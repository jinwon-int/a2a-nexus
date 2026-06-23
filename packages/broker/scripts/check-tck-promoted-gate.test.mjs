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

test("promoted TCK gate runs only the documented agent_card category", () => {
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

test("promoted TCK gate is documented separately from the non-gating measurement lane", () => {
  const runbook = readRepo("packages/broker/docs/a2a-tck-runbook.md");

  assert.match(runbook, /tck-promoted-gate\.yml/);
  assert.match(runbook, /agent_card/);
  assert.match(runbook, /measurement lane .*non-gating/i);
  assert.match(runbook, /one-time promotion exception/i);
  assert.match(runbook, /stable window at 2/i);
  assert.match(runbook, /future promoted categories must appear as stable promotion candidates/i);
});

test("broker test suite covers TCK harness passthrough and promoted gate guards", () => {
  const pkg = JSON.parse(readRepo("packages/broker/package.json"));
  const testScript = pkg.scripts.test;

  assert.match(testScript, /a2a-tck-harness-args\.test\.mjs/);
  assert.match(testScript, /check-tck-promoted-gate\.test\.mjs/);
});
