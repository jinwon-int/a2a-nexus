// Goal and budget routes (#2499, spec docs/specs/goal-budget/spec.md):
//
// POST /goals           create a goal (status `pursuing`)           hub/operator
// GET  /goals           list goals, newest first (?status=&limit=)  read roles
// GET  /goals/:id       one goal plus linked-task counts            read roles
// GET  /budgets/status  spend-ledger totals for a period (slice 2)  read roles
// POST /budgets         create a monthly budget (slice 3b)          hub/operator
// PATCH /budgets/:id    update limits / warnPct / enforce (3b)      hub/operator
// GET  /budgets         list budgets (?scope_type=&scope_id=&limit=) read roles
//
// Auth mirrors the wave-plan routes, the closest supervisory record: writes
// are hub/operator only; reads are open to the broader observer set. Both
// apply only when requester identity is enforced, like every other route.
// Read-only projections: no route here creates, requeues, or approves tasks.
//
// Input limits (400 bad_request): a goal id must match GOAL_ID_PATTERN
// (`^[A-Za-z0-9._:-]{1,128}$`, never trimmed) on POST and on GET /goals/:id;
// title <= 200 and objective <= 2000 characters after trimming. Budget ids and
// budget scope ids use the same pattern (#2499 slice 3b).
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store/store.js";
import {
  BUDGET_PERIOD_KEY_PATTERN,
  BUDGET_SCOPE_ID_PATTERN,
  BUDGET_SCOPE_TYPES,
  jsonSafeSpendInteger,
  GOAL_ID_PATTERN,
  GOAL_STATUS_VALUES,
  spendLedgerPeriodComplete,
  spendTotalsToJson,
} from "../core/store-schemas.js";
import { assertRequesterHasRole, type RequesterIdentity } from "../core/transport/request-security.js";
import type {
  A2APartyRole,
  BudgetEvaluation,
  BudgetRecord,
  BudgetScopeType,
  GoalBudgetPolicy,
  GoalListFilters,
  GoalStatus,
  SpendScopeTotals,
  SpendTopRow,
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

/** Bound on scope groups returned per scope type. */
const BUDGET_STATUS_SCOPE_LIMIT = 1_000;

/** Bound on budgets evaluated per status read (one indexed aggregate each). */
const BUDGET_STATUS_BUDGET_LIMIT = 200;
/** Default and maximum `top` rows per order in a named-scope status read. */
const BUDGET_STATUS_TOP_DEFAULT = 5;
const BUDGET_STATUS_TOP_MAX = 20;
/** Maximum `limit` on GET /budgets (#2499 slice 3b-2: the broker's 10 000 budget load cap; default 1000). */
const BUDGET_LIST_LIMIT_MAX = 10_000;

/**
 * Strict positive integer query value (#2499 slice 3b): decimal digits only,
 * no sign, padding, exponent, fraction or hex, at most `max`; else 400.
 */
function strictPositiveIntParam(raw: string, name: string, max: number): number {
  const value = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value > max) {
    throw new BrokerError("bad_request", `${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

/** `limits` of a status scope entry: its month budget, or null (#2499 slice 3b). */
function limitsJson(budget: BudgetRecord | undefined) {
  if (!budget) return null;
  return {
    budgetId: budget.id,
    limitUsd: budget.limitUsd,
    limitTokens: budget.limitTokens,
    warnPct: budget.warnPct,
    enforce: budget.enforce,
  };
}

/** A status scope entry; `limits` from the broker's in-memory map of every budget. */
function scopeJson(scope: SpendScopeTotals, broker: InMemoryA2ABroker) {
  return {
    scope_type: scope.scopeType,
    scope_id: scope.scopeId,
    ...spendTotalsToJson(scope),
    limits: limitsJson(broker.findBudgetForScope(scope.scopeType, scope.scopeId)),
  };
}

/** A top-rows entry; `tokens` is bigint-safe like the totals. */
function topRowJson(row: SpendTopRow) {
  return { ...row, tokens: jsonSafeSpendInteger(row.tokens) };
}

/**
 * Await the queued write of a budget mutation (#2499 slice 3b). On the
 * worker-thread topology the row and its audit commit in that write; if it
 * failed, neither is in SQLite, so the in-memory entry is re-read from the
 * store (dropped or restored) before the error is returned.
 */
async function awaitBudgetWrite(ctx: GoalRouteContext, budgetId: string): Promise<void> {
  // #2499 slice 3b-2: read before awaiting, so a newer queued write of the
  // same budget is not overwritten by this write's resync.
  const generation = ctx.broker.getBudgetWriteGeneration(budgetId);
  try {
    await awaitDurablePersistenceAck(ctx.stateStore);
  } catch (error) {
    try {
      ctx.broker.reloadBudgetFromStore(budgetId, generation);
    } catch {
      // Keep the write failure as the answer; the next restart reloads the map.
    }
    throw error;
  }
}

/** The camelCase budget record (`updatedAt` absent: the table keeps no update time). */
function budgetJson(budget: BudgetRecord) {
  return {
    id: budget.id,
    scopeType: budget.scopeType,
    scopeId: budget.scopeId,
    period: budget.period,
    limitUsd: budget.limitUsd,
    limitTokens: budget.limitTokens,
    warnPct: budget.warnPct,
    enforce: budget.enforce,
    createdBy: budget.createdBy,
    createdAt: budget.createdAt,
  };
}

function budgetEvaluationJson(evaluation: BudgetEvaluation) {
  const { budget } = evaluation;
  return {
    id: budget.id,
    scopeType: budget.scopeType,
    scopeId: budget.scopeId,
    limitUsd: budget.limitUsd,
    limitTokens: budget.limitTokens,
    warnPct: budget.warnPct,
    enforce: budget.enforce,
    usdSpent: evaluation.usdSpent,
    tokensSpent: jsonSafeSpendInteger(evaluation.tokensSpent),
    usdExhausted: evaluation.usdExhausted,
    tokensExhausted: evaluation.tokensExhausted,
    warn: evaluation.warn,
  };
}

const BUDGET_CREATE_FIELDS = new Set(["id", "scopeType", "scopeId", "period", "limitUsd", "limitTokens", "warnPct", "enforce"]);
const BUDGET_UPDATE_FIELDS = new Set(["limitUsd", "limitTokens", "warnPct", "enforce"]);

async function readBudgetBody(ctx: GoalRouteContext, allowed: ReadonlySet<string>, operation: string): Promise<Record<string, unknown>> {
  const body = await readJson<Record<string, unknown>>(ctx.req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BrokerError("bad_request", `${operation} requires a JSON object body`);
  }
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new BrokerError("bad_request", `${operation} has unsupported fields: ${unknown.join(", ")}`);
  }
  return body;
}

function callerId(ctx: GoalRouteContext): string {
  return ctx.requesterIdentity?.id ?? "unidentified";
}

/**
 * POST /budgets (#2499 slice 3b) — create one monthly budget. Values are
 * validated by the broker (400, never trimmed or clamped); a goal scope
 * must exist (404); a duplicate id or scope is 409; `createdBy` is the
 * authenticated caller. A store without the SQLite spend ledger answers 409
 * `unsupported_operation`.
 */
async function handleBudgetCreate(ctx: GoalRouteContext): Promise<void> {
  assertRoles(ctx, GOAL_WRITE_ROLES, "budget.create");
  const body = await readBudgetBody(ctx, BUDGET_CREATE_FIELDS, "budget create");
  const budget = ctx.broker.createBudget({
    ...(body.id !== undefined ? { id: body.id as string } : {}),
    scopeType: body.scopeType as BudgetScopeType,
    scopeId: body.scopeId as string,
    period: body.period as BudgetRecord["period"],
    ...(body.limitUsd !== undefined ? { limitUsd: body.limitUsd as number | null } : {}),
    ...(body.limitTokens !== undefined ? { limitTokens: body.limitTokens as number | null } : {}),
    ...(body.warnPct !== undefined ? { warnPct: body.warnPct as number } : {}),
    ...(body.enforce !== undefined ? { enforce: body.enforce as BudgetRecord["enforce"] } : {}),
    createdBy: callerId(ctx),
  });
  await awaitBudgetWrite(ctx, budget.id);
  sendJson(ctx.res, 201, { budget: budgetJson(budget) }, { "cache-control": "no-store" });
}

/**
 * PATCH /budgets/:id (#2499 slice 3b) — limits (null clears one), warnPct,
 * enforce. Every invalid value is 400 (validated by the broker); an empty
 * `{}` changes nothing and is 400, not a 200 no-op.
 */
async function handleBudgetUpdate(ctx: GoalRouteContext, budgetId: string): Promise<void> {
  assertRoles(ctx, GOAL_WRITE_ROLES, "budget.update");
  if (!GOAL_ID_PATTERN.test(budgetId)) {
    throw new BrokerError("bad_request", `budget id must match ${GOAL_ID_PATTERN.source}`);
  }
  const body = await readBudgetBody(ctx, BUDGET_UPDATE_FIELDS, "budget update");
  const budget = ctx.broker.updateBudget(budgetId, {
    ...(body.limitUsd !== undefined ? { limitUsd: body.limitUsd as number | null } : {}),
    ...(body.limitTokens !== undefined ? { limitTokens: body.limitTokens as number | null } : {}),
    ...(body.warnPct !== undefined ? { warnPct: body.warnPct as number } : {}),
    ...(body.enforce !== undefined ? { enforce: body.enforce as BudgetRecord["enforce"] } : {}),
    actorId: callerId(ctx),
  });
  await awaitBudgetWrite(ctx, budget.id);
  sendJson(ctx.res, 200, { budget: budgetJson(budget) }, { "cache-control": "no-store" });
}

/** Shared scope_type / scope_id query validation (status and list). */
function scopeFiltersFromUrl(url: URL): { scopeType?: BudgetScopeType; scopeId?: string } {
  const rawScopeType = url.searchParams.get("scope_type");
  const scopeId = url.searchParams.get("scope_id") ?? undefined;
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
  return { ...(scopeType ? { scopeType } : {}), ...(scopeId !== undefined ? { scopeId } : {}) };
}

/**
 * GET /budgets (#2499 slice 3b) — budgets ordered by scope type, scope id,
 * period and id, from the broker's in-memory map; `scope_type` / `scope_id`
 * filter, `limit` (strict integer 1..10000, default 1000). Without budgets (non-SQLite store):
 * `available: false` and an empty list, like `GET /budgets/status`.
 */
function handleBudgetList(ctx: GoalRouteContext): void {
  assertRoles(ctx, GOAL_READ_ROLES, "budget.list");
  const filters = scopeFiltersFromUrl(ctx.url);
  const rawLimit = ctx.url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : strictPositiveIntParam(rawLimit, "limit", BUDGET_LIST_LIMIT_MAX);
  const budgets = ctx.broker.listBudgets({ ...filters, ...(limit !== undefined ? { limit } : {}) });
  if (!budgets) {
    sendJson(
      ctx.res,
      200,
      { kind: "budgets", available: false, reason: "budgets require the SQLite state store", count: 0, budgets: [] },
      { "cache-control": "no-store" },
    );
    return;
  }
  sendJson(
    ctx.res,
    200,
    { kind: "budgets", available: true, count: budgets.length, budgets: budgets.map(budgetJson) },
    { "cache-control": "no-store" },
  );
}

/**
 * #2499 slice 3b-2: a failed ledger read, classified by error type: a SQLite
 * error (`code` ERR_SQLITE_*, which includes an integer overflow, decision
 * 13). Any other throw is not a ledger read failure.
 */
function isLedgerReadError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof Error && typeof code === "string" && code.startsWith("ERR_SQLITE");
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
 * GET /budgets/status?scope_type=agent|lane|goal&scope_id=…&period=YYYY-MM&top=N
 * (#2499 slice 2, record only; slice 3b adds budgets). Totals come from the
 * spend ledger (`broker_spend_events`), one row per terminal task:
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
 * - `limits` on each `scopes` entry (slice 3b): that scope's month budget
 *   (`budgetId`, `limitUsd`, `limitTokens`, `warnPct`, `enforce`), or null
 *   when it has none (slice 2 always answered null);
 * - `ledger` (#2499 slice 3a, additive): `firstPeriod` and `timeZone` from
 *   the ledger coverage metadata, `missingSpendRows` (terminal task rows with
 *   no spend row, live; null when the store cannot count them or the count
 *   failed) and `periodComplete` (the period is strictly after `firstPeriod`);
 * - slice 3b, additive:
 *   - `enforcement` `{ configuredMode, effectiveMode, reason }` for the
 *     period (`on` runs as `shadow` while `periodComplete` is false);
 *   - `budgets`: the budgets matching the scope filter (at most
 *     BUDGET_STATUS_BUDGET_LIMIT, `budgetsTruncated` when more) evaluated
 *     against the period: `usdSpent`, `tokensSpent` (number or decimal
 *     string, like the totals), `usdExhausted`, `tokensExhausted`, `warn`.
 *     `limits` on the scope entries comes from all budgets, not this list;
 *   - `topRows` for a named scope: `{ limit, byCost, byTokens }`, the N
 *     largest rows of the scope in the period (`top`, strict integer 1..20,
 *     default 5; `top` without a named scope is 400); null otherwise;
 *     `tokens` is a number or decimal string like the totals;
 *   - `checkFailed` `{ count, lastAt, consecutive }`: failed budget reads since startup
 *     (claim-time evaluator and enforcement-mode metadata), from memory. A
 *     ledger read that throws still answers 200 with `available: true`,
 *     `readError: "ledger_read_failed"`, null totals and `ledger`, empty
 *     `scopes`/`budgets`, and the in-memory `enforcement` and `checkFailed`
 *     (`available: false` keeps meaning "no SQLite ledger");
 * - slice 3b-2, additive, from memory: `consecutive` in `checkFailed`
 *   (failures since the last successful budget read); `claims`
 *   `{ refusedTotal, wouldRefuseTotal, lastAt }`, `listing`
 *   `{ omittedTotal, lastOmittedAt, lastOmittedCount, wouldOmitTotal }`, `creates`
 *   `{ refusedTotal, wouldRefuseTotal, lastAt }` and `goals`
 *   `{ limitedTotal, resumedTotal, wouldLimitTotal, lastAt }`
 *   since startup (`listing` also `lastOmittedCount`). Only a SQLite read
 *   error (ERR_SQLITE_*) is `ledger_read_failed` (`budgetsTruncated: null`,
 *   so the field is boolean | null); any other error is mapped as usual;
 * - the spend ledger is SQLite-only: other stores answer `available: false`.
 */
function handleBudgetStatus(ctx: GoalRouteContext): void {
  assertRoles(ctx, GOAL_READ_ROLES, "budget.status");
  const params = ctx.url.searchParams;
  const { scopeType, scopeId } = scopeFiltersFromUrl(ctx.url);
  const rawPeriod = params.get("period");
  if (rawPeriod !== null && !BUDGET_PERIOD_KEY_PATTERN.test(rawPeriod)) {
    throw new BrokerError("bad_request", "period must be YYYY-MM");
  }
  const named = scopeType !== undefined && scopeId !== undefined;
  const rawTop = params.get("top");
  let top = BUDGET_STATUS_TOP_DEFAULT;
  if (rawTop !== null) {
    if (!named) throw new BrokerError("bad_request", "top requires scope_type and scope_id");
    top = strictPositiveIntParam(rawTop, "top", BUDGET_STATUS_TOP_MAX);
  }
  const period = rawPeriod ?? ctx.broker.budgetPeriodKey();
  const base = {
    kind: "budget-status",
    period,
    timeZone: ctx.broker.getBudgetPeriodTimeZone(),
    scopeType: scopeType ?? null,
    scopeId: scopeId ?? null,
  };
  // Served from memory (plus one metadata lookup; getBudgetEnforcement never
  // throws and counts a failed lookup in checkFailed, so read it first).
  // #2499 slice 3b-2: the enforcement counters (`claims`, `listing`,
  // `creates`, `goals`) are served from memory too.
  const live = {
    enforcement: ctx.broker.getBudgetEnforcement(period),
    checkFailed: ctx.broker.getBudgetCheckFailures(),
    ...ctx.broker.getBudgetEnforcementCounters(),
  };
  const empty = (marker: Record<string, unknown>) => {
    sendJson(
      ctx.res,
      200,
      {
        ...base,
        ...marker,
        period_total: null,
        scope_total: null,
        scopes: [],
        budgets: [],
        topRows: null,
        ...live,
      },
      { "cache-control": "no-store" },
    );
  };
  const noLedger = { available: false, reason: "the spend ledger requires the SQLite state store" };
  if (!ctx.broker.hasSpendLedger()) {
    empty(noLedger);
    return;
  }
  // #2499 slice 3b-2: only a SQLite read error (isLedgerReadError), from
  // any read in this block, is `ledger_read_failed`; a BrokerError keeps its
  // mapping and any other throw (a programming error) is a 500.
  let body: Record<string, unknown>;
  try {
    const result = ctx.broker.readSpendTotals({
      periodKey: period,
      ...(scopeType ? { scopeType } : {}),
      ...(scopeId !== undefined ? { scopeId } : {}),
      limit: BUDGET_STATUS_SCOPE_LIMIT,
    });
    if (!result) {
      empty(noLedger);
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
      missingSpendRows: coverage ? coverage.missingSpendRows : null,
      periodComplete: spendLedgerPeriodComplete(period, coverage?.firstPeriod),
    };
    const scopes: SpendScopeTotals[] = named && result.scopes.length === 0
      ? [{ scopeType: scopeType!, scopeId: scopeId!, ...ZERO_TOTALS }]
      : result.scopes;
    // #2499 slice 3b: budgets for the scope filter, evaluated against the
    // period (one indexed aggregate each, bounded).
    const listed = ctx.broker.listBudgets({
      ...(scopeType ? { scopeType } : {}),
      ...(scopeId !== undefined ? { scopeId } : {}),
      limit: BUDGET_STATUS_BUDGET_LIMIT + 1,
    }) ?? [];
    const budgetsTruncated = listed.length > BUDGET_STATUS_BUDGET_LIMIT;
    const budgets = listed.slice(0, BUDGET_STATUS_BUDGET_LIMIT);
    const topSpend = named && ctx.broker.hasBudgets()
      ? ctx.broker.listTopSpendRows({ periodKey: period, scopeType: scopeType!, scopeId: scopeId!, limit: top })
      : undefined;
    const topRows = topSpend ? { limit: top, byCost: topSpend.byCost.map(topRowJson), byTokens: topSpend.byTokens.map(topRowJson) } : null;
    body = {
      ...base,
      available: true,
      period_total: spendTotalsToJson(result.total),
      scope_total: named && scopes[0] ? spendTotalsToJson(scopes[0]) : null,
      scopes: scopes.map((scope) => scopeJson(scope, ctx.broker)),
      truncated: result.truncated,
      ledger,
      budgets: budgets.map((budget) => budgetEvaluationJson(ctx.broker.evaluateBudget(budget, period))),
      budgetsTruncated,
      topRows,
      ...live,
    };
  } catch (error) {
    if (!isLedgerReadError(error)) throw error;
    // The ledger exists (available stays true); the read failed.
    ctx.broker.noteBudgetStatusReadFailure(error);
    // `budgetsTruncated` is unknown when the read failed (null, like the totals).
    empty({ available: true, readError: "ledger_read_failed", ledger: null, budgetsTruncated: null });
    return;
  }
  sendJson(ctx.res, 200, body, { "cache-control": "no-store" });
}

/** Route dispatcher for the goal and budget routes. Returns true only when handled. */
export async function handleGoalRoutesIfMatched(ctx: GoalRouteContext): Promise<boolean> {
  if (ctx.segments[0] === "budgets") {
    if (ctx.segments.length === 1) {
      if (ctx.method === "POST") {
        await handleBudgetCreate(ctx);
        return true;
      }
      if (ctx.method === "GET") {
        handleBudgetList(ctx);
        return true;
      }
      return false;
    }
    if (ctx.segments.length !== 2) return false;
    if (ctx.method === "GET" && ctx.segments[1] === "status") {
      handleBudgetStatus(ctx);
      return true;
    }
    if (ctx.method === "PATCH") {
      await handleBudgetUpdate(ctx, ctx.segments[1]!);
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
