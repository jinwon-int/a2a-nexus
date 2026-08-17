// Trusted Conversation Plane relay tests (#1864 slice 2; spec #1861).
// Threats owned here: T7 (peer trust abuse — sender proof binds the payload),
// T8 (at-least-once redelivery collapses), T9 (sequence gap blocks, never
// skips; lost lineage head blocks for resync), T12 (wrong destination
// refused). Exercises the two-broker shape with two InMemoryA2ABroker
// instances wired through the real route handlers.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import { sha256Hex, parsePeerCredentialRegistry } from "../core/request-security.js";
import { buildCrossBrokerSenderProof, CrossBrokerNonceCache, type CrossBrokerTrustAnchors } from "../a2a/cross-broker-sender-proof.js";
import { handleConversationRelayRoutesIfMatched } from "./conversation-relay-routes.js";

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

const SECRET_A = "relay-secret-alpha";
const SECRET_B = "relay-secret-beta";

function brokerRegistry() {
  return parsePeerCredentialRegistry(
    {
      "broker-alpha": { secretSha256: sha256Hex(SECRET_A), scopes: ["conversation:send", "conversation:relay"] },
      "broker-beta": { secretSha256: sha256Hex(SECRET_B), scopes: ["conversation:send", "conversation:relay"] },
    },
    "test",
  );
}

function peerHeaders(brokerId: string, secret: string): Record<string, string> {
  return { "x-a2a-peer-broker-id": brokerId, "x-a2a-peer-secret": secret };
}

async function callRelay(
  broker: InMemoryA2ABroker,
  options: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    anchors?: CrossBrokerTrustAnchors | null;
    nonceCache?: CrossBrokerNonceCache;
  },
) {
  const res = new CapturingResponse();
  const req = (options.body === undefined
    ? Readable.from([])
    : Readable.from([JSON.stringify(options.body)])) as unknown as IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = options.headers ?? {};
  const pathOnly = options.path.split("?")[0];
  const handled = await handleConversationRelayRoutesIfMatched({
    method: options.method,
    path: pathOnly,
    req,
    res: res as unknown as ServerResponse,
    url: new URL(`http://broker.test${options.path}`), // keeps the query for param parsing
    broker,
    stateStore: {} as BrokerStateStore,
    crossBrokerTrustAnchors: options.anchors ?? null,
    crossBrokerNonceCache: options.nonceCache,
    peerCredentialRegistry: brokerRegistry(),
    peerHandoffScopeMode: "auto",
  });
  return { handled, res, json: JSON.parse(res.body || "{}") };
}

function openCrossBrokerConversation(broker: InMemoryA2ABroker) {
  return broker.startConversation({
    homeBrokerId: "broker-alpha",
    envelope: {
      messageId: "msg-1",
      kind: "question",
      sender: { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" },
      recipients: [
        { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" },
      ],
      idempotencyKey: "idem-1",
      content: { text: "Question for the beta worker" },
    },
  });
}

test("T8: pull → relay apply → redelivery collapses without re-applying", async () => {
  const alpha = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const beta = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-beta" });
  const { conversation } = openCrossBrokerConversation(alpha);
  alpha.enqueueConversationRelay(conversation.conversationId, "msg-1", "broker-beta");

  // broker-beta pulls alpha's outbox with its own peer credential.
  const pulled = await callRelay(alpha, {
    method: "GET",
    path: "/peer/conversations/outbox?cursor=0&limit=10",
    headers: peerHeaders("broker-beta", SECRET_B),
  });
  assert.equal(pulled.json.entries.length, 1);
  const entry = pulled.json.entries[0];
  assert.equal(entry.destinationBrokerId, "broker-beta");

  // Beta applies the payload (built from the entry's fields).
  const payload = alpha.buildConversationRelayPayload(conversation.conversationId, "msg-1", "broker-beta");
  const applied = await callRelay(beta, {
    method: "POST",
    path: "/peer/conversations/relay",
    body: payload,
    headers: peerHeaders("broker-alpha", SECRET_A),
  });
  assert.equal(applied.res.statusCode, 200);
  assert.equal(applied.json.outcome, "applied");

  // At-least-once redelivery of the SAME payload collapses (T8).
  const duplicate = await callRelay(beta, {
    method: "POST",
    path: "/peer/conversations/relay",
    body: payload,
    headers: peerHeaders("broker-alpha", SECRET_A),
  });
  assert.equal(duplicate.res.statusCode, 200);
  assert.equal(duplicate.json.outcome, "duplicate");

  // The mirror inbox exposes the message to the local recipient once.
  const inbox = beta.pollRelayMirrorInbox(conversation.conversationId, { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" });
  assert.equal(inbox.entries.length, 1);
  assert.equal(inbox.entries[0].messageId, "msg-1");
});

test("T9: a sequence gap blocks (409) and never skips ahead", async () => {
  const alpha = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const beta = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-beta" });
  const { conversation } = openCrossBrokerConversation(alpha);

  // Relay seq=2 first (seq=1 lost) — the receiver must block for resync.
  alpha.addConversationMessage(conversation.conversationId, {
    messageId: "msg-2",
    kind: "reply",
    sender: { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" },
    recipients: [{ kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" }],
    idempotencyKey: "idem-2",
    content: { text: "second message before the first arrived" },
  });
  const payload2 = alpha.buildConversationRelayPayload(conversation.conversationId, "msg-2", "broker-beta");
  const blocked = await callRelay(beta, {
    method: "POST",
    path: "/peer/conversations/relay",
    body: payload2,
    headers: peerHeaders("broker-alpha", SECRET_A),
  });
  assert.equal(blocked.res.statusCode, 409);
  assert.equal(blocked.json.outcome, "blocked");
  assert.equal(blocked.json.expectedSequence, 1);
  assert.equal(blocked.json.resyncRequired, true);

  // After resync (seq=1 applied), seq=2 lands cleanly — no skip-ahead happened.
  const payload1 = alpha.buildConversationRelayPayload(conversation.conversationId, "msg-1", "broker-beta");
  const applied1 = await callRelay(beta, {
    method: "POST",
    path: "/peer/conversations/relay",
    body: payload1,
    headers: peerHeaders("broker-alpha", SECRET_A),
  });
  assert.equal(applied1.json.outcome, "applied");
  const applied2 = await callRelay(beta, {
    method: "POST",
    path: "/peer/conversations/relay",
    body: payload2,
    headers: peerHeaders("broker-alpha", SECRET_A),
  });
  assert.equal(applied2.json.outcome, "applied");
});

test("T12: a relay addressed to a different broker is refused", async () => {
  const alpha = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const beta = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-beta" });
  const { conversation } = openCrossBrokerConversation(alpha);
  const payload = alpha.buildConversationRelayPayload(conversation.conversationId, "msg-1", "broker-gamma");
  await assert.rejects(
    () => callRelay(beta, {
      method: "POST",
      path: "/peer/conversations/relay",
      body: payload,
      headers: peerHeaders("broker-alpha", SECRET_A),
    }),
    (error: unknown) => error instanceof Error && /addressed to broker broker-gamma/.test(error.message),
  );
});

test("T7: with trust anchors configured, the relay requires a valid request-bound sender proof", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const alpha = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const beta = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-beta" });
  const anchors = new Map([["broker-alpha", publicKey.export({ type: "spki", format: "pem" }).toString()]]);
  const nonceCache = new CrossBrokerNonceCache();
  const { conversation } = openCrossBrokerConversation(alpha);
  const payload = alpha.buildConversationRelayPayload(conversation.conversationId, "msg-1", "broker-beta");

  // No proof → rejected.
  await assert.rejects(
    () => callRelay(beta, {
      method: "POST",
      path: "/peer/conversations/relay",
      body: payload,
      headers: peerHeaders("broker-alpha", SECRET_A),
      anchors,
      nonceCache,
    }),
    (error: unknown) => error instanceof Error && /sender proof rejected/.test(error.message),
  );

  // Proof over a DIFFERENT body → bodyHash mismatch → rejected.
  const wrongBodyProof = buildCrossBrokerSenderProof(privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
    brokerId: "broker-alpha",
    body: { ...payload, message: { ...payload.message, content: { text: "tampered" } } } as Record<string, unknown>,
    nonce: "nonce-wrong-body",
  });
  await assert.rejects(
    () => callRelay(beta, {
      method: "POST",
      path: "/peer/conversations/relay",
      body: { ...payload, senderProof: wrongBodyProof },
      headers: peerHeaders("broker-alpha", SECRET_A),
      anchors,
      nonceCache,
    }),
    (error: unknown) => error instanceof Error && /bodyHash does not match/.test(error.message),
  );

  // Valid proof over the real payload → applied.
  const proof = buildCrossBrokerSenderProof(privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
    brokerId: "broker-alpha",
    body: payload as unknown as Record<string, unknown>,
    nonce: "nonce-1",
  });
  const applied = await callRelay(beta, {
    method: "POST",
    path: "/peer/conversations/relay",
    body: { ...payload, senderProof: proof },
    headers: peerHeaders("broker-alpha", SECRET_A),
    anchors,
    nonceCache,
  });
  assert.equal(applied.json.outcome, "applied");

  // Replay of the same proof nonce with new content → replay-rejected (T7/T2).
  const secondProof = buildCrossBrokerSenderProof(privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
    brokerId: "broker-alpha",
    body: payload as unknown as Record<string, unknown>,
    nonce: "nonce-1",
  });
  await assert.rejects(
    () => callRelay(beta, {
      method: "POST",
      path: "/peer/conversations/relay",
      body: { ...payload, senderProof: secondProof },
      headers: peerHeaders("broker-alpha", SECRET_A),
      anchors,
      nonceCache,
    }),
    (error: unknown) => error instanceof Error && /sender proof rejected/.test(error.message),
  );
});

test("peer scope enforcement: outbox pull without credentials fails closed; wrong secret is refused", async () => {
  const alpha = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const { conversation } = openCrossBrokerConversation(alpha);
  alpha.enqueueConversationRelay(conversation.conversationId, "msg-1", "broker-beta");

  await assert.rejects(
    () => callRelay(alpha, { method: "GET", path: "/peer/conversations/outbox?cursor=0", headers: {} }),
    (error: unknown) => error instanceof Error && /requires peer credentials/.test(error.message),
  );
  await assert.rejects(
    () => callRelay(alpha, {
      method: "GET",
      path: "/peer/conversations/outbox?cursor=0",
      headers: peerHeaders("broker-beta", "wrong-secret"),
    }),
    (error: unknown) => error instanceof Error,
  );
});

test("relay outbox and mirrors survive snapshot rehydration with cursor continuity", async () => {
  const alpha = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const beta = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-beta" });
  const { conversation } = openCrossBrokerConversation(alpha);
  alpha.enqueueConversationRelay(conversation.conversationId, "msg-1", "broker-beta");

  const payload = alpha.buildConversationRelayPayload(conversation.conversationId, "msg-1", "broker-beta");
  await callRelay(beta, {
    method: "POST",
    path: "/peer/conversations/relay",
    body: payload,
    headers: peerHeaders("broker-alpha", SECRET_A),
  });

  const alphaRevived = new InMemoryA2ABroker(undefined, alpha.exportSnapshot(), { brokerId: "broker-alpha" });
  const pulled = await callRelay(alphaRevived, {
    method: "GET",
    path: "/peer/conversations/outbox?cursor=0",
    headers: peerHeaders("broker-beta", SECRET_B),
  });
  assert.equal(pulled.json.entries.length, 1);

  const betaRevived = new InMemoryA2ABroker(undefined, beta.exportSnapshot(), { brokerId: "broker-beta" });
  const inbox = betaRevived.pollRelayMirrorInbox(conversation.conversationId, { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" });
  assert.equal(inbox.entries.length, 1);
});

// ---------------------------------------------------------------------------
// C5 (#1865): cross-broker worker↔worker routing — full lineage convergence
// ---------------------------------------------------------------------------

import { handleConversationRoutesIfMatched } from "./conversations-routes.js";

async function callConversation(
  broker: InMemoryA2ABroker,
  options: { method: string; path: string; body?: unknown },
) {
  const res = new CapturingResponse();
  const pathOnly = options.path.split("?")[0];
  const req = (options.body === undefined
    ? Readable.from([])
    : Readable.from([JSON.stringify(options.body)])) as unknown as IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = {};
  const handled = await handleConversationRoutesIfMatched({
    method: options.method,
    path: pathOnly,
    segments: pathOnly.split("/").filter(Boolean),
    req,
    res: res as unknown as ServerResponse,
    url: new URL(`http://broker.test${options.path}`),
    stateStore: {} as BrokerStateStore,
    broker,
    enforceRequesterIdentity: false,
    requesterIdentity: null,
  });
  return { handled, res, json: JSON.parse(res.body || "{}") };
}

async function pullAndApplyAll(
  from: InMemoryA2ABroker,
  to: InMemoryA2ABroker,
  pullerBrokerId: string,
  pullerSecret: string,
): Promise<string[]> {
  const outcomes: string[] = [];
  let cursor = 0;
  for (;;) {
    const pulled = await callRelay(from, {
      method: "GET",
      path: `/peer/conversations/outbox?cursor=${cursor}&limit=50`,
      headers: peerHeaders(pullerBrokerId, pullerSecret),
    });
    if (!pulled.json.entries?.length) break;
    for (const entry of pulled.json.entries) {
      if (!entry.payload) continue;
      const applied = await callRelay(to, {
        method: "POST",
        path: "/peer/conversations/relay",
        body: entry.payload,
        headers: { "x-a2a-peer-broker-id": entry.payload.senderBrokerId, "x-a2a-peer-secret": entry.payload.senderBrokerId === "broker-alpha" ? SECRET_A : SECRET_B },
      });
      outcomes.push(String(applied.json.outcome));
      cursor = entry.cursor;
    }
  }
  return outcomes;
}

test("C5: A→brokerA→brokerB→B question and reverse reply converge into ONE lineage", async () => {
  const alpha = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const beta = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-beta" });

  // 1) worker-a@alpha opens a conversation targeting worker-b@beta.
  const opened = await callConversation(alpha, {
    method: "POST",
    path: "/conversations",
    body: {
      envelope: {
        messageId: "msg-1",
        kind: "question",
        sender: { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" },
        recipients: [{ kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" }],
        idempotencyKey: "idem-1",
        content: { text: "cross-broker question" },
      },
    },
  });
  const conversationId = opened.json.conversationId;
  alpha.enqueueConversationRelay(conversationId, "msg-1", "broker-beta");

  // 2) beta pulls and applies → mirror; worker-b sees it in its inbox.
  const forward = await pullAndApplyAll(alpha, beta, "broker-beta", SECRET_B);
  assert.deepEqual(forward, ["applied"]);
  const bInbox = beta.pollRelayMirrorInbox(conversationId, { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" });
  assert.equal(bInbox.entries.length, 1);

  // 3) worker-b replies ON THE MIRROR → queued for relay to the home broker.
  const queued = await callConversation(beta, {
    method: "POST",
    path: `/conversations/${conversationId}/messages`,
    body: {
      envelope: {
        messageId: "msg-2",
        kind: "reply",
        sender: { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" },
        recipients: [{ kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" }],
        idempotencyKey: "idem-2",
        content: { text: "cross-broker answer" },
      },
    },
  });
  assert.equal(queued.res.statusCode, 202);
  assert.equal(queued.json.outcome, "queued");

  // 4) worker-b consumes the mirrored question with the reply as evidence —
  //    mirror processed + receipt + a deterministic ack queued for the home broker.
  const consumed = await callConversation(beta, {
    method: "POST",
    path: `/conversations/${conversationId}/messages/msg-1/processed`,
    body: {
      actor: { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" },
      evidence: { kind: "reply", ref: "msg-2" },
    },
  });
  assert.equal(consumed.res.statusCode, 200);
  assert.equal(consumed.json.ackQueued, true);
  assert.equal(consumed.json.ackMessageId, "ack-msg-1");
  assert.equal(consumed.json.receipt.brokerId, "broker-beta");

  // 5) alpha pulls beta's outbox and applies → the reply AND the ack land in
  //    the ORIGINAL conversation with home-assigned sequences (one lineage).
  const reverse = await pullAndApplyAll(beta, alpha, "broker-alpha", SECRET_A);
  assert.deepEqual(reverse, ["applied", "applied"]);
  const original = alpha.getConversation(conversationId);
  assert.ok(original, "original conversation exists at the home broker");
  assert.equal(original.messagesById["msg-2"].sequence, 2); // home broker assigned
  assert.equal(original.messagesById["msg-2"].sender.homeBrokerId, "broker-beta");
  assert.equal(original.messagesById["ack-msg-1"].kind, "ack");
  assert.equal(original.messagesById["ack-msg-1"].sequence, 3);
  assert.equal(original.lastAssignedSequence, 3);

  // 6) ONE lineage: alpha relays the applied reply back; beta's mirror advances.
  alpha.enqueueConversationRelay(conversationId, "msg-2", "broker-beta");
  // The pull walks the append-only outbox from cursor 0, so the earlier
  // forward entry redelivers first (collapses as duplicate — T8) before the
  // new back-relay entry applies.
  const back = await pullAndApplyAll(alpha, beta, "broker-beta", SECRET_B);
  assert.deepEqual(back, ["duplicate", "applied"]);
  const mirror = beta.pollRelayMirrorInbox(conversationId, { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" });
  assert.equal(mirror.entries.filter((entry: { messageId: string }) => entry.messageId === "msg-2").length, 1);

  // 7) No cross-registration: beta never registered worker-a, alpha never
  //    registered worker-b — the actors exist only as envelope participants.
  assert.equal(alpha.getWorkerView ? alpha.getWorkerView("worker-b", 30_000) : null, null);
  assert.equal(beta.getWorkerView ? beta.getWorkerView("worker-a", 30_000) : null, null);
  assert.ok(original.participants.includes("worker:worker-b:broker-beta"));
});

test("C5 resync: re-pulling from cursor 0 after loss re-applies idempotently (no loss, no duplication)", async () => {
  const alpha = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const beta = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-beta" });
  const opened = await callConversation(alpha, {
    method: "POST",
    path: "/conversations",
    body: {
      envelope: {
        messageId: "msg-1",
        kind: "question",
        sender: { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" },
        recipients: [{ kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" }],
        idempotencyKey: "idem-1",
        content: { text: "question" },
      },
    },
  });
  const conversationId = opened.json.conversationId;
  alpha.enqueueConversationRelay(conversationId, "msg-1", "broker-beta");

  await pullAndApplyAll(alpha, beta, "broker-beta", SECRET_B);

  // Simulate cursor loss / operator resync: pull from cursor 0 again and
  // re-apply everything — duplicates collapse, nothing is lost or duplicated.
  const resyncOutcomes = await pullAndApplyAll(alpha, beta, "broker-beta", SECRET_B);
  assert.deepEqual(resyncOutcomes, ["duplicate"]);
  const mirrorInbox = beta.pollRelayMirrorInbox(conversationId, { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" });
  assert.equal(mirrorInbox.entries.length, 1);

  // Reverse direction after alpha restart (snapshot rehydration): the outbox
  // still serves the entry and re-apply at the home broker is idempotent.
  const revivedAlpha = new InMemoryA2ABroker(undefined, alpha.exportSnapshot(), { brokerId: "broker-alpha" });
  const revived = await pullAndApplyAll(revivedAlpha, beta, "broker-beta", SECRET_B);
  assert.deepEqual(revived, ["duplicate"]);
});

test("C5 mirror consume: evidence required, recipient-only, ack converges idempotently into the home lineage", async () => {
  const alpha = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-alpha" });
  const beta = new InMemoryA2ABroker(undefined, undefined, { brokerId: "broker-beta" });
  const opened = await callConversation(alpha, {
    method: "POST",
    path: "/conversations",
    body: {
      envelope: {
        messageId: "msg-1",
        kind: "question",
        sender: { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" },
        recipients: [{ kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" }],
        idempotencyKey: "idem-1",
        content: { text: "question" },
      },
    },
  });
  const conversationId = opened.json.conversationId;
  alpha.enqueueConversationRelay(conversationId, "msg-1", "broker-beta");
  await pullAndApplyAll(alpha, beta, "broker-beta", SECRET_B);
  beta.pollRelayMirrorInbox(conversationId, { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" });

  // Missing evidence fails closed.
  await assert.rejects(
    () => callConversation(beta, {
      method: "POST",
      path: `/conversations/${conversationId}/messages/msg-1/processed`,
      body: { actor: { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" } },
    }),
    (error: unknown) => error instanceof Error && /evidence/.test(error.message),
  );

  // A participant that is not a recipient of the message cannot consume it.
  await assert.rejects(
    () => callConversation(beta, {
      method: "POST",
      path: `/conversations/${conversationId}/messages/msg-1/processed`,
      body: {
        actor: { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" },
        evidence: { kind: "ack", ref: "self-ack" },
      },
    }),
    (error: unknown) => error instanceof Error && /not addressed to/.test(error.message),
  );

  // A third worker is not even a participant.
  await assert.rejects(
    () => callConversation(beta, {
      method: "POST",
      path: `/conversations/${conversationId}/messages/msg-1/processed`,
      body: {
        actor: { kind: "worker", id: "worker-z", homeBrokerId: "broker-beta" },
        evidence: { kind: "ack", ref: "z" },
      },
    }),
    (error: unknown) => error instanceof Error && /participant/.test(error.message),
  );

  // Valid consume: receipt from the mirror-holding broker + ack queued.
  const consumed = await callConversation(beta, {
    method: "POST",
    path: `/conversations/${conversationId}/messages/msg-1/processed`,
    body: {
      actor: { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" },
      evidence: { kind: "ack", ref: "read" },
    },
  });
  assert.equal(consumed.res.statusCode, 200);
  assert.equal(consumed.json.receipt.brokerId, "broker-beta");
  assert.match(consumed.json.receipt.receiptDigest, /^sha256:[0-9a-f]{64}$/);

  // The mirror's message is processed and cannot re-process.
  await assert.rejects(
    () => callConversation(beta, {
      method: "POST",
      path: `/conversations/${conversationId}/messages/msg-1/processed`,
      body: {
        actor: { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" },
        evidence: { kind: "ack", ref: "again" },
      },
    }),
    (error: unknown) => error instanceof Error && /cannot transition/.test(error.message),
  );

  // The ack converges into the home lineage; re-pulling collapses (T8).
  const applied = await pullAndApplyAll(beta, alpha, "broker-alpha", SECRET_A);
  assert.deepEqual(applied, ["applied"]);
  const original = alpha.getConversation(conversationId);
  assert.ok(original, "original conversation exists at the home broker");
  assert.equal(original.messagesById["ack-msg-1"].kind, "ack");
  assert.equal(original.messagesById["ack-msg-1"].sequence, 2);
  const resync = await pullAndApplyAll(beta, alpha, "broker-alpha", SECRET_A);
  assert.deepEqual(resync, ["duplicate"]);
});
