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
 * Trusted time is observed **here**, next to the adapter that consumes it, at
 * the moment the command executes. The wire protocol carries no caller clock
 * field, so a main-thread caller cannot influence the observation.
 *
 * Every message is re-parsed defensively even though the proxy already parsed
 * it. Only a request that clears the closed parser reaches the adapter.
 */
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import { SharedStateSqliteAdapterV1 } from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1,
  buildSharedStateSqliteWorkerErrorResponseV1,
  buildSharedStateSqliteWorkerValueResponseV1,
  parseSharedStateSqliteWorkerRequestV1,
  type SharedStateSqliteWorkerCommandV1,
} from "./shared-state-sqlite-worker-protocol-v1.js";

export interface SharedStateSqliteWorkerBootstrapV1 {
  readonly filePath: string;
  readonly ownerToken: string;
  readonly backwardSkewToleranceMs: string;
}

function readBootstrap(input: unknown): SharedStateSqliteWorkerBootstrapV1 {
  if (typeof input !== "object" || input === null) {
    throw new Error("shared-state sqlite worker bootstrap is missing");
  }
  const candidate = input as Record<string, unknown>;
  const { filePath, ownerToken, backwardSkewToleranceMs } = candidate;
  if (
    typeof filePath !== "string"
    || typeof ownerToken !== "string"
    || typeof backwardSkewToleranceMs !== "string"
  ) {
    throw new Error("shared-state sqlite worker bootstrap is malformed");
  }
  return { filePath, ownerToken, backwardSkewToleranceMs };
}

/**
 * Extracts just enough of an unparseable message to answer the ticket that sent
 * it. Without this the proxy would have to wait for its acknowledgment timeout
 * and then treat a merely malformed request as ambiguous, which would be a
 * strictly worse report than a known closed failure.
 */
function readCorrelation(
  input: unknown,
): { ticket: string; command: SharedStateSqliteWorkerCommandV1 } | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = input as Record<string, unknown>;
  const ticket = candidate["ticket"];
  const command = candidate["command"];
  if (typeof ticket !== "string" || typeof command !== "string") return null;
  const commands: readonly string[] =
    SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.commands;
  if (!commands.includes(command)) return null;
  return { ticket, command: command as SharedStateSqliteWorkerCommandV1 };
}

if (!parentPort) {
  throw new Error(
    "shared-state-sqlite-worker-entry-v1 must run as a worker thread",
  );
}

const port = parentPort;
const bootstrap = readBootstrap(workerData);

const db = new DatabaseSync(bootstrap.filePath, { timeout: 0 });
const applied = applySharedStateSqliteSchemaV1(db);
if (!applied.ok) {
  db.close();
  throw new Error(
    `shared-state sqlite worker schema failed: ${applied.error.code}`,
  );
}

const adapter = new SharedStateSqliteAdapterV1({
  db,
  ownerToken: bootstrap.ownerToken,
  backwardSkewToleranceMs: bootstrap.backwardSkewToleranceMs,
});

/**
 * Set once the adapter has released ownership. The thread deliberately stays
 * alive afterwards: the proxy terminates it only after this clean close, and a
 * forced termination before it is not a clean close.
 */
let released = false;

port.on("message", (raw: unknown) => {
  const parsed = parseSharedStateSqliteWorkerRequestV1(raw);

  if (!parsed.ok) {
    const correlation = readCorrelation(raw);
    if (correlation) {
      port.postMessage(
        buildSharedStateSqliteWorkerErrorResponseV1(
          correlation.ticket,
          correlation.command,
          "adapter_unavailable",
        ),
      );
    }
    return;
  }

  const request = parsed.value;

  if (released) {
    port.postMessage(
      buildSharedStateSqliteWorkerErrorResponseV1(
        request.ticket,
        request.command,
        "not_open",
      ),
    );
    return;
  }

  try {
    switch (request.command) {
      case "open": {
        const opened = adapter.open();
        port.postMessage(
          opened.ok
            ? buildSharedStateSqliteWorkerValueResponseV1(
                request.ticket,
                "open",
                opened.value,
              )
            : buildSharedStateSqliteWorkerErrorResponseV1(
                request.ticket,
                "open",
                opened.error.code,
              ),
        );
        return;
      }
      case "transact": {
        // Observed here, by the thread that owns the adapter, immediately
        // before execution. Never supplied by the caller.
        const observedAtUnixMs = Date.now().toString();
        const result = adapter.transact(request.transactionCommand, {
          observedAtUnixMs,
        });
        // `transact` returns only after SQLite COMMIT (or a known rollback), so
        // posting here is the durable acknowledgment for this ticket.
        port.postMessage(
          result.ok
            ? buildSharedStateSqliteWorkerValueResponseV1(
                request.ticket,
                "transact",
                result.value,
              )
            : buildSharedStateSqliteWorkerErrorResponseV1(
                request.ticket,
                "transact",
                result.error.code,
              ),
        );
        return;
      }
      case "query": {
        const result = adapter.query(request.queryRequest);
        port.postMessage(
          result.ok
            ? buildSharedStateSqliteWorkerValueResponseV1(
                request.ticket,
                "query",
                result.value,
              )
            : buildSharedStateSqliteWorkerErrorResponseV1(
                request.ticket,
                "query",
                result.error.code,
              ),
        );
        return;
      }
      case "drain": {
        const drained = adapter.drain();
        port.postMessage(
          drained.ok
            ? buildSharedStateSqliteWorkerValueResponseV1(
                request.ticket,
                "drain",
                drained.value,
              )
            : buildSharedStateSqliteWorkerErrorResponseV1(
                request.ticket,
                "drain",
                drained.error.code,
              ),
        );
        return;
      }
      case "close": {
        const closed = adapter.close();
        if (!closed.ok) {
          port.postMessage(
            buildSharedStateSqliteWorkerErrorResponseV1(
              request.ticket,
              "close",
              closed.error.code,
            ),
          );
          return;
        }
        released = true;
        db.close();
        port.postMessage(
          buildSharedStateSqliteWorkerValueResponseV1(
            request.ticket,
            "close",
            closed.value,
          ),
        );
        return;
      }
    }
  } catch {
    // A throw from the adapter leaves this ticket without a known adapter
    // result. Reporting a closed failure is still better than silence: the
    // proxy fails the ticket closed instead of waiting for its timeout.
    port.postMessage(
      buildSharedStateSqliteWorkerErrorResponseV1(
        request.ticket,
        request.command,
        "store_failure",
      ),
    );
  }
});
