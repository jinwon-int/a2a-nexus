// #2339 PR-4: A2A_CROSS_BROKER_SENDER_PROOF_MODE (off | record | enforce) for
// the cross-broker Terminal Brief ingest, its counters, and startup fail-closed.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  CrossBrokerNonceCache,
  CrossBrokerSenderProofCounters,
  buildCrossBrokerSenderProof,
  resolveCrossBrokerSenderProofMode,
  verifyCrossBrokerSenderProof,
} from "./a2a/cross-broker-sender-proof.js";
import type { InMemoryA2ABroker } from "./core/broker.js";
import { jsonHeaders, startTestServer } from "./server-test-helpers.js";

const PARENT = "brokeralpha";
const CHILD = "brokerbeta";
const ROUND = "brokeralpha-round-proof";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function anchorsFile(pins: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "a2a-proof-mode-"));
  dirs.push(dir);
  const file = join(dir, "anchors.json");
  writeFileSync(file, JSON.stringify(pins));
  return file;
}

function projection(order: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parentRoundId: ROUND,
    originBrokerId: CHILD,
    handoffBrokerId: CHILD,
    brokerOfRecordId: PARENT,
    childTaskId: `child-${order}`,
    status: "succeeded",
    completedAt: "2026-10-01T05:00:00.000Z",
    parentRoundTotal: 9,
    parentRoundOrder: order,
    ...overrides,
  };
}

function signed(body: Record<string, unknown>, priv: string, brokerId = CHILD): Record<string, unknown> {
  return { ...body, senderProof: buildCrossBrokerSenderProof(priv, { brokerId, body, nonce: randomUUID() }) };
}

// ---- unit: mode resolution ---------------------------------------------------

test("PR-4 mode resolution: unset keeps the legacy meaning, an explicit mode wins, enforce needs anchors", () => {
  assert.equal(resolveCrossBrokerSenderProofMode(undefined, true), "enforce");
  assert.equal(resolveCrossBrokerSenderProofMode("", false), "off");
  assert.equal(resolveCrossBrokerSenderProofMode(" Record ", true), "record");
  assert.equal(resolveCrossBrokerSenderProofMode("off", true), "off", "explicit off wins over an anchors file");
  assert.equal(resolveCrossBrokerSenderProofMode("record", false), "record", "record without anchors starts (counts unpinned)");
  assert.throws(() => resolveCrossBrokerSenderProofMode("enforce", false), /requires trust anchors/);
  assert.throws(() => resolveCrossBrokerSenderProofMode("strict", true), /must be off, record, or enforce/);
});

// ---- unit: failure classes, counters, claimed broker ---------------------------

test("PR-4 verdicts carry a failure class and the counters bucket them", () => {
  const pinned = keys();
  const other = keys();
  const anchors = new Map([[CHILD, pinned.pub]]);
  const nonceCache = new CrossBrokerNonceCache();
  const counters = new CrossBrokerSenderProofCounters();
  const verify = (body: unknown) => {
    const verdict = verifyCrossBrokerSenderProof(anchors, body, { nonceCache });
    counters.record(verdict);
    return verdict;
  };

  assert.equal(verify(signed(projection(1), pinned.priv)).ok, true);
  const missing = verify(projection(2));
  assert.ok(!missing.ok && missing.failure === "missing");
  const forged = verify(signed(projection(3), other.priv));
  assert.ok(!forged.ok && forged.failure === "invalid");
  const unpinned = verify(signed(projection(4, { handoffBrokerId: "brokergamma", originBrokerId: "brokergamma" }), pinned.priv, "brokergamma"));
  assert.ok(!unpinned.ok && unpinned.failure === "unpinned");
  counters.recordUnpinned();

  assert.deepEqual(counters.snapshot(), { verified: 1, missing: 1, invalid: 1, unpinnedBroker: 2 });
});

test("PR-4 the proof is checked against the top-level handoffBrokerId, not a minted originBrokerId", () => {
  const child = keys();
  const anchors = new Map([[CHILD, child.pub]]);
  // CROSS_BROKER_EMIT_MINTED_ORIGIN shape: originBrokerId is the parent (minted origin).
  const body = signed(projection(1, { originBrokerId: PARENT }), child.priv);

  const verdict = verifyCrossBrokerSenderProof(anchors, body, { nonceCache: new CrossBrokerNonceCache() });

  assert.deepEqual(verdict, { ok: true, brokerId: CHILD });
});

// ---- server: modes through the projection route ----------------------------------

async function parentServer(options: { anchors?: Record<string, string>; mode?: string }) {
  const server = await startTestServer({
    brokerId: PARENT,
    knownBrokerIds: [CHILD],
    ...(options.anchors ? { crossBrokerSenderProofKeysFile: anchorsFile(options.anchors) } : {}),
    ...(options.mode !== undefined ? { crossBrokerSenderProofMode: options.mode } : {}),
  });
  const broker = server.runtime.broker as InMemoryA2ABroker;
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["t"], environments: ["research"] },
  });
  broker.createTask({
    id: ROUND,
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "parent round",
    payload: { parentRoundTotal: 9 },
  });
  const hub = jsonHeaders({ "x-a2a-requester-id": "brokerbeta-terminal-brief-receiver", "x-a2a-requester-role": "hub" });
  return {
    server,
    ingest: async (body: unknown) => (await fetch(`${server.baseUrl}/a2a/cross-broker/terminal-briefs`, {
      method: "POST",
      headers: hub,
      body: JSON.stringify(body),
    })).status,
    proofHealth: async () => ((await (await fetch(`${server.baseUrl}/health`)).json()) as {
      crossBrokerSenderProof: Record<string, unknown>;
    }).crossBrokerSenderProof,
  };
}

test("PR-4 record mode verifies and counts every outcome but rejects nothing", async () => {
  const pinned = keys();
  const other = keys();
  const { server, ingest, proofHealth } = await parentServer({ anchors: { [CHILD]: pinned.pub }, mode: "record" });
  try {
    assert.equal(await ingest(signed(projection(1), pinned.priv)), 202);
    assert.equal(await ingest(projection(2)), 202, "missing proof is accepted in record mode");
    assert.equal(await ingest(signed(projection(3), other.priv)), 202, "invalid proof is accepted in record mode");
    assert.equal(
      await ingest(signed(projection(4, { handoffBrokerId: "brokergamma", originBrokerId: "brokergamma" }), other.priv, "brokergamma")),
      202,
    );
    assert.deepEqual(await proofHealth(), {
      mode: "record",
      anchorsConfigured: true,
      verified: 1,
      missing: 1,
      invalid: 1,
      unpinnedBroker: 1,
    });
  } finally {
    await server.close();
  }
});

test("PR-4 enforce mode rejects unverified projections and counts them", async () => {
  const pinned = keys();
  const { server, ingest, proofHealth } = await parentServer({ anchors: { [CHILD]: pinned.pub }, mode: "enforce" });
  try {
    assert.equal(await ingest(projection(1)), 403);
    assert.equal(await ingest(signed(projection(2), keys().priv)), 403);
    assert.equal(await ingest(signed(projection(3), pinned.priv)), 202);
    assert.deepEqual(await proofHealth(), {
      mode: "enforce",
      anchorsConfigured: true,
      verified: 1,
      missing: 1,
      invalid: 1,
      unpinnedBroker: 0,
    });
  } finally {
    await server.close();
  }
});

test("PR-4 unset mode keeps the legacy meaning: anchors file enforces, no anchors is off", async () => {
  const pinned = keys();
  const legacyEnforce = await parentServer({ anchors: { [CHILD]: pinned.pub } });
  try {
    assert.equal(await legacyEnforce.ingest(projection(1)), 403);
    assert.equal((await legacyEnforce.proofHealth()).mode, "enforce");
  } finally {
    await legacyEnforce.server.close();
  }

  const legacyOff = await parentServer({});
  try {
    assert.equal(await legacyOff.ingest(projection(1)), 202);
    assert.deepEqual(await legacyOff.proofHealth(), {
      mode: "off",
      anchorsConfigured: false,
      verified: 0,
      missing: 0,
      invalid: 0,
      unpinnedBroker: 0,
    });
  } finally {
    await legacyOff.server.close();
  }
});

test("PR-4 explicit off skips verification even with anchors; record without anchors counts unpinned", async () => {
  const pinned = keys();
  const off = await parentServer({ anchors: { [CHILD]: pinned.pub }, mode: "off" });
  try {
    assert.equal(await off.ingest(projection(1)), 202);
    assert.equal((await off.proofHealth()).verified, 0);
  } finally {
    await off.server.close();
  }

  const recordNoAnchors = await parentServer({ mode: "record" });
  try {
    assert.equal(await recordNoAnchors.ingest(signed(projection(1), pinned.priv)), 202);
    const health = await recordNoAnchors.proofHealth();
    assert.equal(health.anchorsConfigured, false);
    assert.equal(health.unpinnedBroker, 1);
  } finally {
    await recordNoAnchors.server.close();
  }
});

test("PR-4 enforce without trust anchors refuses to start", async () => {
  await assert.rejects(
    startTestServer({ brokerId: PARENT, crossBrokerSenderProofMode: "enforce" }),
    /requires trust anchors/,
  );
  await assert.rejects(
    startTestServer({ brokerId: PARENT, crossBrokerSenderProofMode: "sometimes" }),
    /must be off, record, or enforce/,
  );
});
