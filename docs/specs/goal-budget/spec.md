# Feature Spec: Goal Links and Monthly Spend Budgets

> **Issue:** [#2499](https://github.com/jinwon-int/a2a-nexus/issues/2499)
> **Phase:** Spec-first. This document changes no code, schema, or runtime behaviour.
> **Status:** Accepted for planning — owner decisions recorded 2026-11-06 in [Decisions](#decisions). Plan: [`plan.md`](plan.md), tasks: [`tasks.md`](tasks.md).
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
  `GoalStatus`. This spec follows `types.ts`. #2517 settled this: the two are distinct
  fields (planner run state vs. goal outcome status), and `schema.json` links a run to a
  broker goal through `brokerGoal` (`contracts/a2a/goal-mode-lifecycle.md` §2.5).
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
| Codex analysis | yes (#2518) | no: `codex exec --json` carries no price | `codexExecutionTelemetry` (`turn.completed.usage`) |
| Hermes analysis | yes (#2518) | yes when every session row is `actual`/`estimated` (Hermes' own figure); `included`/`unknown` stay unknown | `hermesExecutionTelemetry` (state.db `sessions` row) |
| Claude patch / docker-runner | yes (#2518) | yes (`total_cost_usd`, summed over the run's CLI invocations; unknown if one has no envelope) | `artifacts/execution-telemetry.json` → artifact manifest → `result.output` / `bridgeFailure` |

(#2518 updated the last three rows; before it, Codex and Hermes reported model name
only and patch lanes reported turns only. The new rows take effect only after a worker
artifact rollout and, for docker-runner patch lanes, a runner and image rollout.)

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

- `broker_budgets(id, scope_type, scope_id, period, limit_usd, limit_tokens, warn_pct, enforce, created_by, created_at)`
  - `scope_type`: `agent | lane | goal`; `period`: `month` only in the first slice.
  - `limit_usd` and `limit_tokens` are both nullable; at least one is set (Decision 1).
  - `warn_pct` defaults to 80.
  - `enforce`: `refuse | pause`, default `refuse` (Decision 2).
- `broker_spend_events(task_id PRIMARY KEY, recorded_at, period_key, agent_id, lane, goal_id, cost_usd, input_tokens, output_tokens, cost_known)`
  - One row per task, written once when the task reaches any terminal state
    (including failed and `partial`). The primary key makes terminal retries and
    replays idempotent: spend is never counted twice.
  - `cost_known = false` when the runtime reported no cost. Those rows still carry
    tokens when present.
  - *Clarified in slice 2 (2026-11-06):*
    - `agent_id` is the worker that did the work: `claimedBy`, else the
      worker that held the claim when a cancel cleared `claimedBy`, else
      `assignedWorkerId`, else NULL. A NULL row counts toward the period
      total but toward no agent scope.
    - `lane` is the task `intent`.
    - `input_tokens` is uncached input plus cache-creation tokens. Cache-read
      tokens are not counted: they are billed at a fraction of the input rate
      and dominate raw counts on cached runs.
    - "Not reported" is stored as `0`, not NULL: the slice 1 columns are
      `NOT NULL DEFAULT 0`, and a NULL would need a second migration. A row
      with `cost_known = false` and zero tokens is unmetered.
    - Malformed or out-of-range telemetry (`costUsd` > 1e6, a token count
      > 1e12, a negative or non-numeric value, an unknown schema version) is
      never clamped. The next carrier in precedence order with valid
      telemetry is used instead; if none parses, the row is unmetered.
    - Token totals are exact integers (BigInt) past 2^53; the status route
      returns a number while a total is at most `Number.MAX_SAFE_INTEGER`,
      else its decimal string.
    - Spend is SQLite-only. Other stores keep no ledger, and budget status
      reports `available: false` for them.
  - *Clarified in slice 3a (2026-11-07):*
    - **Late metering (G1).** A task canceled while running is recorded
      unmetered at cancel time. The first late complete/fail result the worker
      posts after the cancel (`lateEvidenceAfterCancel`) updates that row once,
      only while it is still unmetered (`cost_known = 0`, zero tokens) and only
      when the poster is the row's `agent_id`. Same carriers, precedence and
      validation as a terminal-time row. `period_key` and `recorded_at` keep the
      cancel's values.
    - **Reconciliation (G2, G3).** Terminal `broker_tasks` rows with no spend row
      are found by one anti-join (status column and the spend primary key, never
      `payload`) and repaired create-only from the in-memory task record, at
      startup and on every stale-reaper sweep (one page of 200). The same pass
      backfills terminal tasks from before slice 2 that are still in the hot
      table. Budget status reports the live count as `ledger.missingSpendRows`.
    - **Ledger coverage.** The store records the first ledger period
      (`spend_ledger_first_period`, written once) and the period zone
      (`spend_ledger_time_zone`). Budget status shows both and `periodComplete`
      (the requested period is after the first ledger period).
    - **Retention.** Spend rows are never pruned; terminal task rows are, so the
      reconciliation can only repair tasks still in the hot table. Its cadence
      (startup plus every sweep) is far shorter than the retention window.
    - **Telemetry fallback.** When a higher-precedence carrier is malformed and a
      later one parses, the row is metered from the later one and the broker logs
      one `broker.spend.telemetry_fallback` line (reason code only).
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
- **Claim retry loop (verified 2026-11-06).** Workers poll
  `GET /tasks?assignedWorkerId=<id>&status=queued`
  (`workers/broker-worker-client.ts:395-402`), and the worker SSE stream sends the same
  queued set as `worker-assignment-snapshot` (`http/task-event-streams.ts:74`).
  `policy_denied` maps to HTTP 403 (`http/error-mapping.ts:102`), which the worker treats as
  a skippable claim error (`workers/external-handler.ts:323-324`). A refused task
  therefore stays in the next poll result and is re-claimed on every poll for as long as
  the budget stays exhausted. This is not a CPU spin, but it is a month-long stream of
  refused claims and log lines. **Requirement:** the claim-time refusal stays the
  authority, and the queued listing for a worker (poll route and SSE snapshot) must also
  omit tasks whose scope is exhausted, with the omitted count exposed in budget status.

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

## Decisions

Owner decisions, 2026-11-06 (recorded on #2499). The former open questions are kept as the
question each decision answers.

1. *(Draft Q2)* **Budget unit — both USD and tokens.** A budget row may set a USD limit, a
   token limit, or both. A task's spend counts toward the USD limit when `cost_known` is
   true and toward the token limit whenever tokens were reported.
2. *(Draft Q3)* **Default `enforce` — `refuse` at claim.** The task stays `queued` and is
   visible. `pause` (refuse at create time) remains available per budget row but is not
   the default.
3. **Period boundary — calendar month in `Asia/Seoul`.** `period_key` is `YYYY-MM` computed
   in that time zone. The zone is a broker setting so it can change without a schema
   change; the default is `Asia/Seoul`.
4. **Unknown-cost runtimes — never refused by a USD limit.** A task whose runtime reports
   no cost is not blocked because a USD limit is exhausted. It is governed by the token
   limit when tokens are reported, and by warn alerts. A runtime that reports neither
   cost nor tokens is recorded with `cost_known = false` and zero tokens, and appears in
   budget status as unmetered spend.
5. **Goal persistence — dedicated `broker_goals` table.**

*(Draft Q1 is answered above: usage is present for some runtimes only, as an unsigned
sidecar in `task.result.output.executionTelemetry`.)*

### Enforcement preconditions (slice 3a, 2026-11-07)

Proposed in the slice 3a PR and accepted when the owner approves its merge. They resolve
the preconditions in `tasks.md` (slice 3) and the slice 2 re-review additions. Items 9–14
constrain slice 3b, which adds the enforcement mode; none of them changes behaviour while
enforcement is `off`.

6. **G1 — late telemetry after a cancel: one-time late metering** (see "Clarified in
   slice 3a"). Canceled work is metered when the worker reports it; work the worker never
   reports stays unmetered. A row rebuilt by the reconciliation is attributed to the
   assignee (the claimant at cancel time is not kept on the task record) and gets the
   late usage when the late poster is that assignee. The late poster always is the
   assignee (`assertTaskWorker`), so the live path and the rebuilt row differ only for a
   task reassigned after its claim; that divergence is accepted.
7. **G2 — missing rows: repair, not only report.** Create-only reconciliation at startup and
   on every stale-reaper sweep (the periodic run keeps its page cursor across sweeps, so it
   advances past ids it cannot repair); the remaining count is shown in budget status, or
   `null` when the count cannot be read.
   Enforcement proceeds while rows are missing; the count tells the operator how much
   spend the totals may be missing.
8. **Fail-closed spend insert: kept.** A failing ledger insert still fails the terminal
   transition. The failures left (I/O, disk full, lock timeout) would fail the task row
   in the same transaction anyway, the failure is visible and the worker retries, and a
   silent under-count would weaken enforcement. With the reconciliation in place, a
   non-fatal variant buys nothing. The same holds for the G1 late-metering update, which
   rides the late-evidence transaction.
9. **G3 — partial deploy period: no enforcement before the first full period.** The
   reconciliation backfills what the hot table still has, but tasks pruned before the
   deploy are gone. Slice 3b runs `on` as `shadow` for any period where
   `periodComplete` is false (the deploy month).
10. **Spend of running tasks: overshoot accepted.** Spend is counted at the terminal
    transition only. A scope can overshoot by the tasks already claimed when it becomes
    exhausted, plus tasks that completed within one worker-thread write flush (reads run on
    the main-thread connection; writes are queued). In-flight tasks are never interrupted.
11. **Time zone change: new rows only, at a month boundary.** `period_key` is fixed at
    insert. A changed `A2A_BUDGET_PERIOD_TIME_ZONE` logs `broker.spend.time_zone_changed`
    at startup and updates the stored zone; the runbook (slice 4) says to change it only at
    a month boundary. The broker does not refuse the change.
12. **Unsigned telemetry: counted as reported, within the per-task caps** (`costUsd`
    ≤ 1e6, tokens ≤ 1e12; above a cap the carrier is malformed, never clamped). Budgets
    are a cost guardrail between trusted fleet workers, not a security boundary. Signed
    usage is a follow-up issue.
13. **Ledger unavailable or unreadable (slice 3b behaviour).** A mode other than `off` on
    a store without a spend ledger (`available: false`) refuses startup. A budget read that
    throws at claim time fails open: the claim proceeds, the broker logs
    `broker.budget.check_failed` and counts it in budget status. Token sums are exact
    BigInt to 2^63 − 1 and USD uses `TOTAL()`, so no overflow path is expected; a SQLite
    integer overflow is treated as a failed read.
14. **Slice 2 clarifications accepted:** `input_tokens` is uncached input plus
    cache-creation tokens; "not reported" is stored as `0`.

### Budgets and enforcement mode (slice 3b, 2026-11-07)

Proposed in the slice 3b-1 PR and accepted when the owner approves its merge.

15. **USD limit at claim time: cost-reporting workers only.** A USD-exhausted scope refuses
    a claim only from a worker that reported a known cost in the same period (one
    `cost_known = 1` row with that `agent_id`). Workers whose runtime reports no cost are
    never refused by a USD limit (Decision 4); a token-exhausted scope refuses any worker.
    This uses the ledger instead of a static runtime table; a worker's first cost-reporting
    task in a period can overshoot by that one task.
16. **Mode setting and budget rows.** `A2A_BUDGET_ENFORCEMENT_MODE` = `off | shadow | on`,
    default `off`, read at startup (a change needs a restart; an invalid value or a mode
    other than `off` without a spend ledger refuses startup). One budget per scope and
    period (unique index on `broker_budgets(scope_type, scope_id, period)`, added to the
    v14 DDL, no version bump). A `pause` budget acts at create time only and never refuses
    a claim. `warn` stays true once a limit is exhausted. Budget rows expose `createdAt`
    only; changes are in the `budget.updated` audit events.
17. **Routes.** `POST /budgets`, `PATCH /budgets/:id` (limits, `warnPct`, `enforce`; at least
    one limit stays set) and `GET /budgets`, with the goal routes' auth (writes hub/operator,
    reads the observer set). `GET /budgets/status` adds `enforcement` (configured and
    effective mode, reason), per-budget usage, `topRows` for a named scope, and
    `checkFailed` (served from memory, also when the ledger read fails).

### Enforcement hooks (slice 3b-2, 2026-11-07)

Proposed in the slice 3b-2 PR and accepted when the owner approves its merge.

18. **Hook details.**
    - **Claim refusal:** `policy_denied` with `{reason: "budget_exhausted", periodKey, scopes}` (HTTP 403). JSON-RPC message-send claims return `-32012` with the reason in the message; the task stays `queued`.
    - **`pause` at create:** `{reason: "budget_paused", ...}`. The agent scope is the task's effective worker (`assignedWorkerId`, else the target), and the same worker is the cost-reporting probe. Retries scheduled inside `failTask` do not go through `createTask`, so a terminal transition never fails on a budget.
    - **Listing filter:** applies to the worker poll (`assignedWorkerId`/`worker` with `status=queued`) and the SSE `worker-assignment-snapshot`. Live `worker-assignment` events and their replay are not filtered; a worker acting on one gets the 403. `listing.omittedTotal` counts per listing, not per task.
    - **Goal `budget_limited`:** the stale-reaper sweep moves a `pursuing` goal whose budget is exhausted (either limit) to `budget_limited`, and back to `pursuing` when the limit is raised or the period rolls. The resume uses the existing history reason `operator_requested` with note `budget_available`; there is no new reason value, so goal rows stay readable by older binaries. Mode `off` does not resume goals limited while the mode was `on`.
    - **Fail-open:** repeated read failures stay fail-open; `checkFailed.consecutive` is shown, and the alert comes in slice 4.

### Budget alerts (slice 4, 2026-11-07)

Proposed in the slice 4 PR and accepted when the owner approves its merge.

19. **Alert semantics.**
    - **Kinds:** `budget_warn` (warning, at `warnPct` of either limit) and `budget_exhausted` (critical) in `AlertKind`, with subject kind `budget`. The subject id is `<budgetId>:<periodKey>`, so at most one alert per budget and period is open at a time, and a period roll resolves it. A resolved alert can open again in the same period if the condition returns (for example, a limit raised and then exhausted again).
    - **One at a time:** exhausted supersedes warn for the same budget and period.
    - **Every mode:** alerts are visibility only and are projected in every enforcement mode (including `off`) whenever a spend ledger exists. A USD-exhausted budget alerts even though at claim time it refuses only cost-reporting workers.
    - **Evaluation:** in the stale-reaper sweep, up to 200 budgets per sweep (recently written first, then round-robin), cached on the broker. The projection does no store reads.
    - **Failures:** a failed read keeps the previous alert state and counts in `checkFailed` (source `alert`).
    - **Restart:** all budgets are evaluated once at startup, before the alert differ is seeded, so a restart does not re-open an alert that still holds.
    - **No alert for `checkFailed` itself:** it is visible in status.

### Carried review minors (#2520, 2026-11-09)

Corrections from the #2514 / #2515 reviews, proposed in the #2520 PR and accepted when the owner approves its merge. Where they differ, they replace the text of 18 and 19 above.

20. **Corrections.**
    - **Goal resume in `off`:** the last sentence of 18 ("Mode `off` does not resume goals limited while the mode was `on`") does not describe slice 3b-2, which resumes every goal a budget limited whenever the effective mode is not `on`, also in `off` after a restart. A goal whose goal budget left memory (a write that did not land) is resumed too, also in `on`.
    - **Listing filter:** live `worker-assignment` events and their replay use the same filter as the snapshot (slice 3b-2). Every SSE stream sends a fresh, filtered snapshot when the budget revision changes (a budget write, the period roll, or the alert sweep seeing a budget become or stop being exhausted, the next time it evaluates that budget), after the write commits. `listing.omittedTotal` stays a per-listing count.
    - **Alert failures:** a budget whose evaluation fails stays queued as a failed retry; retries take at most a quarter of each sweep (oldest failure first; the rest stay in the round-robin), so budgets that always fail cannot starve the others. Only a sweep without failures resets `checkFailed.consecutive`.
    - **Restart:** the startup alert pass is bounded to 1 000 budgets; the rest are evaluated first by the next sweeps, and an alert among them that still holds re-opens after the restart.
    - **`detectedAt`:** kept while an alert stays open; an alert that resolved and opens again gets the re-opening sweep's time.

## Out of scope

- Dashboard UI and spend charts.
- Automatic budget reallocation.
- Price table maintenance.
- Organisation charts.
- Adding cost reporting to Codex, Hermes, or patch lanes. That would be a worker-adapter
  change in its own issue.

## Follow-ups

- ~~Reconcile or retire `docs/specs/a2a-goal-mode/schema.json` states against `GoalStatus`.~~ Done in #2517: kept as distinct fields, linked through `brokerGoal`.
- Implementation follows [`plan.md`](plan.md) and [`tasks.md`](tasks.md), in slices.
