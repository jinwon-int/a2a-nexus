// Trusted Conversation Plane — task↔conversation bridge tests (#1863 slice 1;
// spec #1861). Exit-criteria coverage: task result → bounded conversation
// reply (deterministic, idempotent re-projection), conversation reply →
// input-required resume exactly once, and the task-turn/message-turn
// distinction (pure message turns never touch task lifecycle).
import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryA2ABroker } from "./broker.js";
import { TASK_RESULT_REPLY_MAX_BYTES, buildTaskResultReplyEnvelope, taskReferencesOf } from "./broker-conversation-task-bridge.js";
import { BrokerError } from "./broker-error.js";

const WORKER_A = { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" };
const WORKER_B = { kind: "worker", id: "worker-b", homeBrokerId: "broker-alpha" };

function openConversation(broker: InMemoryA2ABroker, overrides: Record<string, unknown> = {}): string {
  const { conversation } = broker.startConversation({
    homeBrokerId: "broker-alpha",
    envelope: {
      messageId: "msg-1",
      kind: "question",
      sender: WORKER_A,
      recipients: [WORKER_B],
      idempotencyKey: "idem-1",
      content: { text: "Please analyze the release" },
      ...overrides,
    },
  });
  return conversation.conversationId;
}

function makeClaimedTask(broker: InMemoryA2ABroker, workerId = "worker-b") {
  broker.registerWorker({
    nodeId: workerId,
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
  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: workerId, kind: "node", role: "analyst" },
  });
  broker.claimTask(task.id, workerId);
  broker.startTask(task.id, workerId);
  return broker.getTask(task.id) ?? task;
}

test("task result projects as a bounded, task-turn reply with a deterministic idempotency key", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const conversationId = openConversation(broker);
  const task = makeClaimedTask(broker);
  broker.completeTask(task.id, task.claimedBy as string, {
    summary: "Analysis complete; two risks found and documented".repeat(40),
    note: "artifacts attached",
    artifactIds: ["art-1", "art-2"],
  });

  const projected = broker.projectTaskResultAsConversationReply(conversationId, task.id);
  assert.equal(projected.outcome, "accepted");

  const conversation = broker.getConversation(conversationId);
  const reply = conversation?.messagesById[projected.messageId];
  assert.ok(reply, "projected reply exists");
  assert.equal(reply.kind, "reply");
  assert.equal(reply.taskId, task.id); // task-turn distinction
  assert.match(reply.content.text, /^task=/);
  assert.match(reply.content.text, /status=succeeded/);
  assert.ok(Buffer.byteLength(reply.content.text, "utf8") <= TASK_RESULT_REPLY_MAX_BYTES);
  assert.match(reply.idempotencyKey, /^taskresult:/);

  // Re-projection converges (deterministic key) — no duplicate reply.
  const again = broker.projectTaskResultAsConversationReply(conversationId, task.id);
  assert.equal(again.outcome, "converged");
  assert.equal(again.messageId, projected.messageId);
  assert.equal(conversation?.lastAssignedSequence, reply.sequence);
});

test("buildTaskResultReplyEnvelope bounds oversized summaries and refuses unclaimed tasks", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const conversationId = openConversation(broker);
  const conversation = broker.getConversation(conversationId)!;
  const task = { id: "t-x", status: "succeeded", claimedBy: "worker-b", result: { summary: "s".repeat(10_000) } };
  const envelope = buildTaskResultReplyEnvelope(conversation, task);
  assert.ok(Buffer.byteLength(envelope.content.text, "utf8") <= TASK_RESULT_REPLY_MAX_BYTES);
  assert.ok(envelope.content.text.endsWith("…") || envelope.content.text.length < TASK_RESULT_REPLY_MAX_BYTES);

  assert.throws(
    () => buildTaskResultReplyEnvelope(conversation, { id: "t-unclaimed", status: "queued" }),
    (error: unknown) => error instanceof BrokerError && /no worker/.test(error.message),
  );
});

test("input-required resume: a conversation reply resumes an awaiting_operator checkpoint exactly once", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const conversationId = openConversation(broker);
  const task = makeClaimedTask(broker);
  broker.checkpointTask(task.id, task.claimedBy as string, {
    state: "awaiting_operator",
    reason: "need approval to proceed",
  });
  assert.equal(broker.getTask(task.id)?.checkpoint?.state, "awaiting_operator");

  // The worker replies in the conversation, referencing the task.
  const reply = broker.addConversationMessage(conversationId, {
    messageId: "msg-2",
    kind: "reply",
    sender: WORKER_B,
    recipients: [WORKER_A],
    idempotencyKey: "idem-2",
    taskId: task.id,
    content: { text: "Approved — proceed with the plan." },
  });
  assert.equal(reply.outcome, "accepted");
  assert.equal(broker.getTask(task.id)?.checkpoint, undefined, "awaiting_operator cleared");

  // Exactly one resume audit event.
  const resumes = broker
    .listAuditEvents()
    .filter((event) => event.action === "task.resumed" && event.targetId === task.id);
  assert.equal(resumes.length, 1);

  // A duplicate replay of the same reply converges at the envelope layer —
  // it never reaches the bridge, so still exactly one resume.
  const replay = broker.addConversationMessage(conversationId, {
    messageId: "msg-2",
    kind: "reply",
    sender: WORKER_B,
    recipients: [WORKER_A],
    idempotencyKey: "idem-2",
    taskId: task.id,
    content: { text: "Approved — proceed with the plan." },
  });
  assert.equal(replay.outcome, "converged");
  assert.equal(
    broker.listAuditEvents().filter((event) => event.action === "task.resumed" && event.targetId === task.id).length,
    1,
  );

  // A second, distinct reply after the checkpoint is cleared is a no-op
  // (resumeTask idempotent) — no error, still one resume.
  const later = broker.addConversationMessage(conversationId, {
    messageId: "msg-3",
    kind: "clarification",
    sender: WORKER_A,
    recipients: [WORKER_B],
    idempotencyKey: "idem-3",
    referenceTaskIds: [task.id],
    content: { text: "Also include the risk table." },
  });
  assert.equal(later.outcome, "accepted");
  assert.equal(
    broker.listAuditEvents().filter((event) => event.action === "task.resumed" && event.targetId === task.id).length,
    1,
  );
});

test("pure message turns (no task references) never touch task lifecycle", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const conversationId = openConversation(broker);
  const task = makeClaimedTask(broker);
  broker.checkpointTask(task.id, task.claimedBy as string, {
    state: "awaiting_operator",
    reason: "need approval",
  });

  broker.addConversationMessage(conversationId, {
    messageId: "msg-2",
    kind: "reply",
    sender: WORKER_B,
    recipients: [WORKER_A],
    idempotencyKey: "idem-2",
    content: { text: "chit chat without any task reference" },
  });

  assert.equal(broker.getTask(task.id)?.checkpoint?.state, "awaiting_operator", "checkpoint untouched");
  assert.deepEqual(taskReferencesOf({ taskId: undefined, referenceTaskIds: [] }), []);
});

test("non-resuming kinds (ack/control) do not resume checkpoints", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const conversationId = openConversation(broker);
  const task = makeClaimedTask(broker);
  broker.checkpointTask(task.id, task.claimedBy as string, { state: "awaiting_operator", reason: "waiting" });

  broker.addConversationMessage(conversationId, {
    messageId: "msg-2",
    kind: "ack",
    sender: WORKER_B,
    recipients: [WORKER_A],
    idempotencyKey: "idem-2",
    taskId: task.id,
    content: { text: "acknowledged" },
  });

  assert.equal(broker.getTask(task.id)?.checkpoint?.state, "awaiting_operator", "ack does not resume");
});
