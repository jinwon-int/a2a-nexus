/**
 * Child-process helper for the #2129 drain-duration log test. Not a test
 * file itself: it wires a minimal fake runtime into
 * `startBrokerServerWithFactory` so the test can observe the real
 * `closeServer` timing/log-line logic in `server-lifecycle.ts` without
 * paying for a full broker + sqlite fence.
 *
 * Env knobs (read by the test, not by production code):
 *   TEST_CLOSE_WORKER_PERSISTENCE_DELAY_MS — how long the fake
 *     `closeWorkerPersistence()` takes to resolve, simulating the real
 *     drain work (worker-thread shutdown + fence release).
 *   TEST_CLOSE_WORKER_PERSISTENCE_FAIL — set to "1" to make the fake
 *     `closeWorkerPersistence()` reject instead of resolving (failure-path
 *     timing/wording coverage). Non-fatal: the lifecycle then exits 1.
 *
 * `A2A_SHUTDOWN_DRAIN_MS` and `A2A_STOP_GRACE_PERIOD_HINT_MS` are passed
 * through to `server-lifecycle.ts` unchanged via the spawned env.
 */
import { createServer } from "node:http";

import { startBrokerServerWithFactory } from "./server-lifecycle.js";

const closeDelayMs = Math.max(
  0,
  Number(process.env.TEST_CLOSE_WORKER_PERSISTENCE_DELAY_MS ?? "10") || 0,
);
const closeFails = process.env.TEST_CLOSE_WORKER_PERSISTENCE_FAIL === "1";

function createFakeRuntime() {
  // A real (if handler-less) http.Server, not a stub: a stub with no open
  // handles would let the event loop drain and the process exit before the
  // test ever gets to send SIGTERM. Listening on 127.0.0.1:0 keeps the loop
  // alive exactly like the real broker does, for free.
  const server = createServer((_req, res) => res.end());

  return {
    server,
    stopStaleReaper() {},
    stopPoller() {},
    closeWorkerPersistence: () =>
      new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (closeFails) {
            reject(new Error("simulated worker-persistence shutdown failure (TEST_CLOSE_WORKER_PERSISTENCE_FAIL)"));
            return;
          }
          resolve();
        }, closeDelayMs);
      }),
    beginDrain() {
      // #1405 drain entry point: the real runtime refuses new poll/claim work
      // here. The fake runtime has nothing to refuse; its mere presence is
      // what lets server-lifecycle.ts take the A2A_SHUTDOWN_DRAIN_MS
      // pre-close drain path that the #2129 timing regression covers.
    },
    config: {
      host: "127.0.0.1",
      port: 0,
      serviceName: "a2a-broker-drain-log-test",
      publicBaseUrl: "https://broker.test/",
      staleReaperEnabled: false,
      staleReaperIntervalSec: 0,
      staleReaperOlderThanSec: 0,
      maxRequeueAttempts: 0,
    },
  };
}

startBrokerServerWithFactory(createFakeRuntime);
// SIGTERM/SIGINT handlers are registered synchronously above, so it is safe
// for the test to signal as soon as it reads this line.
process.stdout.write("ready\n");
