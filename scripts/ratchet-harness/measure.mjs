#!/usr/bin/env node
/**
 * Ratchet harness — protected evaluator for the ratchet experiment lane PoC
 * (a2a-nexus#1636). This file is BROKER-OWNED. Workers must not modify it.
 *
 * Metric: wall-clock of the pinned two-phase core-suite run
 *   phase 1: npx tsc -b tsconfig.json            (packages/broker)
 *   phase 2: node --test [--test-concurrency N] dist/core/*.test.js
 * 3 repetitions, median of (phase1 + phase2) per repetition.
 *
 * Invariant (metric-gaming guard): aggregated TAP counts must equal the
 * pinned baseline exactly (tests, pass) and fail must be 0. Any deviation
 * discards the attempt regardless of measured time.
 *
 * Worker-writable surface (ONLY): scripts/ratchet-harness/ratchet-target.json
 *   { "testConcurrency": <int 1..32>, "nodeOptions": "<NODE_OPTIONS string>" }
 *
 * Usage:
 *   node scripts/ratchet-harness/measure.mjs                 # measure vs baseline
 *   node scripts/ratchet-harness/measure.mjs --record-baseline  # (operator only) pin new baseline
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const BROKER = join(REPO_ROOT, "packages", "broker");
const BASELINE_PATH = join(HERE, "baseline.json");
const TARGET_PATH = join(HERE, "ratchet-target.json");
const RUNS_DIR = join(HERE, "runs");

// Pinned after baseline recording (operator step). Empty = enforcement off
// only until first pin; measure mode REFUSES to run unpinned.
const EXPECTED_BASELINE_SHA256 = "91d44eab82ff9188e6f03d0b7bd81181da96ea164f076e903fadb69c515a039f";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function failClosed(reason, extra = {}) {
  const out = { ok: false, crash: true, reason, ...extra };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(2);
}

function loadTarget() {
  if (!existsSync(TARGET_PATH)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(TARGET_PATH, "utf8"));
  } catch (error) {
    failClosed(`ratchet-target.json is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    failClosed("ratchet-target.json must be an object");
  }
  const allowed = new Set(["testConcurrency", "nodeOptions"]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) failClosed(`ratchet-target.json: key ${key} is outside the write surface`);
  }
  if (parsed.testConcurrency !== undefined) {
    const n = parsed.testConcurrency;
    if (!Number.isInteger(n) || n < 1 || n > 32) {
      failClosed("testConcurrency must be an integer in [1, 32]");
    }
  }
  if (parsed.nodeOptions !== undefined && typeof parsed.nodeOptions !== "string") {
    failClosed("nodeOptions must be a string");
  }
  if (typeof parsed.nodeOptions === "string" && parsed.nodeOptions.length > 500) {
    failClosed("nodeOptions too long");
  }
  return parsed;
}

function runPhase(command, args, options) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: BROKER,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  const elapsedMs = performance.now() - started;
  return { result, elapsedMs };
}

function parseTapSummary(tap) {
  const counts = {};
  for (const line of tap.split("\n")) {
    const match = line.match(/^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$/);
    if (match) counts[match[1]] = Number(match[2]);
  }
  for (const key of ["tests", "pass", "fail"]) {
    if (typeof counts[key] !== "number") return null;
  }
  return counts;
}

// Failing test IDs from either reporter shape: spec ("✖ name (12.3ms)") or
// TAP ("not ok 7 - name"). Deduplicated, order of first appearance.
function extractFailingTests(tap) {
  const failing = [];
  const seen = new Set();
  for (const line of tap.split("\n")) {
    const trimmed = line.trim();
    let name = null;
    let match = trimmed.match(/^✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/);
    if (match) name = match[1];
    if (!name) {
      match = trimmed.match(/^not ok \d+ - (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/);
      if (match) name = match[1];
    }
    if (name && !seen.has(name)) {
      seen.add(name);
      failing.push(name);
    }
  }
  return failing;
}

function preserveRunTap(stamp, index, tap) {
  mkdirSync(RUNS_DIR, { recursive: true });
  const path = join(RUNS_DIR, `${stamp}-run${index + 1}.log`);
  writeFileSync(path, tap);
  return path;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function testFiles() {
  return readdirSync(join(BROKER, "dist", "core"))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => join("dist", "core", name))
    .sort();
}

function measureOnce(target) {
  // phase 1: pinned build command (literal — never routed through package.json)
  const build = runPhase("npx", ["tsc", "-b", "tsconfig.json"], {
    env: { ...process.env, ...(target.nodeOptions ? { NODE_OPTIONS: target.nodeOptions } : {}) },
  });
  if ((build.result.status ?? 1) !== 0) {
    return { crash: true, phase: "build", stderrTail: (build.result.stderr || "").toString().slice(-2000) };
  }
  // phase 2: pinned test command
  const testArgs = ["--test"];
  if (target.testConcurrency) testArgs.push(`--test-concurrency=${target.testConcurrency}`);
  testArgs.push(...testFiles());
  const test = runPhase("node", testArgs, {
    env: { ...process.env, ...(target.nodeOptions ? { NODE_OPTIONS: target.nodeOptions } : {}) },
  });
  const tap = (test.result.stdout || "").toString();
  const counts = parseTapSummary(tap);
  if (!counts) {
    return { crash: true, phase: "test", reason: "TAP summary not found", tap, stderrTail: (test.result.stderr || "").toString().slice(-2000) };
  }
  return {
    crash: false,
    buildMs: Math.round(build.elapsedMs),
    testMs: Math.round(test.elapsedMs),
    totalMs: Math.round(build.elapsedMs + test.elapsedMs),
    counts,
    failingTests: extractFailingTests(tap),
    tap,
    exitStatus: test.result.status ?? 1,
  };
}

function main() {
  const recordBaseline = process.argv.includes("--record-baseline");
  const target = loadTarget();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Persist per-run raw test output so a flaky/non-green run is diagnosable
  // after the fact (PoC attempt 11 lost the failing test ID without this).
  // Returns run views safe for JSON output (raw tap stripped).
  function collectRuns() {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const run = measureOnce(target);
      const { tap, ...view } = run;
      if (typeof tap === "string") view.tapFile = preserveRunTap(stamp, i, tap);
      runs.push(view);
    }
    return runs;
  }

  if (recordBaseline) {
    const runs = collectRuns();
    const bad = runs.find((r) => r.crash || r.counts.fail !== 0 || r.exitStatus !== 0);
    if (bad) {
      failClosed("baseline run is not green — refusing to pin", { run: bad });
    }
    const baseline = {
      kind: "ratchet-baseline-v1",
      recordedAt: new Date().toISOString(),
      host: { cpus: 8, note: "8-core VPS" },
      node: process.version,
      phases: ["npx tsc -b tsconfig.json", "node --test dist/core/*.test.js"],
      target,
      tests: runs[0].counts.tests,
      pass: runs[0].counts.pass,
      fail: runs[0].counts.fail,
      median_ms: Math.round(median(runs.map((r) => r.totalMs))),
      median_build_ms: Math.round(median(runs.map((r) => r.buildMs))),
      median_test_ms: Math.round(median(runs.map((r) => r.testMs))),
      runs: runs.map((r) => ({ buildMs: r.buildMs, testMs: r.testMs, totalMs: r.totalMs })),
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ ok: true, recorded: true, baselineSha256: sha256File(BASELINE_PATH), baseline }) + "\n");
    return;
  }

  // measure mode: baseline integrity first (fail closed)
  if (EXPECTED_BASELINE_SHA256 === "__PINNED_AFTER_BASELINE__") {
    failClosed("baseline not pinned yet — operator must record and pin baseline first");
  }
  if (!existsSync(BASELINE_PATH)) failClosed("baseline.json missing");
  if (sha256File(BASELINE_PATH) !== EXPECTED_BASELINE_SHA256) {
    failClosed("baseline.json tampered (sha256 mismatch)");
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

  const runs = collectRuns();
  const crashed = runs.find((r) => r.crash);
  if (crashed) {
    process.stdout.write(JSON.stringify({ ok: false, crash: true, phase: crashed.phase, detail: crashed, runs }) + "\n");
    return;
  }
  const counts = runs[0].counts;
  const invariantOk =
    counts.tests === baseline.tests &&
    counts.pass === baseline.pass &&
    counts.fail === 0 &&
    runs.every((r) => r.exitStatus === 0);
  const medianTotal = Math.round(median(runs.map((r) => r.totalMs)));
  const deltaPct = Number((((medianTotal - baseline.median_ms) / baseline.median_ms) * 100).toFixed(2));
  process.stdout.write(JSON.stringify({
    ok: true,
    crash: false,
    median_ms: medianTotal,
    median_build_ms: Math.round(median(runs.map((r) => r.buildMs))),
    median_test_ms: Math.round(median(runs.map((r) => r.testMs))),
    delta_pct: deltaPct,
    test_count: counts.tests,
    pass_count: counts.pass,
    fail_count: counts.fail,
    invariant_ok: invariantOk,
    failing_tests: [...new Set(runs.flatMap((r) => r.failingTests || []))],
    target,
    runs: runs.map((r) => ({ buildMs: r.buildMs, testMs: r.testMs, totalMs: r.totalMs, exitStatus: r.exitStatus, failingTests: r.failingTests, tapFile: r.tapFile })),
  }) + "\n");
}

main();
