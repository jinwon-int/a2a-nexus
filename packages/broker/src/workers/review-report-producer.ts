/**
 * Worker-side review-report producer for bounded PR review lineages (#2351,
 * Slice 2 of #2274; parent #1518).
 *
 * `POST /review-lineages/{lineageId}/review-report` only accepts a report
 * signed by the reviewer itself: the verified signing-key owner must equal
 * `receipt.reviewerNodeId`. Handlers never hold the worker key
 * (`buildWorkerHandlerEnv` strips it), so the report can only come from the
 * worker process that claims and completes the task. This module builds that
 * report from three explicit inputs and nothing else:
 *
 * - the dispatcher's `task.payload.reviewLineage` binding (lineage id and the
 *   exact intentHash/headSha/diffHash the operator froze at create time);
 * - the review verdict and note the completion gate already reads
 *   (`reviewValidation`), whose `nodeId` must equal the worker id;
 * - an optional structured block `result.output.reviewLineage` holding the
 *   reviewer's findings in FindingV1 terms.
 *
 * It never infers a verdict or a finding from prose, logs, task status, or the
 * free-text `output.findings`. A `pass` without the structured block is a
 * complete report (no findings). A `fail` without a valid structured block is
 * not reported at all, so the ledger never receives an invented finding.
 *
 * Identity: `reviewerNodeId` is always the worker id, never a handler value.
 * Idempotency: `reportRef` is `task:<taskId>` and finding ids are derived
 * deterministically from it. A transport retry of the same built request is
 * answered `replayed`; a later re-run of the task builds a new observation
 * time, so the broker rejects it as a changed payload and the first report
 * stands. One task yields at most one counted reviewer run.
 */
import { createHash } from "node:crypto";

import type { TaskRecord, TaskResult } from "../core/types.js";
import { findingSignature } from "../review-lifecycle/canonical-json.js";
import {
  NON_BLOCKING_CATEGORIES,
  type FindingCategory,
  type FindingSeverity,
  type FindingV1,
  type NewFindingJustification,
  type ReviewReceiptV1,
} from "../review-lifecycle/types.js";
import { reviewValidation } from "../worker-review.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const FINDING_ID_PATTERN = /^F-[0-9]+$/;
const NOTE_MAX = 4096;
const MAX_FINDINGS = 100;

const SEVERITIES: ReadonlySet<FindingSeverity> = new Set(["critical", "major", "minor"]);
const CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  "correctness", "security", "regression", "spec_ambiguity", "scope_drift",
  "style", "preference", "design", "other",
]);
const JUSTIFICATIONS: ReadonlySet<NewFindingJustification["kind"]> = new Set([
  "introduced_regression", "critical_security", "unavailable_evidence",
]);

export interface ReviewLineageTaskBinding {
  lineageId: string;
  intentHash: string;
  headSha: string;
  diffHash: string;
}

export interface ReviewReportRequestV1 {
  reportRef: string;
  observedAt: string;
  binding: { intentHash: string; headSha: string; diffHash: string };
  receipt: ReviewReceiptV1;
  resolvedFindingIds: string[];
  reopenedFindingIds: string[];
  newFindings: Array<FindingV1 & { justification?: NewFindingJustification }>;
}

/** Why no report was produced. Body-free so it can be logged as is. */
export type ReviewReportSkipReason =
  | "binding_invalid"
  | "review_validation_missing"
  | "reviewer_identity_mismatch"
  | "author_is_reviewer"
  | "author_invalid"
  | "report_ref_invalid"
  | "structured_findings_missing"
  | "structured_findings_invalid";

export type ReviewReportPlan =
  | { kind: "none" }
  | { kind: "skip"; lineageId?: string; reason: ReviewReportSkipReason; detail?: string }
  | { kind: "report"; lineageId: string; request: ReviewReportRequestV1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown, pattern?: RegExp, max = NOTE_MAX): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && (!pattern || pattern.test(value));
}

/**
 * `task.payload.reviewLineage`: absent means the dispatcher did not opt in
 * (no report, no log). Present but malformed is a visible skip.
 */
export function parseReviewLineageBinding(
  task: TaskRecord,
): { binding: ReviewLineageTaskBinding } | { error: string } | null {
  const raw = (task.payload as Record<string, unknown> | undefined)?.reviewLineage;
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw) || !hasExactKeys(raw, ["lineageId", "intentHash", "headSha", "diffHash"])) {
    return { error: "expected exactly {lineageId, intentHash, headSha, diffHash}" };
  }
  if (!text(raw.lineageId, IDENTIFIER_PATTERN, 200)) return { error: "lineageId" };
  if (!text(raw.intentHash, HASH_PATTERN)) return { error: "intentHash" };
  if (!text(raw.headSha, SHA_PATTERN)) return { error: "headSha" };
  if (!text(raw.diffHash, HASH_PATTERN)) return { error: "diffHash" };
  return {
    binding: {
      lineageId: raw.lineageId,
      intentHash: raw.intentHash,
      headSha: raw.headSha,
      diffHash: raw.diffHash,
    },
  };
}

/** Deterministic `F-<n>` id: stable across re-runs of the same report. */
export function deriveFindingId(reportRef: string, index: number): string {
  const digest = createHash("sha256").update(`${reportRef}\n${index}`, "utf8").digest("hex");
  // 13 hex digits (52 bits) stay exact as a JavaScript number.
  return `F-${Number.parseInt(digest.slice(0, 13), 16)}`;
}

interface StructuredFindings {
  newFindings: Array<{
    criterionRef: string;
    evidenceRefs: string[];
    severity: FindingSeverity;
    category: FindingCategory;
    blocking: boolean;
    justification?: NewFindingJustification;
  }>;
  resolvedFindingIds: string[];
  reopenedFindingIds: string[];
}

function parseStructuredFindings(raw: unknown): StructuredFindings | string {
  if (!isRecord(raw) || !hasExactKeys(raw, ["newFindings", "resolvedFindingIds", "reopenedFindingIds"])) {
    return "expected exactly {newFindings, resolvedFindingIds, reopenedFindingIds}";
  }
  const ids = (value: unknown, name: string): string[] | string => {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) return `${name} must be an array`;
    if (!value.every((id) => text(id, FINDING_ID_PATTERN, 64))) return `${name} items must be F-<n>`;
    return [...new Set(value as string[])];
  };
  const resolved = ids(raw.resolvedFindingIds, "resolvedFindingIds");
  if (typeof resolved === "string") return resolved;
  const reopened = ids(raw.reopenedFindingIds, "reopenedFindingIds");
  if (typeof reopened === "string") return reopened;
  if (!Array.isArray(raw.newFindings) || raw.newFindings.length > MAX_FINDINGS) {
    return "newFindings must be an array";
  }
  const newFindings: StructuredFindings["newFindings"] = [];
  for (const [index, item] of raw.newFindings.entries()) {
    const at = `newFindings[${index}]`;
    if (!isRecord(item) || !hasExactKeys(item, ["criterionRef", "evidenceRefs", "severity", "category", "blocking"], ["justification"])) {
      return `${at} has missing or unknown fields`;
    }
    if (!text(item.criterionRef, undefined, 128)) return `${at}.criterionRef`;
    if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0
        || !item.evidenceRefs.every((ref) => text(ref, undefined, 512))) {
      return `${at}.evidenceRefs must hold 1+ non-empty strings`;
    }
    if (!SEVERITIES.has(item.severity as FindingSeverity)) return `${at}.severity`;
    if (!CATEGORIES.has(item.category as FindingCategory)) return `${at}.category`;
    if (typeof item.blocking !== "boolean") return `${at}.blocking`;
    let justification: NewFindingJustification | undefined;
    if (item.justification !== undefined) {
      const j = item.justification;
      if (!isRecord(j) || !hasExactKeys(j, ["kind", "detail"])
          || !JUSTIFICATIONS.has(j.kind as NewFindingJustification["kind"]) || !text(j.detail)) {
        return `${at}.justification`;
      }
      justification = { kind: j.kind as NewFindingJustification["kind"], detail: j.detail as string };
    }
    const category = item.category as FindingCategory;
    newFindings.push({
      criterionRef: item.criterionRef as string,
      evidenceRefs: [...(item.evidenceRefs as string[])],
      severity: item.severity as FindingSeverity,
      category,
      // Style/preference/design never block (spec); the canonical parser
      // rejects a blocking one outright, so normalize instead of losing it.
      blocking: NON_BLOCKING_CATEGORIES.has(category) ? false : item.blocking,
      ...(justification ? { justification } : {}),
    });
  }
  return { newFindings, resolvedFindingIds: resolved, reopenedFindingIds: reopened };
}

export interface PlanReviewReportInput {
  task: TaskRecord;
  result: TaskResult | undefined;
  workerId: string;
  now?: () => Date;
}

/** Decide whether and what to report. Pure apart from the clock. */
export function planReviewReport({ task, result, workerId, now }: PlanReviewReportInput): ReviewReportPlan {
  const parsed = parseReviewLineageBinding(task);
  if (parsed === null) return { kind: "none" };
  if ("error" in parsed) return { kind: "skip", reason: "binding_invalid", detail: parsed.error };
  const { binding } = parsed;
  const lineageId = binding.lineageId;

  const validation = reviewValidation(result);
  if (!validation || validation.kind !== "review"
      || (validation.verdict !== "pass" && validation.verdict !== "fail")) {
    return { kind: "skip", lineageId, reason: "review_validation_missing" };
  }
  if (validation.nodeId !== workerId) {
    return { kind: "skip", lineageId, reason: "reviewer_identity_mismatch" };
  }
  const rawAuthor = (task.payload as Record<string, unknown> | undefined)?.review;
  const authorWorkerId = isRecord(rawAuthor) && typeof rawAuthor.authorWorkerId === "string"
    ? rawAuthor.authorWorkerId.trim()
    : undefined;
  if (authorWorkerId === workerId) return { kind: "skip", lineageId, reason: "author_is_reviewer" };
  if (authorWorkerId !== undefined && !IDENTIFIER_PATTERN.test(authorWorkerId)) {
    return { kind: "skip", lineageId, reason: "author_invalid" };
  }

  const reportRef = `task:${task.id}`;
  if (!IDENTIFIER_PATTERN.test(reportRef)) return { kind: "skip", lineageId, reason: "report_ref_invalid" };

  const output = result?.output as Record<string, unknown> | undefined;
  const rawStructured = isRecord(output) ? output.reviewLineage : undefined;
  let structured: StructuredFindings;
  if (rawStructured === undefined) {
    if (validation.verdict === "fail") {
      return { kind: "skip", lineageId, reason: "structured_findings_missing" };
    }
    structured = { newFindings: [], resolvedFindingIds: [], reopenedFindingIds: [] };
  } else {
    const outcome = parseStructuredFindings(rawStructured);
    if (typeof outcome === "string") {
      return { kind: "skip", lineageId, reason: "structured_findings_invalid", detail: outcome };
    }
    structured = outcome;
  }

  const observedAt = (now ? now() : new Date()).toISOString();
  const note = (validation.note ?? "").trim() || `review verdict ${validation.verdict}`;
  const newFindings = structured.newFindings.map((finding, index) => {
    const { justification, ...rest } = finding;
    return {
      findingId: deriveFindingId(reportRef, index),
      ...rest,
      introducedAtHead: binding.headSha,
      firstSeenAtHead: binding.headSha,
      resolvedAtHead: null,
      disposition: "open" as const,
      signature: findingSignature({
        criterionRef: rest.criterionRef,
        category: rest.category,
        evidenceRefs: rest.evidenceRefs,
      }),
      ...(justification ? { justification } : {}),
    };
  });

  return {
    kind: "report",
    lineageId,
    request: {
      reportRef,
      observedAt,
      binding: { intentHash: binding.intentHash, headSha: binding.headSha, diffHash: binding.diffHash },
      receipt: {
        kind: "ReviewReceiptV1",
        reviewerNodeId: workerId,
        verdict: validation.verdict,
        note: note.slice(0, NOTE_MAX),
        headSha: binding.headSha,
        diffHash: binding.diffHash,
        intentHash: binding.intentHash,
        findingLedgerRef: `ledger-${lineageId}`,
        ...(authorWorkerId ? { authorWorkerId } : {}),
        submittedAt: observedAt,
      },
      resolvedFindingIds: structured.resolvedFindingIds,
      reopenedFindingIds: structured.reopenedFindingIds,
      newFindings,
    },
  };
}
