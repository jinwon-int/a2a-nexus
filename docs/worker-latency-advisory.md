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
  timestamp events, tasks without a usable worker identity;
- body-free receipt measurements per worker (#1815 item 1 slice, see below):
  source bytes, model requests, schema retries, and model-metadata coverage.

The view carries **no** prompts, payloads, messages, credentials, paths, model
names, error excerpts, evidence refs, URLs, or task bodies — counts,
milliseconds, bytes and bounded enum keys only. Worker identifiers are
operator-scope data, which is why this surface is role-gated while
`/stats/tasks` (public-safe aggregates) deliberately omits worker identities.

## Receipt measurements (#1815 item 1 slice)

Each terminal task contributes **one** receipt, chosen by deterministic
precedence: a structured bridge failure (`error.details.bridgeFailure`) wins on
failed tasks so success-side metadata can never hide a failure receipt;
otherwise the preserved/success result output (`result.output`) is used. A
terminal task with neither carrier is reported under `receipts.carriers.none` —
absence is reported, never imputed:

- `sourceBytes`: only the carrier's `sourceCarrierStats.totalBytes`, reported as
  observed count + distribution, with `missing` counted separately. A fractional,
  negative, non-finite or non-numeric value is not an observation.
- `executionTelemetry`: only well-formed `a2a.analysis-execution-telemetry.v1`
  objects from `piri_progress_file` or `claude_cli_envelope` count as observed;
  wrong schema/source/shape counts as `invalid`, an absent object as `missing`,
  and `truncated: true` stays visible in `truncated`. An incomplete or truncated
  receipt is never treated as complete. `modelRequests` and `schemaRetries` are
  strict non-negative safe integers — an explicit valid zero is a real
  observation and stays distinct from absence. Retry reasons are aggregated
  under the bounded enum (`extra_property`, `missing_field`, `invalid_value`,
  `no_json_candidate`, `provider_failure`, `other`); unknown keys are dropped,
  never emitted. No token or USD estimation is performed.
- `modelMetadata`: presence coverage for requested/actual/effective model and
  requested/effective thinking — counts only, never names. The equality
  counters compare **literal identifier equality only**: alias-equivalent ids
  (e.g. `k3[1m]` vs a canonical provider id) count as literal differences, so a
  literal difference is NOT by itself proof of a runtime mismatch. There is no
  "actual thinking" carrier; none is inferred.

`coverage.receipts` / `coverage.executionTelemetry` aggregate the same
classification over every in-window terminal task, including the unattributed
ones counted in `tasksWithoutWorkerIdentity`.

## What it does not do

`viewMode` is `read_only_advisory` and `automaticRoutingPolicy` is `none`:

- it never routes, claims, denies, retries, finalizes, or scores by itself;
- it is not success evidence and does not relax any exact-head,
  independence, signature/provenance, or safety gate;
- a missing or stale profile is "no usable view", never permission;
- receipt measurements document what ran — they prove no latency decrease and
  satisfy none of #1815's paired A/B, canary or model-attestation conditions.

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
