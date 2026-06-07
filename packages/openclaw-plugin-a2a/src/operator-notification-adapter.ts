import {
  resolveA2ABrokerAdapterPluginConfig,
  type A2ABrokerAdapterPluginRuntimeConfig,
} from "../config.js";
import {
  renderA2AOperatorTerminalBriefTemplate,
  type A2AOperatorTerminalNotificationEnvelope,
} from "./operator-terminal-notifier.js";

type UnknownRecord = Record<string, unknown>;

type OperatorNotificationTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  allowUnconfirmedProviderSend?: boolean;
};

type OperatorNotificationOutboundAdapter = {
  sendText?: (payload: UnknownRecord) => Promise<unknown> | unknown;
  sendPayload?: (payload: UnknownRecord) => Promise<unknown> | unknown;
  base?: OperatorNotificationOutboundAdapter;
  attachedResults?: OperatorNotificationOutboundAdapter;
  capabilities?: UnknownRecord;
  receiptCapabilities?: UnknownRecord;
  supportsReceipt?: (receiptMode: "current_session_visible") => boolean | Promise<boolean>;
  supportsCurrentSessionVisibleReceipt?: boolean;
  supportsUserVisibleReceipt?: boolean;
  currentSessionVisibleReceipt?: boolean;
  userVisibleReceipt?: boolean;
  shouldTreatDeliveredTextAsVisible?: (params: {
    kind: "tool" | "block" | "final";
    text?: string;
  }) => boolean;
};

type OperatorNotificationRuntime = {
  channel?: {
    outbound?: {
      loadAdapter?: (channel: never) => Promise<OperatorNotificationOutboundAdapter | undefined>;
    };
  };
};

export type A2AOperatorNotificationReceiptConfirmationSource =
  | "current_session_visible"
  | "manual_operator_receipt"
  | "dry_run_projection";

export type A2AOperatorNotificationDeliveryReceipt = {
  dedupeKey: string;
  channel: string;
  to: string;
  deliveredAt: string;
  confirmationSource: A2AOperatorNotificationReceiptConfirmationSource;
  dryRun?: boolean;
};

export type A2AOperatorNotificationAdapter = {
  notify(envelope: A2AOperatorTerminalNotificationEnvelope): Promise<A2AOperatorNotificationDeliveryReceipt | undefined>;
  listReceipts(): A2AOperatorNotificationDeliveryReceipt[];
};

export type A2AOperatorNotificationPreflightCheck = {
  code:
    | "plugin_activation"
    | "operator_events_enabled"
    | "notification_target"
    | "runtime_adapter"
    | "receipt_runtime"
    | "terminal_outbox_fuse";
  ok: boolean;
  message: string;
  severity: "info" | "error";
};

export type A2AOperatorNotificationTargetState = {
  status: "ready" | "disabled" | "missing" | "blocked";
  enabled: boolean;
  configured: boolean;
  channel?: string;
  to?: string;
  reason: string;
};

export type A2AOperatorNotificationPreflightResult = {
  ok: boolean;
  safeToRestartGateway: boolean;
  providerSendMode: "receipt_confirmed_required" | "transport_only_unacknowledged";
  notificationTarget: A2AOperatorNotificationTargetState;
  target?: OperatorNotificationTarget;
  checks: A2AOperatorNotificationPreflightCheck[];
};

export type A2AOperatorNotificationPreflightDeps = {
  terminalOutbox?: UnknownRecord;
  terminalOutboxHistory?: UnknownRecord;
};

const MAX_RECEIPTS = 250;

export function createA2AOperatorNotificationAdapter(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  runtime: unknown,
  deps: { now?: () => number } = {},
): A2AOperatorNotificationAdapter | undefined {
  const target = resolveOperatorNotificationTarget(config);
  if (!target) {
    return undefined;
  }
  const notificationTarget = target;

  const safeRuntime = runtime as OperatorNotificationRuntime | undefined;
  const delivered = new Map<string, A2AOperatorNotificationDeliveryReceipt>();
  const pending = new Map<string, Promise<A2AOperatorNotificationDeliveryReceipt | undefined>>();
  const now = deps.now ?? Date.now;

  return {
    async notify(envelope) {
      const existing = delivered.get(envelope.dedupeKey);
      if (existing) {
        return existing;
      }
      const inFlight = pending.get(envelope.dedupeKey);
      if (inFlight) {
        return await inFlight;
      }

      const attempt = notifyOnce(envelope);
      pending.set(envelope.dedupeKey, attempt);
      try {
        return await attempt;
      } finally {
        pending.delete(envelope.dedupeKey);
      }
    },
    listReceipts() {
      return [...delivered.values()].map((receipt) => ({ ...receipt }));
    },
  };

  async function notifyOnce(
    envelope: A2AOperatorTerminalNotificationEnvelope,
  ): Promise<A2AOperatorNotificationDeliveryReceipt | undefined> {
    const existing = delivered.get(envelope.dedupeKey);
    if (existing) {
      return existing;
    }

    let confirmationSource: A2AOperatorNotificationReceiptConfirmationSource;

    if (envelope.dryRun) {
      confirmationSource = "dry_run_projection";
    } else {
      const outbound = await safeRuntime?.channel?.outbound?.loadAdapter?.(notificationTarget.channel as never);
      if (!outbound || !hasOperatorNotificationSender(outbound)) {
        return undefined;
      }
      if (!notificationTarget.allowUnconfirmedProviderSend && !await adapterSupportsCurrentSessionVisibleReceipt(outbound)) {
        return undefined;
      }
      const text = renderOperatorNotificationText(envelope);
      const providerResult = await sendOperatorNotification(outbound, {
        cfg: config as never,
        target: notificationTarget,
        text,
      });
      const confirmed = readReceiptConfirmationSource(providerResult, notificationTarget)
        ?? (await isCurrentSessionVisibleDelivery(outbound, providerResult, notificationTarget, text)
          ? "current_session_visible"
          : undefined);
      if (!confirmed) {
        // receipt_confirmation_missing: provider acceptance is transport-only and must not ACK Terminal Brief delivery.
        return undefined;
      }
      confirmationSource = confirmed;
    }

    const receipt: A2AOperatorNotificationDeliveryReceipt = {
      dedupeKey: envelope.dedupeKey,
      channel: notificationTarget.channel,
      to: notificationTarget.to,
      deliveredAt: new Date(now()).toISOString(),
      confirmationSource,
      ...(envelope.dryRun ? { dryRun: true } : {}),
    };

    delivered.set(envelope.dedupeKey, receipt);
    if (delivered.size > MAX_RECEIPTS) {
      const oldest = delivered.keys().next().value;
      if (oldest) delivered.delete(oldest);
    }
    return receipt;
  }
}

export async function preflightA2AOperatorNotificationRuntime(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  runtime: unknown,
  deps: A2AOperatorNotificationPreflightDeps = {},
): Promise<A2AOperatorNotificationPreflightResult> {
  const resolved = resolveA2ABrokerAdapterPluginConfig(config);
  const target = resolveOperatorNotificationTarget(config);
  const notificationTarget = buildOperatorNotificationTargetState(config, resolved, target);
  const checks: A2AOperatorNotificationPreflightCheck[] = [];

  checks.push({
    code: "plugin_activation",
    ok: resolved.enabled && resolved.explicitlyActivated,
    severity: resolved.enabled && resolved.explicitlyActivated ? "info" : "error",
    message: resolved.enabled && resolved.explicitlyActivated
      ? "a2a-broker-adapter is explicitly activated"
      : "set plugins.entries.a2a-broker-adapter.enabled=true or allowlist the plugin before restarting Gateway",
  });
  checks.push({
    code: "operator_events_enabled",
    ok: resolved.operatorEventsEnabled,
    severity: resolved.operatorEventsEnabled ? "info" : "error",
    message: resolved.operatorEventsEnabled
      ? "operatorEvents.enabled is true"
      : "set plugins.entries.a2a-broker-adapter.config.operatorEvents.enabled=true before terminal-outbox monitoring",
  });
  checks.push({
    code: "notification_target",
    ok: Boolean(target),
    severity: target ? "info" : "error",
    message: target
      ? `operatorEvents.notification resolves to ${target.channel}`
      : "set operatorEvents.enabled=true and operatorEvents.notification.enabled=true with notification.to or chatId; stale targets stay ignored while disabled",
  });

  let runtimeAdapterReady = true;
  let receiptRuntimeReady = true;
  if (target) {
    const adapterChecks = await preflightRuntimeAdapter(runtime, target.channel);
    checks.push(...adapterChecks);
    runtimeAdapterReady = adapterChecks.some((check) => check.code === "runtime_adapter" && check.ok);
    receiptRuntimeReady = adapterChecks.some((check) => check.code === "receipt_runtime" && check.ok);
  }

  const terminalOutboxChecks = preflightTerminalOutboxFuse(deps.terminalOutbox, deps.terminalOutboxHistory);
  checks.push(...terminalOutboxChecks);

  const ok = checks.every((check) => check.ok);
  const terminalOutboxBlocker = terminalOutboxChecks.find((check) => !check.ok);
  const finalNotificationTarget = target && (!runtimeAdapterReady || !receiptRuntimeReady || terminalOutboxBlocker)
    ? {
      ...notificationTarget,
      status: "blocked" as const,
      reason: terminalOutboxBlocker
        ? terminalOutboxBlocker.message
        : !runtimeAdapterReady
        ? `operatorEvents.notification resolves to ${target.channel}, but no runtime route is available; preflight did not send a live message`
        : `operatorEvents.notification resolves to ${target.channel}, but runtime does not advertise current-session-visible receipt support; preflight did not send a live message`,
    }
    : notificationTarget;
  return {
    ok,
    safeToRestartGateway: ok,
    providerSendMode: target?.allowUnconfirmedProviderSend === true
      ? "transport_only_unacknowledged"
      : "receipt_confirmed_required",
    notificationTarget: finalNotificationTarget,
    ...(target ? { target } : {}),
    checks,
  };
}

function preflightTerminalOutboxFuse(
  terminalOutbox: UnknownRecord | undefined,
  terminalOutboxHistory: UnknownRecord | undefined,
): A2AOperatorNotificationPreflightCheck[] {
  if (terminalOutbox) {
    const deployPreflight = asRecord(terminalOutbox.deployPreflight);
    const lastNotificationAttempt = asRecord(terminalOutbox.lastNotificationAttempt)
      ?? asRecord(deployPreflight?.lastNotificationAttempt);
    const reason = readOptionalString(lastNotificationAttempt?.reason);
    const deployStatus = readOptionalString(deployPreflight?.status);
    const receiptStatus = readOptionalString(lastNotificationAttempt?.receiptStatus);
    const fuseReason = reason && /one-shot live notification fuse|manual receipt\/ACK is required/i.test(reason)
      ? reason
      : undefined;

    if (fuseReason) {
      return [{
        code: "terminal_outbox_fuse",
        ok: false,
        severity: "error",
        message: `terminal-outbox live canary is blocked before restart: ${fuseReason}`,
      }];
    }

    if (deployStatus === "blocked" && receiptStatus === "pending") {
      return [{
        code: "terminal_outbox_fuse",
        ok: false,
        severity: "error",
        message: "terminal-outbox deploy preflight is blocked by a pending receipt; resolve operator-visible/manual receipt debt before Gateway restart or live canary",
      }];
    }
  }

  const historyError = readOptionalString(terminalOutboxHistory?.error);
  if (historyError) {
    return [{
      code: "terminal_outbox_fuse",
      ok: false,
      severity: "error",
      message: `terminal-outbox history preflight failed before restart: ${historyError}`,
    }];
  }

  const historyEvents = readRecordArray(terminalOutboxHistory?.events);
  if (historyEvents.length) {
    const pending = historyEvents.filter(isUnacknowledgedTerminalOutboxHistoryEvent);
    if (pending.length) {
      const first = pending[0];
      const taskId = readOptionalString(asRecord(first.payload)?.taskId);
      return [{
        code: "terminal_outbox_fuse",
        ok: false,
        severity: "error",
        message: `broker terminal-outbox history has ${pending.length} unacknowledged accepted/pending row(s) after the preflight cursor${taskId ? `; first taskId=${taskId}` : ""}; resolve operator-visible/manual receipt debt before Gateway restart or live canary`,
      }];
    }
  }

  if (!terminalOutbox && !terminalOutboxHistory) return [];

  return [{
    code: "terminal_outbox_fuse",
    ok: true,
    severity: "info",
    message: terminalOutboxHistory
      ? "terminal-outbox state/history has no tripped one-shot notification fuse or unacknowledged accepted rows"
      : "terminal-outbox state has no tripped one-shot notification fuse",
  }];
}

function isUnacknowledgedTerminalOutboxHistoryEvent(event: UnknownRecord): boolean {
  const ack = asRecord(event.ack);
  if (readOptionalString(ack?.status) === "receipt_confirmed") return false;
  if (readOptionalString(event.deliveredAt)) return false;
  const receipt = asRecord(event.receipt);
  const receiptStatus = readOptionalString(receipt?.status)?.toLowerCase();
  if (receiptStatus === "operator_visible" || receiptStatus === "receipt_confirmed") return false;
  return receiptStatus === "accepted" || receiptStatus === "pending" || readOptionalNumber(event.attempts) === 0 || !ack;
}

function buildOperatorNotificationTargetState(
  config: A2ABrokerAdapterPluginRuntimeConfig,
  resolved: ReturnType<typeof resolveA2ABrokerAdapterPluginConfig>,
  target: OperatorNotificationTarget | undefined,
): A2AOperatorNotificationTargetState {
  if (target) {
    return {
      status: "ready",
      enabled: true,
      configured: true,
      channel: target.channel,
      to: target.to,
      reason: `operatorEvents.notification resolves to ${target.channel}; runtime preflight does not send live messages`,
    };
  }

  const pluginConfig = config.plugins?.entries?.["a2a-broker-adapter"]?.config;
  const operatorEvents = asRecord(pluginConfig?.operatorEvents);
  const notification = asRecord(operatorEvents?.notification) ?? asRecord(operatorEvents?.notify);
  const channel = readOptionalString(notification?.channel) ?? "telegram";
  const staleTo = readOptionalString(notification?.to) ?? readOptionalString(notification?.chatId);

  if (!resolved.enabled || !resolved.explicitlyActivated || !resolved.operatorEventsEnabled) {
    return {
      status: "blocked",
      enabled: false,
      configured: false,
      reason: "operator events are not fully enabled; notification targets are ignored until plugin and operatorEvents are active",
    };
  }

  if (!notification || notification.enabled !== true) {
    return {
      status: "disabled",
      enabled: false,
      configured: false,
      channel,
      reason: staleTo
        ? "operatorEvents.notification.enabled is not true; stale notification.to/chatId is ignored and no live send will occur"
        : "operatorEvents.notification.enabled is not true; no live notification target is active",
    };
  }

  return {
    status: "missing",
    enabled: true,
    configured: false,
    channel,
    reason: "operatorEvents.notification.enabled=true but notification.to/chatId is missing; terminal ACK remains receipt-gated",
  };
}

async function preflightRuntimeAdapter(
  runtime: unknown,
  channel: string,
): Promise<A2AOperatorNotificationPreflightCheck[]> {
  const safeRuntime = runtime as OperatorNotificationRuntime | undefined;
  const loadAdapter = safeRuntime?.channel?.outbound?.loadAdapter;
  if (!loadAdapter) {
    return [{
      code: "runtime_adapter",
      ok: false,
      severity: "error",
      message: "Gateway runtime channel outbound loader is unavailable; restart/live send is not ready",
    }];
  }

  try {
    const outbound = await loadAdapter(channel as never);
    if (outbound && hasOperatorNotificationSender(outbound)) {
      const supportsReceipt = await adapterSupportsCurrentSessionVisibleReceipt(outbound);
      return [
        {
          code: "runtime_adapter",
          ok: true,
          severity: "info",
          message: `Gateway runtime can resolve ${channel} outbound adapter without sending a live message`,
        },
        {
          code: "receipt_runtime",
          ok: supportsReceipt,
          severity: supportsReceipt ? "info" : "error",
          message: supportsReceipt
            ? `Gateway runtime ${channel} adapter advertises current-session-visible receipt support without sending a live message`
            : `Gateway runtime ${channel} adapter does not advertise current-session-visible receipt support; live send remains approval-blocked`,
        },
      ];
    }
  } catch (error) {
    return [{
      code: "runtime_adapter",
      ok: false,
      severity: "error",
      message: `Gateway runtime failed to resolve ${channel} outbound adapter: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }

  return [{
    code: "runtime_adapter",
    ok: false,
    severity: "error",
    message: `Gateway runtime ${channel} adapter does not expose sendText/sendPayload; live send remains approval-blocked`,
  }];
}

async function sendOperatorNotification(
  outbound: OperatorNotificationOutboundAdapter,
  params: { cfg: unknown; target: OperatorNotificationTarget; text: string },
): Promise<unknown> {
  const payload = {
    cfg: params.cfg as never,
    channel: params.target.channel,
    to: params.target.to,
    text: params.text,
    delivery: {
      mode: "announce",
      channel: params.target.channel,
      to: params.target.to,
      ...(params.target.accountId ? { accountId: params.target.accountId } : {}),
      ...(params.target.threadId !== undefined ? { threadId: params.target.threadId } : {}),
    },
    receiptRequired: "current_session_visible",
    userVisibleReceiptRequired: true,
    ...(params.target.accountId ? { accountId: params.target.accountId } : {}),
    ...(params.target.threadId !== undefined ? { threadId: params.target.threadId } : {}),
  };
  const payloadSender = outbound.sendPayload ?? outbound.base?.sendPayload ?? outbound.attachedResults?.sendPayload;
  if (payloadSender) {
    return await payloadSender({
      ...payload,
      payload: { text: params.text },
    });
  }
  const textSender = outbound.sendText ?? outbound.base?.sendText ?? outbound.attachedResults?.sendText;
  if (textSender) return await textSender(payload);
  return undefined;
}

function hasOperatorNotificationSender(outbound: OperatorNotificationOutboundAdapter): boolean {
  return Boolean(
    outbound.sendText ||
    outbound.sendPayload ||
    outbound.attachedResults?.sendText ||
    outbound.attachedResults?.sendPayload ||
    outbound.base?.sendText ||
    outbound.base?.sendPayload
  );
}

async function adapterSupportsCurrentSessionVisibleReceipt(
  outbound: OperatorNotificationOutboundAdapter,
): Promise<boolean> {
  if (outbound.supportsCurrentSessionVisibleReceipt === true || outbound.supportsUserVisibleReceipt === true) return true;
  if (outbound.currentSessionVisibleReceipt === true || outbound.userVisibleReceipt === true) return true;

  for (const capabilities of [
    outbound.capabilities,
    outbound.receiptCapabilities,
    outbound.attachedResults?.capabilities,
    outbound.attachedResults?.receiptCapabilities,
    outbound.base?.capabilities,
    outbound.base?.receiptCapabilities,
  ]) {
    if (!capabilities) continue;
    if (
      capabilities.currentSessionVisibleReceipt === true ||
      capabilities.current_session_visible === true ||
      capabilities.currentSessionVisible === true ||
      capabilities.userVisibleReceipt === true ||
      capabilities.user_visible_receipt === true
    ) {
      return true;
    }
    const receipt = asRecord(capabilities.receipt);
    if (
      receipt?.currentSessionVisible === true ||
      receipt?.currentSessionVisibleReceipt === true ||
      receipt?.current_session_visible === true ||
      receipt?.userVisibleReceipt === true
    ) {
      return true;
    }
  }

  if (outbound.supportsReceipt) {
    try {
      return await outbound.supportsReceipt("current_session_visible") === true;
    } catch {
      return false;
    }
  }

  return adapterTreatsDeliveredTextAsVisible(outbound, undefined);
}

async function isCurrentSessionVisibleDelivery(
  outbound: OperatorNotificationOutboundAdapter,
  providerResult: unknown,
  target: OperatorNotificationTarget,
  text: string,
): Promise<boolean> {
  if (!adapterTreatsDeliveredTextAsVisible(outbound, text)) {
    return false;
  }
  return providerResultConfirmsDelivery(providerResult, target);
}

function adapterTreatsDeliveredTextAsVisible(
  outbound: OperatorNotificationOutboundAdapter,
  text: string | undefined,
): boolean {
  for (const candidate of [outbound, outbound.attachedResults, outbound.base]) {
    const predicate = candidate?.shouldTreatDeliveredTextAsVisible;
    if (!predicate) continue;
    try {
      if (predicate({ kind: "tool", ...(text !== undefined ? { text } : {}) }) === true) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

function providerResultConfirmsDelivery(
  value: unknown,
  target: OperatorNotificationTarget): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const delivery = asRecord(record.delivery);
  const receipt = asRecord(record.receipt);
  const candidates = [record, delivery, receipt].filter(Boolean) as UnknownRecord[];
  if (candidates.some((candidate) => !receiptTargetMatches(candidate, target))) {
    return false;
  }
  return candidates.some((candidate) =>
    Boolean(readOptionalString(candidate.messageId)) ||
    Boolean(readOptionalString(candidate.message_id)) ||
    Boolean(readOptionalNumber(candidate.messageId)) ||
    Boolean(readOptionalNumber(candidate.message_id)) ||
    Boolean(readOptionalString(candidate.id)) ||
    readOptionalString(candidate.status) === "delivered" ||
    readOptionalString(candidate.status) === "visible" ||
    readOptionalString(candidate.status) === "operator_visible"
  );
}

export function renderOperatorNotificationText(
  envelope: A2AOperatorTerminalNotificationEnvelope,
): string {
  // Parent-owned/cross-broker relay projections: skip the child broker's
  // terminalBriefTemplate (e.g. "곽가 원문\n{title}\n요약: {summary}")
  // and return the raw compact title directly.  The template is the child
  // broker's local formatting convention and must not wrap the title when
  // the notification is rendered for the parent-broker operator.
  if (
    envelope.parentRoundId &&
    envelope.terminalBriefTemplate &&
    envelope.terminalBriefTitle &&
    /^A2A Terminal Brief\s+\S+:\s+\S+\(.+\)$/.test(envelope.terminalBriefTitle)
  ) {
    return envelope.terminalBriefTitle;
  }

  // When a terminalBriefTemplate is provided, render the template string
  // with {variable} placeholders resolved from the envelope fields.
  if (envelope.terminalBriefTemplate) {
    return renderA2AOperatorTerminalBriefTemplate(envelope.terminalBriefTemplate, envelope);
  }

  return renderCompactOperatorNotificationTitle(envelope);
}

function renderCompactOperatorNotificationTitle(
  envelope: A2AOperatorTerminalNotificationEnvelope,
): string {
  const worker = envelope.worker?.trim();
  const parentRoundContext = Boolean(
    envelope.parentRoundContext ||
      envelope.parentRoundId ||
      envelope.parentRoundTotal !== undefined ||
      envelope.parentRoundOrder !== undefined,
  );
  const progress = formatCompactRoundProgress(
    readEnvelopeRoundNum(envelope),
    readEnvelopeRoundTotal(envelope),
    {
      parentRoundContext,
      progressKind: readEnvelopeRoundProgressKind(envelope),
    },
  );
  const label = worker ?? "A2A";
  // Broker-provided terminalBriefTitle takes precedence, except for the
  // standard single-worker title shape that must still show (1/1).
  const missingProgress = parentRoundContext && progress === undefined ? formatMissingCompactRoundProgress(envelope.type) : undefined;
  if (envelope.terminalBriefTitle && !missingProgress) {
    return normalizeSingleWorkerTerminalBriefTitle(envelope.terminalBriefTitle, label, progress);
  }
  // Avoid hardcoded "${worker} 작업" when round progress is available
  if (progress || missingProgress) {
    const subject = `${label}${progress ?? missingProgress}`;
    if (envelope.type === "success") return `A2A Terminal Brief 완료: ${subject}`;
    if (envelope.type === "failure") return `A2A Terminal Brief 실패: ${subject}`;
    if (envelope.type === "block") return `A2A Terminal Brief 차단: ${subject}`;
    return `A2A Terminal Brief PR 알림: ${subject}`;
  }
  const subject = worker ? `${label} 작업` : `${label} 작업`;
  if (envelope.type === "success") return `A2A Terminal Brief 완료: ${subject}`;
  if (envelope.type === "failure") return `A2A Terminal Brief 실패: ${subject}`;
  if (envelope.type === "block") return `A2A Terminal Brief 차단: ${subject}`;
  return `A2A Terminal Brief PR 알림: ${subject}`;
}

function formatMissingCompactRoundProgress(type: A2AOperatorTerminalNotificationEnvelope["type"]): string {
  return type === "success" || type === "pr" ? "(완료 ?/?)" : "(?/?)";
}

function readEnvelopeRoundNum(envelope: A2AOperatorTerminalNotificationEnvelope): number | undefined {
  return readPositiveInteger(envelope.roundNum) ??
    readPositiveInteger(envelope.parentRoundProgress) ??
    readPositiveInteger(envelope.roundProgress?.completed) ??
    readPositiveInteger(envelope.parentRoundOrder);
}

/**
 * Returns the progress kind for the envelope's round number:
 * - "completed" when the primary source is a progress field (parentRoundProgress or roundProgress.completed)
 * - "order" when only parentRoundOrder is available (lane order)
 * - undefined when no round progress info exists
 */
function readEnvelopeRoundProgressKind(
  envelope: A2AOperatorTerminalNotificationEnvelope,
): "completed" | "order" | undefined {
  // For failure/block types, progress label should not say "완료" (completed).
  // Use "order" to show lane position without misleading success labeling.
  if (envelope.type === "failure" || envelope.type === "block") {
    if (
      readPositiveInteger(envelope.roundNum) !== undefined ||
      readPositiveInteger(envelope.parentRoundProgress) !== undefined ||
      readPositiveInteger(envelope.roundProgress?.completed) !== undefined ||
      readPositiveInteger(envelope.parentRoundOrder) !== undefined
    ) {
      return "order";
    }
    return undefined;
  }
  if (readPositiveInteger(envelope.roundNum) !== undefined) {
    return "completed";
  }
  if (readPositiveInteger(envelope.parentRoundProgress) !== undefined) {
    return "completed";
  }
  if (readPositiveInteger(envelope.roundProgress?.completed) !== undefined) {
    return "completed";
  }
  if (readPositiveInteger(envelope.parentRoundOrder) !== undefined) {
    return "order";
  }
  return undefined;
}

function readEnvelopeRoundTotal(envelope: A2AOperatorTerminalNotificationEnvelope): number | undefined {
  return readPositiveInteger(envelope.roundTotal) ?? readPositiveInteger(envelope.parentRoundTotal);
}

function formatCompactRoundProgress(
  roundNum?: number,
  roundTotal?: number,
  options: { parentRoundContext?: boolean; progressKind?: "completed" | "order" } = {},
): string | undefined {
  const allowImplicitSingleWorker = !options.parentRoundContext;
  if (roundNum === undefined && roundTotal === undefined) {
    return allowImplicitSingleWorker ? "(1/1)" : undefined;
  }
  if ((roundNum === 1 && roundTotal === undefined) || (roundNum === undefined && roundTotal === 1)) {
    return allowImplicitSingleWorker ? "(1/1)" : undefined;
  }
  if (roundNum === undefined || roundTotal === undefined || roundNum > roundTotal) {
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

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export function resolveOperatorNotificationTarget(
  config: A2ABrokerAdapterPluginRuntimeConfig,
): OperatorNotificationTarget | undefined {
  const resolved = resolveA2ABrokerAdapterPluginConfig(config);
  if (!resolved.enabled || !resolved.explicitlyActivated || !resolved.operatorEventsEnabled) {
    return undefined;
  }

  const pluginConfig = config.plugins?.entries?.["a2a-broker-adapter"]?.config;
  const operatorEvents = asRecord(pluginConfig?.operatorEvents);
  const notification = asRecord(operatorEvents?.notification) ?? asRecord(operatorEvents?.notify);
  if (!notification || notification.enabled !== true) {
    return undefined;
  }

  const channel = readOptionalString(notification.channel) ?? "telegram";
  const to = readOptionalString(notification.to) ?? readOptionalString(notification.chatId);
  if (!to) {
    return undefined;
  }

  const accountId = readOptionalString(notification.accountId);
  const threadId = readOptionalString(notification.threadId) ?? readOptionalNumber(notification.threadId);
  const allowUnconfirmedProviderSend = notification.allowUnconfirmedProviderSend === true;
  return {
    channel,
    to,
    ...(accountId ? { accountId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(allowUnconfirmedProviderSend ? { allowUnconfirmedProviderSend } : {}),
  };
}

function readReceiptConfirmationSource(
  value: unknown,
  target: OperatorNotificationTarget,
): A2AOperatorNotificationReceiptConfirmationSource | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const delivery = asRecord(record.delivery);
  const receipt = asRecord(record.receipt);
  const confirmation = asRecord(record.confirmation) ?? asRecord(delivery?.confirmation) ?? asRecord(receipt?.confirmation);
  const candidates = [record, delivery, receipt, confirmation].filter(Boolean) as UnknownRecord[];
  if (candidates.some((candidate) => !receiptTargetMatches(candidate, target))) {
    return undefined;
  }

  for (const candidate of candidates) {
    if (!receiptTargetMatches(candidate, target)) {
      continue;
    }
    if (candidateIsAcceptedButNotAcknowledged(candidate)) {
      continue;
    }
    if (
      candidate.currentSessionVisible === true ||
      candidate.current_session_visible === true ||
      candidate.userVisible === true ||
      candidate.user_visible === true ||
      candidate.visibleInCurrentSession === true ||
      candidate.visible_in_current_session === true
    ) {
      return "current_session_visible";
    }
    if (
      candidate.manualReceiptConfirmed === true ||
      candidate.manual_receipt_confirmed === true ||
      candidate.operatorReceiptConfirmed === true ||
      candidate.operator_receipt_confirmed === true ||
      candidate.receiptConfirmedByOperator === true ||
      candidate.receipt_confirmed_by_operator === true ||
      candidate.manual_operator_receipt === true
    ) {
      return "manual_operator_receipt";
    }
    const source =
      readOptionalString(candidate.confirmationSource) ??
      readOptionalString(candidate.confirmation_source) ??
      readOptionalString(candidate.source) ??
      readOptionalString(candidate.receiptProjection) ??
      readOptionalString(candidate.receipt_projection) ??
      readOptionalString(candidate.evidence) ??
      readOptionalString(candidate.terminalAckProjection) ??
      readOptionalString(candidate.terminal_ack_projection) ??
      readOptionalString(candidate.projection) ??
      readOptionalString(candidate.mode);
    const normalizedSource = normalizeReceiptConfirmationSource(source);
    if (normalizedSource) {
      const status = readOptionalString(candidate.status);
      if (!status || ["confirmed", "receipt_confirmed", "delivered", "visible", "operator_visible", "operator_confirmed", "received"].includes(status) || candidateHasExplicitAcknowledgement(candidate)) {
        return normalizedSource;
      }
    }
  }

  return undefined;
}

function normalizeReceiptConfirmationSource(value: string | undefined): A2AOperatorNotificationReceiptConfirmationSource | undefined {
  const normalized = value?.toLowerCase();
  if (normalized === "current_session_visible" || normalized === "operator_visible" || normalized === "operator-visible") {
    return "current_session_visible";
  }
  if (normalized === "manual_operator_receipt" || normalized === "operator_confirmed" || normalized === "operator-confirmed") {
    return "manual_operator_receipt";
  }
  return undefined;
}

function candidateHasExplicitAcknowledgement(candidate: UnknownRecord): boolean {
  return (
    readOptionalBoolean(candidate.acknowledged) ??
    readOptionalBoolean(candidate.operatorAcknowledged) ??
    readOptionalBoolean(candidate.operator_acknowledged) ??
    readOptionalBoolean(candidate.userVisibleAcknowledged) ??
    readOptionalBoolean(candidate.user_visible_acknowledged) ??
    readOptionalBoolean(candidate.receiptAcknowledged) ??
    readOptionalBoolean(candidate.receipt_acknowledged)
  ) === true;
}

function candidateIsAcceptedButNotAcknowledged(candidate: UnknownRecord): boolean {
  if (candidateHasExplicitAcknowledgement(candidate)) return false;

  const accepted =
    readOptionalBoolean(candidate.accepted) ??
    readOptionalBoolean(candidate.providerAccepted) ??
    readOptionalBoolean(candidate.provider_accepted) ??
    readOptionalBoolean(candidate.sendAccepted) ??
    readOptionalBoolean(candidate.send_accepted) ??
    readOptionalBoolean(candidate.delivered);
  const status = readOptionalString(candidate.status);
  if (status) {
    if (status === "sent") return true;
    const nonAckStatuses = new Set([
      "accepted",
      "queued",
      "sent",
      "provider_sent",
      "provider_send_success",
      "provider_accepted_send",
      "message_sent",
      "send_ok",
      "delivery_sent",
      "send_success",
      "gateway_provider_send_success",
    ]);
    if (nonAckStatuses.has(status)) return true;
  }
  return accepted === true;
}

function receiptTargetMatches(candidate: UnknownRecord, target: OperatorNotificationTarget): boolean {
  const channel = readOptionalString(candidate.channel);
  if (channel && channel !== target.channel) {
    return false;
  }

  const to = readOptionalString(candidate.to) ?? readOptionalString(candidate.target) ?? readTargetId(candidate.chatId);
  if (to && !notificationTargetIdsMatch(to, target)) {
    return false;
  }

  const accountId = readOptionalString(candidate.accountId);
  if (accountId && target.accountId && accountId !== target.accountId) {
    return false;
  }

  const threadId = readOptionalString(candidate.threadId) ?? readOptionalNumber(candidate.threadId)?.toString();
  if (threadId && target.threadId !== undefined && threadId !== String(target.threadId)) {
    return false;
  }

  return true;
}

function readTargetId(value: unknown): string | undefined {
  return readOptionalString(value) ?? readOptionalNumber(value)?.toString();
}

function notificationTargetIdsMatch(candidateTo: string, target: OperatorNotificationTarget): boolean {
  if (candidateTo === target.to) return true;
  if (target.channel === "telegram") {
    return normalizeTelegramTargetId(candidateTo) === normalizeTelegramTargetId(target.to);
  }
  return false;
}

function normalizeTelegramTargetId(value: string): string {
  return value.replace(/^telegram:/i, "");
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter((item): item is UnknownRecord => Boolean(asRecord(item))) : [];
}
