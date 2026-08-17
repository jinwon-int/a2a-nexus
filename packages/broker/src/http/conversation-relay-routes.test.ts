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
