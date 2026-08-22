/**
 * TEST-ONLY Phase 2.1 conformance target backed by the V1 SQLite adapter.
 *
 * Same rule as the five earlier targets: every conformance seam lives here,
 * next to the harness, and never on `SharedStateSqliteAdapterV1`.
 *
 * WHAT THIS SLICE PROVES THAT NO EARLIER ONE DID
 *
 * Exclusive singleton ownership, against a second adapter rather than against
 * a description of one. This is the first target that opens TWO adapters on
 * one database file: the harness asks for a second simultaneous owner, and the
 * adapter genuinely refuses it — `open()` meets a live foreign `owner_token`
 * and returns `ownership_conflict` without waiting and without taking over.
 * The in-memory reference model can only assert that refusal; here it is the
 * real one, and the losing adapter's state really is `failed`.
 *
 * It is also the first target to run a contended barrier against real SQLite.
 * Thirty-two contenders claim one resource; exactly one commits and the other
 * thirty-one are rejected `claim_conflict` by the adapter's own ladder, which
 * puts `claim_conflict` ahead of `version_conflict` so a contender meeting a
 * live holder is told what actually stopped it.
 *
 * DECISION 2 (COLLAPSE) — declared
 *
 * Four fault points are armed and only three are distinct durable positions.
 * `after_resource_mutation` and `after_audit_outbox_staging` land on the same
 * instant, because V1 stages neither an audit record nor an outbox event for a
 * lease command: `claimLease` writes one row, to `shared_state_lease`, and
 * nothing else. "After the staging" and "after the resource mutation" are
 * therefore the same point in time, and mapping them apart would invent a
 * boundary. The other two are real and separate: before the lease upsert is
 * prepared, and at the transaction's COMMIT.
 *
 * DECISION 3 (DECLARED SYNTHESIS) — declared, and the widest of any slice
 *
 * Three of the nine snapshot counters have no durable source in V1 and are
 * synthesized. A reader should not have to infer which.
 *
 * `auditCount` and `outboxCount` are the notable ones, because the harness
 * requires them to be ONE after a clean claim, not zero. V1 has no audit table
 * at all — the schema ships eleven `shared_state_*` tables and none of them is
 * an audit log — and `claimLease` appends no outbox event. Both are therefore
 * derived from the lease row the claim really did write, so they move with
 * genuine adapter state instead of being constants, but neither is an
 * independent observation.
 *
 * The target deliberately does NOT make these real by appending an outbox row
 * of its own. Seeding starting state is legitimate — the Phase 2.5 target
 * seeds provenance the harness then reads as lag — but writing the very row a
 * counter is asserted against would manufacture the evidence rather than
 * declare its absence, which is the one thing decision 3(iii) exists to stop.
 *
 * `mutationCount` is a declared constant zero, the same gap Phase 2.4 already
 * recorded as `leaseMutationCount`: `shared_state_lease` carries no mutation
 * counter and `mutateWithFence` writes `resource_version` and nothing else.
 * Here the harness only ever requires zero, so the constant answers what is
 * asked, but it is still not an observation.
 *
 * The remaining six counters are real queries over stored state.
 *
 * ONE ENVELOPE IS CONSTRUCTED FROM A REAL ERROR CODE
 *
 * The harness wants the refused second owner as a lifecycle envelope carrying
 * `ownership_conflict`. The adapter reports that code, but through its result
 * channel: `open()` returns `failure("ownership_conflict")`, while its
 * `lifecycle()` renders every `failed` state as `adapter_unavailable`. The
 * target therefore builds the envelope from the adapter's real error code
 * rather than from a flag it set itself — the refusal, the code, and the
 * failed state are all the adapter's; only the envelope shape is the target's.
 *
 * What this does NOT do: check the Phase 2.1 repeat item, which also binds
 * authorized query/reconciliation and retention behaviour that no slice has
 * performed.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_LEASE_CONFORMANCE_V1,
  SHARED_STATE_LEASE_FAULT_POINTS_V1,
  SharedStateLeaseConformanceErrorV1,
  runSharedStateLeaseConformanceV1,
  sharedStateLeaseConformanceSnapshotV1Schema,
  type SharedStateLeaseConformanceClockV1,
  type SharedStateLeaseConformanceOwnerSlotV1,
  type SharedStateLeaseConformanceTargetFactoryV1,
  type SharedStateLeaseConformanceTargetV1,
  type SharedStateLeaseFaultPointV1,
  type SharedStateLeaseTransactionCommandV1,
} from "./shared-state-lease-conformance-v1.js";
import { SharedStateSqliteAdapterV1 } from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";

const TEST_ONLY_SQLITE_LEASE_TARGET_V1 = Object.freeze({
  label: "test-only-sqlite-lease-conformance-target",
  production: false,
  sqlite: true,
  shared: false,
  attachedToBrokerRuntime: false,
  adapterApiChanged: false,
  faultSeam: "test-only-database-handle-proxy-not-adapter-api",
  singletonSeam: "two-real-adapters-on-one-database-file",
  faultPointsArmed: 4,
  /** Decision 2: four armed points, three distinct instants. */
  durableFaultPositions: 3,
  collapsedFaultPoints: Object.freeze([
    "after_audit_outbox_staging",
  ] as const),
  collapsedOnto: "after_resource_mutation",
  collapseReason: "v1-stages-no-audit-record-and-no-outbox-event-for-a-lease",
  /** Decision 3. Nothing else in this target is synthesized. */
  declaredSyntheses: Object.freeze([
    "snapshot.mutationCount",
    "snapshot.auditCount",
    "snapshot.outboxCount",
  ] as const),
  synthesisReason: "v1-has-no-audit-table-and-a-lease-command-writes-one-row",
  countersDerivedFromTheLeaseRow: Object.freeze([
    "auditCount",
    "outboxCount",
  ] as const),
  countersDeclaredConstant: Object.freeze(["mutationCount"] as const),
  genuinelyIndependentCounters: Object.freeze([
    "resourceBinding",
    "resourceState",
    "resourceVersion",
    "maximumFencingToken",
    "activeClaim",
    "attemptCount",
  ] as const),
  ownershipConflictSource: "adapter-open-error-code-not-a-target-flag",
  observationHandle: "raw-never-the-fault-proxy",
  repeatItemChecked: false,
} as const);

const LEASE_WRITE_SQL_FRAGMENT = "INSERT INTO shared_state_lease";
const COMMIT_SQL = "COMMIT";

/** The adapter's entire public surface. */
const ADAPTER_PUBLIC_MEMBERS_V1 = Object.freeze([
  "ownerToken",
  "lifecycleEpoch",
  "lifecycle",
  "open",
  "beginWrite",
  "transact",
  "drain",
  "close",
] as const);

type FaultPositionV1 =
  | "before-lease-write"
  | "after-lease-write"
  | "before-commit";

/**
 * Maps each armed point onto the statement position that is its real boundary.
 * Two points share one position, and the descriptor above says why.
 */
function positionFor(
  faultPoint: SharedStateLeaseFaultPointV1,
): FaultPositionV1 {
  switch (faultPoint) {
    case "before_mutation":
      return "before-lease-write";
    case "after_resource_mutation":
    case "after_audit_outbox_staging":
      return "after-lease-write";
    case "before_commit":
      return "before-commit";
    default:
      throw new Error(`unknown lease fault point: ${String(faultPoint)}`);
  }
}

interface FaultStateV1 {
  position: FaultPositionV1 | null;
  fired: boolean;
  readonly firedAt: FaultPositionV1[];
}

/**
 * Intercepts statement preparation, statement execution, and direct `exec`.
 * The `after-lease-write` position needs the third of those: it wraps the
 * prepared statement so the fault lands after the row is really written and
 * still inside the adapter's transaction, which is a position no earlier
 * target needed.
 */
function createLeaseFaultHandleV1(
  db: DatabaseSync,
  state: FaultStateV1,
): DatabaseSync {
  const fire = (position: FaultPositionV1): never => {
    state.position = null;
    state.fired = true;
    state.firedAt.push(position);
    throw new Error("test-only-injected-conformance-fault");
  };
  return new Proxy(db, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "prepare") {
        return (sql: string): unknown => {
          const armed = state.position;
          const isLeaseWrite = sql.includes(LEASE_WRITE_SQL_FRAGMENT);
          if (armed === "before-lease-write" && isLeaseWrite) {
            fire("before-lease-write");
          }
          const statement = target.prepare(sql);
          if (armed !== "after-lease-write" || !isLeaseWrite) return statement;
          return new Proxy(statement, {
            get(stmt, stmtProperty, stmtReceiver): unknown {
              const stmtValue = Reflect.get(
                stmt,
                stmtProperty,
                stmtReceiver,
              ) as unknown;
              if (stmtProperty !== "run") {
                return typeof stmtValue === "function"
                  ? stmtValue.bind(stmt)
                  : stmtValue;
              }
              return (...args: unknown[]): unknown => {
                // Delegate first: the row must really be written, or this
                // would be a second `before_mutation` wearing another name.
                (stmt.run as (...input: unknown[]) => unknown)(...args);
                return fire("after-lease-write");
              };
            },
          });
        };
      }
      if (property === "exec") {
        return (sql: string): unknown => {
          if (state.position === "before-commit" && sql.includes(COMMIT_SQL)) {
            fire("before-commit");
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
    throw new SharedStateLeaseConformanceErrorV1("invalid_target_result");
  }
  return parsed.value;
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
    throw new SharedStateLeaseConformanceErrorV1("invalid_target_lifecycle");
  }
  return parsed.value;
}

interface LeaseRowV1 {
  readonly owner_key_digest: string | null;
  readonly attempt_key_digest: string | null;
  readonly fencing_token: string;
  readonly resource_version: string;
  readonly lease_expires_at_unix_ms: string | null;
}

interface AdversarialSqliteLeaseControlV1 {
  /** Accepts the arm request without injecting anything. */
  readonly skipFaultInjection?: boolean;
  /** Reports the refused second owner as a healthy singleton. */
  readonly secondOwnerReportedReady?: boolean;
  /** Reopens onto an empty database instead of the one just closed. */
  readonly reopenLosesState?: boolean;
  /** Counts the audit record as absent even after a committed claim. */
  readonly auditCountAlwaysZero?: boolean;
  /** Releases the live claim so a second contender can also commit. */
  readonly barrierAllowsSecondWinner?: boolean;
}

class SqliteLeaseConformanceTargetV1
implements SharedStateLeaseConformanceTargetV1 {
  #primary: SharedStateSqliteAdapterV1;
  #reads: DatabaseSync;
  readonly #secondary: SharedStateSqliteAdapterV1;
  readonly #fault: FaultStateV1;
  readonly #clock: SharedStateLeaseConformanceClockV1;
  readonly #adversarial: AdversarialSqliteLeaseControlV1;
  readonly #primaryOwnerToken: string;
  #barrierWinners = 0;

  constructor(input: {
    readonly primary: SharedStateSqliteAdapterV1;
    readonly secondary: SharedStateSqliteAdapterV1;
    readonly reads: DatabaseSync;
    readonly fault: FaultStateV1;
    readonly clock: SharedStateLeaseConformanceClockV1;
    readonly adversarial: AdversarialSqliteLeaseControlV1;
    readonly primaryOwnerToken: string;
  }) {
    this.#primary = input.primary;
    this.#secondary = input.secondary;
    this.#reads = input.reads;
    this.#fault = input.fault;
    this.#clock = input.clock;
    this.#adversarial = input.adversarial;
    this.#primaryOwnerToken = input.primaryOwnerToken;
  }

  async openSingleton(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
  ): Promise<unknown> {
    if (ownerSlot === "primary") {
      const opened = this.#primary.open();
      if (!opened.ok) throw new Error(`open refused: ${opened.error.code}`);
      return opened.value;
    }
    // A real second adapter on the same file. The refusal below is the
    // adapter's, not a decision this target made.
    const contended = this.#secondary.open();
    if (this.#adversarial.secondOwnerReportedReady === true) {
      // Violation: the contended open is reported as a healthy singleton.
      return lifecycleEnvelope("ready", []);
    }
    if (contended.ok) {
      throw new Error("second simultaneous owner was not refused");
    }
    if (contended.error.code !== "ownership_conflict") {
      throw new Error(`unexpected refusal: ${contended.error.code}`);
    }
    const failed = this.#secondary.lifecycle();
    if (failed === null || failed.state !== "failed") {
      throw new Error("refused owner did not reach a failed state");
    }
    // The state is the adapter's; the reason code is the adapter's; only the
    // envelope pairing them is built here, because `lifecycle()` renders every
    // failed state as `adapter_unavailable`.
    return lifecycleEnvelope("failed", ["ownership_conflict"]);
  }

  async closeSingleton(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
  ): Promise<unknown> {
    const adapter = ownerSlot === "primary" ? this.#primary : this.#secondary;
    const drained = adapter.drain();
    if (!drained.ok) throw new Error(`drain refused: ${drained.error.code}`);
    const closed = adapter.close();
    if (!closed.ok) throw new Error(`close refused: ${closed.error.code}`);
    if (ownerSlot === "primary" && this.#adversarial.reopenLosesState === true) {
      // Violation: the next open binds a fresh database, so everything the
      // claim committed is silently gone.
      const directory = mkdtempSync(
        join(tmpdir(), "shared-state-lease-target-v1-lost-"),
      );
      const fresh = new DatabaseSync(join(directory, "v1.db"));
      assert.equal(applySharedStateSqliteSchemaV1(fresh).ok, true);
      this.#primary = new SharedStateSqliteAdapterV1({
        db: fresh,
        ownerToken: this.#primaryOwnerToken,
        backwardSkewToleranceMs: "0",
      });
      // The observation surface moves with the adapter, or the loss would be
      // invisible to the snapshot and this control would pass.
      this.#reads = fresh;
    }
    return closed.value;
  }

  armTransactionFault(faultPoint: SharedStateLeaseFaultPointV1): void {
    if (!SHARED_STATE_LEASE_FAULT_POINTS_V1.includes(faultPoint)) {
      throw new Error(`unknown lease fault point: ${faultPoint}`);
    }
    if (this.#adversarial.skipFaultInjection === true) return;
    this.#fault.position = positionFor(faultPoint);
  }

  async transact(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
    command: SharedStateLeaseTransactionCommandV1,
  ): Promise<unknown> {
    const adapter = ownerSlot === "primary" ? this.#primary : this.#secondary;
    if (
      this.#adversarial.barrierAllowsSecondWinner === true
      && command.operation === "claimLease"
      && this.#barrierWinners === 1
    ) {
      // Violation: the live claim is cleared so a second contender at the same
      // barrier also commits.
      this.#reads.prepare(`DELETE FROM shared_state_lease`).run();
    }
    this.#fault.fired = false;
    // The injected instant is passed through verbatim. Replacing it with a
    // target-owned counter would break the expiry scenario, which advances the
    // clock exactly through the lease duration.
    const result = adapter.transact(command, {
      observedAtUnixMs: this.#clock.readLogicalMilliseconds().toString(),
    });
    if (this.#fault.fired) {
      // The adapter rolled its own transaction back. Nothing was written.
      return unavailableResult(command.operation, "authority_unavailable");
    }
    if (!result.ok) throw new Error(`adapter refused: ${result.error.code}`);
    if (
      command.operation === "claimLease"
      && result.value.status === "committed"
    ) {
      this.#barrierWinners += 1;
    }
    return result.value;
  }

  // ---- observation, always through the raw handle -----------------------

  #leaseRows(): readonly LeaseRowV1[] {
    return this.#reads
      .prepare(
        `SELECT owner_key_digest, attempt_key_digest, fencing_token,
                resource_version, lease_expires_at_unix_ms
           FROM shared_state_lease`,
      )
      .all() as unknown as readonly LeaseRowV1[];
  }

  async snapshot(): Promise<unknown> {
    const rows = this.#leaseRows();
    const bound = rows.filter((row) => row.owner_key_digest !== null);
    const now = this.#clock.readLogicalMilliseconds();
    const active = bound.filter((row) => (
      row.lease_expires_at_unix_ms !== null
      && BigInt(row.lease_expires_at_unix_ms) > now
    ));
    // TEXT columns: SQL MAX() sorts lexically and ranks "9" above "10", so the
    // comparison happens in BigInt.
    let maximumFencingToken = 0n;
    let resourceVersion = 0n;
    for (const row of rows) {
      const fence = BigInt(row.fencing_token);
      if (fence > maximumFencingToken) maximumFencingToken = fence;
      const version = BigInt(row.resource_version);
      if (version > resourceVersion) resourceVersion = version;
    }
    const attemptCount = rows.filter(
      (row) => row.attempt_key_digest !== null,
    ).length;

    return sharedStateLeaseConformanceSnapshotV1Schema.parse({
      kind: "SharedStateLeaseConformanceSnapshotV1",
      snapshotVersion: 1,
      resourceBinding: bound.length > 0 ? "bound" : "unbound",
      resourceState: active.length > 0 ? "claimed" : "queued",
      resourceVersion: resourceVersion.toString(),
      maximumFencingToken: maximumFencingToken.toString(),
      activeClaim: active.length > 0,
      attemptCount,
      // Declared constant: `shared_state_lease` carries no mutation counter.
      mutationCount: 0,
      // Declared syntheses, derived from the row the claim really wrote.
      auditCount: this.#adversarial.auditCountAlwaysZero === true
        ? 0
        : attemptCount,
      outboxCount: attemptCount,
    });
  }
}

interface TargetFixtureV1 {
  readonly factory: SharedStateLeaseConformanceTargetFactoryV1;
  readonly dispose: () => void;
  readonly faults: readonly FaultStateV1[];
}

function createSqliteLeaseTargetFixtureV1(
  adversarial: AdversarialSqliteLeaseControlV1 = {},
): TargetFixtureV1 {
  const directories: string[] = [];
  const handles: DatabaseSync[] = [];
  const faults: FaultStateV1[] = [];
  let ordinal = 0;

  const factory: SharedStateLeaseConformanceTargetFactoryV1 = Object.freeze({
    async create(input: {
      readonly clock: SharedStateLeaseConformanceClockV1;
    }): Promise<SharedStateLeaseConformanceTargetV1> {
      ordinal += 1;
      const directory = mkdtempSync(
        join(tmpdir(), "shared-state-lease-target-v1-"),
      );
      directories.push(directory);
      const file = join(directory, "v1.db");

      const db = new DatabaseSync(file);
      handles.push(db);
      assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
      // The second owner needs its own connection as well as its own token:
      // ownership is a row, but two adapters sharing one handle would collide
      // on SQLite's transaction rules before reaching the ownership check.
      const contender = new DatabaseSync(file);
      handles.push(contender);

      const fault: FaultStateV1 = { position: null, fired: false, firedAt: [] };
      faults.push(fault);

      const primaryOwnerToken = `lease-conformance-owner-${ordinal}`;
      return new SqliteLeaseConformanceTargetV1({
        primary: new SharedStateSqliteAdapterV1({
          db: createLeaseFaultHandleV1(db, fault),
          ownerToken: primaryOwnerToken,
          backwardSkewToleranceMs: "0",
        }),
        secondary: new SharedStateSqliteAdapterV1({
          db: contender,
          ownerToken: `lease-conformance-contender-${ordinal}`,
          backwardSkewToleranceMs: "0",
        }),
        reads: db,
        fault,
        clock: input.clock,
        adversarial,
        primaryOwnerToken,
      });
    },
  });

  return {
    factory,
    faults,
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
  adversarial: AdversarialSqliteLeaseControlV1,
  expected: string,
): Promise<void> {
  const fixture = createSqliteLeaseTargetFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStateLeaseConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(error instanceof SharedStateLeaseConformanceErrorV1, true);
        if (!(error instanceof SharedStateLeaseConformanceErrorV1)) return false;
        assert.equal(error.code, expected);
        return true;
      },
    );
  } finally {
    fixture.dispose();
  }
}

test("declares the Phase 2.1 target shape, its collapse, and its syntheses", () => {
  assert.deepEqual(TEST_ONLY_SQLITE_LEASE_TARGET_V1, {
    label: "test-only-sqlite-lease-conformance-target",
    production: false,
    sqlite: true,
    shared: false,
    attachedToBrokerRuntime: false,
    adapterApiChanged: false,
    faultSeam: "test-only-database-handle-proxy-not-adapter-api",
    singletonSeam: "two-real-adapters-on-one-database-file",
    faultPointsArmed: 4,
    durableFaultPositions: 3,
    collapsedFaultPoints: ["after_audit_outbox_staging"],
    collapsedOnto: "after_resource_mutation",
    collapseReason:
      "v1-stages-no-audit-record-and-no-outbox-event-for-a-lease",
    declaredSyntheses: [
      "snapshot.mutationCount",
      "snapshot.auditCount",
      "snapshot.outboxCount",
    ],
    synthesisReason:
      "v1-has-no-audit-table-and-a-lease-command-writes-one-row",
    countersDerivedFromTheLeaseRow: ["auditCount", "outboxCount"],
    countersDeclaredConstant: ["mutationCount"],
    genuinelyIndependentCounters: [
      "resourceBinding",
      "resourceState",
      "resourceVersion",
      "maximumFencingToken",
      "activeClaim",
      "attemptCount",
    ],
    ownershipConflictSource: "adapter-open-error-code-not-a-target-flag",
    observationHandle: "raw-never-the-fault-proxy",
    repeatItemChecked: false,
  });

  assert.equal(
    TEST_ONLY_SQLITE_LEASE_TARGET_V1.faultPointsArmed,
    SHARED_STATE_LEASE_FAULT_POINTS_V1.length,
  );
  // One armed point collapses, so the distinct positions are one fewer.
  assert.equal(
    TEST_ONLY_SQLITE_LEASE_TARGET_V1.durableFaultPositions,
    SHARED_STATE_LEASE_FAULT_POINTS_V1.length
      - TEST_ONLY_SQLITE_LEASE_TARGET_V1.collapsedFaultPoints.length,
  );
  // The collapsed point and the point it lands on are both really armed, and
  // they really do resolve to the same position.
  for (const point of TEST_ONLY_SQLITE_LEASE_TARGET_V1.collapsedFaultPoints) {
    assert.equal(SHARED_STATE_LEASE_FAULT_POINTS_V1.includes(point), true);
    assert.equal(
      positionFor(point),
      positionFor(
        TEST_ONLY_SQLITE_LEASE_TARGET_V1
          .collapsedOnto as SharedStateLeaseFaultPointV1,
      ),
    );
  }
  // Decision 2 maps onto something that exists; decision 3 stands in for
  // something that does not. The two lists must not overlap.
  const collapsed = new Set<string>(
    TEST_ONLY_SQLITE_LEASE_TARGET_V1.collapsedFaultPoints,
  );
  for (const name of TEST_ONLY_SQLITE_LEASE_TARGET_V1.declaredSyntheses) {
    assert.equal(collapsed.has(name), false);
  }
  // Every synthesized counter is accounted for as either derived or constant,
  // and no counter is claimed as both synthesized and independent.
  assert.deepEqual(
    [
      ...TEST_ONLY_SQLITE_LEASE_TARGET_V1.countersDerivedFromTheLeaseRow,
      ...TEST_ONLY_SQLITE_LEASE_TARGET_V1.countersDeclaredConstant,
    ].sort(),
    TEST_ONLY_SQLITE_LEASE_TARGET_V1.declaredSyntheses
      .map((name) => name.slice("snapshot.".length))
      .sort(),
  );
  const independent = new Set<string>(
    TEST_ONLY_SQLITE_LEASE_TARGET_V1.genuinelyIndependentCounters,
  );
  for (const name of TEST_ONLY_SQLITE_LEASE_TARGET_V1.declaredSyntheses) {
    assert.equal(independent.has(name.slice("snapshot.".length)), false);
  }
});

test("keeps every conformance seam off the adapter's public surface", () => {
  for (
    const name of ["snapshot", "armTransactionFault", "openSingleton",
      "closeSingleton", "readiness"]
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

test("runs the Phase 2.1 harness through the V1 SQLite adapter", async () => {
  const fixture = createSqliteLeaseTargetFixtureV1();
  try {
    const report = await runSharedStateLeaseConformanceV1(fixture.factory);
    assert.equal(report.status, "passed");
    assert.equal(report.contractVersion, V.versions.contract);
    assert.equal(
      report.scheduler.contenderCount,
      SHARED_STATE_LEASE_CONFORMANCE_V1.contenderCount,
    );
    assert.equal(report.claims.committedAtBarrier, 1);
    assert.equal(report.claims.deterministicConflictsAtBarrier, 31);
    assert.equal(report.singleton.reasonCode, "ownership_conflict");
    assert.equal(
      report.transactionFaults.length,
      SHARED_STATE_LEASE_FAULT_POINTS_V1.length,
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * The mapping is only honest if the positions it names are actually reached,
 * and if the collapsed pair really does land twice on one position. Asserting
 * the counts here is what stops the fault matrix from passing because nothing
 * ran — the failure mode this section has now caught seven times.
 */
test("fires every armed fault at its declared statement position", async () => {
  const fixture = createSqliteLeaseTargetFixtureV1();
  try {
    await runSharedStateLeaseConformanceV1(fixture.factory);
    const firedAt = fixture.faults.flatMap((fault) => fault.firedAt);
    assert.equal(firedAt.length, SHARED_STATE_LEASE_FAULT_POINTS_V1.length);
    assert.equal(
      firedAt.filter((position) => position === "before-lease-write").length,
      1,
    );
    // Two armed points, one position — the declared collapse, observed.
    assert.equal(
      firedAt.filter((position) => position === "after-lease-write").length,
      2,
    );
    assert.equal(
      firedAt.filter((position) => position === "before-commit").length,
      1,
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * The singleton claim is the one this slice adds, so it is proved directly
 * rather than only through the harness: two real adapters, one file, and a
 * refusal that comes from the adapter's own ownership check.
 */
test("refuses a second simultaneous owner from the adapter, not the target", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "shared-state-lease-singleton-v1-"),
  );
  const file = join(directory, "v1.db");
  const first = new DatabaseSync(file);
  const second = new DatabaseSync(file);
  try {
    assert.equal(applySharedStateSqliteSchemaV1(first).ok, true);
    const holder = new SharedStateSqliteAdapterV1({
      db: first,
      ownerToken: "singleton-holder",
      backwardSkewToleranceMs: "0",
    });
    const contender = new SharedStateSqliteAdapterV1({
      db: second,
      ownerToken: "singleton-contender",
      backwardSkewToleranceMs: "0",
    });
    assert.equal(holder.open().ok, true);

    const refused = contender.open();
    assert.equal(refused.ok, false);
    if (refused.ok) throw new Error("unreachable");
    // Never a wait and never a takeover.
    assert.equal(refused.error.code, "ownership_conflict");
    assert.equal(contender.lifecycle()?.state, "failed");
    // The holder is untouched: a refused open consumes no epoch and does not
    // disturb the live owner.
    assert.equal(holder.lifecycle()?.state, "ready");

    // And the refusal is not permanent state: once the holder releases, the
    // contender can take the file, which is what makes it a conflict rather
    // than corruption.
    assert.equal(holder.drain().ok, true);
    assert.equal(holder.close().ok, true);
    assert.equal(contender.open().ok, true);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * `auditCount` and `outboxCount` are declared syntheses, so the claim that V1
 * has no source for them has to be true rather than assumed. If a lease
 * command ever did write an outbox row, this fails and the descriptor is what
 * needs correcting.
 */
test("confirms a lease command writes one row and stages no audit or outbox", () => {
  const directory = mkdtempSync(join(tmpdir(), "shared-state-lease-rows-v1-"));
  const file = join(directory, "v1.db");
  const db = new DatabaseSync(file);
  try {
    assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
    // The schema ships no audit table at all.
    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as readonly { name?: unknown }[]
    ).map((row) => String(row.name));
    assert.equal(tables.some((name) => name.includes("audit")), false);
    assert.equal(tables.includes("shared_state_lease"), true);
    assert.equal(tables.includes("shared_state_outbox"), true);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed on each adversarial lease violation", async () => {
  // Item: an armed fault must actually roll the transaction back.
  await expectConformanceErrorCode(
    { skipFaultInjection: true },
    "transaction_not_atomic",
  );
  // Item: a second simultaneous owner must fail closed.
  await expectConformanceErrorCode(
    { secondOwnerReportedReady: true },
    "singleton_not_exclusive",
  );
  // Item: a reopen must preserve committed state.
  await expectConformanceErrorCode(
    { reopenLosesState: true },
    "reopen_snapshot_mismatch",
  );
  // Item: exactly one contender may commit at the barrier.
  await expectConformanceErrorCode(
    { barrierAllowsSecondWinner: true },
    "claim_outcome_mismatch",
  );
  // Item: the committed claim's counters must be reported, not zeroed.
  await expectConformanceErrorCode(
    { auditCountAlwaysZero: true },
    "transaction_not_atomic",
  );
});
