/**
 * Backend-neutral deterministic `executeIdempotent` conformance harness for
 * `a2a.shared-state.storage/v1`.
 *
 * The harness consumes the existing closed command/result envelopes, the
 * registered idempotency policy, and the V1 digest keyspace. It does not
 * implement storage, select a backend, execute retention, or attach to broker
 * runtime. Targets expose only bounded test controls for an injected clock,
 * transaction fault points, lifecycle continuity, and a public-safe snapshot.
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
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";

export const SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1 = Object.freeze({
  kind: "SharedStateIdempotencyConformanceReportV1",
  harnessVersion: 1,
  scope: "execute-idempotent",
  sameFingerprintContenderCount: 64,
  conflictContenderCount: 2,
  schedulerSeed: 1504,
  reopenClockAdvanceMs: 64,
  targetCount: 8,
  operationLimit: 96,
  expectedOperationCount: 78,
} as const);

export const SHARED_STATE_IDEMPOTENCY_TRANSACTION_FAULT_POINTS_V1 =
  Object.freeze([
    "after_reservation",
    "after_domain_mutation",
    "after_outbox_staging",
    "after_outcome_staging",
  ] as const);

export const SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1 = Object.freeze([
  ...SHARED_STATE_IDEMPOTENCY_TRANSACTION_FAULT_POINTS_V1,
  "after_commit_before_response",
] as const);

export const SHARED_STATE_IDEMPOTENCY_CONFORMANCE_ERROR_CODES_V1 =
  Object.freeze([
    "invalid_generated_command",
    "invalid_target_result",
    "invalid_target_lifecycle",
    "invalid_target_snapshot",
    "target_create_failed",
    "target_operation_failed",
    "target_lifecycle_failed",
    "target_snapshot_failed",
    "target_fault_control_failed",
    "barrier_not_ready",
    "operation_limit_exceeded",
    "same_fingerprint_outcome_mismatch",
    "idempotency_conflict_mismatch",
    "effect_snapshot_mismatch",
    "ambiguous_commit_mismatch",
    "transaction_not_atomic",
    "reopen_snapshot_mismatch",
    "retention_policy_mismatch",
    "report_invalid",
    "reference_model_invariant",
  ] as const);

export type SharedStateIdempotencyTransactionFaultPointV1 =
  (typeof SHARED_STATE_IDEMPOTENCY_TRANSACTION_FAULT_POINTS_V1)[number];
export type SharedStateIdempotencyFaultPointV1 =
  (typeof SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1)[number];
export type SharedStateIdempotencyConformanceErrorCodeV1 =
  (typeof SHARED_STATE_IDEMPOTENCY_CONFORMANCE_ERROR_CODES_V1)[number];
export type SharedStateExecuteIdempotentCommandV1 = Extract<
  SharedStateTransactionCommandV1,
  { readonly operation: "executeIdempotent" }
>;
export type SharedStateExecuteIdempotentResultV1 = Extract<
  SharedStateTransactionResultV1,
  { readonly operation: "executeIdempotent" }
>;

export const sharedStateIdempotencyConformanceErrorReportV1Schema = z
  .object({
    kind: z.literal("SharedStateIdempotencyConformanceErrorV1"),
    errorVersion: z.literal(1),
    code: z.enum(SHARED_STATE_IDEMPOTENCY_CONFORMANCE_ERROR_CODES_V1),
  })
  .strict();

export type SharedStateIdempotencyConformanceErrorReportV1 = Readonly<
  z.infer<typeof sharedStateIdempotencyConformanceErrorReportV1Schema>
>;

export class SharedStateIdempotencyConformanceErrorV1 extends Error {
  readonly code: SharedStateIdempotencyConformanceErrorCodeV1;
  readonly publicReport: SharedStateIdempotencyConformanceErrorReportV1;

  constructor(code: SharedStateIdempotencyConformanceErrorCodeV1) {
    super(code);
    this.name = "SharedStateIdempotencyConformanceErrorV1";
    this.code = code;
    this.publicReport = Object.freeze({
      kind: "SharedStateIdempotencyConformanceErrorV1",
      errorVersion: 1,
      code,
    });
    this.stack = `${this.name}: ${code}`;
  }

  toJSON(): SharedStateIdempotencyConformanceErrorReportV1 {
    return this.publicReport;
  }
}

function fail(
  code: SharedStateIdempotencyConformanceErrorCodeV1,
): never {
  throw new SharedStateIdempotencyConformanceErrorV1(code);
}

const boundedCountSchema = z.number().int().nonnegative().max(
  SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.operationLimit,
);

export const sharedStateIdempotencyConformanceSnapshotV1Schema = z
  .object({
    kind: z.literal("SharedStateIdempotencyConformanceSnapshotV1"),
    snapshotVersion: z.literal(1),
    reservationCount: boundedCountSchema,
    pendingReservationCount: boundedCountSchema,
    domainMutationCount: boundedCountSchema,
    outboxAppendCount: boundedCountSchema,
    stableOutcomeCount: boundedCountSchema,
  })
  .strict();

export type SharedStateIdempotencyConformanceSnapshotV1 = Readonly<
  z.infer<typeof sharedStateIdempotencyConformanceSnapshotV1Schema>
>;

const singleEffectReportSchema = z
  .object({
    reservationCount: z.literal(1),
    pendingReservationCount: z.literal(0),
    domainMutationCount: z.literal(1),
    outboxAppendCount: z.literal(1),
    stableOutcomeCount: z.literal(1),
  })
  .strict();

export const sharedStateIdempotencyTransactionFaultReportV1Schema = z
  .object({
    faultPoint: z.enum(
      SHARED_STATE_IDEMPOTENCY_TRANSACTION_FAULT_POINTS_V1,
    ),
    failedStatus: z.literal("unavailable"),
    failedReasonCode: z.literal("authority_unavailable"),
    rollback: z.literal("exact-empty-baseline"),
    pendingReservationCount: z.literal(0),
    nextCleanDecision: z.literal("executed"),
  })
  .strict();

export type SharedStateIdempotencyTransactionFaultReportV1 = Readonly<
  z.infer<typeof sharedStateIdempotencyTransactionFaultReportV1Schema>
>;

export const sharedStateIdempotencyConformanceReportV1Schema = z
  .object({
    kind: z.literal(SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.kind),
    harnessVersion: z.literal(
      SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.harnessVersion,
    ),
    contractVersion: z.literal(V.versions.contract),
    scope: z.literal(SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.scope),
    status: z.literal("passed"),
    scheduler: z
      .object({
        kind: z.literal("seeded-deterministic"),
        seed: z.literal(
          SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.schedulerSeed,
        ),
        barrier: z.literal("explicit-promise"),
        targetIsolation: z.literal("factory-created-per-scenario"),
        targetCount: z.literal(
          SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.targetCount,
        ),
        operationLimit: z.literal(
          SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.operationLimit,
        ),
        operationCount: z.literal(
          SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.expectedOperationCount,
        ),
      })
      .strict(),
    sameFingerprintRace: z
      .object({
        contenderCount: z.literal(
          SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1
            .sameFingerprintContenderCount,
        ),
        executedResults: z.literal(1),
        replayedResults: z.literal(63),
        outcomeDigests: z.literal("identical-original"),
        effects: singleEffectReportSchema,
      })
      .strict(),
    conflictingFingerprintRace: z
      .object({
        contenderCount: z.literal(
          SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.conflictContenderCount,
        ),
        executedResults: z.literal(1),
        rejectedResults: z.literal(1),
        rejectionReasonCode: z.literal("idempotency_conflict"),
        winnerSeededRank: z.number().int().min(1).max(2),
        loserEffects: z.literal("none"),
        effects: singleEffectReportSchema,
      })
      .strict(),
    ambiguousCommit: z
      .object({
        firstStatus: z.literal("unavailable"),
        firstReasonCode: z.literal("ambiguous_commit"),
        committedState: z.literal("fully-committed"),
        retryDecision: z.literal("replayed"),
        outcomeDigest: z.literal("original"),
        retryEffects: z.literal("none"),
        effects: singleEffectReportSchema,
      })
      .strict(),
    transactionFaults: z
      .array(sharedStateIdempotencyTransactionFaultReportV1Schema)
      .length(
        SHARED_STATE_IDEMPOTENCY_TRANSACTION_FAULT_POINTS_V1.length,
      ),
    closeReopen: z
      .object({
        clock: z.literal("injected-fake"),
        advanceExactlyByMs: z.literal(
          SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.reopenClockAdvanceMs,
        ),
        snapshotContinuity: z.literal("preserved"),
        retryDecision: z.literal("replayed"),
        outcomeDigest: z.literal("identical-original"),
        retentionReasonCode: z.literal(
          "non_expiring_until_prune_proof",
        ),
        retentionExecution: z.literal("not-executed"),
        effects: singleEffectReportSchema,
      })
      .strict(),
  })
  .strict();

export type SharedStateIdempotencyConformanceReportV1 = Readonly<
  z.infer<typeof sharedStateIdempotencyConformanceReportV1Schema>
>;

export interface SharedStateIdempotencyConformanceClockV1 {
  readLogicalMilliseconds(): bigint;
}

export interface SharedStateIdempotencyConformanceClockControlV1
  extends SharedStateIdempotencyConformanceClockV1 {
  advanceExactlyBy(milliseconds: number): void;
}

export class InjectedIdempotencyDeterministicFakeClockV1
implements SharedStateIdempotencyConformanceClockControlV1 {
  #logicalMilliseconds = 0n;

  readLogicalMilliseconds(): bigint {
    return this.#logicalMilliseconds;
  }

  advanceExactlyBy(milliseconds: number): void {
    if (
      !Number.isSafeInteger(milliseconds)
      || milliseconds < 0
      || milliseconds > V.limits.maxDurationMs
    ) {
      fail("target_operation_failed");
    }
    this.#logicalMilliseconds += BigInt(milliseconds);
  }
}

/**
 * Backend-neutral target seam. Commands and results are exclusively the
 * existing storage V1 envelopes; snapshots and faults are bounded test
 * controls, not a storage contract or runtime API.
 */
export interface SharedStateIdempotencyConformanceTargetV1 {
  open(): Promise<unknown>;
  executeIdempotent(
    command: SharedStateExecuteIdempotentCommandV1,
  ): Promise<unknown>;
  snapshot(): Promise<unknown>;
  armFault(faultPoint: SharedStateIdempotencyFaultPointV1): void;
  close(): Promise<unknown>;
}

export interface SharedStateIdempotencyConformanceTargetFactoryV1 {
  create(input: {
    readonly clock: SharedStateIdempotencyConformanceClockV1;
  }): Promise<SharedStateIdempotencyConformanceTargetV1>;
}

export class ExplicitIdempotencyPromiseBarrierV1 {
  readonly #expected: number;
  #arrived = 0;
  #released = false;
  readonly #allArrived: Promise<void>;
  readonly #gate: Promise<void>;
  #resolveAllArrived!: () => void;
  #resolveGate!: () => void;

  constructor(expected: number) {
    if (
      !Number.isSafeInteger(expected)
      || expected <= 0
      || expected
        > SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1
          .sameFingerprintContenderCount
    ) {
      fail("barrier_not_ready");
    }
    this.#expected = expected;
    this.#allArrived = new Promise((resolve) => {
      this.#resolveAllArrived = resolve;
    });
    this.#gate = new Promise((resolve) => {
      this.#resolveGate = resolve;
    });
  }

  async arriveAndWait(): Promise<void> {
    if (this.#released || this.#arrived >= this.#expected) {
      fail("barrier_not_ready");
    }
    this.#arrived += 1;
    if (this.#arrived === this.#expected) this.#resolveAllArrived();
    await this.#gate;
  }

  async waitUntilAllArrived(): Promise<void> {
    await this.#allArrived;
  }

  release(): void {
    if (this.#released || this.#arrived !== this.#expected) {
      fail("barrier_not_ready");
    }
    this.#released = true;
    this.#resolveGate();
  }
}

export function seededDeterministicIdempotencyOrderV1(
  count: number,
): readonly number[] {
  if (
    !Number.isSafeInteger(count)
    || count <= 0
    || count
      > SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1
        .sameFingerprintContenderCount
  ) {
    return fail("invalid_generated_command");
  }
  const order = Array.from({ length: count }, (_, index) => index);
  let state = SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.schedulerSeed >>> 0;
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (
      Math.imul(state, 1_664_525) + 1_013_904_223
    ) >>> 0;
    const other = state % (index + 1);
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  return Object.freeze(order);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function sameSnapshot(
  left: SharedStateIdempotencyConformanceSnapshotV1,
  right: SharedStateIdempotencyConformanceSnapshotV1,
): boolean {
  return (
    left.kind === right.kind
    && left.snapshotVersion === right.snapshotVersion
    && left.reservationCount === right.reservationCount
    && left.pendingReservationCount === right.pendingReservationCount
    && left.domainMutationCount === right.domainMutationCount
    && left.outboxAppendCount === right.outboxAppendCount
    && left.stableOutcomeCount === right.stableOutcomeCount
  );
}

function isEmptySnapshot(
  value: SharedStateIdempotencyConformanceSnapshotV1,
): boolean {
  return (
    value.reservationCount === 0
    && value.pendingReservationCount === 0
    && value.domainMutationCount === 0
    && value.outboxAppendCount === 0
    && value.stableOutcomeCount === 0
  );
}

function isSingleEffectSnapshot(
  value: SharedStateIdempotencyConformanceSnapshotV1,
): boolean {
  return (
    value.reservationCount === 1
    && value.pendingReservationCount === 0
    && value.domainMutationCount === 1
    && value.outboxAppendCount === 1
    && value.stableOutcomeCount === 1
  );
}

const IDEMPOTENCY_REGISTRATION = (() => {
  const registration = sharedStateIdempotencyCatalogV1().entries.find(
    (entry) => entry.namespace === "broker.task.create",
  );
  if (
    registration === undefined
    || registration.retentionPolicyVersion !== "task-create-effects.v1"
    || registration.effectKind !== "domain-mutation-with-outbox"
  ) {
    return fail("retention_policy_mismatch");
  }
  return registration;
})();

type DigestDomain =
  | "broker.idempotency.key"
  | "broker.idempotency.payload-fingerprint"
  | "broker.idempotency.domain-mutation"
  | "broker.outbox.stream-key"
  | "broker.outbox.event-key"
  | "broker.outbox.payload";

function digest(
  domain: DigestDomain,
  components: readonly {
    readonly field: string;
    readonly type: "utf8" | "bytes";
    readonly value: string;
  }[],
): string {
  const result = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace: IDEMPOTENCY_REGISTRATION.namespace,
    components,
  });
  if (!result.ok) return fail("invalid_generated_command");
  return result.value.digest;
}

const IDEMPOTENCY_KEY_DIGEST = digest("broker.idempotency.key", [
  { field: "operationName", type: "utf8", value: "synthetic-operation" },
  { field: "clientKey", type: "utf8", value: "synthetic-key" },
]);

function commandVariant(
  variant: 0 | 1,
): SharedStateExecuteIdempotentCommandV1 {
  const suffix = variant === 0 ? "a" : "b";
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "executeIdempotent",
    input: {
      namespace: IDEMPOTENCY_REGISTRATION.namespace,
      keyDigest: IDEMPOTENCY_KEY_DIGEST,
      payloadFingerprint: digest(
        "broker.idempotency.payload-fingerprint",
        [{ field: "payload", type: "bytes", value: `${suffix}1` }],
      ),
      retentionPolicyVersion:
        IDEMPOTENCY_REGISTRATION.retentionPolicyVersion,
      effect: {
        kind: IDEMPOTENCY_REGISTRATION.effectKind,
        domainMutationDigest: digest(
          "broker.idempotency.domain-mutation",
          [
            {
              field: "mutationType",
              type: "utf8",
              value: `synthetic-${suffix}`,
            },
            {
              field: "mutationBody",
              type: "bytes",
              value: `${suffix}2`,
            },
          ],
        ),
        outbox: {
          streamKeyDigest: digest("broker.outbox.stream-key", [
            { field: "streamType", type: "utf8", value: "synthetic" },
            { field: "streamId", type: "utf8", value: suffix },
          ]),
          eventKeyDigest: digest("broker.outbox.event-key", [
            { field: "eventId", type: "utf8", value: `synthetic-${suffix}` },
          ]),
          payloadDigest: digest("broker.outbox.payload", [
            { field: "payload", type: "bytes", value: `${suffix}3` },
          ]),
          retentionPolicyVersion: "caller-owned-outbox.v1",
        },
      },
    },
  });
  if (!parsed.ok || parsed.value.operation !== "executeIdempotent") {
    return fail("invalid_generated_command");
  }
  return parsed.value;
}

const PRIMARY_COMMAND = commandVariant(0);
const ALTERNATE_COMMAND = commandVariant(1);

async function createTarget(
  factory: SharedStateIdempotencyConformanceTargetFactoryV1,
  clock: SharedStateIdempotencyConformanceClockV1,
): Promise<SharedStateIdempotencyConformanceTargetV1> {
  try {
    return await factory.create({ clock });
  } catch {
    return fail("target_create_failed");
  }
}

async function lifecycle(
  action: () => Promise<unknown>,
): Promise<SharedStateStorageLifecycleV1> {
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

function requireReady(result: SharedStateStorageLifecycleV1): void {
  if (result.state !== "ready" || result.reasonCodes.length !== 0) {
    fail("target_lifecycle_failed");
  }
}

async function closeTarget(
  target: SharedStateIdempotencyConformanceTargetV1,
): Promise<void> {
  const closed = await lifecycle(() => target.close());
  if (
    closed.state !== "closed"
    || closed.reasonCodes.length !== 1
    || closed.reasonCodes[0] !== "close_requested"
  ) {
    fail("target_lifecycle_failed");
  }
}

async function snapshot(
  target: SharedStateIdempotencyConformanceTargetV1,
): Promise<SharedStateIdempotencyConformanceSnapshotV1> {
  let raw: unknown;
  try {
    raw = await target.snapshot();
  } catch {
    return fail("target_snapshot_failed");
  }
  const parsed = sharedStateIdempotencyConformanceSnapshotV1Schema.safeParse(
    raw,
  );
  if (!parsed.success) return fail("invalid_target_snapshot");
  return deepFreeze(parsed.data);
}

/**
 * Runs exactly the bounded Phase 2.2 reference-model slice and returns only a
 * strict, public-safe report. Target values and thrown messages are never
 * reflected in reports or errors.
 */
export async function runSharedStateIdempotencyConformanceV1(
  factory: SharedStateIdempotencyConformanceTargetFactoryV1,
): Promise<SharedStateIdempotencyConformanceReportV1> {
  let operationCount = 0;
  let targetCount = 0;

  async function execute(
    target: SharedStateIdempotencyConformanceTargetV1,
    command: SharedStateExecuteIdempotentCommandV1,
  ): Promise<SharedStateExecuteIdempotentResultV1> {
    operationCount += 1;
    if (
      operationCount
      > SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.operationLimit
    ) {
      return fail("operation_limit_exceeded");
    }
    let raw: unknown;
    try {
      raw = await target.executeIdempotent(command);
    } catch {
      return fail("target_operation_failed");
    }
    const parsed = parseSharedStateTransactionResultV1(raw);
    if (!parsed.ok || parsed.value.operation !== "executeIdempotent") {
      return fail("invalid_target_result");
    }
    return parsed.value;
  }

  async function openedTarget(
    clock: SharedStateIdempotencyConformanceClockV1,
  ): Promise<SharedStateIdempotencyConformanceTargetV1> {
    targetCount += 1;
    if (
      targetCount > SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.targetCount
    ) {
      return fail("target_create_failed");
    }
    const target = await createTarget(factory, clock);
    requireReady(await lifecycle(() => target.open()));
    return target;
  }

  const sameClock = new InjectedIdempotencyDeterministicFakeClockV1();
  const sameTarget = await openedTarget(sameClock);
  const sameOrder = seededDeterministicIdempotencyOrderV1(
    SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.sameFingerprintContenderCount,
  );
  const sameBarrier = new ExplicitIdempotencyPromiseBarrierV1(
    SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.sameFingerprintContenderCount,
  );
  const samePromises = sameOrder.map(async () => {
    await sameBarrier.arriveAndWait();
    return execute(sameTarget, PRIMARY_COMMAND);
  });
  await sameBarrier.waitUntilAllArrived();
  sameBarrier.release();
  const sameResults = await Promise.all(samePromises);
  const sameExecuted = sameResults.filter(
    (result) => (
      result.status === "committed"
      && result.result.decision === "executed"
    ),
  );
  const sameReplayed = sameResults.filter(
    (result) => (
      result.status === "committed"
      && result.result.decision === "replayed"
    ),
  );
  if (
    sameExecuted.length !== 1
    || sameReplayed.length !== 63
    || sameResults.some((result) => result.status !== "committed")
  ) {
    fail("same_fingerprint_outcome_mismatch");
  }
  const originalExecutedResult = sameExecuted[0];
  if (
    originalExecutedResult === undefined
    || originalExecutedResult.status !== "committed"
  ) {
    return fail("same_fingerprint_outcome_mismatch");
  }
  const originalOutcomeDigest =
    originalExecutedResult.result.outcomeDigest;
  if (
    !sameResults.every((result) => (
      result.status === "committed"
      && result.result.outcomeDigest === originalOutcomeDigest
    ))
  ) {
    fail("same_fingerprint_outcome_mismatch");
  }
  if (!isSingleEffectSnapshot(await snapshot(sameTarget))) {
    fail("effect_snapshot_mismatch");
  }
  await closeTarget(sameTarget);

  const conflictClock = new InjectedIdempotencyDeterministicFakeClockV1();
  const conflictTarget = await openedTarget(conflictClock);
  const conflictOrder = seededDeterministicIdempotencyOrderV1(
    SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.conflictContenderCount,
  );
  const conflictBarrier = new ExplicitIdempotencyPromiseBarrierV1(
    SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.conflictContenderCount,
  );
  const conflictEntries = conflictOrder.map((variantIndex) => {
    const command = variantIndex === 0 ? PRIMARY_COMMAND : ALTERNATE_COMMAND;
    return {
      variantIndex,
      resultPromise: (async () => {
        await conflictBarrier.arriveAndWait();
        return execute(conflictTarget, command);
      })(),
    };
  });
  await conflictBarrier.waitUntilAllArrived();
  conflictBarrier.release();
  const conflictResults = await Promise.all(
    conflictEntries.map(async (entry) => ({
      variantIndex: entry.variantIndex,
      result: await entry.resultPromise,
    })),
  );
  const conflictWinners = conflictResults.filter(
    (entry) => (
      entry.result.status === "committed"
      && entry.result.result.decision === "executed"
    ),
  );
  const conflictLosers = conflictResults.filter(
    (entry) => (
      entry.result.status === "rejected"
      && entry.result.reasonCode === "idempotency_conflict"
    ),
  );
  if (
    conflictWinners.length !== 1
    || conflictLosers.length !== 1
    || conflictWinners[0]!.variantIndex
      === conflictLosers[0]!.variantIndex
  ) {
    fail("idempotency_conflict_mismatch");
  }
  const winnerSeededRank = conflictOrder.indexOf(
    conflictWinners[0]!.variantIndex,
  ) + 1;
  if (winnerSeededRank < 1 || winnerSeededRank > 2) {
    fail("idempotency_conflict_mismatch");
  }
  if (!isSingleEffectSnapshot(await snapshot(conflictTarget))) {
    fail("effect_snapshot_mismatch");
  }
  await closeTarget(conflictTarget);

  const ambiguousClock = new InjectedIdempotencyDeterministicFakeClockV1();
  const ambiguousTarget = await openedTarget(ambiguousClock);
  try {
    ambiguousTarget.armFault("after_commit_before_response");
  } catch {
    return fail("target_fault_control_failed");
  }
  const ambiguousFirst = await execute(ambiguousTarget, PRIMARY_COMMAND);
  if (
    ambiguousFirst.status !== "unavailable"
    || ambiguousFirst.reasonCode !== "ambiguous_commit"
  ) {
    fail("ambiguous_commit_mismatch");
  }
  const ambiguousCommitted = await snapshot(ambiguousTarget);
  if (!isSingleEffectSnapshot(ambiguousCommitted)) {
    fail("ambiguous_commit_mismatch");
  }
  const ambiguousRetry = await execute(ambiguousTarget, PRIMARY_COMMAND);
  if (
    ambiguousRetry.status !== "committed"
    || ambiguousRetry.result.decision !== "replayed"
  ) {
    fail("ambiguous_commit_mismatch");
  }
  if (!sameSnapshot(
    ambiguousCommitted,
    await snapshot(ambiguousTarget),
  )) {
    fail("ambiguous_commit_mismatch");
  }
  await closeTarget(ambiguousTarget);

  const transactionFaults:
  SharedStateIdempotencyTransactionFaultReportV1[] = [];
  for (
    const faultPoint
    of SHARED_STATE_IDEMPOTENCY_TRANSACTION_FAULT_POINTS_V1
  ) {
    const faultClock = new InjectedIdempotencyDeterministicFakeClockV1();
    const faultTarget = await openedTarget(faultClock);
    const baseline = await snapshot(faultTarget);
    if (!isEmptySnapshot(baseline)) fail("transaction_not_atomic");
    try {
      faultTarget.armFault(faultPoint);
    } catch {
      return fail("target_fault_control_failed");
    }
    const failed = await execute(faultTarget, PRIMARY_COMMAND);
    if (
      failed.status !== "unavailable"
      || failed.reasonCode !== "authority_unavailable"
    ) {
      fail("transaction_not_atomic");
    }
    if (!sameSnapshot(baseline, await snapshot(faultTarget))) {
      fail("transaction_not_atomic");
    }
    const clean = await execute(faultTarget, PRIMARY_COMMAND);
    if (
      clean.status !== "committed"
      || clean.result.decision !== "executed"
    ) {
      fail("transaction_not_atomic");
    }
    if (!isSingleEffectSnapshot(await snapshot(faultTarget))) {
      fail("transaction_not_atomic");
    }
    await closeTarget(faultTarget);
    transactionFaults.push({
      faultPoint,
      failedStatus: "unavailable",
      failedReasonCode: "authority_unavailable",
      rollback: "exact-empty-baseline",
      pendingReservationCount: 0,
      nextCleanDecision: "executed",
    });
  }

  const reopenClock = new InjectedIdempotencyDeterministicFakeClockV1();
  const reopenTarget = await openedTarget(reopenClock);
  const reopenFirst = await execute(reopenTarget, PRIMARY_COMMAND);
  if (
    reopenFirst.status !== "committed"
    || reopenFirst.result.decision !== "executed"
  ) {
    fail("reopen_snapshot_mismatch");
  }
  const beforeClose = await snapshot(reopenTarget);
  if (!isSingleEffectSnapshot(beforeClose)) {
    fail("reopen_snapshot_mismatch");
  }
  await closeTarget(reopenTarget);
  reopenClock.advanceExactlyBy(
    SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.reopenClockAdvanceMs,
  );
  requireReady(await lifecycle(() => reopenTarget.open()));
  if (!sameSnapshot(beforeClose, await snapshot(reopenTarget))) {
    fail("reopen_snapshot_mismatch");
  }
  const reopenRetry = await execute(reopenTarget, PRIMARY_COMMAND);
  if (
    reopenRetry.status !== "committed"
    || reopenRetry.result.decision !== "replayed"
    || reopenRetry.result.outcomeDigest
      !== reopenFirst.result.outcomeDigest
  ) {
    fail("reopen_snapshot_mismatch");
  }
  if (!sameSnapshot(beforeClose, await snapshot(reopenTarget))) {
    fail("reopen_snapshot_mismatch");
  }
  const retention = evaluateSharedStateIdempotencyExpiryV1(
    IDEMPOTENCY_REGISTRATION,
  );
  if (
    !retention.ok
    || retention.value.decision !== "non-expiring"
    || retention.value.reasonCode !== "non_expiring_until_prune_proof"
  ) {
    fail("retention_policy_mismatch");
  }
  await closeTarget(reopenTarget);

  if (
    targetCount !== SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.targetCount
    || operationCount
      !== SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.expectedOperationCount
  ) {
    fail("operation_limit_exceeded");
  }

  const singleEffects = {
    reservationCount: 1,
    pendingReservationCount: 0,
    domainMutationCount: 1,
    outboxAppendCount: 1,
    stableOutcomeCount: 1,
  } as const;
  const report = {
    kind: SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.kind,
    harnessVersion: SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.harnessVersion,
    contractVersion: V.versions.contract,
    scope: SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.scope,
    status: "passed",
    scheduler: {
      kind: "seeded-deterministic",
      seed: SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.schedulerSeed,
      barrier: "explicit-promise",
      targetIsolation: "factory-created-per-scenario",
      targetCount,
      operationLimit:
        SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.operationLimit,
      operationCount,
    },
    sameFingerprintRace: {
      contenderCount:
        SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1
          .sameFingerprintContenderCount,
      executedResults: 1,
      replayedResults: 63,
      outcomeDigests: "identical-original",
      effects: singleEffects,
    },
    conflictingFingerprintRace: {
      contenderCount:
        SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.conflictContenderCount,
      executedResults: 1,
      rejectedResults: 1,
      rejectionReasonCode: "idempotency_conflict",
      winnerSeededRank,
      loserEffects: "none",
      effects: singleEffects,
    },
    ambiguousCommit: {
      firstStatus: "unavailable",
      firstReasonCode: "ambiguous_commit",
      committedState: "fully-committed",
      retryDecision: "replayed",
      outcomeDigest: "original",
      retryEffects: "none",
      effects: singleEffects,
    },
    transactionFaults,
    closeReopen: {
      clock: "injected-fake",
      advanceExactlyByMs:
        SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.reopenClockAdvanceMs,
      snapshotContinuity: "preserved",
      retryDecision: "replayed",
      outcomeDigest: "identical-original",
      retentionReasonCode: "non_expiring_until_prune_proof",
      retentionExecution: "not-executed",
      effects: singleEffects,
    },
  } as const;
  const parsedReport =
    sharedStateIdempotencyConformanceReportV1Schema.safeParse(report);
  if (!parsedReport.success) return fail("report_invalid");
  return deepFreeze(parsedReport.data);
}
