// Retention reachability computation, extracted from the InMemoryA2ABroker
// god-class. Given a read-only view of the entity maps plus the retention
// policy, this walks the cross-entity reference graph and returns the set of
// record ids to retain for each entity kind. It only *reads* the maps and never
// mutates them, so the actual pruning (and the collaborator prune() fan-out)
// stays in the broker; this module owns just the "what survives" reasoning.
//
// The BrokerRetentionPolicy type is defined and exported by broker.ts; it is
// imported here type-only, so there is no runtime import cycle.
import {
  isTerminalExchangeStatus,
  isTerminalProposalStatus,
  isTerminalTaskStatus,
} from "./broker-status-predicates.js";
import {
  estimateRetentionRecordBytes,
  selectRetainedAuditEventIds,
  selectRetainedTerminalRecordIds,
  selectRetainedWorkerIds,
} from "./broker-retention-selectors.js";
import type {
  ArtifactRecord,
  AuditEvent,
  A2AExchangeMessageRecord,
  A2AExchangeState,
  ChangeProposal,
  TaskRecord,
  ValidationResult,
  WorkerRecord,
} from "./types.js";
import type { BrokerRetentionPolicy } from "./broker.js";

/** Read-only view of the broker entity maps the reachability walk consults. */
export interface RetentionReachabilityState {
  exchanges: ReadonlyMap<string, A2AExchangeState>;
  exchangeMessages: ReadonlyMap<string, A2AExchangeMessageRecord>;
  tasks: ReadonlyMap<string, TaskRecord>;
  proposals: ReadonlyMap<string, ChangeProposal>;
  artifacts: ReadonlyMap<string, ArtifactRecord>;
  validations: ReadonlyMap<string, ValidationResult>;
  workers: ReadonlyMap<string, WorkerRecord>;
  auditEvents: ReadonlyMap<string, AuditEvent>;
}

/** The ids that survive retention, per entity kind. */
export interface RetainedRecordIds {
  exchangeIds: Set<string>;
  messageIds: Set<string>;
  taskIds: Set<string>;
  proposalIds: Set<string>;
  artifactIds: Set<string>;
  validationIds: Set<string>;
  workerIds: Set<string>;
  auditEventIds: Set<string>;
}

/**
 * Compute which record ids to retain. Exchanges and tasks cross-protect each
 * other (an active exchange keeps its task, a retained task keeps its exchange);
 * proposals/artifacts/validations/messages are kept when referenced by a
 * surviving record; workers are kept while inactive-within-policy or referenced;
 * audit events are kept per their own policy plus references to survivors.
 */
export function computeRetainedRecordIds(
  state: RetentionReachabilityState,
  retentionPolicy: BrokerRetentionPolicy,
  nowMs: number,
): RetainedRecordIds {
  const retainedExchangeIds = selectRetainedTerminalRecordIds({
    records: [...state.exchanges.values()],
    isTerminal: (exchange) => isTerminalExchangeStatus(exchange.status),
    getId: (exchange) => exchange.id,
    getTimestamp: (exchange) => exchange.updatedAt,
    nowMs,
    retentionMs: retentionPolicy.terminalRetentionMs,
    maxTerminalRecords: retentionPolicy.maxTerminalExchanges,
  });

  const protectedTaskIds = new Set<string>();
  for (const exchangeId of retainedExchangeIds) {
    const activeTaskId = state.exchanges.get(exchangeId)?.activeTaskId;
    if (activeTaskId) {
      protectedTaskIds.add(activeTaskId);
    }
  }

  const retainedTaskIds = selectRetainedTerminalRecordIds({
    records: [...state.tasks.values()],
    isTerminal: (task) => isTerminalTaskStatus(task.status),
    getId: (task) => task.id,
    getTimestamp: (task) => task.completedAt ?? task.updatedAt,
    nowMs,
    retentionMs: retentionPolicy.terminalRetentionMs,
    maxTerminalRecords: retentionPolicy.maxTerminalTasks,
    maxTerminalRecordBytes: retentionPolicy.maxTerminalTaskBytes,
    getRecordBytes: estimateRetentionRecordBytes,
    protectedIds: protectedTaskIds,
  });

  for (const taskId of retainedTaskIds) {
    const exchangeId = state.tasks.get(taskId)?.exchangeId;
    if (exchangeId) {
      retainedExchangeIds.add(exchangeId);
    }
  }

  const protectedProposalIds = new Set<string>();
  for (const taskId of retainedTaskIds) {
    const proposalId = state.tasks.get(taskId)?.proposalId;
    if (proposalId) {
      protectedProposalIds.add(proposalId);
    }
  }

  const retainedProposalIds = selectRetainedTerminalRecordIds({
    records: [...state.proposals.values()],
    isTerminal: (proposal) => isTerminalProposalStatus(proposal.status),
    getId: (proposal) => proposal.id,
    getTimestamp: (proposal) => proposal.updatedAt,
    nowMs,
    retentionMs: retentionPolicy.terminalRetentionMs,
    maxTerminalRecords: retentionPolicy.maxTerminalProposals,
    protectedIds: protectedProposalIds,
  });

  const retainedArtifactIds = collectRetainedArtifactIds(state, {
    retainedTaskIds,
    retainedProposalIds,
  });
  const retainedValidationIds = collectRetainedValidationIds(state, retainedProposalIds);
  const retainedMessageIds = collectRetainedExchangeMessageIds(state, retainedExchangeIds);

  const retainedWorkerIds = selectRetainedWorkerIds({
    workers: [...state.workers.values()],
    nowMs,
    inactiveWorkerRetentionMs: retentionPolicy.inactiveWorkerRetentionMs,
    maxInactiveWorkers: retentionPolicy.maxInactiveWorkers,
    protectedIds: collectProtectedWorkerIds(state, {
      retainedExchangeIds,
      retainedTaskIds,
      retainedProposalIds,
    }),
  });

  const retainedAuditEventIds = selectRetainedAuditEventIds({
    auditEvents: [...state.auditEvents.values()],
    nowMs,
    auditRetentionMs: retentionPolicy.auditRetentionMs,
    maxAuditEvents: retentionPolicy.maxAuditEvents,
    maxHeartbeatAuditEvents: retentionPolicy.maxHeartbeatAuditEvents,
    retainedProposalIds,
    retainedTaskIds,
    retainedExchangeIds,
    retainedMessageIds,
    retainedArtifactIds,
    retainedValidationIds,
    retainedWorkerIds,
  });

  return {
    exchangeIds: retainedExchangeIds,
    messageIds: retainedMessageIds,
    taskIds: retainedTaskIds,
    proposalIds: retainedProposalIds,
    artifactIds: retainedArtifactIds,
    validationIds: retainedValidationIds,
    workerIds: retainedWorkerIds,
    auditEventIds: retainedAuditEventIds,
  };
}

function collectRetainedExchangeMessageIds(
  state: RetentionReachabilityState,
  retainedExchangeIds: Set<string>,
): Set<string> {
  const retainedMessageIds = new Set<string>();
  for (const message of state.exchangeMessages.values()) {
    if (retainedExchangeIds.has(message.exchangeId)) {
      retainedMessageIds.add(message.id);
    }
  }
  return retainedMessageIds;
}

function collectRetainedArtifactIds(
  state: RetentionReachabilityState,
  params: {
    retainedTaskIds: Set<string>;
    retainedProposalIds: Set<string>;
  },
): Set<string> {
  const retainedArtifactIds = new Set<string>();

  for (const proposalId of params.retainedProposalIds) {
    const proposal = state.proposals.get(proposalId);
    for (const artifactId of proposal?.artifactIds ?? []) {
      retainedArtifactIds.add(artifactId);
    }
  }

  for (const artifact of state.artifacts.values()) {
    if (params.retainedProposalIds.has(artifact.proposalId)) {
      retainedArtifactIds.add(artifact.id);
    }
  }

  for (const taskId of params.retainedTaskIds) {
    const task = state.tasks.get(taskId);
    for (const artifactId of task?.artifactIds ?? []) {
      retainedArtifactIds.add(artifactId);
    }
    for (const artifactId of task?.result?.artifactIds ?? []) {
      retainedArtifactIds.add(artifactId);
    }
    for (const artifactId of task?.result?.validation?.artifactIds ?? []) {
      retainedArtifactIds.add(artifactId);
    }
    for (const validation of task?.result?.validations ?? []) {
      for (const artifactId of validation.artifactIds ?? []) {
        retainedArtifactIds.add(artifactId);
      }
    }
    for (const artifactId of task?.result?.apply?.artifactIds ?? []) {
      retainedArtifactIds.add(artifactId);
    }
  }

  return retainedArtifactIds;
}

function collectRetainedValidationIds(
  state: RetentionReachabilityState,
  retainedProposalIds: Set<string>,
): Set<string> {
  const retainedValidationIds = new Set<string>();
  for (const validation of state.validations.values()) {
    if (retainedProposalIds.has(validation.proposalId)) {
      retainedValidationIds.add(validation.id);
    }
  }
  return retainedValidationIds;
}

function collectProtectedWorkerIds(
  state: RetentionReachabilityState,
  params: {
    retainedExchangeIds: Set<string>;
    retainedTaskIds: Set<string>;
    retainedProposalIds: Set<string>;
  },
): Set<string> {
  const retainedWorkerIds = new Set<string>();

  for (const exchangeId of params.retainedExchangeIds) {
    const exchange = state.exchanges.get(exchangeId);
    if (!exchange) {
      continue;
    }
    retainedWorkerIds.add(exchange.targetNodeId);
    if (exchange.assignedWorkerId) {
      retainedWorkerIds.add(exchange.assignedWorkerId);
    }
    retainedWorkerIds.add(exchange.target.id);
  }

  for (const taskId of params.retainedTaskIds) {
    const task = state.tasks.get(taskId);
    if (!task) {
      continue;
    }
    retainedWorkerIds.add(task.targetNodeId);
    retainedWorkerIds.add(task.target.id);
    if (task.assignedWorkerId) {
      retainedWorkerIds.add(task.assignedWorkerId);
    }
    if (task.claimedBy) {
      retainedWorkerIds.add(task.claimedBy);
    }
  }

  for (const proposalId of params.retainedProposalIds) {
    const proposal = state.proposals.get(proposalId);
    if (!proposal) {
      continue;
    }
    retainedWorkerIds.add(proposal.sourceNodeId);
    retainedWorkerIds.add(proposal.targetNodeId);
    retainedWorkerIds.add(proposal.source.id);
    retainedWorkerIds.add(proposal.target.id);
  }

  return retainedWorkerIds;
}
