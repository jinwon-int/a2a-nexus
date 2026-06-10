# Phase 6 Wake-on-Task guard model

Phase 6 treats Wake-on-Task as an opt-in responsiveness layer. The default
behavior remains unchanged until the Phase 6 gates are green: accepted A2A tasks
can still complete through the existing broker/worker path without forcing a
target agent wake.

## Wake envelope

The plugin-local wake port starts from an `A2AWakeEnvelope`:

- `taskId` — broker-owned task id
- `waitRunId` — optional OpenClaw wait-run id
- `correlationId` / `parentRunId` — duplicate and loop-guard inputs
- `brokerStatus` — broker task status at wake-planning time
- `requester` / `target` refs — target must include `sessionKey`

The deterministic wake key is:

```text
(correlationId || taskId):(waitRunId || target.sessionKey)
```

That key becomes the runtime idempotency key with the `a2a-wake:` prefix.

## Runtime-facing port and result

`evaluateA2AWakePlan()` is pure guard planning. The runtime adapter boundary is
`executeA2AWake({ envelope, runtime, config, state })`, where `runtime` exposes a
single `dispatchWake({ envelope, plan })` port.

The runtime returns an `A2AWakeRuntimeReceipt`:

- `accepted: true` — the target wake was accepted, optionally with
  `runtimeRunId`, `queuedAtMs`, and a note.
- `accepted: false` — the wake was rejected with a visible code/message.

`executeA2AWake()` returns an `A2AWakeResult` with one of:

- `skipped` — guard decided not to wake.
- `scheduled` — runtime accepted the wake.
- `failed` — runtime rejected or threw while dispatching the wake.

Every result includes an `audit` object with an `a2a.wake` audit event and a
small `taskStatePatch.wake` projection. This is the Phase 6 visibility contract:
wake failures must remain inspectable in task/audit state even when the broker
task itself can continue through the normal worker path.

## Guard order

`evaluateA2AWakePlan()` applies guards in this order:

1. **default off** — wake is skipped unless explicitly enabled.
2. **terminal task no-op** — `succeeded`, `failed`, and `canceled` tasks never wake.
3. **required target** — missing `taskId` or `target.sessionKey` skips wake.
4. **loop guard** — `parentRunId` matching the wait-run or a known local active run skips wake.
5. **duplicate wake** — recent wake keys skip duplicate scheduling.
6. **per-node rate limit** — repeated wake attempts for the same target node/session key skip once the configured sliding-window limit is reached.
7. **active-session coalescing** — active target sessions use `append_to_active_session`; otherwise the runtime may `resume_or_launch`.

The target rate-limit key prefers `target.displayKey` and falls back to
`target.sessionKey`, so node-level routing can remain stable even if display and
session identifiers differ.

## Current boundary

This pass deliberately keeps the actual runtime launch behind the injected
`dispatchWake` port. It pins the interface, guard contract, rate-limit shape,
and failure visibility for `plugin-a2a#38`; `plugin-a2a#39`
can wire the scheduled plan into the runtime-specific adapter.
