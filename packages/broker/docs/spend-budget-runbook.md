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

```bash
export BROKER_URL="https://broker.example.invalid"   # your broker's base URL
export OPERATOR_ID="operator-1"                      # your operator identity
```

Keep the edge secret off the curl command line (`ps`, `/proc`) and out of
shell history. Run the next block **as a script** (`bash setup-auth.sh`, or
paste it into `bash -s`), not line by line into an interactive shell.
Pasting can feed the following line to `read`, and a failed guard does not
stop an interactive shell. It is bash-only (`read -s -p`). The header file
is owner-only and removed when the script exits. Put the calls that need
`AUTH` in the same script.

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS= read -rs -p 'edge secret: ' A2A_EDGE_SECRET_VALUE </dev/tty; echo
[ -n "$A2A_EDGE_SECRET_VALUE" ] || { echo 'edge secret is empty' >&2; exit 1; }
HDR="$(umask 077; mktemp)"
trap 'rm -f "$HDR"' EXIT
printf 'x-a2a-edge-secret: %s\n' "$A2A_EDGE_SECRET_VALUE" > "$HDR"   # printf is a builtin: not in ps
unset A2A_EDGE_SECRET_VALUE
AUTH=(-H @"$HDR" -H "x-a2a-requester-id: ${OPERATOR_ID}" -H "x-a2a-requester-role: operator")
# ... curl -sS "${AUTH[@]}" "$BROKER_URL/budgets/status" ...
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

1. Get the owner's approval first. It covers the migration and, if the backup
   needs the broker stopped, that stop and restart.
2. Take a backup of the whole broker state database before the upgrade, using
   the store's usual backup procedure. With SQLite in WAL mode, take it with
   the SQLite online backup API (`.backup` / `VACUUM INTO`) on the live file,
   or stop the broker cleanly first. A stopped broker that leaves a `-wal`
   file still holds committed transactions there: copy the main file together
   with its `-wal` (and `-shm`), or checkpoint first. Never copy the main file
   alone.
3. Verify the backup before deploying: open the copy read-only and check
   that `PRAGMA integrity_check` returns `ok` and that `broker_metadata` shows
   the pre-upgrade `schema_version`. Record a backup **reference** (a path
   relative to your backup root, or the backup system's id; no host or node
   names), its checksum and the verification result in the approval record.
4. Deploy. The broker migrates at startup. A v14 store makes an older binary
   refuse to start, so this pre-upgrade backup is the only way back to an
   older release.

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
held long poll is released. Worker SSE streams send a fresh
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

`A2A_BUDGET_PERIOD_TIME_ZONE` is also read at startup, so changing it needs a
restart (**owner approval**). Change it only at a month boundary in the new
zone. Rows keep the period they were written with, and the broker logs
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
| `listing` | `omittedTotal`, `lastOmittedAt`, `lastOmittedCount`, `wouldOmitTotal` (counted per listing evaluation, so they grow with poll frequency; a held long poll re-evaluates at least every 250 ms. `lastOmittedCount` is the number hidden by the latest listing) |
| `creates` | `refusedTotal`, `wouldRefuseTotal`, `lastAt` (`pause` budgets) |
| `goals` | `limitedTotal`, `resumedTotal`, `wouldLimitTotal` (once per goal per period), `lastAt` |
| `checkFailed` | `count`, `lastAt`, `consecutive`: failed budget reads (fail-open). `consecutive` is reset by a fully successful claim evaluation or alert sweep, so a budget that fails on every sweep keeps it growing |

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
| `budget_warn:<budgetId>:<periodKey>` | warning | a limit reached `warnPct` % this period |
| `budget_exhausted:<budgetId>:<periodKey>` | critical | a limit is exhausted this period |

`<periodKey>` is the month key, such as `2026-11`. The metadata field `period`
is the budget's period type (`month`).

The metadata names the budget, scope, period, which limit crossed (`limits`),
spent against limit, `warnPct`, `enforce`, and the configured and effective
mode. At most one alert per budget and period is open at a time. It resolves
when the period rolls, or when a raised or cleared limit ends the condition.
It can open again in the same period if spend crosses the line again.
Exhausted replaces warn. Alerts are evaluated by the stale-reaper sweep (every
`STALE_REAPER_INTERVAL_SEC`, default 60 s; up to 200 budgets per sweep, changed
budgets first), in every mode.

The stale-reaper sweep also runs the spend reconciliation, late-metering
repair and goal `budget_limited` / resume. If stale reaping is disabled
(`STALE_REAPER_ENABLED=0`; default `1`, interval `STALE_REAPER_INTERVAL_SEC`),
none of these run: budget alerts are computed only once at startup (for up to
1 000 budgets), goals are
never limited or resumed by budget, and rolling back to mode `off` does not
resume limited goals until stale reaping is on again. Check it before
switching the mode.

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
  `budgetOmitted` and `budgetScanCapped`. So a polling worker stops getting
  403s after its next poll. A worker on the SSE stream can get a 403 for a
  task announced before its scope ran out. The broker sends every stream a
  fresh `worker-assignment-snapshot` when the budget state changes (a write,
  the period roll, or the sweep seeing a budget become exhausted or stop
  being exhausted); the snapshot replaces the worker's queued set, so those
  tasks drop out of it.
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
`budget_enforcement_not_on`; this also holds after a restart in `off`). A goal
whose goal budget is no longer in memory (a write that did not land) resumes
the same way. Goals limited for another reason are never touched.

## 9. Roll back

In order of preference:

1. **Mode `off`** (restart, **owner approval**): nothing is refused or hidden;
   goals limited by a budget resume over the next sweeps; budgets, status and
   alerts keep working.
2. **Revert the code** to an earlier release of the same schema version
   (v14), if one exists. Budgets and the ledger stay in the database
   untouched. If the release you are rolling back from is the first one with
   schema v14, there is no such release; use step 1 or step 3. (Check the
   release notes, or `SQLITE_SCHEMA_VERSION` in the candidate release's
   `packages/broker/src/core/store/store.ts`.)
3. **Restore the pre-upgrade backup taken in §1** to go back before schema 14
   (**owner approval**: a database restore). This replaces the **whole broker
   state database**. Everything recorded since the backup was taken is lost
   with it, not only spend: tasks, goals, exchanges, audit events, budgets and
   the spend ledger. Work that ran after the backup is in the current store
   only. Before restoring:
   - stop the broker;
   - keep a copy of the current (v14) database next to the backup, made the
     same WAL-safe way as in §1. Verify it with `PRAGMA integrity_check`; its
     `schema_version` is 14. That way the ledger and audit records since the
     upgrade are not destroyed with no copy left;
   - move the current `-wal` and `-shm` files away before putting the restored
     file in place, so SQLite does not replay v14 WAL frames into it.

Never delete budget or spend rows by hand: the ledger is the audit record, and
budget audit events are exempt from retention for that reason.
