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

## Spend ledger and budget status (#2499 slice 2)

Slice 2 records spend; it does not enforce anything. No claim or create is refused, no listing is filtered and no alert is raised because of spend.

### Ledger rows

Every terminal transition writes one `broker_spend_events` row keyed by `task_id`: completion, failure (including a failure that schedules a retry, and a stale-sweep dead-letter), and cancellation (including cascades and checkpoint expiry). `partial` results are ordinary succeeded results and are recorded the same way. The insert is `INSERT … ON CONFLICT(task_id) DO NOTHING`, so a replayed or repeated terminal write never counts twice. A retry is a new task with its own row.

| column | value |
| --- | --- |
| `recorded_at` | terminal transition time (`completedAt`, else `updatedAt`) |
| `period_key` | `YYYY-MM` of `recorded_at` in the budget period time zone |
| `agent_id` | `claimedBy` (the worker that completed or failed the task), else the worker that held the claim when a cancel cleared `claimedBy`, else `assignedWorkerId`, else NULL (counted in the period total, in no agent scope) |
| `lane` | the task `intent` (`analyze`, `propose_patch`, …): the closed lane vocabulary the broker already indexes, known before claim |
| `goal_id` | `TaskRecord.goalId`, else NULL |
| `cost_usd`, `cost_known` | reported `costUsd`; `cost_known = 1` iff a finite, in-range `costUsd` was reported, else `cost_usd = 0` and `cost_known = 0` |
| `input_tokens` | `inputTokens + cacheCreationInputTokens` (cache-read tokens are not counted) |
| `output_tokens` | `outputTokens` |

Usage is read from `executionTelemetry` (schema `a2a.analysis-execution-telemetry.v1`) on `result.output`, on `error.details.bridgeFailure`, on the same nested under `error.details.nestedError.details` (a wrapped handler exit), or on a preserved negative review verdict. Carrier order: a failed task tries bridgeFailure, nested bridgeFailure, `result.output`, then the negative-verdict output; every other status tries `result.output`, the negative-verdict output, bridgeFailure, then nested bridgeFailure. The first carrier whose telemetry is valid wins; a malformed carrier falls through to the next. This data is unsigned and worker-reported. Every number must be a finite, non-negative number, with `costUsd` at most 1e6 and each token count at most 1e12. A wrong schema version, a non-object or any invalid field makes that carrier's telemetry malformed. When no present carrier is valid, the row is recorded unmetered and one `broker.spend.telemetry_malformed` warning (task id, status, the top carrier's reason code, no values) is logged. Telemetry never makes a terminal transition fail.

The ledger columns are `NOT NULL DEFAULT 0` (schema 14), so "not reported" is stored as 0, not NULL. A row with `cost_known = 0` and zero tokens is **unmetered** (Codex, Hermes, patch lanes, Piri without a usage marker, cancellations). Rows that report tokens but no cost (Danso) are cost-unknown but not unmetered.

### Durability

Each of the four writers of a terminal status stages the row itself, inside its `commitMutation`, after the terminal task row is set and before `persistState`: `completeTask`, `failTask` (a fail that schedules a retry records the failed attempt; the retry is a new task with its own row), `cancelTaskRecord` (direct cancels, every non-terminal descendant of a cascade, checkpoint expiry, exchange cancels) and the stale-sweep dead-letter. The row is staged in the same save hints as the terminal task row, and the store inserts it in the same transaction:

- In-process SQLite (repositories on write): the task row is upserted at `setTaskRecord` and the spend row is inserted at `persistState`, both inside one `BEGIN IMMEDIATE … COMMIT`. A failing spend insert rolls the terminal task row back.
- Worker-thread persistence: the task row and the spend row travel in the same queued `saveHotEntities` write and commit in one worker-side transaction.

A restart cannot persist a terminal task without its spend row, or the reverse. A failing spend insert therefore fails the terminal transition (fail-closed; see the slice 3 preconditions in `docs/specs/goal-budget/tasks.md`). Terminal tasks from before slice 2 are not backfilled.

### Stores without SQLite

Spend is SQLite-only. Stores without `readSpendTotals` (the JSON-file store and injected snapshot stores) get no rows, and the snapshot shape is unchanged. Keeping one row per task forever in a single snapshot blob that is rewritten on every full save would grow without bound. `GET /budgets/status` reports `available: false` on those stores.

### Period time zone

`A2A_BUDGET_PERIOD_TIME_ZONE` (server option `budgetPeriodTimeZone`) sets the zone for `period_key` and for the default period of the status route. Unset or blank means `Asia/Seoul` (spec Decision 3). The value is canonicalized (`asia/seoul` → `Asia/Seoul`), and a zone `Intl` does not accept fails broker startup. Changing the zone affects new rows only; existing `period_key` values are not rewritten.

### `GET /budgets/status`

`GET /budgets/status?scope_type=agent|lane|goal&scope_id=…&period=YYYY-MM` uses the same auth posture as `GET /goals` (hub, operator, analyst, researcher, live-trader when requester identity is enforced).

- `period` defaults to the current period in the configured zone; anything other than `YYYY-MM` (month 01–12) is 400.
- Without `scope_type`, every scope of every type is returned. With `scope_type` only, every scope of that type. With `scope_id` as well, just that scope (zero totals if it spent nothing). A `scope_id` without `scope_type`, an unknown `scope_type`, or a `scope_id` that breaks the goal id pattern (goal scope) or is longer than 256 characters or contains control characters (agent and lane scopes) is 400. Values are never trimmed.
- Each scope reports `usd_known_total` (only `cost_known` rows, Decision 4), `input_tokens_total`, `output_tokens_total`, `task_count`, `cost_unknown_task_count`, `unmetered_task_count`, and `limits: null`; limits arrive with budgets in slice 3.
- `period_total` always covers the whole period, including rows with no agent or goal, whatever the scope filter. `scope_total` is the named scope's totals when `scope_type` and `scope_id` are both given (zero totals if it spent nothing), else null.
- Token totals are summed exactly (SQLite integer `SUM` read as BigInt; USD uses `TOTAL()`). A token total is a JSON number while it is at most `Number.MAX_SAFE_INTEGER` (2^53 − 1), else its exact decimal string, so clients must accept both. SQLite's integer sum is exact up to 2^63 − 1, at least about 9.2 million rows at the 1e12 per-row cap in one period.
- Groups are capped at 1000 per scope type (`truncated: true` when hit). Every query is one indexed aggregate over `broker_spend_events` (`(period_key, agent_id|lane|goal_id)` indexes); no query scans `broker_tasks.payload`.

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
  "truncated": false
}
```

Spend is per broker. A fleet-wide total is the sum over the Team 1 and Team 2 brokers (cross-broker aggregation is a follow-up).

## Smoke / golden fixture

`src/fixtures/goal-lifecycle.ts` exports `buildGoalLifecycleSmokeFixture()`. The fixture contains one `budget_limited` goal attached to a parent task and three child tasks (`design`, `implementation`, `smoke`), showing mixed child outcomes without treating budget exhaustion as task failure.

## Non-goals

- No unbounded goal pursuit loop.
- No automatic safety-gate or approval bypass.
- No replacement of existing task status semantics.
