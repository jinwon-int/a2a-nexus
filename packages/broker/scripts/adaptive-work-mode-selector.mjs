#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildA2AAdaptiveSelectorRecord,
  extractA2AAdaptiveSelectorInput,
  renderA2AAdaptiveSelectorMarkdown,
} from "../dist/core/adaptive-work-mode-selector.js";

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
    throw new Error("usage: node scripts/adaptive-work-mode-selector.mjs --input fixture.json [--json]");
  }
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const record = buildA2AAdaptiveSelectorRecord(extractA2AAdaptiveSelectorInput(input));
  if (argv.includes("--json")) console.log(JSON.stringify(record, null, 2));
  else console.log(renderA2AAdaptiveSelectorMarkdown(record));
}

main().catch((error) => {
  console.error("adaptive-work-mode-selector: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
});
