import test from "node:test";
import assert from "node:assert/strict";

import { buildDispatchRiskHints } from "./dispatch-risk-hints.mjs";
import { forbiddenIdentifierViolation } from "./check-lane-reliability-ledger.mjs";

const LEDGER = {
  entries: [
    {
      id: "low",
      adapterClass: "hermes-analysis",
      modelClass: "mixed",
      taskClass: "analyze",
      window: "2026-07",
      dispatchedCount: 10,
      substantiveCount: 4,
    },
    {
      id: "healthy",
      adapterClass: "claude-analysis",
      modelClass: "mixed",
      taskClass: "analyze",
      window: "2026-07",
      dispatchedCount: 10,
      substantiveCount: 9,
    },
    {
      id: "tiny",
      adapterClass: "source-only-local",
      modelClass: "none",
      taskClass: "analyze",
      window: "2026-07",
      dispatchedCount: 3,
      substantiveCount: 0,
    },
  ],
};

const SCORECARD = {
  entries: [
    { id: "r1", failureBreakdown: { environment: 3, other: 1 } },
    { id: "r2", failureBreakdown: { environment: 4 } },
  ],
};

test("ledger hint fires for low-substantive combos at sufficient sample size only (#1300 M2-b)", () => {
  const { noData, hints } = buildDispatchRiskHints({ ledger: LEDGER, scorecard: { entries: [] }, taskClass: "analyze" });
  assert.equal(noData, false);
  const ledgerHints = hints.filter((h) => h.kind === "ledger");
  assert.equal(ledgerHints.length, 1);
  assert.match(ledgerHints[0].text, /hermes-analysis/);
  assert.match(ledgerHints[0].text, /substantive 4\/10/, "counts-only phrasing");
  assert.ok(!hints.some((h) => h.text.includes("source-only-local")), "sample 3 < 5 must not be judged");
  assert.ok(!hints.some((h) => h.text.includes("claude-analysis")), "healthy combo not warned");
});

test("taxonomy hint fires when a failure category crosses the cumulative threshold", () => {
  const { hints } = buildDispatchRiskHints({ ledger: { entries: [] }, scorecard: SCORECARD, taskClass: "analyze" });
  const taxonomy = hints.filter((h) => h.kind === "taxonomy");
  assert.equal(taxonomy.length, 1);
  assert.match(taxonomy[0].text, /failureClass environment cumulative 7/);
  assert.ok(!hints.some((h) => h.text.includes("other")), "cumulative 1 < 5 stays silent");
});

test("missing ledger AND scorecard produce explicit no_data, never silent success", () => {
  const result = buildDispatchRiskHints({ ledger: null, scorecard: null, taskClass: "analyze" });
  assert.deepEqual(result, { noData: true, hints: [] });
});

test("hint text passes the anonymity gate (no worker/node/url identifiers)", () => {
  const { hints } = buildDispatchRiskHints({ ledger: LEDGER, scorecard: SCORECARD, taskClass: "analyze" });
  for (const hint of hints) {
    assert.equal(forbiddenIdentifierViolation(hint.text), undefined, `identifier leaked: ${hint.text}`);
  }
});
