# Feature Spec: A2A Task Assignment Entrypoint (#2187, parent #1601 S1)

> **Status**: implemented for the source slice (Phase A + B). Phase C
> (host/skill wiring, limited live pilot) is tracked but NOT executed here.
> This document authorizes no deploy, restart, fleet rollout, or live pilot.

## Problem

An agent that receives a work request currently assembles the dispatch
pipeline by hand: read the manual, pick a lane, author a manifest, collect
worker readiness, dry-run, dispatch, read back, recover from ambiguity.
Each step is a chance for trial-and-error, and the request→admission ceremony
dominates S1 latency. #1601's P0 measured only the broker-visible window;
the pre-create ceremony was invisible (see
[ceremony latency instrumentation](../ceremony-latency-instrumentation.md)).

## Goal

One stable programmatic entrypoint that maps a normalized task request to an
admitted (or explicitly blocked/needs-input) broker task with a durable
receipt — without requiring the caller to hand-assemble manifests, without
new standing services, and without bypassing any existing gate.

## Non-goals (from #2187)

- No DAG/multi-step fanout, no LLM-based authorization decisions, no
  readiness promotion of model output, no fast-lane activation, no automatic
  scope widening, no cancellation of other tasks, no review/CI bypass.
- No new Jev accounts or paid calls. Jev-based task classification (#2185)
  stays a separate, later concern.
- This tool does not CREATE readiness evidence; it consumes existing evidence
  (#1597 remains the canonical canary gate).

## Reuse contract (decided)

| Asset | Role in this slice |
|---|---|
| `scripts/a2a-dispatch-round.mjs` exports | Manifest shape, `validateManifest`, `runDispatch` (sequential POST, classification), `fetchTask` readback, `deriveLaneId`. Reused unchanged except an ADDITIVE `retryAfterMs` field on failed classifications (informational; dispatcher still never retries). |
| `scripts/a2a-worker-readiness-preflight.mjs` | `evaluateWorkerReadiness` for trusted offline records; the dispatcher's own #1034/#1597 row checks remain the FINAL authority for patch lanes — the entrypoint only mirrors them as a non-authoritative selection screen. |
| `GET /workers` broker read API | Live observation source (GET-only). Fields it does not carry stay `unknown`. |
| `ceremony-latency-instrumentation.md` | S1 model extended: the timeline below instruments request-received→admission, feeding S1 without any runtime broker change. |
| `a2a-task-poll` skill / agent manuals | Phase C: thin callers of this facade; NOT modified in this slice. |

**CLI decision**: NO new CLI command and no new top-level script. The script
budget (`scripts/*.mjs` 160/160, #882/#1485/#1503) stays flat: the entrypoint
is a library facade at `scripts/lib/task-assign-entrypoint.mjs`. Hosts and
skills import it directly. Reconsidering a CLI is a later slice with its own
budget justification.

## Request contract (`a2a.task-assign-request.v1`)

| Field | Requirement | Notes |
|---|---|---|
| `requestId` | required | `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`; journal key; never reused for a different spec. |
| `kind` | required | `analysis` \| `patch`. Unknown → invalid, never guessed. |
| `objective` | required | Free text; becomes the lane message head. |
| `requestRef` | required | URL/reference to the authoritative request source. |
| `target.repo` | required for patch | `owner/repo`. |
| `target.declaredScope.paths` | required for patch | Non-empty; copied verbatim — never widened. |
| `target.repoTests` | required for patch | Non-empty; embedded in the lane message. |
| `target.baseBranch` / `baseRevision` | optional | A non-40-hex `baseRevision` is recorded with reason `base_revision_unpinned`; branch→SHA pinning is a later slice (needs a read-only VCS lookup). |
| `target.hostSmoke` | optional (patch) | Missing → advisory `host_smoke_missing` on the prepared receipt. Distinct from `target.repoTests` (repository tests). |
| `lanes[]` | optional | Pass-through lane content (id/intent/message/payload); default single lane derived from kind. |
| `workerPolicy.preferredWorkers` | optional | Deterministic selection order. Part of the spec digest. |
| `workerPolicy.readinessRecords` | optional | Trusted locally-collected readiness rows (evidence — NOT part of the spec digest). Required evidence for patch submits; never fabricated by the entrypoint. |
| `budget.timeoutMs` | optional | Passed through unchanged; env-resolved effective budgets are NOT resolvable here and stay unclaimed. |
| `correlation.requestReceivedAt` / `.correlationId` | optional | Host-supplied S1 instrumentation input. |
| `brokerUrl`, secrets | **rejected in request text** | Trusted host context only (`context.brokerUrl`, `context.secret`); presence in the request fails with `untrusted_broker_or_secret_input`. |

**Missing fields are returned in ONE batch** (`missingFields[]`, dotted
paths); present-but-invalid values land in `invalidFields[]` of the same
response. The entrypoint never guesses scope or tests to pass pre-checks.

## Output contract (`a2a.task-assign-receipt.v1`)

States (fixed set, lossless mapping from dispatcher classifications recorded
in the same PR's spec tasks):

| State | Meaning / mapping |
|---|---|
| `needs_input` | Input/context contract incomplete (`missingFields[]`) or manifest validation found content-level gaps (`validationErrors[]`, sanitized). |
| `blocked` | Cannot proceed: no eligible worker, expired/missing readiness, unauthorized submit, lock contention, broker read failure. Zero tasks created. |
| `prepared` | Manifest built and validated; ZERO broker mutations. |
| `admitted` | Matching broker task admission evidence (create response OR verified readback). NOT proof of execution start, success, or merge. |
| `admission_unconfirmed` | Ambiguous: accepted-unconfirmed with failed/absent readback, or unverifiable existing record. Never folded into success. |
| `existing` | Task already existed; field-level match verified when the task exposes comparable fields, otherwise `existing_task_match_unverified`. |
| `failed` | Dispatcher-reported failure after bounded recovery (or spec-conflict fail-closed). |

Receipt fields: `schemaVersion`, `requestId`, `state`, `reasonCodes[]`,
`missingFields[]`, `nextAction{code,detail?}`, `taskIds[]`, `lanes[]`,
`planDigest`, `readiness{source,observedAt,stale,candidatesConsidered,
excluded?,selected?,unknownFields[]}`, `manifest`/`plannedLanes`/
`validationErrors` when applicable, `timeline[]`, `timings{}`,
`journalFile`. `nextAction.code` comes ONLY from the allowlist (`none`,
`provide_missing_fields`, `resolve_worker_readiness`, `retry_prepare`,
`resume_existing_task`, `poll_task_readback`, `verify_admission`,
`new_request_id_required`); error text never becomes a command or a
next-action.

## Readiness collection & compatibility

1. Broker URL and credentials come only from the trusted host context; never
   copied from issues/manifests into receipts or the journal.
2. Live mode: GET `{brokerUrl}/workers` (GET-only; same edge-secret headers as
   the dispatcher). Offline mode: caller-provided snapshot with `observedAt`;
   snapshots older than `ttlMs` (default 300 s) yield `blocked/readiness_expired`.
3. Eligibility: `status: online`, management plane not `disconnected`; analysis
   lanes additionally require `substantiveAnalysisReady` (live view) or a
   passing trusted record; patch lanes REQUIRE a trusted readiness record
   satisfying the #1034/#1597 row contract (canary evidence included) — the
   live view alone NEVER qualifies for patch. "Online" is never substituted
   for "can implement".
4. Deterministic selection: `workerPolicy.preferredWorkers` order, then
   stable lexicographic worker id. Rationale recorded. Failure-rate/latency
   telemetry is advisory and is NOT a selection input. No candidate →
   `blocked/no_eligible_worker` with per-worker exclusion reasons.
5. Unknown values stay `unknown`; the patch observation carries an explicit
   `unknownFields[]` list naming every gate field the live API does not carry.
6. Cache ≠ reservation: broker admission/claim checks remain the only
   admission authority. A fresh live read precedes every submit.

Lane templates and defaults are versioned in code
(`laneTemplateVersion: 1`); contract compatibility with the dispatcher is
structural — the SAME `validateManifest` gates every submission, so
unverifiable version drift fails closed at validation instead of guessing
flags. The entrypoint never sets `allowUnverifiedPatchWorkers` or any
readiness override.

## Submit, idempotency, recovery (invariants)

1. Journal-first: requestId, deterministic lane ids (`assign-<requestId>:N`),
   spec digest, broker URL and requester are recorded (0600 file, 0700 dir,
   tmp+rename atomic write with fsync, symlink-rejected) BEFORE the first POST.
2. Same requestId + different `planDigest` (canonical semantic spec: kind,
   objective, requestRef, target, lanes, budget, preferredWorkers) →
   `failed/request_spec_conflict`, next action `new_request_id_required`.
   Never overwritten.
3. Timeouts/lost responses are never failures: exact-ID readback first; the
   bounded retry (network/429 only, default 1 retry, `Retry-After` honored up
   to 5 s) fires only after a readback proves the task was NOT created.
4. Auth/schema/4xx failures never retry (`submit_failed_no_retry`).
5. Concurrent submits serialize on a per-request lock file; a second caller
   gets `blocked/submit_in_progress` with ZERO POSTs. Crashed-holder locks
   expire after 30 s. Crash-recovery: a journaled request without task ids
   resumes with the SAME lane ids; task ids are never re-minted.
6. `accepted-unconfirmed` stays distinct: readback-confirmed → `admitted`
   (reason `durable_ack_unconfirmed_confirmed_via_readback`); unreachable →
   `admission_unconfirmed` with receipt retained.
7. Default single lane; caller-supplied multi-lane keeps per-lane states and
   never re-submits admitted lanes on resume. No cross-broker atomicity.
8. Journal/receipts are owner-only state; receipts deep-strip secret-shaped
   keys and sanitize all error detail (control chars stripped, length-capped,
   secret-redacted). Public diagnostics carry states/reasons/timestamps only.

## Instrumentation (S1 extension)

Timeline events: `requestReceived` (host clock; recorded `missing` when
absent — never replaced by tool start), `intentReady`, `toolEntered`,
`readinessReady`, `manifestValidated`, `firstSubmit`, `admissionConfirmed`,
`workerStarted` (ONLY from an observed broker task status: claimed/running/
started/active; never substituted). `timings` reports request→firstSubmit,
tool→readiness, tool→manifestValidated, firstSubmit→admission (null when an
endpoint event is missing). Aggregate p50/p95 reporting across requests is a
later aggregation-layer slice; the receipt timeline is its input.

## Verification summary (what this slice proves)

- Complete analysis and patch requests: one-call prepare→submit, mock-broker
  in-process integration (no live broker).
- Batched missing fields; read-only vs write-capable conflicts; unauthorized
  submit with zero POSTs.
- Expired/missing snapshots, zero candidates, patch-record gating
  (`patch_readiness_record_missing` / `_ineligible`), canary-missing fixture.
- Lost-response recovery via readback; 429 + Retry-After bounded retry;
  retry-budget exhaustion; auth no-retry; broker read failure blocks pre-POST.
- Same-ID/different-spec conflict; concurrent-submit lock; crash-before-POST
  resume; terminal-ID reuse without duplicate tasks; offline prepare zero
  network; live prepare GET-only; hostile error-text injection and secret
  non-leak.

## Acceptance criteria

- [x] Spec/plan/tasks exist and match the implementation (same PR).
- [x] Library facade implements prepare/submit/resume with the contracts above.
- [x] Regression suite passes; dispatcher suite unaffected (additive field only).
- [x] Script budget stays flat; no new npm scripts; manifest-coverage gate updated.
- [x] agent manual updated in the same PR.
- [ ] Phase C: host/skill wiring PR + limited live pilot (separate approval,
      separate evidence; NOT part of this slice's done-ness).
