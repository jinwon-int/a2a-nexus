import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";

function registerWorker(broker: InMemoryA2ABroker, nodeId: string): void {
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

function workModeDecision(): Record<string, unknown> {
  return {
    mode: "team1",
    idempotencyKey: "team1-parent-round-policy:test",
    finalizerOwner: "seoseo",
    generatedAt: "2026-06-08T13:00:00.000Z",
    capacityState: "healthy",
    capacitySnapshotSource: "/workers/capacity",
    capacitySnapshotAt: "2026-06-08T12:59:00.000Z",
    sourceOnlyDecision: true,
    workerDispatchAllowedByThisPacket: false,
  };
}

test("operator Team1 tasks fail closed when parent round order metadata is missing", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  registerWorker(broker, "bangtong");

  assert.throws(
    () =>
      broker.createTask({
        id: "team1-parentless-canary",
        intent: "analyze",
        requester: { id: "seoseo", kind: "node", role: "hub" },
        target: { id: "bangtong", kind: "node", role: "analyst" },
        assignedWorkerId: "bangtong",
        message: "analysis-only Team1 canary without parent order metadata",
        payload: {
          mode: "analysis-only",
          discussionRunId: "team1-hermes-canary",
        },
        taskOrigin: "operator",
        teamId: "team1",
        brokerOfRecord: "seoseo",
      }),
    {
      name: "BrokerError",
      code: "bad_request",
      message: /parentRoundTotal|parentRoundOrder/,
    },
  );
});

test("operator Team1 tasks must pass through parent round resolution before creation", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  for (const workerId of ["sogyo", "nosuk", "bangtong"]) {
    registerWorker(broker, workerId);
  }

  const task = broker.createTask({
    id: "team1-parent-resolved-canary",
    intent: "analyze",
    requester: { id: "seoseo", kind: "node", role: "hub" },
    target: { id: "bangtong", kind: "node", role: "analyst" },
    assignedWorkerId: "bangtong",
    message: "analysis-only Team1 canary resolved by participant topology",
    payload: {
      mode: "analysis-only",
      discussionRunId: "team1-hermes-canary",
      participantWorkers: ["sogyo", "nosuk", "bangtong"],
      workModeDecision: workModeDecision(),
    },
    taskOrigin: "operator",
    teamId: "team1",
    brokerOfRecord: "seoseo",
  });

  assert.equal(task.payload.parentRoundId, "team1-hermes-canary");
  assert.equal(task.payload.run, "team1-hermes-canary");
  assert.equal(task.payload.parentRoundTotal, 3);
  assert.equal(task.payload.parentRoundOrder, 3);
  assert.equal(task.parentRoundId, "team1-hermes-canary");
  assert.equal(task.parentRoundTotal, 3);
  assert.equal(task.parentRoundOrder, 3);
  assert.deepEqual(task.payload.parentRoundResolution, {
    kind: "a2a.parent-round-resolution.v1",
    required: true,
    teamScope: "team1",
    parentRoundId: "team1-hermes-canary",
    parentRoundTotal: 3,
    parentRoundOrder: 3,
    sources: {
      teamScope: "request.teamId",
      parentRoundId: "payload.discussionRunId",
      parentRoundTotal: "payload.participantWorkers.length",
      parentRoundOrder: "payload.participantWorkers.index",
      participantWorkers: "payload participant worker list",
      originBrokerId: "request/broker",
      brokerOfRecordId: "request/broker",
    },
  });
});

test("operator Team1 round denominator uses actual dispatched workers before broad participants", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  for (const workerId of ["sogyo", "nosuk", "bangtong", "gongyung", "yukson"]) {
    registerWorker(broker, workerId);
  }

  const task = broker.createTask({
    id: "team1-actual-dispatch-denominator-canary",
    intent: "analyze",
    requester: { id: "seoseo", kind: "node", role: "hub" },
    target: { id: "yukson", kind: "node", role: "analyst" },
    assignedWorkerId: "yukson",
    message: "analysis-only Team1 canary resolved by actual dispatch topology",
    payload: {
      mode: "analysis-only",
      discussionRunId: "team1-worker-refresh-canary",
      participantWorkers: ["sogyo", "nosuk", "bangtong", "gongyung", "yukson"],
      dispatchedWorkers: ["sogyo", "nosuk", "bangtong", "yukson"],
      workModeDecision: workModeDecision(),
    },
    taskOrigin: "operator",
    teamId: "team1",
    brokerOfRecord: "seoseo",
  });

  assert.equal(task.payload.parentRoundId, "team1-worker-refresh-canary");
  assert.equal(task.payload.parentRoundTotal, 4);
  assert.equal(task.payload.parentRoundOrder, 4);
  assert.equal(task.parentRoundTotal, 4);
  assert.equal(task.parentRoundOrder, 4);
  assert.deepEqual(task.payload.parentRoundResolution, {
    kind: "a2a.parent-round-resolution.v1",
    required: true,
    teamScope: "team1",
    parentRoundId: "team1-worker-refresh-canary",
    parentRoundTotal: 4,
    parentRoundOrder: 4,
    sources: {
      teamScope: "request.teamId",
      parentRoundId: "payload.discussionRunId",
      parentRoundTotal: "payload.dispatchedWorkers.length",
      parentRoundOrder: "payload.dispatchedWorkers.index",
      dispatchedWorkers: "payload.dispatchedWorkers",
      participantWorkers: "payload participant worker list",
      originBrokerId: "request/broker",
      brokerOfRecordId: "request/broker",
    },
  });
});

test("operator Team1 tasks normalize discussionRunId into parent round metadata", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  registerWorker(broker, "bangtong");

  const task = broker.createTask({
    id: "team1-parent-aware-canary",
    intent: "analyze",
    requester: { id: "seoseo", kind: "node", role: "hub" },
    target: { id: "bangtong", kind: "node", role: "analyst" },
    assignedWorkerId: "bangtong",
    message: "analysis-only Team1 canary with parent metadata",
    payload: {
      mode: "analysis-only",
      discussionRunId: "team1-hermes-canary",
      parentRoundTotal: 3,
      parentRoundOrder: 2,
      workModeDecision: workModeDecision(),
    },
    taskOrigin: "operator",
    teamId: "team1",
    brokerOfRecord: "seoseo",
  });

  assert.equal(task.payload.parentRoundId, "team1-hermes-canary");
  assert.equal(task.payload.run, "team1-hermes-canary");
  assert.equal(task.payload.parentRoundTotal, 3);
  assert.equal(task.payload.parentRoundOrder, 2);
  assert.equal(task.parentRoundId, "team1-hermes-canary");
  assert.equal(task.parentRoundTotal, 3);
  assert.equal(task.parentRoundOrder, 2);
  assert.equal(task.payload.originBrokerId, "seoseo");
  assert.equal(task.payload.brokerOfRecordId, "seoseo");
  assert.equal(task.payload.teamScope, "team1");
});

test("operator Team1 decision-dialectic parent tasks are not treated as A2A round children", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  registerWorker(broker, "sogyo");

  const task = broker.createTask({
    id: "decision-dialectic-parent",
    intent: "analyze",
    requester: { id: "seoseo", kind: "node", role: "hub" },
    target: { id: "sogyo", kind: "node", role: "analyst" },
    assignedWorkerId: "sogyo",
    message: "decision dialectic parent task",
    payload: {
      contract: {
        kind: "decision.dialectic",
        version: "1",
        phase: "thesis",
      },
    },
    taskOrigin: "operator",
    teamId: "team1",
    brokerOfRecord: "seoseo",
  });

  assert.equal(task.payload.parentRoundId, undefined);
  assert.equal(task.payload.teamScope, undefined);
});

test("source-only A2A analysis with sourceHints fails closed when no source evidence is attached", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  registerWorker(broker, "sogyo");

  assert.throws(
    () =>
      broker.createTask({
        id: "team1-source-hints-without-bundle",
        intent: "analyze",
        requester: { id: "seoseo", kind: "node", role: "hub" },
        target: { id: "sogyo", kind: "node", role: "analyst" },
        assignedWorkerId: "sogyo",
        message: "source-only A2A task with source hints but no source bundle",
        payload: {
          mode: "analysis-only",
          noLive: true,
          sourceOnly: true,
          readOnlyValidation: true,
          discussionRunId: "team1-source-map-canary",
          participantWorkers: ["sogyo"],
          sourceHints: [
            { repo: "jinwon-int/a2a-nexus", path: "packages/broker/src/core/a2a-intent-router.ts" },
          ],
          workModeDecision: workModeDecision(),
        },
        taskOrigin: "operator",
        teamId: "team1",
        brokerOfRecord: "seoseo",
      }),
    {
      name: "BrokerError",
      code: "bad_request",
      message: /source evidence/i,
    },
  );
});

test("source-only A2A analysis accepts embedded source evidence instead of harness-specific repo access", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  registerWorker(broker, "sogyo");

  const task = broker.createTask({
    id: "team1-embedded-source-evidence",
    intent: "analyze",
    requester: { id: "seoseo", kind: "node", role: "hub" },
    target: { id: "sogyo", kind: "node", role: "analyst" },
    assignedWorkerId: "sogyo",
    message: "source-only A2A task with embedded source evidence",
    payload: {
      mode: "analysis-only",
      noLive: true,
      sourceOnly: true,
      readOnlyValidation: true,
      discussionRunId: "team1-embedded-source-canary",
      participantWorkers: ["sogyo"],
      sourceHints: [
        { repo: "jinwon-int/a2a-nexus", path: "packages/broker/src/core/a2a-intent-router.ts" },
      ],
      embeddedSourceEvidence: [
        { repo: "jinwon-int/a2a-nexus", path: "packages/broker/src/core/a2a-intent-router.ts", content: "export const marker = true;" },
      ],
      workModeDecision: workModeDecision(),
    },
    taskOrigin: "operator",
    teamId: "team1",
    brokerOfRecord: "seoseo",
  });

  const sourceEvidenceResolution = task.payload.sourceEvidenceResolution as Record<string, unknown>;
  assert.equal(task.payload.parentRoundId, "team1-embedded-source-canary");
  assert.equal(sourceEvidenceResolution.kind, "a2a.source-evidence-resolution.v1");
  assert.equal(sourceEvidenceResolution.status, "embedded");
});
