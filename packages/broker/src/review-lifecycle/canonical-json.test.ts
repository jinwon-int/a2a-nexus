import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalize,
  diffHash,
  EMPTY_DIFF_HASH,
  findingSignature,
  intentHash,
  intentHashPayload,
} from "./canonical-json.js";

// Parity guard: these literals are pinned by the Phase-1 conformance check
// (test/conformance/check-bounded-pr-review-lifecycle.mjs). The broker port
// MUST produce identical values (spec: Phase 3 keeps Phase-1 vectors green).

const goldenContract = {
  kind: "IntentContractV1",
  lineageId: "golden-1",
  goal: "g",
  nonGoals: [],
  invariants: ["i"],
  acceptanceCriteria: [{ id: "AC-1", text: "t" }],
  declaredPaths: { allowed: ["a/**"] },
  baseSha: "0".repeat(40),
  headSha: "1".repeat(40),
};

test("canonical-json: intentHash matches the Phase-1 golden literal", () => {
  assert.equal(intentHash(goldenContract), "sha256:48eff27dde6b85ef2f531f23a13709eaf1fcd9b52a4e2e8567045bb6368bcf5e");
});

test("canonical-json: diffHash matches the Phase-1 golden literal", () => {
  const goldenPatch = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
  assert.equal(diffHash(goldenPatch), "sha256:ce4e4355ad4788f70a1f68697c3ce10d52bdf157bdf71fcd76c4478ec4a0b7e7");
});

test("canonical-json: empty diff hashes to the empty-string SHA-256", () => {
  assert.equal(EMPTY_DIFF_HASH, "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(diffHash(""), EMPTY_DIFF_HASH);
});

test("canonical-json: findingSignature matches the Phase-1 golden literal (evidence trimmed+sorted)", () => {
  assert.equal(
    findingSignature({ criterionRef: "AC-9", category: "regression", evidenceRefs: ["b.ts:2", "a.ts:1"] }),
    "sha256:3b2d758e35f5538add0fd028b0d24bbacf3f850bbd8abb9ca31c251d4a580e50",
  );
});

test("canonical-json: canonicalization is key-order independent", () => {
  const a = canonicalize({ x: 1, y: [2, { b: true, a: null }] });
  const b = canonicalize({ y: [2, { a: null, b: true }], x: 1 });
  assert.equal(a, b);
});

test("canonical-json: createdAt and intentHash are excluded from intentHash", () => {
  const withMeta = { ...goldenContract, createdAt: "2030-01-01T00:00:00Z", intentHash: "sha256:" + "f".repeat(64) };
  assert.equal(intentHash(withMeta), intentHash(goldenContract));
  assert.deepEqual(Object.keys(intentHashPayload(withMeta)).sort(), Object.keys(goldenContract).sort());
});

test("canonical-json: semantic field changes change the hash", () => {
  assert.notEqual(intentHash({ ...goldenContract, goal: "g!" }), intentHash(goldenContract));
  assert.notEqual(intentHash({ ...goldenContract, declaredPaths: { allowed: ["b/**"] } }), intentHash(goldenContract));
});

test("canonical-json: diffHash rejects non-string input", () => {
  assert.throws(() => diffHash(undefined as unknown as string), TypeError);
});
