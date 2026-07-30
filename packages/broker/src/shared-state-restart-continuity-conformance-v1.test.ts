/**
 * TEST-ONLY deterministic restart-continuity reference model.
 *
 * This bounded in-memory model is non-production, non-SQLite, non-shared,
 * non-conforming, and detached from broker runtime. It exists only in this
 * adjacent test file to exercise the backend-neutral Phase 2.4 harness.
 * Close/reopen retains this test object's state solely as a conformance
 * control; that retention is not a durability claim.
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
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_TIME_V1_VALUES as TIME_V,
  deriveSharedStateExpiryV1,
  evaluateSharedStateLogicalBoundaryV1,
  evaluateSharedStateTimeV1,
  type SharedStateClockProfileV1,
  type SharedStateTimeEvaluationV1,
  type SharedStateTimePolicyV1,
} from "./shared-state-time-v1.js";
import {
  SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1,
  SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1,
  SharedStateRestartContinuityConformanceErrorV1,
  runSharedStateRestartContinuityConformanceV1,
  seededDeterministicRestartFaultOrderV1,
  sharedStateRestartContinuityConformanceCursorV1Schema,
  sharedStateRestartContinuityConformanceReconcileResponseV1Schema,
  sharedStateRestartContinuityConformanceReportV1Schema,
  sharedStateRestartContinuityConformanceSnapshotV1Schema,
  sharedStateRestartContinuityErrorReportV1Schema,
  type SharedStateRestartContinuityConformanceClockV1,
  type SharedStateRestartContinuityConformanceCursorV1,
  type SharedStateRestartContinuityConformanceTargetFactoryV1,
  type SharedStateRestartContinuityConformanceTargetV1,
  type SharedStateRestartContinuityFaultPointV1,
} from "./shared-state-restart-continuity-conformance-v1.js";

const TEST_ONLY_DETERMINISTIC_RESTART_CONTINUITY_REFERENCE_MODEL_V1 =
  Object.freeze({
    role: "test-only-deterministic-reference-model",
    productionAdapter: false,
    sqliteAdapter: false,
    sharedAdapter: false,
    conformingAdapterClaim: false,
    backendClassClaim: "none",
    runtimeIntegration: "not-attached",
    persistenceClaim: "none",
    closeReopenRetention: "test-control-not-durability",
  } as const);

interface ReplayRecord {
  readonly expiresAt: bigint;
}

interface RateEntry {
  readonly cost: number;
  readonly eventAt: bigint;
  readonly windowMs: number;
}

interface LeaseRecord {
  readonly ownerKeyDigest: string;
  readonly attemptKeyDigest: string;
  readonly fencingToken: bigint;
  resourceVersion: bigint;
  expiresAt: bigint;
}

interface IdempotencyRecord {
  readonly payloadFingerprint: string;
  readonly outcomeDigest: string;
}

interface OutboxEvent {
  readonly idempotencyKeyDigest: string;
  readonly eventKeyDigest: string;
  readonly payloadDigest: string;
  readonly streamSequence: bigint;
  receiptState: "pending" | "confirmed" | "failed";
  acknowledgmentState: "unacknowledged" | "acknowledged";
}

interface OutboxStream {
  highWater: bigint;
  readonly events: Map<string, OutboxEvent>;
}

interface GraphFact {
  readonly sourceFactDigest: string;
  readonly sourceSequence: bigint;
}

interface ProjectionBatch {
  readonly batchDigest: string;
  readonly checkpointSequence: bigint;
}

interface ModelState {
  readonly replay: Map<string, ReplayRecord>;
  readonly rate: Map<string, RateEntry[]>;
  lease: LeaseRecord | null;
  maximumFencingToken: bigint;
  leaseResourceVersionHighWater: bigint;
  leaseMutationCount: number;
  readonly idempotency: Map<string, IdempotencyRecord>;
  domainEffectCount: number;
  idempotentOutboxEffectCount: number;
  readonly outboxStreams: Map<string, OutboxStream>;
  readonly outboxBindings: Map<string, OutboxEvent>;
  readonly graphFacts: Map<string, GraphFact>;
  graphSourceSequenceHighWater: bigint;
  readonly projectionBatches: Map<string, ProjectionBatch>;
  graphProjectionCheckpointHighWater: bigint;
  persistedClockFloor: bigint | null;
}

function invariant(): never {
  throw new SharedStateRestartContinuityConformanceErrorV1(
    "reference_model_invariant",
  );
}

function initialState(): ModelState {
  return {
    replay: new Map(),
    rate: new Map(),
    lease: null,
    maximumFencingToken: 0n,
    leaseResourceVersionHighWater: 0n,
    leaseMutationCount: 0,
    idempotency: new Map(),
    domainEffectCount: 0,
    idempotentOutboxEffectCount: 0,
    outboxStreams: new Map(),
    outboxBindings: new Map(),
    graphFacts: new Map(),
    graphSourceSequenceHighWater: 0n,
    projectionBatches: new Map(),
    graphProjectionCheckpointHighWater: 0n,
    persistedClockFloor: null,
  };
}

function lifecycle(
  state: "ready" | "closed" | "failed",
  reasonCodes: readonly (
    | "close_requested"
    | "ownership_conflict"
    | "lost_fence"
    | "unsafe_clock"
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
  reasonCode:
    | "authority_unavailable"
    | "ambiguous_commit"
    | "unsafe_clock",
): unknown {
  return transactionResult(operation, {
    status: "unavailable",
    completeness: "unavailable",
    reasonCode,
  });
}

function timePolicyForProfile(
  clockProfile: SharedStateClockProfileV1,
): SharedStateTimePolicyV1 {
  const requirements = TIME_V.profileRequirements[clockProfile];
  return {
    kind: TIME_V.kinds.policy,
    timeVersion: TIME_V.version,
    clockProfile,
    clockAuthority: requirements.clockAuthority,
    observationSource: requirements.observationSource,
    timestampUnit: TIME_V.timestampUnit,
    integerEncoding: TIME_V.integerEncoding,
    backwardSkewToleranceMs:
      SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .backwardSkewToleranceMs
        .toString(),
  };
}

const TIME_POLICIES = Object.freeze(
  TIME_V.clockProfiles.map(timePolicyForProfile),
);

function digest(
  domain:
    | "broker.lease.attempt-key"
    | "broker.idempotency.outcome",
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

function idempotencyOutcomeDigest(
  command: Extract<
    SharedStateTransactionCommandV1,
    { readonly operation: "executeIdempotent" }
  >,
): string {
  const bytes = command.input.payloadFingerprint.split(":").at(-1);
  if (bytes === undefined || !/^[0-9a-f]{64}$/.test(bytes)) {
    return invariant();
  }
  return digest(
    "broker.idempotency.outcome",
    command.input.namespace,
    [
      {
        field: "outcomeType",
        type: "utf8",
        value: "restart-continuity-reference",
      },
      { field: "outcomeBody", type: "bytes", value: bytes },
    ],
  );
}

function decimalDifference(later: bigint, earlier: bigint): number {
  const value = later - earlier;
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return invariant();
  }
  return Number(value);
}

type TestOnlyExtraneousPostCommitMutationV1 =
  | "lease-mutation-after-command-commit"
  | "graph-high-water-after-ack-commit";

interface TestOnlyAdversarialCrashControlV1 {
  readonly mutation: TestOnlyExtraneousPostCommitMutationV1;
  appliedCount: number;
}

/**
 * Bounded in-memory target used only by this test file. Its persisted state
 * object survives close/reopen and simulated crash solely so the harness can
 * test observable continuity. This is not disk durability or adapter
 * conformance.
 */
class TestOnlyDeterministicRestartContinuityReferenceModelV1
implements SharedStateRestartContinuityConformanceTargetV1 {
  readonly #clock: SharedStateRestartContinuityConformanceClockV1;
  readonly #adversarialCrashControl:
    TestOnlyAdversarialCrashControlV1 | null;
  readonly #state = initialState();
  #open = false;
  #unsafeClock = false;
  #armedFault: SharedStateRestartContinuityFaultPointV1 | null = null;

  constructor(
    clock: SharedStateRestartContinuityConformanceClockV1,
    adversarialCrashControl:
      TestOnlyAdversarialCrashControlV1 | null = null,
  ) {
    this.#clock = clock;
    this.#adversarialCrashControl = adversarialCrashControl;
  }

  #evaluateTime(): SharedStateTimeEvaluationV1 {
    const observed = this.#clock.readObservedUnixMilliseconds();
    const persisted = this.#state.persistedClockFloor ?? observed;
    let commonEvaluation: SharedStateTimeEvaluationV1 | null = null;
    for (const policy of TIME_POLICIES) {
      const evaluated = evaluateSharedStateTimeV1(policy, {
        kind: TIME_V.kinds.observation,
        timeVersion: TIME_V.version,
        trustBoundary: TIME_V.trustBoundary,
        clockProfile: policy.clockProfile,
        clockAuthority: policy.clockAuthority,
        observationSource: policy.observationSource,
        observedAtUnixMs: observed.toString(),
        persistedFloorUnixMs: persisted.toString(),
        minimumExpectedFloorUnixMs:
          this.#state.persistedClockFloor?.toString() ?? null,
      });
      if (!evaluated.ok) return invariant();
      if (
        commonEvaluation !== null
        && JSON.stringify(commonEvaluation)
          !== JSON.stringify(evaluated.value)
      ) {
        return invariant();
      }
      commonEvaluation = evaluated.value;
    }
    if (commonEvaluation === null) return invariant();
    if (commonEvaluation.safe) {
      this.#state.persistedClockFloor = BigInt(
        commonEvaluation.nextPersistedFloorUnixMs,
      );
    }
    return commonEvaluation;
  }

  #active(
    time: SharedStateTimeEvaluationV1,
    kind: "replay-ttl" | "lease",
    expiresAt: bigint,
  ): boolean {
    const evaluated = evaluateSharedStateLogicalBoundaryV1(time, {
      timeVersion: TIME_V.version,
      kind,
      expiresAtUnixMs: expiresAt.toString(),
    });
    if (!evaluated.ok) return invariant();
    return evaluated.value.decision === "active";
  }

  #counted(
    time: SharedStateTimeEvaluationV1,
    entry: RateEntry,
  ): boolean {
    const evaluated = evaluateSharedStateLogicalBoundaryV1(time, {
      timeVersion: TIME_V.version,
      kind: "rate-window-entry",
      eventAtUnixMs: entry.eventAt.toString(),
      windowMs: entry.windowMs.toString(),
    });
    if (!evaluated.ok) return invariant();
    return evaluated.value.decision === "counted";
  }

  #deriveExpiry(
    time: SharedStateTimeEvaluationV1,
    durationMs: number,
  ): bigint {
    const derived = deriveSharedStateExpiryV1(
      time,
      durationMs.toString(),
    );
    if (!derived.ok) return invariant();
    return BigInt(derived.value);
  }

  #crash(): void {
    this.#open = false;
    this.#armedFault = null;
  }

  #applyBoundedExtraneousPostCommitMutation(
    mutation: TestOnlyExtraneousPostCommitMutationV1,
  ): void {
    const control = this.#adversarialCrashControl;
    if (control === null || control.mutation !== mutation) return;
    if (control.appliedCount !== 0) return invariant();
    control.appliedCount += 1;
    if (mutation === "lease-mutation-after-command-commit") {
      this.#state.leaseMutationCount += 1;
    } else {
      this.#state.graphSourceSequenceHighWater += 1n;
    }
  }

  async open(): Promise<unknown> {
    if (this.#open) return lifecycle("failed", ["ownership_conflict"]);
    const time = this.#evaluateTime();
    if (!time.safe) {
      this.#unsafeClock = true;
      return lifecycle("failed", ["unsafe_clock"]);
    }
    this.#unsafeClock = false;
    this.#open = true;
    return lifecycle("ready", []);
  }

  async close(): Promise<unknown> {
    if (!this.#open) return lifecycle("failed", ["lost_fence"]);
    this.#open = false;
    this.#armedFault = null;
    return lifecycle("closed", ["close_requested"]);
  }

  armConformanceCrashFault(
    faultPoint: SharedStateRestartContinuityFaultPointV1,
  ): void {
    if (
      this.#armedFault !== null
      || !SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1
        .includes(faultPoint)
    ) {
      invariant();
    }
    this.#armedFault = faultPoint;
  }

  async transact(
    command: SharedStateTransactionCommandV1,
  ): Promise<unknown> {
    const parsed = parseSharedStateTransactionCommandV1(command);
    if (!parsed.ok) return invariant();
    if (this.#unsafeClock) {
      return unavailable(parsed.value.operation, "unsafe_clock");
    }
    if (!this.#open) {
      return unavailable(parsed.value.operation, "authority_unavailable");
    }
    const time = this.#evaluateTime();
    if (!time.safe) {
      this.#open = false;
      this.#unsafeClock = true;
      return unavailable(parsed.value.operation, "unsafe_clock");
    }

    switch (parsed.value.operation) {
      case "consumeReplayNonce":
        return this.#consumeReplayNonce(parsed.value, time);
      case "reserveRateLimitCost":
        return this.#reserveRateLimitCost(parsed.value, time);
      case "claimLease":
        return this.#claimLease(parsed.value, time);
      case "renewLease":
        return this.#renewLease(parsed.value, time);
      case "mutateWithFence":
        return this.#mutateWithFence(parsed.value, time);
      case "releaseLease":
        return rejected("releaseLease", "invalid_state_transition");
      case "executeIdempotent":
        return this.#executeIdempotent(parsed.value);
      case "appendOutbox":
        return this.#appendOutbox(parsed.value);
      case "updateOutboxReceipt":
        return this.#updateOutboxReceipt(parsed.value);
      case "acknowledgeOutbox":
        return this.#acknowledgeOutbox(parsed.value);
      case "appendGraphSource":
        return this.#appendGraphSource(parsed.value);
      case "applyGraphProjectionBatch":
        return this.#applyGraphProjectionBatch(parsed.value);
      case "rollbackGraphProjectionBatch":
        return rejected(
          "rollbackGraphProjectionBatch",
          "projection_batch_not_found",
        );
    }
  }

  #consumeReplayNonce(
    command: Extract<
      SharedStateTransactionCommandV1,
      { readonly operation: "consumeReplayNonce" }
    >,
    time: SharedStateTimeEvaluationV1,
  ): unknown {
    if (!time.safe) return invariant();
    const key = `${command.input.keyDigest}|${command.input.nonceDigest}`;
    const existing = this.#state.replay.get(key);
    if (
      existing !== undefined
      && this.#active(time, "replay-ttl", existing.expiresAt)
    ) {
      return committed("consumeReplayNonce", {
        decision: "replay",
        expiresInMs: decimalDifference(
          existing.expiresAt,
          BigInt(time.effectiveNowUnixMs),
        ),
      });
    }
    const expiresAt = this.#deriveExpiry(time, command.input.ttlMs);
    this.#state.replay.set(key, { expiresAt });
    return committed("consumeReplayNonce", {
      decision: "accepted",
      expiresInMs: command.input.ttlMs,
    });
  }

  #reserveRateLimitCost(
    command: Extract<
      SharedStateTransactionCommandV1,
      { readonly operation: "reserveRateLimitCost" }
    >,
    time: SharedStateTimeEvaluationV1,
  ): unknown {
    if (!time.safe) return invariant();
    const existing =
      this.#state.rate.get(command.input.bucketKeyDigest) ?? [];
    const counted = existing.filter((entry) => this.#counted(time, entry));
    this.#state.rate.set(command.input.bucketKeyDigest, counted);
    const accumulated = counted.reduce(
      (sum, entry) => sum + entry.cost,
      0,
    );
    const resetInMs = counted.length === 0
      ? command.input.windowMs
      : Math.max(
          0,
          decimalDifference(
            counted[0]!.eventAt + BigInt(counted[0]!.windowMs),
            BigInt(time.effectiveNowUnixMs),
          ),
        );
    if (accumulated + command.input.cost > command.input.limit) {
      return committed("reserveRateLimitCost", {
        decision: "rate_limited",
        resetInMs,
      });
    }
    counted.push({
      cost: command.input.cost,
      eventAt: BigInt(time.effectiveNowUnixMs),
      windowMs: command.input.windowMs,
    });
    return committed("reserveRateLimitCost", {
      decision: "accepted",
      remaining:
        command.input.limit - accumulated - command.input.cost,
      resetInMs: command.input.windowMs,
    });
  }

  #claimLease(
    command: Extract<
      SharedStateTransactionCommandV1,
      { readonly operation: "claimLease" }
    >,
    time: SharedStateTimeEvaluationV1,
  ): unknown {
    if (!time.safe) return invariant();
    if (
      this.#state.lease !== null
      && this.#active(time, "lease", this.#state.lease.expiresAt)
    ) {
      return rejected("claimLease", "claim_conflict");
    }
    if (
      command.input.expectedResourceVersion
      !== this.#state.leaseResourceVersionHighWater.toString()
    ) {
      return rejected("claimLease", "version_conflict");
    }
    const fence = this.#state.maximumFencingToken + 1n;
    const resourceVersion =
      this.#state.leaseResourceVersionHighWater + 1n;
    const attemptKeyDigest = digest(
      "broker.lease.attempt-key",
      command.input.namespace,
      [
        { field: "resourceId", type: "utf8", value: "continuity" },
        { field: "attemptNumber", type: "uint", value: fence.toString() },
      ],
    );
    this.#state.maximumFencingToken = fence;
    this.#state.leaseResourceVersionHighWater = resourceVersion;
    this.#state.lease = {
      ownerKeyDigest: command.input.ownerKeyDigest,
      attemptKeyDigest,
      fencingToken: fence,
      resourceVersion,
      expiresAt: this.#deriveExpiry(time, command.input.leaseDurationMs),
    };
    return committed("claimLease", {
      decision: "claimed",
      attemptKeyDigest,
      fencingToken: fence.toString(),
      resourceVersion: resourceVersion.toString(),
      leaseExpiresInMs: command.input.leaseDurationMs,
    });
  }

  #leaseAuthority(
    command: Extract<
      SharedStateTransactionCommandV1,
      {
        readonly operation:
          | "renewLease"
          | "mutateWithFence";
      }
    >,
    time: SharedStateTimeEvaluationV1,
  ): LeaseRecord | string {
    const lease = this.#state.lease;
    if (lease === null) return "stale_fence";
    if (lease.ownerKeyDigest !== command.input.ownerKeyDigest) {
      return "owner_mismatch";
    }
    if (
      lease.attemptKeyDigest !== command.input.attemptKeyDigest
      || lease.fencingToken.toString() !== command.input.fencingToken
    ) {
      return "stale_fence";
    }
    if (
      lease.resourceVersion.toString()
      !== command.input.expectedResourceVersion
    ) {
      return "version_conflict";
    }
    if (!this.#active(time, "lease", lease.expiresAt)) {
      return "lease_expired";
    }
    return lease;
  }

  #renewLease(
    command: Extract<
      SharedStateTransactionCommandV1,
      { readonly operation: "renewLease" }
    >,
    time: SharedStateTimeEvaluationV1,
  ): unknown {
    const authority = this.#leaseAuthority(command, time);
    if (typeof authority === "string") {
      return rejected("renewLease", authority);
    }
    authority.resourceVersion += 1n;
    authority.expiresAt = this.#deriveExpiry(
      time,
      command.input.leaseDurationMs,
    );
    this.#state.leaseResourceVersionHighWater =
      authority.resourceVersion;
    return committed("renewLease", {
      decision: "renewed",
      resourceVersion: authority.resourceVersion.toString(),
      leaseExpiresInMs: command.input.leaseDurationMs,
    });
  }

  #mutateWithFence(
    command: Extract<
      SharedStateTransactionCommandV1,
      { readonly operation: "mutateWithFence" }
    >,
    time: SharedStateTimeEvaluationV1,
  ): unknown {
    const authority = this.#leaseAuthority(command, time);
    if (typeof authority === "string") {
      return rejected("mutateWithFence", authority);
    }
    authority.resourceVersion += 1n;
    this.#state.leaseResourceVersionHighWater =
      authority.resourceVersion;
    this.#state.leaseMutationCount += 1;
    return committed("mutateWithFence", {
      decision: "applied",
      resourceVersion: authority.resourceVersion.toString(),
    });
  }

  #executeIdempotent(
    command: Extract<
      SharedStateTransactionCommandV1,
      { readonly operation: "executeIdempotent" }
    >,
  ): unknown {
    const existing = this.#state.idempotency.get(command.input.keyDigest);
    if (existing !== undefined) {
      if (
        existing.payloadFingerprint !== command.input.payloadFingerprint
      ) {
        return rejected("executeIdempotent", "idempotency_conflict");
      }
      return committed("executeIdempotent", {
        decision: "replayed",
        outcomeDigest: existing.outcomeDigest,
      });
    }

    const fault = this.#armedFault;
    if (fault === "before-command-commit") {
      this.#crash();
      return unavailable("executeIdempotent", "authority_unavailable");
    }
    if (
      fault !== null
      && fault !== "after-command-commit-before-response"
    ) {
      return invariant();
    }

    const outcomeDigest = idempotencyOutcomeDigest(command);
    this.#state.idempotency.set(command.input.keyDigest, {
      payloadFingerprint: command.input.payloadFingerprint,
      outcomeDigest,
    });
    this.#state.domainEffectCount += 1;
    this.#state.idempotentOutboxEffectCount += 1;
    if (fault === "after-command-commit-before-response") {
      this.#applyBoundedExtraneousPostCommitMutation(
        "lease-mutation-after-command-commit",
      );
      this.#crash();
      return unavailable("executeIdempotent", "ambiguous_commit");
    }
    return committed("executeIdempotent", {
      decision: "executed",
      outcomeDigest,
    });
  }

  #appendOutbox(
    command: Extract<
      SharedStateTransactionCommandV1,
      { readonly operation: "appendOutbox" }
    >,
  ): unknown {
    const existing = this.#state.outboxBindings.get(
      command.input.idempotencyKeyDigest,
    );
    if (existing !== undefined) {
      if (
        existing.payloadDigest !== command.input.payloadDigest
        || existing.eventKeyDigest !== command.input.eventKeyDigest
      ) {
        return rejected("appendOutbox", "idempotency_conflict");
      }
      return committed("appendOutbox", {
        decision: "replayed",
        eventKeyDigest: existing.eventKeyDigest,
        streamSequence: existing.streamSequence.toString(),
      });
    }
    let stream = this.#state.outboxStreams.get(
      command.input.streamKeyDigest,
    );
    if (stream === undefined) {
      stream = {
        highWater: 0n,
        events: new Map(),
      };
      this.#state.outboxStreams.set(
        command.input.streamKeyDigest,
        stream,
      );
    }
    stream.highWater += 1n;
    const event: OutboxEvent = {
      idempotencyKeyDigest: command.input.idempotencyKeyDigest,
      eventKeyDigest: command.input.eventKeyDigest,
      payloadDigest: command.input.payloadDigest,
      streamSequence: stream.highWater,
      receiptState: "pending",
      acknowledgmentState: "unacknowledged",
    };
    stream.events.set(command.input.eventKeyDigest, event);
    this.#state.outboxBindings.set(
      command.input.idempotencyKeyDigest,
      event,
    );
    return committed("appendOutbox", {
      decision: "appended",
      eventKeyDigest: event.eventKeyDigest,
      streamSequence: event.streamSequence.toString(),
    });
  }

  #findOutboxEvent(
    streamKeyDigest: string,
    eventKeyDigest: string,
  ): OutboxEvent | null {
    return (
      this.#state.outboxStreams
        .get(streamKeyDigest)
        ?.events.get(eventKeyDigest)
      ?? null
    );
  }

  #updateOutboxReceipt(
    command: Extract<
      SharedStateTransactionCommandV1,
      { readonly operation: "updateOutboxReceipt" }
    >,
  ): unknown {
    const event = this.#findOutboxEvent(
      command.input.streamKeyDigest,
      command.input.eventKeyDigest,
    );
    if (event === null) {
      return rejected("updateOutboxReceipt", "event_not_found");
    }
    if (event.receiptState !== command.input.expectedReceiptState) {
      return rejected(
        "updateOutboxReceipt",
        "receipt_state_conflict",
      );
    }
    event.receiptState = command.input.newReceiptState;
    return committed("updateOutboxReceipt", {
      decision: "updated",
      receiptState: event.receiptState,
    });
  }

  #acknowledgeOutbox(
    command: Extract<
      SharedStateTransactionCommandV1,
      { readonly operation: "acknowledgeOutbox" }
    >,
  ): unknown {
    const event = this.#findOutboxEvent(
      command.input.streamKeyDigest,
      command.input.eventKeyDigest,
    );
    if (event === null) {
      return rejected("acknowledgeOutbox", "event_not_found");
    }
    if (event.acknowledgmentState === "acknowledged") {
      return committed("acknowledgeOutbox", {
        decision: "already_acknowledged",
        acknowledgmentState: "acknowledged",
      });
    }
    if (event.receiptState !== "confirmed") {
      return rejected("acknowledgeOutbox", "receipt_not_confirmed");
    }

    const fault = this.#armedFault;
    if (fault === "before-ack-commit") {
      this.#crash();
      return unavailable("acknowledgeOutbox", "authority_unavailable");
    }
    if (
      fault !== null
      && fault !== "after-ack-commit-before-response"
    ) {
      return invariant();
    }
    event.acknowledgmentState = "acknowledged";
    if (fault === "after-ack-commit-before-response") {
      this.#applyBoundedExtraneousPostCommitMutation(
        "graph-high-water-after-ack-commit",
      );
      this.#crash();
      return unavailable("acknowledgeOutbox", "ambiguous_commit");
    }
    return committed("acknowledgeOutbox", {
      decision: "acknowledged",
      acknowledgmentState: "acknowledged",
    });
  }

  #appendGraphSource(
    command: Extract<
      SharedStateTransactionCommandV1,
      { readonly operation: "appendGraphSource" }
    >,
  ): unknown {
    const existing = this.#state.graphFacts.get(
      command.input.sourceFactDigest,
    );
    if (existing !== undefined) {
      return committed("appendGraphSource", {
        decision: "replayed",
        sourceSequence: existing.sourceSequence.toString(),
      });
    }
    if (
      command.input.expectedSourceSequence
      !== this.#state.graphSourceSequenceHighWater.toString()
    ) {
      return rejected("appendGraphSource", "source_sequence_conflict");
    }
    this.#state.graphSourceSequenceHighWater += 1n;
    const fact = {
      sourceFactDigest: command.input.sourceFactDigest,
      sourceSequence: this.#state.graphSourceSequenceHighWater,
    };
    this.#state.graphFacts.set(command.input.sourceFactDigest, fact);
    return committed("appendGraphSource", {
      decision: "appended",
      sourceSequence: fact.sourceSequence.toString(),
    });
  }

  #applyGraphProjectionBatch(
    command: Extract<
      SharedStateTransactionCommandV1,
      { readonly operation: "applyGraphProjectionBatch" }
    >,
  ): unknown {
    const existing = this.#state.projectionBatches.get(
      command.input.batchKeyDigest,
    );
    if (existing !== undefined) {
      if (existing.batchDigest !== command.input.batchDigest) {
        return rejected(
          "applyGraphProjectionBatch",
          "projection_batch_conflict",
        );
      }
      return committed("applyGraphProjectionBatch", {
        decision: "replayed",
        checkpointSequence: existing.checkpointSequence.toString(),
      });
    }
    if (
      command.input.expectedCheckpointSequence
      !== this.#state.graphProjectionCheckpointHighWater.toString()
    ) {
      return rejected(
        "applyGraphProjectionBatch",
        "checkpoint_conflict",
      );
    }
    const through = BigInt(command.input.sourceSequenceThrough);
    if (through > this.#state.graphSourceSequenceHighWater) {
      return rejected(
        "applyGraphProjectionBatch",
        "source_range_incomplete",
      );
    }
    this.#state.graphProjectionCheckpointHighWater = through;
    this.#state.projectionBatches.set(command.input.batchKeyDigest, {
      batchDigest: command.input.batchDigest,
      checkpointSequence: through,
    });
    return committed("applyGraphProjectionBatch", {
      decision: "applied",
      checkpointSequence: through.toString(),
    });
  }

  #orderedStreams(): readonly [string, OutboxStream][] {
    return [...this.#state.outboxStreams.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    );
  }

  async captureConformanceSnapshot(): Promise<unknown> {
    const events = this.#orderedStreams().flatMap(([, stream]) => (
      [...stream.events.values()]
    ));
    const rateEntries = [...this.#state.rate.values()].flat();
    const value = {
      kind: "SharedStateRestartContinuityConformanceSnapshotV1",
      snapshotVersion: 1,
      replayRecordCount: this.#state.replay.size,
      rateWindowEntryCount: rateEntries.length,
      accumulatedRateCost: rateEntries.reduce(
        (sum, entry) => sum + entry.cost,
        0,
      ),
      activeLeaseCount: this.#state.lease === null ? 0 : 1,
      maximumFencingToken:
        this.#state.maximumFencingToken.toString(),
      leaseResourceVersionHighWater:
        this.#state.leaseResourceVersionHighWater.toString(),
      leaseMutationCount: this.#state.leaseMutationCount,
      idempotencyOutcomeCount: this.#state.idempotency.size,
      domainEffectCount: this.#state.domainEffectCount,
      idempotentOutboxEffectCount:
        this.#state.idempotentOutboxEffectCount,
      outboxEventCount: events.length,
      receiptPendingCount: events.filter(
        (event) => event.receiptState === "pending",
      ).length,
      receiptConfirmedCount: events.filter(
        (event) => event.receiptState === "confirmed",
      ).length,
      unacknowledgedCount: events.filter(
        (event) => event.acknowledgmentState === "unacknowledged",
      ).length,
      acknowledgedCount: events.filter(
        (event) => event.acknowledgmentState === "acknowledged",
      ).length,
      streamHighWaters: this.#orderedStreams().map(
        ([, stream], index) => ({
          streamOrdinal: index + 1,
          sequenceHighWater: stream.highWater.toString(),
        }),
      ),
      graphSourceFactCount: this.#state.graphFacts.size,
      graphSourceSequenceHighWater:
        this.#state.graphSourceSequenceHighWater.toString(),
      graphProjectionBatchCount: this.#state.projectionBatches.size,
      graphProjectionCheckpointHighWater:
        this.#state.graphProjectionCheckpointHighWater.toString(),
    } as const;
    const parsed =
      sharedStateRestartContinuityConformanceSnapshotV1Schema
        .safeParse(value);
    if (!parsed.success) return invariant();
    return parsed.data;
  }

  async captureConformanceCursor(): Promise<unknown> {
    const positions = this.#orderedStreams().map(
      ([, stream], index) => {
        let acknowledgedThrough = 0n;
        for (
          let sequence = 1n;
          sequence <= stream.highWater;
          sequence += 1n
        ) {
          const event = [...stream.events.values()].find(
            (candidate) => candidate.streamSequence === sequence,
          );
          if (
            event === undefined
            || event.acknowledgmentState !== "acknowledged"
          ) {
            break;
          }
          acknowledgedThrough = sequence;
        }
        return {
          streamOrdinal: index + 1,
          afterSequence: stream.highWater.toString(),
          acknowledgedThroughSequence:
            acknowledgedThrough.toString(),
        };
      },
    );
    const parsed =
      sharedStateRestartContinuityConformanceCursorV1Schema.safeParse({
        kind: "SharedStateRestartContinuityConformanceCursorV1",
        cursorVersion: 1,
        scope: "test-only-restart-continuity-conformance-control",
        positions,
      });
    if (!parsed.success) return invariant();
    return parsed.data;
  }

  async reconcileForConformance(
    cursor: SharedStateRestartContinuityConformanceCursorV1,
  ): Promise<unknown> {
    const parsedCursor =
      sharedStateRestartContinuityConformanceCursorV1Schema.safeParse(
        cursor,
      );
    if (!parsedCursor.success) return invariant();
    const ordered = this.#orderedStreams();
    const events: Array<{
      eventRank: number;
      streamOrdinal: number;
      streamSequence: string;
      receiptState: OutboxEvent["receiptState"];
      acknowledgmentState: OutboxEvent["acknowledgmentState"];
    }> = [];
    for (const position of parsedCursor.data.positions) {
      const stream = ordered[position.streamOrdinal - 1]?.[1];
      if (stream === undefined) return invariant();
      const after = BigInt(position.afterSequence);
      const acknowledgedThrough = BigInt(
        position.acknowledgedThroughSequence,
      );
      const candidates = [...stream.events.values()]
        .filter((event) => (
          event.streamSequence > after
          && event.streamSequence > acknowledgedThrough
          && event.acknowledgmentState === "unacknowledged"
        ))
        .sort((left, right) => (
          left.streamSequence < right.streamSequence ? -1 : 1
        ));
      for (const event of candidates) {
        events.push({
          eventRank: events.length + 1,
          streamOrdinal: position.streamOrdinal,
          streamSequence: event.streamSequence.toString(),
          receiptState: event.receiptState,
          acknowledgmentState: event.acknowledgmentState,
        });
      }
    }
    const parsed =
      sharedStateRestartContinuityConformanceReconcileResponseV1Schema
        .safeParse({
          kind:
            "SharedStateRestartContinuityConformanceReconcileResponseV1",
          responseVersion: 1,
          scope: "test-only-restart-continuity-conformance-control",
          events,
        });
    if (!parsed.success) return invariant();
    return parsed.data;
  }
}

function createTestOnlyDeterministicRestartContinuityFactoryV1(
  adversarialCrashControl:
    TestOnlyAdversarialCrashControlV1 | null = null,
): SharedStateRestartContinuityConformanceTargetFactoryV1 {
  return Object.freeze({
    async create({
      clock,
    }: {
      readonly clock: SharedStateRestartContinuityConformanceClockV1;
    }) {
      return new TestOnlyDeterministicRestartContinuityReferenceModelV1(
        clock,
        adversarialCrashControl,
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
  for (const [key, nested] of Object.entries(value)) {
    keys.push(key);
    collectKeys(nested, keys);
  }
  return keys;
}

test("labels the restart-continuity model test-only with no durability claim", () => {
  assert.deepEqual(
    TEST_ONLY_DETERMINISTIC_RESTART_CONTINUITY_REFERENCE_MODEL_V1,
    {
      role: "test-only-deterministic-reference-model",
      productionAdapter: false,
      sqliteAdapter: false,
      sharedAdapter: false,
      conformingAdapterClaim: false,
      backendClassClaim: "none",
      runtimeIntegration: "not-attached",
      persistenceClaim: "none",
      closeReopenRetention: "test-control-not-durability",
    },
  );
  assert.equal(
    Object.isFrozen(
      TEST_ONLY_DETERMINISTIC_RESTART_CONTINUITY_REFERENCE_MODEL_V1,
    ),
    true,
  );
});

test("proves the exact bounded Phase 2.4 restart-continuity slice", async () => {
  const report = await runSharedStateRestartContinuityConformanceV1(
    createTestOnlyDeterministicRestartContinuityFactoryV1(),
  );

  assert.equal(report.status, "passed");
  assert.deepEqual(report.controls, {
    scheduler: "seeded-deterministic-serial",
    schedulerSeed: 1504,
    concurrency: "not-exercised",
    barrier: "not-required",
    clock: "single-injected-fake-exact-integer",
    targetIsolation: "factory-created-per-scenario",
    targetCount: 6,
    targetCommandLimit: 64,
    targetCommandCount: 45,
    lifecycleLimit: 24,
    lifecycleCount: 21,
    snapshotControlLimit: 24,
    snapshotControlCount: 19,
    faultControlCount: 4,
    cursorControlCount: 2,
    clockControlCount: 3,
  });
  assert.deepEqual(
    report.crashRecovery.cases.map(({ faultPoint }) => faultPoint),
    seededDeterministicRestartFaultOrderV1(),
  );
  assert.deepEqual(
    report.crashRecovery.cases.map(({ scheduleRank }) => scheduleRank),
    [1, 2, 3, 4],
  );
  assert.deepEqual(report.continuityBaseline.highWaters, {
    maximumFencingToken: "1",
    streamHighWaters: [
      { streamOrdinal: 1, sequenceHighWater: "2" },
      { streamOrdinal: 2, sequenceHighWater: "1" },
    ],
    graphSourceSequenceHighWater: "2",
    graphProjectionCheckpointHighWater: "2",
  });
  assert.deepEqual(report.backwardClock.highWaters, {
    maximumFencingToken: "1",
    streamHighWaters: [
      { streamOrdinal: 1, sequenceHighWater: "1" },
    ],
    graphSourceSequenceHighWater: "1",
    graphProjectionCheckpointHighWater: "1",
  });
  assert.deepEqual(report.monotonicity, {
    fencingToken: "nondecreasing",
    everyRetainedStreamSequenceHighWater: "nondecreasing",
    graphSourceSequence: "nondecreasing",
    graphProjectionCheckpoint: "nondecreasing",
  });
  assert.deepEqual(report.claims, {
    referenceModel: "test-only",
    closeReopenStateRetention: "test-control-not-durability-claim",
    adapterConformance: "not-claimed",
    runtimeIntegration: "none",
    storageQueryContract: "none",
    retentionPruneExecution: "not-executed",
  });
  assertDeepFrozen(report);
});

test("uses a stable seeded serial crash schedule with no barrier", () => {
  const first = seededDeterministicRestartFaultOrderV1();
  const second = seededDeterministicRestartFaultOrderV1();
  assert.deepEqual(first, second);
  assert.equal(first.length, 4);
  assert.equal(new Set(first).size, 4);
  assert.deepEqual(
    new Set(first),
    new Set(SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1),
  );
});

test("rejects bounded extraneous post-commit crash state", async () => {
  const mutations = [
    "lease-mutation-after-command-commit",
    "graph-high-water-after-ack-commit",
  ] as const satisfies readonly TestOnlyExtraneousPostCommitMutationV1[];

  for (const mutation of mutations) {
    const control: TestOnlyAdversarialCrashControlV1 = {
      mutation,
      appliedCount: 0,
    };
    await assert.rejects(
      runSharedStateRestartContinuityConformanceV1(
        createTestOnlyDeterministicRestartContinuityFactoryV1(control),
      ),
      (error: unknown) => {
        assert.equal(
          error instanceof
            SharedStateRestartContinuityConformanceErrorV1,
          true,
        );
        if (
          !(error instanceof
            SharedStateRestartContinuityConformanceErrorV1)
        ) {
          return false;
        }
        assert.equal(error.code, "crash_recovery_mismatch");
        return true;
      },
    );
    assert.equal(control.appliedCount, 1);
  }
});

test("keeps reports, snapshots, controls, and errors strict and non-reflecting", async () => {
  const report = await runSharedStateRestartContinuityConformanceV1(
    createTestOnlyDeterministicRestartContinuityFactoryV1(),
  );
  assert.equal(
    sharedStateRestartContinuityConformanceReportV1Schema.safeParse({
      ...report,
      reflectedTargetError: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    sharedStateRestartContinuityConformanceSnapshotV1Schema.safeParse({
      kind: "SharedStateRestartContinuityConformanceSnapshotV1",
      snapshotVersion: 1,
      replayRecordCount: 0,
      rateWindowEntryCount: 0,
      accumulatedRateCost: 0,
      activeLeaseCount: 0,
      maximumFencingToken: "0",
      leaseResourceVersionHighWater: "0",
      leaseMutationCount: 0,
      idempotencyOutcomeCount: 0,
      domainEffectCount: 0,
      idempotentOutboxEffectCount: 0,
      outboxEventCount: 0,
      receiptPendingCount: 0,
      receiptConfirmedCount: 0,
      unacknowledgedCount: 0,
      acknowledgedCount: 0,
      streamHighWaters: [],
      graphSourceFactCount: 0,
      graphSourceSequenceHighWater: "0",
      graphProjectionBatchCount: 0,
      graphProjectionCheckpointHighWater: "0",
      identityDigest: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    sharedStateRestartContinuityConformanceCursorV1Schema.safeParse({
      kind: "SharedStateRestartContinuityConformanceCursorV1",
      cursorVersion: 1,
      scope: "test-only-restart-continuity-conformance-control",
      positions: [],
      namespace: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    sharedStateRestartContinuityConformanceReconcileResponseV1Schema
      .safeParse({
        kind:
          "SharedStateRestartContinuityConformanceReconcileResponseV1",
        responseVersion: 1,
        scope: "test-only-restart-continuity-conformance-control",
        events: [],
        payload: "forbidden",
      }).success,
    false,
  );
  assert.equal(
    sharedStateRestartContinuityErrorReportV1Schema.safeParse({
      kind: "SharedStateRestartContinuityConformanceErrorV1",
      errorVersion: 1,
      code: "target_create_failed",
      targetError: "forbidden",
    }).success,
    false,
  );

  const forbiddenPublicKeys =
    /(?:identity|digest|namespace|prompt|payload|path|secret|endpoint|host|provider|worker|task|timestamp)/iu;
  assert.equal(
    collectKeys(report).some((key) => forbiddenPublicKeys.test(key)),
    false,
  );

  const sentinel = "sensitive-target-value";
  await assert.rejects(
    runSharedStateRestartContinuityConformanceV1({
      async create() {
        throw new Error(sentinel);
      },
    }),
    (error: unknown) => {
      assert.equal(
        error instanceof
          SharedStateRestartContinuityConformanceErrorV1,
        true,
      );
      if (
        !(error instanceof
          SharedStateRestartContinuityConformanceErrorV1)
      ) {
        return false;
      }
      assert.equal(error.code, "target_create_failed");
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(error.stack?.includes(sentinel) ?? false, false);
      assert.deepEqual(error.toJSON(), {
        kind: "SharedStateRestartContinuityConformanceErrorV1",
        errorVersion: 1,
        code: "target_create_failed",
      });
      assertDeepFrozen(error.toJSON());
      return true;
    },
  );
});

test("pins the exact crash-fault and existing unavailable vocabulary", () => {
  assert.deepEqual(
    SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1,
    [
      "before-command-commit",
      "after-command-commit-before-response",
      "before-ack-commit",
      "after-ack-commit-before-response",
    ],
  );
});
