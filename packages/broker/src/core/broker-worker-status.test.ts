// #2065: the workerMode/mobile-worker retirement collapsed the heartbeat
// liveness ladder to its neutral names (HEARTBEAT_LIVENESS_*). These tests pin
// the module and public-broker export values (30s online window, 90s offline
// boundary) and the retired MOBILE_* aliases / effectiveOfflineAfterMs helper
// are asserted gone from both surfaces.
import assert from "node:assert/strict";
import test from "node:test";

import * as workerStatus from "./broker-worker-status.js";
import * as broker from "./broker.js";

test("neutral heartbeat-liveness constants pin the existing 30s/90s conversation ladder values", () => {
  assert.equal(workerStatus.HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS, 30_000);
  assert.equal(workerStatus.HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS, 90_000);
  // Public broker surface re-exports the same values.
  assert.equal(broker.HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS, 30_000);
  assert.equal(broker.HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS, 90_000);
});

test("retired workerMode-era exports are absent from the module and public broker surfaces", () => {
  // The legacy MOBILE_* aliases and the mode-aware offline-window helper must
  // be gone entirely — imports of them would fail to compile.
  for (const surface of [workerStatus, broker]) {
    assert.ok(
      !("MOBILE_OFFLINE_AFTER_MS" in surface),
      "MOBILE_OFFLINE_AFTER_MS must be retired (#2065)",
    );
    assert.ok(
      !("MOBILE_DISCONNECTED_AFTER_MS" in surface),
      "MOBILE_DISCONNECTED_AFTER_MS must be retired (#2065)",
    );
    assert.ok(
      !("effectiveOfflineAfterMs" in surface),
      "effectiveOfflineAfterMs must be retired (#2065)",
    );
  }
});
