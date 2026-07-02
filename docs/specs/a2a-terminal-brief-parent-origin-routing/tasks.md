# Tasks: A2A Terminal Brief parent-origin routing contract

## Preconditions

- [x] Feature spec is linked and accepted for trial use.
- [x] Implementation plan is linked and accepted for trial use.
- [x] Size classification is recorded: Large.
- [x] Approval-sensitive actions are out of scope for source PRs.
- [x] Broker of record / finalizer is identified: broker-beta unless explicitly handed off.

## Task group 0 — spec-first trial in `a2a-plane`

- [ ] Add `spec.md`, `plan.md`, and `tasks.md` for `a2a-broker#634`.
- [ ] Run docs/release-gate validation.
- [ ] Open PR and link it to `a2a-broker#634` and `a2a-plane#315`.
- [ ] Do not change runtime behavior.

Evidence required:

- PR URL;
- validation commands/results;
- changed file list;
- safety boundary statement.

## Task group 1 — `a2a-plane` contract/fixture/release gate

- [ ] Add or update a machine-readable four-case routing fixture.
- [ ] Update `contracts/a2a/parent-terminal-brief-aggregation.md` if needed.
- [ ] Update `contracts/a2a/broker-handoff-protocol.md` if needed.
- [ ] Add conformance/release-gate coverage for all four cases.
- [ ] Ensure parentless projection remains fail-closed in contract language.
- [ ] Run `npm run test:release-gate`.

Evidence required:

- PR URL;
- fixture path;
- contract paths;
- test command/result;
- CI result.

## Task group 2 — `a2a-broker` implementation/tests

- [ ] Add a routing helper or normalized contract equivalent for the four cases.
- [ ] Normalize team/scope fields: Team1-only, Team2-only, Team1+Team2.
- [ ] Normalize parent/origin broker and handoff broker fields.
- [ ] Preserve parent existence guard and `missing_parent` behavior.
- [ ] Ensure Team2-only cannot route through broker-alpha.
- [ ] Ensure Team1-only cannot route through broker-beta.
- [ ] Add broker tests for all four cases.
- [ ] Run focused tests.
- [ ] Run full `npm test`.

Evidence required:

- PR URL;
- changed functions/files;
- focused test command/result;
- full test result;
- CI result;
- compatibility notes for persisted rows or legacy field names.

## Task group 3 — `openclaw-plugin-a2a` relay/notification implementation/tests

- [ ] Ensure relay projection builder emits unambiguous parent/origin and handoff broker fields.
- [ ] Include parent round total/order in projections.
- [ ] Add relay-success duplicate suppression test.
- [ ] Preserve relay-failure local fallback test.
- [ ] Ensure synthetic parent-side projection rows do not relay back to child.
- [ ] Run focused tests.
- [ ] Run full `npm test`.

Evidence required:

- PR URL;
- changed functions/files;
- focused test command/result;
- full test result;
- CI result;
- monitor/readiness field notes if changed.

## Task group 4 — merge rehearsal and closeout

- [ ] Confirm all PRs are green and mergeable.
- [ ] Decide merge order.
- [ ] Rehearse conflict-sensitive merges if needed.
- [ ] Merge source PRs only when safe.
- [ ] Comment final source closeout on `a2a-broker#634`.
- [ ] Keep `a2a-plane#315` open until one real medium/large workflow trial is evaluated.

Evidence required:

- PR merge commits;
- CI/check summaries;
- any merge rehearsal logs;
- final issue comment URL.

## Task group 5 — separately approved runtime gate

Do not start this group without fresh explicit approval.

- [ ] Deploy source changes to relevant runtime checkouts.
- [ ] Restart Gateway/broker/worker if required.
- [ ] Run bounded local-only Terminal Brief canary if needed.
- [ ] Run bounded cross-team parent-seeded canary in both directions if needed:
  - broker-alpha parent + broker-beta child;
  - broker-beta parent + broker-alpha child.
- [ ] Cleanup relay windows, cursors, and allowlists.
- [ ] Report GO/NO-GO.

Evidence required:

- approval record;
- runtime revisions;
- Gateway/broker readiness;
- canary task IDs;
- outbox/projection states;
- cleanup confirmation.

## Final closeout checklist

- [ ] Exactly one finalizer made the closeout decision.
- [ ] Evidence supports the decision.
- [ ] Follow-up issues are linked.
- [ ] Wiki/runbook update is linked or explicitly not needed.
- [ ] No unapproved deploy/restart/canary/DB/ACK/replay/release/secret action occurred.
