// #1301 M3-c attestation bundle checker tests.
// The checker is the bundle consumer's tool: broker-independent schema
// validation, integrity recomputation, and a fail-closed PII/identifier scan
// (second line of defense behind the exporter's redaction pass).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { evaluateAttestationBundle } from "./check-attestation-bundle.mjs";
import { canonicalizeJson } from "./lib/a2a-offline-verify.mjs";

function seal(body) {
  const hash = createHash("sha256").update(canonicalizeJson(body), "utf8").digest("hex");
  return { ...body, integrity: { alg: "sha256-jcs", hash } };
}

function fixtureBundle() {
  return seal({
    bundleVersion: "0",
    subject: {
      kind: "task",
      taskId: "round-77-<author>-01",
      taskIdHash: `sha256:${"a".repeat(64)}`,
      intent: "analyze",
      status: "failed",
      completedAt: "2026-07-07T00:00:00.000Z",
    },
    contract: {
      acceptance: { kind: "command", command: "npm test" },
      declaredScope: { paths: ["src/x.ts"] },
      evidenceGate: "missing",
    },
    evidence: {
      redGreen: "missing",
      validations: [
        { kind: "smoke", verdict: "pass", role: "author" },
        { kind: "review", verdict: "pass", role: "reviewer", note: "independent review" },
      ],
      failures: [{ stage: "handler", excerpt: "exit 1: <redacted-github-token> rejected" }],
      provenance: { resultHash: "sha256:abc", workerSigned: true, brokerCountersigned: true },
    },
  });
}

test("a sealed, clean bundle evaluates with zero problems", () => {
  assert.deepEqual(evaluateAttestationBundle(fixtureBundle()), []);
});

test("integrity tamper is detected (any field, one byte)", () => {
  const bundle = fixtureBundle();
  bundle.evidence.failures[0].excerpt += "!";
  const problems = evaluateAttestationBundle(bundle);
  assert.ok(problems.some((p) => /integrity/.test(p)), problems.join("; "));
});

test("unknown top-level fields and bad version fail closed", () => {
  const extra = seal({ ...structuredClone(fixtureBundle()), surprise: 1 });
  delete extra.integrity;
  const resealed = seal(extra);
  assert.ok(evaluateAttestationBundle(resealed).some((p) => /unknown field 'surprise'/.test(p)));

  const { integrity, ...body } = fixtureBundle();
  const wrongVersion = seal({ ...body, bundleVersion: "1" });
  assert.ok(evaluateAttestationBundle(wrongVersion).some((p) => /bundleVersion/.test(p)));

  assert.ok(evaluateAttestationBundle({ bundleVersion: "0" }).length > 0, "missing sections must fail");
});

test("PII scan rejects identifier and secret shapes anywhere in the bundle (double defense)", () => {
  const { integrity, ...body } = fixtureBundle();

  const withNodeWord = structuredClone(body);
  withNodeWord.evidence.failures[0].excerpt = "ssh vps7 and retry";
  assert.ok(
    evaluateAttestationBundle(seal(withNodeWord)).some((p) => /identifier|forbidden/i.test(p)),
    "structural node identifier must be rejected",
  );

  const withWorkerPrefix = structuredClone(body);
  withWorkerPrefix.subject.taskId = "round-77-worker-zeta-01";
  assert.ok(evaluateAttestationBundle(seal(withWorkerPrefix)).length > 0, "worker- prefixed identifier must be rejected");

  const withSecret = structuredClone(body);
  withSecret.evidence.validations[1].note = `token ghp_${"b".repeat(24)}`;
  assert.ok(evaluateAttestationBundle(seal(withSecret)).length > 0, "secret shape must be rejected");

  const withUrl = structuredClone(body);
  withUrl.contract.acceptance = { kind: "command", command: "curl https://internal.example/run" };
  assert.ok(evaluateAttestationBundle(seal(withUrl)).length > 0, "URLs must be rejected (no endpoints in audit bundles)");
});

test("missing or foreign integrity block fails closed", () => {
  const { integrity, ...body } = fixtureBundle();
  assert.ok(evaluateAttestationBundle(body).some((p) => /integrity/.test(p)));
  const wrongAlg = { ...body, integrity: { alg: "sha1", hash: "00" } };
  assert.ok(evaluateAttestationBundle(wrongAlg).some((p) => /alg/.test(p)));
});
