// Operator broker-cleanup routes (GET /operator/cleanup/plan, POST
// /operator/cleanup/execute), extracted from the server request closure into
// explicit-context handlers (continuing the #645 dispatcher migration). Both
// operate on the SQLite state store directly and require operator role; the
// dispatcher is async because execute reads a JSON body.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError } from "../core/broker-error.js";
import { SqliteBrokerStateStore, type BrokerStateStore } from "../core/store.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/request-security.js";
import {
  buildBrokerCleanupPlan,
  executeBrokerCleanupPlan,
  validateCleanupExecution,
} from "../core/broker-cleanup.js";
import { optionalString } from "../request-parsers.js";
import { cleanupPlanOptionsFromUrl, cleanupPlanOptionsFromBody } from "./request-params.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

export interface OperatorCleanupRouteContext {
  method: string | undefined;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

/** GET /operator/cleanup/plan — dry-run cleanup plan over the SQLite store. */
export function handleOperatorCleanupPlanRequest(ctx: OperatorCleanupRouteContext): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "operator.cleanup.plan");
  }
  if (!(ctx.stateStore instanceof SqliteBrokerStateStore)) {
    throw new BrokerError("bad_request", "broker cleanup planning requires sqlite persistence");
  }
  const plan = buildBrokerCleanupPlan(ctx.stateStore, cleanupPlanOptionsFromUrl(ctx.url));
  sendJson(ctx.res, 200, plan, { "cache-control": "no-store" });
}

/** POST /operator/cleanup/execute — validate and execute a cleanup plan. */
export async function handleOperatorCleanupExecuteRequest(ctx: OperatorCleanupRouteContext): Promise<void> {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, ["hub", "operator"], "operator.cleanup.execute");
  }
  if (!(ctx.stateStore instanceof SqliteBrokerStateStore)) {
    throw new BrokerError("bad_request", "broker cleanup execution requires sqlite persistence");
  }
  const body = await readJson<Record<string, unknown>>(ctx.req);
  const plan = buildBrokerCleanupPlan(ctx.stateStore, cleanupPlanOptionsFromBody(body));
  const executionOptions = {
    approvalToken: optionalString(body?.approvalToken),
    confirmation: optionalString(body?.confirmation),
    backupProof: optionalString(body?.backupProof),
    allowWorkerPrune: body?.allowWorkerPrune === true,
    actorId: ctx.requesterIdentity?.id,
  };
  const blockers = validateCleanupExecution(plan, executionOptions);
  if (blockers.length > 0) {
    sendJson(ctx.res, 409, {
      ok: false,
      error: "cleanup_execution_blocked",
      blockers,
      plan,
    }, { "cache-control": "no-store" });
    return;
  }
  const result = executeBrokerCleanupPlan(ctx.stateStore, plan, executionOptions);
  sendJson(ctx.res, 200, { ok: true, plan, result }, { "cache-control": "no-store" });
}

/** Route dispatcher for operator broker-cleanup routes. Returns true only when handled. */
export async function handleOperatorCleanupRouteIfMatched(
  ctx: OperatorCleanupRouteContext,
): Promise<boolean> {
  if (ctx.method === "GET" && ctx.path === "/operator/cleanup/plan") {
    handleOperatorCleanupPlanRequest(ctx);
    return true;
  }
  if (ctx.method === "POST" && ctx.path === "/operator/cleanup/execute") {
    await handleOperatorCleanupExecuteRequest(ctx);
    return true;
  }
  return false;
}
