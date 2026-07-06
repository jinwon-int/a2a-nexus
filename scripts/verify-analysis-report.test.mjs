import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  verifyReport,
  digestOf,
  stableJsonStringify,
  REPORT_VERSION,
} from "./verify-analysis-report.mjs";

function signDetached(payload, privateKey) {
  return sign(null, Buffer.from(stableJsonStringify(payload), "utf8"), privateKey).toString("base64url");
}

function makeKeys() {
  const worker = generateKeyPairSync("ed25519");
  const broker = generateKeyPairSync("ed25519");
  return {
    workerKeyId: "worker-key-1",
    brokerKeyId: "broker-key-1",
    workerPriv: worker.privateKey,
    brokerPriv: broker.privateKey,
    keyring: {
      keys: {
        "worker-key-1": worker.publicKey.export({ type: "spki", format: "pem" }),
        "broker-key-1": broker.publicKey.export({ type: "spki", format: "pem" }),
      },
    },
  };
}

/** Build a fully-signed v0 bundle. `overrides` shallow-merges into the pre-sign base. */
function buildBundle(ctx, { taskId = "task-1", omitAssurance = false, base: baseOverride = {} } = {}) {
  const base = {
    reportVersion: REPORT_VERSION,
    taskId,
    producedAt: "2026-07-06T00:00:00.000Z",
    worker: { keyId: ctx.workerKeyId, class: "source-only" },
    analysis: { summary: "finding X holds under condition Y" },
    sources: {
      retrievalClass: "source-capture",
      items: [
        { sourceId: "s1", contentHash: "sha256:1111", fetchedAt: "2026-07-05T00:00:00.000Z" },
        { sourceId: "s2", contentHash: "sha256:2222", fetchedAt: "2026-07-05T01:00:00.000Z" },
      ],
    },
    evidence: { validations: [{ kind: "source-check", verdict: "pass" }] },
    assurance: {
      proves: ["source-grounding", "integrity", "process-provenance"],
      doesNotProve: ["analytical-correctness", "normative-judgment"],
      disclaimer: "Proves production + integrity, not correctness.",
    },
    ...baseOverride,
  };
  if (omitAssurance) delete base.assurance;
  base.analysis.bodyHash = digestOf(base.analysis.summary);
  base.sources.sourcesRoot = digestOf(base.sources.items.map((i) => i.contentHash).sort());

  const resultHash = digestOf(base);
  const workerSig = signDetached({ resultHash, taskId: base.taskId, producedAt: base.producedAt }, ctx.workerPriv);
  const verifiedAt = "2026-07-06T00:01:00.000Z";
  const sig = signDetached({ workerSig, taskId: base.taskId, verifiedAt }, ctx.brokerPriv);
  return {
    ...base,
    provenance: {
      alg: "EdDSA",
      workerKeyId: ctx.workerKeyId,
      resultHash,
      workerSig,
      brokerCountersig: { brokerKeyId: ctx.brokerKeyId, sig, verifiedAt },
    },
  };
}

function checkById(result, id) {
  return result.checks.find((c) => c.id === id);
}

test("valid bundle verifies GREEN with every check passing", () => {
  const ctx = makeKeys();
  const result = verifyReport(buildBundle(ctx), ctx.keyring);
  assert.equal(result.green, true, JSON.stringify(result.checks));
  assert.ok(result.checks.every((c) => c.ok));
});

test("tampered content breaks the result-hash master check (fail-closed)", () => {
  const ctx = makeKeys();
  const bundle = buildBundle(ctx);
  // Mutate a signed field NOT covered by bodyHash so result-hash is the isolated failure.
  bundle.evidence.validations[0].verdict = "fail";
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(result.green, false);
  assert.equal(checkById(result, "result-hash").ok, false);
  assert.equal(checkById(result, "body-hash").ok, true);
});

test("a one-byte analysis edit breaks body-hash and result-hash", () => {
  const ctx = makeKeys();
  const bundle = buildBundle(ctx);
  bundle.analysis.summary += ".";
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(result.green, false);
  assert.equal(checkById(result, "body-hash").ok, false);
  assert.equal(checkById(result, "result-hash").ok, false);
});

test("a signature transplanted from another task fails worker-signature", () => {
  const ctx = makeKeys();
  const other = buildBundle(ctx, { taskId: "other-task" });
  const bundle = buildBundle(ctx, { taskId: "task-1" });
  // Graft the other task's worker signature; content (and thus result-hash) still
  // matches this bundle, isolating the signature-binding failure.
  bundle.provenance.workerSig = other.provenance.workerSig;
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(result.green, false);
  assert.equal(checkById(result, "result-hash").ok, true);
  assert.equal(checkById(result, "worker-signature").ok, false);
});

test("a perfectly-signed bundle without the assurance invariant is still RED (V0-d)", () => {
  const ctx = makeKeys();
  // Signed correctly, but omits the correctness-separation declaration.
  const bundle = buildBundle(ctx, { omitAssurance: true });
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(checkById(result, "result-hash").ok, true, "signature is valid");
  assert.equal(checkById(result, "assurance-invariant").ok, false);
  assert.equal(result.green, false);
});

test("assurance that omits analytical-correctness is rejected", () => {
  const ctx = makeKeys();
  const bundle = buildBundle(ctx, {
    base: {
      assurance: {
        proves: ["integrity"],
        doesNotProve: ["normative-judgment"], // correctness claim quietly dropped
        disclaimer: "looks fine",
      },
    },
  });
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(checkById(result, "assurance-invariant").ok, false);
  assert.equal(result.green, false);
});

test("unknown worker key fails closed rather than passing", () => {
  const ctx = makeKeys();
  const bundle = buildBundle(ctx);
  const emptyKeyring = { keys: { "broker-key-1": ctx.keyring.keys["broker-key-1"] } };
  const result = verifyReport(bundle, emptyKeyring);
  assert.equal(result.green, false);
  assert.equal(checkById(result, "worker-signature").ok, false);
  assert.match(checkById(result, "worker-signature").detail, /not in keyring/);
});

test("tampered source hash breaks sources-root", () => {
  const ctx = makeKeys();
  const bundle = buildBundle(ctx);
  bundle.sources.items[0].contentHash = "sha256:deadbeef";
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(result.green, false);
  assert.equal(checkById(result, "sources-root").ok, false);
});

test("malformed bundle is a fail-closed result, not a crash", () => {
  const ctx = makeKeys();
  for (const bad of [null, {}, { reportVersion: "wrong" }, 42, "nope"]) {
    const result = verifyReport(bad, ctx.keyring);
    assert.equal(result.green, false);
    assert.equal(checkById(result, "shape").ok, false);
  }
});

test("signature whose declared alg mismatches the key is rejected", () => {
  const ctx = makeKeys();
  const bundle = buildBundle(ctx);
  bundle.provenance.alg = "ES256"; // key is ed25519 → declared alg mismatch
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(result.green, false);
  assert.equal(checkById(result, "worker-signature").ok, false);
});
