import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  findingDisposition,
  reviewLineageSimulationFixtureSchema,
  runReviewLineageSimulation,
  type ReviewLineageSimulationResult,
} from "./simulation-fixture.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../fixtures/review-lifecycle/", import.meta.url),
);
const EXPECTED_FIXTURES = [
  "converging.json",
  "moving-goalpost.json",
  "non-converging.json",
  "scope-drift.json",
];

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}/${name}`, "utf8"));
}

function run(name: string): ReviewLineageSimulationResult {
  return runReviewLineageSimulation(loadFixture(name));
}

test("review lineage simulations expose exactly the four Phase 3.3 fixtures", () => {
  assert.deepEqual(
    readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json")).sort(),
    EXPECTED_FIXTURES,
  );
});

test("converging fixture passes after one correction and two reviewer runs", () => {
  const result = run("converging.json");
  assert.equal(result.record.state, "passed");
  assert.equal(result.record.counters.correctionGenerations, 1);
  assert.equal(result.record.counters.reviewerRuns, 2);
  assert.equal(result.steps.length, 3, "initial review + correction + resolution only");
  assert.equal(findingDisposition(result, "F-1"), "resolved");
});

test("non-converging fixture stops on the repeated finding signature", () => {
  const result = run("non-converging.json");
  assert.equal(result.record.state, "blocked_needs_operator");
  assert.equal(result.record.terminalReason, "repeated_findings");
  assert.equal(result.record.counters.repeatedSignatureHits, 1);
  assert.ok(result.effects.includes("repeated_signature_stop:F-1"));
});

test("moving-goalpost fixture keeps a new design preference non-blocking", () => {
  const result = run("moving-goalpost.json");
  const designFinding = result.record.ledger.findings.find(
    (finding) => finding.findingId === "F-2",
  );
  assert.equal(result.record.state, "passed");
  assert.equal(designFinding?.blocking, false);
  assert.ok(result.effects.includes("nonblocking_category_normalized:F-2"));
});

test("scope-drift fixture rejects the candidate and preserves the original head", () => {
  const result = run("scope-drift.json");
  assert.equal(result.record.state, "correction_pending");
  assert.equal(result.record.currentHeadSha, result.record.contract.headSha);
  assert.equal(result.record.counters.correctionGenerations, 0);
  assert.equal(result.record.counters.scopeDriftRejections, 1);
});

test("fixture schema fails closed on undeclared fields", () => {
  const fixture = loadFixture("converging.json") as Record<string, unknown>;
  assert.throws(
    () => reviewLineageSimulationFixtureSchema.parse({ ...fixture, writeAuthority: true }),
    /unrecognized_keys/i,
  );
});

test("fixture harness rejects expectation drift", () => {
  const fixture = structuredClone(
    loadFixture("scope-drift.json"),
  ) as Record<string, unknown>;
  const expected = fixture.expect as Record<string, unknown>;
  expected.state = "passed";
  assert.throws(
    () => runReviewLineageSimulation(fixture),
    /expected state passed, got correction_pending/,
  );
});

test("fixture harness rejects finding-signature drift", () => {
  const fixture = structuredClone(loadFixture("converging.json")) as {
    steps: Array<{
      event: {
        newFindings?: Array<{ signature: string }>;
      };
    }>;
  };
  const finding = fixture.steps[0]?.event.newFindings?.[0];
  assert.ok(finding);
  finding.signature = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => runReviewLineageSimulation(fixture),
    /finding F-1 signature mismatch/,
  );
});
