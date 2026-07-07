#!/usr/bin/env node
/**
 * Spec <-> broker conformance checker (#1304 M6-b).
 *
 * Spec: docs/spec/verifiable-delegation-contract-v0.md. The spec carries
 * machine-readable ```json conformance blocks; this checker extracts them and
 * compares every value against what it extracts from the broker SOURCE files
 * with tightly anchored patterns. Divergence in either direction turns CI
 * red: a spec edit without the matching implementation (or vice versa), a
 * missing block, an unknown key, a moved constant, or a dead source path.
 * This is the dead-document prevention device — the "spec with a reference
 * implementation" claim is only as good as this gate.
 *
 * Read-only; no broker build required (source-text extraction by design, so
 * the gate runs before/without dist).
 *
 * Usage: node scripts/check-spec-broker-conformance.mjs [--json]
 * Exit 0 = conformant; 1 = divergence; 2 = read error.
 */
import fs from "node:fs";
import path from "node:path";

export const SPEC_PATH = "docs/spec/verifiable-delegation-contract-v0.md";
const CONFORMANCE_FENCE = /```json conformance\n([\s\S]*?)```/g;

/** Parse every ```json conformance block out of the spec markdown. */
export function extractConformanceBlocks(markdown) {
  const blocks = [];
  for (const match of markdown.matchAll(CONFORMANCE_FENCE)) {
    blocks.push(JSON.parse(match[1]));
  }
  return blocks;
}

function readSource(repoRoot, relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function anchored(source, pattern, what) {
  const match = source.match(pattern);
  if (!match) throw new Error(`anchor not found: ${what} — the broker source moved; update the extractor AND the spec together`);
  return match;
}

function stringList(literal) {
  return [...literal.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Extract the actual contract values from the broker source files. Every
 * extractor is anchored: if the constant moves or is renamed, this throws
 * instead of silently comparing nothing.
 */
export function collectBrokerActuals(repoRoot) {
  const readiness = readSource(repoRoot, "packages/broker/src/task-readiness.ts");
  const errorDetails = readSource(repoRoot, "packages/broker/src/core/task-error-details.ts");
  const types = readSource(repoRoot, "packages/broker/src/core/types.ts");
  const workerReview = readSource(repoRoot, "packages/broker/src/worker-review.ts");
  const workerAcceptance = readSource(repoRoot, "packages/broker/src/worker-acceptance.ts");

  return {
    "task-contract": {
      requiredFields: [...readiness.matchAll(/missing\.push\("([a-zA-Z]+)"\)/g)].map((m) => m[1]),
      gatedIntents: stringList(anchored(readiness, /PATCH_TASK_INTENTS = new Set\(\[([^\]]*)\]\)/, "PATCH_TASK_INTENTS")[1]),
      gatedModes: stringList(anchored(readiness, /PATCH_TASK_MODES = new Set\(\[([^\]]*)\]\)/, "PATCH_TASK_MODES")[1]),
      modes: stringList(anchored(readiness, /export type TaskReadinessMode = ([^;]+);/, "TaskReadinessMode")[1]),
      defaultMode: anchored(readiness, /DEFAULT_TASK_READINESS_MODE: TaskReadinessMode = "(\w+)"/, "DEFAULT_TASK_READINESS_MODE")[1],
      errorCode: anchored(readiness, /code: "(spec_underspecified)"/, "spec_underspecified code")[1],
      source: "packages/broker/src/task-readiness.ts",
    },
    "failure-readback": {
      stages: stringList(anchored(errorDetails, /export const FAILURE_READBACK_STAGES = \[([^\]]*)\]/s, "FAILURE_READBACK_STAGES")[1]),
      excerptMaxLines: Number(anchored(errorDetails, /FAILURE_EXCERPT_MAX_LINES = ([\d_]+)/, "FAILURE_EXCERPT_MAX_LINES")[1].replaceAll("_", "")),
      excerptMaxChars: Number(anchored(errorDetails, /FAILURE_EXCERPT_MAX_CHARS = ([\d_]+)/, "FAILURE_EXCERPT_MAX_CHARS")[1].replaceAll("_", "")),
      source: "packages/broker/src/core/task-error-details.ts",
    },
    "independent-verification": {
      validationKinds: stringList(anchored(types, /export type ValidationKind = ([^;]+);/, "ValidationKind")[1]),
      verdicts: stringList(anchored(types, /export type ValidationVerdict = ([^;]+);/, "ValidationVerdict")[1]),
      independenceErrorCode: anchored(workerReview, /code: "(review_not_independent)"/, "review_not_independent code")[1],
      sources: ["packages/broker/src/core/types.ts", "packages/broker/src/worker-review.ts"],
    },
    versioning: {
      legacySingletonAcceptanceCutoffIso: anchored(
        workerAcceptance,
        /LEGACY_SINGLETON_ACCEPTANCE_CUTOFF_ISO = "([^"]+)"/,
        "LEGACY_SINGLETON_ACCEPTANCE_CUTOFF_ISO",
      )[1],
      source: "packages/broker/src/worker-acceptance.ts",
    },
  };
}

/** Compare spec blocks against broker actuals. Returns problems; empty = conformant. */
export function evaluateSpecConformance({ blocks, actuals, repoRoot }) {
  const problems = [];
  const byKey = new Map();
  for (const block of blocks) {
    if (typeof block?.conformanceKey !== "string") {
      problems.push("a conformance block lacks conformanceKey");
      continue;
    }
    if (byKey.has(block.conformanceKey)) problems.push(`duplicate conformance block '${block.conformanceKey}'`);
    byKey.set(block.conformanceKey, block);
  }
  for (const key of Object.keys(actuals)) {
    if (!byKey.has(key)) problems.push(`spec is missing the '${key}' conformance block (coverage is mandatory)`);
  }
  for (const [key, block] of byKey) {
    const actual = actuals[key];
    if (!actual) {
      problems.push(`spec carries unknown conformance key '${key}' (fail-closed: typo or unregistered extractor)`);
      continue;
    }
    for (const [field, expected] of Object.entries(block)) {
      if (field === "conformanceKey") continue;
      if (field === "source" || field === "sources") {
        const sources = field === "sources" ? expected : [expected];
        for (const source of sources) {
          if (!fs.existsSync(path.join(repoRoot, source))) {
            problems.push(`${key}.${field}: cited source '${source}' does not exist`);
          }
        }
        continue;
      }
      const actualValue = actual[field];
      if (actualValue === undefined) {
        problems.push(`${key}.${field}: spec declares a field the extractor does not produce`);
      } else if (JSON.stringify(actualValue) !== JSON.stringify(expected)) {
        problems.push(`${key}.${field}: spec says ${JSON.stringify(expected)} but broker source has ${JSON.stringify(actualValue)}`);
      }
    }
  }
  return problems;
}

function main(argv) {
  const repoRoot = process.cwd();
  let markdown;
  try {
    markdown = fs.readFileSync(path.join(repoRoot, SPEC_PATH), "utf8");
  } catch (error) {
    process.stderr.write(`cannot read spec '${SPEC_PATH}': ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let problems;
  try {
    problems = evaluateSpecConformance({
      blocks: extractConformanceBlocks(markdown),
      actuals: collectBrokerActuals(repoRoot),
      repoRoot,
    });
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
    return problems.length ? 1 : 0;
  }
  if (problems.length) {
    process.stderr.write(`spec-broker conformance FAILED (${problems.length} problem(s)):\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    return 1;
  }
  process.stdout.write("spec-broker conformance ok (4 blocks match the broker source)\n");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
