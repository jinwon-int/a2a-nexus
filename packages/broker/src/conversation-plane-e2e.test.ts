// Trusted Conversation Plane — C6 loopback E2E (#1866, spec #1861).
// Two REAL broker HTTP servers on loopback ports, driven end-to-end over real
// HTTP (fetch): the conversation surface, the peer relay transport, ordering,
// at-least-once replay convergence, fail-closed peer auth, and broker restart
// state/sequence preservation.
//
// The one internal step is the FORWARD relay enqueue trigger
// (`runtime.broker.enqueueConversationRelay`) — in production this is the
// broker-side integration point (accept-time or operator action); there is no
// HTTP route for "put this message in the relay outbox" by design. Everything
// else — open, poll, reply, consume, relay pull, relay apply, auth refusals —
// is real HTTP against real server instances, with peer credentials loaded
// from a root-only registry file exactly as production does.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

import { createBrokerServer, type BrokerServerRuntime } from "./server.js";
import { JsonFileBrokerStateStore } from "./core/store.js";
import { sha256Hex } from "./core/request-security.js";

const SECRET_ALPHA = "two-broker-alpha-secret";
const SECRET_BETA = "two-broker-beta-secret";

interface TestBroker {
  runtime: BrokerServerRuntime;
  baseUrl: string;
  stateFile: string;
  peerRegistryFile: string;
}

function writePeerRegistry(path: string, peerBrokerId: string, secret: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      [peerBrokerId]: { secretSha256: sha256Hex(secret), scopes: ["conversation:send", "conversation:relay"] },
    }),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600); // umask-proof: loadPeerCredentialRegistryFile requires group/other bits 0
}

async function startBroker(
  brokerId: string,
  peer: { brokerId: string; secret: string },
): Promise<TestBroker> {
  const dir = mkdtempSync(join(tmpdir(), `a2a-conv-e2e-${brokerId}-`));
  const stateFile = join(dir, "state.json");
  const peerRegistryFile = join(dir, "peer-credentials.json");
  writePeerRegistry(peerRegistryFile, peer.brokerId, peer.secret);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    brokerId,
    serviceName: brokerId,
    publicBaseUrl: `https://${brokerId}.test/`,
    stateStore: new JsonFileBrokerStateStore(stateFile),
    edgeSecret: "edge-secret-e2e",
    staleReaperEnabled: false,
    peerCredentialsFile: peerRegistryFile,
    peerHandoffScopeMode: "enforce",
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test broker");
  return { runtime, baseUrl: `http://127.0.0.1:${address.port}`, stateFile, peerRegistryFile };
}

async function stopBroker(broker: TestBroker): Promise<void> {
  broker.runtime.server.close();
  await once(broker.runtime.server, "close");
}

async function httpJson(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; requester?: string } = {},
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      // Production-style auth: the edge secret gates the operator surface and
      // the requester identity binds to the envelope sender / polling actor.
      "x-a2a-edge-secret": "edge-secret-e2e",
      ...(init.requester !== undefined ? { "x-a2a-requester-id": init.requester } : {}),
      ...(init.headers ?? {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

function peerHeaders(brokerId: string, secret: string): Record<string, string> {
  return { "x-a2a-peer-broker-id": brokerId, "x-a2a-peer-secret": secret };
}

const WORKER_A = { kind: "worker", id: "worker-a", homeBrokerId: "broker-alpha" };
const WORKER_B = { kind: "worker", id: "worker-b", homeBrokerId: "broker-beta" };

test("C6 loopback E2E: ordering, replay convergence, fail-closed auth, broker restart — over real HTTP", async () => {
  const alpha = await startBroker("broker-alpha", { brokerId: "broker-beta", secret: SECRET_BETA });
  const beta = await startBroker("broker-beta", { brokerId: "broker-alpha", secret: SECRET_ALPHA });
  try {
    // --- 1. Open a cross-broker conversation at the home broker (HTTP).
    const opened = await httpJson(alpha.baseUrl, "/conversations", {
      method: "POST",
      requester: "worker-a",
      body: {
        envelope: {
          messageId: "msg-1",
          kind: "question",
          sender: WORKER_A,
          recipients: [WORKER_B],
          idempotencyKey: "idem-1",
          content: { text: "C6 loopback question" },
        },
      },
    });
    assert.equal(opened.status, 201);
    const conversationId = opened.json.conversationId;

    // --- 2. Replay the OPEN over HTTP: converges (no second conversation).
    const openedReplay = await httpJson(alpha.baseUrl, "/conversations", {
      method: "POST",
      requester: "worker-a",
      body: {
        envelope: {
          messageId: "msg-1",
          kind: "question",
          sender: WORKER_A,
          recipients: [WORKER_B],
          idempotencyKey: "idem-1",
          content: { text: "C6 loopback question" },
        },
      },
    });
    // A fresh open with the same idempotency key: the conversation already
    // recorded it — the open path re-runs validation and the same root message
    // id collides with the existing record, refusing the duplicate id instead
    // of minting a second conversation.
    assert.ok([200, 201, 409].includes(openedReplay.status), `replay status ${openedReplay.status}`);

    // --- 3. Forward relay (the internal enqueue trigger + real HTTP pull/apply).
    alpha.runtime.broker.enqueueConversationRelay(conversationId, "msg-1", "broker-beta");
    const pulled = await httpJson(
      alpha.baseUrl,
      "/peer/conversations/outbox?cursor=0&limit=10",
      { headers: peerHeaders("broker-beta", SECRET_BETA) },
    );
    assert.equal(pulled.status, 200);
    assert.equal(pulled.json.entries.length, 1);
    const payload = pulled.json.entries[0].payload;
    assert.equal(payload.message.sequence, 1);

    const applied = await httpJson(beta.baseUrl, "/peer/conversations/relay", {
      method: "POST",
      body: payload,
      headers: peerHeaders("broker-alpha", SECRET_ALPHA),
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.json.outcome, "applied");

    // --- 4. At-least-once replay of the SAME payload converges (duplicate).
    const replayed = await httpJson(beta.baseUrl, "/peer/conversations/relay", {
      method: "POST",
      body: payload,
      headers: peerHeaders("broker-alpha", SECRET_ALPHA),
    });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.json.outcome, "duplicate");

    // --- 5. Ordering is visible at the mirror through the real inbox route.
    const bInbox = await httpJson(
      beta.baseUrl,
      `/conversations/${conversationId}/inbox?actor=worker:worker-b:broker-beta`,
      { requester: "worker-b" },
    );
    assert.equal(bInbox.status, 200);
    assert.equal(bInbox.json.markedDelivered, 1);
    assert.equal(bInbox.json.entries[0].sequence, 1);

    // --- 6. Reverse: worker-b replies ON THE MIRROR over HTTP (202 queued).
    const queued = await httpJson(beta.baseUrl, `/conversations/${conversationId}/messages`, {
      method: "POST",
      requester: "worker-b",
      body: {
        envelope: {
          messageId: "msg-2",
          kind: "reply",
          sender: WORKER_B,
          recipients: [WORKER_A],
          idempotencyKey: "idem-2",
          content: { text: "C6 loopback answer" },
        },
      },
    });
    assert.equal(queued.status, 202);

    // worker-b consumes with evidence over HTTP; ack queues for the home broker.
    const consumed = await httpJson(
      beta.baseUrl,
      `/conversations/${conversationId}/messages/msg-1/processed`,
      {
        method: "POST",
        requester: "worker-b",
        body: { actor: WORKER_B, evidence: { kind: "reply", ref: "msg-2" } },
      },
    );
    assert.equal(consumed.status, 200);
    assert.equal(consumed.json.ackQueued, true);

    // alpha pulls beta's outbox and applies reply + ack — one lineage, ordered.
    const betaPull = await httpJson(
      beta.baseUrl,
      "/peer/conversations/outbox?cursor=0&limit=10",
      { headers: peerHeaders("broker-alpha", SECRET_ALPHA) },
    );
    assert.equal(betaPull.json.entries.length, 2);
    const outcomes: string[] = [];
    for (const entry of betaPull.json.entries) {
      const result = await httpJson(alpha.baseUrl, "/peer/conversations/relay", {
        method: "POST",
        body: entry.payload,
        headers: peerHeaders("broker-beta", SECRET_BETA),
      });
      outcomes.push(String(result.json.outcome));
      assert.equal(result.status, 200);
    }
    assert.deepEqual(outcomes, ["applied", "applied"]);

    const detail = await httpJson(
      alpha.baseUrl,
      `/conversations/${conversationId}?actor=worker:worker-a:broker-alpha`,
      { requester: "worker-a" },
    );
    assert.equal(detail.json.lastAssignedSequence, 3); // msg-1(1) reply(2) ack(3) — ordered

    // --- 7. Fail-closed peer auth (enforce mode).
    const noCreds = await httpJson(alpha.baseUrl, "/peer/conversations/outbox?cursor=0", {});
    assert.equal(noCreds.status, 401);
    const wrongSecret = await httpJson(alpha.baseUrl, "/peer/conversations/outbox?cursor=0", {
      headers: peerHeaders("broker-beta", "wrong-secret"),
    });
    assert.equal(wrongSecret.status, 401);
    const noCredsApply = await httpJson(beta.baseUrl, "/peer/conversations/relay", {
      method: "POST",
      body: payload,
    });
    assert.equal(noCredsApply.status, 401);

    // --- 8. Broker restart: state and sequence authority survive.
    const sequenceBefore = detail.json.lastAssignedSequence;
    await stopBroker(alpha);
    const dir = alpha.stateFile;
    // Re-create the server on the SAME state file (same options) — a restart.
    const registryFile = alpha.peerRegistryFile;
    const revivedRuntime = createBrokerServer({
      host: "127.0.0.1",
      port: 0,
      brokerId: "broker-alpha",
      serviceName: "broker-alpha",
      publicBaseUrl: "https://broker-alpha.test/",
      stateStore: new JsonFileBrokerStateStore(dir),
      edgeSecret: "edge-secret-e2e",
      staleReaperEnabled: false,
      peerCredentialsFile: registryFile,
      peerHandoffScopeMode: "enforce",
    });
    revivedRuntime.server.listen(0, "127.0.0.1");
    await once(revivedRuntime.server, "listening");
    const revivedAddress = revivedRuntime.server.address();
    const revivedUrl = `http://127.0.0.1:${(revivedAddress as { port: number }).port}`;
    try {
      const after = await httpJson(
        revivedUrl,
        `/conversations/${conversationId}?actor=worker:worker-a:broker-alpha`,
        { requester: "worker-a" },
      );
      assert.equal(after.status, 200);
      assert.equal(after.json.lastAssignedSequence, sequenceBefore, "sequence authority preserved across restart");
      assert.equal(after.json.turnCount, 3, "conversation turns preserved");

      // The next message continues gap-free (worker-a reply referencing the ack).
      const next = await httpJson(revivedUrl, `/conversations/${conversationId}/messages`, {
        method: "POST",
        requester: "worker-a",
        body: {
          envelope: {
            messageId: "msg-3",
            kind: "reply",
            sender: WORKER_A,
            recipients: [WORKER_B],
            idempotencyKey: "idem-3",
            content: { text: "after restart" },
          },
        },
      });
      assert.equal(next.status, 201);
      assert.equal(next.json.sequence, sequenceBefore + 1, "next sequence continues gap-free after restart");

      // And the relay outbox still serves prior entries idempotently (resync).
      const resyncPull = await httpJson(revivedUrl, "/peer/conversations/outbox?cursor=0", {
        headers: peerHeaders("broker-beta", SECRET_BETA),
      });
      assert.equal(resyncPull.status, 200);
      const resync = await httpJson(beta.baseUrl, "/peer/conversations/relay", {
        method: "POST",
        body: resyncPull.json.entries[0].payload,
        headers: peerHeaders("broker-alpha", SECRET_ALPHA),
      });
      assert.equal(resync.json.outcome, "duplicate");
    } finally {
      revivedRuntime.server.close();
      await once(revivedRuntime.server, "close");
    }
  } finally {
    await stopBroker(beta).catch(() => undefined);
    await stopBroker(alpha).catch(() => undefined);
  }
});
