import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const brokerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(brokerDir, "..", "..");

function readRepo(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("promoted TCK gate keeps the documented agent_card category", () => {
  const workflow = readRepo(".github/workflows/tck-promoted-gate.yml");

  assert.match(workflow, /name:\s*tck-promoted-gate/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /packages\/broker\/src\/a2a\/\*\*/);
  assert.match(workflow, /packages\/broker\/src\/server\.ts/);
  assert.match(workflow, /npm run tck:run -- --level must --transport jsonrpc --/);
  assert.match(workflow, /--ignore=tests\/compatibility\/core_operations/);
  assert.match(workflow, /--ignore=tests\/compatibility\/grpc/);
  assert.match(workflow, /--ignore=tests\/compatibility\/http_json/);
  assert.match(workflow, /--ignore=tests\/compatibility\/jsonrpc/);
  assert.doesNotMatch(workflow, /tests\/compatibility\/agent_card -q/);
});

test("promoted TCK gate blocks on exactly the version-negotiation selector set", () => {
  const workflow = readRepo(".github/workflows/tck-promoted-gate.yml");

  assert.match(workflow, /name:\s*promoted TCK sub-category — version negotiation/);
  assert.match(workflow, /test_unsupported_version_returns_error_jsonrpc/);
  assert.match(workflow, /test_empty_version_treated_as_default_jsonrpc/);
  assert.match(workflow, /test_version_not_supported_error/);
  assert.match(workflow, /test_error_code_in_valid_range/);
  assert.match(workflow, /--deselect='tests\/compatibility\/jsonrpc\/test_error_codes\.py::TestJsonRpcErrorCodeRange::test_error_code_in_valid_range\[GetTask-nonexistent\]'/);
  assert.match(workflow, /--deselect='tests\/compatibility\/jsonrpc\/test_error_codes\.py::TestJsonRpcErrorCodeRange::test_error_code_in_valid_range\[CancelTask-nonexistent\]'/);
  assert.match(workflow, /tck-promoted-version-negotiation\.log/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});

test("promoted TCK gate is documented separately from the non-gating measurement lane", () => {
  const runbook = readRepo("packages/broker/docs/a2a-tck-runbook.md");

  assert.match(runbook, /tck-promoted-gate\.yml/);
  assert.match(runbook, /agent_card/);
  assert.match(runbook, /measurement lane .*non-gating/i);
  assert.match(runbook, /one-time promotion exception/i);
  assert.match(runbook, /stable window at 2/i);
  assert.match(runbook, /future promoted categories must appear as stable promotion candidates/i);
});

test("promoted TCK gate rejects stale release-readiness projections", () => {
  const workflow = readRepo(".github/workflows/tck-promoted-gate.yml");
  const readiness = readRepo("docs/release-readiness.md");

  assert.match(workflow, /packages\/broker\/scripts\/project-tck-readiness\.mjs/);
  assert.match(workflow, /packages\/broker\/scripts\/project-tck-readiness\.test\.mjs/);
  assert.match(workflow, /packages\/broker\/docs\/tck-history\.json/);
  assert.match(workflow, /packages\/broker\/docs\/tck-failing-categories\.json/);
  assert.match(workflow, /docs\/release-readiness\.md/);
  assert.match(workflow, /project-tck-readiness\.mjs --check/);
  assert.match(readiness, /<!-- TCK-READINESS:START -->/);
  assert.match(readiness, /A2A 1\.0-compatible broker alpha profile/);
  assert.match(readiness, /<!-- TCK-READINESS:END -->/);
});

test("broker test suite covers TCK harness passthrough and promoted gate guards", () => {
  const manifest = JSON.parse(readRepo("packages/broker/scripts/test-manifest.json"));
  const testScript = manifest.legacyEquivalent;

  assert.match(testScript, /a2a-tck-harness-args\.test\.mjs/);
  assert.match(testScript, /check-tck-promoted-gate\.test\.mjs/);
  assert.match(testScript, /project-tck-readiness\.test\.mjs/);
});
