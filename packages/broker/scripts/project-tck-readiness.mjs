#!/usr/bin/env node
/**
 * Project the latest sufficient official-TCK measurement into the release
 * readiness page.
 *
 * The committed TCK history remains the only numeric ledger. The category
 * classification contributes only promotion state and the expected promoted
 * pass/total. Output is deterministic: no wall-clock time is rendered.
 *
 * Usage:
 *   node scripts/project-tck-readiness.mjs --check
 *   node scripts/project-tck-readiness.mjs --write
 *
 * Safety: source-only documentation check/update. No live broker action.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const DEFAULT_HISTORY = path.resolve(scriptDir, "..", "docs", "tck-history.json");
const DEFAULT_CLASSIFICATION = path.resolve(scriptDir, "..", "docs", "tck-failing-categories.json");
const DEFAULT_READINESS = path.resolve(repoRoot, "docs", "release-readiness.md");

export const TCK_READINESS_START = "<!-- TCK-READINESS:START -->";
export const TCK_READINESS_END = "<!-- TCK-READINESS:END -->";

function fail(message) {
  throw new Error(`TCK readiness projection: ${message}`);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireRatio(value, label) {
  const ratio = requireObject(value, label);
  if (
    !Number.isInteger(ratio.pass)
    || !Number.isInteger(ratio.total)
    || ratio.pass < 0
    || ratio.total <= 0
    || ratio.pass > ratio.total
  ) {
    fail(`${label} must contain an integer 0 <= pass <= total with total > 0`);
  }
  return { pass: ratio.pass, total: ratio.total };
}

function ratioText(ratio) {
  return `${ratio.pass}/${ratio.total}`;
}

function percentText(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    fail("latest measurement overallPercent must be a finite number from 0 to 100");
  }
  return `${value}%`;
}

function workflowRunSource(source) {
  const match = typeof source === "string" && source.match(/^tck-measurement workflow run ([1-9]\d*)$/);
  if (!match) fail("latest measurement source must identify a tck-measurement workflow run");
  return {
    label: source,
    url: `https://github.com/jinwon-int/a2a-nexus/actions/runs/${match[1]}`,
  };
}

export function selectLatestSufficientMeasurement(history, { level = "must", transport = "jsonrpc" } = {}) {
  const measurements = requireObject(history, "history").measurements;
  if (!Array.isArray(measurements)) fail("history.measurements must be an array");

  for (let index = measurements.length - 1; index >= 0; index -= 1) {
    const candidate = measurements[index];
    if (
      candidate?.level === level
      && candidate?.transport === transport
      && candidate?.pytestOutcomeAccounting?.sufficientForMeasurement === true
    ) {
      return candidate;
    }
  }
  fail(`no sufficient ${level}/${transport} measurement exists`);
}

export function buildTckReadinessProjection(history, classification) {
  const latest = selectLatestSufficientMeasurement(history);
  if (typeof latest.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(latest.date)) {
    fail("latest measurement date must use YYYY-MM-DD");
  }

  const source = workflowRunSource(latest.source);
  const categories = requireObject(latest.categories, "latest measurement categories");
  const subCategories = requireObject(latest.subCategories, "latest measurement subCategories");
  const configured = requireObject(classification, "classification").subCategories;
  if (!Array.isArray(configured)) fail("classification.subCategories must be an array");

  const promotedIds = new Set();
  const promoted = configured
    .filter((entry) => entry?.promotionReadiness === "promoted")
    .map((entry) => {
      if (typeof entry.id !== "string" || !/^[a-z0-9-]+$/.test(entry.id)) {
        fail("each promoted sub-category must have a stable lowercase id");
      }
      if (promotedIds.has(entry.id)) fail(`promoted sub-category ${entry.id} is duplicated`);
      promotedIds.add(entry.id);
      const measured = requireRatio(subCategories[entry.id], `latest measurement subCategories.${entry.id}`);
      const baseline = requireRatio(entry.measuredPassTotal, `classification ${entry.id}.measuredPassTotal`);
      if (measured.pass !== baseline.pass || measured.total !== baseline.total) {
        fail(`promoted sub-category ${entry.id} disagrees with its classified measuredPassTotal`);
      }
      if (measured.pass !== measured.total) {
        // Capability-excluded green: a promoted sub-category may carry
        // documented capabilityExcludedSelectors (tests the TCK itself skips
        // because the agent declares a capability, e.g. streaming). The
        // latest measurement must then show ZERO failures and exactly the
        // documented number of skips — any real failure or extra skip still
        // blocks the projection.
        const excluded = Array.isArray(entry.capabilityExcludedSelectors)
          ? entry.capabilityExcludedSelectors.length
          : 0;
        const outcomes = subCategories[entry.id]?.outcomes;
        if (
          excluded === 0
          || !outcomes
          || outcomes.failed !== 0
          || outcomes.skipped !== excluded
          || measured.pass + excluded !== measured.total
        ) {
          fail(`promoted sub-category ${entry.id} is not fully green in the latest sufficient measurement`);
        }
      }
      return { id: entry.id, result: measured };
    });

  if (promoted.length === 0) fail("classification contains no promoted sub-categories");

  return {
    date: latest.date,
    source,
    overall: percentText(latest.overallPercent),
    agentCard: requireRatio(categories.agent_card, "latest measurement categories.agent_card"),
    jsonrpc: requireRatio(categories.jsonrpc, "latest measurement categories.jsonrpc"),
    promoted,
  };
}

export function renderTckReadinessMarkdown(projection) {
  const promotedRows = projection.promoted
    .map(({ id, result }) => `| Promoted sub-category: \`${id}\` | ${ratioText(result)} |`)
    .join("\n");

  return [
    TCK_READINESS_START,
    "## Official A2A TCK compatibility snapshot",
    "",
    "Compatibility posture: **A2A 1.0-compatible broker alpha profile**. This is a measured alpha snapshot, not a certification or full-conformance claim.",
    "",
    "| Official TCK measurement | Result |",
    "| --- | ---: |",
    `| Overall compatibility | ${projection.overall} |`,
    `| Agent Card | ${ratioText(projection.agentCard)} |`,
    `| JSON-RPC | ${ratioText(projection.jsonrpc)} |`,
    promotedRows,
    "",
    `Source: [${projection.source.label}](${projection.source.url}), measured \`${projection.date}\`. Canonical ledgers: \`packages/broker/docs/tck-history.json\` and \`packages/broker/docs/tck-failing-categories.json\`.`,
    "",
    "The full official TCK remains a non-gating measurement lane. Only sub-categories marked `promoted` in the classification ledger are represented as blocking PR gates.",
    TCK_READINESS_END,
  ].join("\n");
}

export function replaceTckReadinessBlock(document, rendered) {
  const start = document.indexOf(TCK_READINESS_START);
  const end = document.indexOf(TCK_READINESS_END);
  if (start < 0 || end < 0 || end < start) fail("release-readiness markers are missing or out of order");
  if (document.indexOf(TCK_READINESS_START, start + 1) >= 0 || document.indexOf(TCK_READINESS_END, end + 1) >= 0) {
    fail("release-readiness markers must appear exactly once");
  }
  return `${document.slice(0, start)}${rendered}${document.slice(end + TCK_READINESS_END.length)}`;
}

export function checkTckReadinessDocument(document, rendered) {
  return replaceTckReadinessBlock(document, rendered) === document;
}

function parseArgs(argv) {
  let mode;
  for (const arg of argv) {
    if (arg === "--check" || arg === "--write") {
      const requested = arg.slice(2);
      if (mode && mode !== requested) fail("--check and --write are mutually exclusive");
      mode = requested;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return mode ?? "check";
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main() {
  try {
    const mode = parseArgs(process.argv.slice(2));
    const history = readJson(DEFAULT_HISTORY, "TCK history");
    const classification = readJson(DEFAULT_CLASSIFICATION, "TCK classification");
    const document = fs.readFileSync(DEFAULT_READINESS, "utf8");
    const rendered = renderTckReadinessMarkdown(buildTckReadinessProjection(history, classification));
    const projected = replaceTckReadinessBlock(document, rendered);

    if (mode === "write") {
      if (projected !== document) fs.writeFileSync(DEFAULT_READINESS, projected);
      console.log(`TCK readiness projection ${projected === document ? "already current" : "updated"}`);
      return;
    }

    if (projected !== document) {
      console.error("TCK readiness projection is stale; run this script with --write and commit the result");
      process.exitCode = 1;
      return;
    }
    console.log("TCK readiness projection is current");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
