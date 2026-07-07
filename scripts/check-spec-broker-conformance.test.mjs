// #1304 M6-b spec<->broker conformance tests.
// The spec document carries machine-readable conformance blocks; the checker
// extracts them and compares against the broker source constants. A mutated
// spec (or a moved broker constant) must turn CI red — the dead-document
// prevention device behind the "spec with a reference implementation" claim.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractConformanceBlocks,
  collectBrokerActuals,
  evaluateSpecConformance,
  SPEC_PATH,
} from "./check-spec-broker-conformance.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_TEXT = readFileSync(join(REPO_ROOT, SPEC_PATH), "utf8");

test("the committed spec conforms to the broker source (zero problems)", () => {
  const blocks = extractConformanceBlocks(SPEC_TEXT);
  const actuals = collectBrokerActuals(REPO_ROOT);
  assert.deepEqual(evaluateSpecConformance({ blocks, actuals, repoRoot: REPO_ROOT }), []);
});

test("the spec covers every registered conformance key (no silent drops)", () => {
  const blocks = extractConformanceBlocks(SPEC_TEXT);
  const keys = blocks.map((block) => block.conformanceKey).sort();
  assert.deepEqual(keys, ["failure-readback", "independent-verification", "task-contract", "versioning"]);
});

test("a mutated spec enum value turns the checker red (divergence detection)", () => {
  const blocks = extractConformanceBlocks(SPEC_TEXT);
  const actuals = collectBrokerActuals(REPO_ROOT);
  const mutated = structuredClone(blocks);
  const readback = mutated.find((block) => block.conformanceKey === "failure-readback");
  readback.stages = [...readback.stages.slice(0, -1), "postmortem"];
  const problems = evaluateSpecConformance({ blocks: mutated, actuals, repoRoot: REPO_ROOT });
  assert.ok(problems.some((p) => /failure-readback/.test(p) && /stages/.test(p)), problems.join("; "));
});

test("a missing conformance block turns the checker red (coverage is mandatory)", () => {
  const blocks = extractConformanceBlocks(SPEC_TEXT).filter((block) => block.conformanceKey !== "versioning");
  const actuals = collectBrokerActuals(REPO_ROOT);
  const problems = evaluateSpecConformance({ blocks, actuals, repoRoot: REPO_ROOT });
  assert.ok(problems.some((p) => /versioning/.test(p) && /missing/.test(p)), problems.join("; "));
});

test("an unknown conformance key fails closed (typos cannot pass silently)", () => {
  const blocks = [...extractConformanceBlocks(SPEC_TEXT), { conformanceKey: "grade-inflation", value: 1 }];
  const actuals = collectBrokerActuals(REPO_ROOT);
  const problems = evaluateSpecConformance({ blocks, actuals, repoRoot: REPO_ROOT });
  assert.ok(problems.some((p) => /grade-inflation/.test(p)), problems.join("; "));
});

test("every source path cross-referenced by the spec blocks exists", () => {
  for (const block of extractConformanceBlocks(SPEC_TEXT)) {
    const sources = block.sources ?? (block.source ? [block.source] : []);
    assert.ok(sources.length > 0, `${block.conformanceKey}: blocks must cite their reference source`);
    for (const source of sources) {
      assert.doesNotThrow(() => readFileSync(join(REPO_ROOT, source), "utf8"), `${block.conformanceKey}: ${source} must exist`);
    }
  }
});
