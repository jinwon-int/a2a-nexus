/**
 * TEST-ONLY Phase 2.6 conformance target backed by the V1 SQLite adapter.
 *
 * Same rule as the six earlier targets: every conformance seam lives here,
 * next to the harness, and never on `SharedStateSqliteAdapterV1`. A snapshot,
 * a cleanup switch, or a capacity-pressure band on the adapter would be a
 * storage API the contract does not register.
 *
 * WHAT THIS SLICE PROVES THAT NO EARLIER ONE DID
 *
 * Physical cleanup is not an input to a logical expiry decision, against a
 * real store rather than against a model that chose to keep expired rows.
 * The adapter has no `DELETE FROM shared_state_*` path at all: a logically
 * expired replay, rate, or lease row stays on disk, and the exclusive
 * boundary (`observed == expires` is already expired) is the adapter's own
 * evaluator, not a target rewrite. Section 2.6 requires
 * `attempt-early-eviction` to be refused; V1 refuses it structurally.
 *
 * There is no fault-injection surface. The six earlier targets all wrap the
 * database handle; this one does not, because the Phase 2.6 harness has no
 * `armFault` and its two controls — cleanup and capacity — are both
 * synchronous and test-only. Two handles are enough: one for the adapter,
 * one raw for observation.
 *
 * DECISION 2 (COLLAPSE) — nothing to collapse
 *
 * No fault points are armed, so there is no durable position to map onto
 * another. The collapsed list is empty on purpose, and a test asserts it
 * does not overlap the synthesis list.
 *
 * DECISION 3 (DECLARED SYNTHESIS) — one field, cut narrow
 *
 * `ownershipEpoch` is the only synthesized snapshot value. The harness
 * means lease-claim generation: `"1"` after the first claim, `"2"` after
 * an atomic reap/new-claim. V1 has no lease-ownership-epoch column. The
 * nearest real durable value is `shared_state_lease.fencing_token`, which
 * rises on claim and only on claim. The adapter's
 * `shared_state_ownership.lifecycle_epoch` is the wrong field: it is the
 * session epoch, established by `open`, and a reclaim does not move it. A
 * dedicated test pins that distinction so the next reader does not follow
 * the investigation note that named the ownership row.
 *
 * `physicalCleanupState` and `capacityPressureBand` are not syntheses.
 * The harness header already calls them test-only controls; the target
 * reports the control it was last asked to apply. They are listed
 * separately so a later reader cannot mistake a control report for a
 * missing durable column.
 *
 * What this does NOT do: check the Phase 2.6 repeat item. That item also
 * binds authorized retention/prune execution at and after the logical
 * boundary, which no slice has performed. V1 has no delete path to run
 * such a prune through.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_EXPIRY_CONFORMANCE_V1,
  SharedStateExpiryConformanceErrorV1,
  runSharedStateExpiryConformanceV1,
  type SharedStateExpiryCleanupControlV1,
  type SharedStateExpiryConformanceClockV1,
  type SharedStateExpiryConformanceTargetFactoryV1,
  type SharedStateExpiryConformanceTargetV1,
} from "./shared-state-expiry-conformance-v1.js";
import { SharedStateSqliteAdapterV1 } from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import { buildSharedStateExpiryConformanceSnapshotV1 } from "./shared-state-sqlite-expiry-snapshot-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  digestSharedStateKeyV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";

const TEST_ONLY_SQLITE_EXPIRY_TARGET_V1 = Object.freeze({
  label: "test-only-sqlite-expiry-conformance-target",
  production: false,
  sqlite: true,
  shared: false,
  attachedToBrokerRuntime: false,
  adapterApiChanged: false,
  faultSeam: "none-section-has-no-fault-points",
  clockSeam: "single-injected-shared-clock-readObservedUnixMilliseconds",
  skewToleranceMs: "10",
  physicalDeletePath: "none-expired-rows-remain-on-disk",
  exclusiveExpiryBoundary: true,
  faultPointsArmed: 0,
  durableFaultPositions: 0,
  /** Decision 2. Empty: there is no fault point to map. */
  collapsedFaultPoints: Object.freeze([] as const),
  collapseReason: "no-fault-points-to-collapse",
  /** Decision 3. Nothing else in this target is synthesized. */
  declaredSyntheses: Object.freeze([
    "snapshot.ownershipEpoch",
  ] as const),
  synthesisReason: "v1-has-no-lease-ownership-epoch-column",
  ownershipEpochDerivedFrom: "shared_state_lease.fencing_token",
  ownershipEpochNotTakenFrom: "shared_state_ownership.lifecycle_epoch",
  /**
   * Control-state reports, not syntheses. The harness names them
   * test-only controls; the target echoes the last applied control.
   */
  controlStateFields: Object.freeze([
    "snapshot.physicalCleanupState",
    "snapshot.capacityPressureBand",
  ] as const),
  genuinelyIndependentCounters: Object.freeze([
    "replayRetainedCount",
    "rateEntryRetainedCount",
    "leaseBinding",
    "activeLeaseCount",
    "maximumFencingToken",
    "leaseResourceVersion",
    "idempotencyOutcomeRetainedCount",
    "outboxEventRetainedCount",
    "unacknowledgedEventCount",
    "acknowledgedEventCount",
    "streamSequenceHighWater",
    "provenanceSourceRetainedCount",
    "provenanceSourceSequenceHighWater",
    "provenanceCheckpointSequence",
  ] as const),
  observationHandle: "raw-never-a-fault-proxy",
  repeatItemChecked: false,
} as const);

const SKEW_TOLERANCE_MS =
  SHARED_STATE_EXPIRY_CONFORMANCE_V1.backwardSkewToleranceMs.toString();

/** The adapter's entire public surface. Nothing conformance-shaped is on it. */
const ADAPTER_PUBLIC_MEMBERS_V1 = Object.freeze([
  "ownerToken",
  "lifecycleEpoch",
  "lifecycle",
  "open",
  "beginWrite",
  "transact",
  "query",
  "drain",
  "close",
] as const);

interface AdversarialSqliteExpiryControlV1 {
  /** Cleanup actually deletes the still-active replay row. */
  readonly earlyEvictionActuallyDeletes?: boolean;
  /** Capacity pressure drops unexpired replay and idempotency rows. */
  readonly pressureEvictsUnexpired?: boolean;
  /** Treats the exclusive expiry instant as still active. */
  readonly staleBoundaryOffByOne?: boolean;
  /** Snapshot silently retires an unacknowledged outbox row. */
  readonly implicitTtlOnOutbox?: boolean;
  /** Reports critical pressure but still accepts new work. */
  readonly skipCapacityShedding?: boolean;
}

function transactionResult(
  operation: string,
  body: Record<string, unknown>,
): unknown {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    consistency:
      V.operationConsistency[operation as keyof typeof V.operationConsistency],
    ...body,
  });
  if (!parsed.ok) {
    throw new SharedStateExpiryConformanceErrorV1("invalid_target_result");
  }
  return parsed.value;
}

function unavailableResult(operation: string, reasonCode: string): unknown {
  return transactionResult(operation, {
    status: "unavailable",
    completeness: "unavailable",
    reasonCode,
  });
}

/** Builds a lifecycle envelope. The kind is `V.kinds.lifecycle`; getting it
 * wrong fails parsing silently and only surfaces as a lifecycle error. */
function lifecycleEnvelope(
  state: (typeof V.lifecycleStates)[number],
  reasonCodes: readonly (typeof V.lifecycleReasonCodes)[number][],
): unknown {
  const parsed = parseSharedStateStorageLifecycleV1({
    kind: V.kinds.lifecycle,
    lifecycleVersion: V.versions.lifecycle,
    contractVersion: V.versions.contract,
    state,
    reasonCodes,
  });
  if (!parsed.ok) {
    throw new SharedStateExpiryConformanceErrorV1("invalid_target_lifecycle");
  }
  return parsed.value;
}

class SqliteExpiryConformanceTargetV1
implements SharedStateExpiryConformanceTargetV1 {
  readonly #adapter: SharedStateSqliteAdapterV1;
  readonly #reads: DatabaseSync;
  readonly #clock: SharedStateExpiryConformanceClockV1;
  readonly #adversarial: AdversarialSqliteExpiryControlV1;
  #cleanupState: "none" | "early-eviction-refused" | "deferred" = "none";
  #pressureBand: (typeof V.pressureBands)[number] = "none";

  constructor(input: {
    readonly adapter: SharedStateSqliteAdapterV1;
    readonly reads: DatabaseSync;
    readonly clock: SharedStateExpiryConformanceClockV1;
    readonly adversarial: AdversarialSqliteExpiryControlV1;
  }) {
    this.#adapter = input.adapter;
    this.#reads = input.reads;
    this.#clock = input.clock;
    this.#adversarial = input.adversarial;
  }

  async open(): Promise<unknown> {
    const opened = this.#adapter.open();
    if (!opened.ok) throw new Error(`open refused: ${opened.error.code}`);
    return opened.value;
  }

  async close(): Promise<unknown> {
    const drained = this.#adapter.drain();
    if (!drained.ok) throw new Error(`drain refused: ${drained.error.code}`);
    const closed = this.#adapter.close();
    if (!closed.ok) throw new Error(`close refused: ${closed.error.code}`);
    return closed.value ?? lifecycleEnvelope("closed", ["close_requested"]);
  }

  applyConformanceCleanupControl(
    control: SharedStateExpiryCleanupControlV1,
  ): void {
    if (control === "attempt-early-eviction") {
      if (this.#adversarial.earlyEvictionActuallyDeletes === true) {
        // Violation: cleanup removed a logically active record. V1 has no
        // delete path, so this can only happen if the target does it.
        this.#reads.exec("DELETE FROM shared_state_replay_nonce");
      }
      this.#cleanupState = "early-eviction-refused";
      return;
    }
    if (control !== "defer-physical-cleanup") {
      throw new Error(`unknown cleanup control: ${String(control)}`);
    }
    this.#cleanupState = "deferred";
  }

  applyConformanceCapacityControl(
    band: (typeof V.pressureBands)[number],
  ): void {
    if (this.#adversarial.pressureEvictsUnexpired === true) {
      // Violation: pressure dropped unexpired safety records.
      this.#reads.exec("DELETE FROM shared_state_replay_nonce");
      this.#reads.exec("DELETE FROM shared_state_idempotency");
    }
    this.#pressureBand = band;
  }

  async transact(
    command: SharedStateTransactionCommandV1,
  ): Promise<unknown> {
    if (this.#shouldShed(command)) {
      return unavailableResult(command.operation, "authority_unavailable");
    }
    const inclusiveReplay = this.#inclusiveReplayAtExpiry(command);
    if (inclusiveReplay !== null) return inclusiveReplay;
    // The injected instant is passed through verbatim. Replacing it with a
    // target-owned counter would break every boundary probe, which advances
    // the shared clock exactly through expiry-1 / expiry / expiry+1.
    // Shifting the observation itself cannot express an inclusive boundary:
    // setup and probe would move together and cancel at the exclusive instant.
    const result = this.#adapter.transact(command, {
      observedAtUnixMs: this.#clock.readObservedUnixMilliseconds().toString(),
    });
    if (!result.ok) throw new Error(`adapter refused: ${result.error.code}`);
    return result.value;
  }

  /**
   * Violation: treat `observed == expires` as still active. Shifting the
   * clock by one millisecond cancels, because setup stores expiry from the
   * same shifted instant. The only way to reach the harness check is to
   * answer `replay` at the exclusive instant itself.
   */
  #inclusiveReplayAtExpiry(
    command: SharedStateTransactionCommandV1,
  ): unknown | null {
    if (this.#adversarial.staleBoundaryOffByOne !== true) return null;
    if (command.operation !== "consumeReplayNonce") return null;
    const now = this.#clock.readObservedUnixMilliseconds();
    const row = this.#reads
      .prepare(
        `SELECT expires_at_unix_ms FROM shared_state_replay_nonce
         WHERE namespace = ? AND key_digest = ? AND nonce_digest = ?`,
      )
      .get(
        command.input.namespace,
        command.input.keyDigest,
        command.input.nonceDigest,
      ) as { expires_at_unix_ms?: unknown } | undefined;
    if (row === undefined || typeof row.expires_at_unix_ms !== "string") {
      return null;
    }
    if (now !== BigInt(row.expires_at_unix_ms)) return null;
    return transactionResult("consumeReplayNonce", {
      status: "committed",
      completeness: "complete",
      result: {
        decision: "replay",
        expiresInMs: 1,
      },
    });
  }

  #shouldShed(command: SharedStateTransactionCommandV1): boolean {
    if (this.#pressureBand !== "critical") return false;
    if (this.#adversarial.skipCapacityShedding === true) return false;
    return !this.#isRetainedSafetyReplay(command);
  }

  /**
   * Unexpired replay of an existing nonce, or replay of an existing
   * idempotency key, must survive critical pressure. Everything else is
   * new work and is shed.
   */
  #isRetainedSafetyReplay(
    command: SharedStateTransactionCommandV1,
  ): boolean {
    const now = this.#clock.readObservedUnixMilliseconds();
    if (command.operation === "consumeReplayNonce") {
      const row = this.#reads
        .prepare(
          `SELECT expires_at_unix_ms FROM shared_state_replay_nonce
           WHERE namespace = ? AND key_digest = ? AND nonce_digest = ?`,
        )
        .get(
          command.input.namespace,
          command.input.keyDigest,
          command.input.nonceDigest,
        ) as { expires_at_unix_ms?: unknown } | undefined;
      if (row === undefined || typeof row.expires_at_unix_ms !== "string") {
        return false;
      }
      return BigInt(row.expires_at_unix_ms) > now;
    }
    if (command.operation === "executeIdempotent") {
      const row = this.#reads
        .prepare(
          `SELECT 1 AS present FROM shared_state_idempotency
           WHERE namespace = ? AND key_digest = ?`,
        )
        .get(command.input.namespace, command.input.keyDigest) as
        | { present?: unknown }
        | undefined;
      return row !== undefined;
    }
    return false;
  }

  // ---- observation, always through the raw handle -----------------------

  async captureConformanceSnapshot(): Promise<unknown> {
    if (this.#adversarial.implicitTtlOnOutbox === true) {
      // Violation: an implicit TTL silently retires an unacknowledged row.
      this.#reads.exec("DELETE FROM shared_state_outbox");
    }
    // W2 extracted this builder so the worker-mode target proves the same
    // snapshot shape from inside the worker instead of a second copy of it.
    return buildSharedStateExpiryConformanceSnapshotV1(this.#reads, {
      observedAtUnixMs: this.#clock.readObservedUnixMilliseconds().toString(),
      physicalCleanupState: this.#cleanupState,
      capacityPressureBand: this.#pressureBand,
    });
  }
}

interface TargetFixtureV1 {
  readonly factory: SharedStateExpiryConformanceTargetFactoryV1;
  readonly dispose: () => void;
}

function createSqliteExpiryTargetFixtureV1(
  adversarial: AdversarialSqliteExpiryControlV1 = {},
): TargetFixtureV1 {
  const directories: string[] = [];
  const handles: DatabaseSync[] = [];
  let ordinal = 0;

  const factory: SharedStateExpiryConformanceTargetFactoryV1 = Object.freeze({
    async create(input: {
      readonly clock: SharedStateExpiryConformanceClockV1;
    }): Promise<SharedStateExpiryConformanceTargetV1> {
      ordinal += 1;
      const directory = mkdtempSync(
        join(tmpdir(), "shared-state-expiry-target-v1-"),
      );
      directories.push(directory);
      const file = join(directory, "v1.db");

      const db = new DatabaseSync(file);
      handles.push(db);
      assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);

      return new SqliteExpiryConformanceTargetV1({
        adapter: new SharedStateSqliteAdapterV1({
          db,
          ownerToken: `expiry-conformance-owner-${ordinal}`,
          // Must match the harness tolerance. Five of the six earlier
          // targets pass `"0"`; copying them here fails the policy-agreement
          // check. Phase 2.4 already recorded this trap.
          backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
        }),
        reads: db,
        clock: input.clock,
        adversarial,
      });
    },
  });

  return {
    factory,
    dispose(): void {
      for (const handle of handles) {
        try {
          handle.close();
        } catch {
          // The directory removal below is what actually matters.
        }
      }
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

async function expectConformanceErrorCode(
  adversarial: AdversarialSqliteExpiryControlV1,
  expected: string,
): Promise<void> {
  const fixture = createSqliteExpiryTargetFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStateExpiryConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateExpiryConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStateExpiryConformanceErrorV1)) {
          return false;
        }
        assert.equal(error.code, expected);
        return true;
      },
    );
  } finally {
    fixture.dispose();
  }
}

test("declares the Phase 2.6 target shape, its collapse, and its syntheses", () => {
  assert.deepEqual(TEST_ONLY_SQLITE_EXPIRY_TARGET_V1, {
    label: "test-only-sqlite-expiry-conformance-target",
    production: false,
    sqlite: true,
    shared: false,
    attachedToBrokerRuntime: false,
    adapterApiChanged: false,
    faultSeam: "none-section-has-no-fault-points",
    clockSeam: "single-injected-shared-clock-readObservedUnixMilliseconds",
    skewToleranceMs: "10",
    physicalDeletePath: "none-expired-rows-remain-on-disk",
    exclusiveExpiryBoundary: true,
    faultPointsArmed: 0,
    durableFaultPositions: 0,
    collapsedFaultPoints: [],
    collapseReason: "no-fault-points-to-collapse",
    declaredSyntheses: ["snapshot.ownershipEpoch"],
    synthesisReason: "v1-has-no-lease-ownership-epoch-column",
    ownershipEpochDerivedFrom: "shared_state_lease.fencing_token",
    ownershipEpochNotTakenFrom: "shared_state_ownership.lifecycle_epoch",
    controlStateFields: [
      "snapshot.physicalCleanupState",
      "snapshot.capacityPressureBand",
    ],
    genuinelyIndependentCounters: [
      "replayRetainedCount",
      "rateEntryRetainedCount",
      "leaseBinding",
      "activeLeaseCount",
      "maximumFencingToken",
      "leaseResourceVersion",
      "idempotencyOutcomeRetainedCount",
      "outboxEventRetainedCount",
      "unacknowledgedEventCount",
      "acknowledgedEventCount",
      "streamSequenceHighWater",
      "provenanceSourceRetainedCount",
      "provenanceSourceSequenceHighWater",
      "provenanceCheckpointSequence",
    ],
    observationHandle: "raw-never-a-fault-proxy",
    repeatItemChecked: false,
  });

  assert.equal(TEST_ONLY_SQLITE_EXPIRY_TARGET_V1.faultPointsArmed, 0);
  assert.equal(TEST_ONLY_SQLITE_EXPIRY_TARGET_V1.durableFaultPositions, 0);
  assert.equal(
    TEST_ONLY_SQLITE_EXPIRY_TARGET_V1.skewToleranceMs,
    SKEW_TOLERANCE_MS,
  );
  // Decision 2 is a mapping and decision 3 is a substitution. They are
  // different categories, so the two lists must not overlap.
  const collapsed = new Set<string>(
    TEST_ONLY_SQLITE_EXPIRY_TARGET_V1.collapsedFaultPoints,
  );
  for (const synthesized of TEST_ONLY_SQLITE_EXPIRY_TARGET_V1
    .declaredSyntheses) {
    assert.equal(collapsed.has(synthesized), false);
  }
  // A control-state report is not a synthesis and not a collapse.
  for (const field of TEST_ONLY_SQLITE_EXPIRY_TARGET_V1.controlStateFields) {
    assert.equal(collapsed.has(field), false);
    assert.equal(
      (
        TEST_ONLY_SQLITE_EXPIRY_TARGET_V1.declaredSyntheses as
          readonly string[]
      ).includes(field),
      false,
    );
  }
  // The independent counters, the one synthesis, and the two control
  // reports together account for the whole snapshot, so nothing is left
  // undeclared.
  assert.equal(
    TEST_ONLY_SQLITE_EXPIRY_TARGET_V1.genuinelyIndependentCounters.length
      + TEST_ONLY_SQLITE_EXPIRY_TARGET_V1.declaredSyntheses.length
      + TEST_ONLY_SQLITE_EXPIRY_TARGET_V1.controlStateFields.length,
    17,
  );
});

test("keeps every conformance seam off the adapter's public surface", () => {
  for (
    const name of [
      "captureConformanceSnapshot",
      "applyConformanceCleanupControl",
      "applyConformanceCapacityControl",
      "armConformanceFault",
      "armFault",
      "snapshot",
    ]
  ) {
    assert.equal(
      name in SharedStateSqliteAdapterV1.prototype,
      false,
      `adapter must not expose ${name}`,
    );
  }
  assert.deepEqual(
    Object.getOwnPropertyNames(SharedStateSqliteAdapterV1.prototype)
      .filter((name) => name !== "constructor")
      .sort(),
    [...ADAPTER_PUBLIC_MEMBERS_V1].sort(),
  );
});

test("runs the Phase 2.6 harness through the V1 SQLite adapter", async () => {
  const fixture = createSqliteExpiryTargetFixtureV1();
  try {
    const report = await runSharedStateExpiryConformanceV1(fixture.factory);
    assert.equal(report.status, "passed");
    assert.equal(report.contractVersion, V.versions.contract);
    assert.equal(
      report.controls.targetCount,
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.targetCount,
    );
    assert.equal(
      report.controls.targetCommandCount,
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedTargetCommandCount,
    );
    assert.equal(
      report.controls.lifecycleCount,
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedLifecycleCount,
    );
    assert.equal(
      report.controls.snapshotControlCount,
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedSnapshotControlCount,
    );
    assert.equal(
      report.controls.cleanupControlCount,
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.cleanupControlCount,
    );
    assert.equal(
      report.controls.capacityControlCount,
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.capacityControlCount,
    );
    assert.equal(
      report.controls.clockControlCount,
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.clockControlCount,
    );
    assert.equal(
      report.boundaryProbe.cases.length,
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedProbeCaseCount,
    );
    assert.equal(report.cleanupIndependence.presenceIsEvaluatorInput, false);
    assert.equal(
      report.cleanupIndependence.expiredRecordPhysicalState,
      "retained",
    );
    assert.equal(report.capacityPressure.permissiveEvictionObserved, false);
    assert.equal(report.leaseTransition.expiryAloneTransfersOwnership, false);
    assert.equal(report.claims.retentionPruneExecution, "not-executed");
    assert.equal(report.claims.adapterConformance, "not-claimed");
  } finally {
    fixture.dispose();
  }
});

/**
 * The point of this slice. Logical expiry must not remove a row, and the
 * instant of expiry is already expired. The in-memory reference model can
 * only choose to keep the row; here the adapter has no delete path, so the
 * retain is structural.
 */
test("proves expired rows stay on disk and the expiry instant is exclusive", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "shared-state-expiry-retain-v1-"),
  );
  const file = join(directory, "v1.db");
  const db = new DatabaseSync(file);
  try {
    assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
    const sqlite = new SharedStateSqliteAdapterV1({
      db,
      ownerToken: "expiry-retain-owner",
      backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
    });
    assert.equal(sqlite.open().ok, true);

    const first = sqlite.transact(probeReplayCommand("retain-1"), {
      observedAtUnixMs: "2000000",
    });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.value.status, "committed");
    if (first.value.status !== "committed") throw new Error("unreachable");
    assert.equal(first.value.result.decision, "accepted");

    const beforeExpiry = sqlite.transact(probeReplayCommand("retain-1"), {
      observedAtUnixMs: "2000999",
    });
    assert.equal(beforeExpiry.ok, true);
    if (!beforeExpiry.ok) throw new Error("unreachable");
    assert.equal(beforeExpiry.value.status, "committed");
    if (beforeExpiry.value.status !== "committed") {
      throw new Error("unreachable");
    }
    assert.equal(beforeExpiry.value.result.decision, "replay");

    const atExpiry = sqlite.transact(probeReplayCommand("retain-1"), {
      observedAtUnixMs: "2001000",
    });
    assert.equal(atExpiry.ok, true);
    if (!atExpiry.ok) throw new Error("unreachable");
    assert.equal(atExpiry.value.status, "committed");
    if (atExpiry.value.status !== "committed") {
      throw new Error("unreachable");
    }
    // Exclusive: the instant of expiry is already expired, so this is a
    // new consume that overwrites the same primary key.
    assert.equal(atExpiry.value.result.decision, "accepted");

    const afterExpiry = sqlite.transact(probeReplayCommand("retain-1"), {
      observedAtUnixMs: "2001001",
    });
    assert.equal(afterExpiry.ok, true);
    if (!afterExpiry.ok) throw new Error("unreachable");
    assert.equal(afterExpiry.value.status, "committed");
    if (afterExpiry.value.status !== "committed") {
      throw new Error("unreachable");
    }
    assert.equal(afterExpiry.value.result.decision, "replay");

    const retained = db
      .prepare(`SELECT COUNT(*) AS count FROM shared_state_replay_nonce`)
      .get() as { count?: unknown };
    // The overwrite never briefly deletes the row, so the count stays one
    // across the exclusive boundary.
    assert.equal(Number(retained.count), 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * `ownershipEpoch` is declared as derived from the lease fence because the
 * adapter session epoch does not move on reclaim. If a later slice adds a
 * real lease-ownership-epoch column, this fails and the descriptor is what
 * needs correcting.
 */
test("derives ownershipEpoch from the lease fence, not the session epoch", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "shared-state-expiry-epoch-v1-"),
  );
  const file = join(directory, "v1.db");
  const db = new DatabaseSync(file);
  try {
    assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
    const sqlite = new SharedStateSqliteAdapterV1({
      db,
      ownerToken: "expiry-epoch-owner",
      backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
    });
    assert.equal(sqlite.open().ok, true);

    const first = sqlite.transact(probeClaimCommand("owner-a", "0"), {
      observedAtUnixMs: "2000000",
    });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.value.status, "committed");
    if (first.value.status !== "committed") throw new Error("unreachable");
    assert.equal(first.value.result.decision, "claimed");
    if (first.value.result.decision !== "claimed") {
      throw new Error("unreachable");
    }
    assert.equal(first.value.result.fencingToken, "1");
    assert.equal(sqlite.lifecycleEpoch, "1");

    const reclaim = sqlite.transact(
      probeClaimCommand("owner-b", first.value.result.resourceVersion),
      { observedAtUnixMs: "2001000" },
    );
    assert.equal(reclaim.ok, true);
    if (!reclaim.ok) throw new Error("unreachable");
    assert.equal(reclaim.value.status, "committed");
    if (reclaim.value.status !== "committed") throw new Error("unreachable");
    assert.equal(reclaim.value.result.decision, "claimed");
    if (reclaim.value.result.decision !== "claimed") {
      throw new Error("unreachable");
    }
    assert.equal(reclaim.value.result.fencingToken, "2");
    // The session epoch did not move. Mapping ownershipEpoch onto it would
    // report "1" after the reclaim and fail scenario D.
    assert.equal(sqlite.lifecycleEpoch, "1");

    const ownership = db
      .prepare(
        `SELECT lifecycle_epoch FROM shared_state_ownership WHERE id = 1`,
      )
      .get() as { lifecycle_epoch?: unknown };
    assert.equal(ownership.lifecycle_epoch, "1");
    const lease = db
      .prepare(`SELECT fencing_token FROM shared_state_lease`)
      .get() as { fencing_token?: unknown };
    assert.equal(lease.fencing_token, "2");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Each control has to reach the harness check it was written for. A control
 * that passes has not proved the implementation correct — it has proved the
 * control too weak — so these pin the exact code, not merely a rejection.
 *
 * `reopenLosesState` is deliberately absent. The Phase 2.6 harness never
 * reopens a target, so that control would be consumed by `close` and then
 * sit unused. The five below each fire inside a check the run actually
 * performs.
 */
test("fails closed on each adversarial expiry violation", async () => {
  // Item: early eviction must refuse, not delete an active record.
  await expectConformanceErrorCode(
    { earlyEvictionActuallyDeletes: true },
    "active_record_removed",
  );
  // Item: capacity pressure must not drop unexpired safety records.
  await expectConformanceErrorCode(
    { pressureEvictsUnexpired: true },
    "capacity_eviction_permissive",
  );
  // Item: the expiry instant is exclusive, not inclusive.
  await expectConformanceErrorCode(
    { staleBoundaryOffByOne: true },
    "boundary_operation_mismatch",
  );
  // Item: an unacknowledged outbox row has no implicit TTL.
  await expectConformanceErrorCode(
    { implicitTtlOnOutbox: true },
    "implicit_ttl_detected",
  );
  // Item: critical pressure must shed new work.
  await expectConformanceErrorCode(
    { skipCapacityShedding: true },
    "capacity_shedding_mismatch",
  );
});

function probeDigest(
  domain: string,
  namespace: string,
  components: readonly {
    readonly field: string;
    readonly type: "utf8" | "uint" | "bytes";
    readonly value: string;
  }[],
): string {
  const built = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace,
    components,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return built.value.digest;
}

function probeReplayCommand(
  nonce: string,
): SharedStateTransactionCommandV1 {
  const namespace = "security.replay.conformance";
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "consumeReplayNonce",
    input: {
      namespace,
      keyDigest: probeDigest(
        "security.replay.requester-key",
        namespace,
        [{ field: "requesterId", type: "utf8", value: "retain-requester" }],
      ),
      nonceDigest: probeDigest("security.replay.nonce", namespace, [
        { field: "nonce", type: "utf8", value: nonce },
      ]),
      ttlMs: SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

function probeClaimCommand(
  ownerId: string,
  expectedResourceVersion: string,
): SharedStateTransactionCommandV1 {
  const namespace = "broker.lease.conformance";
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "claimLease",
    input: {
      namespace,
      resourceKeyDigest: probeDigest(
        "broker.lease.resource-key",
        namespace,
        [
          { field: "resourceType", type: "utf8", value: "broker-expiry" },
          { field: "resourceId", type: "utf8", value: "expiry-resource" },
        ],
      ),
      ownerKeyDigest: probeDigest("broker.lease.owner-key", namespace, [
        { field: "ownerId", type: "utf8", value: ownerId },
      ]),
      leaseDurationMs: SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
      expectedResourceVersion,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}
