import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TCK_READINESS_END,
  TCK_READINESS_START,
  buildTckReadinessProjection,
  checkTckReadinessDocument,
  renderTckReadinessMarkdown,
  replaceTckReadinessBlock,
  selectLatestSufficientMeasurement,
} from "./project-tck-readiness.mjs";

const brokerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(brokerDir, "..", "..");

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
}

function sufficientMeasurement(overrides = {}) {
  return {
    date: "2026-07-22",
    level: "must",
    transport: "jsonrpc",
    overallPercent: 65.7,
    categories: {
      agent_card: { pass: 6, total: 6 },
      jsonrpc: { pass: 46, total: 94 },
    },
    subCategories: {
      "jsonrpc-version-negotiation": { pass: 4, total: 4 },
    },
    pytestOutcomeAccounting: { sufficientForMeasurement: true },
    source: "tck-measurement workflow run 29917128590",
    ...overrides,
  };
}

function classification(overrides = {}) {
  return {
    subCategories: [
      {
        id: "jsonrpc-version-negotiation",
        measuredPassTotal: { pass: 4, total: 4 },
        promotionReadiness: "promoted",
        ...overrides,
      },
      {
        id: "jsonrpc-error-codes-and-errorinfo",
        measuredPassTotal: { pass: 6, total: 13 },
        promotionReadiness: "blocked-pending-fresh-run",
      },
    ],
  };
}

test("selects the latest sufficient matching measurement and skips incomplete runs", () => {
  const earlier = sufficientMeasurement({ source: "tck-measurement workflow run 100" });
  const incomplete = sufficientMeasurement({
    source: "tck-measurement workflow run 200",
    pytestOutcomeAccounting: { sufficientForMeasurement: false },
  });
  const wrongTransport = sufficientMeasurement({ transport: "grpc", source: "tck-measurement workflow run 300" });

  assert.equal(
    selectLatestSufficientMeasurement({ measurements: [earlier, incomplete, wrongTransport] }),
    earlier,
  );
});

test("renders current overall, JSON-RPC, and promoted results without overclaiming", () => {
  const rendered = renderTckReadinessMarkdown(
    buildTckReadinessProjection({ measurements: [sufficientMeasurement()] }, classification()),
  );

  assert.match(rendered, /A2A 1\.0-compatible broker alpha profile/);
  assert.match(rendered, /\| Overall compatibility \| 65\.7% \|/);
  assert.match(rendered, /\| JSON-RPC \| 46\/94 \|/);
  assert.match(rendered, /`jsonrpc-version-negotiation` \| 4\/4/);
  assert.doesNotMatch(rendered, /\bcertified\b|\bfully compliant\b/i);
});

test("rejects promoted classification drift from the latest measurement", () => {
  assert.throws(
    () => buildTckReadinessProjection(
      { measurements: [sufficientMeasurement()] },
      classification({ measuredPassTotal: { pass: 3, total: 4 } }),
    ),
    /disagrees with its classified measuredPassTotal/,
  );
});

test("capability-excluded promoted sub-category projects when skips match the documented exclusions exactly", () => {
  const excluded = {
    id: "jsonrpc-error-codes-and-errorinfo",
    measuredPassTotal: { pass: 12, total: 13 },
    promotionReadiness: "promoted",
    capabilityExcludedSelectors: [
      { selector: "tests/compatibility/jsonrpc/test_error_codes.py::TestJsonRpcErrorCodeMappings::test_unsupported_operation_error", reason: "streaming declared" },
    ],
  };
  const withExclusion = classification();
  withExclusion.subCategories[1] = excluded;
  const measurement = sufficientMeasurement({
    subCategories: {
      "jsonrpc-version-negotiation": { pass: 4, total: 4 },
      "jsonrpc-error-codes-and-errorinfo": { pass: 12, total: 13, outcomes: { passed: 12, failed: 0, skipped: 1 } },
    },
  });
  const projection = buildTckReadinessProjection({ measurements: [measurement] }, withExclusion);
  assert.deepEqual(
    projection.promoted.find((row) => row.id === "jsonrpc-error-codes-and-errorinfo").result,
    { pass: 12, total: 13 },
  );

  // A real failure behind the same ratio still blocks.
  const withFailure = sufficientMeasurement({
    subCategories: {
      "jsonrpc-version-negotiation": { pass: 4, total: 4 },
      "jsonrpc-error-codes-and-errorinfo": { pass: 12, total: 13, outcomes: { passed: 12, failed: 1, skipped: 0 } },
    },
  });
  assert.throws(
    () => buildTckReadinessProjection({ measurements: [withFailure] }, withExclusion),
    /not fully green/,
  );

  // Extra undocumented skips also block.
  const withExtraSkip = sufficientMeasurement({
    subCategories: {
      "jsonrpc-version-negotiation": { pass: 4, total: 4 },
      "jsonrpc-error-codes-and-errorinfo": { pass: 11, total: 13, outcomes: { passed: 11, failed: 0, skipped: 2 } },
    },
  });
  const drifted = classification();
  drifted.subCategories[1] = { ...excluded, measuredPassTotal: { pass: 11, total: 13 } };
  assert.throws(
    () => buildTckReadinessProjection({ measurements: [withExtraSkip] }, drifted),
    /not fully green/,
  );
});

test("rejects a promoted sub-category that is duplicated or no longer fully green", () => {
  const regressed = sufficientMeasurement({
    subCategories: {
      "jsonrpc-version-negotiation": { pass: 3, total: 4 },
    },
  });
  assert.throws(
    () => buildTckReadinessProjection(
      { measurements: [regressed] },
      classification({ measuredPassTotal: { pass: 3, total: 4 } }),
    ),
    /not fully green/,
  );

  const duplicate = classification();
  duplicate.subCategories.push({ ...duplicate.subCategories[0] });
  assert.throws(
    () => buildTckReadinessProjection({ measurements: [sufficientMeasurement()] }, duplicate),
    /is duplicated/,
  );
});

test("detects a stale committed projection before replacing it", () => {
  const rendered = renderTckReadinessMarkdown(
    buildTckReadinessProjection({ measurements: [sufficientMeasurement()] }, classification()),
  );
  const stale = [
    "# Readiness",
    "",
    TCK_READINESS_START,
    "stale overall: 60%; stale JSON-RPC: 40/94",
    TCK_READINESS_END,
    "",
  ].join("\n");

  assert.equal(checkTckReadinessDocument(stale, rendered), false);
  const updated = replaceTckReadinessBlock(stale, rendered);
  assert.equal(checkTckReadinessDocument(updated, rendered), true);
  assert.doesNotMatch(updated, /60%|40\/94/);
});

test("fails closed when projection markers are missing or duplicated", () => {
  assert.throws(() => replaceTckReadinessBlock("# no markers\n", "projection"), /markers are missing/);
  assert.throws(
    () => replaceTckReadinessBlock(
      `${TCK_READINESS_START}\n${TCK_READINESS_END}\n${TCK_READINESS_END}`,
      "projection",
    ),
    /markers must appear exactly once/,
  );
});

test("the committed release-readiness projection matches the canonical ledgers", () => {
  const history = readJson("packages/broker/docs/tck-history.json");
  const categories = readJson("packages/broker/docs/tck-failing-categories.json");
  const document = readFileSync(resolve(repoRoot, "docs/release-readiness.md"), "utf8");
  const rendered = renderTckReadinessMarkdown(buildTckReadinessProjection(history, categories));

  assert.equal(checkTckReadinessDocument(document, rendered), true);
});
