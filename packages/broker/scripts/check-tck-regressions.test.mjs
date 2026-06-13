import test from "node:test";
import assert from "node:assert/strict";
import { findRegressions, stablyGreenCategories } from "./check-tck-regressions.mjs";

function history(measurements) {
  return { schemaVersion: 1, measurements };
}

test("findRegressions flags a drop in MUST pass count for the same suite size", () => {
  const h = history([
    { date: "2026-06-11", level: "must", transport: "jsonrpc", must: { pass: 18, total: 75 }, categories: {} },
    { date: "2026-06-18", level: "must", transport: "jsonrpc", must: { pass: 14, total: 75 }, categories: {} },
  ]);
  const { regressions } = findRegressions(h, { level: "must", transport: "jsonrpc" });
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].metric, "must.pass");
  assert.equal(regressions[0].from, 18);
  assert.equal(regressions[0].to, 14);
});

test("findRegressions does not flag an improvement", () => {
  const h = history([
    { date: "2026-06-11", level: "must", transport: "jsonrpc", must: { pass: 12, total: 75 }, categories: {} },
    { date: "2026-06-18", level: "must", transport: "jsonrpc", must: { pass: 18, total: 75 }, categories: {} },
  ]);
  const { regressions } = findRegressions(h, { level: "must", transport: "jsonrpc" });
  assert.equal(regressions.length, 0);
});

test("findRegressions treats a suite-size change as a note, not a regression", () => {
  const h = history([
    { date: "2026-06-11", level: "must", transport: "jsonrpc", must: { pass: 18, total: 75 }, categories: {} },
    { date: "2026-06-18", level: "must", transport: "jsonrpc", must: { pass: 16, total: 80 }, categories: {} },
  ]);
  const { regressions, notes } = findRegressions(h, { level: "must", transport: "jsonrpc" });
  assert.equal(regressions.length, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "suite-size-change");
});

test("findRegressions compares a fresh measurement against the latest committed one", () => {
  const h = history([
    { date: "2026-06-11", level: "must", transport: "jsonrpc", must: { pass: 18, total: 75 }, categories: {} },
  ]);
  const current = { date: "2026-06-18", level: "must", transport: "jsonrpc", must: { pass: 9, total: 75 }, categories: {} };
  const { regressions } = findRegressions(h, { level: "must", transport: "jsonrpc", current });
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].to, 9);
});

test("findRegressions ignores the current run's own already-appended entry (#682)", () => {
  // The workflow appends the current run to history before the check, so the
  // latest scoped entry is the current run itself. The regression vs the prior
  // baseline (18 -> 9) must still be detected, not masked by a self-comparison.
  const h = history([
    { date: "2026-06-11", level: "must", transport: "jsonrpc", must: { pass: 18, total: 75 }, categories: {} },
    { date: "2026-06-18", level: "must", transport: "jsonrpc", must: { pass: 9, total: 75 }, categories: {} },
  ]);
  const current = { date: "2026-06-18", level: "must", transport: "jsonrpc", must: { pass: 9, total: 75 }, categories: {} };
  const { regressions } = findRegressions(h, { level: "must", transport: "jsonrpc", current });
  assert.equal(regressions.length, 1, "must compare against the prior baseline, not itself");
  assert.equal(regressions[0].from, 18);
  assert.equal(regressions[0].to, 9);
});

test("stablyGreenCategories lists categories green across the window", () => {
  const h = history([
    { date: "2026-06-11", level: "must", transport: "jsonrpc", categories: { agent_card: { pass: 6, total: 6 }, jsonrpc: { pass: 12, total: 75 } } },
    { date: "2026-06-18", level: "must", transport: "jsonrpc", categories: { agent_card: { pass: 6, total: 6 }, jsonrpc: { pass: 18, total: 75 } } },
  ]);
  assert.deepEqual(stablyGreenCategories(h, 2, { level: "must", transport: "jsonrpc" }), ["agent_card"]);
});

test("stablyGreenCategories needs a full window before promoting", () => {
  const h = history([
    { date: "2026-06-11", level: "must", transport: "jsonrpc", categories: { agent_card: { pass: 6, total: 6 } } },
  ]);
  assert.deepEqual(stablyGreenCategories(h, 2, { level: "must", transport: "jsonrpc" }), []);
});
