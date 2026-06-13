#!/usr/bin/env node
/**
 * Append a TCK compliance measurement to docs/tck-history.json.
 *
 * Parses the official A2A TCK run log (the same lines the tck-measurement
 * workflow already greps into its job summary) and records a structured
 * trend entry so the compliance number is readable in-repo, not only inside
 * 90-day Actions artifacts.
 *
 * Usage:
 *   node scripts/append-tck-history.mjs \
 *     --log /tmp/tck-run.log --level must --transport jsonrpc [--date YYYY-MM-DD] \
 *     [--source "..."] [--history path]
 *
 * Safety: source-only file update. No deploy, send, DB, or live action.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HISTORY = path.resolve(scriptDir, "..", "docs", "tck-history.json");
const CATEGORY_KEYS = ["agent_card", "jsonrpc", "http_json", "grpc"];

function ratioFrom(line) {
  if (!line) return null;
  const m = line.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { pass: Number(m[1]), total: Number(m[2]) } : null;
}

function percentFrom(line) {
  if (!line) return null;
  const m = line.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}

function firstLine(lines, labelRe) {
  return lines.find((line) => labelRe.test(line)) ?? null;
}

export function parseTckLog(text) {
  const lines = String(text).split(/\r?\n/);
  const result = {
    overallPercent: percentFrom(firstLine(lines, /OVERALL COMPATIBILITY/i)),
    must: ratioFrom(firstLine(lines, /\bMUST\b/)),
    categories: {},
  };
  for (const cat of CATEGORY_KEYS) {
    const r = ratioFrom(firstLine(lines, new RegExp(`\\b${cat}\\s*:`, "i")));
    if (r) result.categories[cat] = r;
  }
  return result;
}

function measurementKey(m) {
  return `${m.date}|${m.level}|${m.transport}`;
}

export function upsertMeasurement(history, entry) {
  const measurements = Array.isArray(history.measurements) ? [...history.measurements] : [];
  const idx = measurements.findIndex((m) => measurementKey(m) === measurementKey(entry));
  if (idx >= 0) {
    measurements[idx] = entry;
  } else {
    measurements.push(entry);
  }
  measurements.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : measurementKey(a).localeCompare(measurementKey(b)),
  );
  return { ...history, measurements };
}

export function buildMeasurement({ date, level, transport, parsed, source }) {
  const entry = {
    date,
    level,
    transport,
    overallPercent: parsed.overallPercent ?? null,
    must: parsed.must ?? null,
    categories: parsed.categories ?? {},
  };
  if (source) entry.source = source;
  return entry;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log") args.log = argv[++i];
    else if (a === "--level") args.level = argv[++i];
    else if (a === "--transport") args.transport = argv[++i];
    else if (a === "--date") args.date = argv[++i];
    else if (a === "--source") args.source = argv[++i];
    else if (a === "--history") args.history = argv[++i];
  }
  return args;
}

function main() {
  const cli = parseArgs(process.argv.slice(2));
  const logPath = cli.log ?? "/tmp/tck-run.log";
  const level = cli.level ?? "must";
  const transport = cli.transport ?? "jsonrpc";
  const date = cli.date ?? new Date().toISOString().slice(0, 10);
  const historyPath = cli.history ?? DEFAULT_HISTORY;

  let logText;
  try {
    logText = fs.readFileSync(logPath, "utf8");
  } catch (error) {
    console.error(`append-tck-history: cannot read log ${logPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const parsed = parseTckLog(logText);
  if (!parsed.must && parsed.overallPercent === null && Object.keys(parsed.categories).length === 0) {
    console.error(`append-tck-history: no compliance numbers found in ${logPath}; refusing to append an empty measurement`);
    process.exit(1);
  }

  let history = { schemaVersion: 1, measurements: [] };
  try {
    history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  } catch {
    // Start a fresh history file if none exists yet.
  }

  const entry = buildMeasurement({ date, level, transport, parsed, source: cli.source });
  const updated = upsertMeasurement(history, entry);
  fs.writeFileSync(historyPath, JSON.stringify(updated, null, 2) + "\n");

  console.log(`append-tck-history: recorded ${date} ${level}/${transport} → ${historyPath}`);
  console.log(JSON.stringify(entry, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
