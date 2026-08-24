/**
 * W1 worker-thread entry for the V1 SQLite lane.
 *
 * This thread is the single authority for its V1 database in worker mode: it
 * owns the `DatabaseSync` connection, the `SharedStateSqliteAdapterV1`
 * instance, the lifecycle epoch, and the ownership token. The main thread never
 * opens a second V1 adapter on this file and never bypasses this thread for a
 * query.
 *
 * It is not, and does not import, the legacy
 * `core/sqlite-worker-thread-persistence.ts` proxy. It does not touch the
 * legacy `SqliteBrokerStateStore` file, schema, protocol, or runtime flag, and
 * it holds no main-thread read connection.
 *
 * W2 moved the bootstrap helpers and the closed-request dispatch into
 * `shared-state-sqlite-worker-runtime-v1.ts` without changing them, so a
 * test-only conformance build can reuse the same handling rather than keeping a
 * divergent copy. They live there rather than here because this file throws at
 * import time when it is not running as a worker. This file now owns only the
 * guard and the port wiring.
 */
import { parentPort, workerData } from "node:worker_threads";

import {
  SHARED_STATE_SQLITE_WORKER_SYSTEM_CLOCK_V1,
  createSharedStateSqliteWorkerRuntimeV1,
  openSharedStateSqliteWorkerDatabaseV1,
  readSharedStateSqliteWorkerBootstrapV1,
} from "./shared-state-sqlite-worker-runtime-v1.js";

if (!parentPort) {
  throw new Error(
    "shared-state-sqlite-worker-entry-v1 must run as a worker thread",
  );
}

const port = parentPort;
const runtime = createSharedStateSqliteWorkerRuntimeV1({
  ...openSharedStateSqliteWorkerDatabaseV1(
    readSharedStateSqliteWorkerBootstrapV1(workerData),
  ),
  // The real clock. A conformance build supplies a deterministic one instead;
  // neither is ever supplied by the main thread over the lane protocol.
  clock: SHARED_STATE_SQLITE_WORKER_SYSTEM_CLOCK_V1,
});

port.on("message", (raw: unknown) => {
  const response = runtime.handle(raw);
  if (response !== null) port.postMessage(response);
});
