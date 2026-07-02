# #1032 Persistence Queue Diagnostics — Operator Review

**Lane:** 3/4 — Operator Diagnostics & Rollout Risk Review
**Worker:** workergamma
**Run:** a2a-1032-goal-team1-worker-thread-production-20260604T0219Z
**Review date:** 2026-06-04
**PR #1235 commit:** `22c47bb264fd7adb1adc288cdeb4d373e3bc34a8`

---

## 1. Diagnostics Surface Summary

### 1.1 /health `persistenceQueue` field (public, unauthenticated)
```json
{
  "kind": "broker.persistence.queue",
  "enabled": false,
  "mode": "inline",
  "state": "disabled",
  "capacity": null,
  "queued": 0,
  "active": 0,
  "inFlight": 0,
  "available": null,
  "closing": false,
  "aborted": false
}
```
- **Source:** `src/server.ts` lines 3118–3149
- **Test:** `src/server.test.ts` lines 880–920
- Exposed alongside `persistence` metadata, `auditDiagnostics`, `runtimeMemory`, `requestPressure`.
- Public endpoint; no auth required. OK for load-balanced health checks.
- **╳ No latency metric for the persistence queue itself** — only the total `/health` response `timing.totalMs` and `timing.persistenceMs` (which is the cache/state-store read, not queue depth latency).

### 1.2 /schedz `persistenceQueue` field (edge-secret protected)
- **Source:** `src/server.ts` lines 5440–5460 (within the `/schedz` handler)
- Exposed alongside scheduling timing, CPU cgroup, PSI pressure, connection diagnostics.
- Edge-secret required; fine for operator or automated scheduler diagnostics.
- **╳ No worker-thread-specific counters** — same provider interface as /health.

### 1.3 /dashboard `persistenceQueue` field + attention (edge-secret protected)
- **Source:** `src/server.ts` lines 3519–3537 (route handler), `buildDashboardResponse` at line 7019
- `persistenceQueue` included in response object AND consumed by `buildDashboardAttention` (lines 6820–6845).
- Attention items surface three persistence queue conditions:
  - `persistence-queue-saturated` (severity: warn)
  - `persistence-queue-unavailable` (severity: warn)
  - `persistence-queue-draining` (severity: info)
- **Test coverage:** `src/server.test.ts` line 911–916 (dashboard.assert + attention item check)

### 1.4 /control-tower `persistenceQueue` field (role-gated: hub/operator)
- **Source:** `src/server.ts` lines 3548–3564
- Same provider, but requires `x-a2a-requester-role: hub` or `operator` on top of edge secret.
- **Test coverage:** Not explicitly tested — relies on same `readPersistenceQueueDiagnostics` function.

### 1.5 Broker queue counters (task-level, not persistence-level)
Included in /dashboard and /control-tower:
- `queue.byStatus.{blocked, queued, claimed, running}`
- `observability.queuePressure.staleWorkerAssignments`
- `observability.queuePressure.oldestClaimed` / `oldestRunning`
- `observability.recovery.{totalRequeued, totalDeadLettered, recentRequeues, recentDeadLetters}`
- `observability.workerHealth.staleWorkersWithActiveTasks`

These are **in-memory task scheduling counters**, not persistence write-queue counters. They are distinct from the `persistenceQueue` diagnostics.

---

## 2. Wiring Analysis

### 2.1 Provider Interface
```typescript
// src/server.ts line 445
export type BrokerPersistenceQueueDiagnosticsProvider =
  () => BrokerPersistenceQueueDiagnostics | undefined;
```

- **Pluggable but not wired.** The option `persistenceQueueDiagnostics` on `BrokerServerOptions` (line 2495) accepts a provider function, but:
  - No real worker-thread SQLite queue wires this in production.
  - No env-var-based default exists (contrast with `BROKER_PERSISTENCE_BACKEND`).
  - Default = `undefined` → `disabledPersistenceQueueDiagnostics()` → `state: "disabled"`, `mode: "inline"`, all counters zero/null.
- **Design intent** (line 2492–2495): "Optional O(1) worker-thread persistence queue counters for /health, /schedz, and /dashboard." Confirmed as forward-looking plumbing.

### 2.2 Existing spike/wiring reference
- `src/core/sqlite-worker-thread-spike.test.ts` — bounded test-only prototype (`TestOnlyWriteQueue`, `TestOnlySqliteWorkerThread`).
- Not imported or called from production code.
- Docs: `docs/a2a-1032-sqlite-worker-thread-spike.md` — explicitly "do not implement production SQLite worker-thread isolation directly from the current #1032 evidence."

### 2.3 State store synchronization
Current SQLite persistence (`SqliteBrokerStateStore`):
- **Synchronous** (`DatabaseSync`) — writes block the event loop.
- No separate write queue, no async flush, no worker thread delegation.
- `getPersistenceInfo()` (line 1223) returns hot-table load metrics but **no queue depth info**.
- `readHotTerminalOutboxDiagnostics()` (line 1463) is terminal outbox-focused, not write-queue.

### 2.4 Retryable 503 mapping
```typescript
// src/server.ts lines 7188–7192
case "queue_saturated":
case "queue_drain_timeout":
case "queue_closed":
case "worker_crashed":
case "worker_unavailable":
```
These error codes are mapped to 503 responses in the error handler. Test at `src/server.test.ts` line 1505 validates the mapping.

---

## 3. Rollout Risk Inventory

### 3.1 Missing guardrails / gaps

| # | Gap | Severity | Details |
|---|------|----------|---------|
| G1 | **No real worker-thread queue wired** | Critical | Production SQLite persistence is synchronous (`DatabaseSync`). Diagnostics show `state: "disabled"` always. No way to observe real queue depth. |
| G2 | **No env-var auto-wire** | High | Unlike `BROKER_PERSISTENCE_BACKEND`, there's no `BROKER_PERSISTENCE_QUEUE_ENABLED` or similar env var. Operator cannot enable the diagnostics without code change. |
| G3 | **No saturation guard for inline mode** | Medium | Inline (default) mode has no queue boundary. `capacity: null`, `available: null`. An operator reading diagnostics can't distinguish "no queue" from "queue with unbounded capacity." |
| G4 | **No latency metric per persistence queue operation** | Medium | `timing.persistenceMs` on /health measures the health endpoint's own persistence read (cache). Not a write-queue latency signal. |
| G5 | **No per-worker/route persistence impact** | Medium | /schedz shows per-route timing but can't attribute delays to SQLite persistence vs event-loop scheduling. The spike doc (PR #1225 revert) explicitly removed /schedz heartbeat attribution fields. |
| G6 | **No circuit-breaker or failover path** | High | If a worker-thread queue saturated, crashed, or stalled, there's no fallback to synchronous inline writes documented or implemented. The spike doc says this is a pre-requisite for any implementation. |
| G7 | **No dashboard test for persistence queue attention items with real values** | Low | The attention item test at line 912 uses a hardcoded `saturated` state. No test exercises draining, shutdown, or recovery transitions. |
| G8 | **No compatibility contract for mode transitions** | Medium | Rolling back from `worker_thread` to `inline` would lose diagnostics visibility but not data — data is already committed synchronously. However, transitioning forward requires DB-compatible reading. The spike doc requires this explicitly. |
| G9 | **No `/livez` persistence queue exposure** | Low (by design) | `/livez` excludes persistenceQueue and other heavy diagnostics to keep it a lightweight health check. Tests confirm this (line 920). Deliberate, correct design. |

### 3.2 Strengths (ship-worthy parts)

| # | Item | Evidence |
|---|------|----------|
| S1 | Full diagnostics surface on /health, /schedz, /dashboard | Three endpoints expose the same canonical diagnostics object. Consistent format. |
| S2 | Attention-item integration on /dashboard | `persistence-queue-saturated`, `-unavailable`, `-draining` surfaced to operator attention with severity, count, and summary. |
| S3 | 503 error mapping for queue errors | Retryable queue errors (`queue_saturated`, `queue_closed`, `worker_crashed`, etc.) correctly mapped to 503. |
| S4 | Normalization logic clean | `normalizePersistenceQueueDiagnostics` (line 598) clamps negative values, ensures `inFlight ≥ queued + active`, and sets `available` correctly. |
| S5 | Disabled-default is safe | Provider=undefined → disabled diagnostics. No false-positive queue warnings. |
| S6 | Spike test covers queue semantics | `TestOnlyWriteQueue` in test file proves capacity, enqueue, drain/close, abort, and inFlight counting. |

---

## 4. Approval Gates Required Before Production Deploy

Based on the spike doc requirements and current gaps, these approvals are needed **before** a production release can claim #1032 close:

1. ✅ **PR #1235 diagnostics surface** — already merged. Public + protected endpoints show `persistenceQueue`. **Gate: PASS**
2. ⛔ **Real worker-thread queue provider** — not yet wired. Gate: BLOCK unless operator accepts `state: "disabled"` diagnostics for initial rollout.
3. ⛔ **Env-var-based provider activation** — an explicit env gate such as `BROKER_PERSISTENCE_QUEUE_ENABLED` is needed for ops to toggle without code deploy. Gate: BLOCK for automated rollout.
4. ⛔ **Saturation/backpressure proof** — spike doc requires bounded capacity, fail-closed, crash recovery, shutdown drain. Gate: BLOCK until source-review approved.
5. ✅ **Error propagation to caller** — 503 mapping in place. Gate: PASS.
6. ⛔ **Rollback compat** — must prove `worker_thread` → `inline` transition is safe without DB migration. Gate: BLOCK.
7. ⚠️ **Latency evidence** — the #1032 goal requires a "live latency proof" for the remaining >1s /livez samples. This PR does not provide that. Gate: SEPARATE EVIDENCE required.
8. ⚠️ **brokeralpha finalizer sign-off** — per safety rules, brokeralpha is finalizer of record and must sign before merge/close. Gate: MUST NOT CLOSE #1032 without brokeralpha.

---

## 5. File Reference Map

| File | Lines | Description |
|------|-------|-------------|
| `src/server.ts` | 425–429 | `BrokerPersistenceQueueMode`, `BrokerPersistenceQueueState` types |
| `src/server.ts` | 428–444 | `BrokerPersistenceQueueDiagnostics` interface |
| `src/server.ts` | 445 | `BrokerPersistenceQueueDiagnosticsProvider` type |
| `src/server.ts` | 563–602 | `disabledPersistenceQueueDiagnostics()`, `unavailablePersistenceQueueDiagnostics()` |
| `src/server.ts` | 598–627 | `readPersistenceQueueDiagnostics()`, `normalizePersistenceQueueDiagnostics()` |
| `src/server.ts` | 2492–2495 | Option declaration with doc comment |
| `src/server.ts` | 2634 | Provider extraction from options |
| `src/server.ts` | 2880 | Operator SSE summary persistenceQueue |
| `src/server.ts` | 3106–3184 | /health handler with persistenceQueue |
| `src/server.ts` | 3519–3537 | /dashboard handler with persistenceQueue |
| `src/server.ts` | 3541–3564 | /control-tower handler with persistenceQueue |
| `src/server.ts` | 5440–5460 | /schedz handler with persistenceQueue |
| `src/server.ts` | 6747–6850 | `buildDashboardAttention()` persistence queue rules |
| `src/server.ts` | 6885–6960 | `buildOperatorDashboardSnapshot()` |
| `src/server.ts` | 7019–7055 | `buildDashboardResponse()` |
| `src/server.ts` | 7188–7192 | Queue error → 503 mapping |
| `src/core/sqlite-worker-thread-spike.test.ts` | 1–500+ | Bounded test-only worker-thread prototype |
| `src/core/store.ts` | 917–1260 | `SqliteBrokerStateStore` (synchronous, no worker queue) |
| `src/server.test.ts` | 880–920 | Diagnostics surface test |
| `src/server.test.ts` | 1505–1540 | 503 queue error mapping test |
| `src/server.test.ts` | 4231–4280 | Dashboard default state test (includes disabled persistenceQueue) |
| `docs/a2a-1032-sqlite-worker-thread-spike.md` | full | Spike plan / ADR (recommends no production deployment yet) |

---

## 6. Commands for Verification

```bash
# Build the project (requires node_modules installed)
npm run build

# Run diagnostics-specific tests
node --test --test-name-pattern="persistence queue" dist/server.test.js

# Run dashboard tests
node --test --test-name-pattern="GET /dashboard" dist/server.test.js

# Start broker and manually probe endpoints
node dist/server.js &
sleep 1
# Public health (includes persistenceQueue)
curl -s http://localhost:8787/health | jq '.persistenceQueue'
# Edge-secret protected schedz
curl -s -H 'x-a2a-edge-secret: YOUR_SECRET' http://localhost:8787/schedz | jq '.persistenceQueue'
# Dashboard with full attention
curl -s -H 'x-a2a-edge-secret: YOUR_SECRET' http://localhost:8787/dashboard | jq '.persistenceQueue, .attention'
```

---

## 7. Verdict

**Status: PARTIAL — diagnostics surface is merged, production worker-thread wiring is not.**

- **/health, /schedz, /dashboard persistenceQueue fields** — ✅ Ready. Consistent, tested, normalized, safe-disabled default. Can ship for operator visibility now.
- **Worker-thread queue provider** — ❌ Not wired. `state: "disabled"` will persist in production unless someone provides a real provider.
- **Live latency proof** — ❌ Not provided by this PR. PR #1235 is a diagnostics plumbing change, not a latency fix.
- **Rollout approval** — ⛔ BLOCKED on brokeralpha finalizer review and the approval gates in §4.

**Recommended next action:** Keep PR #1235 as the source-side diagnostics baseline. The `persistenceQueue` field will show `state: "disabled"` until a worker-thread provider is wired via a follow-up PR. Any production deploy or release still requires brokeralpha finalizer approval; close of #1032 requires separate latency evidence.

---

*Review produced by workergamma (Lane 3/4). brokeralpha remains finalizer of record.*
