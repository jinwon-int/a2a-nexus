/**
 * Offline record-mode scorecard readback for bounded PR review lineages
 * (#1518 Phase 7).
 *
 * This module is pure and advisory-only. It has no broker, completion, retry,
 * finalizer, GitHub, or live-service call site. Full ReviewLineageRecord values
 * are projected into an envelope-local redacted sample before aggregation.
 */

import { createHash } from "node:crypto";

import { computeMetrics } from "./lifecycle.js";
import {
  REVIEW_LINEAGE_KIND,
  TERMINAL_LINEAGE_STATES,
  type LineageMetrics,
  type ReviewLineageBudgetV1,
  type ReviewLineageRecord,
  type ReviewLineageState,
  type TerminalStopReason,
} from "./types.js";

export const REVIEW_LINEAGE_SCORECARD_INPUT_KIND =
  "a2a.review-lineage-scorecard-input.v1" as const;
export const REVIEW_LINEAGE_SCORECARD_OUTPUT_KIND =
  "a2a.review-lineage-scorecard-output.v1" as const;
export const REVIEW_LINEAGE_SCORECARD_SAMPLE_KIND =
  "a2a.review-lineage-scorecard-sample.v1" as const;
export const REVIEW_LINEAGE_SCORECARD_REDACTION_PROFILE =
  "a2a.review-lineage-scorecard-redacted.v1" as const;
export const INTENT_HASH_ASSESSMENT_KIND =
  "a2a.intent-hash-assessment.v1" as const;

const UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SOURCE_ROUND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const LINEAGE_REF_PATTERN = /^lr-[0-9a-f]{16}$/;
const SIGNAL_REF_PATTERN = /^ih-[0-9a-f]{16}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const EVIDENCE_REF_PATTERN =
  /^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
const EVIDENCE_REF_NAMESPACES = new Set([
  "artifact",
  "doc",
  "github",
  "sha256",
  "task",
  "test",
]);

const STATES: ReadonlySet<ReviewLineageState> = new Set([
  "reviewing_initial",
  "correction_pending",
  "reviewing_resolution",
  "passed",
  "blocked_needs_operator",
  "intent_conflict",
  "canceled",
]);
const TERMINAL_REASONS: ReadonlySet<TerminalStopReason> = new Set([
  "budget_wall_clock",
  "budget_correction_generations",
  "budget_reviewer_runs",
  "repeated_findings",
  "intent_drift",
  "scope_drift",
  "operator_cancel",
]);
const METRIC_KEYS = [
  "elapsedSeconds",
  "correctionGenerations",
  "reviewerRuns",
  "reviewerReplacements",
  "findingsNew",
  "findingsReopened",
  "findingsResolved",
  "repeatedSignatureHits",
  "goalpostRejections",
  "scopeDriftRejections",
  "openBlockingFindings",
] as const satisfies ReadonlyArray<Exclude<keyof LineageMetrics, "terminalReason">>;
type NumericMetricKey = (typeof METRIC_KEYS)[number];

export interface ReviewLineageScorecardSampleV1 {
  kind: typeof REVIEW_LINEAGE_SCORECARD_SAMPLE_KIND;
  recordSchemaVersion: typeof REVIEW_LINEAGE_KIND;
  lineageRef: string;
  mode: "record";
  state: ReviewLineageState;
  budget: ReviewLineageBudgetV1;
  metrics: LineageMetrics;
  startedAt: string;
  observedAt: string;
  terminalReason: TerminalStopReason | null;
  unresolvedSignatureCount: number;
  intentHashSignalRefs: string[];
}

export interface IntentHashAssessmentV1 {
  kind: typeof INTENT_HASH_ASSESSMENT_KIND;
  lineageRef: string;
  signalRef: string;
  finalDisposition: "true_positive" | "false_positive";
  reasonCode: string;
  evidenceRefs: string[];
}

export interface ReviewLineageScorecardInputV1 {
  kind: typeof REVIEW_LINEAGE_SCORECARD_INPUT_KIND;
  sourceRoundId: string;
  recordSchemaVersion: typeof REVIEW_LINEAGE_KIND;
  redactionProfileVersion: typeof REVIEW_LINEAGE_SCORECARD_REDACTION_PROFILE;
  asOf: string;
  samples: ReviewLineageScorecardSampleV1[];
  intentHashAssessments: IntentHashAssessmentV1[];
}

export interface MetricAggregate {
  count: number;
  total: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export type MetricAggregates = Record<NumericMetricKey, MetricAggregate>;

export interface IntentHashBehavior {
  signalCount: number;
  adjudicatedCount: number;
  truePositiveCount: number;
  falsePositiveCount: number;
  unadjudicatedCount: number;
  falsePositiveRate: {
    numerator: number;
    denominator: number;
    rate: number | null;
  };
}

export type BudgetAdviceStatus =
  | "insufficient_evidence"
  | "hold"
  | "investigate_increase"
  | "investigate_decrease"
  | "not_observable";

export interface BudgetDimensionAdvice {
  advisory: true;
  status: BudgetAdviceStatus;
  current: number;
  evidenceCount: number;
  exhaustionHits: number;
  exhaustionRate: number | null;
  observedP95: number | null;
  observedMax: number | null;
  candidate: number | null;
  thresholdReason: string;
}

export interface AdvisoryBudgetRecommendations {
  maxWallClockSeconds: BudgetDimensionAdvice;
  maxCorrectionGenerations: BudgetDimensionAdvice;
  maxReviewerRuns: BudgetDimensionAdvice;
  maxReviewerReplacements: BudgetDimensionAdvice;
  repeatedFindingThreshold: BudgetDimensionAdvice;
}

export interface ScorecardLineageRow {
  lineageRef: string;
  state: ReviewLineageState;
  budgetSignature: string;
  metrics: LineageMetrics;
  terminalReason: TerminalStopReason | null;
  unresolvedSignatureCount: number;
  intentHashSignals: Array<{
    signalRef: string;
    disposition: "true_positive" | "false_positive" | "unadjudicated";
    reasonCode: string | null;
    evidenceRefs: string[];
  }>;
}

export interface ScorecardCohort {
  cohortKey: string;
  budget: ReviewLineageBudgetV1;
  lineageCount: number;
  terminalLineageCount: number;
  stateCounts: Record<ReviewLineageState, number>;
  terminalReasonCounts: Record<TerminalStopReason, number>;
  aggregates: MetricAggregates;
  intentHashBehavior: IntentHashBehavior;
  advisoryBudgetRecommendations: AdvisoryBudgetRecommendations;
}

export interface ReviewLineageScorecardOutputV1 {
  kind: typeof REVIEW_LINEAGE_SCORECARD_OUTPUT_KIND;
  sourceRoundId: string;
  recordSchemaVersion: typeof REVIEW_LINEAGE_KIND;
  redactionProfileVersion: typeof REVIEW_LINEAGE_SCORECARD_REDACTION_PROFILE;
  asOf: string;
  inputDigest: string;
  lineageCount: number;
  coverage: {
    activeLineageCount: number;
    terminalLineageCount: number;
    intentHashSignalCount: number;
    adjudicatedIntentHashSignalCount: number;
    unadjudicatedIntentHashSignalCount: number;
  };
  stateCounts: Record<ReviewLineageState, number>;
  terminalReasonCounts: Record<TerminalStopReason, number>;
  aggregates: MetricAggregates;
  intentHashBehavior: IntentHashBehavior;
  cohorts: ScorecardCohort[];
  lineages: ScorecardLineageRow[];
}

export interface ScorecardProjectionOptions {
  sourceRoundId: string;
  asOf: string;
}

export interface BuildScorecardInputOptions extends ScorecardProjectionOptions {
  records: ReviewLineageRecord[];
  intentHashAssessments?: IntentHashAssessmentV1[];
}

function invalid(path: string, detail: string): never {
  throw new Error(`invalid review-lineage scorecard: ${path} ${detail}`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, "is an unexpected field");
  }
}

function textAt(
  value: unknown,
  path: string,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(path, "must be a non-empty string");
  }
  if (pattern && !pattern.test(value)) invalid(path, "has an invalid format");
  return value;
}

function utcAt(value: unknown, path: string): string {
  const text = textAt(value, path, UTC_PATTERN);
  if (!Number.isFinite(Date.parse(text))) invalid(path, "must be a valid UTC timestamp");
  return text;
}

function integerAt(value: unknown, path: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    invalid(path, `must be an integer >= ${minimum}`);
  }
  return value as number;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  return value;
}

function enumAt<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  path: string,
): T {
  const text = textAt(value, path);
  if (!allowed.has(text as T)) {
    invalid(path, `must be one of: ${[...allowed].join(", ")}`);
  }
  return text as T;
}

function normalizeBudget(
  value: unknown,
  path: string,
): ReviewLineageBudgetV1 {
  const budget = objectAt(value, path);
  exactKeys(
    budget,
    new Set([
      "kind",
      "maxWallClockSeconds",
      "maxCorrectionGenerations",
      "maxReviewerRuns",
      "maxReviewerReplacements",
      "repeatedFindingThreshold",
      "onExhaustion",
    ]),
    path,
  );
  if (budget.kind !== "ReviewLineageBudgetV1") {
    invalid(`${path}.kind`, "must equal ReviewLineageBudgetV1");
  }
  if (budget.onExhaustion !== "blocked_needs_operator") {
    invalid(`${path}.onExhaustion`, "must equal blocked_needs_operator");
  }
  return {
    kind: "ReviewLineageBudgetV1",
    maxWallClockSeconds: integerAt(
      budget.maxWallClockSeconds,
      `${path}.maxWallClockSeconds`,
      1,
    ),
    maxCorrectionGenerations: integerAt(
      budget.maxCorrectionGenerations,
      `${path}.maxCorrectionGenerations`,
    ),
    maxReviewerRuns: integerAt(
      budget.maxReviewerRuns,
      `${path}.maxReviewerRuns`,
      1,
    ),
    maxReviewerReplacements: integerAt(
      budget.maxReviewerReplacements,
      `${path}.maxReviewerReplacements`,
    ),
    repeatedFindingThreshold: integerAt(
      budget.repeatedFindingThreshold,
      `${path}.repeatedFindingThreshold`,
      1,
    ),
    onExhaustion: "blocked_needs_operator",
  };
}

function normalizeMetrics(value: unknown, path: string): LineageMetrics {
  const metrics = objectAt(value, path);
  exactKeys(metrics, new Set([...METRIC_KEYS, "terminalReason"]), path);
  const terminalReason =
    metrics.terminalReason === null
      ? null
      : enumAt(metrics.terminalReason, TERMINAL_REASONS, `${path}.terminalReason`);
  return {
    elapsedSeconds: integerAt(metrics.elapsedSeconds, `${path}.elapsedSeconds`),
    correctionGenerations: integerAt(
      metrics.correctionGenerations,
      `${path}.correctionGenerations`,
    ),
    reviewerRuns: integerAt(metrics.reviewerRuns, `${path}.reviewerRuns`),
    reviewerReplacements: integerAt(
      metrics.reviewerReplacements,
      `${path}.reviewerReplacements`,
    ),
    findingsNew: integerAt(metrics.findingsNew, `${path}.findingsNew`),
    findingsReopened: integerAt(
      metrics.findingsReopened,
      `${path}.findingsReopened`,
    ),
    findingsResolved: integerAt(
      metrics.findingsResolved,
      `${path}.findingsResolved`,
    ),
    repeatedSignatureHits: integerAt(
      metrics.repeatedSignatureHits,
      `${path}.repeatedSignatureHits`,
    ),
    goalpostRejections: integerAt(
      metrics.goalpostRejections,
      `${path}.goalpostRejections`,
    ),
    scopeDriftRejections: integerAt(
      metrics.scopeDriftRejections,
      `${path}.scopeDriftRejections`,
    ),
    openBlockingFindings: integerAt(
      metrics.openBlockingFindings,
      `${path}.openBlockingFindings`,
    ),
    terminalReason,
  };
}

function stateReasonMatches(
  state: ReviewLineageState,
  terminalReason: TerminalStopReason | null,
): boolean {
  switch (state) {
    case "reviewing_initial":
    case "correction_pending":
    case "reviewing_resolution":
    case "passed":
      return terminalReason === null;
    case "blocked_needs_operator":
      return terminalReason !== null
        && terminalReason !== "intent_drift"
        && terminalReason !== "operator_cancel";
    case "intent_conflict":
      return terminalReason === "intent_drift";
    case "canceled":
      return terminalReason === "operator_cancel";
  }
}

function normalizeSample(
  value: unknown,
  index: number,
  inputAsOf: string,
  recordSchemaVersion: string,
): ReviewLineageScorecardSampleV1 {
  const path = `input.samples[${index}]`;
  const sample = objectAt(value, path);
  exactKeys(
    sample,
    new Set([
      "kind",
      "recordSchemaVersion",
      "lineageRef",
      "mode",
      "state",
      "budget",
      "metrics",
      "startedAt",
      "observedAt",
      "terminalReason",
      "unresolvedSignatureCount",
      "intentHashSignalRefs",
    ]),
    path,
  );
  if (sample.kind !== REVIEW_LINEAGE_SCORECARD_SAMPLE_KIND) {
    invalid(`${path}.kind`, `must equal ${REVIEW_LINEAGE_SCORECARD_SAMPLE_KIND}`);
  }
  if (sample.recordSchemaVersion !== recordSchemaVersion) {
    invalid(`${path}.recordSchemaVersion`, "must match input.recordSchemaVersion");
  }
  if (sample.mode !== "record") {
    invalid(`${path}.mode`, "must equal record");
  }
  const state = enumAt(sample.state, STATES, `${path}.state`);
  const terminalReason =
    sample.terminalReason === null
      ? null
      : enumAt(
          sample.terminalReason,
          TERMINAL_REASONS,
          `${path}.terminalReason`,
        );
  if (!stateReasonMatches(state, terminalReason)) {
    invalid(`${path}.terminalReason`, `does not match state ${state}`);
  }
  const metrics = normalizeMetrics(sample.metrics, `${path}.metrics`);
  if (metrics.terminalReason !== terminalReason) {
    invalid(`${path}.metrics.terminalReason`, "must match sample.terminalReason");
  }
  const startedAt = utcAt(sample.startedAt, `${path}.startedAt`);
  const observedAt = utcAt(sample.observedAt, `${path}.observedAt`);
  if (Date.parse(observedAt) < Date.parse(startedAt)) {
    invalid(`${path}.observedAt`, "must not precede startedAt");
  }
  if (Date.parse(observedAt) > Date.parse(inputAsOf)) {
    invalid(`${path}.observedAt`, "must not follow input.asOf");
  }
  const elapsedSeconds = Math.floor(
    (Date.parse(observedAt) - Date.parse(startedAt)) / 1000,
  );
  if (metrics.elapsedSeconds !== elapsedSeconds) {
    invalid(
      `${path}.metrics.elapsedSeconds`,
      "must equal the startedAt/observedAt interval",
    );
  }
  const signalRefs = arrayAt(
    sample.intentHashSignalRefs,
    `${path}.intentHashSignalRefs`,
  ).map((entry, signalIndex) =>
    textAt(
      entry,
      `${path}.intentHashSignalRefs[${signalIndex}]`,
      SIGNAL_REF_PATTERN,
    ));
  if (new Set(signalRefs).size !== signalRefs.length) {
    invalid(`${path}.intentHashSignalRefs`, "contains a duplicate signalRef");
  }
  if (state === "intent_conflict" && signalRefs.length === 0) {
    invalid(`${path}.intentHashSignalRefs`, "must identify the mismatch signal");
  }
  if (state !== "intent_conflict" && signalRefs.length > 0) {
    invalid(
      `${path}.intentHashSignalRefs`,
      "must be empty unless state is intent_conflict",
    );
  }
  signalRefs.sort(compareText);
  return {
    kind: REVIEW_LINEAGE_SCORECARD_SAMPLE_KIND,
    recordSchemaVersion: REVIEW_LINEAGE_KIND,
    lineageRef: textAt(sample.lineageRef, `${path}.lineageRef`, LINEAGE_REF_PATTERN),
    mode: "record",
    state,
    budget: normalizeBudget(sample.budget, `${path}.budget`),
    metrics,
    startedAt,
    observedAt,
    terminalReason,
    unresolvedSignatureCount: integerAt(
      sample.unresolvedSignatureCount,
      `${path}.unresolvedSignatureCount`,
    ),
    intentHashSignalRefs: signalRefs,
  };
}

function normalizeAssessment(
  value: unknown,
  index: number,
): IntentHashAssessmentV1 {
  const path = `input.intentHashAssessments[${index}]`;
  const assessment = objectAt(value, path);
  exactKeys(
    assessment,
    new Set([
      "kind",
      "lineageRef",
      "signalRef",
      "finalDisposition",
      "reasonCode",
      "evidenceRefs",
    ]),
    path,
  );
  if (assessment.kind !== INTENT_HASH_ASSESSMENT_KIND) {
    invalid(`${path}.kind`, `must equal ${INTENT_HASH_ASSESSMENT_KIND}`);
  }
  const evidenceRefs = arrayAt(
    assessment.evidenceRefs,
    `${path}.evidenceRefs`,
  ).map((entry, evidenceIndex) => {
    const ref = textAt(
      entry,
      `${path}.evidenceRefs[${evidenceIndex}]`,
      EVIDENCE_REF_PATTERN,
    );
    if (ref.includes("://")) {
      invalid(`${path}.evidenceRefs[${evidenceIndex}]`, "must be an opaque reference");
    }
    const namespace = ref.slice(0, ref.indexOf(":"));
    if (!EVIDENCE_REF_NAMESPACES.has(namespace)) {
      invalid(
        `${path}.evidenceRefs[${evidenceIndex}]`,
        `namespace must be one of: ${[...EVIDENCE_REF_NAMESPACES].join(", ")}`,
      );
    }
    return ref;
  });
  if (evidenceRefs.length === 0) {
    invalid(`${path}.evidenceRefs`, "must contain at least one reference");
  }
  if (new Set(evidenceRefs).size !== evidenceRefs.length) {
    invalid(`${path}.evidenceRefs`, "contains a duplicate reference");
  }
  evidenceRefs.sort(compareText);
  return {
    kind: INTENT_HASH_ASSESSMENT_KIND,
    lineageRef: textAt(
      assessment.lineageRef,
      `${path}.lineageRef`,
      LINEAGE_REF_PATTERN,
    ),
    signalRef: textAt(
      assessment.signalRef,
      `${path}.signalRef`,
      SIGNAL_REF_PATTERN,
    ),
    finalDisposition: enumAt(
      assessment.finalDisposition,
      new Set(["true_positive", "false_positive"] as const),
      `${path}.finalDisposition`,
    ),
    reasonCode: textAt(
      assessment.reasonCode,
      `${path}.reasonCode`,
      REASON_CODE_PATTERN,
    ),
    evidenceRefs,
  };
}

export function validateReviewLineageScorecardInput(
  value: unknown,
): ReviewLineageScorecardInputV1 {
  const input = objectAt(value, "input");
  exactKeys(
    input,
    new Set([
      "kind",
      "sourceRoundId",
      "recordSchemaVersion",
      "redactionProfileVersion",
      "asOf",
      "samples",
      "intentHashAssessments",
    ]),
    "input",
  );
  if (input.kind !== REVIEW_LINEAGE_SCORECARD_INPUT_KIND) {
    invalid("input.kind", `must equal ${REVIEW_LINEAGE_SCORECARD_INPUT_KIND}`);
  }
  if (input.recordSchemaVersion !== REVIEW_LINEAGE_KIND) {
    invalid("input.recordSchemaVersion", `must equal ${REVIEW_LINEAGE_KIND}`);
  }
  if (
    input.redactionProfileVersion
    !== REVIEW_LINEAGE_SCORECARD_REDACTION_PROFILE
  ) {
    invalid(
      "input.redactionProfileVersion",
      `must equal ${REVIEW_LINEAGE_SCORECARD_REDACTION_PROFILE}`,
    );
  }
  const asOf = utcAt(input.asOf, "input.asOf");
  const samples = arrayAt(input.samples, "input.samples").map((entry, index) =>
    normalizeSample(entry, index, asOf, REVIEW_LINEAGE_KIND));
  const lineageRefs = new Set<string>();
  const signals = new Set<string>();
  for (const sample of samples) {
    if (lineageRefs.has(sample.lineageRef)) {
      invalid("input.samples", `contains duplicate lineageRef ${sample.lineageRef}`);
    }
    lineageRefs.add(sample.lineageRef);
    for (const signalRef of sample.intentHashSignalRefs) {
      signals.add(`${sample.lineageRef}\0${signalRef}`);
    }
  }
  const assessments = arrayAt(
    input.intentHashAssessments,
    "input.intentHashAssessments",
  ).map(normalizeAssessment);
  const assessmentKeys = new Set<string>();
  for (const assessment of assessments) {
    const key = `${assessment.lineageRef}\0${assessment.signalRef}`;
    if (assessmentKeys.has(key)) {
      invalid(
        "input.intentHashAssessments",
        `contains duplicate intentHash assessment ${assessment.lineageRef}/${assessment.signalRef}`,
      );
    }
    assessmentKeys.add(key);
    if (!signals.has(key)) {
      invalid(
        "input.intentHashAssessments",
        `references unknown intentHash signal ${assessment.lineageRef}/${assessment.signalRef}`,
      );
    }
  }
  samples.sort((a, b) => compareText(a.lineageRef, b.lineageRef));
  assessments.sort((a, b) =>
    compareText(
      `${a.lineageRef}\0${a.signalRef}`,
      `${b.lineageRef}\0${b.signalRef}`,
    ));
  return {
    kind: REVIEW_LINEAGE_SCORECARD_INPUT_KIND,
    sourceRoundId: textAt(
      input.sourceRoundId,
      "input.sourceRoundId",
      SOURCE_ROUND_PATTERN,
    ),
    recordSchemaVersion: REVIEW_LINEAGE_KIND,
    redactionProfileVersion: REVIEW_LINEAGE_SCORECARD_REDACTION_PROFILE,
    asOf,
    samples,
    intentHashAssessments: assessments,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function digest(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function envelopeRef(prefix: "lr" | "ih", ...parts: string[]): string {
  return `${prefix}-${sha256(parts.join("\0")).slice(0, 16)}`;
}

export function projectReviewLineageScorecardSample(
  record: ReviewLineageRecord,
  options: ScorecardProjectionOptions,
): ReviewLineageScorecardSampleV1 {
  textAt(options.sourceRoundId, "projection.sourceRoundId", SOURCE_ROUND_PATTERN);
  const asOf = utcAt(options.asOf, "projection.asOf");
  if (record.mode !== "record") {
    invalid("projection.record.mode", "must equal record");
  }
  if (Date.parse(asOf) < Date.parse(record.updatedAt)) {
    invalid("projection.asOf", "must not precede record.updatedAt");
  }
  const observedAt = TERMINAL_LINEAGE_STATES.has(record.state)
    ? record.updatedAt
    : asOf;
  const metrics = computeMetrics(record, observedAt);
  const lineageRef = envelopeRef(
    "lr",
    options.sourceRoundId,
    record.lineageId,
  );
  const intentHashSignalRefs =
    record.state === "intent_conflict" && record.terminalReason === "intent_drift"
      ? [
          envelopeRef(
            "ih",
            options.sourceRoundId,
            record.lineageId,
            record.contract.intentHash,
          ),
        ]
      : [];
  const sample: ReviewLineageScorecardSampleV1 = {
    kind: REVIEW_LINEAGE_SCORECARD_SAMPLE_KIND,
    recordSchemaVersion: REVIEW_LINEAGE_KIND,
    lineageRef,
    mode: "record",
    state: record.state,
    budget: normalizeBudget(record.budget, "projection.record.budget"),
    metrics,
    startedAt: record.startedAt,
    observedAt,
    terminalReason: record.terminalReason,
    unresolvedSignatureCount: Object.values(record.unresolvedSignatures).filter(
      (count) => count > 0,
    ).length,
    intentHashSignalRefs,
  };
  return normalizeSample(sample, 0, asOf, REVIEW_LINEAGE_KIND);
}

export function buildReviewLineageScorecardInput(
  options: BuildScorecardInputOptions,
): ReviewLineageScorecardInputV1 {
  return validateReviewLineageScorecardInput({
    kind: REVIEW_LINEAGE_SCORECARD_INPUT_KIND,
    sourceRoundId: options.sourceRoundId,
    recordSchemaVersion: REVIEW_LINEAGE_KIND,
    redactionProfileVersion: REVIEW_LINEAGE_SCORECARD_REDACTION_PROFILE,
    asOf: options.asOf,
    samples: options.records.map((record) =>
      projectReviewLineageScorecardSample(record, options)),
    intentHashAssessments: options.intentHashAssessments ?? [],
  });
}

function emptyStateCounts(): Record<ReviewLineageState, number> {
  return {
    reviewing_initial: 0,
    correction_pending: 0,
    reviewing_resolution: 0,
    passed: 0,
    blocked_needs_operator: 0,
    intent_conflict: 0,
    canceled: 0,
  };
}

function emptyTerminalReasonCounts(): Record<TerminalStopReason, number> {
  return {
    budget_wall_clock: 0,
    budget_correction_generations: 0,
    budget_reviewer_runs: 0,
    repeated_findings: 0,
    intent_drift: 0,
    scope_drift: 0,
    operator_cancel: 0,
  };
}

function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null;
}

function aggregateValues(values: number[]): MetricAggregate {
  if (values.length === 0) {
    return { count: 0, total: 0, min: null, p50: null, p95: null, max: null };
  }
  return {
    count: values.length,
    total: values.reduce((sum, value) => sum + value, 0),
    min: Math.min(...values),
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    max: Math.max(...values),
  };
}

function aggregateMetrics(
  samples: ReviewLineageScorecardSampleV1[],
): MetricAggregates {
  return Object.fromEntries(
    METRIC_KEYS.map((key) => [
      key,
      aggregateValues(samples.map((sample) => sample.metrics[key])),
    ]),
  ) as MetricAggregates;
}

function countStates(
  samples: ReviewLineageScorecardSampleV1[],
): Record<ReviewLineageState, number> {
  const counts = emptyStateCounts();
  for (const sample of samples) counts[sample.state] += 1;
  return counts;
}

function countTerminalReasons(
  samples: ReviewLineageScorecardSampleV1[],
): Record<TerminalStopReason, number> {
  const counts = emptyTerminalReasonCounts();
  for (const sample of samples) {
    if (sample.terminalReason) counts[sample.terminalReason] += 1;
  }
  return counts;
}

function assessmentMap(
  assessments: IntentHashAssessmentV1[],
): Map<string, IntentHashAssessmentV1> {
  return new Map(
    assessments.map((assessment) => [
      `${assessment.lineageRef}\0${assessment.signalRef}`,
      assessment,
    ]),
  );
}

function summarizeIntentHashBehavior(
  samples: ReviewLineageScorecardSampleV1[],
  assessments: IntentHashAssessmentV1[],
): IntentHashBehavior {
  const allowedSignals = new Set(
    samples.flatMap((sample) =>
      sample.intentHashSignalRefs.map(
        (signalRef) => `${sample.lineageRef}\0${signalRef}`,
      )),
  );
  const relevant = assessments.filter((assessment) =>
    allowedSignals.has(`${assessment.lineageRef}\0${assessment.signalRef}`));
  const truePositiveCount = relevant.filter(
    (assessment) => assessment.finalDisposition === "true_positive",
  ).length;
  const falsePositiveCount = relevant.filter(
    (assessment) => assessment.finalDisposition === "false_positive",
  ).length;
  const denominator = truePositiveCount + falsePositiveCount;
  return {
    signalCount: allowedSignals.size,
    adjudicatedCount: denominator,
    truePositiveCount,
    falsePositiveCount,
    unadjudicatedCount: allowedSignals.size - denominator,
    falsePositiveRate: {
      numerator: falsePositiveCount,
      denominator,
      rate: denominator === 0 ? null : falsePositiveCount / denominator,
    },
  };
}

function terminalSamples(
  samples: ReviewLineageScorecardSampleV1[],
): ReviewLineageScorecardSampleV1[] {
  return samples.filter((sample) => TERMINAL_LINEAGE_STATES.has(sample.state));
}

function observableAdvice(options: {
  current: number;
  terminal: ReviewLineageScorecardSampleV1[];
  terminalReason: TerminalStopReason;
  metric: NumericMetricKey;
  minimumUnit: number;
}): BudgetDimensionAdvice {
  const values = options.terminal.map((sample) => sample.metrics[options.metric]);
  const evidenceCount = values.length;
  const exhaustionHits = options.terminal.filter(
    (sample) => sample.terminalReason === options.terminalReason,
  ).length;
  const exhaustionRate =
    evidenceCount === 0 ? null : exhaustionHits / evidenceCount;
  const observedP95 = nearestRank(values, 0.95);
  const observedMax = values.length === 0 ? null : Math.max(...values);
  const base = {
    advisory: true as const,
    current: options.current,
    evidenceCount,
    exhaustionHits,
    exhaustionRate,
    observedP95,
    observedMax,
  };
  if (evidenceCount < 30) {
    return {
      ...base,
      status: "insufficient_evidence",
      candidate: null,
      thresholdReason: "terminal_lineages_below_30",
    };
  }
  if (
    exhaustionHits >= 5
    && exhaustionRate !== null
    && exhaustionRate >= 0.1
  ) {
    const p95 = observedP95 ?? options.current;
    return {
      ...base,
      status: "investigate_increase",
      candidate: Math.max(
        options.current + options.minimumUnit,
        Math.ceil(p95 * 1.2),
      ),
      thresholdReason: "exhaustion_rate_at_least_10_percent_and_5_hits",
    };
  }
  if (
    evidenceCount >= 100
    && exhaustionHits === 0
    && observedP95 !== null
    && observedP95 <= options.current * 0.5
  ) {
    const candidate = Math.max(
      options.minimumUnit,
      observedMax ?? 0,
      Math.ceil(observedP95 * 1.2),
    );
    if (candidate >= options.current) {
      return {
        ...base,
        status: "hold",
        candidate: null,
        thresholdReason: "minimum_or_observed_limit_prevents_decrease",
      };
    }
    return {
      ...base,
      status: "investigate_decrease",
      candidate,
      thresholdReason: "100_samples_zero_exhaustion_p95_at_most_half",
    };
  }
  return {
    ...base,
    status: "hold",
    candidate: null,
    thresholdReason: "advisory_change_threshold_not_met",
  };
}

function notObservableAdvice(
  current: number,
  evidenceCount: number,
): BudgetDimensionAdvice {
  return {
    advisory: true,
    status: "not_observable",
    current,
    evidenceCount,
    exhaustionHits: 0,
    exhaustionRate: evidenceCount === 0 ? null : 0,
    observedP95: null,
    observedMax: null,
    candidate: null,
    thresholdReason: "terminal_reason_does_not_disambiguate_reviewer_replacements",
  };
}

function budgetAdvice(
  budget: ReviewLineageBudgetV1,
  samples: ReviewLineageScorecardSampleV1[],
): AdvisoryBudgetRecommendations {
  const terminal = terminalSamples(samples);
  return {
    maxWallClockSeconds: observableAdvice({
      current: budget.maxWallClockSeconds,
      terminal,
      terminalReason: "budget_wall_clock",
      metric: "elapsedSeconds",
      minimumUnit: 60,
    }),
    maxCorrectionGenerations: observableAdvice({
      current: budget.maxCorrectionGenerations,
      terminal,
      terminalReason: "budget_correction_generations",
      metric: "correctionGenerations",
      minimumUnit: 1,
    }),
    maxReviewerRuns: observableAdvice({
      current: budget.maxReviewerRuns,
      terminal,
      terminalReason: "budget_reviewer_runs",
      metric: "reviewerRuns",
      minimumUnit: 1,
    }),
    maxReviewerReplacements: notObservableAdvice(
      budget.maxReviewerReplacements,
      terminal.length,
    ),
    repeatedFindingThreshold: observableAdvice({
      current: budget.repeatedFindingThreshold,
      terminal,
      terminalReason: "repeated_findings",
      metric: "repeatedSignatureHits",
      minimumUnit: 1,
    }),
  };
}

function lineages(
  samples: ReviewLineageScorecardSampleV1[],
  assessments: IntentHashAssessmentV1[],
): ScorecardLineageRow[] {
  const bySignal = assessmentMap(assessments);
  return samples.map((sample) => ({
    lineageRef: sample.lineageRef,
    state: sample.state,
    budgetSignature: digest(sample.budget),
    metrics: structuredClone(sample.metrics),
    terminalReason: sample.terminalReason,
    unresolvedSignatureCount: sample.unresolvedSignatureCount,
    intentHashSignals: sample.intentHashSignalRefs.map((signalRef) => {
      const assessment = bySignal.get(`${sample.lineageRef}\0${signalRef}`);
      return {
        signalRef,
        disposition: assessment?.finalDisposition ?? "unadjudicated",
        reasonCode: assessment?.reasonCode ?? null,
        evidenceRefs: assessment ? [...assessment.evidenceRefs] : [],
      };
    }),
  }));
}

function cohorts(
  samples: ReviewLineageScorecardSampleV1[],
  assessments: IntentHashAssessmentV1[],
): ScorecardCohort[] {
  const grouped = new Map<
    string,
    { budget: ReviewLineageBudgetV1; samples: ReviewLineageScorecardSampleV1[] }
  >();
  for (const sample of samples) {
    const cohortKey = digest(sample.budget);
    const group = grouped.get(cohortKey) ?? {
      budget: sample.budget,
      samples: [],
    };
    group.samples.push(sample);
    grouped.set(cohortKey, group);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([cohortKey, group]) => ({
      cohortKey,
      budget: structuredClone(group.budget),
      lineageCount: group.samples.length,
      terminalLineageCount: terminalSamples(group.samples).length,
      stateCounts: countStates(group.samples),
      terminalReasonCounts: countTerminalReasons(group.samples),
      aggregates: aggregateMetrics(group.samples),
      intentHashBehavior: summarizeIntentHashBehavior(
        group.samples,
        assessments,
      ),
      advisoryBudgetRecommendations: budgetAdvice(
        group.budget,
        group.samples,
      ),
    }));
}

export function buildReviewLineageScorecard(
  value: unknown,
): ReviewLineageScorecardOutputV1 {
  const input = validateReviewLineageScorecardInput(value);
  const intentHashBehavior = summarizeIntentHashBehavior(
    input.samples,
    input.intentHashAssessments,
  );
  const terminalLineageCount = terminalSamples(input.samples).length;
  return {
    kind: REVIEW_LINEAGE_SCORECARD_OUTPUT_KIND,
    sourceRoundId: input.sourceRoundId,
    recordSchemaVersion: input.recordSchemaVersion,
    redactionProfileVersion: input.redactionProfileVersion,
    asOf: input.asOf,
    inputDigest: digest(input),
    lineageCount: input.samples.length,
    coverage: {
      activeLineageCount: input.samples.length - terminalLineageCount,
      terminalLineageCount,
      intentHashSignalCount: intentHashBehavior.signalCount,
      adjudicatedIntentHashSignalCount: intentHashBehavior.adjudicatedCount,
      unadjudicatedIntentHashSignalCount:
        intentHashBehavior.unadjudicatedCount,
    },
    stateCounts: countStates(input.samples),
    terminalReasonCounts: countTerminalReasons(input.samples),
    aggregates: aggregateMetrics(input.samples),
    intentHashBehavior,
    cohorts: cohorts(input.samples, input.intentHashAssessments),
    lineages: lineages(input.samples, input.intentHashAssessments),
  };
}

export function assertReviewLineageScorecardReplay(
  existing: ReviewLineageScorecardOutputV1,
  candidate: ReviewLineageScorecardOutputV1,
): void {
  if (
    existing.sourceRoundId === candidate.sourceRoundId
    && existing.inputDigest !== candidate.inputDigest
  ) {
    throw new Error(
      `review-lineage scorecard sourceRoundId collision: ${existing.sourceRoundId} has a different inputDigest`,
    );
  }
}
