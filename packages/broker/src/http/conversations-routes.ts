// Trusted Conversation Plane routes (#1862, C2 slice 2; spec frozen #1861).
// Follows the exchanges-read.ts dispatcher convention: an explicit-context
// handler module with a `handleConversationRoutesIfMatched` entry the server
// calls; returning false means "not a conversation route".
//
// Surface (participant-authorized by the domain rules in broker-conversation.ts):
//   POST /conversations                                    — open (mints conv id)
//   GET  /conversations/:id                                — participant read
//   GET  /conversations/:id/inbox?actor=kind:id:home       — poll (→delivered)
//   POST /conversations/:id/messages                       — reply/accept (idempotent)
//   POST /conversations/:id/messages/:messageId/processed  — consume (→processed+receipt)

import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { assertRequesterMatchesParty, type RequesterIdentity } from "../core/request-security.js";
import type { BrokerStateStore } from "../core/store.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

interface ActorRefShape {
  kind: string;
  id: string;
  homeBrokerId: string;
}

/** `actor=worker:worker-a:broker-alpha` → {kind,id,homeBrokerId}. */
function parseActorParam(raw: string | null): ActorRefShape {
  if (!raw) throw new BrokerError("bad_request", "actor query parameter (kind:id:homeBrokerId) is required");
  const parts = raw.split(":");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new BrokerError("bad_request", "actor must be kind:id:homeBrokerId");
  }
  const [kind, id, homeBrokerId] = parts;
  if (!["worker", "broker", "operator"].includes(kind)) {
    throw new BrokerError("bad_request", "actor.kind must be worker|broker|operator");
  }
  return { kind, id, homeBrokerId };
}

function parseBodyActor(value: unknown, field: string): ActorRefShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("bad_request", `${field} must be {kind,id,homeBrokerId}`);
  }
  const record = value as Record<string, unknown>;
  return parseActorParam(
    `${String(record.kind ?? "")}:${String(record.id ?? "")}:${String(record.homeBrokerId ?? "")}`,
  );
}

function requesterMatchesActor(
  enforceRequesterIdentity: boolean,
  requesterIdentity: RequesterIdentity | null,
  actor: ActorRefShape,
  context: string,
): void {
  if (!enforceRequesterIdentity) return;
  assertRequesterMatchesParty(requesterIdentity, { id: actor.id }, context);
}

export interface ConversationRoutesContext {
  res: ServerResponse;
  stateStore: BrokerStateStore;
  broker: InMemoryA2ABroker;
  method: string | undefined;
  path: string;
  segments: readonly string[];
  req: IncomingMessage;
  url: URL;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

export async function handleConversationRoutesIfMatched(ctx: ConversationRoutesContext): Promise<boolean> {
  if (ctx.segments[0] !== "conversations") return false;

  if (ctx.method === "POST" && ctx.path === "/conversations") {
    const body = await readJson<{
      homeBrokerId?: string;
      maxTurns?: number;
      envelope?: Record<string, unknown>;
    }>(ctx.req);
    const envelope = body?.envelope;
    const sender = envelope?.sender as ActorRefShape | undefined;
    if (!envelope || !sender?.id) {
      throw new BrokerError("bad_request", "envelope with envelope.sender is required");
    }
    requesterMatchesActor(ctx.enforceRequesterIdentity, ctx.requesterIdentity, sender, "conversation.create");
    const { conversation, messageId } = ctx.broker.startConversation({
      homeBrokerId: body?.homeBrokerId ?? sender.homeBrokerId,
      ...(body?.maxTurns !== undefined ? { maxTurns: body.maxTurns } : {}),
      envelope,
    });
    await awaitDurablePersistenceAck(ctx.stateStore);
    sendJson(ctx.res, 201, { conversationId: conversation.conversationId, messageId, sequence: 1 });
    return true;
  }

  const conversationId = ctx.segments[1];
  if (!conversationId) {
    throw new BrokerError("not_found", "conversation not found");
  }

  if (ctx.method === "GET" && ctx.segments.length === 2) {
    const actor = parseActorParam(ctx.url.searchParams.get("actor"));
    const conversation = ctx.broker.getConversation(conversationId);
    if (!conversation) throw new BrokerError("not_found", "conversation not found");
    // Participant read (T6) via the domain guard: reuse the inbox poll with a
    // digest-only summary projection instead of exposing everything blindly.
    const { assertConversationParticipant } = await import("../core/broker-conversation.js");
    assertConversationParticipant(conversation, actor, "read");
    sendJson(ctx.res, 200, {
      conversationId: conversation.conversationId,
      homeBrokerId: conversation.homeBrokerId,
      status: conversation.status,
      ...(conversation.closureReason ? { closureReason: conversation.closureReason } : {}),
      maxTurns: conversation.maxTurns,
      turnCount: conversation.turnCount,
      lastAssignedSequence: conversation.lastAssignedSequence,
      participants: conversation.participants,
      updatedAt: conversation.updatedAt,
    });
    return true;
  }

  if (ctx.method === "GET" && ctx.segments[2] === "delivery" && ctx.segments.length === 3) {
    const actor = parseActorParam(ctx.url.searchParams.get("actor"));
    const conversation = ctx.broker.getConversation(conversationId);
    if (!conversation) throw new BrokerError("not_found", "conversation not found");
    const { assertConversationParticipant } = await import("../core/broker-conversation.js");
    assertConversationParticipant(conversation, actor, "read");
    // Participant read exposes the queue matrix only — message bodies stay
    // behind the inbox poll (digest-first summary here).
    const summary = ctx.broker.getConversationDeliverySummary(conversationId);
    sendJson(ctx.res, 200, summary);
    return true;
  }

  if (ctx.method === "GET" && ctx.segments[2] === "inbox" && ctx.segments.length === 3) {
    const actor = parseActorParam(ctx.url.searchParams.get("actor"));
    requesterMatchesActor(ctx.enforceRequesterIdentity, ctx.requesterIdentity, actor, "conversation.inbox.poll");
    const result = ctx.broker.pollConversationInbox(conversationId, actor);
    await awaitDurablePersistenceAck(ctx.stateStore);
    sendJson(ctx.res, 200, {
      conversationId,
      actor: `${actor.kind}:${actor.id}:${actor.homeBrokerId}`,
      markedDelivered: result.markedDelivered,
      entries: result.entries,
    });
    return true;
  }

  if (ctx.method === "POST" && ctx.segments[2] === "messages" && ctx.segments.length === 3) {
    const body = await readJson<{ envelope?: Record<string, unknown> }>(ctx.req);
    const envelope = body?.envelope;
    const sender = envelope?.sender as ActorRefShape | undefined;
    if (!envelope || !sender?.id) {
      throw new BrokerError("bad_request", "envelope with envelope.sender is required");
    }
    requesterMatchesActor(ctx.enforceRequesterIdentity, ctx.requesterIdentity, sender, "conversation.message.create");
    // C5: when the id names a MIRROR conversation (cross-broker), the reply
    // queues for relay to the home broker instead of applying locally.
    if (!ctx.broker.getConversation(conversationId)) {
      const queued = ctx.broker.addMirrorConversationReply(conversationId, envelope);
      await awaitDurablePersistenceAck(ctx.stateStore);
      sendJson(ctx.res, 202, queued);
      return true;
    }
    const result = ctx.broker.addConversationMessage(conversationId, envelope);
    await awaitDurablePersistenceAck(ctx.stateStore);
    sendJson(ctx.res, result.outcome === "converged" ? 200 : 201, {
      outcome: result.outcome,
      messageId: result.messageId,
      sequence: result.sequence,
    });
    return true;
  }

  if (
    ctx.method === "POST"
    && ctx.segments[2] === "messages"
    && ctx.segments[3]
    && ctx.segments[4] === "processed"
    && ctx.segments.length === 5
  ) {
    const messageId = ctx.segments[3];
    const body = await readJson<{
      actor?: Record<string, unknown>;
      evidence?: { kind?: string; ref?: string };
    }>(ctx.req);
    const actor = parseBodyActor(body?.actor, "actor");
    requesterMatchesActor(ctx.enforceRequesterIdentity, ctx.requesterIdentity, actor, "conversation.message.process");
    const evidence = body?.evidence;
    if (!evidence || !["reply", "task-result", "ack"].includes(String(evidence.kind)) || !evidence.ref) {
      throw new BrokerError("bad_request", "evidence {kind: reply|task-result|ack, ref} is required");
    }
    // C5: when the id names a MIRROR conversation (cross-broker), the consume
    // runs on the mirror and queues a deterministic ack back to the home broker.
    if (!ctx.broker.getConversation(conversationId)) {
      const mirrorResult = ctx.broker.consumeMirrorConversationMessage(conversationId, messageId, actor, {
        kind: evidence.kind as "reply" | "task-result" | "ack",
        ref: String(evidence.ref),
      });
      await awaitDurablePersistenceAck(ctx.stateStore);
      sendJson(ctx.res, 200, {
        messageId,
        receipt: mirrorResult.receipt,
        ackQueued: mirrorResult.ackQueued,
        ackMessageId: mirrorResult.ackMessageId,
      });
      return true;
    }
    const result = ctx.broker.consumeConversationMessage(conversationId, messageId, actor, {
      kind: evidence.kind as "reply" | "task-result" | "ack",
      ref: String(evidence.ref),
    });
    await awaitDurablePersistenceAck(ctx.stateStore);
    sendJson(ctx.res, 200, { messageId, receipt: result.receipt });
    return true;
  }

  throw new BrokerError("not_found", "conversation route not found");
}
