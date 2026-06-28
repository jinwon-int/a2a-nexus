// Cleanup-candidate discovery, extracted from the InMemoryA2ABroker god-class.
// discoverCleanupCandidates() was a ~310-line read-only diagnostic that scans
// the worker/task/tombstone collections plus the terminal-outbox snapshot and
// reports prunable-but-unsafe entities as a dry-run plan. The reasoning is pure
// — it only reads the supplied state and returns a CleanupDryRunPlan — so it
// moves here as a free function; the broker keeps a thin wrapper that gathers
// the collections and delegates.
//
// This module imports only leaf helpers and types, never broker.ts, so there is
// no import cycle.
import { formatAgeMs } from "./broker-helpers.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";
import type {
  CleanupCandidate,
  CleanupCandidateActionability,
  CleanupDryRunPlan,
  TaskRecord,
  TaskTombstone,
  WorkerRecord,
} from "./types.js";

/** Read-only view of the broker collections cleanup discovery scans. */
export interface CleanupDiscoveryState {
  workers: ReadonlyMap<string, WorkerRecord>;
  tasks: ReadonlyMap<string, TaskRecord>;
  tombstones: ReadonlyMap<string, TaskTombstone>;
  outboxEvents: TerminalTaskOutboxEvent[];
}

export interface CleanupDiscoveryOptions {
  staleWorkerAfterMs?: number;
  staleTaskAfterMs?: number;
  terminalOutboxBacklogAfterMs?: number;
  historicalTerminalAfterMs?: number;
  nowMs?: number;
}

export function buildCleanupDryRunPlan(
  state: CleanupDiscoveryState,
  options?: CleanupDiscoveryOptions,
): CleanupDryRunPlan {
  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const staleWorkerAfterMs = options?.staleWorkerAfterMs ?? 300_000; // 5 min
  const staleTaskAfterMs = options?.staleTaskAfterMs ?? 120_000; // 2 min
  const terminalOutboxBacklogAfterMs = options?.terminalOutboxBacklogAfterMs ?? 900_000; // 15 min
  const historicalTerminalAfterMs = options?.historicalTerminalAfterMs ?? 86_400_000; // 24 h

  const candidates: CleanupCandidate[] = [];
  const riskNotes: string[] = [];

  // --- Stale workers ---
  for (const [nodeId, worker] of state.workers) {
    const lastSeenMs = worker.lastSeenAt ? Date.parse(worker.lastSeenAt) : 0;
    const ageMs = nowMs - lastSeenMs;
    if (ageMs > staleWorkerAfterMs) {
      const hasActiveTasks = [...state.tasks.values()].some(
        (task) =>
          (task.assignedWorkerId === nodeId || task.claimedBy === nodeId) &&
          task.status !== "succeeded" &&
          task.status !== "failed" &&
          task.status !== "canceled",
      );
      const risk: CleanupCandidate["risk"] = hasActiveTasks ? "high_risk" : "caution";
      const actionability: CleanupCandidateActionability = hasActiveTasks ? "blocked" : "advisory";
      candidates.push({
        id: `cleanup:stale-worker:${encodeURIComponent(nodeId)}`,
        class: "stale_worker",
        reason: hasActiveTasks
          ? `stale worker ${nodeId} has active tasks assigned; do not prune without reassigning`
          : `stale worker ${nodeId} has not been seen for ${formatAgeMs(ageMs)}`,
        risk,
        actionability,
        actionabilityReason: hasActiveTasks
          ? "blocked: stale worker still owns active tasks; reassign or settle tasks before worker cleanup"
          : "advisory: stale worker has no active tasks; prune only through an approved worker cleanup plan",
        entityId: nodeId,
        updatedAt: worker.lastSeenAt,
        ageMs,
        metadata: {
          nodeId: worker.nodeId,
          role: worker.role,
          workerMode: worker.workerMode,
          lastSeenAt: worker.lastSeenAt,
          hasActiveTasks,
        },
      });
    }
  }

  // --- Malformed queued tasks and queued residue ---
  // Single pass: malformed tasks (missing fields) are caught first with a
  // `continue` to skip queued-residue detection; well-formed stale queued
  // tasks fall through as queued residue.
  for (const task of state.tasks.values()) {
    if (task.status !== "queued") continue;
    const ageMs = nowMs - Date.parse(task.updatedAt);
    if (ageMs < staleTaskAfterMs) continue;

    const issues: string[] = [];
    if (!task.targetNodeId) issues.push("missing targetNodeId");
    if (!task.requester?.id) issues.push("missing requester.id");
    if (!task.payload || Object.keys(task.payload).length === 0) issues.push("empty payload");

    if (issues.length > 0) {
      candidates.push({
        id: `cleanup:malformed-task:${encodeURIComponent(task.id)}`,
        class: "malformed_task",
        reason: `queued task ${task.id} is malformed: ${issues.join("; ")}`,
        risk: "caution",
        actionability: "blocked",
        actionabilityReason: "blocked: malformed queued task requires manual payload inspection before cancellation or repair",
        entityId: task.id,
        updatedAt: task.updatedAt,
        ageMs,
        metadata: {
          taskId: task.id,
          intent: task.intent,
          issues,
        },
      });
      continue; // malformed — not queued residue
    }

    // --- Queued residue: well-formed queued task sitting stale/unclaimed ---
    candidates.push({
      id: `cleanup:queued-residue:${encodeURIComponent(task.id)}`,
      class: "queued_residue",
      reason: `queued task ${task.id} has been ${task.status} for ${formatAgeMs(ageMs)} without being claimed`,
      risk: "caution",
      actionability: "advisory",
      actionabilityReason: "advisory: queued residue is non-terminal and requires capacity/routing review before cancellation or reassignment",
      entityId: task.id,
      updatedAt: task.updatedAt,
      ageMs,
      metadata: {
        taskId: task.id,
        intent: task.intent,
        status: task.status,
        requeueCount: task.requeueCount,
      },
    });
  }

  // --- Orphaned claims: claimed/running tasks whose claiming worker is stale ---
  const staleWorkerIds = new Set(
    [...state.workers.entries()]
      .filter(([, w]) => {
        const lastSeenMs = w.lastSeenAt ? Date.parse(w.lastSeenAt) : 0;
        return Number.isFinite(lastSeenMs) && nowMs - lastSeenMs > staleWorkerAfterMs;
      })
      .map(([id]) => id),
  );
  if (staleWorkerIds.size > 0) {
    for (const task of state.tasks.values()) {
      if (task.status !== "claimed" && task.status !== "running") continue;
      const workerId = task.claimedBy ?? task.assignedWorkerId;
      if (!workerId || !staleWorkerIds.has(workerId)) continue;

      const lastActivityMs = task.lastHeartbeatAt
        ? Date.parse(task.lastHeartbeatAt)
        : task.claimedAt
          ? Date.parse(task.claimedAt)
          : Date.parse(task.createdAt);
      const ageMs = nowMs - (Number.isFinite(lastActivityMs) ? lastActivityMs : nowMs);

      const risk: CleanupCandidate["risk"] =
        task.status === "running" ? "high_risk" : "caution";
      const actionability: CleanupCandidateActionability = "blocked";

      candidates.push({
        id: `cleanup:orphaned-claim:${encodeURIComponent(task.id)}`,
        class: "orphaned_claim",
        reason: `task ${task.id} is ${task.status} but its claiming worker ${workerId} has been stale for ${formatAgeMs(nowMs - (state.workers.get(workerId)?.lastSeenAt ? Date.parse(state.workers.get(workerId)!.lastSeenAt) : nowMs))}`,
        risk,
        actionability,
        actionabilityReason: "blocked: claimed/running task on a stale worker must be requeued or failed before cleanup",
        entityId: task.id,
        updatedAt: task.lastHeartbeatAt ?? task.claimedAt ?? task.updatedAt,
        ageMs,
        metadata: {
          taskId: task.id,
          status: task.status,
          intent: task.intent,
          staleWorkerId: workerId,
          lastHeartbeatAt: task.lastHeartbeatAt,
          claimedAt: task.claimedAt,
          requeueCount: task.requeueCount,
        },
      });
    }
  }

  // --- Terminal outbox backlog ---
  const outboxEvents = state.outboxEvents;
  for (const event of outboxEvents) {
    const createdAtMs = Date.parse(event.createdAt);
    const ageMs = nowMs - createdAtMs;
    if (ageMs < terminalOutboxBacklogAfterMs) continue;
    const isAcked =
      event.ack?.status === "receipt_confirmed" || Boolean(event.deliveredAt);
    if (isAcked) continue;

    const risk: CleanupCandidate["risk"] =
      ageMs > 3_600_000 ? "high_risk" : "caution";
    candidates.push({
      id: `cleanup:outbox-backlog:${encodeURIComponent(event.id)}`,
      class: "terminal_outbox_backlog",
      reason: `unacknowledged terminal outbox event ${event.id} (${event.payload?.status ?? "unknown"}) is ${formatAgeMs(ageMs)} old`,
      risk,
      actionability: "blocked",
      actionabilityReason: "blocked: terminal outbox rows require operator-visible receipt or a separate approved ACK/prune path; broker cursor state is unknown",
      entityId: event.payload?.taskId ?? event.id,
      updatedAt: event.createdAt,
      ageMs,
      metadata: {
        outboxId: event.id,
        taskId: event.payload?.taskId,
        terminalStatus: event.payload?.status,
        receiptStatus: event.receipt?.status,
        ackDecision: event.ackAudit?.decision,
        cursorState: "unknown",
        worker: event.payload?.worker,
      },
    });
  }

  // --- Historical terminal tasks ---
  for (const task of state.tasks.values()) {
    if (
      task.status !== "succeeded" &&
      task.status !== "failed" &&
      task.status !== "canceled"
    )
      continue;
    const completedAtMs = task.completedAt
      ? Date.parse(task.completedAt)
      : Date.parse(task.updatedAt);
    const ageMs = nowMs - completedAtMs;
    if (ageMs < historicalTerminalAfterMs) continue;

    const tombstone = state.tombstones.get(task.id);
    const risk: CleanupCandidate["risk"] =
      task.status === "failed" && !tombstone ? "high_risk" : "safe";
    const actionability: CleanupCandidateActionability =
      risk === "high_risk" ? "blocked" : "retention_not_due";
    candidates.push({
      id: `cleanup:historical-task:${encodeURIComponent(task.id)}`,
      class: "historical_terminal_task",
      reason: `terminal task ${task.id} (${task.status}) is ${formatAgeMs(ageMs)} old; safe to archive with tombstone${tombstone ? "" : " (missing tombstone — verify before pruning)"}`,
      risk,
      actionability,
      actionabilityReason: risk === "high_risk"
        ? "blocked: failed historical task has no tombstone; verify evidence before any pruning"
        : "retention_not_due: historical task discovery is advisory unless operator cleanup plan marks it executable under retention/cap policy",
      entityId: task.id,
      updatedAt: task.completedAt ?? task.updatedAt,
      ageMs,
      metadata: {
        taskId: task.id,
        status: task.status,
        intent: task.intent,
        hasTombstone: Boolean(tombstone),
        tombstoneReason: tombstone?.tombstoneReason,
        completedAt: task.completedAt,
      },
    });
  }

  // --- Summary ---
  const summary: CleanupDryRunPlan["summary"] = {
    stale_worker: 0,
    malformed_task: 0,
    queued_residue: 0,
    orphaned_claim: 0,
    terminal_outbox_backlog: 0,
    historical_terminal_task: 0,
  };
  const actionabilitySummary: CleanupDryRunPlan["actionabilitySummary"] = {
    advisory: 0,
    blocked: 0,
    executable: 0,
    cursor_skipped: 0,
    retention_not_due: 0,
  };
  for (const candidate of candidates) {
    summary[candidate.class] += 1;
    actionabilitySummary[candidate.actionability] += 1;
  }

  if (summary.stale_worker > 0) {
    riskNotes.push(
      `Stale workers detected (${summary.stale_worker}): verify worker health and task reassignment before any pruning. Use workerOfflineAfterMs to tune detection window.`,
    );
  }
  if (summary.malformed_task > 0) {
    riskNotes.push(
      `Malformed queued tasks detected (${summary.malformed_task}): inspect payload before cancellation; may indicate upstream ingestion issues.`,
    );
  }
  if (summary.queued_residue > 0) {
    riskNotes.push(
      `Queued residue detected (${summary.queued_residue}): well-formed queued tasks that remain unclaimed. Verify worker capacity and routing before manual intervention.`,
    );
  }
  if (summary.orphaned_claim > 0) {
    riskNotes.push(
      `Orphaned claims detected (${summary.orphaned_claim}): claimed/running tasks assigned to stale workers after fleet update. Requeue or fail these tasks to unblock the queue. Use --allow-worker-prune only after reassignment.`,
    );
  }
  if (summary.terminal_outbox_backlog > 0) {
    riskNotes.push(
      `Terminal outbox backlog detected (${summary.terminal_outbox_backlog}): unacknowledged events may indicate notifier disconnect. Retry delivery or confirm operator visibility before pruning.`,
    );
  }
  if (summary.historical_terminal_task > 0) {
    riskNotes.push(
      `Historical terminal tasks detected (${summary.historical_terminal_task}): archive with tombstone backup before pruning. High-risk items may need manual verification.`,
    );
  }

  if (candidates.length === 0) {
    riskNotes.push("No cleanup candidates found. Broker state is clean.");
  }

  // Sort by risk: high_risk first, then caution, then safe.
  candidates.sort((a, b) => {
    const riskOrder: Record<CleanupCandidate["risk"], number> = {
      high_risk: 0,
      caution: 1,
      safe: 2,
    };
    return riskOrder[a.risk] - riskOrder[b.risk];
  });

  return {
    generatedAt: nowIso,
    summary,
    actionabilitySummary,
    totalCandidates: candidates.length,
    candidates,
    riskNotes,
  };
}
