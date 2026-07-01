# #1032 Live-Proof / Release Gate Plan

**Author:** Team1/Yukson (lane 4/4)
**Issue:** https://github.com/jinwon-int/a2a-broker/issues/1032
**Diagnostics surface PR:** #1235 (`22c47bb` — Expose #1032 persistence queue diagnostics)
**Base:** `jinwon-int/a2a-broker` `main`

> **This is a read-only plan document.**
> No live action defined here may be executed without a separate, explicit approval from Seoseo (the operator). See §8 for the approval gate.

---

## 1. Context and Scope

### 1.1 Current State

PR #1235 merged the production-facing persistence queue diagnostics surface:

| Component | Status |
|-----------|--------|
| `BrokerPersistenceQueueDiagnostics` interface | ✅ Defined in `src/server.ts` |
| `BrokerPersistenceQueueDiagnosticsProvider` callback | ✅ Optional in `BrokerServerOptions` |
| Diagnostics displayed on `/health`, `/schedz`, `/dashboard` | ✅ Accepted via callback |
| `/livez` explicitly excludes queue diagnostics | ✅ Lightweight path preserved |
| `queue_saturated` / `queue_drain_timeout` BrokerError → HTTP 503 | ✅ Mapped in `src/core/broker.ts` |
| Actual persistence queue wired from broker to server | ❌ Not yet — callback is undefined by default (reads as `disabled`) |
| Worker-thread SQLite persistence lane | ❌ Not yet — spike-only (`sqlite-worker-thread-spike.test.ts`) |

### 1.2 Remaining Blockers (in order)

1. **Broker/server worker-thread persistence wiring** — Create a real persistence queue/worker-thread adapter that mutating routes can await before returning success, and that the server queries for diagnostics
2. **Approval-gated live latency proof** — Deploy the wiring to one broker, run a bounded measurement gate, confirm >1s rate <2% and >3s rate = 0 over 90s
3. **Production deploy/release decision** — If latency proof passes, promote the configuration to both brokers and cut a release; if it fails, roll back and document the residual attribution

### 1.3 Constraints

- Seoseo is finalizer of record. Workers must not merge PRs or close #1032.
- All live actions require a separate, fresh approval from the operator. This document only defines *what* would be done, when, and how to verify — not an authorization to do it.
- No DB migration, prune, mutation, Terminal ACK/replay, provider canary, credential movement, tag/release, or Gateway restart/reload without explicit approval.

---

## 2. Preflight (Source-Only, No Live Broker)

These checks run entirely against the checked-out source, configured CI artifacts, and diagnostics scripts. They require no broker deployment, no Docker compose, no live connectivity.

### 2.1 Source Audit

| Check | Command / Method | Pass Criteria |
|-------|------------------|---------------|
| TypeScript compilation | `npm run build` | `tsc` exits 0, no errors |
| Full test suite | `npm test` | All tests pass |
| Persistence queue diagnostics contract | `node --test dist/server.test.js --test-name-pattern "persistence queue diagnostics"` | 1+ test passes confirming `persistenceQueue` on `/health`, `/schedz`, `/dashboard` |
| Queue error mapping | `node --test dist/server.test.js --test-name-pattern "maps retryable persistence queue BrokerErrors to 503"` | 1+ test passes confirming error code mapping |
| Libero validation matrix | `node --test dist/core/libero-validation-matrix.test.js --test-name-pattern "#1032"` | All #1032 guardrail tests pass (C6-C9, T6-T9, L8-L11) |
| Keep-alive timeout config | `node --test dist/server.test.js --test-name-pattern "keepAliveTimeout"` | All keep-alive tests pass |
| Spike tests not broken | `node --test dist/core/sqlite-worker-thread-spike.test.js` | All spike queue-semantic tests pass |

### 2.2 Diagnostics Script Readiness

| Check | Script | Pass Criteria |
|-------|--------|---------------|
| Broker comprehensive diagnostics | `node scripts/broker-comprehensive-diagnostics.mjs --dry-run` | Script parses CLI flags, no runtime errors, produces skeleton report |
| Release gate pre-cut | `node scripts/release-gate.mjs --dry-run` | Dry-run succeeds, no connection errors |
| Closeout release report | `node scripts/closeout-release-report.mjs --mock` | Report generates valid markdown |

### 2.3 Operator Document Checklist

- [ ] Operator runbook updated with `persistenceQueue` field descriptions (see §5)
- [ ] Rollback procedure documented and tested (see §6)
- [ ] Wiki page scaffolding created (see §7)
- [ ] Approval template drafted (see §8)

---

## 3. Deploy / Recreate (Approval-Gated)

Once Seoseo signs off, the deploy proceeds in two phases:

### Phase A: Staging / Single-Broker Canary (Seoseo only)

1. **Build image**
   ```bash
   docker build -t seoseo-broker:<commit-short> .
   ```

2. **Stage the diagnostics callback** — The new binary includes the `persistenceQueueDiagnostics` option. The broker's entry point creates a `PersistenceQueue` instance (or a no-op placeholder) and passes it via `persistenceQueueDiagnostics: () => queue.diagnostics()`.

3. **Deploy to Seoseo** — Docker compose update:
   ```bash
   docker compose -f docker-compose.yml up -d broker
   ```
   After deploy, verify:
   - `/health` returns `persistenceQueue.kind === "broker.persistence.queue"`
   - `/health` returns `persistenceQueue.state` (`disabled`, `healthy`, `saturated`, `draining`, `aborted`, or `unavailable`)
   - `/schedz` includes `persistenceQueue` counters
   - `/dashboard` attention block flags saturated, draining, aborted, and unavailable queue states
   - `/livez` is unchanged — no `persistenceQueue` field

4. **Observe 30 min settle** — Let the broker run under normal worker heartbeat load. Confirm:
   - Docker health: all latest samples passed
   - `/livez`: no 5s timeouts
   - Event loop: `eventLoop.degraded === false` on `/readyz`

### Phase B: Gwakga Follow (If Phase A Passes)

Repeat steps 1-3 for the Gwakga broker, with the same image tag and configuration.

### Live Verification Commands

```bash
# Quick health check
curl -s http://<broker>:8787/health | jq '.persistenceQueue'

# Queue state counter check
curl -s http://<broker>:8787/schedz | jq '.persistenceQueue'

# Dashboard attention check
curl -s http://<broker>:8787/dashboard | jq '.attention[] | select(.code | startswith("persistence-queue"))'

# Livez must NOT have persistenceQueue
curl -s http://<broker>:8787/livez | jq 'has("persistenceQueue")'  # false
```

---

## 4. Canary and Latency Proof

### 4.1 Canary Configuration

Before the latency proof gate, configure the canary:

| Setting | Value | Rationale |
|---------|-------|-----------|
| `keepAliveTimeoutMs` | 62000 (default, configurable via env `BROKER_KEEPALIVE_TIMEOUT_MS`) | Prevents TCP handshake from conflating with handler latency |
| `persistenceQueueDiagnostics` | Enabled (wired from broker) | Provides visibility into queue state without adding hot-path overhead |
| Monitoring interval | 15s healthcheck, 5s livez | Matches existing Docker compose defaults |

### 4.2 Latency Proof Gate

Run the latency gate after a 30-min settle with the canary configuration:

**Gate command (read-only, bounded):**
```bash
# 90-second observation window
node scripts/broker-comprehensive-diagnostics.mjs \
  --broker-url http://<broker>:8787 \
  --duration 90 \
  --expect-zero-3s \
  --threshold-1s 2.0
```

**Pass criteria:**

| Metric | Target | Source |
|--------|--------|--------|
| HTTP failures | 0 | Gate HTTP responses |
| `/livez` p99 | < 2ms | `/livez` response time series |
| `/livez` samples > 1s | < 2% (≤ 2 samples over 90s at 5s interval) | `/livez` time series |
| `/livez` samples > 3s | 0 (zero tolerance) | `/livez` time series |
| `persistenceQueue.state` | `"healthy"` (or `"disabled"` before live worker-thread enablement); never `"saturated"`, `"aborted"`, or `"unavailable"` | `/health` or `/schedz` |
| `eventLoop.degraded` | `false` | `/readyz` |
| Docker health latest | All passed | `docker inspect` |
| Worker registrations | No unexpected churn | `/schedz` worker heartbeat list |

**If pass:** Proceed to Phase B (Gwakga deploy) if not yet done, then to §5 (rollback boundary) and §7 (release decision).

**If fail:** Execute §6 (rollback), then document residual attribution.

### 4.3 Correlation Runbook

If the gate passes on both brokers but residual >1s samples remain, run the attribution script:

```bash
node scripts/broker-livez-stall-attribution.mjs \
  --broker-url http://<broker>:8787 \
  --schedz-samples 200
```

This script (already in `scripts/broker-livez-stall-attribution.mjs`) correlates `/livez` timing with `/schedz` snapshot timing and helps attribute stalls to event-loop delay, request path, SQLite persistence, or scheduling attribution.

---

## 5. Wiki / Evidence Requirements

### 5.1 Required Evidence Artifacts

Before the release decision, collect these evidence artifacts:

| Artifact | Source | Format |
|----------|--------|--------|
| Preflight test results | CI output | Markdown + links |
| `npm run build` log | CI | Text |
| `npm test` log | CI | Text |
| Diagnostics contract test | `node --test ... persistence queue diagnostics` | CLI output |
| Image build log | `docker build` | Text |
| Seoseo deploy timestamp | Operator log | ISO-8601 |
| Seoseo 30-min settle health | `/health`, `/livez`, `/readyz` sequence | JSON snapshot |
| Seoseo latency gate report | `broker-comprehensive-diagnostics.mjs` | JSON + Markdown |
| Gwakga deploy timestamp | Operator log | ISO-8601 |
| Gwakga latency gate report | `broker-comprehensive-diagnostics.mjs` | JSON + Markdown |
| Correlation report (if >1s samples) | `broker-livez-stall-attribution.mjs` | Markdown |
| `/schedz` snapshot at peak | `curl /schedz` | JSON |

### 5.2 Wiki Page Structure

Create or update the broker ops wiki page with:

```markdown
# Broker Persistence Queue Diagnostics

## Overview
The persistence queue diagnostics surface exposes `PersistenceQueue` state
on operator-facing endpoints without adding work to the /livez hot path.

## Endpoints

### /health
- `persistenceQueue.kind` — always `"broker.persistence.queue"`
- `persistenceQueue.state` — one of: `disabled`, `healthy`, `saturated`,
  `draining`, `aborted`, `unavailable`
- `persistenceQueue.capacity` — max queue depth
- `persistenceQueue.queued` — pending writes
- `persistenceQueue.inFlight` — active + queued writes
- `persistenceQueue.available` — remaining slots (`capacity - inFlight`)
- `persistenceQueue.closing` — boolean, true during shutdown drain
- `persistenceQueue.lastErrorMessage` — last error (cleared on success)
- `persistenceQueue.mode` — `"inline"` or `"worker_thread"`

### /schedz
- Same fields as /health

### /dashboard
- Same fields as /schedz
- Attention block flags `persistence-queue-saturated`,
  `persistence-queue-unavailable`, `persistence-queue-draining` with count.

### /livez
- NOT included — /livez stays lightweight regardless of queue state.

## Queue States

| State | Meaning | Action |
|-------|---------|--------|
| `disabled` | No persistence queue configured | No action |
| `healthy` | Queue is enabled and accepting writes | No action |
| `saturated` | Queue full, writes rejected | Investigate; consider scaling |
| `draining` | Shutdown in progress | Wait for drain or timeout |
| `aborted` | Queue terminated by error | Investigate crash/error |
| `unavailable` | Worker unavailable | Restart broker |

## Rollback

See [docs/a2a-1032-live-proof-release-gate-plan.md](../docs/a2a-1032-live-proof-release-gate-plan.md#6-rollback).
```

---

## 6. Rollback

### 6.1 Rollback Triggers (R1–R5)

| ID | Trigger | Severity | Action |
|----|---------|----------|--------|
| R1 | `/livez` 5s timeout reappears after deploy | Critical | Immediate rollback |
| R2 | New 3s+ `/livez` samples > 0 during gate | Critical | Immediate rollback |
| R3 | `persistenceQueue.state === "saturated"` for > 60s continuously | High | Rollback during maintenance window |
| R4 | Unexpected worker registration churn | High | Rollback during maintenance window |
| R5 | Docker healthcheck failure attributed to persistence queue | Critical | Immediate rollback |

### 6.2 Rollback Procedure

```bash
# 1. Revert to previous image tag
BROKER_IMAGE_TAG=seoseo-github-<pre-deploy-commit>
docker compose -f docker-compose.yml up -d broker

# 2. Verify recovery
curl -s http://<broker>:8787/health | jq '.ok'    # true
curl -s http://<broker>:8787/livez                 # < 2ms
curl -s http://<broker>:8787/readyz | jq '.ready'  # true

# 3. Confirm queue diagnostics return to pre-deploy state
curl -s http://<broker>:8787/health | jq '.persistenceQueue'
# Should show disabled state (no provider)

# 4. Document the rollback reason in #1032
```

### 6.3 Rollback Safety

- Reverting the image does not require a DB migration, data rewrite, or schema change
- The synchronous SQLite persistence path is unchanged — the worker-thread queue is an additive layer
- If the queue was in `saturated` or `draining` state at rollback time, any uncommitted writes must be reconciled before the next deploy

---

## 7. Release Decision

### 7.1 Release Gate Criteria

After the latency proof passes on **both** Seoseo and Gwakga:

| Criterion | Requirement | Evidence |
|-----------|-------------|----------|
| G1 | Latency gate passed on Seoseo | Gate report timestamp |
| G2 | Latency gate passed on Gwakga | Gate report timestamp |
| G3 | No rollback triggers fired (see §6.1) | Operator log |
| G4 | All source preflight checks pass | CI log |
| G5 | #1032 acceptance criteria satisfied | Issue comment |
| G6 | Libero validation matrix #1032 guardrails satisfied | C6-C9 from libero matrix |
| G7 | Approval comment from Seoseo on issue | Issue link |
| G8 | Wiki/evidence artifacts published | Wiki page link |

### 7.2 Release Path

1. **Seoseo approves:** Seoseo (the operator) posts an approval comment on #1032
2. **Documentation updated:** Wiki page committed in the release branch
3. **Tag:** Release tag pushed (e.g., `v1.6.0-rc1` or agreed version)
4. **Release notes:** Include summary of persistence queue diagnostics and #1032 closure
5. **Close #1032:** Seoseo closes the issue with a summary comment

### 7.3 If Gate Fails

1. Do not deploy to Gwakga (if Phase A failed)
2. Rollback Seoseo (if Phase B failed before Gwakga deploy)
3. Open a follow-up issue with the residual attribution evidence
4. Document the latency threshold that was not met
5. Do not close #1032 — keep the issue open for the follow-up

---

## 8. Approval Gate

### 8.1 What Requires Approval

The following actions require a **separate, fresh approval** from the operator (Seoseo) in a comment on #1032:

- [ ] Deploy new broker image to Seoseo (any image change)
- [ ] Deploy new broker image to Gwakga
- [ ] Enable persistence queue diagnostics on a live broker
- [ ] Run any script that makes repeated or latency-measuring live HTTP requests to a production broker
- [ ] Modify broker/server configuration in production
- [ ] Cut a release or tag
- [ ] Close #1032

### 8.2 What Does NOT Require Approval

- Source commits, PRs, and reviews
- Test suite runs
- Dry-run / mock-mode script execution
- Documentation changes
- One-off read-only source/GitHub inspection and local dry-run/mock-mode checks

### 8.3 Approval Request Template

```
**Request:** #1032 [deploy/canary/gate/release] — [brief description]

**Plan reference:** docs/a2a-1032-live-proof-release-gate-plan.md §[section]

**Changes:**
- [list of PRs, commits, or config changes]

**Risks:**
- [list of identified risks]

**Rollback:**
- [rollback procedure reference]

**Requested by:** @yukson
**Date:** YYYY-MM-DD
```

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Queue diagnostics add latency to /health | Low | Medium | /health is not hot-path; /livez explicitly excludes queue field |
| Worker-thread queue saturated during peak | Low | High | Fail-closed saturation; operator alerted via dashboard attention |
| Shutdown drain timeout causes lost writes | Low | Critical | Drain timeout + explicit error propagation; rollback to sync path |
| Worker crash during queue write | Low | High | Error propagates to caller; queue restarts with same SQLite file |
| KeepAliveTimeout increase causes idle-connection memory pressure | Low | Medium | Bounded number of workers (~dozens); monitor with `/schedz` connection counters |
| Rollback needed but operator unfamiliar with procedure | Medium | Medium | Document rollback in runbook; test recovery with dry-run script |
| OCaml/runtime bootstrap context files leak into PR artifact | Low | Medium | Pre-PR guard in runner; `git status --porcelain` check before artifacts |

---

## 10. File References

### Source (diagnostics contract)
- `src/server.ts` — `BrokerPersistenceQueueDiagnostics`, `BrokerPersistenceQueueDiagnosticsProvider`, `readPersistenceQueueDiagnostics`
- `src/core/broker.ts` — `queue_saturated`, `queue_drain_timeout`, `queue_closed` error codes

### Tests
- `src/server.test.ts` — `"server surfaces persistence queue diagnostics on health, schedz, and dashboard"`, `"server maps retryable persistence queue BrokerErrors to 503"`
- `src/core/sqlite-worker-thread-spike.test.ts` — Spike queue semantics tests

### Spike / Design
- `docs/a2a-1032-sqlite-worker-thread-spike.md` — Full spike ADR with verdict history
- `docs/persistence-next-step-proposal.md` — Original SQLite persistence path proposal
- `docs/yukson-1032-a2ad-followup-03-review.md` — Libero review of #1083/#1086

### Diagnostics Scripts
- `scripts/broker-comprehensive-diagnostics.mjs` — Latency proof gate runner
- `scripts/broker-livez-stall-attribution.mjs` — Stall correlation analysis
- `scripts/release-gate.mjs` — Pre-cut release verification
- `scripts/closeout-release-report.mjs` — Closeout evidence renderer

### Libero Validation
- `src/core/libero-validation-matrix.ts` — #1032 guardrails C6-C9, T6-T9, L8-L11
- `docs/libero-scheduling-gate-criteria.md` — Gate criteria K1-K5, R1-R5

### This Document
- `docs/a2a-1032-live-proof-release-gate-plan.md` — Approval-gated live-proof and release plan

---

**Start marker:** 2026-06-04T02:21:00Z | **Worker:** yukson (Team1, lane 4/4)
