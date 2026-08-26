/**
 * TEST-ONLY Phase 2.6 conformance snapshot builder, shared by both modes.
 *
 * The inline expiry target built this snapshot from its own raw handle. Worker
 * mode has to build the same snapshot from inside the worker, because the
 * worker owns the connection and a worker-mode target opens none of its own.
 * Two copies of this SQL would let the two modes' evidence drift apart
 * silently, and a worker-mode pass would then no longer mean what an inline
 * pass means. So both call this.
 *
 * Every read is a plain observation. Nothing here writes, and nothing here
 * consults the adapter — the snapshot is deliberately taken behind the
 * adapter's back so a harness can catch an adapter that reports one thing and
 * stores another.
 */
import type { DatabaseSync } from "node:sqlite";

import {
  sharedStateExpiryConformanceSnapshotV1Schema,
  type SharedStateExpiryConformanceSnapshotV1,
} from "./shared-state-expiry-conformance-v1.js";
import { SHARED_STATE_STORAGE_V1_VALUES as V } from "./shared-state-storage-contract-v1.js";

export type SharedStateExpiryPhysicalCleanupStateV1 =
  | "none"
  | "early-eviction-refused"
  | "deferred";

export interface SharedStateExpirySnapshotInputV1 {
  /**
   * The harness's injected instant, as a decimal string. Lease activity is
   * relative to it, so a target-owned counter here would break every boundary
   * probe the harness runs.
   */
  readonly observedAtUnixMs: string;
  readonly physicalCleanupState: SharedStateExpiryPhysicalCleanupStateV1;
  readonly capacityPressureBand: (typeof V.pressureBands)[number];
}

function count(reads: DatabaseSync, table: string, where = ""): number {
  const row = reads
    .prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`)
    .get() as { count?: unknown };
  return Number(row.count);
}

function maximum(
  reads: DatabaseSync,
  table: string,
  column: string,
): bigint {
  const rows = reads
    .prepare(`SELECT ${column} AS value FROM ${table}`)
    .all() as readonly { value?: unknown }[];
  let high = 0n;
  for (const row of rows) {
    // TEXT columns: SQL MAX() would order them lexically and rank "9" above
    // "10". The comparison has to happen in BigInt.
    if (row.value === null || row.value === undefined) continue;
    const value = BigInt(String(row.value));
    if (value > high) high = value;
  }
  return high;
}

function checkpointSequence(reads: DatabaseSync): bigint {
  const row = reads
    .prepare(`SELECT checkpoint_sequence FROM shared_state_graph_projection`)
    .get() as { checkpoint_sequence?: unknown } | undefined;
  if (row === undefined) return 0n;
  return BigInt(String(row.checkpoint_sequence));
}

function activeLeaseCount(reads: DatabaseSync, now: bigint): number {
  const rows = reads
    .prepare(
      `SELECT owner_key_digest, lease_expires_at_unix_ms
         FROM shared_state_lease`,
    )
    .all() as readonly {
      owner_key_digest?: unknown;
      lease_expires_at_unix_ms?: unknown;
    }[];
  let active = 0;
  for (const row of rows) {
    if (typeof row.owner_key_digest !== "string") continue;
    if (typeof row.lease_expires_at_unix_ms !== "string") continue;
    if (BigInt(row.lease_expires_at_unix_ms) > now) active += 1;
  }
  return active;
}

export function buildSharedStateExpiryConformanceSnapshotV1(
  reads: DatabaseSync,
  input: SharedStateExpirySnapshotInputV1,
): SharedStateExpiryConformanceSnapshotV1 {
  const now = BigInt(input.observedAtUnixMs);
  const bound = count(
    reads,
    "shared_state_lease",
    "WHERE owner_key_digest IS NOT NULL",
  );
  const maximumFencingToken = maximum(reads, "shared_state_lease", "fencing_token");
  return sharedStateExpiryConformanceSnapshotV1Schema.parse({
    kind: "SharedStateExpiryConformanceSnapshotV1",
    snapshotVersion: 1,
    replayRetainedCount: count(reads, "shared_state_replay_nonce"),
    rateEntryRetainedCount: count(reads, "shared_state_rate_cost"),
    leaseBinding: bound > 0 ? "bound" : "unbound",
    activeLeaseCount: activeLeaseCount(reads, now),
    // Declared synthesis: derived from the fence the claim really wrote.
    // Both fields report the same maximum, so scan the table once.
    ownershipEpoch: maximumFencingToken.toString(),
    maximumFencingToken: maximumFencingToken.toString(),
    leaseResourceVersion: maximum(
      reads,
      "shared_state_lease",
      "resource_version",
    ).toString(),
    idempotencyOutcomeRetainedCount: count(reads, "shared_state_idempotency"),
    outboxEventRetainedCount: count(reads, "shared_state_outbox"),
    unacknowledgedEventCount: count(
      reads,
      "shared_state_outbox",
      "WHERE acknowledgment_state = 'unacknowledged'",
    ),
    acknowledgedEventCount: count(
      reads,
      "shared_state_outbox",
      "WHERE acknowledgment_state = 'acknowledged'",
    ),
    streamSequenceHighWater: maximum(
      reads,
      "shared_state_outbox",
      "stream_sequence",
    ).toString(),
    provenanceSourceRetainedCount: count(reads, "shared_state_graph_source"),
    provenanceSourceSequenceHighWater: maximum(
      reads,
      "shared_state_graph_source",
      "source_sequence",
    ).toString(),
    provenanceCheckpointSequence: checkpointSequence(reads).toString(),
    physicalCleanupState: input.physicalCleanupState,
    capacityPressureBand: input.capacityPressureBand,
  });
}
