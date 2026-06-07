# Operator dashboard snapshot

`GET /dashboard` includes an additive `operatorSnapshot` object for operator UIs and incident handoffs. It is a compact JSON projection over the broker's workers, task status counters, recovery signals, and attention items.

## Shape

```json
{
  "operatorSnapshot": {
    "generatedAt": "2026-04-30T10:00:00.000Z",
    "workers": { "total": 4, "online": 3, "stale": 1, "byNode": [] },
    "taskStatusSummary": {
      "total": 12,
      "active": 5,
      "terminal": 7,
      "byStatus": { "queued": 2, "claimed": 1, "running": 2, "succeeded": 6, "failed": 1 }
    },
    "recoverySummary": {
      "stale": {
        "staleWorkerAssignments": 1,
        "staleWorkersWithActiveTasks": [],
        "oldestClaimed": null,
        "oldestRunning": null
      },
      "retry": {
        "totalRequeued": 2,
        "maxRequeueAttempts": 2,
        "recentRequeues": []
      },
      "deadLetter": {
        "totalDeadLettered": 1,
        "recentDeadLetters": []
      }
    },
    "attentionItems": []
  }
}
```

## Attention items

Each `attentionItems[]` entry is designed to answer the operator's first three questions without opening raw task/session logs:

- `whyStuck`: broker-owned reason the task needs attention (stale worker, stale task heartbeat, long-running task, prior requeue, or dead-letter).
- `whoClaimed`: worker/claimant identity when known.
- `whatNext`: recommended operator action, such as checking the worker, requeueing stale work, reassigning to a healthy worker, or inspecting dead-letter evidence.

Items also include `taskId`, `status`, `intent`, `targetNodeId`, `assignedWorkerId`, `claimedBy`, `requeueCount`, `statusAgeSec`, and relevant terminal error fields.

## Operator interpretation

- **Stale**: `recoverySummary.stale` and `stale_worker`/`stale_task` attention items indicate work that may be stuck because the worker heartbeat or task heartbeat is too old.
- **Retry**: `recoverySummary.retry` shows how much stale work has been recycled and what cap (`maxRequeueAttempts`) applies before dead-lettering.
- **Dead-letter**: `recoverySummary.deadLetter` and `dead_lettered` attention items identify tasks that exhausted retries and require human review before recreating/reassigning work.

The projection intentionally excludes secrets, private filesystem paths, and raw session dumps.

## Control Tower Slice

`GET /control-tower` is a read-only aggregate for A2A control tower clients. It combines:

- queue status and recovery/attention summaries from `GET /dashboard`;
- worker dispatch capacity from `GET /workers/capacity`;
- Terminal Brief inbox health from `GET /terminal-brief/inbox`.

The endpoint is explicitly non-mutating. It does not dispatch work, ACK Terminal Brief rows, replay providers, prune state, restart services, deploy broker code, or mutate the database.

### Scheduler Control Tower Summary v2 (`scheduler-control-tower.ts`)

`buildSchedulerControlTowerSummaryV2()` and the convenience `buildQueueGroupSummary()` output a structured, deterministic read-only summary that extends the basic capacity view with:

**Worker-level capacity signals** (`WorkerCapacitySlot`) — per-worker breakdown of active, queued, claimed, and running tasks, plus optional max-concurrent-task limits and utilization percentages when capability-card data is available.

**Queue grouping** across five dimensions:
- **worker** — by assigned worker / target node
- **role** — by worker role (analyst, researcher, operator, …)
- **repo** — by GitHub repository or workspace id (extracted from payload or workspace ref)
- **task type** — by task intent (`propose_patch`, `analyze`, …)
- **priority** — by priority level (defaults to `default`; future-ready for native priority fields)

Each group entry includes a count, status breakdown, and the age of the oldest task in the group. Groups are sorted by descending count.

The summary also includes a Markdown renderer (`renderSchedulerControlTowerSummary()`) for CLI consumption.

See `src/core/scheduler-control-tower.ts` for types and functions. The module is pure — no mutation, dispatch, ACK/replay, or DB writes.

`GET /terminal-brief/inbox` is the bounded Terminal Brief inbox view. It defaults to unacked rows and reports `rawUnacked`, `actionableUnacked`, `ackEligibleUnacked`, `providerSendOnlyUnacked`, and `ackIneligibleProjectionRows` so parent-broker-only projection rows do not appear as false operator blockers.
