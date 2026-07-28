# A2A Nexus Security and Ops Hardening

> **Status:** Private/alpha. Part of the A2A security hardening roadmap (a2a-plane#440).
> **Parent tracker:** a2a-plane#443 (internal tracker, private)
> **Team1 productization lane 4/4 — worker-delta.**

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
| `/review-lineages` | GET/POST | Yes | Yes | No | Read roles for GET; exact operator role for POST contract freeze |
| `/review-lineages/:id` | GET | Yes | Yes | No | Redacted lineage projection |
| `/review-lineages/:id/operator-cancel` | POST | Yes | Yes | No | Exact operator role |
| `/review-lineages/:id/review-report` | POST | Yes | Yes | No | Ed25519 worker signature plus `review-lineage.report` scope |
| `/review-lineages/:id/correction-generation` | POST | Yes | Yes | No | Exact operator role; records an already committed generation only |
| `/review-lineages/:id/reviewer-replacement` | POST | Yes | Yes | No | Exact operator role; records a classified infrastructure-failure decision only |
| `/dashboard` | GET | Yes | No | No | Read-only operator dashboard |
| `/alerts` | GET | Yes | No | No | Read-only alert projection |
| `/audit` | GET | Yes | No | No | Read-only audit log |
| `/proposals` | GET/POST | Yes | Per-method | No | Identity-bound reads/writes |
| `/exchanges` | GET/POST | Yes | Per-method | No | Identity-bound reads/writes |

### Auth enforcement flags (set via env)

- **`EDGE_SECRET` / `A2A_EDGE_SECRET`**: Shared secret required by non-public endpoints. If unset, the broker will still start but public-discoverable endpoints and authenticated routes issue 401 without it.
- **`ENFORCE_REQUESTER_IDENTITY`** (default `1`): When enabled, write endpoints validate `x-a2a-requester-id` / `x-a2a-requester-role` / `x-a2a-requester-kind` headers against the actor making the request. Operators running in trusted networks can disable, but this weakens the identity audit trail.
- **`TRUSTED_PROXY`**: Set to `1` when the broker sits behind a reverse proxy that strips external `x-a2a-*` headers. Without this, rate-limiting key computation may produce incorrect results.

### Review-lineage correction authority

The correction-generation route is not a fixer or patch-application endpoint.
After the exact operator-role gate, trusted broker code assigns semantic
`correction_controller` authority and derives source identities. The body
cannot assert them. Admission requires canonical state
`correction_pending`, the exact pre-correction intent/head/diff tuple, the
unchanged frozen intent, and a complete changed-path list. Forbidden or
out-of-scope paths preserve the pending head.

Keep `A2A_REVIEW_LINEAGE_MODE=off` unless record-mode activation has separate
approval. Do not connect generic task/result/log/prose, retry, completion,
finalizer, or fixer flows to this route. It records an already committed
generation and must never apply or auto-push patch output.

### Review-lineage reviewer-allocation authority

The reviewer-replacement route requires the exact `operator` role. Trusted
broker code assigns semantic `reviewer_allocator` authority and fixes the
source kind, namespace, issuer, observation kind, and reason
`infrastructure_failure`. The body carries only a decision reference,
observation time, and exact current intent/head/diff binding; it cannot assert
a reviewer, worker, task, assignment, authority, or source identity.

This route records an already classified decision. It does not classify task
errors, select a replacement, mutate assignment, dispatch work, inspect generic
task/result/error/log/prose/retry/completion/finalizer state, or create an
automatic loop. Exact-subject mismatch and terminal lineages fail closed.
Replacement-budget exhaustion remains terminal and operator-visible, and a
replacement never resets shared lineage state or budget.

Keep `A2A_REVIEW_LINEAGE_MODE=off` unless record-mode activation has separate
approval. Source attachment coverage `5/5` is not activation, deployment,
independent review, finalizer closeout, or issue closeout.

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

## 6. HTTP Signature Replay Protection and Transport Binding (#917)

### Nonce-based replay protection

Worker authentication via HTTP Signature (Ed25519, tag `a2a-worker-v1`) now includes
transport-independent replay protection. The `nonce` parameter in the signature
input is authenticated by the signature itself; the verifier stores seen nonces
in a pluggable nonce cache. A replayed request (same nonce within its expiry
window) receives a fail-closed `a2a_signature_replay_detected` error.

#### Nonce cache contract

The `NonceCache` interface is transport-independent:

| Method | Purpose |
|--------|---------|
| `record(nonce, expiresAtEpochSeconds)` | Returns `true` for a fresh nonce, `false` for a replay. The expiry is the `expires` parameter from the signature input, so the cache entry lives exactly as long as the signature window. |
| `has(nonce)` | Check whether a nonce is currently tracked. |
| `prune(nowEpochSeconds)` | Garbage-collect entries past their expiry. |
| `size()` | Current tracked count (diagnostics). |

The in-memory implementation (`InMemoryNonceCache`) bounds at 10 000 entries by
default and evicts oldest entries when over cap — safe for single-process broker
deployments. Multi-process deployments can implement `NonceCache` with a shared
Redis or SQLite backing store.

#### Transport independence

Replay protection does not assume any particular transport. It operates purely
on the signature input fields (`nonce`, `created`, `expires`), which are part
of every signed request regardless of whether the request is delivered via:

- HTTP polling (`GET /tasks?worker=<id>`)
- Server-Sent Events (`GET /a2a/tasks/:id/events`)
- Webhooks (GitHub, etc.)
- WebSocket upgrades
- Future native worker transports

The broker records the nonce after signature verification succeeds; a replay is
rejected before any business logic executes. Operators must share a nonce cache
instance across all transport handlers within a single process.

#### Error shape (fail-closed)

```
HTTP 401 Unauthorized
x-a2a-error-code: a2a_signature_replay_detected
Body: {"error":"A2A HTTP signature nonce has already been seen — possible replay"}
```

#### Backward compatibility

When no `NonceCache` is provided to `verifyA2AHttpSignature`, no replay check
is performed. Existing callers that do not construct a nonce cache keep their
current behavior unaffected. This is a transitional state; once all deployment
configurations have adopted the cache, the backward-compatible path can be
deprecated.

### Scoped-key requirements (#691, #922)

Each worker signing key in the registry may declare a `scopes` array listing
the route scope tokens it is authorized for. The route scope tokens are defined
in `request-security.ts` as `A2A_WORKER_ROUTE_SCOPES`:

```
workers.assignment-events  worker.register  worker.heartbeat
tasks.list  task.claim  task.start  task.heartbeat
task.checkpoint  task.complete  task.evidence  task.fail
review-lineage.report
```

#### Current behavior (dual-auth transition)

- **Key with declared scopes**: The broker fails closed (`a2a_signature_scope_denied`)
  when the route's required scope is not listed in the key's grant.
- **Key without scopes (legacy)**: Treated as an unscoped credential authorized
  for every worker route. This compatibility path is **explicit, measurable, and
  temporary** — operators can audit unscoped keys by checking for the absence of
  the `scopes` field in their registry records.

#### Migration path to strict scoped keys

1. All new worker keys must declare explicit `scopes` — no new unscoped keys.
2. Existing unscoped keys operate with a warning log on each verification.
3. A future release will remove the unscoped compatibility path; at that point,
   all worker keys must declare scopes or be refused.
4. Operators can track migration progress by watching the `hasUnscopedKeys`
   metric (exposed via `/health` when available).

#### Lifecycle checks (already implemented)

- **Revoked keys** (`status: "revoked"`): Rejected at verification (`a2a_signature_key_revoked`).
- **Not-before/expires-at**: Keys outside their validity window are rejected (`a2a_signature_key_inactive`).
- **Role binding**: When `roles` are declared, the signed `x-a2a-requester-role`
  must appear in the list; otherwise `a2a_signature_role_denied`.

### Key provisioning and rotation requirements (no live secrets)

Refer to `packages/broker/src/core/request-security.ts` for the `A2AHttpSignatureKeyRecord`
schema. A key registry JSON file contains one record per `keyid`:

```json
{
  "worker:<workerId>:v1": {
    "keyid": "worker:<workerId>:v1",
    "workerId": "<workerId>",
    "publicKeyJwk": { "kty": "OKP", "crv": "Ed25519", "x": "<base64url>" },
    "scopes": ["worker.register", "worker.heartbeat", "task.claim", "task.complete"],
    "status": "active",
    "notBefore": "2026-06-01T00:00:00Z",
    "expiresAt": "2026-12-31T23:59:59Z"
  }
}
```

The registry is loaded from `A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE` at broker
startup and not hot-reloaded (same limitation as edge secret rotation). Key
rotation requires a broker restart — operators should plan maintenance windows.

### Explicit non-actions

This document section and the implementation it describes do NOT:
- Move, rotate, or create live secrets.
- Reconstitute credentials from environment variables.
- Restart any running broker, worker, or Gateway.
- Mutate any database, terminal outbox, or receipt state.
- Publish releases, tags, npm packages, or Docker images.

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
