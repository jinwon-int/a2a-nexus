import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signAgentCard } from "./agent-card-signing.js";
import { loadCrossBrokerTrustAnchors, verifyCrossBrokerSenderCard } from "./cross-broker-card-trust.js";

function makeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const card = { name: "peer-broker", protocolVersion: "1.0", capabilities: { streaming: true, pushNotifications: false }, skills: [] };

test("trust anchors load from a JSON pin file and reject malformed pins", () => {
  const { publicPem } = makeKeys();
  const dir = mkdtempSync(join(tmpdir(), "a2a-trust-"));
  const file = join(dir, "anchors.json");
  writeFileSync(file, JSON.stringify({ "peer-a": publicPem }));
  const anchors = loadCrossBrokerTrustAnchors(file);
  assert.ok(anchors?.has("peer-a"));

  assert.equal(loadCrossBrokerTrustAnchors(undefined), null, "unset file disables the gate");
  const badFile = join(dir, "bad.json");
  writeFileSync(badFile, JSON.stringify({ "peer-a": "not-a-pem" }));
  assert.throws(() => loadCrossBrokerTrustAnchors(badFile), /SPKI public key PEM/);
});

test("verifyCrossBrokerSenderCard binds the claimed broker id to the pinned key", () => {
  const { privatePem, publicPem } = makeKeys();
  const anchors = new Map([["peer-a", publicPem]]);
  const signed = signAgentCard(card, { privateKeyPem: privatePem });

  const ok = verifyCrossBrokerSenderCard(anchors, {
    crossBrokerHandoff: { handoffBrokerId: "peer-a" },
    senderAgentCard: signed,
  });
  assert.deepEqual(ok, { ok: true, brokerId: "peer-a" });

  const unknown = verifyCrossBrokerSenderCard(anchors, {
    crossBrokerHandoff: { handoffBrokerId: "peer-b" },
    senderAgentCard: signed,
  });
  assert.equal(unknown.ok, false);
  assert.match((unknown as { reason: string }).reason, /no trust anchor/);

  const missingCard = verifyCrossBrokerSenderCard(anchors, {
    crossBrokerHandoff: { handoffBrokerId: "peer-a" },
  });
  assert.equal(missingCard.ok, false);
  assert.match((missingCard as { reason: string }).reason, /senderAgentCard/);

  const tampered = verifyCrossBrokerSenderCard(anchors, {
    crossBrokerHandoff: { handoffBrokerId: "peer-a" },
    senderAgentCard: { ...signed, name: "evil-broker" },
  });
  assert.equal(tampered.ok, false);
  assert.match((tampered as { reason: string }).reason, /does not verify/);

  // A key the anchor does not pin must not verify even with a valid signature.
  const { privatePem: otherKey } = makeKeys();
  const otherSigned = signAgentCard(card, { privateKeyPem: otherKey });
  const wrongKey = verifyCrossBrokerSenderCard(anchors, {
    crossBrokerHandoff: { handoffBrokerId: "peer-a" },
    senderAgentCard: otherSigned,
  });
  assert.equal(wrongKey.ok, false);
});
