/**
 * Runtime detachment pin (#1504 §3: "Keep runtime integration/default
 * enablement off").
 *
 * The V1 storage adapter, the bounded FIFO worker lane, and their conformance
 * scaffolding must stay OUT of the broker runtime until an approved conforming
 * backend exists and primitive integration is explicitly wired. This test pins
 * the built runtime artifact: if a future change imports the adapter or the
 * lane into `server.ts`, this pin fails and forces the change to acknowledge —
 * and update — the detachment claim in tasks.md instead of drifting silently.
 *
 * The legacy opt-in worker-thread persistence flag
 * (BROKER_PERSISTENCE_QUEUE_WORKER_THREAD, default off) is the pre-existing
 * legacy-store mechanism and is not part of this claim.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SHARED_STATE_SQLITE_WORKER_LANE_V1 } from "./shared-state-sqlite-worker-lane-v1.js";

const here = dirname(fileURLToPath(import.meta.url));

test("the built broker runtime imports neither the V1 adapter nor the worker lane", () => {
  const serverJs = readFileSync(join(here, "server.js"), "utf8");
  assert.doesNotMatch(
    serverJs,
    /shared-state-sqlite-worker/,
    "server.ts must not import the V1 worker lane/entry/channel modules",
  );
  assert.doesNotMatch(
    serverJs,
    /shared-state-sqlite-adapter-v1/,
    "server.ts must not import the V1 SQLite adapter",
  );
  assert.doesNotMatch(
    serverJs,
    /SharedStateSqliteAdapterV1/,
    "the V1 adapter class must not appear in the runtime",
  );
});

test("the lane's own manifest keeps claiming it is not attached to the broker runtime", () => {
  assert.equal(SHARED_STATE_SQLITE_WORKER_LANE_V1.attachedToBrokerRuntime, false);
  assert.equal(SHARED_STATE_SQLITE_WORKER_LANE_V1.fullAdapterConformanceClaimed, false);
});
