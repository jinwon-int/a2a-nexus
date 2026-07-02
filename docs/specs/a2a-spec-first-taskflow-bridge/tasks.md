# Tasks: A2A Spec-First TaskFlow Bridge

## Preconditions

- [x] Feature spec is linked and accepted for design work.
- [x] Implementation plan is linked and accepted for design work.
- [x] Size classification is recorded: Medium for design-only PR.
- [x] Approval-sensitive actions are explicitly out of scope.
- [x] Broker of record / finalizer is identified: broker-beta.

## Design tasks

- [ ] Add TaskFlow bridge design doc.
- [ ] Document state schema.
- [ ] Document lifecycle states and transitions.
- [ ] Document child evidence task linkage.
- [ ] Document approval waits and blocked states.
- [ ] Document finalizer closeout rules.
- [ ] Add example mapping from Terminal Brief #634.
- [ ] Add optional fixture/example state packet.
- [ ] Run local validation.
- [ ] Open PR and link #322/#315.

## Evidence checklist

- [ ] PR URL.
- [ ] Changed files list.
- [ ] `git diff --check` result.
- [ ] `npm run check:layout` result.
- [ ] `npm run test:release-gate` result.
- [ ] GitHub Actions check result.
- [ ] Safety boundary statement.

## Future runtime tasks (not this PR)

- [ ] Decide implementation repo/component.
- [ ] Define TaskFlow API binding layer.
- [ ] Implement managed flow creation from a spec-first packet.
- [ ] Link child subagents/A2A evidence workers via TaskFlow child tasks.
- [ ] Add approval wait handling.
- [ ] Add closeout summary generation.
- [ ] Validate with dry-run only before any runtime activation.

## Final closeout checklist

- [ ] Exactly one finalizer made the closeout decision.
- [ ] Evidence supports the decision.
- [ ] Follow-up issues are linked.
- [ ] Wiki/runbook update is linked or explicitly not needed.
- [ ] No unapproved deploy/restart/canary/DB/ACK/replay/release/secret action occurred.
