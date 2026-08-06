#!/usr/bin/env node
/**
 * Analysis-bridge failure-signature measurement report (#1725 finding 1,
 * "측정 후 결정" item).
 *
 * The audit asked for measurement BEFORE deciding whether a repeated
 * invalid-JSON failure signature should temporarily exclude an adapter class
 * from substantive routing. This script computes that measurement from a task
 * store dump: per adapter class, how many lanes failed with
 * `analysis_bridge_invalid_json`, in which output shapes, at what wasted
 * turn/elapsed cost, and whether the counts cross the advisory thresholds.
 *
 * Read-only and offline: it never mutates routing, workers, or dispatch. The
 * report is the input to an operator decision, never the decision itself.
 *
 * Usage:
 *   node scripts/analysis-bridge-failure-signature-report.mjs --tasks dump.json [--json]
 *     [--warn-threshold 2] [--exclude-threshold 3] [--exclude-rate 0.5]
 */
import fs from "node:fs";
import { parseArgs } from "node:util";

export const DEFAULT_THRESHOLDS = Object.freeze({
  warnThreshold: 2,
  excludeThreshold: 3,
  excludeRate: 0.5,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value) {
  return value === undefined || value === null ? "" : String(value);
}

/** Structured #1734 bridge failure record, when the handler preserved one. */
function bridgeFailureOf(task) {
  const candidates = [
    task?.error?.details?.bridgeFailure,
    task?.error?.details?.error?.bridgeFailure,
  ];
  for (const candidate of candidates) {
    if (isPlainObject(candidate) && typeof candidate.code === "string") return candidate;
  }
  return undefined;
}

function adapterClassOf(task) {
  const structured = bridgeFailureOf(task)?.adapterClass;
  if (structured) return String(structured);
  const fromOutput = task?.result?.output?.bridgeAdapter;
  if (asText(fromOutput)) return asText(fromOutput).trim();
  return "unknown";
}

const LEGACY_INVALID_JSON = /openclaw_analysis_failed|analysis_bridge_invalid_json|did not contain valid analysis JSON|not valid JSON/i;

/**
 * Classify one task lane for the measurement:
 * { class: "invalid_json" | "substantive" | "other_failure" | "non_terminal", ... }
 */
export function classifyLaneForSignatureReport(task) {
  const structured = bridgeFailureOf(task);
  if (structured?.code === "analysis_bridge_invalid_json") {
    return {
      class: "invalid_json",
      failureShape: asText(structured.failureShape) || "unspecified",
      turnsUsed: Number.isFinite(structured.turnsUsed) ? structured.turnsUsed : undefined,
      elapsedMs: Number.isFinite(structured.elapsedMs) ? structured.elapsedMs : undefined,
      evidence: "structured",
    };
  }
  const status = asText(task?.status).toLowerCase();
  if (status === "succeeded") {
    const output = task?.result?.output;
    const substantive = isPlainObject(output)
      && Array.isArray(output.findings) && output.findings.length > 0
      && asText(output.analysisStatus ?? "done") === "done";
    return { class: substantive ? "substantive" : "other_failure", evidence: "result" };
  }
  if (status === "failed" || status === "canceled") {
    const blob = asText(task?.error?.code) + "\n" + asText(task?.error?.message)
      + "\n" + asText(JSON.stringify(task?.error?.details ?? {}));
    if (LEGACY_INVALID_JSON.test(blob)) {
      return { class: "invalid_json", failureShape: "legacy_unstructured", evidence: "message" };
    }
    return { class: "other_failure", evidence: "status" };
  }
  return { class: "non_terminal", evidence: "status" };
}

function recommendAction(row, thresholds) {
  if (row.invalidJson >= thresholds.excludeThreshold && row.invalidJsonRate >= thresholds.excludeRate) {
    return "temporary-exclusion-candidate";
  }
  if (row.invalidJson >= thresholds.warnThreshold) {
    return "preflight-warning";
  }
  return "none";
}

/**
 * Aggregate the measurement per adapter class.
 */
export function buildFailureSignatureReport(tasks, thresholds = DEFAULT_THRESHOLDS) {
  if (!Array.isArray(tasks)) throw new Error("tasks must be an array");
  const rows = new Map();
  for (const task of tasks) {
    if (!isPlainObject(task)) continue;
    const adapterClass = adapterClassOf(task);
    const lane = classifyLaneForSignatureReport(task);
    const row = rows.get(adapterClass) ?? {
      adapterClass,
      lanes: 0,
      substantive: 0,
      invalidJson: 0,
      byShape: {},
      turnsWasted: 0,
      elapsedMsWasted: 0,
      structuredCoverage: 0,
    };
    row.lanes += 1;
    if (lane.class === "invalid_json") {
      row.invalidJson += 1;
      row.byShape[lane.failureShape] = (row.byShape[lane.failureShape] ?? 0) + 1;
      if (lane.turnsUsed !== undefined) row.turnsWasted += lane.turnsUsed;
      if (lane.elapsedMs !== undefined) row.elapsedMsWasted += lane.elapsedMs;
      if (lane.evidence === "structured") row.structuredCoverage += 1;
    } else if (lane.class === "substantive") {
      row.substantive += 1;
    }
    rows.set(adapterClass, row);
  }
  const adapters = [...rows.values()]
    .map((row) => {
      const terminal = row.substantive + row.invalidJson;
      const invalidJsonRate = terminal > 0 ? row.invalidJson / terminal : 0;
      return {
        ...row,
        invalidJsonRate: Math.round(invalidJsonRate * 1000) / 1000,
        recommendedAction: recommendAction({ ...row, invalidJsonRate }, thresholds),
      };
    })
    .sort((a, b) => b.invalidJson - a.invalidJson || a.adapterClass.localeCompare(b.adapterClass));
  return {
    kind: "analysis-bridge-failure-signature-report",
    thresholds,
    laneCount: tasks.length,
    adapters,
  };
}

function loadTasks(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read --tasks file '${file}': ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse --tasks JSON '${file}': ${error.message}`);
  }
  const tasks = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(tasks)) throw new Error(`--tasks file '${file}' must be a JSON array or an object with an 'items' array`);
  return tasks;
}

function printHuman(report) {
  process.stdout.write(`analysis-bridge failure signature report (${report.laneCount} lanes)\n`);
  for (const row of report.adapters) {
    const shapes = Object.entries(row.byShape).map(([shape, count]) => `${shape}:${count}`).join(", ") || "-";
    process.stdout.write(
      `  ${row.adapterClass}: lanes=${row.lanes} substantive=${row.substantive} invalidJson=${row.invalidJson} ` +
      `rate=${row.invalidJsonRate} turnsWasted=${row.turnsWasted} elapsedMsWasted=${row.elapsedMsWasted} ` +
      `shapes=[${shapes}] action=${row.recommendedAction}\n`,
    );
  }
  process.stdout.write(
    "note: measurement only — temporary routing exclusion or preflight warning is an operator decision (#1725).\n",
  );
}

function main() {
  const { values } = parseArgs({
    options: {
      tasks: { type: "string" },
      json: { type: "boolean", default: false },
      "warn-threshold": { type: "string" },
      "exclude-threshold": { type: "string" },
      "exclude-rate": { type: "string" },
    },
  });
  if (!values.tasks) {
    process.stderr.write("usage: --tasks <dump.json> [--json] [--warn-threshold N] [--exclude-threshold N] [--exclude-rate R]\n");
    process.exit(2);
  }
  const thresholds = {
    warnThreshold: Number.isFinite(Number(values["warn-threshold"])) && values["warn-threshold"] !== undefined
      ? Number(values["warn-threshold"]) : DEFAULT_THRESHOLDS.warnThreshold,
    excludeThreshold: Number.isFinite(Number(values["exclude-threshold"])) && values["exclude-threshold"] !== undefined
      ? Number(values["exclude-threshold"]) : DEFAULT_THRESHOLDS.excludeThreshold,
    excludeRate: Number.isFinite(Number(values["exclude-rate"])) && values["exclude-rate"] !== undefined
      ? Number(values["exclude-rate"]) : DEFAULT_THRESHOLDS.excludeRate,
  };
  const report = buildFailureSignatureReport(loadTasks(values.tasks), thresholds);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) main();
