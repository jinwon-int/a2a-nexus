import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  findRegressions,
  stablyGreenCategories,
  stablyGreenSubCategories,
} from "./check-tck-regressions.mjs";

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

test("findRegressions skips the appended current measurement before selecting a baseline (#682)", () => {
  const current = { date: "2026-06-18", level: "must", transport: "jsonrpc", must: { pass: 9, total: 75 }, categories: {} };
  const h = history([
    { date: "2026-06-11", level: "must", transport: "jsonrpc", must: { pass: 12, total: 75 }, categories: {} },
    current,
  ]);
  const { regressions, notes } = findRegressions(h, { level: "must", transport: "jsonrpc", current });
  assert.equal(regressions.length, 1, "must compare against the prior baseline, not itself");
  assert.equal(regressions[0].from, 12);
  assert.equal(regressions[0].to, 9);
  assert.equal(notes.some((note) => note.kind === "baseline-skipped-current" && note.count === 1), true);
});

test("findRegressions compares independent same-day runs by source identity", () => {
  const h = history([
    {
      date: "2026-07-22",
      level: "must",
      transport: "jsonrpc",
      overallPercent: 65.7,
      categories: {},
      source: "tck-measurement workflow run 100",
    },
  ]);
  const current = {
    date: "2026-07-22",
    level: "must",
    transport: "jsonrpc",
    overallPercent: 60,
    categories: {},
    source: "tck-measurement workflow run 101",
  };
  const { regressions, notes } = findRegressions(h, { level: "must", transport: "jsonrpc", current });
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].from, 65.7);
  assert.equal(regressions[0].to, 60);
  assert.equal(notes.some((note) => note.kind === "baseline-skipped-current"), false);
});

test("CLI emits regression JSON to stdout even when exiting non-zero", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tck-regression-"));
  try {
    const historyPath = path.join(dir, "history.json");
    const logPath = path.join(dir, "tck.log");
    fs.writeFileSync(historyPath, JSON.stringify(history([
      { date: "2026-06-11", level: "must", transport: "jsonrpc", must: { pass: 12, total: 75 }, categories: {} },
      { date: "2026-06-18", level: "must", transport: "jsonrpc", must: { pass: 9, total: 75 }, categories: {} },
    ]), null, 2));
    fs.writeFileSync(logPath, "A2A TCK run\nOVERALL COMPATIBILITY: 42.0%\nMUST: 9/75\njsonrpc: 9/75\n");

    const scriptPath = fileURLToPath(new URL("./check-tck-regressions.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [
      scriptPath,
      "--history", historyPath,
      "--against-log", logPath,
      "--date", "2026-06-18",
      "--level", "must",
      "--transport", "jsonrpc",
    ], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.regressions.length, 1);
    assert.equal(report.regressions[0].from, 12);
    assert.equal(report.regressions[0].to, 9);
    assert.equal(report.notes.some((note) => note.kind === "baseline-skipped-current"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("stablyGreenSubCategories promotes only two-window green selector groups", () => {
  const h = history([
    {
      date: "2026-07-22",
      level: "must",
      transport: "jsonrpc",
      source: "tck-measurement workflow run 100",
      subCategories: {
        "jsonrpc-version-negotiation": { pass: 4, total: 4 },
        "jsonrpc-error-codes-and-errorinfo": { pass: 6, total: 13 },
      },
    },
    {
      date: "2026-07-22",
      level: "must",
      transport: "jsonrpc",
      source: "tck-measurement workflow run 101",
      subCategories: {
        "jsonrpc-version-negotiation": { pass: 4, total: 4 },
        "jsonrpc-error-codes-and-errorinfo": { pass: 7, total: 13 },
      },
    },
  ]);
  assert.deepEqual(
    stablyGreenSubCategories(h, 2, { level: "must", transport: "jsonrpc" }),
    ["jsonrpc-version-negotiation"],
  );
});
