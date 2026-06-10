# Orchestration E2E Regression Matrix

Closes jinwon-int/plugin-a2a#71.

This document defines the regression surface for **multi-task orchestration
patterns** as seen from the plugin's gateway and wake layers. The broker
owns orchestration logic (fanout/split/review/swarm scheduling, barrier
enforcement, parent-child linking); the plugin owns the contract boundary
that surfaces those semantics to the OpenClaw runtime.

## Relationship to docs/regression-matrix.md

`regression-matrix.md` covers **single-task** lifecycle scenarios. This
document covers **multi-task orchestration** scenarios where the plugin
must correctly handle parent-child relationships, duplicate wake
suppression, partial failure propagation, and cancellation fan-out.

## Assignment modes (broker-side)

| Mode | Pattern | Broker fixture |
|------|---------|----------------|
| fanout | 1 parent → N children on **different** workers | `buildFanoutFixture` |
| split | 1 parent → N children on the **same** worker | `buildSplitFixture` |
| review | 1 parent → implementer child → reviewer task | `buildReviewFixture` |
| swarm | 1 parent → N children + barrier + threshold | `buildSwarmFixture` |

Broker fixtures: `a2a-broker/src/fixtures/team-assignment.ts`

## Plugin-side regression scenarios

### O1. Fanout — distinct wake routing

- **Setup**: broker dispatches fanout children to worker-alpha and
  worker-beta. Each child task triggers an independent wake via the
  plugin wake layer.
- **Pass signals**:
  - Both wakes evaluate as `scheduled` (not suppressed).
  - Wake keys differ (different `correlationId` or `waitRunId`).
  - No `coalesced: true` — different sessions.
  - `idempotencyKey` uniquely identifies each wake.
- **Coverage**: **automated** (`test/orchestration-wake.test.mjs`).

### O2. Split — coalesced wake for same-session children

- **Setup**: broker dispatches split children to the same worker.
  Both children target the same session key.
- **Pass signals**:
  - First wake: `scheduled`, `mode: "resume_or_launch"`.
  - Second wake: `scheduled`, `mode: "append_to_active_session"`,
    `coalesced: true`.
  - Both share the same `sessionKey`.
- **Coverage**: **automated**.

### O3. Review — sequential dependency wake ordering

- **Setup**: broker creates implementer child, then after child
  succeeds, creates reviewer task on a different worker.
- **Pass signals**:
  - Implementer wake and reviewer wake have distinct keys.
  - Neither is suppressed as duplicate.
  - Reviewer wake targets a different session than implementer.
- **Coverage**: **automated**.

### O4. Swarm — barrier child not woken prematurely

- **Setup**: broker has 3 swarm children; only 1 has completed.
  Barrier child (child 2) is still `queued`.
- **Pass signals**:
  - Completed child's wake is `scheduled`.
  - Running child's wake is `scheduled`.
  - Queued barrier child's wake is **skipped** (`terminal_task` or
    broker does not emit wake for `queued` tasks).
  - Parent remains `running` — no parent-level wake yet.
- **Coverage**: **automated**.

### O5. Partial failure — one child fails, parent status

- **Setup**: fanout with 2 children. Child-0 succeeds, child-1 fails.
- **Pass signals**:
  - `mapBrokerStatusToExecutionStatus("failed")` → `"failed"`.
  - Plugin surfaces the failure with the child's `taskId` identifiable
    in the error/gateway response.
  - Parent task status (when queried) reflects failure — the broker
    handles this; plugin must not mask it.
- **Coverage**: **automated** — type-mapping unit test + wake
  evaluation for failed child.

### O6. Cancellation fan-out — operator cancels parent

- **Setup**: parent is `running` with N children. Operator cancels
  parent. Broker cancels all children.
- **Pass signals**:
  - Cancelled children produce wake envelopes with terminal
    `brokerStatus` → plugin skips (`terminal_task`).
  - If a cancel wake arrives for an already-completed child, it is
    still skipped (idempotent).
  - No `duplicate_wake` suppression fires between the cancel and the
    completion — they have different keys.
- **Coverage**: **automated**.

### O7. Duplicate dispatch suppression — exact replay

- **Setup**: broker replays the same wake (e.g., SSE reconnect) for
  a child task.
- **Pass signals**:
  - Second wake with identical `wakeKey` → `skipped`,
    `code: "duplicate_wake"`.
  - Original wake is not affected.
- **Coverage**: **automated**.

### O8. Rate limiting — burst of same-node wakes

- **Setup**: swarm dispatches 5 children to the same node within a
  short window. Rate limit is 3 per window.
- **Pass signals**:
  - First 3 wakes: `scheduled`.
  - Wakes 4 and 5: `skipped`, `code: "rate_limited"`.
  - Rate limit window is sliding — older wakes expire.
- **Coverage**: **automated**.

### O9. Payload round-trip — orchestration metadata preserved

- **Setup**: child task created with `parentTaskId`,
  `assignmentMode`, `childIndex` in payload.
- **Pass signals**:
  - `readBrokerTaskPayload` returns the full payload including
    orchestration fields.
  - `buildGatewayTaskOutput` does not strip unknown payload keys.
- **Coverage**: **automated**.

### O10. Lifecycle transition matrix — parent state progression

- **Setup**: parent transitions through queued → running → succeeded
  (or failed/canceled) as children complete.
- **Pass signals**:
  - Plugin's `mapBrokerStatusToExecutionStatus` correctly maps each
    broker parent status.
  - `buildGatewayTaskStatus` includes all child-relevant metadata.
  - No regression when parent transitions from `running` to terminal.
- **Coverage**: **automated** — maps onto existing type-mapping tests.

## Acceptance criteria mapping

| AC from #71 | Covered by |
|---|---|
| Documented matrix showing which mode/path is covered | This doc (O1–O10) |
| At least one regression test proves partial failure does not silently pass | O5 |
| Test output makes the failing child/task easy to identify | O5, O6 |

## Test files

- `test/orchestration-wake.test.mjs` — O1, O2, O3, O4, O7, O8
- `tests/regression-first-wave.test.ts` — O5 (partial failure mapping), O9 (payload round-trip), O10 (lifecycle)
- `test/wake-layer.test.mjs` — O7, O8 (existing coverage, referenced)
