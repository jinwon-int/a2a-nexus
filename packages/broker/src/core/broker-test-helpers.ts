import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryA2ABroker, type BrokerProfilingSample, type TaskUpdate, type BufferedTaskEvent } from "./broker.js";
import type { WorkerRuntimeRepository } from "./worker-repository.js";
import {
  CURRENT_BROKER_STATE_VERSION,
  SqliteArtifactRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteExchangeMessageRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
  emptySnapshot,
  type BrokerSnapshot,
  type BrokerStateSaveHints,
  type BrokerStateStore,
} from "./store.js";
import type { ArtifactRecord, AuditEvent, ChangeProposal, CreateTaskRequest, TaskTombstone, ValidationResult, WorkerMobileHealth, WorkerMode, WorkerRecord } from "./types.js";

export function registerWorker(broker: InMemoryA2ABroker, nodeId: string): void {
  broker.registerWorker({
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
}

export function createWorkerTask(broker: InMemoryA2ABroker, id: string, workerId: string) {
  return broker.createTask({
    id,
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: workerId, kind: "node", role: "analyst" },
    assignedWorkerId: workerId,
    message: `task ${id}`,
    payload: { secretLikeLargePayload: "must not appear in capacity summary" },
  });
}

export function createGithubPatchTask(broker: InMemoryA2ABroker, id: string, workerId: string) {
  return broker.createTask({
    id,
    intent: "propose_patch",
    requester: { id: "github", kind: "service", role: "hub" },
    target: { id: workerId, kind: "node", role: "analyst" },
    assignedWorkerId: workerId,
    message: `github task ${id}`,
    payload: {
      mode: "github-propose-patch",
      githubRepo: "jinwon-int/a2a-broker",
      githubIssueNumber: 310,
    },
    taskOrigin: "github",
  });
}

export function createOwnedTask(broker: InMemoryA2ABroker, id: string, workerId: string, overrides: Partial<CreateTaskRequest> = {}) {
  return broker.createTask({
    id,
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: workerId, kind: "node", role: "analyst" },
    assignedWorkerId: workerId,
    message: `owned task ${id}`,
    ...overrides,
  });
}
