import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import {
  agentCardSigningPayload,
  canonicalizeJson,
  signAgentCard,
  verifyAgentCardSignature,
} from "./agent-card-signing.js";

// ---------------------------------------------------------------------------
// RFC 8785 canonicalization
// ---------------------------------------------------------------------------

test("canonicalizeJson sorts keys recursively and strips undefined members", () => {
  const canonical = canonicalizeJson({
    b: 1,
    a: { z: true, y: [3, 1, { d: null, c: "x" }] },
    skipped: undefined,
  });
  assert.equal(canonical, '{"a":{"y":[3,1,{"c":"x","d":null}],"z":true},"b":1}');
});

test("canonicalizeJson uses ES6 number serialization and rejects non-finite numbers", () => {
  assert.equal(canonicalizeJson({ n: 1e21, m: 0.000001, k: 10 }), '{"k":10,"m":0.000001,"n":1e+21}');
  assert.throws(() => canonicalizeJson({ bad: Number.POSITIVE_INFINITY }), /non-finite/);
});

test("canonicalizeJson is stable regardless of insertion order", () => {
  const first = canonicalizeJson({ a: 1, b: 2 });
  const second = canonicalizeJson({ b: 2, a: 1 });
  assert.equal(first, second);
});

// ---------------------------------------------------------------------------
// JWS sign / verify
// ---------------------------------------------------------------------------

const card = {
  name: "test-broker",
  protocolVersion: "1.0",
  capabilities: { streaming: true, pushNotifications: false },
  skills: [],
};

test("signAgentCard produces a verifiable Ed25519 signature excluding the signatures field", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = signAgentCard(card, {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    kid: "test-key-1",
  });

  assert.equal(signed.signatures.length, 1);
  const header = JSON.parse(Buffer.from(signed.signatures[0].protected, "base64url").toString());
  assert.equal(header.alg, "EdDSA");
  assert.equal(header.kid, "test-key-1");

  // The payload excludes signatures, so signing the signed card again covers
  // the same bytes.
  assert.equal(agentCardSigningPayload(signed), agentCardSigningPayload(card));

  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifyAgentCardSignature(signed, publicPem), true);

  // Tampering with any signed field must invalidate the signature.
  const tampered = { ...signed, name: "evil-broker" };
  assert.equal(verifyAgentCardSignature(tampered, publicPem), false);
});

test("signAgentCard supports EC P-256 (ES256) and rejects unsupported key types", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signed = signAgentCard(card, {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  const header = JSON.parse(Buffer.from(signed.signatures[0].protected, "base64url").toString());
  assert.equal(header.alg, "ES256");
  assert.equal(Buffer.from(signed.signatures[0].signature, "base64url").length, 64, "ES256 JWS signature must be raw r||s");
  assert.equal(
    verifyAgentCardSignature(signed, publicKey.export({ type: "spki", format: "pem" }).toString()),
    true,
  );

  const { privateKey: rsaKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () => signAgentCard(card, { privateKeyPem: rsaKey.export({ type: "pkcs8", format: "pem" }).toString() }),
    /unsupported agent-card signing key type/,
  );
});

test("verifyAgentCardSignature returns false for an unsigned card", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  assert.equal(
    verifyAgentCardSignature(card, publicKey.export({ type: "spki", format: "pem" }).toString()),
    false,
  );
});
