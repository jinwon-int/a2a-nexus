# Tasks: Goal Links and Monthly Spend Budgets

Spec: [`spec.md`](spec.md) · Plan: [`plan.md`](plan.md) · Issue: [#2499](https://github.com/jinwon-int/a2a-nexus/issues/2499)

## Preconditions

- [x] Feature spec is linked and accepted (`spec.md`, decisions 2026-11-06).
- [x] Implementation plan is linked and accepted (`plan.md`, this PR).
- [x] Size classification is recorded: Large.
- [x] Approval-sensitive actions are explicitly out of scope for the source slices:
  - schema deploy;
  - enforcement mode changes;
  - live canary;
  - store restore.
- [x] Broker of record / finalizer is identified: Team 1 broker; one finalizer per slice PR.

## Implementation tasks

### Cross-cutting (every slice)

- [ ] Discovery inventory: not applicable (no cleanup or removal).
- [ ] Independent verification: at least one A2A analysis review lane per slice PR that did not author it; a Team 2 lane for slice 3.
- [ ] One slice = one PR; any consolidation needs a recorded finalizer approval.
- [ ] Keep `node scripts/check-script-budget.mjs` and `node scripts/check-broker-core-dependency-isolation.mjs` green. Fold logic into existing modules; justify any budget raise in the same PR.
- [ ] Confirm no secret or credential appears in logs, alerts, or status output.
- [ ] Confirm broker foreground liveness: the spend write and budget checks are single indexed queries, with no scan of `broker_tasks.payload`.

### Slice 1 — schema v14, goal link, goal read routes

- [ ] `SQLITE_SCHEMA_VERSION` 13 → 14 with:
  - `broker_goals`;
  - `broker_budgets`;
  - `broker_spend_events`;
  - `broker_tasks.goal_id` (via `ensureColumn`);
  - indexes on `goal_id`, `(period_key, agent_id)`, `(period_key, lane)`, `(period_key, goal_id)`.
- [ ] Goal persistence reusing `GoalRecord` / `GoalStatus`; no second status enum.
- [ ] Optional `goalId` on `TaskRecord` and the create-task input; refuse an unknown or non-`pursuing` goal at create.
  - One goal id pattern, `^[A-Za-z0-9._:-]{1,128}$`, for goal ids and `goalId`; a padded or malformed id is 400, never trimmed.
  - Idempotent create replays treat `goalId` like any other field (legacy: stored task returned unchanged; V1 idempotency authority: a differing `goalId` is 409 `idempotency_conflict`).
  - Retry tasks inherit the root task's `goalId`; decision-dialectic phase tasks carry the parent's `goalId` through `createTask` validation; other create paths build requests without a goal.
- [ ] `POST /goals` (hub/operator; creates a `pursuing` goal; `goal.created` audit event; id pattern, title ≤ 200 and objective ≤ 2000 characters, else 400; duplicate id 409).
- [ ] `GET /goals`, `GET /goals/:id` (JSON, read-only). `linkedTasks` counts come from the hot task table (see the lifecycle doc).
- [ ] Stores without a goal table (JSON file) carry goals in the snapshot `goals` field and survive a restart.
- [ ] Tests:
  - v13 → v14 upgrade keeps all task rows; partially applied v14 re-runs to the full shape; a newer `schema_version` is refused;
  - goal create/attach;
  - unknown-goal refusal;
  - routes;
  - JSON-file store restart keeps goals.

### Slice 2 — spend ledger (record only)

- [x] On every terminal transition, insert one `broker_spend_events` row keyed by `task_id`; conflicts are ignored.
  - Terminal transitions covered: complete, fail (including retry-scheduling fails and stale-sweep dead-letters), and cancel (including cascades and checkpoint expiry).
    - Each of the four writers of a terminal status (`completeTask`, `failTask`, `cancelTaskRecord`, the stale-sweep dead-letter) stages the row itself, inside its `commitMutation`, before `persistState`.
    - A fail that schedules a retry records the failed attempt; the retry is a new task id with its own row. A cascade over N non-terminal descendants records N+1 rows; descendants already terminal keep their own earlier row.
    - One test per path, plus an invariant test: every terminal task row has exactly one spend row and no non-terminal task has one.
  - The row is staged with the terminal task row and committed in the same store transaction, on both the in-process and the worker-thread SQLite topologies (the worker-thread case is tested on the real `createWorkerThreadPersistence` queue).
- [x] Read `executionTelemetry` from `result.output` or `error.details.bridgeFailure`; set `cost_known` from the presence of `costUsd`.
  - Also read from `error.details.nestedError.details.bridgeFailure` (wrapped handler exit) and from a preserved negative review verdict.
  - Precedence: a failed task tries bridgeFailure, nested bridgeFailure, `result.output`, then the negative-verdict output; other statuses try `result.output` and the negative-verdict output first. The first carrier whose telemetry parses wins, so a malformed carrier falls through to the next valid one.
  - Values are validated and bounded (`costUsd` ≤ 1e6, tokens ≤ 1e12). When no present carrier parses, the row is recorded unmetered with one `broker.spend.telemetry_malformed` log line.
  - `agent_id`: `claimedBy`, else the claimant at cancel time (cancellation clears `claimedBy`), else the assignee.
  - Token, `agent_id` and `lane` semantics are recorded in the spec ("Budgets and spend", clarified in slice 2).
- [x] `period_key` in the configured zone (default `Asia/Seoul`), as a broker setting: `A2A_BUDGET_PERIOD_TIME_ZONE`. An invalid zone fails startup.
- [x] `GET /budgets/status?scope_type=&scope_id=&period=`:
  - spend totals (USD known, tokens, unmetered task count);
  - `period_total` is always the whole period; `scope_total` is the named scope when `scope_type` and `scope_id` are both given, else null;
  - token totals are exact past 2^53: a number while at most `Number.MAX_SAFE_INTEGER`, else a decimal string;
  - limits shown as none until slice 3.
  - Same read auth as `GET /goals`; 400 on a bad `scope_type`, `scope_id` or `period`.
  - Spend is SQLite-only: other stores report `available: false`.
- [x] Tests:
  - replay idempotency;
  - failed and `partial` results recorded;
  - KST month boundary (00:00 KST = 15:00 UTC on the last day);
  - runtimes without cost or tokens.
- [x] Slice 1 review follow-ups:
  - `createGoal` rolls back when the save throws: the in-memory goal (store without a goal table) and, on every store, the `goal.created` audit event.
  - Snapshot `goals` loaded into a SQLite-backed broker are imported into `broker_goals` (create-only; one log line when something was imported or quarantined, none on a restart that finds every goal present). A failed import does not abort startup: it logs `broker.snapshot.goals_import_failed` and carries the goals forward in the snapshot for the next start.
  - HTTP decision-dialectic advance with a non-pursuing parent goal (paused, or closed such as `achieved`: 409 `invalid_transition`) or a missing one (404 `not_found`) creates no phase task. Test-only: the refusal is slice 1's `createTask` goal gate; no source change was needed.

### Slice 3 — budgets and enforcement (default off)

Split into two PRs (one finalizer each): 3a resolves the preconditions below, 3b adds budgets and enforcement. Decisions are recorded in the spec ("Enforcement preconditions (slice 3a)", items 6–14).

#### Slice 3a — preconditions before enforcement

From the slice 2 review and re-review; each is resolved or decided before any mode other than `off` ships:

- [x] G1 — late telemetry after a cancel: one-time late metering of the unmetered row (only while `cost_known = 0` and both token counts are 0, only from the row's `agent_id`, once). Spec decision 6.
- [x] G2 — terminal tasks with no spend row: create-only reconciliation (anti-join on the status column and the spend primary key) at startup and on every stale-reaper sweep; live count `ledger.missingSpendRows` in budget status; `broker.spend.reconciled` / `broker.spend.reconcile_failed` log lines. Spec decision 7.
- [x] G3 — no backfill: the same reconciliation backfills pre-slice-2 terminal tasks still in the hot table; `spend_ledger_first_period` in store metadata and `ledger.periodComplete` in status; 3b runs `on` as `shadow` until the first full period. Spec decision 9.
- [x] Fail-closed spend insert: kept, decided with G2. Spec decision 8.
- [x] Time zone change mid-period: zone stored as `spend_ledger_time_zone`; a change logs `broker.spend.time_zone_changed` and applies to new rows only; change at a month boundary (runbook, slice 4). Spec decision 11.
- [x] Unsigned telemetry: counted as reported within the per-task caps; signed usage is a follow-up. Spec decision 12.
- [x] Spec sign-off for the slice 2 clarifications (`input_tokens` incl. cache creation; "not reported" = 0): accepted with the 3a merge. Spec decision 14.
- [x] Re-review additions: spend of running tasks and worker-thread read lag (overshoot accepted, decision 10); retention pruning never removes spend rows, and a test proves it (reconciliation only repairs retained tasks); ledger read failure, SUM overflow and `available: false` (decision 13, implemented in 3b); startup check for terminal tasks without a spend row (the startup reconciliation).
- [x] Re-review minors: `broker.spend.telemetry_fallback` when a malformed higher-precedence carrier falls through to a valid one; shared bigint-safe JSON projector `spendTotalsToJson` (token totals: number up to `Number.MAX_SAFE_INTEGER`, else decimal string — published in `packages/broker/docs/goal-objective-lifecycle.md`).
- [x] Tests: `packages/broker/src/core/broker-spend-reconcile.test.ts` (G1 incl. worker-thread queue, G2/G3 restart idempotency and invariant, metadata, fallback, bigint JSON, retention) and `goal-routes.test.ts` (`ledger` object).

#### Slice 3b — budgets and enforcement

Split into two PRs (finalizer decision, 2026-11-07, recorded on #2499): **3b-1** budgets, mode setting, evaluator, status and the 3a review minors (spec decisions 15–17); **3b-2** the refusal hooks (claim refusal, queued-listing filter, `pause` at create, goal `budget_limited`, shadow decisions), red first. Items below are marked with the PR that closes them.

- [x] (3b-1) Operator budget routes `POST /budgets`, `PATCH /budgets/:id`, `GET /budgets`; one budget per scope and period; `budget.created` / `budget.updated` audit events.
- [x] (3b-1) `A2A_BUDGET_ENFORCEMENT_MODE` `off|shadow|on`, default `off`, applied at restart; invalid value or non-`off` without a spend ledger refuses startup; `on` runs as `shadow` while `periodComplete` is false (decision 9).
- [x] (3b-1) Evaluator: USD counts `cost_known` rows, tokens count input + output; claim decision function (decision 15) unit-tested but not yet called; read failures fail open with an in-memory `checkFailed` count/last-at and a rate-limited `broker.budget.check_failed` line.
- [x] (3b-1) `GET /budgets/status`: `enforcement`, per-budget usage, `limits` filled, `topRows`, `checkFailed` (also when the ledger read fails).
- [x] (3b-1) 3a round-2 minors: first parseable cancel-time candidate; periodic page skipped after 3 consecutive failures (`reconcile_page_skipped`) and rate-limited `reconcile_failed`; diagnostics logged after the page write; reconciled cancel logs late `malformed`; `reconciled.passEnded`; `broker.spend.near_cap`.
- [x] (3b-2) Repeated `checkFailed` stays fail-open; `checkFailed.consecutive` in status (alert in slice 4).
- [x] (3b-2) A late metering lost with a failed save is restaged by a second sweep pass (`late_metering_restaged`).

- [x] (3b-1) Mode `on` behaves as `shadow` while `ledger.periodComplete` is false (decision 9); a mode other than `off` without a spend ledger refuses startup, and a failed budget read fails open with `broker.budget.check_failed` counted in status (decision 13).
- [x] (3b-1/3b-2) Carried from the slice 3a reviews (Team 1 lane PASS, Team 2 lane REVISE → fixed):
  - `broker.budget.check_failed`: rate-limited log line; count and last-at kept in memory and shown in status even when the status read itself fails; decide whether N consecutive failures downgrade `on` to `shadow` or fail closed.
  - Show `ledger.missingSpendRows`, `ledger.periodComplete` and the time zone next to the mode in status; `periodComplete` does not consider missing rows.
  - A late metering lost with a failed save is not reconciled (its row exists, unmetered). Either a second reconcile pass for canceled tasks with late evidence and an unmetered row, or count them in status.
  - Outliers: log per-task reports near the caps and give operators a way to see a single row that exhausts a shared lane or goal budget.
- [x] (3b-1) Operator-authenticated budget routes: create, update limit, list. Use the existing operator auth; no new credential.
- [x] (3b-1) Enforcement mode setting `off | shadow | on`, default `off`; state whether it applies live or at restart.
- [x] (3b-2) Red first: commit failing tests for the claim refusal and the listing filter, then the implementation; link both CI runs.
- [x] (3b-2) Claim-time check next to `assertClaimTaskPolicy`: `policy_denied` with reason `budget_exhausted` (HTTP 403); the task stays `queued`.
- [x] (3b-2) Filter exhausted-scope tasks out of the worker queued listing:
  - the poll route `GET /tasks?assignedWorkerId=&status=queued`;
  - the SSE `worker-assignment-snapshot`;
  - expose the omitted count in budget status.
- [x] (3b-2) `pause` budgets refuse at create time.
- [x] (3b-2) USD limits count only `cost_known` rows; token limits count rows with tokens (Decisions 1 and 4).
- [x] (3b-2) Goal-scope exhaustion moves the goal to `budget_limited` with reason `budget_exhausted`.
- [x] (3b-2) `shadow` records would-refuse decisions in status and logs without refusing.
- [x] (3b-2) Tests:
  - all three modes;
  - poll and SSE agree;
  - in-flight tasks untouched;
  - USD-only budget does not block unknown-cost tasks.

### Slice 4 — alerts and runbook

- [x] `budget_warn` (at `warn_pct`) and `budget_exhausted` added to the `AlertKind` list, through the existing operator alert path.
- [x] Each alert opens once per scope and period and resolves when the period rolls or the limit is raised.
- [x] Runbook: create and inspect budgets, raise a limit, switch mode, read unmetered spend, roll back.
- [x] Tests: alert open/resolve, no duplicate alert within a period.
- [x] Runbook: `packages/broker/docs/spend-budget-runbook.md` (linked from the lifecycle doc and the broker README). Spec decision 19.
- [x] Slice 3b-2 round-2 minors: small-limit scan bound, SSE re-snapshot on a budget change, guarded JSON-RPC race cancel, shared create request builder, restage settles after its save, `latestQueuedWrite` cleared, goal overlay applies all filters plus a resume cursor, `wouldLimitTotal` per goal and period, no metadata reads without budgets, sweep-hook and worker-thread race tests.

### Closeout

- [x] Open follow-up issues:
  - cross-broker spend aggregation (Team 1 + Team 2): #2516 — design [`cross-broker-spend.md`](cross-broker-spend.md), ratified 2026-11-14 as recommended; implementation not started;
  - reconcile `docs/specs/a2a-goal-mode/schema.json` with `GoalStatus`: #2517;
  - cost reporting for Codex, Hermes and patch lanes (worker adapters): #2518;
  - signed usage telemetry, so budgets do not rely on unsigned worker reports (spec decision 12): #2519 — design [`signed-usage-telemetry.md`](signed-usage-telemetry.md), ratified 2026-11-14 as recommended; implementation not started;
  - carried review minors from slices 3b-2 and 4: #2520 (and #2512, found during slice 3a).
- [x] Produce worker evidence packets (A2A lane task IDs and verdicts) per slice: [`evidence.md`](evidence.md).
- [x] Runbook hardening from the slice 4 re-review: keep the current v14 database before a restore, verify and record the pre-upgrade backup, read the edge secret without shell history, name `STALE_REAPER_ENABLED`, and document the SSE snapshot replace semantics in `a2a-protocol.md`.
- [ ] Finalizer closeout decision on #2499.
- [ ] Wiki runbook entry linked.

## Evidence checklist

For each slice PR, attach:

- [ ] repo/branch/commit or PR link;
- [ ] test/build/lint command and result;
- [ ] CI/check URL or status on the exact head;
- [ ] risk notes (schema, worker poll behaviour);
- [ ] rollback notes (mode `off`, revert, backup restore for v14);
- [ ] approval-sensitive actions not performed;
- [ ] blocker or final recommendation.

## Final closeout

- [ ] Exactly one finalizer made the closeout decision.
- [ ] Evidence supports the decision.
- [ ] Follow-up issues are linked.
- [ ] Wiki/runbook update is linked or explicitly not needed.
- [ ] No unapproved deploy/restart/canary/DB/ACK/replay/release/secret action occurred.
