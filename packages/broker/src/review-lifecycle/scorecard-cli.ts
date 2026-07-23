#!/usr/bin/env node
/**
 * Manual, offline scorecard readback for #1518 Phase 7.
 *
 * The input must already use the redacted scorecard envelope. This command
 * performs no broker/GitHub/network calls and validates the full input before
 * writing. Existing output paths are replay-guarded by sourceRoundId/digest.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  REVIEW_LINEAGE_SCORECARD_OUTPUT_KIND,
  assertReviewLineageScorecardReplay,
  buildReviewLineageScorecard,
  type ReviewLineageScorecardOutputV1,
} from "./scorecard.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function usage(): string {
  return [
    "Usage:",
    "  node packages/broker/dist/review-lifecycle/scorecard-cli.js",
    "    --input <redacted-input.json> [--output <scorecard.json>]",
    "",
    "Without --output the validated scorecard is written to stdout.",
  ].join("\n");
}

function readJsonFile(file: string, label: string): unknown {
  const resolved = path.resolve(process.cwd(), file);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${file}`);
  if (stat.size > MAX_INPUT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_INPUT_BYTES} bytes: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function replayIdentity(value: unknown): ReviewLineageScorecardOutputV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("existing scorecard output must be an object");
  }
  const output = value as Partial<ReviewLineageScorecardOutputV1>;
  if (output.kind !== REVIEW_LINEAGE_SCORECARD_OUTPUT_KIND) {
    throw new Error(
      `existing scorecard output kind must equal ${REVIEW_LINEAGE_SCORECARD_OUTPUT_KIND}`,
    );
  }
  if (typeof output.sourceRoundId !== "string" || output.sourceRoundId.length === 0) {
    throw new Error("existing scorecard output sourceRoundId is missing");
  }
  if (
    typeof output.inputDigest !== "string"
    || !DIGEST_PATTERN.test(output.inputDigest)
  ) {
    throw new Error("existing scorecard output inputDigest is invalid");
  }
  return output as ReviewLineageScorecardOutputV1;
}

export function runReviewLineageScorecardCli(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!values.input) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  const candidate = buildReviewLineageScorecard(
    readJsonFile(values.input, "scorecard input"),
  );
  const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  if (!values.output) {
    process.stdout.write(serialized);
    return 0;
  }

  const outputPath = path.resolve(process.cwd(), values.output);
  if (fs.existsSync(outputPath)) {
    const existing = replayIdentity(
      readJsonFile(outputPath, "existing scorecard output"),
    );
    if (existing.sourceRoundId !== candidate.sourceRoundId) {
      throw new Error(
        `existing output belongs to sourceRoundId ${existing.sourceRoundId}; refusing overwrite`,
      );
    }
    assertReviewLineageScorecardReplay(existing, candidate);
  }
  fs.writeFileSync(outputPath, serialized, { encoding: "utf8", flag: "w" });
  process.stdout.write(
    `review-lineage scorecard ok (${candidate.lineageCount} lineage(s), ${candidate.cohorts.length} budget cohort(s), advisory-only)\n`,
  );
  return 0;
}

const directRun =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (directRun) {
  try {
    process.exitCode = runReviewLineageScorecardCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `review-lineage scorecard FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
