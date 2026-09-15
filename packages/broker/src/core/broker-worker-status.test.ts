// #2065 retirement prerequisite: the pre-existing conversation/legacy-health
// heartbeat liveness ladder gets neutral names (HEARTBEAT_LIVENESS_*), while
// the legacy MOBILE_* constants remain deprecated exact-value aliases. These
// tests pin the module and public-broker export values, the alias parity, the
// frozen-clock legacy mobileHealth boundary matrix, the persistent/absent-mode
// omission rule, and the effectiveOfflineAfterMs precedence. No new timeout
// behavior is introduced: every expectation reproduces the historical ladder.
import assert from "node:assert/strict";
import test from "node:test";

import {
  computeWorkerMobileHealth,
  effectiveOfflineAfterMs,
  HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS,
  HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS,
  MOBILE_DISCONNECTED_AFTER_MS,
  MOBILE_OFFLINE_AFTER_MS,
} from "./broker-worker-status.js";
import {
  HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS as BROKER_HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS,
  HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS as BROKER_HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS,
  MOBILE_DISCONNECTED_AFTER_MS as BROKER_MOBILE_DISCONNECTED_AFTER_MS,
  MOBILE_OFFLINE_AFTER_MS as BROKER_MOBILE_OFFLINE_AFTER_MS,
} from "./broker.js";

const FROZEN_NOW_MS = 1_700_000_000_000;

function lastSeenAge(ageMs: number): string {
  return new Date(FROZEN_NOW_MS - ageMs).toISOString();
}

test("neutral heartbeat-liveness constants pin the existing 30s/90s conversation ladder values", () => {
  assert.equal(HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS, 30_000);
  assert.equal(HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS, 90_000);
});

test("deprecated MOBILE_* constants are exact-value aliases on the module and public broker surfaces", () => {
  // Module-level alias parity.
  assert.equal(MOBILE_OFFLINE_AFTER_MS, HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS);
  assert.equal(MOBILE_DISCONNECTED_AFTER_MS, HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS);
  // Public broker surface: neutral and legacy re-exports stay in lockstep.
  assert.equal(BROKER_HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS, 30_000);
  assert.equal(BROKER_HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS, 90_000);
  assert.equal(BROKER_MOBILE_OFFLINE_AFTER_MS, BROKER_HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS);
  assert.equal(BROKER_MOBILE_DISCONNECTED_AFTER_MS, BROKER_HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS);
});

test("frozen-clock legacy mobileHealth boundary matrix reproduces the historical ladder", () => {
  const matrix: Array<[number, "health_ok" | "stale" | "disconnected"]> = [
    [0, "health_ok"],
    [29_999, "health_ok"],
    [30_000, "health_ok"],
    [30_001, "stale"],
    [89_999, "stale"],
    [90_000, "stale"],
    [90_001, "disconnected"],
  ];
  for (const [ageMs, expected] of matrix) {
    assert.equal(
      computeWorkerMobileHealth("mobile", lastSeenAge(ageMs), FROZEN_NOW_MS),
      expected,
      `mobile heartbeat age ${ageMs}ms must classify as ${expected}`,
    );
  }
});

test("persistent and absent workerMode still omit mobileHealth; mobile missing/invalid heartbeats disconnect", () => {
  for (const ageMs of [0, 30_000, 30_001, 90_000, 90_001, 10_000_000]) {
    assert.equal(
      computeWorkerMobileHealth("persistent", lastSeenAge(ageMs), FROZEN_NOW_MS),
      undefined,
      `persistent age ${ageMs}ms must omit mobileHealth`,
    );
    assert.equal(
      computeWorkerMobileHealth(undefined, lastSeenAge(ageMs), FROZEN_NOW_MS),
      undefined,
      `absent-mode age ${ageMs}ms must omit mobileHealth`,
    );
  }
  // Legacy behavior preserved: a declared mobile worker without a parseable
  // heartbeat is "disconnected", never health_ok.
  assert.equal(computeWorkerMobileHealth("mobile", undefined, FROZEN_NOW_MS), "disconnected");
  assert.equal(computeWorkerMobileHealth("mobile", "not-a-timestamp", FROZEN_NOW_MS), "disconnected");
});

test("effectiveOfflineAfterMs keeps the legacy mobile 30s value against supplied common windows including 0 and 120000", () => {
  // Declared mobile workers keep the legacy ladder value regardless of the
  // supplied common window — including explicit zero and longer overrides.
  assert.equal(effectiveOfflineAfterMs("mobile", HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS), 30_000);
  assert.equal(effectiveOfflineAfterMs("mobile", 0), 30_000);
  assert.equal(effectiveOfflineAfterMs("mobile", 120_000), 30_000);
  // Persistent and absent modes resolve the supplied common window verbatim;
  // explicit zero stays zero (no falsy coalescing).
  assert.equal(effectiveOfflineAfterMs("persistent", 0), 0);
  assert.equal(effectiveOfflineAfterMs("persistent", 120_000), 120_000);
  assert.equal(effectiveOfflineAfterMs(undefined, 0), 0);
  assert.equal(effectiveOfflineAfterMs(undefined, 120_000), 120_000);
});
