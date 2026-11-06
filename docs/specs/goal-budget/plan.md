# Implementation Plan: Goal Links and Monthly Spend Budgets

## Linked spec

- Spec: [`docs/specs/goal-budget/spec.md`](spec.md) (accepted for planning; decisions recorded 2026-11-06)
- Issue: [#2499](https://github.com/jinwon-int/a2a-nexus/issues/2499)
- Tasks: [`tasks.md`](tasks.md)

## Size classification

- [ ] Small
- [ ] Medium
- [x] Large

Reason: a SQLite schema bump (13 → 14) that older binaries refuse to open, a new claim-time
refusal on the worker hot path, and a change to what workers see when they poll. Each is
approval-sensitive at deploy time even though the source work is reversible.

## Affected repos/components

- `a2a-nexus` (this repository, `packages/broker`; template row `a2a-plane`):
  - `src/core/types.ts`: `TaskRecord.goalId`, budget and spend types; `GoalRecord` reused.
  - `src/core/store/store.ts`: schema v14, `broker_goals`, `broker_budgets`, `broker_spend_events`, `broker_tasks.goal_id`.
  - `src/core/broker.ts`: create-time goal check, claim-time budget check, terminal spend write.
  - `src/core/dispatch/broker-task-admission.ts`: budget evaluation for claim and create.
  - `src/http/*`: queued listing filter, read routes, operator budget routes.
  - `src/http/task-event-streams.ts`: the SSE snapshot uses the same filter.
  - `src/core/observability/alert-projection.ts`: two new `AlertKind`s.
- `a2a-broker`: no change (split repository is an archived mirror).
- `a2a-docker-runner`: no change.
- Harness bridges (`packages/broker/scripts/*-a2a-*-bridge.mjs`): no change. They already emit `executionTelemetry`; adding cost to Codex, Hermes, or patch lanes is out of scope.
- Worker/node config: none for source slices. Deploy-time broker settings listed under Rollout.
- Wiki/runbooks: one runbook entry at closeout (budget operations and rollback).
- Other: none.

## Broker / worker / finalizer roles

- Broker of record / finalizer: the Team 1 broker; one finalizer per slice PR (the implementing session), named in each PR.
- Workers: A2A analysis lanes for independent code review of each slice PR (Team 1, plus one Team 2 lane for the slice that changes the worker-visible poll result).
- Libero/validator: GitHub Actions required checks; local `npm test` for the broker package.
- Human approval owner: the repository owner, for each merge, the schema deploy, and each change of the enforcement mode.

## Execution lane

- [ ] Direct small change
- [ ] Isolated subagent
- [ ] Broker-owned TaskFlow
- [x] TaskFlow + A2A evidence workers
- [ ] Other:

Why this lane is safe: each slice is a source-only PR with tests. Runtime behaviour only
changes when a deploy is separately approved. Enforcement ships default-off (`off` →
`shadow` → `on`), so merging a slice never refuses a claim by itself.

## Data/control flow

1. **Create.** `createTask` validates an optional `goalId`: it must exist and be
   `pursuing`. With enforcement `on` and a `pause` budget exhausted for the task's scope,
   creation is refused.
2. **Poll and claim.**
   - The queued listing for a worker (poll route and SSE snapshot) omits tasks whose scope
     has an exhausted `refuse` budget.
   - `claimTask` re-checks next to `assertClaimTaskPolicy` and throws `policy_denied` with
     reason `budget_exhausted` (HTTP 403, which workers already skip).
   - The listing filter prevents a month-long retry stream; the claim check is the
     authority.
3. **Terminal.**
   - On any terminal transition (completed, failed, `partial`), the broker writes one
     `broker_spend_events` row keyed by `task_id`.
   - Values come from `result.output.executionTelemetry` or `error.details.bridgeFailure`.
   - The insert ignores conflicts, so replays never double count.
4. **Evaluate.**
   - Monthly totals are summed per scope and `period_key` (`YYYY-MM` in the configured
     zone, default `Asia/Seoul`).
   - USD totals include only `cost_known` rows (Decision 4); token totals include every
     row that reported tokens.
5. **Alert.**
   - Crossing `warn_pct` opens a `budget_warn` alert; reaching a limit opens
     `budget_exhausted`.
   - A goal-scope exhaustion moves the goal to `budget_limited` with reason
     `budget_exhausted`.
   - Alerts flow through the existing operator alert path.
6. **Scope of a budget.**
   - Budgets and spend are per broker. Team 1 and Team 2 run separate brokers and stores,
     so a fleet-wide total is the sum of both.
   - Cross-broker aggregation is a follow-up and not part of this plan.

Not touched: signed proofs, Terminal Brief, cross-broker relay, attestation.

## Tests and validation

- **Oracle independence / finalizer coverage review:**
  - Each slice PR gets at least one A2A analysis review lane that did not author it.
  - Slice 3 also gets a Team 2 lane.
  - The finalizer records lane verdicts in the PR.
- **Red-to-green evidence for new gates:**
  - Slice 3 commits the claim-refusal and listing-filter tests first, failing, then the
    implementation.
  - The PR links both CI runs.
- **Discovery inventory:** not a cleanup task; none.
- **Follow-up issue materialization:** open the cross-broker aggregation and
  goal-mode-schema reconciliation issues before closing #2499.
- **Lane-to-PR mapping:** one slice = one PR (four PRs).
- **Unit tests:**
  - **Store migration:** a v13 store opens, upgrades to v14, and keeps every task row; a
    v14 store refused by a v13 build is documented, not tested.
  - **Spend idempotency:** a replayed terminal transition writes no second row.
  - **Period boundary:** the last day of a month at 23:59 KST vs 00:00 KST (15:00 UTC).
  - **Units:** a USD-only budget ignores `cost_known = false` rows; a token budget counts
    them when tokens are present.
  - **Claim refusal:** status 403, reason `budget_exhausted`, task stays `queued`.
  - **Listing filter:** the poll route and the SSE snapshot agree.
  - **Enforcement modes:** `off` (no effect), `shadow` (log and status only), `on`.
- **Contract/conformance tests:**
  - `brokerSnapshotSchema` stays unchanged.
  - The HTTP route table includes the new read routes.
- **Build/lint/typecheck:**
  - `npm run build` and the broker package test suite.
  - `node scripts/check-script-budget.mjs`.
  - `node scripts/check-broker-core-dependency-isolation.mjs`.
- **Dry-run/doctor checks:** `GET /budgets/status` on a local broker with fixture spend.
- **CI checks:** all required checks on the exact head of each PR.
- **Live canary, if separately approved:** `shadow` mode on the Team 1 broker for two
  weeks before `on`.

## Rollout plan

- **Source PR order:**
  1. Slice 1: schema v14 with all tables and the column, goal link, goal read routes.
  2. Slice 2: spend ledger written on terminal, `GET /budgets/status`, no limits.
  3. Slice 3: operator budget routes, enforcement modes, claim refusal, listing filter.
  4. Slice 4: alerts and the runbook.
- **Merge/rehearsal order:**
  - Slices merge in order.
  - Slice 1 carries the whole schema change, so only one database migration needs
    deploy approval.
- **Deployment gate, if separately approved:**
  - Deploy slice 1 or later to a broker only after a store backup. This is a DB migration
    and needs owner approval.
  - Enforcement mode starts `off`. Moving to `shadow`, then to `on`, is a separate owner
    approval each time, per broker.
- **Communication/Terminal Brief expectations:**
  - No Terminal Brief change.
  - Budget alerts appear on the operator alert path. Owner-messenger delivery stays with
    existing consumers.

## Rollback plan

- **Revert path:** revert the slice PR. Slices 2–4 add no schema, so reverting them is
  code-only.
- **Config rollback:**
  - Set the enforcement mode to `off`. It takes effect without a restart if implemented
    as a live setting; otherwise it applies at the next restart.
  - Slice 3 must state which of the two it is.
- **State cleanup:**
  - The v14 tables are inert under a v14-aware binary with enforcement off.
  - A v13 binary refuses a v14 store, so a full downgrade restores the pre-upgrade backup.
    Spend recorded since then is lost, and tasks created since then are only in the
    current store.
- **Approval required before cleanup:**
  - Any store restore or table drop is a DB action that needs owner approval.

## Closeout evidence

- **Finalizer decision:** one per slice PR, plus a closeout comment on #2499 listing the
  four PRs.
- **Evidence links:** PR URLs, merge commits, A2A lane task IDs and verdicts.
- **Tests/checks:** CI run links on exact heads; local test summaries.
- **Approval-sensitive actions not performed:** none of the following happen in the
  source slices: schema deploy, enforcement mode change, live canary, store restore.
- **Wiki/runbook update:** budget operations runbook (create, inspect, raise a limit,
  switch mode, roll back).
