import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import {
  verifyReport,
  canonicalizeJson,
  REPORT_VERSION,
  CANONICALIZATION,
  RESULT_PROVENANCE_SCHEMA,
  BROKER_COUNTERSIG_SCHEMA,
  RETRIEVAL_SNAPSHOT_SCHEMA,
} from "./verify-analysis-report.mjs";

const CLAIMED_AT = "2026-07-06T00:00:00.000Z";
const VERIFIED_AT = "2026-07-06T00:01:00.000Z";

function sha256Prefix(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * In-test JWS signer mirroring agent-card-signing.ts / provenance.ts (EdDSA):
 * signature covers `${protected}.${base64url(JCS(payload))}`. Kept faithful so
 * the verifier is exercised against bundles shaped exactly like #1380's output.
 * (A guarded round-trip against the real broker signers runs below when the
 * broker dist is present.)
 */
function signJws(payloadObject, privateKey, kid) {
  const protectedHeader = Buffer.from(canonicalizeJson({ alg: "EdDSA", typ: "JOSE", kid })).toString("base64url");
  const payload = Buffer.from(canonicalizeJson(payloadObject)).toString("base64url");
  const signature = sign(null, Buffer.from(`${protectedHeader}.${payload}`, "utf8"), privateKey).toString("base64url");
  return { protected: protectedHeader, signature };
}

function makeCtx() {
  const mk = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return { priv: privateKey, pub: publicKey.export({ type: "spki", format: "pem" }).toString() };
  };
  const worker = mk(), broker = mk(), runner = mk();
  return {
    workerKeyId: "w1", brokerKeyId: "b1", runnerKeyId: "runner1",
    workerPriv: worker.priv, brokerPriv: broker.priv, runnerPriv: runner.priv,
    keyring: { keys: { w1: worker.pub, b1: broker.pub, runner1: runner.pub } },
  };
}

function buildBundle(ctx, opts = {}) {
  const taskId = opts.taskId ?? "task-1";
  const content = opts.snapContent ?? "# A2A Nexus\n";
  const snapContentHash = sha256Prefix(content);

  // By default the result declares the one snapshot it consumed (bijection).
  // opts.declaredSources overrides (null = omit the field entirely).
  const declared = opts.declaredSources !== undefined
    ? opts.declaredSources
    : (opts.omitSources ? null : [{ sourceId: "s1", contentHash: snapContentHash }]);
  const output = { a: 1, b: 2 };
  if (Array.isArray(declared)) output.sources = declared;
  const result = { summary: "finding X holds", output };

  const resultHash = sha256Prefix(canonicalizeJson(result));
  const workerSig = signJws(
    { schemaVersion: RESULT_PROVENANCE_SCHEMA, canonicalization: CANONICALIZATION, taskId, claimedAt: CLAIMED_AT, resultHash },
    ctx.workerPriv, ctx.workerKeyId,
  );
  const counterSig = signJws(
    { schemaVersion: BROKER_COUNTERSIG_SCHEMA, canonicalization: CANONICALIZATION, taskId, verifiedAt: VERIFIED_AT, workerSig },
    ctx.brokerPriv, ctx.brokerKeyId,
  );
  const provenance = {
    schemaVersion: RESULT_PROVENANCE_SCHEMA, canonicalization: CANONICALIZATION, alg: "EdDSA",
    workerKeyId: ctx.workerKeyId, claimedAt: CLAIMED_AT, resultHash, workerSig,
    brokerCountersig: { brokerKeyId: ctx.brokerKeyId, verifiedAt: VERIFIED_AT, sig: counterSig },
  };

  const unsigned = {
    schemaVersion: RETRIEVAL_SNAPSHOT_SCHEMA, canonicalization: CANONICALIZATION, source: "github",
    repo: "a/b", requestedRef: "r", resolvedRef: "r", path: "README.md", fetchedAt: CLAIMED_AT,
    byteLen: Buffer.byteLength(content, "utf8"), contentHash: snapContentHash, content,
  };
  const snapshot = { ...unsigned, signature: signJws(unsigned, ctx.runnerPriv, ctx.runnerKeyId) };

  const bundle = {
    reportVersion: REPORT_VERSION, taskId,
    result: { ...result, provenance },
    sources: opts.omitSources ? [] : [snapshot],
    assurance: {
      proves: ["source-grounding", "integrity", "process-provenance"],
      doesNotProve: ["analytical-correctness", "normative-judgment"],
      disclaimer: "Proves production + integrity, not correctness.",
    },
  };
  if (opts.omitAssurance) delete bundle.assurance;
  return bundle;
}

const check = (result, id) => result.checks.find((c) => c.id === id);

test("valid bundle verifies GREEN with every check passing", () => {
  const ctx = makeCtx();
  const result = verifyReport(buildBundle(ctx), ctx.keyring);
  assert.equal(result.green, true, JSON.stringify(result.checks));
  assert.ok(result.checks.every((c) => c.ok));
});

test("tampered result body breaks the result-hash master check", () => {
  const ctx = makeCtx();
  const bundle = buildBundle(ctx);
  bundle.result.summary = "finding X FAILS";
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(result.green, false);
  assert.equal(check(result, "result-hash").ok, false);
  assert.equal(check(result, "worker-signature").ok, true, "sig covers resultHash, not body — isolates result-hash");
});

test("a bundle presented under a different taskId fails worker-signature (replay)", () => {
  const ctx = makeCtx();
  const bundle = buildBundle(ctx, { taskId: "task-1" });
  bundle.taskId = "task-2"; // taskId is bound by the worker signature, not by resultHash
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(result.green, false);
  assert.equal(check(result, "result-hash").ok, true);
  assert.equal(check(result, "worker-signature").ok, false);
});

test("a perfectly-signed bundle without the assurance invariant is still RED (V0-d)", () => {
  const ctx = makeCtx();
  const result = verifyReport(buildBundle(ctx, { omitAssurance: true }), ctx.keyring);
  assert.equal(check(result, "result-hash").ok, true, "signatures valid");
  assert.equal(check(result, "assurance-invariant").ok, false);
  assert.equal(result.green, false);
});

test("assurance that omits analytical-correctness is rejected", () => {
  const ctx = makeCtx();
  const bundle = buildBundle(ctx);
  bundle.assurance.doesNotProve = ["normative-judgment"]; // correctness claim quietly dropped
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(check(result, "assurance-invariant").ok, false);
  assert.equal(result.green, false);
});

test("unknown worker key fails closed rather than passing", () => {
  const ctx = makeCtx();
  const keyring = { keys: { b1: ctx.keyring.keys.b1, runner1: ctx.keyring.keys.runner1 } };
  const result = verifyReport(buildBundle(ctx), keyring);
  assert.equal(result.green, false);
  assert.equal(check(result, "worker-signature").ok, false);
  assert.match(check(result, "worker-signature").detail, /not in keyring/);
});

test("tampered broker verifiedAt fails the countersignature", () => {
  const ctx = makeCtx();
  const bundle = buildBundle(ctx);
  bundle.result.provenance.brokerCountersig.verifiedAt = "2027-01-01T00:00:00.000Z";
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(result.green, false);
  assert.equal(check(result, "broker-countersignature").ok, false);
});

test("tampered snapshot content breaks its contentHash", () => {
  const ctx = makeCtx();
  const bundle = buildBundle(ctx);
  bundle.sources[0].content = "# A2A Nexus TAMPERED\n";
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(result.green, false);
  assert.equal(check(result, "source[0]").ok, false);
});

test("tampered snapshot metadata breaks its whole-tuple signature", () => {
  const ctx = makeCtx();
  const bundle = buildBundle(ctx);
  bundle.sources[0].repo = "evil/repo"; // signature covers repo, not just content
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(result.green, false);
  assert.equal(check(result, "source[0]").ok, false);
});

test("snapshot signing key absent from keyring fails closed", () => {
  const ctx = makeCtx();
  const keyring = { keys: { w1: ctx.keyring.keys.w1, b1: ctx.keyring.keys.b1 } };
  const result = verifyReport(buildBundle(ctx), keyring);
  assert.equal(result.green, false);
  assert.equal(check(result, "source[0]").ok, false);
});

test("empty sources array is allowed (analysis with no external source)", () => {
  const ctx = makeCtx();
  const result = verifyReport(buildBundle(ctx, { omitSources: true }), ctx.keyring);
  assert.equal(result.green, true, JSON.stringify(result.checks));
  assert.equal(check(result, "source-binding"), undefined, "no binding check when there are no sources");
});

test("a valid bundle binds its snapshot to result.output.sources", () => {
  const ctx = makeCtx();
  const result = verifyReport(buildBundle(ctx), ctx.keyring);
  assert.equal(check(result, "source-binding").ok, true);
  assert.equal(result.green, true);
});

test("an unbound snapshot (present but not declared by the result) is rejected", () => {
  const ctx = makeCtx();
  // snapshot present in report.sources, but result declares no sources.
  const result = verifyReport(buildBundle(ctx, { declaredSources: null }), ctx.keyring);
  assert.equal(check(result, "source-binding").ok, false);
  assert.match(check(result, "source-binding").detail, /unbound/);
  assert.equal(result.green, false);
});

test("a dangling source declaration (declared but no snapshot) is rejected", () => {
  const ctx = makeCtx();
  const result = verifyReport(
    buildBundle(ctx, { omitSources: true, declaredSources: [{ sourceId: "ghost", contentHash: "sha256:ffff" }] }),
    ctx.keyring,
  );
  assert.equal(check(result, "source-binding").ok, false);
  assert.match(check(result, "source-binding").detail, /no matching snapshot/);
  assert.equal(result.green, false);
});

test("tampering the declared source set breaks the signature (binding is signed)", () => {
  const ctx = makeCtx();
  const bundle = buildBundle(ctx);
  bundle.result.output.sources[0].contentHash = "sha256:swapped";
  const result = verifyReport(bundle, ctx.keyring);
  assert.equal(check(result, "result-hash").ok, false, "declared sources are inside the signed result");
  assert.equal(result.green, false);
});

test("malformed bundle is a fail-closed result, not a crash", () => {
  const ctx = makeCtx();
  for (const bad of [null, {}, { reportVersion: "wrong" }, 42, "nope"]) {
    const result = verifyReport(bad, ctx.keyring);
    assert.equal(result.green, false);
    assert.equal(check(result, "shape").ok, false);
  }
});

// Conformance guard: round-trip the REAL #1380 broker signers through this
// standalone verifier. Runs when the broker dist is built (the normal CI case
// after the release-gate build barrier); skips loudly otherwise so a divergence
// between #1380's emit side and this verifier surfaces rather than hiding.
test("conformance: real #1380 provenance signers verify offline", async (t) => {
  let mod;
  try {
    mod = await import("../packages/broker/dist/core/provenance.js");
  } catch {
    return t.skip("broker dist not built — run `npm --workspace packages/broker run build` for the conformance round-trip");
  }
  const keys = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return { priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: publicKey.export({ type: "spki", format: "pem" }).toString() };
  };
  const w = keys(), b = keys(), r = keys();
  const taskId = "task-conformance";
  let snap = mod.buildGithubRetrievalSnapshot({ repo: "a/b", requestedRef: "r", resolvedRef: "r", path: "README.md", fetchedAt: CLAIMED_AT, content: "# A2A Nexus\n" });
  snap = mod.signRetrievalSnapshot(snap, { privateKeyPem: r.priv, keyId: "runner1" });
  // result declares the consumed snapshot (K2 Wave 2 binding) before it is signed.
  const result = { summary: "finding X holds", output: { a: 1, b: 2, sources: [{ sourceId: "s1", contentHash: snap.contentHash }] } };
  let prov = mod.signTaskResultProvenance(result, { taskId, claimedAt: CLAIMED_AT, privateKeyPem: w.priv, workerKeyId: "w1" });
  prov = mod.countersignTaskResultProvenance(prov, { taskId, verifiedAt: VERIFIED_AT, privateKeyPem: b.priv, brokerKeyId: "b1" });
  const bundle = {
    reportVersion: REPORT_VERSION, taskId, result: { ...result, provenance: prov }, sources: [snap],
    assurance: { proves: ["source-grounding", "integrity", "process-provenance"], doesNotProve: ["analytical-correctness", "normative-judgment"], disclaimer: "Proves production + integrity, not correctness." },
  };
  const keyring = { keys: { w1: w.pub, b1: b.pub, runner1: r.pub } };
  const res = verifyReport(bundle, keyring);
  assert.equal(res.green, true, `real #1380 output must verify offline: ${JSON.stringify(res.checks)}`);
  bundle.result.summary = "tampered";
  assert.equal(verifyReport(bundle, keyring).green, false);
});
