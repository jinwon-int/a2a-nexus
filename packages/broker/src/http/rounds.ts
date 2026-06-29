// Round-status read route (#629), implemented as an explicit-context handler
// rather than a closure over the server (the #645 phase-3 dispatcher shape):
// the route declares exactly the state it needs, so it is unit-testable in
// isolation and does not capture the whole server scope.

import type { ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { sendJson } from "./response.js";
import type { RoundStatusSummary } from "../core/round-status.js";

export interface RoundStatusRouteContext {
  res: ServerResponse;
  /** The raw (still percent-encoded) `:id` path segment. */
  rawParentRoundId: string;
  getRoundStatus: (parentRoundId: string) => RoundStatusSummary;
}

/** GET /rounds/:id/status — report A2A/A2AD round completion progress. */
export function handleRoundStatusRequest(ctx: RoundStatusRouteContext): void {
  let parentRoundId: string;
  try {
    parentRoundId = decodeURIComponent(ctx.rawParentRoundId);
  } catch {
    // A malformed percent-encoded path segment is a client error, not a 500.
    throw new BrokerError("bad_request", "round id path segment is not valid percent-encoding");
  }
  sendJson(ctx.res, 200, ctx.getRoundStatus(parentRoundId));
}

export interface RoundStatusDispatchContext {
  method: string | undefined;
  segments: string[];
  res: ServerResponse;
  broker: InMemoryA2ABroker;
}

/** Route dispatcher for the round-status read route. Returns true only when handled. */
export function handleRoundStatusRouteIfMatched(ctx: RoundStatusDispatchContext): boolean {
  if (
    ctx.method === "GET" &&
    ctx.segments[0] === "rounds" &&
    ctx.segments[1] &&
    ctx.segments[2] === "status" &&
    ctx.segments.length === 3
  ) {
    handleRoundStatusRequest({
      res: ctx.res,
      rawParentRoundId: ctx.segments[1],
      getRoundStatus: (parentRoundId) => ctx.broker.getRoundStatus(parentRoundId),
    });
    return true;
  }
  return false;
}
