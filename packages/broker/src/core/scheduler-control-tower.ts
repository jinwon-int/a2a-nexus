/**
 * Scheduler control‑tower summary: worker‑level capacity signals and queue
 * grouping by worker, role, repo, task type, and priority.
 *
 * Pure functions only — no mutation, dispatch, ACK/replay, or DB writes.
 * Deterministic for identical inputs; suitable for CLI/UI consumption.
 *
 * Refs: a2a-plane#434, a2a-broker#905
 */
import type { A2AExchangeIntent, TaskRecord, TaskStatus, WorkerView } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Extraction dimension for queue grouping.
 * Each dimension produces a separate set of grouped entries.
 */
export type QueueGroupDimension = "worker" | "role" | "repo" | "task_type" | "priority";

/**
 * One group entry — tasks matching a specific value for a single dimension.
 */
export interface QueueGroupEntry {
  /**
   * The dimension label, e.g. "workergamma", "implementation", "jinwon-int/a2a-broker",
   * "propose_patch", or "default".
   */
  key: string;
  /** Number of tasks in this group (non‑terminal only). */
  count: number;
  /** Counts broken down by task status. */
  byStatus: Partial<Record<TaskStatus, number>>;
  /** ISO timestamp of the oldest task in this group, or null when empty. */
  oldestCreatedAt: string | null;
  /** Age in ms of the oldest task, or null. */
  oldestAgeMs: number | null;
}

/**
 * Per‑worker capacity signal.
 */
export interface WorkerCapacitySlot {
  workerId: string;
  role: string;
  displayName: string | undefined;
  status: "online" | "stale";
  lastSeenAt: string;
  /** Current task load (active tasks only). */
  activeTaskCount: number;
  queuedTaskCount: number;
  claimedTaskCount: number;
  runningTaskCount: number;
  /** Maximum concurrent tasks from capability card, or undefined if unknown. */
  maxConcurrentTasks?: number;
  /** Utilization fraction (0–1) when maxConcurrentTasks is known. */
  utilizationPct?: number;
  /** Slots remaining when maxConcurrentTasks is known. */
  remainingSlots?: number;
}

/**
 * Read‑only scheduler control‑tower summary (v2).
 * Extends the basic capacity summary with queue grouping by multiple
 * dimensions and enriched per‑worker capacity signals.
 */
export interface SchedulerControlTowerSummaryV2 {
  kind: "a2a-broker.scheduler-control-tower.summary-v2";
  version: 1;
  generatedAt: string;
  capacity: {
    workers: WorkerCapacitySlot[];
    totals: {
      workers: number;
      online: number;
      stale: number;
      activeTasks: number;
    };
  };
  groups: SchedulerControlTowerQueueGroups;
}

/**
 * Queue groupings for all five dimensions.
 */
export interface SchedulerControlTowerQueueGroups {
  byWorker: QueueGroupEntry[];
  byRole: QueueGroupEntry[];
  byRepo: QueueGroupEntry[];
  byTaskType: QueueGroupEntry[];
  byPriority: QueueGroupEntry[];
}

// ---------------------------------------------------------------------------
// Non‑terminal statuses used for grouping
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES: TaskStatus[] = ["blocked", "queued", "claimed", "running"];

// ---------------------------------------------------------------------------
// Repo extraction
// ---------------------------------------------------------------------------

/**
 * Extract a stable repo identifier from a task record.
 *
 * Priority order:
 * 1. `payload.githubRepo` (set by GitHub ingestion)
 * 2. `workspace.workspaceId`
 * 3. `"unknown"`
 */
export function extractRepo(task: TaskRecord): string {
  const fromPayload = task.payload?.githubRepo;
  if (typeof fromPayload === "string" && fromPayload.trim().length > 0) {
    return fromPayload.trim();
  }
  const fromWorkspace = task.workspace?.workspaceId;
  if (typeof fromWorkspace === "string" && fromWorkspace.trim().length > 0) {
    return fromWorkspace.trim();
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Priority extraction
// ---------------------------------------------------------------------------

/**
 * Task priority labels.
 *
 * Priority is not yet a native field on TaskRecord.  This function checks the
 * payload and workspace for an optional `priority` signal, defaulting to
 * `"default"`.  The string union is intentionally loose so callers and future
 * code can introduce new levels without changing this module's types.
 */
export type TaskPriorityLevel = "default" | "low" | "medium" | "high" | "critical";

/**
 * Extract a priority level from a task record.
 *
 * Currently always returns `"default"` because no native priority field
 * exists.  The signature accepts a task so that future implementations can
 * read payload metadata or a dedicated column without changing callers.
 */
export function extractPriority(_task: TaskRecord): TaskPriorityLevel {
  // check payload for an explicit priority signal (future-proofing)
  if (typeof _task.payload?.priority === "string") {
    const p = _task.payload.priority.toLowerCase();
    if (["low", "medium", "high", "critical"].includes(p)) return p as TaskPriorityLevel;
  }
  return "default";
}

// ---------------------------------------------------------------------------
// Worker ID extraction
// ---------------------------------------------------------------------------

/**
 * Return the stable identifier for the worker that this task targets.
 * Prefers `assignedWorkerId`, falls back to `targetNodeId`.
 */
export function extractWorkerId(task: TaskRecord): string {
  return task.assignedWorkerId ?? task.targetNodeId ?? "unassigned";
}

// ---------------------------------------------------------------------------
// Queue group – single dimension
// ---------------------------------------------------------------------------

/**
 * Group non‑terminal tasks by a single extracted dimension.
 *
 * @param tasks – all task records; only active (non‑terminal) tasks are grouped.
 * @param extractKey – function returning the group key for each task.
 * @returns sorted array of group entries (highest count first).
 */
export function groupTasksBy<T extends string>(
  tasks: readonly TaskRecord[],
  extractKey: (task: TaskRecord) => T,
): QueueGroupEntry[] {
  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  if (active.length === 0) return [];

  const map = new Map<T, { count: number; byStatus: Partial<Record<TaskStatus, number>>; oldestCreatedAt: string | null; oldestMs: number | null }>();

  for (const task of active) {
    const key = extractKey(task);
    let entry = map.get(key);
    if (!entry) {
      entry = { count: 0, byStatus: {}, oldestCreatedAt: null, oldestMs: null };
      map.set(key, entry);
    }
    entry.count += 1;
    entry.byStatus[task.status] = (entry.byStatus[task.status] ?? 0) + 1;

    const createdAtMs = Date.parse(task.createdAt);
    if (Number.isFinite(createdAtMs)) {
      if (entry.oldestMs === null || createdAtMs < entry.oldestMs) {
        entry.oldestMs = createdAtMs;
        entry.oldestCreatedAt = task.createdAt;
      }
    }
  }

  const nowMs = Date.now();
  const entries: QueueGroupEntry[] = [];
  for (const [key, val] of map) {
    entries.push({
      key,
      count: val.count,
      byStatus: val.byStatus,
      oldestCreatedAt: val.oldestCreatedAt,
      oldestAgeMs: val.oldestMs !== null ? nowMs - val.oldestMs : null,
    });
  }

  entries.sort((a, b) => b.count - a.count);
  return entries;
}

// ---------------------------------------------------------------------------
// Worker capacity signals
// ---------------------------------------------------------------------------

/**
 * Build per‑worker capacity signals from task and worker records.
 *
 * Each slot includes the worker's current task load (by status) and
 * optional maximum capacity when a capability card provides it.
 *
 * @param tasks – all task records (active statuses relevant).
 * @param workers – current worker views.
 * @param maxConcurrentOverrides – optional worker‑id → max concurrent tasks map
 *                                  (typically sourced from capability cards).
 * @param options.nowMs – snapshot time override (for testing).
 * @param options.workerOfflineAfterMs – staleness threshold in ms.
 */
export function buildWorkerCapacitySlots(
  tasks: readonly TaskRecord[],
  workers: readonly WorkerView[],
  maxConcurrentOverrides?: ReadonlyMap<string, number>,
  options?: { nowMs?: number; workerOfflineAfterMs?: number },
): WorkerCapacitySlot[] {
  const nowMs = options?.nowMs ?? Date.now();
  const offlineAfterMs = options?.workerOfflineAfterMs ?? 90_000;
  const workerMap = new Map<string, WorkerView>();
  for (const w of workers) workerMap.set(w.nodeId, w);

  // Active tasks bucketed by worker
  const activeTasks = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const tasksByWorker = new Map<string, TaskRecord[]>();
  for (const task of activeTasks) {
    const wid = extractWorkerId(task);
    const bucket = tasksByWorker.get(wid) ?? [];
    bucket.push(task);
    tasksByWorker.set(wid, bucket);
  }

  const allWorkerIds = new Set([...workerMap.keys(), ...tasksByWorker.keys()]);
  const slots: WorkerCapacitySlot[] = [];

  for (const wid of allWorkerIds) {
    const worker = workerMap.get(wid);
    const workerTasks = tasksByWorker.get(wid) ?? [];
    const isStale = worker ? workerStale(worker.lastSeenAt, offlineAfterMs, nowMs) : true;

    let queued = 0, claimed = 0, running = 0;
    for (const t of workerTasks) {
      if (t.status === "queued") queued++;
      else if (t.status === "claimed") claimed++;
      else if (t.status === "running") running++;
    }
    const activeCount = workerTasks.length;

    const maxConcurrent = maxConcurrentOverrides?.get(wid);
    const utilizationPct = maxConcurrent !== undefined && maxConcurrent > 0
      ? Math.round((activeCount / maxConcurrent) * 100)
      : undefined;
    const remainingSlots = maxConcurrent !== undefined
      ? Math.max(0, maxConcurrent - activeCount)
      : undefined;

    slots.push({
      workerId: wid,
      role: worker?.role ?? "unknown",
      displayName: worker?.displayName,
      status: isStale ? "stale" : "online",
      lastSeenAt: worker?.lastSeenAt ?? "",
      activeTaskCount: activeCount,
      queuedTaskCount: queued,
      claimedTaskCount: claimed,
      runningTaskCount: running,
      maxConcurrentTasks: maxConcurrent,
      utilizationPct,
      remainingSlots,
    });
  }

  slots.sort((a, b) => b.activeTaskCount - a.activeTaskCount);
  return slots;
}

// ---------------------------------------------------------------------------
// Full summary builder
// ---------------------------------------------------------------------------

/**
 * Build the full read‑only scheduler control‑tower summary (v2).
 *
 * Combines per‑worker capacity signals and queue groupings across all
 * five dimensions.
 *
 * @param tasks – all known task records.
 * @param workers – current worker views.
 * @param maxConcurrentOverrides – optional worker → max concurrent map.
 * @param options – snapshot time / staleness overrides for testing.
 */
export function buildSchedulerControlTowerSummaryV2(
  tasks: readonly TaskRecord[],
  workers: readonly WorkerView[],
  maxConcurrentOverrides?: ReadonlyMap<string, number>,
  options?: { nowMs?: number; workerOfflineAfterMs?: number },
): SchedulerControlTowerSummaryV2 {
  const nowMs = options?.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const capacitySlots = buildWorkerCapacitySlots(tasks, workers, maxConcurrentOverrides, { nowMs, workerOfflineAfterMs: options?.workerOfflineAfterMs });

  let online = 0, stale = 0;
  for (const s of capacitySlots) {
    if (s.status === "online") online++;
    else stale++;
  }

  const activeTasks = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).length;
  const workerCount = workers.length;

  // Build a worker‑id → role map for role grouping
  const roleMap = new Map<string, string>();
  for (const w of workers) roleMap.set(w.nodeId, w.role);

  const groups: SchedulerControlTowerQueueGroups = {
    byWorker: groupTasksBy(tasks, (t) => extractWorkerId(t)),
    byRole: groupTasksBy(tasks, (t) => roleMap.get(extractWorkerId(t)) ?? "unknown"),
    byRepo: groupTasksBy(tasks, (t) => extractRepo(t)),
    byTaskType: groupTasksBy(tasks, (t) => t.intent),
    byPriority: groupTasksBy(tasks, (t) => extractPriority(t)),
  };

  return {
    kind: "a2a-broker.scheduler-control-tower.summary-v2",
    version: 1,
    generatedAt,
    capacity: {
      workers: capacitySlots,
      totals: { workers: workerCount, online, stale, activeTasks },
    },
    groups,
  };
}

// ---------------------------------------------------------------------------
// Convenience: queue‑group summary only (no capacity signals)
// ---------------------------------------------------------------------------

/**
 * Build a queue‑group summary for all five dimensions.
 * This is a convenience wrapper that skips capacity signals — useful when
 * only grouped queue counts are needed.
 *
 * @param tasks – all known task records.
 * @param workers – worker views (needed for role resolution).
 */
export function buildQueueGroupSummary(
  tasks: readonly TaskRecord[],
  workers: readonly WorkerView[],
): SchedulerControlTowerQueueGroups {
  const roleMap = new Map<string, string>();
  for (const w of workers) roleMap.set(w.nodeId, w.role);

  return {
    byWorker: groupTasksBy(tasks, (t) => extractWorkerId(t)),
    byRole: groupTasksBy(tasks, (t) => roleMap.get(extractWorkerId(t)) ?? "unknown"),
    byRepo: groupTasksBy(tasks, (t) => extractRepo(t)),
    byTaskType: groupTasksBy(tasks, (t) => t.intent),
    byPriority: groupTasksBy(tasks, (t) => extractPriority(t)),
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Render a compact markdown summary suitable for CLI/UI display.
 */
export function renderSchedulerControlTowerSummary(summary: SchedulerControlTowerSummaryV2): string {
  const lines: string[] = [];
  lines.push(`# Scheduler control‑tower summary (v2)`);
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(``);

  // Capacity
  const cap = summary.capacity;
  lines.push(`## Capacity`);
  lines.push(`Workers: ${cap.totals.workers} (${cap.totals.online} online, ${cap.totals.stale} stale)`);
  lines.push(`Active tasks: ${cap.totals.activeTasks}`);
  lines.push(``);
  lines.push(`| Worker | Role | Status | Active | Queued | Claimed | Running | Max | Util% | Remaining |`);
  lines.push(`|--------|------|--------|--------|--------|---------|---------|-----|-------|-----------|`);
  for (const w of cap.workers) {
    lines.push(
      `| ${w.workerId} | ${w.role} | ${w.status} | ${w.activeTaskCount} | ${w.queuedTaskCount} | ${w.claimedTaskCount} | ${w.runningTaskCount} | ${w.maxConcurrentTasks ?? "—"} | ${w.utilizationPct !== undefined ? w.utilizationPct + "%" : "—"} | ${w.remainingSlots !== undefined ? w.remainingSlots : "—"} |`,
    );
  }
  lines.push(``);

  // Queue groups
  const dimMap: Array<{ key: keyof SchedulerControlTowerQueueGroups; label: string }> = [
    { key: "byWorker", label: "By worker" },
    { key: "byRole", label: "By role" },
    { key: "byRepo", label: "By repo" },
    { key: "byTaskType", label: "By task type" },
    { key: "byPriority", label: "By priority" },
  ];

  for (const { key, label } of dimMap) {
    const entries = summary.groups[key];
    lines.push(`## ${label}`);
    if (entries.length === 0) {
      lines.push(`(no active tasks)`);
      lines.push(``);
      continue;
    }
    lines.push(`| Key | Count | Statuses | Oldest age |`);
    lines.push(`|-----|-------|----------|------------|`);
    for (const e of entries) {
      const statusStr = Object.entries(e.byStatus)
        .map(([s, c]) => `${s}=${c}`)
        .join(", ");
      const ageStr = e.oldestAgeMs !== null ? `${Math.round(e.oldestAgeMs / 60000)} min` : "—";
      lines.push(`| ${e.key} | ${e.count} | ${statusStr} | ${ageStr} |`);
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`_Read-only summary; no mutation, dispatch, or ACK/replay._`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function workerStale(lastSeenAt: string, offlineAfterMs: number, nowMs: number): boolean {
  const seen = Date.parse(lastSeenAt);
  return !Number.isFinite(seen) || (nowMs - seen) > offlineAfterMs;
}
