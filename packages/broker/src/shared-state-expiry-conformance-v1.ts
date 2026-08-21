/**
 * Backend-neutral deterministic expiry-boundary conformance harness for
 * `a2a.shared-state.storage/v1`.
 *
 * The harness reuses the existing storage V1 command/result/lifecycle
 * envelopes, keyspace digests, closed idempotency/outbox registrations, and
 * the shared-state time V1 boundary evaluator. It does not implement storage,
 * clocks, health/readiness routes, queries, migrations, retention/prune
 * execution, or broker runtime wiring.
 *
 * Snapshot, physical-cleanup, and capacity-pressure methods on the target
 * seam are bounded test-only conformance controls. They are not V1 adapter or
 * runtime APIs.
 */

import { z } from "zod";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  digestSharedStateKeyV1,
  evaluateSharedStateIdempotencyExpiryV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  sharedStateIdempotencyCatalogV1,
  sharedStateOutboxCatalogV1,
  type SharedStateIdempotencyRegistrationV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
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

export const SHARED_STATE_EXPIRY_CONFORMANCE_V1 = Object.freeze({
  kind: "SharedStateExpiryConformanceReportV1",
  harnessVersion: 1,
  scope: "expiry-boundaries",
  schedulerSeed: 1504,
  initialInstant: 2_000_000n,
  boundaryDurationMs: 1_000,
  noImplicitTtlAdvanceMs: 31_536_000_000,
  backwardSkewToleranceMs: 10,
  rateLimit: 1,
  rateCost: 1,
  targetCount: 7,
  targetCommandLimit: 64,
  expectedTargetCommandCount: 44,
  lifecycleLimit: 24,
  expectedLifecycleCount: 14,
  snapshotControlLimit: 24,
  expectedSnapshotControlCount: 11,
  cleanupControlCount: 2,
  capacityControlCount: 1,
  clockControlCount: 6,
  probePointCount: 3,
  boundaryFixtureCount: 4,
  expectedProbeCaseCount: 12,
} as const);

export const SHARED_STATE_EXPIRY_PROBE_POINTS_V1 = Object.freeze([
  "expiry-minus-1",
  "expiry",
  "expiry-plus-1",
] as const);

export const SHARED_STATE_EXPIRY_BOUNDARY_FIXTURES_V1 = Object.freeze([
  "replay-ttl",
  "rate-window-entry",
  "lease",
  "idempotency-explicit-retention",
] as const);

export const SHARED_STATE_EXPIRY_CLEANUP_CONTROLS_V1 = Object.freeze([
  "attempt-early-eviction",
  "defer-physical-cleanup",
] as const);

export const SHARED_STATE_EXPIRY_ERROR_CODES_V1 = Object.freeze([
  "invalid_generated_command",
  "invalid_target_result",
  "invalid_target_lifecycle",
  "invalid_conformance_snapshot",
  "target_create_failed",
  "target_operation_failed",
  "target_lifecycle_failed",
  "target_snapshot_control_failed",
  "target_cleanup_control_failed",
  "target_capacity_control_failed",
  "clock_control_failed",
  "operation_limit_exceeded",
  "registry_policy_mismatch",
  "boundary_fixture_coverage_mismatch",
  "time_evaluator_mismatch",
  "expiry_boundary_mismatch",
  "rate_window_boundary_mismatch",
  "epoch_threshold_mismatch",
  "boundary_operation_mismatch",
  "cleanup_independence_mismatch",
  "active_record_removed",
  "capacity_eviction_permissive",
  "capacity_shedding_mismatch",
  "lease_ownership_transition_mismatch",
  "fence_not_advanced",
  "implicit_ttl_detected",
  "retention_posture_mismatch",
  "high_water_regression",
  "report_invalid",
  "reference_model_invariant",
] as const);

export type SharedStateExpiryProbePointV1 =
  (typeof SHARED_STATE_EXPIRY_PROBE_POINTS_V1)[number];
export type SharedStateExpiryBoundaryFixtureV1 =
  (typeof SHARED_STATE_EXPIRY_BOUNDARY_FIXTURES_V1)[number];
export type SharedStateExpiryCleanupControlV1 =
  (typeof SHARED_STATE_EXPIRY_CLEANUP_CONTROLS_V1)[number];
export type SharedStateExpiryErrorCodeV1 =
  (typeof SHARED_STATE_EXPIRY_ERROR_CODES_V1)[number];

type Operation = SharedStateTransactionCommandV1["operation"];
type CommandFor<Selected extends Operation> = Extract<
  SharedStateTransactionCommandV1,
  { readonly operation: Selected }
>;
type ResultFor<Selected extends Operation> = Extract<
  SharedStateTransactionResultV1,
  { readonly operation: Selected }
>;

export const sharedStateExpiryErrorReportV1Schema = z
  .object({
    kind: z.literal("SharedStateExpiryConformanceErrorV1"),
    errorVersion: z.literal(1),
    code: z.enum(SHARED_STATE_EXPIRY_ERROR_CODES_V1),
  })
  .strict();

export type SharedStateExpiryErrorReportV1 = Readonly<
  z.infer<typeof sharedStateExpiryErrorReportV1Schema>
>;

export class SharedStateExpiryConformanceErrorV1 extends Error {
  readonly code: SharedStateExpiryErrorCodeV1;
  readonly publicReport: SharedStateExpiryErrorReportV1;

  constructor(code: SharedStateExpiryErrorCodeV1) {
    super(code);
    this.name = "SharedStateExpiryConformanceErrorV1";
    this.code = code;
    this.publicReport = deepFreeze({
      kind: "SharedStateExpiryConformanceErrorV1",
      errorVersion: 1,
      code,
    } as const);
    this.stack = `${this.name}: ${code}`;
  }

  toJSON(): SharedStateExpiryErrorReportV1 {
    return this.publicReport;
  }
}

function fail(code: SharedStateExpiryErrorCodeV1): never {
  throw new SharedStateExpiryConformanceErrorV1(code);
}

const nonNegativeDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,39})$/);
const boundedCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(SHARED_STATE_EXPIRY_CONFORMANCE_V1.targetCommandLimit);

/**
 * Strict aggregate snapshot returned only by the target's test-only
 * conformance control. It intentionally contains no identity, digest,
 * namespace, payload, time, backend, or reflected error value.
 *
 * Retained counts are deliberately separate from logically active counts so
 * the harness can prove that physical retention is not an input to a logical
 * boundary decision.
 */
export const sharedStateExpiryConformanceSnapshotV1Schema = z
  .object({
    kind: z.literal("SharedStateExpiryConformanceSnapshotV1"),
    snapshotVersion: z.literal(1),
    replayRetainedCount: boundedCountSchema,
    rateEntryRetainedCount: boundedCountSchema,
    leaseBinding: z.enum(["unbound", "bound"]),
    activeLeaseCount: boundedCountSchema.max(1),
    ownershipEpoch: nonNegativeDecimalSchema,
    maximumFencingToken: nonNegativeDecimalSchema,
    leaseResourceVersion: nonNegativeDecimalSchema,
    idempotencyOutcomeRetainedCount: boundedCountSchema,
    outboxEventRetainedCount: boundedCountSchema,
    unacknowledgedEventCount: boundedCountSchema,
    acknowledgedEventCount: boundedCountSchema,
    streamSequenceHighWater: nonNegativeDecimalSchema,
    provenanceSourceRetainedCount: boundedCountSchema,
    provenanceSourceSequenceHighWater: nonNegativeDecimalSchema,
    provenanceCheckpointSequence: nonNegativeDecimalSchema,
    physicalCleanupState: z.enum([
      "none",
      "early-eviction-refused",
      "deferred",
    ]),
    capacityPressureBand: z.enum(V.pressureBands),
  })
  .strict();

export type SharedStateExpiryConformanceSnapshotV1 = Readonly<
  z.infer<typeof sharedStateExpiryConformanceSnapshotV1Schema>
>;

const boundaryProbeCaseSchema = z
  .object({
    fixtureKind: z.enum(SHARED_STATE_EXPIRY_BOUNDARY_FIXTURES_V1),
    probePoint: z.enum(SHARED_STATE_EXPIRY_PROBE_POINTS_V1),
    probeRank: z
      .number()
      .int()
      .min(1)
      .max(SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedProbeCaseCount),
    boundaryRule: z.enum([
      TIME_V.boundaryRules.expiry,
      TIME_V.boundaryRules.rateWindow,
    ]),
    boundaryDecision: z.enum([
      "active",
      "expired",
      "counted",
      "excluded",
    ]),
    operationStatus: z.enum(V.transactionStatuses),
    operationOutcome: z.string().min(1).max(64),
  })
  .strict();

export const sharedStateExpiryConformanceReportV1Schema = z
  .object({
    kind: z.literal(SHARED_STATE_EXPIRY_CONFORMANCE_V1.kind),
    harnessVersion: z.literal(
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.harnessVersion,
    ),
    contractVersion: z.literal(V.versions.contract),
    timeVersion: z.literal(TIME_V.version),
    scope: z.literal(SHARED_STATE_EXPIRY_CONFORMANCE_V1.scope),
    status: z.literal("passed"),
    controls: z
      .object({
        scheduler: z.literal("seeded-deterministic-serial"),
        schedulerSeed: z.literal(
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.schedulerSeed,
        ),
        concurrency: z.literal("not-exercised"),
        barrier: z.literal("not-required"),
        clock: z.literal("single-injected-fake-exact-integer"),
        targetIsolation: z.literal("factory-created-per-scenario"),
        targetCount: z.literal(
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.targetCount,
        ),
        targetCommandLimit: z.literal(
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.targetCommandLimit,
        ),
        targetCommandCount: boundedCountSchema,
        lifecycleLimit: z.literal(
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.lifecycleLimit,
        ),
        lifecycleCount: boundedCountSchema,
        snapshotControlLimit: z.literal(
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.snapshotControlLimit,
        ),
        snapshotControlCount: boundedCountSchema,
        cleanupControlCount: z.literal(
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.cleanupControlCount,
        ),
        capacityControlCount: z.literal(
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.capacityControlCount,
        ),
        clockControlCount: z.literal(
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.clockControlCount,
        ),
      })
      .strict(),
    boundaryProbe: z
      .object({
        fixtureCount: z.literal(
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryFixtureCount,
        ),
        fixtureCoverage: z.literal("exactly-the-closed-boundary-kinds"),
        probePointCount: z.literal(
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.probePointCount,
        ),
        expiryEqualityDecision: z.literal("expired"),
        rateWindowEqualityDecision: z.literal("excluded"),
        beforeEpochThresholdDecision: z.literal("counted"),
        derivedExpiryRule: z.literal("adapter-derived-from-trusted-now"),
        callerSuppliedAbsoluteTime: z.literal("forbidden"),
        cases: z
          .array(boundaryProbeCaseSchema)
          .length(
            SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedProbeCaseCount,
          ),
      })
      .strict(),
    cleanupIndependence: z
      .object({
        activeRecordEarlyEviction: z.literal("refused"),
        activeDecisionBeforeCleanup: z.literal("replay"),
        expiredRecordPhysicalState: z.literal("retained"),
        expiredReplayDecision: z.literal("accepted"),
        expiredRateDecision: z.literal("accepted"),
        presenceIsEvaluatorInput: z.literal(false),
        retainedCountChangedByExpiry: z.literal(false),
      })
      .strict(),
    capacityPressure: z
      .object({
        band: z.literal("critical"),
        newRequestStatus: z.literal("unavailable"),
        newRequestReasonCode: z.literal("authority_unavailable"),
        unexpiredReplayDecision: z.literal("replay"),
        unexpiredIdempotencyDecision: z.literal("replayed"),
        permissiveEvictionObserved: z.literal(false),
        duplicateEffectCount: z.literal(0),
        retainedSafetyRecordCountChanged: z.literal(false),
      })
      .strict(),
    leaseTransition: z
      .object({
        expiryAloneTransfersOwnership: z.literal(false),
        ownershipEpochUnchangedOnExpiry: z.literal(true),
        expiredRenewOutcome: z.literal("lease_expired"),
        reclaimOutcome: z.literal("claimed"),
        reclaimAtomicity: z.literal("single-committed-transition"),
        fenceAdvanced: z.literal("strictly-greater"),
        staleFenceMutationOutcome: z.literal("stale_fence"),
        staleRejectionChangedState: z.literal(false),
      })
      .strict(),
    implicitTtl: z
      .object({
        advanceMs: z.literal(
          SHARED_STATE_EXPIRY_CONFORMANCE_V1.noImplicitTtlAdvanceMs,
        ),
        unacknowledgedEventState: z.literal("retained-unacknowledged"),
        unacknowledgedAppendRetryOutcome: z.literal("replayed"),
        provenanceSourceState: z.literal("retained"),
        provenanceAppendRetryOutcome: z.literal("replayed"),
        provenanceCheckpointState: z.literal("original-preserved"),
        outboxCommandTtlFieldRejection: z.literal("unknown_field"),
        provenanceCommandTtlFieldRejection: z.literal("unknown_field"),
        registeredRetentionPostures: z.literal(
          "all-non-expiring-until-prune-proof",
        ),
        registeredBoundaryAttemptRejection: z.literal(
          "expiry_boundary_forbidden",
        ),
        allowedRetentionBoundaryDecision: z.literal(
          "explicit_time_v1_boundary_accepted",
        ),
        capacityCeilingIsRetentionConformance: z.literal(false),
      })
      .strict(),
    monotonicity: z
      .object({
        fencingToken: z.literal("nondecreasing"),
        leaseResourceVersion: z.literal("nondecreasing"),
        streamSequenceHighWater: z.literal("nondecreasing"),
        provenanceSourceSequence: z.literal("nondecreasing"),
        provenanceCheckpoint: z.literal("nondecreasing"),
      })
      .strict(),
    claims: z
      .object({
        referenceModel: z.literal("test-only"),
        adapterConformance: z.literal("not-claimed"),
        runtimeIntegration: z.literal("none"),
        storageQueryContract: z.literal("none"),
        retentionPruneExecution: z.literal("not-executed"),
        partitionUnavailableInjection: z.literal("out-of-scope"),
        readinessRouteBehavior: z.literal("out-of-scope"),
      })
      .strict(),
  })
  .strict();

export type SharedStateExpiryConformanceReportV1 = Readonly<
  z.infer<typeof sharedStateExpiryConformanceReportV1Schema>
>;

export interface SharedStateExpiryConformanceClockV1 {
  readObservedUnixMilliseconds(): bigint;
}

/**
 * Harness-owned fake-clock control. It is not an adapter clock API.
 */
export class InjectedExpiryConformanceFakeClockV1
implements SharedStateExpiryConformanceClockV1 {
  #observed: bigint = SHARED_STATE_EXPIRY_CONFORMANCE_V1.initialInstant;

  readObservedUnixMilliseconds(): bigint {
    return this.#observed;
  }

  advanceExactlyBy(milliseconds: number): void {
    if (
      !Number.isSafeInteger(milliseconds)
      || milliseconds < 0
      || milliseconds > V.limits.maxDurationMs
    ) {
      fail("clock_control_failed");
    }
    this.#observed += BigInt(milliseconds);
  }

  observeExactlyAt(instant: bigint): void {
    if (
      instant < 0n
      || instant > BigInt(TIME_V.limits.maxTimestampUnixMs)
    ) {
      fail("clock_control_failed");
    }
    this.#observed = instant;
  }
}

/**
 * Backend-neutral target seam. `transact`, `open`, and `close` use only the
 * existing storage V1 contract. Every other method is explicitly a bounded
 * test-only conformance control and must never be exposed as an adapter or
 * broker runtime API.
 */
export interface SharedStateExpiryConformanceTargetV1 {
  open(): Promise<unknown>;
  transact(command: SharedStateTransactionCommandV1): Promise<unknown>;
  captureConformanceSnapshot(): Promise<unknown>;
  applyConformanceCleanupControl(
    control: SharedStateExpiryCleanupControlV1,
  ): void;
  applyConformanceCapacityControl(
    band: (typeof V.pressureBands)[number],
  ): void;
  close(): Promise<unknown>;
}

export interface SharedStateExpiryConformanceTargetFactoryV1 {
  create(input: {
    readonly clock: SharedStateExpiryConformanceClockV1;
  }): Promise<SharedStateExpiryConformanceTargetV1>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

/**
 * The declared fixture list must stay exactly the closed time V1 boundary
 * vocabulary. If the vocabulary grows, this slice fails closed instead of
 * silently under-covering the boundary surface.
 */
const BOUNDARY_FIXTURE_COVERAGE = (() => {
  const declared = [...SHARED_STATE_EXPIRY_BOUNDARY_FIXTURES_V1].sort();
  const closed = [...TIME_V.boundaryKinds].sort();
  if (
    declared.length !== closed.length
    || declared.length
      !== SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryFixtureCount
    || declared.some((kind, index) => kind !== closed[index])
  ) {
    return fail("boundary_fixture_coverage_mismatch");
  }
  return "exactly-the-closed-boundary-kinds" as const;
})();

const IDEMPOTENCY_REGISTRATION = (() => {
  const entry = sharedStateIdempotencyCatalogV1().entries.find(
    (candidate) => candidate.namespace === "broker.task.create",
  );
  if (
    entry === undefined
    || entry.retentionPolicyVersion !== "task-create-effects.v1"
    || entry.effectKind !== "domain-mutation-with-outbox"
    || entry.expiryPosture !== "non-expiring-until-prune-proof"
    || entry.logicalExpiryBoundaryKind !== null
  ) {
    return fail("registry_policy_mismatch");
  }
  return entry;
})();

/**
 * No registered V1 namespace currently allows time-bounded retention. The
 * "allowed idempotency-retention" fixture therefore uses this explicitly
 * labeled test-only registration. It is never added to the closed catalog.
 */
const TEST_ONLY_ALLOWED_RETENTION_REGISTRATION_V1 = deepFreeze({
  ...IDEMPOTENCY_REGISTRATION,
  expiryPosture: "time-bounded",
  logicalExpiryBoundaryKind: "idempotency-explicit-retention",
  effectClass: "reversible",
} as SharedStateIdempotencyRegistrationV1);

const OUTBOX_REGISTRATION = (() => {
  const entry = sharedStateOutboxCatalogV1().entries.find(
    (candidate) => (
      candidate.namespace === "broker.terminal-outbox"
      && candidate.eventPurpose === "task-terminal-notification"
    ),
  );
  if (
    entry === undefined
    || entry.sequenceAuthority
      !== "adapter-allocated-per-exact-stream-key"
    || entry.orderingScope !== "total-within-exact-stream-key"
    || entry.idempotencyBinding
      !== "same-key-and-payload-return-original-event-id-and-sequence"
    || entry.receiptPolicyVersion !== "terminal-notification-receipt.v1"
    || entry.acknowledgmentPolicyVersion
      !== "terminal-notification-ack.v1"
  ) {
    return fail("registry_policy_mismatch");
  }
  return entry;
})();

type DigestDomain =
  | "security.replay.requester-key"
  | "security.replay.nonce"
  | "security.rate-limit.bucket-key"
  | "broker.lease.resource-key"
  | "broker.lease.owner-key"
  | "broker.lease.mutation"
  | "broker.idempotency.key"
  | "broker.idempotency.payload-fingerprint"
  | "broker.idempotency.domain-mutation"
  | "broker.outbox.stream-key"
  | "broker.outbox.idempotency-key"
  | "broker.outbox.event-key"
  | "broker.outbox.payload"
  | "broker.claim-graph.source-stream-key"
  | "broker.claim-graph.source-fact"
  | "broker.claim-graph.projection-batch-key"
  | "broker.claim-graph.projection-batch"
  | "broker.claim-graph.projection-inverse";

function digest(
  domain: DigestDomain,
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
  if (!parsed.ok) return fail("invalid_generated_command");
  return parsed.value.digest;
}

function command<Selected extends Operation>(
  operation: Selected,
  input: CommandFor<Selected>["input"],
): CommandFor<Selected> {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input,
  });
  if (!parsed.ok || parsed.value.operation !== operation) {
    return fail("invalid_generated_command");
  }
  return parsed.value as CommandFor<Selected>;
}

/**
 * Attempts a command that carries an extra caller-supplied retention/TTL
 * field. The closed command surface has no such field, so the existing parser
 * must reject it. This proves structurally that unacknowledged outbox rows and
 * claim provenance cannot be given an implicit TTL through the V1 surface.
 */
function rejectedExtraFieldCode(
  operation: Operation,
  input: Record<string, unknown>,
): string {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input,
  });
  if (parsed.ok) return fail("implicit_ttl_detected");
  return parsed.error.code;
}

const REPLAY_NAMESPACE = "security.replay.conformance";
const RATE_NAMESPACE = "security.rate-limit.conformance";
const LEASE_NAMESPACE = "broker.lease.conformance";
const IDEMPOTENCY_NAMESPACE = IDEMPOTENCY_REGISTRATION.namespace;
const OUTBOX_NAMESPACE = OUTBOX_REGISTRATION.namespace;
const GRAPH_NAMESPACE = "broker.claim-graph.conformance";

function replayCommand(
  ordinal: number,
): CommandFor<"consumeReplayNonce"> {
  return command("consumeReplayNonce", {
    namespace: REPLAY_NAMESPACE,
    keyDigest: digest(
      "security.replay.requester-key",
      REPLAY_NAMESPACE,
      [{ field: "requesterId", type: "utf8", value: "expiry-requester" }],
    ),
    nonceDigest: digest("security.replay.nonce", REPLAY_NAMESPACE, [
      { field: "nonce", type: "utf8", value: `expiry-nonce-${ordinal}` },
    ]),
    ttlMs: SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
  });
}

function rateCommand(): CommandFor<"reserveRateLimitCost"> {
  return command("reserveRateLimitCost", {
    namespace: RATE_NAMESPACE,
    bucketKeyDigest: digest(
      "security.rate-limit.bucket-key",
      RATE_NAMESPACE,
      [
        { field: "principal", type: "utf8", value: "expiry-principal" },
        { field: "route", type: "utf8", value: "expiry-route" },
      ],
    ),
    cost: SHARED_STATE_EXPIRY_CONFORMANCE_V1.rateCost,
    limit: SHARED_STATE_EXPIRY_CONFORMANCE_V1.rateLimit,
    windowMs: SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
  });
}

const LEASE_RESOURCE_DIGEST = digest(
  "broker.lease.resource-key",
  LEASE_NAMESPACE,
  [
    { field: "resourceType", type: "utf8", value: "broker-expiry" },
    { field: "resourceId", type: "utf8", value: "expiry-resource" },
  ],
);

function leaseOwnerDigest(ownerId: string): string {
  return digest("broker.lease.owner-key", LEASE_NAMESPACE, [
    { field: "ownerId", type: "utf8", value: ownerId },
  ]);
}

function claimCommand(
  ownerId: string,
  expectedResourceVersion: string,
): CommandFor<"claimLease"> {
  return command("claimLease", {
    namespace: LEASE_NAMESPACE,
    resourceKeyDigest: LEASE_RESOURCE_DIGEST,
    ownerKeyDigest: leaseOwnerDigest(ownerId),
    leaseDurationMs:
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
    expectedResourceVersion,
  });
}

function leaseAuthority(
  ownerId: string,
  attemptKeyDigest: string,
  fencingToken: string,
  expectedResourceVersion: string,
): {
  readonly namespace: string;
  readonly resourceKeyDigest: string;
  readonly ownerKeyDigest: string;
  readonly attemptKeyDigest: string;
  readonly fencingToken: string;
  readonly expectedResourceVersion: string;
} {
  return {
    namespace: LEASE_NAMESPACE,
    resourceKeyDigest: LEASE_RESOURCE_DIGEST,
    ownerKeyDigest: leaseOwnerDigest(ownerId),
    attemptKeyDigest,
    fencingToken,
    expectedResourceVersion,
  };
}

function renewCommand(
  ownerId: string,
  attemptKeyDigest: string,
  fencingToken: string,
  expectedResourceVersion: string,
): CommandFor<"renewLease"> {
  return command("renewLease", {
    ...leaseAuthority(
      ownerId,
      attemptKeyDigest,
      fencingToken,
      expectedResourceVersion,
    ),
    leaseDurationMs:
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
  });
}

function fencedMutationCommand(
  ownerId: string,
  attemptKeyDigest: string,
  fencingToken: string,
  expectedResourceVersion: string,
): CommandFor<"mutateWithFence"> {
  return command("mutateWithFence", {
    ...leaseAuthority(
      ownerId,
      attemptKeyDigest,
      fencingToken,
      expectedResourceVersion,
    ),
    mutationKind: "checkpoint",
    mutationDigest: digest("broker.lease.mutation", LEASE_NAMESPACE, [
      { field: "mutationKind", type: "utf8", value: "checkpoint" },
      { field: "mutationBody", type: "bytes", value: "2606" },
    ]),
  });
}

function idempotentCommand(): CommandFor<"executeIdempotent"> {
  return command("executeIdempotent", {
    namespace: IDEMPOTENCY_NAMESPACE,
    keyDigest: digest("broker.idempotency.key", IDEMPOTENCY_NAMESPACE, [
      { field: "operationName", type: "utf8", value: "expiry-execute" },
      { field: "clientKey", type: "utf8", value: "expiry-client" },
    ]),
    payloadFingerprint: digest(
      "broker.idempotency.payload-fingerprint",
      IDEMPOTENCY_NAMESPACE,
      [{ field: "payload", type: "bytes", value: "2606" }],
    ),
    retentionPolicyVersion:
      IDEMPOTENCY_REGISTRATION.retentionPolicyVersion,
    effect: {
      kind: IDEMPOTENCY_REGISTRATION.effectKind,
      domainMutationDigest: digest(
        "broker.idempotency.domain-mutation",
        IDEMPOTENCY_NAMESPACE,
        [
          { field: "mutationType", type: "utf8", value: "expiry" },
          { field: "mutationBody", type: "bytes", value: "2606" },
        ],
      ),
      outbox: {
        streamKeyDigest: digest(
          "broker.outbox.stream-key",
          IDEMPOTENCY_NAMESPACE,
          [
            { field: "streamType", type: "utf8", value: "synthetic" },
            { field: "streamId", type: "utf8", value: "expiry-effect" },
          ],
        ),
        eventKeyDigest: digest(
          "broker.outbox.event-key",
          IDEMPOTENCY_NAMESPACE,
          [{ field: "eventId", type: "utf8", value: "expiry-effect" }],
        ),
        payloadDigest: digest(
          "broker.outbox.payload",
          IDEMPOTENCY_NAMESPACE,
          [{ field: "payload", type: "bytes", value: "26e0" }],
        ),
        retentionPolicyVersion: "caller-owned-outbox.v1",
      },
    },
  });
}

const OUTBOX_STREAM_COMPONENTS = [
  {
    field: "streamType",
    type: "utf8",
    value: "broker-terminal-outbox",
  },
  {
    field: "streamId",
    type: "utf8",
    value: "expiry-stream",
  },
] as const;

const OUTBOX_STREAM_KEY_INPUT = {
  keyspaceVersion: V.versions.keyspace,
  components: OUTBOX_STREAM_COMPONENTS,
} as const;

const OUTBOX_STREAM_KEY_DIGEST = digest(
  "broker.outbox.stream-key",
  OUTBOX_NAMESPACE,
  OUTBOX_STREAM_COMPONENTS,
);

function outboxAppendInput(): Record<string, unknown> {
  return {
    namespace: OUTBOX_NAMESPACE,
    eventPurpose: OUTBOX_REGISTRATION.eventPurpose,
    streamKey: OUTBOX_STREAM_KEY_INPUT,
    streamKeyDigest: OUTBOX_STREAM_KEY_DIGEST,
    orderingScope: OUTBOX_REGISTRATION.orderingScope,
    idempotencyKeyDigest: digest(
      "broker.outbox.idempotency-key",
      OUTBOX_NAMESPACE,
      [
        { field: "producerId", type: "utf8", value: "expiry-producer" },
        { field: "clientKey", type: "utf8", value: "expiry-unacked" },
      ],
    ),
    eventKeyDigest: digest("broker.outbox.event-key", OUTBOX_NAMESPACE, [
      { field: "eventId", type: "utf8", value: "expiry-unacked" },
    ]),
    payloadDigest: digest("broker.outbox.payload", OUTBOX_NAMESPACE, [
      { field: "payload", type: "bytes", value: "26e1" },
    ]),
    retentionPolicyVersion: OUTBOX_REGISTRATION.retentionPolicyVersion,
    receiptPolicyVersion: OUTBOX_REGISTRATION.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      OUTBOX_REGISTRATION.acknowledgmentPolicyVersion,
  };
}

function outboxAppendCommand(): CommandFor<"appendOutbox"> {
  return command(
    "appendOutbox",
    outboxAppendInput() as CommandFor<"appendOutbox">["input"],
  );
}

function graphSourceInput(
  ordinal: number,
  expectedSourceSequence: string,
): Record<string, unknown> {
  return {
    namespace: GRAPH_NAMESPACE,
    sourceStreamKeyDigest: digest(
      "broker.claim-graph.source-stream-key",
      GRAPH_NAMESPACE,
      [
        { field: "sourceType", type: "utf8", value: "expiry-source" },
        { field: "sourceId", type: "utf8", value: "expiry-provenance" },
      ],
    ),
    sourceFactDigest: digest(
      "broker.claim-graph.source-fact",
      GRAPH_NAMESPACE,
      [
        {
          field: "nodeType",
          type: "utf8",
          value: ordinal === 1 ? "Claim" : "Source",
        },
        {
          field: "fact",
          type: "bytes",
          value: ordinal.toString(16).padStart(2, "0"),
        },
      ],
    ),
    nodeType: ordinal === 1 ? "Claim" : "Source",
    expectedSourceSequence,
  };
}

function graphSourceCommand(
  ordinal: number,
  expectedSourceSequence: string,
): CommandFor<"appendGraphSource"> {
  return command(
    "appendGraphSource",
    graphSourceInput(
      ordinal,
      expectedSourceSequence,
    ) as CommandFor<"appendGraphSource">["input"],
  );
}

function graphProjectionCommand(): CommandFor<"applyGraphProjectionBatch"> {
  return command("applyGraphProjectionBatch", {
    namespace: GRAPH_NAMESPACE,
    projectionVersion: "expiry-projection-v1",
    batchKeyDigest: digest(
      "broker.claim-graph.projection-batch-key",
      GRAPH_NAMESPACE,
      [
        {
          field: "projectionVersion",
          type: "utf8",
          value: "expiry-projection-v1",
        },
        { field: "batchId", type: "utf8", value: "expiry-batch" },
      ],
    ),
    batchDigest: digest(
      "broker.claim-graph.projection-batch",
      GRAPH_NAMESPACE,
      [{ field: "batch", type: "bytes", value: "2610" }],
    ),
    inverseDigest: digest(
      "broker.claim-graph.projection-inverse",
      GRAPH_NAMESPACE,
      [{ field: "inverse", type: "bytes", value: "2611" }],
    ),
    sourceSequenceFrom: "1",
    sourceSequenceThrough: "2",
    expectedCheckpointSequence: "0",
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
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.backwardSkewToleranceMs
        .toString(),
  };
}

const TIME_POLICIES = Object.freeze(
  TIME_V.clockProfiles.map(timePolicyForProfile),
);

function evaluateHarnessTime(
  observed: bigint,
  persistedFloor: bigint,
): SharedStateTimeEvaluationV1 {
  let commonEvaluation: SharedStateTimeEvaluationV1 | null = null;
  for (const policy of TIME_POLICIES) {
    const result = evaluateSharedStateTimeV1(policy, {
      kind: TIME_V.kinds.observation,
      timeVersion: TIME_V.version,
      trustBoundary: TIME_V.trustBoundary,
      clockProfile: policy.clockProfile,
      clockAuthority: policy.clockAuthority,
      observationSource: policy.observationSource,
      observedAtUnixMs: observed.toString(),
      persistedFloorUnixMs: persistedFloor.toString(),
      minimumExpectedFloorUnixMs: persistedFloor.toString(),
    });
    if (!result.ok) return fail("time_evaluator_mismatch");
    if (
      commonEvaluation !== null
      && JSON.stringify(commonEvaluation) !== JSON.stringify(result.value)
    ) {
      return fail("time_evaluator_mismatch");
    }
    commonEvaluation = result.value;
  }
  return commonEvaluation ?? fail("time_evaluator_mismatch");
}

/**
 * Derives the absolute expiry exactly the way the contract prescribes: the
 * caller supplies only a bounded relative duration and the adapter-side
 * trusted evaluation supplies `now`.
 */
function deriveExpiry(
  time: SharedStateTimeEvaluationV1,
  durationMs: number,
): bigint {
  const derived = deriveSharedStateExpiryV1(time, String(durationMs));
  if (!derived.ok) return fail("time_evaluator_mismatch");
  return BigInt(derived.value);
}

function expiryDecision(
  time: SharedStateTimeEvaluationV1,
  kind: Exclude<SharedStateExpiryBoundaryFixtureV1, "rate-window-entry">,
  expiresAt: bigint,
): "active" | "expired" {
  const evaluated = evaluateSharedStateLogicalBoundaryV1(time, {
    timeVersion: TIME_V.version,
    kind,
    expiresAtUnixMs: expiresAt.toString(),
  });
  if (
    !evaluated.ok
    || evaluated.value.rule !== TIME_V.boundaryRules.expiry
    || (
      evaluated.value.decision !== "active"
      && evaluated.value.decision !== "expired"
    )
  ) {
    return fail("expiry_boundary_mismatch");
  }
  return evaluated.value.decision;
}

function rateWindowDecision(
  time: SharedStateTimeEvaluationV1,
  eventAt: bigint,
  windowMs: number,
): "counted" | "excluded" {
  const evaluated = evaluateSharedStateLogicalBoundaryV1(time, {
    timeVersion: TIME_V.version,
    kind: "rate-window-entry",
    eventAtUnixMs: eventAt.toString(),
    windowMs: String(windowMs),
  });
  if (
    !evaluated.ok
    || evaluated.value.rule !== TIME_V.boundaryRules.rateWindow
    || (
      evaluated.value.decision !== "counted"
      && evaluated.value.decision !== "excluded"
    )
  ) {
    return fail("rate_window_boundary_mismatch");
  }
  return evaluated.value.decision;
}

async function createTarget(
  factory: SharedStateExpiryConformanceTargetFactoryV1,
  clock: SharedStateExpiryConformanceClockV1,
): Promise<SharedStateExpiryConformanceTargetV1> {
  try {
    return await factory.create({ clock });
  } catch {
    return fail("target_create_failed");
  }
}

export function seededDeterministicExpiryFixtureOrderV1():
readonly SharedStateExpiryBoundaryFixtureV1[] {
  const order = [...SHARED_STATE_EXPIRY_BOUNDARY_FIXTURES_V1];
  let state = SHARED_STATE_EXPIRY_CONFORMANCE_V1.schedulerSeed >>> 0;
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const other = state % (index + 1);
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  return Object.freeze(order);
}

/**
 * Runs the bounded Phase 2.6 source-only slice. Successful output contains
 * only strict public-safe aggregate facts; target values and thrown messages
 * are never reflected.
 */
export async function runSharedStateExpiryConformanceV1(
  factory: SharedStateExpiryConformanceTargetFactoryV1,
): Promise<SharedStateExpiryConformanceReportV1> {
  const clock = new InjectedExpiryConformanceFakeClockV1();
  let targetCount = 0;
  let targetCommandCount = 0;
  let lifecycleCount = 0;
  let snapshotControlCount = 0;
  let cleanupControlCount = 0;
  let capacityControlCount = 0;
  let clockControlCount = 0;

  async function lifecycle(
    action: () => Promise<unknown>,
  ): Promise<SharedStateStorageLifecycleV1> {
    lifecycleCount += 1;
    if (lifecycleCount > SHARED_STATE_EXPIRY_CONFORMANCE_V1.lifecycleLimit) {
      return fail("operation_limit_exceeded");
    }
    let raw: unknown;
    try {
      raw = await action();
    } catch {
      return fail("target_lifecycle_failed");
    }
    const parsed = parseSharedStateStorageLifecycleV1(raw);
    if (!parsed.ok) return fail("invalid_target_lifecycle");
    return parsed.value;
  }

  function requireReady(value: SharedStateStorageLifecycleV1): void {
    if (value.state !== "ready" || value.reasonCodes.length !== 0) {
      fail("target_lifecycle_failed");
    }
  }

  async function openedTarget():
  Promise<SharedStateExpiryConformanceTargetV1> {
    targetCount += 1;
    if (targetCount > SHARED_STATE_EXPIRY_CONFORMANCE_V1.targetCount) {
      return fail("operation_limit_exceeded");
    }
    const target = await createTarget(factory, clock);
    requireReady(await lifecycle(() => target.open()));
    return target;
  }

  async function closeTarget(
    target: SharedStateExpiryConformanceTargetV1,
  ): Promise<void> {
    const value = await lifecycle(() => target.close());
    if (
      value.state !== "closed"
      || value.reasonCodes.length !== 1
      || value.reasonCodes[0] !== "close_requested"
    ) {
      fail("target_lifecycle_failed");
    }
  }

  async function transact<Selected extends Operation>(
    target: SharedStateExpiryConformanceTargetV1,
    generatedCommand: CommandFor<Selected>,
  ): Promise<ResultFor<Selected>> {
    targetCommandCount += 1;
    if (
      targetCommandCount
      > SHARED_STATE_EXPIRY_CONFORMANCE_V1.targetCommandLimit
    ) {
      return fail("operation_limit_exceeded");
    }
    let raw: unknown;
    try {
      raw = await target.transact(generatedCommand);
    } catch {
      return fail("target_operation_failed");
    }
    const parsed = parseSharedStateTransactionResultV1(raw);
    if (!parsed.ok || parsed.value.operation !== generatedCommand.operation) {
      return fail("invalid_target_result");
    }
    return parsed.value as ResultFor<Selected>;
  }

  async function snapshot(
    target: SharedStateExpiryConformanceTargetV1,
  ): Promise<SharedStateExpiryConformanceSnapshotV1> {
    snapshotControlCount += 1;
    if (
      snapshotControlCount
      > SHARED_STATE_EXPIRY_CONFORMANCE_V1.snapshotControlLimit
    ) {
      return fail("operation_limit_exceeded");
    }
    let raw: unknown;
    try {
      raw = await target.captureConformanceSnapshot();
    } catch {
      return fail("target_snapshot_control_failed");
    }
    const parsed =
      sharedStateExpiryConformanceSnapshotV1Schema.safeParse(raw);
    if (!parsed.success) return fail("invalid_conformance_snapshot");
    return deepFreeze(parsed.data);
  }

  function applyCleanup(
    target: SharedStateExpiryConformanceTargetV1,
    control: SharedStateExpiryCleanupControlV1,
  ): void {
    cleanupControlCount += 1;
    if (
      cleanupControlCount
      > SHARED_STATE_EXPIRY_CONFORMANCE_V1.cleanupControlCount
    ) {
      fail("operation_limit_exceeded");
    }
    try {
      target.applyConformanceCleanupControl(control);
    } catch {
      fail("target_cleanup_control_failed");
    }
  }

  function applyCapacity(
    target: SharedStateExpiryConformanceTargetV1,
    band: (typeof V.pressureBands)[number],
  ): void {
    capacityControlCount += 1;
    if (
      capacityControlCount
      > SHARED_STATE_EXPIRY_CONFORMANCE_V1.capacityControlCount
    ) {
      fail("operation_limit_exceeded");
    }
    try {
      target.applyConformanceCapacityControl(band);
    } catch {
      fail("target_capacity_control_failed");
    }
  }

  function advanceClockExactlyBy(milliseconds: number): void {
    clockControlCount += 1;
    try {
      clock.advanceExactlyBy(milliseconds);
    } catch {
      fail("clock_control_failed");
    }
  }

  function harnessTimeNow(floor: bigint): SharedStateTimeEvaluationV1 {
    return evaluateHarnessTime(clock.readObservedUnixMilliseconds(), floor);
  }

  // Scenario A: one isolated target per probe point holds all four closed
  // boundary fixtures. Probing a target exactly once per fixture keeps a
  // mutating probe from contaminating the two neighbouring probe points.
  const setupInstant = clock.readObservedUnixMilliseconds();
  const setupTime = harnessTimeNow(setupInstant);
  const expiresAt = deriveExpiry(
    setupTime,
    SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
  );
  const probeTargets: SharedStateExpiryConformanceTargetV1[] = [];
  const probeLeases: {
    readonly attemptKeyDigest: string;
    readonly fencingToken: string;
    readonly resourceVersion: string;
  }[] = [];

  for (
    let index = 0;
    index < SHARED_STATE_EXPIRY_CONFORMANCE_V1.probePointCount;
    index += 1
  ) {
    const target = await openedTarget();
    const replay = await transact(target, replayCommand(1));
    const rate = await transact(target, rateCommand());
    const claim = await transact(target, claimCommand("owner-a", "0"));
    const idempotent = await transact(target, idempotentCommand());
    if (
      replay.status !== "committed"
      || replay.result.decision !== "accepted"
      || rate.status !== "committed"
      || rate.result.decision !== "accepted"
      || claim.status !== "committed"
      || claim.result.decision !== "claimed"
      || idempotent.status !== "committed"
      || idempotent.result.decision !== "executed"
    ) {
      fail("boundary_operation_mismatch");
    }
    probeTargets.push(target);
    probeLeases.push({
      attemptKeyDigest: claim.result.attemptKeyDigest,
      fencingToken: claim.result.fencingToken,
      resourceVersion: claim.result.resourceVersion,
    });
  }

  const fixtureOrder = seededDeterministicExpiryFixtureOrderV1();
  const probeCases: {
    fixtureKind: SharedStateExpiryBoundaryFixtureV1;
    probePoint: SharedStateExpiryProbePointV1;
    probeRank: number;
    boundaryRule: string;
    boundaryDecision: string;
    operationStatus: string;
    operationOutcome: string;
  }[] = [];

  const probeAdvances = [
    SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs - 1,
    1,
    1,
  ] as const;

  for (
    let pointIndex = 0;
    pointIndex < SHARED_STATE_EXPIRY_CONFORMANCE_V1.probePointCount;
    pointIndex += 1
  ) {
    advanceClockExactlyBy(probeAdvances[pointIndex]!);
    const probePoint = SHARED_STATE_EXPIRY_PROBE_POINTS_V1[pointIndex]!;
    const target = probeTargets[pointIndex]!;
    const lease = probeLeases[pointIndex]!;
    const time = harnessTimeNow(setupInstant);

    for (const fixtureKind of fixtureOrder) {
      probeCases.push(
        await probeFixture(
          target,
          lease,
          fixtureKind,
          probePoint,
          time,
          probeCases.length + 1,
        ),
      );
    }
  }

  async function probeFixture(
    target: SharedStateExpiryConformanceTargetV1,
    lease: {
      readonly attemptKeyDigest: string;
      readonly fencingToken: string;
      readonly resourceVersion: string;
    },
    fixtureKind: SharedStateExpiryBoundaryFixtureV1,
    probePoint: SharedStateExpiryProbePointV1,
    time: SharedStateTimeEvaluationV1,
    probeRank: number,
  ): Promise<{
    fixtureKind: SharedStateExpiryBoundaryFixtureV1;
    probePoint: SharedStateExpiryProbePointV1;
    probeRank: number;
    boundaryRule: string;
    boundaryDecision: string;
    operationStatus: string;
    operationOutcome: string;
  }> {
    if (fixtureKind === "rate-window-entry") {
      const boundaryDecision = rateWindowDecision(
        time,
        setupInstant,
        SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
      );
      const result = await transact(target, rateCommand());
      if (result.status !== "committed") {
        fail("boundary_operation_mismatch");
      }
      const expected =
        boundaryDecision === "counted" ? "rate_limited" : "accepted";
      if (result.result.decision !== expected) {
        fail("boundary_operation_mismatch");
      }
      return {
        fixtureKind,
        probePoint,
        probeRank,
        boundaryRule: TIME_V.boundaryRules.rateWindow,
        boundaryDecision,
        operationStatus: result.status,
        operationOutcome: result.result.decision,
      };
    }

    const boundaryDecision = expiryDecision(time, fixtureKind, expiresAt);

    if (fixtureKind === "replay-ttl") {
      const result = await transact(target, replayCommand(1));
      if (result.status !== "committed") {
        fail("boundary_operation_mismatch");
      }
      const expected =
        boundaryDecision === "active" ? "replay" : "accepted";
      if (result.result.decision !== expected) {
        fail("boundary_operation_mismatch");
      }
      return {
        fixtureKind,
        probePoint,
        probeRank,
        boundaryRule: TIME_V.boundaryRules.expiry,
        boundaryDecision,
        operationStatus: result.status,
        operationOutcome: result.result.decision,
      };
    }

    if (fixtureKind === "lease") {
      const result = await transact(
        target,
        fencedMutationCommand(
          "owner-a",
          lease.attemptKeyDigest,
          lease.fencingToken,
          lease.resourceVersion,
        ),
      );
      if (boundaryDecision === "active") {
        if (
          result.status !== "committed"
          || result.result.decision !== "applied"
        ) {
          fail("boundary_operation_mismatch");
        }
        return {
          fixtureKind,
          probePoint,
          probeRank,
          boundaryRule: TIME_V.boundaryRules.expiry,
          boundaryDecision,
          operationStatus: result.status,
          operationOutcome: result.result.decision,
        };
      }
      if (
        result.status !== "rejected"
        || result.reasonCode !== "lease_expired"
      ) {
        fail("boundary_operation_mismatch");
      }
      return {
        fixtureKind,
        probePoint,
        probeRank,
        boundaryRule: TIME_V.boundaryRules.expiry,
        boundaryDecision,
        operationStatus: result.status,
        operationOutcome: result.reasonCode,
      };
    }

    // `idempotency-explicit-retention`: the logical retention boundary may
    // expire, but this slice never executes retention or prune. The retained
    // outcome must therefore keep replaying at every probe point.
    const result = await transact(target, idempotentCommand());
    if (
      result.status !== "committed"
      || result.result.decision !== "replayed"
    ) {
      fail("boundary_operation_mismatch");
    }
    return {
      fixtureKind,
      probePoint,
      probeRank,
      boundaryRule: TIME_V.boundaryRules.expiry,
      boundaryDecision,
      operationStatus: result.status,
      operationOutcome: result.result.decision,
    };
  }

  for (const target of probeTargets) {
    await snapshot(target);
    await closeTarget(target);
  }

  const equalityTime = evaluateHarnessTime(expiresAt, setupInstant);
  if (
    expiryDecision(equalityTime, "replay-ttl", expiresAt) !== "expired"
    || expiryDecision(equalityTime, "lease", expiresAt) !== "expired"
    || expiryDecision(
      equalityTime,
      "idempotency-explicit-retention",
      expiresAt,
    ) !== "expired"
  ) {
    fail("expiry_boundary_mismatch");
  }
  if (
    rateWindowDecision(
      equalityTime,
      expiresAt
        - BigInt(SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs),
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
    ) !== "excluded"
  ) {
    fail("rate_window_boundary_mismatch");
  }

  // A window wider than the observed instant places the conceptual threshold
  // before the Unix epoch, so every valid non-negative event instant counts.
  const epochTime = evaluateHarnessTime(1_000n, 1_000n);
  if (
    rateWindowDecision(epochTime, 0n, 2_000) !== "counted"
    || rateWindowDecision(epochTime, 1_000n, 2_000) !== "counted"
  ) {
    fail("epoch_threshold_mismatch");
  }

  // Scenario B: physical cleanup is not an input to a logical decision.
  const cleanupTarget = await openedTarget();
  const cleanupSetupInstant = clock.readObservedUnixMilliseconds();
  const cleanupSetupTime = harnessTimeNow(cleanupSetupInstant);
  const cleanupExpiresAt = deriveExpiry(
    cleanupSetupTime,
    SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
  );
  const cleanupReplaySetup = await transact(cleanupTarget, replayCommand(2));
  const cleanupRateSetup = await transact(cleanupTarget, rateCommand());
  if (
    cleanupReplaySetup.status !== "committed"
    || cleanupReplaySetup.result.decision !== "accepted"
    || cleanupRateSetup.status !== "committed"
    || cleanupRateSetup.result.decision !== "accepted"
  ) {
    fail("cleanup_independence_mismatch");
  }

  applyCleanup(cleanupTarget, "attempt-early-eviction");
  const beforeCleanupSnapshot = await snapshot(cleanupTarget);
  if (
    beforeCleanupSnapshot.physicalCleanupState !== "early-eviction-refused"
    || beforeCleanupSnapshot.replayRetainedCount !== 1
  ) {
    fail("active_record_removed");
  }
  const stillActiveReplay = await transact(cleanupTarget, replayCommand(2));
  if (
    stillActiveReplay.status !== "committed"
    || stillActiveReplay.result.decision !== "replay"
    || expiryDecision(
      harnessTimeNow(cleanupSetupInstant),
      "replay-ttl",
      cleanupExpiresAt,
    ) !== "active"
  ) {
    fail("active_record_removed");
  }

  advanceClockExactlyBy(
    SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
  );
  applyCleanup(cleanupTarget, "defer-physical-cleanup");
  const expiredCleanupTime = harnessTimeNow(cleanupSetupInstant);
  if (
    expiryDecision(expiredCleanupTime, "replay-ttl", cleanupExpiresAt)
      !== "expired"
  ) {
    fail("expiry_boundary_mismatch");
  }
  // Snapshot before issuing the post-expiry commands: logical expiry alone
  // must not have removed a single retained row.
  const afterCleanupSnapshot = await snapshot(cleanupTarget);
  if (
    afterCleanupSnapshot.physicalCleanupState !== "deferred"
    || afterCleanupSnapshot.replayRetainedCount
      !== beforeCleanupSnapshot.replayRetainedCount
    || afterCleanupSnapshot.rateEntryRetainedCount
      !== beforeCleanupSnapshot.rateEntryRetainedCount
  ) {
    fail("cleanup_independence_mismatch");
  }
  const expiredReplay = await transact(cleanupTarget, replayCommand(2));
  const expiredRate = await transact(cleanupTarget, rateCommand());
  if (
    expiredReplay.status !== "committed"
    || expiredReplay.result.decision !== "accepted"
    || expiredRate.status !== "committed"
    || expiredRate.result.decision !== "accepted"
  ) {
    fail("cleanup_independence_mismatch");
  }
  await closeTarget(cleanupTarget);

  // Scenario C: capacity pressure sheds new work and never evicts an
  // unexpired replay or idempotency safety record permissively.
  const capacityTarget = await openedTarget();
  const capacityReplaySetup = await transact(
    capacityTarget,
    replayCommand(3),
  );
  const capacityIdempotentSetup = await transact(
    capacityTarget,
    idempotentCommand(),
  );
  if (
    capacityReplaySetup.status !== "committed"
    || capacityReplaySetup.result.decision !== "accepted"
    || capacityIdempotentSetup.status !== "committed"
    || capacityIdempotentSetup.result.decision !== "executed"
  ) {
    fail("capacity_eviction_permissive");
  }
  const beforePressureSnapshot = await snapshot(capacityTarget);

  applyCapacity(capacityTarget, "critical");
  const shedNewRequest = await transact(capacityTarget, replayCommand(4));
  if (
    shedNewRequest.status !== "unavailable"
    || shedNewRequest.reasonCode !== "authority_unavailable"
  ) {
    fail("capacity_shedding_mismatch");
  }
  const retainedReplay = await transact(capacityTarget, replayCommand(3));
  const retainedIdempotent = await transact(
    capacityTarget,
    idempotentCommand(),
  );
  const afterPressureSnapshot = await snapshot(capacityTarget);
  if (
    retainedReplay.status !== "committed"
    || retainedReplay.result.decision !== "replay"
    || retainedIdempotent.status !== "committed"
    || retainedIdempotent.result.decision !== "replayed"
  ) {
    fail("capacity_eviction_permissive");
  }
  if (
    afterPressureSnapshot.capacityPressureBand !== "critical"
    || afterPressureSnapshot.replayRetainedCount
      !== beforePressureSnapshot.replayRetainedCount
    || afterPressureSnapshot.idempotencyOutcomeRetainedCount
      !== beforePressureSnapshot.idempotencyOutcomeRetainedCount
    || afterPressureSnapshot.outboxEventRetainedCount
      !== beforePressureSnapshot.outboxEventRetainedCount
  ) {
    fail("capacity_eviction_permissive");
  }
  await closeTarget(capacityTarget);

  // Scenario D: expiry alone never transfers ownership; one atomic
  // reap/new-claim transition does, and it advances the fence.
  const leaseTarget = await openedTarget();
  const leaseSetupInstant = clock.readObservedUnixMilliseconds();
  const originalClaim = await transact(
    leaseTarget,
    claimCommand("owner-a", "0"),
  );
  if (
    originalClaim.status !== "committed"
    || originalClaim.result.decision !== "claimed"
  ) {
    fail("lease_ownership_transition_mismatch");
  }
  const leaseExpiresAt = deriveExpiry(
    harnessTimeNow(leaseSetupInstant),
    SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
  );
  advanceClockExactlyBy(
    SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
  );
  if (
    expiryDecision(
      harnessTimeNow(leaseSetupInstant),
      "lease",
      leaseExpiresAt,
    ) !== "expired"
  ) {
    fail("expiry_boundary_mismatch");
  }
  const expiredOwnershipSnapshot = await snapshot(leaseTarget);
  if (
    expiredOwnershipSnapshot.leaseBinding !== "bound"
    || expiredOwnershipSnapshot.ownershipEpoch !== "1"
    || expiredOwnershipSnapshot.maximumFencingToken
      !== originalClaim.result.fencingToken
  ) {
    fail("lease_ownership_transition_mismatch");
  }

  const expiredRenew = await transact(
    leaseTarget,
    renewCommand(
      "owner-a",
      originalClaim.result.attemptKeyDigest,
      originalClaim.result.fencingToken,
      originalClaim.result.resourceVersion,
    ),
  );
  if (
    expiredRenew.status !== "rejected"
    || expiredRenew.reasonCode !== "lease_expired"
  ) {
    fail("lease_ownership_transition_mismatch");
  }

  const reclaim = await transact(
    leaseTarget,
    claimCommand("owner-b", originalClaim.result.resourceVersion),
  );
  if (
    reclaim.status !== "committed"
    || reclaim.result.decision !== "claimed"
  ) {
    fail("lease_ownership_transition_mismatch");
  }
  if (
    BigInt(reclaim.result.fencingToken)
      <= BigInt(originalClaim.result.fencingToken)
  ) {
    fail("fence_not_advanced");
  }

  const staleMutation = await transact(
    leaseTarget,
    fencedMutationCommand(
      "owner-a",
      originalClaim.result.attemptKeyDigest,
      originalClaim.result.fencingToken,
      reclaim.result.resourceVersion,
    ),
  );
  const afterTransitionSnapshot = await snapshot(leaseTarget);
  if (
    staleMutation.status !== "rejected"
    || staleMutation.reasonCode !== "stale_fence"
  ) {
    fail("lease_ownership_transition_mismatch");
  }
  if (
    afterTransitionSnapshot.ownershipEpoch !== "2"
    || afterTransitionSnapshot.maximumFencingToken
      !== reclaim.result.fencingToken
    || afterTransitionSnapshot.leaseResourceVersion
      !== reclaim.result.resourceVersion
    || BigInt(afterTransitionSnapshot.maximumFencingToken)
      < BigInt(expiredOwnershipSnapshot.maximumFencingToken)
    || BigInt(afterTransitionSnapshot.leaseResourceVersion)
      < BigInt(expiredOwnershipSnapshot.leaseResourceVersion)
  ) {
    fail("high_water_regression");
  }
  await closeTarget(leaseTarget);

  // Scenario E: unacknowledged outbox rows and claim provenance have no
  // implicit TTL. The closed command surface carries no retention duration,
  // and a bounded maximum advance changes nothing.
  const ttlTarget = await openedTarget();
  const appended = await transact(ttlTarget, outboxAppendCommand());
  const firstSource = await transact(ttlTarget, graphSourceCommand(1, "0"));
  const secondSource = await transact(ttlTarget, graphSourceCommand(2, "1"));
  const projected = await transact(ttlTarget, graphProjectionCommand());
  if (
    appended.status !== "committed"
    || appended.result.decision !== "appended"
    || firstSource.status !== "committed"
    || firstSource.result.decision !== "appended"
    || secondSource.status !== "committed"
    || secondSource.result.decision !== "appended"
    || projected.status !== "committed"
    || projected.result.decision !== "applied"
  ) {
    fail("implicit_ttl_detected");
  }
  const beforeTtlSnapshot = await snapshot(ttlTarget);
  if (
    beforeTtlSnapshot.unacknowledgedEventCount !== 1
    || beforeTtlSnapshot.acknowledgedEventCount !== 0
    || beforeTtlSnapshot.provenanceSourceRetainedCount !== 2
  ) {
    fail("implicit_ttl_detected");
  }

  advanceClockExactlyBy(
    SHARED_STATE_EXPIRY_CONFORMANCE_V1.noImplicitTtlAdvanceMs,
  );
  const replayedAppend = await transact(ttlTarget, outboxAppendCommand());
  const replayedSource = await transact(ttlTarget, graphSourceCommand(2, "1"));
  const afterTtlSnapshot = await snapshot(ttlTarget);
  if (
    replayedAppend.status !== "committed"
    || replayedAppend.result.decision !== "replayed"
    || replayedSource.status !== "committed"
    || replayedSource.result.decision !== "replayed"
  ) {
    fail("implicit_ttl_detected");
  }
  if (
    JSON.stringify(afterTtlSnapshot) !== JSON.stringify(beforeTtlSnapshot)
  ) {
    fail("implicit_ttl_detected");
  }
  await closeTarget(ttlTarget);

  const outboxTtlRejection = rejectedExtraFieldCode("appendOutbox", {
    ...outboxAppendInput(),
    retentionTtlMs: String(
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
    ),
  });
  const provenanceTtlRejection = rejectedExtraFieldCode(
    "appendGraphSource",
    {
      ...graphSourceInput(1, "0"),
      retentionTtlMs: String(
        SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs,
      ),
    },
  );
  if (
    outboxTtlRejection !== "unknown_field"
    || provenanceTtlRejection !== "unknown_field"
  ) {
    fail("implicit_ttl_detected");
  }

  for (const entry of sharedStateIdempotencyCatalogV1().entries) {
    if (
      entry.expiryPosture !== "non-expiring-until-prune-proof"
      || entry.logicalExpiryBoundaryKind !== null
    ) {
      fail("retention_posture_mismatch");
    }
  }
  const registeredBoundaryAttempt = evaluateSharedStateIdempotencyExpiryV1(
    IDEMPOTENCY_REGISTRATION,
    {
      timeVersion: TIME_V.version,
      kind: "idempotency-explicit-retention",
      expiresAtUnixMs: expiresAt.toString(),
    },
  );
  if (
    registeredBoundaryAttempt.ok
    || registeredBoundaryAttempt.error.code !== "expiry_boundary_forbidden"
  ) {
    fail("retention_posture_mismatch");
  }
  const allowedRetention = evaluateSharedStateIdempotencyExpiryV1(
    TEST_ONLY_ALLOWED_RETENTION_REGISTRATION_V1,
    {
      timeVersion: TIME_V.version,
      kind: "idempotency-explicit-retention",
      expiresAtUnixMs: expiresAt.toString(),
    },
  );
  if (
    !allowedRetention.ok
    || allowedRetention.value.decision !== "time-bounded"
    || allowedRetention.value.reasonCode
      !== "explicit_time_v1_boundary_accepted"
  ) {
    fail("retention_posture_mismatch");
  }

  if (
    targetCount !== SHARED_STATE_EXPIRY_CONFORMANCE_V1.targetCount
    || targetCommandCount
      !== SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedTargetCommandCount
    || lifecycleCount
      !== SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedLifecycleCount
    || snapshotControlCount
      !== SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedSnapshotControlCount
    || cleanupControlCount
      !== SHARED_STATE_EXPIRY_CONFORMANCE_V1.cleanupControlCount
    || capacityControlCount
      !== SHARED_STATE_EXPIRY_CONFORMANCE_V1.capacityControlCount
    || clockControlCount
      !== SHARED_STATE_EXPIRY_CONFORMANCE_V1.clockControlCount
    || probeCases.length
      !== SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedProbeCaseCount
  ) {
    fail("operation_limit_exceeded");
  }

  const report = {
    kind: SHARED_STATE_EXPIRY_CONFORMANCE_V1.kind,
    harnessVersion: SHARED_STATE_EXPIRY_CONFORMANCE_V1.harnessVersion,
    contractVersion: V.versions.contract,
    timeVersion: TIME_V.version,
    scope: SHARED_STATE_EXPIRY_CONFORMANCE_V1.scope,
    status: "passed",
    controls: {
      scheduler: "seeded-deterministic-serial",
      schedulerSeed: SHARED_STATE_EXPIRY_CONFORMANCE_V1.schedulerSeed,
      concurrency: "not-exercised",
      barrier: "not-required",
      clock: "single-injected-fake-exact-integer",
      targetIsolation: "factory-created-per-scenario",
      targetCount,
      targetCommandLimit:
        SHARED_STATE_EXPIRY_CONFORMANCE_V1.targetCommandLimit,
      targetCommandCount,
      lifecycleLimit: SHARED_STATE_EXPIRY_CONFORMANCE_V1.lifecycleLimit,
      lifecycleCount,
      snapshotControlLimit:
        SHARED_STATE_EXPIRY_CONFORMANCE_V1.snapshotControlLimit,
      snapshotControlCount,
      cleanupControlCount,
      capacityControlCount,
      clockControlCount,
    },
    boundaryProbe: {
      fixtureCount: SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryFixtureCount,
      fixtureCoverage: BOUNDARY_FIXTURE_COVERAGE,
      probePointCount: SHARED_STATE_EXPIRY_CONFORMANCE_V1.probePointCount,
      expiryEqualityDecision: "expired",
      rateWindowEqualityDecision: "excluded",
      beforeEpochThresholdDecision: "counted",
      derivedExpiryRule: "adapter-derived-from-trusted-now",
      callerSuppliedAbsoluteTime: "forbidden",
      cases: probeCases,
    },
    cleanupIndependence: {
      activeRecordEarlyEviction: "refused",
      activeDecisionBeforeCleanup: "replay",
      expiredRecordPhysicalState: "retained",
      expiredReplayDecision: "accepted",
      expiredRateDecision: "accepted",
      presenceIsEvaluatorInput: false,
      retainedCountChangedByExpiry: false,
    },
    capacityPressure: {
      band: "critical",
      newRequestStatus: "unavailable",
      newRequestReasonCode: "authority_unavailable",
      unexpiredReplayDecision: "replay",
      unexpiredIdempotencyDecision: "replayed",
      permissiveEvictionObserved: false,
      duplicateEffectCount: 0,
      retainedSafetyRecordCountChanged: false,
    },
    leaseTransition: {
      expiryAloneTransfersOwnership: false,
      ownershipEpochUnchangedOnExpiry: true,
      expiredRenewOutcome: "lease_expired",
      reclaimOutcome: "claimed",
      reclaimAtomicity: "single-committed-transition",
      fenceAdvanced: "strictly-greater",
      staleFenceMutationOutcome: "stale_fence",
      staleRejectionChangedState: false,
    },
    implicitTtl: {
      advanceMs: SHARED_STATE_EXPIRY_CONFORMANCE_V1.noImplicitTtlAdvanceMs,
      unacknowledgedEventState: "retained-unacknowledged",
      unacknowledgedAppendRetryOutcome: "replayed",
      provenanceSourceState: "retained",
      provenanceAppendRetryOutcome: "replayed",
      provenanceCheckpointState: "original-preserved",
      outboxCommandTtlFieldRejection: outboxTtlRejection,
      provenanceCommandTtlFieldRejection: provenanceTtlRejection,
      registeredRetentionPostures: "all-non-expiring-until-prune-proof",
      registeredBoundaryAttemptRejection: "expiry_boundary_forbidden",
      allowedRetentionBoundaryDecision:
        "explicit_time_v1_boundary_accepted",
      capacityCeilingIsRetentionConformance: false,
    },
    monotonicity: {
      fencingToken: "nondecreasing",
      leaseResourceVersion: "nondecreasing",
      streamSequenceHighWater: "nondecreasing",
      provenanceSourceSequence: "nondecreasing",
      provenanceCheckpoint: "nondecreasing",
    },
    claims: {
      referenceModel: "test-only",
      adapterConformance: "not-claimed",
      runtimeIntegration: "none",
      storageQueryContract: "none",
      retentionPruneExecution: "not-executed",
      partitionUnavailableInjection: "out-of-scope",
      readinessRouteBehavior: "out-of-scope",
    },
  } as const;
  const parsed =
    sharedStateExpiryConformanceReportV1Schema.safeParse(report);
  if (!parsed.success) return fail("report_invalid");
  return deepFreeze(parsed.data);
}
