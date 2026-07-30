/**
 * TEST-ONLY deterministic `executeIdempotent` reference model.
 *
 * This detached in-memory model is non-production, is not SQLite or a shared
 * backend, does not claim adapter conformance or durability/HA, and is not
 * connected to broker runtime. It exists only to prove that the adjacent
 * backend-neutral Phase 2.2 harness detects the required invariants.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  digestSharedStateKeyV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  type SharedStateStorageLifecycleV1,
} from "./shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1,
  SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1,
  SHARED_STATE_IDEMPOTENCY_TRANSACTION_FAULT_POINTS_V1,
  SharedStateIdempotencyConformanceErrorV1,
  runSharedStateIdempotencyConformanceV1,
  seededDeterministicIdempotencyOrderV1,
  sharedStateIdempotencyConformanceErrorReportV1Schema,
  sharedStateIdempotencyConformanceReportV1Schema,
  sharedStateIdempotencyConformanceSnapshotV1Schema,
  sharedStateIdempotencyTransactionFaultReportV1Schema,
  type SharedStateExecuteIdempotentCommandV1,
  type SharedStateExecuteIdempotentResultV1,
  type SharedStateIdempotencyConformanceClockV1,
  type SharedStateIdempotencyConformanceTargetFactoryV1,
  type SharedStateIdempotencyConformanceTargetV1,
  type SharedStateIdempotencyFaultPointV1,
} from "./shared-state-idempotency-conformance-v1.js";

const TEST_ONLY_DETERMINISTIC_IDEMPOTENCY_REFERENCE_MODEL_V1 =
  Object.freeze({
    role: "test-only-deterministic-reference-model",
    productionAdapter: false,
    sqliteAdapter: false,
    sharedAdapter: false,
    conformingAdapterClaim: false,
    backendClassClaim: "none",
    runtimeIntegration: "not-attached",
  } as const);

interface StableRecord {
  readonly payloadFingerprint: string;
  readonly outcomeDigest: string;
}

interface ModelState {
  records: Map<string, StableRecord>;
  reservationCount: number;
  domainMutationCount: number;
  outboxAppendCount: number;
  stableOutcomeCount: number;
}

function invariant(): never {
  throw new SharedStateIdempotencyConformanceErrorV1(
    "reference_model_invariant",
  );
}

function initialState(): ModelState {
  return {
    records: new Map(),
    reservationCount: 0,
    domainMutationCount: 0,
    outboxAppendCount: 0,
    stableOutcomeCount: 0,
  };
}

function cloneState(state: ModelState): ModelState {
  return {
    records: new Map(state.records),
    reservationCount: state.reservationCount,
    domainMutationCount: state.domainMutationCount,
    outboxAppendCount: state.outboxAppendCount,
    stableOutcomeCount: state.stableOutcomeCount,
  };
}

function lifecycle(
  state: "ready" | "closed" | "failed",
  reasonCodes: readonly (
    | "close_requested"
    | "ownership_conflict"
    | "lost_fence"
  )[],
): SharedStateStorageLifecycleV1 {
  const parsed = parseSharedStateStorageLifecycleV1({
    kind: V.kinds.lifecycle,
    lifecycleVersion: V.versions.lifecycle,
    contractVersion: V.versions.contract,
    state,
    reasonCodes,
  });
  if (!parsed.ok) return invariant();
  return parsed.value;
}

function transactionResult(
  body: Record<string, unknown>,
): SharedStateExecuteIdempotentResultV1 {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "executeIdempotent",
    consistency: V.operationConsistency.executeIdempotent,
    ...body,
  });
  if (!parsed.ok || parsed.value.operation !== "executeIdempotent") {
    return invariant();
  }
  return parsed.value;
}

function unavailable(
  reasonCode: "authority_unavailable" | "ambiguous_commit",
): SharedStateExecuteIdempotentResultV1 {
  return transactionResult({
    status: "unavailable",
    completeness: "unavailable",
    reasonCode,
  });
}

function conflict(): SharedStateExecuteIdempotentResultV1 {
  return transactionResult({
    status: "rejected",
    completeness: "complete",
    reasonCode: "idempotency_conflict",
  });
}

function committed(
  decision: "executed" | "replayed",
  outcomeDigest: string,
): SharedStateExecuteIdempotentResultV1 {
  return transactionResult({
    status: "committed",
    completeness: "complete",
    result: {
      decision,
      outcomeDigest,
    },
  });
}

function referenceOutcomeDigest(
  command: SharedStateExecuteIdempotentCommandV1,
): string {
  const fingerprintBytes = command.input.payloadFingerprint
    .split(":")
    .at(-1);
  if (
    fingerprintBytes === undefined
    || !/^[0-9a-f]{64}$/.test(fingerprintBytes)
  ) {
    return invariant();
  }
  const result = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.idempotency.outcome",
    namespace: command.input.namespace,
    components: [
      {
        field: "outcomeType",
        type: "utf8",
        value: "deterministic-reference",
      },
      {
        field: "outcomeBody",
        type: "bytes",
        value: fingerprintBytes,
      },
    ],
  });
  if (!result.ok) return invariant();
  return result.value.digest;
}

/**
 * Bounded in-memory state used only in this test. Close/reopen deliberately
 * retains the object state so the harness can exercise continuity without
 * representing a durable backend.
 */
class TestOnlyDeterministicIdempotencyReferenceModelV1
implements SharedStateIdempotencyConformanceTargetV1 {
  readonly #clock: SharedStateIdempotencyConformanceClockV1;
  #state = initialState();
  #open = false;
  #armedFault: SharedStateIdempotencyFaultPointV1 | null = null;
  #lastObservedLogicalMilliseconds = 0n;
  #transactionTail: Promise<void> = Promise.resolve();

  constructor(clock: SharedStateIdempotencyConformanceClockV1) {
    this.#clock = clock;
  }

  async open(): Promise<unknown> {
    if (this.#open) return lifecycle("failed", ["ownership_conflict"]);
    this.#open = true;
    return lifecycle("ready", []);
  }

  async close(): Promise<unknown> {
    if (!this.#open) return lifecycle("failed", ["lost_fence"]);
    this.#open = false;
    this.#armedFault = null;
    return lifecycle("closed", ["close_requested"]);
  }

  armFault(faultPoint: SharedStateIdempotencyFaultPointV1): void {
    if (
      this.#armedFault !== null
      || !SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1.includes(faultPoint)
    ) {
      invariant();
    }
    this.#armedFault = faultPoint;
  }

  async snapshot(): Promise<unknown> {
    const value = {
      kind: "SharedStateIdempotencyConformanceSnapshotV1",
      snapshotVersion: 1,
      reservationCount: this.#state.reservationCount,
      pendingReservationCount: 0,
      domainMutationCount: this.#state.domainMutationCount,
      outboxAppendCount: this.#state.outboxAppendCount,
      stableOutcomeCount: this.#state.stableOutcomeCount,
    } as const;
    const parsed =
      sharedStateIdempotencyConformanceSnapshotV1Schema.safeParse(value);
    if (!parsed.success) return invariant();
    return parsed.data;
  }

  async executeIdempotent(
    command: SharedStateExecuteIdempotentCommandV1,
  ): Promise<unknown> {
    const predecessor = this.#transactionTail;
    let release!: () => void;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return this.#executeNow(command);
    } finally {
      release();
    }
  }

  #executeNow(
    command: SharedStateExecuteIdempotentCommandV1,
  ): SharedStateExecuteIdempotentResultV1 {
    const parsed = parseSharedStateTransactionCommandV1(command);
    if (!parsed.ok || parsed.value.operation !== "executeIdempotent") {
      return invariant();
    }
    if (!this.#open) return unavailable("authority_unavailable");
    const now = this.#clock.readLogicalMilliseconds();
    if (now < this.#lastObservedLogicalMilliseconds) return invariant();
    this.#lastObservedLogicalMilliseconds = now;

    const existing = this.#state.records.get(command.input.keyDigest);
    if (existing !== undefined) {
      if (
        existing.payloadFingerprint !== command.input.payloadFingerprint
      ) {
        return conflict();
      }
      return committed("replayed", existing.outcomeDigest);
    }

    const fault = this.#armedFault;
    this.#armedFault = null;
    const working = cloneState(this.#state);
    working.reservationCount += 1;
    if (fault === "after_reservation") {
      return unavailable("authority_unavailable");
    }

    working.domainMutationCount += 1;
    if (fault === "after_domain_mutation") {
      return unavailable("authority_unavailable");
    }

    working.outboxAppendCount += 1;
    if (fault === "after_outbox_staging") {
      return unavailable("authority_unavailable");
    }

    const outcomeDigest = referenceOutcomeDigest(command);
    working.stableOutcomeCount += 1;
    working.records.set(command.input.keyDigest, {
      payloadFingerprint: command.input.payloadFingerprint,
      outcomeDigest,
    });
    if (fault === "after_outcome_staging") {
      return unavailable("authority_unavailable");
    }

    this.#state = working;
    if (fault === "after_commit_before_response") {
      return unavailable("ambiguous_commit");
    }
    return committed("executed", outcomeDigest);
  }
}

function createTestOnlyDeterministicIdempotencyReferenceModelFactoryV1():
SharedStateIdempotencyConformanceTargetFactoryV1 {
  return Object.freeze({
    async create({
      clock,
    }: {
      readonly clock: SharedStateIdempotencyConformanceClockV1;
    }) {
      return new TestOnlyDeterministicIdempotencyReferenceModelV1(clock);
    },
  });
}

interface DeferredConflictEntry {
  readonly command: SharedStateExecuteIdempotentCommandV1;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * Test-only scheduling seam that makes either seeded contender rank reach the
 * reference model first. Only scenario 2 is reordered.
 */
function createTestOnlyScheduledConflictWinnerFactoryV1(
  winnerSeededRank: 1 | 2,
): SharedStateIdempotencyConformanceTargetFactoryV1 {
  const delegateFactory =
    createTestOnlyDeterministicIdempotencyReferenceModelFactoryV1();
  let createdTargets = 0;

  return Object.freeze({
    async create(input: {
      readonly clock: SharedStateIdempotencyConformanceClockV1;
    }) {
      const target = await delegateFactory.create(input);
      createdTargets += 1;
      if (createdTargets !== 2) return target;

      const entries: DeferredConflictEntry[] = [];
      let released = false;
      const scheduledTarget: SharedStateIdempotencyConformanceTargetV1 = {
        open() {
          return target.open();
        },
        executeIdempotent(command) {
          if (released) return target.executeIdempotent(command);
          return new Promise<unknown>((resolve, reject) => {
            entries.push({ command, resolve, reject });
            if (
              entries.length
              !== SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1
                .conflictContenderCount
            ) {
              return;
            }
            released = true;
            const winner = entries[winnerSeededRank - 1];
            if (winner === undefined) {
              const error = new SharedStateIdempotencyConformanceErrorV1(
                "reference_model_invariant",
              );
              for (const entry of entries) entry.reject(error);
              return;
            }
            const scheduledEntries = [
              winner,
              ...entries.filter((entry) => entry !== winner),
            ];
            void (async () => {
              for (const entry of scheduledEntries) {
                try {
                  entry.resolve(
                    await target.executeIdempotent(entry.command),
                  );
                } catch (error: unknown) {
                  entry.reject(error);
                }
              }
            })();
          });
        },
        snapshot() {
          return target.snapshot();
        },
        armFault(faultPoint) {
          target.armFault(faultPoint);
        },
        close() {
          return target.close();
        },
      };
      return scheduledTarget;
    },
  });
}

const EXPECTED_REPORT = {
  kind: "SharedStateIdempotencyConformanceReportV1",
  harnessVersion: 1,
  contractVersion: "a2a.shared-state.storage/v1",
  scope: "execute-idempotent",
  status: "passed",
  scheduler: {
    kind: "seeded-deterministic",
    seed: 1504,
    barrier: "explicit-promise",
    targetIsolation: "factory-created-per-scenario",
    targetCount: 8,
    operationLimit: 96,
    operationCount: 78,
  },
  sameFingerprintRace: {
    contenderCount: 64,
    executedResults: 1,
    replayedResults: 63,
    outcomeDigests: "identical-original",
    effects: {
      reservationCount: 1,
      pendingReservationCount: 0,
      domainMutationCount: 1,
      outboxAppendCount: 1,
      stableOutcomeCount: 1,
    },
  },
  conflictingFingerprintRace: {
    contenderCount: 2,
    executedResults: 1,
    rejectedResults: 1,
    rejectionReasonCode: "idempotency_conflict",
    winnerSeededRank: 1,
    loserEffects: "none",
    effects: {
      reservationCount: 1,
      pendingReservationCount: 0,
      domainMutationCount: 1,
      outboxAppendCount: 1,
      stableOutcomeCount: 1,
    },
  },
  ambiguousCommit: {
    firstStatus: "unavailable",
    firstReasonCode: "ambiguous_commit",
    committedState: "fully-committed",
    retryDecision: "replayed",
    outcomeDigest: "original",
    retryEffects: "none",
    effects: {
      reservationCount: 1,
      pendingReservationCount: 0,
      domainMutationCount: 1,
      outboxAppendCount: 1,
      stableOutcomeCount: 1,
    },
  },
  transactionFaults: [
    {
      faultPoint: "after_reservation",
      failedStatus: "unavailable",
      failedReasonCode: "authority_unavailable",
      rollback: "exact-empty-baseline",
      pendingReservationCount: 0,
      nextCleanDecision: "executed",
    },
    {
      faultPoint: "after_domain_mutation",
      failedStatus: "unavailable",
      failedReasonCode: "authority_unavailable",
      rollback: "exact-empty-baseline",
      pendingReservationCount: 0,
      nextCleanDecision: "executed",
    },
    {
      faultPoint: "after_outbox_staging",
      failedStatus: "unavailable",
      failedReasonCode: "authority_unavailable",
      rollback: "exact-empty-baseline",
      pendingReservationCount: 0,
      nextCleanDecision: "executed",
    },
    {
      faultPoint: "after_outcome_staging",
      failedStatus: "unavailable",
      failedReasonCode: "authority_unavailable",
      rollback: "exact-empty-baseline",
      pendingReservationCount: 0,
      nextCleanDecision: "executed",
    },
  ],
  closeReopen: {
    clock: "injected-fake",
    advanceExactlyByMs: 64,
    snapshotContinuity: "preserved",
    retryDecision: "replayed",
    outcomeDigest: "identical-original",
    retentionReasonCode: "non_expiring_until_prune_proof",
    retentionExecution: "not-executed",
    effects: {
      reservationCount: 1,
      pendingReservationCount: 0,
      domainMutationCount: 1,
      outboxAppendCount: 1,
      stableOutcomeCount: 1,
    },
  },
} as const;

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (value === null || typeof value !== "object") return keys;
  for (const [key, nested] of Object.entries(value)) {
    keys.push(key);
    collectKeys(nested, keys);
  }
  return keys;
}

test("labels the deterministic idempotency model as test-only and detached", () => {
  assert.deepEqual(
    TEST_ONLY_DETERMINISTIC_IDEMPOTENCY_REFERENCE_MODEL_V1,
    {
      role: "test-only-deterministic-reference-model",
      productionAdapter: false,
      sqliteAdapter: false,
      sharedAdapter: false,
      conformingAdapterClaim: false,
      backendClassClaim: "none",
      runtimeIntegration: "not-attached",
    },
  );
  assert.equal(
    Object.isFrozen(
      TEST_ONLY_DETERMINISTIC_IDEMPOTENCY_REFERENCE_MODEL_V1,
    ),
    true,
  );
});

test("proves the exact bounded Phase 2.2 idempotency report", async () => {
  const report = await runSharedStateIdempotencyConformanceV1(
    createTestOnlyScheduledConflictWinnerFactoryV1(1),
  );

  assert.deepEqual(report, EXPECTED_REPORT);
  assert.equal(
    report.sameFingerprintRace.executedResults
      + report.sameFingerprintRace.replayedResults,
    64,
  );
  assert.deepEqual(
    report.transactionFaults.map(({ faultPoint }) => faultPoint),
    SHARED_STATE_IDEMPOTENCY_TRANSACTION_FAULT_POINTS_V1,
  );
  assertDeepFrozen(report);
});

test("accepts either bounded scheduling winner without caller fairness", async () => {
  for (const winnerSeededRank of [1, 2] as const) {
    const report = await runSharedStateIdempotencyConformanceV1(
      createTestOnlyScheduledConflictWinnerFactoryV1(winnerSeededRank),
    );
    assert.equal(
      report.conflictingFingerprintRace.winnerSeededRank,
      winnerSeededRank,
    );
    assert.equal(
      report.conflictingFingerprintRace.rejectionReasonCode,
      "idempotency_conflict",
    );
    assert.equal(
      report.conflictingFingerprintRace.loserEffects,
      "none",
    );
  }
});

test("uses repeatable seeded schedules and bounded operation counts", () => {
  for (const count of [2, 64]) {
    const first = seededDeterministicIdempotencyOrderV1(count);
    const second = seededDeterministicIdempotencyOrderV1(count);
    assert.deepEqual(first, second);
    assert.equal(first.length, count);
    assert.equal(new Set(first).size, count);
  }
  assert.equal(
    EXPECTED_REPORT.scheduler.operationCount
      <= EXPECTED_REPORT.scheduler.operationLimit,
    true,
  );
  assert.equal(EXPECTED_REPORT.scheduler.targetCount, 8);
});

test("keeps reports, snapshots, faults, and errors closed and non-reflecting", async () => {
  assert.equal(
    sharedStateIdempotencyConformanceReportV1Schema.safeParse({
      ...EXPECTED_REPORT,
      reflectedValue: "forbidden",
    }).success,
    false,
  );
  for (const winnerSeededRank of [0, 3]) {
    assert.equal(
      sharedStateIdempotencyConformanceReportV1Schema.safeParse({
        ...EXPECTED_REPORT,
        conflictingFingerprintRace: {
          ...EXPECTED_REPORT.conflictingFingerprintRace,
          winnerSeededRank,
        },
      }).success,
      false,
    );
  }
  assert.equal(
    sharedStateIdempotencyConformanceSnapshotV1Schema.safeParse({
      kind: "SharedStateIdempotencyConformanceSnapshotV1",
      snapshotVersion: 1,
      reservationCount: 0,
      pendingReservationCount: 0,
      domainMutationCount: 0,
      outboxAppendCount: 0,
      stableOutcomeCount: 0,
      hostPath: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    sharedStateIdempotencyTransactionFaultReportV1Schema.safeParse({
      ...EXPECTED_REPORT.transactionFaults[0],
      secret: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    sharedStateIdempotencyConformanceErrorReportV1Schema.safeParse({
      kind: "SharedStateIdempotencyConformanceErrorV1",
      errorVersion: 1,
      code: "target_create_failed",
      reflectedValue: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    collectKeys(EXPECTED_REPORT).some((key) => (
      /(?:path|identity|prompt|payload|secret|timestamp|network|host|random)/iu
        .test(key)
    )),
    false,
  );

  const sentinel = "sensitive-target-value";
  await assert.rejects(
    runSharedStateIdempotencyConformanceV1({
      async create() {
        throw new Error(sentinel);
      },
    }),
    (error: unknown) => {
      assert.equal(
        error instanceof SharedStateIdempotencyConformanceErrorV1,
        true,
      );
      if (
        !(error instanceof SharedStateIdempotencyConformanceErrorV1)
      ) {
        return false;
      }
      assert.equal(error.code, "target_create_failed");
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(error.stack?.includes(sentinel) ?? false, false);
      assert.deepEqual(error.toJSON(), {
        kind: "SharedStateIdempotencyConformanceErrorV1",
        errorVersion: 1,
        code: "target_create_failed",
      });
      assertDeepFrozen(error.toJSON());
      return true;
    },
  );
});

test("pins the complete closed deterministic fault vocabulary", () => {
  assert.deepEqual(SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1, [
    "after_reservation",
    "after_domain_mutation",
    "after_outbox_staging",
    "after_outcome_staging",
    "after_commit_before_response",
  ]);
});
