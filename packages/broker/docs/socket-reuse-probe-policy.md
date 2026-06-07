# Socket Reuse Probe Policy

This policy covers residual `/livez` wall-clock samples where broker internals
are already healthy and diagnostics attribute the slow sample to a reused client
socket that was idle before the next request event.

## Operator decision

Use fresh-socket and standalone `/livez` probes as the strict wall-clock gate
when the operator goal is to eliminate rare `/livez >1s` samples completely.
Keep reused-socket mode in the comparison report as a diagnostic lane, not as
the sole broker health verdict.

The residual is observable, not actionable, when all of these are true:

- `/livez` failures are `0`.
- `/schedz` failures are `0`.
- `/livez >3s` is `0`.
- fresh-socket probes have `/livez >1s = 0`.
- standalone `/livez-only` probes have `/livez >1s = 0` when included.
- reused-socket slow samples are attributed to
  `reused-socket-idle-before-request-event`.
- `reuseDataToHttpRequestEventMs` and request-event-to-handler timings stay
  low enough to rule out "bytes arrived but Node did not process them."

In that case, treat rare reused-socket `/livez >1s` samples as client/probe
pool latency. Do not classify them as broker handler, SQLite persistence,
worker heartbeat, or readiness failures.

## Investigate instead

Escalate to investigation when any of these happen:

- `/livez` has HTTP failures.
- `/schedz` has failures.
- `/livez >3s` is non-zero.
- fresh-socket or standalone `/livez-only` probes still cross 1s.
- the reused-socket bucket is not `reused-socket-idle-before-request-event`.
- `reuseDataToHttpRequestEventMs`, request-event-to-handler, handler, heartbeat,
  cgroup, GC, or host pressure fields identify broker/host-side work.

## Approval boundary

This policy does not approve a live canary, deploy, Gateway restart, broker
recreate, DB action, terminal ACK/replay, release, tag, or provider send. Those
still need separate explicit operator approval.

## Code surface

`scripts/broker-comprehensive-diagnostics.mjs` emits
`livezSocketReusePolicy` in connection-mode comparison reports. The field gives
operators a structured `operatorAction`, `strictWallClockGateMode`,
`reusedSocketResidualPolicy`, and approval-sensitive action list.
