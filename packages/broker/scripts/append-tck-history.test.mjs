import test from "node:test";
import assert from "node:assert/strict";
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
