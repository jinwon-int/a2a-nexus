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

// ---------------------------------------------------------------------------
// Multi-signature verification (#1919)
// ---------------------------------------------------------------------------

const ed25519Pem = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};

test("a valid signature verifies at any index, not only the first (#1919)", () => {
  const a = ed25519Pem();
  const b = ed25519Pem();

  // A co-signed / mid-rotation card: two signers over the same payload. The
  // payload excludes `signatures` entirely, so every entry covers identical
  // bytes and each is independently valid.
  const multi = {
    ...card,
    signatures: [
      signAgentCard(card, { privateKeyPem: b.priv }).signatures[0],
      signAgentCard(card, { privateKeyPem: a.priv }).signatures[0],
    ],
  };

  assert.equal(verifyAgentCardSignature(multi, b.pub), true, "signer at index 0 verifies");
  assert.equal(
    verifyAgentCardSignature(multi, a.pub),
    true,
    "a valid signature at index 1 must verify — rejecting it breaks key rotation and co-signing",
  );

  // Still fail-closed: a key that signed nothing on this card is rejected.
  assert.equal(verifyAgentCardSignature(multi, ed25519Pem().pub), false);
});

test("one unusable entry does not mask a valid one (#1919)", () => {
  const a = ed25519Pem();
  const valid = signAgentCard(card, { privateKeyPem: a.priv }).signatures[0];

  const withJunkFirst = {
    ...card,
    signatures: [
      { protected: "!!!not-base64-json!!!", signature: "@@@" },
      valid,
    ],
  };
  assert.equal(
    verifyAgentCardSignature(withJunkFirst, a.pub),
    true,
    "a malformed neighbouring entry must not hide a valid signature",
  );

  // And a card of nothing but junk still fails closed rather than throwing.
  const allJunk = {
    ...card,
    signatures: [{ protected: "###", signature: "###" }],
  };
  assert.equal(verifyAgentCardSignature(allJunk, a.pub), false);
});

test("entries are matched on their own protected alg, not the key's (#1919)", () => {
  const ed = ed25519Pem();
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ecPriv = ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const ecPub = ec.publicKey.export({ type: "spki", format: "pem" }).toString();

  // Mixed algorithms on one card. An ES256 entry is 64 raw bytes and an EdDSA
  // entry is 64 raw bytes too, so a verifier that assumed the key's alg for
  // every entry would feed EdDSA bytes through the ECDSA DER conversion.
  const mixed = {
    ...card,
    signatures: [
      signAgentCard(card, { privateKeyPem: ed.priv }).signatures[0],
      signAgentCard(card, { privateKeyPem: ecPriv }).signatures[0],
    ],
  };

  assert.equal(verifyAgentCardSignature(mixed, ecPub), true, "the ES256 entry must be found");
  assert.equal(verifyAgentCardSignature(mixed, ed.pub), true, "the EdDSA entry must be found");
});

test("an empty signatures array fails closed (#1919)", () => {
  const a = ed25519Pem();
  assert.equal(verifyAgentCardSignature({ ...card, signatures: [] }, a.pub), false);
});

test("the unprotected header round-trips but is never authenticated (#1919)", () => {
  const a = ed25519Pem();
  const signed = signAgentCard(card, { privateKeyPem: a.priv });

  // A foreign card may carry `header`. It must not break verification...
  const withHeader = {
    ...card,
    signatures: [{ ...signed.signatures[0], header: { kid: "foreign-hint" } }],
  };
  assert.equal(verifyAgentCardSignature(withHeader, a.pub), true);

  // ...and it must not be mistaken for signed data: only `protected` is in the
  // signing input, so changing `header` cannot change the verdict. Anything
  // read from here is a hint, never an authenticated claim.
  const tamperedHeader = {
    ...card,
    signatures: [{ ...signed.signatures[0], header: { kid: "attacker-controlled" } }],
  };
  assert.equal(
    verifyAgentCardSignature(tamperedHeader, a.pub),
    true,
    "header is outside the signature by design — callers must not trust it",
  );

  // The signer itself still emits no header.
  assert.equal(Object.hasOwn(signed.signatures[0], "header"), false);
});
