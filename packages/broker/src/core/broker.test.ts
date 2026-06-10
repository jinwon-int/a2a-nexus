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

function createWorkerTask(broker: InMemoryA2ABroker, id: string, workerId: string) {
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

function createGithubPatchTask(broker: InMemoryA2ABroker, id: string, workerId: string) {
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

function createOwnedTask(broker: InMemoryA2ABroker, id: string, workerId: string, overrides: Partial<CreateTaskRequest> = {}) {
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

test("broker exchange threads can use SQLite runtime repositories without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-exchange-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      exchangeRepository: new SqliteExchangeRuntimeRepository(sqliteStore),
      exchangeMessageRepository: new SqliteExchangeMessageRuntimeRepository(sqliteStore),
    });
    registerWorker(broker, "worker-sqlite");

    const exchange = broker.startExchange({
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-sqlite", kind: "node", role: "analyst" },
      message: "exchange through runtime repo",
      intent: "chat",
    });

    assert.equal(sqliteStore.readHotExchanges({ id: exchange.id })[0]?.id, exchange.id);
    assert.equal(sqliteStore.readHotExchangeMessages({ exchangeId: exchange.id })[0]?.id, exchange.rootMessageId);
    assert.deepEqual(sqliteStore.load().exchanges, []);
    assert.deepEqual(sqliteStore.load().exchangeMessages, []);

    const message = broker.addExchangeMessage(exchange.id, {
      actor: { id: "hub-a", kind: "node", role: "hub" },
      message: "need more context",
      parentMessageId: exchange.rootMessageId,
    });

    const row = sqliteStore.readHotExchanges({ id: exchange.id })[0]!;
    assert.equal(row.messageCount, 2);
    assert.equal(row.latestMessageId, message.id);
    assert.equal(broker.getExchange(exchange.id)?.latestMessageId, message.id);
    assert.deepEqual(
      broker.listExchanges().map((item) => item.id),
      [exchange.id],
    );
    assert.deepEqual(
      broker.listExchangeMessages(exchange.id).map((item) => item.id),
      [exchange.rootMessageId, message.id],
    );
    assert.deepEqual(
      broker.listExchangeMessages(exchange.id, { parentMessageId: exchange.rootMessageId }).map((item) => item.id),
      [message.id],
    );
    assert.equal(snapshots.at(-1)?.exchanges.find((item) => item.id === exchange.id)?.latestMessageId, message.id);
    assert.equal(snapshots.at(-1)?.exchangeMessages.find((item) => item.id === message.id)?.message, "need more context");
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker exchange threads keep the JSON/default state path without runtime repositories", () => {
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

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-json", kind: "node", role: "analyst" },
    message: "json exchange path",
    intent: "chat",
  });
  const message = broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "json thread reply",
  });

  assert.equal(broker.getExchange(exchange.id)?.latestMessageId, message.id);
  assert.deepEqual(broker.listExchangeMessages(exchange.id).map((item) => item.id), [exchange.rootMessageId, message.id]);
  assert.equal(snapshots.at(-1)?.exchanges.find((item) => item.id === exchange.id)?.latestMessageId, message.id);
  assert.ok(saveHints.some((hints) => hints?.hotExchanges?.some((item) => item.id === exchange.id)));
  assert.ok(saveHints.some((hints) => hints?.hotExchangeMessages?.some((item) => item.id === message.id)));
});

test("accepted exchange thread creates and links an exchange task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  const threadMessage = broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted for worker-a",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "running");
  assert.equal(refreshedExchange.currentDecision, "accepted");
  assert.equal(refreshedExchange.assignedWorkerId, "worker-a");
  assert.equal(refreshedExchange.latestMessageId, threadMessage.id);
  assert.ok(refreshedExchange.activeTaskId);

  const linkedTask = broker.getTask(refreshedExchange.activeTaskId);
  assert.ok(linkedTask);
  assert.equal(linkedTask.exchangeId, exchange.id);
  assert.equal(linkedTask.assignedWorkerId, "worker-a");
  assert.equal(linkedTask.status, "queued");
});

test("live-impact task creation by a non-operator is blocked until approval", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "apply_local_change",
    requester: { id: "analyst-a", kind: "node", role: "analyst" },
    target: { id: "worker-a", kind: "node", role: "live-trader" },
    workspace: { nodeId: "worker-a", workspaceId: "test" },
    message: "apply live patch",
  });

  assert.equal(task.status, "blocked");
  assert.equal(task.policyContext?.requiresApproval, true);
  assert.throws(() => broker.claimTask(task.id, "worker-a"), {
    name: "BrokerError",
    code: "policy_denied",
    message: "task requires operator or hub approval before claim",
  });
});

test("dangerous task creation records explicit human-gate policy context and waits blocked", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "promote_to_live",
    requester: { id: "operator-a", kind: "node", role: "operator" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "promote after review",
  });

  assert.deepEqual(task.policyContext, {
    requiresApproval: true,
    liveImpact: true,
    targetEnvironment: "live",
  });
  assert.equal(task.status, "blocked");
});

test("operator approval resumes blocked approval-gated task and records audit metadata", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "promote_to_live",
    requester: { id: "analyst-a", kind: "node", role: "analyst" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "promote after review",
  });

  assert.throws(
    () => broker.approveTask(task.id, {
      actor: { id: "researcher-a", kind: "node", role: "researcher" },
      reason: "not authorized",
    }),
    {
      name: "BrokerError",
      code: "policy_denied",
      message: "task approval requires a hub or operator actor",
    },
  );

  const approved = broker.approveTask(task.id, {
    actor: { id: "operator-a", kind: "node", role: "operator" },
    approvalId: "approval-123",
    reason: "change ticket CHG-123 reviewed",
  });

  assert.equal(approved.status, "queued");
  assert.deepEqual(approved.approval, {
    approvalId: "approval-123",
    approvedAt: approved.approval?.approvedAt,
    approvedBy: "operator-a",
    actorRole: "operator",
    requesterRole: "analyst",
    reason: "change ticket CHG-123 reviewed",
  });
  assert.ok(approved.approval?.approvedAt);
  const audit = broker.listAuditEvents({ targetId: task.id, action: "task.approved" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorId, "operator-a");
  assert.equal(audit[0].note, "change ticket CHG-123 reviewed");

  const claimed = broker.claimTask(task.id, "worker-a");
  assert.equal(claimed.status, "claimed");
});

test("repeat approval is idempotent and preserves first approval record", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "rollback_live",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "rollback",
  });
  const first = broker.approveTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    approvalId: "approval-first",
    reason: "first reason",
  });
  const auditCount = broker.listAuditEvents({ targetId: task.id, action: "task.approved" }).length;
  const second = broker.approveTask(task.id, {
    actor: { id: "operator-b", kind: "node", role: "operator" },
    approvalId: "approval-second",
    reason: "second reason",
  });

  assert.deepEqual(second.approval, first.approval);
  assert.equal(second.approval?.approvalId, "approval-first");
  assert.equal(second.approvalOutcome?.status, "approved");
  assert.equal(second.approvalOutcome?.approvalId, "approval-first");
  assert.equal(broker.listAuditEvents({ targetId: task.id, action: "task.approved" }).length, auditCount);
});

test("operator rejection records terminal approval outcome and leaves task unclaimable", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "promote_to_live",
    requester: { id: "analyst-a", kind: "node", role: "analyst" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "promote after review",
  });
  const updates: TaskUpdate[] = [];
  broker.subscribeToTask(task.id, (update) => updates.push(update));

  const rejected = broker.rejectTaskApproval(task.id, {
    actor: { id: "operator-a", kind: "node", role: "operator" },
    approvalId: "chg-rejected-1",
    status: "rejected",
    reason: "change ticket rejected",
  });
  const repeated = broker.rejectTaskApproval(task.id, {
    actor: { id: "operator-b", kind: "node", role: "operator" },
    approvalId: "chg-rejected-2",
    status: "expired",
    reason: "late duplicate",
  });

  assert.equal(rejected.status, "canceled");
  assert.deepEqual(repeated.approvalOutcome, rejected.approvalOutcome);
  assert.deepEqual(rejected.approvalOutcome, {
    status: "rejected",
    approvalId: "chg-rejected-1",
    decidedAt: rejected.approvalOutcome?.decidedAt,
    decidedBy: "operator-a",
    actorRole: "operator",
    requesterRole: "analyst",
    reason: "change ticket rejected",
  });
  assert.ok(rejected.approvalOutcome?.decidedAt);
  assert.equal(rejected.cancellation?.reason, "change ticket rejected");
  assert.equal(broker.listAuditEvents({ targetId: task.id, action: "task.approval_rejected" }).length, 1);
  assert.deepEqual(
    updates.map((update) => [update.reason, update.final, update.task.approvalOutcome?.status]),
    [["canceled", true, "rejected"]],
  );
  assert.throws(() => broker.claimTask(task.id, "worker-a"), {
    name: "BrokerError",
    code: "policy_denied",
  });
});

test("needs_clarification cancels active exchange task and returns exchange to queued", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "worker-a", kind: "node", role: "analyst" },
    message: "need more detail",
    decision: "needs_clarification",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "queued");
  assert.equal(refreshedExchange.currentDecision, "needs_clarification");
  assert.ok(refreshedExchange.activeTaskId);

  const linkedTask = broker.getTask(refreshedExchange.activeTaskId);
  assert.ok(linkedTask);
  assert.equal(linkedTask.status, "canceled");
});

test("partially_accepted keeps exchange running with an active task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "partial accept",
    decision: "partially_accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "running");
  assert.equal(refreshedExchange.currentDecision, "partially_accepted");
  assert.ok(refreshedExchange.activeTaskId);
});

test("declined marks exchange failed and cancels any active task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "declined",
    decision: "declined",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "failed");
  assert.equal(refreshedExchange.currentDecision, "declined");
  assert.ok(refreshedExchange.activeTaskId);

  const linkedTask = broker.getTask(refreshedExchange.activeTaskId);
  assert.ok(linkedTask);
  assert.equal(linkedTask.status, "canceled");
});

test("canceling a parent task fans out to child tasks recursively", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");
  registerWorker(broker, "worker-c");

  const parent = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "parent",
  });
  const child = broker.createTask({
    parentTaskId: parent.id,
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-b", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-b",
    message: "child",
  });
  const grandchild = broker.createTask({
    parentTaskId: child.id,
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-c", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-c",
    message: "grandchild",
  });

  broker.claimTask(child.id, "worker-b");

  broker.cancelTask(parent.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "operator stop",
  });

  assert.equal(broker.getTask(parent.id)?.status, "canceled");
  assert.equal(broker.getTask(child.id)?.status, "canceled");
  assert.equal(broker.getTask(grandchild.id)?.status, "canceled");
  assert.equal(broker.getTask(child.id)?.cancellation?.sourceTaskId, parent.id);
  assert.equal(broker.getTask(grandchild.id)?.cancellation?.sourceTaskId, child.id);
  assert.deepEqual(
    broker.listAuditEvents({ action: "task.canceled" }).map((event) => event.targetId).sort(),
    [child.id, grandchild.id, parent.id].sort(),
  );
});

test("repeat cancel is idempotent and preserves the first cancellation record", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const first = broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "first stop",
  });
  const auditCount = broker.listAuditEvents({ targetId: task.id, action: "task.canceled" }).length;

  const second = broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "second stop",
  });

  assert.equal(second.status, "canceled");
  assert.equal(second.completedAt, first.completedAt);
  assert.deepEqual(second.cancellation, first.cancellation);
  assert.equal(second.cancellation?.reason, "first stop");
  assert.equal(broker.listAuditEvents({ targetId: task.id, action: "task.canceled" }).length, auditCount);
});

test("finalizer can durably mark a running sibling task as superseded", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "nosuk");
  registerWorker(broker, "sogyo");

  const selected = createWorkerTask(broker, "round-selected-pr", "nosuk");
  broker.claimTask(selected.id, "nosuk");
  broker.startTask(selected.id, "nosuk");
  broker.completeTask(selected.id, "nosuk", {
    summary: "selected PR merged",
    output: { prUrl: "https://github.com/jinwon-int/a2a-docker-runner/pull/356" },
  });

  const sibling = createWorkerTask(broker, "round-sibling-running", "sogyo");
  broker.claimTask(sibling.id, "sogyo");
  broker.startTask(sibling.id, "sogyo");
  const nextRound = createWorkerTask(broker, "next-round-sogyo-queued", "sogyo");

  const canceled = broker.cancelTask(sibling.id, {
    actor: { id: "seoseo", kind: "node", role: "hub" },
    reason: "finalizer selected and merged PR #356",
    supersededByTaskId: selected.id,
    supersededByPrUrl: "https://github.com/jinwon-int/a2a-docker-runner/pull/356",
    roundId: "a2a-team1-354-runner-nochange-contract-20260606T145219KST",
  });

  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.cancellation?.kind, "superseded");
  assert.equal(canceled.cancellation?.supersededByTaskId, selected.id);
  assert.equal(canceled.cancellation?.supersededByPrUrl, "https://github.com/jinwon-int/a2a-docker-runner/pull/356");
  assert.equal(canceled.cancellation?.roundId, "a2a-team1-354-runner-nochange-contract-20260606T145219KST");
  assert.equal(broker.getTask(nextRound.id)?.status, "queued");

  const tombstone = broker.getTombstone(sibling.id);
  assert.equal(tombstone?.tombstoneReason, "canceled");
  assert.equal(tombstone?.metadata?.cancellationKind, "superseded");
  assert.equal(tombstone?.metadata?.supersededByTaskId, selected.id);

  const diagnostics = broker.getTaskDiagnostics(sibling.id);
  assert.equal(diagnostics.interruption?.kind, "superseded");
  assert.equal(diagnostics.interruption?.actorId, "seoseo");
  assert.equal(diagnostics.brokerHints.supersededByTaskId, selected.id);
  assert.equal(diagnostics.brokerHints.supersededByPrUrl, "https://github.com/jinwon-int/a2a-docker-runner/pull/356");
  assert.equal(diagnostics.brokerHints.supersededRoundId, "a2a-team1-354-runner-nochange-contract-20260606T145219KST");
});

test("superseded cancellation requires a different terminal winner task when supersededByTaskId is supplied", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");

  const running = createWorkerTask(broker, "superseded-running", "worker-a");
  broker.claimTask(running.id, "worker-a");
  const nonTerminalWinner = createWorkerTask(broker, "superseded-winner-not-terminal", "worker-b");

  assert.throws(() => broker.cancelTask(running.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    supersededByTaskId: running.id,
  }), {
    name: "BrokerError",
    message: /supersededByTaskId must refer to a different task/,
  });

  assert.throws(() => broker.cancelTask(running.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    supersededByTaskId: nonTerminalWinner.id,
  }), {
    name: "BrokerError",
    message: /cannot supersede task by non-terminal task/,
  });
});

test("stale requeue keeps assignedWorkerId unchanged", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);
  const task = broker.getTask(taskId);
  assert.ok(task);
  broker.claimTask(task.id, "worker-a");
  const requeued = broker.requeueStaleTasks(0, { nowMs: Date.now() });
  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].assignedWorkerId, "worker-a");
  assert.equal(requeued[0].status, "queued");
});

test("requeueStaleTasks caps requeues and dead-letters the task to failed", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 2 });
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });
  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });
  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);

  // Drive three consecutive claim → stale-requeue cycles. The first two should succeed as
  // requeues; the third must dead-letter because the task has already been requeued twice.
  broker.claimTask(taskId, "worker-a");
  let result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 1);
  assert.equal(result.deadLettered.length, 0);
  assert.equal(result.requeued[0].requeueCount, 1);

  broker.claimTask(taskId, "worker-a");
  result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 1);
  assert.equal(result.deadLettered.length, 0);
  assert.equal(result.requeued[0].requeueCount, 2);

  broker.claimTask(taskId, "worker-a");
  result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 0);
  assert.equal(result.deadLettered.length, 1);

  const deadLettered = result.deadLettered[0];
  assert.equal(deadLettered.status, "failed");
  assert.equal(deadLettered.error?.code, "exceeded_requeue_limit");
  assert.equal(deadLettered.requeueCount, 2);
  assert.ok(deadLettered.completedAt);

  const finalTask = broker.getTask(taskId);
  assert.ok(finalTask);
  assert.equal(finalTask.status, "failed");
  assert.equal(finalTask.error?.code, "exceeded_requeue_limit");

  // Dead-lettering should also close the linked exchange so operator dashboards do not keep
  // it pinned as running forever.
  const finalExchange = broker.getExchange(exchange.id);
  assert.ok(finalExchange);
  assert.equal(finalExchange.status, "failed");
});

test("maxRequeueAttempts=0 disables the cap and allows unlimited requeues", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 0 });
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });
  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });
  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);

  for (let i = 0; i < 10; i++) {
    broker.claimTask(taskId, "worker-a");
    const { requeued, deadLettered } = broker.requeueStaleTasksDetailed(0);
    assert.equal(requeued.length, 1, `iteration ${i} should requeue`);
    assert.equal(deadLettered.length, 0, `iteration ${i} should not dead-letter`);
  }

  const finalTask = broker.getTask(taskId);
  assert.ok(finalTask);
  assert.equal(finalTask.status, "queued");
  assert.equal(finalTask.requeueCount, 10);
});

test("reassignTask resets requeueCount so the new target gets a fresh attempt budget", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 1 });
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });
  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });
  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);

  // Burn the single requeue attempt worker-a gets.
  broker.claimTask(taskId, "worker-a");
  let result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued[0].requeueCount, 1);

  // Operator reassigns to worker-b; the fresh target should not inherit the dead-letter
  // pressure from worker-a's flap.
  const reassigned = broker.reassignTask(taskId, {
    actor: { id: "ops", kind: "node", role: "operator" },
    targetNodeId: "worker-b",
    assignedWorkerId: "worker-b",
  });
  assert.equal(reassigned.requeueCount, 0);

  broker.claimTask(taskId, "worker-b");
  result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 1, "reassigned task should be requeuable again");
  assert.equal(result.deadLettered.length, 0);
  assert.equal(result.requeued[0].requeueCount, 1);
});

// ---------------------------------------------------------------------------
// Terminal immutability: failed/succeeded/canceled tasks reject further mutations
// ---------------------------------------------------------------------------

test("cannot reassign a failed task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");

  const task = createWorkerTask(broker, "task-reassign-failed", "worker-a");
  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.failTask(task.id, "worker-a", { code: "error", message: "boom" });

  assert.throws(
    () => broker.reassignTask(task.id, {
      actor: { id: "ops", kind: "node", role: "operator" },
      targetNodeId: "worker-b",
      assignedWorkerId: "worker-b",
    }),
    { name: "BrokerError", message: /cannot reassign task while status is failed/ },
  );
});

test("cannot reassign a succeeded task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = createWorkerTask(broker, "task-reassign-succeeded", "worker-a");
  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  assert.throws(
    () => broker.reassignTask(task.id, {
      actor: { id: "ops", kind: "node", role: "operator" },
      targetNodeId: "worker-a",
    }),
    { name: "BrokerError", message: /cannot reassign task while status is succeeded/ },
  );
});

test("cannot reassign a canceled task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = createWorkerTask(broker, "task-reassign-canceled", "worker-a");
  broker.cancelTask(task.id, { actor: { id: "hub-a", kind: "node", role: "hub" } });

  assert.throws(
    () => broker.reassignTask(task.id, {
      actor: { id: "ops", kind: "node", role: "operator" },
      targetNodeId: "worker-a",
    }),
    { name: "BrokerError", message: /cannot reassign task while status is canceled/ },
  );
});

test("terminal task idempotency: completeTask returns existing terminal task without mutation", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = createWorkerTask(broker, "task-idempotent-complete", "worker-a");
  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  const completed = broker.completeTask(task.id, "worker-a", { summary: "first" });
  assert.equal(completed.result?.summary, "first");

  // Second completion attempt: returns existing task with original result
  const second = broker.completeTask(task.id, "worker-a", { summary: "second" });
  assert.equal(second.result?.summary, "first");
  assert.equal(second.status, "succeeded");
});

test("terminal task idempotency: failTask returns existing terminal task without mutation", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = createWorkerTask(broker, "task-idempotent-fail", "worker-a");
  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  const failed = broker.failTask(task.id, "worker-a", { code: "ERR", message: "first fail" });
  assert.equal(failed.error?.message, "first fail");

  // Second fail attempt: returns existing task with original error
  const second = broker.failTask(task.id, "worker-a", { code: "ERR2", message: "second fail" });
  assert.equal(second.error?.message, "first fail");
  assert.equal(second.status, "failed");
});

test("terminal task idempotency: cancelTask returns existing canceled task without mutation", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = createWorkerTask(broker, "task-idempotent-cancel", "worker-a");
  const canceled = broker.cancelTask(task.id, { actor: { id: "hub-a", kind: "node", role: "hub" }, reason: "first cancel" });
  assert.equal(canceled.cancellation?.reason, "first cancel");

  // Second cancel: returns existing task with original cancellation
  const second = broker.cancelTask(task.id, { actor: { id: "hub-a", kind: "node", role: "hub" }, reason: "second cancel" });
  assert.equal(second.cancellation?.reason, "first cancel");
  assert.equal(second.status, "canceled");
});

test("completing an accepted exchange task marks the exchange completed", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);

  broker.claimTask(taskId, "worker-a");
  broker.startTask(taskId, "worker-a");
  const completedTask = broker.completeTask(taskId, "worker-a", {
    summary: "analysis complete",
    artifactIds: ["artifact-1"],
  });

  assert.equal(completedTask.status, "succeeded");
  assert.deepEqual(completedTask.artifactIds, ["artifact-1"]);

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "completed");
  assert.equal(refreshedExchange.activeTaskId, taskId);
  assert.equal(refreshedExchange.assignedWorkerId, "worker-a");
  assert.equal(refreshedExchange.currentDecision, "accepted");
});

test("routing update reassigns the active exchange task instead of creating a new one", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const originalTaskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(originalTaskId);

  const rerouteMessage = broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "route this to worker-b",
    targetNodeId: "worker-b",
    assignedWorkerId: "worker-b",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "queued");
  assert.equal(refreshedExchange.latestMessageId, rerouteMessage.id);
  assert.equal(refreshedExchange.activeTaskId, originalTaskId);
  assert.equal(refreshedExchange.targetNodeId, "worker-b");
  assert.equal(refreshedExchange.assignedWorkerId, "worker-b");

  const task = broker.getTask(originalTaskId);
  assert.ok(task);
  assert.equal(task.status, "queued");
  assert.equal(task.targetNodeId, "worker-b");
  assert.equal(task.assignedWorkerId, "worker-b");
  assert.equal(task.claimedBy, undefined);
  assert.equal(broker.listTasks({ exchangeId: exchange.id }).length, 1);
});

test("getDashboard returns aggregated queue, history, proposals, and workers", () => {
  const nowMs = Date.now();
  const broker = new InMemoryA2ABroker();

  // Register workers
  broker.registerWorker({
    nodeId: "w-online",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
    metadata: {},
  });

  broker.registerWorker({
    nodeId: "w-stale",
    role: "researcher",
    capabilities: {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
    metadata: {},
  });

  // Create tasks in various states
  broker.createTask({
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w-online", kind: "node", role: "analyst" },
    assignedWorkerId: "w-online",
    message: "task-queued-1",
  });
  broker.createTask({
    intent: "backfill",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w-online", kind: "node", role: "analyst" },
    assignedWorkerId: "w-online",
    message: "task-queued-2",
  });

  const dashboard = broker.getDashboard({
    nowMs,
    offlineAfterMs: 90_000,
    recentHistoryLimit: 5,
    oldestPendingLimit: 3,
    pendingActionLimit: 5,
  });

  // Queue
  assert.equal(dashboard.queue.total, 2);
  assert.equal(dashboard.queue.byStatus["queued"], 2);
  assert.equal(dashboard.queue.oldestPending.length, 2);

  // History (no completed tasks yet)
  assert.equal(dashboard.history.totalCompleted, 0);
  assert.equal(dashboard.history.totalFailed, 0);
  assert.equal(dashboard.history.recent.length, 0);

  // Proposals (none yet)
  assert.equal(dashboard.proposals.total, 0);

  // Workers (both registerWorker calls use isoNow(), so both have same lastSeenAt → both online)
  assert.equal(dashboard.workers.total, 2);
  assert.equal(dashboard.workers.online, 2);
  assert.equal(dashboard.workers.stale, 0);
  assert.ok(dashboard.workers.byNode.find((w) => w.nodeId === "w-online")!.status === "online");
  assert.ok(dashboard.workers.byNode.find((w) => w.nodeId === "w-stale")!.status === "online");

  // Timestamp
  assert.ok(new Date(dashboard.generatedAt).getTime() > 0);
});

test("getDashboard history tracks completed and failed tasks", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task1 = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "success-task",
  });
  broker.claimTask(task1.id, "w1");
  broker.completeTask(task1.id, "w1", { summary: "done" });

  const task2 = broker.createTask({
    intent: "backfill",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "fail-task",
  });
  broker.claimTask(task2.id, "w1");
  broker.failTask(task2.id, "w1", { code: "timeout", message: "took too long" });

  const dashboard = broker.getDashboard({ nowMs: Date.now() });

  assert.equal(dashboard.history.totalCompleted, 1);
  assert.equal(dashboard.history.totalFailed, 1);
  assert.equal(dashboard.history.recent.length, 2);
  const statuses = new Set(dashboard.history.recent.map((r) => r.status));
  assert.ok(statuses.has("succeeded") && statuses.has("failed"));
  const succeeded = dashboard.history.recent.find((r) => r.status === "succeeded")!;
  const failed = dashboard.history.recent.find((r) => r.status === "failed")!;
  assert.ok(succeeded.result?.summary === "done");
  assert.ok(failed.error?.code === "timeout");
});

test("getDashboard proposals shows pending action items", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "w1",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
  });
  broker.registerWorker({
    nodeId: "w2",
    role: "live-trader",
    capabilities: {
      canAnalyze: false,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: true,
      workspaceIds: ["ws1"],
      environments: ["live"],
    },
  });

  // submitted proposal (needs validation)
  broker.createProposal({
    source: { id: "w1", kind: "node", role: "analyst" },
    target: { id: "w2", kind: "node", role: "live-trader" },
    kind: "patch",
    summary: "fix signal threshold",
    workspace: { nodeId: "w2", workspaceId: "ws1" },
    patchText: "diff --git a/config.ts ...",
  });

  const dashboard = broker.getDashboard({ nowMs: Date.now() });

  assert.equal(dashboard.proposals.total, 1);
  assert.equal(dashboard.proposals.byStatus["submitted"], 1);
  assert.equal(dashboard.proposals.pendingAction.length, 1);
  assert.equal(dashboard.proposals.pendingAction[0].status, "submitted");
});

test("getDashboard workers shows active task counts", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "active-task",
  });
  broker.claimTask(task.id, "w1");

  const dashboard = broker.getDashboard({ nowMs: Date.now() });

  const w1 = dashboard.workers.byNode.find((w) => w.nodeId === "w1")!;
  assert.equal(w1.activeTaskCount, 1);
  assert.equal(w1.role, "analyst");
  assert.ok(typeof w1.lastSeenAgeSec === "number");
});

test("getDashboard exposes broker-owned age fields for pending work and stale workers", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const claimedTask = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "claimed-task",
  });
  const claimed = broker.claimTask(claimedTask.id, "w1");

  const runningTask = broker.createTask({
    intent: "backfill",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "running-task",
  });
  broker.claimTask(runningTask.id, "w1");
  const running = broker.startTask(runningTask.id, "w1");

  const nowMs = Math.max(
    Date.parse(claimed.claimedAt ?? claimed.createdAt),
    Date.parse(running.updatedAt),
    Date.parse(broker.listWorkers()[0]!.lastSeenAt),
  ) + 30_000;

  const dashboard = broker.getDashboard({ nowMs, offlineAfterMs: 10_000 });
  const pendingClaimed = dashboard.queue.oldestPending.find((task) => task.id === claimed.id)!;
  const oldestClaimed = dashboard.observability.queuePressure.oldestClaimed!;
  const oldestRunning = dashboard.observability.queuePressure.oldestRunning!;
  const staleWorker = dashboard.observability.workerHealth.staleWorkersWithActiveTasks[0]!;
  const worker = dashboard.workers.byNode.find((entry) => entry.nodeId === "w1")!;

  assert.equal(pendingClaimed.statusSinceAt, claimed.claimedAt);
  assert.ok(pendingClaimed.statusAgeSec >= 30);
  assert.equal(oldestClaimed.statusSinceAt, claimed.claimedAt);
  assert.ok(oldestClaimed.statusAgeSec >= 30);
  assert.equal(oldestRunning.statusSinceAt, running.updatedAt);
  assert.ok(oldestRunning.statusAgeSec >= 30);
  assert.equal(worker.status, "stale");
  assert.ok(worker.lastSeenAgeSec >= 30);
  assert.equal(staleWorker.nodeId, "w1");
  assert.ok(staleWorker.lastSeenAgeSec >= 30);
});

test("retention prunes stale terminal state but preserves the newest referenced graph", () => {
  const oldIso = "2020-01-01T00:00:00.000Z";
  const newerOldIso = "2020-01-02T00:00:00.000Z";
  const workerCapabilities: WorkerRecord["capabilities"] = {
    canAnalyze: true,
    canBackfill: false,
    canPatchWorkspace: false,
    canPromoteLive: false,
    workspaceIds: ["test"],
    environments: ["research"],
  };
  const hub = { id: "hub-a", kind: "node" as const, role: "hub" as const };
  const retainedWorker = {
    id: "worker-ref",
    kind: "node" as const,
    role: "analyst" as const,
  };
  const prunedWorker = {
    id: "worker-pruned",
    kind: "node" as const,
    role: "analyst" as const,
  };

  const snapshot: BrokerSnapshot = {
    version: CURRENT_BROKER_STATE_VERSION,
    exchanges: [
      {
        id: "exchange-retained",
        requester: hub,
        target: retainedWorker,
        targetNodeId: retainedWorker.id,
        assignedWorkerId: retainedWorker.id,
        message: "keep me",
        maxTurns: 1,
        intent: "analyze",
        status: "completed",
        rootMessageId: "message-retained",
        latestMessageId: "message-retained",
        messageCount: 1,
        lastMessageAt: newerOldIso,
        activeTaskId: "task-retained",
        createdAt: oldIso,
        updatedAt: newerOldIso,
      },
      {
        id: "exchange-pruned",
        requester: hub,
        target: prunedWorker,
        targetNodeId: prunedWorker.id,
        assignedWorkerId: prunedWorker.id,
        message: "prune me",
        maxTurns: 1,
        intent: "analyze",
        status: "completed",
        rootMessageId: "message-pruned",
        latestMessageId: "message-pruned",
        messageCount: 1,
        lastMessageAt: oldIso,
        activeTaskId: "task-pruned",
        createdAt: oldIso,
        updatedAt: oldIso,
      },
    ],
    exchangeMessages: [
      {
        id: "message-retained",
        exchangeId: "exchange-retained",
        kind: "root",
        message: "keep me",
        requester: hub,
        targetNodeId: retainedWorker.id,
        createdAt: newerOldIso,
        updatedAt: newerOldIso,
      },
      {
        id: "message-pruned",
        exchangeId: "exchange-pruned",
        kind: "root",
        message: "prune me",
        requester: hub,
        targetNodeId: prunedWorker.id,
        createdAt: oldIso,
        updatedAt: oldIso,
      },
    ],
    proposals: [
      {
        id: "proposal-retained",
        source: retainedWorker,
        target: retainedWorker,
        sourceNodeId: retainedWorker.id,
        targetNodeId: retainedWorker.id,
        kind: "patch",
        summary: "keep me",
        workspace: { nodeId: retainedWorker.id, workspaceId: "ws-1" },
        artifactIds: ["artifact-retained"],
        status: "applied",
        createdAt: oldIso,
        updatedAt: oldIso,
      },
      {
        id: "proposal-pruned",
        source: prunedWorker,
        target: prunedWorker,
        sourceNodeId: prunedWorker.id,
        targetNodeId: prunedWorker.id,
        kind: "patch",
        summary: "prune me",
        workspace: { nodeId: prunedWorker.id, workspaceId: "ws-2" },
        artifactIds: ["artifact-pruned"],
        status: "applied",
        createdAt: oldIso,
        updatedAt: oldIso,
      },
    ],
    artifacts: [
      {
        id: "artifact-retained",
        proposalId: "proposal-retained",
        kind: "diff",
        uri: "file:///retained.patch",
        createdAt: oldIso,
      },
      {
        id: "artifact-pruned",
        proposalId: "proposal-pruned",
        kind: "diff",
        uri: "file:///pruned.patch",
        createdAt: oldIso,
      },
    ],
    validations: [
      {
        id: "validation-retained",
        proposalId: "proposal-retained",
        nodeId: retainedWorker.id,
        kind: "smoke",
        verdict: "pass",
        metrics: {},
        artifactIds: ["artifact-retained"],
        createdAt: oldIso,
      },
      {
        id: "validation-pruned",
        proposalId: "proposal-pruned",
        nodeId: prunedWorker.id,
        kind: "smoke",
        verdict: "pass",
        metrics: {},
        artifactIds: ["artifact-pruned"],
        createdAt: oldIso,
      },
    ],
    auditEvents: [
      {
        id: "audit-retained",
        actorId: retainedWorker.id,
        action: "task.succeeded",
        targetType: "task",
        targetId: "task-retained",
        proposalId: "proposal-retained",
        createdAt: oldIso,
      },
      {
        id: "audit-pruned",
        actorId: prunedWorker.id,
        action: "task.succeeded",
        targetType: "task",
        targetId: "task-pruned",
        proposalId: "proposal-pruned",
        createdAt: oldIso,
      },
    ],
    workers: [
      {
        nodeId: retainedWorker.id,
        role: retainedWorker.role,
        capabilities: workerCapabilities,
        createdAt: oldIso,
        updatedAt: oldIso,
        lastSeenAt: oldIso,
      },
      {
        nodeId: prunedWorker.id,
        role: prunedWorker.role,
        capabilities: workerCapabilities,
        createdAt: oldIso,
        updatedAt: oldIso,
        lastSeenAt: oldIso,
      },
    ],
    tasks: [
      {
        id: "task-retained",
        exchangeId: "exchange-retained",
        intent: "analyze",
        requester: hub,
        target: retainedWorker,
        message: "keep me",
        proposalId: "proposal-retained",
        artifactIds: ["artifact-retained"],
        assignedWorkerId: retainedWorker.id,
        createdAt: oldIso,
        status: "succeeded",
        targetNodeId: retainedWorker.id,
        payload: {},
        updatedAt: newerOldIso,
        completedAt: newerOldIso,
        claimedBy: retainedWorker.id,
        result: {
          summary: "done",
          artifactIds: ["artifact-retained"],
        },
      },
      {
        id: "task-pruned",
        exchangeId: "exchange-pruned",
        intent: "analyze",
        requester: hub,
        target: prunedWorker,
        message: "prune me",
        proposalId: "proposal-pruned",
        artifactIds: ["artifact-pruned"],
        assignedWorkerId: prunedWorker.id,
        createdAt: oldIso,
        status: "succeeded",
        targetNodeId: prunedWorker.id,
        payload: {},
        updatedAt: oldIso,
        completedAt: oldIso,
        claimedBy: prunedWorker.id,
      },
    ],
  };

  const broker = new InMemoryA2ABroker(undefined, snapshot, {
    retention: {
      terminalRetentionMs: 0,
      maxTerminalExchanges: 0,
      maxTerminalTasks: 1,
      maxTerminalProposals: 0,
      inactiveWorkerRetentionMs: 0,
      maxInactiveWorkers: 0,
      auditRetentionMs: 0,
      maxAuditEvents: 0,
    },
  });

  const retained = broker.exportSnapshot();

  assert.deepEqual(retained.exchanges.map((exchange) => exchange.id), ["exchange-retained"]);
  assert.deepEqual(retained.exchangeMessages.map((message) => message.id), ["message-retained"]);
  assert.deepEqual(retained.tasks.map((task) => task.id), ["task-retained"]);
  assert.deepEqual(retained.proposals.map((proposal) => proposal.id), ["proposal-retained"]);
  assert.deepEqual(retained.artifacts.map((artifact) => artifact.id), ["artifact-retained"]);
  assert.deepEqual(retained.validations.map((validation) => validation.id), ["validation-retained"]);
  assert.deepEqual(retained.auditEvents.map((event) => event.id), ["audit-retained"]);
  assert.deepEqual(retained.workers.map((worker) => worker.nodeId), [retainedWorker.id]);
});

test("broker retention coalesces worker heartbeat audit rows without pruning worker registration proof", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    retention: {
      auditRetentionMs: 60 * 60 * 1000,
      maxAuditEvents: 2,
    },
    workerHeartbeatPersistIntervalMs: 0,
  });

  registerWorker(broker, "worker-heartbeat-cap");
  broker.heartbeatWorker("worker-heartbeat-cap");
  broker.heartbeatWorker("worker-heartbeat-cap");
  broker.heartbeatWorker("worker-heartbeat-cap");

  const auditActions = broker.exportSnapshot().auditEvents.map((event) => event.action);

  assert.equal(auditActions.filter((action) => action === "worker.registered").length, 1);
  assert.equal(auditActions.filter((action) => action === "worker.heartbeat").length, 1);
});

test("broker retention coalesces task heartbeat audit rows without pruning task lifecycle proof", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    retention: {
      auditRetentionMs: 60 * 60 * 1000,
      maxAuditEvents: 4,
      maxHeartbeatAuditEvents: 1,
      heartbeatAuditSampleIntervalMs: 0,
    },
  });
  registerWorker(broker, "worker-task-heartbeat-cap");
  const task = createWorkerTask(broker, "task-heartbeat-cap", "worker-task-heartbeat-cap");
  broker.claimTask(task.id, "worker-task-heartbeat-cap");
  broker.startTask(task.id, "worker-task-heartbeat-cap");

  broker.heartbeatTask(task.id, "worker-task-heartbeat-cap");
  broker.heartbeatTask(task.id, "worker-task-heartbeat-cap");
  broker.heartbeatTask(task.id, "worker-task-heartbeat-cap");

  const auditEvents = broker.exportSnapshot().auditEvents;
  const auditActions = auditEvents.map((event) => event.action);

  assert.equal(auditActions.filter((action) => action === "task.created").length, 1);
  assert.equal(auditActions.filter((action) => action === "task.claimed").length, 1);
  assert.equal(auditActions.filter((action) => action === "task.started").length, 1);
  assert.deepEqual(
    auditEvents
      .filter((event) => event.action === "task.heartbeat")
      .map((event) => event.id),
    [`task-heartbeat:${task.id}`],
  );
});

test("subscribeToTask streams lifecycle updates and marks terminal events final", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  unsubscribe();

  assert.deepEqual(
    updates.map((u) => u.reason),
    ["claimed", "started", "succeeded"],
  );
  assert.deepEqual(
    updates.map((u) => u.task.status),
    ["claimed", "running", "succeeded"],
  );
  assert.deepEqual(
    updates.map((u) => u.final),
    [false, false, true],
  );
  // Snapshot safety: mutating the delivered task should not affect broker state.
  updates[0].task.status = "canceled";
  assert.equal(broker.getTask(task.id)?.status, "succeeded");
});

test("subscribeToTask emits approval updates with approval metadata", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "promote_to_live",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "live-trader" },
    assignedWorkerId: "worker-a",
    message: "promote after review",
  });

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.approveTask(task.id, {
    actor: { id: "operator-a", kind: "user", role: "operator" },
    approvalId: "chg-28",
    reason: "operator reviewed live promotion",
  });

  unsubscribe();

  assert.deepEqual(
    updates.map((u) => u.reason),
    ["approved"],
  );
  assert.equal(updates[0].task.status, "queued");
  assert.equal(updates[0].final, false);
  assert.equal(updates[0].task.approval?.approvalId, "chg-28");
  assert.equal(updates[0].task.policyContext?.requiresApproval, true);
});

test("subscribeToTask emits dead_lettered and requeued updates during stale recovery", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 1 });
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });
  broker.claimTask(task.id, "worker-a");

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  // First sweep requeues (within cap).
  broker.requeueStaleTasksDetailed(0, { nowMs: Date.now() + 60_000 });
  // Second sweep dead-letters because requeueCount already matches maxRequeueAttempts=1.
  broker.claimTask(task.id, "worker-a");
  broker.requeueStaleTasksDetailed(0, { nowMs: Date.now() + 120_000 });

  unsubscribe();

  const reasons = updates.map((u) => u.reason);
  assert.ok(reasons.includes("requeued"), `expected requeued in ${reasons.join(",")}`);
  assert.ok(reasons.includes("dead_lettered"), `expected dead_lettered in ${reasons.join(",")}`);
  const terminal = updates.find((u) => u.reason === "dead_lettered");
  assert.ok(terminal);
  assert.equal(terminal.final, true);
  assert.equal(terminal.task.status, "failed");
});

test("subscribeToTask unsubscribe stops further deliveries", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  unsubscribe();
  broker.startTask(task.id, "worker-a");

  assert.deepEqual(
    updates.map((u) => u.reason),
    ["claimed"],
  );
});

test("subscribeToTask includes monotonically increasing seq numbers", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  unsubscribe();

  assert.ok(updates.length === 3);
  assert.ok(updates[0].seq < updates[1].seq);
  assert.ok(updates[1].seq < updates[2].seq);
});

test("replayTaskEvents returns events buffered after the given seq", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  // Subscribe to trigger buffering.
  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  unsubscribe();

  // Replay from seq 0 should return events with seq > 0.
  const replayed = broker.replayTaskEvents(task.id, 0);
  assert.ok(replayed.length >= 2);
  for (const event of replayed) {
    assert.ok(event.seq > 0);
  }
});

test("replayTaskEvents returns empty for unknown task", () => {
  const broker = new InMemoryA2ABroker();
  const replayed = broker.replayTaskEvents("nonexistent", 0);
  assert.deepEqual(replayed, []);
});

test("formatSseEventId and parseSseEventId round-trip", () => {
  const broker = new InMemoryA2ABroker();
  const id = broker.formatSseEventId("task-abc", 42);
  assert.equal(id, "task-abc:42");
  const parsed = broker.parseSseEventId(id);
  assert.deepEqual(parsed, { taskId: "task-abc", seq: 42 });
});

test("parseSseEventId returns null for malformed values", () => {
  const broker = new InMemoryA2ABroker();
  assert.equal(broker.parseSseEventId(""), null);
  assert.equal(broker.parseSseEventId("no-colon"), null);
  assert.equal(broker.parseSseEventId(":123"), null);
  assert.equal(broker.parseSseEventId("task:notanumber"), null);
});

test("event buffer respects maxBufferedEventsPerTask limit", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    maxBufferedEventsPerTask: 3,
  });
  registerWorker(broker, "worker-a");

  // Create multiple tasks and drive lifecycle to generate events.
  for (let i = 0; i < 5; i++) {
    const task = broker.createTask({
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: `run analysis ${i}`,
    });
    broker.claimTask(task.id, "worker-a");
    broker.startTask(task.id, "worker-a");
    broker.completeTask(task.id, "worker-a", { summary: `done ${i}` });
  }

  // Pick the first task and verify buffer is capped at 3.
  const allTasks = broker.listTasks({});
  const firstTask = allTasks[0];
  const allEvents = broker.replayTaskEvents(firstTask.id, -1);
  assert.ok(allEvents.length <= 3, `expected <= 3 events, got ${allEvents.length}`);
});

// ---------------------------------------------------------------------------
// Durable task/attempt identity and idempotent create semantics
// ---------------------------------------------------------------------------

test("idempotent create returns existing task for same id", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task1 = broker.createTask({
    id: "dup-1",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
  });

  const auditBefore = broker.listAuditEvents({ targetId: "dup-1" });

  const task2 = broker.createTask({
    id: "dup-1",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis again",
  });

  assert.equal(task1, task2);

  const auditAfter = broker.listAuditEvents({ targetId: "dup-1" });
  assert.equal(auditAfter.length, auditBefore.length, "no duplicate audit events");
});

test("idempotent create does not revalidate", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "dup-noval",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
  });

  // Second create with a non-existent worker should NOT throw — it returns the existing task.
  const task2 = broker.createTask({
    id: "dup-noval",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "no-such-worker", kind: "node", role: "analyst" },
    assignedWorkerId: "no-such-worker",
    message: "invalid worker",
  });

  assert.equal(task, task2);
});

test("claimTask generates attemptId", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const claimed = broker.claimTask(task.id, "worker-a");
  assert.equal(typeof claimed.attemptId, "string");
  const firstAttemptId = claimed.attemptId;

  // Requeue and claim again — should get a new attemptId
  broker.requeueStaleTasks(0, { nowMs: Date.now() + 999_999 });
  const reclaimedTask = broker.getTask(task.id)!;
  assert.equal(reclaimedTask.attemptId, undefined);

  const claimed2 = broker.claimTask(task.id, "worker-a");
  assert.equal(typeof claimed2.attemptId, "string");
  assert.notEqual(claimed2.attemptId, firstAttemptId);
});

test("reassign clears attemptId", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  const claimed = broker.getTask(task.id)!;
  assert.ok(claimed.attemptId);

  broker.reassignTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "operator" },
    targetNodeId: "worker-b",
  });

  const reassigned = broker.getTask(task.id)!;
  assert.equal(reassigned.attemptId, undefined);
});

test("completeTask is idempotent on already-succeeded", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  const completed1 = broker.completeTask(task.id, "worker-a", { summary: "done" });
  const completed2 = broker.completeTask(task.id, "worker-a", { summary: "done again" });

  assert.equal(completed1.completedAt, completed2.completedAt);
  assert.deepEqual(completed1.result, completed2.result);
  assert.equal(completed2.status, "succeeded");
});

test("failTask is idempotent on already-failed", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  const failed1 = broker.failTask(task.id, "worker-a", { message: "boom" });
  const failed2 = broker.failTask(task.id, "worker-a", { message: "boom again" });

  assert.equal(failed1.completedAt, failed2.completedAt);
  assert.deepEqual(failed1.error, failed2.error);
  assert.equal(failed2.status, "failed");
});

test("completeTask on already-canceled returns task without mutation", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "no longer needed",
  });

  const result = broker.completeTask(task.id, "worker-a", { summary: "done" });
  assert.equal(result.status, "canceled");
});

test("failTask on already-succeeded returns task without mutation", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  const result = broker.failTask(task.id, "worker-a", { message: "boom" });
  assert.equal(result.status, "succeeded");
});

// ── Late evidence after cancel (issue #954) ──────────────────────────────

test("completeTask on already-canceled records lateEvidenceAfterCancel", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "no longer needed",
  });

  const result = broker.completeTask(task.id, "worker-a", { summary: "done late" });
  assert.equal(result.status, "canceled");
  assert.ok(result.lateEvidenceAfterCancel, "should record late evidence");
  assert.equal(result.lateEvidenceAfterCancel!.kind, "complete");
  assert.equal(result.lateEvidenceAfterCancel!.submittedBy, "worker-a");
  assert.equal(result.lateEvidenceAfterCancel!.result?.summary, "done late");
  assert.ok(result.lateEvidenceAfterCancel!.submittedAt);
});

test("failTask on already-canceled records lateEvidenceAfterCancel", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "no longer needed",
  });

  const result = broker.failTask(task.id, "worker-a", { message: "late fail" });
  assert.equal(result.status, "canceled");
  assert.ok(result.lateEvidenceAfterCancel, "should record late evidence");
  assert.equal(result.lateEvidenceAfterCancel!.kind, "fail");
  assert.equal(result.lateEvidenceAfterCancel!.submittedBy, "worker-a");
  assert.equal(result.lateEvidenceAfterCancel!.error?.message, "late fail");
  assert.ok(result.lateEvidenceAfterCancel!.submittedAt);
});

test("late completion after cancel produces canceled_with_late_completion tombstone", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "no longer needed",
  });
  broker.completeTask(task.id, "worker-a", { summary: "done late" });

  const diag = broker.getTaskDiagnostics(task.id);
  assert.equal(diag.interruption?.kind, "late_completion_after_cancel");
  assert.equal(diag.interruption?.source, "tombstone");
  assert.ok(diag.interruption?.summary.includes("after cancel"));

  const ts = broker.getTombstone(task.id);
  assert.ok(ts);
  assert.equal(ts!.tombstoneReason, "canceled_with_late_completion");
  assert.ok(ts!.metadata);
  assert.equal(ts!.metadata!.cancelReason, "worker posted complete evidence after cancel");
});

test("late evidence after cancel surfaces in diagnostic brokerHints", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "no longer needed",
  });
  broker.completeTask(task.id, "worker-a", { summary: "done late" });

  const diag = broker.getTaskDiagnostics(task.id);
  assert.ok(diag.brokerHints.lateEvidenceAfterCancel);
  assert.equal(diag.brokerHints.lateEvidenceAfterCancel!.kind, "complete");
  assert.equal(diag.brokerHints.lateEvidenceAfterCancel!.submittedBy, "worker-a");
  assert.ok(diag.brokerHints.lateEvidenceAfterCancel!.submittedAt);
});

test("second complete after cancel does not overwrite lateEvidenceAfterCancel", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "no longer needed",
  });

  const first = broker.completeTask(task.id, "worker-a", { summary: "first late" });
  assert.equal(first.lateEvidenceAfterCancel?.result?.summary, "first late");

  const second = broker.completeTask(task.id, "worker-a", { summary: "second late" });
  assert.equal(second.lateEvidenceAfterCancel?.result?.summary, "first late");
});

test("snapshot roundtrip preserves lateEvidenceAfterCancel", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "no longer needed",
  });
  broker.completeTask(task.id, "worker-a", { summary: "done late" });

  const snapshot = broker.exportSnapshot();
  const broker2 = new InMemoryA2ABroker(undefined, snapshot);

  const loaded = broker2.getTask(task.id);
  assert.ok(loaded);
  assert.equal(loaded!.status, "canceled");
  assert.ok(loaded!.lateEvidenceAfterCancel);
  assert.equal(loaded!.lateEvidenceAfterCancel!.kind, "complete");
  assert.equal(loaded!.lateEvidenceAfterCancel!.result?.summary, "done late");
});

test("late fail after cancel produces late_completion_after_cancel interruption", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "no longer needed",
  });
  broker.failTask(task.id, "worker-a", { message: "late fail" });

  const diag = broker.getTaskDiagnostics(task.id);
  assert.equal(diag.interruption?.kind, "late_completion_after_cancel");
  assert.equal(diag.interruption?.source, "tombstone");
  assert.ok(diag.brokerHints.lateEvidenceAfterCancel);
  assert.equal(diag.brokerHints.lateEvidenceAfterCancel!.kind, "fail");
  assert.equal(diag.brokerHints.lateEvidenceAfterCancel!.submittedBy, "worker-a");

  const ts = broker.getTombstone(task.id);
  assert.ok(ts);
  assert.equal(ts!.tombstoneReason, "canceled_with_late_completion");
});

test("accepted-task wake planning is durable and duplicate-safe", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "task-wake-1",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "wake target",
    payload: {
      waitRunId: "wait-1",
      correlationId: "corr-1",
      parentRunId: "parent-1",
    },
  });

  const firstPlan = broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-1",
    correlationId: "corr-1",
    parentRunId: "parent-1",
  });
  assert.equal(firstPlan.shouldDispatch, true);
  assert.equal(firstPlan.replayed, false);
  assert.equal(firstPlan.wake.status, "planned");
  assert.equal(firstPlan.wake.wakeKey, "corr-1:wait-1");
  assert.equal(firstPlan.wake.idempotencyKey, "a2a-wake:corr-1:wait-1");

  const scheduled = broker.recordTaskWakeDecision(task.id, {
    status: "scheduled",
    runtimeRunId: "run-1",
    coalesced: false,
    message: "queued for target wake",
  });
  assert.equal(scheduled.wake?.status, "scheduled");
  assert.equal(scheduled.wake?.runtimeRunId, "run-1");

  const replay = broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-1",
    correlationId: "corr-1",
    parentRunId: "parent-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.shouldDispatch, false);
  assert.equal(replay.wake.status, "scheduled");
  assert.equal(replay.wake.replayCount, 1);

  assert.equal(
    broker.listAuditEvents({ targetId: task.id, action: "task.wake.planned" }).length,
    1,
  );
  assert.equal(
    broker.listAuditEvents({ targetId: task.id, action: "task.wake.scheduled" }).length,
    1,
  );
});

test("accepted-task wake replay after restart preserves pending and decided state", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "task-wake-restart",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "wake target",
  });
  broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-restart",
    correlationId: "corr-restart",
  });

  const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot());
  const replayPlan = restarted.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-restart",
    correlationId: "corr-restart",
  });
  assert.equal(replayPlan.replayed, true);
  assert.equal(replayPlan.shouldDispatch, true);
  assert.equal(replayPlan.wake.status, "planned");
  assert.equal(replayPlan.wake.replayCount, 1);

  restarted.recordTaskWakeDecision(task.id, {
    status: "skipped",
    code: "wake_disabled",
    message: "Wake-on-Task disabled by default",
  });
  const secondRestart = new InMemoryA2ABroker(undefined, restarted.exportSnapshot());
  const persisted = secondRestart.getTask(task.id);
  assert.equal(persisted?.wake?.status, "skipped");
  assert.equal(persisted?.wake?.code, "wake_disabled");

  const replayAfterDecision = secondRestart.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-restart",
    correlationId: "corr-restart",
  });
  assert.equal(replayAfterDecision.replayed, true);
  assert.equal(replayAfterDecision.shouldDispatch, false);
  assert.equal(replayAfterDecision.wake.status, "skipped");
});

test("accepted-task wake failure is durable and operator-visible", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "task-wake-failure",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "wake target",
  });
  broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-fail",
    correlationId: "corr-fail",
  });
  broker.recordTaskWakeDecision(task.id, {
    status: "failed",
    code: "wake_dispatch_failed",
    message: "runtime unavailable",
  });

  const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot());
  const persisted = restarted.getTask(task.id);
  assert.equal(persisted?.wake?.status, "failed");
  assert.equal(persisted?.wake?.code, "wake_dispatch_failed");
  assert.equal(persisted?.wake?.message, "runtime unavailable");

  const failures = restarted.listAuditEvents({
    targetId: task.id,
    action: "task.wake.failed",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0].note ?? "", /runtime unavailable/);
});

test("broker accepts canonical GitHub patch dispatch and stamps taskOrigin", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-canonical");

  const task = broker.createTask({
    intent: "propose_patch",
    taskOrigin: "github",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-canonical", kind: "node", role: "analyst" },
    message: "fix issue",
    payload: {
      mode: "github-propose-patch",
      repo: "acme/platform",
      issueNumber: 291,
      issueUrl: "https://github.com/acme/platform/issues/291",
    },
  });

  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "github-propose-patch");
  assert.equal(task.payload.repo, "acme/platform");
  assert.equal(task.payload.issue, "#291");
  assert.equal(task.payload.issueNumber, 291);
  assert.equal(task.payload.issueUrl, "https://github.com/acme/platform/issues/291");
  assert.equal(task.payload.githubDispatchCompatibility, undefined);
});

test("broker derives parent-round metadata for Team GitHub patch dispatches", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-team-round");

  const task = broker.createTask({
    intent: "propose_patch",
    taskOrigin: "github",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-team-round", kind: "node", role: "analyst" },
    message: "fix issue",
    payload: {
      mode: "github-propose-patch",
      repo: "acme/platform",
      issueNumber: 291,
      issueUrl: "https://github.com/acme/platform/issues/291",
      parentIssueUrl: "https://github.com/acme/platform/issues/290",
      teamId: "team1",
      lane: 3,
      runId: "a2a-team1-round-20260606T073100Z",
      workModeDecision: {
        mode: "team1",
        idempotencyKey: "a2a-work-mode:team1:github-round",
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

  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.parentRoundId, "a2a-team1-round-20260606T073100Z");
  assert.equal(task.payload.parentRoundTotal, 4);
  assert.equal(task.payload.parentRoundOrder, 3);
  assert.equal(task.payload.originBrokerId, "hub-a");
  assert.equal(task.payload.runId, "a2a-team1-round-20260606T073100Z");
  assert.equal((task.payload.workModeDecision as Record<string, unknown>)?.finalizerOwner, "seoseo");
});

test("broker rejects parent-routed GitHub patch dispatches with incomplete parent-round metadata", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-parent-round-reject");

  assert.throws(
    () => broker.createTask({
      intent: "propose_patch",
      taskOrigin: "github",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-parent-round-reject", kind: "node", role: "analyst" },
      message: "fix issue",
      payload: {
        mode: "github-propose-patch",
        repo: "acme/platform",
        issueNumber: 291,
        issueUrl: "https://github.com/acme/platform/issues/291",
        parentIssueUrl: "https://github.com/acme/platform/issues/290",
        runId: "a2a-parent-round-without-lane",
      },
    }),
    /parent-round metadata invalid: parentRoundTotal is required.*parentRoundOrder is required/,
  );
});

test("broker normalizes legacy GitHub dispatch fields with compatibility marker", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-legacy");

  const task = broker.createTask({
    intent: "propose_patch",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-legacy", kind: "node", role: "analyst" },
    message: "fix issue",
    payload: {
      githubRepo: "acme/platform",
      githubIssueNumber: 292,
      workMode: "github",
    },
  });

  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "github-propose-patch");
  assert.equal(task.payload.repo, "acme/platform");
  assert.equal(task.payload.issue, "#292");
  assert.equal(task.payload.issueNumber, 292);
  assert.equal(task.payload.issueUrl, "https://github.com/acme/platform/issues/292");
  assert.deepEqual(task.payload.githubDispatchCompatibility, {
    normalizedFromLegacyPayload: true,
    legacyFields: ["githubRepo", "githubIssueNumber", "workMode"],
  });
});

test("broker accepts GitHub read-only validation lanes with issue metadata", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-readonly");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-readonly", kind: "node", role: "analyst" },
    message: "libero validation for https://github.com/acme/platform/issues/527",
    payload: {
      mode: "read-only-analysis",
      repo: "acme/platform",
      issueUrl: "https://github.com/acme/platform/issues/527",
      assignmentRole: "libero",
    },
  });

  assert.equal(task.intent, "analyze");
  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "read-only-analysis");
  assert.equal(task.payload.repo, "acme/platform");
  assert.equal(task.payload.issue, "#527");
  assert.equal(task.payload.issueNumber, 527);
  assert.equal(task.payload.issueUrl, "https://github.com/acme/platform/issues/527");
  assert.equal(task.payload.assignmentRole, "libero");
});

test("broker accepts github-verify as a read-only evidence lane", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-verify");

  const task = broker.createTask({
    intent: "verify",
    taskOrigin: "github",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-verify", kind: "node", role: "analyst" },
    message: "run no-live validation",
    payload: {
      mode: "github-verify",
      repo: "acme/platform",
      issueNumber: 528,
    },
  });

  assert.equal(task.intent, "verify");
  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "github-verify");
  assert.equal(task.payload.issue, "#528");
  assert.equal(task.payload.issueUrl, "https://github.com/acme/platform/issues/528");
});

test("broker accepts family-wiki-readonly-audit as a read-only evidence lane", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-family-wiki-audit");

  const task = broker.createTask({
    intent: "verify",
    taskOrigin: "github",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-family-wiki-audit", kind: "node", role: "analyst" },
    message: "audit Family Wiki structure without patch evidence",
    payload: {
      mode: "family-wiki-readonly-audit",
      repo: "jinwon-int/seoyoon-family-wiki",
      issueNumber: 894,
    },
  });

  assert.equal(task.intent, "verify");
  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "family-wiki-readonly-audit");
  assert.equal(task.payload.issue, "#894");
  assert.equal(task.payload.issueUrl, "https://github.com/jinwon-int/seoyoon-family-wiki/issues/894");
});

test("broker rejects non-canonical GitHub dispatch with wrong taskOrigin", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-reject");

  assert.throws(
    () => broker.createTask({
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-reject", kind: "node", role: "analyst" },
      taskOrigin: "api",
      message: "fix issue",
      payload: {
        mode: "github-propose-patch",
        repo: "acme/platform",
        issueNumber: 293,
      },
    }),
    /taskOrigin=github/,
  );
});

test("broker rejects GitHub issue URLs before generic handler fallback", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-url-reject");

  assert.throws(
    () => broker.createTask({
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-url-reject", kind: "node", role: "analyst" },
      message: "please work https://github.com/acme/platform/issues/294",
      payload: { mode: "terminal-brief-r4-receipt-automation" },
    }),
    /GitHub-looking tasks require canonical intent=propose_patch/,
  );
});

test("broker rejects GitHub-looking generic task before worker fallback", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-generic-reject");

  assert.throws(
    () => broker.createTask({
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-generic-reject", kind: "node", role: "analyst" },
      message: "https://github.com/acme/platform/issues/294",
      payload: { mode: "terminal-brief-r4-receipt-automation" },
    }),
    /GitHub-looking tasks require canonical intent=propose_patch/,
  );
});

test("broker rejects ad-hoc legacy GitHub metadata dispatch before worker fallback", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-legacy-generic-reject");

  assert.throws(
    () => broker.createTask({
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-legacy-generic-reject", kind: "node", role: "analyst" },
      message: "run terminal brief automation",
      payload: {
        mode: "terminal-brief-r4-receipt-automation",
        githubRepo: "acme/platform",
        githubIssueNumber: 295,
      },
    }),
    /GitHub-looking tasks require canonical intent=propose_patch/,
  );
});

test("broker rejects repo plus issueNumber without canonical github-propose-patch mode", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-shape-reject");

  assert.throws(
    () => broker.createTask({
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-shape-reject", kind: "node", role: "analyst" },
      message: "fix issue",
      payload: {
        repo: "acme/platform",
        issueNumber: 295,
      },
    }),
    /payload\.mode=github-propose-patch/,
  );
});

test("broker rejects repo plus issueUrl dispatch that is missing canonical GitHub mode", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-mode-reject");

  assert.throws(
    () => broker.createTask({
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-mode-reject", kind: "node", role: "analyst" },
      taskOrigin: "github",
      message: "fix issue",
      payload: {
        repo: "acme/platform",
        issueUrl: "https://github.com/acme/platform/issues/295",
      },
    }),
    /mode=github-propose-patch/,
  );
});

// --- Cleanup candidate discovery (issue #520) ---

test("discoverCleanupCandidates returns empty plan for clean broker", () => {
  const broker = new InMemoryA2ABroker();
  const plan = broker.discoverCleanupCandidates();
  assert.equal(plan.totalCandidates, 0);
  assert.equal(plan.summary.stale_worker, 0);
  assert.equal(plan.summary.malformed_task, 0);
  assert.equal(plan.summary.terminal_outbox_backlog, 0);
  assert.equal(plan.summary.historical_terminal_task, 0);
  assert.deepEqual(plan.actionabilitySummary, {
    advisory: 0,
    blocked: 0,
    executable: 0,
    cursor_skipped: 0,
    retention_not_due: 0,
  });
  assert.ok(plan.generatedAt);
  assert.ok(plan.riskNotes.length > 0);
  assert.ok(plan.riskNotes.some((n) => n.includes("No cleanup candidates")));
});

test("discoverCleanupCandidates detects stale workers via nowMs aging", () => {
  const broker = new InMemoryA2ABroker();
  // Register worker — lastSeenAt is set to now
  broker.registerWorker({
    nodeId: "stale-w1",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  // Use nowMs far in the future to make the worker appear stale
  const farFutureMs = Date.now() + 600_000; // 10 min later
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000, // 5 min
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.stale_worker, 1);
  assert.equal(plan.totalCandidates, 1);
  assert.equal(plan.candidates[0].class, "stale_worker");
  assert.equal(plan.candidates[0].entityId, "stale-w1");
  assert.equal(plan.candidates[0].risk, "caution");
  assert.equal(plan.candidates[0].actionability, "advisory");
  assert.equal(plan.actionabilitySummary.advisory, 1);
});

test("discoverCleanupCandidates marks stale worker with active tasks as high_risk", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "stale-w2",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  // Create an active task assigned to the stale worker
  broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "stale-w2", kind: "node", role: "operator" },
    payload: { work: "active-task" },
  });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.stale_worker, 1);
  assert.equal(plan.candidates[0].risk, "high_risk");
  assert.equal(plan.candidates[0].actionability, "blocked");
  assert.equal(plan.actionabilitySummary.blocked, 1);
  assert.equal(plan.candidates[0].metadata?.hasActiveTasks, true);
});

test("discoverCleanupCandidates detects malformed queued tasks with missing target", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  // Create a task that will be queued
  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "valid" },
  });
  assert.equal(task.status, "queued");

  // With proper fields, should not be flagged as malformed
  const nowMs = Date.now() + 300_000;
  const plan = broker.discoverCleanupCandidates({
    staleTaskAfterMs: 120_000,
    nowMs,
  });

  assert.equal(plan.summary.malformed_task, 0);
  // Well-formed stale queued tasks are detected as queued_residue (see
  // dedicated queued-residue tests below for comprehensive coverage).
  assert.equal(plan.summary.queued_residue, 1);
});

test("discoverCleanupCandidates detects queued residue for old unclaimed queued tasks", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  // Create a well-formed queued task that remains unclaimed
  const task = broker.createTask({
    intent: "backfill",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { branch: "feature/cleanup" },
  });
  assert.equal(task.status, "queued");

  // Fast-forward past the stale threshold; set staleWorkerAfterMs high to
  // avoid interference from stale worker detection
  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 86_400_000, // 24h — well beyond the window
    staleTaskAfterMs: 120_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.queued_residue, 1);
  assert.equal(plan.summary.malformed_task, 0);
  assert.equal(plan.totalCandidates, 1);

  const residue = plan.candidates[0];
  assert.equal(residue.class, "queued_residue");
  assert.equal(residue.entityId, task.id);
  assert.equal(residue.risk, "caution");
  assert.equal(residue.actionability, "advisory");
  assert.equal(plan.actionabilitySummary.advisory, 1);
  assert.equal(residue.metadata?.intent, "backfill");
  assert.equal(residue.metadata?.status, "queued");
  assert.ok(residue.reason.includes("queued"));
  assert.ok(residue.id.includes("cleanup:queued-residue:"));
  assert.ok(plan.riskNotes.some((note) => note.includes("Queued residue")));
});

test("discoverCleanupCandidates queued residue is distinct from malformed_task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  // Well-formed queued task — should be queued residue
  const valid = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "important" },
  });

  // Malformed queued task: clear targetNodeId and payload to make it malformed
  broker.createTask({
    id: "malformed-distinct",
    intent: "backfill",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { temp: "placeholder" },
  });
  const malformedTaskRaw = broker.getTask("malformed-distinct")!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (malformedTaskRaw as any).targetNodeId = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (malformedTaskRaw as any).payload = {};
  malformedTaskRaw.updatedAt = new Date(Date.now() - 600_000).toISOString();

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 86_400_000, // 24h — avoid stale-worker interference
    staleTaskAfterMs: 120_000,
    nowMs: farFutureMs,
  });

  // Both classes should be present and distinct
  assert.equal(plan.summary.malformed_task, 1);
  assert.equal(plan.summary.queued_residue, 1);
  assert.equal(plan.totalCandidates, 2);

  const malformedItem = plan.candidates.find((c) => c.class === "malformed_task");
  assert.ok(malformedItem);
  assert.equal(malformedItem.metadata?.taskId, "malformed-distinct");
  assert.ok(malformedItem.reason.includes("malformed"));
  assert.ok(malformedItem.reason.includes("missing targetNodeId"));

  const residueItem = plan.candidates.find((c) => c.class === "queued_residue");
  assert.ok(residueItem);
  assert.equal(residueItem.entityId, valid.id);
  assert.ok(residueItem.reason.includes("without being claimed"));
  assert.ok(!residueItem.reason.includes("malformed"));

  // Risk notes for both classes present
  assert.ok(plan.riskNotes.some((note) => note.includes("Malformed queued tasks")));
  assert.ok(plan.riskNotes.some((note) => note.includes("Queued residue")));
});

test("discoverCleanupCandidates no queued residue for recent queued tasks", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "fresh" },
  });

  // No time travel — task is still recent
  const plan = broker.discoverCleanupCandidates();
  assert.equal(plan.summary.queued_residue, 0);
});

test("discoverCleanupCandidates queued residue risk note includes count", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "a" },
  });
  broker.createTask({
    intent: "backfill",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "b" },
  });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 86_400_000, // 24h — avoid stale-worker interference
    staleTaskAfterMs: 120_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.queued_residue, 2);
  assert.ok(plan.riskNotes.some((note) => note === "Queued residue detected (2): well-formed queued tasks that remain unclaimed. Verify worker capacity and routing before manual intervention."));
});

test("discoverCleanupCandidates detects terminal outbox backlog", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "w1");
  broker.completeTask(task.id, "w1", { summary: "done" });

  const plan = broker.discoverCleanupCandidates({
    terminalOutboxBacklogAfterMs: 0, // immediate
  });

  // The outbox should have an unacknowledged event for the terminal task
  assert.ok(plan.summary.terminal_outbox_backlog >= 1);
  const backlogItem = plan.candidates.find(
    (c) => c.class === "terminal_outbox_backlog",
  );
  assert.ok(backlogItem);
  assert.equal(backlogItem.metadata?.taskId, task.id);
  assert.equal(backlogItem.actionability, "blocked");
  assert.equal(backlogItem.metadata?.cursorState, "unknown");
});

test("discoverCleanupCandidates excludes acknowledged outbox events", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "w1");
  broker.completeTask(task.id, "w1", { summary: "done" });

  // Mark all outbox events as acknowledged
  const outbox = broker.getTerminalTaskEventOutbox();
  const events = outbox.snapshot();
  for (const event of events) {
    outbox.acknowledge(event.id, {
      evidence: "operator_visible",
      acknowledgedAt: new Date().toISOString(),
    });
  }

  const plan = broker.discoverCleanupCandidates({
    terminalOutboxBacklogAfterMs: 0,
  });

  assert.equal(plan.summary.terminal_outbox_backlog, 0);
});

test("discoverCleanupCandidates detects historical terminal tasks", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "w1");
  broker.completeTask(task.id, "w1", { summary: "done" });

  const farFutureMs = Date.now() + 86_400_000 + 1000; // ~24h + 1s later
  const plan = broker.discoverCleanupCandidates({
    historicalTerminalAfterMs: 86_400_000,
    nowMs: farFutureMs,
  });

  assert.ok(plan.summary.historical_terminal_task >= 1);
  const histItem = plan.candidates.find(
    (c) => c.class === "historical_terminal_task",
  );
  assert.ok(histItem);
  assert.equal(histItem.entityId, task.id);
  assert.equal(histItem.metadata?.status, "succeeded");
  assert.equal(histItem.actionability, "retention_not_due");
  assert.equal(plan.actionabilitySummary.retention_not_due, 1);
});

test("discoverCleanupCandidates sorts by risk (high_risk first)", () => {
  const broker = new InMemoryA2ABroker();

  // Create a stale worker with active tasks (high_risk)
  broker.registerWorker({
    nodeId: "stale-hi",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });
  broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "stale-hi", kind: "node", role: "operator" },
    payload: {},
  });

  // Create another stale worker without tasks (caution)
  broker.registerWorker({
    nodeId: "stale-lo",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.ok(plan.candidates.length >= 2);
  // high_risk should be first
  assert.equal(plan.candidates[0].risk, "high_risk");
  assert.equal(plan.candidates[0].entityId, "stale-hi");
});

test("discoverCleanupCandidates returns riskNotes matching summary", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "stale-notes",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.ok(plan.riskNotes.some((note) => note.includes("Stale workers")));
});

test("discoverCleanupCandidates is read-only (no state mutation)", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: {},
  });

  const beforeSnapshot = broker.exportSnapshot();

  broker.discoverCleanupCandidates();
  broker.discoverCleanupCandidates({ staleWorkerAfterMs: 1000, nowMs: Date.now() + 99_999 });

  const afterSnapshot = broker.exportSnapshot();
  assert.equal(afterSnapshot.tasks.length, beforeSnapshot.tasks.length);
  assert.equal(afterSnapshot.workers.length, beforeSnapshot.workers.length);
  assert.equal(broker.getTask(task.id)!.status, task.status);
});

test("discoverCleanupCandidates respects custom thresholds", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "custom-w",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const farFutureMs = Date.now() + 120_000; // 2 min later

  // Default threshold (5 min) should NOT find it stale
  const planDefault = broker.discoverCleanupCandidates({ nowMs: farFutureMs });
  assert.equal(planDefault.summary.stale_worker, 0);

  // Custom threshold (1 min) should find it stale
  const planCustom = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 60_000,
    nowMs: farFutureMs,
  });
  assert.equal(planCustom.summary.stale_worker, 1);
});

test("discoverCleanupCandidates detects orphaned_claim for claimed task on stale worker", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "orphan-worker",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "orphan-worker", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "orphan-worker");
  assert.equal(broker.getTask(task.id)!.status, "claimed");

  // Fast-forward time to make the worker stale
  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.orphaned_claim, 1);
  const orphanItem = plan.candidates.find((c) => c.class === "orphaned_claim");
  assert.ok(orphanItem);
  assert.equal(orphanItem.entityId, task.id);
  assert.equal(orphanItem.metadata?.status, "claimed");
  assert.equal(orphanItem.metadata?.staleWorkerId, "orphan-worker");
  assert.equal(orphanItem.risk, "caution");
  assert.ok(orphanItem.reason.includes("orphan-worker"));
});

test("discoverCleanupCandidates detects orphaned_claim for running task on stale worker (high_risk)", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "orphan-runner",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "orphan-runner", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "orphan-runner");
  // The broker goes claimed->running on start with a heartbeat
  broker.startTask(task.id, "orphan-runner");
  assert.equal(broker.getTask(task.id)!.status, "running");

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.orphaned_claim, 1);
  const orphanItem = plan.candidates.find((c) => c.class === "orphaned_claim");
  assert.ok(orphanItem);
  assert.equal(orphanItem.entityId, task.id);
  assert.equal(orphanItem.metadata?.status, "running");
  assert.equal(orphanItem.metadata?.staleWorkerId, "orphan-runner");
  // Running task on stale worker is high risk (potential data loss)
  assert.equal(orphanItem.risk, "high_risk");
});

test("discoverCleanupCandidates does not flag orphaned_claim when worker is healthy", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "healthy-w",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "healthy-w", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "healthy-w");

  // No time travel — worker is still fresh
  const plan = broker.discoverCleanupCandidates();
  assert.equal(plan.summary.orphaned_claim, 0);
});

test("discoverCleanupCandidates does not flag orphaned_claim for queued tasks", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "queued-worker",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "queued-worker", kind: "node", role: "operator" },
    payload: {},
  });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  // Worker is stale, but queued tasks are not orphaned claims
  assert.equal(plan.summary.stale_worker, 1);
  assert.equal(plan.summary.orphaned_claim, 0);
});

test("discoverCleanupCandidates orphaned_claim risk notes are present when detected", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "risk-worker",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "risk-worker", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(task.id, "risk-worker");

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    nowMs: farFutureMs,
  });

  assert.equal(plan.summary.orphaned_claim, 1);
  assert.ok(plan.riskNotes.some((note) => note.includes("Orphaned claims")));
});

test("discoverCleanupCandidates stable ids are deterministic", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "stable-w",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  const farFutureMs = Date.now() + 600_000;
  const plan1 = broker.discoverCleanupCandidates({ staleWorkerAfterMs: 300_000, nowMs: farFutureMs });
  const plan2 = broker.discoverCleanupCandidates({ staleWorkerAfterMs: 300_000, nowMs: farFutureMs });

  assert.equal(plan1.candidates.length, plan2.candidates.length);
  assert.equal(plan1.candidates[0].id, plan2.candidates[0].id);
  assert.equal(plan1.candidates[0].id, "cleanup:stale-worker:stable-w");
});

test("discoverCleanupCandidates finds candidates not eligible for retention pruning (actionability gap)", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  // Stale worker with active tasks — discovered as candidate but blocks pruning
  broker.registerWorker({
    nodeId: "stale-active",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });
  const activeTask = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "stale-active", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(activeTask.id, "stale-active");

  // Queued residue — non-terminal, not retention-prunable
  broker.createTask({
    intent: "backfill",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "residue" },
  });

  // Terminal task — completed but not past historical threshold (within 24h)
  const recentTerminal = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: {},
  });
  broker.claimTask(recentTerminal.id, "w1");
  broker.completeTask(recentTerminal.id, "w1", { summary: "done" });

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    staleTaskAfterMs: 120_000,
    nowMs: farFutureMs,
  });

  // Discovery finds multiple candidate classes
  assert.ok(plan.totalCandidates > 0, "should discover candidates");

  // stale_worker with active tasks — NOT prunable via retention
  const staleActive = plan.candidates.find((c) => c.class === "stale_worker" && c.metadata?.hasActiveTasks === true);
  assert.ok(staleActive, "should find stale worker with active tasks");
  assert.equal(staleActive!.risk, "high_risk");

  // queued_residue — NOT prunable via retention (non-terminal)
  const residue = plan.candidates.find((c) => c.class === "queued_residue");
  assert.ok(residue, "should find queued residue");

  // Recent terminal task should NOT show as historical_terminal_task (within threshold)
  const hist = plan.candidates.find((c) => c.class === "historical_terminal_task");
  assert.equal(hist, undefined, "recent terminal task should not be historical yet");

  // stale_worker (idle, no tasks) — NOT present because no idle stale worker exists
  const staleIdle = plan.candidates.filter(
    (c) => c.class === "stale_worker" && c.metadata?.hasActiveTasks !== true,
  );
  // Both workers have active claims; no idle stale workers
  assert.equal(staleIdle.length, 0, "all stale workers have active tasks");

  // Risk notes reflect non-prunable categories
  assert.ok(plan.riskNotes.some((n) => n.includes("Stale workers")));
  assert.ok(plan.riskNotes.some((n) => n.includes("Queued residue")));

  // Verify the actionability gap: discovered candidates > 0 but none are
  // eligible for automated retention pruning (queued_residue and stale_worker
  // with active tasks are discovery-only categories)
  const prunableClasses = new Set(["historical_terminal_task"]);
  const prunableCandidates = plan.candidates.filter((c) => prunableClasses.has(c.class));
  assert.equal(
    prunableCandidates.length,
    0,
    "no candidates prunable via retention alone — all require manual operator intervention",
  );
});

test("discoverCleanupCandidates risk notes correctly categorize actionable and non-actionable classes", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  // Register a worker that will be stale but has NO active tasks — actionable (safe to prune with opt-in)
  broker.registerWorker({
    nodeId: "idle-worker",
    role: "operator",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["default"], environments: ["research"] },
  });

  // Create queued residue that ages past threshold
  broker.createTask({
    id: "old-residue",
    intent: "backfill",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { data: "stale" },
  });

  // Create a malformed task (missing targetNodeId) that ages past threshold
  broker.createTask({
    id: "old-malformed",
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "operator" },
    payload: { temp: "x" },
  });
  const malformedRaw = broker.getTask("old-malformed")!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (malformedRaw as any).targetNodeId = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (malformedRaw as any).payload = {};
  malformedRaw.updatedAt = new Date(Date.now() - 600_000).toISOString();

  const farFutureMs = Date.now() + 600_000;
  const plan = broker.discoverCleanupCandidates({
    staleWorkerAfterMs: 300_000,
    staleTaskAfterMs: 120_000,
    nowMs: farFutureMs,
  });

  // Should find at least some candidates
  assert.ok(plan.riskNotes.length > 0, "should have risk notes");

  // Verify each candidate has a valid risk classification matching the actionability doc
  assert.ok(plan.candidates.length > 0, "should find candidates");
  assert.ok(
    plan.candidates.every((c) => ["high_risk", "caution", "safe"].includes(c.risk)),
    "all candidates should have valid risk classification",
  );

  // Risk notes should exist for discovered classes
  if (plan.summary.stale_worker > 0) {
    assert.ok(
      plan.riskNotes.some((n) => n.includes("Stale workers")),
      "stale worker risk note present",
    );
  }
  if (plan.summary.queued_residue > 0) {
    assert.ok(
      plan.riskNotes.some((n) => n.includes("Queued residue")),
      "queued residue risk note present",
    );
  }
  if (plan.summary.malformed_task > 0) {
    assert.ok(
      plan.riskNotes.some((n) => n.includes("Malformed queued tasks")),
      "malformed task risk note present",
    );
  }

  // Verify that stale_worker (no tasks) is "caution" — actionable with opt-in
  const idleStale = plan.candidates.find(
    (c) => c.class === "stale_worker" && c.metadata?.hasActiveTasks === false,
  );
  if (idleStale) {
    assert.equal(idleStale.risk, "caution", "idle stale worker should be caution risk");
  }

  // queued_residue is "caution" — requires manual intervention, not automated pruning
  const residue = plan.candidates.find((c) => c.class === "queued_residue");
  if (residue) {
    assert.equal(residue.risk, "caution", "queued residue should be caution risk");
  }

  // malformed_task is "caution" — requires manual inspection
  const malformed = plan.candidates.find((c) => c.class === "malformed_task");
  if (malformed) {
    assert.equal(malformed.risk, "caution", "malformed task should be caution risk");
  }
});

// ---------------------------------------------------------------------------
// Mobile worker health in broker-facing status
// ---------------------------------------------------------------------------

test("getWorkerCapacitySummary includes workerMode and mobileHealth for mobile workers", () => {
  const broker = new InMemoryA2ABroker();
  const nowMs = Date.now();

  // Register a persistent worker (control)
  broker.registerWorker({
    nodeId: "persistent-w1",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });

  // Register a mobile worker with recent heartbeat
  broker.registerWorker({
    nodeId: "gongyung",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });

  // Recent heartbeat (within mobile 30s window)
  broker.heartbeatWorker("gongyung", { capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] } });

  const summary = broker.getWorkerCapacitySummary({ nowMs });

  // Persistent worker: no mobileHealth, no workerMode
  const persistentItem = summary.items.find((i) => i.nodeId === "persistent-w1");
  assert.ok(persistentItem);
  assert.equal(persistentItem.workerMode, undefined);
  assert.equal(persistentItem.mobileHealth, undefined);

  // Mobile worker (online): has workerMode and mobileHealth
  const mobileItem = summary.items.find((i) => i.nodeId === "gongyung");
  assert.ok(mobileItem);
  assert.equal(mobileItem.workerMode, "mobile");
  assert.equal(mobileItem.mobileHealth, "health_ok");
});

test("getWorkerCapacitySummary exposes runtimeFlavor and gatewayRequired for poll-only workers", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "sogyo-poll-only",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["team1"],
      environments: ["research"],
      runtimeFlavor: "openclaw-poll-handler",
      gatewayRequired: false,
    },
    metadata: {
      workerProfile: "openclaw-poll-only",
      executionPlane: "broker-poll-http-handler",
    },
  });

  const summary = broker.getWorkerCapacitySummary();
  const item = summary.items.find((i) => i.nodeId === "sogyo-poll-only");
  assert.ok(item);
  assert.equal(item.runtimeFlavor, "openclaw-poll-handler");
  assert.equal(item.gatewayRequired, false);
});

test("getWorkerCapacitySummary classifies mobile worker as stale beyond mobile threshold", () => {
  const broker = new InMemoryA2ABroker();

  // Register a mobile worker at time zero
  broker.registerWorker({
    nodeId: "daegyo",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });

  // Advance time to 35s after registration — past mobile 30s window, within 90s extended window
  // The broker "now" is set to lastSeenAt + 35_000 ms
  const worker = broker.getWorker("daegyo");
  assert.ok(worker);
  const workerSeenMs = Date.parse(worker.lastSeenAt);
  const nowMs = workerSeenMs + 35_000;

  const summary = broker.getWorkerCapacitySummary({ nowMs });

  const daegyo = summary.items.find((i) => i.nodeId === "daegyo");
  assert.ok(daegyo);
  assert.equal(daegyo.workerMode, "mobile");
  // Mobile past 30s => stale, but not yet disconnected (within 90s)
  assert.equal(daegyo.mobileHealth, "stale");
  // Brokers' generic status reflects mobile-aware threshold
  assert.equal(daegyo.status, "stale");
});

test("getWorkerCapacitySummary classifies mobile worker as disconnected past extended threshold", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "daegyo-disconnected",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });

  const worker = broker.getWorker("daegyo-disconnected");
  assert.ok(worker);
  const workerSeenMs = Date.parse(worker.lastSeenAt);
  // 100s — well beyond both 30s mobile and 90s extended threshold
  const nowMs = workerSeenMs + 100_000;

  const summary = broker.getWorkerCapacitySummary({ nowMs });

  const daegyo = summary.items.find((i) => i.nodeId === "daegyo-disconnected");
  assert.ok(daegyo);
  assert.equal(daegyo.workerMode, "mobile");
  assert.equal(daegyo.mobileHealth, "disconnected");
  assert.equal(daegyo.status, "stale");
});

test("getDashboard includes workerMode and mobileHealth for mobile workers", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "persistent-w2",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });

  broker.registerWorker({
    nodeId: "gongyung-dash",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });
  broker.heartbeatWorker("gongyung-dash", { capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] } });

  const dashboard = broker.getDashboard({ nowMs: Date.now(), offlineAfterMs: 90_000 });

  // Persistent worker: no mobile fields
  const persistentNode = dashboard.workers.byNode.find((w) => w.nodeId === "persistent-w2");
  assert.ok(persistentNode);
  assert.equal(persistentNode.workerMode, undefined);
  assert.equal(persistentNode.mobileHealth, undefined);

  // Mobile worker (online)
  const mobileNode = dashboard.workers.byNode.find((w) => w.nodeId === "gongyung-dash");
  assert.ok(mobileNode);
  assert.equal(mobileNode.workerMode, "mobile");
  assert.equal(mobileNode.mobileHealth, "health_ok");
  assert.equal(mobileNode.status, "online");
});

test("getDashboard fleet worker counts use mobile-aware stale thresholds", () => {
  const broker = new InMemoryA2ABroker();

  // Register one persistent and one mobile worker
  broker.registerWorker({
    nodeId: "persistent-a",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });
  broker.registerWorker({
    nodeId: "gongyung-fleet",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });

  const persistentWorker = broker.getWorker("persistent-a");
  const mobileWorker = broker.getWorker("gongyung-fleet");
  assert.ok(persistentWorker);
  assert.ok(mobileWorker);

  const persistentSeenMs = Date.parse(persistentWorker.lastSeenAt);
  const mobileSeenMs = Date.parse(mobileWorker.lastSeenAt);

  // Advance time to 45s after registration:
  //   - persistent worker still within 90s window => online
  //   - mobile worker past its 30s window but within 90s extended => stale
  const nowMs = Math.max(persistentSeenMs, mobileSeenMs) + 45_000;

  const dashboard = broker.getDashboard({ nowMs, offlineAfterMs: 90_000 });

  // Fleet totals reflect mode-aware staleness
  assert.equal(dashboard.workers.total, 2);
  assert.equal(dashboard.workers.online, 1, "persistent still online at 45s");
  assert.equal(dashboard.workers.stale, 1, "mobile stale at 45s");

  const persistentNode = dashboard.workers.byNode.find((w) => w.nodeId === "persistent-a");
  const mobileNode = dashboard.workers.byNode.find((w) => w.nodeId === "gongyung-fleet");
  assert.ok(persistentNode);
  assert.ok(mobileNode);

  assert.equal(persistentNode.status, "online");
  assert.equal(persistentNode.workerMode, undefined);
  assert.equal(persistentNode.mobileHealth, undefined);

  assert.equal(mobileNode.status, "stale");
  assert.equal(mobileNode.workerMode, "mobile");
  assert.equal(mobileNode.mobileHealth, "stale");
});

test("computeWorkerMobileHealth returns undefined for persistent workers", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "persistent-b",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });

  const summary = broker.getWorkerCapacitySummary();
  const item = summary.items.find((i) => i.nodeId === "persistent-b");
  assert.ok(item);
  assert.equal(item.workerMode, undefined);
  assert.equal(item.mobileHealth, undefined);
});

test("getWorkerCapacitySummary mobile fields present for mobile workers, absent for persistent", () => {
  const broker = new InMemoryA2ABroker();

  // Register a mix of mobile and persistent workers
  broker.registerWorker({
    nodeId: "gongyung-mix",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });
  broker.registerWorker({
    nodeId: "daegyo-mix",
    role: "analyst",
    workerMode: "mobile",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });
  broker.registerWorker({
    nodeId: "persistent-c",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });
  broker.registerWorker({
    nodeId: "persistent-d",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
  });

  // Heartbeat gongyung so it's fresh; daegyo stays at registration time
  broker.heartbeatWorker("gongyung-mix", { capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["hermes-no-live"], environments: ["research"] } });

  // Query at the current time — all workers should be online since
  // registration and heartbeat are all within the 90s persistent window
  const summary = broker.getWorkerCapacitySummary();
  assert.equal(summary.totals.workers, 4);

  // Mobile items carry workerMode and mobileHealth
  const gongyung = summary.items.find((i) => i.nodeId === "gongyung-mix");
  const daegyo = summary.items.find((i) => i.nodeId === "daegyo-mix");
  assert.ok(gongyung);
  assert.ok(daegyo);
  assert.equal(gongyung.workerMode, "mobile");
  assert.ok(gongyung.mobileHealth); // could be "health_ok" or "stale" depending on timing
  assert.equal(daegyo.workerMode, "mobile");
  assert.ok(daegyo.mobileHealth);

  // Persistent items have neither field
  assert.equal(summary.items.find((i) => i.nodeId === "persistent-c")?.workerMode, undefined);
  assert.equal(summary.items.find((i) => i.nodeId === "persistent-c")?.mobileHealth, undefined);
  assert.equal(summary.items.find((i) => i.nodeId === "persistent-d")?.workerMode, undefined);
  assert.equal(summary.items.find((i) => i.nodeId === "persistent-d")?.mobileHealth, undefined);
});

test("Hermes native worker submits redacted done evidence via completeTask", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "hermes-evidence-tester",
    role: "analyst",
    workerMode: "mobile",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["hermes-no-live"],
      environments: ["research"],
      runtimeFlavor: "termux-hermes",
      gatewayRequired: false,
    },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  });

  const task = broker.createTask({
    id: "hermes-evidence-task",
    requester: { id: "hub-requester", kind: "service", role: "hub" },
    target: { id: "hermes-evidence-tester", kind: "node", role: "analyst" },
    assignedWorkerId: "hermes-evidence-tester",
    intent: "analyze",
    message: "Hermes worker evidence contract test",
    payload: { source: "hermes-evidence-contract-test" },
    taskOrigin: "api",
  });
  assert.equal(task.status, "queued");

  broker.claimTask(task.id, "hermes-evidence-tester");
  broker.startTask(task.id, "hermes-evidence-tester");

  const result = broker.completeTask(task.id, "hermes-evidence-tester", {
    summary: "Hermes worker produced redacted terminal evidence",
    output: { referenceWorker: "hermes-agent", openClawRequired: false, operatorNote: "source-only; no provider ids" },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.result?.summary, "Hermes worker produced redacted terminal evidence");
  assert.deepEqual(result.result?.output, { referenceWorker: "hermes-agent", openClawRequired: false, operatorNote: "source-only; no provider ids" });
  assert.equal(result.assignedWorkerId, "hermes-evidence-tester");
});

test("Hermes native worker submits redacted blocked evidence via failTask", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "hermes-blocked-tester",
    role: "analyst",
    workerMode: "mobile",
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
  });

  const task = broker.createTask({
    id: "hermes-blocked-evidence-task",
    requester: { id: "hub-requester", kind: "service", role: "hub" },
    target: { id: "hermes-blocked-tester", kind: "node", role: "analyst" },
    assignedWorkerId: "hermes-blocked-tester",
    intent: "analyze",
    message: "Hermes worker blocked evidence test",
    payload: { source: "hermes-blocked-evidence-test" },
    taskOrigin: "api",
  });
  assert.equal(task.status, "queued");

  broker.claimTask(task.id, "hermes-blocked-tester");
  broker.startTask(task.id, "hermes-blocked-tester");

  const result = broker.failTask(task.id, "hermes-blocked-tester", {
    code: "blocked",
    message: "Preflight no-live gate rejected live promotion attempt",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "blocked");
  assert.equal(result.error?.message, "Preflight no-live gate rejected live promotion attempt");
});

test("Hermes mobile worker transitions through health_ok, stale, disconnected", () => {
  const broker = new InMemoryA2ABroker();

  broker.registerWorker({
    nodeId: "hermes-health-tester",
    role: "analyst",
    workerMode: "mobile",
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
  });

  const nowMs = Date.now();
  let summary = broker.getWorkerCapacitySummary({ nowMs });
  const worker = summary.items.find((i) => i.nodeId === "hermes-health-tester");
  assert.ok(worker);
  assert.equal(worker.status, "online");
  assert.equal(worker.workerMode, "mobile");
  assert.equal(worker.mobileHealth, "health_ok");

  const staleNowMs = nowMs + 45_000;
  summary = broker.getWorkerCapacitySummary({ nowMs: staleNowMs });
  const staleWorker = summary.items.find((i) => i.nodeId === "hermes-health-tester");
  assert.ok(staleWorker);
  assert.equal(staleWorker.status, "stale");
  assert.equal(staleWorker.mobileHealth, "stale");

  const disconnectedNowMs = nowMs + 100_000;
  summary = broker.getWorkerCapacitySummary({ nowMs: disconnectedNowMs });
  const disconnectedWorker = summary.items.find((i) => i.nodeId === "hermes-health-tester");
  assert.ok(disconnectedWorker);
  assert.equal(disconnectedWorker.status, "stale");
  assert.equal(disconnectedWorker.mobileHealth, "disconnected");
});

test("Hermes worker registration preserves runtimeFlavor and gatewayRequired in read model", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-hermes-read-model-"));
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
      nodeId: "hermes-read-model",
      role: "analyst",
      displayName: "Hermes Read Model Tester",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["hermes-no-live"],
        environments: ["research"],
        runtimeFlavor: "termux-hermes",
        gatewayRequired: false,
      },
      workerMode: "mobile",
      metadata: { runtime: "hermes-agent", transport: "http-poll" },
    });

    const hot = sqliteStore.readHotWorkers({ nodeId: "hermes-read-model" });
    assert.equal(hot.length, 1);
    assert.equal(hot[0]?.capabilities.runtimeFlavor, "termux-hermes");
    assert.equal(hot[0]?.capabilities.gatewayRequired, false);
    assert.equal(hot[0]?.workerMode, "mobile");

    const worker = broker.getWorker("hermes-read-model");
    assert.ok(worker);
    assert.equal(worker.capabilities.runtimeFlavor, "termux-hermes");
    assert.equal(worker.capabilities.gatewayRequired, false);
    assert.equal(worker.workerMode, "mobile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
