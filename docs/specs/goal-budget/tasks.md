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
  - The row is staged with the terminal task row and committed in the same store transaction, on both the in-process and the worker-thread SQLite topologies.
- [x] Read `executionTelemetry` from `result.output` or `error.details.bridgeFailure`; set `cost_known` from the presence of `costUsd`.
  - Also read from `error.details.nestedError.details.bridgeFailure` (wrapped handler exit) and from a preserved negative review verdict.
  - Values are validated and bounded (`costUsd` ≤ 1e6, tokens ≤ 1e12). Malformed telemetry is recorded unmetered with one `broker.spend.telemetry_malformed` log line.
  - Token, `agent_id` and `lane` semantics are recorded in the spec ("Budgets and spend", clarified in slice 2).
- [x] `period_key` in the configured zone (default `Asia/Seoul`), as a broker setting: `A2A_BUDGET_PERIOD_TIME_ZONE`. An invalid zone fails startup.
- [x] `GET /budgets/status?scope_type=&scope_id=&period=`:
  - spend totals (USD known, tokens, unmetered task count);
  - limits shown as none until slice 3.
  - Same read auth as `GET /goals`; 400 on a bad `scope_type`, `scope_id` or `period`.
  - Spend is SQLite-only: other stores report `available: false`.
- [x] Tests:
  - replay idempotency;
  - failed and `partial` results recorded;
  - KST month boundary (00:00 KST = 15:00 UTC on the last day);
  - runtimes without cost or tokens.
- [x] Slice 1 review follow-ups:
  - `createGoal` on a store without a goal table rolls the goal back when the save throws.
  - Snapshot `goals` loaded into a SQLite-backed broker are imported into `broker_goals` (create-only, counted in one log line).
  - HTTP decision-dialectic advance with a closed (409) or missing (404) parent goal creates no phase task.

### Slice 3 — budgets and enforcement (default off)

- [ ] Operator-authenticated budget routes: create, update limit, list. Use the existing operator auth; no new credential.
- [ ] Enforcement mode setting `off | shadow | on`, default `off`; state whether it applies live or at restart.
- [ ] Red first: commit failing tests for the claim refusal and the listing filter, then the implementation; link both CI runs.
- [ ] Claim-time check next to `assertClaimTaskPolicy`: `policy_denied` with reason `budget_exhausted` (HTTP 403); the task stays `queued`.
- [ ] Filter exhausted-scope tasks out of the worker queued listing:
  - the poll route `GET /tasks?assignedWorkerId=&status=queued`;
  - the SSE `worker-assignment-snapshot`;
  - expose the omitted count in budget status.
- [ ] `pause` budgets refuse at create time.
- [ ] USD limits count only `cost_known` rows; token limits count rows with tokens (Decisions 1 and 4).
- [ ] Goal-scope exhaustion moves the goal to `budget_limited` with reason `budget_exhausted`.
- [ ] `shadow` records would-refuse decisions in status and logs without refusing.
- [ ] Tests:
  - all three modes;
  - poll and SSE agree;
  - in-flight tasks untouched;
  - USD-only budget does not block unknown-cost tasks.

### Slice 4 — alerts and runbook

- [ ] `budget_warn` (at `warn_pct`) and `budget_exhausted` added to the `AlertKind` list, through the existing operator alert path.
- [ ] Each alert opens once per scope and period and resolves when the period rolls or the limit is raised.
- [ ] Runbook: create and inspect budgets, raise a limit, switch mode, read unmetered spend, roll back.
- [ ] Tests: alert open/resolve, no duplicate alert within a period.

### Closeout

- [ ] Open follow-up issues:
  - cross-broker spend aggregation (Team 1 + Team 2);
  - reconcile `docs/specs/a2a-goal-mode/schema.json` with `GoalStatus`;
  - cost reporting for Codex, Hermes and patch lanes (worker adapters).
- [ ] Produce worker evidence packets (A2A lane task IDs and verdicts) per slice.
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
