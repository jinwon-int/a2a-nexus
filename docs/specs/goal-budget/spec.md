# Feature Spec: Goal Links and Monthly Spend Budgets

> **Issue:** [#2499](https://github.com/jinwon-int/a2a-nexus/issues/2499)
> **Phase:** Spec-first. This document changes no code, schema, or runtime behaviour.
> **Status:** Proposed — needs the owner decisions in [Open questions](#open-questions) before a plan and task list are written.
> **Related:** [`docs/specs/a2a-goal-mode/`](../a2a-goal-mode/spec.md), [`packages/broker/docs/goal-objective-lifecycle.md`](../../../packages/broker/docs/goal-objective-lifecycle.md)

## Problem

The broker can say which worker finished a task and with what evidence. It cannot say
which objective the task belonged to, how much an agent, lane, or objective spent this
month, or stop work when a spending limit is reached.

Spend controls exist today only outside the broker or without money:

- Node-local daily token limits per provider live in the node harness, not in the broker.
- `worker-subagent-budget-counter` (`packages/attestation/src/worker-subagent-budget-counter.ts`)
  counts sub-agents and never enforces at runtime.
- Policy `maxTasksPerDay` per worker class
  (`packages/policy-referee/src/broker-policy.ts:36,321-335`) counts tasks, not cost, and is
  skipped at claim by design (`broker-policy.ts:314-320`).

The issue draft proposed four new tables (`goals`, `tasks.goal_id`, `budgets`, `spend`).
This spec aligns that draft with what the repository already contains, answers the
draft's open question 1 from source, and lists the migration and state-machine impact.

## What exists today (verified against `main` at `fc2c3fe`)

### Goal model: types and docs only

| Item | Location | Runtime use |
|---|---|---|
| `GoalStatus` (`pursuing`, `paused`, `achieved`, `blocked`, `unmet`, `budget_limited`, `cleared`) | `packages/broker/src/core/types.ts:134-141` | none |
| `GoalTransitionReason`, incl. `budget_exhausted` | `types.ts:143-151` | none |
| `GoalBudgetPolicy { maxChildAttempts, deadlineAt, maxResourceUnits }` | `types.ts:153-160` | none |
| `GoalTaskAttachment`, `GoalStatusEvent`, `GoalRecord` | `types.ts:162-200` | none |
| `BrokerSnapshot.goals?: GoalRecord[]` | `core/store/store-contracts.ts:55` | not emitted, not in `brokerSnapshotSchema` |
| Lifecycle fixture | `src/fixtures/goal-lifecycle.ts` + `src/goal-lifecycle-fixture.test.ts` | test only |
| `GET /goals/:id` sketch | `goal-objective-lifecycle.md:52-75` | not implemented |

- `TaskRecord` has no goal link. No CLI or HTTP route lists or shows goals.
- `GoalBudgetPolicy.maxResourceUnits` is described only as "tokens, cost units, or
  minutes"; there is no USD field.
- `docs/specs/a2a-goal-mode/schema.json` uses a different model (`goalRunId`, states
  `idle…cancelled`, `budgetLimits` in slices/workers/runtime). It does not match
  `GoalStatus`. This spec follows `types.ts`; reconciling `schema.json` is listed under
  [Follow-ups](#follow-ups).
- The word `budget_limited` also appears in docker-runner as an artifact outcome
  (`packages/docker-runner/src/types.ts:1053`, chosen at `runner.ts:438`). That is a
  per-run turn/time/token stop, unrelated to goal budgets, and stays as is.

### Usage and cost in terminal results (answers draft question 1)

Usage reaches the broker only as `task.result.output.executionTelemetry`
(schema `a2a.analysis-execution-telemetry.v1`,
`packages/broker/scripts/lib/analysis-execution-telemetry.mjs`), stored inside the
`broker_tasks.payload` JSON column. On bridge failure it travels in
`error.details.bridgeFailure`. The model name travels separately as
`requestedModel` / `actualRuntimeModel`.

| Runtime | Tokens | Cost (USD) | Source |
|---|---|---|---|
| Claude analysis | yes | yes (`total_cost_usd` → `costUsd`) | `analysis-execution-telemetry.mjs:87-104` |
| Piri analysis | only when the run emits a usage marker | same | `analysis-execution-telemetry.mjs:106-173` |
| Danso analysis | yes | no, by design | `analysis-execution-telemetry.mjs:193-213` |
| Codex analysis | no | no | model name only |
| Hermes analysis | no | no | model name only |
| Claude patch / docker-runner | turns only (`budget.used`) | no | artifact manifest |

Conclusions:

1. **USD is available for one runtime family only.** A USD-only budget would not see
   Codex, Hermes, Danso, or patch lanes. Token counts cover more runtimes but not all.
2. **Usage is an unsigned, worker-reported sidecar.** `ExecutionProof` in docker-runner
   (`types.ts:59-106`, signed in `execution-proof-signing.ts:63-90`) carries no usage, and
   the worker HTTP signature covers the request body in transit but is not stored. A
   budget built on this data is a cost control, not a security boundary: a faulty or
   dishonest worker can under-report.
3. The only current reader of `executionTelemetry` is task stats
   (`core/observability/task-stats.ts:775-845`), which counts model requests and schema
   retries and ignores cost and tokens.
4. The Completion Rule from #2500 (`01bb2137`) changed only
   `worker-subagent-orchestration-policy.md`; receipts are unchanged. Spend must still be
   recorded for `partial` and failed results, because the money was spent.

## Proposed design

### Goals: reuse the existing model

- Keep `GoalRecord`, `GoalStatus`, and `GoalTransitionReason` as the single goal model.
  The draft's `active | paused | done` maps to `pursuing | paused | achieved` (or
  `cleared`); no second status enum.
- Persist goals in a new SQLite table `broker_goals` (one row per goal, record JSON plus
  indexed `status` and `updated_at`), created with the existing additive pattern
  (`CREATE TABLE IF NOT EXISTS`, `core/store/store.ts:1201-1349`). Do not rely on
  `BrokerSnapshot.goals`: the snapshot schema does not declare it, and a table keeps
  goals queryable without loading the snapshot.
- Add optional `goalId` to `TaskRecord` and to the create-task input. Store it in the
  task payload and in an indexed `goal_id` column added with `ensureColumn`
  (`store.ts:1350`, defined at `:2218`).
- Tasks without a goal keep today's behaviour. An unknown or non-`pursuing` `goalId` is
  refused at create time (fail closed), so spend never attaches to a closed goal.
- Propagate `goalId` into terminal evidence projections that already carry task
  identity. No change to signed proofs.

### Budgets and spend

- `broker_budgets(id, scope_type, scope_id, period, limit, unit, warn_pct, enforce, created_by, created_at)`
  - `scope_type`: `agent | lane | goal`; `period`: `month` only in the first slice.
  - `unit` is an owner decision (question 2): `usd`, `tokens`, or both.
  - `warn_pct` defaults to 80.
  - `enforce`: `refuse | pause` (question 3).
- `broker_spend_events(task_id PRIMARY KEY, recorded_at, period_key, agent_id, lane, goal_id, cost_usd, input_tokens, output_tokens, cost_known)`
  - One row per task, written once when the task reaches any terminal state
    (including failed and `partial`). The primary key makes terminal retries and
    replays idempotent: spend is never counted twice.
  - `cost_known = false` when the runtime reported no cost. Those rows still carry
    tokens when present.
- Monthly totals are derived from `broker_spend_events` by `period_key` instead of a
  mutable running counter. This keeps the ledger auditable and avoids a second write
  path that could drift.

### Enforcement points

| Check | Hook | Effect |
|---|---|---|
| Claim-time (`refuse`) | beside `assertClaimTaskPolicy`, `packages/broker/src/core/broker.ts:2808` (policy in `core/dispatch/broker-task-admission.ts:382`) | throw a `policy_denied`-class error with reason `budget_exhausted`; the task stays `queued` |
| Dispatch-time (`pause`) | `evaluateCreateTaskPolicy`, `core/dispatch/broker-task-admission.ts:257-296` (called at `core/broker.ts:2326`) | new tasks for the exhausted scope are refused at creation |
| Goal scope exhausted | goal transition | goal moves to `budget_limited` with reason `budget_exhausted`; `outcome.failed` stays `false` (`types.ts:196`) |

- In-flight tasks are never interrupted. Spend is recorded after the fact, so a scope
  can overshoot by at most the tasks already claimed. The spec accepts this, as the
  issue draft does.
- No new `TaskStatus`. The draft's "stays in the queue" is today's `queued` state.
- **To verify — claim loop:** if workers poll for claimable tasks and retry refused
  claims, a refused task could cause a hot loop. Before implementation, check how the
  claim routes (`http/tasks-worker-routes.ts:202,220`, `a2a/json-rpc.ts:1016,1033`) list
  claimable work, and filter budget-exhausted scopes out of that list rather than only
  refusing at claim.

### Alerts and read surfaces

- Warn and exhaust events become a new `AlertKind` in the closed list in
  `core/observability/alert-projection.ts:26-37`. They then flow through the existing
  operator alert path (`OperatorAlertDiffer`, SSE `operator-alert-opened/resolved`,
  `GET /alerts`). The broker has no fleet-alert sender; forwarding operator alerts to
  the owner's messenger stays the job of existing consumers outside this repository.
- Read-only HTTP: `GET /goals`, `GET /goals/:id`, `GET /budgets/status?scope_type=&scope_id=`.
  JSON only, no UI.
- Prefer HTTP routes over new `scripts/*.mjs` CLI wrappers: the scripts budget is full
  (see below).

## Migration and boundary impact

- **SQLite schema:** `SQLITE_SCHEMA_VERSION` 13 → 14 (`store.ts:399`), additive only
  (three tables, one column). `CURRENT_BROKER_STATE_VERSION` (8,
  `core/store-schemas.ts:11`) stays unchanged because the snapshot shape does not change.
- **Downgrade:** a store written at version 14 makes an older binary refuse to start
  (fail-closed check, `store.ts:1165-1195`). Rolling back after the migration therefore
  needs a store backup taken before upgrade, or a binary that tolerates version 14.
  Deploying the migration is a database migration and needs separate operator approval.
- **Domain placement** (`docs/ops/broker-core-domain-map.json`, enforced by
  `scripts/check-broker-core-dependency-isolation.mjs`):
  - Types → kernel (`types.ts`).
  - Persistence → store (`store.ts`) or a kernel `*-repository`.
  - Claim and create gates → dispatch (`core/dispatch/broker-task-admission.ts`).
  - Alerts → observability (`alert-projection.ts`).
- **Script budget** (`scripts/check-script-budget.mjs`, currently `core=175/175`,
  `scripts/*.mjs=160/160`, `core-ceremony=16/16`):
  - New logic should fold into the existing modules above.
  - Any new core file needs a justified budget raise in the same PR.
  - File names must avoid ceremony markers (`approval`, `rehearsal`, `preflight`, …).
- **Trust model:** unchanged. No signed artifact gains or loses fields.

## Open questions

Owner decisions, needed before the plan:

1. *(Draft Q2)* **Budget unit:** USD only, tokens only, or both? USD covers Claude
   analysis lanes only; tokens cover more runtimes but not Codex or Hermes. Recommended:
   both, with enforcement on USD where `cost_known` and on tokens otherwise.
2. *(Draft Q3)* **Default `enforce`:** `refuse` at claim, or `pause` at dispatch?
   Recommended: `refuse`, the draft's own default, because it leaves dispatched work
   visible in the queue.
3. **Period boundary:** calendar month in UTC or in the owner's local time zone?
4. **Unknown-cost runtimes:** should tasks on runtimes that report neither cost nor
   tokens be refused once a scope with a USD-only budget is exhausted, or ignored?
5. **Goal persistence:** confirm a `broker_goals` table rather than snapshot JSON.

*(Draft Q1 is answered above: usage is present for some runtimes only, as an unsigned
sidecar in `task.result.output.executionTelemetry`.)*

## Out of scope

- Dashboard UI and spend charts.
- Automatic budget reallocation.
- Price table maintenance.
- Organisation charts.
- Adding cost reporting to Codex, Hermes, or patch lanes. That would be a worker-adapter
  change in its own issue.

## Follow-ups

- Reconcile or retire `docs/specs/a2a-goal-mode/schema.json` states against `GoalStatus`.
- After the owner decides the open questions: write `plan.md` and `tasks.md` in this
  directory (medium/large change rule, `CONTRIBUTING.md`), then implement in slices:
  1. Goal table and `goalId` link.
  2. Spend ledger (record only, no enforcement).
  3. Enforcement behind a default-off flag.
  4. Alerts and read routes.
