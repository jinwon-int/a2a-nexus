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
  registerWorker(broker, "workeralpha");
  registerWorker(broker, "workerbeta");

  const selected = createWorkerTask(broker, "round-selected-pr", "workeralpha");
  broker.claimTask(selected.id, "workeralpha");
  broker.startTask(selected.id, "workeralpha");
  broker.completeTask(selected.id, "workeralpha", {
    summary: "selected PR merged",
    output: { prUrl: "https://github.com/jinwon-int/a2a-docker-runner/pull/356" },
  });

  const sibling = createWorkerTask(broker, "round-sibling-running", "workerbeta");
  broker.claimTask(sibling.id, "workerbeta");
  broker.startTask(sibling.id, "workerbeta");
  const nextRound = createWorkerTask(broker, "next-round-workerbeta-queued", "workerbeta");

  const canceled = broker.cancelTask(sibling.id, {
    actor: { id: "brokeralpha", kind: "node", role: "hub" },
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
  assert.equal(diagnostics.interruption?.actorId, "brokeralpha");
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

