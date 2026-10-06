// #2331 phase 1: producers must not mint parent-owned Terminal Briefs whose
// owner no broker relays to. Covers the GitHub patch normalizer default owner,
// the known-broker guard, the terminal-outbox unknown-owner fallback, the
// handoff-receiver regression, and the unchanged projection-store contract.
import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryA2ABroker } from "./broker.js";
import { BrokerError } from "./broker-error.js";
import { normalizeGitHubPatchTaskRequest } from "./broker-task-request-normalizers.js";
import { buildCrossBrokerTerminalBriefProjectionFromEvent } from "./cross-broker-terminal-brief-receiver.js";
import type { TaskStatusEvent } from "./task-events.js";
import { TerminalTaskEventOutbox, type TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";
import type { CreateTaskRequest, TaskRecord } from "./types.js";

const WORKER = "workerA";
const NODE_REQUESTER = "workerB";

function registerWorker(broker: InMemoryA2ABroker, nodeId = WORKER): void {
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

function patchRequest(payload: Record<string, unknown> = {}, overrides: Partial<CreateTaskRequest> = {}): CreateTaskRequest {
  return {
    intent: "propose_patch",
    taskOrigin: "github",
    requester: { id: NODE_REQUESTER, kind: "node", role: "hub" },
    target: { id: WORKER, kind: "node", role: "analyst" },
    assignedWorkerId: WORKER,
    message: "fix issue",
    payload: {
      mode: "github-propose-patch",
      repo: "acme/platform",
      issueNumber: 291,
      issueUrl: "https://github.com/acme/platform/issues/291",
      parentIssueUrl: "https://github.com/acme/platform/issues/290",
      parentRoundId: "brokeralpha-round-1",
      parentRoundTotal: 2,
      parentRoundOrder: 1,
      operatorFacingOwner: "parent",
      ...payload,
    },
    ...overrides,
  };
}

function completeAndReadTerminalEvent(broker: InMemoryA2ABroker, taskId: string, worker = WORKER): TerminalTaskOutboxEvent {
  broker.claimTask(taskId, worker);
  broker.completeTask(taskId, worker, {
    summary: "child finished",
    output: { github: { doneCommentUrl: "https://github.com/acme/platform/issues/291#issuecomment-1" } },
  });
  const event = broker.getTerminalTaskEventOutbox().subscribe().find((candidate) => candidate.payload.taskId === taskId);
  assert.ok(event, `terminal outbox event for ${taskId}`);
  return event;
}

function assertBadRequest(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BrokerError);
    assert.equal(error.code, "bad_request");
    assert.match(error.message, pattern);
    return true;
  });
}

// ---- (a) normalizer default owner -----------------------------------------

test("#2331 (a) node requester without originBrokerId resolves to the receiving broker, not the node", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  registerWorker(broker);

  const task = broker.createTask(patchRequest());

  assert.equal(task.payload.originBrokerId, "brokeralpha");
  assert.equal(task.payload.crossBrokerHandoff, undefined, "no create-time handoff synthesized for a local owner");

  const event = completeAndReadTerminalEvent(broker, task.id);
  assert.equal(event.payload.originBrokerId, "brokeralpha");
  assert.equal(event.payload.brokerOfRecordId, "brokeralpha");
  assert.equal(event.payload.notificationOwnership, undefined, "no parent-broker-only scope");
  assert.equal(event.payload.crossBrokerHandoff, undefined);
  assert.equal(event.payload.notificationOwnershipFallback, undefined, "the producer fix needs no outbox fallback");
});

test("#2331 (a) legacy broker without a configured brokerId still falls back to the requester id", () => {
  const normalized = normalizeGitHubPatchTaskRequest(patchRequest());
  assert.equal(normalized.payload?.originBrokerId, NODE_REQUESTER);

  const configured = normalizeGitHubPatchTaskRequest(patchRequest(), { brokerId: "brokeralpha" });
  assert.equal(configured.payload?.originBrokerId, "brokeralpha");
});

// ---- (b) known-broker guard -----------------------------------------------

test("#2331 (b) explicit unknown originBrokerId is rejected bad_request when knownBrokerIds is configured", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha", knownBrokerIds: ["brokerbeta"] });
  registerWorker(broker);

  assertBadRequest(
    () => broker.createTask(patchRequest({ originBrokerId: NODE_REQUESTER })),
    /originBrokerId must be the receiving broker or a known broker id/,
  );
  assertBadRequest(
    () => normalizeGitHubPatchTaskRequest(patchRequest({ originBrokerId: "brokergamma" }), {
      brokerId: "brokeralpha",
      knownBrokerIds: ["brokerbeta"],
    }),
    /A2A_KNOWN_BROKER_IDS/,
  );

  const local = broker.createTask(patchRequest({ originBrokerId: "brokeralpha" }));
  assert.equal(local.payload.originBrokerId, "brokeralpha");
  const known = broker.createTask(patchRequest({ originBrokerId: "brokerbeta", parentRoundId: "brokerbeta-round-1" }));
  assert.equal(known.payload.originBrokerId, "brokerbeta");
  const knownMixedCase = broker.createTask(patchRequest({ originBrokerId: "brokerBeta", parentRoundId: "brokerbeta-round-2" }));
  assert.equal(knownMixedCase.payload.originBrokerId, "brokerBeta", "known-broker match is case-insensitive like the outbox");
});

test("#2331 (b) the known-broker guard is inactive when knownBrokerIds is empty (backward compatible)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha", knownBrokerIds: [] });
  registerWorker(broker);

  const task = broker.createTask(patchRequest({ originBrokerId: "brokergamma" }));
  assert.equal(task.payload.originBrokerId, "brokergamma");
});

// ---- (d) outbox unknown-owner fallback -------------------------------------

/** A task stored before the normalizer fix: a node id was recorded as the owning broker. */
function legacyOrphanTask(): TaskRecord {
  return {
    id: "legacy-orphan-child",
    targetNodeId: WORKER,
    assignedWorkerId: WORKER,
    claimedBy: WORKER,
    requester: { id: NODE_REQUESTER, kind: "node", role: "hub" },
    target: { id: WORKER, kind: "node", role: "analyst" },
    intent: "propose_patch",
    brokerOfRecord: "brokerbeta",
    payload: {
      parentRoundId: "brokerbeta-child-round",
      parentRoundTotal: 2,
      parentRoundOrder: 1,
      originBrokerId: NODE_REQUESTER,
      brokerOfRecordId: "brokerbeta",
      operatorFacingOwner: "parent",
      crossBrokerHandoff: {
        parentRoundId: "brokerbeta-child-round",
        originBrokerId: NODE_REQUESTER,
        handoffBrokerId: "brokerbeta",
        childWorkerId: WORKER,
      },
      notificationOwnership: {
        owner: "parent",
        ownerBrokerId: NODE_REQUESTER,
        scope: "parent-broker-only",
      },
    },
    artifactIds: [],
    status: "succeeded",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:05.000Z",
    completedAt: "2026-10-01T00:00:05.000Z",
  } as unknown as TaskRecord;
}

function terminalStatusEvent(task: TaskRecord): TaskStatusEvent {
  return {
    id: 7,
    timestamp: task.completedAt ?? task.updatedAt,
    taskId: task.id,
    kind: "succeeded",
    status: task.status,
  } as unknown as TaskStatusEvent;
}

test("#2331 (d) outbox keeps a node-owned stored task locally owned when knownBrokerIds is configured", () => {
  const task = legacyOrphanTask();
  const outbox = new TerminalTaskEventOutbox({ brokerId: "brokerbeta", knownBrokerIds: ["brokeralpha"] });

  const event = outbox.enqueue(terminalStatusEvent(task), task);

  assert.ok(event);
  assert.equal(event.payload.brokerOfRecordId, "brokerbeta", "notification owner falls back to the lifecycle broker-of-record");
  assert.equal(event.payload.notificationOwnership, undefined, "no parent-broker-only scope");
  assert.equal(event.payload.crossBrokerHandoff, undefined, "no crossBrokerHandoff");
  assert.deepEqual(event.payload.notificationOwnershipFallback, {
    reason: "unknown_owner_broker",
    claimedOwner: NODE_REQUESTER,
  });
  assert.equal(
    buildCrossBrokerTerminalBriefProjectionFromEvent(event, { sourceBrokerId: "brokerbeta", destinationBrokerId: NODE_REQUESTER }),
    null,
    "no receiver will relay the downgraded brief",
  );
});

test("#2331 (d) without knownBrokerIds the outbox keeps legacy parent ownership (guard inactive)", () => {
  const task = legacyOrphanTask();
  const outbox = new TerminalTaskEventOutbox({ brokerId: "brokerbeta" });

  const event = outbox.enqueue(terminalStatusEvent(task), task);

  assert.ok(event);
  assert.equal(event.payload.notificationOwnership?.scope, "parent-broker-only");
  assert.equal(event.payload.notificationOwnership?.ownerBrokerId, NODE_REQUESTER);
  assert.equal(event.payload.notificationOwnershipFallback, undefined);
});

test("#2331 (d) broker wires knownBrokerIds into the outbox for a node-owned parent claim", () => {
  // knownBrokerIds is empty at create time so the stored task carries the
  // legacy node owner; a restarted broker with the guard configured must not
  // emit the orphan.
  const legacy = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokerbeta" });
  registerWorker(legacy);
  const created = legacy.createTask(patchRequest({ originBrokerId: NODE_REQUESTER, parentRoundId: "brokerbeta-child-round" }));
  assert.equal(created.payload.originBrokerId, NODE_REQUESTER);

  const restarted = new InMemoryA2ABroker(undefined, legacy.exportSnapshot(), {
    brokerId: "brokerbeta",
    knownBrokerIds: ["brokeralpha"],
  });
  const event = completeAndReadTerminalEvent(restarted, created.id);

  assert.equal(event.payload.brokerOfRecordId, "brokerbeta");
  assert.equal(event.payload.notificationOwnership, undefined);
  assert.equal(event.payload.crossBrokerHandoff, undefined);
  assert.deepEqual(event.payload.notificationOwnershipFallback, { reason: "unknown_owner_broker", claimedOwner: NODE_REQUESTER });
});

// ---- (e) handoff-receiver regression ---------------------------------------

test("#2331 (e) handoff-receiver-shaped task with a known origin still emits parent-broker-only to the origin", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokerbeta", knownBrokerIds: ["brokeralpha"] });
  registerWorker(broker);

  const task = broker.createTask(patchRequest({
    parentRoundId: "brokeralpha-parent-round",
    originBrokerId: "brokeralpha",
    brokerOfRecordId: "brokeralpha",
    operatorFacingOwner: "parent",
    crossBrokerHandoff: {
      parentRoundId: "brokeralpha-parent-round",
      originBrokerId: "brokeralpha",
      handoffBrokerId: "brokerbeta",
      childWorkerId: WORKER,
      originTaskId: "brokeralpha-parent-task-1",
    },
  }, {
    requester: { id: "brokeralpha-handoff", kind: "service", role: "operator" },
    brokerOfRecord: "brokerbeta",
  }));

  const event = completeAndReadTerminalEvent(broker, task.id);

  assert.equal(event.payload.notificationOwnershipFallback, undefined);
  assert.equal(event.payload.notificationOwnership?.scope, "parent-broker-only");
  assert.equal(event.payload.notificationOwnership?.ownerBrokerId, "brokeralpha");
  assert.deepEqual(event.payload.crossBrokerHandoff, {
    parentRoundId: "brokeralpha-parent-round",
    originBrokerId: "brokeralpha",
    handoffBrokerId: "brokerbeta",
    originTaskId: "brokeralpha-parent-task-1",
    childWorkerId: WORKER,
  });
  const projection = buildCrossBrokerTerminalBriefProjectionFromEvent(event, {
    sourceBrokerId: "brokerbeta",
    destinationBrokerId: "brokeralpha",
  });
  assert.equal(projection?.parentRoundId, "brokeralpha-parent-round");
  assert.equal(projection?.brokerOfRecordId, "brokeralpha");
});

// ---- (f) projection store contract unchanged -------------------------------

test("#2331 (f) a self-referencing child projection is still rejected missing_parent by the parent broker", () => {
  const parent = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha", knownBrokerIds: ["brokerbeta"] });
  registerWorker(parent);
  parent.createTask({
    id: "brokeralpha-parent-round",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: WORKER, kind: "node", role: "analyst" },
    assignedWorkerId: WORKER,
    message: "parent round",
    payload: { parentRoundTotal: 2 },
  });

  // The child round names itself as parent (the pre-fix dispatch helper shape).
  const result = parent.ingestCrossBrokerTerminalBriefProjection({
    parentRoundId: "brokerbeta-child-round",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "brokerbeta-child-1",
    parentRoundTotal: 2,
    parentRoundOrder: 1,
    status: "succeeded",
    summary: "child completed",
    completedAt: "2026-10-01T00:00:05.000Z",
    emittedAt: "2026-10-01T00:00:06.000Z",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_parent");
  assert.equal(result.ack.terminalAck, false);
  assert.equal(parent.listCrossBrokerTerminalBriefProjections().length, 0, "no implicit parent round is created");
});
