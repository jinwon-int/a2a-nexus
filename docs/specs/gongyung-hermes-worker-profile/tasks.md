# Tasks: Gongyung Hermes Lightweight A2A Worker Profile

## Preconditions

- [x] Feature spec is linked and accepted: `docs/specs/gongyung-hermes-worker-profile/spec.md`.
- [x] Implementation plan is linked and accepted: `docs/specs/gongyung-hermes-worker-profile/plan.md`.
- [x] Size classification is recorded: Medium.
- [x] Approval-sensitive actions are explicitly out of scope.
- [x] This task produces docs/spec + validation tests only.

## Implementation tasks

- [x] Create `docs/specs/gongyung-hermes-worker-profile/spec.md` — feature spec
  with allowed task classes, rejected/handoff classes, artifact manifest
  requirements, redaction rules, and fail-closed admission semantics.
- [x] Create `docs/specs/gongyung-hermes-worker-profile/plan.md` — implementation
  plan with affected components, execution lane, and test strategy.
- [x] Create `docs/specs/gongyung-hermes-worker-profile/tasks.md` — this
  evidence checklist.
- [x] Create admission validation tests under
  `packages/openclaw-plugin-a2a/tests/gongyung-worker-profile-admission.test.ts`.
- [ ] Run admission validation tests.
- [ ] Run broader monorepo validation (`npm run check` or equivalent).
- [ ] Confirm no OpenClaw runtime/bootstrap context files entered the branch.
- [ ] Confirm secret redaction / no sensitive output in spec or tests.
- [ ] Confirm no live production action was performed.
- [ ] Produce terminal evidence packet.

## Evidence checklist

- [x] Spec packet under `docs/specs/gongyung-hermes-worker-profile/`:
  - `spec.md` ✓
  - `plan.md` ✓
  - `tasks.md` ✓
- [x] Test file at `packages/openclaw-plugin-a2a/tests/gongyung-worker-profile-admission.test.ts`.
- [ ] Test results (exit code 0).
- [ ] `git diff --check` passed.
- [ ] Branch diff excludes OpenClaw runtime/bootstrap context files.
- [ ] No live deploy, restart, provider send, DB mutation, terminal ACK/replay,
      secret rotation, credential disclosure performed.
- [ ] Final recommendation: Done (or Block, with reason).

## Final closeout

- [ ] One finalizer (this agent) made the closeout decision.
- [ ] Evidence supports the decision.
- [ ] Follow-up issues are linked.
- [ ] Wiki/runbook update is explicitly not needed.
- [ ] No unapproved deploy/restart/canary/DB/ACK/replay/release/secret action
      occurred.
