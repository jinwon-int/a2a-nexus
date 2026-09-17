// #2065 retirement prerequisite: the pre-existing conversation/legacy-health
// heartbeat liveness ladder gets neutral names (HEARTBEAT_LIVENESS_*), while
// the legacy MOBILE_* constants remain deprecated exact-value aliases. These
// tests pin the module and public-broker export values, the alias parity, and
// the effectiveOfflineAfterMs precedence. The retired mobileHealth projection
// ladder has no tests here because the helper no longer exists (#2065).
import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("effectiveOfflineAfterMs keeps the legacy mobile 30s value against supplied common windows including 0 and 120000", () => {
  // Declared mobile workers keep the legacy ladder value regardless of the
  // supplied common window — including explicit zero and longer overrides.
  // (Task-admission still consumes this helper; projections do not — #2065.)
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
