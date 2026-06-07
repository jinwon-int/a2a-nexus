# Legacy Parity Fixtures — Delete-Readiness Checklist

> Refs: plugin-a2a#16, parent #6
>
> Scope: a2a-broker + openclaw-plugin-a2a only (no archived legacy repo access).

This document captures which lifecycle/status behaviors from the original
A2A system must be preserved before the archived legacy repository can be
safely deleted. It is derived by cross-referencing the broker's current
state machine, the plugin's type mappings, and the regression matrix
(`docs/regression-matrix.md`).

## Methodology

1. Enumerate all broker `AuditAction` values and SSE `reason` values.
2. Trace each through the plugin's mapping layer (`gateway-handlers.ts`).
3. Identify any behavior that has **no active owner** or **no test coverage**
   in either repo.
4. Flag gaps as delete blockers.

---

## 1. Broker Status → Plugin Mapping Coverage

| Broker Status | Plugin `executionStatus` | Plugin `deliveryStatus` | Tested? | Owner |
|---|---|---|---|---|
| `queued` | `accepted` | `pending` | ✅ plugin-a2a#18 (6a) | node-remote |
| `claimed` | `accepted` | `pending` | ✅ plugin-a2a#18 (6a) | node-remote |
| `running` | `running` | `pending` | ✅ plugin-a2a#18 (6a) | node-remote |
| `succeeded` | `completed` | `skipped` | ✅ plugin-a2a#18 (6a) | node-remote |
| `failed` (generic) | `failed` | `skipped` | ✅ plugin-a2a#18 (6a) | node-remote |
| `failed` + `timeout` code | `timed_out` | `skipped` | ✅ plugin-a2a#18 (6a) | node-remote |
| `canceled` | `cancelled` | `skipped` | ✅ plugin-a2a#18 (6a) | node-remote |

**Verdict**: All status transitions are mapped and tested. **No blocker.**

---

## 2. Broker Audit Actions vs Plugin SSE Reasons

### Broker AuditAction (ground truth for persistence)
```
proposal.created, artifact.attached, validation.submitted,
proposal.approved, proposal.rejected, proposal.applied,
exchange.message.added, task.created, task.claimed, task.started,
task.reassigned, task.requeued, task.succeeded, task.failed,
task.canceled, worker.registered, worker.heartbeat
```

### Plugin SSE Status Update Reasons
```
created, claimed, started, succeeded, failed, canceled,
reassigned, requeued, dead_lettered
```

### Gap Analysis

| Behavior | Broker Audit | Plugin SSE | Plugin Handles? | Tested? | Blocker? |
|---|---|---|---|---|---|
| Task created | `task.created` | `created` | ✅ (read) | ❌ no e2e test | No — smoke covered |
| Task claimed | `task.claimed` | `claimed` | ✅ (read) | ❌ no e2e test | No — broker test covers |
| Task started | `task.started` | `started` | ✅ (read) | ❌ no e2e test | No — broker test covers |
| Task succeeded | `task.succeeded` | `succeeded` | ✅ (read) | ✅ plugin-a2a#18 | No |
| Task failed | `task.failed` | `failed` | ✅ (read) | ✅ plugin-a2a#18 | No |
| Task canceled | `task.canceled` | `canceled` | ✅ (read) | ✅ plugin-a2a#18 (6f) | No |
| Task reassigned | `task.reassigned` | `reassigned` | ✅ (SSE schema) | ❌ | **No** — reassign is operator-initiated |
| Task requeued | `task.requeued` | `requeued` | ✅ (SSE schema) | ❌ | No — broker#11 recovery gate covers |
| Dead-lettered | `task.failed` + error code | `dead_lettered` | ⚠️ **partial** | ❌ | **See §3** |
| Proposal lifecycle | 6 actions | — | ❌ not in plugin scope | ❌ | No — proposals are broker-internal |
| Exchange messages | `exchange.message.added` | — | ❌ not in plugin scope | ❌ | No — exchange is broker-internal |
| Worker lifecycle | `worker.registered/heartbeat` | — | ❌ not in plugin scope | ❌ | No — workers are broker-side |

---

## 3. Dead-Letter Handling — Key Gap

### Current Behavior

The broker dead-letters a task by:
1. Setting `task.status = "failed"`
2. Setting `task.error.code = "exceeded_requeue_limit"`
3. Emitting audit `task.failed` (not `task.dead_lettered`)
4. Emitting SSE reason `"dead_lettered"`

The plugin side:
- `mapBrokerStatusToExecutionStatus` → `"failed"` (correct, it's `failed` in the broker)
- **No special handling** for `exceeded_requeue_limit` error code
- SSE schema knows about `"dead_lettered"` reason but the plugin does not
  act on it differently from any other `"failed"` reason

### Assessment

This is **not a silent data loss risk** — dead-lettered tasks arrive as
`failed` with a distinct error code that operators can inspect. The
regression matrix (scenario 3) already calls this out: the SSE reason
chain is the ground truth, and the plugin symptom for dead-letter is
`executionStatus = "failed"` with a non-timeout error code.

### Recommendation

Add a **unit test** verifying that `exceeded_requeue_limit` maps to
`executionStatus = "failed"` (not `timed_out`). This prevents a future
code change from accidentally treating it as a timeout.

| Item | Target Repo | Priority | Owner |
|---|---|---|---|
| Unit test: `exceeded_requeue_limit` → `failed` | plugin-a2a | Low | node-remote (this PR) |

---

## 4. Broker Error Codes — Plugin Awareness

| Broker Error Code | Plugin `isTimeoutCode`? | Plugin Mapping | Tested? | Gap? |
|---|---|---|---|---|
| `timeout` | ✅ | `timed_out` | ✅ plugin-a2a#18 | No |
| `timed_out` | ✅ | `timed_out` | ✅ plugin-a2a#18 | No |
| `broker_timeout` | ✅ | `timed_out` | ✅ plugin-a2a#18 | No |
| `exceeded_requeue_limit` | ❌ | `failed` | ❌ | **Low** — add test |
| `policy_denied` | ❌ | surfacing via `toGatewayError` | ❌ | No — not in scope |
| `bad_request` | ❌ | surfacing via `toGatewayError` | ❌ | No — not in scope |

---

## 5. Cancel Lifecycle — Broker vs Plugin

### Broker cancel rules (enforced in `cancelTask`):
- Terminal tasks (`succeeded`, `failed`, `canceled`) → return as-is (no-op)
- Actor must be: `hub`, `operator`, requester, or assigned worker
- Otherwise: throws `policy_denied`

### Plugin cancel handler:
- Uses `resolvedConfig.requester` as actor (falls back to `brokerTask.requester`)
- Passes actor to broker `cancelTask`
- Maps `canceled` → `abortStatus = "aborted"`, otherwise `"not-attempted"`

### Gap

| Behavior | Broker | Plugin | Tested? | Gap? |
|---|---|---|---|---|
| Cancel on terminal task | Returns task as-is | `buildGatewayTaskResult` → `abortStatus = "not-attempted"` | ✅ plugin-a2a#18 (6f) | No |
| Cancel with policy_denied | Throws `policy_denied` | `toGatewayError` wraps as `INVALID_REQUEST` | ❌ | **Low** — add test |
| Cancel by non-matching actor | Throws `policy_denied` | Same as above | ❌ | Same as above |

---

## 6. Fixture Shapes Required for Regression

These are the minimal broker task shapes that the plugin contract depends on:

### 6.1 Happy-path task (succeeded)
```ts
{
  id: string, status: "succeeded",
  requester: { id, kind, role },
  target: { id },
  assignedWorkerId: string,
  claimedBy: string,
  claimedAt: string, startedAt: string, completedAt: string,
  result: { summary?, output?, artifactIds?, validation?, apply?, note? },
  payload: {
    requesterSessionKey, requesterChannel,
    targetSessionKey, targetDisplayKey,
    correlationId, parentRunId,
  },
}
```
**Coverage**: ✅ plugin-a2a#18

### 6.2 Failed with timeout
```ts
{ ..., status: "failed", error: { code: "timeout", message: "..." } }
```
**Coverage**: ✅ plugin-a2a#18

### 6.3 Failed with dead-letter (exceeded_requeue_limit)
```ts
{
  ...,
  status: "failed",
  error: {
    code: "exceeded_requeue_limit",
    message: "dead-lettered after N automatic requeues: ...",
    details: { requeueCount, maxRequeueAttempts, previousStatus, lastRequeueReason },
  },
}
```
**Coverage**: ❌ — needs test

### 6.4 Canceled
```ts
{ ..., status: "canceled" }
```
**Coverage**: ✅ plugin-a2a#18

### 6.5 Canceled on already-terminal (no-op cancel)
```ts
// broker returns task as-is with original terminal status
{ ..., status: "succeeded" }  // or "failed"
```
**Coverage**: ✅ plugin-a2a#18

---

## 7. Delete Blocker Summary

| # | Item | Severity | Owner | Action |
|---|---|---|---|---|
| 1 | `exceeded_requeue_limit` not explicitly tested | Low | node-remote | Add unit test in plugin-a2a (this PR) |
| 2 | `policy_denied` on cancel not tested | Low | node-remote | Add unit test in plugin-a2a (this PR) |
| 3 | End-to-end stale/requeue/dead-letter flow | Medium | worker-alpha | broker#8 covers stale-task recovery |
| 4 | SSE `dead_lettered` reason handling | Low | node-remote | Documented in regression matrix §3 |

**Overall verdict**: No hard blockers for deletion. All critical lifecycle
behaviors are preserved. The gaps above are low-priority test improvements
that can be addressed before or after deletion.

---

## 8. Recommended Target Repo Ownership for Future Regression Tests

| Scenario | Primary Repo | Notes |
|---|---|---|
| Status mapping (6a) | plugin-a2a | ✅ Done |
| Error shaping (6b) | plugin-a2a | ✅ Done |
| Payload round-trip (6d) | plugin-a2a | ✅ Done |
| Output envelope (6e) | plugin-a2a | ✅ Done |
| Cancel result shape (6f) | plugin-a2a | ✅ Done |
| Validator errors (6g) | plugin-a2a | ✅ Done |
| Task-not-found (8) | plugin-a2a | ✅ Done |
| Dead-letter error code mapping | plugin-a2a | Add to first-wave tests |
| Cancel policy_denied error | plugin-a2a | Add to first-wave tests |
| Stale requeue e2e | a2a-broker | broker#8 (worker-alpha) |
| Dead-letter e2e | a2a-broker | broker#8 (worker-alpha) |
| Restart recovery | a2a-broker | broker#11 (node-remote, done) |
| Compose smoke (happy path) | a2a-broker | broker#11 (node-remote, done) |
| Rate-limit 429 surfacing | plugin-a2a | Needs broker mock or integration test |
| Auth 401/403 surfacing | plugin-a2a | Needs broker mock or integration test |
| Success path e2e (request→succeed) | plugin-a2a | Needs sibling broker fixture |
