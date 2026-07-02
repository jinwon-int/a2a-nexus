# Quality Checklist: <name>

Use this before implementation starts and again before closeout. It validates that the spec-first packet is complete enough to execute safely.

## Packet links

- Spec:
- Clarify notes, if any:
- Plan:
- Tasks:
- Analysis notes:
- Evidence packet / final closeout:

## Pre-implementation checklist

- [ ] Size classification is recorded.
- [ ] Spec exists for Medium/Large work.
- [ ] Plan exists for Medium/Large work.
- [ ] Tasks exist for Large work.
- [ ] Required clarifications are resolved or explicitly blocked.
- [ ] Approval-sensitive actions are excluded or separately approved.
- [ ] Broker of record/finalizer is named.
- [ ] Execution lane is appropriate for the size and risk.
- [ ] Tests/validation commands are named.
- [ ] New gates/scanners have a red-to-green evidence plan.
- [ ] Cleanup/removal work has a discovery inventory plan.
- [ ] Oracle-producing lanes are separated from implementation validation, or finalizer coverage review is named.
- [ ] Multi-stage follow-ups are materialized before closeout.
- [ ] Lane-to-PR slicing is recorded, or consolidation approval is required.
- [ ] Rollback/failure handling is documented.

## Pre-merge / closeout checklist

- [ ] Changed files/repos are listed.
- [ ] Focused validation passed or blockers are documented.
- [ ] Broader validation/CI passed or blockers are documented.
- [ ] Evidence packet is sufficient for finalizer judgment.
- [ ] Issue checklist items were compared 1:1 against artifacts before closeout.
- [ ] No bulk closeout occurred without finalizer-written issue-by-issue disposition.
- [ ] Approval-sensitive actions not performed are named.
- [ ] Wiki/runbook update is linked or explicitly not needed.
- [ ] Remaining follow-up issues are linked.
- [ ] Exactly one finalizer made the closeout decision.

## NO-GO conditions

Mark NO-GO if any are true and not explicitly approved/resolved:

- [ ] Secrets/private data appear in logs, fixtures, docs, issues, PRs, or evidence.
- [ ] Deploy/restart/live canary/DB mutation/ACK replay/release is implied but not approved.
- [ ] Broker foreground session is expected to carry heavy closeout work.
- [ ] Worker isolation is unclear for execution changes.
- [ ] Evidence is insufficient to verify the result.
- [ ] Ownership/finalizer is ambiguous.

## Outcome

- [ ] GO for implementation.
- [ ] GO for merge/source closeout.
- [ ] NEEDS OPERATOR DECISION.
- [ ] NO-GO.

Decision summary:
