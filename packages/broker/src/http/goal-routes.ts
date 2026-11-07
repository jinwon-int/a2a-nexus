// Goal and budget routes (#2499, spec docs/specs/goal-budget/spec.md):
//
// POST /goals           create a goal (status `pursuing`)           hub/operator
// GET  /goals           list goals, newest first (?status=&limit=)  read roles
// GET  /goals/:id       one goal plus linked-task counts            read roles
// GET  /budgets/status  spend-ledger totals for a period (slice 2)  read roles
//
// Auth mirrors the wave-plan routes, the closest supervisory record: writes
// are hub/operator only; reads are open to the broader observer set. Both
// apply only when requester identity is enforced, like every other route.
// Read-only projections: no route here creates, requeues, or approves tasks.
//
// Input limits (400 bad_request): a goal id must match GOAL_ID_PATTERN
// (`^[A-Za-z0-9._:-]{1,128}$`, never trimmed) on POST and on GET /goals/:id;
// title <= 200 and objective <= 2000 characters after trimming.
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store/store.js";
import {
  BUDGET_PERIOD_KEY_PATTERN,
  BUDGET_SCOPE_TYPES,
  GOAL_ID_PATTERN,
  GOAL_STATUS_VALUES,
  spendTotalsToJson,
} from "../core/store-schemas.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/transport/request-security.js";
import type {
  A2APartyRole,
  BudgetScopeType,
  GoalBudgetPolicy,
  GoalListFilters,
  GoalStatus,
  SpendScopeTotals,
  SpendTotals,
} from "../core/types.js";
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

/**
 * GET /goals/:id — one goal plus per-status counts of its linked tasks.
 *
 * `linkedTasks` (`{ total, byStatus }`) is a read model over the HOT task
 * table (`broker_tasks.goal_id` on SQLite, the in-memory task map otherwise),
 * not a ledger:
 * - on the worker-thread persistence topology task writes reach SQLite
 *   through the persistence queue while this count reads the main-thread
 *   connection, so a just-created or just-transitioned task can lag;
 * - tasks removed from the hot table by retention (terminal caps, tombstoned
 *   or pruned tasks) are no longer counted.
 * Durable per-goal spend accounting is the spend ledger's job (slice 2).
 */
function handleGet(ctx: GoalRouteContext, goalId: string): void {
  assertRoles(ctx, GOAL_READ_ROLES, "goal.get");
  if (!GOAL_ID_PATTERN.test(goalId)) {
    throw new BrokerError("bad_request", `goal id must match ${GOAL_ID_PATTERN.source}`);
  }
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

/** Agent and lane scope ids: 1-256 characters, no control characters, never trimmed. */
const BUDGET_SCOPE_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/;
/** Bound on scope groups returned per scope type. */
const BUDGET_STATUS_SCOPE_LIMIT = 1_000;

function scopeJson(scope: SpendScopeTotals) {
  // Budgets (and so limits) arrive in slice 3.
  return { scope_type: scope.scopeType, scope_id: scope.scopeId, ...spendTotalsToJson(scope), limits: null };
}

const ZERO_TOTALS: SpendTotals = {
  usdKnownTotal: 0,
  inputTokensTotal: 0n,
  outputTokensTotal: 0n,
  taskCount: 0,
  costUnknownTaskCount: 0,
  unmeteredTaskCount: 0,
};

/**
 * GET /budgets/status?scope_type=agent|lane|goal&scope_id=…&period=YYYY-MM
 * (#2499 slice 2, record only). Totals come from the spend ledger
 * (`broker_spend_events`), one row per terminal task:
 * - `period` defaults to the current `YYYY-MM` in the broker's budget period
 *   time zone (A2A_BUDGET_PERIOD_TIME_ZONE, default Asia/Seoul);
 * - no `scope_type`: per-scope totals for every scope type; `scope_type`
 *   only: every scope of that type; plus `scope_id`: that one scope (zero
 *   totals when it spent nothing). `scope_id` without `scope_type` is 400;
 * - `period_total` is always the whole period (every row, including rows
 *   with no agent or goal), whatever the scope filter; `scope_total` is the
 *   named scope's totals when `scope_type` and `scope_id` are both given
 *   (equal to its one `scopes` entry), else null;
 * - `usd_known_total` sums only rows with a reported cost (Decision 4);
 *   `cost_unknown_task_count` counts the rest; `unmetered_task_count` counts
 *   rows with neither cost nor tokens. Token totals are numbers while
 *   <= Number.MAX_SAFE_INTEGER, else exact decimal strings;
 * - `limits` is null until budgets exist (slice 3);
 * - `ledger` (#2499 slice 3a, additive): `firstPeriod` and `timeZone` from
 *   the ledger coverage metadata, `missingSpendRows` (terminal task rows with
 *   no spend row, live) and `periodComplete` (the period is strictly after
 *   `firstPeriod`);
 * - the spend ledger is SQLite-only: other stores answer `available: false`.
 */
function handleBudgetStatus(ctx: GoalRouteContext): void {
  assertRoles(ctx, GOAL_READ_ROLES, "budget.status");
  const params = ctx.url.searchParams;
  const rawScopeType = params.get("scope_type");
  const scopeId = params.get("scope_id") ?? undefined;
  const rawPeriod = params.get("period");
  let scopeType: BudgetScopeType | undefined;
  if (rawScopeType !== null) {
    if (!(BUDGET_SCOPE_TYPES as readonly string[]).includes(rawScopeType)) {
      throw new BrokerError("bad_request", `scope_type must be one of ${BUDGET_SCOPE_TYPES.join(", ")}`);
    }
    scopeType = rawScopeType as BudgetScopeType;
  }
  if (scopeId !== undefined) {
    if (!scopeType) throw new BrokerError("bad_request", "scope_id requires scope_type");
    const pattern = scopeType === "goal" ? GOAL_ID_PATTERN : BUDGET_SCOPE_ID_PATTERN;
    if (!pattern.test(scopeId)) {
      throw new BrokerError("bad_request", `scope_id must match ${pattern.source}`);
    }
  }
  if (rawPeriod !== null && !BUDGET_PERIOD_KEY_PATTERN.test(rawPeriod)) {
    throw new BrokerError("bad_request", "period must be YYYY-MM");
  }
  const period = rawPeriod ?? ctx.broker.budgetPeriodKey();
  const base = {
    kind: "budget-status",
    period,
    timeZone: ctx.broker.getBudgetPeriodTimeZone(),
    scopeType: scopeType ?? null,
    scopeId: scopeId ?? null,
  };
  const result = ctx.broker.readSpendTotals({
    periodKey: period,
    ...(scopeType ? { scopeType } : {}),
    ...(scopeId !== undefined ? { scopeId } : {}),
    limit: BUDGET_STATUS_SCOPE_LIMIT,
  });
  if (!result) {
    sendJson(
      ctx.res,
      200,
      {
        ...base,
        available: false,
        reason: "the spend ledger requires the SQLite state store",
        period_total: null,
        scope_total: null,
        scopes: [],
      },
      { "cache-control": "no-store" },
    );
    return;
  }
  // #2499 slice 3a: what the ledger covers. `periodComplete` is true only
  // for a period strictly after the one the ledger started recording in
  // (that first period, and any before it, may be partial; `YYYY-MM`
  // compares as a string).
  const coverage = ctx.broker.readSpendLedgerCoverage();
  const ledger = {
    firstPeriod: coverage?.firstPeriod ?? null,
    timeZone: coverage?.timeZone ?? null,
    missingSpendRows: coverage?.missingSpendRows ?? 0,
    periodComplete: coverage?.firstPeriod ? period > coverage.firstPeriod : false,
  };
  const named = scopeType !== undefined && scopeId !== undefined;
  const scopes: SpendScopeTotals[] = scopeType !== undefined && scopeId !== undefined && result.scopes.length === 0
    ? [{ scopeType, scopeId, ...ZERO_TOTALS }]
    : result.scopes;
  sendJson(
    ctx.res,
    200,
    {
      ...base,
      available: true,
      period_total: spendTotalsToJson(result.total),
      scope_total: named && scopes[0] ? spendTotalsToJson(scopes[0]) : null,
      scopes: scopes.map(scopeJson),
      truncated: result.truncated,
      ledger,
    },
    { "cache-control": "no-store" },
  );
}

/** Route dispatcher for the goal and budget routes. Returns true only when handled. */
export async function handleGoalRoutesIfMatched(ctx: GoalRouteContext): Promise<boolean> {
  if (ctx.segments[0] === "budgets") {
    if (ctx.method === "GET" && ctx.segments.length === 2 && ctx.segments[1] === "status") {
      handleBudgetStatus(ctx);
      return true;
    }
    return false;
  }
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
