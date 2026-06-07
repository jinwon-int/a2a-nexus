#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildA2AWorkModePreDispatchDecision,
  extractA2AWorkModePreDispatchDecisionInput,
  renderA2AWorkModePreDispatchDecisionMarkdown,
} from "../dist/core/work-mode-pre-dispatch-decision.js";

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputPath = readOption(argv, "--input");
  if (!inputPath) {
    throw new Error("usage: node scripts/work-mode-pre-dispatch-decision.mjs --input fixture.json [--json]");
  }
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const packet = buildA2AWorkModePreDispatchDecision(extractA2AWorkModePreDispatchDecisionInput(input));
  if (argv.includes("--json")) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderA2AWorkModePreDispatchDecisionMarkdown(packet));
}

main().catch((error) => {
  console.error("work-mode-pre-dispatch-decision: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
});
