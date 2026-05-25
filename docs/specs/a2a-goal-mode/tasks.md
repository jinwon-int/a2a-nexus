# Tasks: A2A Goal Mode — Persistent Objective Execution

## Preconditions

- [x] Feature spec is linked and accepted for design work.
- [x] Implementation plan is linked and accepted for design work.
- [x] Size classification is recorded: Medium for design-only PR.
- [x] Approval-sensitive actions are explicitly out of scope.
- [x] Broker of record / finalizer is identified: Seoseo.

## Design tasks

- [ ] Write the Goal Mode feature spec (`docs/specs/a2a-goal-mode/spec.md`).
- [ ] Write the implementation plan (`docs/specs/a2a-goal-mode/plan.md`).
- [ ] Write this task list (`docs/specs/a2a-goal-mode/tasks.md`).
- [ ] Write the Goal Mode lifecycle contract (`contracts/a2a/goal-mode-lifecycle.md`):
  - [ ] Durable goal object schema documentation.
  - [ ] Lifecycle states and allowed transitions.
  - [ ] Approval gate types and surfacing mechanism.
  - [ ] Planner loop contract.
  - [ ] Idempotency and resume behavior.
  - [ ] Worker evidence format for goal slices.
- [ ] Write the goal object JSON schema (`docs/specs/a2a-goal-mode/schema.json`).
- [ ] Write the goal object fixture (`fixtures/contract/a2a-goal-mode.json`).
- [ ] Run local validation.
- [ ] Open PR and link #442.

## Evidence checklist

- [ ] PR URL.
- [ ] Changed files list.
- [ ] `git diff --check` result.
- [ ] `npm run check:layout` result.
- [ ] `npm run test:release-gate` result.
- [ ] JSON schema parse validation.
- [ ] JSON fixture parse validation.
- [ ] GitHub Actions check result.
- [ ] Safety boundary statement.

## Future runtime tasks (not this PR)

- [ ] Define broker-side goal state machine (create, plan, dispatch, collect, re-plan, complete).
- [ ] Implement planner loop as a deterministic script/command.
- [ ] Add goal status endpoint or CLI command.
- [ ] Integrate worker evidence routing to goal-level aggregator.
- [ ] Add idempotent goal creation and replay detection.
- [ ] Add approval-gate detection and pause/resume.
- [ ] Add goal event log for auditing.
- [ ] Validate with dry-run before any live automation.

## Final closeout checklist

- [ ] Exactly one finalizer made the closeout decision.
- [ ] Evidence supports the decision.
- [ ] Follow-up issues are linked.
- [ ] Wiki/runbook update is linked or explicitly not needed.
- [ ] No unapproved deploy/restart/canary/DB/ACK/replay/release/secret action occurred.
