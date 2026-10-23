// Parent round registry routes (#2339 PR-1b, spec docs/specs/cross-broker-parent-round §1+2):
//   POST /a2a/parent-rounds                — mint a local-origin round on this broker
//   POST /a2a/parent-rounds/:id/anchors    — add an origin/child task id anchor
//   GET  /a2a/parent-rounds/:id            — read one entry
//
// Only this API mints `local-origin` rounds. `foreign-handoff` entries come
// from the authenticated handoff receiver, never from a request body. No
// projection or routing decision reads the registry until PR-1c, so these
// routes change no delivery outcome yet.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import { ParentRoundRegistryError } from "../core/parent-round-registry.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

export interface ParentRoundRouteContext {
  method: string | undefined;
  path: string;
  segments: string[];
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  /** This broker's id: the origin and parent of every round it mints. */
  brokerId: string;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

const WRITE_ROLES = ["hub", "operator"] as const;

function assertRole(ctx: ParentRoundRouteContext, operation: string): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, [...WRITE_ROLES], operation);
  }
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BrokerError("bad_request", `${field} must be a string`);
  return value;
}

/** POST /a2a/parent-rounds — mint a local-origin parent round (idempotent; 409 on different metadata). */
export async function handleParentRoundMintRequest(ctx: ParentRoundRouteContext): Promise<void> {
  assertRole(ctx, "parent-round.mint");
  const body = await readJson<Record<string, unknown>>(ctx.req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BrokerError("bad_request", "parent round mint requires a JSON object body");
  }
  if (body.kind !== undefined && body.kind !== "local-origin") {
    throw new BrokerError("bad_request", "this route mints local-origin rounds only; foreign-handoff entries come from the handoff receiver");
  }
  // A round minted here has this broker as origin and parent (v0
  // parentBrokerId == originBrokerId). Accept the fields only when they agree.
  for (const field of ["originBrokerId", "parentBrokerId"] as const) {
    const claimed = optionalString(body, field);
    if (claimed !== undefined && claimed !== ctx.brokerId) {
      throw new BrokerError("bad_request", `${field} must be this broker (${ctx.brokerId}) for a local-origin round`);
    }
  }
  const total = body.parentRoundTotal;
  if (total !== undefined && typeof total !== "number") {
    throw new BrokerError("bad_request", "parentRoundTotal must be a number");
  }
  const anchors = body.anchors;
  if (anchors !== undefined && !(Array.isArray(anchors) && anchors.every((anchor) => typeof anchor === "string"))) {
    throw new BrokerError("bad_request", "anchors must be an array of strings");
  }
  const parentRoundId = optionalString(body, "parentRoundId");
  if (!parentRoundId) throw new BrokerError("bad_request", "parentRoundId is required");

  let teamScope = optionalString(body, "teamScope");
  let handoffBrokerId = optionalString(body, "handoffBrokerId");
  const initiatingBrokerId = optionalString(body, "initiatingBrokerId") ?? ctx.brokerId;
  // #2339 spec item 2: with a configured broker-team registry, the round's
  // routing must agree with the parent-origin resolver. The resolver fills a
  // missing handoff broker, and the registry entry then activates
  // routing_mismatch for the round. Without a registry the placeholder
  // default would misjudge real broker ids, so nothing is checked.
  if (teamScope) {
    const resolved = ctx.broker.resolveConfiguredParentOriginRoute(initiatingBrokerId, teamScope);
    if (resolved && !resolved.ok) {
      throw new BrokerError("bad_request", `teamScope does not resolve to a route: ${resolved.code}: ${resolved.reason}`);
    }
    if (resolved?.ok) {
      const { route } = resolved;
      if (route.parentBrokerId !== ctx.brokerId.toLowerCase()) {
        throw new BrokerError("bad_request", `teamScope routes the parent to ${route.parentBrokerId}, not this broker (${ctx.brokerId})`);
      }
      const routedHandoff = route.handoff?.handoffBrokerId;
      if (handoffBrokerId && handoffBrokerId.toLowerCase() !== routedHandoff) {
        throw new BrokerError(
          "bad_request",
          routedHandoff
            ? `handoffBrokerId ${handoffBrokerId} does not match the routed handoff broker ${routedHandoff}`
            : `teamScope ${route.requestedTeamScope} is local-only; it has no handoff broker`,
        );
      }
      handoffBrokerId = handoffBrokerId ?? routedHandoff;
      teamScope = route.requestedTeamScope;
    }
  }
  let result: ReturnType<InMemoryA2ABroker["mintParentRound"]>;
  try {
    result = ctx.broker.mintParentRound({
      parentRoundId,
      originBrokerId: ctx.brokerId,
      parentBrokerId: ctx.brokerId,
      initiatingBrokerId,
      ...(teamScope ? { teamScope } : {}),
      ...(handoffBrokerId ? { handoffBrokerId } : {}),
      ...(typeof total === "number" ? { parentRoundTotal: total } : {}),
      kind: "local-origin",
      mintedBy: {
        requesterId: ctx.requesterIdentity?.id ?? "unidentified",
        role: ctx.requesterIdentity?.role ?? "unidentified",
      },
      ...(Array.isArray(anchors) ? { anchors: anchors as string[] } : {}),
    });
  } catch (error) {
    if (error instanceof ParentRoundRegistryError) throw new BrokerError("bad_request", error.message);
    throw error;
  }
  if (result.status === "conflict") {
    sendJson(ctx.res, 409, {
      status: "conflict",
      reason: "a different parent round is already registered under this id",
      entry: result.entry,
    });
    return;
  }
  if (result.status === "minted") await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, result.status === "minted" ? 201 : 200, result);
}

/** POST /a2a/parent-rounds/:id/anchors — register an origin/child task id for a known round. */
export async function handleParentRoundAnchorRequest(ctx: ParentRoundRouteContext, parentRoundId: string): Promise<void> {
  assertRole(ctx, "parent-round.anchor");
  const body = await readJson<{ anchor?: unknown }>(ctx.req);
  const anchor = body?.anchor;
  if (typeof anchor !== "string") throw new BrokerError("bad_request", "anchor must be a string");
  let result: ReturnType<InMemoryA2ABroker["addParentRoundAnchor"]>;
  try {
    result = ctx.broker.addParentRoundAnchor(parentRoundId, anchor);
  } catch (error) {
    if (error instanceof ParentRoundRegistryError) throw new BrokerError("bad_request", error.message);
    throw error;
  }
  if (result.status === "unknown_round") {
    sendJson(ctx.res, 404, { status: result.status });
    return;
  }
  if (result.status === "anchor_limit") {
    sendJson(ctx.res, 409, { status: result.status, entry: result.entry });
    return;
  }
  if (result.status === "added") await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, result.status === "added" ? 201 : 200, result);
}

/** GET /a2a/parent-rounds/:id — read one registry entry. */
export function handleParentRoundGetRequest(ctx: ParentRoundRouteContext, parentRoundId: string): void {
  assertRole(ctx, "parent-round.get");
  const entry = ctx.broker.getParentRound(parentRoundId);
  if (!entry) {
    sendJson(ctx.res, 404, { status: "unknown_round" });
    return;
  }
  sendJson(ctx.res, 200, { entry });
}

/** Dispatcher for the parent round routes. Returns true only when handled. */
export async function handleParentRoundRouteIfMatched(ctx: ParentRoundRouteContext): Promise<boolean> {
  const [a2a, resource, id, sub, ...rest] = ctx.segments;
  if (a2a !== "a2a" || resource !== "parent-rounds" || rest.length > 0) return false;
  if (ctx.method === "POST" && id === undefined) {
    await handleParentRoundMintRequest(ctx);
    return true;
  }
  if (ctx.method === "POST" && id !== undefined && sub === "anchors") {
    await handleParentRoundAnchorRequest(ctx, id);
    return true;
  }
  if (ctx.method === "GET" && id !== undefined && sub === undefined) {
    handleParentRoundGetRequest(ctx, id);
    return true;
  }
  return false;
}
