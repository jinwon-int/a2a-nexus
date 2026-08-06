#!/usr/bin/env node
/**
 * Deterministic fixtures for the failure-signature measurement report
 * (#1725): structured #1734 records, legacy message-based failures,
 * substantive lanes, unknown adapters, and the advisory thresholds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_THRESHOLDS,
  buildFailureSignatureReport,
  classifyLaneForSignatureReport,
} from "./analysis-bridge-failure-signature-report.mjs";

const SCRIPT = new URL("./analysis-bridge-failure-signature-report.mjs", import.meta.url).pathname;

function invalidJsonLane(adapter, overrides = {}) {
  return {
    id: `t-${adapter}-${Math.random().toString(36).slice(2, 8)}`,
    status: "failed",
    error: {
      code: "handler_exit_nonzero",
      details: {
        bridgeFailure: {
          code: "analysis_bridge_invalid_json",
          adapterClass: adapter,
          failureShape: "schema_invalid",
          turnsUsed: 20,
          elapsedMs: 900_000,
          ...overrides,
        },
      },
    },
  };
}

function substantiveLane(adapter) {
  return {
    id: `t-${adapter}-ok`,
    status: "succeeded",
    result: { output: { bridgeAdapter: adapter, analysisStatus: "done", findings: ["substantive finding"] } },
  };
}

test("structured #1734 records classify with shape, turns, and elapsed preserved", () => {
  const lane = classifyLaneForSignatureReport(invalidJsonLane("claude_code"));
  assert.equal(lane.class, "invalid_json");
  assert.equal(lane.failureShape, "schema_invalid");
  assert.equal(lane.turnsUsed, 20);
  assert.equal(lane.elapsedMs, 900_000);
  assert.equal(lane.evidence, "structured");
});

test("legacy unstructured failures classify via the message path without invented telemetry", () => {
  const lane = classifyLaneForSignatureReport({
    id: "t-legacy",
    status: "failed",
    error: { code: "openclaw_analysis_failed", message: "Claude output did not contain valid analysis JSON" },
  });
  assert.equal(lane.class, "invalid_json");
  assert.equal(lane.failureShape, "legacy_unstructured");
  assert.equal(lane.turnsUsed, undefined);
});

test("report aggregates per adapter class with rates and wasted-cost counters", () => {
  const tasks = [
    invalidJsonLane("claude_code"),
    invalidJsonLane("claude_code", { failureShape: "provider_error_text", turnsUsed: 3, elapsedMs: 120_000 }),
    invalidJsonLane("claude_code", { failureShape: "schema_invalid", turnsUsed: 26, elapsedMs: 1_200_000 }),
    substantiveLane("claude_code"),
    substantiveLane("codex"),
    substantiveLane("codex"),
    {
      id: "t-legacy-unknown",
      status: "failed",
      error: { code: "openclaw_analysis_failed", message: "did not contain valid analysis JSON" },
    },
  ];
  const report = buildFailureSignatureReport(tasks);
  assert.equal(report.laneCount, 7);
  const claude = report.adapters.find((row) => row.adapterClass === "claude_code");
  assert.equal(claude.lanes, 4);
  assert.equal(claude.substantive, 1);
  assert.equal(claude.invalidJson, 3);
  assert.equal(claude.invalidJsonRate, 0.75);
  assert.equal(claude.turnsWasted, 49);
  assert.equal(claude.elapsedMsWasted, 2_220_000);
  assert.equal(claude.structuredCoverage, 3);
  assert.deepEqual(claude.byShape, { schema_invalid: 2, provider_error_text: 1 });
  assert.equal(claude.recommendedAction, "temporary-exclusion-candidate");
  const codex = report.adapters.find((row) => row.adapterClass === "codex");
  assert.equal(codex.recommendedAction, "none");
  const unknown = report.adapters.find((row) => row.adapterClass === "unknown");
  assert.equal(unknown.invalidJson, 1);
  assert.equal(unknown.recommendedAction, "none", "one legacy hit stays below the warning floor");
});

test("thresholds: warning at two hits, exclusion needs count AND rate", () => {
  const twoHits = [
    invalidJsonLane("hermes"),
    invalidJsonLane("hermes"),
    substantiveLane("hermes"),
    substantiveLane("hermes"),
  ];
  const report = buildFailureSignatureReport(twoHits);
  const hermes = report.adapters.find((row) => row.adapterClass === "hermes");
  assert.equal(hermes.invalidJson, 2);
  assert.equal(hermes.recommendedAction, "preflight-warning");

  const threeHitsLowRate = [
    invalidJsonLane("hermes"),
    invalidJsonLane("hermes"),
    invalidJsonLane("hermes"),
    substantiveLane("hermes"),
    substantiveLane("hermes"),
    substantiveLane("hermes"),
    substantiveLane("hermes"),
    substantiveLane("hermes"),
    substantiveLane("hermes"),
    substantiveLane("hermes"),
  ];
  const lowRate = buildFailureSignatureReport(threeHitsLowRate);
  assert.equal(
    lowRate.adapters.find((row) => row.adapterClass === "hermes").recommendedAction,
    "preflight-warning",
    "3 hits at 3/10 rate must NOT exclude — both conditions are required",
  );
});

test("CLI prints the human report and honors --json", () => {
  const dir = mkdtempSync(join(tmpdir(), "signature-report-"));
  try {
    const dump = join(dir, "tasks.json");
    writeFileSync(dump, JSON.stringify({ items: [invalidJsonLane("claude_code"), substantiveLane("codex")] }), "utf8");
    const human = spawnSync(process.execPath, [SCRIPT, "--tasks", dump], { encoding: "utf8" });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /claude_code: lanes=1 .* invalidJson=1/);
    assert.match(human.stdout, /measurement only/);
    const json = spawnSync(process.execPath, [SCRIPT, "--tasks", dump, "--json"], { encoding: "utf8" });
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.kind, "analysis-bridge-failure-signature-report");
    assert.deepEqual(report.thresholds, DEFAULT_THRESHOLDS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
