/**
 * Validation test for Docker Runner branch/no-diff PR closeout guidance doc.
 *
 * This test verifies the guidance document at
 * docs/docker-runner-no-diff-closeout-guidance.md contains the required
 * sections, evidence fields, and safety markers defined in
 * a2a-plane#102 (internal tracker, private).
 *
 * Safety: read-only doc validation. No deploy, no restart, no live send, no secret logging.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(repoRoot, "docs", "docker-runner-no-diff-closeout-guidance.md");

test("guidance doc exists and is readable", async () => {
  const content = await readFile(docPath, "utf8");
  assert.ok(content.length > 500, "doc must have substantial content");
});

test("guidance doc contains required classification sections", async () => {
  const content = await readFile(docPath, "utf8");

  // Required section headers
  assert.match(content, /Classification.*No-Commits|Branch Ownership Mismatch/);
  assert.match(content, /Operator Closeout Procedure/);
  assert.match(content, /Safety Constraints/);
  assert.match(content, /Public-Readiness Status/);

  // Classification markers
  assert.match(content, /BRANCH_MISMATCH/);
  assert.match(content, /ZERO_DIFF/);
  assert.match(content, /MISSING_PR/);
  assert.match(content, /branch-mismatch/);
  assert.match(content, /no-diff/);
});

test("guidance doc lists required evidence fields", async () => {
  const content = await readFile(docPath, "utf8");

  // Evidence fields operators must preserve (from issue #102 scope)
  assert.match(content, /task.?[iI][dD]/);
  assert.match(content, /runner branch/);
  assert.match(content, /HEAD SHA/);
  assert.match(content, /origin\/main SHA/);
  assert.match(content, /issue URL/);
  assert.match(content, /branch URL/);
  assert.match(content, /no-diff marker/) || assert.match(content, /no.diff.*marker/);
  assert.match(content, /branch.mismatch.*marker/);
});

test("guidance doc references broker parent fix", async () => {
  const content = await readFile(docPath, "utf8");
  assert.match(content, /jinwon-int\/a2a-broker#446/);
});

test("guidance doc references upstream Terminal Brief gate", async () => {
  const content = await readFile(docPath, "utf8");
  assert.match(content, /openclaw\/openclaw#78261/);
});

test("guidance doc includes safety constraints", async () => {
  const content = await readFile(docPath, "utf8");

  // Must include no-deploy/no-restart safety language
  assert.match(content, /No production deploy/);
  assert.match(content, /No.*restart/);
  assert.match(content, /No.*DB mutation/);

  // Runtime/bootstrap guard paths must be mentioned
  assert.match(content, /AGENTS\.md/);
  assert.match(content, /SOUL\.md/);
  assert.match(content, /openclaw\/\*\*/);
});

test("guidance doc does not claim public-readiness is unblocked", async () => {
  const content = await readFile(docPath, "utf8");

  // Must contain NO-GO language
  assert.match(content, /NO-GO/);
  // Must not claim GO for public visibility
  assert.ok(
    !content.includes("public-readiness GO"),
    "doc must not claim public-readiness GO"
  );
});

test("guidance doc contains no raw secrets or private paths", async () => {
  const content = await readFile(docPath, "utf8");

  // No secret patterns
  assert.ok(!/gh[pousr]_[A-Za-z0-9_]{20,}/.test(content), "no GitHub tokens");
  assert.ok(!/github_pat_[A-Za-z0-9_]{20,}/.test(content), "no GitHub PATs");
  assert.ok(
    !/(?:Authorization:\s*(?:Bearer|token)\s+)[^\s<]+/.test(content),
    "no Authorization headers"
  );

  // No host-specific private paths
  assert.ok(!/\/root\//.test(content), "no /root/ paths");
  assert.ok(!/\/home\//.test(content), "no /home/ paths");
  assert.ok(!/\/tmp\//.test(content), "no /tmp/ paths");
  assert.ok(!/\/var\/folders\//.test(content), "no /var/folders/ paths");

  // No raw secrets
  assert.ok(!/token=/.test(content), "no token= patterns");
  assert.ok(!/password=/.test(content), "no password= patterns");
  assert.ok(!/secret=/.test(content), "no secret= patterns");
  assert.ok(!/api[_-]?key=/.test(content), "no api_key patterns");
});
