import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";

import {
  assertWebCitationsSigned,
  buildWebRetrievalSnapshot,
  signWebRetrievalSnapshot,
  snapshotIdFor,
  verifyWebRetrievalSnapshot,
  WebRetrievalSnapshotError,
} from "./snapshot.js";
import {
  WEB_RETRIEVAL_CANONICALIZATION,
  WEB_RETRIEVAL_SNAPSHOT_SCHEMA,
} from "./web-retrieval-contract.mjs";

function ed25519() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function es256() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function sampleSnapshot(overrides: Partial<Parameters<typeof buildWebRetrievalSnapshot>[0]> = {}) {
  return buildWebRetrievalSnapshot({
    provider: "fixture",
    url: "https://docs.example.com/guide",
    retrievedAt: "2026-08-30T00:00:00.000Z",
    content: "hello web",
    requestQuery: "example docs",
    ...overrides,
  });
}

test("built snapshots carry schema, canonicalization, byte length, and content hash", () => {
  const snapshot = sampleSnapshot();
  assert.equal(snapshot.schemaVersion, WEB_RETRIEVAL_SNAPSHOT_SCHEMA);
  assert.equal(snapshot.canonicalization, WEB_RETRIEVAL_CANONICALIZATION);
  assert.equal(snapshot.byteLen, Buffer.byteLength("hello web", "utf8"));
  assert.match(snapshot.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(snapshot.signature, undefined);
});

test("rejects non-http and credential-bearing urls", () => {
  assert.throws(() => sampleSnapshot({ url: "ftp://docs.example.com/x" }), WebRetrievalSnapshotError);
  assert.throws(() => sampleSnapshot({ url: "https://user:pass@docs.example.com/x" }), WebRetrievalSnapshotError);
  assert.throws(() => sampleSnapshot({ url: "not a url" }), WebRetrievalSnapshotError);
});

test("ed25519 sign + verify round-trips", () => {
  const keys = ed25519();
  const signed = signWebRetrievalSnapshot(sampleSnapshot(), { privateKeyPem: keys.privateKeyPem, keyId: "gw-test-1" });
  assert.equal(signed.signature?.alg, "EdDSA");
  assert.equal(signed.signature?.keyId, "gw-test-1");
  assert.deepEqual(verifyWebRetrievalSnapshot(signed, { publicKeyPem: keys.publicKeyPem }), { ok: true });
});

test("es256 sign + verify round-trips", () => {
  const keys = es256();
  const signed = signWebRetrievalSnapshot(sampleSnapshot(), { privateKeyPem: keys.privateKeyPem, keyId: "gw-test-2" });
  assert.equal(signed.signature?.alg, "ES256");
  assert.deepEqual(verifyWebRetrievalSnapshot(signed, { publicKeyPem: keys.publicKeyPem }), { ok: true });
});

test("alg mismatch between snapshot and verifying key is rejected", () => {
  const ed = ed25519();
  const ec = es256();
  const signed = signWebRetrievalSnapshot(sampleSnapshot(), { privateKeyPem: ed.privateKeyPem, keyId: "gw-test-3" });
  const verdict = verifyWebRetrievalSnapshot(signed, { publicKeyPem: ec.publicKeyPem });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /signature_alg_mismatch/);
});

test("tampered content is rejected", () => {
  const keys = ed25519();
  const signed = signWebRetrievalSnapshot(sampleSnapshot(), { privateKeyPem: keys.privateKeyPem, keyId: "gw-test-4" });
  const tampered = { ...signed, content: "tampered content" };
  const verdict = verifyWebRetrievalSnapshot(tampered, { publicKeyPem: keys.publicKeyPem });
  assert.equal(verdict.ok, false);
});

test("stale content hash with edited content is rejected as hash mismatch", () => {
  const keys = ed25519();
  const signed = signWebRetrievalSnapshot(sampleSnapshot(), { privateKeyPem: keys.privateKeyPem, keyId: "gw-test-5" });
  const tampered = { ...signed, content: "tampered" };
  const verdict = verifyWebRetrievalSnapshot(tampered, { publicKeyPem: keys.publicKeyPem });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /content_hash_mismatch|signature_invalid/);
});

test("stripped signature is rejected as signature_missing", () => {
  const keys = ed25519();
  const signed = signWebRetrievalSnapshot(sampleSnapshot(), { privateKeyPem: keys.privateKeyPem, keyId: "gw-test-6" });
  const { signature: _stripped, ...unsigned } = signed;
  const verdict = verifyWebRetrievalSnapshot(unsigned, { publicKeyPem: keys.publicKeyPem });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /signature_missing/);
});

test("assertWebCitationsSigned reports per-index rejections for unsigned or tampered citations", () => {
  const keys = ed25519();
  const good = signWebRetrievalSnapshot(sampleSnapshot(), { privateKeyPem: keys.privateKeyPem, keyId: "gw-test-7" });
  const unsigned = sampleSnapshot({ url: "https://docs.example.com/other" });
  const tampered = { ...signWebRetrievalSnapshot(sampleSnapshot({ url: "https://docs.example.com/third" }), { privateKeyPem: keys.privateKeyPem, keyId: "gw-test-7" }), retrievedAt: "2020-01-01T00:00:00.000Z" };
  const verdict = assertWebCitationsSigned([good, unsigned, tampered], { publicKeyPem: keys.publicKeyPem });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.deepEqual(verdict.rejections.map((r) => r.index), [1, 2]);
    assert.match(verdict.rejections[0]!.reason, /signature_missing/);
  }
  assert.deepEqual(assertWebCitationsSigned([good], { publicKeyPem: keys.publicKeyPem }), { ok: true });
});

test("snapshotIdFor is stable for identical url+content and differs otherwise", () => {
  const a = sampleSnapshot();
  const b = sampleSnapshot();
  const c = sampleSnapshot({ content: "different" });
  assert.equal(snapshotIdFor(a), snapshotIdFor(b));
  assert.notEqual(snapshotIdFor(a), snapshotIdFor(c));
  assert.match(snapshotIdFor(a), /^web-[0-9a-f]{64}$/);
});
