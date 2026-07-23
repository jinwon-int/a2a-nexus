/**
 * Deterministic fixture harness for bounded PR review lineages (#1518 Phase 3c).
 *
 * Fixtures are source-only conformance inputs. They exercise the pure lifecycle
 * engine and have no broker, task-completion, retry, finalizer, network, or
 * persistence authority.
 */

import { z } from "zod";

import { findingSignature } from "./canonical-json.js";
import {
  applyEvent,
  computeMetrics,
  createLineage,
  type AppliedEvent,
} from "./lifecycle.js";
import type {
  FindingDisposition,
  ReviewLineageEvent,
  ReviewLineageRecord,
} from "./types.js";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestampSchema = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), "expected an ISO-8601 timestamp");

const contractSchema = z
  .object({
    kind: z.literal("IntentContractV1"),
    lineageId: z.string().min(1),
    goal: z.string().min(1),
    nonGoals: z.array(z.string()),
    invariants: z.array(z.string()),
    acceptanceCriteria: z
      .array(
        z
          .object({
            id: z.string().min(1),
            text: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    declaredPaths: z
      .object({
        allowed: z.array(z.string().min(1)).min(1),
        forbidden: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    baseSha: shaSchema,
    headSha: shaSchema,
    createdAt: timestampSchema,
    intentHash: hashSchema,
  })
  .strict();

const budgetSchema = z
  .object({
    kind: z.literal("ReviewLineageBudgetV1"),
    maxWallClockSeconds: z.number().int().positive(),
    maxCorrectionGenerations: z.number().int().nonnegative(),
    maxReviewerRuns: z.number().int().positive(),
    maxReviewerReplacements: z.number().int().nonnegative(),
    repeatedFindingThreshold: z.number().int().positive(),
    onExhaustion: z.literal("blocked_needs_operator"),
  })
  .strict();

const findingSchema = z
  .object({
    findingId: z.string().min(1),
    criterionRef: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).min(1),
    severity: z.enum(["critical", "major", "minor"]),
    category: z.enum([
      "correctness",
      "security",
      "regression",
      "spec_ambiguity",
      "scope_drift",
      "style",
      "preference",
      "design",
      "other",
    ]),
    blocking: z.boolean(),
    introducedAtHead: shaSchema,
    firstSeenAtHead: shaSchema,
    resolvedAtHead: shaSchema.nullable(),
    disposition: z.enum([
      "open",
      "resolved",
      "reopened",
      "overruled_by_finalizer",
    ]),
    signature: hashSchema,
  })
  .strict();

const justificationSchema = z
  .object({
    kind: z.enum([
      "introduced_regression",
      "critical_security",
      "unavailable_evidence",
    ]),
    detail: z.string().min(1),
  })
  .strict();

const receiptSchema = z
  .object({
    kind: z.literal("ReviewReceiptV1"),
    reviewerNodeId: z.string().min(1),
    verdict: z.enum(["pass", "fail"]),
    note: z.string().min(1),
    headSha: shaSchema,
    diffHash: hashSchema,
    intentHash: hashSchema,
    findingLedgerRef: z.string().min(1),
    authorWorkerId: z.string().min(1).optional(),
    submittedAt: timestampSchema.optional(),
  })
  .strict();

const eventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("review_report"),
      at: timestampSchema,
      receipt: receiptSchema,
      resolvedFindingIds: z.array(z.string().min(1)).optional(),
      reopenedFindingIds: z.array(z.string().min(1)).optional(),
      newFindings: z
        .array(findingSchema.extend({ justification: justificationSchema.optional() }))
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("correction_generation"),
      at: timestampSchema,
      headSha: shaSchema,
      diffHash: hashSchema,
      intentHash: hashSchema,
      pathsChanged: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("reviewer_replacement"),
      at: timestampSchema,
      reason: z.enum(["infrastructure_failure", "other"]),
      detail: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("operator_cancel"),
      at: timestampSchema,
      detail: z.string().min(1).optional(),
    })
    .strict(),
]);

const counterExpectationSchema = z
  .object({
    correctionGenerations: z.number().int().nonnegative().optional(),
    reviewerRuns: z.number().int().nonnegative().optional(),
    reviewerReplacements: z.number().int().nonnegative().optional(),
    findingsNew: z.number().int().nonnegative().optional(),
    findingsReopened: z.number().int().nonnegative().optional(),
    findingsResolved: z.number().int().nonnegative().optional(),
    repeatedSignatureHits: z.number().int().nonnegative().optional(),
    goalpostRejections: z.number().int().nonnegative().optional(),
    scopeDriftRejections: z.number().int().nonnegative().optional(),
  })
  .strict();

const findingExpectationSchema = z
  .object({
    findingId: z.string().min(1),
    blocking: z.boolean().optional(),
    disposition: z
      .enum(["open", "resolved", "reopened", "overruled_by_finalizer"])
      .optional(),
  })
  .strict();

const expectationSchema = z
  .object({
    state: z.enum([
      "reviewing_initial",
      "correction_pending",
      "reviewing_resolution",
      "passed",
      "blocked_needs_operator",
      "intent_conflict",
      "canceled",
    ]),
    terminalReason: z
      .enum([
        "budget_wall_clock",
        "budget_correction_generations",
        "budget_reviewer_runs",
        "repeated_findings",
        "intent_drift",
        "scope_drift",
        "operator_cancel",
      ])
      .nullable()
      .optional(),
    currentHeadSha: shaSchema.optional(),
    counters: counterExpectationSchema.optional(),
    openBlockingFindings: z.number().int().nonnegative().optional(),
    effectsContain: z.array(z.string().min(1)).optional(),
    findings: z.array(findingExpectationSchema).optional(),
    absentFindingIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const reviewLineageSimulationFixtureSchema = z
  .object({
    kind: z.literal("ReviewLineageSimulationFixtureV1"),
    scenarioId: z.string().min(1),
    description: z.string().min(1),
    create: z
      .object({
        contract: contractSchema,
        budget: budgetSchema.optional(),
        at: timestampSchema,
        diffHash: hashSchema.optional(),
      })
      .strict(),
    steps: z
      .array(
        z
          .object({
            stepId: z.string().min(1),
            event: eventSchema,
            expect: expectationSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    expect: expectationSchema,
  })
  .strict();

export type ReviewLineageSimulationFixture = z.infer<
  typeof reviewLineageSimulationFixtureSchema
>;
type SimulationExpectation = z.infer<typeof expectationSchema>;

export interface ReviewLineageSimulationStepResult {
  stepId: string;
  eventType: ReviewLineageEvent["type"];
  applied: AppliedEvent;
}

export interface ReviewLineageSimulationResult {
  fixture: ReviewLineageSimulationFixture;
  record: ReviewLineageRecord;
  steps: ReviewLineageSimulationStepResult[];
  effects: string[];
}

function fail(label: string, detail: string): never {
  throw new Error(`review lineage simulation ${label}: ${detail}`);
}

function verifyExpectation(
  label: string,
  record: ReviewLineageRecord,
  effects: string[],
  expected: SimulationExpectation,
): void {
  if (record.state !== expected.state) {
    fail(label, `expected state ${expected.state}, got ${record.state}`);
  }
  if (
    expected.terminalReason !== undefined
    && record.terminalReason !== expected.terminalReason
  ) {
    fail(
      label,
      `expected terminalReason ${String(expected.terminalReason)}, got ${String(record.terminalReason)}`,
    );
  }
  if (
    expected.currentHeadSha !== undefined
    && record.currentHeadSha !== expected.currentHeadSha
  ) {
    fail(
      label,
      `expected currentHeadSha ${expected.currentHeadSha}, got ${record.currentHeadSha}`,
    );
  }
  for (const [name, value] of Object.entries(expected.counters ?? {})) {
    const counter = name as keyof ReviewLineageRecord["counters"];
    if (record.counters[counter] !== value) {
      fail(
        label,
        `expected counter ${counter}=${String(value)}, got ${record.counters[counter]}`,
      );
    }
  }
  if (expected.openBlockingFindings !== undefined) {
    const actual = computeMetrics(record, record.updatedAt).openBlockingFindings;
    if (actual !== expected.openBlockingFindings) {
      fail(
        label,
        `expected openBlockingFindings=${expected.openBlockingFindings}, got ${actual}`,
      );
    }
  }
  for (const effect of expected.effectsContain ?? []) {
    if (!effects.includes(effect)) {
      fail(label, `missing expected effect ${effect}`);
    }
  }
  for (const findingExpected of expected.findings ?? []) {
    const finding = record.ledger.findings.find(
      (candidate) => candidate.findingId === findingExpected.findingId,
    );
    if (!finding) {
      fail(label, `missing expected finding ${findingExpected.findingId}`);
    }
    if (
      findingExpected.blocking !== undefined
      && finding.blocking !== findingExpected.blocking
    ) {
      fail(
        label,
        `expected finding ${finding.findingId} blocking=${findingExpected.blocking}`,
      );
    }
    if (
      findingExpected.disposition !== undefined
      && finding.disposition !== findingExpected.disposition
    ) {
      fail(
        label,
        `expected finding ${finding.findingId} disposition=${findingExpected.disposition}`,
      );
    }
  }
  for (const findingId of expected.absentFindingIds ?? []) {
    if (record.ledger.findings.some((finding) => finding.findingId === findingId)) {
      fail(label, `finding ${findingId} must be absent`);
    }
  }
}

export function runReviewLineageSimulation(
  input: unknown,
): ReviewLineageSimulationResult {
  const fixture = reviewLineageSimulationFixtureSchema.parse(input);
  const stepIds = new Set<string>();
  for (const step of fixture.steps) {
    if (stepIds.has(step.stepId)) {
      fail(fixture.scenarioId, `duplicate stepId ${step.stepId}`);
    }
    stepIds.add(step.stepId);
    if (step.event.type === "review_report") {
      for (const candidate of step.event.newFindings ?? []) {
        const recomputed = findingSignature(candidate);
        if (recomputed !== candidate.signature) {
          fail(
            `${fixture.scenarioId}/${step.stepId}`,
            `finding ${candidate.findingId} signature mismatch`,
          );
        }
      }
    }
  }
  let record = createLineage({
    contract: fixture.create.contract,
    budget: fixture.create.budget,
    at: fixture.create.at,
    mode: "record",
    diffHash: fixture.create.diffHash,
  });
  const steps: ReviewLineageSimulationStepResult[] = [];
  const effects: string[] = [];

  for (const step of fixture.steps) {
    const applied = applyEvent(record, step.event);
    record = applied.record;
    effects.push(...applied.effects);
    steps.push({
      stepId: step.stepId,
      eventType: step.event.type,
      applied,
    });
    if (step.expect) {
      verifyExpectation(
        `${fixture.scenarioId}/${step.stepId}`,
        record,
        applied.effects,
        step.expect,
      );
    }
  }

  verifyExpectation(fixture.scenarioId, record, effects, fixture.expect);
  return { fixture, record, steps, effects };
}

export function findingDisposition(
  result: ReviewLineageSimulationResult,
  findingId: string,
): FindingDisposition | undefined {
  return result.record.ledger.findings.find(
    (finding) => finding.findingId === findingId,
  )?.disposition;
}
