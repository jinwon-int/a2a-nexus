// In-broker finalizer-verdict signature verification (#1383 V-c follow-up).
// Closes the accept-path gap the adversarial round's attack-surface lens
// flagged: the broker now verifies the STATIC-KEY verdict signature at accept
// time (not just structure), reusing the broker's own RFC 8785 JCS + EdDSA so
// there is no second crypto stack. A golden canonical-form assertion pins the
// broker JCS to rfc8785-jcs-v1 (the same spec the offline verifier implements),
// so the two cannot silently drift. Attester (S3) cert-chain verification stays
// with the merge gate (documented v0 boundary).
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import {
  verifyFinalizerVerdictSignature,
  loadFinalizerKeyring,
  type FinalizerKeyring,
} from "./finalizer-verdict-signature.js";
import { canonicalizeJson } from "../a2a/agent-card-signing.js";

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
}

/** Sign a verdict exactly as the contract specifies: JWS over JCS(verdict sans sig). */
function signVerdict(verdict: Record<string, unknown>, privateKey: import("node:crypto").KeyObject, kid: string) {
  const header = { alg: "EdDSA", kid, typ: "JOSE" };
  const protectedHeader = Buffer.from(canonicalizeJson(header)).toString("base64url");
  const { sig: _omit, ...unsigned } = verdict;
  const payload = Buffer.from(canonicalizeJson(unsigned)).toString("base64url");
  const signature = cryptoSign(null, Buffer.from(`${protectedHeader}.${payload}`, "utf8"), privateKey).toString("base64url");
  return { ...verdict, sig: { protected: protectedHeader, signature } };
}

test("broker JCS matches rfc8785-jcs-v1 golden forms (drift pin against the offline verifier)", () => {
  // Key ordering, unicode, and number rules per RFC 8785.
  assert.equal(canonicalizeJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalizeJson({ z: [3, 2, 1], a: "x" }), '{"a":"x","z":[3,2,1]}');
  assert.equal(canonicalizeJson({ n: 1, s: "é" }), '{"n":1,"s":"é"}');
  assert.equal(canonicalizeJson({ keep: 1, drop: undefined }), '{"keep":1}');
});

test("a validly signed verdict verifies against its registered key", () => {
  const k = ed25519();
  const keyring: FinalizerKeyring = { keys: { "finalizer:panel:v1": k.pem } };
  const verdict = signVerdict(
    { schemaVersion: "a2a.finalizer.verdict.v1", subject: { kind: "task-result", resultHash: "sha256:abc" }, decision: "go", finalizerKeyId: "finalizer:panel:v1" },
    k.privateKey, "finalizer:panel:v1",
  );
  assert.deepEqual(verifyFinalizerVerdictSignature(verdict, keyring), { ok: true });
});

test("tampering any signed field fails verification", () => {
  const k = ed25519();
  const keyring: FinalizerKeyring = { keys: { "finalizer:panel:v1": k.pem } };
  const verdict = signVerdict(
    { schemaVersion: "a2a.finalizer.verdict.v1", subject: { kind: "task-result", resultHash: "sha256:abc" }, decision: "go", finalizerKeyId: "finalizer:panel:v1" },
    k.privateKey, "finalizer:panel:v1",
  );
  const tampered = { ...verdict, decision: "no-go" };
  assert.equal(verifyFinalizerVerdictSignature(tampered, keyring).ok, false);
});

test("a key not in the registered keyring fails closed", () => {
  const k = ed25519();
  const other = ed25519();
  const keyring: FinalizerKeyring = { keys: { "finalizer:other:v1": other.pem } };
  const verdict = signVerdict(
    { schemaVersion: "a2a.finalizer.verdict.v1", subject: { kind: "task-result", resultHash: "sha256:abc" }, decision: "go", finalizerKeyId: "finalizer:panel:v1" },
    k.privateKey, "finalizer:panel:v1",
  );
  assert.match(verifyFinalizerVerdictSignature(verdict, keyring).reason ?? "", /not in the registered/);
});

test("a verdict signed by a DIFFERENT key than its finalizerKeyId claims fails", () => {
  const registered = ed25519();
  const attacker = ed25519();
  const keyring: FinalizerKeyring = { keys: { "finalizer:panel:v1": registered.pem } };
  // signed with attacker's key but claims the registered keyId
  const verdict = signVerdict(
    { schemaVersion: "a2a.finalizer.verdict.v1", subject: { kind: "task-result", resultHash: "sha256:abc" }, decision: "go", finalizerKeyId: "finalizer:panel:v1" },
    attacker.privateKey, "finalizer:panel:v1",
  );
  assert.equal(verifyFinalizerVerdictSignature(verdict, keyring).ok, false);
});

test("the attester (S3) path is not a broker static-key signature (deferred to the gate)", () => {
  const keyring: FinalizerKeyring = { keys: {} };
  const attested = { schemaVersion: "a2a.finalizer.verdict.v1", subject: { kind: "task-result", resultHash: "sha256:abc" }, decision: "go", attester: { kind: "github-oidc", subject: "repo:o/n:workflow_ref:x" } };
  assert.match(verifyFinalizerVerdictSignature(attested, keyring).reason ?? "", /static-key|finalizerKeyId/);
});

test("loadFinalizerKeyring validates shape and rejects non-finalizer-namespace keyIds", () => {
  const k = ed25519();
  assert.deepEqual(loadFinalizerKeyring({ keys: { "finalizer:panel:v1": k.pem } }).keys, { "finalizer:panel:v1": k.pem });
  assert.throws(() => loadFinalizerKeyring({ keys: { "worker:alpha:v1": k.pem } }), /finalizer:/);
  assert.throws(() => loadFinalizerKeyring({ keys: { "finalizer:x": 5 } as never }), /must be a PEM string/);
  assert.throws(() => loadFinalizerKeyring({} as never), /keys/);
});

// --- lifecycle (#1383 V-c follow-up: immediate revocation + validity window) ---

function signedVerdict(privateKey: import("node:crypto").KeyObject, producedAt: string) {
  return signVerdict(
    { schemaVersion: "a2a.finalizer.verdict.v1", subject: { kind: "task-result", resultHash: "sha256:abc" }, decision: "go", finalizerKeyId: "finalizer:panel:v1", producedAt },
    privateKey, "finalizer:panel:v1",
  );
}

test("a revoked finalizer key is rejected regardless of a valid signature (immediate revocation)", () => {
  const k = ed25519();
  const keyring: FinalizerKeyring = { keys: { "finalizer:panel:v1": { pem: k.pem, status: "revoked" } } };
  const verdict = signedVerdict(k.privateKey, "2026-07-07T00:00:00.000Z");
  assert.match(verifyFinalizerVerdictSignature(verdict, keyring).reason ?? "", /revoked/);
});

test("producedAt outside the key validity window is rejected; inside passes", () => {
  const k = ed25519();
  const keyring: FinalizerKeyring = {
    keys: { "finalizer:panel:v1": { pem: k.pem, notBefore: "2026-07-01T00:00:00.000Z", expiresAt: "2026-08-01T00:00:00.000Z" } },
  };
  assert.equal(verifyFinalizerVerdictSignature(signedVerdict(k.privateKey, "2026-07-15T00:00:00.000Z"), keyring).ok, true);
  assert.match(verifyFinalizerVerdictSignature(signedVerdict(k.privateKey, "2026-06-15T00:00:00.000Z"), keyring).reason ?? "", /window|notBefore/);
  assert.match(verifyFinalizerVerdictSignature(signedVerdict(k.privateKey, "2026-09-15T00:00:00.000Z"), keyring).reason ?? "", /window|expiresAt/);
});

test("a validity window with no producedAt on the verdict fails closed", () => {
  const k = ed25519();
  const keyring: FinalizerKeyring = { keys: { "finalizer:panel:v1": { pem: k.pem, expiresAt: "2026-08-01T00:00:00.000Z" } } };
  const noProducedAt = signVerdict(
    { schemaVersion: "a2a.finalizer.verdict.v1", subject: { kind: "task-result", resultHash: "sha256:abc" }, decision: "go", finalizerKeyId: "finalizer:panel:v1" },
    k.privateKey, "finalizer:panel:v1",
  );
  assert.equal(verifyFinalizerVerdictSignature(noProducedAt, keyring).ok, false);
});

test("loadFinalizerKeyring accepts the record form and validates lifecycle fields", () => {
  const k = ed25519();
  const loaded = loadFinalizerKeyring({ keys: { "finalizer:panel:v1": { pem: k.pem, status: "active", notBefore: "2026-07-01T00:00:00.000Z" } } });
  assert.equal((loaded.keys["finalizer:panel:v1"] as { status: string }).status, "active");
  assert.throws(() => loadFinalizerKeyring({ keys: { "finalizer:x:v1": { pem: k.pem, status: "paused" } } as never }), /status/);
  assert.throws(() => loadFinalizerKeyring({ keys: { "finalizer:x:v1": { pem: k.pem, notBefore: "not-a-date" } } as never }), /notBefore|ISO|instant/i);
  assert.throws(
    () => loadFinalizerKeyring({ keys: { "finalizer:x:v1": { pem: k.pem, notBefore: "2026-08-01T00:00:00.000Z", expiresAt: "2026-07-01T00:00:00.000Z" } } as never }),
    /earlier than expiresAt|before/i,
  );
});
