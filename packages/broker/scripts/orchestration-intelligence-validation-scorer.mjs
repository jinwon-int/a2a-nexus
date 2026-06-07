#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildOIValidationScorePacket,
  renderOIValidationScoreMarkdown,
} from "../dist/core/orchestration-intelligence-validation-scorer.js";

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputPath = readOption(argv, "--input");
  const input = inputPath ? JSON.parse(await readFile(inputPath, "utf8")) : {};
  const packet = buildOIValidationScorePacket(input);
  if (argv.includes("--json")) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderOIValidationScoreMarkdown(packet));
}

main().catch((error) => {
  console.error("orchestration-intelligence-validation-scorer: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
});
