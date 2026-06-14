import test from "node:test";
import assert from "node:assert/strict";

import { readCgroupCpuSnapshot, readCgroupPsiSnapshot } from "./cgroup-metrics.js";

// These read /sys/fs/cgroup and /proc/pressure, which may or may not exist in
// the test environment. The contract is "return a well-formed snapshot or null,
// never throw" — that's what the /schedz diagnostics rely on.

test("readCgroupCpuSnapshot returns a well-formed shape or nulls without throwing", () => {
  const snap = readCgroupCpuSnapshot();
  assert.equal(typeof snap, "object");
  assert.ok("stats" in snap && "limit" in snap && "delta" in snap);
  if (snap.stats !== null) {
    assert.equal(typeof snap.stats.usageUsec, "number");
    assert.equal(typeof snap.stats.nrThrottled, "number");
  }
});

test("readCgroupPsiSnapshot returns a pressure snapshot or null without throwing", () => {
  const psi = readCgroupPsiSnapshot();
  assert.ok(psi === null || (typeof psi === "object" && "cpu" in psi && "memory" in psi && "io" in psi));
});
