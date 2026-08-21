import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { signAgentCard, verifyAgentCardSignature, type AgentCardSignature } from "a2a-attestation";
import { createBrokerAgentCard, type AgentCard } from "./agent-card.js";

/**
 * AgentCard type ↔ signed wire shape (#1912 F2).
 *
 * The audit found that `AgentCard` could not express the shape the broker
 * actually serves: signing required casting the card out to
 * `Record<string, unknown>` and casting the result back, which erased the
 * `signatures` field from the type immediately after adding it at runtime.
 * With the type blind to signatures, the compiler could not catch card
 * structure regressions on the signed path.
 *
 * These tests are as much a compile-time contract as a runtime one: every
 * assignment below is deliberately explicitly typed, so the file fails to
 * build if `AgentCard` stops expressing the signed shape or if
 * `signAgentCard` stops preserving the input type.
 */

function testCard(): AgentCard {
  return createBrokerAgentCard({
    serviceName: "signed-shape-test-broker",
    publicBaseUrl: "https://broker.test/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });
}

function ed25519Pem(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

test("signAgentCard accepts an AgentCard directly, with no cast (#1912 F2)", () => {
  const card = testCard();
  const { privateKeyPem, publicKeyPem } = ed25519Pem();

  // No `as unknown as Record<string, unknown>`: an AgentCard must satisfy the
  // signer's constraint on its own. If this needs a cast again, the type has
  // stopped describing what the broker signs.
  const signed = signAgentCard(card, { privateKeyPem });

  // The result must stay an AgentCard *and* carry typed signatures. Both
  // annotations are load-bearing — they fail the build, not just the run.
  const stillACard: AgentCard = signed;
  const signatures: AgentCardSignature[] = signed.signatures;

  assert.equal(stillACard.name, card.name, "signing must preserve the card fields");
  assert.equal(signatures.length, 1, "the broker signs with exactly one JWS entry");
  assert.equal(typeof signatures[0].protected, "string");
  assert.equal(typeof signatures[0].signature, "string");
  assert.ok(
    verifyAgentCardSignature(signed, publicKeyPem),
    "the signed card must verify against its own public key",
  );
});

test("the AgentCard type carries signatures through to the served shape (#1912 F2)", () => {
  const { privateKeyPem } = ed25519Pem();

  // This mirrors server.ts: the served card is either signed or not, and both
  // branches must be assignable to AgentCard without erasing the signatures
  // type on the way through.
  const served: AgentCard = signAgentCard(testCard(), { privateKeyPem });

  assert.ok(Array.isArray(served.signatures), "a signed served card exposes signatures");
  assert.equal(served.signatures?.length, 1);

  // The protected header is base64url JSON carrying the advertised alg.
  const header = JSON.parse(
    Buffer.from(served.signatures![0].protected, "base64url").toString("utf8"),
  ) as { alg?: unknown; typ?: unknown };
  assert.equal(header.alg, "EdDSA");
  assert.equal(header.typ, "JOSE");
});

test("an unsigned AgentCard omits the signatures key entirely (#1912 F2)", () => {
  const card = testCard();

  // The field is optional, never a placeholder: the unsigned path must leave
  // the key absent rather than present-and-undefined, because the signing
  // payload is JCS over the card sans `signatures` and a serialized
  // `"signatures": null` would change the canonical bytes.
  assert.equal(
    Object.hasOwn(card, "signatures"),
    false,
    "the default card must not carry a signatures key",
  );
  assert.equal(card.signatures, undefined);
  assert.equal(
    JSON.stringify(card).includes("signatures"),
    false,
    "the serialized default card must not mention signatures",
  );
});
