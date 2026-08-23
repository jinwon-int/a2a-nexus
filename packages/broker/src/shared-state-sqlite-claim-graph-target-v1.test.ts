/**
 * TEST-ONLY Phase 2.7 conformance target backed by the V1 SQLite adapter.
 *
 * The seven Phase 2 harnesses are backend-neutral: each drives a target
 * interface whose non-`transact` methods are explicitly bounded test-only
 * conformance controls. `SharedStateSqliteAdapterV1` has none of those test
 * seams, and must not grow them — its closed Q3 evidence query is a parsed V1
 * request/result surface, not this ordinal-based harness control. That is why
 * this file exists and why it is a test file: it holds the controls adjacent
 * to the harness, exactly as the reference model does.
 *
 * The fault control is the part worth reading. It does not ask the adapter to
 * fail; the adapter has no way to be asked. It proxies the `DatabaseSync`
 * handle the adapter was constructed with and throws when the adapter
 * prepares the checkpoint write. The adapter's own `BEGIN IMMEDIATE` boundary
 * then performs a real `ROLLBACK`, so all-or-none is observed rather than
 * simulated. The production query is exercised separately and does not reuse
 * this fault switch.
 *
 * Nodes and edges are derived, not stored, which is the shape slice G
 * committed to: one node per source sequence in a batch's `[from, through]`
 * range and one edge from the first sequence to each later one, counted over
 * batches that have not been rolled back. The derivation is exact for the
 * Phase 2.7 harness and carries one assumption it does not exercise —
 * batches must not overlap, or a sequence covered by two live batches would
 * be counted as two nodes. The assumption is stated here rather than left to
 * look proved.
 *
 * What this does NOT do: turn `evaluateConformanceEvidencePath` into the Q3
 * query or claim the full Phase 2.7 repeat item. The current durable ledger
 * has no projection-authority marker from which Q3 could honestly synthesize
 * `projection_unavailable`; that remains a later contract/storage decision.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1,
  SharedStateClaimGraphConformanceErrorV1,
  runSharedStateClaimGraphConformanceV1,
  sharedStateClaimGraphConformanceSnapshotV1Schema,
  sharedStateClaimGraphEvidenceResultV1Schema,
  type SharedStateClaimGraphConformanceEvidenceQueryV1,
  type SharedStateClaimGraphConformanceTargetFactoryV1,
  type SharedStateClaimGraphConformanceTargetV1,
  type SharedStateClaimGraphFaultPointV1,
} from "./shared-state-claim-graph-conformance-v1.js";
import { SharedStateSqliteAdapterV1 } from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateTransactionResultV1,
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";

/**
 * Declares what this target is, so a reader never has to infer it. It is a
 * real SQLite adapter, which the reference model is not, and it is still not
 * production, not shared, and not attached to broker runtime.
 */
const TEST_ONLY_SQLITE_CLAIM_GRAPH_TARGET_V1 = Object.freeze({
  label: "test-only-sqlite-claim-graph-conformance-target",
  production: false,
  sqlite: true,
  shared: false,
  attachedToBrokerRuntime: false,
  adapterApiChanged: false,
  faultSeam: "test-only-database-handle-proxy-not-adapter-api",
  evidenceSeam: "test-only-control-not-a-v1-query",
  graphMaterialization: "derived-from-live-batch-ranges",
  overlappingBatchesAssumedAbsent: true,
  repeatItemChecked: false,
} as const);

/**
 * The claim-graph commands carry no time semantics, so one fixed observation
 * keeps every scenario deterministic while still passing the adapter's clock
 * floor evaluation.
 */
const OBSERVED_AT_UNIX_MS = "1000";

const CHECKPOINT_WRITE_SQL_FRAGMENT =
  "INSERT INTO shared_state_graph_projection";
const BATCH_WRITE_SQL_FRAGMENT = "INSERT INTO shared_state_graph_batch";

/**
 * Adversarial controls. Each one is a deliberate violation used to prove the
 * corresponding assertion is reachable. A control that leaves the harness
 * green means the harness never reaches the state, not that the target is
 * correct — the failure mode this section hit in slices D, E, and G.
 */
interface AdversarialSqliteClaimGraphControlV1 {
  /** Counts rolled-back batches as live, so a rollback restores nothing. */
  readonly deriveIncludingRolledBackBatches?: boolean;
  /** Accepts the arm request but never injects, so the batch commits. */
  readonly skipFaultInjection?: boolean;
  /** Leaves the authority reported available after a real fault. */
  readonly authorityStaysAvailableAfterFault?: boolean;
}

interface FaultStateV1 {
  armed: SharedStateClaimGraphFaultPointV1 | null;
  /** Set for the command currently in flight; reset before each one. */
  fired: boolean;
  /** Never reset, so a whole harness run can be audited afterwards. */
  firedCount: number;
  triggerFragment: string;
  readonly preparedSql: string[];
}

/**
 * Wraps the adapter's database handle so a prepared statement can fail at an
 * exact point inside the adapter's transaction. This is the whole fault seam:
 * it lives under the adapter rather than on it, so it cannot become adapter,
 * storage, or runtime API.
 */
function createFaultInjectingHandleV1(
  db: DatabaseSync,
  state: FaultStateV1,
): DatabaseSync {
  return new Proxy(db, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== "prepare") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string): unknown => {
        state.preparedSql.push(sql);
        if (state.armed !== null && sql.includes(state.triggerFragment)) {
          state.armed = null;
          state.fired = true;
          state.firedCount += 1;
          throw new Error("test-only-injected-conformance-fault");
        }
        return target.prepare(sql);
      };
    },
  }) as DatabaseSync;
}

function unavailableResult(
  operation: SharedStateTransactionCommandV1["operation"],
): unknown {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    consistency: V.operationConsistency[operation],
    status: "unavailable",
    completeness: "unavailable",
    reasonCode: "authority_unavailable",
  });
  if (!parsed.ok) {
    throw new SharedStateClaimGraphConformanceErrorV1("invalid_target_result");
  }
  return parsed.value;
}

interface BatchRowV1 {
  readonly from: bigint;
  readonly through: bigint;
  readonly rolledBack: boolean;
}

class SqliteClaimGraphConformanceTargetV1
implements SharedStateClaimGraphConformanceTargetV1 {
  readonly #adapter: SharedStateSqliteAdapterV1;
  readonly #reads: DatabaseSync;
  readonly #fault: FaultStateV1;
  readonly #adversarial: AdversarialSqliteClaimGraphControlV1;
  #authorityUnavailable = false;

  constructor(input: {
    readonly adapter: SharedStateSqliteAdapterV1;
    readonly reads: DatabaseSync;
    readonly fault: FaultStateV1;
    readonly adversarial: AdversarialSqliteClaimGraphControlV1;
  }) {
    this.#adapter = input.adapter;
    this.#reads = input.reads;
    this.#fault = input.fault;
    this.#adversarial = input.adversarial;
  }

  async open(): Promise<unknown> {
    const opened = this.#adapter.open();
    if (!opened.ok) throw new Error(`adapter open refused: ${opened.error}`);
    return opened.value;
  }

  /** `close` releases ownership only after drain, so drain runs first. */
  async close(): Promise<unknown> {
    const drained = this.#adapter.drain();
    if (!drained.ok) throw new Error(`adapter drain refused: ${drained.error}`);
    const closed = this.#adapter.close();
    if (!closed.ok) throw new Error(`adapter close refused: ${closed.error}`);
    return closed.value;
  }

  async transact(command: SharedStateTransactionCommandV1): Promise<unknown> {
    this.#fault.fired = false;
    const result = this.#adapter.transact(command, {
      observedAtUnixMs: OBSERVED_AT_UNIX_MS,
    });

    if (this.#fault.fired) {
      // The adapter rolled its own transaction back. Reporting that as an
      // unavailable authority is the target's translation into the harness
      // vocabulary, not an invented outcome: nothing was written.
      if (this.#adversarial.authorityStaysAvailableAfterFault !== true) {
        this.#authorityUnavailable = true;
      }
      return unavailableResult(command.operation);
    }

    // Any other failure is a real one and is never dressed up as a fault.
    if (!result.ok) throw new Error(`adapter refused: ${result.error}`);

    // A command that completed with no injected fault is the clean retry:
    // the authority is reachable again.
    this.#authorityUnavailable = false;
    return result.value;
  }

  armConformanceProjectionFault(
    faultPoint: SharedStateClaimGraphFaultPointV1,
  ): void {
    // The seam maps one fault point onto one statement. A fault point added
    // to the vocabulary later must not silently inherit that mapping.
    if (faultPoint !== "after-node-edge-writes-before-checkpoint") {
      throw new Error(`unmapped claim-graph fault point: ${faultPoint}`);
    }
    if (this.#adversarial.skipFaultInjection === true) return;
    this.#fault.armed = faultPoint;
  }

  #liveBatches(): readonly BatchRowV1[] {
    const rows = this.#reads
      .prepare(
        `SELECT source_sequence_from, source_sequence_through, rolled_back
           FROM shared_state_graph_batch`,
      )
      .all() as readonly Record<string, unknown>[];
    return rows.map((row) => ({
      from: BigInt(String(row.source_sequence_from)),
      through: BigInt(String(row.source_sequence_through)),
      rolledBack:
        this.#adversarial.deriveIncludingRolledBackBatches === true
          ? false
          : row.rolled_back !== 0,
    }));
  }

  #sourceSequenceHighWater(): bigint {
    const rows = this.#reads
      .prepare(`SELECT source_sequence FROM shared_state_graph_source`)
      .all() as readonly { source_sequence?: unknown }[];
    let high = 0n;
    for (const row of rows) {
      const value = BigInt(String(row.source_sequence));
      if (value > high) high = value;
    }
    return high;
  }

  #checkpointSequence(): bigint {
    const row = this.#reads
      .prepare(
        `SELECT checkpoint_sequence FROM shared_state_graph_projection`,
      )
      .get() as { checkpoint_sequence?: unknown } | undefined;
    if (row === undefined) return 0n;
    return BigInt(String(row.checkpoint_sequence));
  }

  #completeness(): "complete" | "incomplete" | "unavailable" {
    if (this.#authorityUnavailable) return "unavailable";
    return this.#checkpointSequence() === this.#sourceSequenceHighWater()
      ? "complete"
      : "incomplete";
  }

  async captureConformanceSnapshot(): Promise<unknown> {
    const batches = this.#liveBatches();
    const live = batches.filter((batch) => !batch.rolledBack);
    const sourceFactCount = Number(
      (
        this.#reads
          .prepare(`SELECT COUNT(*) AS count FROM shared_state_graph_source`)
          .get() as { count?: unknown }
      ).count,
    );

    // One node per sequence in the range, one edge from the first sequence to
    // each later one. Rollback removes a batch's effects rather than
    // tombstoning them, so no tombstone state exists to count.
    let nodeCount = 0;
    let edgeCount = 0;
    for (const batch of live) {
      nodeCount += Number(batch.through - batch.from) + 1;
      edgeCount += Number(batch.through - batch.from);
    }

    return sharedStateClaimGraphConformanceSnapshotV1Schema.parse({
      kind: "SharedStateClaimGraphConformanceSnapshotV1",
      snapshotVersion: 1,
      sourceFactCount,
      sourceSequenceHighWater: this.#sourceSequenceHighWater().toString(),
      nodeCount,
      edgeCount,
      tombstonedEdgeCount: 0,
      appliedBatchCount: live.length,
      rolledBackBatchCount: batches.length - live.length,
      checkpointSequence: this.#checkpointSequence().toString(),
      completeness: this.#completeness(),
      authorityState: this.#authorityUnavailable
        ? "unavailable"
        : "available",
    });
  }

  async evaluateConformanceEvidencePath(
    query: SharedStateClaimGraphConformanceEvidenceQueryV1,
  ): Promise<unknown> {
    const completeness = this.#completeness();
    const checkpoint = this.#checkpointSequence();
    const highWater = this.#sourceSequenceHighWater();
    const claim = BigInt(query.claimOrdinal);
    const evidenceSequence = BigInt(query.evidenceOrdinal);

    // A batch contributes the edge `from -> evidence` when the evidence
    // sequence is a later member of the same range.
    const supportingEdgeCount = this.#liveBatches().filter(
      (batch) =>
        !batch.rolledBack
        && batch.from === claim
        && evidenceSequence > batch.from
        && evidenceSequence <= batch.through,
    ).length;

    let result: string;
    if (completeness === "unavailable") {
      result = "projection_unavailable";
    } else if (supportingEdgeCount > 0) {
      result = "path_found";
    } else if (completeness === "complete") {
      // Spec 5.6 permits the negative judgment only at a complete checkpoint.
      result = "no_evidence_path";
    } else {
      result = "projection_incomplete";
    }

    const lag = Number(highWater - checkpoint);
    return sharedStateClaimGraphEvidenceResultV1Schema.parse({
      kind: "SharedStateClaimGraphConformanceEvidenceResultV1",
      resultVersion: 1,
      scope: "test-only-claim-graph-conformance-control",
      result,
      completeness,
      asOfSourceSequence: checkpoint.toString(),
      checkpointSequence: checkpoint.toString(),
      sourceSequenceHighWater: highWater.toString(),
      lag: lag < 0 ? 0 : lag,
      supportingEdgeCount,
    });
  }
}

interface TargetFixtureV1 {
  readonly factory: SharedStateClaimGraphConformanceTargetFactoryV1;
  readonly dispose: () => void;
  readonly faults: readonly FaultStateV1[];
}

/**
 * Every target gets its own temporary database file, which is what the
 * harness's `factory-created-per-scenario` isolation means for a real
 * backend: separate files, separate exclusive owners, no shared handle.
 */
function createSqliteClaimGraphTargetFixtureV1(input: {
  readonly adversarial?: AdversarialSqliteClaimGraphControlV1;
  readonly triggerFragment?: string;
} = {}): TargetFixtureV1 {
  const adversarial = input.adversarial ?? {};
  const triggerFragment =
    input.triggerFragment ?? CHECKPOINT_WRITE_SQL_FRAGMENT;
  const directories: string[] = [];
  const handles: DatabaseSync[] = [];
  const faults: FaultStateV1[] = [];
  let ordinal = 0;

  const factory: SharedStateClaimGraphConformanceTargetFactoryV1 =
    Object.freeze({
      async create(): Promise<SharedStateClaimGraphConformanceTargetV1> {
        ordinal += 1;
        const directory = mkdtempSync(
          join(tmpdir(), "shared-state-claim-graph-target-v1-"),
        );
        directories.push(directory);
        const db = new DatabaseSync(join(directory, "v1.db"));
        handles.push(db);
        assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);

        const fault: FaultStateV1 = {
          armed: null,
          fired: false,
          firedCount: 0,
          triggerFragment,
          preparedSql: [],
        };
        faults.push(fault);

        return new SqliteClaimGraphConformanceTargetV1({
          adapter: new SharedStateSqliteAdapterV1({
            db: createFaultInjectingHandleV1(db, fault),
            ownerToken: `claim-graph-conformance-owner-${ordinal}`,
            backwardSkewToleranceMs: "0",
          }),
          reads: db,
          fault,
          adversarial,
        });
      },
    });

  return {
    factory,
    faults,
    dispose(): void {
      for (const handle of handles) handle.close();
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

async function expectConformanceErrorCode(
  adversarial: AdversarialSqliteClaimGraphControlV1,
  expected: string,
): Promise<void> {
  const fixture = createSqliteClaimGraphTargetFixtureV1({ adversarial });
  try {
    await assert.rejects(
      runSharedStateClaimGraphConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateClaimGraphConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStateClaimGraphConformanceErrorV1)) {
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

test("keeps the SQLite conformance target separate from the Q3 query", () => {
  assert.deepEqual(TEST_ONLY_SQLITE_CLAIM_GRAPH_TARGET_V1, {
    label: "test-only-sqlite-claim-graph-conformance-target",
    production: false,
    sqlite: true,
    shared: false,
    attachedToBrokerRuntime: false,
    adapterApiChanged: false,
    faultSeam: "test-only-database-handle-proxy-not-adapter-api",
    evidenceSeam: "test-only-control-not-a-v1-query",
    graphMaterialization: "derived-from-live-batch-ranges",
    overlappingBatchesAssumedAbsent: true,
    repeatItemChecked: false,
  });
});

test("keeps every conformance seam off the adapter's public surface", () => {
  const seamNames = [
    "captureConformanceSnapshot",
    "armConformanceProjectionFault",
    "evaluateConformanceEvidencePath",
    "snapshot",
    "armFault",
  ];
  for (const name of seamNames) {
    assert.equal(
      name in SharedStateSqliteAdapterV1.prototype,
      false,
      `adapter must not expose ${name}`,
    );
  }
  // The lifecycle/write members plus the one closed query dispatcher, and
  // nothing else. In particular, no graph conformance seam is public.
  const own = Object.getOwnPropertyNames(SharedStateSqliteAdapterV1.prototype)
    .filter((name) => name !== "constructor")
    .sort();
  assert.deepEqual(own, [
    "beginWrite",
    "close",
    "drain",
    "lifecycle",
    "lifecycleEpoch",
    "open",
    "ownerToken",
    "query",
    "transact",
  ]);
});

test("runs the Phase 2.7 harness through the V1 SQLite adapter", async () => {
  const fixture = createSqliteClaimGraphTargetFixtureV1();
  try {
    const report = await runSharedStateClaimGraphConformanceV1(
      fixture.factory,
    );
    assert.equal(report.status, "passed");
    assert.equal(report.scope, "claim-graph-projection-rollback");
    assert.equal(report.contractVersion, V.versions.contract);
    assert.equal(
      report.controls.targetIsolation,
      "factory-created-per-scenario",
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * All-or-none is only meaningful if the batch row was actually written before
 * the fault fired. A fault that lands before any write would leave the same
 * observable state and prove nothing, and the harness cannot tell the two
 * apart — so the ordering is asserted directly here rather than through it.
 */
test("injects the fault after the batch write and before the checkpoint", async () => {
  const fixture = createSqliteClaimGraphTargetFixtureV1();
  try {
    await runSharedStateClaimGraphConformanceV1(fixture.factory);

    const faulted = fixture.faults.filter((fault) => fault.firedCount > 0);
    assert.equal(
      faulted.length,
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.faultControlCount,
    );
    const prepared = faulted[0]!.preparedSql;

    const batchIndex = prepared.findIndex((sql) =>
      sql.includes(BATCH_WRITE_SQL_FRAGMENT),
    );
    const checkpointIndex = prepared.findIndex((sql) =>
      sql.includes(CHECKPOINT_WRITE_SQL_FRAGMENT),
    );
    assert.notEqual(batchIndex, -1);
    assert.notEqual(checkpointIndex, -1);
    assert.equal(batchIndex < checkpointIndex, true);
  } finally {
    fixture.dispose();
  }
});

test("fails the harness when a rolled-back batch stays in the derivation", async () => {
  await expectConformanceErrorCode(
    { deriveIncludingRolledBackBatches: true },
    "rollback_restoration_mismatch",
  );
});

test("fails the harness when the armed fault is never injected", async () => {
  await expectConformanceErrorCode(
    { skipFaultInjection: true },
    "checkpoint_advanced_on_fault",
  );
});

test("fails the harness when the authority stays available after a fault", async () => {
  await expectConformanceErrorCode(
    { authorityStaysAvailableAfterFault: true },
    "evidence_path_mismatch",
  );
});

test("records the Phase 2.7 harness bounds this target actually ran", async () => {
  const fixture = createSqliteClaimGraphTargetFixtureV1();
  try {
    await runSharedStateClaimGraphConformanceV1(fixture.factory);
    assert.equal(
      fixture.faults.length,
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.targetCount,
    );
    const fired = fixture.faults.reduce(
      (total, fault) => total + fault.firedCount,
      0,
    );
    assert.equal(
      fired,
      SHARED_STATE_CLAIM_GRAPH_CONFORMANCE_V1.faultControlCount,
    );
  } finally {
    fixture.dispose();
  }
});
