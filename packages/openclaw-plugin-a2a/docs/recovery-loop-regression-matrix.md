# Recovery Loop E2E Regression Matrix

Closes jinwon-int/plugin-a2a#76.

This document defines the regression surface for the **recovery loop**:
inspect → decide → recover → verify. The broker owns recovery primitives
(requeue, cancel, dead-letter, stale-task reaper); the plugin owns the
contract boundary that surfaces recovery state and drives recovery actions
from the OpenClaw gateway.

## Recovery loop phases

| Phase | Owner | Description |
|-------|-------|-------------|
| **Inspect** | Broker | Recovery snapshot: stale workers, dead-lettered tasks, requeue counts, oldest running |
| **Decide** | Plugin/Gateway | Evaluate snapshot → determine recovery action (requeue/cancel/ignore) |
| **Recover** | Plugin → Broker API | Execute recovery action via gateway methods |
| **Verify** | Plugin | Check post-recovery state matches expectation |

## Broker recovery primitives (reference)

- `requeueTask(taskId)` — reset claimed/running task back to `queued`
- `cancelTask(taskId)` — mark task as `canceled`
- Stale-task reaper — auto-requeues tasks past heartbeat/lease window
- Dead-letter — `failed` after `maxRequeueAttempts` exceeded
- Recovery snapshot — `broker.recovery` section with totals + recent events

## Plugin-side regression scenarios

### R1. Green path — successful task completes, no recovery needed

- **Setup**: task queued → claimed → running → succeeded. Normal lifecycle.
- **Inspect**: recovery snapshot shows `totalRequeued: 0`, `totalDeadLettered: 0`.
- **Decide**: no action needed.
- **Pass signals**:
  - Recovery snapshot is clean (zero recovery counters).
  - Plugin does not invoke any recovery gateway method.
  - Task status maps correctly through type-mapping.
- **Coverage**: **automated** (existing regression tests cover this path).

### R2. Stale queued handoff — task claimed but worker never starts

- **Setup**: task claimed by worker, then worker goes stale. Broker reaper
  requeues the task.
- **Inspect**: `recentRequeues` contains an event for the task.
  `requeueCount` incremented.
- **Decide**: requeue is automatic (broker reaper); plugin observes via
  SSE or polling.
- **Recover**: broker auto-requeues → plugin sees status change.
- **Pass signals**:
  - `mapBrokerStatusToExecutionStatus("queued")` → `"accepted"` (requeued
    back to queue).
  - Wake is dispatched for the requeued task (new wake key).
  - Previous wake (if any) is not suppressed (different waitRunId after
    requeue).
- **Coverage**: **automated** — wake layer test for requeued task.

### R3. Failed child session — child task fails, parent needs attention

- **Setup**: fanout with 2 children. Child-0 succeeds, child-1 fails
  (worker crash, not timeout).
- **Inspect**: `recentDeadLetters` or failed task visible in snapshot.
- **Decide**: parent task should be marked failed; operator notified.
- **Recover**: broker marks parent failed; plugin surfaces to gateway.
- **Pass signals**:
  - `mapBrokerStatusToExecutionStatus("failed")` → `"failed"` (not
    `"timed_out"` — no timeout error code).
  - Gateway response includes the failed child's `taskId`.
  - Wake for failed child is skipped (`terminal_task`).
- **Coverage**: **automated**.

### R4. Cancelled run retry — operator cancels, then retries

- **Setup**: parent running with children. Operator cancels parent. All
  children cancelled. Operator creates a retry parent.
- **Inspect**: canceled tasks in history. New task in queue.
- **Decide**: retry is a new task, not a recovery of the old one.
- **Recover**: new task dispatched normally.
- **Pass signals**:
  - Cancelled children → wake skipped (`terminal_task`).
  - New retry task → independent wake, not suppressed.
  - Cancel and retry have different task IDs → no idempotency collision.
- **Coverage**: **automated**.

### R5. Duplicate GitHub event replay — SSE reconnect delivers duplicate events

- **Setup**: SSE connection drops and reconnects. Broker replays buffered
  events via `replayTaskEvents(afterSeq)`.
- **Inspect**: broker delivers replayed events with sequence numbers.
- **Decide**: plugin deduplicates based on wake keys.
- **Recover**: duplicate wakes suppressed; only new events processed.
- **Pass signals**:
  - First wake for an event → `scheduled`.
  - Replay of same event (same wake key) → `skipped`,
    `code: "duplicate_wake"`.
  - Recovery action not duplicated.
- **Coverage**: **automated**.

### R6. Max requeue exhausted — task dead-lettered after too many requeues

- **Setup**: task requeued `DEFAULT_MAX_REQUEUE_ATTEMPTS` (5) times.
  Next reaper pass marks it `failed` with error code
  `exceeded_requeue_limit`.
- **Inspect**: `totalDeadLettered` incremented. Task in
  `recentDeadLetters` with `requeueCount: 5`.
- **Decide**: task is terminal — no further recovery possible.
- **Pass signals**:
  - `mapBrokerStatusToExecutionStatus("failed")` → `"failed"`.
  - Error code `exceeded_requeue_limit` is preserved in gateway response.
  - Plugin does not attempt to re-requeue.
- **Coverage**: **automated**.

### R7. Low-resource / slow-node timing — delayed wake dispatch

- **Setup**: host or mobile node with high latency. Wake dispatch takes
  longer than usual. Rate limiter is active.
- **Decide**: rate limiter may suppress some wakes; broker-side timeout
  may fire before worker responds.
- **Pass signals**:
  - Rate-limited wakes return `skipped`, `code: "rate_limited"`.
  - Timeout paths produce `timed_out` status (distinct from generic
    `failed`).
  - Recovery snapshot shows the timed-out task for operator inspection.
- **Coverage**: **automated** — rate limit + timeout mapping tests.

### R8. Concurrent recovery — two inspectors see same stale task

- **Setup**: Two plugin instances (or one plugin + manual CLI) both
  inspect and try to recover the same stale task.
- **Decide**: broker handles idempotency — duplicate requeue/cancel is
  safe.
- **Pass signals**:
  - `requeueTask` on an already-queued task is idempotent.
  - `cancelTask` on an already-terminal task is idempotent.
  - No double-dispatch of wakes.
- **Coverage**: **automated** (broker-side idempotency; plugin verifies
  no duplicate wake).

## Acceptance criteria mapping

| AC from #76 | Covered by |
|---|---|
| E2E or integration tests prove at least one full recovery loop | R2, R5 |
| Failure scenarios assert next-action text or recovery state | R3, R6 |
| Matrix documents what is automated, what is manual, and why | This doc |
| Tests stay deterministic and do not rely on wall-clock race assumptions | All (deterministic clocks) |

## Coverage summary

| Scenario | Automated | Manual | Notes |
|---|---|---|---|
| R1. Green path | ✅ | | Existing regression tests |
| R2. Stale queued handoff | ✅ | | Wake layer + type-mapping |
| R3. Failed child session | ✅ | | Wake + mapping |
| R4. Cancelled run retry | ✅ | | Wake + idempotency |
| R5. Duplicate event replay | ✅ | | Wake dedup |
| R6. Max requeue exhausted | ✅ | | Mapping + error code |
| R7. Low-resource timing | ✅ | | Rate limit + timeout |
| R8. Concurrent recovery | ✅ | | Broker idempotency |

## Test files

- `test/recovery-loop.test.mjs` — R2–R8 regression tests
- Existing `test/wake-layer.test.mjs` — R5, R7 (referenced)
- Existing `tests/regression-first-wave.test.ts` — R1, R6 (referenced)
