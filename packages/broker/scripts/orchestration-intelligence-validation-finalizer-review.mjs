#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import { buildOIValidationScorePacket } from "../dist/core/orchestration-intelligence-validation-scorer.js";
import {
  buildOIValidationFinalizerReviewPacket,
  renderOIValidationFinalizerReviewMarkdown,
} from "../dist/core/orchestration-intelligence-validation-finalizer-review.js";

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
  const score = input.score ?? buildOIValidationScorePacket(input.scoreInput ?? input);
  const packet = buildOIValidationFinalizerReviewPacket({
    generatedAt: input.generatedAt,
    runId: input.runId,
    reviewer: input.reviewer,
    notes: input.notes,
    score,
  });
  if (argv.includes("--json")) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderOIValidationFinalizerReviewMarkdown(packet));
}

main().catch((error) => {
  console.error("orchestration-intelligence-validation-finalizer-review: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
});
