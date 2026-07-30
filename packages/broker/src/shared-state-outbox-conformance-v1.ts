/**
 * Backend-neutral deterministic outbox-ordering conformance harness for
 * `a2a.shared-state.storage/v1`.
 *
 * The harness consumes only the existing append, receipt, and acknowledgment
 * command/result envelopes plus the closed outbox registry and evaluators. It
 * does not implement storage, add a query contract, select a backend, execute
 * retention, or attach to broker runtime.
 */

import { z } from "zod";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  compareSharedStateOutboxOrderingV1,
  digestSharedStateKeyV1,
  evaluateSharedStateOutboxPolicyV1,
  evaluateSharedStateOutboxRetryBindingV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  sharedStateOutboxCatalogV1,
  type SharedStateOutboxPolicyEvaluationV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";

export const SHARED_STATE_OUTBOX_CONFORMANCE_V1 = Object.freeze({
  kind: "SharedStateOutboxConformanceReportV1",
  harnessVersion: 1,
  scope: "outbox-ordering-receipt-ack",
  schedulerSeed: 1504,
  streamCount: 2,
  producersPerStream: 4,
  producerCount: 8,
  targetCount: 7,
  targetCommandCount: 30,
  reconcileControlCount: 3,
  parserPolicyAttemptCount: 1,
  operationLimit: 40,
  expectedOperationCount: 34,
  reconcileEventLimit: 6,
} as const);

export const SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1 =
  Object.freeze([
    "domain-before-append",
    "append-before-commit",
    "ack-before-commit",
  ] as const);

export const SHARED_STATE_OUTBOX_APPEND_FAULT_POINTS_V1 = Object.freeze([
  SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1[0],
  SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1[1],
] as const);

export const SHARED_STATE_OUTBOX_CONFORMANCE_ERROR_CODES_V1 =
  Object.freeze([
    "invalid_generated_command",
    "invalid_target_result",
    "invalid_target_lifecycle",
    "invalid_target_snapshot",
    "invalid_conformance_cursor",
    "invalid_conformance_reconcile_response",
    "target_create_failed",
    "target_operation_failed",
    "target_lifecycle_failed",
    "target_snapshot_failed",
    "target_fault_control_failed",
    "target_reconcile_control_failed",
    "barrier_not_ready",
    "operation_limit_exceeded",
    "registry_policy_mismatch",
    "ordering_evaluator_mismatch",
    "append_order_mismatch",
    "retry_binding_mismatch",
    "transaction_not_atomic",
    "acknowledgment_not_atomic",
    "reopen_snapshot_mismatch",
    "reconcile_invariant_mismatch",
    "provider_acceptance_mismatch",
    "report_invalid",
    "reference_model_invariant",
  ] as const);

export type SharedStateOutboxConformanceFaultPointV1 =
  (typeof SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1)[number];
export type SharedStateOutboxAppendFaultPointV1 =
  (typeof SHARED_STATE_OUTBOX_APPEND_FAULT_POINTS_V1)[number];
export type SharedStateOutboxConformanceErrorCodeV1 =
  (typeof SHARED_STATE_OUTBOX_CONFORMANCE_ERROR_CODES_V1)[number];
export type SharedStateOutboxOperationV1 =
  | "appendOutbox"
  | "updateOutboxReceipt"
  | "acknowledgeOutbox";
export type SharedStateOutboxTransactionCommandV1 = Extract<
  SharedStateTransactionCommandV1,
  { readonly operation: SharedStateOutboxOperationV1 }
>;
export type SharedStateAppendOutboxCommandV1 = Extract<
  SharedStateOutboxTransactionCommandV1,
  { readonly operation: "appendOutbox" }
>;
export type SharedStateUpdateOutboxReceiptCommandV1 = Extract<
  SharedStateOutboxTransactionCommandV1,
  { readonly operation: "updateOutboxReceipt" }
>;
export type SharedStateAcknowledgeOutboxCommandV1 = Extract<
  SharedStateOutboxTransactionCommandV1,
  { readonly operation: "acknowledgeOutbox" }
>;
export type SharedStateOutboxTransactionResultV1 = Extract<
  SharedStateTransactionResultV1,
  { readonly operation: SharedStateOutboxOperationV1 }
>;
export type SharedStateAppendOutboxResultV1 = Extract<
  SharedStateOutboxTransactionResultV1,
  { readonly operation: "appendOutbox" }
>;
export type SharedStateUpdateOutboxReceiptResultV1 = Extract<
  SharedStateOutboxTransactionResultV1,
  { readonly operation: "updateOutboxReceipt" }
>;
export type SharedStateAcknowledgeOutboxResultV1 = Extract<
  SharedStateOutboxTransactionResultV1,
  { readonly operation: "acknowledgeOutbox" }
>;

export const sharedStateOutboxConformanceErrorReportV1Schema = z
  .object({
    kind: z.literal("SharedStateOutboxConformanceErrorV1"),
    errorVersion: z.literal(1),
    code: z.enum(SHARED_STATE_OUTBOX_CONFORMANCE_ERROR_CODES_V1),
  })
  .strict();

export type SharedStateOutboxConformanceErrorReportV1 = Readonly<
  z.infer<typeof sharedStateOutboxConformanceErrorReportV1Schema>
>;

export class SharedStateOutboxConformanceErrorV1 extends Error {
  readonly code: SharedStateOutboxConformanceErrorCodeV1;
  readonly publicReport: SharedStateOutboxConformanceErrorReportV1;

  constructor(code: SharedStateOutboxConformanceErrorCodeV1) {
    super(code);
    this.name = "SharedStateOutboxConformanceErrorV1";
    this.code = code;
    this.publicReport = deepFreeze({
      kind: "SharedStateOutboxConformanceErrorV1",
      errorVersion: 1,
      code,
    } as const);
    this.stack = `${this.name}: ${code}`;
  }

  toJSON(): SharedStateOutboxConformanceErrorReportV1 {
    return this.publicReport;
  }
}

function fail(code: SharedStateOutboxConformanceErrorCodeV1): never {
  throw new SharedStateOutboxConformanceErrorV1(code);
}

const nonNegativeDecimalSchema = z.string().regex(
  /^(?:0|[1-9][0-9]{0,39})$/,
);
const positiveDecimalSchema = z.string().regex(/^[1-9][0-9]{0,39}$/);
const streamKeyDigestSchema = z.string().regex(
  /^a2a\.shared-state\.keyspace\/v1\|broker\.outbox\.stream-key\|broker\.terminal-outbox\|sha256:[0-9a-f]{64}$/,
);
const eventKeyDigestSchema = z.string().regex(
  /^a2a\.shared-state\.keyspace\/v1\|broker\.outbox\.event-key\|broker\.terminal-outbox\|sha256:[0-9a-f]{64}$/,
);
const boundedCountSchema = z.number().int().nonnegative().max(
  SHARED_STATE_OUTBOX_CONFORMANCE_V1.operationLimit,
);

export const sharedStateOutboxConformanceSnapshotV1Schema = z
  .object({
    kind: z.literal("SharedStateOutboxConformanceSnapshotV1"),
    snapshotVersion: z.literal(1),
    domainEffectCount: boundedCountSchema,
    outboxEventCount: boundedCountSchema,
    receiptPendingCount: boundedCountSchema,
    receiptConfirmedCount: boundedCountSchema,
    receiptFailedCount: boundedCountSchema,
    unacknowledgedCount: boundedCountSchema,
    acknowledgedCount: boundedCountSchema,
  })
  .strict();

export type SharedStateOutboxConformanceSnapshotV1 = Readonly<
  z.infer<typeof sharedStateOutboxConformanceSnapshotV1Schema>
>;

const conformanceCursorPositionSchema = z
  .object({
    streamKeyDigest: streamKeyDigestSchema,
    afterSequence: nonNegativeDecimalSchema,
    acknowledgedThroughSequence: nonNegativeDecimalSchema,
  })
  .strict();

/**
 * Test-only cursor control. This is not a V1 storage query, consumer API, or
 * broker runtime surface.
 */
export const sharedStateOutboxConformanceCursorV1Schema = z
  .object({
    kind: z.literal("SharedStateOutboxConformanceCursorV1"),
    cursorVersion: z.literal(1),
    scope: z.literal("test-only-conformance-control"),
    positions: z
      .array(conformanceCursorPositionSchema)
      .length(SHARED_STATE_OUTBOX_CONFORMANCE_V1.streamCount),
  })
  .strict();

export type SharedStateOutboxConformanceCursorV1 = Readonly<
  z.infer<typeof sharedStateOutboxConformanceCursorV1Schema>
>;

const conformanceReconcileEventSchema = z
  .object({
    streamKeyDigest: streamKeyDigestSchema,
    eventKeyDigest: eventKeyDigestSchema,
    streamSequence: positiveDecimalSchema,
    receiptState: z.enum(V.receiptStates),
    acknowledgmentState: z.enum(V.acknowledgmentStates),
  })
  .strict();

/**
 * Strict response for the test-only reconciliation control. It is not a
 * storage result envelope and must never be wired to broker runtime.
 */
export const sharedStateOutboxConformanceReconcileResponseV1Schema = z
  .object({
    kind: z.literal("SharedStateOutboxConformanceReconcileResponseV1"),
    responseVersion: z.literal(1),
    scope: z.literal("test-only-conformance-control"),
    events: z
      .array(conformanceReconcileEventSchema)
      .max(SHARED_STATE_OUTBOX_CONFORMANCE_V1.reconcileEventLimit),
  })
  .strict();

export type SharedStateOutboxConformanceReconcileResponseV1 = Readonly<
  z.infer<typeof sharedStateOutboxConformanceReconcileResponseV1Schema>
>;

export const sharedStateOutboxConformanceFaultReportV1Schema = z
  .object({
    faultPoint: z.enum(
      SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1,
    ),
    operation: z.enum(["appendOutbox", "acknowledgeOutbox"]),
    failedStatus: z.literal("unavailable"),
    failedReasonCode: z.literal("authority_unavailable"),
    rollback: z.enum([
      "exact-empty-baseline",
      "confirmed-remains-unacknowledged",
    ]),
    cleanRetryDecision: z.enum(["appended", "acknowledged"]),
  })
  .strict();

export type SharedStateOutboxConformanceFaultReportV1 = Readonly<
  z.infer<typeof sharedStateOutboxConformanceFaultReportV1Schema>
>;

const perStreamOrderingReportSchema = z
  .object({
    streamOrdinal: z.number().int().min(1).max(2),
    committedDistinctProducers: z.literal(
      SHARED_STATE_OUTBOX_CONFORMANCE_V1.producersPerStream,
    ),
    adapterSequenceOrder: z
      .array(
        z
          .object({
            allocatedSequence: positiveDecimalSchema,
            producerScheduleRank: z.number().int().min(1).max(8),
          })
          .strict(),
      )
      .length(SHARED_STATE_OUTBOX_CONFORMANCE_V1.producersPerStream),
    uniquePositiveAllocatedSequences: z.literal(true),
    strictlyIncreasingInAdapterSequenceOrder: z.literal(true),
    projectionOrder: z.literal("adapter-sequence-order"),
  })
  .strict();

export const sharedStateOutboxConformanceReportV1Schema = z
  .object({
    kind: z.literal(SHARED_STATE_OUTBOX_CONFORMANCE_V1.kind),
    harnessVersion: z.literal(
      SHARED_STATE_OUTBOX_CONFORMANCE_V1.harnessVersion,
    ),
    contractVersion: z.literal(V.versions.contract),
    scope: z.literal(SHARED_STATE_OUTBOX_CONFORMANCE_V1.scope),
    status: z.literal("passed"),
    scheduler: z
      .object({
        kind: z.literal("seeded-deterministic"),
        seed: z.literal(SHARED_STATE_OUTBOX_CONFORMANCE_V1.schedulerSeed),
        barrier: z.literal("explicit-promise"),
        clock: z.literal("not-required-no-time-semantics"),
        targetIsolation: z.literal("factory-created-per-scenario"),
        targetCount: z.literal(
          SHARED_STATE_OUTBOX_CONFORMANCE_V1.targetCount,
        ),
        targetCommandCount: z.literal(
          SHARED_STATE_OUTBOX_CONFORMANCE_V1.targetCommandCount,
        ),
        reconcileControlCount: z.literal(
          SHARED_STATE_OUTBOX_CONFORMANCE_V1.reconcileControlCount,
        ),
        parserPolicyAttemptCount: z.literal(
          SHARED_STATE_OUTBOX_CONFORMANCE_V1.parserPolicyAttemptCount,
        ),
        operationLimit: z.literal(
          SHARED_STATE_OUTBOX_CONFORMANCE_V1.operationLimit,
        ),
        operationCount: z.literal(
          SHARED_STATE_OUTBOX_CONFORMANCE_V1.expectedOperationCount,
        ),
      })
      .strict(),
    registry: z
      .object({
        status: z.literal("closed-registered-policy"),
        sequenceAuthority: z.literal(
          "adapter-allocated-per-exact-stream-key",
        ),
        orderingScope: z.literal("total-within-exact-stream-key"),
        crossStreamOrder: z.literal("no-global-cross-stream-order"),
      })
      .strict(),
    producerOrdering: z
      .object({
        streamCount: z.literal(
          SHARED_STATE_OUTBOX_CONFORMANCE_V1.streamCount,
        ),
        producersPerStream: z.literal(
          SHARED_STATE_OUTBOX_CONFORMANCE_V1.producersPerStream,
        ),
        committedAppends: z.literal(
          SHARED_STATE_OUTBOX_CONFORMANCE_V1.producerCount,
        ),
        perStream: z.array(perStreamOrderingReportSchema).length(2),
        sameStreamEvaluator: z.literal("same_stream_total_order"),
        crossStreamEvaluator: z.literal("cross_stream_no_order"),
        callerFairnessAssertion: z.literal("none"),
        globalCrossStreamOrderingAssertion: z.literal("none"),
      })
      .strict(),
    retry: z
      .object({
        firstDecision: z.literal("appended"),
        retryDecision: z.literal("replayed"),
        eventKeyBinding: z.literal("original"),
        streamSequenceBinding: z.literal("original"),
        bindingDecision: z.literal("original-binding"),
        bindingReasonCode: z.literal(
          "idempotent_retry_returns_original_binding",
        ),
        secondEventEffect: z.literal("none"),
        secondDomainEffect: z.literal("none"),
      })
      .strict(),
    appendTransactionFaults: z
      .array(sharedStateOutboxConformanceFaultReportV1Schema)
      .length(SHARED_STATE_OUTBOX_APPEND_FAULT_POINTS_V1.length),
    acknowledgment: z
      .object({
        confirmingEvidence: z.literal("current-session-visible"),
        beforeFault: z.literal("receipt-confirmed-unacknowledged"),
        fault: sharedStateOutboxConformanceFaultReportV1Schema,
        stateAfterFault: z.literal(
          "receipt-confirmed-unacknowledged",
        ),
        retryDecision: z.literal("acknowledged"),
        secondRetryDecision: z.literal("already_acknowledged"),
        duplicateEffect: z.literal("none"),
      })
      .strict(),
    reconciliation: z
      .object({
        controlScope: z.literal("test-only-conformance-control"),
        storageQueryContract: z.literal("none"),
        runtimeApi: z.literal("none"),
        closeReopenState: z.literal("preserved"),
        cursorSet: z.tuple([
          z.literal("start"),
          z.literal("intermediate-per-stream"),
          z.literal("end"),
        ]),
        responseEventCounts: z.tuple([
          z.literal(5),
          z.literal(4),
          z.literal(0),
        ]),
        perStreamSequenceReversal: z.literal(false),
        duplicateEventIdWithinResponse: z.literal(false),
        unacknowledgedReplay: z.literal("proved"),
        acknowledgedReplayBeyondCursor: z.literal("none"),
        receiptAcknowledgmentState: z.literal("preserved"),
        globalCrossStreamCursorOrderAssertion: z.literal("none"),
      })
      .strict(),
    providerAcceptance: z
      .object({
        receiptEvidenceKind: z.literal("provider-accepted"),
        receiptState: z.literal("pending"),
        acknowledgmentState: z.literal("unacknowledged"),
        policyErrorCode: z.literal("provider_acceptance_not_ack"),
        parserErrorCode: z.literal(
          "outbox_provider_acceptance_not_ack",
        ),
        receiptConfirmedAck: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type SharedStateOutboxConformanceReportV1 = Readonly<
  z.infer<typeof sharedStateOutboxConformanceReportV1Schema>
>;

/**
 * Backend-neutral target seam. Append/receipt/ACK use only existing storage V1
 * envelopes. Snapshot, fault, and reconciliation methods are bounded
 * conformance controls, not storage commands, queries, or runtime APIs.
 */
export interface SharedStateOutboxConformanceTargetV1 {
  open(): Promise<unknown>;
  appendOutbox(command: SharedStateAppendOutboxCommandV1): Promise<unknown>;
  updateOutboxReceipt(
    command: SharedStateUpdateOutboxReceiptCommandV1,
  ): Promise<unknown>;
  acknowledgeOutbox(
    command: SharedStateAcknowledgeOutboxCommandV1,
  ): Promise<unknown>;
  snapshot(): Promise<unknown>;
  armFault(faultPoint: SharedStateOutboxConformanceFaultPointV1): void;
  reconcileConformanceControl(
    cursor: SharedStateOutboxConformanceCursorV1,
  ): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface SharedStateOutboxConformanceTargetFactoryV1 {
  create(): Promise<SharedStateOutboxConformanceTargetV1>;
}

export class ExplicitOutboxPromiseBarrierV1 {
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
      || expected > SHARED_STATE_OUTBOX_CONFORMANCE_V1.producerCount
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

export function seededDeterministicOutboxOrderV1(
  count: number,
): readonly number[] {
  if (
    !Number.isSafeInteger(count)
    || count <= 0
    || count > SHARED_STATE_OUTBOX_CONFORMANCE_V1.producerCount
  ) {
    return fail("invalid_generated_command");
  }
  const order = Array.from({ length: count }, (_, index) => index);
  let state = SHARED_STATE_OUTBOX_CONFORMANCE_V1.schedulerSeed >>> 0;
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
  left: SharedStateOutboxConformanceSnapshotV1,
  right: SharedStateOutboxConformanceSnapshotV1,
): boolean {
  return (
    left.kind === right.kind
    && left.snapshotVersion === right.snapshotVersion
    && left.domainEffectCount === right.domainEffectCount
    && left.outboxEventCount === right.outboxEventCount
    && left.receiptPendingCount === right.receiptPendingCount
    && left.receiptConfirmedCount === right.receiptConfirmedCount
    && left.receiptFailedCount === right.receiptFailedCount
    && left.unacknowledgedCount === right.unacknowledgedCount
    && left.acknowledgedCount === right.acknowledgedCount
  );
}

function isEmptySnapshot(
  value: SharedStateOutboxConformanceSnapshotV1,
): boolean {
  return (
    value.domainEffectCount === 0
    && value.outboxEventCount === 0
    && value.receiptPendingCount === 0
    && value.receiptConfirmedCount === 0
    && value.receiptFailedCount === 0
    && value.unacknowledgedCount === 0
    && value.acknowledgedCount === 0
  );
}

function isSinglePendingUnacknowledged(
  value: SharedStateOutboxConformanceSnapshotV1,
): boolean {
  return (
    value.domainEffectCount === 1
    && value.outboxEventCount === 1
    && value.receiptPendingCount === 1
    && value.receiptConfirmedCount === 0
    && value.receiptFailedCount === 0
    && value.unacknowledgedCount === 1
    && value.acknowledgedCount === 0
  );
}

function isSingleConfirmedUnacknowledged(
  value: SharedStateOutboxConformanceSnapshotV1,
): boolean {
  return (
    value.domainEffectCount === 1
    && value.outboxEventCount === 1
    && value.receiptPendingCount === 0
    && value.receiptConfirmedCount === 1
    && value.receiptFailedCount === 0
    && value.unacknowledgedCount === 1
    && value.acknowledgedCount === 0
  );
}

function isSingleConfirmedAcknowledged(
  value: SharedStateOutboxConformanceSnapshotV1,
): boolean {
  return (
    value.domainEffectCount === 1
    && value.outboxEventCount === 1
    && value.receiptPendingCount === 0
    && value.receiptConfirmedCount === 1
    && value.receiptFailedCount === 0
    && value.unacknowledgedCount === 0
    && value.acknowledgedCount === 1
  );
}

const OUTBOX_REGISTRATION = (() => {
  const registration = sharedStateOutboxCatalogV1().entries.find(
    (entry) => (
      entry.namespace === "broker.terminal-outbox"
      && entry.eventPurpose === "task-terminal-notification"
    ),
  );
  if (
    registration === undefined
    || registration.sequenceAuthority
      !== "adapter-allocated-per-exact-stream-key"
    || registration.orderingScope !== "total-within-exact-stream-key"
    || registration.crossStreamOrder !== "no-global-cross-stream-order"
    || registration.idempotencyBinding
      !== "same-key-and-payload-return-original-event-id-and-sequence"
    || registration.receiptPolicyVersion
      !== "terminal-notification-receipt.v1"
    || registration.acknowledgmentPolicyVersion
      !== "terminal-notification-ack.v1"
  ) {
    return fail("registry_policy_mismatch");
  }
  return registration;
})();

type DigestDomain =
  | "broker.outbox.stream-key"
  | "broker.outbox.idempotency-key"
  | "broker.outbox.event-key"
  | "broker.outbox.payload"
  | "broker.outbox.receipt-evidence";

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
    namespace: OUTBOX_REGISTRATION.namespace,
    components,
  });
  if (!result.ok) return fail("invalid_generated_command");
  return result.value.digest;
}

interface GeneratedStream {
  readonly ordinal: 1 | 2;
  readonly streamKey: {
    readonly keyspaceVersion: typeof V.versions.keyspace;
    readonly components: readonly [
      {
        readonly field: "streamType";
        readonly type: "utf8";
        readonly value: "broker-terminal-outbox";
      },
      {
        readonly field: "streamId";
        readonly type: "utf8";
        readonly value: string;
      },
    ];
  };
  readonly streamKeyDigest: string;
}

function generatedStream(ordinal: 1 | 2): GeneratedStream {
  const streamKey = {
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
        value: ordinal === 1
          ? "conformance-stream-a"
          : "conformance-stream-b",
      },
    ],
  } as const;
  return Object.freeze({
    ordinal,
    streamKey,
    streamKeyDigest: digest(
      "broker.outbox.stream-key",
      streamKey.components,
    ),
  });
}

const STREAMS = Object.freeze([
  generatedStream(1),
  generatedStream(2),
] as const);

function rawCommand(
  operation: SharedStateOutboxOperationV1,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input,
  };
}

function parseGeneratedCommand(
  operation: "appendOutbox",
  input: Record<string, unknown>,
): SharedStateAppendOutboxCommandV1;
function parseGeneratedCommand(
  operation: "updateOutboxReceipt",
  input: Record<string, unknown>,
): SharedStateUpdateOutboxReceiptCommandV1;
function parseGeneratedCommand(
  operation: "acknowledgeOutbox",
  input: Record<string, unknown>,
): SharedStateAcknowledgeOutboxCommandV1;
function parseGeneratedCommand(
  operation: SharedStateOutboxOperationV1,
  input: Record<string, unknown>,
): SharedStateOutboxTransactionCommandV1 {
  const parsed = parseSharedStateTransactionCommandV1(
    rawCommand(operation, input),
  );
  if (!parsed.ok || parsed.value.operation !== operation) {
    return fail("invalid_generated_command");
  }
  return parsed.value as SharedStateOutboxTransactionCommandV1;
}

function eventDigests(eventOrdinal: number) {
  if (!Number.isSafeInteger(eventOrdinal) || eventOrdinal <= 0) {
    return fail("invalid_generated_command");
  }
  const suffix = eventOrdinal.toString().padStart(2, "0");
  const bytes = eventOrdinal.toString(16).padStart(2, "0");
  return Object.freeze({
    idempotencyKeyDigest: digest("broker.outbox.idempotency-key", [
      {
        field: "producerId",
        type: "utf8",
        value: `conformance-producer-${suffix}`,
      },
      {
        field: "clientKey",
        type: "utf8",
        value: `conformance-key-${suffix}`,
      },
    ]),
    eventKeyDigest: digest("broker.outbox.event-key", [
      {
        field: "eventId",
        type: "utf8",
        value: `conformance-event-${suffix}`,
      },
    ]),
    payloadDigest: digest("broker.outbox.payload", [
      {
        field: "payload",
        type: "bytes",
        value: `${bytes}aa`,
      },
    ]),
  });
}

function appendCommand(
  stream: GeneratedStream,
  eventOrdinal: number,
): SharedStateAppendOutboxCommandV1 {
  const event = eventDigests(eventOrdinal);
  return parseGeneratedCommand("appendOutbox", {
    namespace: OUTBOX_REGISTRATION.namespace,
    eventPurpose: OUTBOX_REGISTRATION.eventPurpose,
    streamKey: stream.streamKey,
    streamKeyDigest: stream.streamKeyDigest,
    orderingScope: OUTBOX_REGISTRATION.orderingScope,
    idempotencyKeyDigest: event.idempotencyKeyDigest,
    eventKeyDigest: event.eventKeyDigest,
    payloadDigest: event.payloadDigest,
    retentionPolicyVersion: OUTBOX_REGISTRATION.retentionPolicyVersion,
    receiptPolicyVersion: OUTBOX_REGISTRATION.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      OUTBOX_REGISTRATION.acknowledgmentPolicyVersion,
  });
}

function receiptEvidenceDigest(
  eventOrdinal: number,
  evidenceOrdinal: number,
): string {
  const eventBytes = eventOrdinal.toString(16).padStart(2, "0");
  const evidenceBytes = evidenceOrdinal.toString(16).padStart(2, "0");
  return digest("broker.outbox.receipt-evidence", [
    {
      field: "provider",
      type: "utf8",
      value: "conformance-evidence",
    },
    {
      field: "evidence",
      type: "bytes",
      value: `${eventBytes}${evidenceBytes}`,
    },
  ]);
}

function receiptCommand(
  append: SharedStateAppendOutboxCommandV1,
  eventOrdinal: number,
  evidenceKind: "current-session-visible" | "provider-accepted",
): SharedStateUpdateOutboxReceiptCommandV1 {
  return parseGeneratedCommand("updateOutboxReceipt", {
    namespace: append.input.namespace,
    eventPurpose: append.input.eventPurpose,
    streamKey: append.input.streamKey,
    streamKeyDigest: append.input.streamKeyDigest,
    orderingScope: append.input.orderingScope,
    eventKeyDigest: append.input.eventKeyDigest,
    receiptEvidenceDigest: receiptEvidenceDigest(eventOrdinal, 1),
    retentionPolicyVersion: append.input.retentionPolicyVersion,
    receiptPolicyVersion: append.input.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      append.input.acknowledgmentPolicyVersion,
    receiptEvidenceKind: evidenceKind,
    expectedReceiptState: "pending",
    newReceiptState: evidenceKind === "provider-accepted"
      ? "pending"
      : "confirmed",
  });
}

function acknowledgmentInput(
  append: SharedStateAppendOutboxCommandV1,
  eventOrdinal: number,
  evidenceKind: "current-session-visible" | "provider-accepted",
): Record<string, unknown> {
  return {
    namespace: append.input.namespace,
    eventPurpose: append.input.eventPurpose,
    streamKey: append.input.streamKey,
    streamKeyDigest: append.input.streamKeyDigest,
    orderingScope: append.input.orderingScope,
    eventKeyDigest: append.input.eventKeyDigest,
    receiptEvidenceDigest: receiptEvidenceDigest(eventOrdinal, 2),
    retentionPolicyVersion: append.input.retentionPolicyVersion,
    receiptPolicyVersion: append.input.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      append.input.acknowledgmentPolicyVersion,
    receiptEvidenceKind: evidenceKind,
    expectedReceiptState: "confirmed",
    expectedAcknowledgmentState: "unacknowledged",
  };
}

function acknowledgeCommand(
  append: SharedStateAppendOutboxCommandV1,
  eventOrdinal: number,
): SharedStateAcknowledgeOutboxCommandV1 {
  return parseGeneratedCommand(
    "acknowledgeOutbox",
    acknowledgmentInput(
      append,
      eventOrdinal,
      "current-session-visible",
    ),
  );
}

function policyInput(
  command: SharedStateOutboxTransactionCommandV1,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    operation: command.operation,
    namespace: command.input.namespace,
    eventPurpose: command.input.eventPurpose,
    streamKey: command.input.streamKey,
    streamKeyDigest: command.input.streamKeyDigest,
    orderingScope: command.input.orderingScope,
    retentionPolicyVersion: command.input.retentionPolicyVersion,
    receiptPolicyVersion: command.input.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      command.input.acknowledgmentPolicyVersion,
  };
  if (command.operation === "updateOutboxReceipt") {
    Object.assign(input, {
      receiptEvidenceKind: command.input.receiptEvidenceKind,
      expectedReceiptState: command.input.expectedReceiptState,
      newReceiptState: command.input.newReceiptState,
    });
  } else if (command.operation === "acknowledgeOutbox") {
    Object.assign(input, {
      receiptEvidenceKind: command.input.receiptEvidenceKind,
      expectedReceiptState: command.input.expectedReceiptState,
      expectedAcknowledgmentState:
        command.input.expectedAcknowledgmentState,
    });
  }
  return input;
}

function evaluatePolicy(
  command: SharedStateOutboxTransactionCommandV1,
): SharedStateOutboxPolicyEvaluationV1 {
  const evaluated = evaluateSharedStateOutboxPolicyV1(policyInput(command));
  if (!evaluated.ok || evaluated.value.operation !== command.operation) {
    return fail("registry_policy_mismatch");
  }
  return evaluated.value;
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
  target: SharedStateOutboxConformanceTargetV1,
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

async function createTarget(
  factory: SharedStateOutboxConformanceTargetFactoryV1,
): Promise<SharedStateOutboxConformanceTargetV1> {
  try {
    return await factory.create();
  } catch {
    return fail("target_create_failed");
  }
}

async function snapshot(
  target: SharedStateOutboxConformanceTargetV1,
): Promise<SharedStateOutboxConformanceSnapshotV1> {
  let raw: unknown;
  try {
    raw = await target.snapshot();
  } catch {
    return fail("target_snapshot_failed");
  }
  const parsed = sharedStateOutboxConformanceSnapshotV1Schema.safeParse(raw);
  if (!parsed.success) return fail("invalid_target_snapshot");
  return deepFreeze(parsed.data);
}

function committedAppend(
  result: SharedStateAppendOutboxResultV1,
  decision: "appended" | "replayed",
): result is Extract<SharedStateAppendOutboxResultV1, {
  readonly status: "committed";
}> {
  return result.status === "committed" && result.result.decision === decision;
}

function strictlyIncreasing(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (BigInt(values[index]!) <= BigInt(values[index - 1]!)) return false;
  }
  return true;
}

function cursor(
  afterFirst: string,
  afterSecond: string,
): SharedStateOutboxConformanceCursorV1 {
  const candidate = {
    kind: "SharedStateOutboxConformanceCursorV1",
    cursorVersion: 1,
    scope: "test-only-conformance-control",
    positions: [
      {
        streamKeyDigest: STREAMS[0].streamKeyDigest,
        afterSequence: afterFirst,
        acknowledgedThroughSequence: "1",
      },
      {
        streamKeyDigest: STREAMS[1].streamKeyDigest,
        afterSequence: afterSecond,
        acknowledgedThroughSequence: "0",
      },
    ],
  } as const;
  const parsed = sharedStateOutboxConformanceCursorV1Schema.safeParse(
    candidate,
  );
  if (!parsed.success) return fail("invalid_conformance_cursor");
  return deepFreeze(parsed.data);
}

/**
 * Runs the exact bounded Phase 2.3 source/reference-model slice and returns
 * only a strict public-safe report. Target values and thrown messages are
 * never reflected in reports or errors.
 */
export async function runSharedStateOutboxConformanceV1(
  factory: SharedStateOutboxConformanceTargetFactoryV1,
): Promise<SharedStateOutboxConformanceReportV1> {
  let targetCount = 0;
  let targetCommandCount = 0;
  let reconcileControlCount = 0;
  let parserPolicyAttemptCount = 0;

  function checkOperationLimit(): void {
    if (
      targetCommandCount
        + reconcileControlCount
        + parserPolicyAttemptCount
      > SHARED_STATE_OUTBOX_CONFORMANCE_V1.operationLimit
    ) {
      fail("operation_limit_exceeded");
    }
  }

  async function openedTarget():
  Promise<SharedStateOutboxConformanceTargetV1> {
    targetCount += 1;
    if (targetCount > SHARED_STATE_OUTBOX_CONFORMANCE_V1.targetCount) {
      return fail("target_create_failed");
    }
    const target = await createTarget(factory);
    requireReady(await lifecycle(() => target.open()));
    return target;
  }

  async function append(
    target: SharedStateOutboxConformanceTargetV1,
    command: SharedStateAppendOutboxCommandV1,
  ): Promise<SharedStateAppendOutboxResultV1> {
    evaluatePolicy(command);
    targetCommandCount += 1;
    checkOperationLimit();
    let raw: unknown;
    try {
      raw = await target.appendOutbox(command);
    } catch {
      return fail("target_operation_failed");
    }
    const parsed = parseSharedStateTransactionResultV1(raw);
    if (!parsed.ok || parsed.value.operation !== "appendOutbox") {
      return fail("invalid_target_result");
    }
    return parsed.value;
  }

  async function updateReceipt(
    target: SharedStateOutboxConformanceTargetV1,
    command: SharedStateUpdateOutboxReceiptCommandV1,
  ): Promise<SharedStateUpdateOutboxReceiptResultV1> {
    evaluatePolicy(command);
    targetCommandCount += 1;
    checkOperationLimit();
    let raw: unknown;
    try {
      raw = await target.updateOutboxReceipt(command);
    } catch {
      return fail("target_operation_failed");
    }
    const parsed = parseSharedStateTransactionResultV1(raw);
    if (!parsed.ok || parsed.value.operation !== "updateOutboxReceipt") {
      return fail("invalid_target_result");
    }
    return parsed.value;
  }

  async function acknowledge(
    target: SharedStateOutboxConformanceTargetV1,
    command: SharedStateAcknowledgeOutboxCommandV1,
  ): Promise<SharedStateAcknowledgeOutboxResultV1> {
    evaluatePolicy(command);
    targetCommandCount += 1;
    checkOperationLimit();
    let raw: unknown;
    try {
      raw = await target.acknowledgeOutbox(command);
    } catch {
      return fail("target_operation_failed");
    }
    const parsed = parseSharedStateTransactionResultV1(raw);
    if (!parsed.ok || parsed.value.operation !== "acknowledgeOutbox") {
      return fail("invalid_target_result");
    }
    return parsed.value;
  }

  async function reconcile(
    target: SharedStateOutboxConformanceTargetV1,
    value: SharedStateOutboxConformanceCursorV1,
  ): Promise<SharedStateOutboxConformanceReconcileResponseV1> {
    const parsedCursor =
      sharedStateOutboxConformanceCursorV1Schema.safeParse(value);
    if (!parsedCursor.success) return fail("invalid_conformance_cursor");
    reconcileControlCount += 1;
    checkOperationLimit();
    let raw: unknown;
    try {
      raw = await target.reconcileConformanceControl(parsedCursor.data);
    } catch {
      return fail("target_reconcile_control_failed");
    }
    const parsed =
      sharedStateOutboxConformanceReconcileResponseV1Schema.safeParse(raw);
    if (!parsed.success) {
      return fail("invalid_conformance_reconcile_response");
    }
    return deepFreeze(parsed.data);
  }

  // Scenario 1: eight seeded producers released together at one barrier,
  // four per exact stream. Seeded schedule rank is attribution only; adapter
  // sequence order, not caller order, defines the per-stream projection.
  const orderingTarget = await openedTarget();
  const producerCommands = Array.from(
    { length: SHARED_STATE_OUTBOX_CONFORMANCE_V1.producerCount },
    (_, producerIndex) => {
      const stream = producerIndex < 4 ? STREAMS[0] : STREAMS[1];
      return {
        producerIndex,
        stream,
        command: appendCommand(stream, producerIndex + 1),
      };
    },
  );
  const seededOrder = seededDeterministicOutboxOrderV1(
    SHARED_STATE_OUTBOX_CONFORMANCE_V1.producerCount,
  );
  const orderingBarrier = new ExplicitOutboxPromiseBarrierV1(
    SHARED_STATE_OUTBOX_CONFORMANCE_V1.producerCount,
  );
  const scheduledProducers = seededOrder.map(
    (producerIndex, scheduleIndex) => {
      const producer = producerCommands[producerIndex];
      if (producer === undefined) return fail("append_order_mismatch");
      return {
        ...producer,
        producerScheduleRank: scheduleIndex + 1,
        promise: (async () => {
          await orderingBarrier.arriveAndWait();
          return append(orderingTarget, producer.command);
        })(),
      };
    },
  );
  await orderingBarrier.waitUntilAllArrived();
  orderingBarrier.release();
  const orderingResults = await Promise.all(
    scheduledProducers.map(async (entry) => ({
      ...entry,
      result: await entry.promise,
    })),
  );
  const perStream = STREAMS.map((stream) => {
    const entries = orderingResults.filter(
      (entry) => entry.stream.streamKeyDigest === stream.streamKeyDigest,
    );
    if (
      entries.length
        !== SHARED_STATE_OUTBOX_CONFORMANCE_V1.producersPerStream
      || entries.some((entry) => (
        !committedAppend(entry.result, "appended")
        || entry.result.result.eventKeyDigest
          !== entry.command.input.eventKeyDigest
      ))
    ) {
      return fail("append_order_mismatch");
    }
    const committedEntries = entries.map((entry) => {
      if (!committedAppend(entry.result, "appended")) {
        return fail("append_order_mismatch");
      }
      return {
        producerIndex: entry.producerIndex,
        producerScheduleRank: entry.producerScheduleRank,
        allocatedSequence: entry.result.result.streamSequence,
      };
    });
    const adapterSequenceOrder = [...committedEntries].sort(
      (left, right) => (
        BigInt(left.allocatedSequence) < BigInt(right.allocatedSequence)
          ? -1
          : BigInt(left.allocatedSequence)
              > BigInt(right.allocatedSequence)
            ? 1
            : 0
      ),
    );
    const allocatedSequences = adapterSequenceOrder.map(
      (entry) => entry.allocatedSequence,
    );
    if (
      new Set(
        committedEntries.map((entry) => entry.producerIndex),
      ).size !== SHARED_STATE_OUTBOX_CONFORMANCE_V1.producersPerStream
      || allocatedSequences.some((sequence) => BigInt(sequence) <= 0n)
      || new Set(allocatedSequences).size !== allocatedSequences.length
      || !strictlyIncreasing(allocatedSequences)
    ) {
      return fail("append_order_mismatch");
    }
    return {
      streamOrdinal: stream.ordinal,
      committedDistinctProducers:
        SHARED_STATE_OUTBOX_CONFORMANCE_V1.producersPerStream,
      adapterSequenceOrder: adapterSequenceOrder.map((entry) => ({
        allocatedSequence: entry.allocatedSequence,
        producerScheduleRank: entry.producerScheduleRank,
      })),
      uniquePositiveAllocatedSequences: true,
      strictlyIncreasingInAdapterSequenceOrder: true,
      projectionOrder: "adapter-sequence-order",
    } as const;
  });
  const firstPolicy = evaluatePolicy(producerCommands[0]!.command);
  const samePolicy = evaluatePolicy(producerCommands[1]!.command);
  const differentPolicy = evaluatePolicy(producerCommands[4]!.command);
  const sameOrdering = compareSharedStateOutboxOrderingV1(
    firstPolicy,
    samePolicy,
  );
  const crossOrdering = compareSharedStateOutboxOrderingV1(
    firstPolicy,
    differentPolicy,
  );
  if (
    sameOrdering.decision !== "same-stream"
    || sameOrdering.reasonCode !== "same_stream_total_order"
    || crossOrdering.decision !== "different-streams"
    || crossOrdering.reasonCode !== "cross_stream_no_order"
    || crossOrdering.orderingScope !== null
  ) {
    fail("ordering_evaluator_mismatch");
  }
  await closeTarget(orderingTarget);

  // Scenario 2: committed same-key/same-payload retry.
  const retryTarget = await openedTarget();
  const retryCommand = appendCommand(STREAMS[0], 9);
  const retryFirst = await append(retryTarget, retryCommand);
  if (!committedAppend(retryFirst, "appended")) {
    fail("retry_binding_mismatch");
  }
  const retryAfterFirst = await snapshot(retryTarget);
  if (!isSinglePendingUnacknowledged(retryAfterFirst)) {
    fail("retry_binding_mismatch");
  }
  const retrySecond = await append(retryTarget, retryCommand);
  if (
    !committedAppend(retrySecond, "replayed")
    || retrySecond.result.eventKeyDigest
      !== retryFirst.result.eventKeyDigest
    || retrySecond.result.streamSequence
      !== retryFirst.result.streamSequence
  ) {
    fail("retry_binding_mismatch");
  }
  const retryBinding = evaluateSharedStateOutboxRetryBindingV1({
    original: {
      namespace: retryCommand.input.namespace,
      idempotencyKeyDigest: retryCommand.input.idempotencyKeyDigest,
      payloadDigest: retryCommand.input.payloadDigest,
      eventKeyDigest: retryFirst.result.eventKeyDigest,
      streamSequence: retryFirst.result.streamSequence,
    },
    retry: {
      namespace: retryCommand.input.namespace,
      idempotencyKeyDigest: retryCommand.input.idempotencyKeyDigest,
      payloadDigest: retryCommand.input.payloadDigest,
      eventKeyDigest: retrySecond.result.eventKeyDigest,
      streamSequence: retrySecond.result.streamSequence,
    },
  });
  if (
    !retryBinding.ok
    || retryBinding.value.decision !== "original-binding"
    || retryBinding.value.reasonCode
      !== "idempotent_retry_returns_original_binding"
    || !sameSnapshot(retryAfterFirst, await snapshot(retryTarget))
  ) {
    fail("retry_binding_mismatch");
  }
  await closeTarget(retryTarget);

  // Scenario 3: both pre-commit append transaction fault boundaries.
  const appendTransactionFaults:
  SharedStateOutboxConformanceFaultReportV1[] = [];
  for (
    const [faultIndex, faultPoint]
    of SHARED_STATE_OUTBOX_APPEND_FAULT_POINTS_V1.entries()
  ) {
    const faultTarget = await openedTarget();
    const baseline = await snapshot(faultTarget);
    if (!isEmptySnapshot(baseline)) fail("transaction_not_atomic");
    try {
      faultTarget.armFault(faultPoint);
    } catch {
      return fail("target_fault_control_failed");
    }
    const command = appendCommand(STREAMS[0], 10 + faultIndex);
    const faulted = await append(faultTarget, command);
    if (
      faulted.status !== "unavailable"
      || faulted.reasonCode !== "authority_unavailable"
      || !sameSnapshot(baseline, await snapshot(faultTarget))
    ) {
      fail("transaction_not_atomic");
    }
    const clean = await append(faultTarget, command);
    if (
      !committedAppend(clean, "appended")
      || !isSinglePendingUnacknowledged(await snapshot(faultTarget))
    ) {
      fail("transaction_not_atomic");
    }
    appendTransactionFaults.push({
      faultPoint,
      operation: "appendOutbox",
      failedStatus: "unavailable",
      failedReasonCode: "authority_unavailable",
      rollback: "exact-empty-baseline",
      cleanRetryDecision: "appended",
    });
    await closeTarget(faultTarget);
  }

  // Scenario 4: ACK-before-commit preserves confirmed replayability.
  const acknowledgmentTarget = await openedTarget();
  const acknowledgmentAppend = appendCommand(STREAMS[0], 12);
  const acknowledgmentAppended = await append(
    acknowledgmentTarget,
    acknowledgmentAppend,
  );
  if (!committedAppend(acknowledgmentAppended, "appended")) {
    fail("acknowledgment_not_atomic");
  }
  const confirmingReceipt = await updateReceipt(
    acknowledgmentTarget,
    receiptCommand(
      acknowledgmentAppend,
      12,
      "current-session-visible",
    ),
  );
  if (
    confirmingReceipt.status !== "committed"
    || confirmingReceipt.result.decision !== "updated"
    || confirmingReceipt.result.receiptState !== "confirmed"
  ) {
    fail("acknowledgment_not_atomic");
  }
  const beforeAckFault = await snapshot(acknowledgmentTarget);
  if (!isSingleConfirmedUnacknowledged(beforeAckFault)) {
    fail("acknowledgment_not_atomic");
  }
  try {
    acknowledgmentTarget.armFault("ack-before-commit");
  } catch {
    return fail("target_fault_control_failed");
  }
  const ackCommand = acknowledgeCommand(acknowledgmentAppend, 12);
  const faultedAck = await acknowledge(acknowledgmentTarget, ackCommand);
  if (
    faultedAck.status !== "unavailable"
    || faultedAck.reasonCode !== "authority_unavailable"
    || !sameSnapshot(
      beforeAckFault,
      await snapshot(acknowledgmentTarget),
    )
  ) {
    fail("acknowledgment_not_atomic");
  }
  const cleanAck = await acknowledge(acknowledgmentTarget, ackCommand);
  if (
    cleanAck.status !== "committed"
    || cleanAck.result.decision !== "acknowledged"
    || !isSingleConfirmedAcknowledged(
      await snapshot(acknowledgmentTarget),
    )
  ) {
    fail("acknowledgment_not_atomic");
  }
  const afterCleanAck = await snapshot(acknowledgmentTarget);
  const repeatedAck = await acknowledge(acknowledgmentTarget, ackCommand);
  if (
    repeatedAck.status !== "committed"
    || repeatedAck.result.decision !== "already_acknowledged"
    || !sameSnapshot(afterCleanAck, await snapshot(acknowledgmentTarget))
  ) {
    fail("acknowledgment_not_atomic");
  }
  await closeTarget(acknowledgmentTarget);
  const ackFaultReport = {
    faultPoint: "ack-before-commit",
    operation: "acknowledgeOutbox",
    failedStatus: "unavailable",
    failedReasonCode: "authority_unavailable",
    rollback: "confirmed-remains-unacknowledged",
    cleanRetryDecision: "acknowledged",
  } as const;

  // Scenario 5: close/reopen and bounded test-only cursor reconciliation.
  const reconcileTarget = await openedTarget();
  const reconcileCommands = [
    appendCommand(STREAMS[0], 13),
    appendCommand(STREAMS[1], 14),
    appendCommand(STREAMS[0], 15),
    appendCommand(STREAMS[1], 16),
    appendCommand(STREAMS[0], 17),
    appendCommand(STREAMS[1], 18),
  ] as const;
  const reconcileAppends: SharedStateAppendOutboxResultV1[] = [];
  for (const command of reconcileCommands) {
    const result = await append(reconcileTarget, command);
    if (!committedAppend(result, "appended")) {
      fail("reconcile_invariant_mismatch");
    }
    reconcileAppends.push(result);
  }
  const firstReconcileReceipt = await updateReceipt(
    reconcileTarget,
    receiptCommand(reconcileCommands[0], 13, "current-session-visible"),
  );
  const firstReconcileAck = await acknowledge(
    reconcileTarget,
    acknowledgeCommand(reconcileCommands[0], 13),
  );
  const confirmedUnacknowledgedReceipt = await updateReceipt(
    reconcileTarget,
    receiptCommand(reconcileCommands[4], 17, "current-session-visible"),
  );
  if (
    firstReconcileReceipt.status !== "committed"
    || firstReconcileReceipt.result.receiptState !== "confirmed"
    || firstReconcileAck.status !== "committed"
    || firstReconcileAck.result.decision !== "acknowledged"
    || confirmedUnacknowledgedReceipt.status !== "committed"
    || confirmedUnacknowledgedReceipt.result.receiptState !== "confirmed"
  ) {
    fail("reconcile_invariant_mismatch");
  }
  const beforeReopen = await snapshot(reconcileTarget);
  if (
    beforeReopen.domainEffectCount !== 6
    || beforeReopen.outboxEventCount !== 6
    || beforeReopen.receiptPendingCount !== 4
    || beforeReopen.receiptConfirmedCount !== 2
    || beforeReopen.unacknowledgedCount !== 5
    || beforeReopen.acknowledgedCount !== 1
  ) {
    fail("reconcile_invariant_mismatch");
  }
  await closeTarget(reconcileTarget);
  requireReady(await lifecycle(() => reconcileTarget.open()));
  if (!sameSnapshot(beforeReopen, await snapshot(reconcileTarget))) {
    fail("reopen_snapshot_mismatch");
  }
  const reconcileResponses = [
    await reconcile(reconcileTarget, cursor("0", "0")),
    await reconcile(reconcileTarget, cursor("1", "1")),
    await reconcile(reconcileTarget, cursor("3", "3")),
  ] as const;
  const expectedResponseCounts = [5, 4, 0] as const;
  const acknowledgedEventKey = reconcileCommands[0].input.eventKeyDigest;
  const confirmedUnacknowledgedEventKey =
    reconcileCommands[4].input.eventKeyDigest;
  for (
    let responseIndex = 0;
    responseIndex < reconcileResponses.length;
    responseIndex += 1
  ) {
    const response = reconcileResponses[responseIndex]!;
    if (
      response.events.length !== expectedResponseCounts[responseIndex]
      || new Set(
        response.events.map((event) => event.eventKeyDigest),
      ).size !== response.events.length
      || response.events.some((event) => (
        event.acknowledgmentState !== "unacknowledged"
        || event.eventKeyDigest === acknowledgedEventKey
      ))
    ) {
      fail("reconcile_invariant_mismatch");
    }
    for (const stream of STREAMS) {
      const sequences = response.events
        .filter(
          (event) => event.streamKeyDigest === stream.streamKeyDigest,
        )
        .map((event) => event.streamSequence);
      if (!strictlyIncreasing(sequences)) {
        fail("reconcile_invariant_mismatch");
      }
    }
  }
  if (
    !reconcileResponses[0].events.some((event) => (
      event.eventKeyDigest === confirmedUnacknowledgedEventKey
      && event.receiptState === "confirmed"
    ))
    || !reconcileResponses[1].events.some((event) => (
      event.eventKeyDigest === confirmedUnacknowledgedEventKey
      && event.receiptState === "confirmed"
    ))
  ) {
    fail("reconcile_invariant_mismatch");
  }
  await closeTarget(reconcileTarget);

  // Scenario 6: provider acceptance stays pending and cannot parse as ACK.
  const providerTarget = await openedTarget();
  const providerAppend = appendCommand(STREAMS[0], 19);
  const providerAppended = await append(providerTarget, providerAppend);
  if (!committedAppend(providerAppended, "appended")) {
    fail("provider_acceptance_mismatch");
  }
  const providerReceipt = await updateReceipt(
    providerTarget,
    receiptCommand(providerAppend, 19, "provider-accepted"),
  );
  if (
    providerReceipt.status !== "committed"
    || providerReceipt.result.decision !== "updated"
    || providerReceipt.result.receiptState !== "pending"
    || !isSinglePendingUnacknowledged(await snapshot(providerTarget))
  ) {
    fail("provider_acceptance_mismatch");
  }
  parserPolicyAttemptCount += 1;
  checkOperationLimit();
  const providerAckInput = acknowledgmentInput(
    providerAppend,
    19,
    "provider-accepted",
  );
  const providerPolicy = evaluateSharedStateOutboxPolicyV1({
    operation: "acknowledgeOutbox",
    namespace: providerAckInput.namespace,
    eventPurpose: providerAckInput.eventPurpose,
    streamKey: providerAckInput.streamKey,
    streamKeyDigest: providerAckInput.streamKeyDigest,
    orderingScope: providerAckInput.orderingScope,
    retentionPolicyVersion: providerAckInput.retentionPolicyVersion,
    receiptPolicyVersion: providerAckInput.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      providerAckInput.acknowledgmentPolicyVersion,
    receiptEvidenceKind: providerAckInput.receiptEvidenceKind,
    expectedReceiptState: providerAckInput.expectedReceiptState,
    expectedAcknowledgmentState:
      providerAckInput.expectedAcknowledgmentState,
  });
  const providerParser = parseSharedStateTransactionCommandV1(
    rawCommand("acknowledgeOutbox", providerAckInput),
  );
  if (
    providerPolicy.ok
    || providerPolicy.error.code !== "provider_acceptance_not_ack"
    || providerParser.ok
    || providerParser.error.code
      !== "outbox_provider_acceptance_not_ack"
    || !isSinglePendingUnacknowledged(await snapshot(providerTarget))
  ) {
    fail("provider_acceptance_mismatch");
  }
  await closeTarget(providerTarget);

  const operationCount = targetCommandCount
    + reconcileControlCount
    + parserPolicyAttemptCount;
  if (
    targetCount !== SHARED_STATE_OUTBOX_CONFORMANCE_V1.targetCount
    || targetCommandCount
      !== SHARED_STATE_OUTBOX_CONFORMANCE_V1.targetCommandCount
    || reconcileControlCount
      !== SHARED_STATE_OUTBOX_CONFORMANCE_V1.reconcileControlCount
    || parserPolicyAttemptCount
      !== SHARED_STATE_OUTBOX_CONFORMANCE_V1.parserPolicyAttemptCount
    || operationCount
      !== SHARED_STATE_OUTBOX_CONFORMANCE_V1.expectedOperationCount
  ) {
    fail("operation_limit_exceeded");
  }

  const report = {
    kind: SHARED_STATE_OUTBOX_CONFORMANCE_V1.kind,
    harnessVersion: SHARED_STATE_OUTBOX_CONFORMANCE_V1.harnessVersion,
    contractVersion: V.versions.contract,
    scope: SHARED_STATE_OUTBOX_CONFORMANCE_V1.scope,
    status: "passed",
    scheduler: {
      kind: "seeded-deterministic",
      seed: SHARED_STATE_OUTBOX_CONFORMANCE_V1.schedulerSeed,
      barrier: "explicit-promise",
      clock: "not-required-no-time-semantics",
      targetIsolation: "factory-created-per-scenario",
      targetCount,
      targetCommandCount,
      reconcileControlCount,
      parserPolicyAttemptCount,
      operationLimit: SHARED_STATE_OUTBOX_CONFORMANCE_V1.operationLimit,
      operationCount,
    },
    registry: {
      status: "closed-registered-policy",
      sequenceAuthority: OUTBOX_REGISTRATION.sequenceAuthority,
      orderingScope: OUTBOX_REGISTRATION.orderingScope,
      crossStreamOrder: OUTBOX_REGISTRATION.crossStreamOrder,
    },
    producerOrdering: {
      streamCount: SHARED_STATE_OUTBOX_CONFORMANCE_V1.streamCount,
      producersPerStream:
        SHARED_STATE_OUTBOX_CONFORMANCE_V1.producersPerStream,
      committedAppends: SHARED_STATE_OUTBOX_CONFORMANCE_V1.producerCount,
      perStream,
      sameStreamEvaluator: "same_stream_total_order",
      crossStreamEvaluator: "cross_stream_no_order",
      callerFairnessAssertion: "none",
      globalCrossStreamOrderingAssertion: "none",
    },
    retry: {
      firstDecision: "appended",
      retryDecision: "replayed",
      eventKeyBinding: "original",
      streamSequenceBinding: "original",
      bindingDecision: "original-binding",
      bindingReasonCode:
        "idempotent_retry_returns_original_binding",
      secondEventEffect: "none",
      secondDomainEffect: "none",
    },
    appendTransactionFaults,
    acknowledgment: {
      confirmingEvidence: "current-session-visible",
      beforeFault: "receipt-confirmed-unacknowledged",
      fault: ackFaultReport,
      stateAfterFault: "receipt-confirmed-unacknowledged",
      retryDecision: "acknowledged",
      secondRetryDecision: "already_acknowledged",
      duplicateEffect: "none",
    },
    reconciliation: {
      controlScope: "test-only-conformance-control",
      storageQueryContract: "none",
      runtimeApi: "none",
      closeReopenState: "preserved",
      cursorSet: ["start", "intermediate-per-stream", "end"],
      responseEventCounts: expectedResponseCounts,
      perStreamSequenceReversal: false,
      duplicateEventIdWithinResponse: false,
      unacknowledgedReplay: "proved",
      acknowledgedReplayBeyondCursor: "none",
      receiptAcknowledgmentState: "preserved",
      globalCrossStreamCursorOrderAssertion: "none",
    },
    providerAcceptance: {
      receiptEvidenceKind: "provider-accepted",
      receiptState: "pending",
      acknowledgmentState: "unacknowledged",
      policyErrorCode: "provider_acceptance_not_ack",
      parserErrorCode: "outbox_provider_acceptance_not_ack",
      receiptConfirmedAck: false,
    },
  } as const;
  const parsed = sharedStateOutboxConformanceReportV1Schema.safeParse(
    report,
  );
  if (!parsed.success) return fail("report_invalid");
  return deepFreeze(parsed.data);
}
