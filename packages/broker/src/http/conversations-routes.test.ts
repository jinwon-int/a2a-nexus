// Trusted Conversation Plane HTTP loop tests (#1862 C2 slice 2; spec #1861).
// Exercises the spec's Broker↔Worker / Worker↔Worker exit criteria through the
// real route handlers: ≥3 round trips between two workers over broker
// mediation, third-party refusal (T6), poll=delivered / consume=processed
// semantics, and replay convergence (T2).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import { handleConversationRoutesIfMatched } from "./conversations-routes.js";

class CapturingResponse extends EventEmitter {
  statusCode?: number;
  body = "";
  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }
  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
}

function jsonRequest(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  return stream;
}

async function call(
  method: string,
  path: string,
  broker: InMemoryA2ABroker,
  options: { body?: unknown; enforceRequesterIdentity?: boolean; requesterIdentity?: { id: string } | null } = {},
) {
  const res = new CapturingResponse();
  const pathOnly = path.split("?")[0];
  const handled = await handleConversationRoutesIfMatched({
    method,
    path: pathOnly,
    segments: pathOnly.split("/").filter(Boolean),
    req: options.body === undefined ? ({} as IncomingMessage) : jsonRequest(options.body),
    res: res as unknown as ServerResponse,
    url: new URL(`http://broker.test${path}`),
    stateStore: {} as BrokerStateStore,
    broker,
    enforceRequesterIdentity: options.enforceRequesterIdentity ?? false,
    requesterIdentity: options.requesterIdentity ?? null,
  });
  return { handled, res, json: JSON.parse(res.body || "{}") };
}

const WORKER_A = { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" };
const WORKER_B = { kind: "worker", id: "worker-b", homeBrokerId: "broker-alpha" };
const THIRD_PARTY = { kind: "worker", id: "worker-z", homeBrokerId: "broker-alpha" };

function envelope(from: typeof WORKER_A, to: typeof WORKER_A, messageId: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    messageId,
    kind: "reply",
    sender: from,
    recipients: [to],
    idempotencyKey: `idem-${messageId}`,
    content: { text },
    ...overrides,
  };
}

test("worker↔worker loop: three round trips over broker mediation with delivered/processed semantics", async () => {
  const broker = new InMemoryA2ABroker();

  // Worker A opens a conversation targeting Worker B (worker→worker open is
  // allowed when the opener is the sender; B is the recipient).
  const opened = await call("POST", "/conversations", broker, {
    body: {
      envelope: envelope(WORKER_A, WORKER_B, "msg-1", "B, can you verify the release notes?", { kind: "question" }),
    },
  });
  assert.equal(opened.handled, true);
  assert.equal(opened.res.statusCode, 201);
  const conversationId = opened.json.conversationId;

  // B polls: the question is delivered (polling never processes it).
  const bInbox1 = await call("GET", `/conversations/${conversationId}/inbox?actor=worker:worker-b:broker-alpha`, broker);
  assert.equal(bInbox1.res.statusCode, 200);
  assert.equal(bInbox1.json.markedDelivered, 1);
  assert.equal(bInbox1.json.entries[0].deliveryState, "delivered");

  // B replies and consumes the question with the reply as evidence.
  const reply1 = await call("POST", `/conversations/${conversationId}/messages`, broker, {
    body: { envelope: envelope(WORKER_B, WORKER_A, "msg-2", "Verified; two items need fixes.") },
  });
  assert.equal(reply1.res.statusCode, 201);
  const consumed1 = await call("POST", `/conversations/${conversationId}/messages/msg-1/processed`, broker, {
    body: { actor: WORKER_B, evidence: { kind: "reply", ref: "msg-2" } },
  });
  assert.equal(consumed1.res.statusCode, 200);
  assert.match(consumed1.json.receipt.receiptDigest, /^sha256:[0-9a-f]{64}$/);

  // A polls, replies, consumes — round trips 2 and 3.
  const aInbox = await call("GET", `/conversations/${conversationId}/inbox?actor=worker:worker-a:broker-alpha`, broker);
  assert.equal(aInbox.json.markedDelivered, 1);
  const reply2 = await call("POST", `/conversations/${conversationId}/messages`, broker, {
    body: { envelope: envelope(WORKER_A, WORKER_B, "msg-3", "Which two? I will patch them.") },
  });
  assert.equal(reply2.json.sequence, 3);
  await call("POST", `/conversations/${conversationId}/messages/msg-2/processed`, broker, {
    body: { actor: WORKER_A, evidence: { kind: "reply", ref: "msg-3" } },
  });

  const bInbox2 = await call("GET", `/conversations/${conversationId}/inbox?actor=worker:worker-b:broker-alpha`, broker);
  assert.equal(bInbox2.json.entries.length, 1);
  assert.equal(bInbox2.json.entries[0].messageId, "msg-3");
  const reply3 = await call("POST", `/conversations/${conversationId}/messages`, broker, {
    body: { envelope: envelope(WORKER_B, WORKER_A, "msg-4", "Items 2 and 5. Done after that.") },
  });
  assert.equal(reply3.json.sequence, 4);
  await call("POST", `/conversations/${conversationId}/messages/msg-3/processed`, broker, {
    body: { actor: WORKER_B, evidence: { kind: "reply", ref: "msg-4" } },
  });

  // Three round trips (msg-1→2, 2→3, 3→4) over broker mediation only.
  const detail = await call("GET", `/conversations/${conversationId}?actor=worker:worker-a:broker-alpha`, broker);
  assert.equal(detail.json.turnCount, 4);
  assert.equal(detail.json.lastAssignedSequence, 4);
});

test("T6: a third worker cannot read, poll, reply, or consume", async () => {
  const broker = new InMemoryA2ABroker();
  const opened = await call("POST", "/conversations", broker, {
    body: { envelope: envelope(WORKER_A, WORKER_B, "msg-1", "status?", { kind: "question" }) },
  });
  const conversationId = opened.json.conversationId;

  await assert.rejects(
    () => call("GET", `/conversations/${conversationId}?actor=worker:worker-z:broker-alpha`, broker),
    (error: unknown) => error instanceof Error && /participant/.test(error.message),
  );
  await assert.rejects(
    () => call("GET", `/conversations/${conversationId}/inbox?actor=worker:worker-z:broker-alpha`, broker),
    (error: unknown) => error instanceof Error && /participant/.test(error.message),
  );
  await assert.rejects(
    () => call("POST", `/conversations/${conversationId}/messages`, broker, {
      body: { envelope: envelope(THIRD_PARTY, WORKER_A, "msg-x", "injecting") },
    }),
    (error: unknown) => error instanceof Error && /participant/.test(error.message),
  );
  // Even a conversation participant cannot consume a message not addressed to it.
  await assert.rejects(
    () => call("POST", `/conversations/${conversationId}/messages/msg-1/processed`, broker, {
      body: { actor: WORKER_A, evidence: { kind: "ack", ref: "self-ack" } },
    }),
    (error: unknown) => error instanceof Error && /not addressed to/.test(error.message),
  );
});

test("T2: replaying the same envelope converges (200) without consuming a sequence", async () => {
  const broker = new InMemoryA2ABroker();
  const opened = await call("POST", "/conversations", broker, {
    body: { envelope: envelope(WORKER_A, WORKER_B, "msg-1", "hello", { kind: "question" }) },
  });
  const conversationId = opened.json.conversationId;

  const first = await call("POST", `/conversations/${conversationId}/messages`, broker, {
    body: { envelope: envelope(WORKER_B, WORKER_A, "msg-2", "first reply") },
  });
  assert.equal(first.res.statusCode, 201);
  const replay = await call("POST", `/conversations/${conversationId}/messages`, broker, {
    body: { envelope: envelope(WORKER_B, WORKER_A, "msg-2", "first reply") },
  });
  assert.equal(replay.res.statusCode, 200);
  assert.equal(replay.json.outcome, "converged");
  const detail = await call("GET", `/conversations/${conversationId}?actor=worker:worker-a:broker-alpha`, broker);
  assert.equal(detail.json.lastAssignedSequence, 2);
});

test("consumed messages require evidence and cannot be re-processed", async () => {
  const broker = new InMemoryA2ABroker();
  const opened = await call("POST", "/conversations", broker, {
    body: { envelope: envelope(WORKER_A, WORKER_B, "msg-1", "ping", { kind: "question" }) },
  });
  const conversationId = opened.json.conversationId;

  await assert.rejects(
    () => call("POST", `/conversations/${conversationId}/messages/msg-1/processed`, broker, {
      body: { actor: WORKER_B },
    }),
    (error: unknown) => error instanceof Error && /evidence/.test(error.message),
  );

  await call("POST", `/conversations/${conversationId}/messages/msg-1/processed`, broker, {
    body: { actor: WORKER_B, evidence: { kind: "ack", ref: "ack-1" } },
  });
  await assert.rejects(
    () => call("POST", `/conversations/${conversationId}/messages/msg-1/processed`, broker, {
      body: { actor: WORKER_B, evidence: { kind: "ack", ref: "ack-2" } },
    }),
    (error: unknown) => error instanceof Error && /cannot transition/.test(error.message),
  );
});

test("requester identity enforcement binds the sender on writes and polls", async () => {
  const broker = new InMemoryA2ABroker();
  // Open fails when the authenticated requester is not the envelope sender.
  await assert.rejects(
    () => call("POST", "/conversations", broker, {
      body: { envelope: envelope(WORKER_A, WORKER_B, "msg-1", "spoof?", { kind: "question" }) },
      enforceRequesterIdentity: true,
      requesterIdentity: { id: "worker-z" },
    }),
    (error: unknown) => error instanceof Error && /requester/.test(error.message),
  );

  const opened = await call("POST", "/conversations", broker, {
    body: { envelope: envelope(WORKER_A, WORKER_B, "msg-1", "status?", { kind: "question" }) },
    enforceRequesterIdentity: true,
    requesterIdentity: { id: "worker-a" },
  });
  const conversationId = opened.json.conversationId;
  await assert.rejects(
    () => call("GET", `/conversations/${conversationId}/inbox?actor=worker:worker-b:broker-alpha`, broker, {
      enforceRequesterIdentity: true,
      requesterIdentity: { id: "worker-a" },
    }),
    (error: unknown) => error instanceof Error && /requester/.test(error.message),
  );
});

test("conversation state survives broker rehydration from the snapshot", async () => {
  const broker = new InMemoryA2ABroker();
  const opened = await call("POST", "/conversations", broker, {
    body: { envelope: envelope(WORKER_A, WORKER_B, "msg-1", "persisted?", { kind: "question" }) },
  });
  const conversationId = opened.json.conversationId;
  const snapshot = broker.exportSnapshot();
  assert.ok((snapshot.conversations ?? []).length === 1);

  const revived = new InMemoryA2ABroker(undefined, snapshot);
  const detail = await call("GET", `/conversations/${conversationId}?actor=worker:worker-a:broker-alpha`, revived);
  assert.equal(detail.json.conversationId, conversationId);
  assert.equal(detail.json.lastAssignedSequence, 1);
  // The sequence authority continues gap-free after the restart.
  const next = await call("POST", `/conversations/${conversationId}/messages`, revived, {
    body: { envelope: envelope(WORKER_B, WORKER_A, "msg-2", "after restart") },
  });
  assert.equal(next.json.sequence, 2);
});
