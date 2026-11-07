# Monthly Spend Budget Runbook

**Issue:** [#2499](https://github.com/jinwon-int/a2a-nexus/issues/2499) (slice 4)
**Spec:** [`docs/specs/goal-budget/spec.md`](../../../docs/specs/goal-budget/spec.md)
**Reference:** [Goal / Objective Lifecycle](goal-objective-lifecycle.md) (ledger, budgets, enforcement hooks, alerts)

This runbook covers the operator side of monthly spend budgets: creating and
inspecting budgets, raising a limit, switching the enforcement mode, reading
spend and counters, acting on the two budget alerts, and rolling back. It
changes nothing by itself. Steps marked **owner approval** are database or
deploy actions and need fresh approval from the owner before anyone runs them.

## 0. Conventions

All examples use placeholder variables. Never paste a real host name, node
name or credential into a ticket, log or this document.

```sh
export BROKER_URL="https://broker.example.invalid"   # your broker's base URL
export A2A_EDGE_SECRET="<redacted>"                  # read from your secret store, never echo it
export OPERATOR_ID="operator-1"                      # your operator identity
AUTH=(-H "x-a2a-edge-secret: ${A2A_EDGE_SECRET}" -H "x-a2a-requester-id: ${OPERATOR_ID}" -H "x-a2a-requester-role: operator")
```

Use the operator authentication your deployment already has; the headers above
are the edge-secret form. Budget writes (`POST`, `PATCH`) need the `hub` or
`operator` role; reads use the `GET /goals` read roles. Worker ids below
(`worker-a`) are examples.

Budgets and the spend ledger exist only on the SQLite state store. On another
store, `GET /budgets` and `GET /budgets/status` answer `available: false` and
budget writes are 409 `unsupported_operation`.

## 1. Deploy prerequisite (owner approval)

The ledger and budget tables arrive with SQLite schema version 14. Upgrading a
store to v14 is a **database migration**:

1. Take a backup of the broker state database before the upgrade (the store's
   usual backup procedure, broker stopped or with a consistent snapshot).
2. Get the owner's approval for the migration and record where the backup is.
3. Deploy. The broker migrates at startup; a v14 store makes an older binary
   refuse to start, so the backup is the only way back to an older release.

The enforcement mode defaults to `off`, so the deploy itself refuses nothing.

## 2. Create and inspect budgets

One budget per scope and period. Scopes: `agent` (a worker id), `lane` (a task
intent such as `analyze`), `goal` (an existing goal id). Period: `month` only,
in the zone `A2A_BUDGET_PERIOD_TIME_ZONE` (default `Asia/Seoul`). At least one
of `limitUsd` and `limitTokens`; `warnPct` defaults to 80; `enforce` is
`refuse` (refuse claims, the default) or `pause` (refuse new tasks at create).

```sh
# Create a token budget for one worker.
curl -sS "${AUTH[@]}" -H 'content-type: application/json' -X POST "$BROKER_URL/budgets" \
  -d '{"id":"b-worker-a","scopeType":"agent","scopeId":"worker-a","period":"month","limitTokens":50000000}'

# Create a USD budget for a lane, warn at 90 %.
curl -sS "${AUTH[@]}" -H 'content-type: application/json' -X POST "$BROKER_URL/budgets" \
  -d '{"id":"b-lane-analyze","scopeType":"lane","scopeId":"analyze","period":"month","limitUsd":200,"warnPct":90}'

# List budgets (optionally ?scope_type=&scope_id=&limit=).
curl -sS "${AUTH[@]}" "$BROKER_URL/budgets" | jq '.budgets'
```

A duplicate id or a second budget for the same scope and period is 409. Every
write appends a `budget.created` / `budget.updated` audit event; budgets have
no update time, the audit trail is their history. Budgets cannot be deleted.

Inspect the current period:

```sh
# Whole period, every scope, every budget evaluated.
curl -sS "${AUTH[@]}" "$BROKER_URL/budgets/status" | jq '{period, enforcement, ledger, budgets}'

# One scope, with its five largest rows.
curl -sS "${AUTH[@]}" "$BROKER_URL/budgets/status?scope_type=agent&scope_id=worker-a&top=5" \
  | jq '{scope_total, budgets, topRows}'

# A past period.
curl -sS "${AUTH[@]}" "$BROKER_URL/budgets/status?period=2026-10" | jq '.period_total'
```

Each entry of `budgets` shows `usdSpent`, `tokensSpent`, `usdExhausted`,
`tokensExhausted` and `warn`. Token totals are a JSON number up to 2^53 − 1
and a decimal string above; scripts must accept both.

## 3. Raise or change a limit

```sh
curl -sS "${AUTH[@]}" -H 'content-type: application/json' -X PATCH "$BROKER_URL/budgets/b-worker-a" \
  -d '{"limitTokens":80000000}'

# Clear one limit (the other must stay set), change warnPct or enforce.
curl -sS "${AUTH[@]}" -H 'content-type: application/json' -X PATCH "$BROKER_URL/budgets/b-lane-analyze" \
  -d '{"limitUsd":null,"limitTokens":100000000,"warnPct":85,"enforce":"pause"}'
```

A raise takes effect immediately for claims, creates and the worker poll; a
held long poll is released. Worker SSE streams that hid tasks send a fresh
`worker-assignment-snapshot`. A goal limited by the budget resumes on the next
stale-reaper sweep, and the budget alert resolves on the next sweep (see §6).
An empty body (`{}`) is 400.

## 4. Switch the enforcement mode

`A2A_BUDGET_ENFORCEMENT_MODE` = `off` (default) | `shadow` | `on`. It is read
at startup, so a change needs a broker restart (**owner approval**: a broker
restart is an approval-sensitive action).

Recommended progression:

1. **`off`**: budgets, status and alerts work; nothing is refused, counted as
   would-refuse, or hidden.
2. **`shadow`**: every decision is computed and counted (`claims.wouldRefuseTotal`,
   `listing.wouldOmitTotal`, `creates.wouldRefuseTotal`, `goals.wouldLimitTotal`)
   and logged (`broker.budget.would_refuse`, `…create_would_refuse`,
   `…goal_would_limit`), but nothing is refused. Run at least a few days and
   compare the counters with what you expect.
3. **`on`**: refusals apply. While the ledger does not cover the whole period
   (`ledger.periodComplete` false: the month the ledger started, or unknown
   coverage) `on` runs as `shadow` (`enforcement.reason: "period_incomplete"`).
   It becomes effective at the first full month.

Confirm after the restart:

```sh
curl -sS "${AUTH[@]}" "$BROKER_URL/budgets/status" | jq '.enforcement'
# {"configuredMode":"on","effectiveMode":"on","reason":"mode_on"}
```

An invalid value, or a mode other than `off` on a store without the spend
ledger, refuses startup with a message naming the setting.

Change `A2A_BUDGET_PERIOD_TIME_ZONE` only at a month boundary; rows keep the
period they were written with, and the broker logs
`broker.spend.time_zone_changed` at startup.

## 5. Read spend, unmetered work and counters

From `GET /budgets/status`:

| field | meaning |
| --- | --- |
| `period_total.usd_known_total` | USD over rows whose runtime reported a cost |
| `period_total.input_tokens_total`, `output_tokens_total` | token totals (`number \| string`) |
| `period_total.cost_unknown_task_count` | tasks that reported tokens but no cost (not refused by a USD limit) |
| `period_total.unmetered_task_count` | tasks that reported neither cost nor tokens (counted, not limited) |
| `scopes[]` | the same per scope, with its budget in `limits` |
| `topRows` | the largest rows of a named scope by cost and by tokens (outliers; `top=1..20`) |
| `ledger.missingSpendRows` | terminal tasks without a spend row (the reconciliation repairs them each sweep); `null` when unreadable |
| `ledger.periodComplete` | whether the requested period is fully covered (decides `on` vs `shadow`) |
| `claims` | `refusedTotal`, `wouldRefuseTotal`, `lastAt` |
| `listing` | `omittedTotal`, `lastOmittedAt`, `lastOmittedCount`, `wouldOmitTotal` (counted per listing, so they grow with poll frequency) |
| `creates` | `refusedTotal`, `wouldRefuseTotal`, `lastAt` (`pause` budgets) |
| `goals` | `limitedTotal`, `resumedTotal`, `wouldLimitTotal` (once per goal per period), `lastAt` |
| `checkFailed` | `count`, `lastAt`, `consecutive`: failed budget reads (fail-open) |

Counters are in memory since the last start. Usage is worker-reported and
unsigned: budgets are a cost guardrail between trusted workers, not a security
boundary. A large unmetered count means part of the work is invisible to the
limits (runtimes without cost or token reporting).

A rising `checkFailed.consecutive` means budget reads keep failing; enforcement
stays fail-open (claims proceed). Check the broker's `broker.budget.check_failed`
lines (`source`: `claim`, `create`, `goal`, `alert`, `enforcement`) and the
database health before anything else.

## 6. Budget alerts

Both come through the normal operator alert path: `GET /alerts`, the operator
event stream `GET /a2a/operator/events` (`operator-alert-opened` /
`operator-alert-resolved`) and its snapshots.

```sh
curl -sS "${AUTH[@]}" "$BROKER_URL/alerts" | jq '.alerts[] | select(.kind | startswith("budget_"))'
```

| alert | severity | meaning |
| --- | --- | --- |
| `budget_warn:<budgetId>:<period>` | warning | a limit reached `warnPct` % this period |
| `budget_exhausted:<budgetId>:<period>` | critical | a limit is exhausted this period |

The metadata names the budget, scope, period, which limit crossed (`limits`),
spent against limit, `warnPct`, `enforce`, and the configured and effective
mode. Each alert opens once per budget and period and resolves when the period
rolls, or when a raised or cleared limit ends the condition; exhausted replaces
warn. Alerts are evaluated by the stale-reaper sweep (every
`STALE_REAPER_INTERVAL_SEC`, default 60 s; up to 200 budgets per sweep, changed
budgets first), in every mode.

What to do:

- **`budget_warn`**: check `topRows` for the scope (one outlier task, or steady
  use?) and the remaining days of the period. Raise the limit (§3) if the
  spend is expected; otherwise tell the owner of the scope.
- **`budget_exhausted`**: in effective `on`, claims for the scope are refused
  (`refuse`) or new tasks are refused (`pause`), and goal budgets limit their
  goal. In `off`/`shadow` it is information only (see the would-* counters).
  Decide with the scope owner: raise the limit (§3) or let it stand until the
  period rolls. In-flight tasks are never interrupted, so spend can overshoot
  by the tasks already claimed.

## 7. Worker-side symptoms (effective `on`)

- A claim of a task in an exhausted `refuse` scope answers **403**
  `policy_denied` with `details.reason: "budget_exhausted"` (JSON-RPC: -32012).
  The task stays `queued`.
- The worker poll `GET /tasks?assignedWorkerId=worker-a&status=queued` and the
  SSE `worker-assignment-snapshot` **hide** those tasks; the poll adds
  `budgetOmitted` and `budgetScanCapped`. So 403s stop after the next poll.
- A create in an exhausted `pause` scope answers **403** `policy_denied` with
  `details.reason: "budget_paused"`.
- A USD limit refuses only workers that reported a cost this period; token
  limits refuse any worker.

Tasks reappear (poll, and a fresh SSE snapshot) as soon as the limit is raised,
the period rolls, or the mode is switched away from `on`.

## 8. Goals: `budget_limited` and resume

In effective `on`, the sweep moves a `pursuing` goal whose goal budget is
exhausted to `budget_limited` (reason `budget_exhausted`; not a failure). New
tasks for it are refused (409) while it is limited.

```sh
curl -sS "${AUTH[@]}" "$BROKER_URL/goals?status=budget_limited" | jq '.goals[] | {id, status}'
```

It returns to `pursuing` by itself on the next sweep after the limit is raised
or the period rolls (history reason `operator_requested`, note
`budget_available`), and after a switch away from `on` (note
`budget_enforcement_not_on`). Goals limited for another reason are never
touched.

## 9. Roll back

In order of preference:

1. **Mode `off`** (restart, **owner approval**): nothing is refused or hidden;
   goals limited by a budget resume over the next sweeps; budgets, status and
   alerts keep working.
2. **Revert the code** to the previous release of the same schema version
   (v14): budgets and the ledger stay in the database untouched.
3. **Restore the v14 backup** to go back before schema 14 (**owner approval**:
   a database restore). Spend recorded since the upgrade is lost with it.

Never delete budget or spend rows by hand: the ledger is the audit record, and
budget audit events are exempt from retention for that reason.
