/**
 * W1 bounded FIFO lane in front of the worker-owned V1 SQLite adapter.
 *
 * Decision W0 (`docs/specs/shared-state-ha-contract/tasks.md`) authorizes this
 * shape. The lane serializes every accepted transaction command and query
 * through one queue, and exactly one request is in flight at a time, so a
 * query's serialization point is its position in that queue.
 *
 * ADMISSION. A ticket is a monotonically increasing process-local number
 * assigned **only after** the request passes its closed parser and a queue slot
 * is available. A rejected parse, a saturated or closing queue, an unavailable
 * worker, or a failed lifecycle is not an accepted write. Such a request is
 * answered with the operation-preserving `unavailable` result when the
 * operation is known, and with the existing closed adapter failure when it is
 * not — a request that fails its parser has no operation to preserve. The
 * ticket is scheduling evidence only: it is never durable state, an outbox
 * sequence, an outbox receipt or acknowledgment, an idempotency key, or a field
 * of any contract envelope this lane returns.
 *
 * DURABLE ACK. `SharedStateSqliteAdapterV1.transact` returns only after SQLite
 * `COMMIT` or a known rollback, and the worker posts its response after that
 * return. A transaction promise therefore reports `committed` only once the
 * commit has completed and the worker's result for that exact ticket has
 * crossed the boundary.
 *
 * AMBIGUITY. Transport loss, worker exit, acknowledgment timeout, or a
 * malformed or crossed response after dispatch leaves a dispatched ticket
 * without a known adapter result. The lane never invents a rollback, never
 * retries the command, and never reports `committed`. It fails the worker
 * surface closed, records the ambiguity, and returns `unavailable`. Because a
 * later query could not then prove that every earlier accepted command reached
 * a known committed or rolled-back result, the lane stops serving after an
 * ambiguity rather than performing a main-thread stale read or weakening the
 * requested consistency. It never creates a replacement authority and never
 * reopens the file.
 *
 * DRAIN AND CLOSE. `drain` closes admission, waits for every accepted ticket to
 * reach a known terminal result, and succeeds only when no ambiguous write
 * remains; a timeout or a crash fails it closed. This is the adapter drain and
 * is unrelated to the broker `beginDrain` path prohibited for `lost_fence`.
 * `close` asks the worker-owned adapter to release ownership only after a
 * successful drain. Forced termination is not a clean close and never claims
 * that ownership was released.
 *
 * NON-CONFORMANCE. This is a narrow closed-command surface. It is deliberately
 * not declared as implementing `SharedStateStorageAdapterV1`: the broad
 * `withTransaction(callback)` member is never serialized or transferred to the
 * worker, and no full adapter conformance is claimed here. Nothing in this
 * module is wired to broker runtime, HTTP, configuration, or serving-store
 * selection.
 */
import type {
  SharedStateSqliteAdapterErrorCodeV1,
  SharedStateSqliteAdapterResultV1,
} from "./shared-state-sqlite-adapter-v1.js";
import {
  buildSharedStateSqliteWorkerRequestV1,
  narrowSharedStateSqliteWorkerResponseValueV1,
  parseSharedStateSqliteWorkerResponseV1,
  type SharedStateSqliteWorkerCommandV1,
  type SharedStateSqliteWorkerRequestV1,
} from "./shared-state-sqlite-worker-protocol-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateQueryResultV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  type SharedStateOperationUnavailableReasonCodeV1,
  type SharedStateOperationV1,
  type SharedStateQueryOperationV1,
  type SharedStateQueryRequestV1,
  type SharedStateQueryResultV1,
  type SharedStateQueryUnavailableReasonCodeV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";

export const SHARED_STATE_SQLITE_WORKER_LANE_V1 = Object.freeze({
  kind: "SharedStateSqliteWorkerLaneV1",
  laneVersion: 1,
  contractVersion: V.versions.contract,
  writerModel: "single",
  serialization: "single-bounded-fifo",
  ticketScope: "process-local-scheduling-evidence",
  commitAcknowledgment: "commit-before-ack",
  attachedToBrokerRuntime: false,
  fullAdapterConformanceClaimed: false,
  reusesLegacyPersistenceWorker: false,
  transfersWithTransactionCallback: false,
} as const);

export const SHARED_STATE_SQLITE_WORKER_LANE_STATES_V1 = Object.freeze([
  "new",
  "ready",
  "draining",
  "drained",
  "closed",
  "failed",
] as const);

export type SharedStateSqliteWorkerLaneStateV1 =
  (typeof SHARED_STATE_SQLITE_WORKER_LANE_STATES_V1)[number];

export const SHARED_STATE_SQLITE_WORKER_LOSS_REASONS_V1 = Object.freeze([
  "worker_error",
  "worker_exit",
  "acknowledgment_timeout",
  "crossed_response",
] as const);

export type SharedStateSqliteWorkerLossReasonV1 =
  (typeof SHARED_STATE_SQLITE_WORKER_LOSS_REASONS_V1)[number];

export interface SharedStateSqliteWorkerChannelHandlersV1 {
  /** Every inbound message, including ones this lane will refuse. */
  onMessage(message: unknown): void;
  /** The worker became unusable. Queued work is rejected; dispatched work is ambiguous. */
  onLoss(reason: SharedStateSqliteWorkerLossReasonV1): void;
}

export interface SharedStateSqliteWorkerChannelV1 {
  post(request: SharedStateSqliteWorkerRequestV1): void;
  /** Forced teardown. Never a clean close and never releases ownership. */
  terminate(): Promise<void>;
}

export type SharedStateSqliteWorkerChannelFactoryV1 = (
  handlers: SharedStateSqliteWorkerChannelHandlersV1,
) => SharedStateSqliteWorkerChannelV1;

export interface SharedStateSqliteWorkerLaneOptionsV1 {
  readonly channel: SharedStateSqliteWorkerChannelFactoryV1;
  /** Maximum accepted-but-unsettled tickets. Must be a positive integer. */
  readonly queueCapacity: number;
  readonly acknowledgmentTimeoutMs: number;
  readonly drainTimeoutMs: number;
}

export interface SharedStateSqliteWorkerLaneDiagnosticsV1 {
  readonly state: SharedStateSqliteWorkerLaneStateV1;
  readonly admittedTickets: number;
  readonly refusedAdmissions: number;
  readonly queuedCount: number;
  readonly dispatchedTicket: string | null;
  readonly ambiguousWrites: number;
  readonly crossedResponses: number;
  readonly ownershipReleased: boolean;
  readonly lastLossReason: SharedStateSqliteWorkerLossReasonV1 | null;
}

type SettleFn = (
  outcome:
    | { readonly kind: "value"; readonly value: unknown }
    | {
        readonly kind: "error";
        readonly code: SharedStateSqliteAdapterErrorCodeV1;
      }
    | { readonly kind: "ambiguous" }
    | { readonly kind: "rejected" },
) => void;

interface LaneEntryV1 {
  readonly ticket: string;
  readonly request: SharedStateSqliteWorkerRequestV1;
  readonly settle: SettleFn;
}

function failure<T>(
  code: SharedStateSqliteAdapterErrorCodeV1,
): SharedStateSqliteAdapterResultV1<T> {
  return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function value<T>(input: T): SharedStateSqliteAdapterResultV1<T> {
  return Object.freeze({ ok: true as const, value: input });
}

/**
 * Builds the operation-preserving transaction `unavailable` envelope through
 * the real closed parser, so a drift in the contract surfaces here as a thrown
 * invariant rather than as a silently malformed result.
 */
function transactionUnavailable(
  operation: SharedStateOperationV1,
  reasonCode: SharedStateOperationUnavailableReasonCodeV1,
): SharedStateTransactionResultV1 {
  const consistency = V.operationConsistency[operation];
  const candidate = {
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    status: V.transactionStatuses[2],
    consistency: { model: consistency.model, scope: consistency.scope },
    completeness: V.resultCompletenessStates[1],
    reasonCode,
  };
  const parsed = parseSharedStateTransactionResultV1(candidate);
  if (!parsed.ok) {
    throw new Error("closed SQLite worker lane transaction invariant failed");
  }
  return parsed.value;
}

function queryUnavailable(
  operation: SharedStateQueryOperationV1,
  reasonCode: SharedStateQueryUnavailableReasonCodeV1,
): SharedStateQueryResultV1 {
  const candidate = {
    kind: V.kinds.queryResult,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation,
    status: V.queryStatuses[1],
    achievedConsistency: null,
    reasonCode,
  };
  const parsed = parseSharedStateQueryResultV1(candidate);
  if (!parsed.ok) {
    throw new Error("closed SQLite worker lane query invariant failed");
  }
  return parsed.value;
}

export interface SharedStateSqliteWorkerLaneV1 {
  open(): Promise<SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1>>;
  transact(
    command: SharedStateTransactionCommandV1,
  ): Promise<SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1>>;
  query(
    request: SharedStateQueryRequestV1,
  ): Promise<SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>>;
  drain(): Promise<SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1>>;
  close(): Promise<SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1>>;
  /** Forced teardown for tests and for crash paths. Never claims a clean close. */
  terminate(): Promise<void>;
  diagnostics(): SharedStateSqliteWorkerLaneDiagnosticsV1;
}

class SqliteWorkerLaneV1 implements SharedStateSqliteWorkerLaneV1 {
  readonly #channel: SharedStateSqliteWorkerChannelV1;
  readonly #queueCapacity: number;
  readonly #acknowledgmentTimeoutMs: number;
  readonly #drainTimeoutMs: number;

  readonly #queue: LaneEntryV1[] = [];
  #idleWaiters: (() => void)[] = [];
  #dispatched: LaneEntryV1 | null = null;
  #acknowledgmentTimer: ReturnType<typeof setTimeout> | null = null;
  #lastLossReason: SharedStateSqliteWorkerLossReasonV1 | null = null;

  #state: SharedStateSqliteWorkerLaneStateV1 = "new";
  #nextTicket = 1n;
  #admittedTickets = 0;
  #refusedAdmissions = 0;
  #ambiguousWrites = 0;
  #crossedResponses = 0;
  #ownershipReleased = false;
  #terminated = false;

  constructor(options: SharedStateSqliteWorkerLaneOptionsV1) {
    if (
      !Number.isSafeInteger(options.queueCapacity)
      || options.queueCapacity < 1
    ) {
      throw new Error("shared-state SQLite worker lane capacity must be >= 1");
    }
    this.#queueCapacity = options.queueCapacity;
    this.#acknowledgmentTimeoutMs = options.acknowledgmentTimeoutMs;
    this.#drainTimeoutMs = options.drainTimeoutMs;
    this.#channel = options.channel({
      onMessage: (message) => {
        this.#receive(message);
      },
      onLoss: (reason) => {
        this.#handleLoss(reason);
      },
    });
  }

  diagnostics(): SharedStateSqliteWorkerLaneDiagnosticsV1 {
    return Object.freeze({
      state: this.#state,
      admittedTickets: this.#admittedTickets,
      refusedAdmissions: this.#refusedAdmissions,
      queuedCount: this.#queue.length,
      dispatchedTicket: this.#dispatched?.ticket ?? null,
      ambiguousWrites: this.#ambiguousWrites,
      crossedResponses: this.#crossedResponses,
      ownershipReleased: this.#ownershipReleased,
      lastLossReason: this.#lastLossReason,
    });
  }

  // ---- admission -------------------------------------------------------

  /**
   * Reads the lane state across an `await`. A loss handler can move the state
   * while a caller is suspended, so the value must be re-read rather than
   * carried across the suspension point.
   */
  #readState(): SharedStateSqliteWorkerLaneStateV1 {
    return this.#state;
  }

  /** True when a new caller request may be accepted at all. */
  #admits(): boolean {
    return this.#state === "ready" && !this.#terminated;
  }

  #hasSlot(): boolean {
    return this.#queue.length + (this.#dispatched ? 1 : 0) < this.#queueCapacity;
  }

  #admit(
    command: SharedStateSqliteWorkerCommandV1,
    payload?: SharedStateTransactionCommandV1 | SharedStateQueryRequestV1,
  ): Promise<Parameters<SettleFn>[0]> {
    const ticket = this.#nextTicket.toString();
    this.#nextTicket += 1n;
    this.#admittedTickets += 1;

    const request =
      command === "transact"
        ? buildSharedStateSqliteWorkerRequestV1(
            ticket,
            "transact",
            payload as SharedStateTransactionCommandV1,
          )
        : command === "query"
          ? buildSharedStateSqliteWorkerRequestV1(
              ticket,
              "query",
              payload as SharedStateQueryRequestV1,
            )
          : buildSharedStateSqliteWorkerRequestV1(ticket, command);

    return new Promise((resolve) => {
      let settled = false;
      this.#queue.push({
        ticket,
        request,
        settle: (outcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        },
      });
      this.#pump();
    });
  }

  // ---- dispatch --------------------------------------------------------

  #pump(): void {
    if (this.#dispatched !== null) return;
    const next = this.#queue.shift();
    if (!next) {
      this.#notifyIdle();
      return;
    }
    this.#dispatched = next;

    if (this.#acknowledgmentTimeoutMs > 0) {
      // Deliberately not `unref`ed. A dispatched-but-unsettled write is exactly
      // the state in which the process must not exit quietly: the timer is what
      // converts that silence into a declared ambiguity. It is always cleared
      // when the ticket settles, so it holds the loop open no longer than the
      // write it guards.
      this.#acknowledgmentTimer = setTimeout(() => {
        this.#handleLoss("acknowledgment_timeout");
      }, this.#acknowledgmentTimeoutMs);
    }

    try {
      this.#channel.post(next.request);
    } catch {
      // The request may or may not have reached the worker.
      this.#handleLoss("worker_error");
    }
  }

  #clearAcknowledgmentTimer(): void {
    if (this.#acknowledgmentTimer !== null) {
      clearTimeout(this.#acknowledgmentTimer);
      this.#acknowledgmentTimer = null;
    }
  }

  #receive(message: unknown): void {
    const dispatched = this.#dispatched;
    if (!dispatched) {
      // Nothing is outstanding, so this is a late or spurious message. It
      // cannot make an already settled ticket ambiguous.
      this.#crossedResponses += 1;
      return;
    }

    const parsed = parseSharedStateSqliteWorkerResponseV1(message);
    if (!parsed.ok) {
      this.#crossedResponses += 1;
      this.#handleLoss("crossed_response");
      return;
    }

    const response = parsed.value;
    if (
      response.ticket !== dispatched.ticket
      || response.command !== dispatched.request.command
    ) {
      this.#crossedResponses += 1;
      this.#handleLoss("crossed_response");
      return;
    }

    this.#clearAcknowledgmentTimer();
    this.#dispatched = null;

    if (response.outcome === "error") {
      dispatched.settle({ kind: "error", code: response.error.code });
      this.#pump();
      return;
    }

    const narrowed = narrowSharedStateSqliteWorkerResponseValueV1(
      response.command,
      response.value,
    );
    if (!narrowed.ok) {
      // A response that clears the envelope but not the contract family leaves
      // this ticket without a known adapter result.
      this.#recordAmbiguity();
      dispatched.settle({ kind: "ambiguous" });
      this.#failLane();
      return;
    }

    dispatched.settle({ kind: "value", value: narrowed.value.value });
    this.#pump();
  }

  #handleLoss(reason: SharedStateSqliteWorkerLossReasonV1): void {
    this.#clearAcknowledgmentTimer();
    const dispatched = this.#dispatched;
    this.#dispatched = null;

    if (dispatched) {
      // Dispatched but unsettled: the write may or may not have committed.
      this.#recordAmbiguity();
      dispatched.settle({ kind: "ambiguous" });
    }
    this.#lastLossReason = reason;
    this.#failLane();
  }

  #recordAmbiguity(): void {
    this.#ambiguousWrites += 1;
  }

  /**
   * Rejects everything still queued and stops serving. Queued entries were
   * never dispatched, so they are refusals rather than ambiguities.
   */
  #failLane(): void {
    this.#state = "failed";
    while (this.#queue.length > 0) {
      const entry = this.#queue.shift();
      entry?.settle({ kind: "rejected" });
    }
    this.#notifyIdle();
  }

  // ---- idle notification for drain -------------------------------------

  #notifyIdle(): void {
    if (this.#dispatched !== null || this.#queue.length > 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  #awaitIdle(timeoutMs: number): Promise<boolean> {
    if (this.#dispatched === null && this.#queue.length === 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, timeoutMs);
      this.#idleWaiters.push(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  // ---- public surface --------------------------------------------------

  async open(): Promise<
    SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1>
  > {
    if (this.#terminated) return failure("adapter_unavailable");
    if (this.#state === "failed") return failure("adapter_unavailable");
    if (this.#state === "closed") return failure("not_open");
    if (this.#state !== "new") return failure("already_open");

    this.#state = "ready";
    const outcome = await this.#admit("open");

    if (outcome.kind === "value") {
      return value(outcome.value as SharedStateStorageLifecycleV1);
    }
    this.#state = "failed";
    if (outcome.kind === "error") return failure(outcome.code);
    return failure("adapter_unavailable");
  }

  async transact(
    command: SharedStateTransactionCommandV1,
  ): Promise<SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1>> {
    const parsed = parseSharedStateTransactionCommandV1(command);
    if (!parsed.ok) {
      // No operation survives a rejected parse, so there is nothing to
      // preserve; this is the existing closed adapter failure.
      this.#refusedAdmissions += 1;
      return failure("adapter_unavailable");
    }
    const operation = parsed.value.operation;

    if (!this.#admits() || !this.#hasSlot()) {
      this.#refusedAdmissions += 1;
      return value(
        transactionUnavailable(operation, "authority_unavailable"),
      );
    }

    const outcome = await this.#admit("transact", parsed.value);

    if (outcome.kind === "value") {
      return value(outcome.value as SharedStateTransactionResultV1);
    }
    if (outcome.kind === "error") return failure(outcome.code);
    if (outcome.kind === "ambiguous") {
      return value(transactionUnavailable(operation, "ambiguous_commit"));
    }
    return value(transactionUnavailable(operation, "authority_unavailable"));
  }

  async query(
    request: SharedStateQueryRequestV1,
  ): Promise<SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>> {
    const parsed = parseSharedStateQueryRequestV1(request);
    if (!parsed.ok) {
      this.#refusedAdmissions += 1;
      return failure("adapter_unavailable");
    }
    const operation = parsed.value.operation;

    // The barrier cannot be proved once any earlier accepted command failed to
    // reach a known committed or rolled-back result.
    if (this.#ambiguousWrites > 0 || !this.#admits() || !this.#hasSlot()) {
      this.#refusedAdmissions += 1;
      return value(queryUnavailable(operation, "authority_unavailable"));
    }

    const outcome = await this.#admit("query", parsed.value);

    if (outcome.kind === "value") {
      return value(outcome.value as SharedStateQueryResultV1);
    }
    if (outcome.kind === "error") return failure(outcome.code);
    return value(queryUnavailable(operation, "authority_unavailable"));
  }

  async drain(): Promise<
    SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1>
  > {
    if (this.#state === "drained") return failure("drain_required");
    if (this.#state !== "ready") return failure("not_ready");

    // Close admission first, then wait for accepted tickets to settle.
    this.#state = "draining";
    const idle = await this.#awaitIdle(this.#drainTimeoutMs);
    if (!idle) {
      this.#state = "failed";
      return failure("adapter_unavailable");
    }
    if (this.#ambiguousWrites > 0 || this.#readState() === "failed") {
      this.#state = "failed";
      return failure("adapter_unavailable");
    }

    const outcome = await this.#admit("drain");
    if (outcome.kind === "value") {
      this.#state = "drained";
      return value(outcome.value as SharedStateStorageLifecycleV1);
    }
    this.#state = "failed";
    if (outcome.kind === "error") return failure(outcome.code);
    return failure("adapter_unavailable");
  }

  async close(): Promise<
    SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1>
  > {
    if (this.#state === "closed") return failure("not_open");
    // Ownership is released only after a successful drain.
    if (this.#state !== "drained") return failure("drain_required");

    const outcome = await this.#admit("close");
    if (outcome.kind === "value") {
      this.#state = "closed";
      this.#ownershipReleased = true;
      await this.#channel.terminate();
      this.#terminated = true;
      return value(outcome.value as SharedStateStorageLifecycleV1);
    }
    this.#state = "failed";
    if (outcome.kind === "error") return failure(outcome.code);
    return failure("adapter_unavailable");
  }

  async terminate(): Promise<void> {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#clearAcknowledgmentTimer();
    if (this.#readState() !== "closed") {
      // Forced teardown is not a clean close and releases no ownership. A
      // request already dispatched has no known adapter result, so it settles
      // ambiguous rather than being left pending forever.
      const dispatched = this.#dispatched;
      this.#dispatched = null;
      if (dispatched) {
        this.#recordAmbiguity();
        dispatched.settle({ kind: "ambiguous" });
      }
      this.#failLane();
    }
    await this.#channel.terminate();
  }
}

export function createSharedStateSqliteWorkerLaneV1(
  options: SharedStateSqliteWorkerLaneOptionsV1,
): SharedStateSqliteWorkerLaneV1 {
  return new SqliteWorkerLaneV1(options);
}
