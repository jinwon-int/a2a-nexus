import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CrossBrokerNonceCache,
  buildCrossBrokerSenderProof,
  loadCrossBrokerTrustAnchors,
  verifyCrossBrokerSenderProof,
} from "./cross-broker-sender-proof.js";

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

test("trust anchors load from a pin file, rejecting empty ids and malformed pins", () => {
  const { pub } = keys();
  const dir = mkdtempSync(join(tmpdir(), "a2a-xbroker-"));
  const file = join(dir, "anchors.json");
  writeFileSync(file, JSON.stringify({ "peer-a": pub }));
  assert.ok(loadCrossBrokerTrustAnchors(file)?.has("peer-a"));
  assert.equal(loadCrossBrokerTrustAnchors(undefined), null);

  const emptyId = join(dir, "empty.json");
  writeFileSync(emptyId, JSON.stringify({ "   ": pub }));
  assert.throws(() => loadCrossBrokerTrustAnchors(emptyId), /non-empty/);
  const badPem = join(dir, "bad.json");
  writeFileSync(badPem, JSON.stringify({ "peer-a": "nope" }));
  assert.throws(() => loadCrossBrokerTrustAnchors(badPem), /SPKI public key PEM/);
});

test("a fresh body-bound proof verifies; replay and tamper are rejected (a2a-nexus#618 review)", () => {
  const { priv, pub } = keys();
  const anchors = new Map([["peer-a", pub]]);
  const now = Date.parse("2026-06-12T00:00:00.000Z");
  const body = { crossBrokerHandoff: { handoffBrokerId: "peer-a" }, parentRoundId: "r1", summary: "ok" };
  const proof = buildCrossBrokerSenderProof(priv, { brokerId: "peer-a", body, nonce: "n1", issuedAt: new Date(now).toISOString() });

  const cache = new CrossBrokerNonceCache();
  assert.deepEqual(
    verifyCrossBrokerSenderProof(anchors, { ...body, senderProof: proof }, { nonceCache: cache, now }),
    { ok: true, brokerId: "peer-a" },
  );

  // Replay of the same nonce is rejected.
  const replay = verifyCrossBrokerSenderProof(anchors, { ...body, senderProof: proof }, { nonceCache: cache, now });
  assert.equal(replay.ok, false);
  assert.match((replay as { reason: string }).reason, /replay/);

  // Tampering the body after signing breaks the bodyHash bind.
  const tampered = verifyCrossBrokerSenderProof(
    anchors,
    { ...body, summary: "evil", senderProof: proof },
    { nonceCache: new CrossBrokerNonceCache(), now },
  );
  assert.equal(tampered.ok, false);
  assert.match((tampered as { reason: string }).reason, /bodyHash/);
});

test("a replayed peer card/proof for a different request cannot impersonate (a2a-nexus#618 review)", () => {
  const { priv, pub } = keys();
  const anchors = new Map([["peer-a", pub]]);
  const now = Date.parse("2026-06-12T00:00:00.000Z");

  // Proof minted for body A.
  const bodyA = { crossBrokerHandoff: { handoffBrokerId: "peer-a" }, parentRoundId: "rA" };
  const proofA = buildCrossBrokerSenderProof(priv, { brokerId: "peer-a", body: bodyA, nonce: "nA", issuedAt: new Date(now).toISOString() });

  // Attacker attaches proofA to a different body B (same broker id) — rejected.
  const bodyB = { crossBrokerHandoff: { handoffBrokerId: "peer-a" }, parentRoundId: "rB", senderProof: proofA };
  const forged = verifyCrossBrokerSenderProof(anchors, bodyB, { nonceCache: new CrossBrokerNonceCache(), now });
  assert.equal(forged.ok, false, "a proof minted for another body must not authenticate this request");
});

test("stale, unknown-broker, missing-proof, and wrong-key cases fail closed", () => {
  const { priv, pub } = keys();
  const anchors = new Map([["peer-a", pub]]);
  const now = Date.parse("2026-06-12T00:00:00.000Z");
  const body = { crossBrokerHandoff: { handoffBrokerId: "peer-a" }, parentRoundId: "r1" };

  // Missing proof.
  const noProof = verifyCrossBrokerSenderProof(anchors, body, { nonceCache: new CrossBrokerNonceCache(), now });
  assert.equal(noProof.ok, false);

  // Stale issuedAt.
  const stale = buildCrossBrokerSenderProof(priv, { brokerId: "peer-a", body, nonce: "ns", issuedAt: new Date(now - 600_000).toISOString() });
  const staleV = verifyCrossBrokerSenderProof(anchors, { ...body, senderProof: stale }, { nonceCache: new CrossBrokerNonceCache(), now });
  assert.equal(staleV.ok, false);
  assert.match((staleV as { reason: string }).reason, /freshness/);

  // Unknown broker id.
  const otherBody = { crossBrokerHandoff: { handoffBrokerId: "peer-z" }, parentRoundId: "r1" };
  const otherProof = buildCrossBrokerSenderProof(priv, { brokerId: "peer-z", body: otherBody, nonce: "nz", issuedAt: new Date(now).toISOString() });
  const unknown = verifyCrossBrokerSenderProof(anchors, { ...otherBody, senderProof: otherProof }, { nonceCache: new CrossBrokerNonceCache(), now });
  assert.equal(unknown.ok, false);
  assert.match((unknown as { reason: string }).reason, /no trust anchor/);

  // Signed by a key the anchor does not pin.
  const { priv: wrongPriv } = keys();
  const wrongProof = buildCrossBrokerSenderProof(wrongPriv, { brokerId: "peer-a", body, nonce: "nw", issuedAt: new Date(now).toISOString() });
  const wrongKey = verifyCrossBrokerSenderProof(anchors, { ...body, senderProof: wrongProof }, { nonceCache: new CrossBrokerNonceCache(), now });
  assert.equal(wrongKey.ok, false);
  assert.match((wrongKey as { reason: string }).reason, /does not verify/);
});

test("an invalid signature cannot poison the replay cache for a future valid nonce (a2a-nexus#618 review)", () => {
  const { priv, pub } = keys();
  const { priv: attackerPriv } = keys();
  const anchors = new Map([["peer-a", pub]]);
  const now = Date.parse("2026-06-12T00:00:00.000Z");
  const body = { crossBrokerHandoff: { handoffBrokerId: "peer-a" }, parentRoundId: "r1" };
  const cache = new CrossBrokerNonceCache();

  // Attacker submits a proof with a NOT-pinned key but the victim's future
  // nonce. It must fail on the signature WITHOUT consuming the nonce.
  const poison = buildCrossBrokerSenderProof(attackerPriv, { brokerId: "peer-a", body, nonce: "victim-nonce", issuedAt: new Date(now).toISOString() });
  const poisoned = verifyCrossBrokerSenderProof(anchors, { ...body, senderProof: poison }, { nonceCache: cache, now });
  assert.equal(poisoned.ok, false);
  assert.match((poisoned as { reason: string }).reason, /does not verify/);

  // The legitimate sender's proof with the same nonce still verifies: the
  // nonce was only committed for fully verified proofs.
  const legit = buildCrossBrokerSenderProof(priv, { brokerId: "peer-a", body, nonce: "victim-nonce", issuedAt: new Date(now).toISOString() });
  assert.deepEqual(
    verifyCrossBrokerSenderProof(anchors, { ...body, senderProof: legit }, { nonceCache: cache, now }),
    { ok: true, brokerId: "peer-a" },
  );

  // And only now is the nonce burned for THIS broker.
  const replay = verifyCrossBrokerSenderProof(anchors, { ...body, senderProof: legit }, { nonceCache: cache, now });
  assert.equal(replay.ok, false);
  assert.match((replay as { reason: string }).reason, /replay/);
});

test("nonce scope is per broker: two trusted peers may use the same nonce (a2a-nexus#618 review)", () => {
  const { priv: privA, pub: pubA } = keys();
  const { priv: privB, pub: pubB } = keys();
  const anchors = new Map([["peer-a", pubA], ["peer-b", pubB]]);
  const now = Date.parse("2026-06-12T00:00:00.000Z");
  const cache = new CrossBrokerNonceCache();

  const bodyA = { crossBrokerHandoff: { handoffBrokerId: "peer-a" }, parentRoundId: "rA" };
  const bodyB = { crossBrokerHandoff: { handoffBrokerId: "peer-b" }, parentRoundId: "rB" };
  const proofA = buildCrossBrokerSenderProof(privA, { brokerId: "peer-a", body: bodyA, nonce: "shared", issuedAt: new Date(now).toISOString() });
  const proofB = buildCrossBrokerSenderProof(privB, { brokerId: "peer-b", body: bodyB, nonce: "shared", issuedAt: new Date(now).toISOString() });

  assert.equal(verifyCrossBrokerSenderProof(anchors, { ...bodyA, senderProof: proofA }, { nonceCache: cache, now }).ok, true);
  // Different broker, same nonce string: not a replay (no cross-peer false positive).
  assert.equal(verifyCrossBrokerSenderProof(anchors, { ...bodyB, senderProof: proofB }, { nonceCache: cache, now }).ok, true);
  // Same broker reusing its own nonce IS a replay.
  const replayA = verifyCrossBrokerSenderProof(anchors, { ...bodyA, senderProof: proofA }, { nonceCache: cache, now });
  assert.equal(replayA.ok, false);
});
