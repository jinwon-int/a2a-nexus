# Tasks: JEV Review-Evidence Shadow (C3 receipt/projection + C4 intake review sufficiency)

## Preconditions

- [x] Baseline `main@a66b8b60` checked out, clean;
      `docs/specs/jev-review-evidence-shadow/` confirmed absent before this
      slice.
- [x] Template trio read for mirroring
      (`docs/specs/jev-probe-gating/`).
- [x] A2AD provenance recorded: the 2026-09-20 source-only utilization round
      on the fleet's originating broker; task ids `jev-utilization-boundaries`,
      `jev-utilization-opportunity-map-r1c`,
      `jev-utilization-opportunity-map-r1b` (lane-to-worker mapping is private
      fleet data, not reproduced here).
- [x] Line cites verified on `main@a66b8b60` (`a2a-task-handler.mjs`
      `:784-801`, `:832-885`, `:888-915`, `:1115-1153`, `:1391-1425`,
      `:1631-1647`, `:2754-2825`, `:2886-2918`, `:2942-2976`).
- [x] Approval-sensitive actions out of scope: no live jev call, no
      deploy/restart, no key material or endpoint values anywhere in the
      repo, no task-body transmission design.

## Phase A — spec (this step)

- [x] `spec.md` — two shadow points (C3/C4), typed question drafts, env
      contract, behavior contract, invariants, acceptance criteria.
- [x] `plan.md` — baseline, decisions, gate items G1–G4, phases, risks,
      explicitly-NOT-done list.
- [x] `tasks.md` (this file).
- [x] All three verified on disk after the write.

## Gate items (separately approved slices; NOT authorized by this packet)

- [ ] **G1** — facade typed-verdict contract extension
      (`lib/jev-classifier.mjs`): Noul/Choice/Score + confidence in-process;
      boolean `is_real_work` preserved for probe-gating.
- [ ] **G2** — owner transmission/privacy decision: closed banded fields
      confirmed; task-body/source-content transmission rejected or a
      specific redaction scheme approved.
- [ ] **G3** — #2185 arms A/B/C results + 2026-09-26 calibration review
      consumed as external evidence.
- [ ] **G4** — fail-open hook-shape fix for the existing probe hook
      (exception isolation from the CLI outcome path; stdout ordering).

## Wiring phases (each requires G1+G2+G4 and its own approval)

- [ ] **Phase C** — C3 receipt shadow: hook after projection-failure
      details, before bridge spawn; telemetry-only typed record;
      byte-identical outputs; golden gate-off identity test; stub-transport
      tests; 3-site registration for any new support module.
- [ ] **Phase D** — C4 review-sufficiency shadow: hook immediately before
      `reviewValidationFromAnalysis`; same posture and test pattern.
- [ ] **Phase E** — offline calibration join (out of runtime): shadow
      records into the calibration corpus protocol; any threshold returns as
      a separately approved default-off gate item.

## Explicitly NOT done (re-asserted every review)

- [ ] No re-routing or proceed automation from any jev verdict.
- [ ] No runtime read of shadow verdicts by any gate.
- [ ] No `handleTask` synchronicity change; no network inside `handleTask`.
- [ ] No worker-process egress (approach B).
- [ ] No new response fields; no probe-ack 6-key contract change.
- [ ] No task-body or source-content transmission without G2.
- [ ] No thresholds, no enforcement, no activation without separate approval.
- [ ] No key material or endpoint values in docs, code, logs, or fixtures.
