// Trusted Conversation Plane — C2 slice 1: the a2a.conversation-envelope.v1
// core domain (spec: docs/specs/trusted-conversation-plane/spec.md, frozen as
// #1861; parent epic #1814; child track #1862).
//
// This slice implements the broker-side conversation core as pure free
// functions with context interfaces, following the broker-exchange.ts
// convention. It contains NO HTTP/JSON-RPC surface and NO worker-loop wiring —
// those arrive with the inbox/reply loop slice. Nothing here changes existing
// behavior; the module is additive and currently exercised only by tests.
//
// What this slice owns (spec §field rules, §state machine, §ownership,
// §idempotency, §budgets):
// - envelope validation with normative field rules (T3: sequence is
//   home-broker-assigned; client value advisory only)
// - participant-only read/write authorization (T6)
// - (homeBrokerId-derived) idempotency convergence/conflict (T2)
// - budget gates: maxTurns live at reply time (T5), message/conversation
//   bytes (T10), fanout bound, TTL expiry
// - redaction gate before persistence (T4) and digest-first audit notes (T11)
// - forward-only delivery state machine with `processed` requiring linked
//   evidence (polling exposure is `delivered`, never `processed`)
// - broker receipt/countersign shape binding messageId/sequence/contentDigest
//   (T1 groundwork; JWS signing arrives with the wire slice)

import { createHash, randomUUID } from "node:crypto";
import { BrokerError } from "./broker-error.js";

export const A2A_CONVERSATION_ENVELOPE_SCHEMA_VERSION = "a2a.conversation-envelope.v1";
export const A2A_CONVERSATION_RECEIPT_SCHEMA_VERSION = "a2a.conversation-receipt.v1";

export const A2A_CONVERSATION_MESSAGE_KINDS = [
  "question",
  "reply",
  "clarification",
  "challenge",
  "proposal",
  "decision",
  "ack",
  "control",
] as const;
export type A2AConversationMessageKind = (typeof A2A_CONVERSATION_MESSAGE_KINDS)[number];

export const A2A_CONVERSATION_ACTOR_KINDS = ["worker", "broker", "operator"] as const;
export type A2AConversationActorKind = (typeof A2A_CONVERSATION_ACTOR_KINDS)[number];

export const A2A_CONVERSATION_RECIPIENT_KINDS = ["worker", "broker"] as const;
export type A2AConversationRecipientKind = (typeof A2A_CONVERSATION_RECIPIENT_KINDS)[number];

export const A2A_CONVERSATION_DELIVERY_STATES = [
  "accepted",
  "persisted",
  "delivered",
  "processed",
  "expired",
  "refused",
  "failed",
] as const;
export type A2AConversationDeliveryState = (typeof A2A_CONVERSATION_DELIVERY_STATES)[number];

const TERMINAL_DELIVERY_STATES: ReadonlySet<A2AConversationDeliveryState> = new Set([
  "expired",
  "refused",
  "failed",
] as const);

// Forward-only progression for the non-terminal states (spec §state machine).
const DELIVERY_TRANSITIONS: Record<string, ReadonlySet<A2AConversationDeliveryState>> = {
  accepted: new Set(["persisted", "expired", "refused", "failed"] as const),
  persisted: new Set(["delivered", "expired", "failed"] as const),
  delivered: new Set(["processed", "expired", "failed"] as const),
  processed: new Set([]),
  expired: new Set([]),
  refused: new Set([]),
  failed: new Set([]),
};

// Budget bounds (spec §budgets; aligned with the existing exchange default).
export const DEFAULT_CONVERSATION_MAX_TURNS = 8;
export const MAX_CONVERSATION_MESSAGE_BYTES = 64 * 1024;
export const MAX_CONVERSATION_TOTAL_BYTES = 1024 * 1024;
export const MAX_CONVERSATION_RECIPIENTS = 8;
export const MAX_CONVERSATION_REFERENCE_TASKS = 8;
export const MAX_CONVERSATION_HOP_TRACE_ENTRIES = 16;
export const MAX_CONVERSATION_ID_BYTES = 128;
export const MAX_CONVERSATION_TEXT_PREVIEW_BYTES = 256;

export interface A2AConversationActorRef {
  kind: A2AConversationActorKind;
  id: string;
  homeBrokerId: string;
}

export interface A2AConversationRecipientRef {
  kind: A2AConversationRecipientKind;
  id: string;
  homeBrokerId: string;
}

/** Client submit shape. `sequence` is advisory only (T3) and never used for ordering. */
export interface A2AConversationEnvelopeInput {
  schemaVersion?: string;
  messageId: string;
  parentMessageId?: string;
  sequence?: number;
  kind: A2AConversationMessageKind;
  sender: A2AConversationActorRef;
  recipients: A2AConversationRecipientRef[];
  taskId?: string;
  referenceTaskIds?: string[];
  idempotencyKey: string;
  createdAt?: string;
  expiresAt?: string;
  content: { text: string };
  clientContentDigest?: string;
  hopTrace?: Array<{ brokerId: string; at?: string; action?: string }>;
}

export interface A2AConversationMessageRecord {
  schemaVersion: typeof A2A_CONVERSATION_ENVELOPE_SCHEMA_VERSION;
  conversationId: string;
  messageId: string;
  parentMessageId?: string;
  /** Assigned by the home broker at accept time; monotonic, gap-free. */
  sequence: number;
  /** The client-supplied advisory sequence, kept for diagnostics only. */
  advisoryClientSequence?: number;
  kind: A2AConversationMessageKind;
  sender: A2AConversationActorRef;
  recipients: A2AConversationRecipientRef[];
  taskId?: string;
  referenceTaskIds: string[];
  idempotencyKey: string;
  createdAt: string;
  expiresAt?: string;
  content: { text: string };
  contentDigest: string;
  redacted: boolean;
  hopTrace: Array<{ brokerId: string; at?: string; action?: string }>;
  deliveryState: A2AConversationDeliveryState;
  stateLog: Array<{ state: A2AConversationDeliveryState; at: string }>;
  /** Evidence linking a `processed` transition (reply id / task id / ack). */
  processedEvidence?: { kind: "reply" | "task-result" | "ack"; ref: string };
  updatedAt: string;
}

export interface A2AConversationIdempotencyRecord {
  messageId: string;
  contentDigest: string;
  outcome: "converged-record" | A2AConversationDeliveryState;
}

export interface A2AConversationState {
  schemaVersion: "a2a.conversation-state.v1";
  conversationId: string;
  homeBrokerId: string;
  status: "open" | "closed";
  closureReason?: "max_turns" | "expired" | "operator" | "failed";
  maxTurns: number;
  turnCount: number;
  totalContentBytes: number;
  lastAssignedSequence: number;
  rootMessageId: string;
  latestMessageId: string;
  /** Participant actor keys (`kind:id:homeBrokerId`) allowed to read/write. */
  participants: string[];
  messagesById: Record<string, A2AConversationMessageRecord>;
  idempotencyByKey: Record<string, A2AConversationIdempotencyRecord>;
  createdAt: string;
  updatedAt: string;
}

export interface OpenBrokerConversationContext {
  now(): string;
  appendAuditEvent(input: { actorId: string; action: string; targetType: string; targetId: string; note?: string }): void;
  setConversationRecord(conversation: A2AConversationState): void;
  persistState(): void;
}

export interface AcceptBrokerConversationMessageContext extends OpenBrokerConversationContext {
  requireConversationMessage(conversationId: string, messageId: string): A2AConversationMessageRecord;
}

// ---------------------------------------------------------------------------
// Validation (spec §field rules)
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BrokerError("bad_request", `conversation envelope field ${field} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new BrokerError("bad_request", `conversation envelope field ${field} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function parseIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new BrokerError("bad_request", `conversation envelope field ${field} must be an ISO-8601 timestamp`);
  }
  return value;
}

function validateActorRef(value: unknown, field: string, kinds: readonly string[]): { kind: string; id: string; homeBrokerId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("bad_request", `conversation envelope field ${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const kind = requireNonEmptyString(record.kind, `${field}.kind`, 32);
  if (!kinds.includes(kind)) {
    throw new BrokerError("bad_request", `conversation envelope field ${field}.kind must be one of ${kinds.join("|")}`);
  }
  return {
    kind,
    id: requireNonEmptyString(record.id, `${field}.id`, MAX_CONVERSATION_ID_BYTES),
    homeBrokerId: requireNonEmptyString(record.homeBrokerId, `${field}.homeBrokerId`, MAX_CONVERSATION_ID_BYTES),
  };
}

export function validateConversationEnvelopeInput(input: unknown): A2AConversationEnvelopeInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BrokerError("bad_request", "conversation envelope must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== undefined && record.schemaVersion !== A2A_CONVERSATION_ENVELOPE_SCHEMA_VERSION) {
    throw new BrokerError("bad_request", `conversation envelope schemaVersion must be ${A2A_CONVERSATION_ENVELOPE_SCHEMA_VERSION}`);
  }
  const kind = requireNonEmptyString(record.kind, "kind", 32);
  if (!(A2A_CONVERSATION_MESSAGE_KINDS as readonly string[]).includes(kind)) {
    throw new BrokerError("bad_request", `conversation envelope kind must be one of ${A2A_CONVERSATION_MESSAGE_KINDS.join("|")}`);
  }
  const sender = validateActorRef(record.sender, "sender", A2A_CONVERSATION_ACTOR_KINDS);
  if (!Array.isArray(record.recipients) || record.recipients.length === 0) {
    throw new BrokerError("bad_request", "conversation envelope recipients must be a non-empty array");
  }
  if (record.recipients.length > MAX_CONVERSATION_RECIPIENTS) {
    throw new BrokerError("bad_request", `conversation envelope recipients exceed the fanout bound of ${MAX_CONVERSATION_RECIPIENTS}`);
  }
  const recipients = record.recipients.map((entry, index) =>
    validateActorRef(entry, `recipients[${index}]`, A2A_CONVERSATION_RECIPIENT_KINDS),
  );
  const content = record.content as Record<string, unknown> | undefined;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new BrokerError("bad_request", "conversation envelope content must be an object");
  }
  if (typeof content.text !== "string" || content.text.length === 0) {
    throw new BrokerError("bad_request", "conversation envelope content.text must be a non-empty string");
  }
  if (Buffer.byteLength(content.text, "utf8") > MAX_CONVERSATION_MESSAGE_BYTES) {
    throw new BrokerError("bad_request", `conversation envelope content.text exceeds ${MAX_CONVERSATION_MESSAGE_BYTES} bytes`);
  }
  const referenceTaskIds = record.referenceTaskIds === undefined ? [] : record.referenceTaskIds;
  if (!Array.isArray(referenceTaskIds) || referenceTaskIds.length > MAX_CONVERSATION_REFERENCE_TASKS) {
    throw new BrokerError("bad_request", `conversation envelope referenceTaskIds must be an array of at most ${MAX_CONVERSATION_REFERENCE_TASKS}`);
  }
  for (const [index, entry] of referenceTaskIds.entries()) {
    requireNonEmptyString(entry, `referenceTaskIds[${index}]`, MAX_CONVERSATION_ID_BYTES);
  }
  const hopTrace = record.hopTrace === undefined ? [] : record.hopTrace;
  if (!Array.isArray(hopTrace) || hopTrace.length > MAX_CONVERSATION_HOP_TRACE_ENTRIES) {
    throw new BrokerError("bad_request", `conversation envelope hopTrace must be an array of at most ${MAX_CONVERSATION_HOP_TRACE_ENTRIES}`);
  }
  for (const [index, entry] of hopTrace.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new BrokerError("bad_request", `conversation envelope hopTrace[${index}] must be an object`);
    }
    requireNonEmptyString((entry as Record<string, unknown>).brokerId, `hopTrace[${index}].brokerId`, MAX_CONVERSATION_ID_BYTES);
  }
  const createdAt = record.createdAt === undefined ? undefined : parseIsoTimestamp(record.createdAt, "createdAt");
  const expiresAt = record.expiresAt === undefined ? undefined : parseIsoTimestamp(record.expiresAt, "expiresAt");
  if (createdAt && expiresAt && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new BrokerError("bad_request", "conversation envelope expiresAt must be after createdAt");
  }
  if (record.clientContentDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(String(record.clientContentDigest))) {
    throw new BrokerError("bad_request", "conversation envelope clientContentDigest must be sha256:<64 lowercase hex>");
  }
  return {
    ...(record.schemaVersion !== undefined ? { schemaVersion: String(record.schemaVersion) } : {}),
    messageId: requireNonEmptyString(record.messageId, "messageId", MAX_CONVERSATION_ID_BYTES),
    ...(record.parentMessageId !== undefined ? { parentMessageId: requireNonEmptyString(record.parentMessageId, "parentMessageId", MAX_CONVERSATION_ID_BYTES) } : {}),
    ...(typeof record.sequence === "number" && Number.isSafeInteger(record.sequence) ? { sequence: record.sequence } : {}),
    kind: kind as A2AConversationMessageKind,
    sender: sender as A2AConversationEnvelopeInput["sender"],
    recipients: recipients as A2AConversationEnvelopeInput["recipients"],
    ...(record.taskId !== undefined ? { taskId: requireNonEmptyString(record.taskId, "taskId", MAX_CONVERSATION_ID_BYTES) } : {}),
    referenceTaskIds: referenceTaskIds as string[],
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey", MAX_CONVERSATION_ID_BYTES),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    content: { text: content.text as string },
    ...(record.clientContentDigest !== undefined ? { clientContentDigest: String(record.clientContentDigest) } : {}),
    hopTrace: hopTrace as A2AConversationEnvelopeInput["hopTrace"],
  };
}

// ---------------------------------------------------------------------------
// Redaction gate (T4/T11): applied before persistence; the broker digest is
// computed over the canonical REDACTED content so audit digests stay stable.
// ---------------------------------------------------------------------------

export function redactConversationContentText(text: string): { text: string; redacted: boolean } {
  const redacted = text
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "<redacted-github-token>")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "<redacted-github-token>")
    .replace(/sk-[A-Za-z0-9_-]{32,}/g, "<redacted-api-key>")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1<redacted>");
  return { text: redacted, redacted: redacted !== text };
}

/** Canonical content serialization for digests (sorted keys, stable JSON). */
export function canonicalConversationContentJson(text: string): string {
  return JSON.stringify({ text });
}

export function conversationContentDigest(text: string): string {
  return `sha256:${createHash("sha256").update(canonicalConversationContentJson(text), "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Ownership (spec §ownership; T6)
// ---------------------------------------------------------------------------

export function conversationActorKey(actor: { kind: string; id: string; homeBrokerId: string }): string {
  return `${actor.kind}:${actor.id}:${actor.homeBrokerId}`;
}

export function assertConversationParticipant(
  conversation: A2AConversationState,
  actor: { kind: string; id: string; homeBrokerId: string },
  mode: "read" | "write",
): void {
  if (actor.kind === "operator") return;
  if (actor.kind === "broker" && actor.id === conversation.homeBrokerId) return;
  if (conversation.participants.includes(conversationActorKey(actor))) return;
  throw new BrokerError(
    "policy_denied",
    `conversation ${mode} requires an existing participant, the home broker, or an operator (conversation ${conversation.conversationId})`,
  );
}

// ---------------------------------------------------------------------------
// Conversation open + message accept (home-broker sequence authority)
// ---------------------------------------------------------------------------

function appendStateLog(record: A2AConversationMessageRecord, state: A2AConversationDeliveryState, now: string): void {
  record.deliveryState = state;
  record.stateLog.push({ state, at: now });
  record.updatedAt = now;
}

export function openBrokerConversation(
  request: {
    homeBrokerId: string;
    maxTurns?: number;
    envelope: unknown;
  },
  context: OpenBrokerConversationContext,
): { conversation: A2AConversationState; message: A2AConversationMessageRecord } {
  const homeBrokerId = requireNonEmptyString(request.homeBrokerId, "homeBrokerId", MAX_CONVERSATION_ID_BYTES);
  if (request.envelope && (request.envelope as Record<string, unknown>).conversationId !== undefined) {
    // The conversation id is minted exactly once by the home broker (spec).
    throw new BrokerError("bad_request", "conversationId is minted by the home broker and must not be supplied when opening a conversation");
  }
  const envelope = validateConversationEnvelopeInput(request.envelope);
  if (envelope.sender.kind === "worker" && envelope.sender.homeBrokerId !== homeBrokerId) {
    throw new BrokerError("policy_denied", "worker senders must be homed at the conversation's home broker on open");
  }
  const maxTurns = request.maxTurns ?? DEFAULT_CONVERSATION_MAX_TURNS;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new BrokerError("bad_request", "conversation maxTurns must be a positive integer");
  }
  const now = context.now();
  const conversationId = `conv-${randomUUID()}`;
  const redacted = redactConversationContentText(envelope.content.text);
  const digest = conversationContentDigest(redacted.text);
  if (envelope.clientContentDigest && envelope.clientContentDigest !== digest) {
    throw new BrokerError("bad_request", "client content digest does not match the redacted content digest computed by the broker");
  }
  const message: A2AConversationMessageRecord = {
    schemaVersion: A2A_CONVERSATION_ENVELOPE_SCHEMA_VERSION,
    conversationId,
    messageId: envelope.messageId,
    ...(envelope.parentMessageId !== undefined ? { parentMessageId: envelope.parentMessageId } : {}),
    sequence: 1,
    ...(envelope.sequence !== undefined ? { advisoryClientSequence: envelope.sequence } : {}),
    kind: envelope.kind,
    sender: envelope.sender,
    recipients: envelope.recipients,
    ...(envelope.taskId !== undefined ? { taskId: envelope.taskId } : {}),
    referenceTaskIds: envelope.referenceTaskIds ?? [],
    idempotencyKey: envelope.idempotencyKey,
    createdAt: envelope.createdAt ?? now,
    ...(envelope.expiresAt !== undefined ? { expiresAt: envelope.expiresAt } : {}),
    content: { text: redacted.text },
    contentDigest: digest,
    redacted: redacted.redacted,
    hopTrace: envelope.hopTrace ?? [],
    deliveryState: "accepted",
    stateLog: [],
    updatedAt: now,
  };
  appendStateLog(message, "persisted", now);
  const conversation: A2AConversationState = {
    schemaVersion: "a2a.conversation-state.v1",
    conversationId,
    homeBrokerId,
    status: "open",
    maxTurns,
    turnCount: 1,
    totalContentBytes: Buffer.byteLength(redacted.text, "utf8"),
    lastAssignedSequence: 1,
    rootMessageId: message.messageId,
    latestMessageId: message.messageId,
    participants: [
      conversationActorKey(envelope.sender),
      ...envelope.recipients.map((recipient) => conversationActorKey(recipient)),
    ],
    messagesById: { [message.messageId]: message },
    idempotencyByKey: { [envelope.idempotencyKey]: { messageId: message.messageId, contentDigest: digest, outcome: "persisted" } },
    createdAt: now,
    updatedAt: now,
  };
  context.setConversationRecord(conversation);
  context.appendAuditEvent({
    actorId: envelope.sender.id,
    action: "conversation.opened",
    targetType: "conversation",
    targetId: conversationId,
    note: `seq=1 digest=${digest}`, // digest-first: no message body in audit (T11)
  });
  context.persistState();
  return { conversation, message };
}

export type AcceptBrokerConversationMessageResult =
  | { outcome: "accepted"; conversation: A2AConversationState; message: A2AConversationMessageRecord }
  | { outcome: "converged"; conversation: A2AConversationState; message: A2AConversationMessageRecord };

export function acceptBrokerConversationMessage(
  conversation: A2AConversationState,
  request: { envelope: unknown },
  context: AcceptBrokerConversationMessageContext,
): AcceptBrokerConversationMessageResult {
  const envelope = validateConversationEnvelopeInput(request.envelope);
  assertConversationParticipant(conversation, envelope.sender, "write");
  const isControl = envelope.kind === "control";
  const controlSenderPrivileged =
    envelope.sender.kind === "operator"
    || (envelope.sender.kind === "broker" && envelope.sender.id === conversation.homeBrokerId);
  // Unprivileged control senders get the control-specific refusal first, so
  // the close-out channel's own authorization stays distinguishable.
  if (isControl && !controlSenderPrivileged) {
    throw new BrokerError("policy_denied", "control messages may only be sent by the home broker or an operator");
  }
  // `control` is the close-out channel (spec §budgets): an operator or the
  // home broker may still send control messages after the conversation closed
  // (e.g. the maxTurns close-out itself). Everything else fails closed.
  if (conversation.status !== "open" && !(isControl && controlSenderPrivileged)) {
    throw new BrokerError("policy_denied", `conversation ${conversation.conversationId} is closed (${conversation.closureReason ?? "unknown"})`);
  }
  const now = context.now();

  // Idempotency (T2): same key + same digest converges; different digest conflicts.
  const existing = conversation.idempotencyByKey[envelope.idempotencyKey];
  if (existing) {
    const redactedText = redactConversationContentText(envelope.content.text).text;
    const digest = conversationContentDigest(redactedText);
    if (existing.contentDigest !== digest) {
      throw new BrokerError(
        "idempotency_conflict",
        `idempotency key ${envelope.idempotencyKey} was already recorded with a different content digest`,
      );
    }
    const recorded = conversation.messagesById[existing.messageId];
    if (!recorded) {
      throw new BrokerError("idempotency_conflict", `idempotency key ${envelope.idempotencyKey} records message ${existing.messageId} which is missing`);
    }
    return { outcome: "converged", conversation, message: recorded };
  }

  // TTL: an envelope already past its expiry is refused and the refusal is
  // recorded so the key cannot be laundered with different content later.
  if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= Date.parse(now)) {
    const digest = conversationContentDigest(redactConversationContentText(envelope.content.text).text);
    conversation.idempotencyByKey[envelope.idempotencyKey] = { messageId: envelope.messageId, contentDigest: digest, outcome: "refused" };
    conversation.updatedAt = now;
    context.setConversationRecord(conversation);
    context.persistState();
    throw new BrokerError("policy_denied", "conversation envelope expiresAt is already in the past");
  }

  if (envelope.parentMessageId !== undefined) {
    context.requireConversationMessage(conversation.conversationId, envelope.parentMessageId);
  }

  const redacted = redactConversationContentText(envelope.content.text);
  const digest = conversationContentDigest(redacted.text);
  if (envelope.clientContentDigest && envelope.clientContentDigest !== digest) {
    throw new BrokerError("bad_request", "client content digest does not match the redacted content digest computed by the broker");
  }

  // Conversation byte budget (T10).
  const messageBytes = Buffer.byteLength(redacted.text, "utf8");
  if (conversation.totalContentBytes + messageBytes > MAX_CONVERSATION_TOTAL_BYTES) {
    throw new BrokerError("policy_denied", `conversation total content bytes would exceed ${MAX_CONVERSATION_TOTAL_BYTES}`);
  }

  // Turn budget (T5): every non-control message consumes a turn; `control`
  // close-out traffic is the exempt channel (home broker / operator only).
  if (!isControl && conversation.turnCount + 1 > conversation.maxTurns) {
    conversation.status = "closed";
    conversation.closureReason = "max_turns";
    conversation.updatedAt = now;
    context.setConversationRecord(conversation);
    context.persistState();
    throw new BrokerError("policy_denied", `conversation ${conversation.conversationId} exhausted its maxTurns budget of ${conversation.maxTurns}`);
  }

  // Sequence authority (T3): assigned here, gap-free, client value advisory.
  const sequence = conversation.lastAssignedSequence + 1;
  const message: A2AConversationMessageRecord = {
    schemaVersion: A2A_CONVERSATION_ENVELOPE_SCHEMA_VERSION,
    conversationId: conversation.conversationId,
    messageId: envelope.messageId,
    ...(envelope.parentMessageId !== undefined ? { parentMessageId: envelope.parentMessageId } : {}),
    sequence,
    ...(envelope.sequence !== undefined ? { advisoryClientSequence: envelope.sequence } : {}),
    kind: envelope.kind,
    sender: envelope.sender,
    recipients: envelope.recipients,
    ...(envelope.taskId !== undefined ? { taskId: envelope.taskId } : {}),
    referenceTaskIds: envelope.referenceTaskIds ?? [],
    idempotencyKey: envelope.idempotencyKey,
    createdAt: envelope.createdAt ?? now,
    ...(envelope.expiresAt !== undefined ? { expiresAt: envelope.expiresAt } : {}),
    content: { text: redacted.text },
    contentDigest: digest,
    redacted: redacted.redacted,
    hopTrace: envelope.hopTrace ?? [],
    deliveryState: "accepted",
    stateLog: [],
    updatedAt: now,
  };
  appendStateLog(message, "persisted", now);

  conversation.messagesById[message.messageId] = message;
  conversation.idempotencyByKey[envelope.idempotencyKey] = {
    messageId: message.messageId,
    contentDigest: digest,
    outcome: "persisted",
  };
  conversation.lastAssignedSequence = sequence;
  conversation.latestMessageId = message.messageId;
  if (!isControl) conversation.turnCount += 1;
  conversation.totalContentBytes += messageBytes;
  for (const actor of [envelope.sender as { kind: string; id: string; homeBrokerId: string }, ...envelope.recipients]) {
    const key = conversationActorKey(actor);
    if (!conversation.participants.includes(key)) conversation.participants.push(key);
  }
  conversation.updatedAt = now;
  context.setConversationRecord(conversation);
  context.appendAuditEvent({
    actorId: envelope.sender.id,
    action: "conversation.message.accepted",
    targetType: "conversation-message",
    targetId: message.messageId,
    note: `seq=${sequence} digest=${digest}`, // digest-first (T11)
  });
  context.persistState();
  return { outcome: "accepted", conversation, message };
}

// ---------------------------------------------------------------------------
// Delivery state machine (spec §state machine)
// ---------------------------------------------------------------------------

export function advanceConversationDelivery(
  conversation: A2AConversationState,
  messageId: string,
  to: A2AConversationDeliveryState,
  options: { now: string; processedEvidence?: { kind: "reply" | "task-result" | "ack"; ref: string } },
): A2AConversationMessageRecord {
  const message = conversation.messagesById[messageId];
  if (!message) {
    throw new BrokerError("not_found", `conversation message ${messageId} not found in ${conversation.conversationId}`);
  }
  const allowed = DELIVERY_TRANSITIONS[message.deliveryState];
  if (!allowed || !allowed.has(to)) {
    throw new BrokerError("policy_denied", `conversation message ${messageId} cannot transition ${message.deliveryState} -> ${to}`);
  }
  if (to === "processed") {
    // `processed` requires linked evidence — polling exposure is `delivered`
    // and provider-send success is never `processed` (spec).
    if (!options.processedEvidence || !options.processedEvidence.ref) {
      throw new BrokerError("bad_request", "transition to processed requires processedEvidence (reply/task-result/ack reference)");
    }
    message.processedEvidence = options.processedEvidence;
  }
  if (to === "expired" && message.expiresAt && Date.parse(message.expiresAt) > Date.parse(options.now)) {
    throw new BrokerError("policy_denied", "conversation message expiresAt has not passed");
  }
  appendStateLog(message, to, options.now);
  conversation.updatedAt = options.now;
  return message;
}

/** Lazily expire messages whose TTL passed before reaching `processed`. */
export function expireStaleConversationMessages(
  conversation: A2AConversationState,
  now: string,
): A2AConversationMessageRecord[] {
  const expired: A2AConversationMessageRecord[] = [];
  for (const message of Object.values(conversation.messagesById)) {
    if (TERMINAL_DELIVERY_STATES.has(message.deliveryState)) continue;
    if (!message.expiresAt || Date.parse(message.expiresAt) > Date.parse(now)) continue;
    message.deliveryState = "expired";
    message.stateLog.push({ state: "expired", at: now });
    message.updatedAt = now;
    conversation.idempotencyByKey[message.idempotencyKey] = {
      messageId: message.messageId,
      contentDigest: message.contentDigest,
      outcome: "expired",
    };
    expired.push(message);
  }
  if (expired.length > 0) conversation.updatedAt = now;
  return expired;
}

// ---------------------------------------------------------------------------
// Broker receipt / countersign shape (T1 groundwork; JWS arrives with the
// cross-broker wire slice — the bound fields are frozen here).
// ---------------------------------------------------------------------------

export interface A2AConversationReceipt {
  schemaVersion: typeof A2A_CONVERSATION_RECEIPT_SCHEMA_VERSION;
  brokerId: string;
  conversationId: string;
  messageId: string;
  sequence: number;
  contentDigest: string;
  deliveryState: A2AConversationDeliveryState;
  issuedAt: string;
  receiptDigest: string;
}

export function buildConversationReceipt(
  message: A2AConversationMessageRecord,
  brokerId: string,
  issuedAt: string,
): A2AConversationReceipt {
  const receipt: Omit<A2AConversationReceipt, "receiptDigest"> = {
    schemaVersion: A2A_CONVERSATION_RECEIPT_SCHEMA_VERSION,
    brokerId,
    conversationId: message.conversationId,
    messageId: message.messageId,
    sequence: message.sequence,
    contentDigest: message.contentDigest,
    deliveryState: message.deliveryState,
    issuedAt,
  } satisfies Omit<A2AConversationReceipt, "receiptDigest">;
  return {
    ...receipt,
    receiptDigest: `sha256:${createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex")}`,
  } satisfies A2AConversationReceipt;
}

// ---------------------------------------------------------------------------
// Inbox + consume (C2 slice 2): the worker-facing half of the loop.
// Polling marks persisted→delivered (spec: polling exposure is `delivered`,
// never `processed`); consuming advances to `processed` with linked evidence.
// ---------------------------------------------------------------------------

function recipientMatches(
  message: A2AConversationMessageRecord,
  actor: { kind: string; id: string; homeBrokerId: string },
): boolean {
  return message.recipients.some((recipient) => recipient.kind === actor.kind && recipient.id === actor.id && recipient.homeBrokerId === actor.homeBrokerId);
}

export interface ConversationInboxEntry {
  messageId: string;
  sequence: number;
  kind: A2AConversationMessageKind;
  sender: A2AConversationActorRef;
  taskId?: string;
  contentDigest: string;
  redacted: boolean;
  deliveryState: A2AConversationDeliveryState;
  expiresAt?: string;
  /** Present only when polling is allowed to expose content (delivered+). */
  content?: { text: string };
  createdAt: string;
}

export interface PollConversationInboxResult {
  entries: ConversationInboxEntry[];
  /** How many messages this poll advanced persisted→delivered. */
  markedDelivered: number;
}

/**
 * Poll an actor's conversation inbox. Participant-only (T6). Messages addressed
 * to the polling actor that are still `persisted` advance to `delivered` —
 * that is the entire effect of a poll; `processed` is never set here.
 */
export function pollConversationInbox(
  conversation: A2AConversationState,
  actor: { kind: string; id: string; homeBrokerId: string },
  options: { now: string },
): PollConversationInboxResult {
  assertConversationParticipant(conversation, actor, "read");
  expireStaleConversationMessages(conversation, options.now);
  const entries: ConversationInboxEntry[] = [];
  let markedDelivered = 0;
  const ordered = Object.values(conversation.messagesById).sort((left, right) => left.sequence - right.sequence);
  for (const message of ordered) {
    if (!recipientMatches(message, actor)) continue;
    if (TERMINAL_DELIVERY_STATES.has(message.deliveryState) || message.deliveryState === "processed") continue;
    if (message.deliveryState === "accepted" || message.deliveryState === "persisted") {
      // accepted→persisted is the broker's own durability step; a poll can
      // carry it forward so the inbox never shows a half-accepted message.
      if (message.deliveryState === "accepted") appendStateLog(message, "persisted", options.now);
      appendStateLog(message, "delivered", options.now);
      markedDelivered += 1;
    }
    entries.push({
      messageId: message.messageId,
      sequence: message.sequence,
      kind: message.kind,
      sender: message.sender,
      ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
      contentDigest: message.contentDigest,
      redacted: message.redacted,
      deliveryState: message.deliveryState,
      ...(message.expiresAt !== undefined ? { expiresAt: message.expiresAt } : {}),
      content: { text: message.content.text },
      createdAt: message.createdAt,
    });
  }
  if (markedDelivered > 0) conversation.updatedAt = options.now;
  return { entries, markedDelivered };
}

export interface ConsumeConversationMessageResult {
  message: A2AConversationMessageRecord;
  receipt: A2AConversationReceipt;
}

/**
 * Consume an inbox message: the polled (delivered) message advances to
 * `processed` with linked evidence — a reply message id, a task result ref, or
 * an explicit ack. Only a recipient of the message may consume it (T6), and
 * only via broker mediation: there is no path here that bypasses the evidence
 * requirement (spec non-proof: polling and provider-send never equal
 * processed).
 */
export function consumeConversationMessage(
  conversation: A2AConversationState,
  messageId: string,
  actor: { kind: string; id: string; homeBrokerId: string },
  evidence: { kind: "reply" | "task-result" | "ack"; ref: string },
  options: { now: string; brokerId: string },
): ConsumeConversationMessageResult {
  assertConversationParticipant(conversation, actor, "write");
  const message = conversation.messagesById[messageId];
  if (!message) {
    throw new BrokerError("not_found", `conversation message ${messageId} not found in ${conversation.conversationId}`);
  }
  if (!recipientMatches(message, actor)) {
    throw new BrokerError("policy_denied", `conversation message ${messageId} is not addressed to ${conversationActorKey(actor)}`);
  }
  if (!evidence.ref || typeof evidence.ref !== "string") {
    throw new BrokerError("bad_request", "consume requires evidence.kind (reply|task-result|ack) and a non-empty evidence.ref");
  }
  if (message.deliveryState === "persisted" || message.deliveryState === "accepted") {
    // An unpolled consume still passes through delivered so the state log
    // records the exposure step (poll semantics) before processed.
    if (message.deliveryState === "accepted") appendStateLog(message, "persisted", options.now);
    appendStateLog(message, "delivered", options.now);
  }
  advanceConversationDelivery(conversation, messageId, "processed", {
    now: options.now,
    processedEvidence: evidence,
  });
  return { message, receipt: buildConversationReceipt(message, options.brokerId, options.now) };
}
