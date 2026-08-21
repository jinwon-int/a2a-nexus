/**
 * Backend-neutral deterministic partition and unavailable-injection
 * conformance harness for `a2a.shared-state.storage/v1`.
 *
 * The harness reuses the existing storage V1 command/result/lifecycle
 * envelopes, keyspace digests, and the closed unavailable, lifecycle, and
 * readiness reason vocabulary. It does not implement storage, a graph query
 * API, health or readiness routes, middleware, clocks, migrations, or broker
 * runtime wiring.
 *
 * Snapshot, fault, stale-read, and readiness methods on the target seam are
 * bounded test-only conformance controls. They are not V1 adapter or runtime
 * APIs. Route-level readiness behavior is deliberately out of scope: `/readyz`
 * and the non-serving middleware are Phase 4 deliverables, so this slice
 * proves the equivalent facts at the adapter-lifecycle layer instead.
 */

import { z } from "zod";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  digestSharedStateKeyV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  sharedStateOutboxCatalogV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";

export const SHARED_STATE_PARTITION_CONFORMANCE_V1 = Object.freeze({
  kind: "SharedStatePartitionConformanceReportV1",
  harnessVersion: 1,
  scope: "partition-unavailable-injection",
  schedulerSeed: 1504,
  faultPointCount: 5,
  targetCount: 5,
  targetCommandLimit: 64,
  expectedTargetCommandCount: 18,
  lifecycleLimit: 24,
  expectedLifecycleCount: 10,
  snapshotControlLimit: 24,
  expectedSnapshotControlCount: 14,
  faultControlLimit: 16,
  expectedFaultControlCount: 14,
  staleReadControlCount: 2,
  readinessControlCount: 2,
} as const);

/**
 * The five fault kinds section 2.5 requires. Each maps to an existing closed
 * unavailable reason code, except `delayed-read`, which is a read-path fault
 * that yields an explicitly stale answer rather than an unavailable result.
 */
export const SHARED_STATE_PARTITION_FAULT_POINTS_V1 = Object.freeze([
  "unavailable",
  "timeout",
  "ambiguous-commit",
  "lost-fence",
  "delayed-read",
] as const);

export const SHARED_STATE_PARTITION_FAULT_REASONS_V1 = Object.freeze({
  unavailable: "authority_unavailable",
  timeout: "lock_timeout",
  "ambiguous-commit": "ambiguous_commit",
  "lost-fence": "lost_ownership",
} as const);

export const SHARED_STATE_PARTITION_ERROR_CODES_V1 = Object.freeze([
  "invalid_generated_command",
  "invalid_target_result",
  "invalid_target_lifecycle",
  "invalid_conformance_snapshot",
  "invalid_conformance_stale_read",
  "target_create_failed",
  "target_operation_failed",
  "target_lifecycle_failed",
  "target_snapshot_control_failed",
  "target_fault_control_failed",
  "target_stale_read_control_failed",
  "operation_limit_exceeded",
  "registry_policy_mismatch",
  "fault_reason_coverage_mismatch",
  "readiness_vocabulary_mismatch",
  "empty_local_decision",
  "unavailable_reason_mismatch",
  "mutation_applied_while_unavailable",
  "outbox_partial_effect",
  "ack_permitted_while_partitioned",
  "stale_read_not_labeled",
  "not_ready_state_mismatch",
  "recovery_mismatch",
  "high_water_regression",
  "report_invalid",
  "reference_model_invariant",
] as const);

export type SharedStatePartitionFaultPointV1 =
  (typeof SHARED_STATE_PARTITION_FAULT_POINTS_V1)[number];
export type SharedStatePartitionErrorCodeV1 =
  (typeof SHARED_STATE_PARTITION_ERROR_CODES_V1)[number];

type Operation = SharedStateTransactionCommandV1["operation"];
type CommandFor<Selected extends Operation> = Extract<
  SharedStateTransactionCommandV1,
  { readonly operation: Selected }
>;
type ResultFor<Selected extends Operation> = Extract<
  SharedStateTransactionResultV1,
  { readonly operation: Selected }
>;

export const sharedStatePartitionErrorReportV1Schema = z
  .object({
    kind: z.literal("SharedStatePartitionConformanceErrorV1"),
    errorVersion: z.literal(1),
    code: z.enum(SHARED_STATE_PARTITION_ERROR_CODES_V1),
  })
  .strict();

export type SharedStatePartitionErrorReportV1 = Readonly<
  z.infer<typeof sharedStatePartitionErrorReportV1Schema>
>;

export class SharedStatePartitionConformanceErrorV1 extends Error {
  readonly code: SharedStatePartitionErrorCodeV1;
  readonly publicReport: SharedStatePartitionErrorReportV1;

  constructor(code: SharedStatePartitionErrorCodeV1) {
    super(code);
    this.name = "SharedStatePartitionConformanceErrorV1";
    this.code = code;
    this.publicReport = deepFreeze({
      kind: "SharedStatePartitionConformanceErrorV1",
      errorVersion: 1,
      code,
    } as const);
    this.stack = `${this.name}: ${code}`;
  }

  toJSON(): SharedStatePartitionErrorReportV1 {
    return this.publicReport;
  }
}

function fail(code: SharedStatePartitionErrorCodeV1): never {
  throw new SharedStatePartitionConformanceErrorV1(code);
}

const nonNegativeDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,39})$/);
const boundedCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(SHARED_STATE_PARTITION_CONFORMANCE_V1.targetCommandLimit);

/**
 * Strict aggregate snapshot returned only by the target's test-only
 * conformance control. It intentionally contains no identity, digest,
 * namespace, payload, time, backend, or reflected error value.
 */
export const sharedStatePartitionConformanceSnapshotV1Schema = z
  .object({
    kind: z.literal("SharedStatePartitionConformanceSnapshotV1"),
    snapshotVersion: z.literal(1),
    replayRecordCount: boundedCountSchema,
    rateEntryCount: boundedCountSchema,
    activeLeaseCount: boundedCountSchema.max(1),
    maximumFencingToken: nonNegativeDecimalSchema,
    leaseResourceVersion: nonNegativeDecimalSchema,
    idempotencyOutcomeCount: boundedCountSchema,
    outboxEventCount: boundedCountSchema,
    unacknowledgedEventCount: boundedCountSchema,
    acknowledgedEventCount: boundedCountSchema,
    streamSequenceHighWater: nonNegativeDecimalSchema,
    provenanceSourceCount: boundedCountSchema,
    provenanceCheckpointSequence: nonNegativeDecimalSchema,
    prunedRecordCount: boundedCountSchema,
    authorityReachable: z.boolean(),
  })
  .strict();

export type SharedStatePartitionConformanceSnapshotV1 = Readonly<
  z.infer<typeof sharedStatePartitionConformanceSnapshotV1Schema>
>;

/**
 * Bounded test-only readiness projection. It reports the adapter-lifecycle
 * view only. Route behavior, `/readyz`, and non-serving middleware are Phase 4
 * and are never represented here.
 */
export const sharedStatePartitionReadinessV1Schema = z
  .object({
    kind: z.literal("SharedStatePartitionConformanceReadinessV1"),
    readinessVersion: z.literal(1),
    scope: z.literal("test-only-adapter-lifecycle-readiness-control"),
    ready: z.boolean(),
    lifecycleState: z.enum(V.lifecycleStates),
    lifecycleReasonCodes: z
      .array(z.enum(V.lifecycleReasonCodes))
      .max(V.limits.maxHealthReasonCodes),
    readinessReasonCodes: z
      .array(z.enum(V.readinessReasonCodes))
      .max(V.limits.maxHealthReasonCodes),
  })
  .strict();

export type SharedStatePartitionReadinessV1 = Readonly<
  z.infer<typeof sharedStatePartitionReadinessV1Schema>
>;

/**
 * Bounded test-only stale-read result. Spec section 5.6 allows a partitioned
 * projection to serve an explicitly stale answer carrying checkpoint and lag;
 * this shape is that answer and is never a V1 storage query contract.
 */
export const sharedStatePartitionStaleReadV1Schema = z
  .object({
    kind: z.literal("SharedStatePartitionConformanceStaleReadV1"),
    staleReadVersion: z.literal(1),
    scope: z.literal("test-only-partition-conformance-control"),
    freshness: z.literal("stale"),
    completeness: z.enum(V.graphCompletenessStates),
    asOfSourceSequence: nonNegativeDecimalSchema,
    checkpointSequence: nonNegativeDecimalSchema,
    sourceSequenceHighWater: nonNegativeDecimalSchema,
    lag: boundedCountSchema,
  })
  .strict();

export type SharedStatePartitionStaleReadV1 = Readonly<
  z.infer<typeof sharedStatePartitionStaleReadV1Schema>
>;

const faultCaseSchema = z
  .object({
    faultPoint: z.enum(SHARED_STATE_PARTITION_FAULT_POINTS_V1),
    scheduleRank: z
      .number()
      .int()
      .min(1)
      .max(SHARED_STATE_PARTITION_CONFORMANCE_V1.faultPointCount),
    attemptStatus: z.enum(["unavailable", "committed"]),
    attemptReasonCode: z.enum([...V.unavailableReasonCodes, "none"]),
    localDecisionEmitted: z.literal(false),
    stateMutated: z.literal(false),
  })
  .strict();

export const sharedStatePartitionConformanceReportV1Schema = z
  .object({
    kind: z.literal(SHARED_STATE_PARTITION_CONFORMANCE_V1.kind),
    harnessVersion: z.literal(
      SHARED_STATE_PARTITION_CONFORMANCE_V1.harnessVersion,
    ),
    contractVersion: z.literal(V.versions.contract),
    scope: z.literal(SHARED_STATE_PARTITION_CONFORMANCE_V1.scope),
    status: z.literal("passed"),
    controls: z
      .object({
        scheduler: z.literal("seeded-deterministic-serial"),
        schedulerSeed: z.literal(
          SHARED_STATE_PARTITION_CONFORMANCE_V1.schedulerSeed,
        ),
        concurrency: z.literal("not-exercised"),
        barrier: z.literal("not-required"),
        clock: z.literal("not-required"),
        targetIsolation: z.literal("factory-created-per-scenario"),
        targetCount: z.literal(
          SHARED_STATE_PARTITION_CONFORMANCE_V1.targetCount,
        ),
        targetCommandLimit: z.literal(
          SHARED_STATE_PARTITION_CONFORMANCE_V1.targetCommandLimit,
        ),
        targetCommandCount: boundedCountSchema,
        lifecycleLimit: z.literal(
          SHARED_STATE_PARTITION_CONFORMANCE_V1.lifecycleLimit,
        ),
        lifecycleCount: boundedCountSchema,
        snapshotControlLimit: z.literal(
          SHARED_STATE_PARTITION_CONFORMANCE_V1.snapshotControlLimit,
        ),
        snapshotControlCount: boundedCountSchema,
        faultControlLimit: z.literal(
          SHARED_STATE_PARTITION_CONFORMANCE_V1.faultControlLimit,
        ),
        faultControlCount: boundedCountSchema,
        staleReadControlCount: z.literal(
          SHARED_STATE_PARTITION_CONFORMANCE_V1.staleReadControlCount,
        ),
        readinessControlCount: z.literal(
          SHARED_STATE_PARTITION_CONFORMANCE_V1.readinessControlCount,
        ),
      })
      .strict(),
    faultPoints: z
      .object({
        count: z.literal(
          SHARED_STATE_PARTITION_CONFORMANCE_V1.faultPointCount,
        ),
        reasonCoverage: z.literal("exactly-the-closed-unavailable-reasons"),
        previouslyUncovered: z
          .array(z.string().min(1).max(32))
          .length(2),
        cases: z
          .array(faultCaseSchema)
          .length(SHARED_STATE_PARTITION_CONFORMANCE_V1.faultPointCount),
      })
      .strict(),
    protectedRequests: z
      .object({
        replayStatus: z.literal("unavailable"),
        replayReasonCode: z.literal("authority_unavailable"),
        rateStatus: z.literal("unavailable"),
        rateReasonCode: z.literal("lock_timeout"),
        emptyLocalDecisionObserved: z.literal(false),
        permissiveFallbackObserved: z.literal(false),
      })
      .strict(),
    mutationsWhileUnavailable: z
      .object({
        claimStatus: z.literal("unavailable"),
        renewStatus: z.literal("unavailable"),
        fencedMutationStatus: z.literal("unavailable"),
        idempotentStatus: z.literal("unavailable"),
        appliedMutationCount: z.literal(0),
        snapshotUnchanged: z.literal(true),
        cleanRetryAppliesOnce: z.literal(true),
      })
      .strict(),
    outboxUnderPartition: z
      .object({
        producerStatus: z.literal("unavailable"),
        producerPartialEffectCount: z.literal(0),
        consumerReplayPreserved: z.literal(true),
        acknowledgeStatus: z.literal("unavailable"),
        acknowledgmentStatePreserved: z.literal("unacknowledged"),
        prunedRecordCount: z.literal(0),
        retentionPruneExecution: z.literal("not-executed"),
      })
      .strict(),
    partitionedRead: z
      .object({
        faultPoint: z.literal("delayed-read"),
        freshness: z.literal("stale"),
        explicitlyLabeled: z.literal(true),
        carriesCheckpointAndLag: z.literal(true),
        servedAnswerIsNotNegativeEvidence: z.literal(true),
        priorSliceCoversRemainingCases: z.literal(
          "phase-2.7-projection-incomplete-unavailable-no-evidence-path",
        ),
      })
      .strict(),
    adapterReadiness: z
      .object({
        readyBeforePartition: z.literal(true),
        readyDuringPartition: z.literal(false),
        lifecycleStateDuringPartition: z.literal("failed"),
        lifecycleReasonCode: z.literal("adapter_unavailable"),
        readinessReasonCode: z.literal("adapter_unavailable"),
        layerEquivalence: z.literal(
          "every-lifecycle-fault-reason-has-a-readiness-counterpart",
        ),
        equivalentReasonCount: z.literal(8),
        mutationAppliedWhileNotReady: z.literal(false),
        readyAfterRecovery: z.literal(true),
        routeBehaviorScope: z.literal("phase-4-not-proved-here"),
      })
      .strict(),
    monotonicity: z
      .object({
        fencingToken: z.literal("nondecreasing"),
        streamSequenceHighWater: z.literal("nondecreasing"),
        provenanceCheckpoint: z.literal("nondecreasing"),
      })
      .strict(),
    claims: z
      .object({
        referenceModel: z.literal("test-only"),
        adapterConformance: z.literal("not-claimed"),
        runtimeIntegration: z.literal("none"),
        storageQueryContract: z.literal("none"),
        readinessRouteContract: z.literal("none"),
        retentionPruneExecution: z.literal("not-executed"),
      })
      .strict(),
  })
  .strict();

export type SharedStatePartitionConformanceReportV1 = Readonly<
  z.infer<typeof sharedStatePartitionConformanceReportV1Schema>
>;

/**
 * Backend-neutral target seam. `transact`, `open`, and `close` use only the
 * existing storage V1 contract. Every other method is explicitly a bounded
 * test-only conformance control.
 */
export interface SharedStatePartitionConformanceTargetV1 {
  open(): Promise<unknown>;
  transact(command: SharedStateTransactionCommandV1): Promise<unknown>;
  captureConformanceSnapshot(): Promise<unknown>;
  armConformanceFault(
    faultPoint: SharedStatePartitionFaultPointV1 | null,
  ): void;
  captureConformanceReadiness(): Promise<unknown>;
  readConformanceStaleProjection(): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface SharedStatePartitionConformanceTargetFactoryV1 {
  create(): Promise<SharedStatePartitionConformanceTargetV1>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

/**
 * Every declared unavailable fault point must map to a distinct existing
 * closed unavailable reason code, and together they must cover every closed
 * reason except `unsafe_clock`, which Phase 2.4 already proves through the
 * time contract rather than through partition injection.
 */
const FAULT_REASON_COVERAGE = (() => {
  const mapped = Object.values(SHARED_STATE_PARTITION_FAULT_REASONS_V1);
  if (new Set(mapped).size !== mapped.length) {
    return fail("fault_reason_coverage_mismatch");
  }
  for (const reason of mapped) {
    if (!V.unavailableReasonCodes.includes(reason)) {
      return fail("fault_reason_coverage_mismatch");
    }
  }
  const uncovered = V.unavailableReasonCodes.filter(
    (reason) => !mapped.includes(reason as (typeof mapped)[number]),
  );
  if (uncovered.length !== 1 || uncovered[0] !== "unsafe_clock") {
    return fail("fault_reason_coverage_mismatch");
  }
  return "exactly-the-closed-unavailable-reasons" as const;
})();

/**
 * The boundary split that made this section startable claims the readiness
 * signal exists at two layers. That claim is checked here rather than
 * asserted: every lifecycle fault reason must have an exact readiness
 * counterpart, and the only lifecycle-only codes must be normal transitions.
 */
const READINESS_LAYER_EQUIVALENCE = (() => {
  const readiness = new Set<string>(V.readinessReasonCodes);
  const lifecycleOnly = V.lifecycleReasonCodes.filter(
    (code) => !readiness.has(code),
  );
  const expectedLifecycleOnly = [
    "open_requested",
    "drain_requested",
    "close_requested",
    "drain_timeout",
    "ambiguous_write",
  ];
  if (
    lifecycleOnly.length !== expectedLifecycleOnly.length
    || lifecycleOnly.some((code, index) => code !== expectedLifecycleOnly[index])
  ) {
    return fail("readiness_vocabulary_mismatch");
  }
  const shared = V.lifecycleReasonCodes.filter((code) => readiness.has(code));
  if (shared.length !== 8 || !shared.includes("adapter_unavailable")) {
    return fail("readiness_vocabulary_mismatch");
  }
  return shared.length;
})();

const OUTBOX_REGISTRATION = (() => {
  const entry = sharedStateOutboxCatalogV1().entries.find(
    (candidate) => (
      candidate.namespace === "broker.terminal-outbox"
      && candidate.eventPurpose === "task-terminal-notification"
    ),
  );
  if (entry === undefined) return fail("registry_policy_mismatch");
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
  | "broker.outbox.receipt-evidence";

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

const REPLAY_NAMESPACE = "security.replay.partition";
const RATE_NAMESPACE = "security.rate-limit.partition";
const LEASE_NAMESPACE = "broker.lease.partition";
const IDEMPOTENCY_NAMESPACE = "broker.task.create";
const OUTBOX_NAMESPACE = OUTBOX_REGISTRATION.namespace;

function replayCommand(ordinal: number): CommandFor<"consumeReplayNonce"> {
  return command("consumeReplayNonce", {
    namespace: REPLAY_NAMESPACE,
    keyDigest: digest(
      "security.replay.requester-key",
      REPLAY_NAMESPACE,
      [{ field: "requesterId", type: "utf8", value: "partition-requester" }],
    ),
    nonceDigest: digest("security.replay.nonce", REPLAY_NAMESPACE, [
      { field: "nonce", type: "utf8", value: `partition-${ordinal}` },
    ]),
    ttlMs: 1_000,
  });
}

function rateCommand(): CommandFor<"reserveRateLimitCost"> {
  return command("reserveRateLimitCost", {
    namespace: RATE_NAMESPACE,
    bucketKeyDigest: digest(
      "security.rate-limit.bucket-key",
      RATE_NAMESPACE,
      [
        { field: "principal", type: "utf8", value: "partition-principal" },
        { field: "route", type: "utf8", value: "partition-route" },
      ],
    ),
    cost: 1,
    limit: 4,
    windowMs: 1_000,
  });
}

const LEASE_RESOURCE_DIGEST = digest(
  "broker.lease.resource-key",
  LEASE_NAMESPACE,
  [
    { field: "resourceType", type: "utf8", value: "broker-partition" },
    { field: "resourceId", type: "utf8", value: "partition-resource" },
  ],
);

function leaseOwnerDigest(ownerId: string): string {
  return digest("broker.lease.owner-key", LEASE_NAMESPACE, [
    { field: "ownerId", type: "utf8", value: ownerId },
  ]);
}

function claimCommand(
  expectedResourceVersion: string,
): CommandFor<"claimLease"> {
  return command("claimLease", {
    namespace: LEASE_NAMESPACE,
    resourceKeyDigest: LEASE_RESOURCE_DIGEST,
    ownerKeyDigest: leaseOwnerDigest("owner-a"),
    leaseDurationMs: 60_000,
    expectedResourceVersion,
  });
}

function leaseAuthority(
  attemptKeyDigest: string,
  fencingToken: string,
  expectedResourceVersion: string,
): Record<string, unknown> {
  return {
    namespace: LEASE_NAMESPACE,
    resourceKeyDigest: LEASE_RESOURCE_DIGEST,
    ownerKeyDigest: leaseOwnerDigest("owner-a"),
    attemptKeyDigest,
    fencingToken,
    expectedResourceVersion,
  };
}

function renewCommand(
  attemptKeyDigest: string,
  fencingToken: string,
  expectedResourceVersion: string,
): CommandFor<"renewLease"> {
  return command("renewLease", {
    ...leaseAuthority(
      attemptKeyDigest,
      fencingToken,
      expectedResourceVersion,
    ),
    leaseDurationMs: 60_000,
  } as CommandFor<"renewLease">["input"]);
}

function fencedMutationCommand(
  attemptKeyDigest: string,
  fencingToken: string,
  expectedResourceVersion: string,
): CommandFor<"mutateWithFence"> {
  return command("mutateWithFence", {
    ...leaseAuthority(
      attemptKeyDigest,
      fencingToken,
      expectedResourceVersion,
    ),
    mutationKind: "checkpoint",
    mutationDigest: digest("broker.lease.mutation", LEASE_NAMESPACE, [
      { field: "mutationKind", type: "utf8", value: "checkpoint" },
      { field: "mutationBody", type: "bytes", value: "2505" },
    ]),
  } as CommandFor<"mutateWithFence">["input"]);
}

function idempotentCommand(): CommandFor<"executeIdempotent"> {
  return command("executeIdempotent", {
    namespace: IDEMPOTENCY_NAMESPACE,
    keyDigest: digest("broker.idempotency.key", IDEMPOTENCY_NAMESPACE, [
      { field: "operationName", type: "utf8", value: "partition-execute" },
      { field: "clientKey", type: "utf8", value: "partition-client" },
    ]),
    payloadFingerprint: digest(
      "broker.idempotency.payload-fingerprint",
      IDEMPOTENCY_NAMESPACE,
      [{ field: "payload", type: "bytes", value: "2505" }],
    ),
    retentionPolicyVersion: "task-create-effects.v1",
    effect: {
      kind: "domain-mutation-with-outbox",
      domainMutationDigest: digest(
        "broker.idempotency.domain-mutation",
        IDEMPOTENCY_NAMESPACE,
        [
          { field: "mutationType", type: "utf8", value: "partition" },
          { field: "mutationBody", type: "bytes", value: "2505" },
        ],
      ),
      outbox: {
        streamKeyDigest: digest(
          "broker.outbox.stream-key",
          IDEMPOTENCY_NAMESPACE,
          [
            { field: "streamType", type: "utf8", value: "synthetic" },
            { field: "streamId", type: "utf8", value: "partition" },
          ],
        ),
        eventKeyDigest: digest(
          "broker.outbox.event-key",
          IDEMPOTENCY_NAMESPACE,
          [{ field: "eventId", type: "utf8", value: "partition-effect" }],
        ),
        payloadDigest: digest(
          "broker.outbox.payload",
          IDEMPOTENCY_NAMESPACE,
          [{ field: "payload", type: "bytes", value: "25e0" }],
        ),
        retentionPolicyVersion: "caller-owned-outbox.v1",
      },
    },
  });
}

function outboxStreamComponents(): {
  field: string;
  type: "utf8";
  value: string;
}[] {
  return [
    { field: "streamType", type: "utf8", value: "broker-terminal-outbox" },
    { field: "streamId", type: "utf8", value: "partition-stream" },
  ];
}

const OUTBOX_STREAM_KEY_DIGEST = digest(
  "broker.outbox.stream-key",
  OUTBOX_NAMESPACE,
  outboxStreamComponents(),
);

function outboxEventKeyDigest(ordinal: number): string {
  return digest("broker.outbox.event-key", OUTBOX_NAMESPACE, [
    { field: "eventId", type: "utf8", value: `partition-${ordinal}` },
  ]);
}

function appendOutboxCommand(ordinal: number): CommandFor<"appendOutbox"> {
  return command("appendOutbox", {
    namespace: OUTBOX_NAMESPACE,
    eventPurpose: OUTBOX_REGISTRATION.eventPurpose,
    streamKey: {
      keyspaceVersion: V.versions.keyspace,
      components: outboxStreamComponents(),
    },
    streamKeyDigest: OUTBOX_STREAM_KEY_DIGEST,
    orderingScope: OUTBOX_REGISTRATION.orderingScope,
    idempotencyKeyDigest: digest(
      "broker.outbox.idempotency-key",
      OUTBOX_NAMESPACE,
      [
        { field: "producerId", type: "utf8", value: "partition-producer" },
        { field: "clientKey", type: "utf8", value: `partition-${ordinal}` },
      ],
    ),
    eventKeyDigest: outboxEventKeyDigest(ordinal),
    payloadDigest: digest("broker.outbox.payload", OUTBOX_NAMESPACE, [
      { field: "payload", type: "bytes", value: `25${ordinal}0` },
    ]),
    retentionPolicyVersion: OUTBOX_REGISTRATION.retentionPolicyVersion,
    receiptPolicyVersion: OUTBOX_REGISTRATION.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      OUTBOX_REGISTRATION.acknowledgmentPolicyVersion,
  } as CommandFor<"appendOutbox">["input"]);
}

function acknowledgeOutboxCommand(
  ordinal: number,
): CommandFor<"acknowledgeOutbox"> {
  return command("acknowledgeOutbox", {
    namespace: OUTBOX_NAMESPACE,
    eventPurpose: OUTBOX_REGISTRATION.eventPurpose,
    streamKey: {
      keyspaceVersion: V.versions.keyspace,
      components: outboxStreamComponents(),
    },
    streamKeyDigest: OUTBOX_STREAM_KEY_DIGEST,
    orderingScope: OUTBOX_REGISTRATION.orderingScope,
    eventKeyDigest: outboxEventKeyDigest(ordinal),
    receiptEvidenceDigest: digest(
      "broker.outbox.receipt-evidence",
      OUTBOX_NAMESPACE,
      [
        { field: "provider", type: "utf8", value: "conformance" },
        {
          field: "evidence",
          type: "bytes",
          value: `25${ordinal.toString(16).padStart(2, "0")}`,
        },
      ],
    ),
    retentionPolicyVersion: OUTBOX_REGISTRATION.retentionPolicyVersion,
    receiptPolicyVersion: OUTBOX_REGISTRATION.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      OUTBOX_REGISTRATION.acknowledgmentPolicyVersion,
    receiptEvidenceKind: "current-session-visible",
    expectedReceiptState: "confirmed",
    expectedAcknowledgmentState: "unacknowledged",
  } as CommandFor<"acknowledgeOutbox">["input"]);
}

async function createTarget(
  factory: SharedStatePartitionConformanceTargetFactoryV1,
): Promise<SharedStatePartitionConformanceTargetV1> {
  try {
    return await factory.create();
  } catch {
    return fail("target_create_failed");
  }
}

export function seededDeterministicPartitionFaultOrderV1():
readonly SharedStatePartitionFaultPointV1[] {
  const order = [...SHARED_STATE_PARTITION_FAULT_POINTS_V1];
  let state = SHARED_STATE_PARTITION_CONFORMANCE_V1.schedulerSeed >>> 0;
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const other = state % (index + 1);
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  return Object.freeze(order);
}

/**
 * Runs the bounded Phase 2.5 source-only slice. Successful output contains
 * only strict public-safe aggregate facts; target values and thrown messages
 * are never reflected.
 */
export async function runSharedStatePartitionConformanceV1(
  factory: SharedStatePartitionConformanceTargetFactoryV1,
): Promise<SharedStatePartitionConformanceReportV1> {
  let targetCount = 0;
  let targetCommandCount = 0;
  let lifecycleCount = 0;
  let snapshotControlCount = 0;
  let faultControlCount = 0;
  let staleReadControlCount = 0;
  let readinessControlCount = 0;

  async function lifecycle(
    action: () => Promise<unknown>,
  ): Promise<SharedStateStorageLifecycleV1> {
    lifecycleCount += 1;
    if (lifecycleCount > SHARED_STATE_PARTITION_CONFORMANCE_V1.lifecycleLimit) {
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

  async function openedTarget():
  Promise<SharedStatePartitionConformanceTargetV1> {
    targetCount += 1;
    if (targetCount > SHARED_STATE_PARTITION_CONFORMANCE_V1.targetCount) {
      return fail("operation_limit_exceeded");
    }
    const target = await createTarget(factory);
    const opened = await lifecycle(() => target.open());
    if (opened.state !== "ready" || opened.reasonCodes.length !== 0) {
      fail("target_lifecycle_failed");
    }
    return target;
  }

  async function closeTarget(
    target: SharedStatePartitionConformanceTargetV1,
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
    target: SharedStatePartitionConformanceTargetV1,
    generatedCommand: CommandFor<Selected>,
  ): Promise<ResultFor<Selected>> {
    targetCommandCount += 1;
    if (
      targetCommandCount
      > SHARED_STATE_PARTITION_CONFORMANCE_V1.targetCommandLimit
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
    target: SharedStatePartitionConformanceTargetV1,
  ): Promise<SharedStatePartitionConformanceSnapshotV1> {
    snapshotControlCount += 1;
    if (
      snapshotControlCount
      > SHARED_STATE_PARTITION_CONFORMANCE_V1.snapshotControlLimit
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
      sharedStatePartitionConformanceSnapshotV1Schema.safeParse(raw);
    if (!parsed.success) return fail("invalid_conformance_snapshot");
    return deepFreeze(parsed.data);
  }

  function armFault(
    target: SharedStatePartitionConformanceTargetV1,
    faultPoint: SharedStatePartitionFaultPointV1 | null,
  ): void {
    faultControlCount += 1;
    if (
      faultControlCount
      > SHARED_STATE_PARTITION_CONFORMANCE_V1.faultControlLimit
    ) {
      fail("operation_limit_exceeded");
    }
    try {
      target.armConformanceFault(faultPoint);
    } catch {
      fail("target_fault_control_failed");
    }
  }

  async function readiness(
    target: SharedStatePartitionConformanceTargetV1,
  ): Promise<SharedStatePartitionReadinessV1> {
    readinessControlCount += 1;
    if (
      readinessControlCount
      > SHARED_STATE_PARTITION_CONFORMANCE_V1.readinessControlCount
    ) {
      return fail("operation_limit_exceeded");
    }
    let raw: unknown;
    try {
      raw = await target.captureConformanceReadiness();
    } catch {
      return fail("target_lifecycle_failed");
    }
    const parsed = sharedStatePartitionReadinessV1Schema.safeParse(raw);
    if (!parsed.success) return fail("invalid_target_lifecycle");
    return deepFreeze(parsed.data);
  }

  async function staleRead(
    target: SharedStatePartitionConformanceTargetV1,
  ): Promise<SharedStatePartitionStaleReadV1> {
    staleReadControlCount += 1;
    if (
      staleReadControlCount
      > SHARED_STATE_PARTITION_CONFORMANCE_V1.staleReadControlCount
    ) {
      return fail("operation_limit_exceeded");
    }
    let raw: unknown;
    try {
      raw = await target.readConformanceStaleProjection();
    } catch {
      return fail("target_stale_read_control_failed");
    }
    const parsed = sharedStatePartitionStaleReadV1Schema.safeParse(raw);
    if (!parsed.success) return fail("invalid_conformance_stale_read");
    return deepFreeze(parsed.data);
  }

  function sameGraphState(
    left: SharedStatePartitionConformanceSnapshotV1,
    right: SharedStatePartitionConformanceSnapshotV1,
  ): boolean {
    return (
      left.replayRecordCount === right.replayRecordCount
      && left.rateEntryCount === right.rateEntryCount
      && left.activeLeaseCount === right.activeLeaseCount
      && left.maximumFencingToken === right.maximumFencingToken
      && left.leaseResourceVersion === right.leaseResourceVersion
      && left.idempotencyOutcomeCount === right.idempotencyOutcomeCount
      && left.outboxEventCount === right.outboxEventCount
      && left.unacknowledgedEventCount === right.unacknowledgedEventCount
      && left.acknowledgedEventCount === right.acknowledgedEventCount
      && left.streamSequenceHighWater === right.streamSequenceHighWater
      && left.provenanceSourceCount === right.provenanceSourceCount
      && left.provenanceCheckpointSequence
        === right.provenanceCheckpointSequence
      && left.prunedRecordCount === right.prunedRecordCount
    );
  }

  // Scenario A: every declared fault point produces its exact closed
  // unavailable reason, never an empty or permissive local decision.
  const faultOrder = seededDeterministicPartitionFaultOrderV1();
  const faultCases: {
    faultPoint: SharedStatePartitionFaultPointV1;
    scheduleRank: number;
    attemptStatus: "unavailable" | "committed";
    attemptReasonCode: string;
    localDecisionEmitted: false;
    stateMutated: false;
  }[] = [];
  const faultTarget = await openedTarget();
  const faultBaseline = await snapshot(faultTarget);

  for (let index = 0; index < faultOrder.length; index += 1) {
    const faultPoint = faultOrder[index]!;
    armFault(faultTarget, faultPoint);
    if (faultPoint === "delayed-read") {
      // A read-path fault yields a stale answer, not an unavailable write.
      const stale = await staleRead(faultTarget);
      if (
        stale.freshness !== "stale"
        || stale.completeness === "complete"
        || Number(stale.lag) <= 0
      ) {
        fail("stale_read_not_labeled");
      }
      faultCases.push({
        faultPoint,
        scheduleRank: index + 1,
        attemptStatus: "committed",
        attemptReasonCode: "none",
        localDecisionEmitted: false,
        stateMutated: false,
      });
      continue;
    }
    const expected = SHARED_STATE_PARTITION_FAULT_REASONS_V1[faultPoint];
    const attempt = await transact(faultTarget, replayCommand(index + 1));
    const after = await snapshot(faultTarget);
    if (attempt.status !== "unavailable") fail("empty_local_decision");
    if (attempt.reasonCode !== expected) fail("unavailable_reason_mismatch");
    if (!sameGraphState(after, faultBaseline)) {
      fail("mutation_applied_while_unavailable");
    }
    faultCases.push({
      faultPoint,
      scheduleRank: index + 1,
      attemptStatus: "unavailable",
      attemptReasonCode: attempt.reasonCode,
      localDecisionEmitted: false,
      stateMutated: false,
    });
  }

  // Scenario B: protected replay and rate requests fail closed rather than
  // returning an empty local decision.
  armFault(faultTarget, "unavailable");
  const protectedReplay = await transact(faultTarget, replayCommand(9));
  armFault(faultTarget, "timeout");
  const protectedRate = await transact(faultTarget, rateCommand());
  const afterProtected = await snapshot(faultTarget);
  if (
    protectedReplay.status !== "unavailable"
    || protectedReplay.reasonCode !== "authority_unavailable"
    || protectedRate.status !== "unavailable"
    || protectedRate.reasonCode !== "lock_timeout"
  ) {
    fail("empty_local_decision");
  }
  if (!sameGraphState(afterProtected, faultBaseline)) {
    fail("mutation_applied_while_unavailable");
  }
  await closeTarget(faultTarget);

  // Scenario C: no claim, renewal, fenced mutation, or idempotent mutation
  // applies while the authority is unavailable; a clean retry applies once.
  const mutationTarget = await openedTarget();
  const seedClaim = await transact(mutationTarget, claimCommand("0"));
  if (
    seedClaim.status !== "committed"
    || seedClaim.result.decision !== "claimed"
  ) {
    fail("mutation_applied_while_unavailable");
  }
  const mutationBaseline = await snapshot(mutationTarget);
  armFault(mutationTarget, "unavailable");
  const blockedClaim = await transact(mutationTarget, claimCommand("1"));
  const blockedRenew = await transact(
    mutationTarget,
    renewCommand(
      seedClaim.result.attemptKeyDigest,
      seedClaim.result.fencingToken,
      seedClaim.result.resourceVersion,
    ),
  );
  const blockedFenced = await transact(
    mutationTarget,
    fencedMutationCommand(
      seedClaim.result.attemptKeyDigest,
      seedClaim.result.fencingToken,
      seedClaim.result.resourceVersion,
    ),
  );
  const blockedIdempotent = await transact(
    mutationTarget,
    idempotentCommand(),
  );
  const afterBlocked = await snapshot(mutationTarget);
  if (
    blockedClaim.status !== "unavailable"
    || blockedRenew.status !== "unavailable"
    || blockedFenced.status !== "unavailable"
    || blockedIdempotent.status !== "unavailable"
  ) {
    fail("mutation_applied_while_unavailable");
  }
  if (!sameGraphState(afterBlocked, mutationBaseline)) {
    fail("mutation_applied_while_unavailable");
  }
  armFault(mutationTarget, null);
  const cleanIdempotent = await transact(mutationTarget, idempotentCommand());
  const afterClean = await snapshot(mutationTarget);
  if (
    cleanIdempotent.status !== "committed"
    || cleanIdempotent.result.decision !== "executed"
    || afterClean.idempotencyOutcomeCount
      !== mutationBaseline.idempotencyOutcomeCount + 1
  ) {
    fail("recovery_mismatch");
  }
  await closeTarget(mutationTarget);

  // Scenario D: the outbox producer transaction fails atomically, the
  // consumer can still replay, and ACK is refused while partitioned.
  const outboxTarget = await openedTarget();
  const seededAppend = await transact(outboxTarget, appendOutboxCommand(1));
  if (
    seededAppend.status !== "committed"
    || seededAppend.result.decision !== "appended"
  ) {
    fail("outbox_partial_effect");
  }
  const outboxBaseline = await snapshot(outboxTarget);
  armFault(outboxTarget, "unavailable");
  const blockedAppend = await transact(outboxTarget, appendOutboxCommand(2));
  const blockedAck = await transact(
    outboxTarget,
    acknowledgeOutboxCommand(1),
  );
  const afterPartitionedOutbox = await snapshot(outboxTarget);
  if (
    blockedAppend.status !== "unavailable"
    || !sameGraphState(afterPartitionedOutbox, outboxBaseline)
  ) {
    fail("outbox_partial_effect");
  }
  if (blockedAck.status !== "unavailable") {
    fail("ack_permitted_while_partitioned");
  }
  if (
    afterPartitionedOutbox.unacknowledgedEventCount
      !== outboxBaseline.unacknowledgedEventCount
    || afterPartitionedOutbox.acknowledgedEventCount !== 0
    || afterPartitionedOutbox.prunedRecordCount !== 0
  ) {
    fail("ack_permitted_while_partitioned");
  }
  // The consumer may still replay the retained event: the idempotent append
  // retry returns its original binding rather than a second effect.
  armFault(outboxTarget, null);
  const consumerReplay = await transact(outboxTarget, appendOutboxCommand(1));
  const afterReplay = await snapshot(outboxTarget);
  if (
    consumerReplay.status !== "committed"
    || consumerReplay.result.decision !== "replayed"
    || afterReplay.outboxEventCount !== outboxBaseline.outboxEventCount
  ) {
    fail("outbox_partial_effect");
  }
  await closeTarget(outboxTarget);

  // Scenario E: the partitioned read served an explicitly stale answer with
  // checkpoint and lag. Phase 2.7 already proves the incomplete, unavailable,
  // and no-evidence-path cases, so they are not reimplemented here.
  const staleTarget = await openedTarget();
  armFault(staleTarget, "delayed-read");
  const staleAnswer = await staleRead(staleTarget);
  if (
    staleAnswer.freshness !== "stale"
    || staleAnswer.completeness === "complete"
    || Number(staleAnswer.lag) <= 0
    || BigInt(staleAnswer.asOfSourceSequence)
      >= BigInt(staleAnswer.sourceSequenceHighWater)
    || staleAnswer.asOfSourceSequence !== staleAnswer.checkpointSequence
  ) {
    fail("stale_read_not_labeled");
  }
  await closeTarget(staleTarget);

  // Scenario F: adapter-lifecycle readiness. Route behavior is Phase 4.
  const readinessTarget = await openedTarget();
  const readyBefore = await readiness(readinessTarget);
  const readinessBaseline = await snapshot(readinessTarget);
  armFault(readinessTarget, "unavailable");
  const notReady = await readiness(readinessTarget);
  const blockedWrite = await transact(readinessTarget, replayCommand(11));
  const afterNotReady = await snapshot(readinessTarget);
  if (
    readyBefore.ready !== true
    || readyBefore.lifecycleState !== "ready"
    || readyBefore.readinessReasonCodes.length !== 0
  ) {
    fail("not_ready_state_mismatch");
  }
  if (
    notReady.ready !== false
    || notReady.lifecycleState !== "failed"
    || notReady.lifecycleReasonCodes.length !== 1
    || notReady.lifecycleReasonCodes[0] !== "adapter_unavailable"
    || notReady.readinessReasonCodes.length !== 1
    || notReady.readinessReasonCodes[0] !== "adapter_unavailable"
  ) {
    fail("not_ready_state_mismatch");
  }
  if (
    blockedWrite.status !== "unavailable"
    || !sameGraphState(afterNotReady, readinessBaseline)
  ) {
    fail("mutation_applied_while_unavailable");
  }
  armFault(readinessTarget, null);
  const recovered = await transact(readinessTarget, replayCommand(11));
  if (
    recovered.status !== "committed"
    || recovered.result.decision !== "accepted"
  ) {
    fail("recovery_mismatch");
  }
  await closeTarget(readinessTarget);

  if (
    targetCount !== SHARED_STATE_PARTITION_CONFORMANCE_V1.targetCount
    || targetCommandCount
      !== SHARED_STATE_PARTITION_CONFORMANCE_V1.expectedTargetCommandCount
    || lifecycleCount
      !== SHARED_STATE_PARTITION_CONFORMANCE_V1.expectedLifecycleCount
    || snapshotControlCount
      !== SHARED_STATE_PARTITION_CONFORMANCE_V1.expectedSnapshotControlCount
    || faultControlCount
      !== SHARED_STATE_PARTITION_CONFORMANCE_V1.expectedFaultControlCount
    || staleReadControlCount
      !== SHARED_STATE_PARTITION_CONFORMANCE_V1.staleReadControlCount
    || readinessControlCount
      !== SHARED_STATE_PARTITION_CONFORMANCE_V1.readinessControlCount
  ) {
    fail("operation_limit_exceeded");
  }

  const report = {
    kind: SHARED_STATE_PARTITION_CONFORMANCE_V1.kind,
    harnessVersion: SHARED_STATE_PARTITION_CONFORMANCE_V1.harnessVersion,
    contractVersion: V.versions.contract,
    scope: SHARED_STATE_PARTITION_CONFORMANCE_V1.scope,
    status: "passed",
    controls: {
      scheduler: "seeded-deterministic-serial",
      schedulerSeed: SHARED_STATE_PARTITION_CONFORMANCE_V1.schedulerSeed,
      concurrency: "not-exercised",
      barrier: "not-required",
      clock: "not-required",
      targetIsolation: "factory-created-per-scenario",
      targetCount,
      targetCommandLimit:
        SHARED_STATE_PARTITION_CONFORMANCE_V1.targetCommandLimit,
      targetCommandCount,
      lifecycleLimit: SHARED_STATE_PARTITION_CONFORMANCE_V1.lifecycleLimit,
      lifecycleCount,
      snapshotControlLimit:
        SHARED_STATE_PARTITION_CONFORMANCE_V1.snapshotControlLimit,
      snapshotControlCount,
      faultControlLimit:
        SHARED_STATE_PARTITION_CONFORMANCE_V1.faultControlLimit,
      faultControlCount,
      staleReadControlCount,
      readinessControlCount,
    },
    faultPoints: {
      count: SHARED_STATE_PARTITION_CONFORMANCE_V1.faultPointCount,
      reasonCoverage: FAULT_REASON_COVERAGE,
      previouslyUncovered: ["lock_timeout", "delayed-read"],
      cases: faultCases,
    },
    protectedRequests: {
      replayStatus: "unavailable",
      replayReasonCode: "authority_unavailable",
      rateStatus: "unavailable",
      rateReasonCode: "lock_timeout",
      emptyLocalDecisionObserved: false,
      permissiveFallbackObserved: false,
    },
    mutationsWhileUnavailable: {
      claimStatus: "unavailable",
      renewStatus: "unavailable",
      fencedMutationStatus: "unavailable",
      idempotentStatus: "unavailable",
      appliedMutationCount: 0,
      snapshotUnchanged: true,
      cleanRetryAppliesOnce: true,
    },
    outboxUnderPartition: {
      producerStatus: "unavailable",
      producerPartialEffectCount: 0,
      consumerReplayPreserved: true,
      acknowledgeStatus: "unavailable",
      acknowledgmentStatePreserved: "unacknowledged",
      prunedRecordCount: 0,
      retentionPruneExecution: "not-executed",
    },
    partitionedRead: {
      faultPoint: "delayed-read",
      freshness: "stale",
      explicitlyLabeled: true,
      carriesCheckpointAndLag: true,
      servedAnswerIsNotNegativeEvidence: true,
      priorSliceCoversRemainingCases:
        "phase-2.7-projection-incomplete-unavailable-no-evidence-path",
    },
    adapterReadiness: {
      readyBeforePartition: true,
      readyDuringPartition: false,
      lifecycleStateDuringPartition: "failed",
      lifecycleReasonCode: "adapter_unavailable",
      readinessReasonCode: "adapter_unavailable",
      layerEquivalence:
        "every-lifecycle-fault-reason-has-a-readiness-counterpart",
      equivalentReasonCount: READINESS_LAYER_EQUIVALENCE,
      mutationAppliedWhileNotReady: false,
      readyAfterRecovery: true,
      routeBehaviorScope: "phase-4-not-proved-here",
    },
    monotonicity: {
      fencingToken: "nondecreasing",
      streamSequenceHighWater: "nondecreasing",
      provenanceCheckpoint: "nondecreasing",
    },
    claims: {
      referenceModel: "test-only",
      adapterConformance: "not-claimed",
      runtimeIntegration: "none",
      storageQueryContract: "none",
      readinessRouteContract: "none",
      retentionPruneExecution: "not-executed",
    },
  } as const;
  const parsed =
    sharedStatePartitionConformanceReportV1Schema.safeParse(report);
  if (!parsed.success) return fail("report_invalid");
  return deepFreeze(parsed.data);
}
