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
| `budget_limited` | Budget outcome: attempt/time/resource ceiling reached before objective was achieved. A goal limited by a monthly spend budget returns to `pursuing` when that budget is no longer exhausted (#2499 slice 3b-2, see [Goal budget limits](#goal-budget-limits-slice-3b-2)). | `pursuing` (spend budget only), `cleared` |
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

Slices 2 and 3a record spend. Slice 3b-1 adds budgets, the enforcement mode setting and the budget evaluator (see [Budgets](#budgets-2499-slice-3b)). Slice 3b-2 adds the refusal hooks: claim refusal, the worker queued-listing filter, the create-time `pause` refusal and goal budget limits (see [Enforcement hooks](#enforcement-hooks-slice-3b-2)). Slice 4 adds the `budget_warn` and `budget_exhausted` operator alerts (see [Budget alerts](#budget-alerts-slice-4)). Operator procedures (create, inspect, raise a limit, switch the mode, roll back) are in the [spend budget runbook](spend-budget-runbook.md).

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

The reconciliation runs once at broker startup, after the state load, walking every page from the first id. It then runs once per in-process stale-reaper sweep (`STALE_REAPER_INTERVAL_SEC`), one page per sweep. The sweeps keep a cursor: each continues after the last id the previous sweep read, so a full page of unrepairable ids sorting first cannot pin the sweep to the same page. A page shorter than the page size ends the pass, and the next sweep starts again from the first id. It never fails startup or the sweep: a throw logs `broker.spend.reconcile_failed` (`submitted`, `unrepairable` of the pages completed before the throw, the error message, and `suppressed`: at most one line per 60 s, `suppressed` counting the lines dropped since the last one), and the next sweep retries the same page. Slice 3b: when a page's write failed (a failure of the listing itself does not count), the next periodic sweep retries that page row by row: each row is its own write, a row whose write fails is skipped with a `broker.spend.reconcile_row_skipped` line (`taskId`, error message, `suppressed`; at most one line per 60 s) and the cursor then moves past the page, so one bad row cannot pin the sweep; a skipped row is tried again on the next pass. When a periodic run that read several pages throws on a later one, the unrepairable count of the earlier pages stays in the pass total. It logs one `broker.spend.reconciled` line (`submitted`, `unrepairable`, `passEnded`, and `rowsSkipped` when a row-by-row retry skipped rows) when rows were submitted or skipped, or when a pass ends with a different unrepairable total from the last one logged; with `passEnded: true`, `unrepairable` is the pass total, else this run's count. A stable set of unrepairable ids is therefore logged once per broker process, not on every sweep, and a restart that finds every row present logs nothing. `submitted` counts rows submitted for insert. In process, a failed insert throws into `reconcile_failed`. On the worker-thread topology the insert is a queued write: a rejection is logged by the persistence queue (`[worker-thread-persistence] background write failed`) and the row stays missing, so a later sweep submits it again. A row inserted concurrently is never duplicated.

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
  - `topRows` (named scope only, else `null`): `{ limit, byCost, byTokens }`, the `top` (1–20, default 5) largest rows of the scope in the period by `cost_usd` (`cost_known` rows only) and by input + output tokens. Each row: `taskId`, `agentId`, `lane`, `goalId`, `costUsd`, `costKnown`, `tokens` (`number | string` like the totals), `recordedAt`. `top` must be a plain decimal integer (`^[1-9][0-9]*$`, so not ` 5`, `0x5`, `1e1` or `5.0`) of at most 20; otherwise, or without both `scope_type` and `scope_id`, it is 400. The scope index selects the rows; the order is a sort over that scope's rows (no index on cost or tokens).
  - `checkFailed`: `{ count, lastAt, consecutive }`, failed budget reads since startup (the claim-time evaluator, the listing filter, the create-time and goal checks, the budget alert evaluation (slice 4), and the enforcement-mode metadata lookup), kept in memory. `consecutive` (slice 3b-2) is the run of failures since the last successful budget evaluation; it resets to 0 then (`count` does not).
  - Slice 3b-2, from memory: `claims` `{ refusedTotal, wouldRefuseTotal, lastAt }`, `listing` `{ omittedTotal, lastOmittedAt, lastOmittedCount, wouldOmitTotal }`, `creates` `{ refusedTotal, wouldRefuseTotal, lastAt }` and `goals` `{ limitedTotal, resumedTotal, wouldLimitTotal, lastAt }`, counted since startup (see [Enforcement hooks](#enforcement-hooks-slice-3b-2)). `listing.omittedTotal` and `wouldOmitTotal` count per listing evaluation, so they grow with poll frequency (a held long poll re-evaluates on every wake, and SSE live events count one each); `lastOmittedCount` is the omitted count of the latest poll or snapshot.
  - `budgetsTruncated` is `boolean | null`: `null` only on the `ledger_read_failed` answer (unknown; slice 3b-1 answered `false` there).
  - `limits` on the `scopes` entries is looked up in the broker's in-memory map of every budget, so it does not depend on the 200-entry `budgets` cap (`budgetsTruncated` is about the `budgets` array only).
  - A ledger read that throws no longer fails the route: it answers 200 with `available: true` (the ledger exists), `readError: "ledger_read_failed"`, null totals and `ledger`, empty `scopes` and `budgets`, `topRows: null`, `budgetsTruncated: null` (slice 3b-2: unknown, not `false`), and the in-memory `enforcement`, `checkFailed` and counters (one `broker.budget.status_read_failed` line per 60 s). `available: false` keeps meaning "no SQLite ledger". Slice 3b-2: the failure is classified by error type, not by call site: only a SQLite error (`code` `ERR_SQLITE_*`, which includes an integer overflow) is `ledger_read_failed`; a `BrokerError` keeps its mapping and any other throw (a programming error) is a 500.

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
  "checkFailed": { "count": 0, "lastAt": null, "consecutive": 0 },
  "claims": { "refusedTotal": 0, "wouldRefuseTotal": 0, "lastAt": null },
  "listing": { "omittedTotal": 0, "lastOmittedAt": null, "lastOmittedCount": 0, "wouldOmitTotal": 0 },
  "creates": { "refusedTotal": 0, "wouldRefuseTotal": 0, "lastAt": null },
  "goals": { "limitedTotal": 0, "resumedTotal": 0, "wouldLimitTotal": 0, "lastAt": null }
}
```

(In this example the `limits` of the `goal-1` scope entry would carry `b-goal-1`.)

Spend is per broker. A fleet-wide total is the sum over the Team 1 and Team 2 brokers (cross-broker aggregation is a follow-up).

## Budgets (#2499 slice 3b)

Slice 3b-1 adds budget records, the enforcement mode setting and the evaluator. Slice 3b-2 adds the claim-time refusal, the queued-listing filter, the create-time `pause` refusal and the goal `budget_limited` transition ([Enforcement hooks](#enforcement-hooks-slice-3b-2)).

### Records and routes

One `broker_budgets` row per budget (schema 14 table, no new column). The broker keeps every budget in memory (by id and by scope and period), loaded once at startup (one `broker.budget.loaded` line with the count; more than 10 000 rows refuses startup, and a failed read fails startup). That map is the source for `GET /budgets`, budget status and the evaluator, and the duplicate check: there is one budget per (`scope_type`, `scope_id`, `period`), and because the broker is single-threaded the check cannot lag a queued write, so two creates for the same scope in quick succession are 201 then 409 on both topologies. The unique index `broker_budgets_scope_unique_idx` is the backstop (a row written behind the broker's back makes the conflicting create fail and roll back). The index is created by the store's startup DDL (`CREATE UNIQUE INDEX IF NOT EXISTS`, run on every start), so a v14 store created before slice 3b gains it on its next start, with no schema version change. Budgets are SQLite-only, like the ledger.

| route | roles | behaviour |
| --- | --- | --- |
| `POST /budgets` | hub, operator | create; 201 `{ budget }` |
| `PATCH /budgets/:id` | hub, operator | update `limitUsd`, `limitTokens` (`null` clears one; at least one must stay), `warnPct`, `enforce`; 200 `{ budget }` |
| `GET /budgets` | `GET /goals` read roles | `{ kind: "budgets", available, count, budgets }`; `?scope_type=&scope_id=&limit=` (`limit`: plain decimal integer 1–10 000, the startup load cap; default 1000; slice 3b-2 raised the maximum from 1000); ordered by scope type, scope id, period, id |

Create body: `id?`, `scopeType` (`agent | lane | goal`), `scopeId`, `period` (`month` only), `limitUsd?` (finite, > 0, ≤ 1e9), `limitTokens?` (integer, > 0, ≤ `Number.MAX_SAFE_INTEGER`), at least one limit, `warnPct?` (integer 1–100, default 80), `enforce?` (`refuse | pause`, default `refuse`). `id` matches the goal id pattern `^[A-Za-z0-9._:-]{1,128}$`; a goal `scopeId` matches it too, and agent and lane `scopeId`s use the pattern the ledger and the status/list filters accept (1–256 characters, no control characters), since worker ids and intents are stored as reported. None is trimmed; an absent `id` is a broker UUID. Unknown fields, wrong types (every id and enum field must be a string) and out-of-range values are 400 (never clamped). `PATCH` validates the same way; an empty `{}` is 400 (`budget update changes nothing`), not a no-op. A caller without identity, or with a read-only role, gets 401 on `POST` and `PATCH`. A goal scope must name an existing goal (404). A duplicate id or a second budget for the same scope and period is 409 `invalid_transition`. `createdBy` is the authenticated caller. Records are camelCase: `id`, `scopeType`, `scopeId`, `period`, `limitUsd`, `limitTokens`, `warnPct`, `enforce`, `createdBy`, `createdAt`. There is no `updatedAt`: the table has no update-time column; updates are in the audit trail.

Each write appends an audit event (`budget.created`, `budget.updated`; target type `budget`; the update's note lists the changed fields). The row travels in the save hints (`BrokerStateSaveHints.budgets`, upserted by id inside both save transactions), so the row and its audit event commit in one store transaction: the `commitMutation` batch in process (one commit), the same queued write on the worker-thread topology. A write that throws undoes the in-memory map entry, the staged row and the audit event; in process SQLite rolls both rows back. On the worker-thread topology a failed queued write leaves neither row in SQLite; the route's durable-ack wait reports it, and the route re-reads that budget from the store (dropping or restoring the in-memory entry) before answering with the error. Slice 3b-2: every budget write still in the persistence queue is remembered (its generation, its audit event and the record it wrote) until its queued save settles. Slice 4: the write a call queued is the store's latest queued write only when it differs from the one seen before the call, and the store forgets its latest queued write once that write settles, so an earlier call's write is never attributed to a later one; the "did it land" comparison treats an absent limit and `null` as equal. The failed write's in-memory `budget.*` audit event is removed when the stored row is not the record it produced (compared field by field), also when a newer write of the same budget is still queued; the in-memory record is re-read only when no newer write is queued (that write's own route re-reads if it fails). A rollback restores a row staged by an earlier, not yet flushed write instead of dropping it. Budget reads (`getBudget`, `findBudgetForScope`, `listBudgets`, and the create/update results) return copies of the in-memory records.

Budget audit events are the only change history of a budget, so no audit retention path prunes them: the in-memory retention selector, the SQLite retention planner, the audit-repository cap prune and the full-save mirror prune all exempt `target_type = 'budget'` with action `budget.created` or `budget.updated` (including rows not hydrated at startup). They grow only with operator budget writes.

On a store without SQLite, `POST` and `PATCH` are 409 `unsupported_operation` and `GET /budgets` answers `available: false` with an empty list.

### Enforcement mode

`A2A_BUDGET_ENFORCEMENT_MODE` (server option `budgetEnforcementMode`): `off` (default; unset or blank), `shadow` or `on`, case-insensitive. It is read at startup; **restart the broker to change it**. Any other value fails startup naming the variable. A mode other than `off` on a store without a spend ledger fails startup (spec decision 13). A server given an injected broker whose mode differs from the configured one fails startup instead of ignoring the setting; the message names where the configured value came from (the server option, the variable, or the default).

The effective mode for a period: `off` and `shadow` as configured; `on` runs as `shadow` while the period is not complete (`ledger.periodComplete` false: the period the ledger started in, or unknown coverage), with `reason: "period_incomplete"` (spec decision 9). Reasons: `mode_off`, `mode_shadow`, `mode_on`, `period_incomplete`. The period test is the same function as `ledger.periodComplete`. If the stored first period cannot be read, the period counts as incomplete and the failure is counted in `checkFailed` with a `broker.budget.check_failed` line (`source: "enforcement"`); the lookup never fails the caller.

### Evaluator

For a budget and a period: `usdSpent` sums `cost_usd` over the scope's `cost_known` rows; `tokensSpent` sums input + output tokens over all the scope's rows (exact BigInt). `usdExhausted` is `limitUsd` set and `usdSpent ≥ limitUsd`; `tokensExhausted` likewise; `warn` is either limit at `warnPct` percent or more. One indexed aggregate per budget.

The claim-time decision (`evaluateClaimBudget({ workerId, lane, goalId })`, called from claim and the listing filter since slice 3b-2) takes the claiming worker as `workerId`, which is both the agent scope key and the cost-reporting probe (the ledger's `agent_id` is the worker that did the work). It looks up the month budget of the agent, lane and goal scopes (in memory) and decides per scope:

- a token-exhausted scope refuses any worker;
- a USD-exhausted scope refuses only a worker that reports cost this period (at least one `cost_known` row with its id as `agent_id`; one probe over the `(period_key, agent_id)` index). A runtime that reports no cost is never refused by a USD limit (Decision 4);
- a `pause` budget acts at create time and never refuses at claim.

It returns `wouldRefuse` (some scope would refuse) and `refuse` (`wouldRefuse` in effective mode `on`). A budget read that throws fails open (decision 13): `checkFailed: true`, no refusal, the failure counted in memory (`checkFailed` in budget status) and one `broker.budget.check_failed` line (`source`: `claim`, `create`, `goal`, `alert` (slice 4) or `enforcement`; `workerId` when known; `count`, error message, `suppressed`) at most every 60 s. A failed enforcement-metadata read is a check failure as well (slice 3b-2). Repeated failures do not change the mode: enforcement stays fail-open (decided in slice 3b-2), and `checkFailed.consecutive` shows a run of failures so an operator can act on it. Slice 4 does not add an alert for `checkFailed`: a failing alert read keeps the budget's previous alert state, and the count stays visible in status.

### Enforcement hooks (slice 3b-2)

Nothing below reads a budget in mode `off`, or when no budget exists for the task's scopes (an in-memory lookup). Every decision in effective `shadow` (configured `shadow`, or `on` while the period is incomplete) is counted and logged but never refuses, omits or limits a goal. Every log line is one JSON line with ids and reason codes only, at most one per 60 s per event name (`suppressed` counts the dropped ones). A failed budget read fails open and is counted in `checkFailed`; within one listing (or one filter) a scope whose read failed is not read again and counted once.

- **Claim** (`claimTask`, after the status check and before any mutation; every claim entry point goes through it: `POST /tasks/:id/claim`, its lease-gated variant (the granted lease is released on a refusal), the JSON-RPC default-agent inline claim and the in-process default agent). Effective `on` with a refusing scope (as decided by the evaluator above): `policy_denied` (HTTP 403, JSON-RPC -32012) with `details.reason: "budget_exhausted"`, `details.periodKey` and `details.scopes` (`budgetId`, `scopeType`, `scopeId`, `enforce`, `reason` `tokens_exhausted | usd_exhausted`, `usdExhausted`, `tokensExhausted`). The task stays `queued` and unclaimed, with no `task.claimed` event. Counted in `claims.refusedTotal`, logged as `broker.budget.claim_refused` (`taskId`, `workerId`, `scopes`: budget ids). Shadow: `claims.wouldRefuseTotal`, `broker.budget.would_refuse`. Under the lease flag the granted lease is released when the claim is refused. JSON-RPC `SendMessage` decides the budget before it creates anything: the create-time `pause` decision for the task it would create and, for a default-agent convention claimed inline, the claim decision; a refusal is -32012 with no exchange and no task, so retries cannot pile up orphans. If the inline claim is still refused afterwards (the budget ran out in between), the just-created task is canceled through the normal cancel path with reason `budget_exhausted` (it gets its spend row and cannot run later) and the error names the task and context. Slice 4: if that cancel throws, the send still fails with the budget refusal (-32012, `taskStatus` the task's current status, the message says the cancel failed) and one `broker.budget.convention_cancel_failed` line (task id only) is logged; the cancel error never replaces the refusal. The pre-check and the create build the task request with one shared builder (only the exchange id, created after the check, differs), and the broker normalizes the pre-checked request exactly as `createTask` does. A budget refusal's JSON-RPC `error.data` ErrorInfo metadata carries `budgetReason` (`budget_exhausted` / `budget_paused`) and, when a task was created, `taskId` and `contextId`. In-flight tasks are never interrupted: a task claimed before its scope ran out completes and records spend as usual.
- **Queued listing** (spec "Claim retry loop"). The worker poll `GET /tasks?assignedWorkerId=W&status=queued` (or `worker=W`; item and `detail=full` responses, including the long poll), the SSE `worker-assignment-snapshot` of `GET /a2a/workers/W/assignment-events`, and that stream's live `worker-assignment` events and `Last-Event-ID` replay share one broker predicate, so they list the same tasks. Effective `on`: a task whose claim by W would be refused is omitted (`listing.omittedTotal`, `lastOmittedAt`, `lastOmittedCount`). Shadow: kept, counted in `listing.wouldOmitTotal`. Other query shapes (no worker, or another status) are not filtered.
  - The poll applies the predicate **before** its page cut: it reads the queue in widening fetches (at least 50, at least `limit`), keeping tasks until `limit` are kept or the queue is exhausted, and scans at most `max(limit, min(10 × limit, 1000), 50)` candidates (slice 4: never fewer than the 50-task minimum fetch, so a small-`limit` poller is not cut at 10 × `limit`). The response keeps `count`, `limit` (the requested limit) and `items`, and adds `budgetOmitted` (refused tasks skipped by this poll) and `budgetScanCapped` (true when the scan bound stopped the refill before `limit` tasks were found). Both are present only while a budget filter is active (mode not `off` and some budget exists); otherwise the response is unchanged. A poll reads each budget once and probes the worker's cost reporting once.
  - A held long poll wakes on every persisted state change; budget creates and updates, and goal budget transitions, persist, so raising a limit releases a held all-omitted poll right away. A period roll persists nothing: a held poll then answers at its `waitMs` deadline and the next poll sees the new period.
  - SSE live and replayed events use one filter per stream for up to 5 s (its memoized reads), so a limit change can take up to 5 s to show there; the snapshot and every poll read fresh.
  - Slice 4: an assignment the stream omitted (from its snapshot or a live event) is re-announced. The broker keeps a budget revision that changes on every budget create or update and when the period rolls (nothing else can make an omitted task claimable: the mode is fixed at startup and spend only grows). A stream that omitted something since its last snapshot checks the revision on every persisted broker state change and at its heartbeat cadence; when it changed, the stream sends a fresh, filtered `worker-assignment-snapshot` (the authoritative queued set) and drops its memoized filter. Streams that omitted nothing send nothing extra. The omitted live event itself is not re-sent and its id stays behind `Last-Event-ID`, so a reconnect never replays it; the reconnect's snapshot lists the task once it is allowed. With the heartbeat disabled (`heartbeatMs` 0) a period roll is noticed on the next state change.
- **Create** (`pause` budgets; `createTask` before anything is created). Only `pause` budgets of the task's lane (intent), goal and agent (`assignedWorkerId`, else the target when its kind is `node`; any other target kind has no agent scope and no cost probe) count: token-exhausted refuses; USD-exhausted refuses only when that worker reports cost this period (Decisions 4 and 15). Effective `on`: `policy_denied` (403) with `details.reason: "budget_paused"`, `periodKey` and `scopes` (as above); `creates.refusedTotal`, `broker.budget.create_refused` (`workerId`, `lane`, `scopes`). Shadow: `creates.wouldRefuseTotal`, `broker.budget.create_would_refuse`. A `refuse` budget never refuses a create. The retry task scheduled inside `failTask` is materialized without `createTask`, so a terminal transition never fails on a budget; every other create path (including dialectic phases and exchange messages) is checked.
- **Goals**: see [Goal budget limits](#goal-budget-limits-slice-3b-2).
- **Lost late metering** (ledger correctness: runs in every enforcement mode, like the slice 3a late metering): every stale-reaper sweep also checks up to 200 canceled tasks with late evidence (one primary-key read each) and restages the late metering for a row that is still unmetered and attributed to the late poster, with the same builder and store guard as the live path. This repairs a metering lost with a failed late-evidence save (a worker retry is idempotent and never stages it again). A pass walks a snapshot of the candidate ids taken when it starts, continuing where the previous sweep stopped; a task with nothing to restage is checked once, whatever the reason (a missing row is the reconciliation's job), and checked ids whose task left the task map are forgotten when the next pass starts. One `broker.spend.late_metering_restaged` line (`count`) per 60 s; a failure logs `broker.spend.late_metering_restage_failed` and the next sweep tries again. Slice 4: a task whose metering was restaged is settled only after the repair save succeeded (in process: after the synchronous save; worker-thread: when its queued write acks; while the write is queued the task is not restaged again). A failed save leaves the task for the next pass, which then writes row by row so one failing row cannot hold back the others; after 3 failed saves the task is settled with one `broker.spend.late_metering_restage_abandoned` line (`taskId`, `attempts`). A failed read or a failed save makes the pass return no result.

Operator notes: a refused claim shows up in worker logs as a 403 (`policy_denied`, `budget_exhausted`) on that task; workers keep polling, but in mode `on` they no longer see the refused tasks in their poll or SSE snapshot, so the 403s stop after the next poll. Raising the limit, the period rolling over, or switching the mode makes the tasks visible and claimable again on the next poll. `pause` refusals reach the caller that creates the task (403 `budget_paused`).

### Goal budget limits (slice 3b-2)

Every stale-reaper sweep evaluates up to 200 goal-scope month budgets (round-robin by budget id; budgets are in memory), one aggregate read each. For a goal budget either limit counts (Decision 4 is about which worker is refused, not about goal state).

- Effective `on`: a `pursuing` goal whose budget is exhausted moves to `budget_limited` with a history event `{ from: "pursuing", to: "budget_limited", reason: "budget_exhausted", note: "budget_exhausted" }`, and a `goal.status_changed` audit event (actor `broker`, note `pursuing->budget_limited:budget_exhausted`); `outcome` is not set (`outcome.failed` stays false). Tasks can no longer be created for it (slice 1: a goal must be `pursuing`, 409). Counted in `goals.limitedTotal`; one `broker.budget.goal_limited` line (`goalId`, `budgetId`, `note`).
- A `budget_limited` goal whose latest limiting event has reason `budget_exhausted` returns to `pursuing` once the budget is no longer exhausted (a raised limit, or the period rolled): history reason `operator_requested` with note `budget_available` (the transition-reason list has no dedicated value; adding one would change the stored goal schema), `goals.resumedTotal`, `broker.budget.goal_resumed`.
- When the effective mode is not `on` (`off`, `shadow`, or `on` in an incomplete period), every goal a budget limited is resumed the same way, with note `budget_enforcement_not_on`, without reading spend (up to 200 per sweep); `shadow` then still counts what `on` would limit (`goals.wouldLimitTotal`, `broker.budget.goal_would_limit`). A failed enforcement-metadata read skips the sweep, so a transient failure cannot flap goals.
- Slice 4: the resume pass walks `budget_limited` goals with a keyset cursor (`updated_at` DESC, `id` ASC; it restarts after a short page), so goals limited for another reason cannot pin it and more than 200 budget-limited goals are all resumed over successive sweeps. `goals.wouldLimitTotal` counts once per goal per period, not once per sweep. Without any goal-scope budget the sweep reads nothing (budgets are never deleted and their scope never changes, so no goal can be budget-limited then).
- Goals in any other state, and goals limited for another reason, are never touched.
- The goal row is updated through the save hints (`BrokerStateSaveHints.goals`, an `UPDATE` of the existing `broker_goals` row; no schema change), in the same transaction as its audit event. Until that write is durable the broker serves the transitioned goal from memory ahead of the table (also in `listGoals`, before its filters and limit), so a queued worker-thread write is never read back stale. Slice 4: `listGoals` applies every filter (status and the internal keyset cursor) to the in-memory copies with the same predicate the JSON-file store uses (`goalMatchesListFilters`), and reads the table past the limit by the number of in-memory copies, so a copy that no longer matches cannot leave the page short. Ties on `updatedAt` are ordered by `id` in code-unit order on every store (the JSON-file store used locale order before). The in-memory copy is dropped right after an in-process save, and when the queued write settles on the worker-thread topology; a failed queued write also drops the transition's in-memory audit event (reads go back to the stored row) and logs `broker.budget.goal_write_failed`.

## Budget alerts (slice 4)

Two operator alert kinds (closed `AlertKind` list in `src/core/observability/alert-projection.ts`) flow through the existing operator alert path: `GET /alerts`, the `operator-snapshot` / `operator-summary-update` alert scan, and `operator-alert-opened` / `operator-alert-resolved` on `GET /a2a/operator/events` (the `OperatorAlertDiffer`). There is no new delivery path; forwarding alerts to a messenger stays with consumers outside this repository.

| kind | severity | condition |
| --- | --- | --- |
| `budget_warn` | `warning` | either limit of the budget reached `warnPct` percent in the current period, and neither is exhausted |
| `budget_exhausted` | `critical` | either limit is exhausted (`usdSpent ≥ limitUsd` or `tokensSpent ≥ limitTokens`) |

- **Subject and id.** Subject `{ kind: "budget", id: "<budgetId>:<periodKey>" }` (a new `AlertSubjectKind`), so the alert id is `budget_warn:<budgetId>:<periodKey>` or `budget_exhausted:<budgetId>:<periodKey>`. One budget and period projects at most one of the two: exhausted supersedes warn, so a warn → exhausted step resolves the warn alert and opens the exhausted one.
- **Opens once per budget and period, and resolves** when the period rolls (the id changes; a new-period alert opens only when the new period crosses again), when a limit is raised or cleared so the condition no longer holds, or (exhausted → warn) when a raise leaves the budget above `warnPct` only. Budgets are never deleted and spend never decreases, so no other resolution exists.
- **Either limit counts**, including a USD limit that only refuses cost-reporting workers at claim (alerts are visibility; Decision 4 is about which worker is refused).
- **Every enforcement mode.** Alerts are computed in `off`, `shadow` and `on`, but only on a store with a spend ledger (SQLite).
- **Metadata** (ids, numbers and modes only; no worker-provided text): `budgetId`, `scopeType`, `scopeId`, `period`, `periodKey`, `limits` (the limits that crossed for this kind: `["usd"]`, `["tokens"]` or both), `usdSpent`, `limitUsd`, `tokensSpent` (`number | string`, bigint-safe like the status totals), `limitTokens`, `warnPct`, `enforce`, `configuredMode`, `effectiveMode` (`null` when the enforcement metadata read failed). `detectedAt` is the first sweep that saw this alert id; the metadata follows the latest evaluation.
- **Evaluation cadence.** The stale-reaper sweep evaluates budget alerts after the reconciliation, the late-metering restage and the goal limits, and caches the result on the broker; the alert projection only reads that cache (no store read when `/alerts` or the operator stream projects alerts). Per sweep at most 200 budgets are evaluated (one aggregate each, the same `evaluateBudget` read as status): budgets created or updated since their last evaluation first, then round-robin by id, wrapping within the sweep. Every budget is in memory; with the 10 000-budget load cap a full round takes 50 sweeps (at the default 60 s interval, under an hour), and budgets not reached keep their previous result. A raised limit is re-evaluated on the next sweep. When the cached set changes the sweep publishes, so the open/resolve events go out right away. Mode `off` reads no enforcement metadata, and nothing is read when no budget exists.
- **Read failures.** A budget whose read fails keeps its previous alert state (no flapping), is retried on the next sweep, and counts in `checkFailed` (`broker.budget.check_failed`, `source: "alert"`). An entry from an earlier period is never served, so a failing read cannot keep a previous period's alert open.
- **Restart.** The operator differ is in memory, like for every alert kind. The broker evaluates every budget once at startup (one aggregate per budget), before the server seeds its differ from the first scan, so an alert that still holds after a restart is in the initial set and does not re-open; an alert that stopped holding while the broker was down is not reported as resolved. This matches the other kinds.

See the [spend budget runbook](spend-budget-runbook.md) for what to do on each alert.

## Smoke / golden fixture

`src/fixtures/goal-lifecycle.ts` exports `buildGoalLifecycleSmokeFixture()`. The fixture contains one `budget_limited` goal attached to a parent task and three child tasks (`design`, `implementation`, `smoke`), showing mixed child outcomes without treating budget exhaustion as task failure.

## Non-goals

- No unbounded goal pursuit loop.
- No automatic safety-gate or approval bypass.
- No replacement of existing task status semantics.
