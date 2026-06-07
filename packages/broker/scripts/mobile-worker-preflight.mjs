#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  buildMobileWorkerPreflight,
  renderMobileWorkerPreflightMarkdown,
} from "../dist/core/mobile-worker-preflight.js";

function usage() {
  return [
    "Usage: node scripts/mobile-worker-preflight.mjs --input <fixture.json> [--json|--markdown] [--now <iso>]",
    "",
    "Builds a source-only/no-live Termux mobile worker preflight packet.",
    "It reads supplied JSON input only. It does not inspect live host state,",
    "dispatch workers, mutate DB, restart services, change wake-locks, send",
    "provider messages, perform Terminal ACK/replay, or move secrets.",
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
    throw new Error("Missing required --input <fixture.json>.");
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readFile(args.input, "utf-8");
  const fixture = JSON.parse(raw);
  const result = buildMobileWorkerPreflight(fixture, {
    now: args.now,
    format: args.format,
  });

  if (result.format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderMobileWorkerPreflightMarkdown(result));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(usage());
  process.exit(1);
});
