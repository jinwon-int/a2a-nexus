# Worker latency advisory — consumption contract

Status: advisory telemetry contract for #1815 (items 1/6 measurement axis).
Surface: `GET /stats/workers` (hub/operator role-gated), schema
`a2a.worker-latency-profiles.v1` (implemented in `packages/broker/src/core/task-stats.ts` alongside the lifecycle-latency read path).

## What it provides

Per-worker terminal-task latency profiles over a bounded stats window
(default 7 days, `since`/`until` capped like `/stats/tasks`):

- run / queue / total latency distributions (`minMs`, `maxMs`, `averageMs`,
  `p50Ms`, `p95Ms`, nearest-rank — same policy as task lifecycle latency);
- outcome mix (`succeeded` / `failed` / `canceled`), bounded deterministic
  top failure codes (≤ 5);
- coverage counters: chains with a monotonic
  created→claimed→started→completed sequence, truncated workers, invalid
  timestamp events, tasks without a usable worker identity.

The view carries **no** prompts, payloads, messages, credentials, paths, or
free-form content — counts and milliseconds only. Worker identifiers are
operator-scope data, which is why this surface is role-gated while
`/stats/tasks` (public-safe aggregates) deliberately omits worker identities.

## What it does not do

`viewMode` is `read_only_advisory` and `automaticRoutingPolicy` is `none`:

- it never routes, claims, denies, retries, finalizes, or scores by itself;
- it is not success evidence and does not relax any exact-head,
  independence, signature/provenance, or safety gate;
- a missing or stale profile is "no usable view", never permission.

## Allowed use — tie-break only

Latency may be consulted only as a tie-break AFTER the candidate set has
already passed every hard filter:

1. worker capability and implementation/model readiness;
2. reviewer independence and author/recusal exclusions;
3. team/broker-of-record boundaries;
4. safety-lane strength requirements.

**Speed never justifies**: duplicate workers on one lane, author
self-review, weakening a safety lane, or an unverified model fallback.
Any future enforcement use (routing policy that *acts* on these profiles)
is out of scope here and requires a separate spec-first decision with its
own rollout/rollback contract.

## Operational notes

- The profiles are computed from the broker's task read paths on request —
  no new broker state, no migration, no restart needed to adopt or roll back.
- Truncation (`coverage.truncatedWorkers > 0`) means the `maxWorkers` cap
  (default 128, query param `maxWorkers`) hid workers deterministically —
  raise the cap rather than comparing a partial set.
- Dispatchers should record the snapshot they used (window + `workerId` +
  p50/p95) in their round evidence so a tie-break decision stays auditable.
