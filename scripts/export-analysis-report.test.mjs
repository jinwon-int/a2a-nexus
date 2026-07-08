import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { buildReportBundle, ASSURANCE } from "./export-analysis-report.mjs";
import { verifyReport, REPORT_VERSION, CANONICALIZATION, RESULT_PROVENANCE_SCHEMA, BROKER_COUNTERSIG_SCHEMA, RETRIEVAL_SNAPSHOT_SCHEMA } from "./verify-analysis-report.mjs";
import { canonicalizeJson, sha256Prefix } from "./lib/a2a-offline-verify.mjs";

const CLAIMED_AT = "2026-07-06T00:00:00.000Z";
const VERIFIED_AT = "2026-07-06T00:01:00.000Z";

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
    workerPriv: worker.priv, brokerPriv: broker.priv, runnerPriv: runner.priv,
    keyring: { keys: { w1: worker.pub, b1: broker.pub, runner1: runner.pub } },
  };
}

/** Build a completed task record shaped like the broker stores it, with a full provenance chain. */
function buildSucceededTask(ctx, { taskId = "task-1", omitProvenance = false, omitCountersig = false, status = "succeeded", declaredSources } = {}) {
  const result = { summary: "analysis holds", output: { a: 1, ...(declaredSources ? { sources: declaredSources } : {}) } };
  const resultHash = sha256Prefix(canonicalizeJson(result));
  const workerSig = signJws(
    { schemaVersion: RESULT_PROVENANCE_SCHEMA, canonicalization: CANONICALIZATION, taskId, claimedAt: CLAIMED_AT, resultHash },
    ctx.workerPriv, "w1",
  );
  const counterSig = signJws(
    { schemaVersion: BROKER_COUNTERSIG_SCHEMA, canonicalization: CANONICALIZATION, taskId, verifiedAt: VERIFIED_AT, workerSig },
    ctx.brokerPriv, "b1",
  );
  const provenance = {
    schemaVersion: RESULT_PROVENANCE_SCHEMA, canonicalization: CANONICALIZATION, alg: "EdDSA",
    workerKeyId: "w1", claimedAt: CLAIMED_AT, resultHash, workerSig,
    ...(omitCountersig ? {} : { brokerCountersig: { brokerKeyId: "b1", verifiedAt: VERIFIED_AT, sig: counterSig } }),
  };
  return {
    id: taskId,
    status,
    claimedAt: CLAIMED_AT,
    result: omitProvenance ? result : { ...result, provenance },
  };
}

function buildSignedSnapshot(ctx) {
  const content = "# source\n";
  const unsigned = {
    schemaVersion: RETRIEVAL_SNAPSHOT_SCHEMA, canonicalization: CANONICALIZATION, source: "github",
    repo: "a/b", requestedRef: "r", resolvedRef: "r", path: "README.md", fetchedAt: CLAIMED_AT,
    byteLen: Buffer.byteLength(content, "utf8"), contentHash: sha256Prefix(content), content,
  };
  return { ...unsigned, signature: signJws(unsigned, ctx.runnerPriv, "runner1") };
}

test("exported bundle from a succeeded provenance-carrying task verifies GREEN offline", () => {
  const ctx = makeCtx();
  const bundle = buildReportBundle(buildSucceededTask(ctx));
  assert.equal(bundle.reportVersion, REPORT_VERSION);
  const res = verifyReport(bundle, ctx.keyring);
  assert.equal(res.green, true, JSON.stringify(res.checks));
});

test("exporter refuses a task without provenance (no unverifiable reports)", () => {
  const ctx = makeCtx();
  assert.throws(() => buildReportBundle(buildSucceededTask(ctx, { omitProvenance: true })), /provenance missing/);
});

test("exporter refuses a provenance chain without broker countersignature", () => {
  const ctx = makeCtx();
  assert.throws(() => buildReportBundle(buildSucceededTask(ctx, { omitCountersig: true })), /brokerCountersig missing/);
});

test("exporter refuses a non-succeeded task", () => {
  const ctx = makeCtx();
  assert.throws(() => buildReportBundle(buildSucceededTask(ctx, { status: "failed" })), /requires 'succeeded'/);
});

test("signed snapshots pass through and the full bundle stays GREEN", () => {
  const ctx = makeCtx();
  const snapshot = buildSignedSnapshot(ctx);
  // Result<->source binding (#1374 / #1386 T2): the SIGNED result must declare
  // every snapshot it consumed in result.output.sources, or the verifier
  // fail-closes with an unbound-source rejection.
  const task = buildSucceededTask(ctx, { declaredSources: [{ sourceId: "s1", contentHash: snapshot.contentHash }] });
  const bundle = buildReportBundle(task, { sources: [snapshot] });
  assert.equal(bundle.sources.length, 1);
  const res = verifyReport(bundle, ctx.keyring);
  assert.equal(res.green, true, JSON.stringify(res.checks));
});

test("stamped assurance declares correctness, judgment, and authorship as unproven", () => {
  const ctx = makeCtx();
  const bundle = buildReportBundle(buildSucceededTask(ctx));
  for (const claim of ["analytical-correctness", "normative-judgment", "authorship"]) {
    assert.ok(bundle.assurance.doesNotProve.includes(claim), claim);
  }
  assert.ok(ASSURANCE.disclaimer.includes("does NOT certify"));
});

test("exported bundle is tamper-evident end to end", () => {
  const ctx = makeCtx();
  const bundle = buildReportBundle(buildSucceededTask(ctx));
  bundle.result.summary = "tampered";
  assert.equal(verifyReport(bundle, ctx.keyring).green, false);
});
