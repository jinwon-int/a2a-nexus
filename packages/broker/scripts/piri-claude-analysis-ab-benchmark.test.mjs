import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { evaluateBenchmark } from "./piri-claude-analysis-ab-benchmark.mjs";

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/piri-claude-analysis-ab/manifest-v1.json"), "utf8"));

function makeArm(sample, adapter, order) {
  const expectedRuntime = manifest.arms[adapter];
  return {
    adapter,
    taskId: `${sample.id}-${adapter}`,
    evidenceUrl: `https://example.invalid/${sample.id}/${adapter}`,
    inputDigest: `sha256:${createHash("sha256").update(sample.id).digest("hex")}`,
    runtimeEvidence: { ...expectedRuntime, evidenceRef: `worker-registry:${adapter}` },
    createdAt: order === 0 ? "2026-08-10T00:00:00.000Z" : "2026-08-10T00:00:03.000Z",
    completedAt: order === 0 ? "2026-08-10T00:00:02.000Z" : "2026-08-10T00:00:05.000Z",
    output: {
      analysisStatus: sample.expectedStatus,
      analysisSummary: "summary",
      findings: [],
      risks: [],
      recommendations: [],
      evidenceRefs: [sample.sourcePaths[0]],
      executionTelemetry: {
        schemaVersion: "a2a.analysis-execution-telemetry.v1",
        source: adapter === "piri" ? "piri_progress_file" : "claude_cli_envelope",
        elapsedMs: 1_500,
        modelRequests: 2,
      },
    },
    rubricScores: sample.rubric.map((criterion) => ({
      criterionId: criterion.id,
      awarded: criterion.weight,
      rationale: "fixture score",
      evidenceRefs: [sample.sourcePaths[0]],
    })),
  };
}

function makeResults() {
  return {
    benchmarkVersion: manifest.benchmarkVersion,
    baseRevision: manifest.baseRevision,
    operatorApprovalRef: "operator-approval:test",
    scoredBy: "independent-finalizer",
    budgetSnapshot: {
      remainingBeforeStart: 200,
      observedPiriRequests: 10,
      observedAt: "2026-08-10T00:00:00.000Z",
      source: "provider-usage-snapshot:test",
    },
    pairs: manifest.samples.map((sample, index) => {
      const runOrder = index % 2 === 0 ? ["piri", "claude_code"] : ["claude_code", "piri"];
      return {
        sampleId: sample.id,
        inputDigest: `sha256:${createHash("sha256").update(sample.id).digest("hex")}`,
        runOrder,
        arms: {
          piri: makeArm(sample, "piri", runOrder.indexOf("piri")),
          claude_code: makeArm(sample, "claude_code", runOrder.indexOf("claude_code")),
        },
      };
    }),
  };
}

test("evaluates five exact-input broker-backed pairs across all four axes", () => {
  const report = evaluateBenchmark(manifest, makeResults());
  assert.equal(report.pairCount, 5);
  assert.equal(report.arms.piri.schemaFitRate, 1);
  assert.equal(report.arms.claude_code.expectedStatusRate, 1);
  assert.equal(report.arms.piri.qualityPercent.mean, 100);
  assert.equal(report.arms.piri.modelRequests.total, 10);
  assert.equal(report.arms.claude_code.executionLatencyMs.median, 1500);
  assert.equal(report.arms.piri.costUsd, "unavailable");
});

test("fails closed when paired inputs differ", () => {
  const results = makeResults();
  results.pairs[0].arms.claude_code.inputDigest = "sha256:different";
  assert.throws(() => evaluateBenchmark(manifest, results), /exact inputDigest/);
});

test("fails closed when request telemetry or independent scoring is absent", () => {
  const missingTelemetry = makeResults();
  delete missingTelemetry.pairs[0].arms.piri.output.executionTelemetry;
  assert.throws(() => evaluateBenchmark(manifest, missingTelemetry), /missing execution telemetry/);

  const selfScored = makeResults();
  selfScored.scoredBy = "piri";
  assert.throws(() => evaluateBenchmark(manifest, selfScored), /independent scoredBy/);
});

test("fails closed on fractional or truncated request telemetry", () => {
  const fractional = makeResults();
  fractional.pairs[0].arms.piri.output.executionTelemetry.modelRequests = 1.5;
  assert.throws(() => evaluateBenchmark(manifest, fractional), /modelRequests must be an integer/);

  const truncated = makeResults();
  truncated.pairs[0].arms.piri.output.executionTelemetry.truncated = true;
  assert.throws(() => evaluateBenchmark(manifest, truncated), /telemetry is truncated/);
});

test("fails closed on unbalanced or non-sequential arm order", () => {
  const unbalanced = makeResults();
  for (const pair of unbalanced.pairs) {
    pair.runOrder = ["piri", "claude_code"];
    pair.arms.piri.createdAt = "2026-08-10T00:00:00.000Z";
    pair.arms.piri.completedAt = "2026-08-10T00:00:02.000Z";
    pair.arms.claude_code.createdAt = "2026-08-10T00:00:03.000Z";
    pair.arms.claude_code.completedAt = "2026-08-10T00:00:05.000Z";
  }
  assert.throws(() => evaluateBenchmark(manifest, unbalanced), /arm order must be balanced/);

  const overlapping = makeResults();
  const pair = overlapping.pairs[0];
  pair.arms[pair.runOrder[1]].createdAt = "2026-08-10T00:00:01.000Z";
  assert.throws(() => evaluateBenchmark(manifest, overlapping), /arms must run sequentially/);
});

test("fails closed on duplicate rubric scores", () => {
  const results = makeResults();
  const scores = results.pairs[0].arms.piri.rubricScores;
  scores[1] = { ...scores[0] };
  assert.throws(() => evaluateBenchmark(manifest, results), /exactly one score per rubric criterion/);
});
