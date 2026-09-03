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
  };
  coverage: {
    workers: number;
    truncatedWorkers: number;
    invalidTimestampEvents: number;
    tasksWithoutWorkerIdentity: number;
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
  for (const task of terminalTaskRows) {
    const workerId = workerIdentityForTask(task);
    if (workerId === undefined || workerId === "") {
      unattributed.add(task.id);
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
    },
    coverage: {
      workers: workers.size,
      truncatedWorkers,
      invalidTimestampEvents: eventIndex.invalidTimestampEvents,
      tasksWithoutWorkerIdentity: unattributed.size,
    },
    profiles,
  };
}

/** Terminal-anchor timestamp for window filtering — same policy as aggregateTaskStats. */
function workerProfileTimestampMs(task: TaskRecord): number {
  const ms = timestampMs(task.completedAt ?? task.updatedAt ?? task.createdAt);
  return ms ?? 0;
}
