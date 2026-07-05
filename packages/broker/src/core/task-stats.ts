import type { TaskRecord, TaskStatus } from "./types.js";

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
}

export interface TaskRoundStats {
  parentRoundId: string;
  failed: number;
  total: number;
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
  let total = 0;

  for (const task of tasks) {
    const timestampMs = taskTimestampMs(task);
    if (timestampMs < sinceMs || timestampMs > untilMs) continue;
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
  };
}
