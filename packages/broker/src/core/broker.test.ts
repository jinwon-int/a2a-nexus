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
import { registerWorker, createWorkerTask, createGithubPatchTask, createOwnedTask } from "./broker-test-helpers.js";

test("broker annotates tasks with owner metadata and rejects mismatched lifecycle ownership", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "broker-a",
    teamId: "team-a",
  });
  registerWorker(broker, "worker-owned");

  const owned = createOwnedTask(broker, "task-owned-defaults", "worker-owned");
  assert.equal(owned.brokerOfRecord, "broker-a");
  assert.equal(owned.teamId, "team-a");

  assert.throws(() => createOwnedTask(broker, "task-wrong-broker-create", "worker-owned", {
    brokerOfRecord: "broker-b",
    teamId: "team-a",
  }), {
    name: "BrokerError",
    code: "policy_denied",
    message: "create cannot set brokerOfRecord broker-b on broker broker-a",
  });

  const wrongBroker = createOwnedTask(broker, "task-wrong-broker", "worker-owned");
  wrongBroker.brokerOfRecord = "broker-b";
  assert.throws(() => broker.claimTask(wrongBroker.id, "worker-owned"), {
    name: "BrokerError",
    code: "policy_denied",
    message: "claim requires broker-of-record broker-b",
  });

  const wrongTeam = createOwnedTask(broker, "task-wrong-team", "worker-owned", {
    brokerOfRecord: "broker-a",
    teamId: "team-b",
  });
  assert.throws(() => broker.claimTask(wrongTeam.id, "worker-owned"), {
    name: "BrokerError",
    code: "policy_denied",
    message: "claim requires teamId team-b",
  });

  const startGuard = createOwnedTask(broker, "task-start-guard", "worker-owned");
  broker.claimTask(startGuard.id, "worker-owned");
  startGuard.brokerOfRecord = "broker-b";
  assert.throws(() => broker.startTask(startGuard.id, "worker-owned"), {
    name: "BrokerError",
    code: "policy_denied",
    message: "start requires broker-of-record broker-b",
  });

  const completeGuard = createOwnedTask(broker, "task-complete-guard", "worker-owned");
  broker.claimTask(completeGuard.id, "worker-owned");
  broker.startTask(completeGuard.id, "worker-owned");
  completeGuard.teamId = "team-b";
  assert.throws(() => broker.completeTask(completeGuard.id, "worker-owned", { summary: "done" }), {
    name: "BrokerError",
    code: "policy_denied",
    message: "complete requires teamId team-b",
  });

  const failGuard = createOwnedTask(broker, "task-fail-guard", "worker-owned");
  broker.claimTask(failGuard.id, "worker-owned");
  broker.startTask(failGuard.id, "worker-owned");
  failGuard.brokerOfRecord = "broker-b";
  assert.throws(() => broker.failTask(failGuard.id, "worker-owned", { message: "boom" }), {
    name: "BrokerError",
    code: "policy_denied",
    message: "fail requires broker-of-record broker-b",
  });
});

test("broker normalizes cross-broker child tasks into parent-owned Terminal Brief payloads", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "gwakga",
    teamId: "team2",
  });
  registerWorker(broker, "jingun");

  const task = broker.createTask({
    id: "seoseo-led-team2-jingun",
    intent: "verify",
    requester: { id: "seoseo", kind: "node", role: "operator" },
    target: { id: "jingun", kind: "node", role: "analyst" },
    assignedWorkerId: "jingun",
    message: "audit Family Wiki A2A page",
    payload: {
      parentRoundId: "family-wiki-cleanup-20260522T031233Z",
      parentRoundTotal: 7,
      parentRoundOrder: 2,
      requestedByBroker: "seoseo",
    },
  });

  assert.equal(task.payload["originBrokerId"], "seoseo");
  assert.equal(task.payload["operatorFacingOwner"], "parent");
  assert.deepEqual(task.payload["crossBrokerHandoff"], {
    parentRoundId: "family-wiki-cleanup-20260522T031233Z",
    originBrokerId: "seoseo",
    handoffBrokerId: "gwakga",
    childWorkerId: "jingun",
  });
  assert.deepEqual(task.payload["notificationOwnership"], {
    owner: "parent",
    ownerBrokerId: "seoseo",
    scope: "parent-broker-only",
    providerSendPermittedByProjection: false,
    terminalAckPermittedByProjection: false,
    reason: "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
  });
  assert.deepEqual(task.payload["terminalBrief"], {
    parentOwnedTerminalBrief: true,
    notificationOwnership: {
      owner: "parent",
      ownerBrokerId: "seoseo",
      scope: "parent-broker-only",
    },
  });
});

test("broker preserves raw dispatch metadata when brokerId is not configured (no enrichment, no regression)", () => {
  // When the broker has no brokerId configured, normalizeTaskPayload returns
  // early because !localBrokerId. The raw payload fields (parentRoundId,
  // parentRoundTotal, parentRoundOrder, requestedByBroker) are preserved
  // as-is. Cross-broker enrichment (crossBrokerHandoff, notificationOwnership,
  // terminalBrief) is absent — projection-time ingestion in
  // CrossBrokerTerminalBriefProjectionStore handles metadata assembly.
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    teamId: "team2",
  });
  registerWorker(broker, "jingun");

  // Use parentRoundId with an explicit run alias so hasTerminalBriefMetadata
  // returns false (parentRoundId alone is not a trigger) — this test only
  // validates that raw payload fields survive without cross-broker enrichment
  // when localBrokerId is absent.
  const task = broker.createTask({
    id: "seoseo-led-unconfigured-broker-jingun",
    intent: "verify",
    requester: { id: "seoseo", kind: "node", role: "operator" },
    target: { id: "jingun", kind: "node", role: "analyst" },
    assignedWorkerId: "jingun",
    message: "audit page with missing broker ID",
    payload: {
      parentRoundId: "unconfigured-round-20260522",
      requestedByBroker: "seoseo",
    },
  });

  // Raw dispatch fields are preserved
  assert.equal(task.payload["parentRoundId"], "unconfigured-round-20260522");
  assert.equal(task.payload["requestedByBroker"], "seoseo");
  // No enrichment because localBrokerId is absent
  assert.equal(task.payload["crossBrokerHandoff"], undefined,
    "crossBrokerHandoff enrichment requires a configured brokerId");
  assert.equal(task.payload["notificationOwnership"], undefined,
    "notificationOwnership enrichment requires a configured brokerId");
  assert.equal(task.payload["terminalBrief"], undefined,
    "terminalBrief enrichment requires a configured brokerId");
});

test("broker hoists payload-only parentRound fields onto the top-level task record (#629)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "gwakga",
    teamId: "team2",
  });
  registerWorker(broker, "jingun");

  // Dispatch paths that only stamp parentRound metadata into payload must still
  // surface it as top-level task.parentRoundId so round-status queries over
  // listTasks() can key on it reliably.
  const task = broker.createTask({
    id: "payload-only-parent-round",
    intent: "verify",
    requester: { id: "seoseo", kind: "node", role: "operator" },
    target: { id: "jingun", kind: "node", role: "analyst" },
    assignedWorkerId: "jingun",
    message: "round child with payload-only parent metadata",
    payload: {
      parentRoundId: "round-payload-only-20260614",
      parentRoundTotal: 5,
      parentRoundOrder: 3,
      requestedByBroker: "seoseo",
    },
  });

  // Hoisted at create time...
  assert.equal(task.parentRoundId, "round-payload-only-20260614");
  assert.equal(task.parentRoundTotal, 5);
  assert.equal(task.parentRoundOrder, 3);
  // ...and preserved in payload for existing consumers.
  assert.equal(task.payload["parentRoundId"], "round-payload-only-20260614");

  // ...and exposed consistently through the listTasks() query path.
  const listed = broker.listTasks().find((t) => t.id === "payload-only-parent-round");
  assert.equal(listed?.parentRoundId, "round-payload-only-20260614");
  assert.equal(listed?.parentRoundTotal, 5);
  assert.equal(listed?.parentRoundOrder, 3);
});

test("broker hoists numeric-string parentRound payload fields using Terminal Brief metadata semantics (#629)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "gwakga",
    teamId: "team2",
  });
  registerWorker(broker, "jingun");

  const task = broker.createTask({
    id: "payload-string-parent-round",
    intent: "verify",
    requester: { id: "seoseo", kind: "node", role: "operator" },
    target: { id: "jingun", kind: "node", role: "analyst" },
    assignedWorkerId: "jingun",
    message: "round child with string parent metadata",
    payload: {
      parentRoundId: " round-string-20260615 ",
      parentRoundTotal: "5",
      parentRoundOrder: "3",
      requestedByBroker: "seoseo",
    },
  });

  assert.equal(task.parentRoundId, "round-string-20260615");
  assert.equal(task.parentRoundTotal, 5);
  assert.equal(task.parentRoundOrder, 3);
});

test("broker ignores invalid numeric parentRound fields while falling back to valid payload values (#629)", () => {
  const broker = new InMemoryA2ABroker(undefined, {
    ...emptySnapshot(),
    tasks: [{
      id: "loaded-invalid-parent-round-number",
      intent: "verify",
      requester: { id: "seoseo", kind: "node", role: "operator" },
      target: { id: "jingun", kind: "node", role: "analyst" },
      targetNodeId: "jingun",
      status: "queued",
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      parentRoundId: "round-loaded",
      parentRoundTotal: 0,
      parentRoundOrder: -1,
      payload: {
        parentRoundTotal: "5",
        parentRoundOrder: "3",
      },
    }],
  });

  const task = broker.listTasks().find((item) => item.id === "loaded-invalid-parent-round-number");
  assert.equal(task?.parentRoundTotal, 5);
  assert.equal(task?.parentRoundOrder, 3);
});

test("broker idempotent createTask returns existing task with same id (duplicate handling)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "gwakga",
    teamId: "team2",
  });
  registerWorker(broker, "jingun");

  const request = {
    id: "duplicate-team2-child-task",
    intent: "verify" as const,
    requester: { id: "seoseo", kind: "node" as const, role: "operator" as const },
    target: { id: "jingun", kind: "node" as const, role: "analyst" as const },
    assignedWorkerId: "jingun",
    message: "duplicate task for idempotency test",
    payload: {
      parentRoundId: "idempotent-round",
      parentRoundTotal: 3,
      parentRoundOrder: 1,
      requestedByBroker: "seoseo",
    },
  };

  const first = broker.createTask(request);
  const second = broker.createTask(request);

  // Second call returns the same task without mutation
  assert.equal(first.id, request.id);
  assert.equal(second.id, first.id);
  assert.deepEqual(second.payload["crossBrokerHandoff"], first.payload["crossBrokerHandoff"]);
  assert.deepEqual(second.payload["notificationOwnership"], first.payload["notificationOwnership"]);
  assert.deepEqual(second.payload["terminalBrief"], first.payload["terminalBrief"]);
  // Only one task in the broker
  assert.equal(
    broker.listTasks().filter((t) => t.id === request.id).length,
    1,
    "duplicate createTask must not produce a second task record",
  );
});

test("broker createTask rejects Team1 parent-round task without work-mode decision evidence", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  registerWorker(broker, "yukson");

  assert.throws(
    () =>
      broker.createTask({
        id: "team1-without-work-mode-evidence",
        intent: "verify",
        requester: { id: "seoseo", kind: "node", role: "operator" },
        target: { id: "yukson", kind: "node", role: "analyst" },
        assignedWorkerId: "yukson",
        message: "Team1 parent-round task without pre-dispatch evidence",
        payload: {
          teamId: "team1",
          parentRoundId: "a2a-work-mode-round",
          parentRoundTotal: 4,
          parentRoundOrder: 1,
        },
      }),
    {
      name: "BrokerError",
      code: "bad_request",
      message: /work-mode decision evidence validation failed/,
    },
  );
});

test("broker createTask accepts Team1 parent-round task with valid work-mode decision evidence", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  registerWorker(broker, "yukson");

  const task = broker.createTask({
    id: "team1-with-work-mode-evidence",
    intent: "verify",
    requester: { id: "seoseo", kind: "node", role: "operator" },
    target: { id: "yukson", kind: "node", role: "analyst" },
    assignedWorkerId: "yukson",
    message: "Team1 parent-round task with pre-dispatch evidence",
    payload: {
      teamId: "team1",
      parentRoundId: "a2a-work-mode-round",
      parentRoundTotal: 4,
      parentRoundOrder: 1,
      originBrokerId: "seoseo",
      workModeDecision: {
        mode: "team1",
        idempotencyKey: "a2a-work-mode:team1:test",
        finalizerOwner: "seoseo",
        generatedAt: "2026-06-07T06:00:00.000Z",
        capacityState: "healthy",
        capacitySnapshotSource: "/workers/capacity",
        capacitySnapshotAt: "2026-06-07T05:59:00.000Z",
        sourceOnlyDecision: true,
        workerDispatchAllowedByThisPacket: false,
      },
    },
  });

  assert.equal(task.id, "team1-with-work-mode-evidence");
  assert.equal((task.payload["workModeDecision"] as Record<string, unknown>)?.["finalizerOwner"], "seoseo");
});

test("broker rejects task workspace metadata missing workspaceId before persistence", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "gwakga",
    teamId: "team2",
  });
  registerWorker(broker, "dungae");

  assert.throws(
    () =>
      broker.createTask({
        id: "malformed-workspace-task",
        intent: "verify",
        requester: { id: "seoseo", kind: "node", role: "operator" },
        target: { id: "dungae", kind: "node", role: "analyst" },
        assignedWorkerId: "dungae",
        workspace: { id: "openclaw-ops", kind: "filesystem", nodeId: "dungae" } as any,
        message: "malformed workspace metadata should not enter broker_tasks",
        payload: {
          parentRoundId: "cross-team-canary",
          originBrokerId: "seoseo",
          parentRoundOrder: 1,
          parentRoundTotal: 1,
        },
        taskOrigin: "operator",
      }),
    {
      name: "BrokerError",
      code: "bad_request",
      message: /workspace\.nodeId and workspace\.workspaceId are required/,
    },
  );
  assert.equal(broker.listTasks().some((task) => task.id === "malformed-workspace-task"), false);
});

test("broker fail-closed at createTask when Terminal Brief metadata has missing parentRoundTotal", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "gwakga",
    teamId: "team2",
  });
  registerWorker(broker, "jingun");

  // parentRoundOrder present but parentRoundTotal absent.
  // originBrokerId triggers hasTerminalBriefMetadata.
  assert.throws(
    () =>
      broker.createTask({
        id: "fail-closed-missing-total",
        intent: "verify",
        requester: { id: "seoseo", kind: "node", role: "operator" },
        target: { id: "jingun", kind: "node", role: "analyst" },
        assignedWorkerId: "jingun",
        message: "missing parentRoundTotal",
        payload: {
          parentRoundId: "fail-closed-round",
          originBrokerId: "seoseo",
          parentRoundOrder: 2,
        },
      }),
    {
      name: "BrokerError",
      code: "bad_request",
      message: /parentRoundTotal/,
    },
  );
});

test("broker fail-closed at createTask when Terminal Brief metadata has missing parentRoundOrder", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "gwakga",
    teamId: "team2",
  });
  registerWorker(broker, "jingun");

  // parentRoundTotal present but parentRoundOrder absent.
  // originBrokerId triggers hasTerminalBriefMetadata.
  assert.throws(
    () =>
      broker.createTask({
        id: "fail-closed-missing-order",
        intent: "verify",
        requester: { id: "seoseo", kind: "node", role: "operator" },
        target: { id: "jingun", kind: "node", role: "analyst" },
        assignedWorkerId: "jingun",
        message: "missing parentRoundOrder",
        payload: {
          parentRoundId: "fail-closed-round",
          originBrokerId: "seoseo",
          parentRoundTotal: 5,
        },
      }),
    {
      name: "BrokerError",
      code: "bad_request",
      message: /parentRoundOrder/,
    },
  );
});

test("broker fail-closed at createTask when parentRoundOrder exceeds parentRoundTotal", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "gwakga",
    teamId: "team2",
  });
  registerWorker(broker, "jingun");

  assert.throws(
    () =>
      broker.createTask({
        id: "fail-closed-order-exceeds-total",
        intent: "verify",
        requester: { id: "seoseo", kind: "node", role: "operator" },
        target: { id: "jingun", kind: "node", role: "analyst" },
        assignedWorkerId: "jingun",
        message: "order exceeds total",
        payload: {
          parentRoundId: "fail-closed-round",
          parentRoundTotal: 3,
          parentRoundOrder: 5,
          requestedByBroker: "seoseo",
        },
      }),
    {
      name: "BrokerError",
      code: "bad_request",
      message: /must not exceed/,
    },
  );
});

test("broker rejects A2A round task without parent round total and order", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  registerWorker(broker, "sogyo");

  assert.throws(
    () =>
      broker.createTask({
        id: "a2a-round-missing-terminal-brief-order",
        intent: "analyze",
        requester: { id: "seoseo", kind: "node", role: "operator" },
        target: { id: "sogyo", kind: "node", role: "analyst" },
        assignedWorkerId: "sogyo",
        message: "A2A task missing parentRoundTotal and parentRoundOrder",
        payload: {
          mode: "ordinary_a2a_lite",
          teamScope: "team1",
          parentRoundId: "a2a-1032-round",
          originBrokerId: "seoseo",
        },
      }),
    {
      name: "BrokerError",
      code: "bad_request",
      message: /A2A round task policy validation failed: .*parentRoundTotal.*parentRoundOrder/,
    },
  );
});

test("broker rejects A2A round task assigned outside the declared team", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  registerWorker(broker, "dungae");

  assert.throws(
    () =>
      broker.createTask({
        id: "a2a-round-wrong-team-worker",
        intent: "analyze",
        requester: { id: "seoseo", kind: "node", role: "operator" },
        target: { id: "dungae", kind: "node", role: "analyst" },
        assignedWorkerId: "dungae",
        message: "A2A task assigned to the wrong team worker",
        payload: {
          mode: "ordinary_a2a_lite",
          teamScope: "team1",
          parentRoundId: "a2a-1032-round",
          originBrokerId: "seoseo",
          parentRoundTotal: 3,
          parentRoundOrder: 1,
        },
      }),
    {
      name: "BrokerError",
      code: "bad_request",
      message: /worker dungae is not in the team1 worker set/,
    },
  );
});

test("broker accepts A2A round task with team worker and complete Terminal Brief metadata", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    teamId: "team1",
  });
  registerWorker(broker, "sogyo");

  const task = broker.createTask({
    id: "a2a-round-valid-team-worker",
    intent: "analyze",
    requester: { id: "seoseo", kind: "node", role: "operator" },
    target: { id: "sogyo", kind: "node", role: "analyst" },
    assignedWorkerId: "sogyo",
    message: "A2A task with complete round metadata",
    payload: {
      mode: "ordinary_a2a_lite",
      teamScope: "team1",
      parentRoundId: "a2a-1032-round",
      originBrokerId: "seoseo",
      parentRoundTotal: 3,
      parentRoundOrder: 1,
    },
  });

  assert.equal(task.assignedWorkerId, "sogyo");
  assert.equal(task.payload.parentRoundTotal, 3);
  assert.equal(task.payload.parentRoundOrder, 1);
});

test("broker fail-closed at createTask when crossBrokerHandoff has empty parentRoundId", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "gwakga",
    teamId: "team2",
  });
  registerWorker(broker, "jingun");

  assert.throws(
    () =>
      broker.createTask({
        id: "fail-closed-missing-parent-round-id",
        intent: "verify",
        requester: { id: "seoseo", kind: "node", role: "operator" },
        target: { id: "jingun", kind: "node", role: "analyst" },
        assignedWorkerId: "jingun",
        message: "missing parentRoundId",
        payload: {
          // parentRoundId deliberately absent
          originBrokerId: "seoseo",
          parentRoundTotal: 5,
          parentRoundOrder: 2,
        },
      }),
    {
      name: "BrokerError",
      code: "bad_request",
      message: /parentRoundId/,
    },
  );
});

test("broker fail-closed at createTask when crossBrokerHandoff has empty originBrokerId", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "gwakga",
    teamId: "team2",
  });
  registerWorker(broker, "jingun");

  assert.throws(
    () =>
      broker.createTask({
        id: "fail-closed-missing-origin-broker",
        intent: "verify",
        requester: { id: "seoseo", kind: "node", role: "operator" },
        target: { id: "jingun", kind: "node", role: "analyst" },
        assignedWorkerId: "jingun",
        message: "missing originBrokerId",
        payload: {
          parentRoundId: "fail-closed-round",
          // originBrokerId deliberately absent
          parentRoundTotal: 5,
          parentRoundOrder: 2,
        },
      }),
    {
      name: "BrokerError",
      code: "bad_request",
      message: /originBrokerId/,
    },
  );
});

test("broker fail-closes GitHub patch completion when evidence is missing", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-evidence");
  const task = createGithubPatchTask(broker, "task-github-evidence-missing", "worker-github-evidence");
  broker.claimTask(task.id, "worker-github-evidence");
  broker.startTask(task.id, "worker-github-evidence");

  assert.throws(
    () => broker.completeTask(task.id, "worker-github-evidence", { summary: "done without public evidence" }),
    {
      name: "BrokerError",
      code: "github_completion_evidence_missing",
    },
  );

  assert.equal(broker.getTask(task.id)?.status, "running");
});

test("broker rejects provider send success as GitHub task receipt evidence", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-receipt");
  const task = createGithubPatchTask(broker, "task-github-receipt-invalid", "worker-github-receipt");
  broker.claimTask(task.id, "worker-github-receipt");

  assert.throws(
    () => broker.completeTask(task.id, "worker-github-receipt", {
      summary: "PR opened",
      output: {
        github: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/311" },
        receipt: { status: "operator_visible", evidence: "provider_send_success" },
      },
    }),
    {
      name: "BrokerError",
      code: "github_completion_receipt_invalid",
    },
  );

  assert.equal(broker.getTask(task.id)?.status, "claimed");
});

test("broker keeps sent receipt state distinct from operator-visible GitHub evidence", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-sent");
  const task = createGithubPatchTask(broker, "task-github-sent", "worker-github-sent");
  broker.claimTask(task.id, "worker-github-sent");

  const completed = broker.completeTask(task.id, "worker-github-sent", {
    summary: "Done evidence posted",
    output: {
      github: { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/310#issuecomment-1" },
      receipt: { status: "sent" },
    },
  });

  assert.equal(completed.status, "succeeded");
  assert.deepEqual(completed.result?.output?.receipt, { status: "sent" });
});

test("broker returns compact worker capacity counts for queued claimed and running tasks", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-capacity");

  createWorkerTask(broker, "task-capacity-queued", "worker-capacity");
  const claimed = createWorkerTask(broker, "task-capacity-claimed", "worker-capacity");
  broker.claimTask(claimed.id, "worker-capacity");
  const running = createWorkerTask(broker, "task-capacity-running", "worker-capacity");
  broker.claimTask(running.id, "worker-capacity");
  broker.startTask(running.id, "worker-capacity");

  const summary = broker.getWorkerCapacitySummary({ workerOfflineAfterMs: 120_000, taskStaleAfterMs: 120_000 });

  assert.equal(summary.totals.workers, 1);
  assert.equal(summary.totals.queued, 1);
  assert.equal(summary.totals.claimed, 1);
  assert.equal(summary.totals.running, 1);
  assert.equal(summary.totals.active, 3);
  assert.equal(summary.totals.staleTasks, 0);
  assert.equal(summary.items.length, 1);
  assert.deepEqual(summary.items[0].counts, {
    queued: 1,
    claimed: 1,
    running: 1,
    stale: 0,
    active: 3,
  });
  assert.ok(summary.items[0].latestTaskUpdatedAt);
  assert.equal(JSON.stringify(summary).includes("secretLikeLargePayload"), false);
});

test("broker marks claimed and running capacity stale after the configured threshold", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-stale-capacity");
  const claimed = createWorkerTask(broker, "task-stale-capacity-claimed", "worker-stale-capacity");
  broker.claimTask(claimed.id, "worker-stale-capacity");
  const running = createWorkerTask(broker, "task-stale-capacity-running", "worker-stale-capacity");
  broker.claimTask(running.id, "worker-stale-capacity");
  broker.startTask(running.id, "worker-stale-capacity");

  const summary = broker.getWorkerCapacitySummary({
    nowMs: Date.now() + 300_000,
    workerOfflineAfterMs: 120_000,
    taskStaleAfterMs: 120_000,
  });

  assert.equal(summary.totals.online, 0);
  assert.equal(summary.totals.staleWorkers, 1);
  assert.equal(summary.totals.staleTasks, 2);
  assert.equal(summary.items[0].status, "stale");
  assert.equal(summary.items[0].counts.stale, 2);
});

test("broker worker capacity summary handles an empty fleet", () => {
  const broker = new InMemoryA2ABroker();
  const summary = broker.getWorkerCapacitySummary({ nowMs: 0 });

  assert.deepEqual(summary.totals, {
    workers: 0,
    online: 0,
    staleWorkers: 0,
    queued: 0,
    claimed: 0,
    running: 0,
    staleTasks: 0,
    active: 0,
  });
  assert.deepEqual(summary.items, []);
});

test("broker exposes compact diagnostics without task payload expansion", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-diag");
  const task = broker.createTask({
    id: "task-compact-diag",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-diag", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-diag",
    message: "compact diagnostic payload should stay small",
  });
  broker.claimTask(task.id, "worker-diag");

  const diagnostics = broker.getCompactDiagnostics({
    staleAfterMs: 120_000,
    workerOfflineAfterMs: 60_000,
    nowMs: Date.now() + 300_000,
  });

  assert.equal(diagnostics.tasks.total, 1);
  assert.equal(diagnostics.tasks.byStatus.claimed, 1);
  assert.equal(diagnostics.tasks.stale, 1);
  assert.equal(diagnostics.workers.total, 1);
  assert.equal(diagnostics.workers.stale, 1);
  assert.equal(diagnostics.audit.total, 3);
  assert.equal(diagnostics.runtimeRepositories.tasks, false);
  assert.equal(Object.hasOwn(diagnostics, "task"), false);
  assert.equal(Object.hasOwn(diagnostics, "tasksById"), false);
});

test("WorkerView includes workerPlane, managementPlane, updateEligible fields", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "worker-wp-test",
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

  // Default (no managementPlane reported) → unknown
  const view = broker.getWorkerView("worker-wp-test", 120_000);
  assert.ok(view);
  assert.equal(view.status, "online");
  assert.equal(view.workerPlane, "online");
  assert.equal(view.managementPlane, "unknown");
  assert.equal(view.updateEligible, true);
});

test("WorkerView workerPlane goes to unknown when worker goes stale", async () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "worker-stale-plane",
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

  // Small delay to nudge timestamp past 1ms stale threshold
  await new Promise((r) => setTimeout(r, 10));

  const view = broker.getWorkerView("worker-stale-plane", 1);
  assert.ok(view);
  assert.equal(view.status, "stale");
  assert.equal(view.workerPlane, "unknown");
  assert.equal(view.managementPlane, "unknown");
  assert.equal(view.updateEligible, false);
});

test("heartbeat-online with management-disconnected sets updateEligible false", () => {
  const broker = new InMemoryA2ABroker();
  const nodeId = "worker-mgmt-disc";
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

  // Heartbeat with managementPlane="disconnected"
  broker.heartbeatWorker(nodeId, { managementPlane: "disconnected" });

  const view = broker.getWorkerView(nodeId, 120_000);
  assert.ok(view);
  assert.equal(view.status, "online");
  assert.equal(view.workerPlane, "online");
  assert.equal(view.managementPlane, "disconnected");
  assert.equal(view.updateEligible, false);
});

test("heartbeat-online with management-online sets updateEligible true", () => {
  const broker = new InMemoryA2ABroker();
  const nodeId = "worker-mgmt-online";
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

  // Heartbeat with managementPlane="online"
  broker.heartbeatWorker(nodeId, { managementPlane: "online" });

  const view = broker.getWorkerView(nodeId, 120_000);
  assert.ok(view);
  assert.equal(view.status, "online");
  assert.equal(view.workerPlane, "online");
  assert.equal(view.managementPlane, "online");
  assert.equal(view.updateEligible, true);
});

test("listWorkerViews includes plane fields for all workers", async () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "plane-worker-a",
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
  broker.registerWorker({
    nodeId: "plane-worker-b",
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

  // Small delay so workers become stale with 1ms threshold
  await new Promise((r) => setTimeout(r, 10));

  const views = broker.listWorkerViews(1);
  assert.equal(views.length, 2);
  for (const view of views) {
    assert.ok("workerPlane" in view);
    assert.ok("managementPlane" in view);
    assert.ok("updateEligible" in view);
    // Offline-after-1ms → stale, so workerPlane should be "unknown"
    assert.equal(view.workerPlane, "unknown");
  }
});

test("broker profiling hooks receive compact persistence samples", () => {
  const samples: BrokerProfilingSample[] = [];
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    profilingListener: (sample) => samples.push(sample),
  });
  registerWorker(broker, "worker-profile");
  samples.length = 0;

  const unsubscribe = broker.subscribeToProfiling((sample) => samples.push(sample));
  broker.createTask({
    id: "task-profile-hook",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-profile", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-profile",
    message: "profile compact persistence hooks",
  });
  unsubscribe();

  assert.equal(samples.length, 2);
  for (const sample of samples) {
    assert.equal(sample.operation, "persistState");
    assert.ok(sample.durationMs >= 0);
    assert.match(sample.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(sample.saveHints, {
      hotExchanges: 0,
      hotExchangeMessages: 0,
      hotProposals: 0,
      hotArtifacts: 0,
      hotValidations: 0,
      hotTasks: 1,
      hotTombstones: 0,
      hotAuditEvents: 1,
      hotWorkers: 0,
      hotTerminalOutboxEvents: 0,
    });
  }
});

test("SQLite hot task poll queries avoid temp b-tree sorts", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-task-poll-index-"));
  const sqliteFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(sqliteFile);
    store.save({
      ...emptySnapshot(),
      tasks: [
        {
          id: "task-poll-index",
          intent: "chat",
          status: "queued",
          requester: { id: "hub", kind: "node", role: "hub" },
          target: { id: "sogyo", kind: "node", role: "analyst" },
          targetNodeId: "sogyo",
          assignedWorkerId: "sogyo",
          message: "prove poll query plan",
          payload: {},
          createdAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:00.000Z",
        },
      ],
    });
    store.close();

    const db = new DatabaseSync(sqliteFile, { readOnly: true });
    const plans = [
      db.prepare(
        "EXPLAIN QUERY PLAN SELECT payload FROM broker_tasks ORDER BY updated_at DESC, id ASC",
      ).all(),
      db.prepare(
        "EXPLAIN QUERY PLAN SELECT payload FROM broker_tasks WHERE status = 'queued' ORDER BY updated_at DESC, id ASC",
      ).all(),
      db.prepare(
        "EXPLAIN QUERY PLAN SELECT payload FROM broker_tasks WHERE status = 'queued' AND assigned_worker_id = 'sogyo' ORDER BY updated_at DESC, id ASC",
      ).all(),
    ];
    db.close();

    for (const plan of plans) {
      assert.equal(
        plan.some((row) => String((row as { detail?: unknown }).detail ?? "").includes("USE TEMP B-TREE")),
        false,
        JSON.stringify(plan),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker throttles unchanged worker heartbeat persistence while keeping in-memory liveness fresh", () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (_snapshot, hints) => {
      saveHints.push(hints);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  registerWorker(broker, "worker-heartbeat-throttle");

  broker.heartbeatWorker("worker-heartbeat-throttle");
  const savesAfterFirstHeartbeat = saveHints.length;
  const secondHeartbeat = broker.heartbeatWorker("worker-heartbeat-throttle");

  assert.equal(saveHints.length, savesAfterFirstHeartbeat, "unchanged immediate heartbeat should not rewrite broker state");
  assert.equal(broker.getWorker("worker-heartbeat-throttle")?.lastSeenAt, secondHeartbeat.lastSeenAt);
});

test("broker seeds worker heartbeat persistence throttle from loaded worker lastSeenAt", () => {
  const now = new Date().toISOString();
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    workers: [
      {
        nodeId: "worker-heartbeat-restart",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      },
    ],
  };
  const store: BrokerStateStore = {
    load: () => snapshot,
    save: (_snapshot, hints) => {
      saveHints.push(hints);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load());

  const heartbeat = broker.heartbeatWorker("worker-heartbeat-restart");

  assert.equal(saveHints.length, 0, "recent loaded workers should not rewrite state on first unchanged heartbeat after restart");
  assert.equal(broker.getWorker("worker-heartbeat-restart")?.lastSeenAt, heartbeat.lastSeenAt);
});

test("broker keeps unchanged worker heartbeat hot writes off the request path", async () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (_snapshot, hints) => {
      saveHints.push(hints);
    },
  };
  const persistedWorkers = new Map<string, WorkerRecord>();
  const workerWrites: WorkerRecord[] = [];
  let workerReads = 0;
  const workerRepository: WorkerRuntimeRepository = {
    getWorker: (nodeId) => {
      workerReads += 1;
      return persistedWorkers.get(nodeId) ?? null;
    },
    listWorkers: () => [...persistedWorkers.values()],
    upsertWorker: (worker) => {
      workerWrites.push(worker);
      persistedWorkers.set(worker.nodeId, worker);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load(), { workerRepository });
  registerWorker(broker, "worker-heartbeat-hot-path");

  workerReads = 0;
  const heartbeat = broker.heartbeatWorker("worker-heartbeat-hot-path");
  assert.equal(workerReads, 0, "cached heartbeat should not synchronously read worker hot table");
  const writesAfterFirstHeartbeat = workerWrites.length;
  const savesAfterFirstHeartbeat = saveHints.length;
  await new Promise((resolve) => setTimeout(resolve, 2));
  workerReads = 0;
  const unchangedHeartbeat = broker.heartbeatWorker("worker-heartbeat-hot-path");

  assert.equal(workerReads, 0, "unchanged cached heartbeat should not synchronously read worker hot table");
  assert.equal(workerWrites.length, writesAfterFirstHeartbeat, "unchanged heartbeat should not synchronously upsert worker hot table");
  assert.equal(saveHints.length, savesAfterFirstHeartbeat, "unchanged heartbeat should not persist state");
  assert.notEqual(unchangedHeartbeat.lastSeenAt, heartbeat.lastSeenAt);
  assert.equal(broker.getWorker("worker-heartbeat-hot-path")?.lastSeenAt, unchangedHeartbeat.lastSeenAt);
  assert.equal(broker.listWorkers()[0]?.lastSeenAt, unchangedHeartbeat.lastSeenAt);
});

test("broker keeps repeated unchanged worker registration off cached hot-table reads", () => {
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: () => {},
  };
  const persistedWorkers = new Map<string, WorkerRecord>();
  const workerWrites: WorkerRecord[] = [];
  let workerReads = 0;
  const workerRepository: WorkerRuntimeRepository = {
    getWorker: (nodeId) => {
      workerReads += 1;
      return persistedWorkers.get(nodeId) ?? null;
    },
    listWorkers: () => [...persistedWorkers.values()],
    upsertWorker: (worker) => {
      workerWrites.push(worker);
      persistedWorkers.set(worker.nodeId, worker);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load(), { workerRepository });
  registerWorker(broker, "worker-register-hot-path");
  const writesAfterRegister = workerWrites.length;

  workerReads = 0;
  registerWorker(broker, "worker-register-hot-path");

  assert.equal(workerReads, 0, "unchanged cached registration should not synchronously read worker hot table");
  assert.equal(workerWrites.length, writesAfterRegister, "unchanged registration should remain heartbeat-like without hot writes");
});

test("broker heartbeat still hydrates workers from hot table when cache is cold", () => {
  const now = new Date().toISOString();
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: () => {},
  };
  const persistedWorkers = new Map<string, WorkerRecord>([
    ["worker-cold-cache", {
      nodeId: "worker-cold-cache",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    }],
  ]);
  let workerReads = 0;
  const workerRepository: WorkerRuntimeRepository = {
    getWorker: (nodeId) => {
      workerReads += 1;
      return persistedWorkers.get(nodeId) ?? null;
    },
    listWorkers: () => [...persistedWorkers.values()],
    upsertWorker: (worker) => {
      persistedWorkers.set(worker.nodeId, worker);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load(), { workerRepository });

  const heartbeat = broker.heartbeatWorker("worker-cold-cache");

  assert.equal(workerReads, 1);
  assert.equal(heartbeat.nodeId, "worker-cold-cache");
  assert.equal(broker.getWorkerCachedFirst("worker-cold-cache")?.lastSeenAt, heartbeat.lastSeenAt);
});

test("broker default keeps unchanged worker heartbeat persistence disabled after the legacy interval", () => {
  const oldTimestamp = new Date(Date.now() - 10 * 60_000).toISOString();
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const persistedWorkers = new Map<string, WorkerRecord>();
  const workerWrites: WorkerRecord[] = [];
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    workers: [
      {
        nodeId: "worker-heartbeat-default-disabled",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp,
        lastSeenAt: oldTimestamp,
      },
    ],
  };
  const store: BrokerStateStore = {
    load: () => snapshot,
    save: (_snapshot, hints) => {
      saveHints.push(hints);
    },
  };
  const workerRepository: WorkerRuntimeRepository = {
    getWorker: (nodeId) => persistedWorkers.get(nodeId) ?? null,
    listWorkers: () => [...persistedWorkers.values()],
    upsertWorker: (worker) => {
      workerWrites.push(worker);
      persistedWorkers.set(worker.nodeId, worker);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load(), { workerRepository });

  const heartbeat = broker.heartbeatWorker("worker-heartbeat-default-disabled");

  assert.equal(saveHints.length, 0, "default unchanged heartbeat should not persist even after old timestamps");
  assert.equal(workerWrites.length, 0, "default unchanged heartbeat should not upsert the worker hot table");
  assert.equal(broker.getWorker("worker-heartbeat-default-disabled")?.lastSeenAt, heartbeat.lastSeenAt);
});

test("broker heartbeatWorker with empty request body updates liveness without material-change persistence", async () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (_snapshot, hints) => {
      saveHints.push(hints);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  registerWorker(broker, "worker-empty-heartbeat");
  const savesAfterRegister = saveHints.length;

  broker.heartbeatWorker("worker-empty-heartbeat", {});
  assert.equal(saveHints.length, savesAfterRegister);
  await new Promise((resolve) => setTimeout(resolve, 2));

  const heartbeat = broker.heartbeatWorker("worker-empty-heartbeat", {});
  assert.equal(saveHints.length, savesAfterRegister);

  const worker = broker.getWorker("worker-empty-heartbeat");
  assert.ok(worker);
  assert.equal(worker.capabilities.canAnalyze, true);
  assert.equal(worker.lastSeenAt, heartbeat.lastSeenAt);
});

test("broker can explicitly keep periodic unchanged worker heartbeat persistence", () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const persistedWorkers = new Map<string, WorkerRecord>();
  const workerWrites: WorkerRecord[] = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (_snapshot, hints) => {
      saveHints.push(hints);
    },
  };
  const workerRepository: WorkerRuntimeRepository = {
    getWorker: (nodeId) => persistedWorkers.get(nodeId) ?? null,
    listWorkers: () => [...persistedWorkers.values()],
    upsertWorker: (worker) => {
      workerWrites.push(worker);
      persistedWorkers.set(worker.nodeId, worker);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load(), {
    workerHeartbeatPersistIntervalMs: 0,
    workerRepository,
  });
  registerWorker(broker, "worker-heartbeat-explicit-persist");
  const writesAfterRegister = workerWrites.length;
  const savesAfterRegister = saveHints.length;

  broker.heartbeatWorker("worker-heartbeat-explicit-persist");

  assert.equal(workerWrites.length, writesAfterRegister + 1);
  assert.equal(saveHints.length, savesAfterRegister + 1);
});

test("broker still persists material worker heartbeat changes by default", () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const persistedWorkers = new Map<string, WorkerRecord>();
  const workerWrites: WorkerRecord[] = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (_snapshot, hints) => {
      saveHints.push(hints);
    },
  };
  const workerRepository: WorkerRuntimeRepository = {
    getWorker: (nodeId) => persistedWorkers.get(nodeId) ?? null,
    listWorkers: () => [...persistedWorkers.values()],
    upsertWorker: (worker) => {
      workerWrites.push(worker);
      persistedWorkers.set(worker.nodeId, worker);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load(), { workerRepository });
  registerWorker(broker, "worker-heartbeat-material");
  const writesAfterRegister = workerWrites.length;
  const savesAfterRegister = saveHints.length;

  broker.heartbeatWorker("worker-heartbeat-material", { metadata: { phase: "changed" } });

  assert.equal(workerWrites.length, writesAfterRegister + 1);
  assert.equal(saveHints.length, savesAfterRegister + 1);
  assert.deepEqual(broker.getWorker("worker-heartbeat-material")?.metadata, { phase: "changed" });
});

test("broker treats heartbeat timestamp metadata as non-material liveness churn", () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const persistedWorkers = new Map<string, WorkerRecord>();
  const workerWrites: WorkerRecord[] = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (_snapshot, hints) => {
      saveHints.push(hints);
    },
  };
  const workerRepository: WorkerRuntimeRepository = {
    getWorker: (nodeId) => persistedWorkers.get(nodeId) ?? null,
    listWorkers: () => [...persistedWorkers.values()],
    upsertWorker: (worker) => {
      workerWrites.push(worker);
      persistedWorkers.set(worker.nodeId, worker);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load(), { workerRepository });

  broker.registerWorker({
    nodeId: "worker-hermes-heartbeat",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["mobile"],
      environments: ["research"],
    },
    workerMode: "mobile",
    metadata: {
      runtime: "hermes-agent",
      transport: "http-poll",
      heartbeat: "ok",
      heartbeatAtEpochMs: "1000",
    },
  });
  const writesAfterRegister = workerWrites.length;
  const savesAfterRegister = saveHints.length;

  broker.heartbeatWorker("worker-hermes-heartbeat", {
    metadata: {
      runtime: "hermes-agent",
      transport: "http-poll",
      heartbeat: "ok",
      heartbeatAtEpochMs: "2000",
    },
  });

  assert.equal(workerWrites.length, writesAfterRegister, "ephemeral heartbeat timestamp should not upsert worker hot table");
  assert.equal(saveHints.length, savesAfterRegister, "ephemeral heartbeat timestamp should not persist state");
  assert.equal(broker.getWorker("worker-hermes-heartbeat")?.metadata?.heartbeatAtEpochMs, "2000");
});

test("broker treats repeated registration heartbeat timestamp metadata as non-material", () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (_snapshot, hints) => {
      saveHints.push(hints);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  const request = {
    nodeId: "worker-hermes-register",
    role: "analyst" as const,
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["mobile"],
      environments: ["research" as const],
    },
    workerMode: "mobile" as const,
    metadata: {
      runtime: "hermes-agent",
      transport: "http-poll",
      heartbeat: "ok",
      heartbeatAtEpochMs: "1000",
    },
  };

  broker.registerWorker(request);
  const savesAfterRegister = saveHints.length;

  broker.registerWorker({
    ...request,
    metadata: {
      ...request.metadata,
      heartbeatAtEpochMs: "2000",
    },
  });

  assert.equal(saveHints.length, savesAfterRegister, "repeated registration timestamp churn should behave like heartbeat");
  assert.equal(broker.getWorker("worker-hermes-register")?.metadata?.heartbeatAtEpochMs, "2000");
});

test("broker passes dirty task, audit, and worker hints to state store saves", () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (_snapshot, hints) => {
      saveHints.push(hints);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  registerWorker(broker, "worker-a");
  const registerHints = saveHints.at(-1);
  assert.deepEqual(registerHints?.hotWorkers?.map((item) => item.nodeId), ["worker-a"]);
  assert.deepEqual(registerHints?.hotAuditEvents?.map((item) => item.action), ["worker.registered"]);

  broker.heartbeatWorker("worker-a", { metadata: { check: "alive" } });
  const heartbeatHints = saveHints.at(-1);
  assert.deepEqual(heartbeatHints?.hotWorkers?.map((item) => [item.nodeId, item.metadata]), [["worker-a", { check: "alive" }]]);
  assert.deepEqual(heartbeatHints?.hotAuditEvents?.map((item) => item.action), ["worker.heartbeat"]);

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "prove exchange hot write hints",
    intent: "chat",
  });
  const exchangeHints = saveHints.at(-1);
  assert.deepEqual(exchangeHints?.hotExchanges?.map((item) => item.id), [exchange.id]);
  assert.deepEqual(exchangeHints?.hotExchangeMessages?.map((item) => [item.exchangeId, item.kind]), [[exchange.id, "root"]]);

  const saveCountBeforeMessage = saveHints.length;
  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "thread message",
  });
  const messageSaveHints = saveHints.slice(saveCountBeforeMessage);
  assert.ok(messageSaveHints.some((hints) => hints?.hotExchanges?.some((item) => item.id === exchange.id && item.messageCount === 2)));
  assert.ok(messageSaveHints.some((hints) => hints?.hotExchangeMessages?.some((item) => item.exchangeId === exchange.id && item.kind === "thread")));
  assert.ok(messageSaveHints.some((hints) => hints?.hotAuditEvents?.some((item) => item.action === "exchange.message.added")));

  const proposal = broker.createProposal({
    source: { id: "worker-a", kind: "node", role: "analyst" },
    target: { id: "operator-a", kind: "service", role: "operator" },
    kind: "patch",
    summary: "prove proposal hot write hints",
    workspace: { nodeId: "worker-a", workspaceId: "test" },
    patchText: "diff --git a/file b/file",
  });
  const proposalHints = saveHints.at(-1);
  assert.deepEqual(proposalHints?.hotProposals?.map((item) => [item.id, item.status]), [[proposal.id, "submitted"]]);
  assert.deepEqual(proposalHints?.hotAuditEvents?.map((item) => item.action), ["proposal.created"]);

  const artifact = broker.attachArtifact(proposal.id, {
    kind: "report",
    uri: "memory://proposal-artifact",
    summary: "proposal artifact",
  });
  const artifactHints = saveHints.at(-1);
  assert.deepEqual(artifactHints?.hotArtifacts?.map((item) => item.id), [artifact.id]);
  assert.deepEqual(artifactHints?.hotProposals?.map((item) => item.artifactIds), [[artifact.id]]);
  assert.deepEqual(artifactHints?.hotAuditEvents?.map((item) => item.action), ["artifact.attached"]);

  const validation = broker.submitValidationResult(proposal.id, {
    nodeId: "operator-a",
    kind: "smoke",
    verdict: "pass",
    artifactIds: [artifact.id],
  });
  const validationHints = saveHints.at(-1);
  assert.deepEqual(validationHints?.hotValidations?.map((item) => item.id), [validation.id]);
  assert.deepEqual(validationHints?.hotProposals?.map((item) => item.status), ["validated"]);
  assert.deepEqual(validationHints?.hotAuditEvents?.map((item) => item.action), ["validation.submitted"]);

  const task = broker.createTask({
    id: "task-hot-hints",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "prove hot write hints",
  });

  const createHints = saveHints.at(-1);
  assert.deepEqual(createHints?.hotTasks?.map((item) => item.id), [task.id]);
  assert.deepEqual(createHints?.hotAuditEvents?.map((item) => item.action), ["task.created"]);

  broker.claimTask(task.id, "worker-a");
  const claimHints = saveHints.at(-1);
  assert.deepEqual(claimHints?.hotTasks?.map((item) => [item.id, item.status]), [[task.id, "claimed"]]);
  assert.deepEqual(claimHints?.hotAuditEvents?.map((item) => item.action), ["task.claimed"]);
});

test("broker hot persistence path avoids full snapshot export for task lifecycle and terminal ACK writes", () => {
  const hotSaves: BrokerStateSaveHints[] = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: () => {
      throw new Error("full snapshot save should not run for hot persistence");
    },
    saveHotEntities: (hints) => {
      hotSaves.push(hints);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  registerWorker(broker, "worker-hot-fast");

  const task = createWorkerTask(broker, "task-hot-fast", "worker-hot-fast");
  broker.claimTask(task.id, "worker-hot-fast");
  broker.startTask(task.id, "worker-hot-fast");
  hotSaves.length = 0;
  (broker as { exportSnapshot: () => BrokerSnapshot }).exportSnapshot = () => {
    throw new Error("exportSnapshot should not run for hot persistence");
  };

  broker.completeTask(task.id, "worker-hot-fast", { summary: "done" });
  const completeHints = hotSaves.at(-1);
  assert.deepEqual(completeHints?.hotTasks?.map((item) => [item.id, item.status]), [[task.id, "succeeded"]]);
  assert.deepEqual(completeHints?.hotAuditEvents?.map((item) => item.action), ["task.succeeded"]);
  assert.equal(completeHints?.hotTerminalOutboxEvents?.[0]?.payload.taskId, task.id);

  const event = broker.getTerminalTaskEventOutbox().subscribe()[0]!;
  broker.recordTerminalTaskOutboxReceiptStatus(event.id, {
    status: "operator_visible",
    updatedAt: "2026-05-17T12:00:00.000Z",
  });
  const receiptHints = hotSaves.at(-1);
  assert.equal(receiptHints?.hotTerminalOutboxEvents?.[0]?.receipt.status, "operator_visible");

  broker.acknowledgeTerminalTaskOutboxEvent(event.id, {
    evidence: "operator_visible",
    acknowledgedAt: "2026-05-17T12:00:01.000Z",
    receiptId: "telegram:message-1",
  });
  const ackHints = hotSaves.at(-1);
  assert.equal(ackHints?.hotTerminalOutboxEvents?.[0]?.ack?.status, "receipt_confirmed");
  assert.equal(ackHints?.hotTerminalOutboxEvents?.[0]?.ack?.evidence, "operator_visible");
});

test("broker task lifecycle mutations can use the SQLite runtime repository without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-task-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      taskRepository: new SqliteTaskRuntimeRepository(sqliteStore),
    });
    registerWorker(broker, "worker-sqlite");

    const completed = broker.createTask({
      id: "task-sqlite-complete",
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-sqlite", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-sqlite",
      message: "complete through runtime repo",
      taskOrigin: "api",
    });
    assert.equal(sqliteStore.readHotTasks({ id: completed.id })[0]?.status, "queued");
    assert.deepEqual(sqliteStore.load().tasks, []);

    broker.claimTask(completed.id, "worker-sqlite");
    assert.equal(sqliteStore.readHotTasks({ id: completed.id })[0]?.status, "claimed");
    assert.equal(sqliteStore.readHotTasks({ id: completed.id })[0]?.claimedBy, "worker-sqlite");
    broker.startTask(completed.id, "worker-sqlite");
    assert.equal(sqliteStore.readHotTasks({ id: completed.id })[0]?.status, "running");
    broker.completeTask(completed.id, "worker-sqlite", { summary: "done" });
    const completedRow = sqliteStore.readHotTasks({ id: completed.id })[0]!;
    assert.equal(completedRow.status, "succeeded");
    assert.equal(completedRow.result?.summary, "done");
    assert.equal(broker.getTask(completed.id)?.status, completedRow.status);
    assert.equal(broker.getTask(completed.id)?.result?.summary, completedRow.result?.summary);

    const failed = broker.createTask({
      id: "task-sqlite-fail",
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-sqlite", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-sqlite",
      message: "fail through runtime repo",
    });
    broker.claimTask(failed.id, "worker-sqlite");
    broker.failTask(failed.id, "worker-sqlite", { code: "boom", message: "failed" });
    assert.equal(sqliteStore.readHotTasks({ id: failed.id })[0]?.status, "failed");
    assert.equal(sqliteStore.readHotTasks({ id: failed.id })[0]?.error?.code, "boom");

    const requeued = broker.createTask({
      id: "task-sqlite-requeue",
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-sqlite", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-sqlite",
      message: "requeue through runtime repo",
    });
    broker.claimTask(requeued.id, "worker-sqlite");
    const requeueResult = broker.requeueStaleTasksDetailed(0, { nowMs: Date.now() + 1_000 });
    assert.deepEqual(requeueResult.requeued.map((task) => task.id), [requeued.id]);
    const requeuedRow = sqliteStore.readHotTasks({ id: requeued.id })[0]!;
    assert.equal(requeuedRow.status, "queued");
    assert.equal(requeuedRow.requeueCount, 1);
    assert.equal(requeuedRow.claimedBy, undefined);

    assert.deepEqual(
      broker.listTasks({ assignedWorkerId: "worker-sqlite" }).map((task) => task.id).sort(),
      [completed.id, failed.id, requeued.id].sort(),
    );
    assert.equal(broker.listTasks({ assignedWorkerId: "worker-sqlite", limit: 2 }).length, 2);
    assert.equal(sqliteStore.readHotTasks({ assignedWorkerId: "worker-sqlite", limit: 1 }).length, 1);
    assert.equal(snapshots.at(-1)?.tasks.find((task) => task.id === requeued.id)?.status, "queued");
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker task lifecycle keeps the JSON/default state path without a runtime repository", () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const snapshots: BrokerSnapshot[] = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot, hints) => {
      snapshots.push(snapshot);
      saveHints.push(hints);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  registerWorker(broker, "worker-json");

  const task = broker.createTask({
    id: "task-json-default",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-json", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-json",
    message: "json default path",
  });
  broker.claimTask(task.id, "worker-json");
  broker.completeTask(task.id, "worker-json", { summary: "json done" });

  assert.equal(broker.getTask(task.id)?.status, "succeeded");
  assert.equal(broker.listTasks({ status: "succeeded" })[0]?.id, task.id);
  assert.equal(snapshots.at(-1)?.tasks.find((item) => item.id === task.id)?.status, "succeeded");
  assert.deepEqual(saveHints.at(-1)?.hotTasks?.map((item) => [item.id, item.status]), [[task.id, "succeeded"]]);
});

test("broker proposal lifecycle can use the SQLite runtime repository without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-proposal-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      proposalRepository: new SqliteProposalRuntimeRepository(sqliteStore),
    });

    const created = broker.createProposal({
      source: { id: "research-a", kind: "node", role: "researcher" },
      target: { id: "live-a", kind: "node", role: "live-trader" },
      kind: "patch",
      summary: "create through runtime repo",
      workspace: { nodeId: "live-a", workspaceId: "repo" },
      patchText: "diff --git a/file b/file",
    });
    assert.equal(sqliteStore.readHotProposals({ id: created.id })[0]?.status, "submitted");
    assert.deepEqual(sqliteStore.load().proposals, []);

    broker.submitValidationResult(created.id, {
      nodeId: "live-a",
      kind: "smoke",
      verdict: "pass",
    });
    assert.equal(sqliteStore.readHotProposals({ id: created.id })[0]?.status, "validated");
    broker.approveProposal(created.id, { actor: { id: "live-a", kind: "node", role: "live-trader" } });
    assert.equal(sqliteStore.readHotProposals({ id: created.id })[0]?.status, "approved");
    broker.applyProposalLocally(created.id, {
      actor: { id: "live-a", kind: "node", role: "live-trader" },
      workspace: { nodeId: "live-a", workspaceId: "repo" },
    });
    assert.equal(sqliteStore.readHotProposals({ id: created.id })[0]?.status, "applied");

    const externalProposal: ChangeProposal = {
      id: "proposal-external-hot",
      source: { id: "operator-a", kind: "service", role: "operator" },
      target: { id: "worker-hot", kind: "node", role: "analyst" },
      sourceNodeId: "operator-a",
      targetNodeId: "worker-hot",
      kind: "params",
      summary: "external proposal from runtime repo",
      workspace: { nodeId: "worker-hot", workspaceId: "repo" },
      parameterPayload: { threshold: 2 },
      artifactIds: [],
      status: "submitted",
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    sqliteStore.upsertHotProposals([externalProposal]);

    assert.equal(broker.getProposal("proposal-external-hot")?.kind, "params");
    assert.deepEqual(
      broker.listProposals({ status: "submitted", targetNodeId: "worker-hot", kind: "params" }).map((proposal) => proposal.id),
      ["proposal-external-hot"],
    );
    const approved = broker.approveProposal("proposal-external-hot", {
      actor: { id: "worker-hot", kind: "node", role: "analyst" },
    });
    assert.equal(approved.status, "approved");
    assert.equal(sqliteStore.readHotProposals({ id: "proposal-external-hot" })[0]?.status, "approved");
    assert.equal(snapshots.at(-1)?.proposals.find((proposal) => proposal.id === created.id)?.status, "applied");
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker proposal artifacts can use the SQLite runtime repository without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-artifact-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      proposalRepository: new SqliteProposalRuntimeRepository(sqliteStore),
      artifactRepository: new SqliteArtifactRuntimeRepository(sqliteStore),
    });

    const proposal = broker.createProposal({
      source: { id: "research-a", kind: "node", role: "researcher" },
      target: { id: "live-a", kind: "node", role: "live-trader" },
      kind: "patch",
      summary: "artifact through runtime repo",
      workspace: { nodeId: "live-a", workspaceId: "repo" },
      patchText: "diff --git a/file b/file",
    });

    const attached = broker.attachArtifact(proposal.id, {
      kind: "report",
      uri: "memory://artifact-runtime-attached",
      summary: "attached through runtime repo",
    });

    assert.equal(sqliteStore.readHotArtifacts({ id: attached.id })[0]?.summary, "attached through runtime repo");
    assert.equal(broker.getArtifact(attached.id)?.summary, "attached through runtime repo");
    assert.deepEqual(sqliteStore.load().artifacts, []);
    assert.deepEqual(
      broker.getProposalDetails(proposal.id)?.artifacts.map((artifact) => artifact.id),
      [attached.id],
    );

    const externalArtifact: ArtifactRecord = {
      id: "artifact-external-hot",
      proposalId: proposal.id,
      kind: "report",
      uri: "memory://artifact-external-hot",
      summary: "external artifact from runtime repo",
      createdAt: "2026-04-27T00:00:00.000Z",
    };
    sqliteStore.upsertHotArtifacts([externalArtifact]);

    assert.deepEqual(
      broker.listArtifactsForProposal(proposal.id).map((artifact) => artifact.id),
      [attached.id, "artifact-external-hot"],
    );
    assert.equal(snapshots.at(-1)?.artifacts.find((artifact) => artifact.id === attached.id)?.summary, "attached through runtime repo");
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker proposal validations can use the SQLite runtime repository without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-validation-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      proposalRepository: new SqliteProposalRuntimeRepository(sqliteStore),
      validationRepository: new SqliteValidationRuntimeRepository(sqliteStore),
    });

    const proposal = broker.createProposal({
      source: { id: "research-a", kind: "node", role: "researcher" },
      target: { id: "live-a", kind: "node", role: "live-trader" },
      kind: "patch",
      summary: "validation through runtime repo",
      workspace: { nodeId: "live-a", workspaceId: "repo" },
      patchText: "diff --git a/file b/file",
    });

    const submitted = broker.submitValidationResult(proposal.id, {
      nodeId: "live-a",
      kind: "smoke",
      verdict: "pass",
      metrics: { checked: true },
      note: "submitted through runtime repo",
    });

    assert.equal(sqliteStore.readHotValidations({ id: submitted.id })[0]?.note, "submitted through runtime repo");
    assert.deepEqual(sqliteStore.load().validations, []);
    assert.deepEqual(
      broker.getProposalDetails(proposal.id)?.validations.map((validation) => validation.id),
      [submitted.id],
    );

    const externalValidation: ValidationResult = {
      id: "validation-external-hot",
      proposalId: proposal.id,
      nodeId: "live-a",
      kind: "paper",
      verdict: "pass",
      metrics: { confidence: "high" },
      artifactIds: [],
      note: "external validation from runtime repo",
      createdAt: "2026-04-27T00:00:00.000Z",
    };
    sqliteStore.upsertHotValidations([externalValidation]);

    assert.deepEqual(
      broker.listValidationsForProposal(proposal.id).map((validation) => validation.id),
      [submitted.id, "validation-external-hot"],
    );
    assert.equal(snapshots.at(-1)?.validations.find((validation) => validation.id === submitted.id)?.note, "submitted through runtime repo");
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker worker mutations can use the SQLite runtime repository without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-worker-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      workerRepository: new SqliteWorkerRuntimeRepository(sqliteStore),
    });

    broker.registerWorker({
      nodeId: "worker-sqlite",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["repo-seam"],
        environments: ["research"],
      },
    });

    assert.equal(sqliteStore.readHotWorkers({ nodeId: "worker-sqlite" })[0]?.nodeId, "worker-sqlite");

    const heartbeat = broker.heartbeatWorker("worker-sqlite", { metadata: { check: "alive" } });
    const row = sqliteStore.readHotWorkers({ nodeId: "worker-sqlite" })[0]!;

    assert.equal(row.lastSeenAt, heartbeat.lastSeenAt);
    assert.deepEqual(row.metadata, { check: "alive" });
    assert.deepEqual(broker.getWorker("worker-sqlite"), row);
    assert.deepEqual(
      broker.listWorkers({ role: "analyst", environment: "research", workspaceId: "repo-seam" }).map((worker) => worker.nodeId),
      ["worker-sqlite"],
    );
    assert.equal(snapshots.at(-1)?.workers[0]?.nodeId, row.nodeId);
    assert.equal(snapshots.at(-1)?.workers[0]?.lastSeenAt, row.lastSeenAt);
    assert.deepEqual(snapshots.at(-1)?.workers[0]?.metadata, row.metadata);
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker normalizes minimal legacy and full worker capabilities before SQLite hot persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-worker-capabilities-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: () => undefined,
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      workerRepository: new SqliteWorkerRuntimeRepository(sqliteStore),
    });

    broker.registerWorker({
      nodeId: "worker-minimal-capabilities",
      role: "analyst",
      capabilities: { canAnalyze: "yes" } as any,
    });
    assert.deepEqual(sqliteStore.readHotWorkers({ nodeId: "worker-minimal-capabilities" })[0]?.capabilities, {
      canAnalyze: false,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: [],
      environments: [],
    });

    broker.registerWorker({
      nodeId: "worker-legacy-array-capabilities",
      role: "analyst",
      capabilities: ["canAnalyze", "canPatchWorkspace"] as any,
    });
    assert.deepEqual(sqliteStore.readHotWorkers({ nodeId: "worker-legacy-array-capabilities" })[0]?.capabilities, {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: [],
      environments: [],
    });

    broker.heartbeatWorker("worker-legacy-array-capabilities", {
      capabilities: {
        canAnalyze: true,
        canBackfill: true,
        canPatchWorkspace: false,
        canPromoteLive: true,
        workspaceIds: ["repo-seam", "repo-seam"],
        environments: ["research", "staging"],
      },
    });
    assert.deepEqual(sqliteStore.readHotWorkers({ nodeId: "worker-legacy-array-capabilities" })[0]?.capabilities, {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: false,
      canPromoteLive: true,
      workspaceIds: ["repo-seam"],
      environments: ["research", "staging"],
    });
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker preserves Hermes native worker capability metadata in hot read model", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-hermes-worker-capabilities-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: () => undefined,
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      workerRepository: new SqliteWorkerRuntimeRepository(sqliteStore),
    });

    broker.registerWorker({
      nodeId: "gongyung",
      role: "analyst",
      displayName: "Gongyung Hermes Worker",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["hermes-no-live"],
        environments: ["research"],
        runtimeFlavor: "termux-hermes",
        gatewayRequired: false,
      },
      workerMode: "mobile",
      metadata: {
        runtime: "hermes-agent",
        transport: "http-poll",
      },
    });

    assert.deepEqual(sqliteStore.readHotWorkers({ nodeId: "gongyung" })[0]?.capabilities, {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["hermes-no-live"],
      environments: ["research"],
      runtimeFlavor: "termux-hermes",
      gatewayRequired: false,
    });

    broker.heartbeatWorker("gongyung", {
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["hermes-no-live", "hermes-no-live"],
        environments: ["research"],
        runtimeFlavor: "custom-hermes-flavor" as any,
        gatewayRequired: "false" as any,
      },
    });

    assert.deepEqual(sqliteStore.readHotWorkers({ nodeId: "gongyung" })[0]?.capabilities, {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["hermes-no-live"],
      environments: ["research"],
      runtimeFlavor: "unknown",
      gatewayRequired: false,
    });
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker audit and tombstone diagnostics can use SQLite runtime repositories", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-audit-tombstone-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      auditRepository: new SqliteAuditRuntimeRepository(sqliteStore),
      tombstoneRepository: new SqliteTombstoneRuntimeRepository(sqliteStore),
    });
    registerWorker(broker, "worker-sqlite");

    const task = broker.createTask({
      id: "task-sqlite-audit-tombstone",
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-sqlite", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-sqlite",
      message: "fail through audit/tombstone repo",
    });
    broker.claimTask(task.id, "worker-sqlite");
    broker.failTask(task.id, "worker-sqlite", { code: "boom", message: "failed through repo" });

    assert.deepEqual(
      sqliteStore.readHotAuditEvents({ targetId: task.id, action: "task.failed" }).map((event) => event.note),
      ["failed through repo"],
    );
    assert.equal(sqliteStore.readHotTombstones({ taskId: task.id })[0]?.error?.code, "boom");
    assert.deepEqual(sqliteStore.load().auditEvents, []);
    assert.deepEqual(sqliteStore.load().tombstones, []);
    assert.equal(snapshots.at(-1)?.tasks.find((item) => item.id === task.id)?.status, "failed");

    const externalAudit: AuditEvent = {
      id: "audit-external-hot",
      actorId: "operator-hot",
      action: "task.requeued",
      targetType: "task",
      targetId: "task-external-hot",
      createdAt: "2026-04-27T00:00:00.000Z",
    };
    const externalTombstone: TaskTombstone = {
      taskId: "task-external-hot",
      terminalStatus: "failed",
      tombstoneReason: "dead_lettered",
      durationMs: 10,
      requeueCount: 2,
      error: { code: "exceeded_requeue_limit", message: "hot tombstone" },
      tombstonedAt: "2026-04-27T00:00:01.000Z",
    };
    sqliteStore.upsertHotAuditEvents([externalAudit]);
    sqliteStore.upsertHotTombstones([externalTombstone]);

    assert.deepEqual(
      broker.listAuditEvents({ targetId: "task-external-hot", action: "task.requeued" }).map((event) => event.id),
      ["audit-external-hot"],
    );
    assert.equal(broker.getTombstone("task-external-hot")?.tombstoneReason, "dead_lettered");
    assert.deepEqual(
      broker.listTombstones({ tombstoneReason: "dead_lettered" }).map((tombstone) => tombstone.taskId),
      ["task-external-hot"],
    );
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

