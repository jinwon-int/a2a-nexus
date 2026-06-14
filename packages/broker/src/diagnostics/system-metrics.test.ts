import test from "node:test";
import assert from "node:assert/strict";

import {
  readCpuDiagnostics,
  readEventLoopDelayMs,
  readGcDiagnostics,
  readRuntimeMemoryUsage,
} from "./system-metrics.js";

// These are process-local runtime readers. The contract is stable shape and
// no throw in normal Node runtimes; concrete values depend on the host/process.

test("readRuntimeMemoryUsage returns stable numeric memory fields", () => {
  const memory = readRuntimeMemoryUsage();
  for (const key of [
    "rssBytes",
    "heapTotalBytes",
    "heapUsedBytes",
    "heapLimitBytes",
    "externalBytes",
    "arrayBuffersBytes",
  ]) {
    assert.equal(typeof memory[key], "number", key);
    assert.ok(Number.isFinite(memory[key]), key);
    assert.ok(memory[key] >= 0, key);
  }
});

test("readCpuDiagnostics returns stable numeric CPU delta fields", () => {
  const cpu = readCpuDiagnostics();
  const keys: Array<keyof typeof cpu> = [
    "userMicrosec",
    "systemMicrosec",
    "deltaUserMicrosec",
    "deltaSystemMicrosec",
    "deltaIntervalMs",
    "percentSinceLastCheck",
  ];
  for (const key of keys) {
    assert.equal(typeof cpu[key], "number", key);
    assert.ok(Number.isFinite(cpu[key]), key);
    assert.ok(cpu[key] >= 0, key);
  }
});

test("readEventLoopDelayMs returns a number or null without throwing", () => {
  const eventLoopDelayMs = readEventLoopDelayMs();
  assert.ok(eventLoopDelayMs === null || (Number.isFinite(eventLoopDelayMs) && eventLoopDelayMs >= 0));
});

test("readGcDiagnostics returns stable numeric GC fields", () => {
  const gc = readGcDiagnostics();
  const keys: Array<keyof typeof gc> = ["totalMs", "count", "lastMs", "recentMax60sMs"];
  for (const key of keys) {
    assert.equal(typeof gc[key], "number", key);
    assert.ok(Number.isFinite(gc[key]), key);
    assert.ok(gc[key] >= 0, key);
  }
});
