# Libero Scheduling Attribution Gate Criteria (Round 4/8)

**Team:** Team1
**Lane:** workerdelta (4/8)
**Broker:** brokeralpha
**Run:** broker-1032-allhands-scheduling-20260531T121928Z
**Parent:** [#1032 — all-hands scheduling attribution](https://github.com/jinwon-int/a2a-broker/issues/1032)
**Issue:** [#1055 — Team1 workerdelta lane](https://github.com/jinwon-int/a2a-broker/issues/1055)
**Prior merged source lanes:** [#1049 (workeralpha — event-loop monitor / liveness evidence)](https://github.com/jinwon-int/a2a-broker/issues/1049), [#1050 (workerbeta — read-only host/probe correlation)](https://github.com/jinwon-int/a2a-broker/issues/1050), [#1051 (workergamma — host scheduling attribution)](https://github.com/jinwon-int/a2a-broker/issues/1051)

---

## Live Baseline (post #1049/#1050/#1051 deploy)

| Metric | Value |
|---|---|
| Broker revision | `846aaa47300e99026c8accc23b34b90528bb7850` |
| Image tag | `brokeralpha-github-846aaa4` |
| Gateway /readyz | `ready=true`, `eventLoop.degraded=false` |
| /livez handler timing | max 0.546ms, p99 0.132ms, diagMs ~0.02ms |
| Loopback >1s (prior 90s) | 10/180 (5.5%) |
| Loopback >1s (settle) | 8/120 (6.7%) |
| Loopback >3s | 0/180 |
| HTTP failures | 0 |
| /schedz scheduling p95 | ~2695ms |
| /schedz scheduling p99 | ~2936ms |
| /schedz scheduling max | ~2949ms |
| /schedz scheduling p50 | <1ms |

---

## Gate Criteria

### ✅ PASS — Deploy gate satisfied

A **PASS** for this round means all of the following hold:

| # | Criterion | Verification | Measurement |
|---|---|---|---|
| P1 | `/livez` handler timing is bounded, O(1), and well under 10ms | `scripts/broker-livez-stall-attribution.mjs` — loopback against healthy broker | `/livez` p99 handler < 5ms, diagMs < 1ms |
| P2 | `/schedz` endpoint is responsive and contains attribution fields | `GET /schedz` returns `ok=true`, `host`, `schedulingTiming` | No timeout on /schedz |
| P3 | No increase in /livez handler latency from attribution code | Compare /livez timing before and after #1049/#1050/#1051 | /livez p99 < 0.5ms (baseline: 0.132ms) |
| P4 | All loopback probes succeed (HTTP 200) | `broker-livez-stall-attribution.mjs` | 0 HTTP failures |
| P5 | External loopback >3s = 0 over any 180-probe window | Loopback measurement | 0 samples above 3s |
| P6 | No false Done / no hiding stalls | No `ok=true` if handler timing was excluded or `_activeRequests` was hidden | Gate report checks are comprehensive |
| P7 | Safety gate: read-only, no deploy, no restart, no DB mutation, no ACK | Code review + gate output | All checks are `ReadOnlyMeasurement` |

### ⏸️ KEEP OPEN — More evidence needed

This round stays open if any of these are true:

| # | Condition | Why |
|---|---|---|
| K1 | Loopback >1s rate > 2% and no convincing root cause identified | 5-7% >1s suggests systemic scheduling delay that needs deeper attribution |
| K2 | `/schedz` missing fields or returning stale data | Without host load or timing window, the attribution is incomplete |
| K3 | `_activeRequests` counter shows unexpected patterns (e.g. never decrements, spikes to large values) | Indicates a leak in the scheduling hook |
| K4 | Correlated probe data shows high host load coinciding with slow probes but no actionable diagnosis | Need to distinguish host-scheduler delay from process-queue delay |
| K5 | Proposed fix for >1s probes cannot be validated in this lane | Lane 4/8 should produce actionable evidence before lane 5/8 begins |

### 🔴 ROLLBACK — Revert #1049/#1050/#1051

Rollback the scheduling attribution changes if:

| # | Condition | Check |
|---|---|---|
| R1 | `/livez` handler timing degrades >10x from baseline after the attribution changes | /livez p99 > 2ms (baseline: 0.132ms) |
| R2 | `_schedulingTimingWindow` blocks event loop (O(N) snapshot on large window) | Review window size (200 samples); if snapshot itself takes >1ms under concurrent load, reduce to 100 or set `--sched-window` tunable |
| R3 | `_activeRequests` counter leaks (grows monotonically without bound) | Monitor for 60s under zero load; should return to 0 |
| R4 | `/livez` or `/schedz` handler introduces any DB/cache/async I/O | All attribution must be O(1), in-memory, no persistence |
| R5 | Attribution code causes process crash, uncaught exception, or unhandled rejection | Test suite + smoke run |

### 🚀 DEPLOY GATE — Conditions for next deploy

Before deploying additional scheduling attribution changes (beyond what's in #1049/#1050/#1051):

| # | Condition | Gate |
|---|---|---|
| D1 | Loopback measurements confirm baseline stall signature captured | The existing >1s probes must be visible in `/schedz.schedulingTiming` |
| D2 | `/schedz` timing window (200 samples) covers the relevant tail | Confirm `schedulingTiming.count >= 200` after measurement run |
| D3 | No regressions in /livez or /health handler timing | Compare before/after p50/p95/p99 |
| D4 | All team1 lanes (1-4) must either pass or produce actionable Block evidence | workerdelta lane 4/8 produces this document |
| D5 | Broker finalizer (brokeralpha) has reviewed and approved the gate matrix | Manual review gate |

---

## Cross-Check: Can #1049/#1050/#1051 Really Close #1032?

### What #1049/#1050/#1051 Added

1. **`_schedulingTimingWindow`** (200-sample rolling window) — records handler-completion duration for ALL requests (not just /livez). Exposes p50/p95/p99 across all endpoints via `/schedz`.
2. **`_activeRequests`** gauge — O(1) counter of in-flight handler executions.
3. **`_totalAcceptedRequests`** counter — monotonically increasing request count.
4. **`initSchedulingHook(res)`** — wired at the top of the HTTP handler (line 1376). Increments on accept, decrements on response finish, records timing.
5. **`readHostLoadSnapshot()`** — caches `/proc/loadavg` and CPU count (refreshed max 1/second).
6. **`/schedz`** endpoint — returns `host` load, `schedulingTiming` window, `totalAccepted`, `activeRequests`.

### What They Do NOT Close

| Gap | Why Still Open |
|---|---|
| **The >1s delay is still unexplained** | The handler timing is 0.02ms. The scheduling window shows ~2949ms p99 for full request completion. This confirms the delay is NOT in the handler body, but the attribution stops there — it doesn't distinguish accept-queue delay from host-scheduler delay from kernel/VCPU descheduling. |
| **No per-phase breakdown** | Without instrumenting the accept/scheduling boundary (e.g., `perf_hooks` around `server.on('request')` vs. handler entry), we can't tell how much of the 2949ms is pre-handler queuing vs. post-handler response serialization. |
| **No `SchedzProbe` data export** | The `/schedz` returns aggregate statistics but doesn't export individual probe records for correlation with external loopback measurements. |
| **No experiment-mode to isolate cause** | The current code observes but doesn't distinguish cause: e.g., `--simulate-stall` mode, GC-pressure injection, concurrent-request ramp would help separate accept scheduling from host scheduling. |
| **Loopback >1s survives** | Even with the attribution changes, the loopback still shows 5-7% samples above 1s. The attribution code is diagnostic, not curative. Closing #1032 requires either explaining away the >1s as acceptable (with evidence) or implementing a fix. |

### What Would Close #1032

| Requirement | Approach |
|---|---|
| **1. Attributable stall evidence** | Confirm that every >1s loopback sample has a corresponding `/schedz` timing entry showing the same duration (i.e., the timing window captures the stall). *Current status: likely yes, but need explicit correlation evidence.* |
| **2. Accept delay vs. handler delay separated** | Add a simple `_acceptTimestampMs` per request (recorded at `initSchedulingHook` before handler runs) so `/schedz` can expose `preHandlerQueueMs: p50/p95/p99` separate from `handlerMs`. |
| **3. Host scheduling excluded as primary cause** | Correlate `loadPerCpu` (from `/schedz`) with slow probes. If `loadPerCpu` is consistently low during >1s events, host oversubscription is unlikely. |
| **4. Accept/queue depth instrumentation** | Track `_queuedBeforeHandler` count (requests accepted but handler not yet started). Compare with `_activeRequests`. A gap indicates accept-queue buildup. |
| **5. GC/CPU correlation on /livez proven harmless** | The existing GC and CPU diagnostics on `/livez` already satisfy this. ✓ |
| **6. Loopback >1s rate drops below acceptable threshold** | Define the acceptable threshold (e.g., <2% over 1s, 0% over 3s) and prove the broker meets it — or document why residual >1s is safe (e.g., CPU steal from co-tenants, not broker code). |

### Verdict: #1032 Must Stay Open

The #1049/#1050/#1051 changes are **valuable diagnostic instrumentation** but do **not** close #1032. They establish:

- ✓ That the stall is NOT in the `/livez` handler body (handler timing: 0.02ms)
- ✓ That full-request completion can be ~2949ms even when handler body is fast
- ✓ That host load, event loop delay, and GC are all healthy during stalls
- ✗ What IS causing the 2949ms (accept queue? host scheduler? kernel?)

**Recommendation:** Keep #1032 open. Refine the attribution in a follow-up PR that adds pre-handler accept-queue timing. The current instrumentation is necessary but not sufficient.

---

## Risk Notes

1. **No liveness safety regression.** The /livez handler unchanged (pre-existing GC/CPU/eventLoop code). Added `activeRequests` field is O(1) read. ✓
2. **`_schedulingTimingWindow.record()` is O(1) amortized.** Push to fixed-size array + re-sort on snapshot is O(N log N) but only called on demand at `/schedz`. Not on /livez hot path. ✓
3. **`readHostLoadSnapshot()` caches for 1s.** Never reads /proc on every request. ✓
4. **`initSchedulingHook` is sync, no I/O.** Uses `res.on("finish")` which is event-emitter, not blocking. ✓
5. **`_activeRequests` counter may transiently drift** if `res.on("finish")` fires after `res.destroy()` in edge cases. Monitor for monotonic growth. ⚠️

## Approval-Sensitive Blockers

| Blocker | Detail |
|---|---|
| `_activeRequests` leak risk | If `res` is destroyed before emitting `finish`, the counter may never decrement. Mitigation: add `res.on("close", ...)` as backup decrement. |
| `_schedulingTimingWindow` snapshot under concurrent load | At 200 samples, snapshot is fast (~0.01ms). If window size increases, measure before bumping. |
| `readHostLoadSnapshot()` blocking | `loadavg()` and `cpus()` are synchronous syscalls (not I/O), but cached to 1s refresh. Acceptable. |

---

**Team1 Libero:** workerdelta
**Broker (finalizer):** brokeralpha
**Evidence type:** Gate criteria + cross-check analysis
**Date:** 2026-05-31
