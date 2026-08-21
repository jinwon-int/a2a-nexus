/**
 * TEST-ONLY deterministic partition/unavailable reference model.
 *
 * This bounded in-memory model is non-production, non-SQLite, non-shared,
 * non-conforming, and detached from broker runtime. It exists only in this
 * adjacent test file to exercise the backend-neutral Phase 2.5 harness.
 * Its readiness method reports the adapter-lifecycle view only; it is not
 * `/readyz`, not middleware, and not a route contract. Its stale-read method
 * is a conformance control, not a V1 storage query.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_PARTITION_CONFORMANCE_V1,
  SHARED_STATE_PARTITION_ERROR_CODES_V1,
  SHARED_STATE_PARTITION_FAULT_POINTS_V1,
  SHARED_STATE_PARTITION_FAULT_REASONS_V1,
  SharedStatePartitionConformanceErrorV1,
  runSharedStatePartitionConformanceV1,
  seededDeterministicPartitionFaultOrderV1,
  sharedStatePartitionConformanceReportV1Schema,
  sharedStatePartitionConformanceSnapshotV1Schema,
  sharedStatePartitionErrorReportV1Schema,
  sharedStatePartitionReadinessV1Schema,
  sharedStatePartitionStaleReadV1Schema,
  type SharedStatePartitionConformanceTargetFactoryV1,
  type SharedStatePartitionConformanceTargetV1,
  type SharedStatePartitionFaultPointV1,
} from "./shared-state-partition-conformance-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  digestSharedStateKeyV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionResultV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";

const TEST_ONLY_PARTITION_REFERENCE_MODEL_V1 = Object.freeze({
  label: "test-only-deterministic-partition-reference-model",
  production: false,
  sqlite: false,
  shared: false,
  conforming: false,
  attachedToBrokerRuntime: false,
  durabilityClaim: "none",
  readinessScope: "adapter-lifecycle-only-not-a-route",
  staleReadScope: "conformance-control-not-a-v1-query",
} as const);

function attemptKeyDigest(namespace: string, attemptNumber: number): string {
  const parsed = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.lease.attempt-key",
    namespace,
    components: [
      { field: "resourceId", type: "utf8", value: "partition-resource" },
      { field: "attemptNumber", type: "uint", value: String(attemptNumber) },
    ],
  });
  if (!parsed.ok) return invariant();
  return parsed.value.digest;
}

function outcomeDigest(namespace: string): string {
  const parsed = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.idempotency.outcome",
    namespace,
    components: [
      { field: "outcomeType", type: "utf8", value: "accepted" },
      { field: "outcomeBody", type: "bytes", value: "2505" },
    ],
  });
  if (!parsed.ok) return invariant();
  return parsed.value.digest;
}

function invariant(): never {
  throw new SharedStatePartitionConformanceErrorV1(
    "reference_model_invariant",
  );
}

interface LeaseState {
  attemptKeyDigest: string;
  fencingToken: bigint;
  resourceVersion: bigint;
}

interface OutboxEvent {
  readonly idempotencyKeyDigest: string;
  readonly eventKeyDigest: string;
  readonly streamSequence: bigint;
  acknowledgmentState: "unacknowledged" | "acknowledged";
}

/**
 * Adversarial controls exist only to prove the harness fails closed. Each one
 * makes the model violate exactly one Phase 2.5 claim.
 */
interface TestOnlyAdversarialPartitionControlV1 {
  readonly permissiveLocalDecision?: boolean;
  readonly mutateWhileUnavailable?: boolean;
  readonly ackWhilePartitioned?: boolean;
  readonly staleReadNotLabeled?: boolean;
  readonly staysReadyWhilePartitioned?: boolean;
  readonly wrongUnavailableReason?: boolean;
}

function lifecycleEnvelope(
  state: "ready" | "closed",
  reasonCodes: readonly "close_requested"[],
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
  operation: SharedStateTransactionCommandV1["operation"],
  body: Record<string, unknown>,
): unknown {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    consistency: V.operationConsistency[operation],
    ...body,
  });
  if (!parsed.ok || parsed.value.operation !== operation) {
    return invariant();
  }
  return parsed.value;
}

function committed(
  operation: SharedStateTransactionCommandV1["operation"],
  result: Record<string, unknown>,
): unknown {
  return transactionResult(operation, {
    status: "committed",
    completeness: "complete",
    result,
  });
}

function unavailable(
  operation: SharedStateTransactionCommandV1["operation"],
  reasonCode: string,
): unknown {
  return transactionResult(operation, {
    status: "unavailable",
    completeness: "unavailable",
    reasonCode,
  });
}

class TestOnlyDeterministicPartitionReferenceModelV1
implements SharedStatePartitionConformanceTargetV1 {
  readonly #adversarial: TestOnlyAdversarialPartitionControlV1;
  readonly #replay = new Set<string>();
  readonly #rate: string[] = [];
  readonly #idempotency = new Set<string>();
  readonly #outbox: OutboxEvent[] = [];
  #lease: LeaseState | null = null;
  #streamSequence = 0n;
  #provenanceSources = 3;
  #provenanceHighWater = 5n;
  #checkpoint = 3n;
  #armedFault: SharedStatePartitionFaultPointV1 | null = null;
  #open = false;

  constructor(adversarial: TestOnlyAdversarialPartitionControlV1) {
    this.#adversarial = adversarial;
  }

  async open(): Promise<unknown> {
    this.#open = true;
    return lifecycleEnvelope("ready", []);
  }

  async close(): Promise<unknown> {
    this.#open = false;
    return lifecycleEnvelope("closed", ["close_requested"]);
  }

  #writeFaultReason(): string | null {
    if (this.#armedFault === null) return null;
    if (this.#armedFault === "delayed-read") return null;
    if (this.#adversarial.wrongUnavailableReason === true) {
      // Violation: reports a reason that does not match the injected fault.
      return "unsafe_clock";
    }
    return SHARED_STATE_PARTITION_FAULT_REASONS_V1[this.#armedFault];
  }

  async transact(
    command: SharedStateTransactionCommandV1,
  ): Promise<unknown> {
    if (!this.#open) return invariant();
    const faultReason = this.#writeFaultReason();
    if (faultReason !== null) {
      if (this.#adversarial.permissiveLocalDecision === true) {
        // Violation: an empty local decision instead of failing closed.
        return this.#apply(command);
      }
      if (
        this.#adversarial.ackWhilePartitioned === true
        && command.operation === "acknowledgeOutbox"
      ) {
        // Violation: ACK committed while the authority is unreachable.
        return this.#apply(command);
      }
      if (this.#adversarial.mutateWhileUnavailable === true) {
        // Violation: the effect lands even though the result says otherwise.
        this.#apply(command);
      }
      return unavailable(command.operation, faultReason);
    }
    return this.#apply(command);
  }

  #apply(command: SharedStateTransactionCommandV1): unknown {
    switch (command.operation) {
      case "consumeReplayNonce": {
        const key = command.input.nonceDigest;
        if (this.#replay.has(key)) {
          return committed("consumeReplayNonce", {
            decision: "replay",
            expiresInMs: command.input.ttlMs,
          });
        }
        this.#replay.add(key);
        return committed("consumeReplayNonce", {
          decision: "accepted",
          expiresInMs: command.input.ttlMs,
        });
      }
      case "reserveRateLimitCost": {
        this.#rate.push(command.input.bucketKeyDigest);
        return committed("reserveRateLimitCost", {
          decision: "accepted",
          remaining: command.input.limit - this.#rate.length,
          resetInMs: command.input.windowMs,
        });
      }
      case "claimLease": {
        if (this.#lease !== null) {
          return transactionResult("claimLease", {
            status: "rejected",
            completeness: "complete",
            reasonCode: "claim_conflict",
          });
        }
        const attempt = attemptKeyDigest(command.input.namespace, 1);
        this.#lease = {
          attemptKeyDigest: attempt,
          fencingToken: 1n,
          resourceVersion: 1n,
        };
        return committed("claimLease", {
          decision: "claimed",
          attemptKeyDigest: attempt,
          fencingToken: "1",
          resourceVersion: "1",
          leaseExpiresInMs: command.input.leaseDurationMs,
        });
      }
      case "renewLease": {
        const lease = this.#lease;
        if (lease === null) return invariant();
        lease.resourceVersion += 1n;
        return committed("renewLease", {
          decision: "renewed",
          resourceVersion: lease.resourceVersion.toString(),
          leaseExpiresInMs: command.input.leaseDurationMs,
        });
      }
      case "mutateWithFence": {
        const lease = this.#lease;
        if (lease === null) return invariant();
        lease.resourceVersion += 1n;
        return committed("mutateWithFence", {
          decision: "applied",
          resourceVersion: lease.resourceVersion.toString(),
        });
      }
      case "executeIdempotent": {
        const key = command.input.keyDigest;
        const decision = this.#idempotency.has(key) ? "replayed" : "executed";
        this.#idempotency.add(key);
        return committed("executeIdempotent", {
          decision,
          outcomeDigest: outcomeDigest(command.input.namespace),
        });
      }
      case "appendOutbox": {
        const existing = this.#outbox.find(
          (event) =>
            event.idempotencyKeyDigest === command.input.idempotencyKeyDigest,
        );
        if (existing !== undefined) {
          return committed("appendOutbox", {
            decision: "replayed",
            eventKeyDigest: existing.eventKeyDigest,
            streamSequence: existing.streamSequence.toString(),
          });
        }
        this.#streamSequence += 1n;
        this.#outbox.push({
          idempotencyKeyDigest: command.input.idempotencyKeyDigest,
          eventKeyDigest: command.input.eventKeyDigest,
          streamSequence: this.#streamSequence,
          acknowledgmentState: "unacknowledged",
        });
        return committed("appendOutbox", {
          decision: "appended",
          eventKeyDigest: command.input.eventKeyDigest,
          streamSequence: this.#streamSequence.toString(),
        });
      }
      case "acknowledgeOutbox": {
        const event = this.#outbox.find(
          (candidate) =>
            candidate.eventKeyDigest === command.input.eventKeyDigest,
        );
        if (event === undefined) return invariant();
        event.acknowledgmentState = "acknowledged";
        return committed("acknowledgeOutbox", {
          decision: "acknowledged",
          acknowledgmentState: "acknowledged",
        });
      }
      default:
        return invariant();
    }
  }

  armConformanceFault(
    faultPoint: SharedStatePartitionFaultPointV1 | null,
  ): void {
    this.#armedFault = faultPoint;
  }

  async captureConformanceSnapshot(): Promise<unknown> {
    return sharedStatePartitionConformanceSnapshotV1Schema.parse({
      kind: "SharedStatePartitionConformanceSnapshotV1",
      snapshotVersion: 1,
      replayRecordCount: this.#replay.size,
      rateEntryCount: this.#rate.length,
      activeLeaseCount: this.#lease === null ? 0 : 1,
      maximumFencingToken: (this.#lease?.fencingToken ?? 0n).toString(),
      leaseResourceVersion: (this.#lease?.resourceVersion ?? 0n).toString(),
      idempotencyOutcomeCount: this.#idempotency.size,
      outboxEventCount: this.#outbox.length,
      unacknowledgedEventCount: this.#outbox.filter(
        (event) => event.acknowledgmentState === "unacknowledged",
      ).length,
      acknowledgedEventCount: this.#outbox.filter(
        (event) => event.acknowledgmentState === "acknowledged",
      ).length,
      streamSequenceHighWater: this.#streamSequence.toString(),
      provenanceSourceCount: this.#provenanceSources,
      provenanceCheckpointSequence: this.#checkpoint.toString(),
      prunedRecordCount: 0,
      authorityReachable: this.#armedFault === null,
    });
  }

  async captureConformanceReadiness(): Promise<unknown> {
    const partitioned =
      this.#armedFault !== null && this.#armedFault !== "delayed-read";
    const ready = this.#adversarial.staysReadyWhilePartitioned === true
      ? true
      : !partitioned;
    return sharedStatePartitionReadinessV1Schema.parse({
      kind: "SharedStatePartitionConformanceReadinessV1",
      readinessVersion: 1,
      scope: "test-only-adapter-lifecycle-readiness-control",
      ready,
      lifecycleState: partitioned ? "failed" : "ready",
      lifecycleReasonCodes: partitioned ? ["adapter_unavailable"] : [],
      readinessReasonCodes: partitioned ? ["adapter_unavailable"] : [],
    });
  }

  async readConformanceStaleProjection(): Promise<unknown> {
    const labeled = this.#adversarial.staleReadNotLabeled !== true;
    return sharedStatePartitionStaleReadV1Schema.parse({
      kind: "SharedStatePartitionConformanceStaleReadV1",
      staleReadVersion: 1,
      scope: "test-only-partition-conformance-control",
      freshness: "stale",
      // A partitioned read is served from the durable checkpoint, which is
      // behind the source high-water. The adversarial branch hides that.
      completeness: labeled ? "incomplete" : "complete",
      asOfSourceSequence: this.#checkpoint.toString(),
      checkpointSequence: this.#checkpoint.toString(),
      sourceSequenceHighWater: labeled
        ? this.#provenanceHighWater.toString()
        : this.#checkpoint.toString(),
      lag: labeled ? Number(this.#provenanceHighWater - this.#checkpoint) : 0,
    });
  }
}

function createTestOnlyDeterministicPartitionFactoryV1(
  adversarial: TestOnlyAdversarialPartitionControlV1 = {},
): SharedStatePartitionConformanceTargetFactoryV1 {
  return Object.freeze({
    async create(): Promise<SharedStatePartitionConformanceTargetV1> {
      return new TestOnlyDeterministicPartitionReferenceModelV1(adversarial);
    },
  });
}

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (value === null || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  for (const [key, nested] of Object.entries(value)) {
    keys.push(key);
    collectKeys(nested, keys);
  }
  return keys;
}

async function expectConformanceErrorCode(
  adversarial: TestOnlyAdversarialPartitionControlV1,
  expected: string,
): Promise<void> {
  await assert.rejects(
    runSharedStatePartitionConformanceV1(
      createTestOnlyDeterministicPartitionFactoryV1(adversarial),
    ),
    (error: unknown) => {
      assert.equal(
        error instanceof SharedStatePartitionConformanceErrorV1,
        true,
      );
      if (!(error instanceof SharedStatePartitionConformanceErrorV1)) {
        return false;
      }
      assert.equal(error.code, expected);
      return true;
    },
  );
}

test("labels the partition model test-only with no route claim", () => {
  assert.deepEqual(TEST_ONLY_PARTITION_REFERENCE_MODEL_V1, {
    label: "test-only-deterministic-partition-reference-model",
    production: false,
    sqlite: false,
    shared: false,
    conforming: false,
    attachedToBrokerRuntime: false,
    durabilityClaim: "none",
    readinessScope: "adapter-lifecycle-only-not-a-route",
    staleReadScope: "conformance-control-not-a-v1-query",
  });
});

test("proves the exact bounded Phase 2.5 partition slice", async () => {
  const report = await runSharedStatePartitionConformanceV1(
    createTestOnlyDeterministicPartitionFactoryV1(),
  );

  assert.equal(report.status, "passed");
  assert.equal(report.scope, "partition-unavailable-injection");
  assert.equal(report.contractVersion, V.versions.contract);

  assert.deepEqual(report.controls, {
    scheduler: "seeded-deterministic-serial",
    schedulerSeed: SHARED_STATE_PARTITION_CONFORMANCE_V1.schedulerSeed,
    concurrency: "not-exercised",
    barrier: "not-required",
    clock: "not-required",
    targetIsolation: "factory-created-per-scenario",
    targetCount: SHARED_STATE_PARTITION_CONFORMANCE_V1.targetCount,
    targetCommandLimit:
      SHARED_STATE_PARTITION_CONFORMANCE_V1.targetCommandLimit,
    targetCommandCount:
      SHARED_STATE_PARTITION_CONFORMANCE_V1.expectedTargetCommandCount,
    lifecycleLimit: SHARED_STATE_PARTITION_CONFORMANCE_V1.lifecycleLimit,
    lifecycleCount:
      SHARED_STATE_PARTITION_CONFORMANCE_V1.expectedLifecycleCount,
    snapshotControlLimit:
      SHARED_STATE_PARTITION_CONFORMANCE_V1.snapshotControlLimit,
    snapshotControlCount:
      SHARED_STATE_PARTITION_CONFORMANCE_V1.expectedSnapshotControlCount,
    faultControlLimit:
      SHARED_STATE_PARTITION_CONFORMANCE_V1.faultControlLimit,
    faultControlCount:
      SHARED_STATE_PARTITION_CONFORMANCE_V1.expectedFaultControlCount,
    staleReadControlCount:
      SHARED_STATE_PARTITION_CONFORMANCE_V1.staleReadControlCount,
    readinessControlCount:
      SHARED_STATE_PARTITION_CONFORMANCE_V1.readinessControlCount,
  });

  // Every declared fault point is exercised exactly once.
  assert.equal(
    report.faultPoints.cases.length,
    SHARED_STATE_PARTITION_CONFORMANCE_V1.faultPointCount,
  );
  assert.deepEqual(
    [...report.faultPoints.cases.map((entry) => entry.faultPoint)].sort(),
    [...SHARED_STATE_PARTITION_FAULT_POINTS_V1].sort(),
  );
  assert.equal(
    report.faultPoints.reasonCoverage,
    "exactly-the-closed-unavailable-reasons",
  );
  assert.deepEqual(report.faultPoints.previouslyUncovered, [
    "lock_timeout",
    "delayed-read",
  ]);
  // Each write fault reports its own mapped reason; none mutates state.
  for (const entry of report.faultPoints.cases) {
    assert.equal(entry.localDecisionEmitted, false);
    assert.equal(entry.stateMutated, false);
    if (entry.faultPoint === "delayed-read") {
      assert.equal(entry.attemptStatus, "committed");
      assert.equal(entry.attemptReasonCode, "none");
      continue;
    }
    assert.equal(entry.attemptStatus, "unavailable");
    assert.equal(
      entry.attemptReasonCode,
      SHARED_STATE_PARTITION_FAULT_REASONS_V1[entry.faultPoint],
    );
  }

  assert.deepEqual(report.protectedRequests, {
    replayStatus: "unavailable",
    replayReasonCode: "authority_unavailable",
    rateStatus: "unavailable",
    rateReasonCode: "lock_timeout",
    emptyLocalDecisionObserved: false,
    permissiveFallbackObserved: false,
  });

  assert.deepEqual(report.mutationsWhileUnavailable, {
    claimStatus: "unavailable",
    renewStatus: "unavailable",
    fencedMutationStatus: "unavailable",
    idempotentStatus: "unavailable",
    appliedMutationCount: 0,
    snapshotUnchanged: true,
    cleanRetryAppliesOnce: true,
  });

  assert.deepEqual(report.outboxUnderPartition, {
    producerStatus: "unavailable",
    producerPartialEffectCount: 0,
    consumerReplayPreserved: true,
    acknowledgeStatus: "unavailable",
    acknowledgmentStatePreserved: "unacknowledged",
    prunedRecordCount: 0,
    retentionPruneExecution: "not-executed",
  });

  assert.deepEqual(report.partitionedRead, {
    faultPoint: "delayed-read",
    freshness: "stale",
    explicitlyLabeled: true,
    carriesCheckpointAndLag: true,
    servedAnswerIsNotNegativeEvidence: true,
    priorSliceCoversRemainingCases:
      "phase-2.7-projection-incomplete-unavailable-no-evidence-path",
  });

  assert.deepEqual(report.adapterReadiness, {
    readyBeforePartition: true,
    readyDuringPartition: false,
    lifecycleStateDuringPartition: "failed",
    lifecycleReasonCode: "adapter_unavailable",
    readinessReasonCode: "adapter_unavailable",
    layerEquivalence:
      "every-lifecycle-fault-reason-has-a-readiness-counterpart",
    equivalentReasonCount: 8,
    mutationAppliedWhileNotReady: false,
    readyAfterRecovery: true,
    routeBehaviorScope: "phase-4-not-proved-here",
  });

  assert.deepEqual(report.claims, {
    referenceModel: "test-only",
    adapterConformance: "not-claimed",
    runtimeIntegration: "none",
    storageQueryContract: "none",
    readinessRouteContract: "none",
    retentionPruneExecution: "not-executed",
  });

  assertDeepFrozen(report);
});

test("uses a stable seeded fault order with no barrier", () => {
  const first = seededDeterministicPartitionFaultOrderV1();
  const second = seededDeterministicPartitionFaultOrderV1();
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(
    [...first].sort(),
    [...SHARED_STATE_PARTITION_FAULT_POINTS_V1].sort(),
  );
});

test("fails closed on each adversarial partition violation", async () => {
  // Item: a protected request must never return an empty local decision.
  await expectConformanceErrorCode(
    { permissiveLocalDecision: true },
    "empty_local_decision",
  );
  // Item: the reported reason must match the injected fault.
  await expectConformanceErrorCode(
    { wrongUnavailableReason: true },
    "unavailable_reason_mismatch",
  );
  // Item: no mutation applies while the authority is unavailable.
  await expectConformanceErrorCode(
    { mutateWhileUnavailable: true },
    "mutation_applied_while_unavailable",
  );
  // Item: a partitioned read must be explicitly labeled stale.
  await expectConformanceErrorCode(
    { staleReadNotLabeled: true },
    "stale_read_not_labeled",
  );
  // Item: the adapter must report not-ready while partitioned.
  await expectConformanceErrorCode(
    { staysReadyWhilePartitioned: true },
    "not_ready_state_mismatch",
  );
});

test(
  "keeps reports, snapshots, controls, and errors strict and non-reflecting",
  async () => {
    const report = await runSharedStatePartitionConformanceV1(
      createTestOnlyDeterministicPartitionFactoryV1(),
    );

    const forbiddenPublicKeys =
      /(?:identity|digest|namespace|prompt|payload|path|secret|endpoint|host|provider|worker|task|timestamp)/iu;
    assert.equal(
      collectKeys(report).some((key) => forbiddenPublicKeys.test(key)),
      false,
    );

    assert.equal(
      sharedStatePartitionConformanceReportV1Schema.safeParse({
        ...report,
        reflectedTargetError: "leaked",
      }).success,
      false,
    );
    assert.equal(
      sharedStatePartitionConformanceSnapshotV1Schema.safeParse({
        kind: "SharedStatePartitionConformanceSnapshotV1",
        snapshotVersion: 1,
        identityDigest: "leaked",
      }).success,
      false,
    );
    assert.equal(
      sharedStatePartitionReadinessV1Schema.safeParse({
        kind: "SharedStatePartitionConformanceReadinessV1",
        readinessVersion: 1,
        scope: "test-only-adapter-lifecycle-readiness-control",
        ready: true,
        lifecycleState: "ready",
        lifecycleReasonCodes: [],
        readinessReasonCodes: [],
        endpoint: "/readyz",
      }).success,
      false,
    );
    assert.equal(
      sharedStatePartitionStaleReadV1Schema.safeParse({
        kind: "SharedStatePartitionConformanceStaleReadV1",
        staleReadVersion: 1,
        scope: "test-only-partition-conformance-control",
        freshness: "stale",
        completeness: "incomplete",
        asOfSourceSequence: "3",
        checkpointSequence: "3",
        sourceSequenceHighWater: "5",
        lag: 2,
        claimText: "leaked",
      }).success,
      false,
    );
    assert.equal(
      sharedStatePartitionErrorReportV1Schema.safeParse({
        kind: "SharedStatePartitionConformanceErrorV1",
        errorVersion: 1,
        code: "report_invalid",
        targetError: "leaked",
      }).success,
      false,
    );

    const sentinel = "sensitive-target-value";
    await assert.rejects(
      runSharedStatePartitionConformanceV1({
        async create() {
          throw new Error(sentinel);
        },
      }),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStatePartitionConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStatePartitionConformanceErrorV1)) {
          return false;
        }
        assert.equal(error.code, "target_create_failed");
        assert.equal(error.message.includes(sentinel), false);
        assert.equal(error.stack?.includes(sentinel) ?? false, false);
        assert.deepEqual(error.toJSON(), {
          kind: "SharedStatePartitionConformanceErrorV1",
          errorVersion: 1,
          code: "target_create_failed",
        });
        assertDeepFrozen(error.toJSON());
        return true;
      },
    );
  },
);

test("pins the fault mapping and the two-layer readiness vocabulary", () => {
  assert.deepEqual(
    [...SHARED_STATE_PARTITION_FAULT_POINTS_V1],
    ["unavailable", "timeout", "ambiguous-commit", "lost-fence",
      "delayed-read"],
  );
  // Each write fault maps to an existing closed unavailable reason.
  assert.deepEqual(SHARED_STATE_PARTITION_FAULT_REASONS_V1, {
    unavailable: "authority_unavailable",
    timeout: "lock_timeout",
    "ambiguous-commit": "ambiguous_commit",
    "lost-fence": "lost_ownership",
  });
  for (const reason of Object.values(SHARED_STATE_PARTITION_FAULT_REASONS_V1)) {
    assert.equal(V.unavailableReasonCodes.includes(reason), true);
  }
  // `unsafe_clock` is the only closed reason not driven by partition
  // injection; Phase 2.4 proves it through the time contract instead.
  const mapped = new Set<string>(
    Object.values(SHARED_STATE_PARTITION_FAULT_REASONS_V1),
  );
  assert.deepEqual(
    V.unavailableReasonCodes.filter((reason) => !mapped.has(reason)),
    ["unsafe_clock"],
  );

  // The boundary split that made this section startable claims the readiness
  // signal exists at two layers. Check it rather than assert it.
  const readiness = new Set<string>(V.readinessReasonCodes);
  const shared = V.lifecycleReasonCodes.filter((code) => readiness.has(code));
  assert.equal(shared.length, 8);
  assert.equal(shared.includes("adapter_unavailable"), true);
  assert.deepEqual(
    V.lifecycleReasonCodes.filter((code) => !readiness.has(code)),
    [
      "open_requested",
      "drain_requested",
      "close_requested",
      "drain_timeout",
      "ambiguous_write",
    ],
  );

  assert.equal(
    new Set(SHARED_STATE_PARTITION_ERROR_CODES_V1).size,
    SHARED_STATE_PARTITION_ERROR_CODES_V1.length,
  );
});
