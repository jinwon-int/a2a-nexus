import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTckLog, upsertMeasurement, buildMeasurement } from "./append-tck-history.mjs";

const SAMPLE_LOG = `
A2A TCK run
OVERALL COMPATIBILITY: 62.7%
MUST: 18/75
SHOULD: 4/20
agent_card: 6/6
jsonrpc: 18/75
http_json: 0/0
`;

const ERROR_INFO_NODE = "tests/compatibility/jsonrpc/test_error_info.py::TestJsonRpcErrorInfo::test_error_info_valid";
const TASK_NOT_FOUND_NODE = "tests/compatibility/jsonrpc/test_error_codes.py::TestJsonRpcErrorCodeMappings::test_task_not_found_error";
const UNKNOWN_NODE = "tests/compatibility/core_operations/test_requirements.py::test_must_requirement[CORE-SEND-001-jsonrpc]";
const CLASSIFICATION = JSON.parse(readFileSync(new URL("../docs/tck-failing-categories.json", import.meta.url), "utf8"));

test("parseTckLog extracts overall percent, MUST ratio, and category ratios", () => {
  const parsed = parseTckLog(SAMPLE_LOG);
  assert.equal(parsed.overallPercent, 62.7);
  assert.deepEqual(parsed.must, { pass: 18, total: 75 });
  assert.deepEqual(parsed.categories.agent_card, { pass: 6, total: 6 });
  assert.deepEqual(parsed.categories.jsonrpc, { pass: 18, total: 75 });
  assert.deepEqual(parsed.categories.http_json, { pass: 0, total: 0 });
  assert.equal(parsed.categories.grpc, undefined);
});

test("parseTckLog returns empty shape when no numbers are present", () => {
  const parsed = parseTckLog("no summary captured\n");
  assert.equal(parsed.overallPercent, null);
  assert.equal(parsed.must, null);
  assert.deepEqual(parsed.categories, {});
});

test("parseTckLog measures all five stable sub-categories from complete verbose outcomes", () => {
  const outcomeByCategory = {
    "jsonrpc-error-codes-and-errorinfo": "PASSED",
    "jsonrpc-task-not-found-and-invalid-task": "FAILED",
    "jsonrpc-artifact-message-projection": "SKIPPED",
    "jsonrpc-streaming-subscribe-ordering": "PASSED",
    "jsonrpc-version-negotiation": "FAILED",
  };
  const verboseLines = [];
  const totals = { passed: 1, failed: 0, skipped: 0 }; // the unknown node passes
  for (const sub of CLASSIFICATION.subCategories) {
    const outcome = outcomeByCategory[sub.id];
    for (const nodeId of sub.pytestNodeIdSelectors) {
      verboseLines.push(`${nodeId} ${outcome}`);
      totals[outcome.toLowerCase()] += 1;
    }
  }
  verboseLines.push(`${UNKNOWN_NODE} PASSED`);
  const parsed = parseTckLog(`${verboseLines.join("\n")}
=========================== short test summary info ============================
FAILED ${TASK_NOT_FOUND_NODE} - AssertionError: wrong code
=== ${totals.failed} failed, ${totals.passed} passed, ${totals.skipped} skipped in 1.23s ===
`);

  const selectorCount = (id) => CLASSIFICATION.subCategories.find((sub) => sub.id === id).pytestNodeIdSelectors.length;

  assert.deepEqual(parsed.subCategories["jsonrpc-error-codes-and-errorinfo"], {
    pass: selectorCount("jsonrpc-error-codes-and-errorinfo"),
    total: selectorCount("jsonrpc-error-codes-and-errorinfo"),
    outcomes: { passed: selectorCount("jsonrpc-error-codes-and-errorinfo"), failed: 0, skipped: 0 },
  });
  assert.deepEqual(parsed.subCategories["jsonrpc-task-not-found-and-invalid-task"], {
    pass: 0,
    total: selectorCount("jsonrpc-task-not-found-and-invalid-task"),
    outcomes: { passed: 0, failed: selectorCount("jsonrpc-task-not-found-and-invalid-task"), skipped: 0 },
  });
  assert.deepEqual(parsed.subCategories["jsonrpc-artifact-message-projection"], {
    pass: 0,
    total: selectorCount("jsonrpc-artifact-message-projection"),
    outcomes: { passed: 0, failed: 0, skipped: selectorCount("jsonrpc-artifact-message-projection") },
  });
  assert.deepEqual(parsed.subCategories["jsonrpc-streaming-subscribe-ordering"], {
    pass: selectorCount("jsonrpc-streaming-subscribe-ordering"),
    total: selectorCount("jsonrpc-streaming-subscribe-ordering"),
    outcomes: { passed: selectorCount("jsonrpc-streaming-subscribe-ordering"), failed: 0, skipped: 0 },
  });
  assert.deepEqual(parsed.subCategories["jsonrpc-version-negotiation"], {
    pass: 0,
    total: selectorCount("jsonrpc-version-negotiation"),
    outcomes: { passed: 0, failed: selectorCount("jsonrpc-version-negotiation"), skipped: 0 },
  });
  assert.equal(parsed.pytestOutcomeAccounting.sufficientForMeasurement, true);
  assert.equal(parsed.pytestOutcomeAccounting.observedNodeCount, verboseLines.length);
  assert.equal(parsed.pytestOutcomeAccounting.classifiedNodeCount, verboseLines.length - 1);
  assert.deepEqual(parsed.pytestOutcomeAccounting.missingSelectors, {});
  assert.deepEqual(parsed.pytestOutcomeAccounting.unclassified, [{ nodeId: UNKNOWN_NODE, outcome: "PASSED" }]);
  assert.deepEqual(parsed.pytestOutcomeAccounting.duplicateFailureSummaryNodeIds, [TASK_NOT_FOUND_NODE]);
});

test("parseTckLog does not fabricate pass/total from a failure-summary-only log", () => {
  const parsed = parseTckLog(`
=========================== short test summary info ============================
FAILED ${TASK_NOT_FOUND_NODE} - AssertionError: wrong code
============================== 1 failed in 0.10s ===============================
`);

  assert.deepEqual(parsed.subCategories, {});
  assert.equal(parsed.pytestOutcomeAccounting.sufficientForMeasurement, false);
  assert.match(parsed.pytestOutcomeAccounting.incompleteReasons.join("\n"), /do not reconcile/);
  assert.deepEqual(parsed.pytestOutcomeAccounting.verboseOutcomes, { passed: 0, failed: 0, skipped: 0 });
});

test("parseTckLog with a truncated verbose log records incomplete evidence", () => {
  const parsed = parseTckLog(`
${ERROR_INFO_NODE} PASSED [ 50%]
========================= 1 failed, 1 passed in 0.20s ==========================
`);

  assert.deepEqual(parsed.subCategories, {});
  assert.equal(parsed.pytestOutcomeAccounting.sufficientForMeasurement, false);
  assert.match(parsed.pytestOutcomeAccounting.incompleteReasons.join("\n"), /do not reconcile/);
});

test("parseTckLog refuses ambiguous selector matches instead of double-counting", () => {
  const classification = {
    subCategories: [
      { id: "one", pytestNodeIdSelectors: ["tests/compatibility/jsonrpc/test_error_info.py::"] },
      { id: "two", pytestNodeIdSelectors: [ERROR_INFO_NODE] },
    ],
  };
  const parsed = parseTckLog(`${ERROR_INFO_NODE} PASSED [100%]\n1 passed in 0.01s\n`, classification);

  assert.deepEqual(parsed.subCategories, {});
  assert.equal(parsed.pytestOutcomeAccounting.sufficientForMeasurement, false);
  assert.deepEqual(parsed.pytestOutcomeAccounting.ambiguous, [{
    nodeId: ERROR_INFO_NODE,
    outcome: "PASSED",
    subCategoryIds: ["one", "two"],
  }]);
});

test("upsertMeasurement appends and keeps measurements sorted by date", () => {
  const history = { schemaVersion: 1, measurements: [] };
  const a = buildMeasurement({ date: "2026-06-11", level: "must", transport: "jsonrpc", parsed: parseTckLog(SAMPLE_LOG) });
  const b = buildMeasurement({ date: "2026-06-04", level: "must", transport: "jsonrpc", parsed: parseTckLog(SAMPLE_LOG) });
  const out = upsertMeasurement(upsertMeasurement(history, a), b);
  assert.deepEqual(out.measurements.map((m) => m.date), ["2026-06-04", "2026-06-11"]);
});

test("upsertMeasurement replaces an entry with the same date+level+transport", () => {
  const history = { schemaVersion: 1, measurements: [] };
  const first = buildMeasurement({ date: "2026-06-11", level: "must", transport: "jsonrpc", parsed: { must: { pass: 12, total: 75 }, overallPercent: null, categories: {} } });
  const second = buildMeasurement({ date: "2026-06-11", level: "must", transport: "jsonrpc", parsed: { must: { pass: 18, total: 75 }, overallPercent: null, categories: {} } });
  const out = upsertMeasurement(upsertMeasurement(history, first), second);
  assert.equal(out.measurements.length, 1);
  assert.deepEqual(out.measurements[0].must, { pass: 18, total: 75 });
});

test("buildMeasurement normalizes missing fields", () => {
  const entry = buildMeasurement({ date: "2026-06-11", level: "should", transport: "grpc", parsed: { categories: {} } });
  assert.equal(entry.overallPercent, null);
  assert.equal(entry.must, null);
  assert.deepEqual(entry.categories, {});
  assert.equal(entry.level, "should");
});

test("buildMeasurement remains compatible with parsed logs that predate node outcome fields", () => {
  const entry = buildMeasurement({
    date: "2026-06-11",
    level: "must",
    transport: "jsonrpc",
    parsed: { must: { pass: 12, total: 75 }, overallPercent: null, categories: { jsonrpc: { pass: 12, total: 75 } } },
  });
  assert.equal(entry.subCategories, undefined);
  assert.equal(entry.pytestOutcomeAccounting, undefined);
  assert.deepEqual(entry.categories.jsonrpc, { pass: 12, total: 75 });
});
