import type { AuditEvent, TaskRecord, TaskStatus } from "./types.js";

const DEFAULT_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TOP_ROUNDS = 10;

export interface TaskStatsWindow {
  since: Date;
  until: Date;
}

export interface TaskStatsOptions extends TaskStatsWindow {
  maxWindowMs?: number;
  maxRoundGroups?: number;
  workerClassForTask?: (task: TaskRecord) => string | undefined;
  auditEvents?: Iterable<AuditEvent>;
}

export interface TaskRoundStats {
  parentRoundId: string;
  failed: number;
  total: number;
}

export interface TaskLatencyDistribution {
  count: number;
  minMs: number | null;
  maxMs: number | null;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export type TaskLifecycleLatencySegment =
  | "createToClaim"
  | "claimToStart"
  | "startToComplete";

export interface TaskLifecycleLatencyResponse {
  schemaVersion: "a2a.task-lifecycle-latency.v1";
  measurementPolicy: {
    selection: "terminal tasks in the requested stats window";
    attempt: "latest monotonic claim/start pair before terminal completion";
    percentile: "nearest-rank";
  };
  coverage: {
    terminalTasks: number;
    completeChains: number;
    stages: {
      created: number;
      claimed: number;
      started: number;
      completed: number;
    };
    missing: {
      created: number;
      claimed: number;
      started: number;
      completed: number;
    };
    invalidChains: number;
    invalidTimestampEvents: number;
  };
  segments: {
    createToClaim: TaskLatencyDistribution;
    claimToStart: TaskLatencyDistribution;
    startToComplete: TaskLatencyDistribution;
    createToComplete: TaskLatencyDistribution;
  };
  bottleneckByP95: { segment: TaskLifecycleLatencySegment; p95Ms: number } | null;
}

export interface TaskStatsResponse {
  window: { since: string; until: string };
  total: number;
  byStatus: Partial<Record<TaskStatus, number>>;
  byErrorCode: Record<string, number>;
  byNestedClass: Record<string, number>;
  byStage: Record<string, number>;
  byWorkerClass: Record<string, number>;
  byRound: { top: TaskRoundStats[] };
  latency: TaskLifecycleLatencyResponse;
}

export const TERMINAL_STATUSES = new Set<TaskStatus>(["succeeded", "failed", "canceled"]);
export const LIFECYCLE_ACTIONS = new Set<AuditEvent["action"]>([
  "task.created",
  "task.claimed",
  "task.started",
  "task.succeeded",
  "task.failed",
  "task.canceled",
]);
export const TERMINAL_ACTION_FOR_STATUS: Partial<Record<TaskStatus, AuditEvent["action"]>> = {
  succeeded: "task.succeeded",
  failed: "task.failed",
  canceled: "task.canceled",
};

export interface IndexedLifecycleEvents {
  rawCountByAction: Partial<Record<AuditEvent["action"], number>>;
  timesByAction: Partial<Record<AuditEvent["action"], number[]>>;
}

function timestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? null;
}

export function summarizeTaskLatency(values: Iterable<number>): TaskLatencyDistribution {
  const sorted = [...values].filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, minMs: null, maxMs: null, averageMs: null, p50Ms: null, p95Ms: null };
  }
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? null,
    maxMs: sorted.at(-1) ?? null,
    averageMs: Math.round((sum / sorted.length) * 1_000) / 1_000,
    p50Ms: nearestRank(sorted, 50),
    p95Ms: nearestRank(sorted, 95),
  };
}

export function indexLifecycleEvents(auditEvents: Iterable<AuditEvent>, taskIds: ReadonlySet<string>): {
  byTaskId: Map<string, IndexedLifecycleEvents>;
  invalidTimestampEvents: number;
} {
  const byTaskId = new Map<string, IndexedLifecycleEvents>();
  let invalidTimestampEvents = 0;
  for (const event of auditEvents) {
    if (event.targetType !== "task" || !taskIds.has(event.targetId) || !LIFECYCLE_ACTIONS.has(event.action)) continue;
    const row = byTaskId.get(event.targetId) ?? { rawCountByAction: {}, timesByAction: {} };
    row.rawCountByAction[event.action] = (row.rawCountByAction[event.action] ?? 0) + 1;
    const at = timestampMs(event.createdAt);
    if (at === null) {
      invalidTimestampEvents += 1;
    } else {
      const times = row.timesByAction[event.action] ?? [];
      times.push(at);
      row.timesByAction[event.action] = times;
    }
    byTaskId.set(event.targetId, row);
  }
  for (const row of byTaskId.values()) {
    for (const times of Object.values(row.timesByAction)) times?.sort((left, right) => left - right);
  }
  return { byTaskId, invalidTimestampEvents };
}

export function preferredEventTime(
  row: IndexedLifecycleEvents | undefined,
  action: AuditEvent["action"],
  fallback: string | undefined,
  edge: "earliest" | "latest",
): number | null {
  const times = row?.timesByAction[action] ?? [];
  if (times.length > 0) return edge === "earliest" ? (times[0] ?? null) : (times.at(-1) ?? null);
  return timestampMs(fallback);
}

export function latestWithin(values: readonly number[], lower: number | null, upper: number | null): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value === undefined) continue;
    if (lower !== null && value < lower) continue;
    if (upper !== null && value > upper) continue;
    return value;
  }
  return null;
}

export function hasTimestampSignal(
  row: IndexedLifecycleEvents | undefined,
  action: AuditEvent["action"],
  fallback: string | undefined,
): boolean {
  return Boolean(fallback) || (row?.rawCountByAction[action] ?? 0) > 0;
}

export function aggregateTaskLifecycleLatency(
  tasks: Iterable<TaskRecord>,
  auditEvents: Iterable<AuditEvent>,
): TaskLifecycleLatencyResponse {
  const terminalTaskRows = [...tasks].filter((task) => TERMINAL_STATUSES.has(task.status));
  const eventIndex = indexLifecycleEvents(auditEvents, new Set(terminalTaskRows.map((task) => task.id)));
  const samples = {
    createToClaim: [] as number[],
    claimToStart: [] as number[],
    startToComplete: [] as number[],
    createToComplete: [] as number[],
  };
  const stages = { created: 0, claimed: 0, started: 0, completed: 0 };
  const missing = { created: 0, claimed: 0, started: 0, completed: 0 };
  let terminalTasks = 0;
  let completeChains = 0;
  let invalidChains = 0;

  for (const task of terminalTaskRows) {
    terminalTasks += 1;
    const row = eventIndex.byTaskId.get(task.id);
    const terminalAction = TERMINAL_ACTION_FOR_STATUS[task.status];
    const createdAt = preferredEventTime(row, "task.created", task.createdAt, "earliest");
    const completedAt = terminalAction
      ? preferredEventTime(row, terminalAction, task.completedAt, "latest")
      : timestampMs(task.completedAt);
    const claimEventTimes = row?.timesByAction["task.claimed"] ?? [];
    const claimedFallback = timestampMs(task.claimedAt);
    const claimCandidates = [...claimEventTimes];
    if (claimedFallback !== null && !claimCandidates.includes(claimedFallback)) claimCandidates.push(claimedFallback);
    claimCandidates.sort((left, right) => left - right);
    const claimedAt = latestWithin(claimCandidates, createdAt, completedAt);
    const startEventTimes = row?.timesByAction["task.started"] ?? [];
    const startedAt = claimedAt === null ? null : latestWithin(startEventTimes, claimedAt, completedAt);
    const hasCreatedSignal = hasTimestampSignal(row, "task.created", task.createdAt);
    const hasClaimSignal = hasTimestampSignal(row, "task.claimed", task.claimedAt);
    const hasStartSignal = hasTimestampSignal(row, "task.started", undefined);
    const hasCompletedSignal = terminalAction
      ? hasTimestampSignal(row, terminalAction, task.completedAt)
      : Boolean(task.completedAt);

    if (createdAt === null) {
      if (!hasCreatedSignal) missing.created += 1;
    } else stages.created += 1;
    if (claimedAt === null) {
      if (!hasClaimSignal) missing.claimed += 1;
    } else stages.claimed += 1;
    if (startedAt === null) {
      if (!hasStartSignal) missing.started += 1;
    } else stages.started += 1;
    if (completedAt === null) {
      if (!hasCompletedSignal) missing.completed += 1;
    } else stages.completed += 1;

    const orderingInvalid =
      (createdAt === null && hasCreatedSignal)
      || (completedAt === null && hasCompletedSignal)
      || (createdAt !== null && completedAt !== null && completedAt < createdAt)
      || (claimedAt === null && hasClaimSignal)
      || (startedAt === null && hasStartSignal);
    if (orderingInvalid) invalidChains += 1;

    if (createdAt !== null && claimedAt !== null) samples.createToClaim.push(claimedAt - createdAt);
    if (claimedAt !== null && startedAt !== null) samples.claimToStart.push(startedAt - claimedAt);
    if (startedAt !== null && completedAt !== null) samples.startToComplete.push(completedAt - startedAt);
    if (createdAt !== null && completedAt !== null && completedAt >= createdAt) {
      samples.createToComplete.push(completedAt - createdAt);
    }
    if (createdAt !== null && claimedAt !== null && startedAt !== null && completedAt !== null) {
      completeChains += 1;
    }
  }

  const segments = {
    createToClaim: summarizeTaskLatency(samples.createToClaim),
    claimToStart: summarizeTaskLatency(samples.claimToStart),
    startToComplete: summarizeTaskLatency(samples.startToComplete),
    createToComplete: summarizeTaskLatency(samples.createToComplete),
  };
  const phaseOrder: TaskLifecycleLatencySegment[] = ["createToClaim", "claimToStart", "startToComplete"];
  const bottleneckByP95 = phaseOrder
    .map((segment, order) => ({ segment, order, p95Ms: segments[segment].p95Ms }))
    .filter((row): row is { segment: TaskLifecycleLatencySegment; order: number; p95Ms: number } => row.p95Ms !== null)
    .sort((left, right) => (right.p95Ms - left.p95Ms) || (left.order - right.order))[0] ?? null;

  return {
    schemaVersion: "a2a.task-lifecycle-latency.v1",
    measurementPolicy: {
      selection: "terminal tasks in the requested stats window",
      attempt: "latest monotonic claim/start pair before terminal completion",
      percentile: "nearest-rank",
    },
    coverage: {
      terminalTasks,
      completeChains,
      stages,
      missing,
      invalidChains,
      invalidTimestampEvents: eventIndex.invalidTimestampEvents,
    },
    segments,
    bottleneckByP95: bottleneckByP95
      ? { segment: bottleneckByP95.segment, p95Ms: bottleneckByP95.p95Ms }
      : null,
  };
}

function assertValidWindow(options: TaskStatsOptions): void {
  const { since, until } = options;
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) {
    throw new Error("since must be a valid ISO timestamp");
  }
  if (!(until instanceof Date) || Number.isNaN(until.getTime())) {
    throw new Error("until must be a valid ISO timestamp");
  }
  if (since.getTime() > until.getTime()) {
    throw new Error("since must be <= until");
  }
  const maxWindowMs = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS;
  if (until.getTime() - since.getTime() > maxWindowMs) {
    throw new Error("stats window must not exceed 7 days");
  }
}

function taskTimestampMs(task: TaskRecord): number {
  const timestamp = task.completedAt ?? task.updatedAt ?? task.createdAt;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? 0 : ms;
}

function increment(map: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorCodeFromJsonText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { error?: { code?: unknown } };
      const code = stringFromUnknown(parsed.error?.code);
      if (code) return code;
    } catch {
      // Keep looking: excerpts may include bounded/truncated text around JSON.
    }
  }
  return undefined;
}

function nestedClassFromError(task: TaskRecord): string | undefined {
  const details = task.error?.details;
  if (!details || typeof details !== "object") {
    return task.status === "failed" ? "no_stdout" : undefined;
  }
  const nestedError = (details as { nestedError?: unknown }).nestedError;
  if (nestedError && typeof nestedError === "object") {
    const code = stringFromUnknown((nestedError as { code?: unknown }).code);
    if (code) return code;
  }
  const directError = (details as { error?: unknown }).error;
  if (directError && typeof directError === "object") {
    const code = stringFromUnknown((directError as { code?: unknown }).code);
    if (code) return code;
  }
  const explicit = stringFromUnknown((details as { nestedClass?: unknown }).nestedClass)
    ?? stringFromUnknown((details as { class?: unknown }).class);
  if (explicit) return explicit;
  const fromStdout = errorCodeFromJsonText((details as { stdout?: unknown }).stdout)
    ?? errorCodeFromJsonText((details as { excerpt?: unknown }).excerpt);
  if (fromStdout) return fromStdout;
  return task.status === "failed" ? "no_stdout" : undefined;
}

function stageFromError(task: TaskRecord): string | undefined {
  const details = task.error?.details;
  if (!details || typeof details !== "object") return undefined;
  return stringFromUnknown((details as { stage?: unknown }).stage);
}

function parentRoundIdFromTask(task: TaskRecord): string | undefined {
  return task.parentRoundId ?? stringFromUnknown(task.payload?.parentRoundId);
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export function aggregateTaskStats(tasks: Iterable<TaskRecord>, options: TaskStatsOptions): TaskStatsResponse {
  assertValidWindow(options);
  const sinceMs = options.since.getTime();
  const untilMs = options.until.getTime();
  const byStatus: Record<string, number> = {};
  const byErrorCode: Record<string, number> = {};
  const byNestedClass: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  const byWorkerClass: Record<string, number> = {};
  const rounds = new Map<string, { failed: number; total: number }>();
  const selectedTasks: TaskRecord[] = [];
  let total = 0;

  for (const task of tasks) {
    const timestampMs = taskTimestampMs(task);
    if (timestampMs < sinceMs || timestampMs > untilMs) continue;
    selectedTasks.push(task);
    total += 1;
    increment(byStatus, task.status);
    increment(byErrorCode, task.error?.code);
    increment(byNestedClass, nestedClassFromError(task));
    increment(byStage, stageFromError(task));
    increment(byWorkerClass, options.workerClassForTask?.(task) ?? "unclassified");
    const parentRoundId = parentRoundIdFromTask(task);
    if (parentRoundId) {
      const row = rounds.get(parentRoundId) ?? { failed: 0, total: 0 };
      row.total += 1;
      if (task.status === "failed") row.failed += 1;
      rounds.set(parentRoundId, row);
    }
  }

  const top = [...rounds.entries()]
    .map(([parentRoundId, value]) => ({ parentRoundId, failed: value.failed, total: value.total }))
    .sort((a, b) => (b.failed - a.failed) || (b.total - a.total) || a.parentRoundId.localeCompare(b.parentRoundId))
    .slice(0, options.maxRoundGroups ?? DEFAULT_TOP_ROUNDS);

  return {
    window: { since: options.since.toISOString(), until: options.until.toISOString() },
    total,
    byStatus: sortRecord(byStatus) as Partial<Record<TaskStatus, number>>,
    byErrorCode: sortRecord(byErrorCode),
    byNestedClass: sortRecord(byNestedClass),
    byStage: sortRecord(byStage),
    byWorkerClass: sortRecord(byWorkerClass),
    byRound: { top },
    latency: aggregateTaskLifecycleLatency(selectedTasks, options.auditEvents ?? []),
  };
}

export const WORKER_LATENCY_PROFILES_SCHEMA_VERSION = "a2a.worker-latency-profiles.v1" as const;

export const DEFAULT_MAX_WORKER_PROFILES = 128;
export const MAX_FAILURE_CODES_PER_WORKER = 5;

// ---- #1815 item 1 slice: body-free receipt measurements -------------------
// Producer-side contract mirrored from
// packages/broker/scripts/lib/analysis-execution-telemetry.mjs (do not widen:
// the producer owns normalization; this read path only counts bounded facts).

export const WORKER_RECEIPT_TELEMETRY_SCHEMA_VERSION = "a2a.analysis-execution-telemetry.v1" as const;

export const WORKER_RECEIPT_TELEMETRY_SOURCES = Object.freeze([
  "piri_progress_file",
  "claude_cli_envelope",
] as const);

export type WorkerReceiptTelemetrySource = (typeof WORKER_RECEIPT_TELEMETRY_SOURCES)[number];

export const WORKER_RECEIPT_SCHEMA_RETRY_REASONS = Object.freeze([
  "extra_property",
  "missing_field",
  "invalid_value",
  "no_json_candidate",
  "provider_failure",
  "other",
] as const);

export type WorkerReceiptSchemaRetryReason = (typeof WORKER_RECEIPT_SCHEMA_RETRY_REASONS)[number];

export interface ReceiptNumericDistribution {
  count: number;
  min: number | null;
  max: number | null;
  average: number | null;
  p50: number | null;
  p95: number | null;
}

export interface WorkerReceiptCarrierCounts {
  /** Terminal tasks whose receipt came from error.details.bridgeFailure. */
  structuredBridgeFailure: number;
  /** Terminal tasks whose receipt came from result.output (success or preserved). */
  resultOutput: number;
  /** Terminal tasks with neither carrier — absence is reported, never imputed. */
  none: number;
}

export interface WorkerReceiptSourceBytes {
  /** Tasks whose chosen carrier carried a valid non-negative safe-integer totalBytes. */
  observed: number;
  /** Tasks whose chosen carrier had no valid totalBytes (absent or malformed). */
  missing: number;
  totalBytes: ReceiptNumericDistribution;
}

export interface WorkerReceiptModelRequests {
  /** Observed telemetry samples carrying a valid modelRequests count. */
  observed: number;
  /** Sum over those samples only — never padded with imputed zeros. */
  total: number;
  distribution: ReceiptNumericDistribution;
}

export interface WorkerReceiptSchemaRetries {
  /** Observed telemetry samples carrying a valid schemaRetries count. */
  observed: number;
  total: number;
  /** Samples with a strictly positive count. */
  tasksWithRetries: number;
  /** Explicit valid zero counts — a real observation, distinct from absence. */
  tasksWithZero: number;
  /** Bounded-enum reason totals; unknown keys are dropped, never emitted. */
  reasons: Partial<Record<WorkerReceiptSchemaRetryReason, number>>;
}

export interface WorkerReceiptTelemetry {
  /** Carrier carried a well-formed a2a.analysis-execution-telemetry.v1 object. */
  observed: number;
  /** Carrier carried no telemetry object at all. */
  missing: number;
  /** Telemetry present but rejected by strict validation (schema/source/shape). */
  invalid: number;
  /** Observed telemetry that self-reports truncated:true. */
  truncated: number;
  modelRequests: WorkerReceiptModelRequests;
  schemaRetries: WorkerReceiptSchemaRetries;
}

export interface WorkerReceiptLiteralEqualityCounts {
  bothObserved: number;
  literalMatch: number;
  literalDifference: number;
}

export interface WorkerReceiptModelMetadata {
  requestedModelObserved: number;
  actualRuntimeModelObserved: number;
  effectiveModelObserved: number;
  requestedThinkingObserved: number;
  effectiveThinkingObserved: number;
  /**
   * Literal string equality only: alias-equivalent ids (e.g. "k3[1m]" vs a
   * canonical provider id) count as literal differences here. This is NOT
   * evidence of a runtime mismatch by itself and no model names are emitted.
   */
  requestedActualModelLiteralEquality: WorkerReceiptLiteralEqualityCounts;
  /** No "actual thinking" carrier exists; requested/effective only, never inferred. */
  requestedEffectiveThinkingLiteralEquality: WorkerReceiptLiteralEqualityCounts;
}

export interface WorkerReceiptProfile {
  carriers: WorkerReceiptCarrierCounts;
  sourceBytes: WorkerReceiptSourceBytes;
  executionTelemetry: WorkerReceiptTelemetry;
  modelMetadata: WorkerReceiptModelMetadata;
}

/** Strict non-negative safe integer: no string/boolean/float coercion. */
function receiptCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function receiptObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type ParsedReceiptTelemetry =
  | { state: "missing" }
  | { state: "invalid" }
  | {
    state: "observed";
    truncated: boolean;
    modelRequests: number | undefined;
    schemaRetries: number | undefined;
    schemaRetryReasons: Partial<Record<WorkerReceiptSchemaRetryReason, number>>;
  };

function parseReceiptTelemetry(value: unknown): ParsedReceiptTelemetry {
  if (value === undefined) return { state: "missing" };
  const carrier = receiptObject(value);
  if (!carrier) return { state: "invalid" };
  if (carrier.schemaVersion !== WORKER_RECEIPT_TELEMETRY_SCHEMA_VERSION) return { state: "invalid" };
  if (!WORKER_RECEIPT_TELEMETRY_SOURCES.includes(carrier.source as WorkerReceiptTelemetrySource)) {
    return { state: "invalid" };
  }
  const rawReasons = receiptObject(carrier.schemaRetryReasons);
  const schemaRetryReasons: Partial<Record<WorkerReceiptSchemaRetryReason, number>> = {};
  if (rawReasons) {
    for (const reason of WORKER_RECEIPT_SCHEMA_RETRY_REASONS) {
      const count = receiptCount(rawReasons[reason]);
      if (count !== undefined) schemaRetryReasons[reason] = count;
    }
  }
  return {
    state: "observed",
    truncated: carrier.truncated === true,
    modelRequests: receiptCount(carrier.modelRequests),
    schemaRetries: receiptCount(carrier.schemaRetries),
    schemaRetryReasons,
  };
}

type ReceiptCarrierKind = "structuredBridgeFailure" | "resultOutput";

interface ReceiptCarrier {
  kind: ReceiptCarrierKind;
  sourceCarrierStats: Record<string, unknown> | undefined;
  telemetryRaw: unknown;
  requestedModel: unknown;
  requestedThinking: unknown;
  actualRuntimeModel: unknown;
  effectiveModel: unknown;
  effectiveThinking: unknown;
}

function carrierFrom(kind: ReceiptCarrierKind, carrier: Record<string, unknown>): ReceiptCarrier {
  return {
    kind,
    sourceCarrierStats: receiptObject(carrier.sourceCarrierStats),
    telemetryRaw: carrier.executionTelemetry,
    requestedModel: carrier.requestedModel,
    requestedThinking: carrier.requestedThinking,
    actualRuntimeModel: carrier.actualRuntimeModel,
    effectiveModel: carrier.effectiveModel,
    effectiveThinking: carrier.effectiveThinking,
  };
}

/**
 * Deterministic one-receipt-per-task carrier precedence: a structured bridge
 * failure on a failed task wins so success-side metadata can never hide a
 * failure receipt; otherwise preserved/success result output; a non-failed
 * task with only a bridge-failure detail still reports through it.
 */
export function receiptCarrierForTask(task: TaskRecord): ReceiptCarrier | undefined {
  const details = receiptObject(task.error?.details);
  const bridgeFailure = receiptObject(details?.bridgeFailure);
  const output = receiptObject(task.result?.output);
  if (task.status === "failed" && bridgeFailure) return carrierFrom("structuredBridgeFailure", bridgeFailure);
  if (output) return carrierFrom("resultOutput", output);
  if (bridgeFailure) return carrierFrom("structuredBridgeFailure", bridgeFailure);
  return undefined;
}

function countLiteralEquality(
  counts: WorkerReceiptLiteralEqualityCounts,
  left: string | undefined,
  right: string | undefined,
): void {
  if (left === undefined || right === undefined) return;
  counts.bothObserved += 1;
  if (left === right) counts.literalMatch += 1;
  else counts.literalDifference += 1;
}

function summarizeReceiptSamples(values: readonly number[]): ReceiptNumericDistribution {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, min: null, max: null, average: null, p50: null, p95: null };
  }
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    average: Math.round((sum / sorted.length) * 1_000) / 1_000,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
  };
}

interface WorkerReceiptTally extends WorkerReceiptProfile {
  byteSamples: number[];
  modelRequestSamples: number[];
  schemaRetryReasonTotals: Map<WorkerReceiptSchemaRetryReason, number>;
  add(carrier: ReceiptCarrier | undefined): void;
}

function emptyReceiptTally(): WorkerReceiptTally {
  const tally: WorkerReceiptTally = {
    carriers: { structuredBridgeFailure: 0, resultOutput: 0, none: 0 },
    sourceBytes: { observed: 0, missing: 0, totalBytes: { count: 0, min: null, max: null, average: null, p50: null, p95: null } },
    executionTelemetry: {
      observed: 0,
      missing: 0,
      invalid: 0,
      truncated: 0,
      modelRequests: { observed: 0, total: 0, distribution: { count: 0, min: null, max: null, average: null, p50: null, p95: null } },
      schemaRetries: { observed: 0, total: 0, tasksWithRetries: 0, tasksWithZero: 0, reasons: {} },
    },
    modelMetadata: {
      requestedModelObserved: 0,
      actualRuntimeModelObserved: 0,
      effectiveModelObserved: 0,
      requestedThinkingObserved: 0,
      effectiveThinkingObserved: 0,
      requestedActualModelLiteralEquality: { bothObserved: 0, literalMatch: 0, literalDifference: 0 },
      requestedEffectiveThinkingLiteralEquality: { bothObserved: 0, literalMatch: 0, literalDifference: 0 },
    },
    byteSamples: [],
    modelRequestSamples: [],
    schemaRetryReasonTotals: new Map(),
    add(carrier: ReceiptCarrier | undefined): void {
      if (!carrier) {
        tally.carriers.none += 1;
        return;
      }
      if (carrier.kind === "structuredBridgeFailure") tally.carriers.structuredBridgeFailure += 1;
      else tally.carriers.resultOutput += 1;

      const totalBytes = receiptCount(carrier.sourceCarrierStats?.totalBytes);
      if (totalBytes === undefined) tally.sourceBytes.missing += 1;
      else {
        tally.sourceBytes.observed += 1;
        tally.byteSamples.push(totalBytes);
      }

      const parsed = parseReceiptTelemetry(carrier.telemetryRaw);
      if (parsed.state === "missing") tally.executionTelemetry.missing += 1;
      else if (parsed.state === "invalid") tally.executionTelemetry.invalid += 1;
      else {
        tally.executionTelemetry.observed += 1;
        if (parsed.truncated) tally.executionTelemetry.truncated += 1;
        if (parsed.modelRequests !== undefined) {
          tally.executionTelemetry.modelRequests.observed += 1;
          tally.executionTelemetry.modelRequests.total += parsed.modelRequests;
          tally.modelRequestSamples.push(parsed.modelRequests);
        }
        const retries = tally.executionTelemetry.schemaRetries;
        if (parsed.schemaRetries !== undefined) {
          retries.observed += 1;
          retries.total += parsed.schemaRetries;
          if (parsed.schemaRetries === 0) retries.tasksWithZero += 1;
          else retries.tasksWithRetries += 1;
        }
        for (const reason of WORKER_RECEIPT_SCHEMA_RETRY_REASONS) {
          const count = parsed.schemaRetryReasons[reason];
          if (count !== undefined) {
            tally.schemaRetryReasonTotals.set(reason, (tally.schemaRetryReasonTotals.get(reason) ?? 0) + count);
          }
        }
      }

      const metadata = tally.modelMetadata;
      const requestedModel = stringFromUnknown(carrier.requestedModel);
      const actualRuntimeModel = stringFromUnknown(carrier.actualRuntimeModel);
      const effectiveModel = stringFromUnknown(carrier.effectiveModel);
      const requestedThinking = stringFromUnknown(carrier.requestedThinking);
      const effectiveThinking = stringFromUnknown(carrier.effectiveThinking);
      if (requestedModel !== undefined) metadata.requestedModelObserved += 1;
      if (actualRuntimeModel !== undefined) metadata.actualRuntimeModelObserved += 1;
      if (effectiveModel !== undefined) metadata.effectiveModelObserved += 1;
      if (requestedThinking !== undefined) metadata.requestedThinkingObserved += 1;
      if (effectiveThinking !== undefined) metadata.effectiveThinkingObserved += 1;
      countLiteralEquality(metadata.requestedActualModelLiteralEquality, requestedModel, actualRuntimeModel);
      countLiteralEquality(metadata.requestedEffectiveThinkingLiteralEquality, requestedThinking, effectiveThinking);
    },
  };
  return tally;
}

function receiptProfileFromTally(tally: WorkerReceiptTally): WorkerReceiptProfile {
  const reasons: Partial<Record<WorkerReceiptSchemaRetryReason, number>> = {};
  for (const reason of WORKER_RECEIPT_SCHEMA_RETRY_REASONS) {
    const count = tally.schemaRetryReasonTotals.get(reason);
    if (count !== undefined && count > 0) reasons[reason] = count;
  }
  return {
    carriers: { ...tally.carriers },
    sourceBytes: {
      observed: tally.sourceBytes.observed,
      missing: tally.sourceBytes.missing,
      totalBytes: summarizeReceiptSamples(tally.byteSamples),
    },
    executionTelemetry: {
      observed: tally.executionTelemetry.observed,
      missing: tally.executionTelemetry.missing,
      invalid: tally.executionTelemetry.invalid,
      truncated: tally.executionTelemetry.truncated,
      modelRequests: {
        observed: tally.executionTelemetry.modelRequests.observed,
        total: tally.executionTelemetry.modelRequests.total,
        distribution: summarizeReceiptSamples(tally.modelRequestSamples),
      },
      schemaRetries: {
        observed: tally.executionTelemetry.schemaRetries.observed,
        total: tally.executionTelemetry.schemaRetries.total,
        tasksWithRetries: tally.executionTelemetry.schemaRetries.tasksWithRetries,
        tasksWithZero: tally.executionTelemetry.schemaRetries.tasksWithZero,
        reasons,
      },
    },
    modelMetadata: {
      requestedModelObserved: tally.modelMetadata.requestedModelObserved,
      actualRuntimeModelObserved: tally.modelMetadata.actualRuntimeModelObserved,
      effectiveModelObserved: tally.modelMetadata.effectiveModelObserved,
      requestedThinkingObserved: tally.modelMetadata.requestedThinkingObserved,
      effectiveThinkingObserved: tally.modelMetadata.effectiveThinkingObserved,
      requestedActualModelLiteralEquality: { ...tally.modelMetadata.requestedActualModelLiteralEquality },
      requestedEffectiveThinkingLiteralEquality: { ...tally.modelMetadata.requestedEffectiveThinkingLiteralEquality },
    },
  };
}

export interface WorkerLatencyProfileOptions {
  /** Deterministic cap on emitted profiles; overflow is counted, never silent. */
  maxWorkers?: number;
  /** Inclusive window bounds on the task's terminal timestamp (completedAt ?? updatedAt ?? createdAt), ms epoch. */
  window?: { sinceMs: number; untilMs: number };
}

export interface WorkerLatencyProfileSegments {
  /** task.started → terminal completion (execution time as the broker saw it). */
  runMs: TaskLatencyDistribution;
  /** task.created → task.claimed (dispatch wait). */
  queueMs: TaskLatencyDistribution;
  /** task.created → terminal completion. */
  totalMs: TaskLatencyDistribution;
}

export interface WorkerLatencyFailureCodeCount {
  code: string;
  count: number;
}

export interface WorkerLatencyProfile {
  workerId: string;
  terminalTasks: number;
  /** Terminal tasks with a monotonic created→claimed→started→completed chain. */
  completeChains: number;
  byStatus: { succeeded: number; failed: number; canceled: number };
  /** Deterministic top failure codes (count desc, code asc), bounded. */
  failureCodes: { top: WorkerLatencyFailureCodeCount[] };
  latency: WorkerLatencyProfileSegments;
  /** Body-free receipt measurements (#1815 item 1 slice); counts/distributions only. */
  receipts: WorkerReceiptProfile;
}

export interface WorkerLatencyProfilesResponse {
  schemaVersion: typeof WORKER_LATENCY_PROFILES_SCHEMA_VERSION;
  viewMode: "read_only_advisory";
  automaticRoutingPolicy: "none";
  measurementPolicy: {
    selection: "terminal tasks in the requested stats window";
    attempt: "latest monotonic claim/start pair before terminal completion";
    percentile: "nearest-rank";
    consumption: "tie-break only after capability/independence/team/readiness filters";
    receiptCarrier: "one receipt per terminal task; structured bridge failure wins over preserved result output; absent carriers are never counted as zeros";
    modelComparison: "literal identifier equality only; alias-equivalent model ids are not resolved and no model names are emitted";
  };
  coverage: {
    workers: number;
    truncatedWorkers: number;
    invalidTimestampEvents: number;
    tasksWithoutWorkerIdentity: number;
    /** Receipt coverage spans every in-window terminal task, unattributed ones included. */
    receipts: {
      withCarrier: number;
      structuredBridgeFailure: number;
      resultOutput: number;
      none: number;
    };
    executionTelemetry: {
      observed: number;
      missing: number;
      invalid: number;
      truncated: number;
    };
  };
  profiles: WorkerLatencyProfile[];
}

interface WorkerAccumulator {
  terminalTasks: number;
  completeChains: number;
  byStatus: { succeeded: number; failed: number; canceled: number };
  failureCodeCounts: Map<string, number>;
  runSamples: number[];
  queueSamples: number[];
  totalSamples: number[];
  receipts: WorkerReceiptTally;
}

function emptyAccumulator(): WorkerAccumulator {
  return {
    terminalTasks: 0,
    completeChains: 0,
    byStatus: { succeeded: 0, failed: 0, canceled: 0 },
    failureCodeCounts: new Map(),
    runSamples: [],
    queueSamples: [],
    totalSamples: [],
    receipts: emptyReceiptTally(),
  };
}

/** Terminal tasks only, grouped by assigned worker (falling back to target node). */
export function workerIdentityForTask(task: TaskRecord): string | undefined {
  return task.assignedWorkerId ?? task.targetNodeId;
}

export function aggregateWorkerLatencyProfiles(
  tasks: Iterable<TaskRecord>,
  auditEvents: Iterable<AuditEvent>,
  options: WorkerLatencyProfileOptions = {},
): WorkerLatencyProfilesResponse {
  const maxWorkers = Math.max(1, Math.floor(options.maxWorkers ?? DEFAULT_MAX_WORKER_PROFILES));
  const windowMs = options.window;
  const terminalTaskRows = [...tasks]
    .filter((task) => TERMINAL_STATUSES.has(task.status))
    .filter((task) => {
      if (!windowMs) return true;
      const timestamp = workerProfileTimestampMs(task);
      return timestamp >= windowMs.sinceMs && timestamp <= windowMs.untilMs;
    });

  const identityByTaskId = new Map<string, string>();
  const unattributed = new Set<string>();
  const coverageReceipts = emptyReceiptTally();
  for (const task of terminalTaskRows) {
    const workerId = workerIdentityForTask(task);
    if (workerId === undefined || workerId === "") {
      unattributed.add(task.id);
      // Unattributed tasks still count toward coverage receipts so nothing in
      // the window silently disappears from the report.
      coverageReceipts.add(receiptCarrierForTask(task));
      continue;
    }
    identityByTaskId.set(task.id, workerId);
  }

  const eventIndex = indexLifecycleEvents(auditEvents, new Set(identityByTaskId.keys()));
  const workers = new Map<string, WorkerAccumulator>();

  for (const task of terminalTaskRows) {
    const workerId = identityByTaskId.get(task.id);
    if (workerId === undefined) continue;
    const acc = workers.get(workerId) ?? emptyAccumulator();
    acc.terminalTasks += 1;
    acc.byStatus[task.status as keyof WorkerAccumulator["byStatus"]] += 1;
    if (task.status === "failed" && task.error?.code) {
      acc.failureCodeCounts.set(task.error.code, (acc.failureCodeCounts.get(task.error.code) ?? 0) + 1);
    }

    const row: IndexedLifecycleEvents | undefined = eventIndex.byTaskId.get(task.id);
    const terminalAction = TERMINAL_ACTION_FOR_STATUS[task.status];
    const createdAt = preferredEventTime(row, "task.created", task.createdAt, "earliest");
    const completedAt = terminalAction
      ? preferredEventTime(row, terminalAction, task.completedAt, "latest")
      : timestampMs(task.completedAt);
    const claimCandidates = [...(row?.timesByAction["task.claimed"] ?? [])];
    const claimedFallback = timestampMs(task.claimedAt);
    if (claimedFallback !== null && !claimCandidates.includes(claimedFallback)) claimCandidates.push(claimedFallback);
    claimCandidates.sort((left, right) => left - right);
    const claimedAt = latestWithin(claimCandidates, createdAt, completedAt);
    const startedAt = claimedAt === null ? null : latestWithin(row?.timesByAction["task.started"] ?? [], claimedAt, completedAt);

    const chainMonotonic =
      createdAt !== null
      && claimedAt !== null
      && startedAt !== null
      && completedAt !== null
      && createdAt <= claimedAt
      && claimedAt <= startedAt
      && startedAt <= completedAt;
    if (chainMonotonic) {
      acc.completeChains += 1;
      acc.queueSamples.push(claimedAt - createdAt);
      acc.runSamples.push(completedAt - startedAt);
      acc.totalSamples.push(completedAt - createdAt);
    }

    const carrier = receiptCarrierForTask(task);
    acc.receipts.add(carrier);
    coverageReceipts.add(carrier);

    workers.set(workerId, acc);
  }

  // Deterministic emission order: terminal volume desc, then workerId asc.
  const ordered = [...workers.entries()].sort((left, right) => {
    const volume = right[1].terminalTasks - left[1].terminalTasks;
    if (volume !== 0) return volume;
    return left[0].localeCompare(right[0]);
  });
  const truncatedWorkers = Math.max(0, ordered.length - maxWorkers);
  const emitted = ordered.slice(0, maxWorkers);

  const profiles: WorkerLatencyProfile[] = emitted.map(([workerId, acc]) => ({
    workerId,
    terminalTasks: acc.terminalTasks,
    completeChains: acc.completeChains,
    byStatus: { ...acc.byStatus },
    failureCodes: {
      top: [...acc.failureCodeCounts.entries()]
        .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))
        .slice(0, MAX_FAILURE_CODES_PER_WORKER)
        .map(([code, count]) => ({ code, count })),
    },
    latency: {
      runMs: summarizeTaskLatency(acc.runSamples),
      queueMs: summarizeTaskLatency(acc.queueSamples),
      totalMs: summarizeTaskLatency(acc.totalSamples),
    },
    receipts: receiptProfileFromTally(acc.receipts),
  }));

  return {
    schemaVersion: WORKER_LATENCY_PROFILES_SCHEMA_VERSION,
    viewMode: "read_only_advisory",
    automaticRoutingPolicy: "none",
    measurementPolicy: {
      selection: "terminal tasks in the requested stats window",
      attempt: "latest monotonic claim/start pair before terminal completion",
      percentile: "nearest-rank",
      consumption: "tie-break only after capability/independence/team/readiness filters",
      receiptCarrier: "one receipt per terminal task; structured bridge failure wins over preserved result output; absent carriers are never counted as zeros",
      modelComparison: "literal identifier equality only; alias-equivalent model ids are not resolved and no model names are emitted",
    },
    coverage: {
      workers: workers.size,
      truncatedWorkers,
      invalidTimestampEvents: eventIndex.invalidTimestampEvents,
      tasksWithoutWorkerIdentity: unattributed.size,
      receipts: {
        withCarrier: coverageReceipts.carriers.structuredBridgeFailure + coverageReceipts.carriers.resultOutput,
        structuredBridgeFailure: coverageReceipts.carriers.structuredBridgeFailure,
        resultOutput: coverageReceipts.carriers.resultOutput,
        none: coverageReceipts.carriers.none,
      },
      executionTelemetry: {
        observed: coverageReceipts.executionTelemetry.observed,
        missing: coverageReceipts.executionTelemetry.missing,
        invalid: coverageReceipts.executionTelemetry.invalid,
        truncated: coverageReceipts.executionTelemetry.truncated,
      },
    },
    profiles,
  };
}

/** Terminal-anchor timestamp for window filtering — same policy as aggregateTaskStats. */
function workerProfileTimestampMs(task: TaskRecord): number {
  const ms = timestampMs(task.completedAt ?? task.updatedAt ?? task.createdAt);
  return ms ?? 0;
}
