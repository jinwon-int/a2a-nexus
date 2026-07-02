# Tasks: <name>

## Preconditions

- [ ] Feature spec is linked and accepted.
- [ ] Implementation plan is linked and accepted.
- [ ] Size classification is recorded.
- [ ] Approval-sensitive actions are explicitly in scope or out of scope.
- [ ] Broker of record / finalizer is identified.

## Implementation tasks

- [ ] Produce a discovery inventory before cleanup/removal edits.
- [ ] Define independent verification or finalizer oracle-coverage review.
- [ ] Capture red evidence before adding/fixing a gate, scanner, or CI wiring.
- [ ] Materialize later-stage follow-up issues/tasks before parent closeout.
- [ ] Map each implementation lane to one PR, or record finalizer approval for consolidation.
- [ ] Define or update evidence/schema/contract expectations.
- [ ] Implement code/config/docs change.
- [ ] Add or update tests.
- [ ] Run focused validation.
- [ ] Run broader validation appropriate to risk.
- [ ] Confirm secret redaction / no sensitive output.
- [ ] Confirm broker foreground liveness impact is acceptable.
- [ ] Produce worker evidence packet(s).
- [ ] Produce finalizer closeout decision.
- [ ] Update Wiki/runbook if the knowledge is reusable.

## Evidence checklist

For each task, attach:

- [ ] repo/branch/commit or PR link;
- [ ] test/build/lint command and result;
- [ ] CI/check URL or status;
- [ ] risk notes;
- [ ] rollback notes;
- [ ] approval-sensitive actions not performed;
- [ ] blocker or final recommendation.

## Final closeout

- [ ] Exactly one finalizer made the closeout decision.
- [ ] Evidence supports the decision.
- [ ] Follow-up issues are linked.
- [ ] Wiki/runbook update is linked or explicitly not needed.
- [ ] No unapproved deploy/restart/canary/DB/ACK/replay/release/secret action occurred.
