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
- [ ] `GET /goals`, `GET /goals/:id` (JSON, read-only).
- [ ] Tests:
  - v13 → v14 upgrade keeps all task rows;
  - goal create/attach;
  - unknown-goal refusal;
  - routes.

### Slice 2 — spend ledger (record only)

- [ ] On every terminal transition, insert one `broker_spend_events` row keyed by `task_id`; conflicts are ignored.
- [ ] Read `executionTelemetry` from `result.output` or `error.details.bridgeFailure`; set `cost_known` from the presence of `costUsd`.
- [ ] `period_key` in the configured zone (default `Asia/Seoul`), as a broker setting.
- [ ] `GET /budgets/status?scope_type=&scope_id=&period=`:
  - spend totals (USD known, tokens, unmetered task count);
  - limits shown as none until slice 3.
- [ ] Tests:
  - replay idempotency;
  - failed and `partial` results recorded;
  - KST month boundary (00:00 KST = 15:00 UTC on the last day);
  - runtimes without cost or tokens.

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
