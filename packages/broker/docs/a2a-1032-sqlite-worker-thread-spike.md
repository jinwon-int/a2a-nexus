# A2A #1032 SQLite Worker-Thread Spike Plan

This document records the source-only decision after the #1032 live rounds that
reduced the `tasks.list` hot read signal but still left residual `/livez`
latency. It is intentionally a spike/ADR boundary, not an implementation plan
for production worker-thread SQLite.

## Status update (2026-06-12): spike answered — implemented opt-in, awaiting live approval

The original `Verdict: PARTIAL / do not implement directly` below reflects the
#1032 evidence at spike time. It is **superseded** by what subsequently landed
in tracked source. Recording it here so the ADR is not read as a standing "do
not build" decision:

- The test-only queue semantics model graduated into a real implementation:
  `src/core/sqlite-worker-thread-persistence.ts` (+ its 571-line
  `*.test.ts`), wired into the server behind
  `BROKER_PERSISTENCE_QUEUE_WORKER_THREAD=1` (off by default).
- Every "required design proof before implementation" listed below is met by
  that implementation:
  - **Ordering** — `WriteQueue.pump()` dequeues one entry at a time (FIFO).
  - **Read-after-write** — reads (`load`, `readHot*`, `getPersistenceInfo`)
    stay synchronous on the main thread against the same DB file; only writes
    are offloaded, so callers keep immediate visibility.
  - **Backpressure** — bounded queue; `enqueue()` rejects with
    `queue_saturated`; counters surface via the read-only `persistenceQueue`
    diagnostics (`BrokerPersistenceQueueDiagnostics`), not a new hot-path
    field.
  - **Crash** — `abort()` rejects all pending and future writes
    (`worker_crashed`).
  - **Shutdown** — `drainAndClose({ timeoutMs })` drains or rejects
    deterministically within a bounded timeout.
  - **Error propagation** — ACK semantics reject the mutating caller; the
    route wrappers do not report success before acknowledgement.
  - **Rollback** — flipping the env off returns to the synchronous SQLite
    path against the same DB file; no migration or data rewrite.

Remaining gate: a **separate explicit live-deploy approval** (per the
"Non-goals" below — no live deploy/recreate is authorized by this ADR). The
diagnostics-only review and the implementation-readiness sections later in
this document already describe that bar. The PR #1224 hot-path heartbeat
attribution remains the explicit anti-pattern not to reintroduce.

This is a documentation reconciliation only: it changes no code and grants no
live approval.

## Verdict: PARTIAL

Worker-thread isolation for SQLite is still plausible, but the current evidence
does not justify landing it directly on the broker runtime.

The next safe step is a bounded source-only spike that proves the ordering,
backpressure, crash, shutdown, and read-after-write semantics before any live
broker deploy or runtime hot-path instrumentation.

## Current evidence

- PR #1223 reduced the default `/tasks` list path by projecting summary fields
  directly from the SQLite hot table. The next live gate still failed the strict
  #1032 close criteria, but `tasks.list` was no longer the only useful signal.
- The 1196b44 live runtime had healthy Docker state, zero restart count, healthy
  `/schedz`, and no 5s `/livez` failures, but still showed residual `>1s` and
  Gwakga `>3s` samples.
- PR #1224 added `/schedz.workerHeartbeatHotPath` runtime diagnostics to split
  in-memory heartbeat updates from persisted heartbeat writes. That live gate
  regressed into new 5s `/livez` timeouts on both Seoseo and Gwakga, so the
  broker was rolled back and the source patch was reverted by PR #1225.
- PR #1226 added a report-only heartbeat correlation guardrail. It prevents
  `workers.heartbeat` or `brokerHeartbeat` slow-sample correlation from being
  treated as proof that SQLite persistence was the blocking operation.

## Decision

Do not implement production SQLite worker-thread isolation directly from the
current #1032 evidence.

Do not reintroduce hot-path `/schedz` heartbeat attribution like PR #1224.
That approach created enough live overhead to be a rollback trigger.

Use a no-live, bounded spike to answer whether a worker-thread persistence lane
can preserve broker semantics and whether it would actually remove the class of
stall seen in the reports.

## Spike questions

1. Can existing gate reports distinguish broker route pressure, Node event-loop
   scheduling, and SQLite persistence without adding new runtime fields to
   `/schedz`?
2. Which broker operations need synchronous read-after-write visibility after a
   worker heartbeat, worker registration, or task mutation?
3. Can a queued SQLite worker preserve the ordering currently provided by the
   synchronous repository writes and `persistState()` calls?
4. What is the minimum non-hot-path measurement that can prove or reject
   SQLite persistence as the remaining #1032 bottleneck?
5. How should the broker fail if the worker queue is saturated, the worker
   crashes, or shutdown occurs while writes are pending?

## Required design proof before implementation

Any worker-thread implementation proposal must answer these points in source
review before it can be considered for a live deploy:

- Ordering: writes for a single worker/task must commit in the same order the
  broker accepted them.
- Read-after-write: callers that currently observe updated worker/task state
  immediately must keep that behavior or receive an explicit contract change.
- Backpressure: the queue must have a bounded size, observable counters, and a
  fail-closed policy that does not hide lost writes.
- Crash and restart: pending writes must either be durably committed or
  explicitly rejected before success is reported to the caller.
- Shutdown: broker shutdown must drain or reject queued writes deterministically
  within a bounded timeout.
- Error propagation: SQLite constraint, schema, and disk errors must surface to
  the mutating route instead of becoming detached background failures.
- Retention: audit and heartbeat retention behavior must remain equivalent to
  the synchronous path.
- Rollback: operators must be able to return to the current synchronous
  SQLite path without DB migration or data rewrite.

## Candidate spike shape

The safest next branch should stay source-only and should not change live
runtime behavior. A useful spike can be one of:

- a design-only ADR with the queue semantics above and explicit rejection
  criteria;
- a test-only prototype behind an unreferenced test helper that models ordered
  queued writes without wiring it into the broker server;
- a micro-benchmark script that uses disposable `.tmp` SQLite files and does
  not touch production state files, live containers, or `/schedz`.

The spike should use a disposable directory such as:

```text
.tmp/openclaw-spikes/a2a-1032-sqlite-worker-thread/
```

Any prototype output from that directory is throwaway evidence unless a later
PR deliberately promotes a small, reviewed helper or fixture into tracked
source.

## Test-only queue semantics spike

PR #1228 adds a tracked test-only model in
`src/core/sqlite-worker-thread-spike.test.ts`. It does not import broker server
code, does not create a SQLite database, and does not wire a queue into runtime.

The model validates the minimum queue contract that a future SQLite worker
thread would need before it can be considered for production code:

- accepted writes are processed in order when callers await the commit promise;
- acknowledged writes provide read-after-write visibility to the caller;
- queue saturation fails closed with `queue_saturated` instead of dropping work;
- write failures reject the mutating caller and do not poison later writes;
- shutdown can drain queued writes and reject new writes deterministically;
- worker crash rejects queued and future writes instead of detaching failures.

This remains only a semantics proof. It does not prove that Node worker threads,
`DatabaseSync`, WAL behavior, or the broker repository layer can satisfy the
same guarantees without additional design and implementation work.

### Spike verdict: PARTIAL

The queue contract is viable enough for a future implementation design, but the
production path is still blocked until the real broker repository operations
prove the same ordering, read-after-write, backpressure, crash, shutdown, and
error-propagation behavior.

## Test-only repository-path proof

PR #1229 extends the same tracked test-only spike with disposable SQLite-backed
`SqliteTaskRuntimeRepository` and `SqliteWorkerRuntimeRepository` checks. It
still does not wire a worker thread into the broker runtime and does not touch
production state files.

The repository-path proof verifies that a queued writer can call the existing
SQLite hot-table repository seam and preserve:

- task status ordering from `queued` to `claimed` to `running`;
- read-after-write visibility through `getTask()` and filtered `listTasks()`;
- hot-table-native projection through `readHotRuntimeSnapshot()` without
  updating the canonical snapshot;
- worker heartbeat ordering through `getWorker()` and filtered `listWorkers()`;
- fail-closed queue saturation before an overflow heartbeat can be hidden as a
  lost SQLite write.

### Repository-path verdict: PARTIAL

This is closer to the real broker repository path than PR #1228, because it
uses the existing SQLite runtime repositories. It is still not a production
implementation proof: there is no Node worker thread, no cross-thread
`DatabaseSync` ownership model, no process crash/restart rehearsal, and no
retention-equivalence proof for audit or terminal-outbox writes.

## Test-only worker-thread ownership proof

PR #1230 extends the tracked test-only spike with an actual Node `Worker` that
owns a disposable SQLite file and opens `SqliteBrokerStateStore` inside the
worker thread. The main test thread only sends request/response messages and
does not share a `DatabaseSync` handle across threads.

The worker-thread proof verifies:

- cross-thread task writes preserve the repository-path status order from
  `queued` to `claimed` to `running`;
- acknowledged cross-thread writes are immediately visible through follow-up
  worker-thread reads;
- filtered `listTasks()` still sees the running task through the SQLite
  repository seam;
- worker heartbeat writes are visible through the worker-owned repository;
- a terminated worker rejects future client calls with an explicit
  `worker_unavailable` error;
- an acknowledged write can be read after starting a replacement worker against
  the same disposable SQLite file.

### Worker-thread verdict: PARTIAL

This answers one of the biggest unknowns left after PR #1229: a Node worker can
own the SQLite store and preserve basic repository read-after-write behavior
without sharing `DatabaseSync` across threads. It is still not production-ready
evidence. The test worker is a tiny request/response harness, not the broker's
runtime persistence lane, and it still does not prove bounded production
backpressure, shutdown-drain timeout behavior, full process crash recovery, or
retention equivalence for audit and terminal-outbox writes.

## Test-only retention and outbox proof

The next source-only spike extends `src/core/sqlite-worker-thread-spike.test.ts`
without wiring any worker-thread persistence lane into the broker runtime.

The added tests verify:

- queued `SqliteAuditRuntimeRepository` writes preserve heartbeat audit
  compaction/retention semantics instead of turning repeated heartbeats into
  unbounded audit rows;
- queued terminal-outbox snapshot writes preserve ACK state and the existing
  runtime hydration cap;
- the worker-thread-owned SQLite store preserves heartbeat audit compaction and
  terminal-outbox ACK state across worker restart.

### Retention/outbox verdict: PARTIAL

This narrows the retention-equivalence gap left after PR #1230. It shows that
the same worker-thread ownership model can carry audit retention and terminal
outbox hot-table state through disposable SQLite and a worker restart. It still
does not prove the production broker persistence lane: there is no broker
server integration, no bounded production queue with observable counters, no
shutdown-drain timeout implementation, and no full crash window proof for
in-flight writes that have not been acknowledged.

## Test-only bounded queue and shutdown proof

The next source-only spike keeps the same test-only queue model and makes the
remaining production contract more explicit before any runtime implementation.

The added tests verify:

- the queue exposes bounded, operator-readable counters for capacity, queued
  writes, active write, in-flight writes, available slots, closing state, and
  aborted state;
- queue saturation is observable at the same time it fails closed;
- shutdown drain can time out deterministically with `queue_drain_timeout`,
  reject queued and in-flight writes, and reject future writes;
- a worker crash before acknowledgement rejects in-flight, queued, and future
  writes instead of allowing a late successful acknowledgement after the crash.

### Bounded queue/shutdown verdict: PARTIAL

This narrows the bounded backpressure, shutdown-drain timeout, and
pre-acknowledgement crash-window gaps. It is still not a production
implementation proof: the counters are test-only, there is no broker server
integration, no HTTP/route mapping for `queue_saturated` or
`queue_drain_timeout`, and no live evidence that moving SQLite writes to a
worker thread improves #1032 latency.

## Test-only broker route boundary proof

The next source-only spike keeps runtime wiring unchanged and adds a small
test-only broker route adapter around the queue model.

The added tests verify:

- a mutating broker route must not return success until the queued SQLite write
  has been acknowledged as committed;
- successful route responses carry an explicit `committed: true` persistence
  marker in the test boundary;
- `queue_saturated`, `queue_drain_timeout`, `queue_closed`, `worker_crashed`,
  and `worker_unavailable` map to retryable HTTP `503` failures with
  `Retry-After: 1`;
- failed queue responses carry `committed: false`, a stable error code, and the
  queue counters that operators would need to diagnose saturation, drain, or
  worker-crash behavior.

### Broker route boundary verdict: PARTIAL

This narrows the broker/server integration and route-error-mapping gap without
changing live behavior. It defines the minimum contract a future production
route wrapper should preserve: no success before durable acknowledgement, and
no hidden background persistence failures. It is still not a production worker
implementation: the adapter is test-only, no HTTP handler is wired to it, and
there is still no live proof that SQLite worker-thread isolation improves the
#1032 latency profile.

## Acceptance gates for a future implementation PR

Before worker-thread SQLite can be proposed for a live approval round:

- unit tests prove per-entity ordering for queued worker and task writes;
- tests prove synchronous read-after-write behavior or document the exact
  changed contract;
- tests cover worker crash, queue saturation, shutdown drain timeout, and
  SQLite write error propagation;
- broker/server tests prove route wrappers do not return success before queued
  persistence acknowledgement and map retryable queue failures to explicit HTTP
  failures;
- diagnostics are read-only and do not add new work to `/livez` or `/schedz`
  hot paths;
- `npm run build`, focused broker/server tests, comprehensive diagnostics, and
  full `npm test` pass;
- #1032 receives a comment explaining why the implementation is ready for a
  separate explicit live approval.

## Non-goals

- No live deploy or broker recreate.
- No Gateway restart or reload.
- No DB migration, prune, or production state mutation.
- No Terminal ACK/replay.
- No provider canary or Telegram send test.
- No release, tag, or npm publish.
- No secret or credential movement.
