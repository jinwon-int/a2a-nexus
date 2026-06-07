# Cleanup Candidate Actionability

**Issue:** [#824](https://github.com/jinwon-int/a2a-broker/issues/824)
**Date:** 2026-05-20
**Author:** yukson (Team1, lane 4/4)

## Problem

The broker has two distinct cleanup discovery surfaces that serve different
purposes. Operators inspecting `/cleanup/candidates` (heuristic discovery) may
see non-zero candidate counts and mistakenly assume those candidates are all
safely prunable. Some candidates are **discoverable but not executable** — they
are blocked by safety gates, risk classification, or architectural constraints.

This document explains the actionability categories and the distinction between
"total candidates discovered" and "total candidates safely prunable."

## Two Cleanup Systems

The broker exposes two independent cleanup APIs:

| Endpoint | Method | Produces | Purpose |
|---|---|---|---|
| `/cleanup/candidates` | GET | `CleanupDryRunPlan` | Heuristic discovery of potential cleanup candidates from broker state |
| `/operator/cleanup/plan` | GET | `BrokerCleanupPlan` | SQLite hot-table retention planning: actual prunable rows |
| `/operator/cleanup/execute` | POST | `BrokerCleanupExecutionResult` | Execute the prune plan with operator approval |

The first endpoint (`/cleanup/candidates`) is **discovery-only** — it identifies
records that *may* need operator attention. The second endpoint
(`/operator/cleanup/plan`) is a **retention planner** — it computes which rows
actually exceed retention policies and are eligible for pruning.

## Actionability Categories

Each cleanup candidate class has a distinct actionability profile:

| Candidate Class | Discovered by | Prunable via retention? | Blocked by | Actionability |
|---|---|---|---|---|
| `stale_worker` (no active tasks) | `discoverCleanupCandidates` | ✅ Yes | `allowWorkerPrune=true` required | Prunable with explicit opt-in |
| `stale_worker` (with active tasks) | `discoverCleanupCandidates` | ❌ No | `high_risk` — active tasks prevent pruning | Must reassign tasks first |
| `malformed_task` | `discoverCleanupCandidates` | ❌ No | Not a retention target; requires manual intervention | Operator must inspect/cancel |
| `queued_residue` | `discoverCleanupCandidates` | ❌ No | Not a retention target; tasks are non-terminal | Operator must verify capacity |
| `orphaned_claim` | `discoverCleanupCandidates` | ❌ No | Not a retention target; tasks are non-terminal | Operator must requeue/fail |
| `terminal_outbox_backlog` | `discoverCleanupCandidates` | ⚠️ Dry-run only | `executionBlockedByDefault` — separate ACK path needed | Pending separate approval path |
| `historical_terminal_task` | `discoverCleanupCandidates` | ✅ Yes | None if tombstone exists | Prunable (risk depends on tombstone) |

## Total Candidates vs. Prune Candidates

The key metric gap:

```
CleanupDryRunPlan.totalCandidates  >=  BrokerCleanupPlan.summary.totalPruneCandidates
```

In practice, `totalCandidates` is typically **larger** than `totalPruneCandidates` because:

1. **Heuristic vs. retention**: `discoverCleanupCandidates` scans *all* broker
   state (workers, active+terminal tasks, outbox) for anomalies. The retention
   planner (`buildBrokerCleanupPlan`) only considers rows past configured
   retention windows (`taskRetentionMs`, `workerRetentionMs`, etc.).

2. **Non-terminal candidates**: `queued_residue`, `orphaned_claim`, and
   `malformed_task` candidates are by definition non-terminal tasks. The
   retention planner only prunes *terminal* tasks. These non-terminal candidates
   require operator intervention (requeue, cancel, or capacity review), not
   automated pruning.

3. **Safety-blocked rows**: Stale workers with active tasks are discovered as
   candidates but retained by the planner because their assigned tasks are still
   active. Terminal outbox events are discovered but `executionBlockedByDefault`.

### Walkthrough: candidates > 0, prune count = 0

```
Scenario: 2 queued tasks (stale, unclaimed), 1 stale worker with active tasks

discoverCleanupCandidates output:
  totalCandidates: 3
    - 1 stale_worker (high_risk — has active tasks)
    - 2 queued_residue (caution)

buildBrokerCleanupPlan output:
  totalPruneCandidates: 0
    - broker_tasks: pruneCount=0 (no terminal tasks past retention)
    - broker_workers: pruneCount=0 (worker has active tasks → retained)
    - broker_audit_events: pruneCount=0
    - broker_terminal_outbox: pruneCount=0 (no outbox events)
```

In this case `totalCandidates=3` but `totalPruneCandidates=0`. The operator
must first reassign or cancel the stale tasks before the retention planner can
safely prune the worker row.

## Why Two Systems?

The two-system architecture is intentional:

- **`discoverCleanupCandidates`** is a health/visibility tool. It runs from
  the in-memory broker (`InMemoryA2ABroker`) and does not require SQLite
  persistence. It surfaces candidate classes that need manual operator review
  (queued residue, orphaned claims, malformed tasks) — classes the retention
  planner intentionally does not touch.

- **`buildBrokerCleanupPlan`** is a persistence-level retention tool. It runs
  against the SQLite store and computes exact prune sets based on retention
  policies. It has safety gates backed by plan-id hashing, confirmation
  strings, backup requirements, and explicit worker-prune opt-in.

## Consumer Compatibility Notes

Existing consumers of `/cleanup/candidates` should:

1. **Not treat `totalCandidates > 0` as an actionable signal to prune**.
   Instead, cross-reference against `/operator/cleanup/plan` to see which
   candidates are actually prunable via retention.

2. **Interpret `riskNotes` for operator guidance**. The `riskNotes` array
   explains each candidate class and the recommended action.

3. **Use `stale_worker.hasActiveTasks` metadata** to distinguish stale workers
   that block pruning from those that can be safely pruned with
   `allowWorkerPrune=true`.

4. **Plan for non-terminal candidates to require manual steps**:
   - `queued_residue`: Verify worker capacity; cancel or reassign tasks.
   - `orphaned_claimed`: Requeue or fail the task to unblock the queue.
   - `malformed_task`: Inspect payload; cancel with error documentation.
   - `terminal_outbox_backlog`: Requires separate operator ACK/prune approval

## Risk Notes Reference

When `discoverCleanupCandidates` emits risk notes, they map to actions:

| Risk Note | Implication |
|---|---|
| "Stale workers detected (N)" | Verify worker health before pruning |
| "Queued residue detected (N)" | Tasks unclaimed after stale threshold; check routing |
| "Orphaned claims detected (N)" | Require requeue or fail before they can be pruned |
| "Terminal outbox backlog detected (N)" | Notifier may be disconnected; retry delivery |
| "Historical terminal tasks detected (N)" | Safe to archive if tombstone exists |
| "Malformed queued tasks detected (N)" | Indicates upstream ingestion issues |

## References

- `src/core/types.ts` — `CleanupCandidate`, `CleanupDryRunPlan` type definitions
- `src/core/broker.ts` — `discoverCleanupCandidates()` implementation
- `src/core/broker-cleanup.ts` — `buildBrokerCleanupPlan()`, `executeBrokerCleanupPlan()`
- `src/core/store.ts` — `planHot*Retention()` methods
- `docs/api-spec-draft.md` — API route documentation
- `docs/hot-table-retention-prune-runbook.md` — Retention and execution runbook
