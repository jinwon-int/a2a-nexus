// Retention/pruning selectors extracted from broker.ts. Given snapshots of
// records plus retention windows and protected-id sets, these pure functions
// compute which terminal task/worker/audit ids to retain (and prune the rest).
// They hold no broker state.
import { sortedCopy } from "./broker-helpers.js";
import type { AuditEvent, WorkerRecord } from "./types.js";

export function parseRetentionTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function selectRetainedTerminalRecordIds<T>(params: {
  records: T[];
  isTerminal: (record: T) => boolean;
  getId: (record: T) => string;
  getTimestamp: (record: T) => string | undefined;
  nowMs: number;
  retentionMs: number;
  maxTerminalRecords: number;
  /**
   * Optional cumulative serialized-byte budget across evictable terminal
   * records (#1579). When set together with getRecordBytes, terminal records
   * are retained newest-first only while the running byte total stays within
   * the budget — including records still inside the retentionMs window — so a
   * byte-capped snapshot cannot be outgrown on the count cap alone. A record
   * whose size exceeds the remaining budget is evicted without starving
   * smaller, older records. Protected and non-terminal records are always
   * retained and never consume budget.
   */
  maxTerminalRecordBytes?: number;
  getRecordBytes?: (record: T) => number;
  protectedIds?: Set<string>;
}): Set<string> {
  const retainedIds = new Set<string>(params.protectedIds ?? []);
  const byteBudget =
    params.maxTerminalRecordBytes !== undefined && params.getRecordBytes !== undefined
      ? { maxBytes: Math.max(0, params.maxTerminalRecordBytes), getBytes: params.getRecordBytes }
      : undefined;
  const terminalCandidates: Array<{
    id: string;
    timestampMs: number;
    withinWindow: boolean;
    bytes: number;
  }> = [];
  const cutoffMs = params.nowMs - params.retentionMs;

  for (const record of params.records) {
    const id = params.getId(record);
    if (!params.isTerminal(record) || retainedIds.has(id)) {
      retainedIds.add(id);
      continue;
    }

    const timestampMs = parseRetentionTimestamp(params.getTimestamp(record));
    if (timestampMs === null) {
      retainedIds.add(id);
      continue;
    }

    const withinWindow = timestampMs >= cutoffMs;
    if (withinWindow && byteBudget === undefined) {
      retainedIds.add(id);
      continue;
    }

    terminalCandidates.push({
      id,
      timestampMs,
      withinWindow,
      bytes: byteBudget === undefined ? 0 : byteBudget.getBytes(record),
    });
  }

  let retainedBytes = 0;
  let retainedExpiredCount = 0;
  for (const entry of sortedCopy(
    terminalCandidates,
    (a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id),
  )) {
    if (!entry.withinWindow && retainedExpiredCount >= params.maxTerminalRecords) {
      continue;
    }
    if (byteBudget !== undefined && retainedBytes + entry.bytes > byteBudget.maxBytes) {
      continue;
    }
    retainedBytes += entry.bytes;
    if (!entry.withinWindow) {
      retainedExpiredCount += 1;
    }
    retainedIds.add(entry.id);
  }

  return retainedIds;
}

export function selectRetainedWorkerIds(params: {
  workers: WorkerRecord[];
  nowMs: number;
  inactiveWorkerRetentionMs: number;
  maxInactiveWorkers: number;
  protectedIds: Set<string>;
}): Set<string> {
  const retainedIds = new Set<string>(params.protectedIds);
  const staleCandidates: Array<{ id: string; timestampMs: number }> = [];
  const cutoffMs = params.nowMs - params.inactiveWorkerRetentionMs;

  for (const worker of params.workers) {
    if (retainedIds.has(worker.nodeId)) {
      continue;
    }
    const lastSeenMs = parseRetentionTimestamp(worker.lastSeenAt);
    if (lastSeenMs === null || lastSeenMs >= cutoffMs) {
      retainedIds.add(worker.nodeId);
      continue;
    }
    staleCandidates.push({ id: worker.nodeId, timestampMs: lastSeenMs });
  }

  sortedCopy(
    staleCandidates,
    (a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id),
  )
    .slice(0, params.maxInactiveWorkers)
    .forEach((entry) => retainedIds.add(entry.id));

  return retainedIds;
}

export function selectRetainedAuditEventIds(params: {
  auditEvents: AuditEvent[];
  nowMs: number;
  auditRetentionMs: number;
  maxAuditEvents: number;
  maxHeartbeatAuditEvents: number;
  retainedProposalIds: Set<string>;
  retainedTaskIds: Set<string>;
  retainedExchangeIds: Set<string>;
  retainedMessageIds: Set<string>;
  retainedArtifactIds: Set<string>;
  retainedValidationIds: Set<string>;
  retainedWorkerIds: Set<string>;
}): Set<string> {
  const retainedIds = new Set<string>();
  const retentionCandidates: Array<{ id: string; timestampMs: number }> = [];
  const heartbeatCandidates: Array<{ id: string; timestampMs: number }> = [];
  const cutoffMs = params.nowMs - params.auditRetentionMs;

  for (const event of params.auditEvents) {
    const timestampMs = parseRetentionTimestamp(event.createdAt);
    if (isAuditEventRetained(event, params) || timestampMs === null) {
      retainedIds.add(event.id);
      continue;
    }
    const entry = { id: event.id, timestampMs };
    if (isHeartbeatAuditEvent(event)) {
      heartbeatCandidates.push(entry);
    } else {
      retentionCandidates.push(entry);
    }
  }

  const retainRecentCandidates = (
    candidates: Array<{ id: string; timestampMs: number }>,
    maxEvents: number,
  ) => {
    sortedCopy(
      candidates,
      (a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id),
    )
      .filter((entry) => entry.timestampMs >= cutoffMs)
      .slice(0, maxEvents)
      .forEach((entry) => retainedIds.add(entry.id));
  };

  retainRecentCandidates(retentionCandidates, params.maxAuditEvents);
  retainRecentCandidates(heartbeatCandidates, params.maxHeartbeatAuditEvents);

  return retainedIds;
}

export function isAuditEventRetained(
  event: AuditEvent,
  params: {
    retainedProposalIds: Set<string>;
    retainedTaskIds: Set<string>;
    retainedExchangeIds: Set<string>;
    retainedMessageIds: Set<string>;
    retainedArtifactIds: Set<string>;
    retainedValidationIds: Set<string>;
    retainedWorkerIds: Set<string>;
  },
): boolean {
  if (isHeartbeatAuditEvent(event)) {
    return false;
  }
  if (event.proposalId && params.retainedProposalIds.has(event.proposalId)) {
    return true;
  }

  switch (event.targetType) {
    case "proposal":
      return params.retainedProposalIds.has(event.targetId);
    case "artifact":
      return params.retainedArtifactIds.has(event.targetId);
    case "validation":
      return params.retainedValidationIds.has(event.targetId);
    case "worker":
      return params.retainedWorkerIds.has(event.targetId);
    case "task":
      return params.retainedTaskIds.has(event.targetId);
    case "exchange":
      return params.retainedExchangeIds.has(event.targetId);
    case "exchange-message":
      return params.retainedMessageIds.has(event.targetId);
    default:
      return false;
  }
}

export function isHeartbeatAuditEvent(event: Pick<AuditEvent, "action" | "targetType">): boolean {
  return (
    (event.action === "worker.heartbeat" && event.targetType === "worker") ||
    (event.action === "task.heartbeat" && event.targetType === "task")
  );
}

export function getHeartbeatAuditEventId(
  event: Pick<AuditEvent, "action" | "targetType" | "targetId">,
): string | null {
  if (event.action === "worker.heartbeat" && event.targetType === "worker") {
    return `worker-heartbeat:${event.targetId}`;
  }
  if (event.action === "task.heartbeat" && event.targetType === "task") {
    return `task-heartbeat:${event.targetId}`;
  }
  return null;
}

export function pruneMapEntries<T>(items: Map<string, T>, retainedIds: Set<string>): void {
  for (const key of items.keys()) {
    if (!retainedIds.has(key)) {
      items.delete(key);
    }
  }
}
