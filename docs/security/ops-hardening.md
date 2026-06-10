# A2A Nexus Security and Ops Hardening

> **Status:** Private/alpha. Part of the A2A security hardening roadmap (a2a-plane#440).
> **Parent tracker:** https://github.com/jinwon-int/a2a-plane/issues/443
> **Team1 productization lane 4/4 — yukson.**

This document covers the first security/ops hardening source slice for the A2A Nexus broker and worker surface. It defines the read-only audit surface, exposure/auth expectations, worker credential mount validation, stale worker identity lifecycle, and readiness dimensions.

## Safety boundary

This document is read-only guidance. It does not authorize:

- Production deployments or Gateway/broker/worker restarts
- Production database mutations or terminal-outbox ACK mutations
- Live provider or Telegram sends
- Secret rotation or disclosure
- Repository visibility changes
- History rewrites or force pushes

Every action below requires separate explicit operator approval naming the action.

---

## 1. Read-only Audit Checklist

Operators run `packages/broker/scripts/ops-hardening-audit.mjs` for a comprehensive read-only check covering all five areas.

### Quick start

```sh
# Synthetic no-live proof (no broker required)
node packages/broker/scripts/ops-hardening-audit.mjs --no-live

# Against a running broker (read-only GETs only)
node packages/broker/scripts/ops-hardening-audit.mjs --base-url http://127.0.0.1:8787

# With edge secret authentication
node packages/broker/scripts/ops-hardening-audit.mjs --base-url http://127.0.0.1:8787 --edge-secret "${A2A_EDGE_SECRET}"
```

### Manual checklist (for environments without script execution)

| # | Check | Area | Command | Expected |
|---|-------|-------|---------|----------|
| 1 | Broker health | Exposure/Auth | `GET /health` | HTTP 200, `ok: true`, `edgeSecretRequired` reflects config |
| 2 | Agent card published | Exposure/Auth | `GET /.well-known/agent-card.json` | HTTP 200, public (no edge secret required) |
| 3 | Auth enforcement | Exposure/Auth | Inspect `/health` `requestSecurity` | `edgeSecretRequired` and `enforceRequesterIdentity` match operator intent |
| 4 | Rate limiting active | Exposure/Auth | Inspect `/health` `requestSecurity` | Non-zero window/limit values |
| 5 | Worker credential env vars | Credential mount | Inspect worker env | `BROKER_URL` or `A2A_BROKER_URL` set; `WORKER_ID` or `A2A_WORKER_ID` set |
| 6 | Worker capabilities | Credential mount | Inspect worker env | Capabilities defined via JSON or individual env vars |
| 7 | Home broker lease | Credential mount | Inspect lease file path | File exists with valid `brokerId` and `workerId` (content redacted) |
| 8 | Worker online status | Stale lifecycle | `GET /workers` | All expected workers report `status: "online"` |
| 9 | Worker capacity | Stale lifecycle | `GET /workers/capacity` | HTTP 200 with worker count summary |
| 10 | Stale reaper enabled | Stale lifecycle | Inspect `/health` `staleReaper` | `enabled: true` with reasonable `intervalSec` and `olderThanSec` |
| 11 | Queue pressure | Readiness | `GET /tasks/diagnostics` | Zero stale/blocked tasks in steady state |
| 12 | Task diagnostics | Readiness | `GET /tasks/diagnostics` | All tasks within diagnostic thresholds |
| 13 | Terminal outbox gaps | Readiness | `GET /a2a/tasks/terminal-outbox` | All events ACKed or receipt gaps within operator tolerance |

---

## 2. Exposure and Auth Expectations

### Endpoint exposure matrix

| Path | Method | Requires edge secret? | Requires requester identity? | Public? | Notes |
|------|--------|-----------------------|------------------------------|---------|-------|
| `/health` | GET | No | No | Yes | Read-only diagnostic; intentionally public for monitoring |
| `/.well-known/agent-card.json` | GET | No | No | Yes | A2A Agent Card discovery; intentionally public |
| `/a2a/jsonrpc` | POST | Yes | Per-method | No | Core API; edge secret always required |
| `/workers/register` | POST | Yes | Yes | No | Identity-bound write |
| `/workers/:id/heartbeat` | POST | Yes | Yes | No | Identity-bound write |
| `/workers` | GET | Yes | No | No | Read-only worker list; edge secret required |
| `/workers/capacity` | GET | Yes | No | No | Read-only capacity summary |
| `/workers/:id` | GET | Yes | No | No | Read-only worker detail |
| `/tasks` | GET | Yes | No | No | Read-only task list |
| `/tasks` | POST | Yes | Yes | No | Identity-bound write |
| `/tasks/:id` | GET | Yes | No | No | Read-only task detail |
| `/tasks/:id/claim` | POST | Yes | Yes | No | Identity-bound write |
| `/tasks/:id/start` | POST | Yes | Yes | No | Identity-bound write |
| `/tasks/:id/complete` | POST | Yes | Yes | No | Identity-bound write |
| `/tasks/:id/fail` | POST | Yes | Yes | No | Identity-bound write |
| `/tasks/:id/evidence` | POST | Yes | Yes | No | Identity-bound write |
| `/tasks/:id/cancel` | POST | Yes | Yes | No | Identity-bound write |
| `/tasks/:id/approve` | POST | Yes | Yes | No | Restricted to hub/operator role |
| `/tasks/:id/reassign` | POST | Yes | Yes | No | Restricted to hub/operator role |
| `/tasks/diagnostics` | GET | Yes | No | No | Read-only |
| `/tasks/requeue_stale` | POST | Yes | Yes | No | Restricted to hub/operator role |
| `/tasks/terminal-outbox` | GET | Yes | Yes | No | Restricted to hub/operator role |
| `/tasks/terminal-outbox/receipt` | POST | Yes | Yes | No | Restricted to hub/operator role |
| `/tasks/terminal-outbox/ack` | POST | Yes | Yes | No | Restricted to hub/operator role |
| `/a2a/tasks/:id/events` | GET | Yes | Yes | No | SSE stream; identity-bound |
| `/a2a/operator/events` | GET | Yes | Yes | No | SSE stream; hub/operator role required |
| `/dashboard` | GET | Yes | No | No | Read-only operator dashboard |
| `/alerts` | GET | Yes | No | No | Read-only alert projection |
| `/audit` | GET | Yes | No | No | Read-only audit log |
| `/proposals` | GET/POST | Yes | Per-method | No | Identity-bound reads/writes |
| `/exchanges` | GET/POST | Yes | Per-method | No | Identity-bound reads/writes |

### Auth enforcement flags (set via env)

- **`EDGE_SECRET` / `A2A_EDGE_SECRET`**: Shared secret required by non-public endpoints. If unset, the broker will still start but public-discoverable endpoints and authenticated routes issue 401 without it.
- **`ENFORCE_REQUESTER_IDENTITY`** (default `1`): When enabled, write endpoints validate `x-a2a-requester-id` / `x-a2a-requester-role` / `x-a2a-requester-kind` headers against the actor making the request. Operators running in trusted networks can disable, but this weakens the identity audit trail.
- **`TRUSTED_PROXY`**: Set to `1` when the broker sits behind a reverse proxy that strips external `x-a2a-*` headers. Without this, rate-limiting key computation may produce incorrect results.

### Secrets and edge security

- The edge secret is never logged or included in health/dashboard responses.
- Worker credential env vars (`BROKER_EDGE_SECRET`, `A2A_BROKER_EDGE_SECRET`) are read at startup; no live reload path exists.
- **Edge secret rotation**: Requires broker restart. No hot-reload support yet — this is a documented gap for the next hardening iteration.

---

## 3. Worker Credential Mount Validation

### Required credential sources

A valid worker configuration provides:

| Source | Required | Purpose |
|--------|----------|---------|
| `BROKER_URL` or `A2A_BROKER_URL` | Yes | Broker endpoint for task polling and lifecycle calls |
| `WORKER_ID` or `A2A_WORKER_ID` | Yes | Unique worker identity used in `x-a2a-requester-id` headers |
| `WORKER_ROLE` or `A2A_WORKER_ROLE` | Yes | Party role (`analyst`, `hub`, `researcher`, `operator`, `live-trader`) |
| `BROKER_EDGE_SECRET` or `EDGE_SECRET` | Recommended | Shared edge secret for authenticated broker calls |
| `A2A_HOME_BROKER_ID` | Recommended | Pin worker to a specific broker identity; fail-closed on mismatch |
| `A2A_HOME_BROKER_LEASE_FILE` | Recommended | Filesystem lease preventing accidental cross-broker retargeting |

### Credential mount validation checks

The `ops-hardening-audit` script validates:

1. Required env vars are present (by name, not by value).
2. Optional/recommended env vars or their fallbacks are present.
3. If `A2A_HOME_BROKER_LEASE_FILE` is configured, the file exists on disk and contains valid `brokerId` and `workerId` fields (path checked, content validated for shape, never printed).
4. Worker capabilities are configured either via `WORKER_CAPABILITIES_JSON` or individual env vars.

### Credential mount failure modes

| Condition | Behavior | Detection |
|-----------|----------|-----------|
| Missing `BROKER_URL` | Worker fails to start; `BrokerApiError` on first HTTP call | Audit script reports `fail` |
| Missing `WORKER_ID` | Worker fails to start | Audit script reports `fail` |
| Mismatched `A2A_HOME_BROKER_ID` | Worker refuses to claim tasks; emits error log | Audit script reports `warn` |
| `A2A_HOME_BROKER_LEASE_FILE` not found | Worker creates lease file on first heartbeat | Audit script reports `warn` |
| Credential file contains expired/malformed data | Worker fails to validate lease; throws | Audit script reports `warn` |

### Secret hygiene

- Worker credential values are never logged to stdout/stderr by the worker daemon or the audit script.
- The audit script emits env var **names** only, never **values**.
- Home broker lease file content is validated for JSON shape but never printed.

---

## 4. Stale Worker Identity Lifecycle

### Stale worker detection

The broker marks a worker as `stale` when its last heartbeat exceeds the `WORKER_OFFLINE_AFTER_SEC` threshold (default 90 seconds).

Detection points:

| Surface | Mechanism | Latency |
|---------|-----------|---------|
| `GET /workers` | Computed `status` field per worker | ~offlineAfterSec |
| `GET /workers/capacity` | Counts online/stale workers | ~offlineAfterSec |
| `GET /dashboard` | `staleWorkersWithActiveTasks` list | ~offlineAfterSec |
| `GET /alerts` | Alert projection for missing heartbeats | ~offlineAfterSec |
| SSE operator events | Real-time stale worker alerts | Seconds after threshold |

### Stale worker lifecycle

```
Worker registered
  │
  ├─ heartbeat received within threshold → status = "online"
  │
  └─ heartbeat missed > WORKER_OFFLINE_AFTER_SEC → status = "stale"
       │
       ├─ Worker reconnects → status returns to "online"
       │
       └─ Stale worker holds claimed/running tasks
            │
            ├─ Stale reaper (60s interval) requeues task up to N times
            │   (BROKER_MAX_REQUEUE_ATTEMPTS, default 3)
            │
            └─ Exceeded requeue limit → task dead-lettered (status= "failed", code="exceeded_requeue_limit")
                 │
                 └─ Operator reviews dead-lettered tasks:
                    - Inspect failed evidence
                    - Create replacement task if needed
                    - Reassign to healthy worker
```

### Inactive worker retention

The broker's retention policy (`BROKER_INACTIVE_WORKER_RETENTION_MS`) governs when stale worker records are pruned from state. The `inactiveWorkerRetentionMs` and `maxInactiveWorkers` settings prevent unbounded accumulation of dead worker entries.

### Operator actions for stale identities

| Action | Endpoint | Approval required? | Notes |
|--------|----------|-------------------|-------|
| View stale workers | `GET /workers` | No | Read-only |
| View stale worker task assignments | `GET /dashboard` | No | Read-only dashboard includes stale assignment count |
| Requeue stale tasks | `POST /tasks/requeue_stale` | No for operator role | Automatic via stale reaper; manual as fallback |
| Reassign task from stale worker | `POST /tasks/:id/reassign` | Yes (hub/operator) | Requires explicit actor |
| Force-dead-letter stale task | Manually via fail endpoint | Yes | Last resort after requeue limit |
| Clean up stale worker registration | Not supported via API yet | — | Current gap: no worker deregistration endpoint |

### Known lifecycle gaps

1. **No worker deregistration API**: Once registered, a worker identity persists until the broker's inactive retention policy prunes it. There is no explicit `DELETE /workers/:id` endpoint.
2. **No grace-period heartbeat retry**: A worker whose heartbeat is stale is immediately marked offline; there is no configurable grace window before reaper actions fire.
3. **No worker identity reaper**: Inactive worker records accumulate until retention limits are reached. A worker identity lifecycle reaper (separate from the task stale reaper) is not implemented.

---

## 5. Readiness Dimensions

Readiness is not a single boolean. The A2A Nexus broker separates five distinct dimensions:

### Dimension matrix

| Dimension | Indicator | Source | Typical healthy state |
|-----------|-----------|--------|----------------------|
| **Health** | Broker process is running and responding | `GET /health` → `ok: true` | HTTP 200 with build info |
| **Liveness** | Broker can accept and process requests | Any authenticated GET succeeds | HTTP 200 on worker/task reads |
| **Worker connectivity** | Expected workers are online | `GET /workers` → online count | All registered workers within heartbeat window |
| **Receipt gaps** | Terminal outbox events have manual receipt confirmation | `GET /a2a/tasks/terminal-outbox` | All events ACKed or acknowledged within operator tolerance |
| **Queue pressure** | Active tasks within normal thresholds | `GET /tasks/diagnostics` | Zero stale/long-running/blocked tasks in steady state |

### Why separation matters

- **Health** tells an operator the broker process started. It does not tell them workers are connected or tasks are flowing.
- **Liveness** confirms the request pipeline works. A broker can be "healthy" but non-live (e.g., DB connection lost but health endpoint still returns 200).
- **Worker connectivity** is an independent dimension: the broker is healthy, workers may not be.
- **Receipt gaps** track terminal event delivery to operators. A broker can be healthy and live while terminal receipts are stuck at `provider_sent` (not yet operator-visible).
- **Queue pressure** monitors task throughput. Even with healthy workers and live broker, queue pressure can indicate a bottleneck.

### Readiness validation script

The `ops-hardening-audit.mjs` script checks all five dimensions:

```
Dimension           Check                  Pass condition
─────────────────────────────────────────────────────────────
Health              broker-health-endpoint  HTTP 200, ok: true
Liveness            agent-card-endpoint     HTTP 200 (no auth)
Worker connectivity workers-stale-identities All expected workers online
Receipt gaps        terminal-outbox-unacked  All terminal events ACKed
Queue pressure      queue-pressure          Zero queued/claimed/running
Queue pressure      task-diagnostics        No stale/long-running tasks
```

### Operator runbook for separation

```sh
# 1. Quick health check
curl -s http://localhost:8787/health | jq '.ok, .service, .version'

# 2. Liveness check (auth-protected read)
curl -s -H 'x-a2a-edge-secret: ...' http://localhost:8787/workers | jq '.items | length'

# 3. Worker connectivity
curl -s -H 'x-a2a-edge-secret: ...' http://localhost:8787/workers | jq '[.items[] | {nodeId, status}]'

# 4. Receipt gaps
curl -s -H 'x-a2a-edge-secret: ...' http://localhost:8787/a2a/tasks/terminal-outbox | jq '.events[] | {id, receiptStatus: .receipt?.status, ackStatus: .ack?.status}'

# 5. Queue pressure
curl -s -H 'x-a2a-edge-secret: ...' http://localhost:8787/tasks/diagnostics | jq '[.items[] | {id, status, diagnosticStatus}]'
```

### Composite readiness

A broker is "ready for operation" when all five dimensions are healthy simultaneously. The dashboard (`GET /dashboard`) and alerts (`GET /alerts`) provide a composite view, but the individual dimensions should always be inspectable via separate endpoints for precise triage.

---

## Appendix: Running the audit

```sh
# From repository root
node packages/broker/scripts/ops-hardening-audit.mjs --no-live --json

# With tests
node --test packages/broker/scripts/ops-hardening-audit.test.mjs
```

### Evidence

When filing hardening evidence, include:

- Audit report JSON (redacted — no secret values)
- Test output (pass/fail counts only)
- Document reference (this file)
- Safety confirmation: no secrets printed, no mutations attempted

---

*Redacted validation artifact only. Does not authorize production impact, visibility changes, or terminal ACKs without separate explicit operator approval.*
