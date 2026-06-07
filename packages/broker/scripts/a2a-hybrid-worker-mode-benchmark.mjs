#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function fail(message) {
  throw new Error(message);
}

function assertBenchmark(input) {
  if (!input || typeof input !== "object") fail("benchmark input must be an object");
  if (input.sourceOnly !== true || input.noLive !== true) fail("benchmark must be sourceOnly and noLive");
  if (!Array.isArray(input.samples)) fail("benchmark samples must be an array");
  const requiredSizes = ["small", "medium", "large"];
  const requiredModes = ["solo", "a2a_direct", "a2a_hybrid"];
  for (const size of requiredSizes) {
    for (const mode of requiredModes) {
      if (!input.samples.some((sample) => sample.taskSize === size && sample.mode === mode)) {
        fail(`missing ${size}/${mode} sample`);
      }
    }
  }
  for (const sample of input.samples) {
    if (sample.brokerRouteP95Seconds > 2) fail(`${sample.sampleId} exceeds broker p95 SLO`);
    if (sample.brokerRouteP99Seconds > 5) fail(`${sample.sampleId} exceeds broker p99 SLO`);
  }
  const smallHybrid = input.samples.find((sample) => sample.taskSize === "small" && sample.mode === "a2a_hybrid");
  if (!smallHybrid || smallHybrid.conclusion !== "not_enabled_small") {
    fail("small a2a_hybrid sample must remain not_enabled_small");
  }
  for (const size of ["medium", "large"]) {
    const hybrid = input.samples.find((sample) => sample.taskSize === size && sample.mode === "a2a_hybrid");
    const baselines = input.samples.filter((sample) => sample.taskSize === size && sample.mode !== "a2a_hybrid");
    if (!hybrid || baselines.length < 2) fail(`missing ${size} hybrid or baselines`);
    const improved = baselines.some((baseline) =>
      hybrid.decisionWallSeconds < baseline.decisionWallSeconds
      || hybrid.finalizerReviewSeconds < baseline.finalizerReviewSeconds
      || hybrid.evidenceCompletenessScore > baseline.evidenceCompletenessScore
      || hybrid.reworkCount < baseline.reworkCount
      || hybrid.qualityFindingsCount > baseline.qualityFindingsCount
    );
    if (!improved) fail(`${size} hybrid does not improve any headline metric`);
  }
  return {
    benchmarkVersion: input.benchmarkVersion,
    samples: input.samples.length,
    status: "pass",
    checked: {
      sourceOnly: true,
      noLive: true,
      smallHybridNotEnabled: true,
      mediumLargeHybridImproves: true,
      brokerRouteSlo: "p95<=2s,p99<=5s",
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const inputPath = readOption(argv, "--input");
  if (!inputPath) {
    throw new Error("usage: node scripts/a2a-hybrid-worker-mode-benchmark.mjs --input fixture.json");
  }
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  console.log(JSON.stringify(assertBenchmark(input), null, 2));
}

main().catch((error) => {
  console.error("a2a-hybrid-worker-mode-benchmark: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
});
