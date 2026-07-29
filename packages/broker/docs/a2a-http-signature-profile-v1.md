# A2A HTTP Signature Profile v1

Status: design proposal
Parent tracker: [#691](https://github.com/jinwon-int/a2a-nexus/issues/691)

## Summary

A2A broker/worker control-plane authentication should be transport-independent. Deployments may use public HTTPS, private IPs, SSH tunnels, Tailscale, Cloudflare, mTLS front doors, or other adapters, but the A2A Nexus core must not require any one of those networks or vendors to be safe.

This profile proposes first-party per-worker signed request authentication for broker control-plane routes:

- each worker owns a stable Ed25519 signing key or equivalent worker credential;
- each broker stores or discovers the worker public key and authorization scope;
- each worker signs broker requests with a narrow HTTP request signature profile aligned with [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421);
- the broker verifies signature ownership, route scope, body integrity, timestamp, nonce replay, and broker audience before mutating task state.

The existing shared `x-a2a-edge-secret` remains useful as a legacy/bootstrap/edge-guard compatibility layer, but it should not be the primary long-term proof of worker identity.

## Goals

1. Allow safe broker/worker operation over ordinary HTTPS without requiring Tailscale, SSH tunnels, Cloudflare Access, SPIFFE/SPIRE, or a VPN.
2. Limit blast radius: a leaked worker credential must not impersonate other workers or hub/operator actors.
3. Bind each signed request to the method, route, query, requester, broker audience, and request body digest.
4. Reject replay with short-lived timestamps and per-key nonces.
5. Keep the profile narrow enough to implement and test reliably before attempting broader RFC 9421 flexibility.

## Non-goals

- Do not remove `x-a2a-edge-secret` in the first migration step.
- Do not require OAuth, SPIFFE/SPIRE, Tailscale, Cloudflare Access, SSH tunnels, or mTLS as core dependencies.
- Do not require full dynamic PKI or automated key rotation in the first implementation.
- Do not sign large artifacts inline; large artifacts should be referenced by URL/digest.

## Threat model addressed

Current shared-edge-secret worker auth makes the shared secret close to a master bearer key. If it leaks, an attacker can attempt to set `x-a2a-requester-id` and `x-a2a-requester-role` headers to impersonate workers.

Per-worker signing improves this model:

- the private key for `workerbeta` proves only `workerbeta`, not `workergamma`, `workerdelta`, hub, or operator;
- a captured signed request cannot be replayed after expiry or nonce consumption;
- a request signed for broker `brokeralpha` cannot be replayed against broker `brokerbeta` when audience binding is enforced;
- a modified body fails `Content-Digest` verification;
- route-specific authorization still decides whether the verified identity may perform the action.

This does not prevent misuse if code running on a worker can actively use that worker's private key. It reduces the blast radius to that worker and makes revocation/rotation possible.

## Request shape

A signed worker request should include:

```http
POST /tasks/task-123/claim HTTP/1.1
Host: broker.seoyoon-family.com
Content-Type: application/json
Content-Digest: sha-256=:<base64-sha256>:
X-A2A-Requester-Id: workerbeta
X-A2A-Requester-Role: analyst
X-A2A-Broker-Id: brokeralpha
Signature-Input: a2a=("@method" "@authority" "@path" "@query" "content-digest" "x-a2a-requester-id" "x-a2a-requester-role" "x-a2a-broker-id");alg="ed25519";keyid="worker:workerbeta:v1";created=1770861600;expires=1770861660;nonce="<random>";tag="a2a-worker-v1"
Signature: a2a=:<base64-signature>:
```

For requests without a body, the first implementation can either omit `content-digest` or sign an empty-body digest. The implementation should choose one behavior and enforce it consistently.

## Required covered components

The A2A v1 profile should require a fixed component set rather than allowing arbitrary RFC 9421 component choices.

| Component | Required | Purpose |
|---|---:|---|
| `@method` | yes | prevents method substitution |
| `@authority` | yes | binds Host / public authority |
| `@path` | yes | binds route |
| `@query` | yes | binds poll filters such as `assignedWorkerId` |
| `content-digest` | yes for body requests | binds request body |
| `x-a2a-requester-id` | yes | binds declared actor id |
| `x-a2a-requester-role` | yes | binds declared actor role |
| `x-a2a-broker-id` | yes | prevents cross-broker replay |

Implementation note: when a reverse proxy rewrites authority, the broker must verify against the external authority intended by deployment config, not an attacker-controlled forwarded header.

## Required signature parameters

| Parameter | Required | Rule |
|---|---:|---|
| `alg` | yes | `ed25519` for v1 |
| `keyid` | yes | identifies the worker public key / credential |
| `created` | yes | Unix timestamp |
| `expires` | yes | short expiry, recommended <= 60 seconds |
| `nonce` | yes | random unique nonce per key within replay window |
| `tag` | yes | `a2a-worker-v1` |

The broker should allow a small clock skew, for example ±60-120 seconds, and return an actionable clock-skew error when possible.

## Worker credential registry

The broker needs an in-memory-verifiable worker credential registry. The first implementation can load a static JSON file or broker config section; later implementations can support signed credentials, dynamic registry updates, or discovery.

Example static shape:

```json
{
  "workers": {
    "workerbeta": {
      "keyid": "worker:workerbeta:v1",
      "alg": "ed25519",
      "publicKeyJwk": { "kty": "OKP", "crv": "Ed25519", "x": "..." },
      "roles": ["analyst"],
      "scopes": [
        "workers.register:self",
        "workers.heartbeat:self",
        "tasks.poll:assigned:self",
        "tasks.claim:assigned:self",
        "tasks.start:claimed:self",
        "tasks.heartbeat:claimed:self",
        "tasks.complete:claimed:self",
        "tasks.fail:claimed:self",
        "tasks.evidence:claimed:self"
      ],
      "status": "active",
      "notBefore": "2026-06-14T00:00:00Z",
      "expiresAt": null
    }
  }
}
```

Future signed worker credentials can follow a NATS-like model:

```text
operator key -> broker/team credential -> worker credential -> signed request
```

That allows worker onboarding/rotation without treating every broker config file as the only source of truth.

## Scoped authorization matrix

Signature verification proves identity. Authorization still happens per route.

| Route family | Required identity/scope |
|---|---|
| `POST /workers/register` | `workers.register:self`; requester id must match worker id |
| `POST /workers/:id/heartbeat` | `workers.heartbeat:self`; path id must match requester id |
| `GET /tasks?assignedWorkerId=:id` | `tasks.poll:assigned:self`; query id must match requester id |
| `POST /tasks/:id/claim` | `tasks.claim:assigned:self`; task assigned worker must match requester id |
| `POST /tasks/:id/start` | `tasks.start:claimed:self`; claimed worker must match requester id |
| `POST /tasks/:id/heartbeat` | `tasks.heartbeat:claimed:self`; claimed/running worker must match requester id |
| `POST /tasks/:id/complete` | `tasks.complete:claimed:self`; claimed/running worker must match requester id |
| `POST /tasks/:id/fail` | `tasks.fail:claimed:self`; claimed/running worker must match requester id |
| `POST /tasks/:id/evidence` | `tasks.evidence:claimed:self`; claimed/running worker must match requester id |

Hub/operator routes should use separate credentials and stronger scopes. A worker credential must not grant hub/operator mutations.

### v1 implemented scope enforcement

The example registry and `:self`-qualified scope vocabulary above describe the
fuller target design. The broker currently enforces a v1 subset:

- **Registry shape** is a JSON object keyed by `keyid`, each record carrying
  `keyid`, `workerId`, `publicKeyJwk`, an optional `scopes` array, and optional
  credential-lifecycle fields `status` (`"active"`/`"revoked"`), `notBefore`,
  and `expiresAt` (ISO-8601). A `revoked` key is rejected at verification with
  `a2a_signature_key_revoked`; a key used before `notBefore` or at/after
  `expiresAt` is rejected with `a2a_signature_key_inactive`. An optional `roles`
  array binds the signed `x-a2a-requester-role`: when declared, a request whose
  role is not in the list is rejected with `a2a_signature_role_denied`, so a
  worker credential cannot assert a hub/operator role even though that header is
  signature-covered (omitted = no role restriction). The remaining richer fields
  (the `workers` wrapper and signed-credential chains) are not parsed yet.
- **Scope tokens** are the per-route capability labels enforced at the call
  sites (one token per worker route), not `:self`-qualified strings:

  | Route | Required scope token |
  |---|---|
  | `POST /workers/register` | `worker.register` |
  | `POST /workers/:id/heartbeat` | `worker.heartbeat` |
  | `GET /a2a/workers/:id/assignment-events` | `workers.assignment-events` |
  | `GET /tasks?assignedWorkerId=:id` (worker poll; `worker=:id` is an accepted alias) | `tasks.list` |
  | `POST /tasks/:id/claim` | `task.claim` |
  | `POST /tasks/:id/start` | `task.start` |
  | `POST /tasks/:id/heartbeat` | `task.heartbeat` |
  | `POST /tasks/:id/checkpoint` | `task.checkpoint` |
  | `POST /tasks/:id/complete` | `task.complete` |
  | `POST /tasks/:id/evidence` | `task.evidence` |
  | `POST /tasks/:id/fail` | `task.fail` |
  | `POST /review-lineages/:id/review-report` | `review-lineage.report` |

- **Self-binding** (requester id must equal the signing key owner / assigned
  worker) is enforced separately from the scope grant, so scope tokens encode
  capability only.
- **Transitional compatibility:** a key record with no `scopes` field is treated
  as an unscoped legacy credential authorized for every worker route. A record
  that declares `scopes` is enforced strictly — unknown scope tokens are
  rejected at registry load, and any route whose token is absent fails closed
  with `403 a2a_signature_scope_denied`.

## Replay protection

The broker should keep a per-key nonce cache for at least the maximum accepted clock window plus expiry window.

Recommended initial behavior:

- reject missing nonce;
- reject duplicate nonce for the same keyid;
- reject `created` too far in the future;
- reject expired signatures;
- use an in-memory TTL/LRU cache for the hot path;
- expose diagnostics for nonce-cache size and rejected replay count.

Avoid synchronous durable DB writes on every request. If multi-process replay protection becomes required, add an optional shared cache later.

## Performance expectations

A local Node.js crypto microbenchmark from the 2026-06-14 design discussion produced approximate costs:

```text
Ed25519 sign:   ~52 µs/request
Ed25519 verify: ~151 µs/request
SHA-256 1KB:    ~6 µs
SHA-256 64KB:   ~199 µs
SHA-256 1MB:    ~3.1 ms
```

For A2A task lifecycle traffic this is expected to be negligible relative to network latency, a typical 5s poll interval, GitHub/CI/provider latency, and task execution time.

Performance guardrails:

- keep task lifecycle request bodies small;
- send large artifacts by digest/reference rather than inline;
- cache public keys in memory;
- use an in-memory nonce cache;
- keep the first profile fixed and narrow.

## Migration plan

1. **Document semantics**: `BROKER_URL` is the control-plane endpoint; it can be public HTTPS, private IP, localhost tunnel, or another deployment adapter. `WORKER_PUBLIC_URL` is separate display/discovery metadata.
2. **Readiness hardening**: worker health must verify task-poll authorization (`GET /tasks?assignedWorkerId=<self>&status=queued`) in addition to register/heartbeat.
3. **Dual-auth optional mode**: workers may send both `x-a2a-edge-secret` and HTTP signatures; broker verifies signatures when present and logs diagnostics.
4. **Worker-route required mode**: require valid signatures for worker control-plane routes while keeping `x-a2a-edge-secret` as a legacy/edge guard.
5. **Rotation/revocation**: add key status, revocation, and versioned key ids.
6. **Transport matrix validation**: prove the same auth works over ordinary public HTTPS, reverse proxy, private IP, SSH tunnel, Tailscale, and Cloudflare-proxied HTTPS.

## Error behavior

The verifier should fail closed.

| Failure | HTTP | Suggested code |
|---|---:|---|
| Missing signature when required | 401 | `a2a_signature_required` |
| Unknown `keyid` | 401 | `a2a_signature_unknown_key` |
| Bad signature | 401 | `a2a_signature_invalid` |
| Expired / not yet valid | 401 | `a2a_signature_time_invalid` |
| Replayed nonce | 401 | `a2a_signature_replay` |
| Requester id != key owner | 401 | `a2a_signature_identity_mismatch` |
| Valid identity lacks route scope | 403 | `a2a_signature_scope_denied` |
| Body digest mismatch | 400 | `content_digest_mismatch` |

Do not log private keys, raw shared secrets, or full credential material.

## Open questions

1. Should v1 require `Content-Digest` for all requests, including empty-body GETs, to simplify verification?
2. Should public key registry live in broker config, SQLite, signed static file, or all three over time?
3. Should hub/operator use the same signature profile with different scopes, or a separate profile?
4. How should cross-broker relay identities differ from worker identities?
5. What is the minimum safe nonce cache behavior for multi-process deployments?
