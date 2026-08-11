// A2A cross-broker + terminal-outbox routes (POST/GET
// /a2a/cross-broker/terminal-briefs, GET /a2a/tasks/terminal-outbox, POST
// /a2a/tasks/terminal-outbox/receipt, POST /a2a/tasks/terminal-outbox/ack),
// extracted from the server request closure into explicit-context handlers
// (continuing the #645 dispatcher migration). The cross-broker ingest verifies
// the sender proof against the server-loaded trust anchors and nonce cache, so
// those collaborators ride in the route context (undefined when no anchors are
// configured). The two SSE stream routes on /a2a/* (terminal-events,
// operator/events) hold connections open and stay in the server closure.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import {
  assertPeerHandoffScope,
  resolvePeerFromRequest,
  type PeerCredentialRegistry,
  type PeerHandoffScopeMode,
} from "../core/request-security.js";
import {
  verifyCrossBrokerSenderProof,
  type CrossBrokerNonceCache,
  type CrossBrokerTrustAnchors,
} from "../a2a/cross-broker-sender-proof.js";
import { parseTerminalOutboxAckReceipt, parseTerminalOutboxReceiptUpdate } from "../request-parsers.js";
import { booleanQueryParam, numberQueryParam } from "./request-params.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

export interface A2ATerminalOutboxRouteContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
  crossBrokerTrustAnchors: CrossBrokerTrustAnchors | null;
  crossBrokerNonceCache: CrossBrokerNonceCache | undefined;
  /** Minimum-scope peer credential registry (null = peer auth not provisioned). */
  peerCredentialRegistry?: PeerCredentialRegistry | null;
  /** Peer handoff scope gate mode; defaults to `auto` (verify when presented). */
  peerHandoffScopeMode?: PeerHandoffScopeMode;
}

/**
 * Resolve + scope-check the calling peer for a handoff route. In `enforce`
 * mode a missing peer credential fails closed; in `auto` mode header-less
 * callers fall through to the pre-existing role/edge-secret gates.
 */
function assertPeerScopeForRoute(
  ctx: A2ATerminalOutboxRouteContext,
  requiredScope: "handoff:status" | "handoff:evidence",
  operation: string,
  options: { softEnforce?: boolean } = {},
): void {
  const mode = ctx.peerHandoffScopeMode ?? "auto";
  if (mode === "off") return;
  const peer = resolvePeerFromRequest(ctx.peerCredentialRegistry ?? null, ctx.req);
  // The terminal-outbox subscribe route is shared with local (same-broker)
  // consumers, so `enforce` only hard-requires peer credentials on the
  // cross-broker projection routes; the shared route keeps verify-if-present
  // semantics (softEnforce).
  const effectiveMode = options.softEnforce && mode === "enforce" ? "auto" : mode;
  assertPeerHandoffScope(effectiveMode, peer, requiredScope, operation);
}

/** POST /a2a/cross-broker/terminal-briefs — ingest a cross-broker terminal-brief projection. */
export async function handleCrossBrokerTerminalBriefIngestRequest(
  ctx: A2ATerminalOutboxRouteContext,
): Promise<void> {
  const { broker, res } = ctx;
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "cross-broker-terminal-brief.ingest");
  }
  assertPeerScopeForRoute(ctx, "handoff:evidence", "cross-broker-terminal-brief.ingest");

  const body = await readJson(ctx.req);
  if (ctx.crossBrokerTrustAnchors && ctx.crossBrokerNonceCache) {
    const verdict = verifyCrossBrokerSenderProof(ctx.crossBrokerTrustAnchors, body, {
      nonceCache: ctx.crossBrokerNonceCache,
    });
    if (!verdict.ok) {
      throw new BrokerError("policy_denied", `cross-broker trust: ${verdict.reason}`);
    }
  }
  const result = broker.ingestCrossBrokerTerminalBriefProjection(
    body as Parameters<typeof broker.ingestCrossBrokerTerminalBriefProjection>[0],
  );
  if (!result.accepted) {
    const status = result.ack.code === "missing_parent" ? 404 : result.ack.code === "stale_replay" ? 409 : 400;
    sendJson(res, status, result);
    return;
  }
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(res, result.replayed ? 200 : 202, result);
}

/** GET /a2a/cross-broker/terminal-briefs — query ingested cross-broker terminal-brief projections. */
export function handleCrossBrokerTerminalBriefQueryRequest(ctx: A2ATerminalOutboxRouteContext): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "cross-broker-terminal-brief.query");
  }
  assertPeerScopeForRoute(ctx, "handoff:status", "cross-broker-terminal-brief.query");

  const parentRoundId = ctx.url.searchParams.get("parent_round_id") ?? undefined;
  const originBrokerId = ctx.url.searchParams.get("origin_broker_id") ?? undefined;
  const records = ctx.broker.listCrossBrokerTerminalBriefProjections({ parentRoundId, originBrokerId });
  sendJson(ctx.res, 200, {
    kind: "a2a.cross-broker.terminal-briefs",
    count: records.length,
    records,
  });
}

/** GET /a2a/tasks/terminal-outbox — subscribe to the terminal-task outbox (optionally reconciling unacked). */
export function handleTerminalOutboxSubscribeRequest(ctx: A2ATerminalOutboxRouteContext): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "task-terminal-outbox.subscribe");
  }
  assertPeerScopeForRoute(ctx, "handoff:status", "task-terminal-outbox.subscribe", { softEnforce: true });

  const afterId = ctx.url.searchParams.get("after_id") ?? undefined;
  const limit = numberQueryParam(ctx.url, "limit");
  const reconcileUnacked = booleanQueryParam(ctx.url, "reconcile_unacked") ?? false;
  if (reconcileUnacked) {
    const subscription = ctx.broker.getTerminalTaskEventOutbox().subscribeWithCursor({ afterId, limit });
    sendJson(ctx.res, 200, {
      kind: "task.terminal.outbox",
      count: subscription.events.length,
      cursor: subscription.cursor,
      reconciledUnacked: subscription.reconciledUnacked,
      events: subscription.events,
    });
    return;
  }
  const events = ctx.broker.getTerminalTaskEventOutbox().subscribe({ afterId, limit });
  sendJson(ctx.res, 200, {
    kind: "task.terminal.outbox",
    count: events.length,
    cursor: events.at(-1)?.id ?? afterId ?? null,
    events,
  });
}

/** POST /a2a/tasks/terminal-outbox/receipt — record a delivery-receipt status for an outbox event. */
export async function handleTerminalOutboxReceiptRequest(ctx: A2ATerminalOutboxRouteContext): Promise<void> {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "task-terminal-outbox.receipt");
  }

  const body = await readJson<{ id?: unknown; receipt?: unknown }>(ctx.req);
  const id = body?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new BrokerError("bad_request", "terminal outbox receipt update requires a non-empty id");
  }
  const receipt = parseTerminalOutboxReceiptUpdate(body?.receipt);
  const event = ctx.broker.recordTerminalTaskOutboxReceiptStatus(id, receipt);
  if (!event) {
    throw new BrokerError("not_found", "terminal outbox event not found");
  }
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 200, { event });
}

/** POST /a2a/tasks/terminal-outbox/ack — acknowledge (and retire) an outbox event. */
export async function handleTerminalOutboxAckRequest(ctx: A2ATerminalOutboxRouteContext): Promise<void> {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "task-terminal-outbox.ack");
  }

  const body = await readJson<{ id?: unknown; receipt?: unknown }>(ctx.req);
  const id = body?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new BrokerError("bad_request", "terminal outbox ack requires a non-empty id");
  }
  const receipt = parseTerminalOutboxAckReceipt(body?.receipt);
  const event = ctx.broker.acknowledgeTerminalTaskOutboxEvent(id, receipt);
  if (!event) {
    throw new BrokerError("not_found", "terminal outbox event not found");
  }
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 200, { event });
}

/**
 * Route dispatcher for the A2A cross-broker + terminal-outbox routes. Returns
 * true only when handled.
 */
export async function handleA2ATerminalOutboxRouteIfMatched(
  ctx: A2ATerminalOutboxRouteContext,
): Promise<boolean> {
  if (ctx.method === "POST" && ctx.path === "/a2a/cross-broker/terminal-briefs") {
    await handleCrossBrokerTerminalBriefIngestRequest(ctx);
    return true;
  }
  if (ctx.method === "GET" && ctx.path === "/a2a/cross-broker/terminal-briefs") {
    handleCrossBrokerTerminalBriefQueryRequest(ctx);
    return true;
  }
  if (ctx.method === "GET" && ctx.path === "/a2a/tasks/terminal-outbox") {
    handleTerminalOutboxSubscribeRequest(ctx);
    return true;
  }
  if (ctx.method === "POST" && ctx.path === "/a2a/tasks/terminal-outbox/receipt") {
    await handleTerminalOutboxReceiptRequest(ctx);
    return true;
  }
  if (ctx.method === "POST" && ctx.path === "/a2a/tasks/terminal-outbox/ack") {
    await handleTerminalOutboxAckRequest(ctx);
    return true;
  }
  return false;
}
