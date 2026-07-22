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
const DEFAULT_CLASSIFICATION = path.resolve(scriptDir, "..", "docs", "tck-failing-categories.json");
const CATEGORY_KEYS = ["agent_card", "jsonrpc", "http_json", "grpc"];
const OUTCOMES = ["PASSED", "FAILED", "SKIPPED"];

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

function stripAnsi(line) {
  return line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function increment(counts, outcome) {
  counts[outcome.toLowerCase()] += 1;
}

function parsePytestSummary(lines) {
  for (const line of [...lines].reverse()) {
    if (!/\bin\s+\d+(?:\.\d+)?s\b/i.test(line)) continue;
    const counts = { passed: 0, failed: 0, skipped: 0, errors: 0, xfailed: 0, xpassed: 0 };
    let found = false;
    for (const match of line.matchAll(/\b(\d+)\s+(passed|failed|skipped|errors?|xfailed|xpassed)\b/gi)) {
      found = true;
      const rawKey = match[2].toLowerCase();
      const key = rawKey.startsWith("error") ? "errors" : rawKey;
      counts[key] += Number(match[1]);
    }
    if (found) return counts;
  }
  return null;
}

function selectorMatches(selector, nodeId) {
  return nodeId === selector || nodeId.startsWith(`${selector}[`) || (selector.endsWith("::") && nodeId.startsWith(selector));
}

function parsePytestOutcomes(lines, classification) {
  const nodes = new Map();
  const duplicateSummaryNodeIds = new Set();
  const conflictingNodeIds = new Set();

  function record(nodeId, outcome, source) {
    const previous = nodes.get(nodeId);
    if (!previous) {
      nodes.set(nodeId, { nodeId, outcome, verbose: source === "verbose", failureSummary: source === "summary" });
      return;
    }
    if (previous.outcome !== outcome) conflictingNodeIds.add(nodeId);
    if (source === "verbose") previous.verbose = true;
    if (source === "summary") {
      previous.failureSummary = true;
      duplicateSummaryNodeIds.add(nodeId);
    }
  }

  for (const line of lines) {
    const verbose = line.match(/^\s*(.+?::.+?)\s+(PASSED|FAILED|SKIPPED)(?:\s|$)/);
    if (verbose) {
      record(verbose[1].trim(), verbose[2], "verbose");
      continue;
    }
    const summary = line.match(/^\s*(FAILED|SKIPPED)\s+(.+?::\S+?)(?:\s+-\s|\s*$)/);
    if (summary) record(summary[2].trim(), summary[1], "summary");
  }

  const pytestSummary = parsePytestSummary(lines);
  const verboseCounts = { passed: 0, failed: 0, skipped: 0 };
  for (const node of nodes.values()) {
    if (node.verbose && OUTCOMES.includes(node.outcome)) increment(verboseCounts, node.outcome);
  }

  const configured = Array.isArray(classification?.subCategories) ? classification.subCategories : [];
  const classified = new Map(configured.map((sub) => [sub.id, []]));
  const unclassified = [];
  const ambiguous = [];
  for (const node of nodes.values()) {
    const matches = configured.filter((sub) =>
      Array.isArray(sub.pytestNodeIdSelectors) && sub.pytestNodeIdSelectors.some((selector) => selectorMatches(selector, node.nodeId)),
    );
    if (matches.length === 1) classified.get(matches[0].id).push(node);
    else if (matches.length === 0) unclassified.push({ nodeId: node.nodeId, outcome: node.outcome });
    else ambiguous.push({ nodeId: node.nodeId, outcome: node.outcome, subCategoryIds: matches.map((sub) => sub.id) });
  }

  const incompleteReasons = [];
  const missingSelectors = {};
  for (const sub of configured) {
    const categoryNodes = classified.get(sub.id) ?? [];
    const missing = sub.pytestNodeIdSelectors.filter((selector) =>
      !categoryNodes.some((node) => selectorMatches(selector, node.nodeId)),
    );
    if (missing.length > 0) missingSelectors[sub.id] = missing;
  }
  if (!pytestSummary) incompleteReasons.push("missing pytest terminal outcome summary");
  if (pytestSummary?.errors) incompleteReasons.push(`pytest summary includes ${pytestSummary.errors} error outcome(s)`);
  if (pytestSummary?.xfailed || pytestSummary?.xpassed) {
    incompleteReasons.push("pytest summary includes unsupported xfailed/xpassed outcome(s)");
  }
  if (pytestSummary && OUTCOMES.some((outcome) => verboseCounts[outcome.toLowerCase()] !== pytestSummary[outcome.toLowerCase()])) {
    incompleteReasons.push("verbose node outcomes do not reconcile with pytest summary counts");
  }
  if (conflictingNodeIds.size > 0) incompleteReasons.push("the same node id has conflicting outcomes");
  if (ambiguous.length > 0) incompleteReasons.push("one or more node ids match multiple sub-categories");
  if (Object.keys(missingSelectors).length > 0) incompleteReasons.push("one or more configured node-id selectors are absent from the verbose outcomes");

  const subCategories = {};
  if (incompleteReasons.length === 0) {
    for (const [id, categoryNodes] of classified) {
      if (categoryNodes.length === 0) continue;
      const outcomes = { passed: 0, failed: 0, skipped: 0 };
      for (const node of categoryNodes) increment(outcomes, node.outcome);
      subCategories[id] = {
        pass: outcomes.passed,
        total: outcomes.passed + outcomes.failed + outcomes.skipped,
        outcomes,
      };
    }
  }

  return {
    subCategories,
    accounting: {
      sufficientForMeasurement: incompleteReasons.length === 0,
      incompleteReasons,
      pytestSummary,
      verboseOutcomes: verboseCounts,
      observedNodeCount: nodes.size,
      classifiedNodeCount: [...classified.values()].reduce((sum, categoryNodes) => sum + categoryNodes.length, 0),
      unclassified,
      ambiguous,
      missingSelectors,
      conflictingNodeIds: [...conflictingNodeIds].sort(),
      duplicateFailureSummaryNodeIds: [...duplicateSummaryNodeIds].sort(),
    },
  };
}

function readDefaultClassification() {
  return JSON.parse(fs.readFileSync(DEFAULT_CLASSIFICATION, "utf8"));
}

export function parseTckLog(text, classification = readDefaultClassification()) {
  const lines = String(text).split(/\r?\n/).map(stripAnsi);
  const pytest = parsePytestOutcomes(lines, classification);
  const result = {
    overallPercent: percentFrom(firstLine(lines, /OVERALL COMPATIBILITY/i)),
    must: ratioFrom(firstLine(lines, /\bMUST\b/)),
    categories: {},
    subCategories: pytest.subCategories,
    pytestOutcomeAccounting: pytest.accounting,
  };
  for (const cat of CATEGORY_KEYS) {
    const r = ratioFrom(firstLine(lines, new RegExp(`\\b${cat}\\s*:`, "i")));
    if (r) result.categories[cat] = r;
  }
  return result;
}

export function measurementKey(m) {
  const source = typeof m.source === "string" ? m.source.trim() : "";
  return `${m.date}|${m.level}|${m.transport}${source ? `|${source}` : ""}`;
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
  if (parsed.subCategories && Object.keys(parsed.subCategories).length > 0) entry.subCategories = parsed.subCategories;
  if (parsed.pytestOutcomeAccounting) entry.pytestOutcomeAccounting = parsed.pytestOutcomeAccounting;
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
  if (
    !parsed.must
    && parsed.overallPercent === null
    && Object.keys(parsed.categories).length === 0
    && Object.keys(parsed.subCategories).length === 0
  ) {
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
