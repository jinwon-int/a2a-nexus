import type {
  A2ABrokerOperatorSseEvent,
  A2ABrokerStreamOperatorEventsOptions,
  A2ATerminalOutboxAckEvidence,
  A2ATerminalOutboxEvent,
  A2ATerminalOutboxListResponse,
} from "../standalone-broker-client.js";
import {
  type A2AOperatorReleaseDriftSummary,
  type A2AOperatorTerminalNotificationEnvelope,
  buildA2AOperatorReleaseDriftSummary,
  buildA2AOperatorTerminalNotificationEnvelope,
  buildA2AOperatorTerminalOutboxNotificationEnvelope,
  getA2AOperatorTerminalReceiptGate,
} from "./operator-terminal-notifier.js";
import { normalizeOptionalString } from "./value-guards.js";
import {
  buildA2ACrossBrokerTerminalProjection,
  type A2ACrossBrokerTerminalProjection,
} from "./cross-broker-terminal-relay.js";

type UnknownRecord = Record<string, unknown>;

export type A2AOperatorEventBridgeConnection =
  | "disabled"
  | "idle"
  | "connecting"
  | "streaming"
  | "error";

export type A2AOperatorEventBridgeFailureCode =
  | "stream_connect_failed"
  | "stream_runtime_failed"
  | "stream_closed";

export type A2AOperatorEventBridgeVisibleFailure = {
  status: "failed";
  code: A2AOperatorEventBridgeFailureCode;
  message: string;
  visible: true;
  timestamp: number;
};

export type A2AOperatorEventBridgeAlert = {
  alertId: string;
  status: "open" | "resolved";
  message?: string;
  severity?: string;
  source?: string;
  openedAt?: number;
  resolvedAt?: number;
  details?: UnknownRecord;
};

export type A2AOperatorWorkerProgressItem = {
  workerId: string;
  liveness: "live" | "stale" | "unknown";
  status?: string;
  lastSeenAt?: number;
  activeTaskId?: string;
  taskStatus?: string;
  progress?: number;
  message?: string;
};

export type A2AOperatorWorkerProgressProjection = {
  status: "live" | "stale" | "unknown";
  counts: {
    total: number;
    live: number;
    stale: number;
    unknown: number;
    activeTasks: number;
  };
  workers: A2AOperatorWorkerProgressItem[];
};

export type A2AOperatorGitHubTaskEvidenceItem = {
  taskId: string;
  status: "start_seen" | "terminal_seen" | "evidence_missing";
  startSeen: boolean;
  prSeen: boolean;
  doneSeen: boolean;
  blockSeen: boolean;
  evidenceMissing: boolean;
  repo?: string;
  issue?: number;
  lastCheckedAt?: number;
  warning?: string;
};

export type A2AOperatorGitHubTaskEvidenceProjection = {
  status: "ok" | "warning" | "unknown";
  counts: {
    total: number;
    startSeen: number;
    terminalSeen: number;
    evidenceMissing: number;
    warnings: number;
  };
  tasks: A2AOperatorGitHubTaskEvidenceItem[];
};

export type A2AOperatorReceiptGapStatus = "confirmed" | "missing" | "timed_out" | "stale" | "failed" | "duplicate_suppressed";

export type A2AOperatorVisibleTerminalReceiptState =
  | "pending_receipt"
  | "timed_out"
  | "stale"
  | "failed"
  | "duplicate_suppressed"
  | "receipt_confirmed";

export type A2AOperatorTerminalReceiptProjection = {
  taskId: string;
  status?: string;
  terminalEventId?: string;
  cursor?: string;
  timestamp?: number;
  receiptMode?: "current_session_visible" | "manual_operator_receipt";
  /** Backward-compatible binary receipt gate used by existing monitor clients. */
  receiptStatus: "pending" | "received";
  /** Structural receipt vocabulary from broker, or a fail-closed gap derived by the plugin. */
  receiptGapStatus: A2AOperatorReceiptGapStatus;
  /** Operator-actionable receipt state, separate from provider send/delivery status. */
  operatorReceiptState: A2AOperatorVisibleTerminalReceiptState;
  operatorReceiptLabel: string;
  providerDeliveryState?: "accepted" | "sent" | "provider-delivered-if-known";
  brokerReceiptClassification?: string;
  terminalAckEligible: boolean;
  reason: string;
};

export type A2AOperatorTerminalOutboxEventProjection = {
  id: string;
  taskId?: string;
  status?: string;
  repo?: string;
  issue?: number;
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  createdAt?: string;
  completedAt?: string;
  attempts?: number;
  ackStatus?: string;
};

export type A2AOperatorTerminalOutboxDeployPreflightProjection = {
  mode: "dry-run-projection";
  status: "unknown" | "ready" | "blocked";
  cursor?: string;
  backlog: {
    lastPollAt?: number;
    pendingUnacknowledged: number;
    reconciledUnacked: number;
    backlogDrain: boolean;
  };
  lastNotificationAttempt?: {
    source: "live-stream" | "outbox-backlog";
    timestamp: number;
    taskId?: string;
    terminalEventId?: string;
    receiptStatus: "received" | "pending";
    reason: string;
  };
  receiptGate: {
    ackRequires: ["current_session_visible", "manual_operator_receipt"];
    providerGatewaySendSuccess: "not_ack_evidence";
    terminalAckEligible: boolean;
    evidence?: A2ATerminalOutboxAckEvidence;
    receiptId?: string;
  };
  safeOperations: {
    liveSend: false;
    terminalOutboxAck: false;
    gatewayRestart: false;
    productionDeploy: false;
  };
};

export type A2AOperatorMonitorSafetyStatus = {
  mode: "release-dryrun/no-live";
  status: "unknown" | "ready" | "blocked";
  blockers: string[];
  safeOperations: {
    liveSend: false;
    terminalOutboxAck: false;
    gatewayRestart: false;
    productionDeploy: false;
  };
  receiptGate: {
    ackRequires: ["current_session_visible", "manual_operator_receipt"];
    providerGatewaySendSuccess: "not_ack_evidence";
    terminalAckEligible: boolean;
  };
};

export type A2AOperatorTerminalOutboxProjection = {
  cursor?: string;
  poller?: {
    status: "started" | "skipped" | "stopped" | "failed";
    reason: string;
    timestamp: number;
    lastTick?: {
      timestamp: number;
      afterId?: string;
      limit: number;
      reconcileUnacked: boolean;
    };
    lastError?: {
      timestamp: number;
      message: string;
    };
  };
  lastPoll?: {
    timestamp: number;
    afterId?: string;
    limit: number;
    count: number;
    reconciledUnacked: number;
    backlogDrain: boolean;
    pendingUnacknowledged: number;
    firstPendingId?: string;
    cursorBlockedByUnacked?: boolean;
  };
  pendingUnacknowledged?: A2AOperatorTerminalOutboxEventProjection[];
  lastEvent?: A2AOperatorTerminalOutboxEventProjection;
  lastNotificationAttempt?: {
    source: "live-stream" | "outbox-backlog";
    timestamp: number;
    taskId?: string;
    terminalEventId?: string;
    dedupeKey: string;
    receiptStatus: "received" | "pending";
    reason: string;
  };
  lastAck?: {
    id: string;
    taskId?: string;
    evidence: A2ATerminalOutboxAckEvidence;
    receiptId?: string;
    acknowledgedAt: string;
    timestamp: number;
  };
  crossBrokerRelay?: A2AOperatorTerminalOutboxRelayProjection;
  deployPreflight?: A2AOperatorTerminalOutboxDeployPreflightProjection;
  /** Internal diagnostic counters for duplicate suppression, fuse, and relay state. */
  doctorDiagnostics?: A2AOperatorTerminalOutboxDoctorDiagnostics;
};

export type A2AOperatorTerminalOutboxDoctorDiagnostics = {
  /** How many unique dedupe keys have been notified so far. */
  notifiedDedupeKeyCount: number;
  /** How many unique dedupe keys are currently pending notification. */
  pendingNotificationDedupeKeyCount: number;
  /** How many unique task notification keys have been notified. */
  notifiedTaskKeyCount: number;
  /** How many unique task notification keys are pending. */
  pendingNotificationTaskKeyCount: number;
  /** Whether the one-shot notification fuse has tripped (blocked further sends pending manual review). */
  notificationFuseTripped: boolean;
  /** How many dedupe keys currently have active retry-after timers. */
  retryAfterCount: number;
  /** How many terminal outbox IDs have been relayed cross-broker. */
  relayedTerminalOutboxIdCount: number;
};

export type A2AOperatorTerminalOutboxRelayProjection = {
  status: "idle" | "started" | "succeeded" | "failed" | "skipped";
  cursor?: string;
  relayed: number;
  skipped: number;
  failed: number;
  lastAttempt?: {
    timestamp: number;
    terminalOutboxId: string;
    childTaskId?: string;
    parentRoundId?: string;
    originBrokerId?: string;
    status: "succeeded" | "failed" | "skipped";
    reason: string;
  };
  lastSuccess?: {
    timestamp: number;
    terminalOutboxId: string;
    relayId: string;
    childTaskId: string;
    parentRoundId: string;
    originBrokerId: string;
  };
  lastError?: {
    timestamp: number;
    terminalOutboxId?: string;
    message: string;
  };
  receiptGate: {
    providerGatewaySendSuccess: "not_ack_evidence";
    terminalAckEligible: false;
  };
};

export type A2AOperatorEventBridgeState = {
  kind: "a2a.operator.monitor";
  enabled: boolean;
  bridge: {
    connection: A2AOperatorEventBridgeConnection;
    note?: string;
    requestedCursor?: string;
    cursor?: string;
    connectedAt?: number;
    lastEvent?: {
      id?: string;
      name: A2ABrokerOperatorSseEvent["name"];
      timestamp: number;
    };
    lastFailure?: A2AOperatorEventBridgeVisibleFailure;
  };
  operator: {
    snapshot?: UnknownRecord;
    liveSummary?: UnknownRecord;
    releaseDrift?: A2AOperatorReleaseDriftSummary;
    workerProgress?: A2AOperatorWorkerProgressProjection;
    githubEvidence?: A2AOperatorGitHubTaskEvidenceProjection;
    safetyStatus: A2AOperatorMonitorSafetyStatus;
    terminalReceipts?: A2AOperatorTerminalReceiptProjection[];
    terminalOutbox?: A2AOperatorTerminalOutboxProjection;
    alerts: {
      open: A2AOperatorEventBridgeAlert[];
      resolved: A2AOperatorEventBridgeAlert[];
    };
  };
};

export type A2AOperatorEventBridgeBrokerClient = {
  streamOperatorEvents(
    options?: A2ABrokerStreamOperatorEventsOptions,
  ): AsyncGenerator<A2ABrokerOperatorSseEvent, void, void>;
  listTerminalOutbox?(params?: {
    afterId?: string;
    limit?: number;
    reconcileUnacked?: boolean;
  }): Promise<A2ATerminalOutboxListResponse>;
  ackTerminalOutbox?(params: {
    id: string;
    receipt: {
      evidence: A2ATerminalOutboxAckEvidence;
      acknowledgedAt?: string;
      receiptId?: string;
      note?: string;
    };
  }): Promise<A2ATerminalOutboxEvent>;
  recordTerminalOutboxReceipt?(params: {
    id: string;
    receipt: {
      status: A2AOperatorTerminalOutboxReceiptStatus;
      updatedAt?: string;
      note?: string;
    };
  }): Promise<A2ATerminalOutboxEvent>;
};

export type A2AOperatorEventBridge = {
  getState(options?: { cursor?: string }): A2AOperatorEventBridgeState;
  shutdown(): void;
  waitForIdle(): Promise<void>;
};

export type A2AOperatorNotificationAckDecision = {
  ackTerminalEvent: boolean;
  reason?: string;
  terminalReceiptStatus?: A2AOperatorTerminalOutboxReceiptStatus;
  confirmationSource?: "current_session_visible" | "manual_operator_receipt";
  receiptId?: string;
};

export type A2AOperatorTerminalOutboxReceiptStatus =
  | "accepted"
  | "started"
  | "produced"
  | "provider_sent"
  | "provider_accepted"
  | "timed_out"
  | "stale"
  | "failed";

export type A2AOperatorTerminalRelayDecision = {
  accepted?: boolean;
  reason?: string;
};

export type A2AOperatorEventBridgeOptions = {
  broker: A2AOperatorEventBridgeBrokerClient;
  now?: () => number;
  retryDelayMs?: number;
  waitForRetry?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readCursor?: () => string | undefined;
  writeCursor?: (cursor: string) => void;
  notifyOperator?: (
    envelope: A2AOperatorTerminalNotificationEnvelope,
  ) => void | A2AOperatorNotificationAckDecision | Promise<void | A2AOperatorNotificationAckDecision>;
  relayTerminalProjection?: (
    projection: A2ACrossBrokerTerminalProjection,
  ) => void | A2AOperatorTerminalRelayDecision | Promise<void | A2AOperatorTerminalRelayDecision>;
  terminalProjectionMaxSummaryChars?: number;
  handoffBrokerId?: string;
  dryRunNotifications?: boolean;
  notificationMaxTextChars?: number;
  terminalOutboxPollMs?: number;
  terminalOutboxLimit?: number;
  /**
   * Optional explicit terminal-outbox allowlist for controlled one-shot live
   * proofs. Historical rows outside this set stay suppressed by default.
   */
  terminalOutboxAllowedIds?: readonly string[];
  /** Optional dynamic terminal-outbox allowlist reader for Gateway hot reload. */
  readTerminalOutboxAllowedIds?: () => readonly string[] | undefined;
  /** Optional initial terminal-outbox cursor for controlled one-shot canaries. */
  terminalOutboxCursor?: string;
  /** Optional dynamic terminal-outbox cursor reader for Gateway hot reload. */
  readTerminalOutboxCursor?: () => string | undefined;
  /** Optional terminal-outbox cursor persistence hook for sidecar/runtime state. */
  writeTerminalOutboxCursor?: (cursor: string) => void;
  /** Skip the startup unacked backlog reconciliation for controlled one-shot canaries. */
  terminalOutboxReconcileUnackedOnStart?: boolean;
  /**
   * Historical unacknowledged terminal-outbox rows are replayable by design, but
   * they must not be live-sent after a Gateway/plugin restart unless an operator
   * explicitly opts into backlog draining. Default suppresses stale backlog to
   * prevent Telegram floods during live notification activation.
   */
  terminalOutboxHistoricalReplay?: "suppress" | "notify";
  /**
   * Broker operator SSE can replay terminal events after reconnect/start. Default
   * suppresses historical terminal notifications so enabling live Telegram does
   * not replay old completed tasks through the stream path.
   */
  terminalEventHistoricalReplay?: "suppress" | "notify";
};

type InternalState = {
  connection: A2AOperatorEventBridgeConnection;
  requestedCursor?: string;
  cursor?: string;
  terminalOutboxCursor?: string;
  terminalOutbox?: A2AOperatorTerminalOutboxProjection;
  connectedAt?: number;
  lastEvent?: {
    id?: string;
    name: A2ABrokerOperatorSseEvent["name"];
    timestamp: number;
  };
  lastFailure?: A2AOperatorEventBridgeVisibleFailure;
  snapshot?: UnknownRecord;
  liveSummary?: UnknownRecord;
  releaseDrift?: A2AOperatorReleaseDriftSummary;
  workerProgress?: A2AOperatorWorkerProgressProjection;
  githubEvidence?: A2AOperatorGitHubTaskEvidenceProjection;
  terminalReceipts: Map<string, A2AOperatorTerminalReceiptProjection>;
  openAlerts: Map<string, A2AOperatorEventBridgeAlert>;
  resolvedAlerts: Map<string, A2AOperatorEventBridgeAlert>;
  notifiedDedupeKeys: Set<string>;
  pendingNotificationDedupeKeys: Set<string>;
  notifiedTaskKeys: Set<string>;
  pendingNotificationTaskKeys: Set<string>;
  terminalOutboxRetryAfterByDedupeKey: Map<string, number>;
  terminalOutboxNotificationFuseTripped: boolean;
  terminalOutboxStartedAt: number;
  relayedTerminalOutboxIds: Set<string>;
};

const DEFAULT_RETRY_DELAY_MS = 1_000;
// Broker general rate limit is intentionally low on operator requesters. Keep
// the default terminal-outbox poll cadence below 10/min so the poller does not
// starve itself or operator status checks before it can send/ACK a fresh row.
const DEFAULT_TERMINAL_OUTBOX_POLL_MS = 15_000;
const DEFAULT_TERMINAL_OUTBOX_RETRY_DELAY_MS = 60_000;

export function createA2AOperatorEventBridge(
  options: A2AOperatorEventBridgeOptions,
): A2AOperatorEventBridge {
  const now = options.now ?? Date.now;
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const waitForRetry = options.waitForRetry ?? defaultWaitForRetry;
  const loopAbort = new AbortController();
  let stopped = false;
  let loopPromise: Promise<void> | undefined;
  let outboxLoopPromise: Promise<void> | undefined;
  let appliedTerminalOutboxCursor = normalizeOptionalString(options.terminalOutboxCursor);
  const state: InternalState = {
    connection: "idle",
    terminalReceipts: new Map(),
    openAlerts: new Map(),
    resolvedAlerts: new Map(),
    notifiedDedupeKeys: new Set(),
    pendingNotificationDedupeKeys: new Set(),
    notifiedTaskKeys: new Set(),
    pendingNotificationTaskKeys: new Set(),
    terminalOutboxRetryAfterByDedupeKey: new Map(),
    terminalOutboxNotificationFuseTripped: false,
    terminalOutboxStartedAt: now(),
    relayedTerminalOutboxIds: new Set(),
    ...(normalizeOptionalString(options.terminalOutboxCursor) ? { terminalOutboxCursor: normalizeOptionalString(options.terminalOutboxCursor) } : {}),
  };

  function readCurrentTerminalOutboxAllowedIds(): readonly string[] {
    const dynamic = options.readTerminalOutboxAllowedIds?.();
    return Array.isArray(dynamic)
      ? dynamic.map(normalizeOptionalString).filter((value): value is string => Boolean(value))
      : options.terminalOutboxAllowedIds ?? [];
  }

  function syncTerminalOutboxCursorFromOptions(): void {
    const configuredCursor = normalizeOptionalString(options.readTerminalOutboxCursor?.())
      ?? normalizeOptionalString(options.terminalOutboxCursor);
    if (!configuredCursor || configuredCursor === appliedTerminalOutboxCursor) {
      return;
    }
    state.terminalOutboxCursor = configuredCursor;
    appliedTerminalOutboxCursor = configuredCursor;
    // A bounded canary can move the live cursor/allowlist by config hot reload.
    // Reset per-event retry/fuse state so the next poll can evaluate the new
    // operator-approved window instead of inheriting an older blocked row.
    state.terminalOutboxNotificationFuseTripped = false;
    state.terminalOutboxRetryAfterByDedupeKey.clear();
  }

  function ensureRequestedCursor(explicitCursor?: string): void {
    if (state.cursor || state.requestedCursor) {
      return;
    }
    const cursor = normalizeOptionalString(explicitCursor) ?? normalizeOptionalString(options.readCursor?.());
    if (cursor) {
      state.requestedCursor = cursor;
    }
  }

  function ensureStarted(): void {
    if (!loopPromise && !stopped) {
      state.connection = "connecting";
      loopPromise = runLoop().finally(() => {
        if (state.connection !== "disabled") {
          state.connection = "idle";
        }
        loopPromise = undefined;
      });
    }
    const outboxSkipReason = getTerminalOutboxPollerSkipReason();
    if (outboxSkipReason) {
      recordTerminalOutboxPollerState(state, {
        status: "skipped",
        reason: outboxSkipReason,
        now,
      });
      return;
    }
    if (!outboxLoopPromise && !stopped) {
      recordTerminalOutboxPollerState(state, {
        status: "started",
        reason: "terminal outbox poller started",
        now,
      });
      outboxLoopPromise = runTerminalOutboxLoop().finally(() => {
        outboxLoopPromise = undefined;
      });
    }
  }

  function getTerminalOutboxPollerSkipReason(): string | undefined {
    if (stopped) return "operator event bridge is stopped";
    if (!options.broker.listTerminalOutbox) return "broker client does not expose listTerminalOutbox; terminal outbox poller not started";
    if (options.notifyOperator && !options.broker.ackTerminalOutbox) return "broker client does not expose ackTerminalOutbox; terminal outbox poller not started";
    if (!options.notifyOperator && !options.relayTerminalProjection) return "operator notification target unavailable and cross-broker relay target unavailable; terminal outbox poller not started";
    return undefined;
  }

  function recordFailure(code: A2AOperatorEventBridgeFailureCode, message: string): void {
    state.lastFailure = {
      status: "failed",
      code,
      message,
      visible: true,
      timestamp: now(),
    };
    state.connection = "error";
  }

  async function applyEvent(event: A2ABrokerOperatorSseEvent): Promise<void> {
    const timestamp = now();
    const receiptGate = getA2AOperatorTerminalReceiptGate(event);
    const terminalNotification = await maybeNotifyOperator(event);
    state.connection = "streaming";
    if (!state.connectedAt) {
      state.connectedAt = timestamp;
    }
    state.lastEvent = {
      ...(event.id ? { id: event.id } : {}),
      name: event.name,
      timestamp,
    };
    if (event.id && (!receiptGate.isTerminal || receiptGate.receiptProjection) && terminalNotification.ackTerminalEvent) {
      state.cursor = event.id;
      if (!state.requestedCursor) {
        state.requestedCursor = event.id;
      }
      try {
        options.writeCursor?.(event.id);
      } catch {
        // Cursor persistence is a host concern; the bridge state must keep flowing.
      }
    }

    switch (event.name) {
      case "operator-snapshot":
        applySnapshotEvent(state, event.data, now);
        return;
      case "operator-summary-update":
        applySummaryEvent(state, event.data, now);
        return;
      case "operator-alert-opened":
        applyAlertOpenedEvent(state, event.data, now);
        return;
      case "operator-alert-resolved":
        applyAlertResolvedEvent(state, event.data, now);
        return;
      default:
        return;
    }
  }


  async function maybeNotifyOperator(event: A2ABrokerOperatorSseEvent): Promise<A2AOperatorNotificationAckDecision> {
    if (!options.notifyOperator) {
      return { ackTerminalEvent: true, reason: "no operator notification configured" };
    }

    const envelope = buildA2AOperatorTerminalNotificationEnvelope(event, {
      dryRun: options.dryRunNotifications,
      maxTextChars: options.notificationMaxTextChars,
    });
    if (!envelope) {
      return { ackTerminalEvent: true, reason: "not a terminal operator notification" };
    }
    if (shouldSuppressLocalCrossBrokerTerminalNotification(event.id, readOperatorEventTerminalPayload(event), options.handoffBrokerId)) {
      return {
        ackTerminalEvent: true,
        reason: "child/handoff Terminal Brief suppressed locally; parent/origin broker owns operator-facing notification",
      };
    }
    if (shouldSuppressHistoricalTerminalEventReplay(envelope, {
      startedAt: state.terminalOutboxStartedAt,
      mode: options.terminalEventHistoricalReplay ?? "suppress",
    })) {
      recordTerminalOutboxNotificationAttempt(state, {
        source: "live-stream",
        envelope,
        decision: {
          ackTerminalEvent: false,
          reason: "historical operator terminal-event replay suppressed; live Terminal Brief notifications only send post-start terminal events",
        },
        now,
      });
      return {
        ackTerminalEvent: false,
        reason: "historical operator terminal-event replay suppressed; live Terminal Brief notifications only send post-start terminal events",
      };
    }
    const taskNotificationKey = buildTaskNotificationKey(envelope);
    if (state.notifiedDedupeKeys.has(envelope.dedupeKey) || state.notifiedTaskKeys.has(taskNotificationKey)) {
      state.notifiedDedupeKeys.add(envelope.dedupeKey);
      state.notifiedTaskKeys.add(taskNotificationKey);
      return {
        ackTerminalEvent: true,
        confirmationSource: "current_session_visible",
        reason: "duplicate terminal notification suppressed for already-notified task",
      };
    }
    if (state.pendingNotificationDedupeKeys.has(envelope.dedupeKey) || state.pendingNotificationTaskKeys.has(taskNotificationKey)) {
      return { ackTerminalEvent: false, reason: "terminal notification already pending or confirmed" };
    }

    state.pendingNotificationDedupeKeys.add(envelope.dedupeKey);
    state.pendingNotificationTaskKeys.add(taskNotificationKey);
    try {
      const decision = await Promise.resolve(options.notifyOperator(envelope));
      const ackDecision = normalizeNotificationAckDecision(decision, options.dryRunNotifications === true);
      recordTerminalOutboxNotificationAttempt(state, {
        source: "live-stream",
        envelope,
        decision: ackDecision,
        now,
      });
      if (ackDecision.ackTerminalEvent) {
        state.notifiedDedupeKeys.add(envelope.dedupeKey);
        state.notifiedTaskKeys.add(taskNotificationKey);
      }
      state.pendingNotificationDedupeKeys.delete(envelope.dedupeKey);
      state.pendingNotificationTaskKeys.delete(taskNotificationKey);
      return ackDecision;
    } catch {
      // Operator delivery is owned by the OpenClaw plugin notifier.
      // A delivery failure must not break broker processing, but it also must
      // not acknowledge terminal outbox/cursor state without a visible receipt.
      state.pendingNotificationDedupeKeys.delete(envelope.dedupeKey);
      state.pendingNotificationTaskKeys.delete(taskNotificationKey);
      return { ackTerminalEvent: false, reason: "operator notification failed before receipt confirmation" };
    }
  }

  async function processTerminalOutboxOnce(reconcileUnacked: boolean): Promise<void> {
    if (!options.broker.listTerminalOutbox) return;
    syncTerminalOutboxCursorFromOptions();
    const afterId = state.terminalOutboxCursor;
    const limit = options.terminalOutboxLimit ?? 25;
    const terminalOutboxAllowedIds = readCurrentTerminalOutboxAllowedIds();
    recordTerminalOutboxPollerTick(state, { afterId, limit, reconcileUnacked, now });
    const response = await options.broker.listTerminalOutbox({
      afterId,
      reconcileUnacked,
      limit,
    });
    let nextContiguousCursor = afterId;
    let firstPendingId: string | undefined;
    let shouldHoldTerminalOutboxCursor = false;
    for (const event of response.events) {
      const relayStatus = await maybeRelayTerminalOutboxEvent(event, { reconcileUnacked, reconciledUnacked: response.reconciledUnacked ?? 0 });
      const relayFailed = relayStatus === "failed";
      const completeCurrentEvent = (): boolean => {
        if (relayFailed) {
          firstPendingId = event.id;
          shouldHoldTerminalOutboxCursor = true;
          return false;
        }
        nextContiguousCursor = event.id;
        return true;
      };
      if (shouldSuppressLocalNotificationForCrossBrokerHandoff(event, relayStatus)) {
        if (!completeCurrentEvent()) break;
        continue;
      }
      if (!options.notifyOperator || !options.broker.ackTerminalOutbox) {
        if (!completeCurrentEvent()) break;
        continue;
      }
      if (event.ack?.status === "receipt_confirmed" || event.deliveredAt) {
        if (!completeCurrentEvent()) break;
        continue;
      }
      const envelope = buildA2AOperatorTerminalOutboxNotificationEnvelope(event, {
        dryRun: options.dryRunNotifications,
        maxTextChars: options.notificationMaxTextChars,
      });
      if (!envelope) {
        firstPendingId = event.id;
        shouldHoldTerminalOutboxCursor = true;
        break;
      }
      const taskNotificationKey = buildTaskNotificationKey(envelope);
      if (terminalOutboxAllowedIds.length && !isAllowedTerminalOutboxEvent(event, terminalOutboxAllowedIds)) {
        if (!completeCurrentEvent()) break;
        continue;
      }
      if (shouldSuppressHistoricalTerminalOutboxReplay(event, {
        reconcileUnacked,
        reconciledUnacked: response.reconciledUnacked ?? 0,
        startedAt: state.terminalOutboxStartedAt,
        mode: options.terminalOutboxHistoricalReplay ?? "suppress",
      })) {
        recordTerminalOutboxNotificationAttempt(state, {
          source: "outbox-backlog",
          envelope,
          decision: {
            ackTerminalEvent: false,
            reason: "historical terminal-outbox replay suppressed; run manual backlog review/ACK before enabling live Terminal Brief notifications",
          },
          now,
        });
        // Suppressed historical rows are intentionally not live-sent or ACKed,
        // but they must not pin after_id forever. Advancing the read cursor lets
        // a controlled fresh allowlisted canary behind old unacked rows become
        // observable without enabling historical replay.
        if (!completeCurrentEvent()) break;
        continue;
      }
      if (state.terminalOutboxNotificationFuseTripped) {
        recordTerminalOutboxNotificationAttempt(state, {
          source: "outbox-backlog",
          envelope,
          decision: {
            ackTerminalEvent: false,
            reason:
              "terminal-outbox one-shot live notification fuse is tripped; manual receipt/ACK is required before any further Terminal Brief sends",
          },
          now,
        });
        firstPendingId = event.id;
        shouldHoldTerminalOutboxCursor = true;
        break;
      }
      if (state.notifiedDedupeKeys.has(envelope.dedupeKey) || state.notifiedTaskKeys.has(taskNotificationKey)) {
        const acknowledgedAt = new Date(now()).toISOString();
        await options.broker.ackTerminalOutbox({
          id: event.id,
          receipt: {
            evidence: "operator_visible",
            acknowledgedAt,
            note: "duplicate terminal notification suppressed for already-notified task",
          },
        });
        recordTerminalOutboxAck(state, event, {
          evidence: "operator_visible",
          acknowledgedAt,
          now,
        });
        state.notifiedDedupeKeys.add(envelope.dedupeKey);
        state.notifiedTaskKeys.add(taskNotificationKey);
        if (!completeCurrentEvent()) break;
        continue;
      }
      if (state.pendingNotificationDedupeKeys.has(envelope.dedupeKey) || state.pendingNotificationTaskKeys.has(taskNotificationKey)) {
        firstPendingId = event.id;
        shouldHoldTerminalOutboxCursor = true;
        break;
      }
      const retryAfter = state.terminalOutboxRetryAfterByDedupeKey.get(envelope.dedupeKey) ?? 0;
      if (retryAfter > now()) {
        firstPendingId = event.id;
        shouldHoldTerminalOutboxCursor = true;
        break;
      }
      state.pendingNotificationDedupeKeys.add(envelope.dedupeKey);
      state.pendingNotificationTaskKeys.add(taskNotificationKey);
      let decision: A2AOperatorNotificationAckDecision;
      try {
        decision = normalizeNotificationAckDecision(await Promise.resolve(options.notifyOperator(envelope)), options.dryRunNotifications === true);
      } catch (error) {
        decision = {
          ackTerminalEvent: false,
          reason: `operator notification failed before receipt confirmation: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        state.pendingNotificationDedupeKeys.delete(envelope.dedupeKey);
        state.pendingNotificationTaskKeys.delete(taskNotificationKey);
      }
      recordTerminalOutboxNotificationAttempt(state, {
        source: "outbox-backlog",
        envelope,
        decision,
        now,
      });
      const receiptStatus = terminalOutboxReceiptStatusFromDecision(decision);
      if (!decision.ackTerminalEvent && receiptStatus && shouldAdvanceTerminalOutboxCursorAfterReceiptStatus(receiptStatus)) {
        if (!options.broker.recordTerminalOutboxReceipt) {
          state.terminalOutboxNotificationFuseTripped = true;
          state.terminalOutboxRetryAfterByDedupeKey.set(envelope.dedupeKey, now() + DEFAULT_TERMINAL_OUTBOX_RETRY_DELAY_MS);
          firstPendingId = event.id;
          shouldHoldTerminalOutboxCursor = true;
          break;
        }
        const updatedAt = new Date(now()).toISOString();
        try {
          await options.broker.recordTerminalOutboxReceipt({
            id: event.id,
            receipt: {
              status: receiptStatus,
              updatedAt,
              note: decision.reason ?? `terminal notification receipt recorded as ${receiptStatus}; terminal ACK remains pending`,
            },
          });
        } catch (error) {
          recordTerminalOutboxNotificationAttempt(state, {
            source: "outbox-backlog",
            envelope,
            decision: {
              ackTerminalEvent: false,
              reason: `terminal receipt update failed before cursor advance: ${error instanceof Error ? error.message : String(error)}`,
            },
            now,
          });
          state.terminalOutboxNotificationFuseTripped = true;
          state.terminalOutboxRetryAfterByDedupeKey.set(envelope.dedupeKey, now() + DEFAULT_TERMINAL_OUTBOX_RETRY_DELAY_MS);
          firstPendingId = event.id;
          shouldHoldTerminalOutboxCursor = true;
          break;
        }
        state.terminalOutboxRetryAfterByDedupeKey.delete(envelope.dedupeKey);
        if (!completeCurrentEvent()) break;
        continue;
      }
      if (!decision.ackTerminalEvent) {
        state.terminalOutboxNotificationFuseTripped = true;
        state.terminalOutboxRetryAfterByDedupeKey.set(envelope.dedupeKey, now() + DEFAULT_TERMINAL_OUTBOX_RETRY_DELAY_MS);
        firstPendingId = event.id;
        shouldHoldTerminalOutboxCursor = true;
        break;
      }
      const evidence = terminalOutboxAckEvidenceFromDecision(decision);
      if (!evidence) {
        firstPendingId = event.id;
        shouldHoldTerminalOutboxCursor = true;
        break;
      }
      const acknowledgedAt = new Date(now()).toISOString();
      await options.broker.ackTerminalOutbox({
        id: event.id,
        receipt: {
          evidence,
          acknowledgedAt,
          ...(decision.receiptId ? { receiptId: decision.receiptId } : {}),
          note: decision.reason ?? `plugin notifier receipt confirmed via ${decision.confirmationSource ?? evidence}`,
        },
      });
      recordTerminalOutboxAck(state, event, {
        evidence,
        acknowledgedAt,
        receiptId: decision.receiptId,
        now,
      });
      state.notifiedDedupeKeys.add(envelope.dedupeKey);
      state.notifiedTaskKeys.add(taskNotificationKey);
      state.terminalOutboxRetryAfterByDedupeKey.delete(envelope.dedupeKey);
      if (!completeCurrentEvent()) break;
    }
    if (nextContiguousCursor && nextContiguousCursor !== afterId) {
      state.terminalOutboxCursor = nextContiguousCursor;
      try {
        options.writeTerminalOutboxCursor?.(nextContiguousCursor);
      } catch {
        // Cursor persistence is a host concern; notification processing must keep flowing.
      }
    } else if (response.cursor && !shouldHoldTerminalOutboxCursor) {
      state.terminalOutboxCursor = response.cursor;
      try {
        options.writeTerminalOutboxCursor?.(response.cursor);
      } catch {
        // Cursor persistence is a host concern; notification processing must keep flowing.
      }
    }
    recordTerminalOutboxPoll(state, response, {
      afterId,
      limit,
      now,
      cursor: state.terminalOutboxCursor,
      firstPendingId,
      cursorBlockedByUnacked: shouldHoldTerminalOutboxCursor,
    });
  }

  async function maybeRelayTerminalOutboxEvent(
    event: A2ATerminalOutboxEvent,
    params: { reconcileUnacked: boolean; reconciledUnacked: number },
  ): Promise<"not_applicable" | "succeeded" | "failed" | "skipped"> {
    if (!options.relayTerminalProjection) return "not_applicable";
    if (isParentSyntheticCrossBrokerTerminalEvent(event)) return "skipped";
    if (state.relayedTerminalOutboxIds.has(event.id)) return "succeeded";
    if (shouldSuppressHistoricalTerminalOutboxReplay(event, {
      reconcileUnacked: params.reconcileUnacked,
      reconciledUnacked: params.reconciledUnacked,
      startedAt: state.terminalOutboxStartedAt,
      mode: options.terminalOutboxHistoricalReplay ?? "suppress",
    })) {
      recordTerminalOutboxRelayAttempt(state, {
        status: "skipped",
        event,
        reason: "historical terminal-outbox replay suppressed; cross-broker relay only sends post-start/post-cursor terminal events",
        now,
      });
      return "skipped";
    }
    const projection = buildA2ACrossBrokerTerminalProjection(event, {
      ...(options.handoffBrokerId ? { handoffBrokerId: options.handoffBrokerId } : {}),
      ...(options.terminalProjectionMaxSummaryChars ? { maxSummaryChars: options.terminalProjectionMaxSummaryChars } : {}),
    });
    if (!projection) {
      recordTerminalOutboxRelayAttempt(state, {
        status: "skipped",
        event,
        reason: "terminal outbox entry has no cross-broker handoff metadata",
        now,
      });
      return "skipped";
    }
    try {
      const decision = await Promise.resolve(options.relayTerminalProjection(projection));
      state.relayedTerminalOutboxIds.add(event.id);
      recordTerminalOutboxRelayAttempt(state, {
        status: "succeeded",
        event,
        projection,
        reason: decision?.reason ?? "cross-broker terminal projection relayed to origin broker",
        now,
      });
      return "succeeded";
    } catch (error) {
      recordTerminalOutboxRelayAttempt(state, {
        status: "failed",
        event,
        projection,
        reason: error instanceof Error ? error.message : String(error),
        now,
      });
      return "failed";
    }
  }

  function isParentSyntheticCrossBrokerTerminalEvent(event: A2ATerminalOutboxEvent): boolean {
    return typeof event.id === "string" && event.id.startsWith("terminal:cross-broker");
  }

  function isParentSyntheticCrossBrokerOperatorTerminalEvent(event: A2ATerminalOutboxEvent): boolean {
    return typeof event.id === "string" && event.id.startsWith("terminal:cross-broker-operator");
  }

  function isParentSyntheticCrossBrokerProjectionEvidenceOnly(event: A2ATerminalOutboxEvent): boolean {
    if (!isParentSyntheticCrossBrokerTerminalEvent(event) || isParentSyntheticCrossBrokerOperatorTerminalEvent(event)) {
      return false;
    }
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const ownership = payload && isRecord(payload.notificationOwnership) ? payload.notificationOwnership : undefined;
    return ownership?.providerSendPermittedByProjection === false ||
      ownership?.terminalAckPermittedByProjection === false;
  }

  function shouldSuppressLocalNotificationForCrossBrokerHandoff(
    event: A2ATerminalOutboxEvent,
    relayStatus: "not_applicable" | "succeeded" | "failed" | "skipped",
  ): boolean {
    if (isParentSyntheticCrossBrokerOperatorTerminalEvent(event)) return false;
    if (isParentSyntheticCrossBrokerProjectionEvidenceOnly(event)) return true;
    if (isParentSyntheticCrossBrokerTerminalEvent(event)) return false;
    const payload = isRecord(event.payload) ? event.payload : undefined;
    if (!shouldSuppressLocalCrossBrokerTerminalNotification(event.id, payload, options.handoffBrokerId)) {
      return false;
    }
    // Relay success, relay failure, and relay-unavailable all stay parent-owned
    // for operator-facing rendering. The child/handoff broker must not create a
    // second local Terminal Brief unless the payload explicitly marks this
    // broker as the parent/broker-of-record.
    return relayStatus === "succeeded" || relayStatus === "failed" || relayStatus === "not_applicable" || relayStatus === "skipped";
  }

  async function runTerminalOutboxLoop(): Promise<void> {
    const pollMs = Math.max(0, options.terminalOutboxPollMs ?? DEFAULT_TERMINAL_OUTBOX_POLL_MS);
    let reconcileUnacked = options.terminalOutboxReconcileUnackedOnStart !== false;
    while (!stopped && !loopAbort.signal.aborted) {
      try {
        await processTerminalOutboxOnce(reconcileUnacked);
        reconcileUnacked = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordFailure("stream_runtime_failed", message);
        recordTerminalOutboxPollerState(state, {
          status: "failed",
          reason: `terminal outbox poll failed: ${message}`,
          now,
        });
      }
      try {
        await waitForRetry(pollMs, loopAbort.signal);
      } catch {
        return;
      }
    }
  }

  async function runLoop(): Promise<void> {
    while (!stopped && !loopAbort.signal.aborted) {
      const resumeCursor = state.cursor ?? state.requestedCursor;
      state.pendingNotificationDedupeKeys.clear();
      state.connection = "connecting";
      state.connectedAt = undefined;

      try {
        for await (const event of options.broker.streamOperatorEvents({
          signal: loopAbort.signal,
          ...(resumeCursor ? { lastEventId: resumeCursor } : {}),
        })) {
          if (loopAbort.signal.aborted) {
            return;
          }
          await applyEvent(event);
        }
        if (loopAbort.signal.aborted || stopped) {
          return;
        }
        recordFailure("stream_closed", "Broker operator event stream closed");
      } catch (error) {
        if (loopAbort.signal.aborted || stopped) {
          return;
        }
        recordFailure(
          state.connectedAt ? "stream_runtime_failed" : "stream_connect_failed",
          error instanceof Error ? error.message : String(error),
        );
      }

      if (loopAbort.signal.aborted || stopped) {
        return;
      }

      try {
        await waitForRetry(retryDelayMs, loopAbort.signal);
      } catch {
        return;
      }
    }
  }

  return {
    getState(requestOptions = {}) {
      ensureRequestedCursor(requestOptions.cursor);
      ensureStarted();
      return buildPublicState(state);
    },

    shutdown() {
      stopped = true;
      recordTerminalOutboxPollerState(state, {
        status: "stopped",
        reason: "operator event bridge shutdown requested",
        now,
      });
      loopAbort.abort();
    },

    async waitForIdle() {
      await Promise.all([loopPromise, outboxLoopPromise]);
    },
  };
}



function shouldSuppressHistoricalTerminalEventReplay(
  envelope: A2AOperatorTerminalNotificationEnvelope,
  params: {
    startedAt: number;
    mode: "suppress" | "notify";
  },
): boolean {
  if (params.mode === "notify") return false;
  const eventCreatedAt = readOptionalTimestamp(envelope.createdAt);
  if (eventCreatedAt === undefined) return true;
  return eventCreatedAt < params.startedAt;
}


function isAllowedTerminalOutboxEvent(event: A2ATerminalOutboxEvent, allowedIds: readonly string[]): boolean {
  const payload: UnknownRecord = isRecord(event.payload) ? event.payload : {};
  const taskId = typeof payload.taskId === "string" && payload.taskId.trim().length > 0
    ? payload.taskId.trim()
    : undefined;
  return allowedIds.some((allowed) =>
    event.id === allowed ||
    event.id.startsWith(allowed) ||
    taskId === allowed ||
    (taskId ? taskId.startsWith(allowed) : false)
  );
}

function shouldSuppressHistoricalTerminalOutboxReplay(
  event: A2ATerminalOutboxEvent,
  params: {
    reconcileUnacked: boolean;
    reconciledUnacked: number;
    startedAt: number;
    mode: "suppress" | "notify";
  },
): boolean {
  if (params.mode === "notify") return false;
  const eventCreatedAt = readTerminalOutboxEventTimestamp(event);
  if (eventCreatedAt === undefined) return true;
  return eventCreatedAt < params.startedAt;
}

function readTerminalOutboxEventTimestamp(event: A2ATerminalOutboxEvent): number | undefined {
  const payload: UnknownRecord = isRecord(event.payload) ? event.payload : {};
  return readOptionalTimestamp(event.createdAt)
    ?? readOptionalTimestamp(payload.completedAt)
    ?? readOptionalTimestamp(payload.updatedAt)
    ?? readOptionalTimestamp(payload.createdAt);
}

function readOperatorEventTerminalPayload(event: A2ABrokerOperatorSseEvent): UnknownRecord | undefined {
  const data = isRecord(event.data) ? event.data : undefined;
  if (!data) return undefined;
  return readRecordCandidate(data, ["terminalEvent", "event"]) ?? data;
}

function shouldSuppressLocalCrossBrokerTerminalNotification(
  eventId: string | undefined,
  payload: UnknownRecord | undefined,
  localBrokerId: string | undefined,
): boolean {
  if (!payload) return false;
  if (typeof eventId === "string" && eventId.startsWith("terminal:cross-broker")) return false;
  if (!readCrossBrokerHandoffRecord(payload)) return false;
  const local = normalizeOptionalString(localBrokerId);
  if (local && isTerminalPayloadOwnedByLocalBroker(payload, local)) return false;
  if (isParentBrokerOnlyTerminalPayload(payload)) return true;
  if (!local) return false;
  return true;
}

function readCrossBrokerHandoffRecord(payload: UnknownRecord): UnknownRecord | undefined {
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  const candidates = [
    payload.crossBrokerHandoff,
    payload.crossBroker,
    payload.handoff,
    metadata?.crossBrokerHandoff,
    metadata?.crossBroker,
    metadata?.handoff,
    hasDirectCrossBrokerOwnershipFields(payload) ? payload : undefined,
    metadata && hasDirectCrossBrokerOwnershipFields(metadata) ? metadata : undefined,
  ];
  for (const candidate of candidates) {
    const record = isRecord(candidate) ? candidate : undefined;
    if (!record) continue;
    const parentRoundId = normalizeOptionalString(record.parentRoundId) ?? normalizeOptionalString(record.roundId);
    const originBrokerId = normalizeOptionalString(record.originBrokerId) ?? normalizeOptionalString(record.parentBrokerId);
    const handoffBrokerId = normalizeOptionalString(record.handoffBrokerId) ?? normalizeOptionalString(record.localBrokerId);
    const brokerOfRecordId = normalizeOptionalString(record.brokerOfRecordId) ?? normalizeOptionalString(record.parentOriginBrokerId) ?? normalizeOptionalString(record.parentOwnerBrokerId);
    if (parentRoundId && (originBrokerId || handoffBrokerId || brokerOfRecordId)) return record;
  }
  return undefined;
}

function hasDirectCrossBrokerOwnershipFields(record: UnknownRecord): boolean {
  return Boolean(
    normalizeOptionalString(record.parentRoundId) &&
    (
      normalizeOptionalString(record.handoffBrokerId) ||
      normalizeOptionalString(record.localBrokerId) ||
      normalizeOptionalString(record.brokerOfRecordId) ||
      normalizeOptionalString(record.parentBrokerId) ||
      normalizeOptionalString(record.parentOriginBrokerId) ||
      normalizeOptionalString(record.parentOwnerBrokerId)
    ),
  );
}

function isParentBrokerOnlyTerminalPayload(payload: UnknownRecord): boolean {
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  const notificationOwnership = isRecord(payload.notificationOwnership) ? payload.notificationOwnership : undefined;
  const metadataNotificationOwnership = metadata && isRecord(metadata.notificationOwnership) ? metadata.notificationOwnership : undefined;
  const terminalBrief = isRecord(payload.terminalBrief) ? payload.terminalBrief : undefined;
  const metadataTerminalBrief = metadata && isRecord(metadata.terminalBrief) ? metadata.terminalBrief : undefined;
  const handoff = readCrossBrokerHandoffRecord(payload);
  const roots = [payload, metadata, notificationOwnership, metadataNotificationOwnership, terminalBrief, metadataTerminalBrief, handoff].filter(isRecord);

  return roots.some((record) => {
    const scope = normalizeOptionalString(record.scope) ?? normalizeOptionalString(record.notificationScope);
    if (scope === "parent-broker-only" || scope === "parent_broker_only") return true;
    const owner = normalizeOptionalString(record.operatorFacingOwner) ??
      normalizeOptionalString(record.terminalBriefOwner) ??
      normalizeOptionalString(record.notificationOwner);
    return record.parentOwned === true ||
      record.parentOwnedTerminalBrief === true ||
      record.parentOwnedNotification === true ||
      record.operatorFacingParentOwned === true ||
      owner === "parent" ||
      owner === "origin" ||
      owner === "parent-owned" ||
      owner === "parent_owned" ||
      owner === "broker-of-record" ||
      owner === "broker_of_record";
  });
}

function isTerminalPayloadOwnedByLocalBroker(payload: UnknownRecord, localBrokerId: string | undefined): boolean {
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  const notificationOwnership = isRecord(payload.notificationOwnership) ? payload.notificationOwnership : undefined;
  const metadataNotificationOwnership = metadata && isRecord(metadata.notificationOwnership) ? metadata.notificationOwnership : undefined;
  const terminalBrief = isRecord(payload.terminalBrief) ? payload.terminalBrief : undefined;
  const metadataTerminalBrief = metadata && isRecord(metadata.terminalBrief) ? metadata.terminalBrief : undefined;
  const handoff = readCrossBrokerHandoffRecord(payload);
  const roots = [payload, metadata, notificationOwnership, metadataNotificationOwnership, terminalBrief, metadataTerminalBrief, handoff].filter(isRecord);

  const local = normalizeOptionalString(localBrokerId);
  if (!local) return false;

  const parentBrokerIds = roots.flatMap((record) => [
    normalizeOptionalString(record.ownerBrokerId),
    normalizeOptionalString(record.brokerOfRecordId),
    normalizeOptionalString(record.parentBrokerId),
    normalizeOptionalString(record.parentOriginBrokerId),
    normalizeOptionalString(record.parentOwnerBrokerId),
  ]);
  if (parentBrokerIds.includes(local)) return true;

  const handoffOriginBrokerId = handoff
    ? normalizeOptionalString(handoff.originBrokerId) ?? normalizeOptionalString(handoff.origin) ?? normalizeOptionalString(handoff.parentBrokerId)
    : undefined;
  return handoffOriginBrokerId === local;
}

function buildTaskNotificationKey(envelope: A2AOperatorTerminalNotificationEnvelope): string {
  const taskId = normalizeOptionalString(envelope.taskId) ?? normalizeOptionalString(envelope.evidence.taskId);
  const parentRoundId = normalizeOptionalString(envelope.parentRoundId);
  const roundScope = parentRoundId ? `round:${parentRoundId}:` : "";
  if (taskId) return `${roundScope}task:${taskId}`;
  const runId = normalizeOptionalString(envelope.runId) ?? normalizeOptionalString(envelope.evidence.runId);
  if (runId) return `${roundScope}run:${runId}:${envelope.type}`;
  const url = normalizeOptionalString(envelope.doneUrl) ??
    normalizeOptionalString(envelope.prUrl) ??
    normalizeOptionalString(envelope.blockUrl) ??
    normalizeOptionalString(envelope.issueUrl) ??
    normalizeOptionalString(envelope.evidence.doneUrl) ??
    normalizeOptionalString(envelope.evidence.prUrl) ??
    normalizeOptionalString(envelope.evidence.blockUrl) ??
    normalizeOptionalString(envelope.evidence.issueUrl);
  if (url) return `${roundScope}url:${url}:${envelope.type}`;
  const worker = normalizeOptionalString(envelope.worker) ?? normalizeOptionalString(envelope.evidence.worker);
  const status = normalizeOptionalString(envelope.status) ?? normalizeOptionalString(envelope.evidence.status);
  const createdAt = normalizeOptionalString(envelope.createdAt) ?? normalizeOptionalString(envelope.evidence.createdAt);
  const summary = normalizeOptionalString(envelope.evidence.summary) ??
    normalizeOptionalString(envelope.evidence.taskSummary) ??
    normalizeOptionalString(envelope.evidence.taskBrief) ??
    normalizeOptionalString(envelope.evidence.taskDescription) ??
    normalizeOptionalString(envelope.title);
  if (worker && createdAt && summary) {
    return `${roundScope}semantic:${envelope.type}:${worker}:${status ?? "unknown"}:${createdAt}:${summary}`;
  }
  return `${roundScope}dedupe:${envelope.dedupeKey}`;
}

function terminalOutboxAckEvidenceFromDecision(
  decision: A2AOperatorNotificationAckDecision,
): A2ATerminalOutboxAckEvidence | undefined {
  if (decision.confirmationSource === "manual_operator_receipt") return "operator_confirmed";
  if (decision.confirmationSource === "current_session_visible") return "operator_visible";
  // Backward-compatible tests may stub only ackTerminalEvent=true. Production
  // adapter only returns true after a current-session/manual receipt, never on
  // provider send success alone.
  return decision.ackTerminalEvent ? "operator_visible" : undefined;
}

function terminalOutboxReceiptStatusFromDecision(
  decision: A2AOperatorNotificationAckDecision,
): A2AOperatorTerminalOutboxReceiptStatus | undefined {
  return decision.terminalReceiptStatus;
}

function shouldAdvanceTerminalOutboxCursorAfterReceiptStatus(
  status: A2AOperatorTerminalOutboxReceiptStatus,
): boolean {
  return status === "accepted" ||
    status === "started" ||
    status === "produced" ||
    status === "provider_sent" ||
    status === "provider_accepted";
}

export function normalizeNotificationAckDecision(
  decision: void | A2AOperatorNotificationAckDecision,
  dryRun: boolean,
): A2AOperatorNotificationAckDecision {
  if (dryRun) {
    return { ackTerminalEvent: true, reason: "dry-run projection only" };
  }
  if (decision?.ackTerminalEvent === true) {
    return {
      ackTerminalEvent: true,
      ...(decision.reason ? { reason: decision.reason } : {}),
      ...(decision.confirmationSource ? { confirmationSource: decision.confirmationSource } : {}),
      ...(decision.receiptId ? { receiptId: decision.receiptId } : {}),
    };
  }
  return {
    ackTerminalEvent: false,
    reason: decision?.reason ?? "waiting for current-session or manual receipt confirmation",
    ...(decision?.terminalReceiptStatus ? { terminalReceiptStatus: decision.terminalReceiptStatus } : {}),
    ...(decision?.receiptId ? { receiptId: decision.receiptId } : {}),
  };
}

export function buildDisabledA2AOperatorEventBridgeState(params: {
  cursor?: string;
  note?: string;
} = {}): A2AOperatorEventBridgeState {
  return {
    kind: "a2a.operator.monitor",
    enabled: false,
    bridge: {
      connection: "disabled",
      ...(normalizeOptionalString(params.note) ? { note: normalizeOptionalString(params.note) } : {}),
      ...(normalizeOptionalString(params.cursor)
        ? { requestedCursor: normalizeOptionalString(params.cursor) }
        : {}),
    },
    operator: {
      safetyStatus: buildMonitorSafetyStatus(undefined, ["operator event bridge is disabled"]),
      alerts: {
        open: [],
        resolved: [],
      },
    },
  };
}

export function buildUnavailableA2AOperatorEventBridgeState(params: {
  message: string;
  cursor?: string;
  now?: () => number;
}): A2AOperatorEventBridgeState {
  const timestamp = (params.now ?? Date.now)();
  return {
    kind: "a2a.operator.monitor",
    enabled: true,
    bridge: {
      connection: "error",
      ...(normalizeOptionalString(params.cursor)
        ? { requestedCursor: normalizeOptionalString(params.cursor) }
        : {}),
      lastFailure: {
        status: "failed",
        code: "stream_connect_failed",
        message: params.message,
        visible: true,
        timestamp,
      },
    },
    operator: {
      safetyStatus: buildMonitorSafetyStatus(undefined, ["operator event bridge is unavailable"]),
      alerts: {
        open: [],
        resolved: [],
      },
    },
  };
}

function recordTerminalOutboxPollerState(
  state: InternalState,
  params: { status: "started" | "skipped" | "stopped" | "failed"; reason: string; now: () => number },
): void {
  const timestamp = params.now();
  const previousPoller = state.terminalOutbox?.poller;
  state.terminalOutbox = {
    ...state.terminalOutbox,
    poller: {
      status: params.status,
      reason: params.reason,
      timestamp,
      ...(previousPoller?.lastTick ? { lastTick: previousPoller.lastTick } : {}),
      ...(params.status === "failed"
        ? { lastError: { timestamp, message: params.reason } }
        : previousPoller?.lastError
          ? { lastError: previousPoller.lastError }
          : {}),
    },
  };
}

function recordTerminalOutboxPollerTick(
  state: InternalState,
  params: { afterId?: string; limit: number; reconcileUnacked: boolean; now: () => number },
): void {
  const previousPoller = state.terminalOutbox?.poller;
  state.terminalOutbox = {
    ...state.terminalOutbox,
    poller: {
      status: previousPoller?.status === "failed" ? "started" : previousPoller?.status ?? "started",
      reason: previousPoller?.status === "failed"
        ? "terminal outbox poller recovered; polling resumed"
        : previousPoller?.reason ?? "terminal outbox poller started",
      timestamp: previousPoller?.timestamp ?? params.now(),
      lastTick: {
        timestamp: params.now(),
        ...(params.afterId ? { afterId: params.afterId } : {}),
        limit: params.limit,
        reconcileUnacked: params.reconcileUnacked,
      },
      ...(previousPoller?.lastError ? { lastError: previousPoller.lastError } : {}),
    },
  };
}

function recordTerminalOutboxPoll(
  state: InternalState,
  response: A2ATerminalOutboxListResponse,
  params: {
    afterId?: string;
    limit: number;
    now: () => number;
    cursor?: string;
    firstPendingId?: string;
    cursorBlockedByUnacked?: boolean;
  },
): void {
  const pending = response.events
    .filter((event) => event.ack?.status !== "receipt_confirmed" && !event.deliveredAt)
    .map(projectTerminalOutboxEvent)
    .slice(0, 10);
  const cursor = normalizeOptionalString(params.cursor) ?? state.terminalOutboxCursor;
  state.terminalOutbox = {
    ...state.terminalOutbox,
    ...(cursor ? { cursor } : {}),
    lastPoll: {
      timestamp: params.now(),
      ...(params.afterId ? { afterId: params.afterId } : {}),
      limit: params.limit,
      count: response.count,
      reconciledUnacked: response.reconciledUnacked ?? 0,
      backlogDrain: (response.reconciledUnacked ?? 0) > 0,
      pendingUnacknowledged: pending.length,
      ...(params.firstPendingId ? { firstPendingId: params.firstPendingId } : {}),
      ...(params.cursorBlockedByUnacked ? { cursorBlockedByUnacked: true } : {}),
    },
    ...(pending.length ? { pendingUnacknowledged: pending } : { pendingUnacknowledged: undefined }),
    ...(pending[0] ? { lastEvent: pending[0] } : {}),
  };
}

function recordTerminalOutboxNotificationAttempt(
  state: InternalState,
  params: {
    source: "live-stream" | "outbox-backlog";
    envelope: A2AOperatorTerminalNotificationEnvelope;
    decision: A2AOperatorNotificationAckDecision;
    now: () => number;
  },
): void {
  state.terminalOutbox = {
    ...state.terminalOutbox,
    lastNotificationAttempt: {
      source: params.source,
      timestamp: params.now(),
      ...(params.envelope.taskId ? { taskId: params.envelope.taskId } : {}),
      terminalEventId: params.envelope.id,
      dedupeKey: params.envelope.dedupeKey,
      receiptStatus: params.decision.ackTerminalEvent ? "received" : "pending",
      reason: params.decision.reason ?? (params.decision.ackTerminalEvent ? "receipt confirmed" : "receipt pending"),
    },
  };
}

function recordTerminalOutboxAck(
  state: InternalState,
  event: A2ATerminalOutboxEvent,
  params: {
    evidence: A2ATerminalOutboxAckEvidence;
    acknowledgedAt: string;
    receiptId?: string;
    now: () => number;
  },
): void {
  const projected = projectTerminalOutboxEvent(event);
  state.terminalOutbox = {
    ...state.terminalOutbox,
    lastEvent: projected,
    lastAck: {
      id: event.id,
      ...(projected.taskId ? { taskId: projected.taskId } : {}),
      evidence: params.evidence,
      ...(params.receiptId ? { receiptId: params.receiptId } : {}),
      acknowledgedAt: params.acknowledgedAt,
      timestamp: params.now(),
    },
  };
}

function recordTerminalOutboxRelayAttempt(
  state: InternalState,
  params: {
    status: "succeeded" | "failed" | "skipped";
    event: A2ATerminalOutboxEvent;
    projection?: A2ACrossBrokerTerminalProjection;
    reason: string;
    now: () => number;
  },
): void {
  const previous = state.terminalOutbox?.crossBrokerRelay;
  const timestamp = params.now();
  const relayed = (previous?.relayed ?? 0) + (params.status === "succeeded" ? 1 : 0);
  const skipped = (previous?.skipped ?? 0) + (params.status === "skipped" ? 1 : 0);
  const failed = (previous?.failed ?? 0) + (params.status === "failed" ? 1 : 0);
  state.terminalOutbox = {
    ...state.terminalOutbox,
    crossBrokerRelay: {
      status: params.status,
      ...(state.terminalOutboxCursor ? { cursor: state.terminalOutboxCursor } : {}),
      relayed,
      skipped,
      failed,
      lastAttempt: {
        timestamp,
        terminalOutboxId: params.event.id,
        ...(params.projection?.childTaskId ? { childTaskId: params.projection.childTaskId } : {}),
        ...(params.projection?.parentRoundId ? { parentRoundId: params.projection.parentRoundId } : {}),
        ...(params.projection?.originBrokerId ? { originBrokerId: params.projection.originBrokerId } : {}),
        status: params.status,
        reason: params.reason,
      },
      ...(params.projection && params.status === "succeeded"
        ? {
            lastSuccess: {
              timestamp,
              terminalOutboxId: params.event.id,
              relayId: params.projection.relayId,
              childTaskId: params.projection.childTaskId,
              parentRoundId: params.projection.parentRoundId,
              originBrokerId: params.projection.originBrokerId,
            },
          }
        : previous?.lastSuccess
          ? { lastSuccess: { ...previous.lastSuccess } }
          : {}),
      ...(params.status === "failed"
        ? { lastError: { timestamp, terminalOutboxId: params.event.id, message: params.reason } }
        : previous?.lastError
          ? { lastError: { ...previous.lastError } }
          : {}),
      receiptGate: {
        providerGatewaySendSuccess: "not_ack_evidence",
        terminalAckEligible: false,
      },
    },
  };
}

function projectTerminalOutboxEvent(event: A2ATerminalOutboxEvent): A2AOperatorTerminalOutboxEventProjection {
  const payload: UnknownRecord = isRecord(event.payload) ? event.payload : {};
  const taskId = safeOperatorString(payload.taskId);
  const status = safeOperatorString(payload.status);
  const repo = safeOperatorString(payload.repo);
  const prUrl = safeOperatorString(payload.prUrl);
  const doneUrl = safeOperatorString(payload.doneUrl);
  const blockUrl = safeOperatorString(payload.blockUrl);
  const createdAt = safeOperatorString(event.createdAt, payload.createdAt);
  const completedAt = safeOperatorString(payload.completedAt);
  const ackStatus = safeOperatorString(event.ack?.status);
  return {
    id: event.id,
    ...(taskId ? { taskId } : {}),
    ...(status ? { status } : {}),
    ...(repo ? { repo } : {}),
    ...(typeof payload.issue === "number" ? { issue: payload.issue } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(doneUrl ? { doneUrl } : {}),
    ...(blockUrl ? { blockUrl } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    attempts: event.attempts,
    ...(ackStatus ? { ackStatus } : {}),
  };
}

function addDoctorDiagnostics(
  projection: A2AOperatorTerminalOutboxProjection,
  state: InternalState,
): A2AOperatorTerminalOutboxProjection {
  return {
    ...projection,
    doctorDiagnostics: {
      notifiedDedupeKeyCount: state.notifiedDedupeKeys.size,
      pendingNotificationDedupeKeyCount: state.pendingNotificationDedupeKeys.size,
      notifiedTaskKeyCount: state.notifiedTaskKeys.size,
      pendingNotificationTaskKeyCount: state.pendingNotificationTaskKeys.size,
      notificationFuseTripped: state.terminalOutboxNotificationFuseTripped,
      retryAfterCount: state.terminalOutboxRetryAfterByDedupeKey.size,
      relayedTerminalOutboxIdCount: state.relayedTerminalOutboxIds.size,
    },
  };
}

function cloneTerminalOutboxProjection(
  projection: A2AOperatorTerminalOutboxProjection,
): A2AOperatorTerminalOutboxProjection {
  const cloned = {
    ...projection,
    ...(projection.lastPoll ? { lastPoll: { ...projection.lastPoll } } : {}),
    ...(projection.pendingUnacknowledged ? { pendingUnacknowledged: projection.pendingUnacknowledged.map((event) => ({ ...event })) } : {}),
    ...(projection.lastEvent ? { lastEvent: { ...projection.lastEvent } } : {}),
    ...(projection.lastNotificationAttempt ? { lastNotificationAttempt: { ...projection.lastNotificationAttempt } } : {}),
    ...(projection.lastAck ? { lastAck: { ...projection.lastAck } } : {}),
    ...(projection.crossBrokerRelay ? { crossBrokerRelay: cloneTerminalOutboxRelayProjection(projection.crossBrokerRelay) } : {}),
  };
  return {
    ...cloned,
    deployPreflight: buildTerminalOutboxDeployPreflightProjection(cloned),
  };
}

function cloneTerminalOutboxRelayProjection(
  projection: A2AOperatorTerminalOutboxRelayProjection,
): A2AOperatorTerminalOutboxRelayProjection {
  return {
    ...projection,
    ...(projection.lastAttempt ? { lastAttempt: { ...projection.lastAttempt } } : {}),
    ...(projection.lastSuccess ? { lastSuccess: { ...projection.lastSuccess } } : {}),
    ...(projection.lastError ? { lastError: { ...projection.lastError } } : {}),
    receiptGate: { ...projection.receiptGate },
  };
}

function buildMonitorSafetyStatus(
  terminalOutbox?: A2AOperatorTerminalOutboxProjection,
  extraBlockers: string[] = [],
): A2AOperatorMonitorSafetyStatus {
  const deployPreflight = terminalOutbox?.deployPreflight;
  const status = deployPreflight?.status ?? "unknown";
  const terminalAckEligible = deployPreflight?.receiptGate.terminalAckEligible ?? false;
  const blockers = [...extraBlockers];
  if (!deployPreflight) {
    blockers.push("terminal outbox preflight evidence unavailable");
  } else if (deployPreflight.status === "blocked") {
    blockers.push("terminal outbox has unacknowledged or receipt-unconfirmed events");
  } else if (deployPreflight.status === "unknown") {
    blockers.push("terminal outbox has not been polled yet");
  }

  return {
    mode: "release-dryrun/no-live",
    status: blockers.length ? (status === "ready" ? "blocked" : status) : status,
    blockers,
    safeOperations: {
      liveSend: false,
      terminalOutboxAck: false,
      gatewayRestart: false,
      productionDeploy: false,
    },
    receiptGate: {
      ackRequires: ["current_session_visible", "manual_operator_receipt"],
      providerGatewaySendSuccess: "not_ack_evidence",
      terminalAckEligible,
    },
  };
}

function buildTerminalOutboxDeployPreflightProjection(
  projection: A2AOperatorTerminalOutboxProjection,
): A2AOperatorTerminalOutboxDeployPreflightProjection {
  const pendingUnacknowledged = projection.lastPoll?.pendingUnacknowledged ?? projection.pendingUnacknowledged?.length ?? 0;
  const terminalAckEligible = projection.lastNotificationAttempt?.receiptStatus === "received" || Boolean(projection.lastAck);
  const status = !projection.lastPoll
    ? "unknown"
    : pendingUnacknowledged > 0 && !terminalAckEligible
      ? "blocked"
      : "ready";
  return {
    mode: "dry-run-projection",
    status,
    ...(projection.cursor ? { cursor: projection.cursor } : {}),
    backlog: {
      ...(projection.lastPoll ? { lastPollAt: projection.lastPoll.timestamp } : {}),
      pendingUnacknowledged,
      reconciledUnacked: projection.lastPoll?.reconciledUnacked ?? 0,
      backlogDrain: projection.lastPoll?.backlogDrain ?? false,
    },
    ...(projection.lastNotificationAttempt
      ? {
          lastNotificationAttempt: {
            source: projection.lastNotificationAttempt.source,
            timestamp: projection.lastNotificationAttempt.timestamp,
            ...(projection.lastNotificationAttempt.taskId ? { taskId: projection.lastNotificationAttempt.taskId } : {}),
            ...(projection.lastNotificationAttempt.terminalEventId
              ? { terminalEventId: projection.lastNotificationAttempt.terminalEventId }
              : {}),
            receiptStatus: projection.lastNotificationAttempt.receiptStatus,
            reason: projection.lastNotificationAttempt.reason,
          },
        }
      : {}),
    receiptGate: {
      ackRequires: ["current_session_visible", "manual_operator_receipt"],
      providerGatewaySendSuccess: "not_ack_evidence",
      terminalAckEligible,
      ...(projection.lastAck ? { evidence: projection.lastAck.evidence } : {}),
      ...(projection.lastAck?.receiptId ? { receiptId: projection.lastAck.receiptId } : {}),
    },
    safeOperations: {
      liveSend: false,
      terminalOutboxAck: false,
      gatewayRestart: false,
      productionDeploy: false,
    },
  };
}

function buildPublicState(state: InternalState): A2AOperatorEventBridgeState {
  const terminalOutbox = state.terminalOutbox
    ? addDoctorDiagnostics(cloneTerminalOutboxProjection(state.terminalOutbox), state)
    : undefined;
  return {
    kind: "a2a.operator.monitor",
    enabled: true,
    bridge: {
      connection: state.connection,
      ...(state.requestedCursor ? { requestedCursor: state.requestedCursor } : {}),
      ...(state.cursor ? { cursor: state.cursor } : {}),
      ...(state.connectedAt ? { connectedAt: state.connectedAt } : {}),
      ...(state.lastEvent
        ? {
            lastEvent: {
              ...(state.lastEvent.id ? { id: state.lastEvent.id } : {}),
              name: state.lastEvent.name,
              timestamp: state.lastEvent.timestamp,
            },
          }
        : {}),
      ...(state.lastFailure ? { lastFailure: { ...state.lastFailure } } : {}),
    },
    operator: {
      ...(state.snapshot ? { snapshot: cloneRecord(state.snapshot) } : {}),
      ...(state.liveSummary ? { liveSummary: cloneRecord(state.liveSummary) } : {}),
      ...(state.releaseDrift ? { releaseDrift: cloneReleaseDriftSummary(state.releaseDrift) } : {}),
      ...(state.workerProgress ? { workerProgress: cloneWorkerProgressProjection(state.workerProgress) } : {}),
      ...(state.githubEvidence ? { githubEvidence: cloneGitHubTaskEvidenceProjection(state.githubEvidence) } : {}),
      safetyStatus: buildMonitorSafetyStatus(terminalOutbox),
      ...(state.terminalReceipts.size
        ? { terminalReceipts: [...state.terminalReceipts.values()].map((receipt) => ({ ...receipt })) }
        : {}),
      ...(terminalOutbox ? { terminalOutbox } : {}),
      alerts: {
        open: [...state.openAlerts.values()].map(cloneAlert).sort(compareAlerts),
        resolved: [...state.resolvedAlerts.values()].map(cloneAlert).sort(compareAlerts),
      },
    },
  };
}

function applySnapshotEvent(
  state: InternalState,
  payload: UnknownRecord,
  now: () => number,
): void {
  const roots = buildPayloadRoots(payload);
  state.snapshot = cloneRecord(roots[0]);

  const summary = readRecordFromRoots(roots, ["summary", "liveSummary", "operatorSummary"]);
  if (summary) {
    state.liveSummary = cloneRecord(summary);
  }
  applyReleaseDriftSummary(state, roots);
  applyWorkerProgressProjection(state, summary ? [summary, ...roots] : roots, now);
  applyGitHubTaskEvidenceProjection(state, summary ? [summary, ...roots] : roots, now);
  applyTerminalReceiptProjection(state, summary ? [summary, ...roots] : roots, now);

  const openAlerts = readAlertArrayFromRoots(roots, ["alerts", "openAlerts"]);
  if (openAlerts) {
    state.openAlerts.clear();
    for (const rawAlert of openAlerts) {
      const alert = normalizeAlert(rawAlert, "open", now);
      state.openAlerts.set(alert.alertId, alert);
      state.resolvedAlerts.delete(alert.alertId);
    }
  }

  const resolvedAlerts = readAlertArrayFromRoots(roots, ["resolvedAlerts"]);
  if (resolvedAlerts) {
    state.resolvedAlerts.clear();
    for (const rawAlert of resolvedAlerts) {
      const alert = normalizeAlert(rawAlert, "resolved", now);
      const existing = state.openAlerts.get(alert.alertId);
      state.resolvedAlerts.set(
        alert.alertId,
        mergeAlerts(existing, alert),
      );
      state.openAlerts.delete(alert.alertId);
    }
  }
}

function applySummaryEvent(
  state: InternalState,
  payload: UnknownRecord,
  now: () => number,
): void {
  const roots = buildPayloadRoots(payload);
  const summary =
    readRecordFromRoots(roots, ["summary", "liveSummary", "operatorSummary"]) ?? roots[0];
  state.liveSummary = cloneRecord(summary);
  applyReleaseDriftSummary(state, roots);
  applyWorkerProgressProjection(state, [summary, ...roots], now);
  applyGitHubTaskEvidenceProjection(state, [summary, ...roots], now);
  applyTerminalReceiptProjection(state, [summary, ...roots], now);
}

function applyReleaseDriftSummary(state: InternalState, roots: UnknownRecord[]): void {
  const releaseDrift = buildA2AOperatorReleaseDriftSummary(roots);
  if (releaseDrift) {
    state.releaseDrift = releaseDrift;
  }
}

function applyWorkerProgressProjection(
  state: InternalState,
  roots: UnknownRecord[],
  now: () => number,
): void {
  const projection = buildWorkerProgressProjection(roots, now);
  if (projection) {
    state.workerProgress = projection;
  }
}

function applyGitHubTaskEvidenceProjection(
  state: InternalState,
  roots: UnknownRecord[],
  now: () => number,
): void {
  const projection = buildGitHubTaskEvidenceProjection(roots, now);
  if (projection) {
    state.githubEvidence = projection;
  }
}

function applyAlertOpenedEvent(
  state: InternalState,
  payload: UnknownRecord,
  now: () => number,
): void {
  const alert = normalizeAlert(extractAlertRecord(payload), "open", now);
  state.openAlerts.set(alert.alertId, mergeAlerts(state.openAlerts.get(alert.alertId), alert));
  state.resolvedAlerts.delete(alert.alertId);
}

function applyAlertResolvedEvent(
  state: InternalState,
  payload: UnknownRecord,
  now: () => number,
): void {
  const next = normalizeAlert(extractAlertRecord(payload), "resolved", now);
  const existing = state.openAlerts.get(next.alertId) ?? state.resolvedAlerts.get(next.alertId);
  state.resolvedAlerts.set(next.alertId, mergeAlerts(existing, next));
  state.openAlerts.delete(next.alertId);
}

function mergeAlerts(
  current: A2AOperatorEventBridgeAlert | undefined,
  next: A2AOperatorEventBridgeAlert,
): A2AOperatorEventBridgeAlert {
  if (!current) {
    return next;
  }
  return {
    alertId: next.alertId,
    status: next.status,
    ...(next.message ?? current.message ? { message: next.message ?? current.message } : {}),
    ...(next.severity ?? current.severity
      ? { severity: next.severity ?? current.severity }
      : {}),
    ...(next.source ?? current.source ? { source: next.source ?? current.source } : {}),
    ...(next.openedAt ?? current.openedAt ? { openedAt: next.openedAt ?? current.openedAt } : {}),
    ...(next.resolvedAt ?? current.resolvedAt
      ? { resolvedAt: next.resolvedAt ?? current.resolvedAt }
      : {}),
    details: {
      ...(current.details ?? {}),
      ...(next.details ?? {}),
    },
  };
}

function buildPayloadRoots(payload: UnknownRecord): UnknownRecord[] {
  const snapshot = readRecordCandidate(payload, ["snapshot"]);
  return snapshot ? [snapshot, payload] : [payload];
}

function extractAlertRecord(payload: UnknownRecord): UnknownRecord {
  return (
    readRecordCandidate(payload, ["alert", "openedAlert", "resolvedAlert"]) ??
    payload
  );
}

function normalizeAlert(
  payload: UnknownRecord,
  status: "open" | "resolved",
  now: () => number,
): A2AOperatorEventBridgeAlert {
  const openedAt =
    readOptionalTimestamp(payload.openedAt) ??
    readOptionalTimestamp(payload.startedAt) ??
    readOptionalTimestamp(payload.createdAt) ??
    (status === "open" ? now() : undefined);
  const resolvedAt =
    readOptionalTimestamp(payload.resolvedAt) ??
    readOptionalTimestamp(payload.endedAt) ??
    readOptionalTimestamp(payload.updatedAt) ??
    (status === "resolved" ? now() : undefined);
  const message =
    normalizeOptionalString(payload.message) ??
    normalizeOptionalString(payload.summary) ??
    normalizeOptionalString(payload.title);
  const severity =
    normalizeOptionalString(payload.severity) ?? normalizeOptionalString(payload.level);
  const source =
    normalizeOptionalString(payload.source) ??
    normalizeOptionalString(payload.nodeId) ??
    normalizeOptionalString(payload.service);
  const alertId =
    normalizeOptionalString(payload.id) ??
    normalizeOptionalString(payload.alertId) ??
    normalizeOptionalString(payload.key) ??
    normalizeOptionalString(payload.code) ??
    `alert:${status}:${openedAt ?? resolvedAt ?? now()}`;

  return {
    alertId,
    status,
    ...(message ? { message } : {}),
    ...(severity ? { severity } : {}),
    ...(source ? { source } : {}),
    ...(openedAt ? { openedAt } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
    details: cloneRecord(payload),
  };
}

function compareAlerts(a: A2AOperatorEventBridgeAlert, b: A2AOperatorEventBridgeAlert): number {
  return a.alertId.localeCompare(b.alertId);
}

function cloneReleaseDriftSummary(
  summary: A2AOperatorReleaseDriftSummary,
): A2AOperatorReleaseDriftSummary {
  return {
    ...summary,
    broker: { ...summary.broker },
    workers: summary.workers.map((worker) => ({ ...worker })),
  };
}

function cloneWorkerProgressProjection(
  projection: A2AOperatorWorkerProgressProjection,
): A2AOperatorWorkerProgressProjection {
  return {
    status: projection.status,
    counts: { ...projection.counts },
    workers: projection.workers.map((worker) => ({ ...worker })),
  };
}

function cloneGitHubTaskEvidenceProjection(
  projection: A2AOperatorGitHubTaskEvidenceProjection,
): A2AOperatorGitHubTaskEvidenceProjection {
  return {
    status: projection.status,
    counts: { ...projection.counts },
    tasks: projection.tasks.map((task) => ({ ...task })),
  };
}

function cloneAlert(alert: A2AOperatorEventBridgeAlert): A2AOperatorEventBridgeAlert {
  return {
    alertId: alert.alertId,
    status: alert.status,
    ...(alert.message ? { message: alert.message } : {}),
    ...(alert.severity ? { severity: alert.severity } : {}),
    ...(alert.source ? { source: alert.source } : {}),
    ...(alert.openedAt ? { openedAt: alert.openedAt } : {}),
    ...(alert.resolvedAt ? { resolvedAt: alert.resolvedAt } : {}),
    ...(alert.details ? { details: cloneRecord(alert.details) } : {}),
  };
}

function cloneRecord(record: UnknownRecord): UnknownRecord {
  return structuredClone(record);
}

function readRecordFromRoots(
  roots: UnknownRecord[],
  keys: string[],
): UnknownRecord | undefined {
  for (const root of roots) {
    const record = readRecordCandidate(root, keys);
    if (record) {
      return record;
    }
  }
  return undefined;
}

function readAlertArrayFromRoots(
  roots: UnknownRecord[],
  keys: string[],
): UnknownRecord[] | undefined {
  for (const root of roots) {
    const records = readRecordArrayCandidate(root, keys);
    if (records) {
      return records;
    }

    for (const key of keys) {
      const nested = root[key];
      if (!isRecord(nested)) {
        continue;
      }
      const nestedRecords = readRecordArrayCandidate(nested, ["alerts", "items", "open"]);
      if (nestedRecords) {
        return nestedRecords;
      }
    }
  }
  return undefined;
}

function buildWorkerProgressProjection(
  roots: UnknownRecord[],
  now: () => number,
): A2AOperatorWorkerProgressProjection | undefined {
  const byWorker = new Map<string, A2AOperatorWorkerProgressItem>();

  for (const root of roots) {
    for (const record of readWorkerRecords(root)) {
      const item = normalizeWorkerProgressItem(record, now);
      if (item) {
        byWorker.set(item.workerId, { ...byWorker.get(item.workerId), ...item });
      }
    }
    for (const record of readTaskRecords(root)) {
      const item = normalizeTaskProgressItem(record, now);
      if (!item) continue;
      byWorker.set(item.workerId, { ...byWorker.get(item.workerId), ...item });
    }
  }

  const workers = [...byWorker.values()].sort((a, b) => a.workerId.localeCompare(b.workerId));
  if (!workers.length) return undefined;

  const counts = {
    total: workers.length,
    live: workers.filter((worker) => worker.liveness === "live").length,
    stale: workers.filter((worker) => worker.liveness === "stale").length,
    unknown: workers.filter((worker) => worker.liveness === "unknown").length,
    activeTasks: workers.filter((worker) => worker.activeTaskId).length,
  };
  return {
    status: counts.stale > 0 ? "stale" : counts.live > 0 ? "live" : "unknown",
    counts,
    workers,
  };
}


const GITHUB_EVIDENCE_GRACE_MS = 10 * 60 * 1000;

function buildGitHubTaskEvidenceProjection(
  roots: UnknownRecord[],
  now: () => number,
): A2AOperatorGitHubTaskEvidenceProjection | undefined {
  const byTask = new Map<string, A2AOperatorGitHubTaskEvidenceItem>();
  for (const root of roots) {
    for (const record of readGitHubEvidenceRecords(root)) {
      const item = normalizeGitHubEvidenceItem(record, now);
      if (!item) continue;
      const current = byTask.get(item.taskId);
      byTask.set(item.taskId, current ? mergeGitHubEvidenceItems(current, item) : item);
    }
  }

  const tasks = [...byTask.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)).slice(0, 25);
  if (!tasks.length) return undefined;
  const counts = {
    total: tasks.length,
    startSeen: tasks.filter((task) => task.startSeen).length,
    terminalSeen: tasks.filter((task) => task.prSeen || task.doneSeen || task.blockSeen).length,
    evidenceMissing: tasks.filter((task) => task.evidenceMissing).length,
    warnings: tasks.filter((task) => task.warning).length,
  };
  return {
    status: counts.warnings > 0 ? "warning" : counts.evidenceMissing > 0 ? "unknown" : "ok",
    counts,
    tasks,
  };
}

function readGitHubEvidenceRecords(root: UnknownRecord): UnknownRecord[] {
  const direct = readRecordArrayCandidate(root, [
    "githubEvidence",
    "githubTaskEvidence",
    "githubTasks",
    "githubPatchTasks",
    "taskEvidence",
  ]);
  if (direct) return direct;
  const nested = readRecordFromRoots([root], [
    "githubEvidence",
    "githubTaskEvidence",
    "githubTasks",
    "githubPatchTasks",
    "taskEvidence",
  ]);
  if (!nested) return [];
  return Object.entries(nested)
    .filter(([, value]) => isRecord(value))
    .map(([taskId, value]) => ({ taskId, ...(value as UnknownRecord) }));
}

function normalizeGitHubEvidenceItem(
  record: UnknownRecord,
  now: () => number,
): A2AOperatorGitHubTaskEvidenceItem | undefined {
  const taskId = safeOperatorString(record.taskId, record.a2aTaskId, record.id);
  if (!taskId) return undefined;
  const repo = safeOperatorString(record.repo, record.repository, record.fullName);
  const issue = normalizeIssueNumber(record.issue, record.issueNumber);
  const lastCheckedAt =
    readOptionalTimestamp(record.lastCheckedAt) ??
    readOptionalTimestamp(record.checkedAt) ??
    readOptionalTimestamp(record.updatedAt) ??
    now();
  const dispatchedAt =
    readOptionalTimestamp(record.dispatchedAt) ??
    readOptionalTimestamp(record.createdAt) ??
    readOptionalTimestamp(record.startedAt);
  const startSeen = hasTruthyEvidence(record.startSeen, record.start_seen, record.startUrl, record.startCommentUrl, record.startedAt);
  const prSeen = hasTruthyEvidence(record.prSeen, record.pr_seen, record.prUrl, record.pullRequestUrl);
  const doneSeen = hasTruthyEvidence(record.doneSeen, record.done_seen, record.doneUrl, record.doneCommentUrl);
  const blockSeen = hasTruthyEvidence(record.blockSeen, record.block_seen, record.blockUrl, record.blockCommentUrl);
  const terminalSeen = prSeen || doneSeen || blockSeen;
  const evidenceMissing = !startSeen && !terminalSeen;
  const beyondGrace = evidenceMissing && dispatchedAt !== undefined && now() - dispatchedAt >= GITHUB_EVIDENCE_GRACE_MS;
  return {
    taskId,
    status: terminalSeen ? "terminal_seen" : startSeen ? "start_seen" : "evidence_missing",
    startSeen,
    prSeen,
    doneSeen,
    blockSeen,
    evidenceMissing,
    ...(repo ? { repo } : {}),
    ...(issue !== undefined ? { issue } : {}),
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
    ...(beyondGrace ? { warning: "GitHub task evidence missing after grace period" } : {}),
  };
}

function mergeGitHubEvidenceItems(
  current: A2AOperatorGitHubTaskEvidenceItem,
  next: A2AOperatorGitHubTaskEvidenceItem,
): A2AOperatorGitHubTaskEvidenceItem {
  const startSeen = current.startSeen || next.startSeen;
  const prSeen = current.prSeen || next.prSeen;
  const doneSeen = current.doneSeen || next.doneSeen;
  const blockSeen = current.blockSeen || next.blockSeen;
  const terminalSeen = prSeen || doneSeen || blockSeen;
  return {
    taskId: current.taskId,
    status: terminalSeen ? "terminal_seen" : startSeen ? "start_seen" : "evidence_missing",
    startSeen,
    prSeen,
    doneSeen,
    blockSeen,
    evidenceMissing: !startSeen && !terminalSeen,
    ...(next.repo ?? current.repo ? { repo: next.repo ?? current.repo } : {}),
    ...(next.issue ?? current.issue ? { issue: next.issue ?? current.issue } : {}),
    ...(Math.max(current.lastCheckedAt ?? 0, next.lastCheckedAt ?? 0) ? { lastCheckedAt: Math.max(current.lastCheckedAt ?? 0, next.lastCheckedAt ?? 0) } : {}),
    ...(next.warning ?? current.warning ? { warning: next.warning ?? current.warning } : {}),
  };
}

function hasTruthyEvidence(...values: unknown[]): boolean {
  return values.some((value) => value === true || (typeof value === "string" && value.trim().length > 0));
}

function normalizeIssueNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return undefined;
}

function applyTerminalReceiptProjection(
  state: InternalState,
  roots: UnknownRecord[],
  now: () => number,
): void {
  for (const root of roots) {
    for (const record of readTerminalReceiptRecords(root)) {
      const projection = normalizeTerminalReceiptProjection(record, now);
      if (!projection) continue;
      state.terminalReceipts.set(projection.taskId, projection);
    }
  }
}

function readTerminalReceiptRecords(root: UnknownRecord): UnknownRecord[] {
  const records: UnknownRecord[] = [];
  const terminalEvent = readRecordCandidate(root, ["terminalEvent", "event"]);
  if (terminalEvent) records.push(terminalEvent);
  const receipt = readRecordCandidate(root, ["terminalReceipt", "terminalAck", "ackReceipt", "receipt"]);
  if (receipt) records.push(receipt);
  const list = readRecordArrayCandidate(root, ["terminalReceipts", "terminalAcks", "ackReceipts", "terminalOutbox", "events", "outboxEvents"]);
  if (list) records.push(...list);
  return records;
}

function normalizeTerminalReceiptProjection(
  record: UnknownRecord,
  now: () => number,
): A2AOperatorTerminalReceiptProjection | undefined {
  const task = isRecord(record.task) ? record.task : undefined;
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;
  const payload = isRecord(record.payload) ? record.payload : undefined;
  const ackAudit = isRecord(record.ackAudit) ? record.ackAudit : undefined;
  const taskId = safeOperatorString(record.taskId, task?.id, metadata?.taskId, payload?.taskId, record.id);
  if (!taskId) return undefined;

  const status = safeOperatorString(record.status, record.type, task && isRecord(task.status) ? task.status.state : undefined, payload?.status);
  const terminalEventId = safeOperatorString(record.terminalEventId, record.eventId, record.id);
  const cursor = safeOperatorString(record.cursor, record.lastEventId, record.sseId);
  const timestamp = readOptionalTimestamp(record.receivedAt) ?? readOptionalTimestamp(record.timestamp) ?? readOptionalTimestamp(record.createdAt) ?? now();
  const receiptMode = readTerminalReceiptMode(record, metadata, payload, ackAudit);
  const receiptGapStatus = readReceiptGapStatus(record, metadata, payload, ackAudit) ?? (receiptMode ? "confirmed" : "missing");
  const receiptStatus = receiptGapStatus === "confirmed" ? "received" : "pending";
  const terminalAckEligible = receiptMode !== undefined && receiptGapStatus === "confirmed";
  const operatorReceiptState = normalizeOperatorVisibleReceiptState(receiptGapStatus);
  const providerDeliveryState = readProviderDeliveryState(record, metadata, payload);
  const brokerReceiptClassification = readBrokerReceiptClassification(record, metadata, ackAudit);

  return {
    taskId,
    ...(status ? { status } : {}),
    ...(terminalEventId ? { terminalEventId } : {}),
    ...(cursor ? { cursor } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(receiptMode ? { receiptMode } : {}),
    receiptStatus,
    receiptGapStatus,
    operatorReceiptState,
    operatorReceiptLabel: buildOperatorReceiptLabel(operatorReceiptState),
    ...(providerDeliveryState ? { providerDeliveryState } : {}),
    ...(brokerReceiptClassification ? { brokerReceiptClassification } : {}),
    terminalAckEligible,
    reason: buildTerminalReceiptProjectionReason(receiptGapStatus, receiptMode),
  };
}

function buildTerminalReceiptProjectionReason(
  status: A2AOperatorReceiptGapStatus,
  mode?: A2AOperatorTerminalReceiptProjection["receiptMode"],
): string {
  if (status === "confirmed" && mode) return `terminal ack allowed by ${mode}`;
  if (status === "failed") return "receipt failed — terminal ack blocked";
  if (status === "timed_out") return "receipt timed out — must refresh before ack";
  if (status === "stale") return "receipt stale — must refresh before ack";
  if (status === "duplicate_suppressed") return "duplicate suppressed — no receipt confirmation, ack blocked";
  return "no current-session/manual receipt — ack blocked";
}

function normalizeOperatorVisibleReceiptState(status: A2AOperatorReceiptGapStatus): A2AOperatorVisibleTerminalReceiptState {
  if (status === "confirmed") return "receipt_confirmed";
  if (status === "timed_out") return "timed_out";
  if (status === "stale") return "stale";
  if (status === "failed") return "failed";
  if (status === "duplicate_suppressed") return "duplicate_suppressed";
  return "pending_receipt";
}

function buildOperatorReceiptLabel(state: A2AOperatorVisibleTerminalReceiptState): string {
  switch (state) {
    case "receipt_confirmed":
      return "✓ receipt confirmed";
    case "timed_out":
      return "⏱ timed out";
    case "stale":
      return "⚠ stale receipt";
    case "failed":
      return "✗ receipt failed";
    case "duplicate_suppressed":
      return "duplicate suppressed";
    case "pending_receipt":
      return "⋯ pending receipt";
  }
}

function readReceiptGapStatus(
  record: UnknownRecord,
  metadata?: UnknownRecord,
  payload?: UnknownRecord,
  ackAudit?: UnknownRecord,
): A2AOperatorReceiptGapStatus | undefined {
  const receipt = isRecord(record.receipt) ? record.receipt : undefined;
  const ack = isRecord(record.ack) ? record.ack : undefined;
  const delivery = isRecord(record.delivery) ? record.delivery : undefined;
  const roots = [ackAudit, record, metadata, receipt, ack, delivery, payload].filter(isRecord);
  for (const root of roots) {
    const decision = normalizeOptionalString(root.decision)?.toLowerCase();
    if (["duplicate_suppressed", "duplicate-suppressed", "duplicate_delivery_suppressed", "suppress_duplicate", "duplicate"].includes(decision ?? "")) {
      return "duplicate_suppressed";
    }
    const raw = normalizeOptionalString(
      root.receiptGapStatus ??
        root.receipt_gap_status ??
        root.operatorReceiptStatus ??
        root.operator_receipt_status ??
        root.terminalReceiptStatus ??
        root.terminal_receipt_status ??
        root.receiptClassification ??
        root.receipt_classification ??
        root.classification ??
        root.receiptStatus ??
        root.receipt_status ??
        root.status ??
        root.state,
    )?.toLowerCase();
    if (!raw) continue;
    if (["confirmed", "receipt_confirmed", "received", "delivered", "visible", "operator_visible", "operator_confirmed"].includes(raw)) {
      return "confirmed";
    }
    if (["accepted", "started", "produced", "provider_sent", "provider-sent", "sent", "provider_delivered", "provider-delivered", "provider-delivered-if-known"].includes(raw)) {
      return "missing";
    }
    if (["missing", "pending", "waiting", "unconfirmed", "not_received", "receipt_missing", "pending_receipt", "hold_unacked"].includes(raw)) {
      return "missing";
    }
    if (["timed_out", "timeout", "timed-out"].includes(raw)) {
      return "timed_out";
    }
    if (["stale", "expired", "stale_timed_out", "timed_out_stale", "timed-out-stale"].includes(raw)) {
      return "stale";
    }
    if (["duplicate_suppressed", "duplicate-suppressed", "duplicate_delivery_suppressed", "suppress_duplicate", "duplicate"].includes(raw)) {
      return "duplicate_suppressed";
    }
    if (["failed", "failure", "error", "rejected", "undeliverable"].includes(raw)) {
      return "failed";
    }
  }
  return undefined;
}

function readTerminalReceiptMode(
  record: UnknownRecord,
  metadata?: UnknownRecord,
  payload?: UnknownRecord,
  ackAudit?: UnknownRecord,
): A2AOperatorTerminalReceiptProjection["receiptMode"] | undefined {
  const receipt = isRecord(record.receipt) ? record.receipt : undefined;
  const ack = isRecord(record.ack) ? record.ack : undefined;
  const delivery = isRecord(record.delivery) ? record.delivery : undefined;
  const roots = [ackAudit, record, metadata, receipt, ack, delivery, payload].filter(isRecord);
  for (const root of roots) {
    if (root.current_session_visible === true || root.currentSessionVisible === true) {
      return "current_session_visible";
    }
    if (root.manual_operator_receipt === true || root.manualOperatorReceipt === true) {
      return "manual_operator_receipt";
    }
    const mode = normalizeOptionalString(root.receiptMode ?? root.receiptProjection ?? root.projection ?? root.mode ?? root.kind ?? root.evidence);
    if (mode === "current_session_visible" || mode === "operator_visible" || mode === "operator-visible") {
      return "current_session_visible";
    }
    if (mode === "manual_operator_receipt" || mode === "operator_confirmed" || mode === "operator-confirmed") {
      return "manual_operator_receipt";
    }
  }
  return undefined;
}

function readProviderDeliveryState(
  record: UnknownRecord,
  metadata?: UnknownRecord,
  payload?: UnknownRecord,
): A2AOperatorTerminalReceiptProjection["providerDeliveryState"] | undefined {
  const receipt = isRecord(record.receipt) ? record.receipt : undefined;
  const delivery = isRecord(record.delivery) ? record.delivery : undefined;
  const roots = [record, metadata, receipt, delivery, payload].filter(isRecord);
  for (const root of roots) {
    const raw = normalizeOptionalString(
      root.providerDeliveryState ??
        root.provider_delivery_state ??
        root.providerDeliveryStatus ??
        root.provider_delivery_status ??
        root.providerSendStatus ??
        root.provider_send_status ??
        root.providerGatewaySendStatus ??
        root.provider_gateway_send_status ??
        root.terminalReceiptStatus ??
        root.terminal_receipt_status ??
        root.receiptStatus ??
        root.receipt_status ??
        root.status,
    )?.toLowerCase();
    if (!raw) continue;
    if (["accepted", "started", "produced", "queued"].includes(raw)) return "accepted";
    if (["sent", "provider_sent", "provider-sent"].includes(raw)) return "sent";
    if (["provider_delivered", "provider-delivered", "provider-delivered-if-known", "delivered"].includes(raw)) return "provider-delivered-if-known";
  }
  return undefined;
}

function readBrokerReceiptClassification(
  record: UnknownRecord,
  metadata?: UnknownRecord,
  ackAudit?: UnknownRecord,
): string | undefined {
  const roots = [record, metadata, ackAudit].filter(isRecord);
  for (const root of roots) {
    const classification = normalizeOptionalString(
      root.receiptClassification ??
        root.receipt_classification ??
        root.operatorReceiptState ??
        root.operator_receipt_state ??
        root.terminalReceiptState ??
        root.terminal_receipt_state ??
        root.decision,
    );
    if (classification) return classification;
  }
  return undefined;
}

function readWorkerRecords(root: UnknownRecord): UnknownRecord[] {
  const direct = readRecordArrayCandidate(root, ["workers", "workerStatuses", "workerLiveness", "fleet", "runners"]);
  if (direct) return direct;
  const nested = readRecordFromRoots([root], ["workers", "workerStatuses", "workerLiveness", "fleet", "runners"]);
  if (!nested) return [];
  return Object.entries(nested)
    .filter(([, value]) => isRecord(value))
    .map(([id, value]) => ({ workerId: id, ...(value as UnknownRecord) }));
}

function readTaskRecords(root: UnknownRecord): UnknownRecord[] {
  return readRecordArrayCandidate(root, ["tasks", "activeTasks", "inFlightTasks", "runningTasks"]) ?? [];
}

function normalizeWorkerProgressItem(
  record: UnknownRecord,
  now: () => number,
): A2AOperatorWorkerProgressItem | undefined {
  const workerId = safeOperatorString(record.workerId, record.id, record.nodeId, record.name);
  if (!workerId) return undefined;
  const lastSeenAt = readOptionalTimestamp(record.lastSeenAt) ?? readOptionalTimestamp(record.lastHeartbeatAt) ?? readOptionalTimestamp(record.heartbeatAt) ?? readOptionalTimestamp(record.updatedAt);
  const status = safeOperatorString(record.status, record.state, record.phase);
  const activeTaskId = safeOperatorString(record.activeTaskId, record.taskId, record.currentTaskId);
  const taskStatus = safeOperatorString(record.taskStatus, record.currentTaskStatus);
  const progress = normalizeProgress(record.progress ?? record.percent ?? record.progressPercent);
  const message = safeOperatorString(record.message, record.summary, record.note);
  return {
    workerId,
    liveness: resolveWorkerLiveness(status, lastSeenAt, now),
    ...(status ? { status } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(activeTaskId ? { activeTaskId } : {}),
    ...(taskStatus ? { taskStatus } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(message ? { message } : {}),
  };
}

function normalizeTaskProgressItem(
  record: UnknownRecord,
  now: () => number,
): A2AOperatorWorkerProgressItem | undefined {
  const workerId = safeOperatorString(record.workerId, record.assigneeId, record.claimedBy, record.runnerId);
  const activeTaskId = safeOperatorString(record.taskId, record.id);
  if (!workerId || !activeTaskId) return undefined;
  const taskStatus = safeOperatorString(record.status, record.state, record.phase);
  const lastSeenAt = readOptionalTimestamp(record.updatedAt) ?? readOptionalTimestamp(record.claimedAt) ?? readOptionalTimestamp(record.startedAt);
  const progress = normalizeProgress(record.progress ?? record.percent ?? record.progressPercent);
  const message = safeOperatorString(record.message, record.summary, record.title);
  return {
    workerId,
    liveness: resolveWorkerLiveness(taskStatus, lastSeenAt, now),
    activeTaskId,
    ...(taskStatus ? { taskStatus } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(message ? { message } : {}),
  };
}

function resolveWorkerLiveness(
  status: string | undefined,
  lastSeenAt: number | undefined,
  now: () => number,
): A2AOperatorWorkerProgressItem["liveness"] {
  const normalized = status?.toLowerCase();
  if (normalized && ["live", "healthy", "active", "running", "claimed", "online"].includes(normalized)) return "live";
  if (normalized && ["stale", "offline", "dead", "failed", "unhealthy", "lost"].includes(normalized)) return "stale";
  if (lastSeenAt !== undefined) return now() - lastSeenAt <= 120_000 ? "live" : "stale";
  return "unknown";
}

function normalizeProgress(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, Number(normalized.toFixed(3))));
}

function safeOperatorString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (!normalized || normalized.length > 160) continue;
    if (/token|secret|password|api[_-]?key|bearer/i.test(normalized)) continue;
    if (/^\/(?:home|root|Users|private)\//.test(normalized)) continue;
    return normalized;
  }
  return undefined;
}

function readRecordCandidate(
  payload: UnknownRecord,
  keys: string[],
): UnknownRecord | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function readRecordArrayCandidate(
  payload: UnknownRecord,
  keys: string[],
): UnknownRecord[] | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (!Array.isArray(value)) {
      continue;
    }
    return value.filter(isRecord);
  }
  return undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOptionalTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function defaultWaitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
