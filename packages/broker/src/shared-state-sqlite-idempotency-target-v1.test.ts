/**
 * TEST-ONLY Phase 2.2 conformance target backed by the V1 SQLite adapter.
 *
 * Same rule as the Phase 2.7 target: the seams live here, next to the
 * harness, and never on `SharedStateSqliteAdapterV1`. A snapshot or a fault
 * switch on the adapter would be a storage API the contract does not
 * register.
 *
 * This target is the first to use the recorded decision that a conformance
 * target may DECLARE a fault-point collapse. The Phase 2.2 harness arms four
 * in-transaction fault points, and V1 does not durably have four distinct
 * instants to arm them at:
 *
 * - `after_reservation` and `after_domain_mutation` both mean "nothing
 *   durable written yet". V1 performs no reservation and executes no domain
 *   mutation of its own — it records an outcome bound to what the caller
 *   DECLARED the mutation to be. Both map to the first write statement.
 * - `after_outbox_staging` maps to the outcome write, so the link row exists
 *   and is rolled back with everything else.
 * - `after_outcome_staging` maps to the commit itself.
 *
 * That is three real positions for four points, and the collapse is stated in
 * `TEST_ONLY_SQLITE_IDEMPOTENCY_TARGET_V1` rather than hidden. No boundary is
 * fabricated, and the adapter did not grow a durable write with no effect
 * behind it to manufacture one.
 *
 * The same collapse reaches the snapshot counters, which is an extension of
 * that decision from fault points to counts and is flagged as such. V1 keeps
 * ONE durable record per executed effect. `reservationCount`,
 * `domainMutationCount`, and `stableOutcomeCount` are therefore all derived
 * from the idempotency row, and `outboxAppendCount` from the link row written
 * in the same transaction. The counts still answer the question the harness
 * asks — did exactly one effect happen — but they are not four independent
 * observations, and the descriptor says which ones share a row.
 *
 * `pendingReservationCount` is the one counter that is genuinely zero rather
 * than collapsed: V1 has no reservation to leave pending.
 *
 * The fault seam intercepts `prepare` AND `exec`, because `BEGIN IMMEDIATE`,
 * `COMMIT`, and `ROLLBACK` are issued through `exec`. The Phase 2.7 target
 * needed only `prepare`; a commit-boundary fault point needs both.
 *
 * What this does NOT do: check the Phase 2.2 repeat item. That item also
 * requires separately proving authorized retention/prune behavior, which is
 * not this slice and not an adapter decision.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1,
  SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1,
  SharedStateIdempotencyConformanceErrorV1,
  runSharedStateIdempotencyConformanceV1,
  type SharedStateExecuteIdempotentCommandV1,
  type SharedStateIdempotencyConformanceClockV1,
  type SharedStateIdempotencyConformanceTargetFactoryV1,
  type SharedStateIdempotencyConformanceTargetV1,
  type SharedStateIdempotencyFaultPointV1,
} from "./shared-state-idempotency-conformance-v1.js";
import { SharedStateSqliteAdapterV1 } from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";

/**
 * States what this target is and, explicitly, where V1 has fewer durable
 * instants than the reference model has in-memory steps. A reader should be
 * able to see the collapse without reading the implementation.
 */
const TEST_ONLY_SQLITE_IDEMPOTENCY_TARGET_V1 = Object.freeze({
  label: "test-only-sqlite-idempotency-conformance-target",
  production: false,
  sqlite: true,
  shared: false,
  attachedToBrokerRuntime: false,
  adapterApiChanged: false,
  faultSeam: "test-only-database-handle-proxy-not-adapter-api",
  faultPointsArmed: 5,
  durableFaultPositions: 3,
  collapsedFaultPoints: Object.freeze([
    "after_reservation",
    "after_domain_mutation",
  ] as const),
  collapseReason: "v1-performs-no-reservation-and-no-domain-mutation",
  countersDerivedFromTheIdempotencyRow: Object.freeze([
    "reservationCount",
    "domainMutationCount",
    "stableOutcomeCount",
  ] as const),
  countersDerivedFromTheLinkRow: Object.freeze([
    "outboxAppendCount",
  ] as const),
  genuinelyIndependentCounters: Object.freeze([
    "pendingReservationCount",
  ] as const),
  repeatItemChecked: false,
} as const);

const COMMIT_SQL = "COMMIT";
const LINK_WRITE_SQL_FRAGMENT =
  "INSERT INTO shared_state_idempotency_outbox_link";
const OUTCOME_WRITE_SQL_FRAGMENT = "INSERT INTO shared_state_idempotency\n";

/**
 * Maps each armed transaction fault point onto the statement that is the
 * nearest real boundary for it. Two points share the first write because V1
 * has nothing durable before it.
 */
function triggerFor(
  faultPoint: SharedStateIdempotencyFaultPointV1,
): { readonly kind: "prepare" | "exec"; readonly fragment: string } | null {
  switch (faultPoint) {
    case "after_reservation":
    case "after_domain_mutation":
      return { kind: "prepare", fragment: LINK_WRITE_SQL_FRAGMENT };
    case "after_outbox_staging":
      return { kind: "prepare", fragment: OUTCOME_WRITE_SQL_FRAGMENT };
    case "after_outcome_staging":
      return { kind: "exec", fragment: COMMIT_SQL };
    default:
      // `after_commit_before_response` is not a statement fault: the
      // transaction must genuinely commit first.
      return null;
  }
}

interface AdversarialSqliteIdempotencyControlV1 {
  /** Reports the link row's count as a second, independent effect. */
  readonly doubleCountOutboxAppends?: boolean;
  /** Accepts the arm request without injecting anything. */
  readonly skipFaultInjection?: boolean;
  /**
   * Injects the post-commit control but not the statement triggers, so the
   * transaction fault matrix is exercised with nothing armed. Without this the
   * blanket skip fails at the earlier ambiguous-commit scenario and the
   * statement mapping is never tested at all.
   */
  readonly skipTransactionFaultInjection?: boolean;
  /** Rolls the transaction back instead of committing it before answering. */
  readonly ambiguousCommitRollsBack?: boolean;
}

interface FaultStateV1 {
  trigger: { readonly kind: "prepare" | "exec"; readonly fragment: string }
    | null;
  fired: boolean;
  firedCount: number;
  readonly prepared: string[];
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
  const fire = (): never => {
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
          state.prepared.push(sql);
          if (
            state.trigger?.kind === "prepare"
            && sql.includes(state.trigger.fragment)
          ) {
            fire();
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
            fire();
          }
          return target.exec(sql);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseSync;
}

function unavailableResult(reasonCode: string): unknown {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "executeIdempotent",
    consistency: V.operationConsistency.executeIdempotent,
    status: "unavailable",
    completeness: "unavailable",
    reasonCode,
  });
  if (!parsed.ok) {
    throw new SharedStateIdempotencyConformanceErrorV1(
      "invalid_target_result",
    );
  }
  return parsed.value;
}

class SqliteIdempotencyConformanceTargetV1
implements SharedStateIdempotencyConformanceTargetV1 {
  readonly #adapter: SharedStateSqliteAdapterV1;
  readonly #reads: DatabaseSync;
  readonly #clock: SharedStateIdempotencyConformanceClockV1;
  readonly #fault: FaultStateV1;
  readonly #adversarial: AdversarialSqliteIdempotencyControlV1;
  #armedAmbiguousCommit = false;

  constructor(input: {
    readonly adapter: SharedStateSqliteAdapterV1;
    readonly reads: DatabaseSync;
    readonly clock: SharedStateIdempotencyConformanceClockV1;
    readonly fault: FaultStateV1;
    readonly adversarial: AdversarialSqliteIdempotencyControlV1;
  }) {
    this.#adapter = input.adapter;
    this.#reads = input.reads;
    this.#clock = input.clock;
    this.#fault = input.fault;
    this.#adversarial = input.adversarial;
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
    return closed.value;
  }

  armFault(faultPoint: SharedStateIdempotencyFaultPointV1): void {
    if (!SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1.includes(faultPoint)) {
      throw new Error(`unknown idempotency fault point: ${faultPoint}`);
    }
    if (this.#adversarial.skipFaultInjection === true) return;
    if (faultPoint === "after_commit_before_response") {
      this.#armedAmbiguousCommit = true;
      return;
    }
    if (this.#adversarial.skipTransactionFaultInjection === true) return;
    this.#fault.trigger = triggerFor(faultPoint);
  }

  async executeIdempotent(
    command: SharedStateExecuteIdempotentCommandV1,
  ): Promise<unknown> {
    this.#fault.fired = false;
    const observedAtUnixMs = this.#clock.readLogicalMilliseconds().toString();

    if (this.#armedAmbiguousCommit) {
      this.#armedAmbiguousCommit = false;
      if (this.#adversarial.ambiguousCommitRollsBack === true) {
        // Violation: the caller is told the commit is ambiguous while nothing
        // was actually written, so a retry would execute a second time.
        return unavailableResult("ambiguous_commit");
      }
      // The transaction really commits. Only the answer is lost, which is
      // exactly what an ambiguous commit is.
      const committed = this.#adapter.transact(command, { observedAtUnixMs });
      if (!committed.ok) throw new Error(`adapter refused: ${committed.error}`);
      return unavailableResult("ambiguous_commit");
    }

    const result = this.#adapter.transact(command, { observedAtUnixMs });
    if (this.#fault.fired) {
      // The adapter rolled its own transaction back. Nothing was written.
      return unavailableResult("authority_unavailable");
    }
    if (!result.ok) throw new Error(`adapter refused: ${result.error}`);
    return result.value;
  }

  #count(table: string): number {
    const row = this.#reads
      .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
      .get() as { total?: unknown };
    return Number(row.total);
  }

  async snapshot(): Promise<unknown> {
    const outcomes = this.#count("shared_state_idempotency");
    const links = this.#count("shared_state_idempotency_outbox_link");
    return Object.freeze({
      kind: "SharedStateIdempotencyConformanceSnapshotV1",
      snapshotVersion: 1,
      // One durable record stands for the reservation, the declared domain
      // mutation, and the stable outcome. The descriptor above says so.
      reservationCount: outcomes,
      // V1 has no reservation to leave pending. This zero is real.
      pendingReservationCount: 0,
      domainMutationCount: outcomes,
      outboxAppendCount:
        this.#adversarial.doubleCountOutboxAppends === true
          ? links * 2
          : links,
      stableOutcomeCount: outcomes,
    });
  }
}

interface TargetFixtureV1 {
  readonly factory: SharedStateIdempotencyConformanceTargetFactoryV1;
  readonly dispose: () => void;
  readonly faults: readonly FaultStateV1[];
}

function createSqliteIdempotencyTargetFixtureV1(
  adversarial: AdversarialSqliteIdempotencyControlV1 = {},
): TargetFixtureV1 {
  const directories: string[] = [];
  const handles: DatabaseSync[] = [];
  const faults: FaultStateV1[] = [];
  let ordinal = 0;

  const factory: SharedStateIdempotencyConformanceTargetFactoryV1 =
    Object.freeze({
      async create(input: {
        readonly clock: SharedStateIdempotencyConformanceClockV1;
      }): Promise<SharedStateIdempotencyConformanceTargetV1> {
        ordinal += 1;
        const directory = mkdtempSync(
          join(tmpdir(), "shared-state-idempotency-target-v1-"),
        );
        directories.push(directory);
        const db = new DatabaseSync(join(directory, "v1.db"));
        handles.push(db);
        assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);

        const fault: FaultStateV1 = {
          trigger: null,
          fired: false,
          firedCount: 0,
          prepared: [],
        };
        faults.push(fault);

        return new SqliteIdempotencyConformanceTargetV1({
          adapter: new SharedStateSqliteAdapterV1({
            db: createFaultInjectingHandleV1(db, fault),
            ownerToken: `idempotency-conformance-owner-${ordinal}`,
            backwardSkewToleranceMs: "0",
          }),
          reads: db,
          clock: input.clock,
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
  adversarial: AdversarialSqliteIdempotencyControlV1,
  expected: string,
): Promise<void> {
  const fixture = createSqliteIdempotencyTargetFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStateIdempotencyConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateIdempotencyConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStateIdempotencyConformanceErrorV1)) {
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

test("declares the Phase 2.2 fault-point and counter collapse", () => {
  assert.deepEqual(TEST_ONLY_SQLITE_IDEMPOTENCY_TARGET_V1, {
    label: "test-only-sqlite-idempotency-conformance-target",
    production: false,
    sqlite: true,
    shared: false,
    attachedToBrokerRuntime: false,
    adapterApiChanged: false,
    faultSeam: "test-only-database-handle-proxy-not-adapter-api",
    faultPointsArmed: 5,
    durableFaultPositions: 3,
    collapsedFaultPoints: ["after_reservation", "after_domain_mutation"],
    collapseReason: "v1-performs-no-reservation-and-no-domain-mutation",
    countersDerivedFromTheIdempotencyRow: [
      "reservationCount",
      "domainMutationCount",
      "stableOutcomeCount",
    ],
    countersDerivedFromTheLinkRow: ["outboxAppendCount"],
    genuinelyIndependentCounters: ["pendingReservationCount"],
    repeatItemChecked: false,
  });
  // The declared numbers must match the vocabulary they describe.
  assert.equal(
    TEST_ONLY_SQLITE_IDEMPOTENCY_TARGET_V1.faultPointsArmed,
    SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1.length,
  );
  const distinct = new Set(
    SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1.map((point) => {
      const trigger = triggerFor(point);
      return trigger === null
        ? "after-commit"
        : `${trigger.kind}:${trigger.fragment}`;
    }),
  );
  // Three statement positions plus the post-commit control.
  assert.equal(distinct.size, 4);
  assert.equal(
    TEST_ONLY_SQLITE_IDEMPOTENCY_TARGET_V1.durableFaultPositions,
    distinct.size - 1,
  );
});

test("keeps every conformance seam off the adapter's public surface", () => {
  for (const name of ["snapshot", "armFault", "executeIdempotent"]) {
    assert.equal(
      name in SharedStateSqliteAdapterV1.prototype,
      false,
      `adapter must not expose ${name}`,
    );
  }
});

test("runs the Phase 2.2 harness through the V1 SQLite adapter", async () => {
  const fixture = createSqliteIdempotencyTargetFixtureV1();
  try {
    const report = await runSharedStateIdempotencyConformanceV1(
      fixture.factory,
    );
    assert.equal(report.status, "passed");
    assert.equal(report.scope, "execute-idempotent");
    assert.equal(report.contractVersion, V.versions.contract);
    assert.equal(
      fixture.faults.length,
      SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.targetCount,
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * The collapse is only acceptable because the boundaries it maps onto are
 * real. Each of the three statement positions must actually be reached, in
 * the declared order, or the fault matrix would be passing because nothing
 * ran rather than because everything rolled back.
 */
test("reaches all three declared fault positions in the adapter's order", async () => {
  const fixture = createSqliteIdempotencyTargetFixtureV1();
  try {
    await runSharedStateIdempotencyConformanceV1(fixture.factory);
    const fired = fixture.faults.reduce(
      (total, fault) => total + fault.firedCount,
      0,
    );
    // One per transaction fault point; the post-commit point fires no
    // statement fault at all.
    assert.equal(fired, 4);

    const withStatements = fixture.faults.find((fault) =>
      fault.prepared.some((sql) => sql.includes(OUTCOME_WRITE_SQL_FRAGMENT)),
    );
    assert.notEqual(withStatements, undefined);
    const prepared = withStatements!.prepared;
    const linkIndex = prepared.findIndex((sql) =>
      sql.includes(LINK_WRITE_SQL_FRAGMENT),
    );
    const outcomeIndex = prepared.findIndex((sql) =>
      sql.includes(OUTCOME_WRITE_SQL_FRAGMENT),
    );
    assert.notEqual(linkIndex, -1);
    assert.equal(linkIndex < outcomeIndex, true);
  } finally {
    fixture.dispose();
  }
});

test("fails the harness when the outbox append is double counted", async () => {
  await expectConformanceErrorCode(
    { doubleCountOutboxAppends: true },
    "effect_snapshot_mismatch",
  );
});

test("fails the harness when an armed fault is never injected", async () => {
  await expectConformanceErrorCode(
    { skipFaultInjection: true },
    "ambiguous_commit_mismatch",
  );
});

test("fails the harness when the transaction fault points are not armed", async () => {
  await expectConformanceErrorCode(
    { skipTransactionFaultInjection: true },
    "transaction_not_atomic",
  );
});

test("fails the harness when an ambiguous commit wrote nothing", async () => {
  await expectConformanceErrorCode(
    { ambiguousCommitRollsBack: true },
    "ambiguous_commit_mismatch",
  );
});
