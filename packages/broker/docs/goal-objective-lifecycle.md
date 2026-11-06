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

## Smoke / golden fixture

`src/fixtures/goal-lifecycle.ts` exports `buildGoalLifecycleSmokeFixture()`. The fixture contains one `budget_limited` goal attached to a parent task and three child tasks (`design`, `implementation`, `smoke`), showing mixed child outcomes without treating budget exhaustion as task failure.

## Non-goals

- No unbounded goal pursuit loop.
- No automatic safety-gate or approval bypass.
- No replacement of existing task status semantics.
