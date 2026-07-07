import test from "node:test";
import assert from "node:assert/strict";

import { buildLaneReliabilityReport } from "./lane-reliability-report.mjs";
import { forbiddenIdentifierViolation } from "./check-lane-reliability-ledger.mjs";

const LEDGER = {
  entries: [
    {
      id: "big",
      adapterClass: "hermes-analysis",
      modelClass: "mixed",
      taskClass: "review",
      window: "2026-07",
      dispatchedCount: 10,
      substantiveCount: 7,
      acceptancePassCount: 4,
      acceptanceFailCount: 1,
    },
    {
      id: "small",
      adapterClass: "claude-analysis",
      modelClass: "mixed",
      taskClass: "analyze",
      window: "2026-07",
      dispatchedCount: 4,
      substantiveCount: 1,
      acceptancePassCount: 0,
      acceptanceFailCount: 0,
    },
    {
      id: "orig",
      adapterClass: "hermes-analysis",
      modelClass: "mixed",
      taskClass: "analyze",
      window: "2026-06",
      dispatchedCount: 6,
      substantiveCount: 1,
      acceptancePassCount: 0,
      acceptanceFailCount: 0,
    },
    {
      id: "corrected",
      supersedes: "orig",
      adapterClass: "hermes-analysis",
      modelClass: "mixed",
      taskClass: "analyze",
      window: "2026-06",
      dispatchedCount: 6,
      substantiveCount: 3,
      acceptancePassCount: 0,
      acceptanceFailCount: 0,
    },
  ],
};

test("rates only appear at sufficient sample size; small cells stay counts-only (#1300 M2-a)", () => {
  const rows = buildLaneReliabilityReport(LEDGER, { minSamples: 5 });
  const big = rows.find((r) => r.adapterClass === "hermes-analysis" && r.taskClass === "review");
  assert.equal(big.substantiveRate, 0.7);
  assert.equal(big.acceptancePassRate, 0.8);
  assert.equal(big.sampleCount, 10);

  const small = rows.find((r) => r.adapterClass === "claude-analysis");
  assert.equal(small.substantiveRate, "insufficient_data", "sample 4 < 5 must never render a ratio");
  assert.equal(small.substantiveCount, 1, "raw counts stay visible");
});

test("correction entries supersede originals before aggregation and sorting is rate-desc", () => {
  const rows = buildLaneReliabilityReport(LEDGER, { minSamples: 5 });
  const corrected = rows.find((r) => r.adapterClass === "hermes-analysis" && r.taskClass === "analyze");
  assert.equal(corrected.substantiveCount, 3, "corrected counts win, no double count");
  assert.equal(corrected.sampleCount, 6);
  assert.equal(rows[0].substantiveRate, 0.7, "sorted by substantive rate descending");
  assert.equal(rows[rows.length - 1].substantiveRate, "insufficient_data", "insufficient cells sort last");
});

test("report rows pass the ledger anonymity gate (pass-through, no identifiers)", () => {
  const rows = buildLaneReliabilityReport(LEDGER, { minSamples: 5 });
  for (const row of rows) {
    for (const value of [row.adapterClass, row.taskClass, ...row.windows]) {
      assert.equal(forbiddenIdentifierViolation(value), undefined, `identifier leaked: ${value}`);
    }
  }
});
