import test from "node:test";
import assert from "node:assert/strict";

import { buildInjectedKnowledgeSnapshot, hintViolation } from "./build-injected-knowledge.mjs";

const LEDGER = {
  entries: [
    {
      id: "orig",
      adapterClass: "hermes-analysis",
      modelClass: "mixed",
      taskClass: "review",
      window: "2026-07",
      dispatchedCount: 10,
      substantiveCount: 3,
      evidenceClassBreakdown: { substantive: 3, provider_or_model_failure: 4, failed: 1 },
    },
    {
      id: "corrected",
      supersedes: "orig",
      adapterClass: "hermes-analysis",
      modelClass: "mixed",
      taskClass: "review",
      window: "2026-07",
      dispatchedCount: 10,
      substantiveCount: 7,
      evidenceClassBreakdown: { substantive: 7, failed: 1 },
    },
  ],
};

const SCORECARD = {
  entries: [
    { id: "r1", failureBreakdown: { environment: 2 } },
    { id: "r2", failureBreakdown: { environment: 1, other: 1 } },
    { id: "r3", failureBreakdown: { environment: 3 } },
  ],
};

test("build is deterministic, supersede-aware, and counts-only", () => {
  const a = buildInjectedKnowledgeSnapshot({ ledger: LEDGER, scorecard: SCORECARD, asOf: "2026-07-07" });
  const b = buildInjectedKnowledgeSnapshot({ ledger: LEDGER, scorecard: SCORECARD, asOf: "2026-07-07" });
  assert.deepEqual(a, b, "same inputs + asOf must produce identical snapshots");
  assert.equal(a.violations.length, 0);
  assert.equal(a.snapshot.asOf, "2026-07-07");

  const ledgerHints = a.snapshot.hints.filter((h) => h.taskClass === "review");
  assert.equal(ledgerHints.length, 1, "superseded original must not produce a second hint");
  assert.match(ledgerHints[0].text, /substantive 7\/10/, "corrected counts win");
});

test("a failure category recurring across the recent scorecard rounds becomes a hint", () => {
  const { snapshot } = buildInjectedKnowledgeSnapshot({ ledger: { entries: [] }, scorecard: SCORECARD, asOf: "2026-07-07" });
  const streak = snapshot.hints.filter((h) => h.taskClass === undefined);
  assert.equal(streak.length, 1);
  assert.match(streak[0].text, /failureClass environment recurred/);
});

test("a hint carrying a worker/node identifier or URL fails the build gate (fail-closed)", () => {
  const dirty = {
    entries: [{
      id: "dirty",
      adapterClass: "hermes-analysis",
      modelClass: "mixed",
      taskClass: "worker-" + "alpha", // worker-shaped identifier in an axis
      window: "2026-07",
      dispatchedCount: 5,
      substantiveCount: 1,
    }],
  };
  const { violations } = buildInjectedKnowledgeSnapshot({ ledger: dirty, scorecard: { entries: [] }, asOf: "2026-07-07" });
  assert.ok(violations.length > 0, "worker-shaped identifier must be rejected");

  assert.ok(hintViolation("see https://example.com/x"), "urls rejected");
  assert.ok(hintViolation("token ghp_" + "a".repeat(24)), "secret shapes rejected");
  assert.ok(hintViolation("stored under /home/x/file"), "private paths rejected");
  assert.equal(hintViolation("adapterClass=hermes-analysis: substantive 4/10"), undefined, "clean counts-only text passes");
});
