# 7655e9d A2A /livez and persistence hardening release notes draft

Status: draft for a future release/tag. This document is not a published
GitHub release, npm publish, or production deployment approval.

Candidate commit:
`7655e9dec8d1713b6a316a797603421d73969726`

Primary operator outcomes:

- Closed [#1032](https://github.com/jinwon-int/a2a-broker/issues/1032) after
  separating broker hot-path stalls from acceptable residual socket/probe
  latency.
- Closed [#1250](https://github.com/jinwon-int/a2a-broker/issues/1250) as
  diagnostic-complete after proving the remaining rare `>1s` `/livez` samples
  are not broker handler work, SQLite work, worker heartbeat work, or delayed
  Node HTTP request-event emission after request bytes arrive.
- Left brokeralpha production broker on worker-thread SQLite persistence with
  `persistenceQueue.enabled=true`, `mode=worker_thread`, and `state=healthy`.

## Operator-facing changes

### Worker-thread durable persistence ACKs

[#1248](https://github.com/jinwon-int/a2a-broker/pull/1248) wires a production
worker-thread persistence lane for SQLite-backed broker state.

- Mutating HTTP routes can wait for durable queued-write ACKs before returning
  success.
- Queue saturation, worker failure, abort, and ACK timeout surface as retryable
  HTTP `503` failures.
- Worker-thread mode prevents bypassing the queued worker-thread persistence
  path through direct main-thread SQLite writes.
- `/health`, `/schedz`, dashboard, and control-tower diagnostics expose
  `persistenceQueue` state, counters, capacity, and failure indicators.
- `/livez` remains intentionally lightweight and does not expose
  `persistenceQueue`.

### Worker heartbeat hot-path reduction

[#1249](https://github.com/jinwon-int/a2a-broker/pull/1249) removes the SQLite
backend's implicit unchanged-worker-heartbeat persistence interval.

- The SQLite backend now follows the core default-off policy for unchanged
  worker heartbeat persistence.
- Operators can still explicitly opt in with
  `BROKER_WORKER_HEARTBEAT_PERSIST_INTERVAL_MS`.
- This removed the multi-second `workers.heartbeat` / `brokerHeartbeat` route
  body stalls observed during the #1032 live investigation.

### Reused-socket latency attribution split

[#1251](https://github.com/jinwon-int/a2a-broker/pull/1251) keeps the reused
socket timing split through comprehensive diagnostics reports.

- `reuseIdleBeforeDataMs` is preserved in client timing, slow-sample rows, and
  Markdown reports.
- `reuseDataToHttpRequestEventMs` is also preserved through the same report
  path.
- Diagnostics now separate `reused-socket-data-received-blocked` from
  `reused-socket-idle-before-request-event`.
- The new split lets operators distinguish "request bytes arrived but Node did
  not emit the HTTP request event promptly" from "the reused socket was idle
  before first data arrived."

## Live validation evidence

### #1032 close gate

Accepted operating threshold after the 2026-06-05 KST close decision:

- HTTP failures: `0`
- `/livez >3s`: `0`
- Docker health: `healthy`
- Gateway `/readyz`: `ready=true`
- Gateway event loop: `degraded=false`
- Worker heartbeat / SQLite unchanged heartbeat multi-second route-body stall:
  resolved

Final #1032 close evidence used revision
`abb1600c9a016e7eedb77ae588490eb05674879a` with image tag
`brokeralpha-github-abb1600c`, before worker-thread persistence was re-enabled for
the follow-up canary.

### Worker-thread persistence canary

brokeralpha enabled `BROKER_PERSISTENCE_QUEUE_WORKER_THREAD=1` and recreated only
the broker container.

90s gate:

- probes: `180`
- `/livez` failures: `0`
- `/schedz` failures: `0`
- `/livez max`: `1726ms`
- `/livez >1s`: `2`
- `/livez >3s`: `0`
- `/schedz max`: `39ms`
- in-broker scheduling max: `936.823ms`
- failed checks: `0`
- `workers.heartbeat` route max body timing: `3.946ms`
- `brokerHeartbeat max`: `0.268ms`

Decision: canary passed under the adjusted operating threshold, and
worker-thread persistence stayed enabled.

### #1250 live gate on 7655e9d

brokeralpha deployed commit
`7655e9dec8d1713b6a316a797603421d73969726` and ran the #1250 live gate.

90s gate:

- evidence:
  [#1250 live gate comment](https://github.com/jinwon-int/a2a-broker/issues/1250#issuecomment-4631461577)
- probes: `180`
- `/livez` failures: `0`
- `/schedz` failures: `0`
- `/livez max`: `1896ms`
- `/livez p95`: `5ms`
- `/livez p99`: `1379ms`
- `/livez >1s`: `2`
- `/livez >3s`: `0`
- `/schedz max`: `37ms`
- in-broker scheduling max: `972.609ms`
- failed checks: `0`

Split result:

- residual bucket: `reused-socket-idle-before-request-event`
- not observed as: `reused-socket-data-received-blocked`
- idle before first data max: `2412.406ms`
- data to HTTP request event max: `1.216ms`
- HTTP request event to handler start max: `0.624ms`
- `/livez` handler max: `0.18ms`

Decision: #1250 closed as diagnostic-complete. The remaining rare `>1s`
samples are outside the broker handler / SQLite / worker heartbeat hot path.

## Operating notes

- Treat `/health.persistenceQueue` as the worker-thread queue health surface.
- Treat `/livez` as lightweight liveness only.
- Rare `/livez >1s` alone is not a worker-thread persistence incident when
  `/livez >3s=0`, HTTP failures are `0`, `/schedz` is normal, and
  `persistenceQueue.state=healthy`.
- `broker_audit_events=5000/5000` can be steady-state audit ring-buffer
  operation when skipped rows are `0`, growth is `0`, and
  `auditDiagnostics.warnings=[]`.
- Manual terminal ACK/replay, DB mutation/prune, broker recreate/restart,
  Gateway restart, rollback/mode change, release/tag, and npm publish still
  require separate fresh operator approval.

## Before cutting a real release/tag

This draft does not replace the release gate. Before creating a real
release/tag, run and record at minimum:

```bash
npm run build
npm run test:comprehensive-diagnostics
npm test
```

For a release that claims the broader broker release bar, also run the normal
release gate from `docs/release-gate.md` with the appropriate SQLite and live
approval boundaries.
