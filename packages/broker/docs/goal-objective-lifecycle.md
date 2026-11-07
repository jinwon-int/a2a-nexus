# Goal / Objective Lifecycle

Broker goals are a bounded objective layer above A2A tasks. A goal records *why* a group of tasks exists, how child tasks attach to that objective, and how the broker reports objective progress without starting autonomous retry loops or bypassing task safety gates.

## Data model

The additive broker-side model is defined in `src/core/types.ts`:

- `GoalRecord`: objective, requester, current status, optional budget, child task attachments, status history, and outcome summary.
- `GoalTaskAttachment`: links an A2A task to a goal with an optional role such as `design`, `implementation`, `review`, or `smoke`.
- `GoalStatusEvent`: append-only status/history entry with actor, reason, optional task id, and timestamp.
- `GoalBudgetPolicy`: bounded ceilings (`maxChildAttempts`, `deadlineAt`, `maxResourceUnits`) that can stop pursuit without classifying the work as a failure.

Existing task lineage remains `TaskRecord.parentTaskId`; goal attachments do not replace parent/child task relationships.

### Persistence and task links (#2499 slice 1)

- SQLite stores keep one `broker_goals` row per goal (schema 14). Stores without a goal table (the JSON-file store) carry goals in the snapshot's optional `goals` field; it passes through `brokerSnapshotSchema` and each entry is validated against `goalRecordSchema` on load (an invalid entry is dropped and logged as `broker.snapshot.record_quarantined`).
- If a snapshot that carries `goals` is loaded into a broker whose store has a goal table (for example a JSON state file imported into SQLite), the valid goals are imported into `broker_goals` create-only: an id that already has a row is never overwritten. One `broker.snapshot.goals_imported` warning reports `snapshotGoals`, `imported`, `alreadyPresent` and `quarantined` when anything was imported or quarantined. The canonical snapshot keeps its `goals` until a full save rewrites it, so each restart re-checks them (one primary-key read per goal) and logs nothing when all are present. A failed import does not abort startup: `broker.snapshot.goals_import_failed` is logged and the goals are carried forward in the broker's snapshot so the next start retries. Goals do not move the other way (SQLite to JSON file).
- A `POST /goals` whose state save fails is rolled back in memory: the goal (store without a goal table; SQLite rolls its row back with the batch) and, on every store, its `goal.created` audit event. A retry is not a false 409 and a later save persists neither.
- `POST /goals` (hub/operator) creates a `pursuing` goal and appends a `goal.created` audit event. Goal ids match `^[A-Za-z0-9._:-]{1,128}$`; titles are at most 200 characters and objectives at most 2000.
- A task links to a goal through the optional `TaskRecord.goalId`, validated at create: malformed is 400, unknown is 404, not `pursuing` is 409. Retry tasks inherit the root task's `goalId`.

## Statuses and transitions

| status | meaning | typical next states |
| --- | --- | --- |
| `pursuing` | Objective is active and may attach/observe child tasks within policy. | `paused`, `achieved`, `blocked`, `unmet`, `budget_limited`, `cleared` |
| `paused` | Operator or policy pause; no new child task attachment until resumed. | `pursuing`, `cleared` |
| `achieved` | Objective satisfied by child task outcomes/artifacts. | `cleared` |
| `blocked` | External dependency, safety gate, or failed child prevents progress but may be resolved. | `pursuing`, `unmet`, `cleared` |
| `unmet` | Terminal non-budget outcome: objective not achieved. | `cleared` |
| `budget_limited` | Terminal budget outcome: attempt/time/resource ceiling reached before objective was achieved. | `cleared` |
| `cleared` | Goal hidden/retained only for audit; no active work. | none |

Allowed transition reasons are `operator_requested`, `child_task_progress`, `child_task_terminal`, `dependency_blocked`, `budget_exhausted`, `objective_satisfied`, `objective_not_met`, and `retention_cleared`.

## Child task attachment

A goal attaches child tasks explicitly through `GoalRecord.taskAttachments[]`:

```ts
{
  taskId: "goal-smoke-impl",
  role: "implementation",
  attachedAt: "2026-05-04T00:02:00.000Z"
}
```

The broker should still use `TaskRecord.parentTaskId` for task lineage and fan-out behavior. The goal attachment answers the objective-level question: "which tasks count toward this goal, and in what role?"

## Budget-limited is not failure

`budget_limited` is intentionally separate from `unmet`/task `failed`:

- `budget_limited`: the broker stopped because `GoalBudgetPolicy` was exhausted. Child tasks may have succeeded, remained queued, or been canceled by policy. `GoalRecord.outcome.failed` should be `false` unless there is also an explicit non-budget failure.
- `unmet`: the objective ended because evidence shows the goal cannot or did not meet its success criteria.
- task `failed`: an individual A2A task failed; this may move the goal to `blocked` or `unmet`, but it is not the same as budget exhaustion.

## Read-model / API sketch

A minimal read surface can be projected from `GoalRecord` plus child task status events:

```ts
GET /goals/:goalId
{
  goal: GoalRecord,
  children: TaskRecord[],
  summary: {
    status: GoalStatus,
    attachedTaskCount: number,
    activeTaskCount: number,
    terminalTaskCount: number,
    lastTransition: GoalStatusEvent
  }
}

GET /goals/:goalId/history?afterId=goal-event-12&limit=50
{
  events: GoalStatusEvent[],
  nextCursor?: string
}
```

The summary is a read model only. It must not create child tasks, requeue work, or approve gated work by itself.

### Implemented in slice 1 (#2499)

The shipped `GET /goals/:id` returns `{ goal, linkedTasks: { total, byStatus } }`. The counts are read from the hot task table (`broker_tasks.goal_id` on SQLite, the in-memory task map otherwise), so they are a read model, not a ledger:

- On the worker-thread persistence topology, task writes reach SQLite through the persistence queue while the count reads the main-thread connection, so a just-created or just-transitioned task can lag.
- Tasks removed from the hot table by retention (terminal caps, tombstoned or pruned tasks) are not counted.

`GET /goals` lists goals newest first (`?status=`, `?limit=`). The `children` / `summary` shape and the history route above remain a sketch.

## Spend ledger and budget status (#2499 slices 2, 3a and 3b)

Slices 2 and 3a record spend. Slice 3b adds budgets, the enforcement mode setting and the budget evaluator (see [Budgets](#budgets-2499-slice-3b)); in this slice the evaluator only reports. No claim or create is refused, no listing is filtered and no alert is raised because of spend.

### Ledger rows

Every terminal transition writes one `broker_spend_events` row keyed by `task_id`: completion, failure (including a failure that schedules a retry, and a stale-sweep dead-letter), and cancellation (including cascades and checkpoint expiry). `partial` results are ordinary succeeded results and are recorded the same way. The insert is `INSERT … ON CONFLICT(task_id) DO NOTHING`, so a replayed or repeated terminal write never counts twice. A retry is a new task with its own row.

| column | value |
| --- | --- |
| `recorded_at` | terminal transition time: the first of `cancellation.requestedAt` (canceled tasks only, so a late post never moves the row), `completedAt`, `updatedAt` that parses as a timestamp, else the current time (slice 3b: an unparseable earlier candidate falls through to the next one) |
| `period_key` | `YYYY-MM` of `recorded_at` in the budget period time zone |
| `agent_id` | `claimedBy` (the worker that completed or failed the task), else the worker that held the claim when a cancel cleared `claimedBy`, else `assignedWorkerId`, else NULL (counted in the period total, in no agent scope) |
| `lane` | the task `intent` (`analyze`, `propose_patch`, …): the closed lane vocabulary the broker already indexes, known before claim |
| `goal_id` | `TaskRecord.goalId`, else NULL |
| `cost_usd`, `cost_known` | reported `costUsd`; `cost_known = 1` iff a finite, in-range `costUsd` was reported, else `cost_usd = 0` and `cost_known = 0` |
| `input_tokens` | `inputTokens + cacheCreationInputTokens` (cache-read tokens are not counted) |
| `output_tokens` | `outputTokens` |

Usage is read from `executionTelemetry` (schema `a2a.analysis-execution-telemetry.v1`) on `result.output`, on `error.details.bridgeFailure`, on the same nested under `error.details.nestedError.details` (a wrapped handler exit), or on a preserved negative review verdict. Carrier order: a failed task tries bridgeFailure, nested bridgeFailure, `result.output`, then the negative-verdict output; every other status tries `result.output`, the negative-verdict output, bridgeFailure, then nested bridgeFailure. The first carrier whose telemetry is valid wins; a malformed carrier falls through to the next. This data is unsigned and worker-reported. Every number must be a finite, non-negative number, with `costUsd` at most 1e6 and each token count at most 1e12. A wrong schema version, a non-object or any invalid field makes that carrier's telemetry malformed. When no present carrier is valid, the row is recorded unmetered and one `broker.spend.telemetry_malformed` warning (task id, status, the top carrier's reason code, no values) is logged. When a higher-precedence carrier is malformed and a later one is valid, the row is metered from the later one and one `broker.spend.telemetry_fallback` warning (task id, status, the malformed carrier's reason code, no values) is logged (slice 3a). A row whose `costUsd` is at least half its cap (5e5) or whose input or output token count is at least half its cap (5e11) logs one `broker.spend.near_cap` line per field (task id and field name, no values; slice 3b), at terminal time, on a late metering (`late: true`) and when reconciled (`reconciled: true`). Telemetry never makes a terminal transition fail.

The ledger columns are `NOT NULL DEFAULT 0` (schema 14), so "not reported" is stored as 0, not NULL. A row with `cost_known = 0` and zero tokens is **unmetered** (Codex, Hermes, patch lanes, Piri without a usage marker, cancellations). Rows that report tokens but no cost (Danso) are cost-unknown but not unmetered.

### Durability

Each of the four writers of a terminal status stages the row itself, inside its `commitMutation`, after the terminal task row is set and before `persistState`: `completeTask`, `failTask` (a fail that schedules a retry records the failed attempt; the retry is a new task with its own row), `cancelTaskRecord` (direct cancels, every non-terminal descendant of a cascade, checkpoint expiry, exchange cancels) and the stale-sweep dead-letter. The row is staged in the same save hints as the terminal task row, and the store inserts it in the same transaction:

- In-process SQLite (repositories on write): the task row is upserted at `setTaskRecord` and the spend row is inserted at `persistState`, both inside one `BEGIN IMMEDIATE … COMMIT`. A failing spend insert rolls the terminal task row back.
- Worker-thread persistence: the task row and the spend row travel in the same queued `saveHotEntities` write and commit in one worker-side transaction.

A failing spend insert fails the terminal transition (fail-closed; see the slice 3 preconditions in `docs/specs/goal-budget/tasks.md`). One gap remains: if a save fails after the in-memory transition, the staged row is lost, and a later save can persist the terminal task row without it. Terminal tasks from before slice 2 also have no row. Both are closed by the reconciliation below.

### Late telemetry after a cancel (slice 3a)

A task canceled while running is recorded unmetered. If its worker then posts a late complete or fail (`lateEvidenceAfterCancel`, recorded once per task), the broker reads usage from that late result or error with the same carriers, precedence and validation as a terminal row: a late complete tries the result carriers first, a late fail the failure carriers first. When usage parses, the broker stages a one-time update of the task's spend row in the same `commitMutation` as the late evidence, so it commits in the same store transaction as the task row (one commit in process; one queued write on the worker-thread topology), and logs one `broker.spend.late_metering_staged` line (task id, `kind`, `costKnown`). When late telemetry is present but no carrier parses, nothing is staged and one `broker.spend.telemetry_malformed` line with `late: true` (reason code only) is logged; a fallback logs `broker.spend.telemetry_fallback` with `late: true`.

The store applies the update with one statement:

```sql
UPDATE broker_spend_events SET cost_usd = ?, input_tokens = ?, output_tokens = ?, cost_known = ?
 WHERE task_id = ? AND cost_known = 0 AND input_tokens = 0 AND output_tokens = 0 AND agent_id IS ?
```

So the update applies only to a row that is still unmetered. It applies only once (a later late post is ignored before it reaches the store, and a metered row no longer matches). The late poster must also be the row's `agent_id`, which is the claimant at cancel time. An already metered row is never overwritten. `period_key` and `recorded_at` stay those of the cancel, so the spend stays in the cancel's period. If the row is missing, the update does nothing; the reconciliation creates the row from the task record instead, applying the same late usage under the same conditions. `broker.spend.late_metering_staged` is logged when the update is staged, before the store's guard; the guard decides whether a row changed.

### Reconciliation (slice 3a)

One create-only mechanism repairs lost rows (a dropped staged row) and backfills terminal tasks from before slice 2 that are still in the hot task table. It looks for `broker_tasks` rows with status `succeeded`, `failed` or `canceled` that have no `broker_spend_events` row. The lookup is a `LEFT JOIN` on `task_id`, paged by id 200 at a time, and reads only the id and status columns, never `payload`. Each row is built from the in-memory task record with the terminal-time builder, so `period_key` comes from the terminal time as usual (for a canceled task, the cancel time, even when late evidence arrived in a later month). Telemetry diagnostics are logged per rebuilt row like terminal-time rows (`broker.spend.telemetry_malformed` / `broker.spend.telemetry_fallback` / `broker.spend.near_cap`, with `reconciled: true`), after the page's write was submitted, so a page that fails and is retried later does not log twice (slice 3b). A rebuilt cancel whose late evidence was malformed logs that line with `late: true, reconciled: true`. A canceled task's claimant is not kept on the record, so a rebuilt cancel row is attributed to the assignee. The rows are inserted with `ON CONFLICT(task_id) DO NOTHING` through the store's hints transaction (`saveHotEntities`; the queued write on the worker-thread topology). Ids with no terminal record in memory (for example, rows past the runtime hydration cap) are counted as `unrepairable` and left alone. They are pruned from the hot table at the next full save. Non-terminal tasks never get rows.

The reconciliation runs once at broker startup, after the state load, walking every page from the first id. It then runs once per in-process stale-reaper sweep (`STALE_REAPER_INTERVAL_SEC`), one page per sweep. The sweeps keep a cursor: each continues after the last id the previous sweep read, so a full page of unrepairable ids sorting first cannot pin the sweep to the same page. A page shorter than the page size ends the pass, and the next sweep starts again from the first id. It never fails startup or the sweep: a throw logs `broker.spend.reconcile_failed` (`submitted`, `unrepairable` of the pages completed before the throw, the error message, and `suppressed`: at most one line per 60 s, `suppressed` counting the lines dropped since the last one), and the next sweep retries the same page. Slice 3b: when the same page (same start cursor, page ids known) fails on 3 consecutive periodic sweeps, the cursor moves past it with one `broker.spend.reconcile_page_skipped` line (`firstId`, `lastId`, `ids`, `failures`), so a deterministic failure cannot pin the sweep forever; the next pass tries those ids again. A failure of the listing itself has no page to skip and keeps the cursor. When a periodic run that read several pages throws on a later one, the unrepairable count of the earlier pages stays in the pass total. It logs one `broker.spend.reconciled` line (`submitted`, `unrepairable`, `passEnded`) when rows were submitted, or when a pass ends with a different unrepairable total from the last one logged; with `passEnded: true`, `unrepairable` is the pass total, else this run's count. A stable set of unrepairable ids is therefore logged once per broker process, not on every sweep, and a restart that finds every row present logs nothing. `submitted` counts rows submitted for insert. In process, a failed insert throws into `reconcile_failed`. On the worker-thread topology the insert is a queued write: a rejection is logged by the persistence queue (`[worker-thread-persistence] background write failed`) and the row stays missing, so a later sweep submits it again. A row inserted concurrently is never duplicated.

Retention prunes terminal `broker_tasks` rows but never `broker_spend_events`, so a pruned task keeps its spend row. The reconciliation never sees pruned tasks, so it cannot recreate or duplicate their rows.

### Ledger coverage metadata (slice 3a)

At startup on a store with a spend ledger, the broker writes two keys to `broker_metadata` (no schema change):

- `spend_ledger_first_period`: the current period. It is written once, when absent, and never moved by a later start.
- `spend_ledger_time_zone`: the currently configured zone. Rows written before a change keep their `period_key`. If the stored zone differs from the configured one, the broker logs one `broker.spend.time_zone_changed` warning (`previous`, `current`), stores the new zone, and starts normally.

Both keys are read and written in one transaction. A failure does not stop startup: the broker logs `broker.spend.ledger_metadata_failed` (error message only) and still runs the reconciliation. The first period then reads as null, so no period is reported complete.

### Stores without SQLite

Spend is SQLite-only. Stores without `readSpendTotals` (the JSON-file store and injected snapshot stores) get no rows, and the snapshot shape is unchanged. Keeping one row per task forever in a single snapshot blob that is rewritten on every full save would grow without bound. `GET /budgets/status` reports `available: false` on those stores.

### Period time zone

`A2A_BUDGET_PERIOD_TIME_ZONE` (server option `budgetPeriodTimeZone`) sets the zone for `period_key` and for the default period of the status route. Unset or blank means `Asia/Seoul` (spec Decision 3). The value is canonicalized (`asia/seoul` → `Asia/Seoul`), and a zone `Intl` does not accept fails broker startup. Changing the zone affects new rows only; existing `period_key` values are not rewritten. Change it only at a month boundary: within a month, rows on either side of the change fall into differently aligned buckets. The broker records the zone in store metadata and warns at startup when it changed (`broker.spend.time_zone_changed`, slice 3a); it does not refuse to start.

### `GET /budgets/status`

`GET /budgets/status?scope_type=agent|lane|goal&scope_id=…&period=YYYY-MM` uses the same auth posture as `GET /goals` (hub, operator, analyst, researcher, live-trader when requester identity is enforced).

- `period` defaults to the current period in the configured zone; anything other than `YYYY-MM` (month 01–12) is 400.
- Without `scope_type`, every scope of every type is returned. With `scope_type` only, every scope of that type. With `scope_id` as well, just that scope (zero totals if it spent nothing). A `scope_id` without `scope_type`, an unknown `scope_type`, or a `scope_id` that breaks the goal id pattern (goal scope) or is longer than 256 characters or contains control characters (agent and lane scopes) is 400. Values are never trimmed.
- Each scope reports `usd_known_total` (only `cost_known` rows, Decision 4), `input_tokens_total`, `output_tokens_total`, `task_count`, `cost_unknown_task_count`, `unmetered_task_count`, and `limits`: the scope's month budget (`budgetId`, `limitUsd`, `limitTokens`, `warnPct`, `enforce`), or `null` when it has none (slice 2 always answered `null`; the field name is unchanged).
- `period_total` always covers the whole period, including rows with no agent or goal, whatever the scope filter. `scope_total` is the named scope's totals when `scope_type` and `scope_id` are both given (zero totals if it spent nothing), else null.
- Token totals are summed exactly (SQLite integer `SUM` read as BigInt; USD uses `TOTAL()`). API contract: `input_tokens_total` and `output_tokens_total` are `number | string`. Each is a JSON number while it is at most `Number.MAX_SAFE_INTEGER` (2^53 − 1), else its exact decimal string (for example `"9008000000000005"`), so clients must accept both and parse a string as an arbitrary-precision integer. Every server-side serialization of spend totals goes through one projector (`spendTotalsToJson` in `core/store-schemas.ts`); a raw `SpendTotals` holds `bigint` and cannot be passed to `JSON.stringify`. SQLite's integer sum is exact up to 2^63 − 1, at least about 9.2 million rows at the 1e12 per-row cap in one period.
- `ledger` (slice 3a, additive; present when `available: true`): `firstPeriod` and `timeZone` from the coverage metadata, `missingSpendRows` (terminal task rows with no spend row, counted live with the reconciliation's anti-join; `null` when the store cannot count them or the count failed, and the response is still 200), and `periodComplete` (true only when the requested period is strictly after `firstPeriod`; the first period and earlier ones may be partial). On the worker-thread topology `missingSpendRows` reads the main-thread connection and can lag queued writes, like the other hot-table read models.
- Groups are capped at 1000 per scope type (`truncated: true` when hit). Every query is one indexed aggregate over `broker_spend_events` (`(period_key, agent_id|lane|goal_id)` indexes); no query scans `broker_tasks.payload`.
- Slice 3b, additive:
  - `enforcement`: `{ configuredMode, effectiveMode, reason }` for the requested period (see [Enforcement mode](#enforcement-mode)).
  - `budgets`: the budgets matching the scope filter (at most 200, `budgetsTruncated: true` when there are more), each evaluated against the period: `id`, `scopeType`, `scopeId`, `limitUsd`, `limitTokens`, `warnPct`, `enforce`, `usdSpent` (`cost_known` rows only), `tokensSpent` (input + output; `number | string` like the totals), `usdExhausted`, `tokensExhausted`, `warn` (either limit reached `warnPct` percent; stays true once exhausted). One indexed aggregate per budget.
  - `topRows` (named scope only, else `null`): `{ limit, byCost, byTokens }`, the `top` (1–20, default 5) largest rows of the scope in the period by `cost_usd` (`cost_known` rows only) and by input + output tokens. Each row: `taskId`, `agentId`, `lane`, `goalId`, `costUsd`, `costKnown`, `tokens`, `recordedAt`. `top` without both `scope_type` and `scope_id`, or out of range, is 400. The scope index selects the rows; the order is a sort over that scope's rows (no index on cost or tokens).
  - `checkFailed`: `{ count, lastAt }`, failed budget reads of the claim-time evaluator since startup, kept in memory.
  - A ledger read that throws no longer fails the route: it answers 200 with `available: false`, `readError: "ledger_read_failed"`, null totals, empty `scopes` and `budgets`, `topRows: null`, and the in-memory `enforcement` and `checkFailed` (one `broker.budget.status_read_failed` line per 60 s). Clients tell the two `available: false` cases apart by `readError`.

```json
{
  "kind": "budget-status",
  "period": "2026-11",
  "timeZone": "Asia/Seoul",
  "scopeType": "goal",
  "scopeId": "goal-1",
  "available": true,
  "period_total": { "usd_known_total": 0.75, "input_tokens_total": 240, "output_tokens_total": 80, "task_count": 2, "cost_unknown_task_count": 0, "unmetered_task_count": 0 },
  "scope_total": { "usd_known_total": 0.5, "input_tokens_total": 120, "output_tokens_total": 40, "task_count": 1, "cost_unknown_task_count": 0, "unmetered_task_count": 0 },
  "scopes": [{ "scope_type": "goal", "scope_id": "goal-1", "usd_known_total": 0.5, "input_tokens_total": 120, "output_tokens_total": 40, "task_count": 1, "cost_unknown_task_count": 0, "unmetered_task_count": 0, "limits": null }],
  "truncated": false,
  "ledger": { "firstPeriod": "2026-11", "timeZone": "Asia/Seoul", "missingSpendRows": 0, "periodComplete": false },
  "budgets": [{ "id": "b-goal-1", "scopeType": "goal", "scopeId": "goal-1", "limitUsd": 5, "limitTokens": null, "warnPct": 80, "enforce": "refuse", "usdSpent": 0.5, "tokensSpent": 160, "usdExhausted": false, "tokensExhausted": false, "warn": false }],
  "budgetsTruncated": false,
  "topRows": { "limit": 5, "byCost": [{ "taskId": "task-1", "agentId": "worker-a", "lane": "analyze", "goalId": "goal-1", "costUsd": 0.5, "costKnown": true, "tokens": 160, "recordedAt": "2026-11-06T00:00:00.000Z" }], "byTokens": [{ "taskId": "task-1", "agentId": "worker-a", "lane": "analyze", "goalId": "goal-1", "costUsd": 0.5, "costKnown": true, "tokens": 160, "recordedAt": "2026-11-06T00:00:00.000Z" }] },
  "enforcement": { "configuredMode": "off", "effectiveMode": "off", "reason": "mode_off" },
  "checkFailed": { "count": 0, "lastAt": null }
}
```

(In this example the `limits` of the `goal-1` scope entry would carry `b-goal-1`.)

Spend is per broker. A fleet-wide total is the sum over the Team 1 and Team 2 brokers (cross-broker aggregation is a follow-up).

## Budgets (#2499 slice 3b)

Slice 3b-1 adds budget records, the enforcement mode setting and the evaluator. The claim-time refusal, the queued-listing filter, the create-time `pause` refusal and the goal `budget_limited` transition come in slice 3b-2; until then nothing is refused, whatever the mode.

### Records and routes

One `broker_budgets` row per budget (schema 14 table, no new column). There is one budget per (`scope_type`, `scope_id`, `period`): the broker checks first, inside the insert transaction, and the unique index `broker_budgets_scope_unique_idx` backs it. The index is created by the store's startup DDL (`CREATE UNIQUE INDEX IF NOT EXISTS`, run on every start), so a v14 store created before slice 3b gains it on its next start, with no schema version change. Budgets are SQLite-only, like the ledger.

| route | roles | behaviour |
| --- | --- | --- |
| `POST /budgets` | hub, operator | create; 201 `{ budget }` |
| `PATCH /budgets/:id` | hub, operator | update `limitUsd`, `limitTokens` (`null` clears one; at least one must stay), `warnPct`, `enforce`; 200 `{ budget }` |
| `GET /budgets` | `GET /goals` read roles | `{ kind: "budgets", available, count, budgets }`; `?scope_type=&scope_id=&limit=`; ordered by scope type, scope id, period, id; bounded like the other hot reads |

Create body: `id?`, `scopeType` (`agent | lane | goal`), `scopeId`, `period` (`month` only), `limitUsd?` (finite, > 0, ≤ 1e9), `limitTokens?` (integer, > 0, ≤ `Number.MAX_SAFE_INTEGER`), at least one limit, `warnPct?` (integer 1–100, default 80), `enforce?` (`refuse | pause`, default `refuse`). `id` and `scopeId` match the goal id pattern `^[A-Za-z0-9._:-]{1,128}$` and are never trimmed; an absent `id` is a broker UUID. Unknown fields, wrong types and out-of-range values are 400 (never clamped). A goal scope must name an existing goal (404). A duplicate id or a second budget for the same scope and period is 409 `invalid_transition`. `createdBy` is the authenticated caller. Records are camelCase: `id`, `scopeType`, `scopeId`, `period`, `limitUsd`, `limitTokens`, `warnPct`, `enforce`, `createdBy`, `createdAt`. There is no `updatedAt`: the table has no update-time column; updates are in the audit trail.

Each write appends an audit event (`budget.created`, `budget.updated`; target type `budget`; the update's note lists the changed fields) in the same `commitMutation` as the row, like `goal.created`. In process a failed save rolls the row back and the in-memory audit event is undone. On the worker-thread topology the row commits on the main connection when the call returns (like a goal) and the audit row follows through the persistence queue; the route awaits it.

On a store without SQLite, `POST` and `PATCH` are 409 `unsupported_operation` and `GET /budgets` answers `available: false` with an empty list.

### Enforcement mode

`A2A_BUDGET_ENFORCEMENT_MODE` (server option `budgetEnforcementMode`): `off` (default; unset or blank), `shadow` or `on`, case-insensitive. It is read at startup; **restart the broker to change it**. Any other value fails startup naming the variable. A mode other than `off` on a store without a spend ledger fails startup (spec decision 13).

The effective mode for a period: `off` and `shadow` as configured; `on` runs as `shadow` while the period is not complete (`ledger.periodComplete` false: the period the ledger started in, or unknown coverage), with `reason: "period_incomplete"` (spec decision 9). Reasons: `mode_off`, `mode_shadow`, `mode_on`, `period_incomplete`.

### Evaluator

For a budget and a period: `usdSpent` sums `cost_usd` over the scope's `cost_known` rows; `tokensSpent` sums input + output tokens over all the scope's rows (exact BigInt). `usdExhausted` is `limitUsd` set and `usdSpent ≥ limitUsd`; `tokensExhausted` likewise; `warn` is either limit at `warnPct` percent or more. One indexed aggregate per budget.

The claim-time decision (`evaluateClaimBudget`, implemented and tested, called from claim in slice 3b-2) looks up the month budget of the task's agent, lane and goal scopes and decides per scope:

- a token-exhausted scope refuses any worker;
- a USD-exhausted scope refuses only a worker that reports cost this period (at least one `cost_known` row with its id as `agent_id`; one probe over the `(period_key, agent_id)` index). A runtime that reports no cost is never refused by a USD limit (Decision 4);
- a `pause` budget acts at create time and never refuses at claim.

It returns `wouldRefuse` (some scope would refuse) and `refuse` (`wouldRefuse` in effective mode `on`). A budget read that throws fails open (decision 13): `checkFailed: true`, no refusal, the failure counted in memory (`checkFailed` in budget status) and one `broker.budget.check_failed` line (`workerId`, `count`, error message, `suppressed`) at most every 60 s. Whether repeated failures should downgrade `on` or fail closed is open for slice 3b-2.

## Smoke / golden fixture

`src/fixtures/goal-lifecycle.ts` exports `buildGoalLifecycleSmokeFixture()`. The fixture contains one `budget_limited` goal attached to a parent task and three child tasks (`design`, `implementation`, `smoke`), showing mixed child outcomes without treating budget exhaustion as task failure.

## Non-goals

- No unbounded goal pursuit loop.
- No automatic safety-gate or approval bypass.
- No replacement of existing task status semantics.
