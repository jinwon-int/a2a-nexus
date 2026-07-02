#!/usr/bin/env node
// Build and render a deterministic A2A round manifest.
//
// Usage:
//   node scripts/round-manifest.mjs --repo jinwon-int/a2a-broker --issue 927 --team team1 --run-id "a2a-round-20260526T201140KST" [options]
//
// Required:
//   --repo       Parent repo slug (owner/repo)
//   --issue      Parent issue number
//   --team       Team identifier (team1, team2)
//   --run-id     Broker run identifier
//   --workers    Comma-separated worker list (e.g. "workergamma,workerepsilon,workerbeta,workeralpha")
//
// Options:
//   --label      Optional human-readable round label
//   --deadline   ISO 8601 round deadline timestamp
//   --json       Output JSON instead of markdown
//   --validate   Validate only, do not build
//   --help, -h   Show this help
//
// Source-only: this script never mutates broker state, writes to outboxes,
// or triggers automatic closeout/finalizer actions.

import process from "node:process";
import {
  buildRoundManifest,
  renderRoundManifestMarkdown,
  validateRoundManifestOptions,
} from "../dist/core/round-manifest.js";

function parseArgs(argv) {
  const read = (name) => {
    const prefix = name + "=";
    const inline = argv.find((a) => a.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const idx = argv.indexOf(name);
    return idx >= 0 && idx < argv.length - 1 ? argv[idx + 1] : undefined;
  };

  const has = (name) => argv.includes(name);

  if (has("--help") || has("-h")) {
    console.log([
      "Usage: node scripts/round-manifest.mjs \\",
      "  --repo OWNER/REPO --issue N --team TEAM --run-id ID \\",
      "  --workers w1,w2,... [--label LABEL] [--deadline ISO] [--json] [--validate]",
      "",
      "Build a deterministic A2A round manifest document.",
      "Source-only: no broker state mutation, no outbox writes.",
    ].join("\n"));
    process.exit(0);
  }

  const repo = read("--repo");
  const issue = Number(read("--issue"));
  const team = read("--team");
  const runId = read("--run-id");
  const workersRaw = read("--workers");
  const label = read("--label");
  const deadline = read("--deadline");
  const asJson = has("--json");
  const validateOnly = has("--validate");

  const errors = [];
  if (!repo) errors.push("--repo is required (e.g. jinwon-int/a2a-broker)");
  if (!issue) errors.push("--issue is required (positive integer)");
  if (!team) errors.push("--team is required (e.g. team1)");
  if (!runId) errors.push("--run-id is required");
  if (!workersRaw) errors.push("--workers is required (comma-separated list)");

  if (errors.length > 0) {
    console.error("Error: missing required arguments");
    errors.forEach((e) => console.error(`  ${e}`));
    console.error("");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  const workers = workersRaw.split(",").map((w, i) => ({
    workerId: w.trim(),
    lane: i + 1,
  }));

  const deadlineConfig = deadline ? { roundDeadlineAt: deadline } : undefined;

  return { repo, issue, team, runId, workers, label, deadlineConfig, asJson, validateOnly };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const options = {
    parentRepo: args.repo,
    parentIssueNumber: args.issue,
    teamId: args.team,
    runId: args.runId,
    roundLabel: args.label,
    expectedWorkers: args.workers,
    deadlineConfig: args.deadlineConfig,
  };

  if (args.validateOnly) {
    const issues = validateRoundManifestOptions(options);
    if (issues.length === 0) {
      console.log("✅ Round manifest options are valid.");
      process.exit(0);
    }
    console.error("❌ Validation failed:");
    issues.forEach((i) => console.error(`  - ${i}`));
    process.exit(1);
  }

  try {
    const manifest = buildRoundManifest(options);

    if (args.asJson) {
      console.log(JSON.stringify(manifest, null, 2));
    } else {
      console.log(renderRoundManifestMarkdown(manifest));
    }

    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to build round manifest:", err.message);
    process.exit(1);
  }
}

main();
