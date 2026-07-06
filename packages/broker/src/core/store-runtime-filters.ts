import type {
  TaskListFilters,
  TaskRecord,
  WorkerListFilters,
  WorkerRecord,
} from "./types.js";

export function taskMatchesRuntimeFilters(task: TaskRecord, filters: TaskListFilters): boolean {
  if (filters.exchangeId && task.exchangeId !== filters.exchangeId) {
    return false;
  }
  if (filters.status && task.status !== filters.status) {
    return false;
  }
  if (filters.targetNodeId && task.targetNodeId !== filters.targetNodeId) {
    return false;
  }
  if (filters.proposalId && task.proposalId !== filters.proposalId) {
    return false;
  }
  if (filters.intent && task.intent !== filters.intent) {
    return false;
  }
  if (filters.claimedBy && task.claimedBy !== filters.claimedBy) {
    return false;
  }
  if (filters.assignedWorkerId && task.assignedWorkerId !== filters.assignedWorkerId) {
    return false;
  }
  if (filters.taskOrigin && (task.taskOrigin ?? "unknown") !== filters.taskOrigin) {
    return false;
  }
  return true;
}

export function workerMatchesRuntimeFilters(worker: WorkerRecord, filters: WorkerListFilters): boolean {
  if (filters.role && worker.role !== filters.role) {
    return false;
  }
  if (filters.environment && !worker.capabilities.environments.includes(filters.environment)) {
    return false;
  }
  if (filters.workspaceId && !worker.capabilities.workspaceIds.includes(filters.workspaceId)) {
    return false;
  }
  if (!workerProviderCapabilityMatchesRuntimeFilters(worker.capabilities.providerCapabilities, filters)) {
    return false;
  }
  return true;
}

export function workerProviderCapabilityMatchesRuntimeFilters(
  capabilities: WorkerRecord["capabilities"]["providerCapabilities"] | undefined,
  filters: WorkerListFilters,
): boolean {
  if (!filters.providerId && !filters.modelFamily && !filters.modelId && !filters.providerAvailability) return true;
  return (capabilities ?? []).some((capability) => {
    if (filters.providerId && capability.providerId !== filters.providerId.trim().toLowerCase()) return false;
    if (filters.modelFamily && capability.modelFamily !== filters.modelFamily.trim().toLowerCase()) return false;
    if (filters.modelId && capability.modelId !== filters.modelId.trim().toLowerCase()) return false;
    if (filters.providerAvailability && capability.availability !== filters.providerAvailability) return false;
    return true;
  });
}
