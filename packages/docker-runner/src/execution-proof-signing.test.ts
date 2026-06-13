import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { buildExecutionProof, verifyExecutionProof } from "./execution-proof.js";
import { verifyExecutionProofSignature } from "./execution-proof-signing.js";
import type { NormalizedRunnerTask, RunnerResult } from "./types.js";

const task = {
  id: "task-sign-1",
  intent: "github-propose-patch",
  repos: [{ url: "https://github.com/acme/x", path: "x", primary: true }],
  env: {},
} as unknown as NormalizedRunnerTask;

const result: RunnerResult = {
  taskId: "task-sign-1",
  ok: true,
  status: "completed",
  exitCode: 0,
  stdout: "done",
  stderr: "",
} as RunnerResult;

function pems() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

test("a signed proof verifies and is tamper-evident over the whole proof", () => {
  const { priv, pub } = pems();
  const proof = buildExecutionProof({ task, result, runToken: "rt-1", now: "2026-06-12T00:00:00.000Z", signingKeyPem: priv, signingKid: "node-1" });
  assert.ok(proof.signature, "proof must carry a signature when a key is configured");

  assert.equal(verifyExecutionProofSignature(proof, pub), true);
  const header = JSON.parse(Buffer.from(proof.signature.protected, "base64url").toString());
  assert.equal(header.alg, "EdDSA");
  assert.equal(header.kid, "node-1");

  // Mutating any signed field breaks the signature.
  assert.equal(verifyExecutionProofSignature({ ...proof, chainDigest: "deadbeef" }, pub), false);

  // verifyExecutionProof enforces the signature when a key is given.
  const ok = verifyExecutionProof(proof, task, undefined, "done", "", { publicKeyPem: pub });
  assert.deepEqual(ok, { valid: true });
  const { priv: otherPriv } = pems();
  const otherProof = buildExecutionProof({ task, result, runToken: "rt-1", now: "2026-06-12T00:00:00.000Z", signingKeyPem: otherPriv });
  const wrong = verifyExecutionProof(otherProof, task, undefined, "done", "", { publicKeyPem: pub });
  assert.equal(wrong.valid, false);
});

test("unsigned proofs are unchanged and a key requirement fails closed on them", () => {
  const { pub } = pems();
  const proof = buildExecutionProof({ task, result, runToken: "rt-2", now: "2026-06-12T00:00:00.000Z" });
  assert.equal(proof.signature, undefined, "no key -> unsigned proof, byte-for-byte as before");

  // Internal verification still passes without a key requirement.
  assert.deepEqual(verifyExecutionProof(proof, task, undefined, "done", ""), { valid: true });
  // But requiring a key on an unsigned proof fails closed.
  const required = verifyExecutionProof(proof, task, undefined, "done", "", { publicKeyPem: pub });
  assert.equal(required.valid, false);
});

function looksLikeDerEcdsaSignature(signature: Buffer): boolean {
  if (signature.length < 8 || signature[0] !== 0x30) return false;
  const sequenceLength = signature[1];
  if (sequenceLength === undefined || sequenceLength + 2 !== signature.length) return false;
  if (signature[2] !== 0x02) return false;
  const rLength = signature[3];
  if (rLength === undefined) return false;
  const sTypeOffset = 4 + rLength;
  if (signature[sTypeOffset] !== 0x02) return false;
  const sLength = signature[sTypeOffset + 1];
  return sLength !== undefined && sTypeOffset + 2 + sLength === signature.length;
}

test("ES256 signatures are raw r||s (64 bytes), not DER (a2a-nexus#619 review)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const proof = buildExecutionProof({
    task, result, runToken: "rt-es", now: "2026-06-12T00:00:00.000Z",
    signingKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  assert.ok(proof.signature);
  const raw = Buffer.from(proof.signature.signature, "base64url");
  assert.equal(raw.length, 64, "JWS ES256 must be raw r||s 64 bytes");
  assert.equal(looksLikeDerEcdsaSignature(raw), false, "must not be DER-encoded");
  assert.equal(
    verifyExecutionProofSignature(proof, publicKey.export({ type: "spki", format: "pem" }).toString()),
    true,
  );
});

test("non-P-256 EC curves are rejected (a2a-nexus#619 review)", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
  assert.throws(
    () => buildExecutionProof({
      task, result, runToken: "rt-bad", now: "2026-06-12T00:00:00.000Z",
      signingKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
    /P-256/,
  );
});

test("a signature whose protected header claims a different alg is rejected (a2a-nexus#619 review)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const proof = buildExecutionProof({
    task, result, runToken: "rt-hdr", now: "2026-06-12T00:00:00.000Z",
    signingKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  assert.ok(proof.signature);
  // Forge the protected header to claim ES256 while the key is Ed25519.
  const forgedHeader = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JOSE" })).toString("base64url");
  const tampered = { ...proof, signature: { ...proof.signature, protected: forgedHeader } };
  assert.equal(
    verifyExecutionProofSignature(tampered, publicKey.export({ type: "spki", format: "pem" }).toString()),
    false,
  );
});
