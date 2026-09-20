# Feature Spec: JEV Review-Evidence Shadow (receipt/projection C3 + intake review sufficiency C4)

> **Status**: spec-first observation design. This document authorizes no live
> jev call, no deploy, no restart, and no fleet rollout. It adds no runtime
> code, no scripts, no dependency, and enables no lane or flag. Endpoint
> values and key material are NEVER stored in these docs or the repo.
>
> Provenance: A2AD source-only utilization round dispatched 2026-09-20 on the
> fleet's originating broker (three lanes: boundaries — succeeded;
> opportunity — succeeded; opportunity retry — partial; task ids
> `jev-utilization-boundaries`, `jev-utilization-opportunity-map-r1c`,
> `jev-utilization-opportunity-map-r1b`). Lane-to-worker mapping is private
> fleet operating data and is intentionally not reproduced here. Baseline: main @
> `a66b8b60`. All `a2a-task-handler.mjs` line cites verified against that
> revision.

## Problem

The broker's evidence-quality decisions are deterministic today, which is the
correct ownership split — but two of them are exactly where a small typed
judge could surface a *second opinion* worth recording offline:

1. **Receipt / source-projection verification (A2AD candidate C3).** The
   handler records payload and detached source carriers
   (`a2a-task-handler.mjs:1115-1153`), hands carrier paths to the bridge
   (`:1391-1425`), and blocks on zero-file / insufficient projection
   (`:888-915`, `:1631-1647`). A truncated source read as complete evidence —
   or a complete source misread as missing — is currently invisible as a
   graded signal.
2. **Intake review evidence sufficiency (A2AD candidate C4).** The
   review-required flow (`:784-801`) and
   `reviewValidationFromAnalysis` (`:832-885`, combined into results at
   `:2754-2825`) accept or reject review verdicts without any graded measure
   of whether the attached evidence actually supports the verdict.

Both points already fail closed deterministically. The proposal is *not* to
replace that: it is to observe a typed second opinion in-process, default-off,
and record it for offline calibration — the same posture as the landed
probe-gating slice (`docs/specs/jev-probe-gating/`), extended from boolean
`is_real_work` to typed verdicts.

## Prior A2AD findings this packet must honor

From the boundaries lane:

- The CLI entry currently awaits `observeJevForOutcome` inside the same
  try/catch that produces the generic ack, and before the stdout write
  (`a2a-task-handler.mjs:2942-2976`) — a structural fail-open risk (exception
  escalation; ack loss inside the timeout window) that any new shadow hook
  must not replicate. Fixing the existing hook is gate item **G4** (separate
  slice) and preconditions new hooks.
- No Jev verdict may gate claims, retries, finalization, merges, or routing.
- Task-body transmission to an external judge is owner-pending; shadow inputs
  must be closed, banded fields only.
- The current facade (`packages/broker/scripts/lib/jev-classifier.mjs`)
  accepts only a boolean `is_real_work` verdict — typed Noul/Choice/Score
  questions require a facade contract extension (gate item **G1**).

From the opportunity lane (first attempt): C3 and C4 ranked first and second of
eight candidates; both are *new review/evidence surfaces*, unrelated to
probe-gating re-routing; both must start shadow-first with deterministic
gates keeping final authority.

## Goal

- Opt-in, env-gated **shadow-only** Jev observation at two async-safe points:
  - **C3 receipt shadow** — after projection-failure details are computed and
    before bridge spawn: graded `receipt_state` observation of whether the
    projected source set is sufficient for the task's evidence needs.
  - **C4 review-sufficiency shadow** — immediately before
    `reviewValidationFromAnalysis` combines a review verdict: graded
    observation of whether the verdict is supported by the attached evidence.
- Typed questions, composed in code, one parallel request over a shared
  judgment-time state; every question is independent:
  - C3: Choice `receipt_state` (complete / partial / unreadable /
    insufficient_information / defer) + Noul `p_source_sufficient` + Score
    `receipt_fidelity`.
  - C4: Choice `review_disposition` (pass / fail / defer) + Noul
    `p_verdict_supported` + Score `review_evidence_quality`.
- Observed in-process only (telemetry record), never returned in any response
  field, never read by any gate, and output byte-identical to gate-off in
  every mode.
- Inputs are closed, banded judgment-time fields only — never the task body,
  prompt, payload text, or source file contents.

## Non-goals

- No runtime authority: shadow verdicts never gate claims, retries,
  finalization, merges, dispatch, or routing (calibration spec contract 4).
- No facade modification in this packet: the typed-verdict facade extension
  is separately approved gate item **G1**. This packet consumes G1's contract.
- No task-body or source-content transmission (owner privacy decision is gate
  item **G2**); no worker-process egress (approach B stays rejected); no new
  CLI command, npm script, top-level script, or dependency (script budget
  stays flat; `scripts/lib/` is not counted).
- No thresholds in code; no accuracy or benchmark claims (#2185 arms A/B/C and
  the 2026-09-26 calibration review own measurement).
- No changes to the probe-gating slice's behavior or its 6-key contract.
- No retry, no backoff, no queueing, no multi-provider routing.

## Reuse contract (decided)

| Asset | Role in this slice |
| --- | --- |
| `lib/jev-classifier.mjs` facade | Extended by G1 to accept typed verdicts; this slice consumes the extended contract read-only. |
| `worker-artifact-rollout-guard` mechanism | 3-site registration for any new handler-imported lib (guard list + Dockerfile handlers/ per-file cp + guard-test fixture). |
| `a2a-task-handler.test.mjs` pattern | `node --test`, stub transport, no network, synthetic fixtures, golden gate-off byte-identity. |
| `docs/specs/jev-recommendation-calibration/` | Probability vs confidenceBand separation, defer semantics, corpus/holdout discipline for any future threshold work. |

## Environment contract

| Variable | Required | Default | Behavior |
|---|---|---|---|
| `A2A_JEV_RECEIPT_SHADOW` | gate (C3) | unset | Same disable tokens as `A2A_JEV_CLASSIFY`. |
| `A2A_JEV_REVIEW_SHADOW` | gate (C4) | unset | Same disable tokens as `A2A_JEV_CLASSIFY`. |
| `A2A_JEV_ENDPOINT` | yes when enabled | — | Shared trio semantics with probe-gating. |
| `A2A_JEV_KEYFILE` | yes when enabled | — | 0600-class keyfile, read at call time. |
| `A2A_JEV_TIMEOUT_MS` | no | 1500 | Clamped [250, 5000]. |
| `A2A_JEV_MODEL` | no | — | Passthrough. |

Enabling either shadow requires the valid trio plus the G1 facade contract
present; invalid configuration → shadow disabled with one deterministic,
value-free stderr line, output byte-identical to gate-off.

## Behavior contract

1. `handleTask` stays fully synchronous; no network inside it. Shadow hooks
   run only at the existing async CLI entry boundary, after the outcome is
   fully computed and after the stdout write is *scheduled but not yet
   flushed by the hook itself* — the hook must never sit between outcome
   computation and output emission (G4 fixes this ordering for the existing
   hook; new hooks inherit the fixed shape).
2. Each enabled shadow point makes exactly one jev attempt per qualifying
   task, bounded by the clamped timeout. A failure never retries.
3. Typed verdicts are accepted only when they parse as the G1 contract
   (per-question Noul/Choice/Score with confidence where applicable). Valid
   verdicts are recorded in-process (telemetry record only). Any other
   outcome → deterministic fallback: output byte-identical to gate-off.
4. Deterministic gates (`projectionFailureDetails`, review-required
   acceptance, write-set/rollout guards) are never consulted by, and never
   consult, the shadow.
5. The shadow never blocks: nothing waits on jev beyond the clamped timeout,
   and no outcome loss is possible from a shadow timeout (G4-fixed hook
   shape).

## Invariants

- Gate-off and invalid-config behavior is byte-identical to current behavior
  (golden test).
- Deterministic gates keep final authority; a shadow verdict is telemetry.
- The key exists only in the 0600 keyfile; never in env dumps, logs, error
  text, diffs, or fixtures. `credentialFree`/`hostNeutral` BUILD_INFO flags
  stay true.
- Inputs to the judge are closed banded fields (request class, mode, source
  carrier counts/bytes, projection quality, review verdict label, artifact
  presence) — no free text, no task body, no paths.
- `defer` is never derived from low confidence; probability and
  confidenceBand stay separate fields (calibration contract 2–3).
- Every handler-imported lib introduced here is registered at all three
  sites.
- No internal fleet node names in any committed fixture.

## Acceptance criteria

- [ ] Spec/plan/tasks exist on the branch and match any implementation.
- [ ] G1–G4 tracked as separate approved items before any wiring phase starts.
- [ ] Gates unset → byte-identical output (golden tests green).
- [ ] Enabled + valid typed verdict → observed in-process only; output
      unchanged; no response-field change.
- [ ] Enabled + any jev failure → fallback; exactly one attempt per point.
- [ ] Deterministic gates unaffected (projection failures still block;
      review-required flow unchanged).
- [ ] Registration guard green with fixtures updated; no network in tests.
- [ ] Diff audit: no key material, no endpoint values, no task-body handling,
      script budget flat.
