# Tasks: JEV Probe-vs-Real-Work Gating (#2185 arm-C wiring)

## Preconditions

- [x] Baseline `feat/jev-probe-gating@d622d7d` checked out, clean;
      `docs/specs/jev-probe-gating/` confirmed absent before this slice.
- [x] Template trio read for mirroring
      (`docs/specs/task-assignment-entrypoint/`).
- [x] Registration sites pinned (guard L49-54; Dockerfile handlers/ cp
      ~L103-109; guard-test fixture L60-65, asserts L143/L165).
- [x] Unregistered imports enumerated: handler telemetry lib; bridge
      `finalizer-tool-policy.mjs` + `lib/utf8-byte-budget.mjs`.
- [x] Approval-sensitive actions out of scope: no live jev call, no
      deploy/restart, no key material anywhere in the repo.

## Phase A — spec (this step)

- [x] `spec.md` — env contract, approach-A behavior contract, invariants.
- [x] `plan.md` — baseline, decisions (separate prep commit; approach A),
      phases, risks.
- [x] `tasks.md` (this file).
- [x] All three verified on disk after the bash write.

## Phase B — registration-gap prep commit

- [ ] Register `lib/analysis-execution-telemetry.mjs` (guard list + Dockerfile
      handlers/ cp + guard-test fixture).
- [ ] Register `finalizer-tool-policy.mjs` likewise (bridge import).
- [ ] Register `lib/utf8-byte-budget.mjs` likewise (bridge import).
- [ ] Guard test green; prep commit kept separate from jev changes.

## Phase C — classifier lib

- [ ] `packages/broker/scripts/lib/jev-classifier.mjs`: gate parsing (disable
      tokens `''`/`none`/`null`/`undefined`, trimmed + case-insensitive),
      trio validity, timeout default 1500 clamp [250, 5000], model
      passthrough, injectable transport, single attempt.
- [ ] Unit tests (`node --test`, stub transport, no network, synthetic
      fixtures).

## Phase D — CLI-entry hook

- [ ] Hook after generic_ack at the stdin CLI entry (argv == SOURCE_PATH);
      verdict accepted only as boolean-`is_real_work` JSON; otherwise keep
      generic_ack.
- [ ] Golden default-off byte-identity test; gate-on-invalid-config
      stderr-warning test.

## Local validation evidence

- [ ] Registration guard green after `jev-classifier.mjs` registration
      (all three sites).
- [ ] Test manifest aligned (added tests joined into the single big
      `node --test` entry).
- [ ] Root `npm test` green; broker `tsc -b` green.
- [ ] Diff audit: no key/endpoint material; script budget flat; BUILD_INFO
      stays `credentialFree: true` / `hostNeutral: true`.

## Explicitly NOT done here (separate approvals / #2185)

- [ ] Live jev calls against the real endpoint.
- [ ] Accuracy/benchmark claims: #2185 arms A/B/C, leakage-free design,
      Brier scoring.
- [ ] Score-threshold tuning, retry/backoff, routing engines.
- [ ] Approach B (worker-process egress).
- [ ] Deploys/restarts; changes to the probe-ack 6-key shape or response
      fields.
