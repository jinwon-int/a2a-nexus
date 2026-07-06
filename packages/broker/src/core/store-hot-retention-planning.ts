import type { AuditEvent, TaskRecord, WorkerRecord } from "./types.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";
import type { BrokerHotEntityHintCoverage } from "./hot-diagnostics.js";
import { parseRetentionTimestamp, isHeartbeatAuditEvent } from "./broker-retention-selectors.js";
import { isTerminalTaskStatus } from "./broker-status-predicates.js";
import type {
  SqliteAuditHotRetentionPlanOptions,
  SqliteAuditHotRetentionProtection,
  SqliteHotRetentionPlan,
  SqliteTaskHotRetentionPlanOptions,
  SqliteTerminalOutboxHotRetentionPlanOptions,
  SqliteWorkerHotRetentionPlanOptions,
} from "./store.js";

export function planTaskRetentionFromRecords(
  records: TaskRecord[],
  options: SqliteTaskHotRetentionPlanOptions,
): SqliteHotRetentionPlan {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.retentionMs;
  const retainedIds = new Set(options.protectedTaskIds ?? []);
  const olderTerminalCandidates: Array<{ id: string; timestampMs: number }> = [];

  for (const task of records) {
    if (!isTerminalTaskStatus(task.status) || retainedIds.has(task.id)) {
      retainedIds.add(task.id);
      continue;
    }
    const timestampMs = parseRetentionTimestamp(task.completedAt ?? task.updatedAt);
    if (timestampMs === null || timestampMs >= cutoffMs) {
      retainedIds.add(task.id);
      continue;
    }
    olderTerminalCandidates.push({ id: task.id, timestampMs });
  }

  const capSorted = [...olderTerminalCandidates]
    .sort((a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id));
  const capRetained = capSorted.slice(0, options.maxTerminalRecords);
  capRetained.forEach((entry) => retainedIds.add(entry.id));

  const plan = buildRetentionPlan("broker_tasks", cutoffMs, records.map((record) => record.id), retainedIds);
  plan.retainedByCapCount = capRetained.length;
  return plan;
}

export function planAuditRetentionFromRecords(
  records: AuditEvent[],
  options: SqliteAuditHotRetentionPlanOptions,
): SqliteHotRetentionPlan {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.retentionMs;
  const retainedIds = new Set<string>();
  const retentionCandidates: Array<{ id: string; timestampMs: number }> = [];
  const protectedIds = normalizeAuditRetentionProtection(options.protectedIds);

  for (const event of records) {
    const timestampMs = parseRetentionTimestamp(event.createdAt);
    if (isAuditEventProtected(event, protectedIds) || timestampMs === null) {
      retainedIds.add(event.id);
      continue;
    }
    retentionCandidates.push({ id: event.id, timestampMs });
  }

  const capSorted = [...retentionCandidates]
    .sort((a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id))
    .filter((entry) => entry.timestampMs >= cutoffMs);
  const capRetained = capSorted.slice(0, options.maxRecords);
  capRetained.forEach((entry) => retainedIds.add(entry.id));

  const plan = buildRetentionPlan("broker_audit_events", cutoffMs, records.map((record) => record.id), retainedIds);
  plan.retainedByCapCount = capRetained.length;
  return plan;
}

export function planWorkerRetentionFromRecords(
  records: WorkerRecord[],
  options: SqliteWorkerHotRetentionPlanOptions,
): SqliteHotRetentionPlan {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.retentionMs;
  const retainedIds = new Set(options.protectedWorkerIds ?? []);
  const olderInactiveCandidates: Array<{ id: string; timestampMs: number }> = [];

  for (const worker of records) {
    if (retainedIds.has(worker.nodeId)) {
      continue;
    }
    const timestampMs = parseRetentionTimestamp(worker.lastSeenAt);
    if (timestampMs === null || timestampMs >= cutoffMs) {
      retainedIds.add(worker.nodeId);
      continue;
    }
    olderInactiveCandidates.push({ id: worker.nodeId, timestampMs });
  }

  const capSorted = [...olderInactiveCandidates]
    .sort((a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id));
  const capRetained = capSorted.slice(0, options.maxInactiveWorkers);
  capRetained.forEach((entry) => retainedIds.add(entry.id));

  const plan = buildRetentionPlan("broker_workers", cutoffMs, records.map((record) => record.nodeId), retainedIds);
  plan.retainedByCapCount = capRetained.length;
  return plan;
}

export function planTerminalOutboxRetentionFromRecords(
  records: TerminalTaskOutboxEvent[],
  options: SqliteTerminalOutboxHotRetentionPlanOptions,
): SqliteHotRetentionPlan {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.retentionMs;
  const retainedIds = new Set<string>();
  const acknowledgedCandidates: Array<{ id: string; timestampMs: number }> = [];

  for (const event of records) {
    const acknowledgedAt = event.ack?.acknowledgedAt ?? event.deliveredAt;
    const acknowledgedMs = acknowledgedAt ? parseRetentionTimestamp(acknowledgedAt) : null;
    if (acknowledgedMs === null) {
      retainedIds.add(event.id);
      continue;
    }
    if (acknowledgedMs >= cutoffMs) {
      retainedIds.add(event.id);
      continue;
    }
    acknowledgedCandidates.push({ id: event.id, timestampMs: acknowledgedMs });
  }

  const capSorted = [...acknowledgedCandidates]
    .sort((a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id));
  const capRetained = capSorted.slice(0, options.maxAcknowledgedRecords);
  capRetained.forEach((entry) => retainedIds.add(entry.id));

  const plan = buildRetentionPlan("broker_terminal_outbox", cutoffMs, records.map((record) => record.id), retainedIds);
  plan.retainedByCapCount = capRetained.length;
  return plan;
}

export function buildHotEntityHintCoverage(
  hotEntityTables: readonly string[],
  hintedWriteTables: readonly string[],
): BrokerHotEntityHintCoverage {
  const supportedTables = [...hintedWriteTables];
  const supported = new Set(supportedTables);
  const missingTables = hotEntityTables.filter((table) => !supported.has(table));
  return {
    ok: missingTables.length === 0,
    supportedTables,
    missingTables,
    supportedCount: supportedTables.length,
    totalCount: hotEntityTables.length,
  };
}

function buildRetentionPlan(
  table: SqliteHotRetentionPlan["table"],
  cutoffMs: number,
  allIds: string[],
  retainedIds: Set<string>,
): SqliteHotRetentionPlan {
  return {
    table,
    cutoffMs,
    retainedIds: allIds.filter((id) => retainedIds.has(id)).sort(),
    pruneIds: allIds.filter((id) => !retainedIds.has(id)).sort(),
  };
}

function normalizeAuditRetentionProtection(
  input: SqliteAuditHotRetentionProtection | undefined,
): Required<Record<keyof SqliteAuditHotRetentionProtection, Set<string>>> {
  return {
    proposalIds: new Set(input?.proposalIds ?? []),
    taskIds: new Set(input?.taskIds ?? []),
    exchangeIds: new Set(input?.exchangeIds ?? []),
    exchangeMessageIds: new Set(input?.exchangeMessageIds ?? []),
    artifactIds: new Set(input?.artifactIds ?? []),
    validationIds: new Set(input?.validationIds ?? []),
    workerIds: new Set(input?.workerIds ?? []),
  };
}

function isAuditEventProtected(
  event: AuditEvent,
  protectedIds: Required<Record<keyof SqliteAuditHotRetentionProtection, Set<string>>>,
): boolean {
  if (isHeartbeatAuditEvent(event)) {
    return false;
  }
  if (event.proposalId && protectedIds.proposalIds.has(event.proposalId)) {
    return true;
  }
  switch (event.targetType) {
    case "proposal":
      return protectedIds.proposalIds.has(event.targetId);
    case "artifact":
      return protectedIds.artifactIds.has(event.targetId);
    case "validation":
      return protectedIds.validationIds.has(event.targetId);
    case "worker":
      return protectedIds.workerIds.has(event.targetId);
    case "task":
      return protectedIds.taskIds.has(event.targetId);
    case "exchange":
      return protectedIds.exchangeIds.has(event.targetId);
    case "exchange-message":
      return protectedIds.exchangeMessageIds.has(event.targetId);
    case "broker":
      return false;
  }
}
