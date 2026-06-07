import { createHash } from "node:crypto";

import type { A2ATerminalOutboxEvent } from "../standalone-broker-client.js";
import {
  buildA2AOperatorTerminalOutboxNotificationEnvelope,
} from "./operator-terminal-notifier.js";

type UnknownRecord = Record<string, unknown>;

export type A2ACrossBrokerTerminalProjection = {
  kind: "a2a.crossBroker.terminalProjection";
  version: 1;
  relayId: string;
  terminalOutboxId: string;
  childTaskId: string;
  parentRoundId: string;
  runId?: string;
  groupId?: string;
  /** Child/handoff broker that produced the Terminal Brief projection; kept for broker ingestion compatibility. */
  originBrokerId: string;
  /** Broker-of-record / initiating parent broker that should receive and render the projection. */
  brokerOfRecordId: string;
  /** Explicit parent/origin broker for the #634 four-case routing contract. */
  parentOriginBrokerId: string;
  /** Alias for the broker that owns parent notification rendering. */
  parentBrokerId: string;
  handoffBrokerId: string;
  originTaskId?: string;
  /** Worker that produced the handoff child, when distinct from the handoff broker. */
  childWorkerId?: string;
  status: string;
  worker?: string;
  evidence: {
    repo?: string;
    issue?: number;
    issueUrl?: string;
    prUrl?: string;
    doneUrl?: string;
    blockUrl?: string;
  };
  receipt: {
    providerGatewaySendSuccess: "not_ack_evidence";
    localReceiptState: "pending_receipt" | "receipt_confirmed" | "provider_only" | "failed";
    localReceiptEvidence?: string;
    originTerminalAckEligible: false;
    reason: string;
  };
  summary?: string;
  /** Handoff broker's rendered operator-facing Terminal Brief title. */
  terminalBriefTitle?: string;
  createdAt?: string;
  completedAt?: string;
  /** Total worker/task count expected for the parent round (denominator). */
  parentRoundTotal?: number;
  /** 1-based worker/task order within the parent round (title numerator). */
  parentRoundOrder?: number;
};

export type A2ACrossBrokerTerminalProjectionBuildOptions = {
  handoffBrokerId?: string;
  maxSummaryChars?: number;
};

const DEFAULT_MAX_SUMMARY_CHARS = 280;
const REDACTED = "[redacted]";
const URL_SECRET_RE = /([?&](?:token|secret|password|key|api_key)=)[^&\s]+/gi;
const BEARER_RE = /\b(?:bearer|token)\s+[a-z0-9._~+/=-]{12,}/gi;
const SECRET_ASSIGN_RE = /(\b(?:token|secret|password|api[_-]?key|authorization)=)\S+/gi;
const PRIVATE_PATH_RE = /\/(?:home|root|Users)\/[^\s),;]+/g;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;

export function buildA2ACrossBrokerTerminalProjection(
  event: A2ATerminalOutboxEvent,
  options: A2ACrossBrokerTerminalProjectionBuildOptions = {},
): A2ACrossBrokerTerminalProjection | undefined {
  const payload = asRecord(event.payload);
  if (!payload) return undefined;

  const metadata = readCrossBrokerHandoffMetadata(payload);
  if (!metadata) return undefined;
  if (!isParentOwnedTerminalPayload(payload, metadata.originBrokerId)) return undefined;

  const childTaskId = readString(payload.taskId);
  const status = readString(payload.status);
  if (!childTaskId || !status) return undefined;

  const handoffBrokerId = metadata.handoffBrokerId ?? options.handoffBrokerId ?? "unknown-handoff-broker";
  const createdAt = readString(event.createdAt) ?? readString(payload.createdAt);
  const completedAt = readString(payload.completedAt) ?? readString(payload.updatedAt);
  const runId = readString(payload.runId) ?? readString(payload.parentRunId) ?? metadata.runId;
  const groupId = readString(payload.groupId) ?? readString(payload.parentGroupId) ?? metadata.groupId;
  const relayId = createHash("sha256")
    .update(`cross-terminal:${metadata.originBrokerId}:${metadata.parentRoundId}:${runId ?? "no-run"}:${groupId ?? "no-group"}:${handoffBrokerId}:${event.id}`)
    .digest("hex")
    .slice(0, 32);
  const issue = typeof payload.issue === "number" && Number.isFinite(payload.issue) ? payload.issue : undefined;
  const repo = readSafeString(payload.repo);
  const issueUrl = readSafeUrl(payload.issueUrl) ?? (repo && issue !== undefined ? `https://github.com/${repo}/issues/${issue}` : undefined);
  const terminalBrief = asRecord(payload.terminalBrief);
  const parentRoundTotal = readPositiveInteger(payload.parentRoundTotal, terminalBrief?.parentRoundTotal, payload.roundTotal, terminalBrief?.roundTotal);
  const parentRoundOrder = readPositiveInteger(
    payload.parentRoundNum,
    payload.parentRoundOrder,
    terminalBrief?.parentRoundNum,
    terminalBrief?.parentRoundOrder,
    payload.parentRoundIndex,
    terminalBrief?.parentRoundIndex,
    payload.roundNum,
    payload.roundOrder,
    terminalBrief?.roundNum,
    terminalBrief?.roundOrder,
    payload.roundIndex,
    terminalBrief?.roundIndex,
  );
  const childWorkerId = firstSafeString(
    metadata.childWorkerId,
    payload.childWorkerId,
    terminalBrief?.childWorkerId,
    payload.workerId,
    terminalBrief?.workerId,
    payload.worker,
    terminalBrief?.worker,
  );
  const summary = firstSafeSummary(
    options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS,
    payload.testSummary,
    payload.summary,
    payload.message,
    payload.note,
    payload.originalMessage,
  );
  const renderedTerminalBriefTitle = buildRenderedTerminalBriefTitleProjection(event);

  return compactProjection({
    kind: "a2a.crossBroker.terminalProjection",
    version: 1,
    relayId,
    terminalOutboxId: event.id,
    childTaskId,
    parentRoundId: metadata.parentRoundId,
    ...(runId ? { runId } : {}),
    ...(groupId ? { groupId } : {}),
    originBrokerId: handoffBrokerId,
    brokerOfRecordId: metadata.originBrokerId,
    parentOriginBrokerId: metadata.originBrokerId,
    parentBrokerId: metadata.originBrokerId,
    handoffBrokerId,
    ...(metadata.originTaskId ? { originTaskId: metadata.originTaskId } : {}),
    ...(childWorkerId ? { childWorkerId } : {}),
    status,
    ...(readSafeString(payload.worker) ? { worker: readSafeString(payload.worker) } : {}),
    evidence: compactEvidence({
      ...(repo ? { repo } : {}),
      ...(issue !== undefined ? { issue } : {}),
      ...(issueUrl ? { issueUrl } : {}),
      ...(readSafeUrl(payload.prUrl) ? { prUrl: readSafeUrl(payload.prUrl) } : {}),
      ...(readSafeUrl(payload.doneUrl) ? { doneUrl: readSafeUrl(payload.doneUrl) } : {}),
      ...(readSafeUrl(payload.blockUrl) ? { blockUrl: readSafeUrl(payload.blockUrl) } : {}),
    }),
    receipt: buildReceiptProjection(event),
    ...(summary ? { summary } : {}),
    ...(renderedTerminalBriefTitle ? { terminalBriefTitle: renderedTerminalBriefTitle } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(parentRoundTotal !== undefined ? { parentRoundTotal } : {}),
    ...(parentRoundOrder !== undefined ? { parentRoundOrder } : {}),
  });
}

function buildRenderedTerminalBriefTitleProjection(event: A2ATerminalOutboxEvent): string | undefined {
  const envelope =
    buildA2AOperatorTerminalOutboxNotificationEnvelope(event as unknown as UnknownRecord) ??
    buildA2AOperatorTerminalOutboxNotificationEnvelope(buildProjectionRenderFallback(event));
  if (!envelope) return undefined;
  return readRenderedTerminalBriefTitle(envelope.terminalBriefTitle ?? envelope.title);
}

function buildProjectionRenderFallback(event: A2ATerminalOutboxEvent): UnknownRecord {
  const record = event as unknown as UnknownRecord;
  const payload = asRecord(record.payload);
  const payloadStatus = readString(payload?.status) ?? readString(record.status);
  const timestamp =
    readString(record.updatedAt) ??
    readString(record.createdAt) ??
    new Date(0).toISOString();
  return {
    ...record,
    ...(payload ? { payload: { ...payload, ...(payloadStatus ? { type: payloadStatus } : {}) } } : {}),
    receipt: asRecord(record.receipt) ?? { status: "accepted", updatedAt: timestamp },
    ackAudit: asRecord(record.ackAudit) ?? {
      decision: "pending",
      reason: "parent-broker current-session-visible projection render only",
      updatedAt: timestamp,
    },
  };
}

function readRenderedTerminalBriefTitle(value: unknown): string | undefined {
  const text = readString(value);
  if (!text) return undefined;
  const safe = redactText(text);
  return safe ? clampText(safe, 240) : undefined;
}

function readCrossBrokerHandoffMetadata(payload: UnknownRecord): {
  parentRoundId: string;
  originBrokerId: string;
  handoffBrokerId?: string;
  originTaskId?: string;
  childWorkerId?: string;
  runId?: string;
  groupId?: string;
} | undefined {
  const roots: UnknownRecord[] = [
    payload.crossBrokerHandoff,
    payload.crossBroker,
    payload.handoff,
    payload.metadata,
    asRecord(payload.metadata)?.crossBrokerHandoff,
    asRecord(payload.metadata)?.crossBroker,
    asRecord(payload.metadata)?.handoff,
    payload,
  ].flatMap((candidate) => {
    const record = asRecord(candidate);
    return record ? [record] : [];
  });

  for (const root of roots) {
    const parentRoundId = readString(root.parentRoundId) ?? readString(root.roundId) ?? readString(asRecord(root.parent)?.roundId);
    const originBrokerId = readString(root.originBrokerId) ?? readString(asRecord(root.originBroker)?.id) ?? readString(root.origin);
    if (!parentRoundId || !originBrokerId) continue;
    return {
      parentRoundId,
      originBrokerId,
      ...(readString(root.handoffBrokerId) ?? readString(root.localBrokerId) ?? readString(root.brokerId)
        ? { handoffBrokerId: readString(root.handoffBrokerId) ?? readString(root.localBrokerId) ?? readString(root.brokerId) }
        : {}),
      ...(readString(root.originTaskId) ?? readString(root.parentTaskId)
        ? { originTaskId: readString(root.originTaskId) ?? readString(root.parentTaskId) }
        : {}),
      ...(readString(root.childWorkerId) ?? readString(root.workerId)
        ? { childWorkerId: readString(root.childWorkerId) ?? readString(root.workerId) }
        : {}),
      ...(readString(root.runId) ?? readString(root.parentRunId)
        ? { runId: readString(root.runId) ?? readString(root.parentRunId) }
        : {}),
      ...(readString(root.groupId) ?? readString(root.parentGroupId)
        ? { groupId: readString(root.groupId) ?? readString(root.parentGroupId) }
        : {}),
    };
  }
  return undefined;
}

function isParentOwnedTerminalPayload(payload: UnknownRecord, parentBrokerId: string): boolean {
  const metadata = asRecord(payload.metadata);
  const notificationOwnership = asRecord(payload.notificationOwnership);
  const metadataNotificationOwnership = metadata ? asRecord(metadata.notificationOwnership) : undefined;
  const terminalBrief = asRecord(payload.terminalBrief);
  const metadataTerminalBrief = metadata ? asRecord(metadata.terminalBrief) : undefined;
  const roots = [payload, metadata, notificationOwnership, metadataNotificationOwnership, terminalBrief, metadataTerminalBrief]
    .flatMap((candidate) => candidate ? [candidate] : []);

  return roots.some((record) => {
    const scope = readString(record.scope) ?? readString(record.notificationScope);
    if (scope === "parent-broker-only" || scope === "parent_broker_only") return true;
    const owner = readString(record.owner) ??
      readString(record.operatorFacingOwner) ??
      readString(record.terminalBriefOwner) ??
      readString(record.notificationOwner);
    if (
      owner === "parent" ||
      owner === "origin" ||
      owner === "parent-owned" ||
      owner === "parent_owned" ||
      sameToken(owner, parentBrokerId)
    ) {
      return true;
    }
    if ((owner === "broker-of-record" || owner === "broker_of_record") && sameToken(readString(record.brokerOfRecordId), parentBrokerId)) {
      return true;
    }
    if (
      record.parentOwned === true ||
      record.parentOwnedTerminalBrief === true ||
      record.parentOwnedNotification === true ||
      record.operatorFacingParentOwned === true
    ) {
      return true;
    }
    return sameToken(readString(record.ownerBrokerId), parentBrokerId) ||
      sameToken(readString(record.parentBrokerId), parentBrokerId) ||
      sameToken(readString(record.parentOriginBrokerId), parentBrokerId) ||
      sameToken(readString(record.parentOwnerBrokerId), parentBrokerId);
  });
}

function buildReceiptProjection(event: A2ATerminalOutboxEvent): A2ACrossBrokerTerminalProjection["receipt"] {
  const ack = asRecord(event.ack);
  const evidence = readString(ack?.evidence);
  const ackStatus = readString(ack?.status);
  const providerOnly = evidence === "provider_delivery_receipt";
  const visibleEvidence =
    evidence === "current_session_visible" || evidence === "operator_visible" || evidence === "operator_confirmed";
  const localReceiptState = providerOnly
    ? "provider_only"
    : ackStatus === "receipt_confirmed" && visibleEvidence
      ? "receipt_confirmed"
      : ackStatus === "failed"
        ? "failed"
        : "pending_receipt";
  return {
    providerGatewaySendSuccess: "not_ack_evidence",
    localReceiptState,
    ...(evidence ? { localReceiptEvidence: evidence } : {}),
    originTerminalAckEligible: false,
    reason: "cross-broker projection is bounded terminal evidence only; provider send success is never operator-visible ACK evidence",
  };
}

function firstSafeSummary(maxChars: number, ...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = readSafeString(value);
    if (text) return clampText(text, Math.max(80, maxChars));
  }
  return undefined;
}

function firstSafeString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = readSafeString(value);
    if (text) return text;
  }
  return undefined;
}

function readSafeString(value: unknown): string | undefined {
  const text = readString(value);
  return text ? redactText(text) : undefined;
}

function readSafeUrl(value: unknown): string | undefined {
  const text = readSafeString(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return clampText(url.toString().replace(URL_SECRET_RE, `$1${REDACTED}`), 240);
  } catch {
    return undefined;
  }
}

function redactText(value: string): string {
  return value
    .replace(CODE_BLOCK_RE, REDACTED)
    .replace(URL_SECRET_RE, `$1${REDACTED}`)
    .replace(BEARER_RE, REDACTED)
    .replace(SECRET_ASSIGN_RE, `$1${REDACTED}`)
    .replace(PRIVATE_PATH_RE, REDACTED)
    .trim();
}

function clampText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function compactEvidence(evidence: A2ACrossBrokerTerminalProjection["evidence"]): A2ACrossBrokerTerminalProjection["evidence"] {
  return Object.fromEntries(Object.entries(evidence).filter(([, value]) => value !== undefined)) as A2ACrossBrokerTerminalProjection["evidence"];
}

function compactProjection(projection: A2ACrossBrokerTerminalProjection): A2ACrossBrokerTerminalProjection {
  return projection;
}

/** Provider delivery state for cross-broker terminal outbox records. */
export type A2ACrossBrokerProviderDeliveryState =
  | "accepted"
  | "sent"
  | "provider_delivered"
  | "unknown";

/** Operator-visible receipt state for cross-broker terminal projections. */
export type A2ACrossBrokerOperatorReceiptState =
  | "pending_receipt"
  | "provider_only"
  | "receipt_confirmed"
  | "failed"
  | "none";

/**
 * Receipt-gap projection for a cross-broker terminal outbox event.
 *
 * Explicitly separates provider delivery/send state from operator-visible
 * receipt state. Cross-broker projections are bounded terminal evidence only;
 * provider send success is never operator-visible ACK evidence.
 */
export type A2ACrossBrokerTerminalReceiptGap = {
  taskId?: string;
  /** Provider/transport delivery state — never ACK evidence by itself. */
  providerDelivery: A2ACrossBrokerProviderDeliveryState;
  /** Operator-visible receipt state. */
  operatorReceipt: A2ACrossBrokerOperatorReceiptState;
  /** Cross-broker projections are bounded terminal evidence; never ACK-eligible at origin. */
  terminalAckEligible: false;
  /** Why the gap is in its current state. */
  reason: string;
};

/**
 * Project the receipt gap for a cross-broker terminal outbox event.
 *
 * Provider delivery state and operator-visible receipt are always kept in
 * separate fields. This is a pure projection — no live send, no ACK, no restart.
 */
export function getCrossBrokerTerminalReceiptGap(
  event: A2ATerminalOutboxEvent,
): A2ACrossBrokerTerminalReceiptGap {
  const payload = asRecord(event.payload);
  const taskId = payload ? readString(payload.taskId) : undefined;

  const ack = asRecord(event.ack);
  const receipt = asRecord(event.receipt);

  const receiptStatus = readString(receipt?.status)?.toLowerCase();
  const ackStatus = readString(ack?.status)?.toLowerCase();
  const ackEvidence = readString(ack?.evidence);

  const providerDelivery: A2ACrossBrokerProviderDeliveryState =
    receiptStatus === "sent" || ackStatus === "sent"
      ? "sent"
      : receiptStatus === "delivered" || ackStatus === "delivered" || receiptStatus === "provider_delivered"
        ? "provider_delivered"
        : receiptStatus === "accepted" || ackStatus === "accepted"
          ? "accepted"
          : "unknown";

  const providerOnly = ackEvidence === "provider_delivery_receipt";
  const visibleEvidence =
    ackEvidence === "current_session_visible" || ackEvidence === "operator_visible" || ackEvidence === "operator_confirmed";

  const operatorReceipt: A2ACrossBrokerOperatorReceiptState = providerOnly
    ? "provider_only"
    : ackStatus === "receipt_confirmed" && visibleEvidence
      ? "receipt_confirmed"
      : ackStatus === "failed"
        ? "failed"
        : visibleEvidence
          ? "pending_receipt"
          : "none";

  const reason = buildCrossBrokerTerminalReceiptGapReason(
    providerDelivery,
    operatorReceipt,
    ackEvidence,
  );

  return {
    ...(taskId ? { taskId } : {}),
    providerDelivery,
    operatorReceipt,
    terminalAckEligible: false,
    reason,
  };
}

function buildCrossBrokerTerminalReceiptGapReason(
  providerDelivery: A2ACrossBrokerProviderDeliveryState,
  operatorReceipt: A2ACrossBrokerOperatorReceiptState,
  ackEvidence?: string,
): string {
  if (operatorReceipt === "provider_only") {
    return `provider delivery is ${providerDelivery} but only legacy provider_delivery_receipt evidence exists — provider evidence is not Terminal Brief visibility proof`;
  }
  if (operatorReceipt === "none") {
    return `provider delivery is ${providerDelivery} but no operator-visible receipt evidence exists; cross-broker projections are bounded terminal evidence only`;
  }
  if (operatorReceipt === "pending_receipt") {
    return `operator-visible receipt evidence ${ackEvidence ?? "present"} is set but receipt not yet confirmed`;
  }
  if (operatorReceipt === "receipt_confirmed") {
    return `visibility receipt confirmed (${ackEvidence}) but cross-broker projection is never origin ACK eligible`;
  }
  return `provider delivery is ${providerDelivery}; operator receipt is ${operatorReceipt}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sameToken(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function readPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}
