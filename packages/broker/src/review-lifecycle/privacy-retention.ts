/**
 * Pure privacy/export/retention planning for bounded PR review lineages
 * (#1518 Phase 11).
 *
 * This module has no database, worker queue, broker, HTTP, or deletion call
 * site. It produces an internal aggregate plan only after the existing
 * scorecard projector has emitted and validated the redacted export proof.
 */

import { canonicalize, sha256Hex } from "./canonical-json.js";
import {
  REVIEW_LINEAGE_SCORECARD_REDACTION_PROFILE,
  buildReviewLineageScorecardInput,
  projectReviewLineageScorecardSample,
  type ReviewLineageScorecardInputV1,
} from "./scorecard.js";
import {
  TERMINAL_LINEAGE_STATES,
  type ReviewLineageRecord,
  type ReviewLineageState,
} from "./types.js";

export const REVIEW_LINEAGE_RETENTION_APPROVAL_KIND =
  "a2a.review-lineage-retention-approval.v1" as const;
export const REVIEW_LINEAGE_REDACTED_EXPORT_PROOF_KIND =
  "a2a.review-lineage-redacted-export-proof.v1" as const;
export const REVIEW_LINEAGE_RETENTION_PLAN_KIND =
  "a2a.review-lineage-retention-plan.v1" as const;

export const REVIEW_LINEAGE_PRIVACY_CLASSES = Object.freeze({
  canonicalLineage: {
    classification: "restricted_sensitive",
    approvedExport: false,
    contents: [
      "frozen_intent",
      "raw_subject",
      "review_notes",
      "finding_evidence",
      "paths",
      "appeals",
      "operator_detail",
    ],
  },
  idempotencyLedger: {
    classification: "internal_operational_metadata",
    approvedExport: false,
    contents: [
      "derived_idempotency_key",
      "payload_fingerprint",
      "lineage_id",
      "stable_outcome",
      "state_version",
      "redacted_effect_codes",
      "observed_at",
    ],
  },
  scorecardProjection: {
    classification: "redacted_pseudonymous_analytics",
    approvedExport: true,
    contents: [
      "round_scoped_lineage_ref",
      "numeric_metrics",
      "state",
      "terminal_reason",
      "timestamps",
      "unresolved_signature_count",
      "hashed_intent_drift_signal",
    ],
  },
} as const);

const UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;
const SOURCE_ROUND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const KNOWN_STATES: ReadonlySet<ReviewLineageState> = new Set([
  "reviewing_initial",
  "correction_pending",
  "reviewing_resolution",
  "passed",
  "blocked_needs_operator",
  "intent_conflict",
  "canceled",
]);
const APPROVAL_FIELDS = new Set([
  "kind",
  "approvalRef",
  "approvedAt",
  "cutoffAt",
]);
const SOURCE_FIELDS = new Set([
  "record",
  "recordVersion",
  "ledgerEntryCount",
]);

export interface ReviewLineageRetentionApprovalV1 {
  kind: typeof REVIEW_LINEAGE_RETENTION_APPROVAL_KIND;
  approvalRef: string;
  approvedAt: string;
  cutoffAt: string;
}

export interface ReviewLineageRetentionSourceV1 {
  record: ReviewLineageRecord;
  /** Storage-owned monotonic version to be rechecked by a future executor. */
  recordVersion: number;
  /** Expected number of ledger rows coupled to this canonical lineage. */
  ledgerEntryCount: number;
}

export interface ReviewLineageRedactedExportProofV1 {
  kind: typeof REVIEW_LINEAGE_REDACTED_EXPORT_PROOF_KIND;
  redactionProfileVersion:
    typeof REVIEW_LINEAGE_SCORECARD_REDACTION_PROFILE;
  sourceRoundId: string;
  asOf: string;
  payloadFingerprint: string;
  scorecardInput: ReviewLineageScorecardInputV1;
}

export interface ReviewLineageRetentionAggregateV1 {
  kind: "canonical_lineage_plus_ledger";
  lineageId: string;
  expectedRecordVersion: number;
  expectedState: Extract<
    ReviewLineageState,
    "passed" | "blocked_needs_operator" | "intent_conflict" | "canceled"
  >;
  expectedUpdatedAt: string;
  expectedLedgerEntryCount: number;
  exportLineageRef: string;
}

export interface ReviewLineageRetentionPlanV1 {
  kind: typeof REVIEW_LINEAGE_RETENTION_PLAN_KIND;
  approval: ReviewLineageRetentionApprovalV1;
  sourceRoundId: string;
  asOf: string;
  exportProof: ReviewLineageRedactedExportProofV1;
  aggregates: ReviewLineageRetentionAggregateV1[];
  excludedActiveCount: number;
  excludedAtOrAfterCutoffCount: number;
}

export interface BuildReviewLineageRetentionPlanOptions {
  approval: ReviewLineageRetentionApprovalV1;
  sourceRoundId: string;
  asOf: string;
  sources: ReviewLineageRetentionSourceV1[];
}

function timestamp(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || !UTC_PATTERN.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`invalid review-lineage retention: ${path} invalid_timestamp`);
  }
  return value;
}

function reference(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`invalid review-lineage retention: ${path} invalid_reference`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`invalid review-lineage retention: ${path} invalid_integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`invalid review-lineage retention: ${path} invalid_integer`);
  }
  return value as number;
}

function exactObject(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid review-lineage retention: ${path} invalid_object`);
  }
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      throw new Error(
        `invalid review-lineage retention: ${path}.${field} unexpected_field`,
      );
    }
  }
  return record;
}

function normalizeApproval(
  value: ReviewLineageRetentionApprovalV1,
  asOf: string,
): ReviewLineageRetentionApprovalV1 {
  const approval = exactObject(value, "approval", APPROVAL_FIELDS);
  if (approval.kind !== REVIEW_LINEAGE_RETENTION_APPROVAL_KIND) {
    throw new Error("invalid review-lineage retention: approval.kind invalid_kind");
  }
  const approvalRef = reference(
    approval.approvalRef,
    "approval.approvalRef",
    REFERENCE_PATTERN,
  );
  const approvedAt = timestamp(approval.approvedAt, "approval.approvedAt");
  const cutoffAt = timestamp(approval.cutoffAt, "approval.cutoffAt");
  if (Date.parse(cutoffAt) > Date.parse(approvedAt)) {
    throw new Error(
      "invalid review-lineage retention: approval.cutoffAt after_approval",
    );
  }
  if (Date.parse(approvedAt) > Date.parse(asOf)) {
    throw new Error(
      "invalid review-lineage retention: approval.approvedAt after_as_of",
    );
  }
  return {
    kind: REVIEW_LINEAGE_RETENTION_APPROVAL_KIND,
    approvalRef,
    approvedAt,
    cutoffAt,
  };
}

function validateSource(
  source: ReviewLineageRetentionSourceV1,
  index: number,
  asOf: string,
): ReviewLineageRetentionSourceV1 {
  const path = `sources[${index}]`;
  exactObject(source, path, SOURCE_FIELDS);
  if (source?.record?.mode !== "record") {
    throw new Error(`invalid review-lineage retention: ${path}.record.mode`);
  }
  if (!KNOWN_STATES.has(source.record.state)) {
    throw new Error(`invalid review-lineage retention: ${path}.record.state`);
  }
  const updatedAt = timestamp(source.record.updatedAt, `${path}.record.updatedAt`);
  if (Date.parse(updatedAt) > Date.parse(asOf)) {
    throw new Error(
      `invalid review-lineage retention: ${path}.record.updatedAt after_as_of`,
    );
  }
  positiveInteger(source.recordVersion, `${path}.recordVersion`);
  nonNegativeInteger(source.ledgerEntryCount, `${path}.ledgerEntryCount`);
  return source;
}

export function buildReviewLineageRedactedExportProof(
  records: ReviewLineageRecord[],
  options: { sourceRoundId: string; asOf: string },
): ReviewLineageRedactedExportProofV1 {
  const sourceRoundId = reference(
    options.sourceRoundId,
    "sourceRoundId",
    SOURCE_ROUND_PATTERN,
  );
  const asOf = timestamp(options.asOf, "asOf");
  const scorecardInput = buildReviewLineageScorecardInput({
    sourceRoundId,
    asOf,
    records,
  });
  return {
    kind: REVIEW_LINEAGE_REDACTED_EXPORT_PROOF_KIND,
    redactionProfileVersion: REVIEW_LINEAGE_SCORECARD_REDACTION_PROFILE,
    sourceRoundId,
    asOf,
    payloadFingerprint:
      `sha256:${sha256Hex(canonicalize(scorecardInput))}`,
    scorecardInput,
  };
}

export function buildReviewLineageRetentionPlan(
  options: BuildReviewLineageRetentionPlanOptions,
): ReviewLineageRetentionPlanV1 {
  const asOf = timestamp(options.asOf, "asOf");
  const sourceRoundId = reference(
    options.sourceRoundId,
    "sourceRoundId",
    SOURCE_ROUND_PATTERN,
  );
  const approval = normalizeApproval(options.approval, asOf);
  const seen = new Set<string>();
  const sources = options.sources.map((source, index) => {
    const validated = validateSource(source, index, asOf);
    if (seen.has(validated.record.lineageId)) {
      throw new Error(
        `invalid review-lineage retention: sources[${index}].record.lineageId duplicate`,
      );
    }
    seen.add(validated.record.lineageId);
    return validated;
  });

  let excludedActiveCount = 0;
  let excludedAtOrAfterCutoffCount = 0;
  const candidates = sources
    .filter((source) => {
      if (!TERMINAL_LINEAGE_STATES.has(source.record.state)) {
        excludedActiveCount += 1;
        return false;
      }
      if (
        Date.parse(source.record.updatedAt)
        >= Date.parse(approval.cutoffAt)
      ) {
        excludedAtOrAfterCutoffCount += 1;
        return false;
      }
      return true;
    })
    .sort((left, right) =>
      left.record.lineageId.localeCompare(right.record.lineageId));

  // Export proof is intentionally constructed before any prune aggregate.
  // If the existing scorecard redaction/validation fails, no plan is returned.
  const exportProof = buildReviewLineageRedactedExportProof(
    candidates.map((source) => source.record),
    { sourceRoundId, asOf },
  );
  const exportedLineageRefs = new Set(
    exportProof.scorecardInput.samples.map((sample) => sample.lineageRef),
  );

  const aggregates = candidates.map((source) => {
    const exportLineageRef = projectReviewLineageScorecardSample(
      source.record,
      { sourceRoundId, asOf },
    ).lineageRef;
    if (!exportedLineageRefs.has(exportLineageRef)) {
      throw new Error(
        "invalid review-lineage retention: export proof missing candidate",
      );
    }
    return {
      kind: "canonical_lineage_plus_ledger" as const,
      lineageId: source.record.lineageId,
      expectedRecordVersion: source.recordVersion,
      expectedState: source.record.state as ReviewLineageRetentionAggregateV1[
        "expectedState"
      ],
      expectedUpdatedAt: source.record.updatedAt,
      expectedLedgerEntryCount: source.ledgerEntryCount,
      exportLineageRef,
    };
  });

  return {
    kind: REVIEW_LINEAGE_RETENTION_PLAN_KIND,
    approval,
    sourceRoundId,
    asOf,
    exportProof,
    aggregates,
    excludedActiveCount,
    excludedAtOrAfterCutoffCount,
  };
}
