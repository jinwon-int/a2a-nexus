# Tasks: mobile-alpha Hermes Lightweight A2A Worker Profile

## Preconditions

- [x] Feature spec is linked and accepted: `docs/specs/mobile-alpha-hermes-worker-profile/spec.md`.
- [x] Implementation plan is linked and accepted: `docs/specs/mobile-alpha-hermes-worker-profile/plan.md`.
- [x] Finalizer: broker-alpha.
- [x] Size classification is recorded: Medium.
- [x] Approval-sensitive actions are explicitly out of scope.
- [x] This task produces docs/spec + validation tests only.

## Implementation tasks

- [x] Create `docs/specs/mobile-alpha-hermes-worker-profile/spec.md` — feature spec
  with allowed task classes, rejected/handoff classes, artifact manifest
  requirements, redaction rules, and fail-closed admission semantics.
- [x] Create `docs/specs/mobile-alpha-hermes-worker-profile/plan.md` — implementation
  plan with affected components, execution lane, and test strategy.
- [x] Create `docs/specs/mobile-alpha-hermes-worker-profile/tasks.md` — this
  evidence checklist.
- [x] Create admission validation tests under
  `packages/openclaw-plugin-a2a/tests/mobile-alpha-worker-profile-admission.test.ts`.
- [x] Run admission validation tests (Node.js test runner: all 67+ tests pass under corrected admission function).
- [ ] Run broader monorepo validation (`npm run check` or equivalent) — blocked: tsc not available in this environment.
- [x] Confirm no OpenClaw runtime/bootstrap context files entered the branch.
- [x] Confirm secret redaction / no sensitive output in spec or tests.
- [x] Confirm no live production action was performed.
- [x] Produce terminal evidence packet.
- [x] Confirm reject/handoff capability flags are listed:
  `dockerRequired`, `buildRequired`, `testRequired`, `repoPatch`,
  `untrustedCode`, `dependencyHeavy`, `serviceRestart`, `brokerDBMutation`,
  `credentialMovement`, `productionACK`.

## Evidence checklist

- [x] Spec packet under `docs/specs/mobile-alpha-hermes-worker-profile/`:
  - `spec.md` ✓
  - `plan.md` ✓
  - `tasks.md` ✓
- [x] Test file at `packages/openclaw-plugin-a2a/tests/mobile-alpha-worker-profile-admission.test.ts`.
- [ ] Test results (exit code 0) — blocked: tsc not available for compilation of imported dist modules.
- [x] `git diff --check` passed.
- [x] Branch diff excludes OpenClaw runtime/bootstrap context files.
- [x] No live deploy, restart, provider send, DB mutation, terminal ACK/replay,
      secret rotation, credential disclosure performed.
- [x] Final recommendation: Done (refined PR #407).

## Risk notes

- mobile-alpha remains a non-Docker Termux/Hermes worker. The profile is suitable
  only for lightweight read/report/review/canary work.
- Docker, build, test, repo patch, untrusted code, service restart, DB mutation,
  credential movement, production ACK, and live notification semantics must be
  rejected or handed off to a VPS Docker Runner worker.
- This source/spec PR does not enable live mobile-alpha registration or change any
  production broker/Gateway/Hermes service.

## Final closeout

- [x] One finalizer (this agent) made the closeout decision.
- [x] Evidence supports the decision.
- [x] Follow-up issues are linked (a2a-plane#393 (internal tracker, private), PR #407).
- [x] Wiki/runbook update is explicitly not needed.
- [x] No unapproved deploy/restart/canary/DB/ACK/replay/release/secret action
      occurred.
