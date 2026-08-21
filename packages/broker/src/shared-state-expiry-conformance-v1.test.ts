/**
 * TEST-ONLY deterministic expiry-boundary reference model.
 *
 * This bounded in-memory model is non-production, non-SQLite, non-shared,
 * non-conforming, and detached from broker runtime. It exists only in this
 * adjacent test file to exercise the backend-neutral Phase 2.6 harness.
 * It retains physically expired rows on purpose so the harness can prove that
 * presence is not an input to a logical boundary decision. It never executes
 * retention or prune.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_EXPIRY_BOUNDARY_FIXTURES_V1,
  SHARED_STATE_EXPIRY_CLEANUP_CONTROLS_V1,
  SHARED_STATE_EXPIRY_CONFORMANCE_V1,
  SHARED_STATE_EXPIRY_ERROR_CODES_V1,
  SHARED_STATE_EXPIRY_PROBE_POINTS_V1,
  SharedStateExpiryConformanceErrorV1,
  runSharedStateExpiryConformanceV1,
  seededDeterministicExpiryFixtureOrderV1,
  sharedStateExpiryConformanceReportV1Schema,
  sharedStateExpiryConformanceSnapshotV1Schema,
  sharedStateExpiryErrorReportV1Schema,
  type SharedStateExpiryCleanupControlV1,
  type SharedStateExpiryConformanceClockV1,
  type SharedStateExpiryConformanceTargetFactoryV1,
  type SharedStateExpiryConformanceTargetV1,
} from "./shared-state-expiry-conformance-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  digestSharedStateKeyV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionResultV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_TIME_V1_VALUES as TIME_V,
  deriveSharedStateExpiryV1,
  evaluateSharedStateTimeV1,
  type SharedStateTimeEvaluationV1,
} from "./shared-state-time-v1.js";

const TEST_ONLY_EXPIRY_REFERENCE_MODEL_V1 = Object.freeze({
  label: "test-only-deterministic-expiry-reference-model",
  production: false,
  sqlite: false,
  shared: false,
  conforming: false,
  attachedToBrokerRuntime: false,
  durabilityClaim: "none",
  retentionPruneExecution: "not-executed",
  physicallyRetainsExpiredRows: true,
} as const);

function modelDigest(
  domain: "broker.lease.attempt-key" | "broker.idempotency.outcome",
  namespace: string,
  components: readonly {
    readonly field: string;
    readonly type: "utf8" | "uint" | "bytes";
    readonly value: string;
  }[],
): string {
  const parsed = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace,
    components,
  });
  if (!parsed.ok) return invariant();
  return parsed.value.digest;
}

function invariant(): never {
  throw new SharedStateExpiryConformanceErrorV1(
    "reference_model_invariant",
  );
}

interface ReplayRecord {
  readonly expiresAt: bigint;
}

interface RateEntry {
  readonly eventAt: bigint;
  readonly cost: number;
}

interface LeaseState {
  ownerKeyDigest: string;
  attemptKeyDigest: string;
  fencingToken: bigint;
  resourceVersion: bigint;
  expiresAt: bigint;
  ownershipEpoch: bigint;
}

interface IdempotencyOutcome {
  readonly payloadFingerprint: string;
}

interface OutboxEvent {
  readonly idempotencyKeyDigest: string;
  readonly eventKeyDigest: string;
  readonly streamSequence: bigint;
  receiptState: "pending" | "confirmed";
  acknowledgmentState: "unacknowledged" | "acknowledged";
}

interface GraphSource {
  readonly sourceFactDigest: string;
  readonly sourceSequence: bigint;
}

/**
 * Adversarial controls exist only to prove the harness fails closed. Each one
 * makes the model violate exactly one Phase 2.6 claim.
 */
interface TestOnlyAdversarialExpiryControlV1 {
  readonly permissiveCapacityEviction?: boolean;
  readonly fenceDoesNotAdvanceOnReclaim?: boolean;
  readonly cleanupRemovesActiveRecord?: boolean;
  readonly implicitTtlOnUnacknowledgedEvent?: boolean;
  readonly ownershipTransfersOnExpiryAlone?: boolean;
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

function rejected(
  operation: SharedStateTransactionCommandV1["operation"],
  reasonCode: string,
): unknown {
  return transactionResult(operation, {
    status: "rejected",
    completeness: "complete",
    reasonCode,
  });
}

function unavailable(
  operation: SharedStateTransactionCommandV1["operation"],
  reasonCode: "authority_unavailable",
): unknown {
  return transactionResult(operation, {
    status: "unavailable",
    completeness: "unavailable",
    reasonCode,
  });
}

class TestOnlyDeterministicExpiryReferenceModelV1
implements SharedStateExpiryConformanceTargetV1 {
  readonly #clock: SharedStateExpiryConformanceClockV1;
  readonly #adversarial: TestOnlyAdversarialExpiryControlV1;
  readonly #replay = new Map<string, ReplayRecord>();
  readonly #rate = new Map<string, RateEntry[]>();
  readonly #idempotency = new Map<string, IdempotencyOutcome>();
  readonly #outbox: OutboxEvent[] = [];
  readonly #graphSources: GraphSource[] = [];
  readonly #projectionBatches = new Set<string>();
  #lease: LeaseState | null = null;
  #streamSequence = 0n;
  #graphSequence = 0n;
  #checkpoint = 0n;
  #floor: bigint | null = null;
  #cleanupState: "none" | "early-eviction-refused" | "deferred" = "none";
  #pressureBand: (typeof V.pressureBands)[number] = "none";
  #open = false;

  constructor(
    clock: SharedStateExpiryConformanceClockV1,
    adversarial: TestOnlyAdversarialExpiryControlV1,
  ) {
    this.#clock = clock;
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

  #time(): SharedStateTimeEvaluationV1 {
    const observed = this.#clock.readObservedUnixMilliseconds();
    if (this.#floor === null || observed > this.#floor) {
      this.#floor = observed;
    }
    const floor = this.#floor;
    const policyProfile = TIME_V.clockProfiles[0]!;
    const requirements = TIME_V.profileRequirements[policyProfile];
    const evaluated = evaluateSharedStateTimeV1(
      {
        kind: TIME_V.kinds.policy,
        timeVersion: TIME_V.version,
        clockProfile: policyProfile,
        clockAuthority: requirements.clockAuthority,
        observationSource: requirements.observationSource,
        timestampUnit: TIME_V.timestampUnit,
        integerEncoding: TIME_V.integerEncoding,
        backwardSkewToleranceMs:
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.backwardSkewToleranceMs
            .toString(),
      },
      {
        kind: TIME_V.kinds.observation,
        timeVersion: TIME_V.version,
        trustBoundary: TIME_V.trustBoundary,
        clockProfile: policyProfile,
        clockAuthority: requirements.clockAuthority,
        observationSource: requirements.observationSource,
        observedAtUnixMs: observed.toString(),
        persistedFloorUnixMs: floor.toString(),
        minimumExpectedFloorUnixMs: floor.toString(),
      },
    );
    if (!evaluated.ok || !evaluated.value.safe) return invariant();
    return evaluated.value;
  }

  #now(): bigint {
    const time = this.#time();
    if (!time.safe) return invariant();
    return BigInt(time.effectiveNowUnixMs);
  }

  #derive(durationMs: number): bigint {
    const derived = deriveSharedStateExpiryV1(
      this.#time(),
      String(durationMs),
    );
    if (!derived.ok) return invariant();
    return BigInt(derived.value);
  }

  #outcomeDigest(namespace: string): string {
    return modelDigest("broker.idempotency.outcome", namespace, [
      { field: "outcomeType", type: "utf8", value: "accepted" },
      { field: "outcomeBody", type: "bytes", value: "2606" },
    ]);
  }

  #underCriticalPressure(): boolean {
    return this.#pressureBand === "critical";
  }

  async transact(
    command: SharedStateTransactionCommandV1,
  ): Promise<unknown> {
    if (!this.#open) return invariant();
    switch (command.operation) {
      case "consumeReplayNonce":
        return this.#consumeReplayNonce(command.input);
      case "reserveRateLimitCost":
        return this.#reserveRateLimitCost(command.input);
      case "claimLease":
        return this.#claimLease(command.input);
      case "renewLease":
        return this.#renewLease(command.input);
      case "mutateWithFence":
        return this.#mutateWithFence(command.input);
      case "executeIdempotent":
        return this.#executeIdempotent(command.input);
      case "appendOutbox":
        return this.#appendOutbox(command.input);
      case "appendGraphSource":
        return this.#appendGraphSource(command.input);
      case "applyGraphProjectionBatch":
        return this.#applyGraphProjectionBatch(command.input);
      default:
        return invariant();
    }
  }

  #consumeReplayNonce(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "consumeReplayNonce" }
    >["input"],
  ): unknown {
    const key = `${input.keyDigest}|${input.nonceDigest}`;
    const now = this.#now();
    const existing = this.#replay.get(key);
    const active = existing !== undefined && now < existing.expiresAt;
    if (active) {
      if (this.#adversarial.permissiveCapacityEviction === true
        && this.#underCriticalPressure()) {
        // Violation: silently evicting an unexpired nonce under pressure.
        this.#replay.delete(key);
        this.#replay.set(key, {
          expiresAt: this.#derive(input.ttlMs),
        });
        return committed("consumeReplayNonce", {
          decision: "accepted",
          expiresInMs: input.ttlMs,
        });
      }
      return committed("consumeReplayNonce", {
        decision: "replay",
        expiresInMs: Number(existing.expiresAt - now),
      });
    }
    // Inserting a record is new work. Capacity pressure sheds new work
    // instead of evicting an unexpired safety record.
    if (this.#underCriticalPressure()) {
      return unavailable("consumeReplayNonce", "authority_unavailable");
    }
    this.#replay.set(key, { expiresAt: this.#derive(input.ttlMs) });
    return committed("consumeReplayNonce", {
      decision: "accepted",
      expiresInMs: input.ttlMs,
    });
  }

  #reserveRateLimitCost(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "reserveRateLimitCost" }
    >["input"],
  ): unknown {
    const now = this.#now();
    const window = BigInt(input.windowMs);
    const entries = this.#rate.get(input.bucketKeyDigest) ?? [];
    // Physical rows outlive the window on purpose; only the logical rule
    // decides which of them still count.
    const counted = entries.filter(
      (entry) => window > now || entry.eventAt > now - window,
    );
    const inWindowCost = counted.reduce(
      (total, entry) => total + entry.cost,
      0,
    );
    if (inWindowCost + input.cost > input.limit) {
      const oldest = counted[0];
      const resetInMs =
        oldest === undefined
          ? 0
          : Number(oldest.eventAt + window - now);
      return committed("reserveRateLimitCost", {
        decision: "rate_limited",
        resetInMs: resetInMs < 0 ? 0 : resetInMs,
      });
    }
    entries.push({ eventAt: now, cost: input.cost });
    this.#rate.set(input.bucketKeyDigest, entries);
    return committed("reserveRateLimitCost", {
      decision: "accepted",
      remaining: input.limit - inWindowCost - input.cost,
      resetInMs: input.windowMs,
    });
  }

  #leaseActive(now: bigint): boolean {
    return this.#lease !== null && now < this.#lease.expiresAt;
  }

  #claimLease(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "claimLease" }
    >["input"],
  ): unknown {
    const now = this.#now();
    if (this.#leaseActive(now)) {
      return rejected("claimLease", "claim_conflict");
    }
    const currentVersion = this.#lease?.resourceVersion ?? 0n;
    if (BigInt(input.expectedResourceVersion) !== currentVersion) {
      return rejected("claimLease", "version_conflict");
    }
    const previousFence = this.#lease?.fencingToken ?? 0n;
    const nextFence =
      this.#adversarial.fenceDoesNotAdvanceOnReclaim === true
        && this.#lease !== null
        ? previousFence
        : previousFence + 1n;
    const attemptNumber = (this.#lease?.ownershipEpoch ?? 0n) + 1n;
    const attemptKeyDigest = modelDigest(
      "broker.lease.attempt-key",
      input.namespace,
      [
        { field: "resourceId", type: "utf8", value: "expiry-resource" },
        {
          field: "attemptNumber",
          type: "uint",
          value: attemptNumber.toString(),
        },
      ],
    );
    // One atomic transition sets owner, attempt, expiry, version, and fence.
    this.#lease = {
      ownerKeyDigest: input.ownerKeyDigest,
      attemptKeyDigest,
      fencingToken: nextFence,
      resourceVersion: currentVersion + 1n,
      expiresAt: this.#derive(input.leaseDurationMs),
      ownershipEpoch: (this.#lease?.ownershipEpoch ?? 0n) + 1n,
    };
    return committed("claimLease", {
      decision: "claimed",
      attemptKeyDigest,
      fencingToken: nextFence.toString(),
      resourceVersion: this.#lease.resourceVersion.toString(),
      leaseExpiresInMs: input.leaseDurationMs,
    });
  }

  #leaseAuthorityFailure(
    input: {
      readonly ownerKeyDigest: string;
      readonly attemptKeyDigest: string;
      readonly fencingToken: string;
    },
    now: bigint,
  ): string | null {
    const lease = this.#lease;
    if (lease === null) return "invalid_state_transition";
    if (BigInt(input.fencingToken) !== lease.fencingToken) {
      return "stale_fence";
    }
    if (input.ownerKeyDigest !== lease.ownerKeyDigest) {
      return "owner_mismatch";
    }
    if (now >= lease.expiresAt) return "lease_expired";
    return null;
  }

  #renewLease(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "renewLease" }
    >["input"],
  ): unknown {
    const now = this.#now();
    const failure = this.#leaseAuthorityFailure(input, now);
    if (failure !== null) return rejected("renewLease", failure);
    const lease = this.#lease;
    if (lease === null) return invariant();
    if (BigInt(input.expectedResourceVersion) !== lease.resourceVersion) {
      return rejected("renewLease", "version_conflict");
    }
    lease.resourceVersion += 1n;
    lease.expiresAt = this.#derive(input.leaseDurationMs);
    return committed("renewLease", {
      decision: "renewed",
      resourceVersion: lease.resourceVersion.toString(),
      leaseExpiresInMs: input.leaseDurationMs,
    });
  }

  #mutateWithFence(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "mutateWithFence" }
    >["input"],
  ): unknown {
    const now = this.#now();
    const failure = this.#leaseAuthorityFailure(input, now);
    if (failure !== null) return rejected("mutateWithFence", failure);
    const lease = this.#lease;
    if (lease === null) return invariant();
    if (BigInt(input.expectedResourceVersion) !== lease.resourceVersion) {
      return rejected("mutateWithFence", "version_conflict");
    }
    lease.resourceVersion += 1n;
    return committed("mutateWithFence", {
      decision: "applied",
      resourceVersion: lease.resourceVersion.toString(),
    });
  }

  #executeIdempotent(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "executeIdempotent" }
    >["input"],
  ): unknown {
    const existing = this.#idempotency.get(input.keyDigest);
    if (existing !== undefined) {
      if (existing.payloadFingerprint !== input.payloadFingerprint) {
        return rejected("executeIdempotent", "idempotency_conflict");
      }
      if (this.#adversarial.permissiveCapacityEviction === true
        && this.#underCriticalPressure()) {
        // Violation: dropping a retained outcome under pressure re-executes
        // the domain mutation a second time.
        this.#idempotency.delete(input.keyDigest);
        return this.#executeIdempotent(input);
      }
      return committed("executeIdempotent", {
        decision: "replayed",
        outcomeDigest: this.#outcomeDigest(input.namespace),
      });
    }
    if (this.#underCriticalPressure()) {
      return unavailable("executeIdempotent", "authority_unavailable");
    }
    this.#idempotency.set(input.keyDigest, {
      payloadFingerprint: input.payloadFingerprint,
    });
    this.#streamSequence += 1n;
    this.#outbox.push({
      idempotencyKeyDigest: input.effect.outbox.eventKeyDigest,
      eventKeyDigest: input.effect.outbox.eventKeyDigest,
      streamSequence: this.#streamSequence,
      receiptState: "pending",
      acknowledgmentState: "unacknowledged",
    });
    return committed("executeIdempotent", {
      decision: "executed",
      outcomeDigest: this.#outcomeDigest(input.namespace),
    });
  }

  #appendOutbox(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "appendOutbox" }
    >["input"],
  ): unknown {
    const existing = this.#outbox.find(
      (event) => event.idempotencyKeyDigest === input.idempotencyKeyDigest,
    );
    if (existing !== undefined) {
      return committed("appendOutbox", {
        decision: "replayed",
        eventKeyDigest: existing.eventKeyDigest,
        streamSequence: existing.streamSequence.toString(),
      });
    }
    this.#streamSequence += 1n;
    const event: OutboxEvent = {
      idempotencyKeyDigest: input.idempotencyKeyDigest,
      eventKeyDigest: input.eventKeyDigest,
      streamSequence: this.#streamSequence,
      receiptState: "pending",
      acknowledgmentState: "unacknowledged",
    };
    this.#outbox.push(event);
    return committed("appendOutbox", {
      decision: "appended",
      eventKeyDigest: event.eventKeyDigest,
      streamSequence: event.streamSequence.toString(),
    });
  }

  #appendGraphSource(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "appendGraphSource" }
    >["input"],
  ): unknown {
    const existing = this.#graphSources.find(
      (source) => source.sourceFactDigest === input.sourceFactDigest,
    );
    if (existing !== undefined) {
      return committed("appendGraphSource", {
        decision: "replayed",
        sourceSequence: existing.sourceSequence.toString(),
      });
    }
    if (BigInt(input.expectedSourceSequence) !== this.#graphSequence) {
      return rejected("appendGraphSource", "source_sequence_conflict");
    }
    this.#graphSequence += 1n;
    this.#graphSources.push({
      sourceFactDigest: input.sourceFactDigest,
      sourceSequence: this.#graphSequence,
    });
    return committed("appendGraphSource", {
      decision: "appended",
      sourceSequence: this.#graphSequence.toString(),
    });
  }

  #applyGraphProjectionBatch(
    input: Extract<
      SharedStateTransactionCommandV1,
      { operation: "applyGraphProjectionBatch" }
    >["input"],
  ): unknown {
    if (this.#projectionBatches.has(input.batchKeyDigest)) {
      return committed("applyGraphProjectionBatch", {
        decision: "replayed",
        checkpointSequence: this.#checkpoint.toString(),
      });
    }
    if (BigInt(input.expectedCheckpointSequence) !== this.#checkpoint) {
      return rejected("applyGraphProjectionBatch", "checkpoint_conflict");
    }
    this.#projectionBatches.add(input.batchKeyDigest);
    this.#checkpoint = BigInt(input.sourceSequenceThrough);
    return committed("applyGraphProjectionBatch", {
      decision: "applied",
      checkpointSequence: this.#checkpoint.toString(),
    });
  }

  applyConformanceCleanupControl(
    control: SharedStateExpiryCleanupControlV1,
  ): void {
    if (control === "attempt-early-eviction") {
      const now = this.#now();
      let activeFound = false;
      for (const record of this.#replay.values()) {
        if (now < record.expiresAt) activeFound = true;
      }
      if (activeFound
        && this.#adversarial.cleanupRemovesActiveRecord === true) {
        // Violation: cleanup removed a logically active record.
        this.#replay.clear();
      }
      this.#cleanupState = "early-eviction-refused";
      return;
    }
    // `defer-physical-cleanup`: retain every physical row, expired or not.
    if (this.#adversarial.implicitTtlOnUnacknowledgedEvent === true) {
      this.#outbox.length = 0;
    }
    this.#cleanupState = "deferred";
  }

  applyConformanceCapacityControl(
    band: (typeof V.pressureBands)[number],
  ): void {
    this.#pressureBand = band;
  }

  async captureConformanceSnapshot(): Promise<unknown> {
    const now = this.#now();
    if (this.#adversarial.implicitTtlOnUnacknowledgedEvent === true
      && this.#outbox.length > 0) {
      // Violation: an implicit TTL silently retires an unacknowledged row.
      this.#outbox.length = 0;
    }
    if (this.#adversarial.ownershipTransfersOnExpiryAlone === true
      && this.#lease !== null
      && now >= this.#lease.expiresAt) {
      // Violation: expiry alone transferred ownership with no transition.
      this.#lease = null;
    }
    let rateRetained = 0;
    for (const entries of this.#rate.values()) {
      rateRetained += entries.length;
    }
    return sharedStateExpiryConformanceSnapshotV1Schema.parse({
      kind: "SharedStateExpiryConformanceSnapshotV1",
      snapshotVersion: 1,
      replayRetainedCount: this.#replay.size,
      rateEntryRetainedCount: rateRetained,
      leaseBinding: this.#lease === null ? "unbound" : "bound",
      activeLeaseCount: this.#leaseActive(now) ? 1 : 0,
      ownershipEpoch: (this.#lease?.ownershipEpoch ?? 0n).toString(),
      maximumFencingToken: (this.#lease?.fencingToken ?? 0n).toString(),
      leaseResourceVersion: (this.#lease?.resourceVersion ?? 0n).toString(),
      idempotencyOutcomeRetainedCount: this.#idempotency.size,
      outboxEventRetainedCount: this.#outbox.length,
      unacknowledgedEventCount: this.#outbox.filter(
        (event) => event.acknowledgmentState === "unacknowledged",
      ).length,
      acknowledgedEventCount: this.#outbox.filter(
        (event) => event.acknowledgmentState === "acknowledged",
      ).length,
      streamSequenceHighWater: this.#streamSequence.toString(),
      provenanceSourceRetainedCount: this.#graphSources.length,
      provenanceSourceSequenceHighWater: this.#graphSequence.toString(),
      provenanceCheckpointSequence: this.#checkpoint.toString(),
      physicalCleanupState: this.#cleanupState,
      capacityPressureBand: this.#pressureBand,
    });
  }
}

function createTestOnlyDeterministicExpiryFactoryV1(
  adversarial: TestOnlyAdversarialExpiryControlV1 = {},
): SharedStateExpiryConformanceTargetFactoryV1 {
  return Object.freeze({
    async create(input: {
      readonly clock: SharedStateExpiryConformanceClockV1;
    }): Promise<SharedStateExpiryConformanceTargetV1> {
      return new TestOnlyDeterministicExpiryReferenceModelV1(
        input.clock,
        adversarial,
      );
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
  adversarial: TestOnlyAdversarialExpiryControlV1,
  expected: string,
): Promise<void> {
  await assert.rejects(
    runSharedStateExpiryConformanceV1(
      createTestOnlyDeterministicExpiryFactoryV1(adversarial),
    ),
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
}

test("labels the expiry model test-only with no durability claim", () => {
  assert.deepEqual(TEST_ONLY_EXPIRY_REFERENCE_MODEL_V1, {
    label: "test-only-deterministic-expiry-reference-model",
    production: false,
    sqlite: false,
    shared: false,
    conforming: false,
    attachedToBrokerRuntime: false,
    durabilityClaim: "none",
    retentionPruneExecution: "not-executed",
    physicallyRetainsExpiredRows: true,
  });
});

test("proves the exact bounded Phase 2.6 expiry-boundary slice", async () => {
  const report = await runSharedStateExpiryConformanceV1(
    createTestOnlyDeterministicExpiryFactoryV1(),
  );

  assert.equal(report.status, "passed");
  assert.equal(report.scope, "expiry-boundaries");
  assert.equal(report.contractVersion, V.versions.contract);
  assert.equal(report.timeVersion, TIME_V.version);

  assert.deepEqual(report.controls, {
    scheduler: "seeded-deterministic-serial",
    schedulerSeed: SHARED_STATE_EXPIRY_CONFORMANCE_V1.schedulerSeed,
    concurrency: "not-exercised",
    barrier: "not-required",
    clock: "single-injected-fake-exact-integer",
    targetIsolation: "factory-created-per-scenario",
    targetCount: SHARED_STATE_EXPIRY_CONFORMANCE_V1.targetCount,
    targetCommandLimit:
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.targetCommandLimit,
    targetCommandCount:
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedTargetCommandCount,
    lifecycleLimit: SHARED_STATE_EXPIRY_CONFORMANCE_V1.lifecycleLimit,
    lifecycleCount:
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedLifecycleCount,
    snapshotControlLimit:
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.snapshotControlLimit,
    snapshotControlCount:
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedSnapshotControlCount,
    cleanupControlCount:
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.cleanupControlCount,
    capacityControlCount:
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.capacityControlCount,
    clockControlCount:
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.clockControlCount,
  });

  // Every closed boundary kind is probed at exactly three points.
  assert.equal(
    report.boundaryProbe.cases.length,
    SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedProbeCaseCount,
  );
  assert.equal(
    report.boundaryProbe.fixtureCoverage,
    "exactly-the-closed-boundary-kinds",
  );
  for (const fixtureKind of SHARED_STATE_EXPIRY_BOUNDARY_FIXTURES_V1) {
    const forFixture = report.boundaryProbe.cases.filter(
      (probe) => probe.fixtureKind === fixtureKind,
    );
    assert.equal(
      forFixture.length,
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.probePointCount,
    );
    assert.deepEqual(
      forFixture.map((probe) => probe.probePoint),
      [...SHARED_STATE_EXPIRY_PROBE_POINTS_V1],
    );
  }

  // The equality point is expired/excluded, never active/counted.
  const atEquality = report.boundaryProbe.cases.filter(
    (probe) => probe.probePoint === "expiry",
  );
  assert.equal(atEquality.length, 4);
  for (const probe of atEquality) {
    assert.equal(
      probe.boundaryDecision === "expired"
        || probe.boundaryDecision === "excluded",
      true,
    );
  }
  const beforeEquality = report.boundaryProbe.cases.filter(
    (probe) => probe.probePoint === "expiry-minus-1",
  );
  for (const probe of beforeEquality) {
    assert.equal(
      probe.boundaryDecision === "active"
        || probe.boundaryDecision === "counted",
      true,
    );
  }
  assert.equal(report.boundaryProbe.expiryEqualityDecision, "expired");
  assert.equal(report.boundaryProbe.rateWindowEqualityDecision, "excluded");
  assert.equal(report.boundaryProbe.beforeEpochThresholdDecision, "counted");
  assert.equal(
    report.boundaryProbe.callerSuppliedAbsoluteTime,
    "forbidden",
  );

  // Operational decisions track the pure boundary decision exactly.
  const replayProbes = report.boundaryProbe.cases.filter(
    (probe) => probe.fixtureKind === "replay-ttl",
  );
  assert.deepEqual(
    replayProbes.map((probe) => probe.operationOutcome),
    ["replay", "accepted", "accepted"],
  );
  const rateProbes = report.boundaryProbe.cases.filter(
    (probe) => probe.fixtureKind === "rate-window-entry",
  );
  assert.deepEqual(
    rateProbes.map((probe) => probe.operationOutcome),
    ["rate_limited", "accepted", "accepted"],
  );
  const leaseProbes = report.boundaryProbe.cases.filter(
    (probe) => probe.fixtureKind === "lease",
  );
  assert.deepEqual(
    leaseProbes.map((probe) => probe.operationOutcome),
    ["applied", "lease_expired", "lease_expired"],
  );
  // Logical retention expiry never deletes a retained outcome, because this
  // slice does not execute retention or prune.
  const retentionProbes = report.boundaryProbe.cases.filter(
    (probe) => probe.fixtureKind === "idempotency-explicit-retention",
  );
  assert.deepEqual(
    retentionProbes.map((probe) => probe.operationOutcome),
    ["replayed", "replayed", "replayed"],
  );

  assert.deepEqual(report.cleanupIndependence, {
    activeRecordEarlyEviction: "refused",
    activeDecisionBeforeCleanup: "replay",
    expiredRecordPhysicalState: "retained",
    expiredReplayDecision: "accepted",
    expiredRateDecision: "accepted",
    presenceIsEvaluatorInput: false,
    retainedCountChangedByExpiry: false,
  });

  assert.deepEqual(report.capacityPressure, {
    band: "critical",
    newRequestStatus: "unavailable",
    newRequestReasonCode: "authority_unavailable",
    unexpiredReplayDecision: "replay",
    unexpiredIdempotencyDecision: "replayed",
    permissiveEvictionObserved: false,
    duplicateEffectCount: 0,
    retainedSafetyRecordCountChanged: false,
  });

  assert.deepEqual(report.leaseTransition, {
    expiryAloneTransfersOwnership: false,
    ownershipEpochUnchangedOnExpiry: true,
    expiredRenewOutcome: "lease_expired",
    reclaimOutcome: "claimed",
    reclaimAtomicity: "single-committed-transition",
    fenceAdvanced: "strictly-greater",
    staleFenceMutationOutcome: "stale_fence",
    staleRejectionChangedState: false,
  });

  assert.deepEqual(report.implicitTtl, {
    advanceMs: SHARED_STATE_EXPIRY_CONFORMANCE_V1.noImplicitTtlAdvanceMs,
    unacknowledgedEventState: "retained-unacknowledged",
    unacknowledgedAppendRetryOutcome: "replayed",
    provenanceSourceState: "retained",
    provenanceAppendRetryOutcome: "replayed",
    provenanceCheckpointState: "original-preserved",
    outboxCommandTtlFieldRejection: "unknown_field",
    provenanceCommandTtlFieldRejection: "unknown_field",
    registeredRetentionPostures: "all-non-expiring-until-prune-proof",
    registeredBoundaryAttemptRejection: "expiry_boundary_forbidden",
    allowedRetentionBoundaryDecision:
      "explicit_time_v1_boundary_accepted",
    capacityCeilingIsRetentionConformance: false,
  });

  assert.deepEqual(report.claims, {
    referenceModel: "test-only",
    adapterConformance: "not-claimed",
    runtimeIntegration: "none",
    storageQueryContract: "none",
    retentionPruneExecution: "not-executed",
    partitionUnavailableInjection: "out-of-scope",
    readinessRouteBehavior: "out-of-scope",
  });

  assertDeepFrozen(report);
});

test("uses a stable seeded fixture order with no barrier", () => {
  const first = seededDeterministicExpiryFixtureOrderV1();
  const second = seededDeterministicExpiryFixtureOrderV1();
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(
    first.length,
    SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryFixtureCount,
  );
  assert.deepEqual(
    [...first].sort(),
    [...SHARED_STATE_EXPIRY_BOUNDARY_FIXTURES_V1].sort(),
  );
});

test("fails closed on each adversarial expiry violation", async () => {
  // Item: capacity pressure must never evict an unexpired safety record.
  await expectConformanceErrorCode(
    { permissiveCapacityEviction: true },
    "capacity_eviction_permissive",
  );
  // Item: an atomic ownership transition must advance the fence.
  await expectConformanceErrorCode(
    { fenceDoesNotAdvanceOnReclaim: true },
    "fence_not_advanced",
  );
  // Item: cleanup must not remove a logically active record.
  await expectConformanceErrorCode(
    { cleanupRemovesActiveRecord: true },
    "active_record_removed",
  );
  // Item: unacknowledged outbox rows have no implicit TTL.
  await expectConformanceErrorCode(
    { implicitTtlOnUnacknowledgedEvent: true },
    "implicit_ttl_detected",
  );
  // Item: expiry alone must not transfer ownership.
  await expectConformanceErrorCode(
    { ownershipTransfersOnExpiryAlone: true },
    "lease_ownership_transition_mismatch",
  );
});

test(
  "keeps reports, snapshots, controls, and errors strict and non-reflecting",
  async () => {
    const report = await runSharedStateExpiryConformanceV1(
      createTestOnlyDeterministicExpiryFactoryV1(),
    );

    const forbiddenPublicKeys =
      /(?:identity|digest|namespace|prompt|payload|path|secret|endpoint|host|provider|worker|task|timestamp)/iu;
    assert.equal(
      collectKeys(report).some((key) => forbiddenPublicKeys.test(key)),
      false,
    );

    assert.equal(
      sharedStateExpiryConformanceReportV1Schema.safeParse({
        ...report,
        reflectedTargetError: "leaked",
      }).success,
      false,
    );
    assert.equal(
      sharedStateExpiryConformanceSnapshotV1Schema.safeParse({
        kind: "SharedStateExpiryConformanceSnapshotV1",
        snapshotVersion: 1,
        identityDigest: "leaked",
      }).success,
      false,
    );
    assert.equal(
      sharedStateExpiryErrorReportV1Schema.safeParse({
        kind: "SharedStateExpiryConformanceErrorV1",
        errorVersion: 1,
        code: "report_invalid",
        targetError: "leaked",
      }).success,
      false,
    );

    const sentinel = "sensitive-target-value";
    await assert.rejects(
      runSharedStateExpiryConformanceV1({
        async create() {
          throw new Error(sentinel);
        },
      }),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateExpiryConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStateExpiryConformanceErrorV1)) {
          return false;
        }
        assert.equal(error.code, "target_create_failed");
        assert.equal(error.message.includes(sentinel), false);
        assert.equal(error.stack?.includes(sentinel) ?? false, false);
        assert.deepEqual(error.toJSON(), {
          kind: "SharedStateExpiryConformanceErrorV1",
          errorVersion: 1,
          code: "target_create_failed",
        });
        assertDeepFrozen(error.toJSON());
        return true;
      },
    );
  },
);

test("pins the exact expiry-probe and existing decision vocabulary", () => {
  assert.deepEqual(
    [...SHARED_STATE_EXPIRY_PROBE_POINTS_V1],
    ["expiry-minus-1", "expiry", "expiry-plus-1"],
  );
  assert.deepEqual(
    [...SHARED_STATE_EXPIRY_CLEANUP_CONTROLS_V1],
    ["attempt-early-eviction", "defer-physical-cleanup"],
  );
  // The declared fixtures are exactly the closed time V1 boundary vocabulary.
  assert.deepEqual(
    [...SHARED_STATE_EXPIRY_BOUNDARY_FIXTURES_V1].sort(),
    [...TIME_V.boundaryKinds].sort(),
  );
  // The harness reuses existing decision and rejection vocabulary only.
  assert.deepEqual(
    [...V.operationDecisions.consumeReplayNonce],
    ["accepted", "replay"],
  );
  assert.deepEqual(
    [...V.operationDecisions.executeIdempotent],
    ["executed", "replayed"],
  );
  assert.equal(
    V.operationRejectionReasonCodes.renewLease.includes("lease_expired"),
    true,
  );
  assert.equal(
    V.operationRejectionReasonCodes.mutateWithFence.includes("stale_fence"),
    true,
  );
  assert.equal(
    V.unavailableReasonCodes.includes("authority_unavailable"),
    true,
  );
  assert.equal(
    SHARED_STATE_EXPIRY_ERROR_CODES_V1.includes("reference_model_invariant"),
    true,
  );
  assert.equal(
    new Set(SHARED_STATE_EXPIRY_ERROR_CODES_V1).size,
    SHARED_STATE_EXPIRY_ERROR_CODES_V1.length,
  );
});
