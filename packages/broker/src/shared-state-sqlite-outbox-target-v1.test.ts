/**
 * TEST-ONLY Phase 2.3 conformance target backed by the V1 SQLite adapter.
 *
 * Same rule as the Phase 2.7 and 2.2 targets: the seams live here, next to
 * the harness, and never on `SharedStateSqliteAdapterV1`. A snapshot, a fault
 * switch, or a reconciliation query on the adapter would be a storage API the
 * contract does not register — and section 2.3's reconciliation control is
 * explicitly not a V1 query.
 *
 * Unlike Phase 2.2, this section needs NO fault-point collapse. All three
 * armed points land on distinct real instants:
 *
 * - `domain-before-append` fires as the outbox INSERT is prepared, which is
 *   before any durable write. V1 performs no domain effect of its own, so
 *   "after the domain effect, before the append" is exactly that instant
 *   rather than an approximation of one.
 * - `append-before-commit` fires at the append transaction's COMMIT, with the
 *   row staged inside it.
 * - `ack-before-commit` fires at the acknowledgment transaction's COMMIT.
 *
 * The last two match on the same SQL text because both are commits, but they
 * are different positions in different commands: only one fault is ever armed,
 * and a fault is consumed by the single command that follows it.
 *
 * ONE counter is collapsed and is declared as such. V1 keeps no durable record
 * of a domain effect separate from the event it appended, so
 * `domainEffectCount` is derived from the outbox row count. The harness holds
 * `domainEffectCount === outboxEventCount` at every point it checks, so the
 * count still answers what it asks, but it is not an independent observation.
 * Every other counter is a real query over stored state, including
 * `receiptFailedCount` — that one reads zero because no scenario produces a
 * failed receipt, not because it is hard-coded.
 *
 * The fault seam intercepts `prepare` AND `exec`, because `COMMIT` is issued
 * through `exec`. Snapshot and reconciliation reads use the RAW handle, so a
 * fault armed for a write can never fire while observing state.
 *
 * What this does NOT do: check the Phase 2.3 repeat item. That item also
 * requires separately implementing and proving authorized query/reconciliation
 * and retention/prune behaviour, which is not this slice and not an adapter
 * decision.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1,
  SHARED_STATE_OUTBOX_CONFORMANCE_V1,
  SharedStateOutboxConformanceErrorV1,
  runSharedStateOutboxConformanceV1,
  type SharedStateAcknowledgeOutboxCommandV1,
  type SharedStateAppendOutboxCommandV1,
  type SharedStateOutboxConformanceCursorV1,
  type SharedStateOutboxConformanceFaultPointV1,
  type SharedStateOutboxConformanceTargetFactoryV1,
  type SharedStateOutboxConformanceTargetV1,
  type SharedStateUpdateOutboxReceiptCommandV1,
} from "./shared-state-outbox-conformance-v1.js";
import { SharedStateSqliteAdapterV1 } from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateTransactionResultV1,
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";

/**
 * States what this target is and, explicitly, the one place where V1 has
 * fewer durable observations than the reference model has in-memory ones. A
 * reader should be able to see it without reading the implementation.
 */
const TEST_ONLY_SQLITE_OUTBOX_TARGET_V1 = Object.freeze({
  label: "test-only-sqlite-outbox-conformance-target",
  production: false,
  sqlite: true,
  shared: false,
  attachedToBrokerRuntime: false,
  adapterApiChanged: false,
  faultSeam: "test-only-database-handle-proxy-not-adapter-api",
  reconcileSeam: "test-only-control-not-a-v1-query",
  faultPointsArmed: 3,
  durableFaultPositions: 3,
  collapsedFaultPoints: Object.freeze([] as const),
  collapseReason: "none-v1-has-a-real-instant-for-every-armed-point",
  countersDerivedFromTheOutboxRowCount: Object.freeze([
    "domainEffectCount",
  ] as const),
  genuinelyIndependentCounters: Object.freeze([
    "outboxEventCount",
    "receiptPendingCount",
    "receiptConfirmedCount",
    "receiptFailedCount",
    "unacknowledgedCount",
    "acknowledgedCount",
  ] as const),
  sequenceAllocatedBy: "adapter-not-target",
  repeatItemChecked: false,
} as const);

const COMMIT_SQL = "COMMIT";
const APPEND_WRITE_SQL_FRAGMENT = "INSERT INTO shared_state_outbox";

/**
 * Maps each armed fault point onto the statement that is its real boundary.
 * Nothing is shared here in the way Phase 2.2 had to share: the two commit
 * points belong to different commands.
 */
function triggerFor(
  faultPoint: SharedStateOutboxConformanceFaultPointV1,
): { readonly kind: "prepare" | "exec"; readonly fragment: string } {
  switch (faultPoint) {
    case "domain-before-append":
      return { kind: "prepare", fragment: APPEND_WRITE_SQL_FRAGMENT };
    case "append-before-commit":
    case "ack-before-commit":
      return { kind: "exec", fragment: COMMIT_SQL };
    default:
      throw new Error(`unknown outbox fault point: ${String(faultPoint)}`);
  }
}

interface AdversarialSqliteOutboxControlV1 {
  /** Accepts the arm request without injecting anything. */
  readonly skipFaultInjection?: boolean;
  /** Reports the appended events as twice as many domain effects. */
  readonly doubleCountDomainEffects?: boolean;
  /** Ignores the cursor and replays every unacknowledged event. */
  readonly ignoreReconcileCursor?: boolean;
  /**
   * Includes acknowledged events, ignoring the cursor floor for them. The
   * floor alone already excludes the one acknowledged event, so a control
   * that only dropped the acknowledgment filter never reached the harness
   * check it was meant to exercise.
   */
  readonly replayAcknowledgedEvents?: boolean;
  /** Reopens onto an empty database instead of the one just closed. */
  readonly reopenLosesState?: boolean;
}

interface FaultStateV1 {
  trigger: { readonly kind: "prepare" | "exec"; readonly fragment: string }
    | null;
  fired: boolean;
  firedCount: number;
  readonly firedAt: string[];
}

/**
 * Intercepts both statement preparation and direct execution, so a fault can
 * land at a write or at the commit. Nothing here is reachable from the
 * adapter's public surface.
 */
function createFaultInjectingHandleV1(
  db: DatabaseSync,
  state: FaultStateV1,
): DatabaseSync {
  const fire = (kind: string): never => {
    state.firedAt.push(kind);
    state.trigger = null;
    state.fired = true;
    state.firedCount += 1;
    throw new Error("test-only-injected-conformance-fault");
  };
  return new Proxy(db, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "prepare") {
        return (sql: string): unknown => {
          if (
            state.trigger?.kind === "prepare"
            && sql.includes(state.trigger.fragment)
          ) {
            fire("prepare");
          }
          return target.prepare(sql);
        };
      }
      if (property === "exec") {
        return (sql: string): unknown => {
          if (
            state.trigger?.kind === "exec"
            && sql.includes(state.trigger.fragment)
          ) {
            fire("exec");
          }
          return target.exec(sql);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseSync;
}

function unavailableResult(operation: string, reasonCode: string): unknown {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    consistency:
      V.operationConsistency[operation as keyof typeof V.operationConsistency],
    status: "unavailable",
    completeness: "unavailable",
    reasonCode,
  });
  if (!parsed.ok) {
    throw new SharedStateOutboxConformanceErrorV1("invalid_target_result");
  }
  return parsed.value;
}

interface OutboxStateRowV1 {
  readonly stream_key_digest: string;
  readonly event_key_digest: string;
  readonly stream_sequence: string;
  readonly receipt_state: string;
  readonly acknowledgment_state: string;
}

class SqliteOutboxConformanceTargetV1
implements SharedStateOutboxConformanceTargetV1 {
  #adapter: SharedStateSqliteAdapterV1;
  #reads: DatabaseSync;
  readonly #writes: DatabaseSync;
  readonly #fault: FaultStateV1;
  readonly #adversarial: AdversarialSqliteOutboxControlV1;
  readonly #ownerToken: string;
  /**
   * This section has no time semantics and the harness injects no clock, so
   * the target keeps its own monotonic observation. It must keep rising across
   * a close and reopen, because the adapter persists a clock floor.
   */
  #observed = 1_000;

  constructor(input: {
    readonly adapter: SharedStateSqliteAdapterV1;
    readonly reads: DatabaseSync;
    readonly writes: DatabaseSync;
    readonly fault: FaultStateV1;
    readonly adversarial: AdversarialSqliteOutboxControlV1;
    readonly ownerToken: string;
  }) {
    this.#adapter = input.adapter;
    this.#reads = input.reads;
    this.#writes = input.writes;
    this.#fault = input.fault;
    this.#adversarial = input.adversarial;
    this.#ownerToken = input.ownerToken;
  }

  async open(): Promise<unknown> {
    const opened = this.#adapter.open();
    if (!opened.ok) throw new Error(`adapter open refused: ${opened.error}`);
    return opened.value;
  }

  async close(): Promise<unknown> {
    const drained = this.#adapter.drain();
    if (!drained.ok) throw new Error(`adapter drain refused: ${drained.error}`);
    const closed = this.#adapter.close();
    if (!closed.ok) throw new Error(`adapter close refused: ${closed.error}`);
    if (this.#adversarial.reopenLosesState === true) {
      // Violation: the reopened adapter is bound to a fresh database, so the
      // events committed before the close are silently gone.
      const directory = mkdtempSync(
        join(tmpdir(), "shared-state-outbox-target-v1-lost-"),
      );
      const fresh = new DatabaseSync(join(directory, "v1.db"));
      assert.equal(applySharedStateSqliteSchemaV1(fresh).ok, true);
      this.#adapter = new SharedStateSqliteAdapterV1({
        db: fresh,
        ownerToken: this.#ownerToken,
        backwardSkewToleranceMs: "0",
      });
      // The observation surface has to move with the adapter, or the loss
      // would be invisible to the snapshot and this control would pass.
      this.#reads = fresh;
    }
    return closed.value;
  }

  armFault(faultPoint: SharedStateOutboxConformanceFaultPointV1): void {
    if (!SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1.includes(faultPoint)) {
      throw new Error(`unknown outbox fault point: ${faultPoint}`);
    }
    if (this.#adversarial.skipFaultInjection === true) return;
    this.#fault.trigger = triggerFor(faultPoint);
  }

  #transact(command: SharedStateTransactionCommandV1): unknown {
    this.#fault.fired = false;
    this.#observed += 1;
    const result = this.#adapter.transact(command, {
      observedAtUnixMs: this.#observed.toString(),
    });
    if (this.#fault.fired) {
      // The adapter rolled its own transaction back. Nothing was written.
      return unavailableResult(command.operation, "authority_unavailable");
    }
    if (!result.ok) throw new Error(`adapter refused: ${result.error.code}`);
    return result.value;
  }

  async appendOutbox(
    command: SharedStateAppendOutboxCommandV1,
  ): Promise<unknown> {
    return this.#transact(command);
  }

  async updateOutboxReceipt(
    command: SharedStateUpdateOutboxReceiptCommandV1,
  ): Promise<unknown> {
    return this.#transact(command);
  }

  async acknowledgeOutbox(
    command: SharedStateAcknowledgeOutboxCommandV1,
  ): Promise<unknown> {
    return this.#transact(command);
  }

  /** Reads committed state through the raw handle, never the fault proxy. */
  #rows(): readonly OutboxStateRowV1[] {
    return this.#reads
      .prepare(
        `SELECT stream_key_digest, event_key_digest, stream_sequence,
                receipt_state, acknowledgment_state
           FROM shared_state_outbox`,
      )
      .all() as unknown as readonly OutboxStateRowV1[];
  }

  async snapshot(): Promise<unknown> {
    const rows = this.#rows();
    const count = (predicate: (row: OutboxStateRowV1) => boolean): number =>
      rows.filter(predicate).length;
    return Object.freeze({
      kind: "SharedStateOutboxConformanceSnapshotV1",
      snapshotVersion: 1,
      // V1 keeps no domain-effect record apart from the event it appended.
      // The descriptor above says so.
      domainEffectCount:
        this.#adversarial.doubleCountDomainEffects === true
          ? rows.length * 2
          : rows.length,
      outboxEventCount: rows.length,
      receiptPendingCount: count((row) => row.receipt_state === "pending"),
      receiptConfirmedCount: count((row) => row.receipt_state === "confirmed"),
      // Real query, not a hard-coded zero: no scenario fails a receipt.
      receiptFailedCount: count((row) => row.receipt_state === "failed"),
      unacknowledgedCount: count(
        (row) => row.acknowledgment_state === "unacknowledged",
      ),
      acknowledgedCount: count(
        (row) => row.acknowledgment_state === "acknowledged",
      ),
    });
  }

  async reconcileConformanceControl(
    cursor: SharedStateOutboxConformanceCursorV1,
  ): Promise<unknown> {
    const rows = this.#rows();
    const events: Record<string, unknown>[] = [];
    for (const position of cursor.positions) {
      // The cursor carries both a read position and an acknowledged prefix;
      // the effective floor is whichever is further along.
      const after = BigInt(position.afterSequence);
      const acknowledged = BigInt(position.acknowledgedThroughSequence);
      const floor = after > acknowledged ? after : acknowledged;
      const forStream = rows
        .filter((row) => row.stream_key_digest === position.streamKeyDigest)
        .filter((row) => {
          const unacknowledged = row.acknowledgment_state === "unacknowledged";
          if (this.#adversarial.replayAcknowledgedEvents === true) {
            // Acknowledged rows bypass the floor as well, or the floor would
            // hide them and this control would silently pass.
            if (!unacknowledged) return true;
          } else if (!unacknowledged) {
            return false;
          }
          return this.#adversarial.ignoreReconcileCursor === true
            ? true
            : BigInt(row.stream_sequence) > floor;
        })
        .sort((left, right) =>
          BigInt(left.stream_sequence) < BigInt(right.stream_sequence) ? -1 : 1
        );
      for (const row of forStream) {
        events.push({
          streamKeyDigest: row.stream_key_digest,
          eventKeyDigest: row.event_key_digest,
          streamSequence: row.stream_sequence,
          receiptState: row.receipt_state,
          acknowledgmentState: row.acknowledgment_state,
        });
      }
    }
    return Object.freeze({
      kind: "SharedStateOutboxConformanceReconcileResponseV1",
      responseVersion: 1,
      scope: "test-only-conformance-control",
      events,
    });
  }

  /** Kept so the fixture can close the handle it owns. */
  get writes(): DatabaseSync {
    return this.#writes;
  }
}

interface TargetFixtureV1 {
  readonly factory: SharedStateOutboxConformanceTargetFactoryV1;
  readonly dispose: () => void;
  readonly faults: readonly FaultStateV1[];
}

function createSqliteOutboxTargetFixtureV1(
  adversarial: AdversarialSqliteOutboxControlV1 = {},
): TargetFixtureV1 {
  const directories: string[] = [];
  const handles: DatabaseSync[] = [];
  const faults: FaultStateV1[] = [];
  let ordinal = 0;

  const factory: SharedStateOutboxConformanceTargetFactoryV1 = Object.freeze({
    // No argument: this section has no time semantics, so the harness injects
    // no clock. Copying the Phase 2.2 `create({clock})` shape would be wrong.
    async create(): Promise<SharedStateOutboxConformanceTargetV1> {
      ordinal += 1;
      const directory = mkdtempSync(
        join(tmpdir(), "shared-state-outbox-target-v1-"),
      );
      directories.push(directory);
      const db = new DatabaseSync(join(directory, "v1.db"));
      handles.push(db);
      assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);

      const fault: FaultStateV1 = {
        trigger: null,
        fired: false,
        firedCount: 0,
        firedAt: [],
      };
      faults.push(fault);

      const ownerToken = `outbox-conformance-owner-${ordinal}`;
      return new SqliteOutboxConformanceTargetV1({
        adapter: new SharedStateSqliteAdapterV1({
          db: createFaultInjectingHandleV1(db, fault),
          ownerToken,
          backwardSkewToleranceMs: "0",
        }),
        reads: db,
        writes: db,
        fault,
        adversarial,
        ownerToken,
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
  adversarial: AdversarialSqliteOutboxControlV1,
  expected: string,
): Promise<void> {
  const fixture = createSqliteOutboxTargetFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStateOutboxConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateOutboxConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStateOutboxConformanceErrorV1)) {
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

test("declares the Phase 2.3 target shape and its one counter collapse", () => {
  assert.deepEqual(TEST_ONLY_SQLITE_OUTBOX_TARGET_V1, {
    label: "test-only-sqlite-outbox-conformance-target",
    production: false,
    sqlite: true,
    shared: false,
    attachedToBrokerRuntime: false,
    adapterApiChanged: false,
    faultSeam: "test-only-database-handle-proxy-not-adapter-api",
    reconcileSeam: "test-only-control-not-a-v1-query",
    faultPointsArmed: 3,
    durableFaultPositions: 3,
    collapsedFaultPoints: [],
    collapseReason: "none-v1-has-a-real-instant-for-every-armed-point",
    countersDerivedFromTheOutboxRowCount: ["domainEffectCount"],
    genuinelyIndependentCounters: [
      "outboxEventCount",
      "receiptPendingCount",
      "receiptConfirmedCount",
      "receiptFailedCount",
      "unacknowledgedCount",
      "acknowledgedCount",
    ],
    sequenceAllocatedBy: "adapter-not-target",
    repeatItemChecked: false,
  });
  // The declared numbers must match the vocabulary they describe.
  assert.equal(
    TEST_ONLY_SQLITE_OUTBOX_TARGET_V1.faultPointsArmed,
    SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1.length,
  );
  // Unlike Phase 2.2, no two points collapse onto one instant. The two commit
  // points share SQL text but belong to different commands, so the count of
  // real positions equals the count of armed points.
  assert.equal(
    TEST_ONLY_SQLITE_OUTBOX_TARGET_V1.durableFaultPositions,
    SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1.length,
  );
  assert.equal(TEST_ONLY_SQLITE_OUTBOX_TARGET_V1.collapsedFaultPoints.length, 0);
});

test("keeps every conformance seam off the adapter's public surface", () => {
  for (
    const name of [
      "snapshot",
      "armFault",
      "reconcileConformanceControl",
      "appendOutbox",
      "updateOutboxReceipt",
      "acknowledgeOutbox",
    ]
  ) {
    assert.equal(
      name in SharedStateSqliteAdapterV1.prototype,
      false,
      `adapter must not expose ${name}`,
    );
  }
});

test("runs the Phase 2.3 harness through the V1 SQLite adapter", async () => {
  const fixture = createSqliteOutboxTargetFixtureV1();
  try {
    const report = await runSharedStateOutboxConformanceV1(fixture.factory);
    assert.equal(report.status, "passed");
    assert.equal(report.contractVersion, V.versions.contract);
    assert.equal(
      fixture.faults.length,
      SHARED_STATE_OUTBOX_CONFORMANCE_V1.targetCount,
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * The mapping is only honest if the boundaries it names are actually reached.
 * Three faults must fire, and they must fire at the declared statement kinds
 * — otherwise the fault matrix would be passing because nothing ran rather
 * than because everything rolled back.
 */
test("fires every armed fault at its declared statement position", async () => {
  const fixture = createSqliteOutboxTargetFixtureV1();
  try {
    await runSharedStateOutboxConformanceV1(fixture.factory);
    const firedAt = fixture.faults.flatMap((fault) => fault.firedAt);
    // One per armed fault point, each consumed by exactly one command.
    assert.equal(firedAt.length, 3);
    // `domain-before-append` is a write-statement fault; both commit points
    // are exec faults.
    assert.equal(firedAt.filter((kind) => kind === "prepare").length, 1);
    assert.equal(firedAt.filter((kind) => kind === "exec").length, 2);
  } finally {
    fixture.dispose();
  }
});

test("allocates every sequence in the adapter, never in the target", async () => {
  // The registry forbids a caller-supplied sequence and the evaluator scans
  // the whole input tree for one. This asserts the target adds nothing to the
  // commands the harness hands it.
  const source = SqliteOutboxConformanceTargetV1.prototype.appendOutbox
    .toString();
  assert.equal(source.includes("streamSequence"), false);
  assert.equal(source.includes("sequence"), false);
});

test("fails the harness when an armed fault is never injected", async () => {
  await expectConformanceErrorCode(
    { skipFaultInjection: true },
    "transaction_not_atomic",
  );
});

test("fails the harness when domain effects are double counted", async () => {
  // Caught at the retry scenario's first snapshot, which is the earliest
  // point that requires an exact count rather than an unchanged one.
  await expectConformanceErrorCode(
    { doubleCountDomainEffects: true },
    "retry_binding_mismatch",
  );
});

test("fails the harness when reconciliation ignores the cursor", async () => {
  await expectConformanceErrorCode(
    { ignoreReconcileCursor: true },
    "reconcile_invariant_mismatch",
  );
});

test("fails the harness when reconciliation replays acknowledged events", async () => {
  await expectConformanceErrorCode(
    { replayAcknowledgedEvents: true },
    "reconcile_invariant_mismatch",
  );
});

test("fails the harness when a reopen loses committed state", async () => {
  await expectConformanceErrorCode(
    { reopenLosesState: true },
    "reopen_snapshot_mismatch",
  );
});
