#!/usr/bin/env node
/**
 * Flag A2A TCK compliance regressions from docs/tck-history.json and list
 * promotion-candidate categories (green across the last N measurements).
 *
 * A regression is a drop in the comparable metric between consecutive
 * measurements of the same level+transport:
 *   - MUST pass count when the suite size (total) is unchanged, else
 *   - OVERALL percent.
 * Suite-size changes are reported as informational, not regressions, so a
 * larger test suite does not raise a false alarm.
 *
 * Usage:
 *   node scripts/check-tck-regressions.mjs [--history path] [--level must]
 *     [--transport jsonrpc] [--stable-window N] [--against-log /tmp/tck-run.log]
 *     [--date YYYY-MM-DD]
 *
 * Exit non-zero when a regression is found. Designed to run as a loud (but
 * non-gating) step in the measurement workflow. Source-only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildMeasurement, measurementKey, parseTckLog, upsertMeasurement } from "./append-tck-history.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HISTORY = path.resolve(scriptDir, "..", "docs", "tck-history.json");

function comparableMetric(m) {
  if (m.must && typeof m.must.pass === "number") {
    return { metric: "must.pass", value: m.must.pass, total: m.must.total };
  }
  if (typeof m.overallPercent === "number") {
    return { metric: "overallPercent", value: m.overallPercent };
  }
  return null;
}

function scoped(history, level, transport) {
  return (history.measurements || [])
    .filter((m) => (!level || m.level === level) && (!transport || m.transport === transport))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : measurementKey(a).localeCompare(measurementKey(b))));
}

function diff(prev, cur) {
  const p = comparableMetric(prev);
  const c = comparableMetric(cur);
  if (!p || !c || p.metric !== c.metric) return null;
  if (c.metric === "must.pass" && p.total !== c.total) {
    return { kind: "suite-size-change", from: p.total, to: c.total };
  }
  if (c.value < p.value) {
    return {
      kind: "regression",
      metric: c.metric,
      from: p.value,
      to: c.value,
      fromDate: prev.date,
      toDate: cur.date,
      level: cur.level,
      transport: cur.transport,
    };
  }
  return null;
}

export function findRegressions(history, { level, transport, current } = {}) {
  const sorted = scoped(history, level, transport);
  const regressions = [];
  const notes = [];
  const pushDiff = (prev, cur) => {
    const d = diff(prev, cur);
    if (!d) return;
    if (d.kind === "regression") regressions.push(d);
    else notes.push({ ...d, toDate: cur.date });
  };
  if (current) {
    // Compare against the latest PRIOR baseline, excluding the current run's
    // own entry. The workflow normally runs this check before appending, but
    // the script also defends against an already-appended current measurement:
    // comparing the current run against itself would mask a real regression (#682).
    const currentKey = measurementKey(current);
    const baseline = sorted.filter((m) => measurementKey(m) !== currentKey);
    const skippedCurrent = sorted.length - baseline.length;
    if (skippedCurrent > 0) {
      notes.push({
        kind: "baseline-skipped-current",
        count: skippedCurrent,
        date: current.date,
        level: current.level,
        transport: current.transport,
      });
    }
    if (baseline.length) pushDiff(baseline[baseline.length - 1], current);
  } else {
    for (let i = 1; i < sorted.length; i++) pushDiff(sorted[i - 1], sorted[i]);
  }
  return { regressions, notes };
}

function stablyGreenCollection(history, collectionName, window = 2, { level, transport } = {}) {
  const sorted = scoped(history, level, transport);
  const recent = sorted.slice(-window);
  if (recent.length < window) return [];
  const names = new Set();
  for (const m of recent) for (const k of Object.keys(m[collectionName] || {})) names.add(k);
  const green = [];
  for (const name of names) {
    const allGreen = recent.every((m) => {
      const c = m[collectionName]?.[name];
      return c && typeof c.total === "number" && c.total > 0 && c.pass === c.total;
    });
    if (allGreen) green.push(name);
  }
  return green.sort();
}

export function stablyGreenCategories(history, window = 2, options = {}) {
  return stablyGreenCollection(history, "categories", window, options);
}

export function stablyGreenSubCategories(history, window = 2, options = {}) {
  return stablyGreenCollection(history, "subCategories", window, options);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--history") args.history = argv[++i];
    else if (a === "--level") args.level = argv[++i];
    else if (a === "--transport") args.transport = argv[++i];
    else if (a === "--stable-window") args.window = Number(argv[++i]);
    else if (a === "--against-log") args.againstLog = argv[++i];
    else if (a === "--date") args.date = argv[++i];
    else if (a === "--source") args.source = argv[++i];
  }
  return args;
}

function main() {
  const cli = parseArgs(process.argv.slice(2));
  const historyPath = cli.history ?? DEFAULT_HISTORY;
  const level = cli.level ?? "must";
  const transport = cli.transport ?? "jsonrpc";
  const window = Number.isFinite(cli.window) ? cli.window : 2;

  let history;
  try {
    history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: `cannot read history ${historyPath}: ${error instanceof Error ? error.message : String(error)}` }, null, 2));
    process.exit(1);
  }

  let current;
  if (cli.againstLog) {
    const parsed = parseTckLog(fs.readFileSync(cli.againstLog, "utf8"));
    current = buildMeasurement({
      date: cli.date ?? new Date().toISOString().slice(0, 10),
      level,
      transport,
      parsed,
      source: cli.source,
    });
  }

  const { regressions, notes } = findRegressions(history, { level, transport, current });
  const promotionHistory = current ? upsertMeasurement(history, current) : history;
  const promotionCandidates = stablyGreenCategories(promotionHistory, window, { level, transport });
  const subCategoryPromotionCandidates = stablyGreenSubCategories(promotionHistory, window, { level, transport });
  const report = {
    ok: regressions.length === 0,
    level,
    transport,
    regressions,
    notes,
    promotionCandidates,
    subCategoryPromotionCandidates,
  };

  // Always emit the structured report on stdout so a `... | tee summary` step
  // captures the evidence on the failure path too (#682); the exit code still
  // signals the regression.
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
