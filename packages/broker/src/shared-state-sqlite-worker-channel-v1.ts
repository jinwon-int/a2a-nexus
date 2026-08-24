/**
 * W1 `node:worker_threads` channel for the V1 SQLite lane.
 *
 * This is the only module in the lane that touches worker threads, so the lane
 * itself can be exercised against a substitute channel without spawning a
 * thread. It spawns a purpose-built entry — never the legacy
 * `core/sqlite-worker-thread-persistence.ts` proxy, its protocol, its database,
 * or its runtime flag — and it holds no SQLite handle of its own: the worker is
 * the single V1 authority for the file.
 *
 * The entry path is resolved the same way the repository already resolves its
 * one production worker: a sibling of the compiled module. `tsc -b` mirrors
 * `src/` into `dist/`, and the broker test manifest runs compiled output, so
 * the compiled entry sits next to this file at run time.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { SharedStateSqliteWorkerBootstrapV1 } from "./shared-state-sqlite-worker-entry-v1.js";
import type { SharedStateSqliteWorkerRequestV1 } from "./shared-state-sqlite-worker-protocol-v1.js";
import type {
  SharedStateSqliteWorkerChannelFactoryV1,
  SharedStateSqliteWorkerChannelV1,
} from "./shared-state-sqlite-worker-lane-v1.js";

const ENTRY_BASENAME = "shared-state-sqlite-worker-entry-v1";

export function resolveSharedStateSqliteWorkerEntryPathV1(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  const compiled = join(directory, `${ENTRY_BASENAME}.js`);
  if (existsSync(compiled)) return compiled;
  const source = join(directory, `${ENTRY_BASENAME}.ts`);
  if (existsSync(source)) return source;
  // Return the compiled path so the Worker constructor raises the real
  // resolution error instead of this module inventing one.
  return compiled;
}

/**
 * Builds the lane's channel factory. The worker is spawned eagerly so that a
 * spawn failure surfaces as a worker loss on the lane rather than as a rejected
 * promise with no ticket attached to it.
 */
export function createSharedStateSqliteWorkerThreadChannelV1(
  bootstrap: SharedStateSqliteWorkerBootstrapV1,
): SharedStateSqliteWorkerChannelFactoryV1 {
  return (handlers): SharedStateSqliteWorkerChannelV1 => {
    const worker = new Worker(resolveSharedStateSqliteWorkerEntryPathV1(), {
      workerData: {
        filePath: bootstrap.filePath,
        ownerToken: bootstrap.ownerToken,
        backwardSkewToleranceMs: bootstrap.backwardSkewToleranceMs,
      },
    });

    let terminating = false;

    worker.on("message", (message: unknown) => {
      handlers.onMessage(message);
    });
    worker.on("error", () => {
      handlers.onLoss("worker_error");
    });
    worker.on("exit", () => {
      // A clean close terminates the thread on purpose; that exit is not a
      // loss. Any other exit leaves dispatched work without a known result.
      if (!terminating) handlers.onLoss("worker_exit");
    });

    return Object.freeze({
      post(request: SharedStateSqliteWorkerRequestV1): void {
        worker.postMessage(request);
      },
      async terminate(): Promise<void> {
        if (terminating) return;
        terminating = true;
        await worker.terminate();
      },
    });
  };
}
