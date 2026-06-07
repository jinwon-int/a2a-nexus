#!/usr/bin/env node
/**
 * round-coordinator-closeout-dry-run.mjs — source-only dry-run closeout CLI
 *
 * Loads a round manifest and task snapshot fixture, runs the result collector,
 * and emits a finalizer-review bundle with lane states, PR/Done/Block evidence
 * refs, missing/stale/timeout/incomplete lanes, risks, and approval gates.
 *
 * Safety:
 * - Source-only: never executes GitHub comments/closes/merges, deploys, live
 *   sends, ACK/replay, or DB writes.
 * - Fails closed if any "live" or "no-live" safety flags are unrecognized.
 * - All output is a read-only projection.
 *
 * Usage:
 *   node scripts/round-coordinator-closeout-dry-run.mjs --input fixture.json [--json|--markdown]
 *
 *   node scripts/round-coordinator-closeout-dry-run.mjs \
 *     --manifest manifest.json --tasks tasks.json [--json]
 *
 * Options:
 *   --input PATH     Combined fixture JSON with { manifest, tasks }
 *   --manifest PATH  Round manifest JSON (standalone)
 *   --tasks PATH     Task snapshot JSON array (standalone)
 *   --json           Output full JSON (includes closeoutBundle, lanes, summary)
 *   --markdown       Output rendered closeout bundle markdown (default)
 *   --now ISO        Override collection time (ISO 8601). Default: now
 *   --validate-only  Load and validate fixture JSON, but do not collect
 *   --help, -h       Show this help
 *
 * Exit codes:
 *   0 — Success (bundle emitted)
 *   1 — Validation or I/O error
 *   2 — Usage error
 *   3 — Safety boundary violation (blocked)
 *
 * Examples:
 *   # Default markdown output
 *   node scripts/round-coordinator-closeout-dry-run.mjs \
 *     --input fixtures/round-coordinator-closeout/all-complete.json
 *
 *   # Full JSON for programmatic consumption
 *   node scripts/round-coordinator-closeout-dry-run.mjs \
 *     --input fixtures/round-coordinator-closeout/mixed-states.json --json
 *
 *   # Override collection time to simulate timeout
 *   node scripts/round-coordinator-closeout-dry-run.mjs \
 *     --input fixtures/round-coordinator-closeout/timeout-scenario.json \
 *     --now "2026-05-28T00:00:00.000Z" --json
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import process from "node:process";

import {
  collectRoundResults,
  buildRoundManifest,
} from "../dist/core/round-result-collector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HELP_TEXT = `
round-coordinator-closeout-dry-run.mjs

Source-only dry-run closeout CLI for A2A round coordinator wiring.

Reads a round manifest and task snapshot fixtures, runs the result collector,
and emits a finalizer-review bundle with lane states, PR/Done/Block evidence
refs, and safety gates.

SAFETY: This script NEVER executes GitHub comments, closes issues, merges PRs,
deploys, sends live messages, ACK/replays Terminal Briefs, or mutates broker DB.

Usage:
  node scripts/round-coordinator-closeout-dry-run.mjs --input <path> [options]

Options:
  --input PATH      Combined fixture JSON (manifest + tasks)
  --manifest PATH   Round manifest JSON only (requires --tasks)
  --tasks PATH      Task snapshot JSON array only (requires --manifest)
  --json            Output full collector JSON
  --markdown        Output closeout bundle markdown (default)
  --now ISO         Override collection timestamp
  --validate-only   Load and validate fixtures only
  --help, -h        Show this help

Exit codes:
  0  Success
  1  Validation/I/O error
  2  Usage error
  3  Safety violation

Examples:
  node scripts/round-coordinator-closeout-dry-run.mjs \\
    --input fixtures/round-coordinator-closeout/all-complete.json --markdown

  node scripts/round-coordinator-closeout-dry-run.mjs \\
    --input fixtures/round-coordinator-closeout/mixed-states.json --json
`.trim();

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = name + "=";
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 && index < argv.length - 1 ? argv[index + 1] : undefined;
  };

  const hasFlag = (name) => argv.includes(name);

  const args = {
    input: readOption("--input"),
    manifest: readOption("--manifest"),
    tasks: readOption("--tasks"),
    now: readOption("--now"),
    json: hasFlag("--json"),
    markdown: hasFlag("--markdown"),
    validateOnly: hasFlag("--validate-only"),
    help: hasFlag("--help") || hasFlag("-h"),
  };

  // Default to markdown if neither --json nor --markdown is specified
  if (!args.json && !args.markdown) args.markdown = true;

  return args;
}

function redactSensitiveStrings(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]{10,}/g, "[redacted-token]")
    .replace(/\b(TOKEN|SECRET|KEY|PASSWORD)=[^\s"]+/gi, "$1=[redacted]");
}

function redactSensitive(obj) {
  if (typeof obj === "string") return redactSensitiveStrings(obj);
  if (Array.isArray(obj)) return obj.map(redactSensitive);
  if (obj && typeof obj === "object") {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      cleaned[key] = redactSensitive(value);
    }
    return cleaned;
  }
  return obj;
}

function validateSafety(fixture) {
  const errors = [];

  // Safety: never execute any live or mutation action
  if (fixture._executeAction) {
    errors.push("Safety violation: fixture contains _executeAction flag (blocked)");
  }

  // Detect any field that looks like an instruction to post/close/merge
  const serialized = JSON.stringify(fixture).toLowerCase();
  const blockedPatterns = [
    { pattern: /"postcomment"/, name: "postComment" },
    { pattern: /"closeissue"/, name: "closeIssue" },
    { pattern: /"mergepr"/, name: "mergePr" },
    { pattern: /"deploy"/, name: "deploy" },
    { pattern: /"livesend"/, name: "liveSend" },
    { pattern: /"ackreplay"/, name: "ackReplay" },
    { pattern: /"dbwrite"/, name: "dbWrite" },
    { pattern: /"dbmutate"/, name: "dbMutate" },
  ];

  for (const { pattern, name } of blockedPatterns) {
    if (pattern.test(serialized)) {
      errors.push(`Safety violation: fixture references blocked action "${name}"`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

async function loadFixture(filePath) {
  const resolved = filePath.startsWith("/") ? filePath : `${process.cwd()}/${filePath}`;
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const raw = await readFile(resolved, "utf-8");
  return JSON.parse(raw);
}

function extractManifestAndTasks(fixture) {
  if (fixture.manifest && Array.isArray(fixture.tasks)) {
    return { manifest: fixture.manifest, tasks: fixture.tasks };
  }

  // Single manifest with no tasks wrapper
  if (fixture.roundLabel && fixture.lanes) {
    return { manifest: fixture, tasks: fixture.tasks ?? [] };
  }

  throw new Error(
    "Fixture must have { manifest: RoundManifest, tasks: TaskRecord[] } shape " +
    "(or be a bare TerminalBriefRoundManifest with optional .tasks)",
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render a standalone closeout bundle markdown when the collector's built-in
 * bundle needs augmentation with safety disclaimer and runbook links.
 */
function renderEnhancedCloseoutBundle(output, args) {
  const baseBundle = output.closeoutBundle;
  const lines = baseBundle.body.split("\n");

  // Add CLI invocation info at top
  const header = [
    `## Dry-Run Closeout: ${output.roundLabel}`,
    "",
    `Generated: ${output.generatedAt}`,
    output.parentIssueUrl ? `Parent: ${output.parentIssueUrl}` : null,
    "",
    "_Source-only projection — no live actions executed._",
    "",
  ].filter(Boolean);

  // Append safety gate summary
  const safetySection = [
    "",
    "---",
    "",
    "### Safety Gates",
    "",
    "| Gate | Status |",
    "| --- | --- |",
    "| GitHub comment/close/merge | ✅ Blocked (source-only dry-run) |",
    "| Live provider/Terminal/Telegram send | ✅ Blocked (source-only dry-run) |",
    "| Terminal ACK/replay | ✅ Blocked (source-only dry-run) |",
    "| Gateway/broker/worker restart/deploy | ✅ Blocked (source-only dry-run) |",
    "| DB mutation/prune/migration | ✅ Blocked (source-only dry-run) |",
    "| Historical outbox replay | ✅ Blocked (source-only dry-run) |",
    "| Release/tag/npm publish | ✅ Blocked (source-only dry-run) |",
    "| Secret/credential movement | ✅ Blocked (source-only dry-run) |",
    "",
    `_CLI invocation: \`node scripts/round-coordinator-closeout-dry-run.mjs ${args.json ? "--json" : "--markdown"} --input ...\`_`,
    "",
    "_This is a draft-only closeout bundle. No comments, closes, merges, deploys, live sends, ACKs, or DB mutations have been executed._",
  ];

  const body = lines[0] === "---"
    ? header.concat(lines.slice(1)).concat(safetySection)
    : header.concat(lines).concat(safetySection);

  return { ...baseBundle, body: body.join("\n") };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Exports (for testability)
// ---------------------------------------------------------------------------

export {
  parseArgs,
  redactSensitiveStrings,
  redactSensitive,
  validateSafety,
  loadFixture,
  extractManifestAndTasks,
  renderEnhancedCloseoutBundle,
  HELP_TEXT,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  // Guard: at least --input or (--manifest + --tasks)
  const hasInput = Boolean(args.input);
  const hasManifest = Boolean(args.manifest);
  const hasTasks = Boolean(args.tasks);

  if (!hasInput && !(hasManifest && hasTasks)) {
    console.error("Error: specify --input <path> or --manifest <path> --tasks <path>");
    console.error(HELP_TEXT);
    process.exit(2);
  }

  if (hasInput && (hasManifest || hasTasks)) {
    console.error("Error: --input cannot be combined with --manifest/--tasks");
    process.exit(2);
  }

  // ---- Load fixtures ----
  let fixture, manifestFixture, tasksArray;
  try {
    if (hasInput) {
      fixture = await loadFixture(args.input);
    } else {
      manifestFixture = await loadFixture(args.manifest);
      const tasksRaw = await loadFixture(args.tasks);
      tasksArray = Array.isArray(tasksRaw) ? tasksRaw : (tasksRaw.tasks ?? []);
      fixture = { manifest: manifestFixture, tasks: tasksArray };
    }
  } catch (err) {
    console.error(`Error loading fixture: ${err.message}`);
    process.exit(1);
  }

  // ---- Validate ----
  const safetyIssues = validateSafety(fixture);
  if (safetyIssues.length > 0) {
    for (const issue of safetyIssues) {
      console.error(issue);
    }
    process.exit(3);
  }

  // ---- Extract manifest + tasks ----
  let manifest, tasks;
  try {
    ({ manifest, tasks } = extractManifestAndTasks(fixture));
  } catch (err) {
    console.error(`Error parsing fixture: ${err.message}`);
    process.exit(1);
  }

  if (args.validateOnly) {
    console.log(JSON.stringify({
      valid: true,
      manifestLabel: manifest.roundLabel,
      lanes: manifest.lanes?.length ?? 0,
      tasks: tasks.length,
      excludedWorkerIds: manifest.excludedWorkerIds ?? [],
      staleAfterMs: manifest.staleAfterMs ?? 1800000,
      timeoutAt: manifest.timeoutAt ?? null,
    }, null, 2));
    process.exit(0);
  }

  // ---- Collect results ----
  const nowMs = args.now ? Date.parse(args.now) : Date.now();

  if (Number.isNaN(nowMs)) {
    console.error(`Invalid --now timestamp: ${args.now}`);
    process.exit(1);
  }

  let output;
  try {
    output = collectRoundResults(manifest, tasks, { nowMs });
  } catch (err) {
    console.error(`Error running result collector: ${err.message}`);
    process.exit(1);
  }

  // ---- Redact any sensitive tokens from output ----
  output = redactSensitive(output);

  // ---- Emit output ----
  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    const enhanced = renderEnhancedCloseoutBundle(output, args);
    console.log(enhanced.body);
  }

  process.exit(0);
}

// Only run main() when this file is the entry point, not when imported
const isMainModule = process.argv[1] && (
  process.argv[1] === import.meta.filename ||
  process.argv[1].endsWith("/round-coordinator-closeout-dry-run.mjs")
);

if (isMainModule) {
  main().catch((err) => {
    console.error(`Unexpected error: ${err.message}`);
    process.exit(1);
  });
}
