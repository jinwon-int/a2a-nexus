// Small pure record helpers extracted from broker.ts: task status-since
// timestamp, save-hint counting for profiling, and the worker / exchange-message
// sort comparators. No broker state; type-only imports keep this leaf module
// free of runtime dependencies.
import type { A2AExchangeMessageRecord, TaskRecord, WorkerRecord } from "./types.js";
import type { BrokerProfilingSample } from "./broker.js";
import type { BrokerStateSaveHints } from "./store.js";

export function taskStatusSinceAt(task: Pick<TaskRecord, "status" | "createdAt" | "updatedAt" | "claimedAt">): string {
  if (task.status === "claimed") {
    return task.claimedAt ?? task.updatedAt ?? task.createdAt;
  }
  if (task.status === "running") {
    return task.updatedAt ?? task.claimedAt ?? task.createdAt;
  }
  return task.createdAt;
}

export function countStateSaveHints(hints: BrokerStateSaveHints): NonNullable<BrokerProfilingSample["saveHints"]> {
  return {
    hotExchanges: hints.hotExchanges?.length ?? 0,
    hotExchangeMessages: hints.hotExchangeMessages?.length ?? 0,
    hotProposals: hints.hotProposals?.length ?? 0,
    hotArtifacts: hints.hotArtifacts?.length ?? 0,
    hotValidations: hints.hotValidations?.length ?? 0,
    hotTasks: hints.hotTasks?.length ?? 0,
    hotTombstones: hints.hotTombstones?.length ?? 0,
    hotAuditEvents: hints.hotAuditEvents?.length ?? 0,
    hotWorkers: hints.hotWorkers?.length ?? 0,
    hotTerminalOutboxEvents: hints.hotTerminalOutboxEvents?.length ?? 0,
  };
}

export function sortWorkersNewestFirst(a: WorkerRecord, b: WorkerRecord): number {
  return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
}

export function sortExchangeMessages(a: A2AExchangeMessageRecord, b: A2AExchangeMessageRecord): number {
  if (a.createdAt === b.createdAt) {
    return a.kind === "root" ? -1 : 1;
  }
  return a.createdAt > b.createdAt ? 1 : -1;
}
