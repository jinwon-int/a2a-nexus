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

test("promoted TCK gate blocks on exactly the artifact/message-projection selector set", () => {
  const workflow = readRepo(".github/workflows/tck-promoted-gate.yml");

  assert.match(workflow, /name:\s*promoted TCK sub-category — artifact\/message projection/);
  assert.match(workflow, /test_task_has_text_artifact/);
  assert.match(workflow, /test_task_has_file_artifact/);
  assert.match(workflow, /test_task_has_file_url_artifact/);
  assert.match(workflow, /test_task_has_data_artifact/);
  assert.match(workflow, /test_returns_message_with_text_part/);
  assert.match(workflow, /test_response_validates_against_schema/);
  assert.match(workflow, /test_no_snake_case_keys/);
  assert.match(workflow, /test_enum_values_are_strings/);
  assert.match(workflow, /test_timestamps_are_iso8601_utc/);
  assert.match(workflow, /tck-promoted-artifact-message-projection\.log/);
});

test("promoted TCK gate blocks on the runnable error-codes/ErrorInfo selector set", () => {
  const workflow = readRepo(".github/workflows/tck-promoted-gate.yml");
  const baseline = JSON.parse(readRepo("packages/broker/docs/tck-failing-categories.json"));

  assert.match(workflow, /name:\s*promoted TCK sub-category — error codes and ErrorInfo/);
  assert.match(workflow, /test_error_has_code_and_message_jsonrpc/);
  assert.match(workflow, /test_error_object_structure/);
  assert.match(workflow, /test_a2a_error_codes_in_range/);
  assert.match(workflow, /test_error_data_contains_error_info/);
  assert.match(workflow, /test_task_not_cancelable_error/);
  assert.match(workflow, /test_push_notification_not_supported_error/);
  assert.match(workflow, /test_content_type_not_supported_error/);
  assert.match(workflow, /test_error_data_is_array/);
  assert.match(workflow, /test_data_contains_error_info/);
  assert.match(workflow, /test_error_info_valid/);
  assert.match(workflow, /test_error_info_reason_matches_condition/);
  // Owns only the CancelTask variant of the shared range test; the GetTask
  // (task-not-found) and SendMessage-bad-version (version-negotiation)
  // variants stay with their own categories.
  assert.match(workflow, /--deselect='tests\/compatibility\/jsonrpc\/test_error_codes\.py::TestJsonRpcErrorCodeRange::test_error_code_in_valid_range\[GetTask-nonexistent\]'/);
  assert.match(workflow, /--deselect='tests\/compatibility\/jsonrpc\/test_error_codes\.py::TestJsonRpcErrorCodeRange::test_error_code_in_valid_range\[SendMessage-bad-version\]'/);
  assert.match(workflow, /tck-promoted-error-codes\.log/);

  // The capability-unreachable selector must be documented in the baseline,
  // not silently dropped from the gate.
  const errorCodes = baseline.subCategories.find((sub) => sub.id === "jsonrpc-error-codes-and-errorinfo");
  assert.equal(errorCodes.promotionReadiness, "promoted");
  assert.deepEqual(
    errorCodes.capabilityExcludedSelectors?.map((entry) => entry.selector),
    ["tests/compatibility/jsonrpc/test_error_codes.py::TestJsonRpcErrorCodeMappings::test_unsupported_operation_error"],
  );
});

test("promoted sub-categories in the baseline all have a gate job", () => {
  const workflow = readRepo(".github/workflows/tck-promoted-gate.yml");
  const baseline = JSON.parse(readRepo("packages/broker/docs/tck-failing-categories.json"));

  const JOB_NAME_BY_CATEGORY = {
    "jsonrpc-version-negotiation": /promoted TCK sub-category — version negotiation/,
    "jsonrpc-artifact-message-projection": /promoted TCK sub-category — artifact\/message projection/,
    "jsonrpc-error-codes-and-errorinfo": /promoted TCK sub-category — error codes and ErrorInfo/,
  };
  for (const sub of baseline.subCategories) {
    if (sub.promotionReadiness !== "promoted") continue;
    const jobName = JOB_NAME_BY_CATEGORY[sub.id];
    assert.ok(jobName, `no gate-job mapping for promoted sub-category ${sub.id}`);
    assert.match(workflow, jobName, `promoted sub-category ${sub.id} is missing its gate job`);
  }
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
