/**
 * TEST-ONLY conformance worker entry for worker-mode V1 SQLite targets.
 *
 * It is a sibling of the production entry, not a replacement for it. Both build
 * the adapter through `openSharedStateSqliteWorkerDatabaseV1` and both serve the
 * closed lane protocol through `createSharedStateSqliteWorkerRuntimeV1`, so the
 * request handling a conformance run exercises is the same code the production
 * entry runs. The differences are exactly two, and both are additive:
 *
 *   1. The adapter is constructed over a fault-seam handle, so a harness can
 *      fire a fault at a SQLite statement boundary inside the adapter's
 *      transaction. The raw connection is kept separately for observation, so
 *      out-of-band probes are never subject to injected faults.
 *   2. It answers the conformance control family, which the production entry
 *      silently ignores because those messages carry no ticket to correlate.
 *
 * The production entry gains nothing from this file's existence and does not
 * import it. Keeping the test affordances in a separate build is what lets the
 * shipped worker stay free of them.
 */
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

import { buildSharedStateExpiryConformanceSnapshotV1 } from "./shared-state-sqlite-expiry-snapshot-v1.js";
import { SHARED_STATE_STORAGE_V1_VALUES as V } from "./shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_SQLITE_EXPIRY_VIOLATIONS_V1,
  buildSharedStateSqliteConformanceReplyV1,
  parseSharedStateSqliteConformanceRequestV1,
  sharedStateSqliteConformanceFaultPlanV1Schema,
  type SharedStateSqliteConformanceControlNameV1,
} from "./shared-state-sqlite-conformance-control-v1.js";
import {
  createSharedStateSqliteConformanceFaultHandleV1,
  createSharedStateSqliteConformanceFaultStateV1,
} from "./shared-state-sqlite-conformance-fault-v1.js";
import { SharedStateSqliteAdapterV1 } from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  createSharedStateSqliteWorkerRuntimeV1,
  readSharedStateSqliteWorkerBootstrapV1,
} from "./shared-state-sqlite-worker-runtime-v1.js";
import { DatabaseSync } from "node:sqlite";

if (!parentPort) {
  throw new Error(
    "shared-state-sqlite-conformance-worker-entry-v1 must run as a worker thread",
  );
}

const port = parentPort;
const bootstrap = readSharedStateSqliteWorkerBootstrapV1(workerData);

// Opened here rather than through `openSharedStateSqliteWorkerDatabaseV1`
// because the adapter must be built over the fault handle while observation
// keeps the raw connection. The open sequence is otherwise identical.
const db = new DatabaseSync(bootstrap.filePath, { timeout: 0 });
const applied = applySharedStateSqliteSchemaV1(db);
if (!applied.ok) {
  db.close();
  throw new Error(
    `shared-state sqlite conformance worker schema failed: ${applied.error.code}`,
  );
}

const faultState = createSharedStateSqliteConformanceFaultStateV1();
const faultHandle = createSharedStateSqliteConformanceFaultHandleV1(
  db,
  faultState,
);

/**
 * This worker's own clock. It is still worker-owned and still read at execution
 * time; it is simply deterministic, because the harnesses probe expiry and
 * lease boundaries exactly and a real clock cannot express `expiry - 1`,
 * `expiry`, and `expiry + 1`.
 *
 * It is a queue, not a slot, and that is load-bearing. A harness may submit
 * many commands concurrently — Phase 2.2 submits sixty-four contenders at once.
 * Each target publishes its instant immediately before admitting its command to
 * the lane, in the same synchronous step, so publication order and lane
 * admission order are the same order. Consuming one instant per command
 * therefore pairs each command with the instant its caller intended. A single
 * slot would let a later caller overwrite an earlier caller's instant before
 * the worker ever executed the earlier command.
 *
 * An empty queue fails the command closed rather than reusing a stale instant.
 * Reusing one would silently answer with the wrong observation, and a
 * conformance suite cannot detect that.
 */
const observedInstants: string[] = [];

const runtime = createSharedStateSqliteWorkerRuntimeV1({
  db: faultHandle,
  adapter: new SharedStateSqliteAdapterV1({
    db: faultHandle,
    ownerToken: bootstrap.ownerToken,
    backwardSkewToleranceMs: bootstrap.backwardSkewToleranceMs,
  }),
  clock: {
    observeUnixMs(): string {
      const next = observedInstants.shift();
      if (next === undefined) {
        throw new Error(
          "conformance worker has no published instant for this command",
        );
      }
      return next;
    },
  },
});

const observedInstantInputSchema = z
  .object({
    observedAtUnixMs: z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/u),
  })
  .strict();

const expiryViolationInputSchema = z
  .object({ violation: z.enum(SHARED_STATE_SQLITE_EXPIRY_VIOLATIONS_V1) })
  .strict();

const expirySnapshotInputSchema = z
  .object({
    observedAtUnixMs: z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/u),
    physicalCleanupState: z.enum([
      "none",
      "early-eviction-refused",
      "deferred",
    ]),
    capacityPressureBand: z.enum(V.pressureBands),
  })
  .strict();

const expirySafetyReplayInputSchema = z
  .object({
    operation: z.string().min(1),
    namespace: z.string().min(1),
    keyDigest: z.string().min(1),
    nonceDigest: z.string().min(1).nullable(),
  })
  .strict();

/**
 * Reads the state capacity shedding and the inclusive-boundary probe both need.
 * Observation uses the raw connection, never the fault handle: a probe must not
 * be subject to an injected fault.
 */
function readExpirySafetyReplayState(
  input: z.infer<typeof expirySafetyReplayInputSchema>,
): { present: boolean; expiresAtUnixMs: string | null } {
  if (input.operation === "consumeReplayNonce") {
    if (input.nonceDigest === null) return { present: false, expiresAtUnixMs: null };
    const row = db
      .prepare(
        `SELECT expires_at_unix_ms FROM shared_state_replay_nonce
         WHERE namespace = ? AND key_digest = ? AND nonce_digest = ?`,
      )
      .get(input.namespace, input.keyDigest, input.nonceDigest) as
      | { expires_at_unix_ms?: unknown }
      | undefined;
    if (row === undefined || typeof row.expires_at_unix_ms !== "string") {
      return { present: false, expiresAtUnixMs: null };
    }
    return { present: true, expiresAtUnixMs: row.expires_at_unix_ms };
  }
  if (input.operation === "executeIdempotent") {
    const row = db
      .prepare(
        `SELECT 1 AS present FROM shared_state_idempotency
         WHERE namespace = ? AND key_digest = ?`,
      )
      .get(input.namespace, input.keyDigest) as { present?: unknown } | undefined;
    return { present: row !== undefined, expiresAtUnixMs: null };
  }
  return { present: false, expiresAtUnixMs: null };
}

function applyControl(
  control: SharedStateSqliteConformanceControlNameV1,
  input: unknown,
): unknown {
  switch (control) {
    case "armFault": {
      const plan = sharedStateSqliteConformanceFaultPlanV1Schema.parse(input);
      faultState.armed = plan;
      faultState.fired = false;
      return null;
    }
    case "disarmFault": {
      faultState.armed = null;
      faultState.fired = false;
      faultState.firedAt = [];
      return null;
    }
    case "readFaultState": {
      return {
        armedPoint: faultState.armed?.point ?? null,
        fired: faultState.fired,
        firedAt: [...faultState.firedAt],
      };
    }
    case "setObservedInstant": {
      observedInstants.push(
        observedInstantInputSchema.parse(input).observedAtUnixMs,
      );
      return null;
    }
    case "expiryViolation": {
      const { violation } = expiryViolationInputSchema.parse(input);
      if (violation === "early-eviction-deletes") {
        db.exec("DELETE FROM shared_state_replay_nonce");
        return null;
      }
      if (violation === "pressure-evicts-unexpired") {
        db.exec("DELETE FROM shared_state_replay_nonce");
        db.exec("DELETE FROM shared_state_idempotency");
        return null;
      }
      db.exec("DELETE FROM shared_state_outbox");
      return null;
    }
    case "expirySnapshot": {
      const parsed = expirySnapshotInputSchema.parse(input);
      return buildSharedStateExpiryConformanceSnapshotV1(db, parsed);
    }
    case "idempotencyEffectCounts": {
      const total = (table: string): number => {
        const row = db
          .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
          .get() as { total?: unknown };
        return Number(row.total);
      };
      return {
        outcomeCount: total("shared_state_idempotency"),
        linkCount: total("shared_state_idempotency_outbox_link"),
      };
    }
    case "expirySafetyReplayState": {
      return readExpirySafetyReplayState(
        expirySafetyReplayInputSchema.parse(input),
      );
    }
  }
}

port.on("message", (raw: unknown) => {
  const request = parseSharedStateSqliteConformanceRequestV1(raw);

  if (request) {
    try {
      port.postMessage(
        buildSharedStateSqliteConformanceReplyV1(
          request.sequence,
          request.control,
          { ok: true, value: applyControl(request.control, request.input) },
        ),
      );
    } catch (error: unknown) {
      port.postMessage(
        buildSharedStateSqliteConformanceReplyV1(
          request.sequence,
          request.control,
          {
            ok: false,
            failure: error instanceof Error ? error.message : String(error),
          },
        ),
      );
    }
    return;
  }

  const response = runtime.handle(raw);
  if (response !== null) port.postMessage(response);
});
