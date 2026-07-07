// #1301 M3-b attestation bundle exporter tests.
// The bundle is the single audit document for one task: contract (DoR payload),
// validations (roles, never names), failure readback, provenance distillation,
// and a recomputable integrity hash. Every text field must ride the existing
// broker redaction path and every internal node identifier must be scrubbed.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { buildAttestationBundle, findBundleTasks } from "./export-attestation-bundle.mjs";
import { canonicalizeJson } from "../../../scripts/lib/a2a-offline-verify.mjs";

function fixtureTask(overrides = {}) {
  return {
    id: "round-77-workeralpha-01",
    intent: "analyze",
    status: "failed",
    targetNodeId: "workeralpha",
    claimedBy: "workeralpha",
    assignedWorkerId: "workeralpha",
    completedAt: "2026-07-07T00:00:00.000Z",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    payload: {
      acceptance: { kind: "command", command: "npm test" },
      declaredScope: { paths: ["src/x.ts"] },
      evidenceGate: { requireRedGreen: true },
      mode: "analysis-only",
    },
    result: {
      summary: "found issue under /home/user/secret-place with token=abc123456",
      validations: [
        { nodeId: "workeralpha", kind: "smoke", verdict: "pass", note: "self smoke on workeralpha" },
        { nodeId: "workerbeta", kind: "review", verdict: "pass", note: "independent review by workerbeta" },
      ],
      provenance: {
        schemaVersion: "a2a.result.provenance.v1",
        resultHash: "sha256:abc",
        workerKeyId: "worker:workeralpha:g2:v1",
        workerSig: { protected: "x", signature: "y" },
        brokerCountersig: { brokerKeyId: "broker:hubco:agent-card:v1", sig: { protected: "x", signature: "y" } },
      },
    },
    error: {
      code: "handler_exit_nonzero",
      message: "boom on workeralpha",
      details: { stage: "handler", excerpt: `token ghp_${"a".repeat(24)} leaked\nsecond line` },
    },
    ...overrides,
  };
}

function stringLeaves(value, acc = []) {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, acc);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringLeaves(item, acc);
  return acc;
}

test("bundle carries subject/contract/evidence/integrity with explicit missing markers (#1301 M3-a)", () => {
  const bundle = buildAttestationBundle(fixtureTask());
  assert.equal(bundle.bundleVersion, "0");
  assert.equal(bundle.subject.kind, "task");
  assert.equal(
    bundle.subject.taskIdHash,
    `sha256:${createHash("sha256").update("round-77-workeralpha-01", "utf8").digest("hex")}`,
    "raw task id stays correlatable through its hash",
  );
  assert.deepEqual(bundle.contract.acceptance, { kind: "command", command: "npm test" });
  assert.deepEqual(bundle.contract.declaredScope, { paths: ["src/x.ts"] });
  assert.equal(bundle.evidence.redGreen, "missing", "broker store does not retain PR-body red/green logs in v0");

  const bare = buildAttestationBundle(fixtureTask({ payload: { mode: "analysis-only" }, result: undefined, error: undefined, errorHistory: undefined }));
  assert.equal(bare.contract.acceptance, "missing", "absent fields are marked, never silently omitted");
  assert.equal(bare.contract.declaredScope, "missing");
  assert.equal(bare.evidence.provenance, "missing");
});

test("validations record roles, never node identifiers", () => {
  const bundle = buildAttestationBundle(fixtureTask());
  assert.equal(bundle.evidence.validations.length, 2);
  assert.equal(bundle.evidence.validations[0].role, "author");
  assert.equal(bundle.evidence.validations[1].role, "reviewer");
  for (const validation of bundle.evidence.validations) {
    assert.equal(validation.nodeId, undefined, "node ids must not survive into the bundle");
  }
});

test("every string leaf is redacted and scrubbed of internal node identifiers", () => {
  const bundle = buildAttestationBundle(fixtureTask());
  const leaves = stringLeaves(bundle);
  for (const leaf of leaves) {
    assert.ok(!leaf.includes("workeralpha"), `worker id leaked: ${leaf}`);
    assert.ok(!leaf.includes("workerbeta"), `reviewer id leaked: ${leaf}`);
    assert.ok(!/ghp_[A-Za-z0-9_]{20,}/.test(leaf), `github token leaked: ${leaf}`);
    assert.ok(!leaf.includes("/home/user/secret-place"), `private path leaked: ${leaf}`);
    assert.ok(!/token=abc/.test(leaf), `generic secret leaked: ${leaf}`);
  }
  const failure = bundle.evidence.failures[0];
  assert.equal(failure.stage, "handler");
  assert.match(failure.excerpt, /<redacted-github-token>/);
});

test("provenance is distilled to hash + signature presence (key ids carry node names)", () => {
  const bundle = buildAttestationBundle(fixtureTask());
  assert.deepEqual(bundle.evidence.provenance, {
    resultHash: "sha256:abc",
    workerSigned: true,
    brokerCountersigned: true,
  });
});

test("integrity hash recomputes over the JCS canonical bundle without the integrity field", () => {
  const bundle = buildAttestationBundle(fixtureTask());
  assert.equal(bundle.integrity.alg, "sha256-jcs");
  const { integrity, ...body } = bundle;
  const recomputed = createHash("sha256").update(canonicalizeJson(body), "utf8").digest("hex");
  assert.equal(integrity.hash, recomputed);
});

test("snapshot selection finds tasks by id and by parent round id", () => {
  const snapshot = { tasks: [fixtureTask(), fixtureTask({ id: "other-task", parentRoundId: "round-88" })] };
  assert.equal(findBundleTasks(snapshot, { taskId: "other-task" }).length, 1);
  assert.equal(findBundleTasks(snapshot, { roundId: "round-88" }).length, 1);
  assert.equal(findBundleTasks(snapshot, { taskId: "nope" }).length, 0);
});

test("exporter fails closed on a record without an id", () => {
  assert.throws(() => buildAttestationBundle({ status: "succeeded" }), /task\.id/);
});
