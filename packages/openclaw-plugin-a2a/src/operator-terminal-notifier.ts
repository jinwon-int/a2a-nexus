import {
  extractWorkerCapacityHint,
  formatWorkerCapacityHint,
} from "./worker-capacity-hints.js";

type UnknownRecord = Record<string, unknown>;

export type A2AOperatorTerminalNotificationType = "success" | "failure" | "block" | "pr";
export type A2AOperatorTerminalReceiptProjection = "current_session_visible" | "manual_operator_receipt";

export type A2AOperatorTerminalNotificationEnvelope = {
  kind: "a2a.operator.notification";
  version: 1;
  id: string;
  dedupeKey: string;
  type: A2AOperatorTerminalNotificationType;
  severity: "info" | "warn" | "error";
  deliveryOwner: "openclaw.plugin-notifier";
  deliveryTarget: "operator-main-session";
  title: string;
  text: string;
  evidence: A2AOperatorNotificationEvidence;
  taskId?: string;
  worker?: string;
  status?: string;
  repo?: string;
  issueUrl?: string;
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  runId?: string;
  /** Parent/all-hands round id when the notification belongs to a grouped worker round. */
  parentRoundId?: string;
  traceId?: string;
  createdAt?: string;
  dryRun?: boolean;
  /** Source carried parent-round grouping context even if numerator/denominator is incomplete. */
  parentRoundContext?: boolean;
  /** Parent-round completion sequence (1-based numerator). */
  roundNum?: number;
  /** Parent-round worker/task order from broker metadata (1-based numerator). */
  parentRoundOrder?: number;
  /** Parent-round total worker/task count (denominator). */
  roundTotal?: number;
  /** Broker-native parent-round completion sequence (1-based numerator). */
  parentRoundProgress?: number;
  /** Broker-native parent-round total worker/task count (denominator). */
  parentRoundTotal?: number;
  /** Broker-native progress object; completed is treated as roundNum compatibility. */
  roundProgress?: { completed?: number };
  /** Broker-provided override title; takes precedence over auto-built title. */
  terminalBriefTitle?: string;
  /** Broker-provided Terminal Brief template string with {variable} placeholders. */
  terminalBriefTemplate?: string;
};

export type A2AOperatorNotificationEvidence = {
  schema: "a2a.operator.notification.evidence";
  version: 1;
  taskId?: string;
  worker?: string;
  status?: string;
  repo?: string;
  issueUrl?: string;
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  runId?: string;
  traceId?: string;
  summary?: string;
  taskDescription?: string;
  taskSummary?: string;
  taskBrief?: string;
  createdAt?: string;
  receiptProjection?: A2AOperatorTerminalReceiptProjection;
  /**
   * Sanitized worker capacity hint — never raw host data.
   * Helps closeout reports distinguish:
   * - worker slow/capacity-limited
   * - task failed
   * - task stuck/no receipt
   * - profile stale/unknown
   */
  capacityHint?: string;
};

export type A2AOpenClawTelegramOperatorNotification = {
  kind: "openclaw.operator.telegram_notification";
  version: 1;
  dedupeKey: string;
  dryRun?: true;
  delivery: {
    mode: "announce";
    channel: "telegram";
  };
  title: string;
  text: string;
  evidence: A2AOperatorNotificationEvidence;
};

export type A2AOperatorReleaseDriftStatus = "current" | "stale" | "unknown";

export type A2AOperatorReleaseDriftItem = {
  id: string;
  status: A2AOperatorReleaseDriftStatus;
  revision?: string;
  expectedRevision?: string;
};

export type A2AOperatorReleaseDriftSummary = {
  kind: "a2a.operator.release-drift";
  status: A2AOperatorReleaseDriftStatus;
  text: string;
  broker: A2AOperatorReleaseDriftItem;
  workers: A2AOperatorReleaseDriftItem[];
};

export type A2AOperatorTerminalNotificationBuildOptions = {
  maxTextChars?: number;
  dryRun?: boolean;
};

export type A2ATelegramSafeDryRunNotificationHarness = {
  notify(envelope: A2AOperatorTerminalNotificationEnvelope): void;
  list(): A2AOperatorTerminalNotificationEnvelope[];
  listTelegram(): A2AOpenClawTelegramOperatorNotification[];
  stats(): {
    accepted: number;
    dropped: number;
    maxNotifications: number;
  };
};

export type A2ATelegramSafeDryRunNotificationHarnessOptions = {
  /**
   * Upper bound for retained dry-run notifications. This is a local safety
   * fuse for replay storms; the harness never sends to Telegram.
   */
  maxNotifications?: number;
};

const DEFAULT_MAX_TEXT_CHARS = 900;
export const A2A_OPERATOR_TERMINAL_BRIEF_DEFAULT_TITLE_FORMAT = "A2A Terminal Brief 완료: worker(완료 1/3)";

const URL_SECRET_RE = /([?&](?:token|secret|password|key|api_key)=)[^&\s]+/gi;
const BEARER_RE = /\b(?:bearer|token)\s+[a-z0-9._~+/=-]{12,}/gi;
const SECRET_ASSIGN_RE = /\b(?:token|secret|password|api[_-]?key)=\S+/gi;
const PRIVATE_PATH_RE = /\/(?:home|root|Users)\/[^\s),;]+/g;

export function buildA2AOperatorTerminalOutboxNotificationEnvelope(
  outbox: UnknownRecord,
  options: A2AOperatorTerminalNotificationBuildOptions = {},
): A2AOperatorTerminalNotificationEnvelope | undefined {
  const payload = asRecord(outbox.payload);
  if (!payload) return undefined;
  const type = readNotificationType(payload);
  if (!type) return undefined;

  const receiptProjection = readTerminalOutboxReceiptProjection(payload, outbox);
  if (!receiptProjection) {
    return undefined;
  }

  const taskId = readString(payload.taskId);
  const worker = readWorker(payload);
  const status = readStatus(payload);
  const repo = readRepo(payload);
  const issueNumber = typeof payload.issue === "number" && Number.isFinite(payload.issue) ? payload.issue : undefined;
  const issueUrl = repo && issueNumber !== undefined ? `https://github.com/${repo}/issues/${issueNumber}` : readIssueUrl(payload);
  const prUrl = readPrUrl(payload);
  const doneUrl = readDoneUrl(payload);
  const blockUrl = readBlockUrl(payload);
  const runId = readRunId(payload, outbox);
  const parentRoundId = readParentRoundId(payload, outbox);
  const parentRoundContext = hasParentRoundContext(payload, outbox);
  const traceId = readTraceId(payload, outbox);
  const createdAt = readString(payload.completedAt) ?? readString(payload.updatedAt) ?? readString(payload.createdAt) ?? readString(outbox.createdAt);
  const summary = readString(payload.testSummary) ?? readString(payload.summary) ?? readString(payload.message);
  const safeSummary = summary ? clampText(redactText(summary), 240) : undefined;
  const taskDescription = readTaskDescription(payload, asRecord(payload.task), asRecord(payload.metadata));
  const safeTaskDescription = taskDescription ? clampText(redactText(taskDescription), 180) : undefined;
  const taskSummary = readTaskSummary(payload, asRecord(payload.task), asRecord(payload.metadata));
  const safeTaskSummary = taskSummary ? clampText(redactText(taskSummary), 180) : undefined;
  const taskBrief = readTaskBrief(payload, asRecord(payload.task), asRecord(payload.metadata));
  const safeTaskBrief = taskBrief ? clampText(redactText(taskBrief), 180) : undefined;
  const terminalBriefTitle = readTerminalBriefTitle(payload, asRecord(payload.metadata), asRecord(payload.terminalBrief), outbox);
  const terminalBriefTemplate = readString(payload.terminalBriefTemplate);
  const roundNum = readRoundNum(payload, outbox);
  const roundTotal = readRoundTotal(payload, outbox);
  const title = buildTitle(type, taskId, prUrl, worker, roundNum, roundTotal, terminalBriefTitle, parentRoundContext);
  const evidence = compactEvidence({
    taskId,
    worker,
    status,
    repo,
    issueUrl,
    prUrl,
    doneUrl,
    blockUrl,
    runId,
    traceId,
    summary: safeSummary,
    taskDescription: safeTaskDescription,
    taskSummary: safeTaskSummary,
    taskBrief: safeTaskBrief,
    createdAt,
    receiptProjection,
  });
  const text = clampText(
    redactText(
      [
        title,
        safeSummary,
        `Required receipt proof: ${receiptProjection}`,
        renderWorkerTaskCompletionLine({ type, worker, taskId, taskDescription: safeTaskDescription }),
        worker ? `Worker: ${worker}` : undefined,
        safeTaskDescription && !taskId ? `Task: ${safeTaskDescription}` : undefined,
        repo ? `Repo: ${repo}` : undefined,
        issueUrl ? `Issue: ${issueUrl}` : undefined,
        prUrl ? `PR: ${prUrl}` : undefined,
        doneUrl ? `Done: ${doneUrl}` : undefined,
        blockUrl ? `Block: ${blockUrl}` : undefined,
        runId ? `Run: ${runId}` : undefined,
        traceId ? `Trace: ${traceId}` : undefined,
      ].filter(Boolean).join("\n"),
    ),
    Math.max(120, options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS),
  );
  const eventId = readString(outbox.id);
  const dedupeKey = buildDedupeKey({ eventId, taskId, type, createdAt, prUrl });
  if (!dedupeKey) return undefined;

  return {
    kind: "a2a.operator.notification",
    version: 1,
    id: `operator-notify:${dedupeKey}`,
    dedupeKey,
    type,
    severity: type === "failure" ? "error" : type === "block" ? "warn" : "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title,
    text,
    evidence,
    ...(taskId ? { taskId } : {}),
    ...(worker ? { worker } : {}),
    ...(status ? { status } : {}),
    ...(repo ? { repo } : {}),
    ...(issueUrl ? { issueUrl } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(doneUrl ? { doneUrl } : {}),
    ...(blockUrl ? { blockUrl } : {}),
    ...(runId ? { runId } : {}),
    ...(parentRoundId ? { parentRoundId } : {}),
    ...(traceId ? { traceId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(roundNum !== undefined ? { roundNum } : {}),
    ...(roundNum !== undefined ? { parentRoundOrder: roundNum } : {}),
    ...(roundTotal !== undefined ? { roundTotal } : {}),
    ...(parentRoundContext ? { parentRoundContext: true } : {}),
    ...(terminalBriefTitle ? { terminalBriefTitle } : {}),
    ...(terminalBriefTemplate ? { terminalBriefTemplate } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
  };
}

export function buildA2AOperatorTerminalNotificationEnvelope(
  event: { id?: string; name?: string; data?: unknown },
  options: A2AOperatorTerminalNotificationBuildOptions = {},
): A2AOperatorTerminalNotificationEnvelope | undefined {
  const data = asRecord(event.data) ?? asRecord(event);
  if (!data) {
    return undefined;
  }

  const terminal = asRecord(data.terminalEvent) ?? asRecord(data.event) ?? data;
  const type = readNotificationType(terminal);
  if (!type) {
    return undefined;
  }

  const task = asRecord(terminal.task) ?? asRecord(data.task);
  const metadata = asRecord(task?.metadata) ?? asRecord(terminal.metadata) ?? {};
  const taskId = readString(terminal.taskId) ?? readString(task?.id) ?? readString(metadata.taskId);
  const worker = readWorker(terminal, task, metadata);
  const status = readStatus(terminal, task);
  const createdAt =
    readString(terminal.createdAt) ?? readString(terminal.timestamp) ?? readString(task?.status && asRecord(task.status)?.timestamp);
  const prUrl = readPrUrl(terminal) ?? readPrUrl(metadata) ?? readPrUrl(task ?? {});
  const repo = readRepo(terminal) ?? readRepo(metadata) ?? readRepo(task ?? {});
  const issueNumber = readIssueNumber(terminal) ?? readIssueNumber(metadata) ?? readIssueNumber(task ?? {});
  const issueUrl = repo && issueNumber !== undefined
    ? `https://github.com/${repo}/issues/${issueNumber}`
    : readIssueUrl(terminal) ?? readIssueUrl(metadata) ?? readIssueUrl(task ?? {});
  const doneUrl = readDoneUrl(terminal) ?? readDoneUrl(metadata) ?? readDoneUrl(task ?? {});
  const blockUrl = readBlockUrl(terminal) ?? readBlockUrl(metadata) ?? readBlockUrl(task ?? {});
  const runId = readRunId(terminal, metadata, task, data);
  const parentRoundId = readParentRoundId(terminal, metadata, task, asRecord(task?.payload), data);
  const parentRoundContext = hasParentRoundContext(terminal, metadata, task, asRecord(task?.payload), data);
  const traceId = readTraceId(terminal, metadata, task, data);
  const releaseDrift = buildA2AOperatorReleaseDriftSummary([terminal, metadata, task, data]);
  const capacityHint = buildNotificationCapacityHint(terminal, metadata, task, data);
  const receiptProjection = readOperatorReceiptProjection(terminal, metadata, task, data);
  if (!receiptProjection) {
    return undefined;
  }
  const summary =
    readString(terminal.summary) ??
    readString(terminal.message) ??
    readStatusMessage(task) ??
    readString(asRecord(terminal.error)?.message) ??
    readString(asRecord(task?.status)?.state);
  const safeSummary = summary ? clampText(redactText(summary), 240) : undefined;
  const taskDescription = readTaskDescription(terminal, metadata, task, asRecord(task?.payload), data);
  const safeTaskDescription = taskDescription ? clampText(redactText(taskDescription), 180) : undefined;
  const taskSummary = readTaskSummary(terminal, metadata, task, asRecord(task?.payload), data);
  const safeTaskSummary = taskSummary ? clampText(redactText(taskSummary), 180) : undefined;
  const taskBrief = readTaskBrief(terminal, metadata, task, asRecord(task?.payload), data);
  const safeTaskBrief = taskBrief ? clampText(redactText(taskBrief), 180) : undefined;
  const terminalBriefTitle = readTerminalBriefTitle(
    terminal,
    metadata,
    task,
    asRecord(task?.payload),
    asRecord(asRecord(task?.payload)?.terminalBrief),
    asRecord(terminal.terminalBrief),
    data,
  );
  const terminalBriefTemplate = readString(terminal.terminalBriefTemplate) ?? readString(data.terminalBriefTemplate);

  const roundNum = readRoundNum(terminal, metadata, task, data);
  const roundTotal = readRoundTotal(terminal, metadata, task, data);
  const title = buildTitle(type, taskId, prUrl, worker, roundNum, roundTotal, terminalBriefTitle, parentRoundContext);
  const releaseLine = releaseDrift ? `Release: ${releaseDrift.text}` : undefined;
  const evidence = compactEvidence({
    taskId,
    worker,
    status,
    repo,
    issueUrl,
    prUrl,
    doneUrl,
    blockUrl,
    runId,
    traceId,
    summary: safeSummary,
    taskDescription: safeTaskDescription,
    taskSummary: safeTaskSummary,
    taskBrief: safeTaskBrief,
    createdAt,
    receiptProjection,
    capacityHint,
  });
  const text = clampText(
    redactText(
      [
        title,
        releaseLine,
        summary,
        `Required receipt proof: ${receiptProjection}`,
        renderWorkerTaskCompletionLine({ type, worker, taskId, taskDescription: safeTaskDescription }),
        worker ? `Worker: ${worker}` : undefined,
        capacityHint ? `Capacity: ${capacityHint}` : undefined,
        safeTaskDescription && !taskId ? `Task: ${safeTaskDescription}` : undefined,
        repo ? `Repo: ${repo}` : undefined,
        issueUrl ? `Issue: ${issueUrl}` : undefined,
        prUrl ? `PR: ${prUrl}` : undefined,
        doneUrl ? `Done: ${doneUrl}` : undefined,
        blockUrl ? `Block: ${blockUrl}` : undefined,
        runId ? `Run: ${runId}` : undefined,
        traceId ? `Trace: ${traceId}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    Math.max(120, options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS),
  );
  const dedupeKey = buildDedupeKey({
    eventId: event.id ?? readString(terminal.id) ?? readString(data.id),
    taskId,
    type,
    createdAt,
    prUrl,
  });

  return {
    kind: "a2a.operator.notification",
    version: 1,
    id: `operator-notify:${dedupeKey}`,
    dedupeKey,
    type,
    severity: type === "failure" ? "error" : type === "block" ? "warn" : "info",
    deliveryOwner: "openclaw.plugin-notifier",
    deliveryTarget: "operator-main-session",
    title,
    text,
    evidence,
    ...(taskId ? { taskId } : {}),
    ...(worker ? { worker } : {}),
    ...(status ? { status } : {}),
    ...(repo ? { repo } : {}),
    ...(issueUrl ? { issueUrl } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(doneUrl ? { doneUrl } : {}),
    ...(blockUrl ? { blockUrl } : {}),
    ...(runId ? { runId } : {}),
    ...(parentRoundId ? { parentRoundId } : {}),
    ...(traceId ? { traceId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(roundNum !== undefined ? { roundNum } : {}),
    ...(roundNum !== undefined ? { parentRoundOrder: roundNum } : {}),
    ...(roundTotal !== undefined ? { roundTotal } : {}),
    ...(parentRoundContext ? { parentRoundContext: true } : {}),
    ...(terminalBriefTitle ? { terminalBriefTitle } : {}),
    ...(terminalBriefTemplate ? { terminalBriefTemplate } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
  };
}

export function buildA2AOpenClawTelegramOperatorNotification(
  envelope: A2AOperatorTerminalNotificationEnvelope,
): A2AOpenClawTelegramOperatorNotification {
  const text = envelope.terminalBriefTemplate
    ? renderA2AOperatorTerminalBriefTemplate(envelope.terminalBriefTemplate, envelope)
    : envelope.title;

  return {
    kind: "openclaw.operator.telegram_notification",
    version: 1,
    dedupeKey: envelope.dedupeKey,
    ...(envelope.dryRun ? { dryRun: true } : {}),
    delivery: {
      mode: "announce",
      channel: "telegram",
    },
    title: envelope.title,
    text,
    evidence: envelope.evidence,
  };
}

export function buildA2AOperatorReleaseDriftSummary(
  payload: unknown,
): A2AOperatorReleaseDriftSummary | undefined {
  const roots = Array.isArray(payload)
    ? payload.flatMap((value) => buildReleaseDriftRoots(value))
    : buildReleaseDriftRoots(payload);

  for (const root of roots) {
    const release = asRecord(root.release);
    const brokerRecord = firstRecord(root.broker, root.brokerRelease, root.brokerStatus, release?.broker);
    const workerRecords = readWorkerReleaseRecords(root);
    if (!brokerRecord && workerRecords.length === 0) {
      continue;
    }

    const broker = normalizeReleaseDriftItem("broker", brokerRecord ?? root, true);
    const workers = workerRecords.map(([id, record]) => normalizeReleaseDriftItem(id, record, false));
    const status = combineReleaseDriftStatus([broker, ...workers]);
    const text = renderA2AOperatorReleaseDriftSummary({ broker, workers });
    return {
      kind: "a2a.operator.release-drift",
      status,
      text,
      broker,
      workers,
    };
  }

  return undefined;
}

export function renderA2AOperatorReleaseDriftSummary(params: {
  broker: A2AOperatorReleaseDriftItem;
  workers: A2AOperatorReleaseDriftItem[];
}): string {
  const workerText = params.workers.length
    ? params.workers.map(renderReleaseDriftItem).join(", ")
    : "none";
  return clampText(`broker ${renderReleaseDriftItem(params.broker).replace(/^broker /, "")}; workers ${workerText}`, 360);
}

export function createA2AOperatorDryRunNotifier(): {
  notify(envelope: A2AOperatorTerminalNotificationEnvelope): void;
  list(): A2AOperatorTerminalNotificationEnvelope[];
} {
  const harness = createA2ATelegramSafeDryRunNotificationHarness();
  return {
    notify: harness.notify,
    list: harness.list,
  };
}

export function createA2ATelegramSafeDryRunNotificationHarness(
  options: A2ATelegramSafeDryRunNotificationHarnessOptions = {},
): A2ATelegramSafeDryRunNotificationHarness {
  const maxNotifications = Math.max(1, Math.floor(options.maxNotifications ?? 100));
  const envelopes: A2AOperatorTerminalNotificationEnvelope[] = [];
  const telegram: A2AOpenClawTelegramOperatorNotification[] = [];
  let dropped = 0;

  function cloneEnvelope(envelope: A2AOperatorTerminalNotificationEnvelope): A2AOperatorTerminalNotificationEnvelope {
    return {
      ...envelope,
      dryRun: true,
      evidence: { ...envelope.evidence },
    };
  }

  function cloneTelegram(notification: A2AOpenClawTelegramOperatorNotification): A2AOpenClawTelegramOperatorNotification {
    return {
      ...notification,
      delivery: { ...notification.delivery },
      evidence: { ...notification.evidence },
    };
  }

  return {
    notify(envelope) {
      if (envelopes.length >= maxNotifications) {
        dropped += 1;
        return;
      }
      const dryRunEnvelope = cloneEnvelope(envelope);
      envelopes.push(dryRunEnvelope);
      telegram.push(buildA2AOpenClawTelegramOperatorNotification(dryRunEnvelope));
    },
    list() {
      return envelopes.map(cloneEnvelope);
    },
    listTelegram() {
      return telegram.map(cloneTelegram);
    },
    stats() {
      return {
        accepted: envelopes.length,
        dropped,
        maxNotifications,
      };
    },
  };
}



export function getA2AOperatorTerminalReceiptGate(
  event: { data?: unknown } | unknown,
): { isTerminal: boolean; receiptProjection?: A2AOperatorTerminalReceiptProjection } {
  const data = asRecord(asRecord(event)?.data) ?? asRecord(event);
  if (!data) {
    return { isTerminal: false };
  }
  const terminal = asRecord(data.terminalEvent) ?? asRecord(data.event) ?? data;
  if (!readNotificationType(terminal)) {
    return { isTerminal: false };
  }
  const task = asRecord(terminal.task) ?? asRecord(data.task);
  const metadata = asRecord(task?.metadata) ?? asRecord(terminal.metadata) ?? {};
  const receiptProjection = readOperatorReceiptProjection(terminal, metadata, task, data);
  return {
    isTerminal: true,
    ...(receiptProjection ? { receiptProjection } : {}),
  };
}

/** Provider delivery state for terminal outbox records, kept separate from operator-visible receipt. */
export type A2AOperatorTerminalOutboxProviderDeliveryState =
  | "accepted"
  | "sent"
  | "provider_delivered"
  | "unknown";

/** Operator-visible terminal receipt state for outbox events. */
export type A2AOperatorTerminalOutboxReceiptState =
  | "pending_receipt"
  | "operator_visible"
  | "receipt_confirmed"
  | "none";

/**
 * Receipt-gap projection for a terminal outbox event.
 *
 * This projection explicitly separates provider delivery/send state from
 * operator-visible receipt state. Provider send success is never evidence
 * of operator-visible ACK — those concepts live in different fields.
 *
 * Monitors use this projection to answer the question:
 * "Has the provider acknowledged delivery but the operator hasn't seen it yet?"
 */
export type A2AOperatorTerminalOutboxReceiptGap = {
  taskId?: string;
  type?: string;
  /** Provider/transport delivery state — never ACK evidence by itself. */
  providerDelivery: A2AOperatorTerminalOutboxProviderDeliveryState;
  /** Operator-visible receipt state — the only field gating ACK eligibility. */
  operatorReceipt: A2AOperatorTerminalOutboxReceiptState;
  operatorReceiptProjection?: A2AOperatorTerminalReceiptProjection;
  /** Whether this terminal event is eligible for terminal ACK. */
  terminalAckEligible: boolean;
  /** Why the receipt gap is in its current state. */
  reason: string;
};

/**
 * Project the receipt gap for a terminal outbox record.
 *
 * Provider delivery state and operator-visible receipt are always kept in
 * separate fields so that monitors, dashboards, and alerting can distinguish
 * "provider sent successfully" from "operator saw it."
 *
 * No live send, no terminal ACK, no Gateway restart.
 */
export function getA2AOperatorTerminalOutboxReceiptGap(
  outbox: UnknownRecord,
): A2AOperatorTerminalOutboxReceiptGap {
  const payload = asRecord(outbox.payload);
  const taskId = payload ? readString(payload.taskId) : undefined;
  const type = payload ? readString(payload.type) : undefined;

  // Provider delivery state — derived from outbox receipt/ack metadata
  const receipt = asRecord(outbox.receipt) ?? asRecord(payload?.receipt);
  const ack = asRecord(outbox.ack) ?? asRecord(payload?.ack);
  const ackAudit = asRecord(outbox.ackAudit) ?? asRecord(payload?.ackAudit);

  const receiptStatus = readString(receipt?.status)?.toLowerCase();
  const ackStatus = readString(ack?.status)?.toLowerCase();
  const ackAuditDecision = readString(ackAudit?.decision)?.toLowerCase();

  const providerDelivery: A2AOperatorTerminalOutboxProviderDeliveryState =
    receiptStatus === "sent" || ackStatus === "sent"
      ? "sent"
      : receiptStatus === "delivered" || ackStatus === "delivered" || receiptStatus === "provider_delivered"
        ? "provider_delivered"
        : receiptStatus === "accepted" || ackStatus === "accepted" || ackAuditDecision === "accepted"
          ? "accepted"
          : "unknown";

  // Operator receipt projection — only gated on operator-visible evidence
  const receiptProjection = payload ? readTerminalOutboxReceiptProjection(payload, outbox) : undefined;

  const operatorReceipt: A2AOperatorTerminalOutboxReceiptState =
    receiptProjection === "current_session_visible" || receiptProjection === "manual_operator_receipt"
      ? ackStatus === "receipt_confirmed"
        ? "receipt_confirmed"
        : "operator_visible"
      : receiptProjection === undefined && providerDelivery !== "unknown"
        ? "none"
        : "pending_receipt";

  const terminalAckEligible =
    operatorReceipt === "receipt_confirmed" && receiptProjection !== undefined;

  const reason = buildTerminalOutboxReceiptGapReason(
    providerDelivery,
    operatorReceipt,
    receiptProjection,
  );

  return {
    ...(taskId ? { taskId } : {}),
    ...(type ? { type } : {}),
    providerDelivery,
    operatorReceipt,
    ...(receiptProjection ? { operatorReceiptProjection: receiptProjection } : {}),
    terminalAckEligible,
    reason,
  };
}

function buildTerminalOutboxReceiptGapReason(
  providerDelivery: A2AOperatorTerminalOutboxProviderDeliveryState,
  operatorReceipt: A2AOperatorTerminalOutboxReceiptState,
  receiptProjection?: A2AOperatorTerminalReceiptProjection,
): string {
  if (operatorReceipt === "none" && providerDelivery !== "unknown") {
    return `provider delivery is ${providerDelivery} but no operator-visible receipt evidence exists; provider evidence is not Terminal Brief visibility proof`;
  }
  if (operatorReceipt === "pending_receipt") {
    return `provider delivery is ${providerDelivery} but operator-visible receipt is pending (projection: ${receiptProjection ?? "none"})`;
  }
  if (operatorReceipt === "operator_visible") {
    return `operator-visible receipt projection ${receiptProjection} is set`;
  }
  if (operatorReceipt === "receipt_confirmed") {
    return `operator-visible receipt is confirmed (projection: ${receiptProjection}) — terminal ACK eligible`;
  }
  return `provider delivery is ${providerDelivery}; operator receipt is ${operatorReceipt}`;
}

function buildReleaseDriftRoots(value: unknown): UnknownRecord[] {
  const record = asRecord(value);
  if (!record) return [];
  const keys = ["releaseDrift", "release", "drift", "versionStatus", "operatorStatus", "snapshot", "summary", "liveSummary"];
  const roots: UnknownRecord[] = [record];
  for (let index = 0; index < roots.length; index += 1) {
    for (const key of keys) {
      const nested = asRecord(roots[index][key]);
      if (nested && !roots.includes(nested)) roots.push(nested);
    }
  }
  return roots;
}

function readWorkerReleaseRecords(root: UnknownRecord): Array<[string, UnknownRecord]> {
  const release = asRecord(root.release);
  const value = root.workers ?? root.workerRevisions ?? root.runnerRevisions ?? root.runners ?? root.fleet ?? release?.workers;
  if (Array.isArray(value)) {
    return value
      .map(asRecord)
      .filter((record): record is UnknownRecord => Boolean(record))
      .map((record, index) => [readWorkerId(record) ?? `worker-${index + 1}`, record]);
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record)
    .map(([id, worker]) => [id, asRecord(worker)] as const)
    .filter((entry): entry is readonly [string, UnknownRecord] => Boolean(entry[1]))
    .map(([id, worker]) => [readWorkerId(worker) ?? id, worker]);
}

function normalizeReleaseDriftItem(
  fallbackId: string,
  record: UnknownRecord,
  broker: boolean,
): A2AOperatorReleaseDriftItem {
  const id = broker ? "broker" : (readWorkerId(record) ?? fallbackId);
  const revision = firstSafeRevision(
    record.revision,
    record.currentRevision,
    record.deployedRevision,
    record.runnerRevision,
    record.commit,
    record.sha,
    record.version,
  );
  const expectedRevision = firstSafeRevision(
    record.expectedRevision,
    record.latestRevision,
    record.mainRevision,
    record.targetRevision,
    record.githubMainRevision,
    record.runnerMainRevision,
  );
  const status = normalizeReleaseDriftStatus(record.status, record.state, record.drift, revision, expectedRevision);
  return {
    id: sanitizeLabel(id) ?? fallbackId,
    status,
    ...(revision ? { revision } : {}),
    ...(expectedRevision ? { expectedRevision } : {}),
  };
}

function normalizeReleaseDriftStatus(
  ...values: unknown[]
): A2AOperatorReleaseDriftStatus {
  const revision = values.at(-2);
  const expectedRevision = values.at(-1);
  for (const value of values.slice(0, -2)) {
    const text = readString(value)?.toLowerCase();
    if (!text) continue;
    if (["current", "ok", "up-to-date", "up_to_date", "match", "matched"].includes(text)) return "current";
    if (["stale", "behind", "drift", "drifted", "mismatch", "blocked"].includes(text)) return "stale";
    if (["unknown", "missing", "unreported", "null"].includes(text)) return "unknown";
  }
  if (!revision || !expectedRevision || typeof revision !== "string" || typeof expectedRevision !== "string") return "unknown";
  return revision === expectedRevision ? "current" : "stale";
}

function combineReleaseDriftStatus(items: A2AOperatorReleaseDriftItem[]): A2AOperatorReleaseDriftStatus {
  if (items.some((item) => item.status === "stale")) return "stale";
  if (items.some((item) => item.status === "unknown")) return "unknown";
  return "current";
}

function renderReleaseDriftItem(item: A2AOperatorReleaseDriftItem): string {
  const current = item.revision ? shortRevision(item.revision) : "?";
  const expected = item.expectedRevision ? shortRevision(item.expectedRevision) : undefined;
  const revisionText = expected && expected !== current ? `${current}→${expected}` : current;
  return `${item.id} ${item.status} ${revisionText}`;
}

function readWorkerId(record: UnknownRecord): string | undefined {
  return sanitizeLabel(firstString(record.workerId, record.nodeId, record.id, record.name));
}

function sanitizeLabel(value: unknown): string | undefined {
  const text = firstString(value);
  return text && /^[a-zA-Z0-9_.:-]{1,80}$/.test(text) ? text : undefined;
}

function firstSafeRevision(...values: unknown[]): string | undefined {
  const text = firstString(...values);
  if (!text || text === "null") return undefined;
  return /^[a-zA-Z0-9._:-]{4,80}$/.test(text) ? text : undefined;
}

function shortRevision(value: string): string {
  return /^[0-9a-f]{12,}$/i.test(value) ? value.slice(0, 12) : value;
}

function firstString(...values: unknown[]): string | undefined {
  return values.map(readString).find(Boolean);
}

function firstRecord(...values: unknown[]): UnknownRecord | undefined {
  return values.map(asRecord).find(Boolean);
}

function readNotificationType(record: UnknownRecord): A2AOperatorTerminalNotificationType | undefined {
  const task = asRecord(record.task);
  const status = asRecord(task?.status);
  const raw = [record.type, record.kind, record.reason, record.status, status?.state]
    .map(readString)
    .find(Boolean)
    ?.toLowerCase();

  if (!raw) return undefined;
  if (["success", "succeeded", "completed", "done"].includes(raw)) return "success";
  if (["failure", "failed", "error", "errored", "dead_lettered", "canceled", "cancelled"].includes(raw)) return "failure";
  if (["block", "blocked", "approval_required", "needs_approval", "waiting_on_operator"].includes(raw)) return "block";
  if (["pr", "pull_request", "pull-request", "pr_opened", "pr_created"].includes(raw)) return "pr";
  return undefined;
}

function buildTitle(
  type: A2AOperatorTerminalNotificationType,
  taskId?: string,
  prUrl?: string,
  worker?: string,
  roundNum?: number,
  roundTotal?: number,
  terminalBriefTitle?: string,
  parentRoundContext?: boolean,
): string {
  return renderA2AOperatorTerminalBriefDefaultTitle({
    type,
    taskId,
    prUrl,
    worker,
    roundNum,
    roundTotal,
    terminalBriefTitle,
    parentRoundContext,
  });
}

export type A2AOperatorTerminalBriefDefaultTitleInput = {
  type: A2AOperatorTerminalNotificationType;
  taskId?: string;
  prUrl?: string;
  worker?: string;
  roundNum?: number;
  roundTotal?: number;
  terminalBriefTitle?: string;
  parentRoundContext?: boolean;
};

export function renderA2AOperatorTerminalBriefDefaultTitle(
  input: A2AOperatorTerminalBriefDefaultTitleInput,
): string {
  const { type, taskId, prUrl, worker, roundNum, roundTotal, terminalBriefTitle, parentRoundContext } = input;
  const label = worker ?? (taskId ? `task ${taskId}` : "terminal task");
  const progress = formatRoundProgress(roundNum, roundTotal, {
    parentRoundContext,
    progressKind: roundNum !== undefined && roundTotal !== undefined
      ? (type === "success" || type === "pr" ? "completed" : "order")
      : undefined,
  });
  const missingProgress = parentRoundContext && progress === undefined ? formatMissingRoundProgress(type) : undefined;
  if (terminalBriefTitle && !missingProgress) return normalizeSingleWorkerTerminalBriefTitle(terminalBriefTitle, label, progress);
  const subject = progress ? `${label}${progress}` : missingProgress ? `${label}${missingProgress}` : label;
  if (type === "success") return `A2A Terminal Brief 완료: ${subject}`;
  if (type === "failure") return `A2A Terminal Brief 실패: ${subject}`;
  if (type === "block") return `A2A Terminal Brief 차단: ${subject}`;
  return `A2A Terminal Brief PR: ${prUrl ?? subject}`;
}

function formatMissingRoundProgress(type: A2AOperatorTerminalNotificationType): string {
  return type === "success" || type === "pr" ? "(완료 ?/?)" : "(?/?)";
}

function formatRoundProgress(
  roundNum?: number,
  roundTotal?: number,
  options: { parentRoundContext?: boolean; progressKind?: "completed" | "order" } = {},
): string | undefined {
  const allowImplicitSingleWorker = !options.parentRoundContext;
  if (roundNum === undefined && roundTotal === undefined) {
    return allowImplicitSingleWorker ? "(1/1)" : undefined;
  }
  if (roundNum === 1 && roundTotal === undefined) {
    return allowImplicitSingleWorker ? "(1/1)" : undefined;
  }
  if (roundNum === undefined && roundTotal === 1) {
    return allowImplicitSingleWorker ? "(1/1)" : undefined;
  }
  if (
    typeof roundNum !== "number" ||
    !Number.isFinite(roundNum) ||
    roundNum < 1 ||
    !Number.isInteger(roundNum) ||
    typeof roundTotal !== "number" ||
    !Number.isFinite(roundTotal) ||
    roundTotal < 1 ||
    !Number.isInteger(roundTotal) ||
    roundNum > roundTotal
  ) {
    return undefined;
  }
  const label = options.progressKind === "completed" ? "완료 " : "";
  return `(${label}${roundNum}/${roundTotal})`;
}

function normalizeSingleWorkerTerminalBriefTitle(title: string, label: string, progress?: string): string {
  if (progress !== "(1/1)" || /\(\d+\/\d+\)/.test(title)) {
    return title;
  }
  const match = title.match(/^(A2A Terminal Brief (?:완료|실패|차단|취소|PR(?: 알림)?): )(.+)$/);
  if (!match) return title;
  const [, prefix, subject] = match;
  return subject.trim() === label ? `${prefix}${subject}${progress}` : title;
}

/**
 * Terminal Brief template variable names and their value resolver.
 */
export type A2AOperatorTerminalBriefTemplateVariables = {
  title: string;
  type: string;
  worker?: string;
  taskId?: string;
  roundNum?: string;
  roundTotal?: string;
  repo?: string;
  issueUrl?: string;
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  runId?: string;
  traceId?: string;
  summary?: string;
  taskDescription?: string;
  taskSummary?: string;
  taskBrief?: string;
  status?: string;
  pr?: string;
  issue?: string;
};

function buildTerminalBriefTemplateVariables(
  envelope: A2AOperatorTerminalNotificationEnvelope,
): A2AOperatorTerminalBriefTemplateVariables {
  const roundNum = readEnvelopeRoundNum(envelope);
  const roundTotal = readEnvelopeRoundTotal(envelope);
  return {
    title: envelope.title,
    type: envelope.type,
    ...(envelope.worker ? { worker: envelope.worker } : {}),
    ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
    ...(roundNum !== undefined ? { roundNum: String(roundNum) } : {}),
    ...(roundTotal !== undefined ? { roundTotal: String(roundTotal) } : {}),
    ...(envelope.repo ? { repo: envelope.repo } : {}),
    ...(envelope.issueUrl ? { issueUrl: envelope.issueUrl, issue: extractNumberFromUrl(envelope.issueUrl) } : {}),
    ...(envelope.prUrl ? { prUrl: envelope.prUrl, pr: extractNumberFromUrl(envelope.prUrl) } : {}),
    ...(envelope.doneUrl ? { doneUrl: envelope.doneUrl } : {}),
    ...(envelope.blockUrl ? { blockUrl: envelope.blockUrl } : {}),
    ...(envelope.runId ? { runId: envelope.runId } : {}),
    ...(envelope.traceId ? { traceId: envelope.traceId } : {}),
    ...(envelope.evidence.summary ? { summary: envelope.evidence.summary } : {}),
    ...(envelope.evidence.taskDescription ? { taskDescription: envelope.evidence.taskDescription } : {}),
    ...(envelope.evidence.taskSummary ? { taskSummary: envelope.evidence.taskSummary } : {}),
    ...(envelope.evidence.taskBrief ? { taskBrief: envelope.evidence.taskBrief } : {}),
    ...(envelope.status ? { status: envelope.status } : {}),
  };
}

function readEnvelopeRoundNum(envelope: A2AOperatorTerminalNotificationEnvelope): number | undefined {
  return readPositiveInteger(envelope.roundNum) ??
    readPositiveInteger(envelope.parentRoundOrder) ??
    readPositiveInteger(envelope.parentRoundProgress) ??
    readPositiveInteger(envelope.roundProgress?.completed);
}

function readEnvelopeRoundTotal(envelope: A2AOperatorTerminalNotificationEnvelope): number | undefined {
  return readPositiveInteger(envelope.roundTotal) ?? readPositiveInteger(envelope.parentRoundTotal);
}

function extractNumberFromUrl(url: string): string {
  const match = url.match(/\/(\d+)$/);
  return match ? match[1] : url;
}

/**
 * Render a Terminal Brief template string with {variable} placeholders
 * resolved from the envelope's field values.
 *
 * Supports the full set of template variables:
 * {title}, {type}, {worker}, {taskId}, {roundNum}, {roundTotal},
 * {repo}, {issueUrl}, {issue}, {prUrl}, {pr}, {doneUrl}, {blockUrl},
 * {runId}, {traceId}, {summary}, {taskDescription}, {taskSummary},
 * {taskBrief}, {status}
 *
 * Escaped braces (\{\{, \}\}) are preserved as literal braces.
 * Missing variables are replaced with empty string.
 */
export function renderA2AOperatorTerminalBriefTemplate(
  template: string,
  envelope: A2AOperatorTerminalNotificationEnvelope,
): string {
  const vars = buildTerminalBriefTemplateVariables(envelope);
  // Replace {variable} with the value, preserving escaped braces
  return template.replace(
    /\{(\w+)\}/g,
    (match: string, name: string) => {
      const value = (vars as Record<string, string | undefined>)[name];
      if (value !== undefined) return value;
      // Leave unknown variables in place
      return match;
    },
  );
}

function renderWorkerTaskCompletionLine(params: {
  type: A2AOperatorTerminalNotificationType;
  worker?: string;
  taskId?: string;
  taskDescription?: string;
}): string | undefined {
  if (!params.worker && !params.taskId && !params.taskDescription) {
    return undefined;
  }
  const worker = params.worker ?? "unknown worker";
  const task = params.taskId
    ? params.taskDescription
      ? `${params.taskId} — ${params.taskDescription}`
      : params.taskId
    : params.taskDescription ?? "unknown task";
  const verb = params.type === "success" || params.type === "pr" ? "completed" : "reported";
  return `Worker ${worker} ${verb} task: ${task}`;
}

function readTaskDescription(...records: Array<UnknownRecord | undefined>): string | undefined {
  for (const record of records) {
    if (!record) continue;
    const nestedRequest = asRecord(record.request);
    const nestedTask = asRecord(record.task);
    const direct = firstString(
      record.taskDescription,
      record.description,
      record.originalMessage,
      record.instructions,
      record.title,
      nestedRequest?.originalMessage,
      nestedRequest?.instructions,
      nestedTask?.taskDescription,
      nestedTask?.description,
      nestedTask?.originalMessage,
      nestedTask?.instructions,
      nestedTask?.title,
    );
    if (direct) return direct;
  }
  return undefined;
}

function readTaskSummary(...records: Array<UnknownRecord | undefined>): string | undefined {
  for (const record of records) {
    if (!record) continue;
    const nestedTask = asRecord(record.task);
    const result = asRecord(record.result);
    const direct = firstString(
      record.taskSummary,
      record.summary,
      result?.summary,
      nestedTask?.taskSummary,
      nestedTask?.summary,
      nestedTask?.result,
    );
    if (direct) return direct;
  }
  return undefined;
}

function readTaskBrief(...records: Array<UnknownRecord | undefined>): string | undefined {
  for (const record of records) {
    if (!record) continue;
    const nestedTask = asRecord(record.task);
    const direct = firstString(
      record.taskBrief,
      record.brief,
      nestedTask?.taskBrief,
      nestedTask?.brief,
    );
    if (direct) return direct;
  }
  return undefined;
}

function readTerminalBriefTitle(...records: Array<UnknownRecord | undefined>): string | undefined {
  for (const record of records) {
    if (!record) continue;
    const metadata = asRecord(record.metadata);
    const terminalBrief = asRecord(record.terminalBrief);
    const metadataTerminalBrief = asRecord(metadata?.terminalBrief);
    const payload = asRecord(record.payload);
    const payloadTerminalBrief = asRecord(payload?.terminalBrief);
    const crossBroker = asRecord(record.crossBrokerHandoff) ?? asRecord(record.crossBroker) ?? asRecord(record.handoff);
    const crossBrokerTerminalBrief = asRecord(crossBroker?.terminalBrief);
    const payloadCrossBroker = asRecord(payload?.crossBrokerHandoff) ?? asRecord(payload?.crossBroker) ?? asRecord(payload?.handoff);
    const payloadCrossBrokerTerminalBrief = asRecord(payloadCrossBroker?.terminalBrief);
    const direct = firstString(
      record.terminalBriefTitle,
      record.briefTitle,
      terminalBrief?.terminalBriefTitle,
      terminalBrief?.title,
      metadata?.terminalBriefTitle,
      metadata?.briefTitle,
      metadataTerminalBrief?.terminalBriefTitle,
      metadataTerminalBrief?.title,
      payload?.terminalBriefTitle,
      payload?.briefTitle,
      payloadTerminalBrief?.terminalBriefTitle,
      payloadTerminalBrief?.title,
      crossBroker?.terminalBriefTitle,
      crossBroker?.briefTitle,
      crossBrokerTerminalBrief?.terminalBriefTitle,
      crossBrokerTerminalBrief?.title,
      payloadCrossBroker?.terminalBriefTitle,
      payloadCrossBroker?.briefTitle,
      payloadCrossBrokerTerminalBrief?.terminalBriefTitle,
      payloadCrossBrokerTerminalBrief?.title,
    );
    if (direct) return direct;
  }
  return undefined;
}

function buildDedupeKey(parts: {
  eventId?: string;
  taskId?: string;
  type: A2AOperatorTerminalNotificationType;
  createdAt?: string;
  prUrl?: string;
}): string {
  return [parts.eventId, parts.taskId, parts.type, parts.createdAt, parts.prUrl]
    .filter(Boolean)
    .join(":")
    .slice(0, 180);
}

function compactEvidence(values: Omit<A2AOperatorNotificationEvidence, "schema" | "version">): A2AOperatorNotificationEvidence {
  return {
    schema: "a2a.operator.notification.evidence",
    version: 1,
    ...(values.taskId ? { taskId: values.taskId } : {}),
    ...(values.worker ? { worker: values.worker } : {}),
    ...(values.status ? { status: values.status } : {}),
    ...(values.repo ? { repo: values.repo } : {}),
    ...(values.issueUrl ? { issueUrl: values.issueUrl } : {}),
    ...(values.prUrl ? { prUrl: values.prUrl } : {}),
    ...(values.doneUrl ? { doneUrl: values.doneUrl } : {}),
    ...(values.blockUrl ? { blockUrl: values.blockUrl } : {}),
    ...(values.runId ? { runId: values.runId } : {}),
    ...(values.traceId ? { traceId: values.traceId } : {}),
    ...(values.summary ? { summary: values.summary } : {}),
    ...(values.taskDescription ? { taskDescription: values.taskDescription } : {}),
    ...(values.taskSummary ? { taskSummary: values.taskSummary } : {}),
    ...(values.taskBrief ? { taskBrief: values.taskBrief } : {}),
    ...(values.createdAt ? { createdAt: values.createdAt } : {}),
    ...(values.receiptProjection ? { receiptProjection: values.receiptProjection } : {}),
    ...(values.capacityHint ? { capacityHint: values.capacityHint } : {}),
  };
}


function readOperatorReceiptProjection(...records: Array<UnknownRecord | undefined>): A2AOperatorTerminalReceiptProjection | undefined {
  for (const record of records) {
    if (!record) continue;
    const receipt = asRecord(record.receipt);
    const ack = asRecord(record.ack);
    const operator = asRecord(record.operator);
    const evidence = asRecord(record.evidence);
    const projection = normalizeReceiptProjection(firstString(
      record.receiptProjection,
      record.operatorReceiptProjection,
      record.operatorVisibleProjection,
      record.ackProjection,
      record.visibilityProjection,
      receipt?.projection,
      receipt?.kind,
      ack?.projection,
      ack?.kind,
      operator?.receiptProjection,
      operator?.visibleProjection,
      evidence?.receiptProjection,
      evidence?.operatorVisibleProjection,
    ));
    if (projection) return projection;
  }
  return undefined;
}

function readTerminalOutboxReceiptProjection(
  payload: UnknownRecord,
  outbox: UnknownRecord,
): A2AOperatorTerminalReceiptProjection | undefined {
  const explicit = readOperatorReceiptProjection(payload, outbox);
  if (explicit) return explicit;

  // Broker terminal-outbox rows start life as `receipt.status=accepted` and can
  // later move through pre-visibility states such as `produced` while
  // ackAudit still says the notifier must obtain current-session/operator
  // visible evidence before ACK. That is a receipt *requirement*, not provider
  // send evidence. Older plugin builds required an explicit payload
  // receiptProjection and therefore dropped these broker-native rows before any
  // Telegram attempt, leaving attempts=0 forever. Infer the receipt gate only
  // for this broker-owned pending shape; plain provider-accepted-only fixtures
  // remain rejected below.
  const receipt = asRecord(outbox.receipt) ?? asRecord(payload.receipt);
  const ackAudit = asRecord(outbox.ackAudit) ?? asRecord(payload.ackAudit);
  const receiptStatus = readString(receipt?.status)?.toLowerCase();
  const ackDecision = readString(ackAudit?.decision)?.toLowerCase();
  const ackReason = readString(ackAudit?.reason)?.toLowerCase() ?? "";
  if (
    isBrokerPendingReceiptStatus(receiptStatus) &&
    ackDecision === "pending" &&
    isBrokerPendingOperatorVisibilityReason(ackReason)
  ) {
    return "current_session_visible";
  }
  return undefined;
}

function isBrokerPendingOperatorVisibilityReason(reason: string): boolean {
  if (reason.includes("provider accepted only")) return false;
  if (reason.includes("not operator-visible receipt")) return false;
  if (reason.includes("not operator visible receipt")) return false;
  if (reason.includes("no operator-visible receipt")) return false;
  if (reason.includes("no operator visible receipt")) return false;
  if (reason.includes("current-session-visible")) return true;
  if (reason.includes("current session visible")) return true;
  if (reason.includes("operator-visible")) return true;
  if (reason.includes("operator visible")) return true;
  if (reason.includes("operator-facing") && reason.includes("visible receipt")) return true;
  if (reason.includes("awaiting visible receipt")) return true;
  if (reason.includes("parent-owned visibility")) return true;
  if (reason.includes("parent broker visibility")) return true;
  if (reason.includes("parent-broker visibility")) return true;
  if (reason.includes("parent-broker current-session-visible")) return true;
  return false;
}

function isBrokerPendingReceiptStatus(status: string | undefined): boolean {
  return status === "accepted" ||
    status === "started" ||
    status === "produced" ||
    status === "provider_sent" ||
    status === "provider_accepted";
}

function normalizeReceiptProjection(value: string | undefined): A2AOperatorTerminalReceiptProjection | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "current_session_visible" || normalized === "manual_operator_receipt") {
    return normalized;
  }
  return undefined;
}

function readWorker(...records: Array<UnknownRecord | undefined>): string | undefined {
  for (const record of records) {
    if (!record) continue;
    const metadata = asRecord(record.metadata);
    const terminalBrief = asRecord(record.terminalBrief);
    const payload = asRecord(record.payload);
    const payloadTerminalBrief = asRecord(payload?.terminalBrief);
    const crossBroker = asRecord(record.crossBrokerHandoff) ?? asRecord(record.crossBroker) ?? asRecord(record.handoff);
    const payloadCrossBroker = asRecord(payload?.crossBrokerHandoff) ?? asRecord(payload?.crossBroker) ?? asRecord(payload?.handoff);
    const worker = sanitizeLabel(firstString(
      terminalBrief?.workerLabel,
      terminalBrief?.worker,
      record.childWorkerId,
      crossBroker?.childWorkerId,
      metadata?.childWorkerId,
      payload?.childWorkerId,
      payloadTerminalBrief?.workerLabel,
      payloadTerminalBrief?.worker,
      payloadCrossBroker?.childWorkerId,
      record.worker,
      record.workerId,
      record.nodeId,
      metadata?.worker,
      metadata?.workerId,
      payload?.worker,
      payload?.workerId,
      asRecord(record.workerRef)?.id,
    ));
    if (worker) return worker;
  }
  return undefined;
}

function readStatus(terminal: UnknownRecord, task?: UnknownRecord): string | undefined {
  return sanitizeLabel(firstString(terminal.status, terminal.type, asRecord(task?.status)?.state, task?.status));
}

function readRepo(record: UnknownRecord): string | undefined {
  const github = asRecord(record.github);
  const repo = firstString(record.repo, record.repository, record.repositoryFullName, github?.repo, github?.repository);
  return repo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]{1,100}$/.test(repo) ? repo : undefined;
}

function readPrUrl(record: UnknownRecord): string | undefined {
  return [record.prUrl, record.pullRequestUrl, record.htmlUrl, asRecord(record.github)?.prUrl]
    .map(readString)
    .find((value) => Boolean(value && /^https:\/\/github\.com\//.test(value)));
}

function readIssueUrl(record: UnknownRecord): string | undefined {
  const payload = asRecord(record.payload);
  return [
    record.issueUrl,
    record.githubIssueUrl,
    record.parentIssueUrl,
    record.parent_issue_url,
    payload?.issueUrl,
    payload?.githubIssueUrl,
    payload?.parentIssueUrl,
    payload?.parent_issue_url,
    asRecord(record.github)?.issueUrl,
  ]
    .map(readString)
    .find(isSafeHttpUrl);
}

function readIssueNumber(record: UnknownRecord): number | undefined {
  const github = asRecord(record.github);
  const value = record.issue ?? record.issueNumber ?? github?.issue ?? github?.issueNumber;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readRunId(...records: Array<UnknownRecord | undefined>): string | undefined {
  for (const record of records) {
    if (!record) continue;
    const metadata = asRecord(record.metadata);
    const github = asRecord(record.github);
    const value = sanitizeLabel(firstString(record.runId, record.run, record.runName, metadata?.runId, metadata?.run, github?.runId));
    if (value) return value;
  }
  return undefined;
}

function readParentRoundId(...records: Array<UnknownRecord | undefined>): string | undefined {
  for (const record of records) {
    if (!record) continue;
    const metadata = asRecord(record.metadata);
    const terminalBrief = asRecord(record.terminalBrief);
    const payload = asRecord(record.payload);
    const payloadTerminalBrief = asRecord(payload?.terminalBrief);
    const crossBroker = asRecord(record.crossBrokerHandoff) ?? asRecord(record.crossBroker) ?? asRecord(record.handoff);
    const payloadCrossBroker = asRecord(payload?.crossBrokerHandoff) ?? asRecord(payload?.crossBroker) ?? asRecord(payload?.handoff);
    const value = sanitizeLabel(firstString(
      record.parentRoundId,
      record.roundId,
      record.round,
      record.run,
      terminalBrief?.parentRoundId,
      terminalBrief?.roundId,
      metadata?.parentRoundId,
      metadata?.roundId,
      metadata?.round,
      metadata?.run,
      payload?.parentRoundId,
      payload?.roundId,
      payload?.round,
      payload?.run,
      payloadTerminalBrief?.parentRoundId,
      payloadTerminalBrief?.roundId,
      crossBroker?.parentRoundId,
      crossBroker?.roundId,
      payloadCrossBroker?.parentRoundId,
      payloadCrossBroker?.roundId,
    ));
    if (value) return value;
  }
  return undefined;
}

function hasParentRoundContext(...records: Array<UnknownRecord | undefined>): boolean {
  if (readParentRoundId(...records)) return true;
  for (const record of records) {
    if (!record) continue;
    const metadata = asRecord(record.metadata);
    const terminalBrief = asRecord(record.terminalBrief);
    const payload = asRecord(record.payload);
    const payloadTerminalBrief = asRecord(payload?.terminalBrief);
    const crossBroker = asRecord(record.crossBrokerHandoff) ?? asRecord(record.crossBroker) ?? asRecord(record.handoff);
    const payloadCrossBroker = asRecord(payload?.crossBrokerHandoff) ?? asRecord(payload?.crossBroker) ?? asRecord(payload?.handoff);
    const values = [
      record.parentRoundTotal,
      record.parentRoundOrder,
      terminalBrief?.parentRoundTotal,
      terminalBrief?.parentRoundOrder,
      metadata?.parentRoundTotal,
      metadata?.parentRoundOrder,
      payload?.parentRoundTotal,
      payload?.parentRoundOrder,
      payloadTerminalBrief?.parentRoundTotal,
      payloadTerminalBrief?.parentRoundOrder,
      crossBroker,
      crossBroker?.parentRoundTotal,
      crossBroker?.parentRoundOrder,
      payloadCrossBroker,
      payloadCrossBroker?.parentRoundTotal,
      payloadCrossBroker?.parentRoundOrder,
    ];
    if (values.some((value) => value !== undefined && value !== null)) return true;
  }
  return false;
}

function readTraceId(...records: Array<UnknownRecord | undefined>): string | undefined {
  for (const record of records) {
    if (!record) continue;
    const metadata = asRecord(record.metadata);
    const telemetry = asRecord(record.telemetry);
    const value = sanitizeLabel(firstString(record.traceId, record.trace, record.correlationId, metadata?.traceId, telemetry?.traceId));
    if (value) return value;
  }
  return undefined;
}

function readDoneUrl(record: UnknownRecord): string | undefined {
  return [record.doneUrl, record.doneEvidenceUrl, record.done, asRecord(record.evidence)?.doneUrl]
    .map(readString)
    .find(isSafeHttpUrl);
}

function readBlockUrl(record: UnknownRecord): string | undefined {
  return [record.blockUrl, record.blockEvidenceUrl, record.block, asRecord(record.evidence)?.blockUrl]
    .map(readString)
    .find(isSafeHttpUrl);
}

/**
 * Build a sanitized worker capacity hint line from notification event
 * sources (terminal event, metadata, task payload).
 *
 * Checks the task payload for broker-reported worker capability data
 * and produces a safe display string.  Never leaks raw host data.
 */
function buildNotificationCapacityHint(
  terminal: UnknownRecord,
  metadata: UnknownRecord,
  task: UnknownRecord | undefined,
  data: UnknownRecord,
): string | undefined {
  // Try task payload first
  const taskPayload = asRecord(task?.payload);
  if (taskPayload) {
    const hint = extractWorkerCapacityHint(taskPayload);
    if (hint) {
      return formatWorkerCapacityHint(hint);
    }
  }

  // Fallback: check metadata for worker capability
  if (metadata) {
    const hint = extractWorkerCapacityHint(metadata as Record<string, unknown>);
    if (hint) {
      return formatWorkerCapacityHint(hint);
    }
  }

  // Check terminal event payload
  const terminalPayload = asRecord(terminal.payload) ?? asRecord(terminal.data);
  if (terminalPayload && terminalPayload !== taskPayload) {
    const hint = extractWorkerCapacityHint(terminalPayload);
    if (hint) {
      return formatWorkerCapacityHint(hint);
    }
  }

  return undefined;
}

function isSafeHttpUrl(value: string | undefined): value is string {
  return Boolean(value && /^https:\/\//.test(value));
}

function readRoundNum(...records: Array<UnknownRecord | undefined>): number | undefined {
  for (const record of records) {
    if (!record) continue;
    const metadata = asRecord(record.metadata);
    const terminalBrief = asRecord(record.terminalBrief);
    const payload = asRecord(record.payload);
    const payloadTerminalBrief = asRecord(payload?.terminalBrief);
    const crossBroker = asRecord(record.crossBrokerHandoff) ?? asRecord(record.crossBroker) ?? asRecord(record.handoff);
    const payloadCrossBroker = asRecord(payload?.crossBrokerHandoff) ?? asRecord(payload?.crossBroker) ?? asRecord(payload?.handoff);
    const roundProgress = asRecord(record.roundProgress);
    const parentRoundProgress = asRecord(record.parentRoundProgress);
    const metadataRoundProgress = asRecord(metadata?.roundProgress);
    const metadataParentRoundProgress = asRecord(metadata?.parentRoundProgress);
    const crossBrokerRoundProgress = asRecord(crossBroker?.roundProgress);
    const crossBrokerParentRoundProgress = asRecord(crossBroker?.parentRoundProgress);
    const payloadRoundProgress = asRecord(payload?.roundProgress);
    const payloadParentRoundProgress = asRecord(payload?.parentRoundProgress);
    const payloadTerminalRoundProgress = asRecord(payloadTerminalBrief?.roundProgress);
    const payloadTerminalParentRoundProgress = asRecord(payloadTerminalBrief?.parentRoundProgress);
    const payloadCrossBrokerRoundProgress = asRecord(payloadCrossBroker?.roundProgress);
    const payloadCrossBrokerParentRoundProgress = asRecord(payloadCrossBroker?.parentRoundProgress);
    const candidates = [
      record.roundNum,
      record.parentRoundNum,
      record.parentRoundProgress,
      roundProgress?.completed,
      parentRoundProgress?.completed,
      metadata?.roundNum,
      metadata?.parentRoundNum,
      metadata?.parentRoundProgress,
      metadataRoundProgress?.completed,
      metadataParentRoundProgress?.completed,
      payload?.roundNum,
      payload?.parentRoundNum,
      payload?.parentRoundProgress,
      payloadRoundProgress?.completed,
      payloadParentRoundProgress?.completed,
      payloadTerminalRoundProgress?.completed,
      payloadTerminalParentRoundProgress?.completed,
      record.completionNum,
      crossBroker?.roundNum,
      crossBroker?.parentRoundNum,
      crossBroker?.parentRoundProgress,
      crossBrokerRoundProgress?.completed,
      crossBrokerParentRoundProgress?.completed,
      crossBroker?.completionNum,
      payloadCrossBroker?.roundNum,
      payloadCrossBroker?.parentRoundNum,
      payloadCrossBroker?.parentRoundProgress,
      payloadCrossBrokerRoundProgress?.completed,
      payloadCrossBrokerParentRoundProgress?.completed,
      payloadCrossBroker?.completionNum,
    ];
    for (const value of candidates) {
      const parsed = readPositiveInteger(value);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function readRoundTotal(...records: Array<UnknownRecord | undefined>): number | undefined {
  for (const record of records) {
    if (!record) continue;
    const metadata = asRecord(record.metadata);
    const terminalBrief = asRecord(record.terminalBrief);
    const payload = asRecord(record.payload);
    const payloadTerminalBrief = asRecord(payload?.terminalBrief);
    const crossBroker = asRecord(record.crossBrokerHandoff) ?? asRecord(record.crossBroker) ?? asRecord(record.handoff);
    const payloadCrossBroker = asRecord(payload?.crossBrokerHandoff) ?? asRecord(payload?.crossBroker) ?? asRecord(payload?.handoff);
    const candidates = [
      record.roundTotal,
      record.parentRoundTotal,
      terminalBrief?.total,
      terminalBrief?.parentRoundTotal,
      metadata?.roundTotal,
      metadata?.parentRoundTotal,
      payload?.roundTotal,
      payload?.parentRoundTotal,
      payload?.terminalBriefTotal,
      payloadTerminalBrief?.total,
      payloadTerminalBrief?.parentRoundTotal,
      record.totalTasks,
      record.totalWorkers,
      record.roundDenominator,
      crossBroker?.roundTotal,
      crossBroker?.parentRoundTotal,
      crossBroker?.totalTasks,
      crossBroker?.totalWorkers,
      payloadCrossBroker?.roundTotal,
      payloadCrossBroker?.parentRoundTotal,
      payloadCrossBroker?.totalTasks,
      payloadCrossBroker?.totalWorkers,
    ];
    for (const value of candidates) {
      const parsed = readPositiveInteger(value);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function readStatusMessage(task?: UnknownRecord): string | undefined {
  const status = asRecord(task?.status);
  const message = asRecord(status?.message);
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts.map(asRecord).map((part) => readString(part?.text)).find(Boolean);
}

function redactText(value: string): string {
  return value
    .replace(URL_SECRET_RE, "$1[REDACTED]")
    .replace(BEARER_RE, "[REDACTED]")
    .replace(SECRET_ASSIGN_RE, "[REDACTED]")
    .replace(PRIVATE_PATH_RE, "[REDACTED_PATH]");
}

function clampText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}
