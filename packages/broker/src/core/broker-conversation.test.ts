// Trusted Conversation Plane — C2 slice 1 core domain tests (#1862, spec
// frozen as #1861). Each test names the spec threat/section it owns:
// T2 replay, T3 forged sequence, T4 redaction, T5 loop budget, T6 third-party
// access, T10 oversized payload, T11 metadata leak, plus the state machine
// (polling ≠ processed) and receipt binding (T1 groundwork).
import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptBrokerConversationMessage,
  advanceConversationDelivery,
  assertConversationParticipant,
  buildConversationReceipt,
  conversationContentDigest,
  expireStaleConversationMessages,
  openBrokerConversation,
  MAX_CONVERSATION_MESSAGE_BYTES,
  MAX_CONVERSATION_RECIPIENTS,
  MAX_CONVERSATION_TOTAL_BYTES,
  type A2AConversationState,
} from "./broker-conversation.js";
import { BrokerError } from "./broker-error.js";

interface AuditCapture {
  events: Array<{ actorId: string; action: string; targetId: string; note?: string }>;
}

function makeContext(now: string, audit: AuditCapture, store: Map<string, A2AConversationState>) {
  return {
    now: () => now,
    appendAuditEvent: (input: { actorId: string; action: string; targetType: string; targetId: string; note?: string }) => {
      audit.events.push({ actorId: input.actorId, action: input.action, targetId: input.targetId, note: input.note });
    },
    setConversationRecord: (conversation: A2AConversationState) => {
      store.set(conversation.conversationId, conversation);
    },
    persistState: () => {},
    requireConversationMessage: (conversationId: string, messageId: string) => {
      const conversation = store.get(conversationId);
      const message = conversation?.messagesById[messageId];
      if (!message) throw new BrokerError("not_found", `conversation message ${messageId} not found`);
      return message;
    },
  };
}

function baseEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "msg-1",
    kind: "question",
    sender: { kind: "broker", id: "broker-alpha", homeBrokerId: "broker-alpha" },
    recipients: [{ kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" }],
    idempotencyKey: "idem-1",
    content: { text: "What is the deployment status?" },
    ...overrides,
  };
}

function openConversation(audit: AuditCapture, store: Map<string, A2AConversationState>, overrides: Record<string, unknown> = {}) {
  return openBrokerConversation(
    { homeBrokerId: "broker-alpha", envelope: baseEnvelope(overrides) },
    makeContext("2026-08-17T00:00:00Z", audit, store),
  );
}

test("openBrokerConversation mints the conversation id, assigns sequence 1, and registers participants", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const { conversation, message } = openConversation(audit, store);
  assert.match(conversation.conversationId, /^conv-/);
  assert.equal(message.sequence, 1);
  assert.equal(message.deliveryState, "persisted");
  assert.deepEqual(message.stateLog.map((entry) => entry.state), ["persisted"]);
  assert.ok(conversation.participants.includes("broker:broker-alpha:broker-alpha"));
  assert.ok(conversation.participants.includes("worker:worker-a:broker-alpha"));
  assert.equal(conversation.turnCount, 1);
  assert.equal(store.size, 1);
});

test("client-supplied conversationId is refused on open (home broker mints it)", () => {
  const audit: AuditCapture = { events: [] };
  assert.throws(
    () => openConversation(audit, new Map(), { conversationId: "conv-forged" }),
    (error: unknown) => error instanceof BrokerError && error.code === "bad_request" && /minted by the home broker/.test(error.message),
  );
});

test("T3: client sequence is advisory only — the home broker assigns gap-free sequences across restarts", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const { conversation } = openConversation(audit, store);

  const workerReply = acceptBrokerConversationMessage(
    conversation,
    { envelope: baseEnvelope({ messageId: "msg-2", sequence: 999, kind: "reply", idempotencyKey: "idem-2", sender: { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" }, recipients: [{ kind: "broker", id: "broker-alpha", homeBrokerId: "broker-alpha" }] }) },
    makeContext("2026-08-17T00:00:01Z", audit, store),
  );
  assert.equal(workerReply.outcome, "accepted");
  assert.equal(workerReply.message.sequence, 2);
  assert.equal(workerReply.message.advisoryClientSequence, 999);

  // Simulate a restart: a "new" broker instance continues from the persisted
  // state object instead of fresh counters.
  const afterRestart = acceptBrokerConversationMessage(
    store.get(conversation.conversationId)!,
    { envelope: baseEnvelope({ messageId: "msg-3", sequence: 0, kind: "reply", idempotencyKey: "idem-3", sender: { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" }, recipients: [{ kind: "broker", id: "broker-alpha", homeBrokerId: "broker-alpha" }] }) },
    makeContext("2026-08-17T00:00:02Z", audit, store),
  );
  assert.equal(afterRestart.message.sequence, 3);
  assert.equal(afterRestart.message.advisoryClientSequence, 0);
});

test("T2: same idempotency key + same digest converges without consuming a sequence; different digest conflicts", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const { conversation } = openConversation(audit, store);
  const lastBefore = conversation.lastAssignedSequence;

  const replay = acceptBrokerConversationMessage(
    conversation,
    { envelope: baseEnvelope({ idempotencyKey: "idem-1" }) },
    makeContext("2026-08-17T00:00:05Z", audit, store),
  );
  assert.equal(replay.outcome, "converged");
  assert.equal(replay.message.messageId, "msg-1");
  assert.equal(conversation.lastAssignedSequence, lastBefore);

  assert.throws(
    () => acceptBrokerConversationMessage(
      conversation,
      { envelope: baseEnvelope({ idempotencyKey: "idem-1", content: { text: "tampered content" } }) },
      makeContext("2026-08-17T00:00:06Z", audit, store),
    ),
    (error: unknown) => error instanceof BrokerError && error.code === "idempotency_conflict" && /different content digest/.test(error.message),
  );
});

test("T2: a refused (expired) envelope records its key so the key cannot be relaunched with different content", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const { conversation } = openConversation(audit, store);

  assert.throws(
    () => acceptBrokerConversationMessage(
      conversation,
      { envelope: baseEnvelope({ messageId: "msg-exp", idempotencyKey: "idem-exp", expiresAt: "2026-08-16T00:00:00Z" }) },
      makeContext("2026-08-17T00:00:00Z", audit, store),
    ),
    (error: unknown) => error instanceof BrokerError && error.code === "policy_denied" && /expiresAt is already in the past/.test(error.message),
  );
  assert.equal(conversation.idempotencyByKey["idem-exp"].outcome, "refused");
  assert.throws(
    () => acceptBrokerConversationMessage(
      conversation,
      { envelope: baseEnvelope({ messageId: "msg-exp2", idempotencyKey: "idem-exp", content: { text: "different" } }) },
      makeContext("2026-08-17T00:00:01Z", audit, store),
    ),
    (error: unknown) => error instanceof BrokerError && error.code === "idempotency_conflict",
  );
});

test("T6: third-party actors are denied read and write; participants, home broker, and operators pass", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const { conversation } = openConversation(audit, store);

  const thirdWorker = { kind: "worker", id: "worker-z", homeBrokerId: "broker-alpha" };
  assert.throws(() => assertConversationParticipant(conversation, thirdWorker, "read"), isPolicyDenied);
  assert.throws(() => assertConversationParticipant(conversation, thirdWorker, "write"), isPolicyDenied);
  const foreignWorker = { kind: "worker", id: "worker-a", homeBrokerId: "broker-beta" };
  assert.throws(() => assertConversationParticipant(conversation, foreignWorker, "write"), isPolicyDenied);

  assertConversationParticipant(conversation, { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" }, "write");
  assertConversationParticipant(conversation, { kind: "broker", id: "broker-alpha", homeBrokerId: "broker-alpha" }, "read");
  assertConversationParticipant(conversation, { kind: "operator", id: "seo", homeBrokerId: "broker-alpha" }, "write");
});

test("T6: acceptBrokerConversationMessage enforces participant-only writes for non-participant senders", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const { conversation } = openConversation(audit, store);
  assert.throws(
    () => acceptBrokerConversationMessage(
      conversation,
      { envelope: baseEnvelope({ messageId: "msg-x", idempotencyKey: "idem-x", kind: "reply", sender: { kind: "worker", id: "worker-z", homeBrokerId: "broker-alpha" } }) },
      makeContext("2026-08-17T00:00:01Z", audit, store),
    ),
    (error: unknown) => error instanceof BrokerError && error.code === "policy_denied" && /participant/.test(error.message),
  );
});

test("T5: maxTurns is live — the budget-exceeding message is refused and the conversation closes; control close-out stays exempt", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const { conversation } = openBrokerConversation(
    { homeBrokerId: "broker-alpha", maxTurns: 2, envelope: baseEnvelope() },
    makeContext("2026-08-17T00:00:00Z", audit, store),
  );

  const second = acceptBrokerConversationMessage(
    conversation,
    { envelope: baseEnvelope({ messageId: "msg-2", kind: "reply", idempotencyKey: "idem-2", sender: { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" } }) },
    makeContext("2026-08-17T00:00:01Z", audit, store),
  );
  assert.equal(second.outcome, "accepted");

  assert.throws(
    () => acceptBrokerConversationMessage(
      conversation,
      { envelope: baseEnvelope({ messageId: "msg-3", kind: "reply", idempotencyKey: "idem-3", sender: { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" } }) },
      makeContext("2026-08-17T00:00:02Z", audit, store),
    ),
    (error: unknown) => error instanceof BrokerError && error.code === "policy_denied" && /maxTurns/.test(error.message),
  );
  assert.equal(conversation.status, "closed");
  assert.equal(conversation.closureReason, "max_turns");

  const control = acceptBrokerConversationMessage(
    conversation,
    { envelope: baseEnvelope({ messageId: "msg-close", kind: "control", idempotencyKey: "idem-close", sender: { kind: "operator", id: "op", homeBrokerId: "broker-alpha" }, content: { text: "close-out" } }) },
    makeContext("2026-08-17T00:00:03Z", audit, store),
  );
  assert.equal(control.outcome, "accepted");

  assert.throws(
    () => acceptBrokerConversationMessage(
      conversation,
      { envelope: baseEnvelope({ messageId: "msg-4", kind: "control", idempotencyKey: "idem-4", sender: { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" } }) },
      makeContext("2026-08-17T00:00:04Z", audit, store),
    ),
    (error: unknown) => error instanceof BrokerError && error.code === "policy_denied" && /control messages/.test(error.message),
  );
});

test("T10: oversized message text and conversation totals are refused", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const oversized = "x".repeat(MAX_CONVERSATION_MESSAGE_BYTES + 1);
  assert.throws(
    () => openConversation(audit, store, { content: { text: oversized } }),
    (error: unknown) => error instanceof BrokerError && error.code === "bad_request" && /content\.text exceeds/.test(error.message),
  );

  const { conversation } = openConversation(audit, store);
  const fanout: unknown[] = Array.from({ length: MAX_CONVERSATION_RECIPIENTS + 1 }, (_, i) => ({ kind: "worker", id: `w-${i}`, homeBrokerId: "broker-alpha" }));
  assert.throws(
    () => acceptBrokerConversationMessage(
      conversation,
      { envelope: baseEnvelope({ messageId: "msg-f", idempotencyKey: "idem-f", recipients: fanout }) },
      makeContext("2026-08-17T00:00:01Z", audit, store),
    ),
    (error: unknown) => error instanceof BrokerError && error.code === "bad_request" && /fanout bound/.test(error.message),
  );

  // Conversation total cap: with a raised turn budget, 64KB messages accumulate
  // until the cumulative cap refuses the next one.
  const full = "y".repeat(MAX_CONVERSATION_MESSAGE_BYTES);
  const raised: A2AConversationState = {
    ...conversation,
    maxTurns: 40,
  };
  store.set(raised.conversationId, raised);
  let accepted = 0;
  for (let i = 0; i < 40; i += 1) {
    try {
      acceptBrokerConversationMessage(
        raised,
        { envelope: baseEnvelope({ messageId: `msg-big-${i}`, idempotencyKey: `idem-big-${i}`, content: { text: full } }) },
        makeContext("2026-08-17T00:01:00Z", audit, store),
      );
      accepted += 1;
    } catch (error) {
      assert.ok(
        error instanceof BrokerError && error.code === "policy_denied" && /total content bytes/.test(error.message),
        `expected the conversation byte cap to refuse message ${i}, got: ${String(error)}`,
      );
      break;
    }
  }
  assert.ok(accepted < 40, "expected the conversation byte cap to trigger before the turn budget");
  assert.equal(accepted, Math.floor(MAX_CONVERSATION_TOTAL_BYTES / MAX_CONVERSATION_MESSAGE_BYTES) - 1);
});

test("T4: secret-shaped content is redacted before persistence and the digest is computed over the redacted text", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  const { message } = openConversation(audit, store, { content: { text: `token ${secret} inline` } });
  assert.equal(message.redacted, true);
  assert.ok(!message.content.text.includes(secret));
  assert.ok(message.content.text.includes("<redacted-github-token>"));
  assert.equal(message.contentDigest, conversationContentDigest(message.content.text));
});

test("T11: audit notes are digest-first — no message body reaches the audit log", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const body = "What is the deployment status?";
  openConversation(audit, store, { content: { text: body } });
  for (const event of audit.events) {
    assert.equal(event.note?.includes(body), false, `audit note leaked the body: ${event.note}`);
    assert.match(event.note ?? "", /digest=sha256:[0-9a-f]{64}/);
  }
});

test("state machine: processed requires linked evidence and transitions are forward-only (polling is delivered, never processed)", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const { conversation, message } = openConversation(audit, store);
  const now = "2026-08-17T00:00:10Z";

  advanceConversationDelivery(conversation, message.messageId, "delivered", { now });
  assert.equal(message.deliveryState, "delivered");

  assert.throws(
    () => advanceConversationDelivery(conversation, message.messageId, "processed", { now }),
    (error: unknown) => error instanceof BrokerError && error.code === "bad_request" && /processedEvidence/.test(error.message),
  );

  advanceConversationDelivery(conversation, message.messageId, "processed", {
    now,
    processedEvidence: { kind: "reply", ref: "msg-2" },
  });
  assert.equal(message.processedEvidence?.ref, "msg-2");

  // Terminal absorbing state: no further transitions from processed.
  assert.throws(
    () => advanceConversationDelivery(conversation, message.messageId, "delivered", { now }),
    (error: unknown) => error instanceof BrokerError && error.code === "policy_denied",
  );
  assert.throws(
    () => advanceConversationDelivery(conversation, message.messageId, "failed", { now }),
    (error: unknown) => error instanceof BrokerError && error.code === "policy_denied",
  );
});

test("expiry: stale messages terminate expired and their idempotency outcome is updated", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const { conversation, message } = openConversation(audit, store, { expiresAt: "2026-08-17T01:00:00Z" });
  advanceConversationDelivery(conversation, message.messageId, "delivered", { now: "2026-08-17T00:30:00Z" });

  const expired = expireStaleConversationMessages(conversation, "2026-08-17T02:00:00Z");
  assert.equal(expired.length, 1);
  assert.equal(message.deliveryState, "expired");
  assert.equal(conversation.idempotencyByKey["idem-1"].outcome, "expired");

  // Early expiry attempt fails closed before the TTL passes.
  const { conversation: second, message: secondMessage } = (() => {
    const opened = openBrokerConversation(
      { homeBrokerId: "broker-alpha", envelope: baseEnvelope({ messageId: "msg-e2", idempotencyKey: "idem-e2", expiresAt: "2026-08-18T00:00:00Z" }) },
      makeContext("2026-08-17T00:00:00Z", audit, store),
    );
    return opened;
  })();
  assert.throws(
    () => advanceConversationDelivery(second, secondMessage.messageId, "expired", { now: "2026-08-17T00:00:01Z" }),
    (error: unknown) => error instanceof BrokerError && error.code === "policy_denied" && /expiresAt has not passed/.test(error.message),
  );
});

test("receipt (T1 groundwork): the countersign binds conversationId, messageId, sequence, digest, and state", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  const { message } = openConversation(audit, store);
  const receipt = buildConversationReceipt(message, "broker-alpha", "2026-08-17T00:00:02Z");
  assert.equal(receipt.schemaVersion, "a2a.conversation-receipt.v1");
  assert.equal(receipt.brokerId, "broker-alpha");
  assert.equal(receipt.conversationId, message.conversationId);
  assert.equal(receipt.messageId, message.messageId);
  assert.equal(receipt.sequence, message.sequence);
  assert.equal(receipt.contentDigest, message.contentDigest);
  assert.equal(receipt.deliveryState, "persisted");
  assert.match(receipt.receiptDigest, /^sha256:[0-9a-f]{64}$/);
  // Deterministic: the same inputs produce the same receipt digest.
  const again = buildConversationReceipt(message, "broker-alpha", "2026-08-17T00:00:02Z");
  assert.equal(again.receiptDigest, receipt.receiptDigest);
});

test("validation: malformed envelopes fail closed with precise codes", () => {
  const audit: AuditCapture = { events: [] };
  const store = new Map<string, A2AConversationState>();
  assert.throws(() => openConversation(audit, store, { kind: "shout" }), isBadRequest);
  assert.throws(() => openConversation(audit, store, { schemaVersion: "a2a.conversation-envelope.v2" }), isBadRequest);
  assert.throws(() => openConversation(audit, store, { recipients: [] }), isBadRequest);
  assert.throws(() => openConversation(audit, store, { sender: { kind: "robot", id: "x", homeBrokerId: "b" } }), isBadRequest);
  assert.throws(() => openConversation(audit, store, { clientContentDigest: "md5:zz" }), isBadRequest);
  assert.throws(
    () => openConversation(audit, store, { createdAt: "2026-08-17T01:00:00Z", expiresAt: "2026-08-17T00:00:00Z" }),
    isBadRequest,
  );
  // A client digest that mismatches the broker-computed redacted digest is refused.
  assert.throws(
    () => openConversation(audit, store, { clientContentDigest: `sha256:${"0".repeat(64)}` }),
    (error: unknown) => error instanceof BrokerError && error.code === "bad_request" && /does not match/.test(error.message),
  );
});

test("open rejects worker senders homed at a different broker (no cross-registration)", () => {
  const audit: AuditCapture = { events: [] };
  assert.throws(
    () => openConversation(audit, new Map(), {
      sender: { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" },
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "policy_denied" && /homed at/.test(error.message),
  );
});

function isBadRequest(error: unknown): boolean {
  return error instanceof BrokerError && error.code === "bad_request";
}

function isPolicyDenied(error: unknown): boolean {
  return error instanceof BrokerError && error.code === "policy_denied";
}
