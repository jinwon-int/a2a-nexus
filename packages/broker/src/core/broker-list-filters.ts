// Pure list-filtering predicates used by the broker's task/proposal/worker list
// read paths. Extracted from broker.ts to keep the stateless filter logic in a
// focused module, separate from the broker class. These functions depend only
// on record/filter types — they hold no state and call nothing on the broker.
import type {
  ChangeProposal,
  ProposalListFilters,
  TaskListFilters,
  TaskRecord,
  WorkerCapabilities,
  WorkerListFilters,
  WorkerRecord,
} from "./types.js";

export function taskMatchesFilters(task: TaskRecord, filters?: TaskListFilters): boolean {
  if (filters?.exchangeId && task.exchangeId !== filters.exchangeId) {
    return false;
  }
  if (filters?.status && task.status !== filters.status) {
    return false;
  }
  if (filters?.targetNodeId && task.targetNodeId !== filters.targetNodeId) {
    return false;
  }
  if (filters?.proposalId && task.proposalId !== filters.proposalId) {
    return false;
  }
  if (filters?.intent && task.intent !== filters.intent) {
    return false;
  }
  if (filters?.claimedBy && task.claimedBy !== filters.claimedBy) {
    return false;
  }
  if (filters?.assignedWorkerId && task.assignedWorkerId !== filters.assignedWorkerId) {
    return false;
  }
  if (filters?.taskOrigin && (task.taskOrigin ?? "unknown") !== filters.taskOrigin) {
    return false;
  }
  return true;
}

export function applyTaskListLimit(tasks: TaskRecord[], limit: number | undefined): TaskRecord[] {
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 0
    ? tasks.slice(0, limit)
    : tasks;
}

export function proposalMatchesFilters(proposal: ChangeProposal, filters?: ProposalListFilters): boolean {
  if (filters?.status && proposal.status !== filters.status) {
    return false;
  }
  if (filters?.sourceNodeId && proposal.sourceNodeId !== filters.sourceNodeId) {
    return false;
  }
  if (filters?.targetNodeId && proposal.targetNodeId !== filters.targetNodeId) {
    return false;
  }
  if (filters?.kind && proposal.kind !== filters.kind) {
    return false;
  }
  return true;
}

export function workerMatchesFilters(worker: WorkerRecord, filters?: WorkerListFilters): boolean {
  if (filters?.role && worker.role !== filters.role) {
    return false;
  }
  if (filters?.environment && !worker.capabilities.environments.includes(filters.environment)) {
    return false;
  }
  if (filters?.workspaceId && !worker.capabilities.workspaceIds.includes(filters.workspaceId)) {
    return false;
  }
  if (!workerProviderCapabilityMatchesFilters(worker.capabilities.providerCapabilities, filters)) {
    return false;
  }
  return true;
}

export function workerProviderCapabilityMatchesFilters(
  capabilities: WorkerCapabilities["providerCapabilities"] | undefined,
  filters?: WorkerListFilters,
): boolean {
  if (!filters?.providerId && !filters?.modelFamily && !filters?.modelId && !filters?.providerAvailability) return true;
  return (capabilities ?? []).some((capability) => {
    if (filters?.providerId && capability.providerId !== filters.providerId.trim().toLowerCase()) return false;
    if (filters?.modelFamily && capability.modelFamily !== filters.modelFamily.trim().toLowerCase()) return false;
    if (filters?.modelId && capability.modelId !== filters.modelId.trim().toLowerCase()) return false;
    if (filters?.providerAvailability && capability.availability !== filters.providerAvailability) return false;
    return true;
  });
}
