// Trusted Conversation Plane peer relay routes (#1864 slice 2; spec #1861).
// Mirrors the terminal-outbox route model (a2a-terminal-outbox-routes.ts):
// transport-level peer credentials gate the surface (conversation:relay to
// pull an outbox, conversation:send to push an apply), and when trust anchors
// are configured the push path additionally requires a request-bound sender
// proof whose bodyHash covers the relay payload (T7).
//
//   GET  /peer/conversations/outbox?cursor=&limit=   — pull (conversation:relay)
//   POST /peer/conversations/relay                   — apply (conversation:send)

import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import {
  assertPeerConversationScope,
  resolvePeerFromRequest,
  type PeerCredentialRegistry,
  type PeerHandoffScopeMode,
  type VerifiedPeer,
} from "../core/request-security.js";
import {
  CrossBrokerNonceCache,
  verifyCrossBrokerSenderProof,
  type CrossBrokerTrustAnchors,
} from "../a2a/cross-broker-sender-proof.js";
import type { BrokerStateStore } from "../core/store.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

export interface ConversationRelayRouteContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  crossBrokerTrustAnchors: CrossBrokerTrustAnchors | null;
  crossBrokerNonceCache: CrossBrokerNonceCache | undefined;
  peerCredentialRegistry?: PeerCredentialRegistry | null;
  peerHandoffScopeMode?: PeerHandoffScopeMode;
}

function requirePeer(
  ctx: ConversationRelayRouteContext,
  requiredScope: "conversation:relay" | "conversation:send",
  operation: string,
): VerifiedPeer | null {
  const peer = resolvePeerFromRequest(ctx.peerCredentialRegistry ?? null, ctx.req);
  assertPeerConversationScope(ctx.peerHandoffScopeMode ?? "auto", peer, requiredScope, operation);
  return peer;
}

function numberQueryParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BrokerError("bad_request", `${name} must be a non-negative integer`);
  }
  return value;
}

export async function handleConversationRelayRoutesIfMatched(ctx: ConversationRelayRouteContext): Promise<boolean> {
  if (ctx.method === "GET" && ctx.path === "/peer/conversations/outbox") {
    const peer = requirePeer(ctx, "conversation:relay", "conversation relay outbox pull");
    if (!peer) {
      // auto mode with no peer headers: the outbox is peer-only — fail closed.
      throw new BrokerError("unauthorized", "conversation relay outbox requires peer credentials");
    }
    const cursor = numberQueryParam(ctx.url, "cursor") ?? 0;
    const limit = numberQueryParam(ctx.url, "limit") ?? 50;
    const result = ctx.broker.listConversationRelayOutbox(cursor, limit, peer.peerBrokerId);
    sendJson(ctx.res, 200, {
      peerBrokerId: peer.peerBrokerId,
      cursor,
      entries: result.entries,
      latestCursor: result.latestCursor,
    });
    return true;
  }

  if (ctx.method === "POST" && ctx.path === "/peer/conversations/relay") {
    const peer = requirePeer(ctx, "conversation:send", "conversation relay apply");
    const body = await readJson<Record<string, unknown>>(ctx.req);
    if (!body) throw new BrokerError("bad_request", "conversation relay payload is required");

    // T7: when trust anchors are configured, the relay must carry a
    // request-bound sender proof for the claimed sender broker whose
    // bodyHash covers the payload (proof fields excluded from the hash).
    if (ctx.crossBrokerTrustAnchors) {
      const senderBrokerId = typeof body.senderBrokerId === "string" ? body.senderBrokerId : "";
      if (!senderBrokerId) {
        throw new BrokerError("bad_request", "conversation relay requires senderBrokerId");
      }
      const verdict = verifyCrossBrokerSenderProof(ctx.crossBrokerTrustAnchors, body, {
        nonceCache: ctx.crossBrokerNonceCache ?? new CrossBrokerNonceCache(),
      });
      if (!verdict.ok) {
        throw new BrokerError("unauthorized", `conversation relay sender proof rejected: ${verdict.reason}`);
      }
      if (verdict.brokerId !== senderBrokerId) {
        throw new BrokerError("unauthorized", "conversation relay senderBrokerId does not match the verified proof broker");
      }
    }
    if (peer && peer.peerBrokerId && typeof body.senderBrokerId === "string" && body.senderBrokerId !== peer.peerBrokerId) {
      throw new BrokerError("unauthorized", "conversation relay senderBrokerId does not match the peer credential broker id");
    }

    const result = ctx.broker.applyConversationRelay(body);
    if (result.outcome === "applied") {
      await awaitDurablePersistenceAck(ctx.stateStore);
    }
    sendJson(ctx.res, result.outcome === "blocked" ? 409 : 200, {
      outcome: result.outcome,
      messageId: result.messageId,
      ...(result.outcome === "blocked"
        ? { lastAppliedSequence: result.lastAppliedSequence, expectedSequence: result.expectedSequence, resyncRequired: true }
        : {}),
    });
    return true;
  }

  return false;
}
