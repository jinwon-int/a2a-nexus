// Goal routes (#2499 slice 1, spec docs/specs/goal-budget/spec.md):
//
// POST /goals       create a goal (status `pursuing`)           hub/operator
// GET  /goals       list goals, newest first (?status=&limit=)  read roles
// GET  /goals/:id   one goal plus linked-task counts            read roles
//
// Auth mirrors the wave-plan routes, the closest supervisory record: writes
// are hub/operator only; reads are open to the broader observer set. Both
// apply only when requester identity is enforced, like every other route.
// Read-only projections: no route here creates, requeues, or approves tasks.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store/store.js";
import { GOAL_STATUS_VALUES } from "../core/store-schemas.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/transport/request-security.js";
import type { A2APartyRole, GoalBudgetPolicy, GoalListFilters, GoalStatus } from "../core/types.js";
import { awaitDurablePersistenceAck } from "./error-mapping.js";
import { readJson } from "./body.js";
import { sendJson } from "./response.js";

const GOAL_WRITE_ROLES = ["hub", "operator"] as const;
const GOAL_READ_ROLES = ["hub", "operator", "analyst", "researcher", "live-trader"] as const;

export interface GoalRouteContext {
  method: string | undefined;
  segments: string[];
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  broker: InMemoryA2ABroker;
  stateStore: BrokerStateStore;
  enforceRequesterIdentity: boolean;
  requesterIdentity: RequesterIdentity | null;
}

function assertRoles(ctx: GoalRouteContext, roles: readonly A2APartyRole[], operation: string): void {
  if (ctx.enforceRequesterIdentity) {
    assertRequesterHasRole(ctx.requesterIdentity, [...roles], operation);
  }
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BrokerError("bad_request", `${field} must be a string`);
  return value;
}

/** Only the GoalBudgetPolicy fields are accepted; the record schema checks their values. */
function pickBudget(value: unknown): GoalBudgetPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("bad_request", "budget must be an object");
  }
  const allowed = new Set(["maxChildAttempts", "deadlineAt", "maxResourceUnits"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new BrokerError("bad_request", `budget has unsupported fields: ${unknown.join(", ")}`);
  }
  return value as GoalBudgetPolicy;
}

/** POST /goals — create a goal. The requester is the authenticated caller. */
async function handleCreate(ctx: GoalRouteContext): Promise<void> {
  assertRoles(ctx, GOAL_WRITE_ROLES, "goal.create");
  const body = await readJson<Record<string, unknown>>(ctx.req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BrokerError("bad_request", "goal create requires a JSON object body");
  }
  const title = optionalString(body, "title");
  if (!title) throw new BrokerError("bad_request", "title is required");
  const identity = ctx.requesterIdentity;
  const goal = ctx.broker.createGoal({
    id: optionalString(body, "id"),
    title,
    objective: optionalString(body, "objective"),
    requester: identity
      ? {
          id: identity.id,
          ...(identity.kind ? { kind: identity.kind } : {}),
          ...(identity.role ? { role: identity.role } : {}),
        }
      : { id: "unidentified" },
    budget: pickBudget(body.budget),
  });
  await awaitDurablePersistenceAck(ctx.stateStore);
  sendJson(ctx.res, 201, { goal }, { "cache-control": "no-store" });
}

function listFiltersFromUrl(url: URL): GoalListFilters {
  const filters: GoalListFilters = {};
  const status = url.searchParams.get("status");
  if (status !== null) {
    if (!(GOAL_STATUS_VALUES as readonly string[]).includes(status)) {
      throw new BrokerError("bad_request", `status must be one of ${GOAL_STATUS_VALUES.join(", ")}`);
    }
    filters.status = status as GoalStatus;
  }
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BrokerError("bad_request", "limit must be a positive integer");
    }
    filters.limit = parsed;
  }
  return filters;
}

/** GET /goals — list goals, newest first. */
function handleList(ctx: GoalRouteContext): void {
  assertRoles(ctx, GOAL_READ_ROLES, "goal.list");
  const goals = ctx.broker.listGoals(listFiltersFromUrl(ctx.url));
  sendJson(ctx.res, 200, { kind: "goals", count: goals.length, goals }, { "cache-control": "no-store" });
}

/** GET /goals/:id — one goal plus per-status counts of its linked tasks. */
function handleGet(ctx: GoalRouteContext, goalId: string): void {
  assertRoles(ctx, GOAL_READ_ROLES, "goal.get");
  const goal = ctx.broker.getGoal(goalId);
  if (!goal) {
    throw new BrokerError("not_found", "goal not found", { goalId });
  }
  const byStatus = ctx.broker.countGoalTasksByStatus(goalId);
  const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  sendJson(
    ctx.res,
    200,
    { goal, linkedTasks: { total, byStatus } },
    { "cache-control": "no-store" },
  );
}

/** Route dispatcher for the goal routes. Returns true only when handled. */
export async function handleGoalRoutesIfMatched(ctx: GoalRouteContext): Promise<boolean> {
  const [resource, id, ...rest] = ctx.segments;
  if (resource !== "goals" || rest.length > 0) return false;
  if (id === undefined) {
    if (ctx.method === "POST") {
      await handleCreate(ctx);
      return true;
    }
    if (ctx.method === "GET") {
      handleList(ctx);
      return true;
    }
    return false;
  }
  if (ctx.method === "GET") {
    handleGet(ctx, id);
    return true;
  }
  return false;
}
