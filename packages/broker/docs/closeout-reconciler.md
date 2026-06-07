# Autonomous Aggregate Closeout Reconciler

> Round 17 · Issue #78 · a2a-broker

## Overview

Deterministic closeout decision engine for parent aggregate tasks. Consumes child task events and produces `ready`, `waiting`, `blocked`, or `failed` verdicts without polling.

## Decision Types

| Decision | Meaning | Signals |
|---|---|---|
| `ready` | All children terminal, parent can close | None |
| `waiting` | Children still in progress | Active/queued child IDs |
| `blocked` | Fail-fast triggered (failure/cancel/stale) | Blocking child IDs |
| `failed` | Max requeue exceeded, unrecoverable | Exhausted child IDs |

## Configuration

| Option | Default | Description |
|---|---|---|
| `failFast` | `true` | Any child failure blocks parent |
| `maxRequeueAttempts` | `3` | Requeue limit before permanent failure |
| `treatStaleAsBlocked` | `true` | Stale children count as blocked |

## Decision Flow

```
ingest(child_event)
  → idempotencyKey seen before? → no-op, return current
  → legacy duplicate? (same status+stale) → no-op, return current
  → update child state, increment seq
  → compute:
    1. fail-fast: any failed/canceled/stale? → blocked
    2. max requeue exceeded? → failed
    3. all terminal?
       - fail-fast: all succeeded → ready
       - non-fail-fast: any terminal → ready
    4. otherwise → waiting
```

## Idempotency Protocol (issue #921)

Each `ChildTaskEvent` may carry an optional `idempotencyKey` string. The
reconciler tracks all seen keys and returns the current verdict without
mutating state when a previously-seen key is received.

Callers SHOULD derive stable keys from the original event source, e.g.:
`"${childTaskId}-${status}-${observedAt}"`. This protects against:

- **Terminal outbox replays**: the same outbox record replayed produces
the same key and is silently rejected.
- **Stale-task reaper double-fire**: if the reaper redelivers the same
heartbeat observation, the duplicate key prevents double-counting.
- **At-least-once delivery**: any transport layer that guarantees delivery
at least once (HTTP retry, SSE reconnect) benefits from deterministic
dedup.

When `idempotencyKey` is absent, the reconciler falls back to the legacy
implicit dedup (same `childTaskId` + `status` + `stale` flag → no-op).

```
// Example: stable key derivation
const key = `${childId}-${status}-${observedAt ?? Date.now()}`;
reconciler.ingest({ childTaskId: childId, status, idempotencyKey: key });
```

## Scenarios Covered

| Scenario | Events | Decision | Idempotency |
|---|---|---|---|
| All succeed | 3× succeeded | `ready` | Key per child prevents replay |
| Partial completion | 1× succeeded, 1× running | `waiting` | Same key replayed → no-op |
| Child failure (fail-fast) | 1× failed | `blocked` | Dedup still works without key |
| Duplicate completion | Same event twice | idempotent (no seq change) | Legacy dedup + key dedup both covered |
| Replay attack | Event with stale key | idempotent | Explicit key dedup |
| Reset + replay | Reset then fresh key | accepted | seenKeys cleared on reset |



## Command-Center Comment

`formatCloseoutComment()` produces Markdown suitable for GitHub issue comments:

```
✅ **Closeout: READY**
> All 3 children succeeded
> Children: 3✓ 0✗ 0⊘ 0⟳ 0⋯ 0⏰
> Parent: `parent-123` | seq: 3
```

## Implementation

- **Reconciler**: `src/core/closeout-reconciler.ts`
- **Tests**: `src/core/closeout-reconciler.test.ts` (48 tests — includes 8 new idempotency key dedup tests)

## Test Results

371/371 pass (all suites including 48 closeout reconciler + new idempotency tests)
