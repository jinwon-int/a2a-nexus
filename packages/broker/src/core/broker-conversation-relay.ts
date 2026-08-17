// Trusted Conversation Plane — C4 slice 2: the cross-broker relay core
// (spec: docs/specs/trusted-conversation-plane/spec.md, frozen #1861; track
// #1864). Mirrors the terminal-brief relay model (cross-broker-terminal-brief-
// receiver.ts): the SENDING broker appends bounded entries to a durable,
// cursor-addressed outbox; the RECEIVING broker pulls (or is pushed) and
// applies idempotently under fail-closed ordering.
//
// Transport-level peer auth (`conversation:send|read|relay` scopes, slice 1 in
// request-security.ts) and request-bound sender proofs
// (cross-broker-sender-proof.ts) are enforced by the HTTP route layer; this
// module owns the ordering/duplication invariants the spec freezes:
//
// - T8 (relay duplication): at-least-once redelivery collapses at the
//   receiving broker via the conversation idempotency key — a redelivery
//   returns `duplicate` without re-applying or re-notifying the inbox.
// - T9 (sequence gap / cursor loss): a relayed message whose sequence is more
//   than one past the receiving mirror's last applied sequence is BLOCKED —
//   never skipped-ahead — with a resync-required marker, mirroring the
//   terminal-brief receiver's cursor-freeze-on-blocked lesson.
// - T12 (wrong destination): an entry whose recipients are all homed
//   elsewhere than the receiving broker id is refused, not silently stored.
//
// No worker may cross-register: the mirror conversation keeps the ORIGINAL
// conversationId and homeBrokerId — the receiving broker never mints its own
// identity for a relayed conversation.

import { BrokerError } from "./broker-error.js";
import {
  conversationContentDigest,
  redactConversationContentText,
  type A2AConversationMessageRecord,
  type A2AConversationState,
} from "./broker-conversation.js";

export const A2A_CONVERSATION_RELAY_SCHEMA_VERSION = "a2a.conversation-relay.v1";

/** One outbound relay entry: a bounded envelope projection, cursor-addressed. */
export interface ConversationRelayOutboxEntry {
  schemaVersion: typeof A2A_CONVERSATION_RELAY_SCHEMA_VERSION;
  id: string;
  /** Monotonic, gap-free cursor position in the outbox log. */
  cursor: number;
  destinationBrokerId: string;
  conversationId: string;
  homeBrokerId: string;
  messageId: string;
  sequence: number;
  /** Bounded content for delivery; digested, already redacted at accept time. */
  content: { text: string };
  contentDigest: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

/** In-memory durable log (persisted through the broker snapshot field). */
export class ConversationRelayOutbox {
  private entries: ConversationRelayOutboxEntry[] = [];
  private nextCursor = 1;

  enqueue(input: {
    id: string;
    destinationBrokerId: string;
    conversationId: string;
    homeBrokerId: string;
    messageId: string;
    sequence: number;
    content: { text: string };
    contentDigest: string;
    createdAt: string;
  }): ConversationRelayOutboxEntry {
    if (this.entries.some((entry) => entry.id === input.id)) {
      throw new BrokerError("idempotency_conflict", `relay outbox entry ${input.id} already exists`);
    }
    const entry: ConversationRelayOutboxEntry = {
      schemaVersion: A2A_CONVERSATION_RELAY_SCHEMA_VERSION,
      id: input.id,
      cursor: this.nextCursor,
      destinationBrokerId: input.destinationBrokerId,
      conversationId: input.conversationId,
      homeBrokerId: input.homeBrokerId,
      messageId: input.messageId,
      sequence: input.sequence,
      content: { text: input.content.text },
      contentDigest: input.contentDigest,
      createdAt: input.createdAt,
      attempts: 0,
    };
    this.nextCursor += 1;
    this.entries.push(entry);
    return entry;
  }

  /** Entries strictly after `cursor` (pull model; 0 = from the start). */
  listAfter(cursor: number, limit = 50, destinationBrokerId?: string): ConversationRelayOutboxEntry[] {
    const filtered = destinationBrokerId
      ? this.entries.filter((entry) => entry.destinationBrokerId === destinationBrokerId)
      : this.entries;
    return filtered.filter((entry) => entry.cursor > cursor).slice(0, Math.max(1, Math.min(limit, 200)));
  }

  /** Highest cursor visible in this outbox (the receiver's resync checkpoint). */
  latestCursor(): number {
    return this.nextCursor - 1;
  }

  recordAttempt(entryId: string, error?: string): void {
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    entry.attempts += 1;
    if (error) entry.lastError = error.slice(0, 256);
  }

  snapshot(): ConversationRelayOutboxEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  hydrate(entries: ConversationRelayOutboxEntry[]): void {
    this.entries = entries.map((entry) => ({ ...entry }));
    this.nextCursor = entries.reduce((max, entry) => Math.max(max, entry.cursor), 0) + 1;
  }
}

/** Wire payload pushed/pulled between brokers (proof fields ride alongside). */
export interface ConversationRelayPayload {
  schemaVersion: typeof A2A_CONVERSATION_RELAY_SCHEMA_VERSION;
  senderBrokerId: string;
  destinationBrokerId: string;
  conversationId: string;
  homeBrokerId: string;
  message: {
    messageId: string;
    sequence: number;
    kind: A2AConversationMessageRecord["kind"];
    sender: A2AConversationMessageRecord["sender"];
    recipients: A2AConversationMessageRecord["recipients"];
    idempotencyKey: string;
    content: { text: string };
    contentDigest: string;
    createdAt: string;
    expiresAt?: string;
    taskId?: string;
  };
}

export function buildConversationRelayPayload(
  senderBrokerId: string,
  destinationBrokerId: string,
  conversation: A2AConversationState,
  message: A2AConversationMessageRecord,
): ConversationRelayPayload {
  return {
    schemaVersion: A2A_CONVERSATION_RELAY_SCHEMA_VERSION,
    senderBrokerId,
    destinationBrokerId,
    conversationId: conversation.conversationId,
    homeBrokerId: conversation.homeBrokerId,
    message: {
      messageId: message.messageId,
      sequence: message.sequence,
      kind: message.kind,
      sender: message.sender,
      recipients: message.recipients,
      idempotencyKey: message.idempotencyKey,
      content: { text: message.content.text },
      contentDigest: message.contentDigest,
      createdAt: message.createdAt,
      ...(message.expiresAt !== undefined ? { expiresAt: message.expiresAt } : {}),
      ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
    },
  };
}

export interface ApplyRelayedConversationResult {
  outcome: "applied" | "duplicate" | "blocked";
  /** Set when blocked: the mirror's last applied sequence (T9 resync marker). */
  lastAppliedSequence?: number;
  expectedSequence?: number;
  messageId: string;
}

/**
 * Receiving-broker apply. Ordering + duplication invariants only — peer auth
 * and sender-proof verification are the route layer's job (T7), done BEFORE
 * this call. The mirror keeps the original conversation id and home broker id;
 * the receiving broker never re-mints identity (no cross-registration).
 */
export function applyRelayedConversationMessage(
  mirrors: Map<string, A2AConversationState>,
  payload: unknown,
  options: {
    localBrokerId: string;
    now: string;
    /** Idempotency table shared with locally-opened conversations. */
    conversations: Map<string, A2AConversationState>;
  },
): ApplyRelayedConversationResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new BrokerError("bad_request", "conversation relay payload must be an object");
  }
  const record = payload as Record<string, unknown>;
  if (record.schemaVersion !== A2A_CONVERSATION_RELAY_SCHEMA_VERSION) {
    throw new BrokerError("bad_request", `conversation relay schemaVersion must be ${A2A_CONVERSATION_RELAY_SCHEMA_VERSION}`);
  }
  const message = record.message as ConversationRelayPayload["message"] | undefined;
  if (!message || typeof message !== "object") {
    throw new BrokerError("bad_request", "conversation relay payload.message is required");
  }
  const destinationBrokerId = typeof record.destinationBrokerId === "string" ? record.destinationBrokerId : "";
  if (destinationBrokerId !== options.localBrokerId) {
    // T12: wrong destination — refuse instead of storing for someone else.
    throw new BrokerError(
      "policy_denied",
      `conversation relay is addressed to broker ${destinationBrokerId || "<missing>"} but this broker is ${options.localBrokerId}`,
    );
  }
  const homeBrokerId = typeof record.homeBrokerId === "string" ? record.homeBrokerId : "";
  const conversationId = typeof record.conversationId === "string" ? record.conversationId : "";
  if (!homeBrokerId || !conversationId || !message.messageId || !message.idempotencyKey) {
    throw new BrokerError("bad_request", "conversation relay requires conversationId, homeBrokerId, message.messageId, message.idempotencyKey");
  }
  if (typeof message.sequence !== "number" || !Number.isSafeInteger(message.sequence) || message.sequence < 1) {
    throw new BrokerError("bad_request", "conversation relay message.sequence must be a positive integer");
  }
  const redacted = redactConversationContentText(String(message.content?.text ?? ""));
  const digest = conversationContentDigest(redacted.text);
  if (message.contentDigest !== digest) {
    throw new BrokerError("bad_request", "conversation relay contentDigest does not match the relayed content");
  }

  // T8: idempotent collapse against BOTH the mirror and locally-known state.
  const known = mirrors.get(conversationId) ?? options.conversations.get(conversationId);
  if (known) {
    if (known.idempotencyByKey[message.idempotencyKey]) {
      return { outcome: "duplicate", messageId: message.messageId };
    }
    if (message.sequence <= known.lastAssignedSequence) {
      // Old sequence with a fresh key: not a replay, a fork — refuse.
      throw new BrokerError(
        "idempotency_conflict",
        `conversation relay sequence ${message.sequence} is not newer than the applied ${known.lastAssignedSequence} for ${conversationId}`,
      );
    }
    if (message.sequence > known.lastAssignedSequence + 1) {
      // T9: gap — block, never skip ahead. The mirror stays at its cursor.
      return {
        outcome: "blocked",
        messageId: message.messageId,
        lastAppliedSequence: known.lastAssignedSequence,
        expectedSequence: known.lastAssignedSequence + 1,
      };
    }
    appendRelayedMessage(known, message, redacted.text, digest, options.now);
    return { outcome: "applied", messageId: message.messageId };
  }

  if (message.sequence !== 1) {
    // No mirror yet and not the root: the lineage head was lost — block for
    // resync instead of fabricating a partial history (T9 cursor-loss case).
    return {
      outcome: "blocked",
      messageId: message.messageId,
      lastAppliedSequence: 0,
      expectedSequence: 1,
    };
  }

  const mirror: A2AConversationState = {
    schemaVersion: "a2a.conversation-state.v1",
    conversationId,
    homeBrokerId,
    status: "open",
    maxTurns: 8,
    turnCount: 1,
    totalContentBytes: Buffer.byteLength(redacted.text, "utf8"),
    lastAssignedSequence: 1,
    rootMessageId: message.messageId,
    latestMessageId: message.messageId,
    participants: [
      `${message.sender.kind}:${message.sender.id}:${message.sender.homeBrokerId}`,
      ...message.recipients.map((recipient) => `${recipient.kind}:${recipient.id}:${recipient.homeBrokerId}`),
    ],
    messagesById: {},
    idempotencyByKey: {},
    createdAt: options.now,
    updatedAt: options.now,
    relayMirror: true,
  };
  appendRelayedMessage(mirror, message, redacted.text, digest, options.now);
  mirrors.set(conversationId, mirror);
  return { outcome: "applied", messageId: message.messageId };
}

function appendRelayedMessage(
  conversation: A2AConversationState,
  message: ConversationRelayPayload["message"],
  redactedText: string,
  digest: string,
  now: string,
): void {
  const record: A2AConversationMessageRecord = {
    schemaVersion: "a2a.conversation-envelope.v1",
    conversationId: conversation.conversationId,
    messageId: message.messageId,
    sequence: message.sequence,
    kind: message.kind,
    sender: message.sender,
    recipients: message.recipients,
    referenceTaskIds: [],
    ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
    idempotencyKey: message.idempotencyKey,
    createdAt: message.createdAt,
    ...(message.expiresAt !== undefined ? { expiresAt: message.expiresAt } : {}),
    content: { text: redactedText },
    contentDigest: digest,
    redacted: true,
    hopTrace: [],
    deliveryState: "persisted",
    stateLog: [{ state: "persisted", at: now }],
    updatedAt: now,
  };
  conversation.messagesById[record.messageId] = record;
  conversation.idempotencyByKey[record.idempotencyKey] = {
    messageId: record.messageId,
    contentDigest: digest,
    outcome: "persisted",
  };
  conversation.lastAssignedSequence = Math.max(conversation.lastAssignedSequence, message.sequence);
  conversation.latestMessageId = record.messageId;
  conversation.totalContentBytes += Buffer.byteLength(redactedText, "utf8");
  conversation.turnCount += 1;
  conversation.updatedAt = now;
}
