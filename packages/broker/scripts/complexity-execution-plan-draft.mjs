#!/usr/bin/env node
/**
 * CLI wrapper for the complexity execution plan draft (#982).
 *
 * Consumes a FinalizerApprovalEnvelopeDraftPacket (#978) fixture file and
 * produces a deterministic complexity execution plan draft.
 *
 * This script is source-only and no-live — it reads a fixture, executes pure
 * transformations, and writes to stdout. It does NOT:
 *   - Read broker/Gateway/worker service state
 *   - Dispatch subagents or spawn processes
 *   - Mutate DB, deploy, restart, or send provider messages
 *   - Perform terminal ACK/replay or release
 *   - Move or expose secrets/credentials
 *
 * Usage:
 *   node scripts/complexity-execution-plan-draft.mjs --input <fixture.json> \
 *     [--json|--markdown] [--now <iso>]
 */

import { readFile } from "node:fs/promises";
import { buildComplexityExecutionPlanDraft, renderComplexityExecutionPlanDraftMarkdown } from "../dist/core/complexity-execution-plan-draft.js";

function usage() {
  return [
    "Usage: node scripts/complexity-execution-plan-draft.mjs --input <fixture.json> [--json|--markdown] [--now <iso>]",
    "",
    "Builds a source-only complexity execution plan draft from a finalizer",
    "approval envelope draft (#978) fixture.",
    "It does not read broker state, dispatch workers, mutate DB, restart services,",
    "send provider messages, or perform terminal ACK/replay.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    input: undefined,
    format: undefined,
    now: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--input":
        args.input = argv[++i];
        break;
      case "--json":
        args.format = "json";
        break;
      case "--markdown":
        args.format = "markdown";
        break;
      case "--now":
        args.now = argv[++i];
        break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) {
    throw new Error("Missing required --input <fixture.json>");
  }

  if (!args.format) {
    args.format = "markdown";
  }

  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    const raw = await readFile(args.input, "utf8");
    const fixture = JSON.parse(raw);

    const plan = buildComplexityExecutionPlanDraft(fixture, {
      now: args.now ?? new Date().toISOString(),
    });

    if (args.format === "json") {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(renderComplexityExecutionPlanDraftMarkdown(plan));
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

main();
