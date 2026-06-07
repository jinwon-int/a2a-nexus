#!/usr/bin/env node
/**
 * CLI wrapper for the complexity execution plan preflight seal (#989).
 *
 * Consumes a ComplexityExecutionPlanDraftPacket (#982) fixture file and
 * produces a deterministic source-only sealed review packet.
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
 *   node scripts/complexity-execution-plan-preflight-seal.mjs --input <fixture.json> \
 *     [--json|--markdown] [--now <iso>]
 */

import { readFile } from "node:fs/promises";
import {
  buildComplexityExecutionPlanPreflightSeal,
  extractExecutionPlanDraftForPreflightSeal,
  renderComplexityExecutionPlanPreflightSealMarkdown,
} from "../dist/core/complexity-execution-plan-preflight-seal.js";

function usage() {
  return [
    "Usage: node scripts/complexity-execution-plan-preflight-seal.mjs --input <fixture.json> [--json|--markdown] [--now <iso>]",
    "",
    "Builds a source-only preflight seal from a complexity execution plan",
    "draft packet (#982) fixture.",
    "It does not read broker state, dispatch workers, mutate DB, restart",
    "services, send provider messages, or perform terminal ACK/replay.",
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

    const plan = extractExecutionPlanDraftForPreflightSeal(fixture);
    const packet = buildComplexityExecutionPlanPreflightSeal(plan, {
      now: args.now ?? new Date().toISOString(),
    });

    if (args.format === "json") {
      console.log(JSON.stringify(packet, null, 2));
    } else {
      console.log(renderComplexityExecutionPlanPreflightSealMarkdown(packet));
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

main();
