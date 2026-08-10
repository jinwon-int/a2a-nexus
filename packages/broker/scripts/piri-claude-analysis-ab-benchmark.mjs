#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "piri-claude-analysis-ab-v1";
const ARMS = ["piri", "claude_code"];

function fail(message) {
  throw new Error(message);
}

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function finiteNonNegative(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${label} must be a non-negative number`);
  return parsed;
}

function finiteNonNegativeInteger(value, label) {
  const parsed = finiteNonNegative(value, label);
  if (!Number.isInteger(parsed)) fail(`${label} must be an integer`);
  return parsed;
}

function assertManifest(manifest) {
  if (manifest?.benchmarkVersion !== VERSION) fail(`manifest benchmarkVersion must be ${VERSION}`);
  if (!Array.isArray(manifest.samples) || manifest.samples.length !== 5) fail("manifest requires exactly five paired samples");
  if (manifest.pairCount !== manifest.samples.length) fail("manifest pairCount must equal samples.length");
  if (!manifest.budget || manifest.budget.kimiFiveHourRequestLimit !== 359) fail("manifest must pin the Kimi 5h limit at 359 requests");
  if (manifest.budget.scope !== "owner-facing-shared-account" || manifest.budget.sharedOwnerFacingNodeCount !== 3) {
    fail("manifest must account for the three-node owner-facing shared Kimi budget");
  }
  const ids = new Set();
  let canonicalRubric;
  for (const sample of manifest.samples) {
    if (!sample.id || ids.has(sample.id)) fail("manifest sample ids must be unique and non-empty");
    ids.add(sample.id);
    if (!["done", "blocked"].includes(sample.expectedStatus)) fail(`sample ${sample.id} has invalid expectedStatus`);
    if (!Array.isArray(sample.sourcePaths) || sample.sourcePaths.length === 0) fail(`sample ${sample.id} requires sourcePaths`);
    if (!Array.isArray(sample.rubric) || sample.rubric.length === 0) fail(`sample ${sample.id} requires rubric criteria`);
    const rubricIds = sample.rubric.map(({ id }) => id);
    if (new Set(rubricIds).size !== rubricIds.length) fail(`sample ${sample.id} rubric ids must be unique`);
    const rubricShape = JSON.stringify(sample.rubric.map(({ id, weight, description }) => ({ id, weight, description })));
    canonicalRubric ??= rubricShape;
    if (rubricShape !== canonicalRubric) fail("every sample must use the same rubric");
    for (const criterion of sample.rubric) {
      if (!criterion.id || !Number.isInteger(criterion.weight) || criterion.weight <= 0) {
        fail(`sample ${sample.id} has an invalid rubric criterion`);
      }
    }
  }
  return ids;
}

function schemaFit(output) {
  return Boolean(
    output
      && ["done", "blocked"].includes(output.analysisStatus)
      && typeof output.analysisSummary === "string"
      && Array.isArray(output.findings)
      && Array.isArray(output.risks)
      && Array.isArray(output.recommendations)
      && Array.isArray(output.evidenceRefs),
  );
}

function scoreQuality(sample, arm) {
  const scores = arm.rubricScores ?? [];
  const scoreIds = scores.map((score) => score.criterionId);
  if (new Set(scoreIds).size !== scoreIds.length || scores.length !== sample.rubric.length) {
    fail(`${sample.id}/${arm.adapter} must provide exactly one score per rubric criterion`);
  }
  const awardedById = new Map(scores.map((score) => [score.criterionId, score]));
  let awarded = 0;
  let possible = 0;
  for (const criterion of sample.rubric) {
    const score = awardedById.get(criterion.id);
    if (!score) fail(`${sample.id}/${arm.adapter} missing rubric score ${criterion.id}`);
    const value = finiteNonNegative(score.awarded, `${sample.id}/${arm.adapter}/${criterion.id}.awarded`);
    if (value > criterion.weight) fail(`${sample.id}/${arm.adapter}/${criterion.id}.awarded exceeds weight`);
    if (typeof score.rationale !== "string" || !score.rationale.trim()) fail(`${sample.id}/${arm.adapter}/${criterion.id} requires rationale`);
    if (!Array.isArray(score.evidenceRefs) || score.evidenceRefs.length === 0) fail(`${sample.id}/${arm.adapter}/${criterion.id} requires evidenceRefs`);
    awarded += value;
    possible += criterion.weight;
  }
  return { awarded, possible, percent: possible ? Math.round((awarded / possible) * 10_000) / 100 : 0 };
}

function summarize(values) {
  if (!values.length) return { total: 0, mean: 0, median: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const total = values.reduce((sum, value) => sum + value, 0);
  return { total, mean: Math.round((total / values.length) * 100) / 100, median };
}

export function evaluateBenchmark(manifest, results) {
  const sampleIds = assertManifest(manifest);
  if (results?.benchmarkVersion !== VERSION) fail(`results benchmarkVersion must be ${VERSION}`);
  if (results.baseRevision !== manifest.baseRevision) fail("results baseRevision must match the manifest");
  if (!results.operatorApprovalRef) fail("results require operatorApprovalRef for provider sends");
  if (!results.scoredBy || ARMS.includes(results.scoredBy)) fail("results require an independent scoredBy identity");
  if (!Array.isArray(results.pairs) || results.pairs.length !== manifest.pairCount) fail("results pair count does not match manifest");

  const budget = results.budgetSnapshot;
  if (!budget || !budget.source || !Number.isFinite(Date.parse(budget.observedAt))) {
    fail("results require a timestamped provider-backed budgetSnapshot source");
  }
  const remaining = finiteNonNegativeInteger(budget.remainingBeforeStart, "budgetSnapshot.remainingBeforeStart");
  const observed = finiteNonNegativeInteger(budget.observedPiriRequests, "budgetSnapshot.observedPiriRequests");
  if (remaining < manifest.budget.minimumRemainingBeforeStart) fail("Kimi remaining requests were below the start gate");
  if (observed > manifest.budget.reservedPiriRequests) fail("observed Piri requests exceeded the reserved budget");

  const seen = new Set();
  const seenTaskIds = new Set();
  const firstArmCounts = { piri: 0, claude_code: 0 };
  const perArm = Object.fromEntries(ARMS.map((arm) => [arm, {
    samples: 0,
    schemaFits: 0,
    expectedStatuses: 0,
    qualityPercents: [],
    modelRequests: [],
    executionLatencyMs: [],
    taskWallMs: [],
    costUsd: [],
  }]));

  for (const pair of results.pairs) {
    const sample = manifest.samples.find((candidate) => candidate.id === pair.sampleId);
    if (!sample || !sampleIds.has(pair.sampleId) || seen.has(pair.sampleId)) fail("results contain an unknown or duplicate sampleId");
    seen.add(pair.sampleId);
    if (!Array.isArray(pair.runOrder) || pair.runOrder.length !== 2 || [...pair.runOrder].sort().join(",") !== [...ARMS].sort().join(",")) {
      fail(`${pair.sampleId} requires an explicit two-arm runOrder`);
    }
    firstArmCounts[pair.runOrder[0]] += 1;
    if (!/^sha256:[a-f0-9]{64}$/.test(pair.inputDigest ?? "") || pair.arms?.piri?.inputDigest !== pair.inputDigest || pair.arms?.claude_code?.inputDigest !== pair.inputDigest) {
      fail(`${pair.sampleId} arms must share one exact inputDigest`);
    }
    for (const adapter of ARMS) {
      const arm = pair.arms?.[adapter];
      if (!arm || arm.adapter !== adapter || !arm.taskId || !arm.evidenceUrl) fail(`${pair.sampleId} is missing broker-backed ${adapter} evidence`);
      if (seenTaskIds.has(arm.taskId)) fail("every arm requires a unique fresh-session taskId");
      seenTaskIds.add(arm.taskId);
      const expectedRuntime = manifest.arms[adapter];
      if (
        arm.runtimeEvidence?.adapter !== expectedRuntime.adapter
        || arm.runtimeEvidence?.provider !== expectedRuntime.provider
        || arm.runtimeEvidence?.model !== expectedRuntime.model
        || !arm.runtimeEvidence?.evidenceRef
      ) {
        fail(`${pair.sampleId}/${adapter} runtime evidence does not match the manifest arm`);
      }
      const telemetry = arm.output?.executionTelemetry;
      if (telemetry?.schemaVersion !== "a2a.analysis-execution-telemetry.v1") fail(`${pair.sampleId}/${adapter} is missing execution telemetry`);
      if (telemetry.truncated === true) fail(`${pair.sampleId}/${adapter} telemetry is truncated`);
      const requests = finiteNonNegativeInteger(telemetry.modelRequests, `${pair.sampleId}/${adapter}.modelRequests`);
      if (requests < 1) fail(`${pair.sampleId}/${adapter} must report at least one model request`);
      if (adapter === "piri" && requests > manifest.budget.maxPiriRequestsPerSample) {
        fail(`${pair.sampleId}/piri exceeded the per-sample request budget`);
      }
      const executionMs = finiteNonNegative(telemetry.elapsedMs, `${pair.sampleId}/${adapter}.elapsedMs`);
      const createdMs = Date.parse(arm.createdAt);
      const completedMs = Date.parse(arm.completedAt);
      if (!Number.isFinite(createdMs) || !Number.isFinite(completedMs) || completedMs < createdMs) fail(`${pair.sampleId}/${adapter} has invalid task timestamps`);
      const aggregate = perArm[adapter];
      aggregate.samples += 1;
      aggregate.schemaFits += schemaFit(arm.output) ? 1 : 0;
      aggregate.expectedStatuses += arm.output.analysisStatus === sample.expectedStatus ? 1 : 0;
      aggregate.qualityPercents.push(scoreQuality(sample, arm).percent);
      aggregate.modelRequests.push(requests);
      aggregate.executionLatencyMs.push(executionMs);
      aggregate.taskWallMs.push(completedMs - createdMs);
      if (telemetry.costUsd !== undefined) aggregate.costUsd.push(finiteNonNegative(telemetry.costUsd, `${pair.sampleId}/${adapter}.costUsd`));
    }
    const first = pair.arms[pair.runOrder[0]];
    const second = pair.arms[pair.runOrder[1]];
    if (Date.parse(first.completedAt) > Date.parse(second.createdAt)) fail(`${pair.sampleId} arms must run sequentially`);
  }

  if (Math.abs(firstArmCounts.piri - firstArmCounts.claude_code) > 1) fail("arm order must be balanced across pairs");

  const arms = Object.fromEntries(ARMS.map((adapter) => {
    const values = perArm[adapter];
    return [adapter, {
      samples: values.samples,
      schemaFitRate: values.schemaFits / values.samples,
      expectedStatusRate: values.expectedStatuses / values.samples,
      qualityPercent: summarize(values.qualityPercents),
      modelRequests: summarize(values.modelRequests),
      executionLatencyMs: summarize(values.executionLatencyMs),
      taskWallMs: summarize(values.taskWallMs),
      ...(values.costUsd.length === values.samples ? { costUsd: summarize(values.costUsd) } : { costUsd: "unavailable" }),
    }];
  }));
  if (arms.piri.modelRequests.total !== observed) {
    fail("budgetSnapshot.observedPiriRequests must equal the paired telemetry total");
  }
  return {
    benchmarkVersion: VERSION,
    baseRevision: manifest.baseRevision,
    pairCount: manifest.pairCount,
    budget: {
      limit: manifest.budget.kimiFiveHourRequestLimit,
      reserved: manifest.budget.reservedPiriRequests,
      remainingBeforeStart: remaining,
      observedPiriRequests: observed,
    },
    arms,
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  for (let index = 0; index < args.length; index += 2) flags[args[index]] = args[index + 1];
  return flags;
}

function main() {
  const flags = parseArgs(process.argv);
  if (!flags["--manifest"] || !flags["--results"]) {
    fail("usage: piri-claude-analysis-ab-benchmark.mjs --manifest manifest.json --results results.json");
  }
  process.stdout.write(`${JSON.stringify(evaluateBenchmark(loadJson(flags["--manifest"]), loadJson(flags["--results"])), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`piri-claude-analysis-ab-benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
