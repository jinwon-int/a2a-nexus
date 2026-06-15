// Round-status read route (#629), implemented as an explicit-context handler
// rather than a closure over the server (the #645 phase-3 dispatcher shape):
// the route declares exactly the state it needs, so it is unit-testable in
// isolation and does not capture the whole server scope.

import type { ServerResponse } from "node:http";

import { sendJson } from "./response.js";
import type { RoundStatusSummary } from "../core/round-status.js";

export interface RoundStatusRouteContext {
  res: ServerResponse;
  parentRoundId: string;
  getRoundStatus: (parentRoundId: string) => RoundStatusSummary;
}

/** GET /rounds/:id/status — report A2A/A2AD round completion progress. */
export function handleRoundStatusRequest(ctx: RoundStatusRouteContext): void {
  sendJson(ctx.res, 200, ctx.getRoundStatus(ctx.parentRoundId));
}
