import type { TaskRecord, TaskStatus } from "./types.js";
import type { TaskStatusEvent } from "./task-events.js";
import type { CrossBrokerTerminalBriefProjection } from "./cross-broker-terminal-brief.js";

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["succeeded", "failed", "canceled", "blocked"]);
const TERMINAL_TASK_EVENT_KINDS = new Set<TaskStatusEvent["kind"]>(["succeeded", "failed", "canceled"]);
const TERMINAL_TASK_ACK_INPUT_EVIDENCE = new Set<TerminalTaskOutboxAckInputEvidence>([
  "current_session_visible",
  "operator_visible",
  "operator_confirmed",
]);
const LEGACY_TERMINAL_TASK_ACK_EVIDENCE = new Set<TerminalTaskOutboxAckEvidence>([
  ...TERMINAL_TASK_ACK_INPUT_EVIDENCE,
  "provider_delivery_receipt",
]);
const TERMINAL_TASK_RECEIPT_STATUSES = new Set<TerminalTaskReceiptStatus>([
  "accepted",
  "started",
  "produced",
  "provider_sent",
  "provider_accepted",
  "current_session_visible",
  "operator_visible",
  "timed_out",
  "stale",
  "failed",
]);
const LEGACY_TERMINAL_TASK_RECEIPT_STATUSES = new Set(["sent", "provider_delivered_if_known"]);
const TASK_BRIEF_KEYS = ["githubIssueTitle", "taskTitle", "title", "taskBrief"] as const;
const MAX_SUMMARY_CHARS = 500;
const MAX_TASK_BRIEF_CHARS = 160;
const MAX_ACK_NOTE_CHARS = 240;
const MAX_TERMINAL_BRIEF_TITLE_CHARS = 240;

export const DEFAULT_TERMINAL_TASK_OUTBOX_RETENTION = 1000;

export type TerminalTaskEventKind = "task.terminal";
export type TerminalTaskStatus = Extract<TaskStatus, "succeeded" | "failed" | "canceled" | "blocked">;

export interface TerminalTaskEventPayload {
  taskId: string;
  status: TerminalTaskStatus;
  /** Canonical Terminal Brief parent round id. Mirrors `run` for legacy consumers. */
  parentRoundId?: string;
  /** Broker that produced the Terminal Brief projection. */
  originBrokerId?: string;
  /** Broker of record that owns operator notification/ACK. */
  brokerOfRecordId?: string;
  /** Operator-safe round/run key for grouping worker terminal notifications. */
  run?: string;
  /** Transport trace id when the assignment came through an A2A exchange. */
  traceId?: string;
  /** Brief, sanitized task label suitable for operator closeout summaries. */
  taskDescription?: string;
  worker?: string;
  repo?: string;
  issue?: number;
  /** Short operator-safe task description for terminal notices. */
  taskBrief?: string;
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  testSummary?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  crossBrokerHandoff?: {
    parentRoundId: string;
    originBrokerId: string;
    handoffBrokerId?: string;
    originTaskId?: string;
    childWorkerId?: string;
  };
  /** Explicit delivery ownership for projected child briefs; projections never send or ACK. */
  notificationOwnership?: {
    ownerBrokerId: string;
    scope: "parent-broker-only";
    providerSendPermittedByProjection: false;
    terminalAckPermittedByProjection: false;
    reason: string;
  };
  /**
   * Parent broker completion sequence for this round (1-based numerator).
   * This is a succeeded-child count, not lane order or terminal-event order.
   * Only populated when the broker has a round progress counter; absent for
   * child/handoff brokers and when round total is unknown.
   */
  parentRoundProgress?: number;
  /**
   * Parent broker terminal-event sequence for this round (1-based numerator).
   * Counts unique canonical children that reached any terminal status. This is
   * used to make failed/canceled/blocked titles show round closure progress
   * separately from succeeded-child progress.
   */
  parentRoundTerminalProgress?: number;
  /**
   * Explains how the progress numerator was derived. Parent-owned handoff
   * tasks use the parent round lane/order because the handoff broker only sees
   * its local child completion.
   */
  parentRoundProgressSource?: "broker_local_count" | "parent_round_order";
  /**
   * Total worker/task count expected for this parent round (denominator).
   * Derived from task payload metadata set by the orchestrator/operator.
   * Absent when unknown — downstream notifiers should fall back to a readable
   * default title.
   */
  parentRoundTotal?: number;
  /** 1-based worker/task lane/order within the parent round. */
  parentRoundOrder?: number;
  /** Compact operator title for parent-round Terminal Brief notifications. */
  terminalBriefTitle?: string;
  /** Compatibility alias consumed by older Terminal Brief renderers. */
  title?: string;
}

export interface TerminalTaskOutboxEvent {
  /** Stable id for external notifier dedupe/replay. */
  id: string;
  kind: TerminalTaskEventKind;
  taskEventId: number;
  payload: TerminalTaskEventPayload;
  createdAt: string;
  /**
   * Receipt-confirmed terminal ack state. This is intentionally stricter than
   * Gateway/provider send success: callers must supply current-session-visible
   * or operator-visible evidence before the broker marks this cursor acked.
   */
  ack?: TerminalTaskOutboxAckState;
  /**
   * Explicit notification receipt state. This is separate from task terminal
   * status: a task can succeed while operator-visible receipt is still pending.
   */
  receipt: TerminalTaskOutboxReceiptState;
  /** Safe operator-facing explanation of the current terminal ACK decision. */
  ackAudit?: TerminalTaskOutboxAckAudit;
  /** @deprecated Older snapshots may contain this; new acks use `ack.acknowledgedAt`. */
  deliveredAt?: string;
  attempts: number;
}

export type TerminalTaskOutboxAckEvidence =
  | "current_session_visible"
  | "operator_visible"
  | "operator_confirmed"
  | "provider_delivery_receipt";

export type TerminalTaskOutboxAckInputEvidence = Exclude<TerminalTaskOutboxAckEvidence, "provider_delivery_receipt">;

export type TerminalTaskReceiptStatus =
  | "accepted"
  | "started"
  | "produced"
  | "provider_sent"
  | "provider_accepted"
  | "current_session_visible"
  | "operator_visible"
  | "timed_out"
  | "stale"
  | "failed";

export interface TerminalTaskOutboxAckInput {
  evidence: TerminalTaskOutboxAckInputEvidence;
  acknowledgedAt?: string;
  receiptId?: string;
  note?: string;
}

export interface TerminalTaskOutboxAckState {
  status: "receipt_confirmed";
  evidence: TerminalTaskOutboxAckEvidence;
  acknowledgedAt: string;
  receiptId?: string;
  note?: string;
}

export interface TerminalTaskOutboxReceiptState {
  status: TerminalTaskReceiptStatus;
  updatedAt: string;
  evidence?: TerminalTaskOutboxAckEvidence;
  receiptId?: string;
  note?: string;
}

export interface TerminalTaskOutboxReceiptUpdateInput {
  status: TerminalTaskReceiptStatus;
  updatedAt?: string;
  note?: string;
}

export type TerminalTaskOutboxAckDecision = "pending" | "eligible" | "confirmed" | "rejected";

export interface TerminalTaskOutboxAckAudit {
  decision: TerminalTaskOutboxAckDecision;
  reason: string;
  updatedAt: string;
  taskId: string;
  worker?: string;
  repo?: string;
  issue?: number;
  taskBrief?: string;
  run?: string;
  traceId?: string;
  receiptStatus?: TerminalTaskReceiptStatus;
  evidence?: TerminalTaskOutboxAckEvidence;
  receiptId?: string;
}

export interface TerminalTaskOutboxSubscribeOptions {
  afterId?: string;
  limit?: number;
}

export interface TerminalTaskOutboxSubscribeResult {
  events: TerminalTaskOutboxEvent[];
  cursor: string | null;
  reconciledUnacked: number;
}

export interface TerminalTaskEventOutboxOptions {
  /** Maximum retained outbox records. Older records are evicted FIFO. */
  maxEvents?: number;
  /** Previously persisted outbox records to replay after broker restart. */
  events?: TerminalTaskOutboxEvent[];
}

/**
 * Durable-delivery projection for terminal task events. The class owns the
 * compact, operator-safe payload that future webhook/SSE dispatchers should use;
 * callers can replay by stable event id and repeated enqueue is idempotent.
 *
 * This outbox only stores broker-local records. It never calls Telegram (or any
 * other external transport); seoseo/OpenClaw plugin-notifier owns delivery to
 * operator Telegram/main-session surfaces.
 */
export class TerminalTaskEventOutbox {
  private readonly events: TerminalTaskOutboxEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly maxEvents: number;
  private readonly maxSeen: number;

  /**
   * Tracks unique terminal canonical child task IDs per run/round key.
   * The set size is used as the parentRoundProgress numerator so that n/N
   * reflects terminal lane arrivals, regardless of succeeded/failed/canceled
   * outcome. A failed Terminal Brief still closes that lane for operator
   * progress purposes.
   */
  private readonly terminalChildIds = new Map<string, Set<string>>();

  constructor(options: TerminalTaskEventOutboxOptions = {}) {
    this.maxEvents = normalizePositiveInt(options.maxEvents, DEFAULT_TERMINAL_TASK_OUTBOX_RETENTION);
    this.maxSeen = this.maxEvents * 2;
    this.restoreSnapshot(options.events ?? []);
  }

  enqueue(taskEvent: TaskStatusEvent, task: TaskRecord): TerminalTaskOutboxEvent | null {
    if (!TERMINAL_TASK_EVENT_KINDS.has(taskEvent.kind)) return null;
    if (!isTerminalStatus(task.status)) return null;
    if (taskEvent.status !== task.status) return null;
    if (taskEvent.taskId !== task.id) return null;

    const id = formatTerminalTaskEventId(task.id, task.status, task.completedAt ?? task.updatedAt);
    const existing = this.events.find((event) => event.id === id);
    if (existing) return existing;
    if (this.seen.has(id)) return null;

    const payload = buildTerminalTaskPayload(task);
    applyRoundProgressMetadata(payload, this.terminalChildIds);
    applyTerminalBriefTitle(payload);
    applyTerminalBriefCompatibilityAliases(payload);
    const event: TerminalTaskOutboxEvent = {
      id,
      kind: "task.terminal",
      taskEventId: taskEvent.id,
      payload,
      createdAt: taskEvent.timestamp,
      receipt: {
        status: "accepted",
        updatedAt: taskEvent.timestamp,
      },
      ackAudit: buildAckAudit(payload, {
        decision: "pending",
        reason: "terminal event accepted; awaiting current-session-visible/operator-visible evidence before ACK",
        updatedAt: taskEvent.timestamp,
        receiptStatus: "accepted",
      }),
      attempts: 0,
    };
    this.events.push(event);
    this.markSeen(id);
    this.enforceRetention();
    return event;
  }


  enqueueCrossBrokerProjection(projection: CrossBrokerTerminalBriefProjection): TerminalTaskOutboxEvent | null {
    // Stable notification idempotency key:
    //   parentRoundId + originBrokerId + projection child key + terminal status
    //   + notification owner
    //
    // Match CrossBrokerTerminalBriefProjectionStore's recordKey() shape so
    // outbox dedupe cannot suppress distinct projection rows. The projection
    // child key is, in order of preference:
    //   1. projection.childTaskId  (explicit child broker task id)
    //   2. worker:<childWorkerId>   (discriminates multiple workers from same origin broker)
    //   3. order:<parentRoundOrder> (distinguishes ordered lanes when no child id is present)
    //   4. broker                  (fallback — origin broker id is already in the stable key)
    //
    // completedAt is intentionally EXCLUDED from this key so that replay/retry
    // with slightly different timestamps (clock skew, retransmission) does not
    // create duplicate operator-facing Terminal Brief events.
    const projectionChildKey = projection.childTaskId
      ?? (projection.childWorkerId ? `worker:${projection.childWorkerId}` : undefined)
      ?? (projection.parentRoundOrder ? `order:${projection.parentRoundOrder}` : undefined)
      ?? "broker";
    const notificationOwner = projection.brokerOfRecordId ?? "unknown-parent-broker";
    const stableId = `cross-broker:${projection.parentRoundId}:${projection.originBrokerId}:${projectionChildKey}:${projection.status}:${notificationOwner}`;
    const id = `terminal:${encodeURIComponent(stableId)}`;

    const existing = this.events.find((event) => event.id === id);
    if (existing) return existing;
    if (this.seen.has(id)) return null;

    // syntheticTaskId is used for the outbox event payload taskId (cosmetic),
    // not for idempotency. Use childTaskId or a descriptive fallback.
    const syntheticTaskId = projection.childTaskId
      ?? (projection.childWorkerId ? `cross-broker-worker:${projection.childWorkerId}` : undefined)
      ?? `cross-broker:${projection.parentRoundId}:${projection.originBrokerId}`;

    const taskBrief = sanitizeTaskBrief(projection.taskBrief)
      ?? sanitizeTaskBrief(`Cross-broker Terminal Brief from ${projection.originBrokerId}`);
    const testSummary = sanitizeSummary(projection.summary);
    const terminalBriefTitle = sanitizeRenderedTerminalBriefText(projection.terminalBriefTitle, MAX_TERMINAL_BRIEF_TITLE_CHARS);
    const evidenceUrl = firstSafeHttpUrl(projection.evidenceUrl);
    const parentBrokerId = projection.brokerOfRecordId ?? "unknown-parent-broker";
    const payload: TerminalTaskEventPayload = {
      taskId: syntheticTaskId,
      status: projection.status,
      parentRoundId: projection.parentRoundId,
      originBrokerId: projection.originBrokerId,
      ...(projection.brokerOfRecordId ? { brokerOfRecordId: projection.brokerOfRecordId } : {}),
      run: projection.parentRoundId,
      taskDescription: `Cross-broker Terminal Brief from ${projection.originBrokerId}`,
      worker: projection.childWorkerId ?? projection.originBrokerId,
      ...(taskBrief ? { taskBrief } : {}),
      ...(evidenceUrl ? { doneUrl: evidenceUrl } : {}),
      ...(testSummary ? { testSummary } : {}),
      createdAt: projection.emittedAt,
      updatedAt: projection.completedAt,
      completedAt: projection.completedAt,
      ...(projection.parentRoundTotal ? { parentRoundTotal: projection.parentRoundTotal } : {}),
      ...(projection.parentRoundOrder ? { parentRoundProgress: projection.parentRoundOrder, parentRoundOrder: projection.parentRoundOrder } : {}),
      crossBrokerHandoff: {
        parentRoundId: projection.parentRoundId,
        originBrokerId: parentBrokerId,
        handoffBrokerId: projection.originBrokerId,
        ...(projection.childTaskId ? { originTaskId: projection.childTaskId } : {}),
        ...(projection.childWorkerId ? { childWorkerId: projection.childWorkerId } : {}),
      },
      notificationOwnership: {
        ownerBrokerId: parentBrokerId,
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
        reason: "cross-broker projection rows are aggregation evidence only; provider send and terminal ACK belong to a separate parent-broker operator-facing Terminal Brief row",
      },
    };
    applyRoundProgressMetadata(payload, this.terminalChildIds);
    applyTerminalBriefTitle(payload);
    if (terminalBriefTitle) payload.terminalBriefTitle = terminalBriefTitle;
    applyTerminalBriefCompatibilityAliases(payload);
    const event: TerminalTaskOutboxEvent = {
      id,
      kind: "task.terminal",
      taskEventId: 0,
      payload,
      createdAt: projection.receivedAt,
      receipt: {
        status: "accepted",
        updatedAt: projection.receivedAt,
      },
      ackAudit: buildAckAudit(payload, {
        decision: "pending",
        reason: "cross-broker terminal projection accepted as evidence only; create or update a separate parent-broker operator-facing row before ACK",
        updatedAt: projection.receivedAt,
        receiptStatus: "accepted",
      }),
      attempts: 0,
    };
    this.events.push(event);
    this.markSeen(id);
    this.enqueueCrossBrokerOperatorFacingRow(projection, payload, stableId);
    this.enforceRetention();
    return event;
  }

  private enqueueCrossBrokerOperatorFacingRow(
    projection: CrossBrokerTerminalBriefProjection,
    evidencePayload: TerminalTaskEventPayload,
    projectionStableId: string,
  ): TerminalTaskOutboxEvent | null {
    const stableId = `cross-broker-operator:${projectionStableId}`;
    const id = `terminal:${encodeURIComponent(stableId)}`;
    const existing = this.events.find((event) => event.id === id);
    if (existing) return existing;
    if (this.seen.has(id)) return null;

    const {
      notificationOwnership: _notificationOwnership,
      ...payload
    } = structuredClone(evidencePayload);

    const event: TerminalTaskOutboxEvent = {
      id,
      kind: "task.terminal",
      taskEventId: 0,
      payload,
      createdAt: projection.receivedAt,
      receipt: {
        status: "accepted",
        updatedAt: projection.receivedAt,
      },
      ackAudit: buildAckAudit(payload, {
        decision: "pending",
        reason: "parent-broker operator-facing Terminal Brief row materialized from cross-broker projection; awaiting current-session-visible/operator-visible evidence before ACK",
        updatedAt: projection.receivedAt,
        receiptStatus: "accepted",
      }),
      attempts: 0,
    };
    this.events.push(event);
    this.markSeen(id);
    return event;
  }

  subscribe(options: TerminalTaskOutboxSubscribeOptions = {}): TerminalTaskOutboxEvent[] {
    return this.forwardEvents(options);
  }

  /**
   * Subscribe while also returning a safe cursor and retrying retained records
   * that are still missing receipt-confirmed ack evidence at/before afterId.
   *
   * This closes the send/crash gap: a notifier can advance its own fetch cursor
   * only for newly returned records, while unacknowledged records before the
   * cursor are replayed until acknowledge() receives receipt evidence.
   */
  subscribeWithCursor(options: TerminalTaskOutboxSubscribeOptions = {}): TerminalTaskOutboxSubscribeResult {
    const afterIndex = this.indexOfId(options.afterId);
    const replayStart = options.afterId && afterIndex < 0 ? 0 : afterIndex + 1;
    const unacknowledgedBeforeCursor = afterIndex >= 0
      ? this.events.slice(0, afterIndex + 1).filter((event) => !isReceiptConfirmed(event))
      : [];
    const newEvents = this.events.slice(replayStart);
    const replay = [...unacknowledgedBeforeCursor, ...newEvents];
    const events = this.applyLimit(replay, options.limit);
    return {
      events,
      cursor: this.nextCursor(options.afterId, afterIndex, events),
      reconciledUnacked: events.filter((event) => {
        const index = this.events.findIndex((candidate) => candidate.id === event.id);
        return index >= 0 && index <= afterIndex && !isReceiptConfirmed(event);
      }).length,
    };
  }

  reconcile(options: TerminalTaskOutboxSubscribeOptions = {}): TerminalTaskOutboxSubscribeResult {
    return this.subscribeWithCursor(options);
  }

  /**
   * Mark an outbox record as acknowledged by an external notifier. The record
   * remains replayable until normal retention evicts it, and the stable id keeps
   * repeated enqueue/ack operations idempotent.
   */
  acknowledge(id: string, receipt: TerminalTaskOutboxAckInput): TerminalTaskOutboxEvent | null {
    const event = this.events.find((candidate) => candidate.id === id);
    if (!receipt || !isTerminalTaskOutboxAckInputEvidence(receipt.evidence)) {
      if (event) {
        event.ackAudit = buildAckAudit(event.payload, {
          decision: "rejected",
          reason: "terminal ACK rejected: provider evidence is not current-session-visible/operator-visible evidence",
          updatedAt: new Date().toISOString(),
          receiptStatus: event.receipt.status,
        });
      }
      throw new TypeError("terminal outbox ack requires current-session-visible/operator-visible evidence");
    }
    if (!event) return null;
    if (event.ack) {
      return event;
    }
    // Projection/evidence rows are never terminal-ACK eligible themselves. A parent
    // broker must ACK its separate operator-facing Terminal Brief row instead.
    if (event.payload.notificationOwnership?.terminalAckPermittedByProjection === false) {
      event.ackAudit = buildAckAudit(event.payload, {
        decision: "rejected",
        reason: "terminal ACK rejected: parent-owned cross-broker projection row is evidence-only; the parent broker (" + (event.payload.notificationOwnership.ownerBrokerId ?? "unknown") + ") must ACK a separate operator-facing Terminal Brief row.",
        updatedAt: new Date().toISOString(),
        receiptStatus: event.receipt.status,
      });
      throw new TypeError("terminal outbox ack rejected: parent-owned cross-broker projection row is evidence-only");
    }
    event.ack = buildAckState(receipt);
    event.receipt = buildReceiptStateFromAck(event.ack);
    event.ackAudit = buildAckAudit(event.payload, {
      decision: "confirmed",
      reason: ackConfirmedReason(event.ack.evidence),
      updatedAt: event.ack.acknowledgedAt,
      receiptStatus: event.receipt.status,
      evidence: event.ack.evidence,
      receiptId: event.ack.receiptId,
    });
    delete event.deliveredAt;
    event.attempts += 1;
    return event;
  }

  /** Record provider-side send/timeout/staleness without implying operator visibility. */
  recordReceiptStatus(id: string, receipt: TerminalTaskOutboxReceiptUpdateInput): TerminalTaskOutboxEvent | null {
    if (!receipt || !isTerminalTaskReceiptStatus(receipt.status)) {
      throw new TypeError("terminal outbox receipt status must be accepted, started, produced, provider_sent, provider_accepted, current_session_visible, operator_visible, timed_out, stale, or failed");
    }
    const event = this.events.find((candidate) => candidate.id === id);
    if (!event) return null;
    // Projection/evidence rows must not record provider-send or visibility receipts.
    // Those belong to the parent broker's separate operator-facing row.
    if (event.payload.notificationOwnership?.providerSendPermittedByProjection === false) {
      if (receipt.status === "provider_sent" || receipt.status === "provider_accepted" || receipt.status === "operator_visible" || receipt.status === "current_session_visible") {
        event.ackAudit = buildAckAudit(event.payload, {
          decision: "rejected",
          reason: "receipt status rejected: parent-owned cross-broker projection row is evidence-only; the parent broker (" + (event.payload.notificationOwnership.ownerBrokerId ?? "unknown") + ") must record provider/operator receipt on a separate operator-facing Terminal Brief row.",
          updatedAt: new Date().toISOString(),
          receiptStatus: event.receipt.status,
        });
        throw new TypeError("terminal outbox receipt rejected: parent-owned cross-broker projection row is evidence-only");
      }
    }
    event.receipt = buildReceiptState(receipt.status, receipt.updatedAt ?? new Date().toISOString(), receipt.note);
    event.ackAudit = buildAckAudit(event.payload, ackAuditFromReceipt(event.receipt));
    return event;
  }

  get size(): number {
    return this.events.length;
  }

  /** Return a persistence-safe copy of retained records. */
  snapshot(): TerminalTaskOutboxEvent[] {
    return structuredClone(this.events);
  }

  /** Merge previously persisted records without duplicating stable ids. */
  restoreSnapshot(events: TerminalTaskOutboxEvent[]): void {
    for (const event of events) {
      this.restore(event);
    }
    this.enforceRetention();
    this.rebuildRoundCounters();
  }

  private restore(event: TerminalTaskOutboxEvent): void {
    if (this.seen.has(event.id)) return;
    const restored = structuredClone(event);
    if (!restored.ack && restored.deliveredAt) {
      restored.ack = {
        status: "receipt_confirmed",
        evidence: "operator_visible",
        acknowledgedAt: restored.deliveredAt,
        note: "migrated legacy deliveredAt ack",
      };
    }
    if (!restored.receipt) {
      restored.receipt = restored.ack
        ? buildReceiptStateFromAck(restored.ack)
        : buildReceiptState("accepted", restored.createdAt);
    } else {
      restored.receipt = normalizeReceiptState(restored.receipt);
    }
    restored.ackAudit = restored.ack
      ? buildAckAudit(restored.payload, {
        decision: "confirmed",
        reason: ackConfirmedReason(restored.ack.evidence),
        updatedAt: restored.ack.acknowledgedAt,
        receiptStatus: restored.receipt.status,
        evidence: restored.ack.evidence,
        receiptId: restored.ack.receiptId,
      })
      : buildAckAudit(restored.payload, ackAuditFromReceipt(restored.receipt));
    this.events.push(restored);
    this.markSeen(event.id);
  }

  private forwardEvents(options: TerminalTaskOutboxSubscribeOptions): TerminalTaskOutboxEvent[] {
    const start = this.indexAfter(options.afterId);
    return this.applyLimit(this.events.slice(start), options.limit);
  }

  /**
   * Rebuild terminal child counters from stored events so that fresh enqueues
   * resume at the correct completed-lane count after a snapshot restore.
   */
  private rebuildRoundCounters(): void {
    this.terminalChildIds.clear();
    for (const event of this.events) {
      const runKey = event.payload.run;
      if (!runKey) continue;
      const terminalCounted = this.terminalChildIds.get(runKey) ?? new Set<string>();
      terminalCounted.add(event.payload.taskId);
      this.terminalChildIds.set(runKey, terminalCounted);
    }
  }

  private indexAfter(afterId: string | undefined): number {
    if (!afterId) return 0;
    const index = this.indexOfId(afterId);
    return index >= 0 ? index + 1 : 0;
  }

  private indexOfId(id: string | undefined): number {
    return id ? this.events.findIndex((event) => event.id === id) : -1;
  }

  private applyLimit(events: TerminalTaskOutboxEvent[], limit: number | undefined): TerminalTaskOutboxEvent[] {
    return typeof limit === "number" && limit >= 0 ? events.slice(0, limit) : events;
  }

  private nextCursor(afterId: string | undefined, afterIndex: number, events: TerminalTaskOutboxEvent[]): string | null {
    if (!afterId || afterIndex < 0) return events.at(-1)?.id ?? null;
    const newestReturned = events
      .map((event) => this.events.findIndex((candidate) => candidate.id === event.id))
      .filter((index) => index > afterIndex)
      .at(-1);
    return typeof newestReturned === "number" ? this.events[newestReturned]!.id : afterId;
  }

  private markSeen(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > this.maxSeen) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seen.delete(evicted);
    }
  }

  private enforceRetention(): void {
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}

export function isTerminalStatus(status: TaskStatus): status is TerminalTaskStatus {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function isTerminalTaskOutboxAckEvidence(value: unknown): value is TerminalTaskOutboxAckEvidence {
  return typeof value === "string" && LEGACY_TERMINAL_TASK_ACK_EVIDENCE.has(value as TerminalTaskOutboxAckEvidence);
}

export function isTerminalTaskOutboxAckInputEvidence(value: unknown): value is TerminalTaskOutboxAckInputEvidence {
  return typeof value === "string" && TERMINAL_TASK_ACK_INPUT_EVIDENCE.has(value as TerminalTaskOutboxAckInputEvidence);
}

export function isTerminalTaskReceiptStatus(value: unknown): value is TerminalTaskReceiptStatus {
  return typeof value === "string" && TERMINAL_TASK_RECEIPT_STATUSES.has(value as TerminalTaskReceiptStatus);
}

export function normalizeTerminalTaskReceiptStatus(value: unknown): TerminalTaskReceiptStatus | undefined {
  if (isTerminalTaskReceiptStatus(value)) return value;
  return typeof value === "string" && LEGACY_TERMINAL_TASK_RECEIPT_STATUSES.has(value)
    ? "provider_sent"
    : undefined;
}

export function formatTerminalTaskEventId(taskId: string, status: TaskStatus, completedAt: string): string {
  return `terminal:${encodeURIComponent(taskId)}:${status}:${encodeURIComponent(completedAt)}`;
}

function isReceiptConfirmed(event: TerminalTaskOutboxEvent): boolean {
  return event.ack?.status === "receipt_confirmed" || Boolean(event.deliveredAt);
}

function normalizeBrokerToken(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function sameBrokerToken(left?: string, right?: string): boolean {
  const leftToken = normalizeBrokerToken(left);
  const rightToken = normalizeBrokerToken(right);
  return Boolean(leftToken && rightToken && leftToken === rightToken);
}

function ownerTokenMeansParent(owner?: string): boolean {
  const token = normalizeBrokerToken(owner);
  return token === "parent" || token === "origin" || token === "parent-owned" || token === "parent_owned";
}

function ownerTokenNamesOrigin(owner?: string, originBrokerId?: string, localBrokerId?: string): boolean {
  return Boolean(
    owner &&
      originBrokerId &&
      sameBrokerToken(owner, originBrokerId) &&
      (!localBrokerId || !sameBrokerToken(originBrokerId, localBrokerId)),
  );
}

export function buildTerminalTaskPayload(task: TaskRecord): TerminalTaskEventPayload {
  const output = isRecord(task.result?.output) ? task.result.output : {};
  const githubOutput = isRecord(output["github"]) ? output["github"] : {};
  const payloadTerminalBrief = isRecord(task.payload["terminalBrief"]) ? task.payload["terminalBrief"] : {};
  const payloadMetadata = isRecord(task.payload["metadata"]) ? task.payload["metadata"] : {};
  const outputTerminalBrief = isRecord(output["terminalBrief"]) ? output["terminalBrief"] : {};
  const outputMetadata = isRecord(output["metadata"]) ? output["metadata"] : {};
  const payloadNotificationOwnership = isRecord(task.payload["notificationOwnership"]) ? task.payload["notificationOwnership"] : {};
  const payloadTerminalBriefNotificationOwnership = isRecord(payloadTerminalBrief["notificationOwnership"])
    ? payloadTerminalBrief["notificationOwnership"]
    : {};
  const payloadMetadataNotificationOwnership = isRecord(payloadMetadata["notificationOwnership"])
    ? payloadMetadata["notificationOwnership"]
    : {};
  const outputNotificationOwnership = isRecord(output["notificationOwnership"]) ? output["notificationOwnership"] : {};
  const outputTerminalBriefNotificationOwnership = isRecord(outputTerminalBrief["notificationOwnership"])
    ? outputTerminalBrief["notificationOwnership"]
    : {};
  const outputMetadataNotificationOwnership = isRecord(outputMetadata["notificationOwnership"])
    ? outputMetadata["notificationOwnership"]
    : {};
  const parentOwnedTerminalBrief = firstTruthyFlag(
    task.payload["parentOwnedTerminalBrief"],
    payloadTerminalBrief["parentOwnedTerminalBrief"],
    payloadMetadata["parentOwnedTerminalBrief"],
    output["parentOwnedTerminalBrief"],
    outputTerminalBrief["parentOwnedTerminalBrief"],
    outputMetadata["parentOwnedTerminalBrief"],
  );
  const operatorFacingOwner = firstSafeText(
    task.payload["operatorFacingOwner"],
    payloadTerminalBrief["operatorFacingOwner"],
    payloadMetadata["operatorFacingOwner"],
    output["operatorFacingOwner"],
    outputTerminalBrief["operatorFacingOwner"],
    outputMetadata["operatorFacingOwner"],
    payloadNotificationOwnership["owner"],
    payloadTerminalBriefNotificationOwnership["owner"],
    payloadMetadataNotificationOwnership["owner"],
    outputNotificationOwnership["owner"],
    outputTerminalBriefNotificationOwnership["owner"],
    outputMetadataNotificationOwnership["owner"],
  );
  const payload: TerminalTaskEventPayload = {
    taskId: task.id,
    status: task.status as TerminalTaskStatus,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  const explicitParentRoundId = firstSafeText(
    task.payload["parentRoundId"],
    payloadTerminalBrief["parentRoundId"],
    payloadMetadata["parentRoundId"],
    output["parentRoundId"],
    outputTerminalBrief["parentRoundId"],
    outputMetadata["parentRoundId"],
  );
  const run = firstSafeText(
    explicitParentRoundId,
    task.payload["run"],
    task.payload["runId"],
    task.payload["round"],
    task.payload["roundId"],
    output["run"],
    output["runId"],
    output["round"],
    output["roundId"],
  );
  if (run) {
    payload.run = run;
  }
  if (explicitParentRoundId) {
    payload.parentRoundId = explicitParentRoundId;
  }
  let originBrokerId = firstSafeText(
    task.payload["originBrokerId"],
    payloadTerminalBrief["originBrokerId"],
    payloadMetadata["originBrokerId"],
    output["originBrokerId"],
    outputTerminalBrief["originBrokerId"],
    outputMetadata["originBrokerId"],
  );
  const lifecycleBrokerOfRecordId = firstSafeText(
    task.payload["brokerOfRecordId"],
    payloadTerminalBrief["brokerOfRecordId"],
    payloadMetadata["brokerOfRecordId"],
    output["brokerOfRecordId"],
    outputTerminalBrief["brokerOfRecordId"],
    outputMetadata["brokerOfRecordId"],
    task.brokerOfRecord,
  );
  if (!originBrokerId && run && lifecycleBrokerOfRecordId) originBrokerId = lifecycleBrokerOfRecordId;
  const explicitNotificationOwnerBrokerId = firstSafeText(
    task.payload["parentOwnerBrokerId"],
    task.payload["ownerBrokerId"],
    payloadTerminalBrief["parentOwnerBrokerId"],
    payloadTerminalBrief["ownerBrokerId"],
    payloadMetadata["parentOwnerBrokerId"],
    payloadMetadata["ownerBrokerId"],
    output["parentOwnerBrokerId"],
    output["ownerBrokerId"],
    outputTerminalBrief["parentOwnerBrokerId"],
    outputTerminalBrief["ownerBrokerId"],
    outputMetadata["parentOwnerBrokerId"],
    outputMetadata["ownerBrokerId"],
    payloadNotificationOwnership["ownerBrokerId"],
    payloadTerminalBriefNotificationOwnership["ownerBrokerId"],
    payloadMetadataNotificationOwnership["ownerBrokerId"],
    outputNotificationOwnership["ownerBrokerId"],
    outputTerminalBriefNotificationOwnership["ownerBrokerId"],
    outputMetadataNotificationOwnership["ownerBrokerId"],
  );
  const parentOwnedByMetadata =
    parentOwnedTerminalBrief ||
    ownerTokenMeansParent(operatorFacingOwner) ||
    ownerTokenNamesOrigin(operatorFacingOwner, originBrokerId, lifecycleBrokerOfRecordId);
  const notificationOwnerBrokerId = parentOwnedByMetadata
    ? explicitNotificationOwnerBrokerId ?? originBrokerId ?? lifecycleBrokerOfRecordId
    : lifecycleBrokerOfRecordId;
  if (notificationOwnerBrokerId) payload.brokerOfRecordId = notificationOwnerBrokerId;
  if (originBrokerId) payload.originBrokerId = originBrokerId;
  const parentRoundTotal = firstSafePositiveInt(
    task.payload["roundTotal"],
    task.payload["parentRoundTotal"],
    payloadTerminalBrief["parentRoundTotal"],
    payloadMetadata["parentRoundTotal"],
    task.payload["expectedWorkers"],
    task.payload["taskCount"],
    output["roundTotal"],
    output["parentRoundTotal"],
    outputTerminalBrief["parentRoundTotal"],
    outputMetadata["parentRoundTotal"],
    output["expectedWorkers"],
  );
  if (parentRoundTotal) payload.parentRoundTotal = parentRoundTotal;
  const parentRoundOrder = firstSafePositiveInt(
    task.payload["parentRoundNum"],
    task.payload["parentRoundOrder"],
    task.payload["parentRoundIndex"],
    task.payload["roundNum"],
    task.payload["roundOrder"],
    task.payload["roundIndex"],
    payloadTerminalBrief["parentRoundNum"],
    payloadTerminalBrief["parentRoundOrder"],
    payloadTerminalBrief["parentRoundIndex"],
    payloadTerminalBrief["roundNum"],
    payloadTerminalBrief["roundOrder"],
    payloadTerminalBrief["roundIndex"],
    payloadMetadata["parentRoundNum"],
    payloadMetadata["parentRoundOrder"],
    payloadMetadata["parentRoundIndex"],
    payloadMetadata["roundNum"],
    payloadMetadata["roundOrder"],
    payloadMetadata["roundIndex"],
    output["parentRoundNum"],
    output["parentRoundOrder"],
    output["parentRoundIndex"],
    output["roundNum"],
    output["roundOrder"],
    output["roundIndex"],
    outputTerminalBrief["parentRoundNum"],
    outputTerminalBrief["parentRoundOrder"],
    outputTerminalBrief["parentRoundIndex"],
    outputTerminalBrief["roundNum"],
    outputTerminalBrief["roundOrder"],
    outputTerminalBrief["roundIndex"],
    outputMetadata["parentRoundNum"],
    outputMetadata["parentRoundOrder"],
    outputMetadata["parentRoundIndex"],
    outputMetadata["roundNum"],
    outputMetadata["roundOrder"],
    outputMetadata["roundIndex"],
  );
  if (parentRoundOrder) {
    payload.parentRoundOrder = parentRoundOrder;
  }
  if (!payload.parentRoundId && run && parentRoundTotal && parentRoundOrder) {
    payload.parentRoundId = run;
  }
  const traceId = firstSafeText(task.via?.traceId, task.payload["traceId"], output["traceId"]);
  if (traceId) payload.traceId = traceId;
  const taskDescription = buildTaskDescription(task, output);
  if (taskDescription) payload.taskDescription = taskDescription;
  const worker = firstSafeText(
    task.claimedBy,
    task.assignedWorkerId,
    task.targetNodeId,
    task.payload["worker"],
    task.payload["workerId"],
    task.payload["assignedWorkerId"],
    task.payload["targetNodeId"],
    payloadTerminalBrief["worker"],
    payloadTerminalBrief["workerId"],
    payloadMetadata["worker"],
    payloadMetadata["workerId"],
    output["worker"],
    output["workerId"],
    outputTerminalBrief["worker"],
    outputTerminalBrief["workerId"],
    outputMetadata["worker"],
    outputMetadata["workerId"],
  );
  if (worker) payload.worker = worker;
  const repo = task.payload["githubRepo"];
  if (typeof repo === "string" && repo.length > 0) payload.repo = repo;
  const issue = task.payload["githubIssueNumber"];
  if (typeof issue === "number" && Number.isFinite(issue)) payload.issue = issue;
  const taskBrief = buildTaskBrief(task, output);
  if (taskBrief) payload.taskBrief = taskBrief;
  const prUrl = firstSafeHttpUrl(
    output["prUrl"],
    output["pullRequestUrl"],
    githubOutput["prUrl"],
    githubOutput["pullRequestUrl"],
    task.payload["prUrl"],
    task.payload["pullRequestUrl"],
  );
  if (prUrl) payload.prUrl = prUrl;
  const doneUrl = firstSafeHttpUrl(
    output["doneUrl"],
    output["doneCommentUrl"],
    githubOutput["doneUrl"],
    githubOutput["doneCommentUrl"],
    task.payload["doneUrl"],
    task.payload["doneCommentUrl"],
  );
  if (doneUrl) payload.doneUrl = doneUrl;
  const blockUrl = firstSafeHttpUrl(
    output["blockUrl"],
    output["blockCommentUrl"],
    githubOutput["blockUrl"],
    githubOutput["blockCommentUrl"],
    task.payload["blockUrl"],
    task.payload["blockCommentUrl"],
  );
  if (blockUrl) payload.blockUrl = blockUrl;
  const handoffBrokerId = firstSafeText(
    task.payload["handoffBrokerId"],
    payloadTerminalBrief["handoffBrokerId"],
    payloadMetadata["handoffBrokerId"],
    output["handoffBrokerId"],
    outputTerminalBrief["handoffBrokerId"],
    outputMetadata["handoffBrokerId"],
  );
  const effectiveHandoffBrokerId =
    handoffBrokerId ??
    (parentOwnedByMetadata &&
    notificationOwnerBrokerId &&
    lifecycleBrokerOfRecordId &&
    !sameBrokerToken(notificationOwnerBrokerId, lifecycleBrokerOfRecordId)
      ? lifecycleBrokerOfRecordId
      : undefined);
  const crossBrokerHandoff = buildCrossBrokerHandoff(
    task.payload["crossBrokerHandoff"],
    payloadTerminalBrief["crossBrokerHandoff"],
    payloadMetadata["crossBrokerHandoff"],
    output["crossBrokerHandoff"],
    outputTerminalBrief["crossBrokerHandoff"],
    outputMetadata["crossBrokerHandoff"],
    effectiveHandoffBrokerId
      ? {
        parentRoundId: run,
        originBrokerId: originBrokerId ?? notificationOwnerBrokerId,
        handoffBrokerId: effectiveHandoffBrokerId,
        childWorkerId: worker,
      }
      : undefined,
  );
  if (crossBrokerHandoff) payload.crossBrokerHandoff = crossBrokerHandoff;
  if (
    parentOwnedByMetadata &&
    notificationOwnerBrokerId &&
    (
      (lifecycleBrokerOfRecordId && !sameBrokerToken(notificationOwnerBrokerId, lifecycleBrokerOfRecordId)) ||
      Boolean(crossBrokerHandoff?.handoffBrokerId)
    )
  ) {
    payload.parentRoundProgressSource = "parent_round_order";
    payload.notificationOwnership = {
      ownerBrokerId: notificationOwnerBrokerId,
      scope: "parent-broker-only",
      providerSendPermittedByProjection: false,
      terminalAckPermittedByProjection: false,
      reason: "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
    };
  }
  const summary = task.result?.summary ?? task.result?.note ?? task.error?.message;
  const safeSummary = sanitizeSummary(summary);
  if (safeSummary) payload.testSummary = safeSummary;
  if (task.completedAt) payload.completedAt = task.completedAt;
  return payload;
}


function buildCrossBrokerHandoff(...values: unknown[]): TerminalTaskEventPayload["crossBrokerHandoff"] | undefined {
  for (const value of values) {
    if (!isRecord(value)) continue;
    const parentRoundId = sanitizeCrossBrokerToken(value["parentRoundId"] ?? value["roundId"]);
    const originBrokerId = sanitizeCrossBrokerToken(value["originBrokerId"] ?? (isRecord(value["originBroker"]) ? value["originBroker"]["id"] : undefined) ?? value["origin"]);
    if (!parentRoundId || !originBrokerId) continue;
    const handoffBrokerId = sanitizeCrossBrokerToken(value["handoffBrokerId"] ?? value["localBrokerId"] ?? value["brokerId"]);
    const originTaskId = sanitizeCrossBrokerToken(value["originTaskId"] ?? value["parentTaskId"]);
    const childWorkerId = sanitizeCrossBrokerToken(value["childWorkerId"] ?? value["workerId"]);
    return {
      parentRoundId,
      originBrokerId,
      ...(handoffBrokerId ? { handoffBrokerId } : {}),
      ...(originTaskId ? { originTaskId } : {}),
      ...(childWorkerId ? { childWorkerId } : {}),
    };
  }
  return undefined;
}

function sanitizeCrossBrokerToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160) return undefined;
  if (/token|secret|password|authorization|api[_-]?key/i.test(trimmed)) return undefined;
  return sanitizeSummary(trimmed);
}

function buildTaskBrief(task: TaskRecord, output: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [];
  for (const key of TASK_BRIEF_KEYS) candidates.push(task.payload[key], output[key]);
  for (const candidate of candidates) {
    const brief = sanitizeTaskBrief(candidate);
     if (brief) return brief;
  }
  return sanitizeTaskMessageBrief(task.message);
}

function sanitizeTaskMessageBrief(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^[-\w.]+\/[-\w.]+#\d+\s*:\s*/.test(value)) return undefined;
  return sanitizeTaskBrief(value);
}

function sanitizeTaskBrief(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutIssuePrefix = value.replace(/^[-\w.]+\/[-\w.]+#\d+\s*:\s*/, "");
  const sanitized = sanitizeSummary(withoutIssuePrefix);
  if (!sanitized) return undefined;
  return sanitized.slice(0, MAX_TASK_BRIEF_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstSafeHttpUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") return value;
    } catch {
      // Ignore malformed or local path evidence.
    }
  }
  return undefined;
}

function firstSafeText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const sanitized = sanitizeSummary(value);
    if (sanitized) return sanitized.slice(0, 160);
  }
  return undefined;
}

function buildTaskDescription(task: TaskRecord, output: Record<string, unknown>): string | undefined {
  const explicit = firstSafeText(
    task.payload["taskDescription"],
    task.payload["taskSummary"],
    task.payload["issueTitle"],
    task.payload["title"],
    task.payload["description"],
    output["taskDescription"],
    output["taskSummary"],
  );
  if (explicit) return explicit;

  const repo = typeof task.payload["githubRepo"] === "string" ? task.payload["githubRepo"] : undefined;
  const issue = typeof task.payload["githubIssueNumber"] === "number" && Number.isFinite(task.payload["githubIssueNumber"])
    ? task.payload["githubIssueNumber"]
    : undefined;
  if (repo && issue !== undefined) return `${repo}#${issue}`;
  if (repo) return repo;
  return firstSafeText(task.result?.summary, task.result?.note, task.error?.message, task.intent);
}

function sanitizeSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abp])-[-_A-Za-z0-9]+\b/g, "[redacted]")
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/(^|\s)(?:[A-Za-z]:)?\/[\w./-]+/g, "$1[path]")
    .replace(/\s+/g, " ")
    .slice(0, MAX_SUMMARY_CHARS);
}

function sanitizeRenderedTerminalBriefText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/```[\s\S]*?```/g, "[redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abp])-[-_A-Za-z0-9]+\b/g, "[redacted]")
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/(^|\s)(?:[A-Za-z]:)?\/[\w./-]+/g, "$1[path]")
    .slice(0, maxChars);
}

function buildAckState(receipt: TerminalTaskOutboxAckInput): TerminalTaskOutboxAckState {
  const ack: TerminalTaskOutboxAckState = {
    status: "receipt_confirmed",
    evidence: receipt.evidence,
    acknowledgedAt: receipt.acknowledgedAt ?? new Date().toISOString(),
  };
  const receiptId = sanitizeAckText(receipt.receiptId, MAX_ACK_NOTE_CHARS);
  if (receiptId) ack.receiptId = receiptId;
  const note = sanitizeAckText(receipt.note, MAX_ACK_NOTE_CHARS);
  if (note) ack.note = note;
  return ack;
}

function buildReceiptStateFromAck(ack: TerminalTaskOutboxAckState): TerminalTaskOutboxReceiptState {
  const status = ack.evidence === "provider_delivery_receipt"
    ? "provider_sent"
    : ack.evidence === "current_session_visible"
      ? "current_session_visible"
      : "operator_visible";
  const receipt: TerminalTaskOutboxReceiptState = {
    status,
    updatedAt: ack.acknowledgedAt,
    evidence: ack.evidence,
  };
  if (ack.receiptId) receipt.receiptId = ack.receiptId;
  if (ack.note) receipt.note = ack.note;
  return receipt;
}

function normalizeReceiptState(receipt: TerminalTaskOutboxReceiptState): TerminalTaskOutboxReceiptState {
  const status = normalizeTerminalTaskReceiptStatus(receipt.status) ?? "accepted";
  return { ...receipt, status };
}

function buildReceiptState(status: TerminalTaskReceiptStatus, updatedAt: string, note?: string): TerminalTaskOutboxReceiptState {
  const receipt: TerminalTaskOutboxReceiptState = { status, updatedAt };
  const safeNote = sanitizeAckText(note, MAX_ACK_NOTE_CHARS);
  if (safeNote) receipt.note = safeNote;
  return receipt;
}

function ackAuditFromReceipt(receipt: TerminalTaskOutboxReceiptState): Omit<TerminalTaskOutboxAckAudit, "taskId"> {
  switch (receipt.status) {
    case "operator_visible":
      return {
        decision: "eligible",
        reason: "operator-visible receipt recorded; terminal ACK is eligible with operator_visible/operator_confirmed evidence",
        updatedAt: receipt.updatedAt,
        receiptStatus: receipt.status,
        evidence: receipt.evidence,
        receiptId: receipt.receiptId,
      };
    case "current_session_visible":
      return {
        decision: "eligible",
        reason: "current-session-visible receipt recorded; terminal ACK is eligible with current_session_visible evidence but is not manual operator confirmation",
        updatedAt: receipt.updatedAt,
        receiptStatus: receipt.status,
        evidence: receipt.evidence,
        receiptId: receipt.receiptId,
      };
    case "provider_sent":
    case "provider_accepted":
      return {
        decision: "pending",
        reason: "provider send-only success recorded; awaiting current-session-visible/operator-visible evidence before ACK",
        updatedAt: receipt.updatedAt,
        receiptStatus: receipt.status,
        evidence: receipt.evidence,
        receiptId: receipt.receiptId,
      };
    case "failed":
    case "timed_out":
    case "stale":
      return {
        decision: "pending",
        reason: `terminal ACK pending: notification receipt is ${receipt.status} without current-session-visible/operator-visible evidence`,
        updatedAt: receipt.updatedAt,
        receiptStatus: receipt.status,
        evidence: receipt.evidence,
        receiptId: receipt.receiptId,
      };
    default:
      return {
        decision: "pending",
        reason: "terminal ACK pending: notification has not produced current-session-visible/operator-visible evidence",
        updatedAt: receipt.updatedAt,
        receiptStatus: receipt.status,
        evidence: receipt.evidence,
        receiptId: receipt.receiptId,
      };
  }
}

function ackConfirmedReason(evidence: TerminalTaskOutboxAckEvidence): string {
  return evidence === "provider_delivery_receipt"
    ? "legacy terminal ACK confirmed from provider-delivery receipt evidence; new ACKs require current-session-visible/operator-visible evidence"
    : evidence === "current_session_visible"
      ? "terminal ACK confirmed from current-session-visible evidence, not provider send-only success or manual operator confirmation"
      : "terminal ACK confirmed from operator-visible evidence";
}

function buildAckAudit(
  payload: TerminalTaskEventPayload,
  input: Omit<TerminalTaskOutboxAckAudit, "taskId" | "worker" | "repo" | "issue" | "taskBrief" | "run" | "traceId">,
): TerminalTaskOutboxAckAudit {
  const audit: TerminalTaskOutboxAckAudit = {
    decision: input.decision,
    reason: input.reason,
    updatedAt: input.updatedAt,
    taskId: payload.taskId,
  };
  if (payload.worker) audit.worker = payload.worker;
  if (payload.repo) audit.repo = payload.repo;
  if (payload.issue !== undefined) audit.issue = payload.issue;
  if (payload.taskBrief) audit.taskBrief = payload.taskBrief;
  if (payload.run) audit.run = payload.run;
  if (payload.traceId) audit.traceId = payload.traceId;
  if (input.receiptStatus) audit.receiptStatus = input.receiptStatus;
  if (input.evidence) audit.evidence = input.evidence;
  if (input.receiptId) audit.receiptId = input.receiptId;
  return audit;
}

function sanitizeAckText(value: unknown, maxChars: number): string | undefined {
  const sanitized = sanitizeSummary(value);
  if (!sanitized) return undefined;
  return sanitized.slice(0, maxChars);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Set broker-local progress counters by incrementing a sequence keyed by the
 * payload's run key. Cross-broker title rendering prefers explicit
 * parentRoundOrder when present, so a child/handoff broker cannot rewrite
 * parent lane 2/2 to local completion 1/2.
 *
 * When the payload has no run key this is a no-op. When parentRoundTotal is
 * unknown, the sequence counter still advances but the payload field is omitted
 * so downstream notifiers fall back instead of rendering misleading `n/?`
 * progress.
 */
function applyRoundProgressMetadata(
  payload: TerminalTaskEventPayload,
  terminalChildIds: Map<string, Set<string>>,
): void {
  const runKey = payload.run;
  if (!runKey) return;

  const terminalCounted = terminalChildIds.get(runKey) ?? new Set<string>();
  terminalCounted.add(payload.taskId);
  terminalChildIds.set(runKey, terminalCounted);

  // Numerator = count of unique terminal canonical children for this run.
  // Success/failure/canceled/blocked all mean that lane has reported in.
  const terminalCount = terminalChildIds.get(runKey)?.size ?? 0;

  // Only set progress when total is known
  if (payload.parentRoundTotal) {
    const useParentRoundOrder = payload.parentRoundProgressSource === "parent_round_order"
      && payload.parentRoundOrder !== undefined;
    payload.parentRoundProgress = useParentRoundOrder
      ? payload.parentRoundOrder
      : terminalCount;
    payload.parentRoundTerminalProgress = useParentRoundOrder
      ? payload.parentRoundOrder
      : terminalCount;
    if (!payload.parentRoundProgressSource) {
      payload.parentRoundProgressSource = "broker_local_count";
    }
  }
}

function applyTerminalBriefTitle(payload: TerminalTaskEventPayload): void {
  const title = buildTerminalBriefTitle(payload);
  if (title) payload.terminalBriefTitle = title;
}

function applyTerminalBriefCompatibilityAliases(payload: TerminalTaskEventPayload): void {
  if (
    payload.run &&
    !payload.parentRoundId &&
    payload.parentRoundTotal !== undefined &&
    (payload.parentRoundOrder !== undefined || payload.parentRoundProgress !== undefined)
  ) {
    payload.parentRoundId = payload.run;
  }
  // parentRoundOrder and parentRoundProgress now have distinct semantics —
  // parentRoundProgress is the succeeded-count numerator, parentRoundOrder is
  // the explicit lane order. The old alias is intentionally not recreated.
  if (payload.terminalBriefTitle && !payload.title) payload.title = payload.terminalBriefTitle;
}

const TERMINAL_BRIEF_STATUS_LABELS: Record<string, string> = {
  succeeded: "완료",
  failed: "실패",
  canceled: "취소",
  blocked: "차단",
};

export function buildTerminalBriefTitle(payload: TerminalTaskEventPayload): string | undefined {
  if (!payload.worker) return undefined;
  const label = TERMINAL_BRIEF_STATUS_LABELS[payload.status] ?? "완료";
  const preserveParentOrder = shouldPreserveParentRoundOrderInTitle(payload);
  const displayProgress = preserveParentOrder ? payload.parentRoundOrder ?? payload.parentRoundProgress : payload.parentRoundProgress;
  const total = payload.parentRoundTotal;
  const hasParentRoundContext = Boolean(
    payload.parentRoundId ||
    payload.parentRoundTotal !== undefined ||
    payload.parentRoundOrder !== undefined ||
    payload.parentRoundProgress !== undefined,
  );
  if (displayProgress !== undefined && total !== undefined) {
    return `A2A Terminal Brief ${label}: ${payload.worker}(완료 ${displayProgress}/${total})`;
  }
  if (hasParentRoundContext) {
    // Ambiguous round metadata: emit diagnostic fallback instead of
    // silent ?/? which misleads operators into thinking a round is
    // tracking progress. The payload carries a round-like key
    // (parentRoundId / run) but is missing required fields to compute
    // deterministic n/N.
    const missingFields: string[] = [];
    if (payload.parentRoundTotal === undefined) missingFields.push("parentRoundTotal");
    if (payload.parentRoundOrder === undefined && payload.parentRoundProgress === undefined) {
      missingFields.push("parentRoundOrder");
    }
    return `A2A Terminal Brief ${label}: ${payload.worker}(진단: ${missingFields.join(", ")} 누락)`;
  }
  return `A2A Terminal Brief ${label}: ${payload.worker}`;
}

function shouldPreserveParentRoundOrderInTitle(payload: TerminalTaskEventPayload): boolean {
  return Boolean(payload.crossBrokerHandoff || payload.notificationOwnership?.scope === "parent-broker-only");
}

/**
 * Return the first argument that resolves to a positive finite integer.
 * Returns undefined when none match.
 */
function firstSafePositiveInt(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0 && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return undefined;
}

function firstTruthyFlag(...values: unknown[]): boolean {
  for (const value of values) {
    if (value === true) return true;
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  }
  return false;
}
