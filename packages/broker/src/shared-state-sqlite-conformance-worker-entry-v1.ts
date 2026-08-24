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
  SHARED_STATE_SQLITE_READ_PATH_CORRUPTIONS_V1,
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
 * Decision W3: the Phase 2.5 rival lives here, inside the worker, as a bare
 * second connection on the same file. It is never a V1 adapter and answers no
 * query — it exists only so the owning adapter's own `BEGIN IMMEDIATE` collides
 * with a real `RESERVED` lock. Opened lazily so no other harness pays for it.
 */
let rival: DatabaseSync | null = null;
let rivalHoldsLock = false;
let lastArmError: string | null = null;

function rivalConnection(): DatabaseSync {
  rival ??= new DatabaseSync(bootstrap.filePath, { timeout: 0 });
  return rival;
}

function takeRivalLock(): void {
  if (rivalHoldsLock) return;
  // BEGIN IMMEDIATE takes RESERVED straight away, which is exactly what the
  // adapter's own BEGIN IMMEDIATE will collide with.
  rivalConnection().exec("BEGIN IMMEDIATE");
  rivalHoldsLock = true;
}

function releaseRivalLock(): void {
  if (!rivalHoldsLock) return;
  rivalConnection().exec("ROLLBACK");
  rivalHoldsLock = false;
}

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

const adapter = new SharedStateSqliteAdapterV1({
  db: faultHandle,
  ownerToken: bootstrap.ownerToken,
  backwardSkewToleranceMs: bootstrap.backwardSkewToleranceMs,
});

const runtime = createSharedStateSqliteWorkerRuntimeV1({
  db: faultHandle,
  adapter,
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

const partitionEstablishInputSchema = z
  .object({
    faultPoint: z.enum([
      "unavailable",
      "lost-fence",
      "timeout",
      "ambiguous-commit",
      "delayed-read",
    ]),
    usurperToken: z.string().min(1),
  })
  .strict();

const partitionArmInputSchema = z
  .object({
    faultPoint: z
      .enum([
        "unavailable",
        "lost-fence",
        "timeout",
        "ambiguous-commit",
        "delayed-read",
      ])
      .nullable(),
    skipFaultInjection: z.boolean(),
    usurperToken: z.string().min(1),
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
 * Decision W6's read-path corruption. The identity carried here is the row's
 * own digest, which the target already holds legitimately — the graph target
 * computes its source fact digests, and the outbox event key digest comes back
 * through the lane in the committed transaction result. No table, column,
 * literal or predicate crosses the channel; the corruption member fixes all
 * four.
 */
const readPathCorruptionInputSchema = z
  .object({
    corruption: z.enum(SHARED_STATE_SQLITE_READ_PATH_CORRUPTIONS_V1),
    namespace: z.string().min(1),
    digest: z.string().min(1),
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
    case "readPathCorruption": {
      // Mutation uses the raw connection, never the fault handle: the point is
      // a row that really is on disk and really is wrong, not an injected
      // error the query layer could distinguish from genuine corruption.
      const { corruption, namespace, digest } =
        readPathCorruptionInputSchema.parse(input);
      if (corruption === "graph-source-sequence-noncanonical") {
        db.prepare(
          `UPDATE shared_state_graph_source SET source_sequence = ?
             WHERE namespace = ? AND source_fact_digest = ?`,
        ).run("03", namespace, digest);
        return null;
      }
      db.prepare(
        `UPDATE shared_state_outbox SET receipt_state = ?
           WHERE namespace = ? AND event_key_digest = ?`,
      ).run("invented", namespace, digest);
      return null;
    }
    case "expirySnapshot": {
      const parsed = expirySnapshotInputSchema.parse(input);
      return buildSharedStateExpiryConformanceSnapshotV1(db, parsed);
    }
    case "leaseRows": {
      // Observation uses the raw connection, never the fault handle.
      return db
        .prepare(
          `SELECT owner_key_digest, attempt_key_digest, fencing_token,
                  resource_version, lease_expires_at_unix_ms
             FROM shared_state_lease`,
        )
        .all();
    }
    case "adapterLifecycle": {
      return adapter.lifecycle();
    }
    case "partitionHeal": {
      // Order matters: the commit fault goes first, because reacquiring
      // ownership issues its own COMMIT. The fired history is deliberately not
      // cleared — a heal undoes a premise, it does not erase evidence.
      faultState.armed = null;
      releaseRivalLock();
      const owner = db
        .prepare(`SELECT owner_token FROM shared_state_ownership WHERE id = 1`)
        .get() as { owner_token?: unknown } | undefined;
      if (owner !== undefined && owner.owner_token !== bootstrap.ownerToken) {
        db.prepare(
          `UPDATE shared_state_ownership SET owner_token = ? WHERE id = 1`,
        ).run(bootstrap.ownerToken);
      }
      if (adapter.lifecycle()?.state === "failed") {
        const reopened = adapter.open();
        if (!reopened.ok) {
          throw new Error(`adapter reopen refused: ${reopened.error.code}`);
        }
      }
      return null;
    }
    case "partitionEstablish": {
      const { faultPoint, usurperToken } = partitionEstablishInputSchema.parse(
        input,
      );
      if (faultPoint === "unavailable") {
        // A foreign owner token: the row says someone else holds the authority.
        db.prepare(
          `UPDATE shared_state_ownership SET owner_token = ? WHERE id = 1`,
        ).run(usurperToken);
        return null;
      }
      if (faultPoint === "lost-fence") {
        // An epoch this session never acquired. The epoch only moves up.
        const row = db
          .prepare(
            `SELECT lifecycle_epoch FROM shared_state_ownership WHERE id = 1`,
          )
          .get() as { lifecycle_epoch?: unknown };
        const current = BigInt(String(row.lifecycle_epoch));
        db.prepare(
          `UPDATE shared_state_ownership SET lifecycle_epoch = ? WHERE id = 1`,
        ).run((current + 1_000n).toString());
        return null;
      }
      if (faultPoint === "timeout") {
        takeRivalLock();
        return null;
      }
      if (faultPoint === "ambiguous-commit") {
        // Non-disarming on purpose: section 2.5 needs a point that keeps
        // firing until it is replaced.
        faultState.armed = {
          point: "ambiguous-commit",
          sqlFragment: "COMMIT",
          phase: "before-exec",
          repeating: true,
        };
        return null;
      }
      // `delayed-read` is a read-path point: the projection lag is already
      // stored and nothing needs establishing.
      return null;
    }
    case "partitionArm": {
      const parsed = partitionArmInputSchema.parse(input);
      lastArmError = null;
      try {
        applyControl("partitionHeal", null);
        if (parsed.faultPoint === null || parsed.skipFaultInjection) return null;
        applyControl("partitionEstablish", {
          faultPoint: parsed.faultPoint,
          usurperToken: parsed.usurperToken,
        });
        if (
          parsed.faultPoint === "unavailable"
          || parsed.faultPoint === "lost-fence"
        ) {
          // `beginWrite` is the adapter's own guard, not a conformance seam.
          const observed = adapter.beginWrite();
          if (observed.ok || observed.error.code !== "ownership_lost") {
            lastArmError = "ownership premise did not reach the adapter";
          }
        }
      } catch (error: unknown) {
        lastArmError = error instanceof Error ? error.message : String(error);
      }
      return null;
    }
    case "partitionState": {
      const count = (table: string, where = ""): number => {
        const row = db
          .prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`)
          .get() as { count?: unknown };
        return Number(row.count);
      };
      const maximum = (table: string, column: string): string => {
        const rows = db
          .prepare(`SELECT ${column} AS value FROM ${table}`)
          .all() as readonly { value?: unknown }[];
        let high = 0n;
        for (const row of rows) {
          if (row.value === null || row.value === undefined) continue;
          const value = BigInt(String(row.value));
          if (value > high) high = value;
        }
        return high.toString();
      };
      const checkpoint = db
        .prepare(`SELECT checkpoint_sequence FROM shared_state_graph_projection`)
        .get() as { checkpoint_sequence?: unknown } | undefined;
      const ownership = db
        .prepare(
          `SELECT owner_token, lifecycle_epoch FROM shared_state_ownership
            WHERE id = 1`,
        )
        .get() as
        | { owner_token?: unknown; lifecycle_epoch?: unknown }
        | undefined;

      return {
        replayRecordCount: count("shared_state_replay_nonce"),
        rateEntryCount: count("shared_state_rate_cost"),
        activeLeaseCount: count(
          "shared_state_lease",
          "WHERE owner_key_digest IS NOT NULL",
        ),
        maximumFencingToken: maximum("shared_state_lease", "fencing_token"),
        leaseResourceVersion: maximum("shared_state_lease", "resource_version"),
        idempotencyOutcomeCount: count("shared_state_idempotency"),
        outboxEventCount: count("shared_state_outbox"),
        unacknowledgedEventCount: count(
          "shared_state_outbox",
          "WHERE acknowledgment_state = 'unacknowledged'",
        ),
        acknowledgedEventCount: count(
          "shared_state_outbox",
          "WHERE acknowledgment_state = 'acknowledged'",
        ),
        streamSequenceHighWater: maximum("shared_state_outbox", "stream_sequence"),
        provenanceSourceCount: count("shared_state_graph_source"),
        provenanceSourceHighWater: maximum(
          "shared_state_graph_source",
          "source_sequence",
        ),
        provenanceCheckpointSequence:
          checkpoint === undefined ? "0" : String(checkpoint.checkpoint_sequence),
        ownerTokenRow:
          ownership === undefined || typeof ownership.owner_token !== "string"
            ? null
            : ownership.owner_token,
        lifecycleEpochRow:
          ownership === undefined ? null : String(ownership.lifecycle_epoch),
        adapterOwnerToken: adapter.ownerToken,
        adapterLifecycleEpoch: adapter.lifecycleEpoch,
        adapterLifecycle: adapter.lifecycle(),
        rivalHoldsLock,
        commitFaultFiredCount: faultState.firedAt.length,
        lastArmError,
      };
    }
    case "leaseClearViolation": {
      db.prepare(`DELETE FROM shared_state_lease`).run();
      return null;
    }
    case "restartContinuityState": {
      // Observation uses the raw connection, never the fault handle.
      const all = (sql: string): readonly Record<string, unknown>[] =>
        db.prepare(sql).all() as readonly Record<string, unknown>[];
      const total = (table: string): number => {
        const row = db
          .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
          .get() as { total?: unknown };
        return Number(row.total);
      };
      const floor = db
        .prepare(
          `SELECT persisted_floor_unix_ms FROM shared_state_clock_floor
            WHERE id = 1`,
        )
        .get() as { persisted_floor_unix_ms?: unknown } | undefined;

      return {
        outboxRows: all(
          `SELECT stream_key_digest, stream_sequence, receipt_state,
                  acknowledgment_state
             FROM shared_state_outbox`,
        ),
        leaseRows: all(
          `SELECT attempt_key_digest, fencing_token, resource_version
             FROM shared_state_lease`,
        ),
        rateRows: all(`SELECT cost FROM shared_state_rate_cost`),
        graphSourceRows: all(
          `SELECT source_sequence FROM shared_state_graph_source`,
        ),
        projectionRows: all(
          `SELECT checkpoint_sequence FROM shared_state_graph_projection`,
        ),
        replayRecordCount: total("shared_state_replay_nonce"),
        idempotencyCount: total("shared_state_idempotency"),
        linkCount: total("shared_state_idempotency_outbox_link"),
        graphBatchCount: total("shared_state_graph_batch"),
        persistedFloorUnixMs:
          floor === undefined || typeof floor.persisted_floor_unix_ms !== "string"
            ? null
            : floor.persisted_floor_unix_ms,
      };
    }
    case "claimGraphState": {
      // Observation uses the raw connection, never the fault handle.
      const batches = (
        db
          .prepare(
            `SELECT source_sequence_from, source_sequence_through, rolled_back
               FROM shared_state_graph_batch`,
          )
          .all() as readonly Record<string, unknown>[]
      ).map((row) => ({
        from: String(row["source_sequence_from"]),
        through: String(row["source_sequence_through"]),
        rolledBack: row["rolled_back"] !== 0,
      }));

      const sequences = db
        .prepare(`SELECT source_sequence FROM shared_state_graph_source`)
        .all() as readonly { source_sequence?: unknown }[];
      let high = 0n;
      for (const row of sequences) {
        const value = BigInt(String(row.source_sequence));
        if (value > high) high = value;
      }

      const checkpoint = db
        .prepare(`SELECT checkpoint_sequence FROM shared_state_graph_projection`)
        .get() as { checkpoint_sequence?: unknown } | undefined;

      return {
        batches,
        sourceFactCount: sequences.length,
        sourceSequenceHighWater: high.toString(),
        checkpointSequence:
          checkpoint === undefined
            ? "0"
            : String(checkpoint.checkpoint_sequence),
      };
    }
    case "outboxRows": {
      // Observation uses the raw connection, never the fault handle.
      return db
        .prepare(
          `SELECT stream_key_digest, event_key_digest, stream_sequence,
                  receipt_state, acknowledgment_state
             FROM shared_state_outbox`,
        )
        .all();
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
