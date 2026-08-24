/**
 * W2 worker-side request runtime for the V1 SQLite lane.
 *
 * This is the request-handling half of `shared-state-sqlite-worker-entry-v1.ts`,
 * extracted verbatim so that a second, test-only worker build can reuse exactly
 * the same handling instead of maintaining a divergent copy of it. The
 * extraction changes no behaviour: the production entry now owns only the
 * bootstrap and the port wiring, and this module owns the closed-request
 * dispatch it previously performed inline.
 *
 * It deliberately contains no test hook of any kind. A conformance build injects
 * faults by wrapping the `DatabaseSync` it passes in, and learns that a fault
 * fired by inspecting its own fault state after `handle` returns — so nothing
 * here has to know that conformance exists.
 *
 * Trusted time is observed here, next to the adapter that consumes it, at the
 * moment the command executes. The wire protocol carries no caller clock field.
 */
import { DatabaseSync } from "node:sqlite";

import { SharedStateSqliteAdapterV1 } from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1,
  buildSharedStateSqliteWorkerErrorResponseV1,
  buildSharedStateSqliteWorkerValueResponseV1,
  parseSharedStateSqliteWorkerRequestV1,
  type SharedStateSqliteWorkerCommandV1,
  type SharedStateSqliteWorkerResponseV1,
} from "./shared-state-sqlite-worker-protocol-v1.js";

export interface SharedStateSqliteWorkerBootstrapV1 {
  readonly filePath: string;
  readonly ownerToken: string;
  readonly backwardSkewToleranceMs: string;
}

export function readSharedStateSqliteWorkerBootstrapV1(
  input: unknown,
): SharedStateSqliteWorkerBootstrapV1 {
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
 * Opens the file, applies the V1 schema, and constructs the adapter the calling
 * thread will own. This lives here rather than in the entry because the entry
 * throws at import time when it is not running as a worker; a conformance build
 * must be able to reuse this without triggering that guard.
 */
export function openSharedStateSqliteWorkerDatabaseV1(
  bootstrap: SharedStateSqliteWorkerBootstrapV1,
): {
  readonly db: DatabaseSync;
  readonly adapter: SharedStateSqliteAdapterV1;
} {
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
  return { db, adapter };
}

export interface SharedStateSqliteWorkerRuntimeV1 {
  /**
   * Handles one inbound message. Returns the response to post, or `null` when
   * the message is unparseable and carries no usable correlation — in that case
   * there is no ticket to answer and the lane's acknowledgment timeout is the
   * only honest outcome.
   */
  handle(raw: unknown): SharedStateSqliteWorkerResponseV1 | null;
  /** True once the adapter has released ownership through a clean close. */
  released(): boolean;
}

/**
 * Extracts just enough of an unparseable message to answer the ticket that sent
 * it. Without this the lane would have to wait for its acknowledgment timeout
 * and then treat a merely malformed request as ambiguous, which is a strictly
 * worse report than a known closed failure.
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

/**
 * The thread-owned time source.
 *
 * Decision W0 forbids a caller clock field, so the observed instant is never
 * carried on the lane protocol and never supplied by the main thread. It is
 * still injected here rather than read inline, because the observation belongs
 * to whoever owns the adapter and that owner differs between builds: the
 * production entry owns the real clock, and a conformance build owns a
 * deterministic one it drives itself. Both remain worker-owned, which is what
 * the decision actually requires.
 */
export interface SharedStateSqliteWorkerClockV1 {
  /** The observed instant as a decimal string, read at execution time. */
  observeUnixMs(): string;
}

export const SHARED_STATE_SQLITE_WORKER_SYSTEM_CLOCK_V1: SharedStateSqliteWorkerClockV1 =
  Object.freeze({
    observeUnixMs(): string {
      return Date.now().toString();
    },
  });

export function createSharedStateSqliteWorkerRuntimeV1(input: {
  readonly db: DatabaseSync;
  readonly adapter: SharedStateSqliteAdapterV1;
  readonly clock: SharedStateSqliteWorkerClockV1;
}): SharedStateSqliteWorkerRuntimeV1 {
  const { db, adapter, clock } = input;

  /**
   * Set once the adapter has released ownership. The thread deliberately stays
   * alive afterwards: the proxy terminates it only after this clean close, and a
   * forced termination before it is not a clean close.
   */
  let released = false;

  return Object.freeze({
    released(): boolean {
      return released;
    },

    handle(raw: unknown): SharedStateSqliteWorkerResponseV1 | null {
      const parsed = parseSharedStateSqliteWorkerRequestV1(raw);

      if (!parsed.ok) {
        const correlation = readCorrelation(raw);
        if (!correlation) return null;
        return buildSharedStateSqliteWorkerErrorResponseV1(
          correlation.ticket,
          correlation.command,
          "adapter_unavailable",
        );
      }

      const request = parsed.value;

      if (released) {
        return buildSharedStateSqliteWorkerErrorResponseV1(
          request.ticket,
          request.command,
          "not_open",
        );
      }

      try {
        switch (request.command) {
          case "open": {
            const opened = adapter.open();
            return opened.ok
              ? buildSharedStateSqliteWorkerValueResponseV1(
                  request.ticket,
                  "open",
                  opened.value,
                )
              : buildSharedStateSqliteWorkerErrorResponseV1(
                  request.ticket,
                  "open",
                  opened.error.code,
                );
          }
          case "transact": {
            // Observed here, by the thread that owns the adapter, immediately
            // before execution. Never supplied by the caller.
            const observedAtUnixMs = clock.observeUnixMs();
            const result = adapter.transact(request.transactionCommand, {
              observedAtUnixMs,
            });
            // `transact` returns only after SQLite COMMIT (or a known
            // rollback), so this response is the durable acknowledgment.
            return result.ok
              ? buildSharedStateSqliteWorkerValueResponseV1(
                  request.ticket,
                  "transact",
                  result.value,
                )
              : buildSharedStateSqliteWorkerErrorResponseV1(
                  request.ticket,
                  "transact",
                  result.error.code,
                );
          }
          case "query": {
            const result = adapter.query(request.queryRequest);
            return result.ok
              ? buildSharedStateSqliteWorkerValueResponseV1(
                  request.ticket,
                  "query",
                  result.value,
                )
              : buildSharedStateSqliteWorkerErrorResponseV1(
                  request.ticket,
                  "query",
                  result.error.code,
                );
          }
          case "drain": {
            const drained = adapter.drain();
            return drained.ok
              ? buildSharedStateSqliteWorkerValueResponseV1(
                  request.ticket,
                  "drain",
                  drained.value,
                )
              : buildSharedStateSqliteWorkerErrorResponseV1(
                  request.ticket,
                  "drain",
                  drained.error.code,
                );
          }
          case "close": {
            const closed = adapter.close();
            if (!closed.ok) {
              return buildSharedStateSqliteWorkerErrorResponseV1(
                request.ticket,
                "close",
                closed.error.code,
              );
            }
            released = true;
            db.close();
            return buildSharedStateSqliteWorkerValueResponseV1(
              request.ticket,
              "close",
              closed.value,
            );
          }
        }
      } catch {
        // A throw from the adapter leaves this ticket without a known adapter
        // result. Reporting a closed failure is still better than silence: the
        // lane fails the ticket closed instead of waiting for its timeout.
        return buildSharedStateSqliteWorkerErrorResponseV1(
          request.ticket,
          request.command,
          "store_failure",
        );
      }
    },
  });
}
