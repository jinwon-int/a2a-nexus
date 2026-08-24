/**
 * TEST-ONLY Phase 2.1 conformance target driven through the W1 bounded FIFO
 * worker lane.
 *
 * WHAT THIS ADDS OVER W2a THROUGH W2e
 * Phase 2.1 is the first harness that needs two authorities at once. It opens a
 * second owner against the same file and requires the adapter — not the target
 * — to refuse it, which is the whole proof that the singleton is exclusive.
 * Worker mode expresses that as two sessions on one file with different owner
 * tokens, so the refusal comes from a genuinely separate process boundary
 * rather than from a second object in the same thread. That is a stronger
 * arrangement than inline, where both adapters share an address space.
 *
 * WHY `adapterLifecycle` EXISTS. The harness requires the refused owner to have
 * reached a failed state. The lane's own state is not a substitute: the lane
 * failing alongside the adapter is a coincidental fact, while the claim under
 * test is about the adapter. So the worker reports its adapter's real
 * lifecycle and the target asserts on that.
 *
 * NO MAIN-THREAD BYPASS. This target opens no `DatabaseSync` and holds no raw
 * handle. Even the deliberate lease-clearing violation runs inside the worker
 * that owns the connection.
 *
 * What this does NOT do: it checks neither 488 nor 489. Phase 2.5 still runs
 * inline only, and this proves no delayed-or-missing-ACK query case.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
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
} from "../shared-state-lease-conformance-v1.js";
import {
  SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1,
  type SharedStateSqliteConformanceFaultPlanV1,
} from "../shared-state-sqlite-conformance-control-v1.js";
import {
  createSharedStateSqliteWorkerConformanceSessionV1,
  type SharedStateSqliteWorkerConformanceSessionV1,
} from "../shared-state-sqlite-worker-conformance-session-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionResultV1,
} from "../shared-state-storage-contract-v1.js";

const LEASE_WRITE_SQL_FRAGMENT = "INSERT INTO shared_state_lease";
const COMMIT_SQL = "COMMIT";
const SKEW_TOLERANCE_MS = "0";
const LANE_QUEUE_CAPACITY = 256;

/** Everything worker-mode Phase 2.1 reaches for beyond the lane protocol. */
const LEASE_CONTROLS_USED_V1 = Object.freeze([
  "adapterLifecycle",
  "armFault",
  "leaseClearViolation",
  "leaseRows",
  "readFaultState",
  "setObservedInstant",
] as const);

function faultPlanFor(
  faultPoint: SharedStateLeaseFaultPointV1,
): SharedStateSqliteConformanceFaultPlanV1 {
  switch (faultPoint) {
    case "before_mutation":
      return {
        point: faultPoint,
        sqlFragment: LEASE_WRITE_SQL_FRAGMENT,
        phase: "before-prepare",
        repeating: false,
      };
    case "after_resource_mutation":
    case "after_audit_outbox_staging":
      // The row must really be written before the fault fires, or this is
      // `before_mutation` wearing another name.
      return {
        point: faultPoint,
        sqlFragment: LEASE_WRITE_SQL_FRAGMENT,
        phase: "after-run",
        repeating: false,
      };
    case "before_commit":
      return {
        point: faultPoint,
        sqlFragment: COMMIT_SQL,
        phase: "before-exec",
        repeating: false,
      };
    default:
      throw new Error(`unknown lease fault point: ${String(faultPoint)}`);
  }
}

interface AdversarialWorkerLeaseControlV1 {
  readonly skipFaultInjection?: boolean;
  readonly secondOwnerReportedReady?: boolean;
  readonly reopenLosesState?: boolean;
  readonly auditCountAlwaysZero?: boolean;
  readonly barrierAllowsSecondWinner?: boolean;
}

interface LeaseRowV1 {
  readonly owner_key_digest: string | null;
  readonly attempt_key_digest: string | null;
  readonly fencing_token: string;
  readonly resource_version: string;
  readonly lease_expires_at_unix_ms: string | null;
}

interface FaultStateReplyV1 {
  readonly firedAt: readonly string[];
}

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

function unavailableResult(operation: string, reasonCode: string): unknown {
  const consistency =
    V.operationConsistency[operation as keyof typeof V.operationConsistency];
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    status: "unavailable",
    consistency: { model: consistency.model, scope: consistency.scope },
    completeness: V.resultCompletenessStates[1],
    reasonCode,
  });
  if (!parsed.ok) {
    throw new SharedStateLeaseConformanceErrorV1("invalid_target_result");
  }
  return parsed.value;
}

class WorkerLeaseConformanceTargetV1
implements SharedStateLeaseConformanceTargetV1 {
  readonly #primary: SharedStateSqliteWorkerConformanceSessionV1;
  readonly #secondary: SharedStateSqliteWorkerConformanceSessionV1;
  readonly #clock: SharedStateLeaseConformanceClockV1;
  readonly #adversarial: AdversarialWorkerLeaseControlV1;
  #barrierWinners = 0;
  #seenFiredCount = 0;

  constructor(input: {
    readonly primary: SharedStateSqliteWorkerConformanceSessionV1;
    readonly secondary: SharedStateSqliteWorkerConformanceSessionV1;
    readonly clock: SharedStateLeaseConformanceClockV1;
    readonly adversarial: AdversarialWorkerLeaseControlV1;
  }) {
    this.#primary = input.primary;
    this.#secondary = input.secondary;
    this.#clock = input.clock;
    this.#adversarial = input.adversarial;
  }

  #session(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
  ): SharedStateSqliteWorkerConformanceSessionV1 {
    return ownerSlot === "primary" ? this.#primary : this.#secondary;
  }

  async #firedCount(): Promise<number> {
    const state = (await this.#primary.observationChannel().control(
      "readFaultState",
    )) as FaultStateReplyV1;
    return state.firedAt.length;
  }

  async openSingleton(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
  ): Promise<unknown> {
    if (ownerSlot === "primary") {
      const opened = await this.#primary.open();
      if (!opened.ok) throw new Error(`open refused: ${opened.error.code}`);
      return opened.value;
    }

    // A real second worker on the same file, holding its own connection and
    // its own owner token. The refusal below is the adapter's, not a decision
    // this target made.
    const contended = await this.#secondary.open();
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
    // Ask the refused worker for its adapter's own lifecycle. The lane's state
    // is not a substitute: the claim under test is about the adapter.
    const failed = (await this.#secondary.observationChannel().control(
      "adapterLifecycle",
    )) as { readonly state?: unknown } | null;
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
    const session = this.#session(ownerSlot);
    const closed = await session.close({ toleratesDrainFailure: true });
    if (!closed.ok) throw new Error(`close refused: ${closed.error.code}`);
    if (
      ownerSlot === "primary"
      && this.#adversarial.reopenLosesState === true
    ) {
      // Violation: the next open binds a fresh database, so everything the
      // claim committed is silently gone. The observation surface moves with
      // it, because it lives in the same worker.
      session.rebindFilePathForViolation(
        join(
          mkdtempSync(join(tmpdir(), "shared-state-worker-lease-lost-")),
          "v1.db",
        ),
      );
    }
    return closed.value;
  }

  armTransactionFault(faultPoint: SharedStateLeaseFaultPointV1): void {
    if (!SHARED_STATE_LEASE_FAULT_POINTS_V1.includes(faultPoint)) {
      throw new Error(`unknown lease fault point: ${faultPoint}`);
    }
    if (this.#adversarial.skipFaultInjection === true) return;
    // Posted on the same port as the lane request that follows, so it is armed
    // before that request executes even though the harness never awaits this.
    this.#primary.channel().send("armFault", faultPlanFor(faultPoint));
  }

  async transact(
    ownerSlot: SharedStateLeaseConformanceOwnerSlotV1,
    command: SharedStateLeaseTransactionCommandV1,
  ): Promise<unknown> {
    const session = this.#session(ownerSlot);
    if (
      this.#adversarial.barrierAllowsSecondWinner === true
      && command.operation === "claimLease"
      && this.#barrierWinners === 1
    ) {
      // Violation: the live claim is cleared so a second contender at the same
      // barrier also commits. It runs inside the worker that owns the file.
      await this.#primary.observationChannel().control("leaseClearViolation");
    }

    // The injected instant is passed through verbatim. Replacing it with a
    // target-owned counter would break the expiry scenario, which advances the
    // clock exactly through the lease duration.
    session.channel().send("setObservedInstant", {
      observedAtUnixMs: this.#clock.readLogicalMilliseconds().toString(),
    });
    const result = await session.lane().transact(command);

    const firedCount = await this.#firedCount();
    if (firedCount > this.#seenFiredCount) {
      this.#seenFiredCount = firedCount;
      // The adapter rolled its own transaction back. Nothing was written.
      return unavailableResult(command.operation, "authority_unavailable");
    }

    if (!result.ok) throw new Error(`lane refused: ${result.error.code}`);
    if (
      command.operation === "claimLease"
      && result.value.status === "committed"
    ) {
      this.#barrierWinners += 1;
    }
    return result.value;
  }

  async snapshot(): Promise<unknown> {
    const rows = (await this.#primary.observationChannel().control(
      "leaseRows",
    )) as readonly LeaseRowV1[];
    const bound = rows.filter((row) => row.owner_key_digest !== null);
    const now = this.#clock.readLogicalMilliseconds();
    const active = bound.filter(
      (row) =>
        row.lease_expires_at_unix_ms !== null
        && BigInt(row.lease_expires_at_unix_ms) > now,
    );
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
      auditCount:
        this.#adversarial.auditCountAlwaysZero === true ? 0 : attemptCount,
      outboxCount: attemptCount,
    });
  }
}

function createWorkerLeaseFixtureV1(
  adversarial: AdversarialWorkerLeaseControlV1 = {},
): {
  readonly factory: SharedStateLeaseConformanceTargetFactoryV1;
  dispose(): Promise<void>;
} {
  const directories: string[] = [];
  const sessions: SharedStateSqliteWorkerConformanceSessionV1[] = [];
  let ordinal = 0;

  const factory: SharedStateLeaseConformanceTargetFactoryV1 = Object.freeze({
    async create(input: {
      readonly clock: SharedStateLeaseConformanceClockV1;
    }): Promise<SharedStateLeaseConformanceTargetV1> {
      ordinal += 1;
      const directory = mkdtempSync(
        join(tmpdir(), "shared-state-worker-lease-target-v1-"),
      );
      directories.push(directory);
      const filePath = join(directory, "v1.db");

      // Two sessions on one file with different owner tokens. Exclusivity is
      // then proved across a real process boundary rather than between two
      // objects sharing an address space.
      const build = (
        slot: string,
      ): SharedStateSqliteWorkerConformanceSessionV1 =>
        createSharedStateSqliteWorkerConformanceSessionV1({
          filePath,
          ownerToken: `worker-lease-conformance-${slot}-${ordinal}`,
          backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
          queueCapacity: LANE_QUEUE_CAPACITY,
          acknowledgmentTimeoutMs: 30_000,
          drainTimeoutMs: 30_000,
        });

      const primary = build("primary");
      const secondary = build("secondary");
      sessions.push(primary, secondary);

      return new WorkerLeaseConformanceTargetV1({
        primary,
        secondary,
        clock: input.clock,
        adversarial,
      });
    },
  });

  return {
    factory,
    async dispose(): Promise<void> {
      for (const session of sessions) {
        await session.dispose();
      }
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

async function expectWorkerConformanceErrorCode(
  adversarial: AdversarialWorkerLeaseControlV1,
  expected: string,
): Promise<void> {
  const fixture = createWorkerLeaseFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStateLeaseConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(error instanceof SharedStateLeaseConformanceErrorV1, true);
        if (!(error instanceof SharedStateLeaseConformanceErrorV1)) {
          return false;
        }
        assert.equal(error.code, expected);
        return true;
      },
    );
  } finally {
    await fixture.dispose();
  }
}

test("declares the worker-mode Phase 2.1 control inventory and fault mapping", () => {
  for (const control of LEASE_CONTROLS_USED_V1) {
    assert.equal(
      (SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1 as readonly string[])
        .includes(control),
      true,
      `undeclared control: ${control}`,
    );
  }
  // Every harness fault point maps to a plan, and the two "after" points map to
  // `after-run` so the row is really written before the fault fires.
  for (const point of SHARED_STATE_LEASE_FAULT_POINTS_V1) {
    const plan = faultPlanFor(point);
    assert.equal(plan.point, point);
    assert.equal(plan.repeating, false);
    if (point.startsWith("after_")) assert.equal(plan.phase, "after-run");
  }
  // The target reaches the database only through its workers.
  const source = WorkerLeaseConformanceTargetV1.toString();
  assert.equal(source.includes("DatabaseSync"), false);
  assert.equal(source.includes("prepare("), false);
});

test("runs the Phase 2.1 harness through the V1 SQLite worker lane", async () => {
  const fixture = createWorkerLeaseFixtureV1();
  try {
    const report = await runSharedStateLeaseConformanceV1(fixture.factory);
    assert.equal(report.status, "passed");
    assert.equal(report.contractVersion, V.versions.contract);
  } finally {
    await fixture.dispose();
  }
});

test("fails closed on each adversarial lease violation in worker mode", async () => {
  await expectWorkerConformanceErrorCode(
    { skipFaultInjection: true },
    "transaction_not_atomic",
  );
  await expectWorkerConformanceErrorCode(
    { secondOwnerReportedReady: true },
    "singleton_not_exclusive",
  );
  await expectWorkerConformanceErrorCode(
    { reopenLosesState: true },
    "reopen_snapshot_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { barrierAllowsSecondWinner: true },
    "claim_outcome_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { auditCountAlwaysZero: true },
    "transaction_not_atomic",
  );
});
