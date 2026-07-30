/**
 * TEST-ONLY deterministic outbox-ordering reference model.
 *
 * This detached in-memory model is non-production, non-SQLite, non-shared,
 * non-conforming, and not durable or connected to broker runtime. It exists
 * only in this adjacent test file to prove that the backend-neutral Phase 2.3
 * harness detects the required append, receipt, ACK, and reconciliation
 * invariants.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  evaluateSharedStateOutboxPolicyV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  type SharedStateStorageLifecycleV1,
} from "./shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_OUTBOX_APPEND_FAULT_POINTS_V1,
  SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1,
  SHARED_STATE_OUTBOX_CONFORMANCE_V1,
  SharedStateOutboxConformanceErrorV1,
  runSharedStateOutboxConformanceV1,
  seededDeterministicOutboxOrderV1,
  sharedStateOutboxConformanceCursorV1Schema,
  sharedStateOutboxConformanceErrorReportV1Schema,
  sharedStateOutboxConformanceFaultReportV1Schema,
  sharedStateOutboxConformanceReconcileResponseV1Schema,
  sharedStateOutboxConformanceReportV1Schema,
  sharedStateOutboxConformanceSnapshotV1Schema,
  type SharedStateAcknowledgeOutboxCommandV1,
  type SharedStateAcknowledgeOutboxResultV1,
  type SharedStateAppendOutboxCommandV1,
  type SharedStateAppendOutboxResultV1,
  type SharedStateOutboxConformanceCursorV1,
  type SharedStateOutboxConformanceFaultPointV1,
  type SharedStateOutboxConformanceTargetFactoryV1,
  type SharedStateOutboxConformanceTargetV1,
  type SharedStateUpdateOutboxReceiptCommandV1,
  type SharedStateUpdateOutboxReceiptResultV1,
} from "./shared-state-outbox-conformance-v1.js";

const TEST_ONLY_DETERMINISTIC_OUTBOX_REFERENCE_MODEL_V1 = Object.freeze({
  role: "test-only-deterministic-reference-model",
  inMemoryOnly: true,
  detached: true,
  productionAdapter: false,
  sqliteAdapter: false,
  sharedAdapter: false,
  conformingAdapterClaim: false,
  durabilityClaim: false,
  runtimeIntegration: "not-attached",
} as const);

type ReceiptState = (typeof V.receiptStates)[number];
type AcknowledgmentState = (typeof V.acknowledgmentStates)[number];

interface EventRecord {
  readonly namespace: string;
  readonly streamKeyDigest: string;
  readonly idempotencyKeyDigest: string;
  readonly eventKeyDigest: string;
  readonly payloadDigest: string;
  readonly streamSequence: string;
  receiptState: ReceiptState;
  acknowledgmentState: AcknowledgmentState;
  providerAcceptanceObserved: boolean;
}

interface IdempotencyRecord {
  readonly namespace: string;
  readonly streamKeyDigest: string;
  readonly payloadDigest: string;
  readonly eventKeyDigest: string;
  readonly streamSequence: string;
}

interface StreamRecord {
  highWater: bigint;
  eventKeys: string[];
}

interface ModelState {
  domainEffectCount: number;
  streams: Map<string, StreamRecord>;
  events: Map<string, EventRecord>;
  idempotency: Map<string, IdempotencyRecord>;
}

function invariant(): never {
  throw new SharedStateOutboxConformanceErrorV1(
    "reference_model_invariant",
  );
}

function initialState(): ModelState {
  return {
    domainEffectCount: 0,
    streams: new Map(),
    events: new Map(),
    idempotency: new Map(),
  };
}

function cloneState(state: ModelState): ModelState {
  return {
    domainEffectCount: state.domainEffectCount,
    streams: new Map(
      [...state.streams].map(([key, stream]) => [
        key,
        {
          highWater: stream.highWater,
          eventKeys: [...stream.eventKeys],
        },
      ]),
    ),
    events: new Map(
      [...state.events].map(([key, event]) => [
        key,
        { ...event },
      ]),
    ),
    idempotency: new Map(
      [...state.idempotency].map(([key, binding]) => [
        key,
        { ...binding },
      ]),
    ),
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

function appendResult(
  body: Record<string, unknown>,
): SharedStateAppendOutboxResultV1 {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "appendOutbox",
    consistency: V.operationConsistency.appendOutbox,
    ...body,
  });
  if (!parsed.ok || parsed.value.operation !== "appendOutbox") {
    return invariant();
  }
  return parsed.value;
}

function receiptResult(
  body: Record<string, unknown>,
): SharedStateUpdateOutboxReceiptResultV1 {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "updateOutboxReceipt",
    consistency: V.operationConsistency.updateOutboxReceipt,
    ...body,
  });
  if (!parsed.ok || parsed.value.operation !== "updateOutboxReceipt") {
    return invariant();
  }
  return parsed.value;
}

function acknowledgmentResult(
  body: Record<string, unknown>,
): SharedStateAcknowledgeOutboxResultV1 {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "acknowledgeOutbox",
    consistency: V.operationConsistency.acknowledgeOutbox,
    ...body,
  });
  if (!parsed.ok || parsed.value.operation !== "acknowledgeOutbox") {
    return invariant();
  }
  return parsed.value;
}

function appendUnavailable(): SharedStateAppendOutboxResultV1 {
  return appendResult({
    status: "unavailable",
    completeness: "unavailable",
    reasonCode: "authority_unavailable",
  });
}

function acknowledgmentUnavailable():
SharedStateAcknowledgeOutboxResultV1 {
  return acknowledgmentResult({
    status: "unavailable",
    completeness: "unavailable",
    reasonCode: "authority_unavailable",
  });
}

function policyInput(
  command:
    | SharedStateAppendOutboxCommandV1
    | SharedStateUpdateOutboxReceiptCommandV1
    | SharedStateAcknowledgeOutboxCommandV1,
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

function requireValidCommand(
  command:
    | SharedStateAppendOutboxCommandV1
    | SharedStateUpdateOutboxReceiptCommandV1
    | SharedStateAcknowledgeOutboxCommandV1,
): void {
  const parsed = parseSharedStateTransactionCommandV1(command);
  const policy = evaluateSharedStateOutboxPolicyV1(policyInput(command));
  if (
    !parsed.ok
    || parsed.value.operation !== command.operation
    || !policy.ok
    || policy.value.operation !== command.operation
  ) {
    invariant();
  }
}

/**
 * Bounded in-memory state used only by this test. Close/reopen intentionally
 * retains this object state for continuity proof; that is not a durability or
 * adapter-conformance claim.
 */
class TestOnlyDeterministicOutboxReferenceModelV1
implements SharedStateOutboxConformanceTargetV1 {
  #state = initialState();
  #open = false;
  #armedFault: SharedStateOutboxConformanceFaultPointV1 | null = null;
  #transactionTail: Promise<void> = Promise.resolve();
  #reverseInitialAppendBatchSize: number;
  #pendingInitialAppends: Array<{
    readonly command: SharedStateAppendOutboxCommandV1;
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason?: unknown) => void;
  }> = [];

  constructor(reverseInitialAppendBatchSize = 0) {
    this.#reverseInitialAppendBatchSize = reverseInitialAppendBatchSize;
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

  armFault(faultPoint: SharedStateOutboxConformanceFaultPointV1): void {
    if (
      this.#armedFault !== null
      || !SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1.includes(
        faultPoint,
      )
    ) {
      invariant();
    }
    this.#armedFault = faultPoint;
  }

  async snapshot(): Promise<unknown> {
    let receiptPendingCount = 0;
    let receiptConfirmedCount = 0;
    let receiptFailedCount = 0;
    let unacknowledgedCount = 0;
    let acknowledgedCount = 0;
    for (const event of this.#state.events.values()) {
      if (event.receiptState === "pending") receiptPendingCount += 1;
      else if (event.receiptState === "confirmed") {
        receiptConfirmedCount += 1;
      } else {
        receiptFailedCount += 1;
      }
      if (event.acknowledgmentState === "unacknowledged") {
        unacknowledgedCount += 1;
      } else {
        acknowledgedCount += 1;
      }
    }
    const value = {
      kind: "SharedStateOutboxConformanceSnapshotV1",
      snapshotVersion: 1,
      domainEffectCount: this.#state.domainEffectCount,
      outboxEventCount: this.#state.events.size,
      receiptPendingCount,
      receiptConfirmedCount,
      receiptFailedCount,
      unacknowledgedCount,
      acknowledgedCount,
    } as const;
    const parsed =
      sharedStateOutboxConformanceSnapshotV1Schema.safeParse(value);
    if (!parsed.success) return invariant();
    return parsed.data;
  }

  async appendOutbox(
    command: SharedStateAppendOutboxCommandV1,
  ): Promise<unknown> {
    if (this.#reverseInitialAppendBatchSize > 0) {
      return new Promise((resolve, reject) => {
        this.#pendingInitialAppends.push({ command, resolve, reject });
        if (
          this.#pendingInitialAppends.length
          === this.#reverseInitialAppendBatchSize
        ) {
          const pending = this.#pendingInitialAppends.splice(0).reverse();
          this.#reverseInitialAppendBatchSize = 0;
          for (const entry of pending) {
            void this.#serialize(
              () => this.#appendNow(entry.command),
            ).then(entry.resolve, entry.reject);
          }
        }
      });
    }
    return this.#serialize(() => this.#appendNow(command));
  }

  async updateOutboxReceipt(
    command: SharedStateUpdateOutboxReceiptCommandV1,
  ): Promise<unknown> {
    return this.#serialize(() => this.#updateReceiptNow(command));
  }

  async acknowledgeOutbox(
    command: SharedStateAcknowledgeOutboxCommandV1,
  ): Promise<unknown> {
    return this.#serialize(() => this.#acknowledgeNow(command));
  }

  async reconcileConformanceControl(
    cursor: SharedStateOutboxConformanceCursorV1,
  ): Promise<unknown> {
    if (!this.#open) return invariant();
    const parsed =
      sharedStateOutboxConformanceCursorV1Schema.safeParse(cursor);
    if (!parsed.success) return invariant();
    const streamKeys = new Set(
      parsed.data.positions.map((position) => position.streamKeyDigest),
    );
    if (
      streamKeys.size !== parsed.data.positions.length
      || parsed.data.positions.length !== this.#state.streams.size
    ) {
      return invariant();
    }
    const events: Array<{
      streamKeyDigest: string;
      eventKeyDigest: string;
      streamSequence: string;
      receiptState: ReceiptState;
      acknowledgmentState: AcknowledgmentState;
    }> = [];
    for (const position of parsed.data.positions) {
      const stream = this.#state.streams.get(position.streamKeyDigest);
      if (stream === undefined) return invariant();
      let contiguousAcknowledgedThrough = 0n;
      for (const eventKey of stream.eventKeys) {
        const event = this.#state.events.get(eventKey);
        if (event === undefined) return invariant();
        if (
          event.acknowledgmentState !== "acknowledged"
          || BigInt(event.streamSequence)
            !== contiguousAcknowledgedThrough + 1n
        ) {
          break;
        }
        contiguousAcknowledgedThrough = BigInt(event.streamSequence);
      }
      if (
        BigInt(position.acknowledgedThroughSequence)
          !== contiguousAcknowledgedThrough
      ) {
        return invariant();
      }
      const threshold =
        BigInt(position.afterSequence) > contiguousAcknowledgedThrough
          ? BigInt(position.afterSequence)
          : contiguousAcknowledgedThrough;
      for (const eventKey of stream.eventKeys) {
        const event = this.#state.events.get(eventKey);
        if (event === undefined) return invariant();
        if (
          BigInt(event.streamSequence) > threshold
          && event.acknowledgmentState === "unacknowledged"
        ) {
          events.push({
            streamKeyDigest: event.streamKeyDigest,
            eventKeyDigest: event.eventKeyDigest,
            streamSequence: event.streamSequence,
            receiptState: event.receiptState,
            acknowledgmentState: event.acknowledgmentState,
          });
        }
      }
    }
    const response = {
      kind: "SharedStateOutboxConformanceReconcileResponseV1",
      responseVersion: 1,
      scope: "test-only-conformance-control",
      events,
    } as const;
    const parsedResponse =
      sharedStateOutboxConformanceReconcileResponseV1Schema.safeParse(
        response,
      );
    if (!parsedResponse.success) return invariant();
    return parsedResponse.data;
  }

  async #serialize<T>(operation: () => T): Promise<T> {
    const predecessor = this.#transactionTail;
    let release!: () => void;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return operation();
    } finally {
      release();
    }
  }

  #appendNow(
    command: SharedStateAppendOutboxCommandV1,
  ): SharedStateAppendOutboxResultV1 {
    requireValidCommand(command);
    if (!this.#open) return appendUnavailable();
    const existing = this.#state.idempotency.get(
      command.input.idempotencyKeyDigest,
    );
    if (existing !== undefined) {
      if (
        existing.namespace !== command.input.namespace
        || existing.streamKeyDigest !== command.input.streamKeyDigest
        || existing.payloadDigest !== command.input.payloadDigest
      ) {
        return appendResult({
          status: "rejected",
          completeness: "complete",
          reasonCode: "idempotency_conflict",
        });
      }
      return appendResult({
        status: "committed",
        completeness: "complete",
        result: {
          decision: "replayed",
          eventKeyDigest: existing.eventKeyDigest,
          streamSequence: existing.streamSequence,
        },
      });
    }
    if (this.#state.events.has(command.input.eventKeyDigest)) {
      return appendResult({
        status: "rejected",
        completeness: "complete",
        reasonCode: "idempotency_conflict",
      });
    }

    const fault = this.#armedFault;
    this.#armedFault = null;
    const working = cloneState(this.#state);
    working.domainEffectCount += 1;
    if (fault === "domain-before-append") return appendUnavailable();

    const stream = working.streams.get(command.input.streamKeyDigest) ?? {
      highWater: 0n,
      eventKeys: [],
    };
    stream.highWater += 1n;
    const streamSequence = stream.highWater.toString();
    stream.eventKeys.push(command.input.eventKeyDigest);
    working.streams.set(command.input.streamKeyDigest, stream);
    const event: EventRecord = {
      namespace: command.input.namespace,
      streamKeyDigest: command.input.streamKeyDigest,
      idempotencyKeyDigest: command.input.idempotencyKeyDigest,
      eventKeyDigest: command.input.eventKeyDigest,
      payloadDigest: command.input.payloadDigest,
      streamSequence,
      receiptState: "pending",
      acknowledgmentState: "unacknowledged",
      providerAcceptanceObserved: false,
    };
    working.events.set(event.eventKeyDigest, event);
    working.idempotency.set(event.idempotencyKeyDigest, {
      namespace: event.namespace,
      streamKeyDigest: event.streamKeyDigest,
      payloadDigest: event.payloadDigest,
      eventKeyDigest: event.eventKeyDigest,
      streamSequence: event.streamSequence,
    });
    if (fault === "append-before-commit") return appendUnavailable();
    if (fault !== null) return invariant();

    this.#state = working;
    return appendResult({
      status: "committed",
      completeness: "complete",
      result: {
        decision: "appended",
        eventKeyDigest: event.eventKeyDigest,
        streamSequence: event.streamSequence,
      },
    });
  }

  #updateReceiptNow(
    command: SharedStateUpdateOutboxReceiptCommandV1,
  ): SharedStateUpdateOutboxReceiptResultV1 {
    requireValidCommand(command);
    if (!this.#open) {
      return receiptResult({
        status: "unavailable",
        completeness: "unavailable",
        reasonCode: "authority_unavailable",
      });
    }
    const existing = this.#state.events.get(command.input.eventKeyDigest);
    if (
      existing === undefined
      || existing.streamKeyDigest !== command.input.streamKeyDigest
    ) {
      return receiptResult({
        status: "rejected",
        completeness: "complete",
        reasonCode: "event_not_found",
      });
    }
    if (existing.receiptState !== command.input.expectedReceiptState) {
      return receiptResult({
        status: "rejected",
        completeness: "complete",
        reasonCode: "receipt_state_conflict",
      });
    }
    const working = cloneState(this.#state);
    const event = working.events.get(command.input.eventKeyDigest);
    if (event === undefined) return invariant();
    event.receiptState = command.input.newReceiptState;
    event.providerAcceptanceObserved =
      command.input.receiptEvidenceKind === "provider-accepted";
    this.#state = working;
    return receiptResult({
      status: "committed",
      completeness: "complete",
      result: {
        decision: "updated",
        receiptState: event.receiptState,
      },
    });
  }

  #acknowledgeNow(
    command: SharedStateAcknowledgeOutboxCommandV1,
  ): SharedStateAcknowledgeOutboxResultV1 {
    requireValidCommand(command);
    if (!this.#open) return acknowledgmentUnavailable();
    const existing = this.#state.events.get(command.input.eventKeyDigest);
    if (
      existing === undefined
      || existing.streamKeyDigest !== command.input.streamKeyDigest
    ) {
      return acknowledgmentResult({
        status: "rejected",
        completeness: "complete",
        reasonCode: "event_not_found",
      });
    }
    if (existing.acknowledgmentState === "acknowledged") {
      return acknowledgmentResult({
        status: "committed",
        completeness: "complete",
        result: {
          decision: "already_acknowledged",
          acknowledgmentState: "acknowledged",
        },
      });
    }
    if (existing.receiptState !== "confirmed") {
      return acknowledgmentResult({
        status: "rejected",
        completeness: "complete",
        reasonCode: "receipt_not_confirmed",
      });
    }
    if (
      existing.acknowledgmentState
        !== command.input.expectedAcknowledgmentState
    ) {
      return acknowledgmentResult({
        status: "rejected",
        completeness: "complete",
        reasonCode: "ack_state_conflict",
      });
    }

    const fault = this.#armedFault;
    this.#armedFault = null;
    const working = cloneState(this.#state);
    const event = working.events.get(command.input.eventKeyDigest);
    if (event === undefined) return invariant();
    event.acknowledgmentState = "acknowledged";
    if (fault === "ack-before-commit") {
      return acknowledgmentUnavailable();
    }
    if (fault !== null) return invariant();
    this.#state = working;
    return acknowledgmentResult({
      status: "committed",
      completeness: "complete",
      result: {
        decision: "acknowledged",
        acknowledgmentState: "acknowledged",
      },
    });
  }
}

function createTestOnlyDeterministicOutboxReferenceModelFactoryV1():
SharedStateOutboxConformanceTargetFactoryV1 {
  let targetOrdinal = 0;
  return Object.freeze({
    async create() {
      targetOrdinal += 1;
      return new TestOnlyDeterministicOutboxReferenceModelV1(
        targetOrdinal === 1
          ? SHARED_STATE_OUTBOX_CONFORMANCE_V1.producerCount
          : 0,
      );
    },
  });
}

const EXPECTED_REPORT = {
  kind: "SharedStateOutboxConformanceReportV1",
  harnessVersion: 1,
  contractVersion: "a2a.shared-state.storage/v1",
  scope: "outbox-ordering-receipt-ack",
  status: "passed",
  scheduler: {
    kind: "seeded-deterministic",
    seed: 1504,
    barrier: "explicit-promise",
    clock: "not-required-no-time-semantics",
    targetIsolation: "factory-created-per-scenario",
    targetCount: 7,
    targetCommandCount: 30,
    reconcileControlCount: 3,
    parserPolicyAttemptCount: 1,
    operationLimit: 40,
    operationCount: 34,
  },
  registry: {
    status: "closed-registered-policy",
    sequenceAuthority: "adapter-allocated-per-exact-stream-key",
    orderingScope: "total-within-exact-stream-key",
    crossStreamOrder: "no-global-cross-stream-order",
  },
  producerOrdering: {
    streamCount: 2,
    producersPerStream: 4,
    committedAppends: 8,
    perStream: [
      {
        streamOrdinal: 1,
        committedDistinctProducers: 4,
        adapterSequenceOrder: [
          { allocatedSequence: "1", producerScheduleRank: 5 },
          { allocatedSequence: "2", producerScheduleRank: 4 },
          { allocatedSequence: "3", producerScheduleRank: 2 },
          { allocatedSequence: "4", producerScheduleRank: 1 },
        ],
        uniquePositiveAllocatedSequences: true,
        strictlyIncreasingInAdapterSequenceOrder: true,
        projectionOrder: "adapter-sequence-order",
      },
      {
        streamOrdinal: 2,
        committedDistinctProducers: 4,
        adapterSequenceOrder: [
          { allocatedSequence: "1", producerScheduleRank: 8 },
          { allocatedSequence: "2", producerScheduleRank: 7 },
          { allocatedSequence: "3", producerScheduleRank: 6 },
          { allocatedSequence: "4", producerScheduleRank: 3 },
        ],
        uniquePositiveAllocatedSequences: true,
        strictlyIncreasingInAdapterSequenceOrder: true,
        projectionOrder: "adapter-sequence-order",
      },
    ],
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
    bindingReasonCode: "idempotent_retry_returns_original_binding",
    secondEventEffect: "none",
    secondDomainEffect: "none",
  },
  appendTransactionFaults: [
    {
      faultPoint: "domain-before-append",
      operation: "appendOutbox",
      failedStatus: "unavailable",
      failedReasonCode: "authority_unavailable",
      rollback: "exact-empty-baseline",
      cleanRetryDecision: "appended",
    },
    {
      faultPoint: "append-before-commit",
      operation: "appendOutbox",
      failedStatus: "unavailable",
      failedReasonCode: "authority_unavailable",
      rollback: "exact-empty-baseline",
      cleanRetryDecision: "appended",
    },
  ],
  acknowledgment: {
    confirmingEvidence: "current-session-visible",
    beforeFault: "receipt-confirmed-unacknowledged",
    fault: {
      faultPoint: "ack-before-commit",
      operation: "acknowledgeOutbox",
      failedStatus: "unavailable",
      failedReasonCode: "authority_unavailable",
      rollback: "confirmed-remains-unacknowledged",
      cleanRetryDecision: "acknowledged",
    },
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
    responseEventCounts: [5, 4, 0],
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

const TEST_STREAM_DIGEST =
  `a2a.shared-state.keyspace/v1|broker.outbox.stream-key|broker.terminal-outbox|sha256:${"a".repeat(64)}`;
const TEST_SECOND_STREAM_DIGEST =
  `a2a.shared-state.keyspace/v1|broker.outbox.stream-key|broker.terminal-outbox|sha256:${"b".repeat(64)}`;
const TEST_EVENT_DIGEST =
  `a2a.shared-state.keyspace/v1|broker.outbox.event-key|broker.terminal-outbox|sha256:${"c".repeat(64)}`;

const VALID_CURSOR = {
  kind: "SharedStateOutboxConformanceCursorV1",
  cursorVersion: 1,
  scope: "test-only-conformance-control",
  positions: [
    {
      streamKeyDigest: TEST_STREAM_DIGEST,
      afterSequence: "0",
      acknowledgedThroughSequence: "0",
    },
    {
      streamKeyDigest: TEST_SECOND_STREAM_DIGEST,
      afterSequence: "0",
      acknowledgedThroughSequence: "0",
    },
  ],
} as const;

test("labels the deterministic outbox model as test-only and detached", () => {
  assert.deepEqual(TEST_ONLY_DETERMINISTIC_OUTBOX_REFERENCE_MODEL_V1, {
    role: "test-only-deterministic-reference-model",
    inMemoryOnly: true,
    detached: true,
    productionAdapter: false,
    sqliteAdapter: false,
    sharedAdapter: false,
    conformingAdapterClaim: false,
    durabilityClaim: false,
    runtimeIntegration: "not-attached",
  });
  assert.equal(
    Object.isFrozen(TEST_ONLY_DETERMINISTIC_OUTBOX_REFERENCE_MODEL_V1),
    true,
  );
});

test("proves the exact bounded Phase 2.3 outbox report", async () => {
  const report = await runSharedStateOutboxConformanceV1(
    createTestOnlyDeterministicOutboxReferenceModelFactoryV1(),
  );
  assert.deepEqual(report, EXPECTED_REPORT);
  assert.deepEqual(
    report.appendTransactionFaults.map(({ faultPoint }) => faultPoint),
    SHARED_STATE_OUTBOX_APPEND_FAULT_POINTS_V1,
  );
  assert.equal(
    report.producerOrdering.globalCrossStreamOrderingAssertion,
    "none",
  );
  assert.equal(report.producerOrdering.callerFairnessAssertion, "none");
  assert.equal(
    collectKeys(report).includes("producerReleaseRanks"),
    false,
  );
  assert.equal(
    JSON.stringify(report).includes("seeded-release-order"),
    false,
  );
  for (const stream of report.producerOrdering.perStream) {
    const ranks = stream.adapterSequenceOrder.map(
      ({ producerScheduleRank }) => producerScheduleRank,
    );
    assert.equal(
      ranks.some((rank, index) => (
        index > 0 && rank < ranks[index - 1]!
      )),
      true,
    );
  }
  assert.equal(
    report.reconciliation.globalCrossStreamCursorOrderAssertion,
    "none",
  );
  assertDeepFrozen(report);
});

test("is deterministic across isolated factory-created runs", async () => {
  const first = await runSharedStateOutboxConformanceV1(
    createTestOnlyDeterministicOutboxReferenceModelFactoryV1(),
  );
  const second = await runSharedStateOutboxConformanceV1(
    createTestOnlyDeterministicOutboxReferenceModelFactoryV1(),
  );
  assert.deepEqual(first, second);
});

test("uses a repeatable seeded schedule and exact bounded counts", () => {
  const first = seededDeterministicOutboxOrderV1(8);
  const second = seededDeterministicOutboxOrderV1(8);
  assert.deepEqual(first, second);
  assert.equal(first.length, 8);
  assert.equal(new Set(first).size, 8);
  assert.equal(
    EXPECTED_REPORT.scheduler.operationCount
      <= EXPECTED_REPORT.scheduler.operationLimit,
    true,
  );
  assert.equal(
    EXPECTED_REPORT.scheduler.targetCommandCount
      + EXPECTED_REPORT.scheduler.reconcileControlCount
      + EXPECTED_REPORT.scheduler.parserPolicyAttemptCount,
    EXPECTED_REPORT.scheduler.operationCount,
  );
  assert.equal(
    SHARED_STATE_OUTBOX_CONFORMANCE_V1.producersPerStream,
    4,
  );
});

test("keeps report, snapshot, cursor, control, fault, and error schemas closed", async () => {
  assert.equal(
    sharedStateOutboxConformanceReportV1Schema.safeParse({
      ...EXPECTED_REPORT,
      reflectedValue: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    sharedStateOutboxConformanceReportV1Schema.safeParse({
      ...EXPECTED_REPORT,
      producerOrdering: {
        ...EXPECTED_REPORT.producerOrdering,
        callerFairnessAssertion: "first-caller",
      },
    }).success,
    false,
  );
  assert.equal(
    sharedStateOutboxConformanceSnapshotV1Schema.safeParse({
      kind: "SharedStateOutboxConformanceSnapshotV1",
      snapshotVersion: 1,
      domainEffectCount: 0,
      outboxEventCount: 0,
      receiptPendingCount: 0,
      receiptConfirmedCount: 0,
      receiptFailedCount: 0,
      unacknowledgedCount: 0,
      acknowledgedCount: 0,
      hostPath: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    sharedStateOutboxConformanceCursorV1Schema.safeParse({
      ...VALID_CURSOR,
      runtimeQuery: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    sharedStateOutboxConformanceReconcileResponseV1Schema.safeParse({
      kind: "SharedStateOutboxConformanceReconcileResponseV1",
      responseVersion: 1,
      scope: "test-only-conformance-control",
      events: [
        {
          streamKeyDigest: TEST_STREAM_DIGEST,
          eventKeyDigest: TEST_EVENT_DIGEST,
          streamSequence: "1",
          receiptState: "pending",
          acknowledgmentState: "unacknowledged",
          payload: "forbidden",
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    sharedStateOutboxConformanceFaultReportV1Schema.safeParse({
      ...EXPECTED_REPORT.appendTransactionFaults[0],
      secret: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    sharedStateOutboxConformanceErrorReportV1Schema.safeParse({
      kind: "SharedStateOutboxConformanceErrorV1",
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
    runSharedStateOutboxConformanceV1({
      async create() {
        throw new Error(sentinel);
      },
    }),
    (error: unknown) => {
      assert.equal(
        error instanceof SharedStateOutboxConformanceErrorV1,
        true,
      );
      if (!(error instanceof SharedStateOutboxConformanceErrorV1)) {
        return false;
      }
      assert.equal(error.code, "target_create_failed");
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(error.stack?.includes(sentinel) ?? false, false);
      assert.deepEqual(error.toJSON(), {
        kind: "SharedStateOutboxConformanceErrorV1",
        errorVersion: 1,
        code: "target_create_failed",
      });
      assertDeepFrozen(error.toJSON());
      return true;
    },
  );
});

test("pins the complete closed deterministic outbox fault vocabulary", () => {
  assert.deepEqual(SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1, [
    "domain-before-append",
    "append-before-commit",
    "ack-before-commit",
  ]);
});
