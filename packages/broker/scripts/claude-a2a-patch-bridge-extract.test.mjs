// Diff-extraction unit tests for the Claude patch bridge.
//
// Found while triaging a live propose_patch failure whose only symptom was
// `git apply --check failed: corrupt patch at line 42`. The patch itself lives
// in a workspace the bridge deletes on exit, so the extraction path is covered
// directly here rather than only through a spawned bridge process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "./claude-a2a-patch-bridge.mjs";

const { extractUnifiedDiff } = __test;

const DIFF = [
  "diff --git a/guide.md b/guide.md",
  "--- a/guide.md",
  "+++ b/guide.md",
  "@@ -3,5 +3,11 @@",
  " Set it via:",
  " ",
  " ```bash",
  " EXISTING=1",
  " ```",
  "+",
  "+```bash",
  "+ADDED=1",
  "+```",
].join("\n");

test("a fenced diff that patches a markdown file keeps its inner fences and drops trailing prose", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "```diff\n" + DIFF + "\n```\n\nApplied the documentation update as requested.",
  });
  const got = extractUnifiedDiff(stdout);
  assert.equal(got.kind, "diff");
  assert.equal(got.body, DIFF, "extracted body must equal the diff exactly");
  assert.equal(got.body.includes("Applied the documentation update"), false, "prose must not enter the patch");
  assert.equal(/^```[ \t]*$/m.test(got.body), false, "the closing fence must not enter the patch");
});

test("a non-diff string earlier in the envelope does not mask a diff in a later field", () => {
  const stdout = JSON.stringify({
    type: "result",
    message: "I inspected the repository and prepared a change.",
    result: "```diff\n" + DIFF + "\n```",
  });
  const got = extractUnifiedDiff(stdout);
  assert.equal(got.kind, "diff");
  assert.equal(got.body, DIFF);
});

test("an explicit NO_DIFF marker is still honoured", () => {
  const stdout = JSON.stringify({ type: "result", result: "```\nNO_DIFF: nothing to change\n```" });
  assert.equal(extractUnifiedDiff(stdout).kind, "no_diff");
});
