# Implementation Plan: JEV Review-Evidence Shadow (C3 receipt/projection + C4 intake review sufficiency)

## Baseline

- Branch `feat/jev-review-evidence-shadow` off `main@a66b8b60`; this packet is
  documentation-only at this step.
- `docs/specs/jev-review-evidence-shadow/` confirmed absent on main before
  this slice.
- A2AD provenance: round `a2ad-jev-utilization-r1(-r1b/-r1c)-20260920-nosuk`
  (seoseo broker, 2026-09-20); candidates C3/C4 ranked 1st/2nd of eight by
  the opportunity lane; boundary findings from the boundaries lane are folded
  into the spec's Prior-findings section.
- Line cites verified against `main@a66b8b60`
  (`a2a-task-handler.mjs`): `:784-801`, `:832-885`, `:888-915`,
  `:1115-1153`, `:1391-1425`, `:1631-1647`, `:2754-2825`, `:2886-2918`,
  `:2942-2976`.

## Decisions

- **One packet, two separately gated shadow points.** C3 and C4 share the
  same preconditions (G1 facade contract, G2 privacy decision, G4 fail-open
  hook shape) and the same observation posture, so the spec is authored once;
  each hook point is its own approvable wiring phase and can land (or be
  rejected) independently.
- **Shadow-only, no thresholds in code.** Any future threshold is an offline
  calibration outcome (jev-recommendation-calibration contract), never a
  runtime constant frozen before #2185 arms A/B/C and the 2026-09-26 review.
- **Typed verdicts via G1, not via this packet.** The existing boolean facade
  contract cannot carry Noul/Choice/Score; widening it is a separately
  reviewed contract change. This packet defines the questions and consumes
  the widened contract.
- **No task-body transmission.** Judgment-time inputs are closed banded
  fields (counts, byte bands, labels, quality enums). If the owner later
  approves redacted field transmission, that is a G2 revision, not a default.
- **G4 first for code shape.** The existing probe hook's try/catch + stdout
  ordering risks (boundaries lane RIS1/RIS2) are fixed in a separate slice
  before any new hook is wired; new hooks inherit the fixed shape
  (outcome computed → output emitted → hook runs isolated, never between the
  two).

## Gate items (each separately approved; nothing here authorizes them)

- **G1 — facade typed-verdict contract extension**: Noul/Choice/Score +
  confidence accepted in-process; boolean `is_real_work` stays supported for
  probe-gating. Separate slice + tests + registration.
- **G2 — owner transmission/privacy decision**: confirm closed-banded-field
  inputs and explicitly reject task-body/source-content transmission, or
  approve a specific redaction scheme. Blocks all wiring.
- **G3 — external evidence**: #2185 arms A/B/C comparison results and the
  2026-09-26 calibration review. Blocks any enforcement discussion (this
  packet has none).
- **G4 — fail-open hook shape fix**: isolate `observeJevForOutcome` from the
  CLI outcome path (separate try; stdout write ordering), so ack loss and
  exception escalation are structurally impossible. Preconditions new hooks.

## Phases

### Phase A — spec trio (this step)

1. `docs/specs/jev-review-evidence-shadow/{spec,plan,tasks}.md` authored and
   verified on disk against `main@a66b8b60`.
2. Contract decisions fixed: two gate variables sharing the probe trio
   semantics, typed question drafts (C3 `receipt_state`/`p_source_sufficient`/
   `receipt_fidelity`; C4 `review_disposition`/`p_verdict_supported`/
   `review_evidence_quality`), hook points, invariants, gate items.

### Phase B — G1 facade extension (separate slice, not this packet)

1. Extend `lib/jev-classifier.mjs` to accept typed verdict bundles while
   keeping the boolean contract; unit tests with stub transports; 3-site
   registration for any new support module.

### Phase C — C3 receipt shadow wiring (after G1+G2+G4)

1. Hook after projection-failure-details computation; one attempt; in-process
   telemetry record (timestamp-grain, task id, banded inputs, per-question
   Noul/Choice/Score + confidence); output byte-identical.
2. Golden gate-off identity test; stub-transport tests; registration guard.

### Phase D — C4 review-sufficiency shadow wiring (after G1+G2+G4)

1. Hook immediately before `reviewValidationFromAnalysis`; same posture.
2. Tests mirror Phase C.

### Phase E — offline calibration join (out of runtime)

1. Shadow records join the calibration corpus protocol offline; thresholds,
   if any ever, come back as a separately approved default-off gate item.

### Explicitly NOT done (re-asserted)

- No re-routing, no proceed automation, no runtime read of shadow verdicts.
- No handleTask synchronicity change; no worker-process egress.
- No new response fields; no probe-ack contract change.
- No task-body/source-content transmission without G2.
- No thresholds, no enforcement, no activation without separate approval.

## Risks

- **Key leak history (2 incidents)**: the 0600 keyfile-read-at-call-time
  contract is inherited unchanged; any deviation fails review.
- **Authority creep**: shadow records could be misread as quality signals for
  gating. Mitigation: telemetry-only surface, spec contract 4 language, and
  the calibration packet's authority-separation rule.
- **Egress permission unknown** (probe-gating plan Risk): unchanged here; G2
  is the owner decision point.
- **Budget pressure on worker analysis bridges**: the A2AD round showed large
  single-file bundles can miss projection on some lanes (sogyo #2023 carrier
  gap); wiring slices must include per-worker carrier regression checks
  before enabling any shadow on those lanes.
- **Threshold freezing violation**: measured-in-code thresholds before
  holdout would breach the calibration contract; no thresholds are defined
  here.
