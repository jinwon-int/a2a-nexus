/**
 * Backend-neutral deterministic restart-continuity conformance harness for
 * `a2a.shared-state.storage/v1`.
 *
 * The harness reuses the existing storage V1 command/result/lifecycle
 * envelopes, keyspace digests, closed idempotency/outbox registrations, and
 * shared-state time V1 evaluator. It does not implement storage, clocks,
 * health/readiness routes, queries, migrations, or broker runtime wiring.
 *
 * Snapshot, crash-fault, cursor, and reconciliation methods on the target
 * seam are bounded test-only conformance controls. They are not V1 adapter or
 * runtime APIs.
 */

import { z } from "zod";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  digestSharedStateKeyV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  sharedStateIdempotencyCatalogV1,
  sharedStateOutboxCatalogV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_TIME_V1_VALUES as TIME_V,
  evaluateSharedStateLogicalBoundaryV1,
  evaluateSharedStateTimeV1,
  type SharedStateClockProfileV1,
  type SharedStateTimeEvaluationV1,
  type SharedStateTimePolicyV1,
} from "./shared-state-time-v1.js";

export const SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1 =
  Object.freeze({
    kind: "SharedStateRestartContinuityConformanceReportV1",
    harnessVersion: 1,
    scope: "restart-continuity",
    schedulerSeed: 1504,
    initialInstant: 2_000_000n,
    boundaryDurationMs: 1_000,
    reopenAdvanceMs: 100,
    backwardSkewToleranceMs: 10,
    targetCount: 6,
    targetCommandLimit: 64,
    expectedTargetCommandCount: 45,
    lifecycleLimit: 24,
    expectedLifecycleCount: 21,
    snapshotControlLimit: 24,
    expectedSnapshotControlCount: 19,
    faultControlCount: 4,
    cursorControlCount: 2,
    clockControlCount: 3,
    streamLimit: 2,
    reconcileEventLimit: 4,
  } as const);

export const SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1 =
  Object.freeze([
    "before-command-commit",
    "after-command-commit-before-response",
    "before-ack-commit",
    "after-ack-commit-before-response",
  ] as const);

export const SHARED_STATE_RESTART_CONTINUITY_ERROR_CODES_V1 =
  Object.freeze([
    "invalid_generated_command",
    "invalid_target_result",
    "invalid_target_lifecycle",
    "invalid_conformance_snapshot",
    "invalid_conformance_cursor",
    "invalid_conformance_reconcile_response",
    "target_create_failed",
    "target_operation_failed",
    "target_lifecycle_failed",
    "target_snapshot_control_failed",
    "target_fault_control_failed",
    "target_cursor_control_failed",
    "target_reconcile_control_failed",
    "clock_control_failed",
    "operation_limit_exceeded",
    "registry_policy_mismatch",
    "time_evaluator_mismatch",
    "continuity_baseline_mismatch",
    "replay_continuity_mismatch",
    "rate_continuity_mismatch",
    "lease_continuity_mismatch",
    "idempotency_continuity_mismatch",
    "outbox_continuity_mismatch",
    "graph_continuity_mismatch",
    "crash_recovery_mismatch",
    "backward_clock_mismatch",
    "high_water_regression",
    "report_invalid",
    "reference_model_invariant",
  ] as const);

export type SharedStateRestartContinuityFaultPointV1 =
  (typeof SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1)[number];
export type SharedStateRestartContinuityErrorCodeV1 =
  (typeof SHARED_STATE_RESTART_CONTINUITY_ERROR_CODES_V1)[number];

type Operation = SharedStateTransactionCommandV1["operation"];
type CommandFor<Selected extends Operation> = Extract<
  SharedStateTransactionCommandV1,
  { readonly operation: Selected }
>;
type ResultFor<Selected extends Operation> = Extract<
  SharedStateTransactionResultV1,
  { readonly operation: Selected }
>;

export const sharedStateRestartContinuityErrorReportV1Schema = z
  .object({
    kind: z.literal("SharedStateRestartContinuityConformanceErrorV1"),
    errorVersion: z.literal(1),
    code: z.enum(SHARED_STATE_RESTART_CONTINUITY_ERROR_CODES_V1),
  })
  .strict();

export type SharedStateRestartContinuityErrorReportV1 = Readonly<
  z.infer<typeof sharedStateRestartContinuityErrorReportV1Schema>
>;

export class SharedStateRestartContinuityConformanceErrorV1
extends Error {
  readonly code: SharedStateRestartContinuityErrorCodeV1;
  readonly publicReport: SharedStateRestartContinuityErrorReportV1;

  constructor(code: SharedStateRestartContinuityErrorCodeV1) {
    super(code);
    this.name = "SharedStateRestartContinuityConformanceErrorV1";
    this.code = code;
    this.publicReport = deepFreeze({
      kind: "SharedStateRestartContinuityConformanceErrorV1",
      errorVersion: 1,
      code,
    } as const);
    this.stack = `${this.name}: ${code}`;
  }

  toJSON(): SharedStateRestartContinuityErrorReportV1 {
    return this.publicReport;
  }
}

function fail(
  code: SharedStateRestartContinuityErrorCodeV1,
): never {
  throw new SharedStateRestartContinuityConformanceErrorV1(code);
}

const nonNegativeDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,39})$/);
const positiveDecimalSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,39}$/);
const boundedCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.targetCommandLimit);

const streamHighWaterSchema = z
  .object({
    streamOrdinal: z
      .number()
      .int()
      .min(1)
      .max(SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.streamLimit),
    sequenceHighWater: nonNegativeDecimalSchema,
  })
  .strict();

/**
 * Strict aggregate snapshot returned only by the target's test-only
 * conformance control. It intentionally contains no identity, digest,
 * namespace, payload, time, backend, or reflected error value.
 */
export const sharedStateRestartContinuityConformanceSnapshotV1Schema = z
  .object({
    kind: z.literal(
      "SharedStateRestartContinuityConformanceSnapshotV1",
    ),
    snapshotVersion: z.literal(1),
    replayRecordCount: boundedCountSchema,
    rateWindowEntryCount: boundedCountSchema,
    accumulatedRateCost: boundedCountSchema,
    activeLeaseCount: boundedCountSchema.max(1),
    maximumFencingToken: nonNegativeDecimalSchema,
    leaseResourceVersionHighWater: nonNegativeDecimalSchema,
    leaseMutationCount: boundedCountSchema,
    idempotencyOutcomeCount: boundedCountSchema,
    domainEffectCount: boundedCountSchema,
    idempotentOutboxEffectCount: boundedCountSchema,
    outboxEventCount: boundedCountSchema,
    receiptPendingCount: boundedCountSchema,
    receiptConfirmedCount: boundedCountSchema,
    unacknowledgedCount: boundedCountSchema,
    acknowledgedCount: boundedCountSchema,
    streamHighWaters: z
      .array(streamHighWaterSchema)
      .max(SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.streamLimit),
    graphSourceFactCount: boundedCountSchema,
    graphSourceSequenceHighWater: nonNegativeDecimalSchema,
    graphProjectionBatchCount: boundedCountSchema,
    graphProjectionCheckpointHighWater: nonNegativeDecimalSchema,
  })
  .strict();

export type SharedStateRestartContinuityConformanceSnapshotV1 =
  Readonly<
    z.infer<
      typeof sharedStateRestartContinuityConformanceSnapshotV1Schema
    >
  >;

const cursorPositionSchema = z
  .object({
    streamOrdinal: z
      .number()
      .int()
      .min(1)
      .max(SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.streamLimit),
    afterSequence: nonNegativeDecimalSchema,
    acknowledgedThroughSequence: nonNegativeDecimalSchema,
  })
  .strict();

/**
 * Test-only restart-continuity cursor control. This is not a storage query,
 * adapter consumer surface, or broker runtime API.
 */
export const sharedStateRestartContinuityConformanceCursorV1Schema = z
  .object({
    kind: z.literal(
      "SharedStateRestartContinuityConformanceCursorV1",
    ),
    cursorVersion: z.literal(1),
    scope: z.literal(
      "test-only-restart-continuity-conformance-control",
    ),
    positions: z
      .array(cursorPositionSchema)
      .max(SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.streamLimit),
  })
  .strict();

export type SharedStateRestartContinuityConformanceCursorV1 = Readonly<
  z.infer<typeof sharedStateRestartContinuityConformanceCursorV1Schema>
>;

const reconcileEventSchema = z
  .object({
    eventRank: z
      .number()
      .int()
      .min(1)
      .max(
        SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
          .reconcileEventLimit,
      ),
    streamOrdinal: z
      .number()
      .int()
      .min(1)
      .max(SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.streamLimit),
    streamSequence: positiveDecimalSchema,
    receiptState: z.enum(V.receiptStates),
    acknowledgmentState: z.enum(V.acknowledgmentStates),
  })
  .strict();

/**
 * Strict response for the test-only reconciliation control. It is not a V1
 * transaction/query result and must not be attached to broker runtime.
 */
export const
sharedStateRestartContinuityConformanceReconcileResponseV1Schema = z
  .object({
    kind: z.literal(
      "SharedStateRestartContinuityConformanceReconcileResponseV1",
    ),
    responseVersion: z.literal(1),
    scope: z.literal(
      "test-only-restart-continuity-conformance-control",
    ),
    events: z
      .array(reconcileEventSchema)
      .max(
        SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
          .reconcileEventLimit,
      ),
  })
  .strict();

export type SharedStateRestartContinuityConformanceReconcileResponseV1 =
Readonly<
  z.infer<
    typeof sharedStateRestartContinuityConformanceReconcileResponseV1Schema
  >
>;

const highWaterReportSchema = z
  .object({
    maximumFencingToken: nonNegativeDecimalSchema,
    streamHighWaters: z
      .array(streamHighWaterSchema)
      .max(SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.streamLimit),
    graphSourceSequenceHighWater: nonNegativeDecimalSchema,
    graphProjectionCheckpointHighWater: nonNegativeDecimalSchema,
  })
  .strict();

const crashRecoveryReportSchema = z
  .object({
    faultPoint: z.enum(
      SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1,
    ),
    scheduleRank: z.number().int().min(1).max(4),
    firstStatus: z.literal("unavailable"),
    firstReasonCode: z.enum([
      "authority_unavailable",
      "ambiguous_commit",
    ]),
    reopenedLifecycleState: z.literal("ready"),
    recoveredState: z.enum([
      "exact-empty-baseline",
      "committed-single-effect",
      "confirmed-unacknowledged",
      "confirmed-acknowledged",
    ]),
    retryDecision: z.enum([
      "executed",
      "replayed",
      "acknowledged",
      "already_acknowledged",
    ]),
    duplicateEffectCount: z.literal(0),
    highWaters: highWaterReportSchema,
  })
  .strict();

export const sharedStateRestartContinuityConformanceReportV1Schema = z
  .object({
    kind: z.literal(
      SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.kind,
    ),
    harnessVersion: z.literal(
      SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.harnessVersion,
    ),
    contractVersion: z.literal(V.versions.contract),
    timeVersion: z.literal(TIME_V.version),
    scope: z.literal(
      SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.scope,
    ),
    status: z.literal("passed"),
    controls: z
      .object({
        scheduler: z.literal("seeded-deterministic-serial"),
        schedulerSeed: z.literal(
          SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
            .schedulerSeed,
        ),
        concurrency: z.literal("not-exercised"),
        barrier: z.literal("not-required"),
        clock: z.literal("single-injected-fake-exact-integer"),
        targetIsolation: z.literal("factory-created-per-scenario"),
        targetCount: z.literal(
          SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.targetCount,
        ),
        targetCommandLimit: z.literal(
          SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
            .targetCommandLimit,
        ),
        targetCommandCount: z.literal(
          SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
            .expectedTargetCommandCount,
        ),
        lifecycleLimit: z.literal(
          SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
            .lifecycleLimit,
        ),
        lifecycleCount: z.literal(
          SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
            .expectedLifecycleCount,
        ),
        snapshotControlLimit: z.literal(
          SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
            .snapshotControlLimit,
        ),
        snapshotControlCount: z.literal(
          SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
            .expectedSnapshotControlCount,
        ),
        faultControlCount: z.literal(
          SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
            .faultControlCount,
        ),
        cursorControlCount: z.literal(
          SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
            .cursorControlCount,
        ),
        clockControlCount: z.literal(
          SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
            .clockControlCount,
        ),
      })
      .strict(),
    continuityBaseline: z
      .object({
        reopenLifecycleState: z.literal("ready"),
        boundaryState: z.literal("before-all-declared-boundaries"),
        replayDecision: z.literal("replay"),
        rateDecision: z.literal("rate_limited"),
        leaseRenewDecision: z.literal("renewed"),
        leaseMutationDecision: z.literal("applied"),
        leaseFenceState: z.literal("original-preserved"),
        idempotencyDecision: z.literal("replayed"),
        idempotencyOutcomeState: z.literal("original-preserved"),
        duplicateEffectCount: z.literal(0),
        appendRetryCount: z.literal(3),
        appendRetryState: z.literal("original-bindings-preserved"),
        retainedEventCount: z.literal(3),
        acknowledgedEventCount: z.literal(2),
        replayedUnacknowledgedEventCount: z.literal(1),
        reconciliationReceiptState: z.literal("pending"),
        reconciliationAcknowledgmentState: z.literal("unacknowledged"),
        graphSourceRetryCount: z.literal(2),
        graphSourceRetryState: z.literal("original-sequences-preserved"),
        graphProjectionRetryDecision: z.literal("replayed"),
        graphProjectionCheckpointState: z.literal("original-preserved"),
        highWaters: highWaterReportSchema,
      })
      .strict(),
    crashRecovery: z
      .object({
        state: z.literal("passed"),
        cases: z.array(crashRecoveryReportSchema).length(4),
      })
      .strict(),
    backwardClock: z
      .object({
        evaluatorReasonCode: z.literal("backward_beyond_tolerance"),
        readiness: z.literal("not-ready"),
        writes: z.literal("forbidden"),
        logicalDecisions: z.literal("forbidden"),
        lifecycleState: z.literal("failed"),
        lifecycleReasonCode: z.literal("unsafe_clock"),
        attemptedWriteStatus: z.literal("unavailable"),
        attemptedWriteReasonCode: z.literal("unsafe_clock"),
        unsafeSnapshotState: z.literal("unchanged"),
        restoredLifecycleState: z.literal("ready"),
        restoredSnapshotState: z.literal("unchanged"),
        highWaters: highWaterReportSchema,
      })
      .strict(),
    monotonicity: z
      .object({
        fencingToken: z.literal("nondecreasing"),
        everyRetainedStreamSequenceHighWater: z.literal("nondecreasing"),
        graphSourceSequence: z.literal("nondecreasing"),
        graphProjectionCheckpoint: z.literal("nondecreasing"),
      })
      .strict(),
    claims: z
      .object({
        referenceModel: z.literal("test-only"),
        closeReopenStateRetention: z.literal(
          "test-control-not-durability-claim",
        ),
        adapterConformance: z.literal("not-claimed"),
        runtimeIntegration: z.literal("none"),
        storageQueryContract: z.literal("none"),
        retentionPruneExecution: z.literal("not-executed"),
      })
      .strict(),
  })
  .strict();

export type SharedStateRestartContinuityConformanceReportV1 = Readonly<
  z.infer<typeof sharedStateRestartContinuityConformanceReportV1Schema>
>;

export interface SharedStateRestartContinuityConformanceClockV1 {
  readObservedUnixMilliseconds(): bigint;
}

/**
 * Harness-owned fake-clock control. It is not an adapter clock API.
 */
export class InjectedRestartContinuityConformanceFakeClockV1
implements SharedStateRestartContinuityConformanceClockV1 {
  #observed: bigint = SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
    .initialInstant;

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
export interface SharedStateRestartContinuityConformanceTargetV1 {
  open(): Promise<unknown>;
  transact(command: SharedStateTransactionCommandV1): Promise<unknown>;
  captureConformanceSnapshot(): Promise<unknown>;
  armConformanceCrashFault(
    faultPoint: SharedStateRestartContinuityFaultPointV1,
  ): void;
  captureConformanceCursor(): Promise<unknown>;
  reconcileForConformance(
    cursor: SharedStateRestartContinuityConformanceCursorV1,
  ): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface SharedStateRestartContinuityConformanceTargetFactoryV1 {
  create(input: {
    readonly clock: SharedStateRestartContinuityConformanceClockV1;
  }): Promise<SharedStateRestartContinuityConformanceTargetV1>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const EMPTY_CRASH_BASELINE_SNAPSHOT_V1 = deepFreeze({
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
} satisfies SharedStateRestartContinuityConformanceSnapshotV1);

const CONFIRMED_UNACKNOWLEDGED_CRASH_BASELINE_SNAPSHOT_V1 =
deepFreeze({
  ...EMPTY_CRASH_BASELINE_SNAPSHOT_V1,
  outboxEventCount: 1,
  receiptConfirmedCount: 1,
  unacknowledgedCount: 1,
  streamHighWaters: [
    {
      streamOrdinal: 1,
      sequenceHighWater: "1",
    },
  ],
} satisfies SharedStateRestartContinuityConformanceSnapshotV1);

const EXACT_SNAPSHOT_DELTA_FIELDS_V1 = Object.freeze([
  "idempotencyOutcomeCount",
  "domainEffectCount",
  "idempotentOutboxEffectCount",
  "unacknowledgedCount",
  "acknowledgedCount",
] as const);

type ExactSnapshotDeltaFieldV1 =
  (typeof EXACT_SNAPSHOT_DELTA_FIELDS_V1)[number];
type ExactSnapshotDeltaV1 = Readonly<
  Partial<Record<ExactSnapshotDeltaFieldV1, number>>
>;

const COMMAND_COMMIT_SNAPSHOT_DELTA_V1 = deepFreeze({
  idempotencyOutcomeCount: 1,
  domainEffectCount: 1,
  idempotentOutboxEffectCount: 1,
} satisfies ExactSnapshotDeltaV1);

const ACK_COMMIT_SNAPSHOT_DELTA_V1 = deepFreeze({
  unacknowledgedCount: -1,
  acknowledgedCount: 1,
} satisfies ExactSnapshotDeltaV1);

/**
 * Derives one complete expected aggregate snapshot without mutating the
 * baseline. Only the explicitly closed atomic-delta fields may differ; every
 * other field, including every high-water, is preserved exactly.
 */
function deriveExactSnapshotWithAtomicDelta(
  baseline: SharedStateRestartContinuityConformanceSnapshotV1,
  delta: ExactSnapshotDeltaV1,
): SharedStateRestartContinuityConformanceSnapshotV1 {
  for (const [field, value] of Object.entries(delta)) {
    if (
      !(EXACT_SNAPSHOT_DELTA_FIELDS_V1 as readonly string[])
        .includes(field)
      || !Number.isSafeInteger(value)
      || (value !== -1 && value !== 1)
    ) {
      fail("crash_recovery_mismatch");
    }
  }
  const parsed =
    sharedStateRestartContinuityConformanceSnapshotV1Schema.safeParse({
      ...baseline,
      idempotencyOutcomeCount:
        baseline.idempotencyOutcomeCount
        + (delta.idempotencyOutcomeCount ?? 0),
      domainEffectCount:
        baseline.domainEffectCount
        + (delta.domainEffectCount ?? 0),
      idempotentOutboxEffectCount:
        baseline.idempotentOutboxEffectCount
        + (delta.idempotentOutboxEffectCount ?? 0),
      unacknowledgedCount:
        baseline.unacknowledgedCount
        + (delta.unacknowledgedCount ?? 0),
      acknowledgedCount:
        baseline.acknowledgedCount
        + (delta.acknowledgedCount ?? 0),
    });
  if (!parsed.success) return fail("crash_recovery_mismatch");
  return deepFreeze(parsed.data);
}

function sameSnapshot(
  left: SharedStateRestartContinuityConformanceSnapshotV1,
  right: SharedStateRestartContinuityConformanceSnapshotV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function highWaters(
  snapshot: SharedStateRestartContinuityConformanceSnapshotV1,
) {
  return {
    maximumFencingToken: snapshot.maximumFencingToken,
    streamHighWaters: snapshot.streamHighWaters,
    graphSourceSequenceHighWater:
      snapshot.graphSourceSequenceHighWater,
    graphProjectionCheckpointHighWater:
      snapshot.graphProjectionCheckpointHighWater,
  } as const;
}

function requireNoHighWaterRegression(
  before: SharedStateRestartContinuityConformanceSnapshotV1,
  after: SharedStateRestartContinuityConformanceSnapshotV1,
): void {
  if (
    BigInt(after.maximumFencingToken)
      < BigInt(before.maximumFencingToken)
    || BigInt(after.leaseResourceVersionHighWater)
      < BigInt(before.leaseResourceVersionHighWater)
    || BigInt(after.graphSourceSequenceHighWater)
      < BigInt(before.graphSourceSequenceHighWater)
    || BigInt(after.graphProjectionCheckpointHighWater)
      < BigInt(before.graphProjectionCheckpointHighWater)
  ) {
    fail("high_water_regression");
  }
  const afterStreams = new Map(
    after.streamHighWaters.map((entry) => [
      entry.streamOrdinal,
      BigInt(entry.sequenceHighWater),
    ]),
  );
  for (const entry of before.streamHighWaters) {
    const next = afterStreams.get(entry.streamOrdinal);
    if (
      next === undefined
      || next < BigInt(entry.sequenceHighWater)
    ) {
      fail("high_water_regression");
    }
  }
}

export function seededDeterministicRestartFaultOrderV1():
readonly SharedStateRestartContinuityFaultPointV1[] {
  const order = [
    ...SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1,
  ];
  let state =
    SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.schedulerSeed >>> 0;
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (
      Math.imul(state, 1_664_525) + 1_013_904_223
    ) >>> 0;
    const other = state % (index + 1);
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  return Object.freeze(order);
}

const IDEMPOTENCY_REGISTRATION = (() => {
  const entry = sharedStateIdempotencyCatalogV1().entries.find(
    (candidate) => candidate.namespace === "broker.task.create",
  );
  if (
    entry === undefined
    || entry.retentionPolicyVersion !== "task-create-effects.v1"
    || entry.effectKind !== "domain-mutation-with-outbox"
  ) {
    return fail("registry_policy_mismatch");
  }
  return entry;
})();

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
    || entry.receiptPolicyVersion
      !== "terminal-notification-receipt.v1"
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
  | "broker.outbox.receipt-evidence"
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

const REPLAY_NAMESPACE = "security.replay.conformance";
const REPLAY_COMMAND = command("consumeReplayNonce", {
  namespace: REPLAY_NAMESPACE,
  keyDigest: digest(
    "security.replay.requester-key",
    REPLAY_NAMESPACE,
    [{ field: "requesterId", type: "utf8", value: "synthetic" }],
  ),
  nonceDigest: digest(
    "security.replay.nonce",
    REPLAY_NAMESPACE,
    [{ field: "nonce", type: "utf8", value: "synthetic" }],
  ),
  ttlMs:
    SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.boundaryDurationMs,
});

const RATE_NAMESPACE = "security.rate-limit.conformance";
const RATE_BUCKET_DIGEST = digest(
  "security.rate-limit.bucket-key",
  RATE_NAMESPACE,
  [
    { field: "principal", type: "utf8", value: "synthetic" },
    { field: "route", type: "utf8", value: "bounded" },
  ],
);
const RATE_INITIAL_COMMAND = command("reserveRateLimitCost", {
  namespace: RATE_NAMESPACE,
  bucketKeyDigest: RATE_BUCKET_DIGEST,
  cost: 4,
  limit: 5,
  windowMs:
    SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.boundaryDurationMs,
});
const RATE_NEXT_COMMAND = command("reserveRateLimitCost", {
  namespace: RATE_NAMESPACE,
  bucketKeyDigest: RATE_BUCKET_DIGEST,
  cost: 2,
  limit: 5,
  windowMs:
    SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.boundaryDurationMs,
});

const LEASE_NAMESPACE = "broker.lease.conformance";
const LEASE_RESOURCE_DIGEST = digest(
  "broker.lease.resource-key",
  LEASE_NAMESPACE,
  [
    { field: "resourceType", type: "utf8", value: "synthetic" },
    { field: "resourceId", type: "utf8", value: "continuity" },
  ],
);
const LEASE_OWNER_DIGEST = digest(
  "broker.lease.owner-key",
  LEASE_NAMESPACE,
  [{ field: "ownerId", type: "utf8", value: "synthetic" }],
);
const LEASE_CLAIM_COMMAND = command("claimLease", {
  namespace: LEASE_NAMESPACE,
  resourceKeyDigest: LEASE_RESOURCE_DIGEST,
  ownerKeyDigest: LEASE_OWNER_DIGEST,
  leaseDurationMs:
    SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.boundaryDurationMs,
  expectedResourceVersion: "0",
});
const LEASE_MUTATION_DIGEST = digest(
  "broker.lease.mutation",
  LEASE_NAMESPACE,
  [
    { field: "mutationKind", type: "utf8", value: "checkpoint" },
    { field: "mutationBody", type: "bytes", value: "1504" },
  ],
);

const IDEMPOTENCY_COMMAND = command("executeIdempotent", {
  namespace: IDEMPOTENCY_REGISTRATION.namespace,
  keyDigest: digest(
    "broker.idempotency.key",
    IDEMPOTENCY_REGISTRATION.namespace,
    [
      { field: "operationName", type: "utf8", value: "continuity" },
      { field: "clientKey", type: "utf8", value: "synthetic" },
    ],
  ),
  payloadFingerprint: digest(
    "broker.idempotency.payload-fingerprint",
    IDEMPOTENCY_REGISTRATION.namespace,
    [{ field: "payload", type: "bytes", value: "1504" }],
  ),
  retentionPolicyVersion:
    IDEMPOTENCY_REGISTRATION.retentionPolicyVersion,
  effect: {
    kind: IDEMPOTENCY_REGISTRATION.effectKind,
    domainMutationDigest: digest(
      "broker.idempotency.domain-mutation",
      IDEMPOTENCY_REGISTRATION.namespace,
      [
        { field: "mutationType", type: "utf8", value: "continuity" },
        { field: "mutationBody", type: "bytes", value: "2401" },
      ],
    ),
    outbox: {
      streamKeyDigest: digest(
        "broker.outbox.stream-key",
        IDEMPOTENCY_REGISTRATION.namespace,
        [
          { field: "streamType", type: "utf8", value: "synthetic" },
          { field: "streamId", type: "utf8", value: "continuity" },
        ],
      ),
      eventKeyDigest: digest(
        "broker.outbox.event-key",
        IDEMPOTENCY_REGISTRATION.namespace,
        [{ field: "eventId", type: "utf8", value: "continuity" }],
      ),
      payloadDigest: digest(
        "broker.outbox.payload",
        IDEMPOTENCY_REGISTRATION.namespace,
        [{ field: "payload", type: "bytes", value: "1504" }],
      ),
      retentionPolicyVersion: "caller-owned-outbox.v1",
    },
  },
});

interface GeneratedStream {
  readonly streamKey: {
    keyspaceVersion: typeof V.versions.keyspace;
    components: [
      {
        field: "streamType";
        type: "utf8";
        value: "broker-terminal-outbox";
      },
      {
        field: "streamId";
        type: "utf8";
        value: string;
      },
    ];
  };
  readonly streamKeyDigest: string;
}

function generatedStream(ordinal: 1 | 2): GeneratedStream {
  const streamKey: GeneratedStream["streamKey"] = {
    keyspaceVersion: V.versions.keyspace,
    components: [
      {
        field: "streamType",
        type: "utf8",
        value: "broker-terminal-outbox",
      },
      {
        field: "streamId",
        type: "utf8",
        value: ordinal === 1 ? "continuity-a" : "continuity-b",
      },
    ],
  };
  return {
    streamKey,
    streamKeyDigest: digest(
      "broker.outbox.stream-key",
      OUTBOX_REGISTRATION.namespace,
      streamKey.components,
    ),
  };
}

const STREAMS = Object.freeze([
  generatedStream(1),
  generatedStream(2),
] as const);

function appendCommand(
  stream: GeneratedStream,
  eventOrdinal: 1 | 2 | 3,
): CommandFor<"appendOutbox"> {
  const suffix = eventOrdinal.toString();
  const bytes = eventOrdinal.toString(16).padStart(2, "0");
  return command("appendOutbox", {
    namespace: OUTBOX_REGISTRATION.namespace,
    eventPurpose: OUTBOX_REGISTRATION.eventPurpose,
    streamKey: stream.streamKey,
    streamKeyDigest: stream.streamKeyDigest,
    orderingScope: OUTBOX_REGISTRATION.orderingScope,
    idempotencyKeyDigest: digest(
      "broker.outbox.idempotency-key",
      OUTBOX_REGISTRATION.namespace,
      [
        { field: "producerId", type: "utf8", value: "continuity" },
        { field: "clientKey", type: "utf8", value: suffix },
      ],
    ),
    eventKeyDigest: digest(
      "broker.outbox.event-key",
      OUTBOX_REGISTRATION.namespace,
      [{ field: "eventId", type: "utf8", value: suffix }],
    ),
    payloadDigest: digest(
      "broker.outbox.payload",
      OUTBOX_REGISTRATION.namespace,
      [{ field: "payload", type: "bytes", value: `${bytes}15` }],
    ),
    retentionPolicyVersion:
      OUTBOX_REGISTRATION.retentionPolicyVersion,
    receiptPolicyVersion: OUTBOX_REGISTRATION.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      OUTBOX_REGISTRATION.acknowledgmentPolicyVersion,
  });
}

const OUTBOX_COMMANDS = Object.freeze({
  firstAcknowledged: appendCommand(STREAMS[0], 1),
  replayableUnacknowledged: appendCommand(STREAMS[0], 2),
  secondAcknowledged: appendCommand(STREAMS[1], 3),
});

function receiptEvidenceDigest(eventOrdinal: number): string {
  const bytes = eventOrdinal.toString(16).padStart(2, "0");
  return digest(
    "broker.outbox.receipt-evidence",
    OUTBOX_REGISTRATION.namespace,
    [
      { field: "provider", type: "utf8", value: "conformance" },
      { field: "evidence", type: "bytes", value: `${bytes}01` },
    ],
  );
}

function receiptCommand(
  append: CommandFor<"appendOutbox">,
  eventOrdinal: number,
): CommandFor<"updateOutboxReceipt"> {
  return command("updateOutboxReceipt", {
    namespace: append.input.namespace,
    eventPurpose: append.input.eventPurpose,
    streamKey: append.input.streamKey,
    streamKeyDigest: append.input.streamKeyDigest,
    orderingScope: append.input.orderingScope,
    eventKeyDigest: append.input.eventKeyDigest,
    receiptEvidenceDigest: receiptEvidenceDigest(eventOrdinal),
    retentionPolicyVersion: append.input.retentionPolicyVersion,
    receiptPolicyVersion: append.input.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      append.input.acknowledgmentPolicyVersion,
    receiptEvidenceKind: "current-session-visible",
    expectedReceiptState: "pending",
    newReceiptState: "confirmed",
  });
}

function acknowledgeCommand(
  append: CommandFor<"appendOutbox">,
  eventOrdinal: number,
): CommandFor<"acknowledgeOutbox"> {
  return command("acknowledgeOutbox", {
    namespace: append.input.namespace,
    eventPurpose: append.input.eventPurpose,
    streamKey: append.input.streamKey,
    streamKeyDigest: append.input.streamKeyDigest,
    orderingScope: append.input.orderingScope,
    eventKeyDigest: append.input.eventKeyDigest,
    receiptEvidenceDigest: receiptEvidenceDigest(eventOrdinal),
    retentionPolicyVersion: append.input.retentionPolicyVersion,
    receiptPolicyVersion: append.input.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      append.input.acknowledgmentPolicyVersion,
    receiptEvidenceKind: "current-session-visible",
    expectedReceiptState: "confirmed",
    expectedAcknowledgmentState: "unacknowledged",
  });
}

const GRAPH_NAMESPACE = "broker.claim-graph.conformance";
const GRAPH_SOURCE_STREAM_DIGEST = digest(
  "broker.claim-graph.source-stream-key",
  GRAPH_NAMESPACE,
  [
    { field: "sourceType", type: "utf8", value: "synthetic" },
    { field: "sourceId", type: "utf8", value: "continuity" },
  ],
);

function graphSourceCommand(
  factOrdinal: 1 | 2,
): CommandFor<"appendGraphSource"> {
  return command("appendGraphSource", {
    namespace: GRAPH_NAMESPACE,
    sourceStreamKeyDigest: GRAPH_SOURCE_STREAM_DIGEST,
    sourceFactDigest: digest(
      "broker.claim-graph.source-fact",
      GRAPH_NAMESPACE,
      [
        {
          field: "nodeType",
          type: "utf8",
          value: factOrdinal === 1 ? "Claim" : "Source",
        },
        {
          field: "fact",
          type: "bytes",
          value: factOrdinal === 1 ? "1504" : "2401",
        },
      ],
    ),
    nodeType: factOrdinal === 1 ? "Claim" : "Source",
    expectedSourceSequence: factOrdinal === 1 ? "0" : "1",
  });
}

const GRAPH_SOURCE_COMMANDS = Object.freeze([
  graphSourceCommand(1),
  graphSourceCommand(2),
] as const);

function graphProjectionCommand(
  sourceSequenceThrough: 1 | 2,
): CommandFor<"applyGraphProjectionBatch"> {
  const suffix = sourceSequenceThrough.toString();
  return command("applyGraphProjectionBatch", {
    namespace: GRAPH_NAMESPACE,
    projectionVersion: "continuity-v1",
    batchKeyDigest: digest(
      "broker.claim-graph.projection-batch-key",
      GRAPH_NAMESPACE,
      [
        {
          field: "projectionVersion",
          type: "utf8",
          value: "continuity-v1",
        },
        { field: "batchId", type: "utf8", value: suffix },
      ],
    ),
    batchDigest: digest(
      "broker.claim-graph.projection-batch",
      GRAPH_NAMESPACE,
      [{ field: "batch", type: "bytes", value: `150${suffix}` }],
    ),
    inverseDigest: digest(
      "broker.claim-graph.projection-inverse",
      GRAPH_NAMESPACE,
      [{ field: "inverse", type: "bytes", value: `240${suffix}` }],
    ),
    sourceSequenceFrom: "1",
    sourceSequenceThrough: suffix,
    expectedCheckpointSequence: "0",
  });
}

const GRAPH_PROJECTION_TWO_COMMAND = graphProjectionCommand(2);
const GRAPH_PROJECTION_ONE_COMMAND = graphProjectionCommand(1);

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

function requireActiveBoundaries(
  time: SharedStateTimeEvaluationV1,
  expiresAt: bigint,
  eventAt: bigint,
): void {
  const expiry = evaluateSharedStateLogicalBoundaryV1(time, {
    timeVersion: TIME_V.version,
    kind: "replay-ttl",
    expiresAtUnixMs: expiresAt.toString(),
  });
  const lease = evaluateSharedStateLogicalBoundaryV1(time, {
    timeVersion: TIME_V.version,
    kind: "lease",
    expiresAtUnixMs: expiresAt.toString(),
  });
  const rate = evaluateSharedStateLogicalBoundaryV1(time, {
    timeVersion: TIME_V.version,
    kind: "rate-window-entry",
    eventAtUnixMs: eventAt.toString(),
    windowMs:
      SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .boundaryDurationMs
        .toString(),
  });
  if (
    !expiry.ok
    || expiry.value.decision !== "active"
    || !lease.ok
    || lease.value.decision !== "active"
    || !rate.ok
    || rate.value.decision !== "counted"
  ) {
    fail("time_evaluator_mismatch");
  }
}

async function createTarget(
  factory: SharedStateRestartContinuityConformanceTargetFactoryV1,
  clock: SharedStateRestartContinuityConformanceClockV1,
): Promise<SharedStateRestartContinuityConformanceTargetV1> {
  try {
    return await factory.create({ clock });
  } catch {
    return fail("target_create_failed");
  }
}

/**
 * Runs the bounded Phase 2.4 source-only slice. Successful output contains
 * only strict public-safe aggregate facts; target values and thrown messages
 * are never reflected.
 */
export async function runSharedStateRestartContinuityConformanceV1(
  factory: SharedStateRestartContinuityConformanceTargetFactoryV1,
): Promise<SharedStateRestartContinuityConformanceReportV1> {
  const clock = new InjectedRestartContinuityConformanceFakeClockV1();
  let targetCount = 0;
  let targetCommandCount = 0;
  let lifecycleCount = 0;
  let snapshotControlCount = 0;
  let faultControlCount = 0;
  let cursorControlCount = 0;
  let clockControlCount = 0;

  async function lifecycle(
    action: () => Promise<unknown>,
  ): Promise<SharedStateStorageLifecycleV1> {
    lifecycleCount += 1;
    if (
      lifecycleCount
      > SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.lifecycleLimit
    ) {
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
  Promise<SharedStateRestartContinuityConformanceTargetV1> {
    targetCount += 1;
    if (
      targetCount
      > SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.targetCount
    ) {
      return fail("operation_limit_exceeded");
    }
    const target = await createTarget(factory, clock);
    requireReady(await lifecycle(() => target.open()));
    return target;
  }

  async function closeTarget(
    target: SharedStateRestartContinuityConformanceTargetV1,
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
    target: SharedStateRestartContinuityConformanceTargetV1,
    generatedCommand: CommandFor<Selected>,
  ): Promise<ResultFor<Selected>> {
    targetCommandCount += 1;
    if (
      targetCommandCount
      > SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .targetCommandLimit
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
    if (
      !parsed.ok
      || parsed.value.operation !== generatedCommand.operation
    ) {
      return fail("invalid_target_result");
    }
    return parsed.value as ResultFor<Selected>;
  }

  async function snapshot(
    target: SharedStateRestartContinuityConformanceTargetV1,
  ): Promise<SharedStateRestartContinuityConformanceSnapshotV1> {
    snapshotControlCount += 1;
    if (
      snapshotControlCount
      > SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .snapshotControlLimit
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
      sharedStateRestartContinuityConformanceSnapshotV1Schema
        .safeParse(raw);
    if (!parsed.success) return fail("invalid_conformance_snapshot");
    return deepFreeze(parsed.data);
  }

  function armFault(
    target: SharedStateRestartContinuityConformanceTargetV1,
    faultPoint: SharedStateRestartContinuityFaultPointV1,
  ): void {
    faultControlCount += 1;
    if (
      faultControlCount
      > SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.faultControlCount
    ) {
      fail("operation_limit_exceeded");
    }
    try {
      target.armConformanceCrashFault(faultPoint);
    } catch {
      fail("target_fault_control_failed");
    }
  }

  async function captureCursor(
    target: SharedStateRestartContinuityConformanceTargetV1,
  ): Promise<SharedStateRestartContinuityConformanceCursorV1> {
    cursorControlCount += 1;
    let raw: unknown;
    try {
      raw = await target.captureConformanceCursor();
    } catch {
      return fail("target_cursor_control_failed");
    }
    const parsed =
      sharedStateRestartContinuityConformanceCursorV1Schema.safeParse(raw);
    if (!parsed.success) return fail("invalid_conformance_cursor");
    return deepFreeze(parsed.data);
  }

  async function reconcile(
    target: SharedStateRestartContinuityConformanceTargetV1,
    cursor: SharedStateRestartContinuityConformanceCursorV1,
  ): Promise<
    SharedStateRestartContinuityConformanceReconcileResponseV1
  > {
    cursorControlCount += 1;
    let raw: unknown;
    try {
      raw = await target.reconcileForConformance(cursor);
    } catch {
      return fail("target_reconcile_control_failed");
    }
    const parsed =
      sharedStateRestartContinuityConformanceReconcileResponseV1Schema
        .safeParse(raw);
    if (!parsed.success) {
      return fail("invalid_conformance_reconcile_response");
    }
    return deepFreeze(parsed.data);
  }

  function advanceClockExactlyBy(milliseconds: number): void {
    clockControlCount += 1;
    try {
      clock.advanceExactlyBy(milliseconds);
    } catch {
      fail("clock_control_failed");
    }
  }

  function observeClockExactlyAt(instant: bigint): void {
    clockControlCount += 1;
    try {
      clock.observeExactlyAt(instant);
    } catch {
      fail("clock_control_failed");
    }
  }

  // Scenario A: one complete state set survives close/reopen before every
  // declared TTL/window/lease boundary.
  const baselineTarget = await openedTarget();
  const baselineInstant = clock.readObservedUnixMilliseconds();

  const replayAccepted = await transact(baselineTarget, REPLAY_COMMAND);
  if (
    replayAccepted.status !== "committed"
    || replayAccepted.result.decision !== "accepted"
  ) {
    fail("continuity_baseline_mismatch");
  }
  const rateAccepted = await transact(
    baselineTarget,
    RATE_INITIAL_COMMAND,
  );
  if (
    rateAccepted.status !== "committed"
    || rateAccepted.result.decision !== "accepted"
  ) {
    fail("continuity_baseline_mismatch");
  }
  const leaseClaimed = await transact(
    baselineTarget,
    LEASE_CLAIM_COMMAND,
  );
  if (
    leaseClaimed.status !== "committed"
    || leaseClaimed.result.decision !== "claimed"
  ) {
    fail("continuity_baseline_mismatch");
  }
  const idempotencyExecuted = await transact(
    baselineTarget,
    IDEMPOTENCY_COMMAND,
  );
  if (
    idempotencyExecuted.status !== "committed"
    || idempotencyExecuted.result.decision !== "executed"
  ) {
    fail("continuity_baseline_mismatch");
  }

  const firstAppend = await transact(
    baselineTarget,
    OUTBOX_COMMANDS.firstAcknowledged,
  );
  const firstReceipt = await transact(
    baselineTarget,
    receiptCommand(OUTBOX_COMMANDS.firstAcknowledged, 1),
  );
  const firstAck = await transact(
    baselineTarget,
    acknowledgeCommand(OUTBOX_COMMANDS.firstAcknowledged, 1),
  );
  const secondStreamAppend = await transact(
    baselineTarget,
    OUTBOX_COMMANDS.secondAcknowledged,
  );
  const secondStreamReceipt = await transact(
    baselineTarget,
    receiptCommand(OUTBOX_COMMANDS.secondAcknowledged, 3),
  );
  const secondStreamAck = await transact(
    baselineTarget,
    acknowledgeCommand(OUTBOX_COMMANDS.secondAcknowledged, 3),
  );
  if (
    firstAppend.status !== "committed"
    || firstAppend.result.decision !== "appended"
    || firstAppend.result.streamSequence !== "1"
    || firstReceipt.status !== "committed"
    || firstReceipt.result.receiptState !== "confirmed"
    || firstAck.status !== "committed"
    || firstAck.result.decision !== "acknowledged"
    || secondStreamAppend.status !== "committed"
    || secondStreamAppend.result.decision !== "appended"
    || secondStreamAppend.result.streamSequence !== "1"
    || secondStreamReceipt.status !== "committed"
    || secondStreamReceipt.result.receiptState !== "confirmed"
    || secondStreamAck.status !== "committed"
    || secondStreamAck.result.decision !== "acknowledged"
  ) {
    fail("continuity_baseline_mismatch");
  }
  const continuityCursor = await captureCursor(baselineTarget);
  if (
    continuityCursor.positions.length !== 2
    || continuityCursor.positions.some((position) => (
      position.afterSequence !== "1"
      || position.acknowledgedThroughSequence !== "1"
    ))
  ) {
    fail("outbox_continuity_mismatch");
  }
  const replayableAppend = await transact(
    baselineTarget,
    OUTBOX_COMMANDS.replayableUnacknowledged,
  );
  if (
    replayableAppend.status !== "committed"
    || replayableAppend.result.decision !== "appended"
    || replayableAppend.result.streamSequence !== "2"
  ) {
    fail("continuity_baseline_mismatch");
  }

  const graphSourceResults = [];
  for (const sourceCommand of GRAPH_SOURCE_COMMANDS) {
    graphSourceResults.push(
      await transact(baselineTarget, sourceCommand),
    );
  }
  if (
    graphSourceResults.some((result, index) => (
      result.status !== "committed"
      || result.result.decision !== "appended"
      || result.result.sourceSequence !== (index + 1).toString()
    ))
  ) {
    fail("continuity_baseline_mismatch");
  }
  const graphProjection = await transact(
    baselineTarget,
    GRAPH_PROJECTION_TWO_COMMAND,
  );
  if (
    graphProjection.status !== "committed"
    || graphProjection.result.decision !== "applied"
    || graphProjection.result.checkpointSequence !== "2"
  ) {
    fail("continuity_baseline_mismatch");
  }

  const beforeClose = await snapshot(baselineTarget);
  if (
    beforeClose.replayRecordCount !== 1
    || beforeClose.rateWindowEntryCount !== 1
    || beforeClose.accumulatedRateCost !== 4
    || beforeClose.activeLeaseCount !== 1
    || beforeClose.maximumFencingToken
      !== leaseClaimed.result.fencingToken
    || beforeClose.idempotencyOutcomeCount !== 1
    || beforeClose.domainEffectCount !== 1
    || beforeClose.idempotentOutboxEffectCount !== 1
    || beforeClose.outboxEventCount !== 3
    || beforeClose.receiptPendingCount !== 1
    || beforeClose.receiptConfirmedCount !== 2
    || beforeClose.unacknowledgedCount !== 1
    || beforeClose.acknowledgedCount !== 2
    || beforeClose.graphSourceFactCount !== 2
    || beforeClose.graphSourceSequenceHighWater !== "2"
    || beforeClose.graphProjectionBatchCount !== 1
    || beforeClose.graphProjectionCheckpointHighWater !== "2"
  ) {
    fail("continuity_baseline_mismatch");
  }

  await closeTarget(baselineTarget);
  advanceClockExactlyBy(
    SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.reopenAdvanceMs,
  );
  const reopenedInstant = clock.readObservedUnixMilliseconds();
  const harnessTime = evaluateHarnessTime(reopenedInstant, baselineInstant);
  if (
    !harnessTime.safe
    || harnessTime.readiness !== "ready"
    || harnessTime.writes !== "allowed"
    || harnessTime.logicalDecisions !== "allowed"
  ) {
    fail("time_evaluator_mismatch");
  }
  requireActiveBoundaries(
    harnessTime,
    baselineInstant
      + BigInt(
        SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
          .boundaryDurationMs,
      ),
    baselineInstant,
  );
  requireReady(await lifecycle(() => baselineTarget.open()));
  const afterReopen = await snapshot(baselineTarget);
  if (!sameSnapshot(beforeClose, afterReopen)) {
    fail("continuity_baseline_mismatch");
  }
  requireNoHighWaterRegression(beforeClose, afterReopen);

  const replayedNonce = await transact(baselineTarget, REPLAY_COMMAND);
  if (
    replayedNonce.status !== "committed"
    || replayedNonce.result.decision !== "replay"
    || replayedNonce.result.expiresInMs
      !== SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .boundaryDurationMs
        - SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.reopenAdvanceMs
  ) {
    fail("replay_continuity_mismatch");
  }
  const rateLimited = await transact(
    baselineTarget,
    RATE_NEXT_COMMAND,
  );
  if (
    rateLimited.status !== "committed"
    || rateLimited.result.decision !== "rate_limited"
    || rateLimited.result.resetInMs
      !== SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .boundaryDurationMs
        - SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.reopenAdvanceMs
  ) {
    fail("rate_continuity_mismatch");
  }

  const renew = command("renewLease", {
    namespace: LEASE_CLAIM_COMMAND.input.namespace,
    resourceKeyDigest: LEASE_CLAIM_COMMAND.input.resourceKeyDigest,
    ownerKeyDigest: LEASE_CLAIM_COMMAND.input.ownerKeyDigest,
    attemptKeyDigest: leaseClaimed.result.attemptKeyDigest,
    fencingToken: leaseClaimed.result.fencingToken,
    expectedResourceVersion: leaseClaimed.result.resourceVersion,
    leaseDurationMs:
      SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.boundaryDurationMs,
  });
  const renewed = await transact(baselineTarget, renew);
  if (
    renewed.status !== "committed"
    || renewed.result.decision !== "renewed"
  ) {
    fail("lease_continuity_mismatch");
  }
  const mutate = command("mutateWithFence", {
    namespace: LEASE_CLAIM_COMMAND.input.namespace,
    resourceKeyDigest: LEASE_CLAIM_COMMAND.input.resourceKeyDigest,
    ownerKeyDigest: LEASE_CLAIM_COMMAND.input.ownerKeyDigest,
    attemptKeyDigest: leaseClaimed.result.attemptKeyDigest,
    fencingToken: leaseClaimed.result.fencingToken,
    expectedResourceVersion: renewed.result.resourceVersion,
    mutationKind: "checkpoint",
    mutationDigest: LEASE_MUTATION_DIGEST,
  });
  const mutated = await transact(baselineTarget, mutate);
  if (
    mutated.status !== "committed"
    || mutated.result.decision !== "applied"
  ) {
    fail("lease_continuity_mismatch");
  }
  const idempotencyReplayed = await transact(
    baselineTarget,
    IDEMPOTENCY_COMMAND,
  );
  if (
    idempotencyReplayed.status !== "committed"
    || idempotencyReplayed.result.decision !== "replayed"
    || idempotencyReplayed.result.outcomeDigest
      !== idempotencyExecuted.result.outcomeDigest
  ) {
    fail("idempotency_continuity_mismatch");
  }

  const appendRetryPairs = [
    [OUTBOX_COMMANDS.firstAcknowledged, firstAppend],
    [OUTBOX_COMMANDS.replayableUnacknowledged, replayableAppend],
    [OUTBOX_COMMANDS.secondAcknowledged, secondStreamAppend],
  ] as const;
  for (const [append, original] of appendRetryPairs) {
    const retry = await transact(baselineTarget, append);
    if (
      original.status !== "committed"
      || retry.status !== "committed"
      || retry.result.decision !== "replayed"
      || retry.result.eventKeyDigest
        !== original.result.eventKeyDigest
      || retry.result.streamSequence
        !== original.result.streamSequence
    ) {
      fail("outbox_continuity_mismatch");
    }
  }
  const reconciled = await reconcile(
    baselineTarget,
    continuityCursor,
  );
  if (
    reconciled.events.length !== 1
    || reconciled.events[0]?.eventRank !== 1
    || reconciled.events[0]?.streamSequence !== "2"
    || reconciled.events[0]?.receiptState !== "pending"
    || reconciled.events[0]?.acknowledgmentState !== "unacknowledged"
  ) {
    fail("outbox_continuity_mismatch");
  }

  for (let index = 0; index < GRAPH_SOURCE_COMMANDS.length; index += 1) {
    const retry = await transact(
      baselineTarget,
      GRAPH_SOURCE_COMMANDS[index]!,
    );
    if (
      retry.status !== "committed"
      || retry.result.decision !== "replayed"
      || retry.result.sourceSequence !== (index + 1).toString()
    ) {
      fail("graph_continuity_mismatch");
    }
  }
  const projectionRetry = await transact(
    baselineTarget,
    GRAPH_PROJECTION_TWO_COMMAND,
  );
  if (
    projectionRetry.status !== "committed"
    || projectionRetry.result.decision !== "replayed"
    || projectionRetry.result.checkpointSequence !== "2"
  ) {
    fail("graph_continuity_mismatch");
  }
  const baselineFinal = await snapshot(baselineTarget);
  if (
    baselineFinal.maximumFencingToken
      !== leaseClaimed.result.fencingToken
    || baselineFinal.domainEffectCount !== 1
    || baselineFinal.idempotentOutboxEffectCount !== 1
    || baselineFinal.outboxEventCount !== 3
    || baselineFinal.receiptPendingCount !== 1
    || baselineFinal.receiptConfirmedCount !== 2
    || baselineFinal.unacknowledgedCount !== 1
    || baselineFinal.acknowledgedCount !== 2
    || baselineFinal.graphSourceFactCount !== 2
    || baselineFinal.graphProjectionBatchCount !== 1
  ) {
    fail("continuity_baseline_mismatch");
  }
  requireNoHighWaterRegression(afterReopen, baselineFinal);
  await closeTarget(baselineTarget);

  // Scenario B: each exact crash point uses a new isolated target. The
  // seeded order is deterministic; there is no concurrency and no barrier.
  const crashReports: Array<
    z.infer<typeof crashRecoveryReportSchema>
  > = [];
  const faultOrder = seededDeterministicRestartFaultOrderV1();
  for (
    let scheduleIndex = 0;
    scheduleIndex < faultOrder.length;
    scheduleIndex += 1
  ) {
    const faultPoint = faultOrder[scheduleIndex]!;
    const target = await openedTarget();
    let failed: SharedStateTransactionResultV1;
    let baseline: SharedStateRestartContinuityConformanceSnapshotV1;
    let expectedCommitted:
      SharedStateRestartContinuityConformanceSnapshotV1;
    let recoveredState:
      | "exact-empty-baseline"
      | "committed-single-effect"
      | "confirmed-unacknowledged"
      | "confirmed-acknowledged";
    let retryDecision:
      | "executed"
      | "replayed"
      | "acknowledged"
      | "already_acknowledged";

    if (
      faultPoint === "before-command-commit"
      || faultPoint === "after-command-commit-before-response"
    ) {
      baseline = await snapshot(target);
      if (
        !sameSnapshot(
          baseline,
          EMPTY_CRASH_BASELINE_SNAPSHOT_V1,
        )
      ) {
        fail("crash_recovery_mismatch");
      }
      expectedCommitted = deriveExactSnapshotWithAtomicDelta(
        baseline,
        COMMAND_COMMIT_SNAPSHOT_DELTA_V1,
      );
      armFault(target, faultPoint);
      failed = await transact(target, IDEMPOTENCY_COMMAND);
    } else {
      const append = await transact(
        target,
        OUTBOX_COMMANDS.firstAcknowledged,
      );
      const receipt = await transact(
        target,
        receiptCommand(OUTBOX_COMMANDS.firstAcknowledged, 1),
      );
      if (
        append.status !== "committed"
        || append.result.decision !== "appended"
        || receipt.status !== "committed"
        || receipt.result.receiptState !== "confirmed"
      ) {
        fail("crash_recovery_mismatch");
      }
      baseline = await snapshot(target);
      if (
        !sameSnapshot(
          baseline,
          CONFIRMED_UNACKNOWLEDGED_CRASH_BASELINE_SNAPSHOT_V1,
        )
      ) {
        fail("crash_recovery_mismatch");
      }
      expectedCommitted = deriveExactSnapshotWithAtomicDelta(
        baseline,
        ACK_COMMIT_SNAPSHOT_DELTA_V1,
      );
      armFault(target, faultPoint);
      failed = await transact(
        target,
        acknowledgeCommand(OUTBOX_COMMANDS.firstAcknowledged, 1),
      );
    }

    const expectedReason = faultPoint.startsWith("before-")
      ? "authority_unavailable"
      : "ambiguous_commit";
    if (
      failed.status !== "unavailable"
      || failed.reasonCode !== expectedReason
    ) {
      fail("crash_recovery_mismatch");
    }

    requireReady(await lifecycle(() => target.open()));
    const recovered = await snapshot(target);
    requireNoHighWaterRegression(baseline, recovered);
    const expectedRecovered = faultPoint.startsWith("before-")
      ? baseline
      : expectedCommitted;
    if (!sameSnapshot(recovered, expectedRecovered)) {
      fail("crash_recovery_mismatch");
    }

    if (faultPoint === "before-command-commit") {
      const retry = await transact(target, IDEMPOTENCY_COMMAND);
      if (
        retry.status !== "committed"
        || retry.result.decision !== "executed"
      ) {
        fail("crash_recovery_mismatch");
      }
      recoveredState = "exact-empty-baseline";
      retryDecision = "executed";
    } else if (
      faultPoint === "after-command-commit-before-response"
    ) {
      const retry = await transact(target, IDEMPOTENCY_COMMAND);
      if (
        retry.status !== "committed"
        || retry.result.decision !== "replayed"
      ) {
        fail("crash_recovery_mismatch");
      }
      recoveredState = "committed-single-effect";
      retryDecision = "replayed";
    } else if (faultPoint === "before-ack-commit") {
      const retry = await transact(
        target,
        acknowledgeCommand(OUTBOX_COMMANDS.firstAcknowledged, 1),
      );
      if (
        retry.status !== "committed"
        || retry.result.decision !== "acknowledged"
      ) {
        fail("crash_recovery_mismatch");
      }
      recoveredState = "confirmed-unacknowledged";
      retryDecision = "acknowledged";
    } else {
      const retry = await transact(
        target,
        acknowledgeCommand(OUTBOX_COMMANDS.firstAcknowledged, 1),
      );
      if (
        retry.status !== "committed"
        || retry.result.decision !== "already_acknowledged"
      ) {
        fail("crash_recovery_mismatch");
      }
      recoveredState = "confirmed-acknowledged";
      retryDecision = "already_acknowledged";
    }
    const final = await snapshot(target);
    requireNoHighWaterRegression(recovered, final);
    if (!sameSnapshot(final, expectedCommitted)) {
      fail("crash_recovery_mismatch");
    }
    await closeTarget(target);
    crashReports.push({
      faultPoint,
      scheduleRank: scheduleIndex + 1,
      firstStatus: "unavailable",
      firstReasonCode: expectedReason,
      reopenedLifecycleState: "ready",
      recoveredState,
      retryDecision,
      duplicateEffectCount: 0,
      highWaters: highWaters(final),
    });
  }

  // Scenario C: a fully prepared isolated target persists its model floor,
  // then fails closed exactly one millisecond beyond tolerance.
  const backwardTarget = await openedTarget();
  const backwardFloor = clock.readObservedUnixMilliseconds();
  const backwardReplay = await transact(backwardTarget, REPLAY_COMMAND);
  const backwardRate = await transact(
    backwardTarget,
    RATE_INITIAL_COMMAND,
  );
  const backwardLease = await transact(
    backwardTarget,
    LEASE_CLAIM_COMMAND,
  );
  const backwardIdempotency = await transact(
    backwardTarget,
    IDEMPOTENCY_COMMAND,
  );
  const backwardOutbox = await transact(
    backwardTarget,
    OUTBOX_COMMANDS.firstAcknowledged,
  );
  const backwardGraph = await transact(
    backwardTarget,
    GRAPH_SOURCE_COMMANDS[0],
  );
  const backwardProjection = await transact(
    backwardTarget,
    GRAPH_PROJECTION_ONE_COMMAND,
  );
  if (
    backwardReplay.status !== "committed"
    || backwardReplay.result.decision !== "accepted"
    || backwardRate.status !== "committed"
    || backwardRate.result.decision !== "accepted"
    || backwardLease.status !== "committed"
    || backwardLease.result.decision !== "claimed"
    || backwardIdempotency.status !== "committed"
    || backwardIdempotency.result.decision !== "executed"
    || backwardOutbox.status !== "committed"
    || backwardOutbox.result.decision !== "appended"
    || backwardGraph.status !== "committed"
    || backwardGraph.result.decision !== "appended"
    || backwardProjection.status !== "committed"
    || backwardProjection.result.decision !== "applied"
  ) {
    fail("backward_clock_mismatch");
  }
  const backwardPrepared = await snapshot(backwardTarget);
  await closeTarget(backwardTarget);

  const unsafeObservation =
    backwardFloor
    - BigInt(
      SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .backwardSkewToleranceMs
      + 1,
    );
  observeClockExactlyAt(unsafeObservation);
  const unsafeEvaluation = evaluateHarnessTime(
    unsafeObservation,
    backwardFloor,
  );
  if (
    unsafeEvaluation.safe
    || unsafeEvaluation.reasonCode !== "backward_beyond_tolerance"
    || unsafeEvaluation.readiness !== "not-ready"
    || unsafeEvaluation.writes !== "forbidden"
    || unsafeEvaluation.logicalDecisions !== "forbidden"
  ) {
    fail("backward_clock_mismatch");
  }
  const unsafeLifecycle = await lifecycle(() => backwardTarget.open());
  if (
    unsafeLifecycle.state !== "failed"
    || unsafeLifecycle.reasonCodes.length !== 1
    || unsafeLifecycle.reasonCodes[0] !== "unsafe_clock"
  ) {
    fail("backward_clock_mismatch");
  }
  const afterUnsafeOpen = await snapshot(backwardTarget);
  if (!sameSnapshot(backwardPrepared, afterUnsafeOpen)) {
    fail("backward_clock_mismatch");
  }
  requireNoHighWaterRegression(backwardPrepared, afterUnsafeOpen);
  const forbiddenWrite = await transact(backwardTarget, REPLAY_COMMAND);
  if (
    forbiddenWrite.status !== "unavailable"
    || forbiddenWrite.reasonCode !== "unsafe_clock"
  ) {
    fail("backward_clock_mismatch");
  }
  const afterForbiddenWrite = await snapshot(backwardTarget);
  if (!sameSnapshot(backwardPrepared, afterForbiddenWrite)) {
    fail("backward_clock_mismatch");
  }
  requireNoHighWaterRegression(afterUnsafeOpen, afterForbiddenWrite);

  observeClockExactlyAt(backwardFloor);
  requireReady(await lifecycle(() => backwardTarget.open()));
  const afterClockRestore = await snapshot(backwardTarget);
  if (!sameSnapshot(backwardPrepared, afterClockRestore)) {
    fail("backward_clock_mismatch");
  }
  requireNoHighWaterRegression(afterForbiddenWrite, afterClockRestore);
  await closeTarget(backwardTarget);

  if (
    targetCount
      !== SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.targetCount
    || targetCommandCount
      !== SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .expectedTargetCommandCount
    || lifecycleCount
      !== SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .expectedLifecycleCount
    || snapshotControlCount
      !== SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .expectedSnapshotControlCount
    || faultControlCount
      !== SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .faultControlCount
    || cursorControlCount
      !== SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .cursorControlCount
    || clockControlCount
      !== SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
        .clockControlCount
  ) {
    fail("operation_limit_exceeded");
  }

  const report = {
    kind: SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.kind,
    harnessVersion:
      SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.harnessVersion,
    contractVersion: V.versions.contract,
    timeVersion: TIME_V.version,
    scope: SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.scope,
    status: "passed",
    controls: {
      scheduler: "seeded-deterministic-serial",
      schedulerSeed:
        SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.schedulerSeed,
      concurrency: "not-exercised",
      barrier: "not-required",
      clock: "single-injected-fake-exact-integer",
      targetIsolation: "factory-created-per-scenario",
      targetCount,
      targetCommandLimit:
        SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
          .targetCommandLimit,
      targetCommandCount,
      lifecycleLimit:
        SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.lifecycleLimit,
      lifecycleCount,
      snapshotControlLimit:
        SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
          .snapshotControlLimit,
      snapshotControlCount,
      faultControlCount,
      cursorControlCount,
      clockControlCount,
    },
    continuityBaseline: {
      reopenLifecycleState: "ready",
      boundaryState: "before-all-declared-boundaries",
      replayDecision: "replay",
      rateDecision: "rate_limited",
      leaseRenewDecision: "renewed",
      leaseMutationDecision: "applied",
      leaseFenceState: "original-preserved",
      idempotencyDecision: "replayed",
      idempotencyOutcomeState: "original-preserved",
      duplicateEffectCount: 0,
      appendRetryCount: 3,
      appendRetryState: "original-bindings-preserved",
      retainedEventCount: 3,
      acknowledgedEventCount: 2,
      replayedUnacknowledgedEventCount: 1,
      reconciliationReceiptState: "pending",
      reconciliationAcknowledgmentState: "unacknowledged",
      graphSourceRetryCount: 2,
      graphSourceRetryState: "original-sequences-preserved",
      graphProjectionRetryDecision: "replayed",
      graphProjectionCheckpointState: "original-preserved",
      highWaters: highWaters(baselineFinal),
    },
    crashRecovery: {
      state: "passed",
      cases: crashReports,
    },
    backwardClock: {
      evaluatorReasonCode: "backward_beyond_tolerance",
      readiness: "not-ready",
      writes: "forbidden",
      logicalDecisions: "forbidden",
      lifecycleState: "failed",
      lifecycleReasonCode: "unsafe_clock",
      attemptedWriteStatus: "unavailable",
      attemptedWriteReasonCode: "unsafe_clock",
      unsafeSnapshotState: "unchanged",
      restoredLifecycleState: "ready",
      restoredSnapshotState: "unchanged",
      highWaters: highWaters(afterClockRestore),
    },
    monotonicity: {
      fencingToken: "nondecreasing",
      everyRetainedStreamSequenceHighWater: "nondecreasing",
      graphSourceSequence: "nondecreasing",
      graphProjectionCheckpoint: "nondecreasing",
    },
    claims: {
      referenceModel: "test-only",
      closeReopenStateRetention: "test-control-not-durability-claim",
      adapterConformance: "not-claimed",
      runtimeIntegration: "none",
      storageQueryContract: "none",
      retentionPruneExecution: "not-executed",
    },
  } as const;
  const parsed =
    sharedStateRestartContinuityConformanceReportV1Schema.safeParse(
      report,
    );
  if (!parsed.success) return fail("report_invalid");
  return deepFreeze(parsed.data);
}
