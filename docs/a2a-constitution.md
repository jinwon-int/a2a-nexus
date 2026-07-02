# A2A Constitution

This constitution is the lightweight safety and operating baseline for A2A Nexus development. It is intentionally a thin governance layer: it does not replace the broker/worker runtime, but it must shape specs, plans, tasks, reviews, and closeout evidence for medium and large A2A changes.

## Principles

### 1. Secrets and private runtime data never enter shared artifacts

Do not write API keys, OAuth tokens, edge secrets, bot tokens, private keys, private hostnames, raw session dumps, provider identifiers, Telegram IDs, or production data into logs, Wiki pages, PR bodies, issue comments, fixtures, or generated evidence.

When a credential or private location matters, document only a safe handling rule such as “check the node-local config” or “rotate via the approved operator path.”

### 2. Broker foreground sessions stay responsive

Broker Telegram/DM sessions are for brief start reports, approval requests, progress checkpoints, and final summaries. They are not the place for long CI review, multi-repo merge rehearsal, heavy evidence collection, or repeated polling.

Medium and large A2A work should be detached into isolated subagents, broker-owned TaskFlow, deterministic scripts, or A2A evidence workers.

### 3. Workers are isolated evidence producers

Workers perform focused implementation, validation, documentation, or evidence collection tasks. They should submit evidence packets and blockers, not independently make final closeout decisions unless explicitly assigned.

Worker execution must not mutate shared workspaces unexpectedly, delete host state, move secrets, or assume production access.

### 4. One broker/finalizer owns judgment

Every A2A round must have exactly one broker of record / finalizer. The finalizer decides merge, defer, supersede, close, or request approval based on evidence.

Cross-broker or cross-team work must preserve ownership: the initiating broker owns the parent round and operator-facing closeout unless an explicit handoff changes that owner.

### 5. Approval boundaries are explicit

The following actions require fresh explicit operator approval for the specific workstream:

- production deploy;
- Gateway, broker, worker, or service restart;
- live canary or provider/Telegram send beyond normal reply delivery;
- DB mutation, prune, migration, or historical replay;
- manual Terminal Brief ACK/replay;
- release/tag publish;
- secret rotation, credential movement, or visibility change;
- force push/history rewrite.

A spec, plan, or task list must say whether any of these are out of scope or require later approval.

### 6. Evidence is required for closeout

No medium or large A2A change should close without evidence appropriate to its risk:

- changed repos/files;
- tests/build/lint/checks run;
- CI or mergeability state when relevant;
- risk and rollback notes;
- approval-sensitive actions not performed;
- remaining blockers or follow-up issues.

### 7. Verification is separated from implementation

A lane that creates or changes an oracle (scanner, release gate, schema, fixture, checklist, or conformance rule) must not be the only lane that validates completion with that same oracle. Either assign a separate validation/finalizer lane, or require the finalizer to review the oracle coverage against the issue text before accepting the result.

### 8. New gates require red-to-green evidence

For new validation rules, scanners, release-gate entries, or CI wiring, ordinary green CI is not enough. The evidence packet must show that the intended bad fixture or pre-change tree fails before the change and passes after the change. If red evidence is impossible, the finalizer must record why and name the compensating review.

### 9. Discovery-first removal tasks

PII, private identifier, secret, dead-link, and residue cleanup tasks must start with an inventory lane that captures variants and scope before the mutation lane edits files. The finalizer closes against the approved inventory, not against a scanner pattern alone.

### 10. Multi-stage plans are materialized

Warn-to-fail migrations, staged strictness upgrades, mirror follow-ups, and other multi-stage plans must become explicit follow-up issues or tasks before the parent issue closes. A green current-stage gate is not closeout evidence for a later stage.

### 11. Reusable operating knowledge is promoted

If a change creates a durable operating rule, repeated procedure, or safety lesson, record it in the appropriate Wiki/runbook path after validation. Do not leave reusable A2A operating knowledge only in chat or ad-hoc local notes.

## Size classification

### Small

May proceed without a formal spec when all are true:

- one repo or one small config/doc change;
- no deploy/restart/canary/DB mutation/replay/release;
- no merge conflict or cross-worker evidence dependency;
- expected work is short and reversible.

### Medium

Requires `spec.md` and `plan.md` when any is true:

- 2+ files with behavior change;
- CI/log review is required;
- broker/worker contract changes;
- evidence from 2+ workers or components;
- OpenClaw plugin bridge, worker model policy, runner behavior, or operator notification behavior is affected.

### Large

Requires `spec.md`, `plan.md`, `tasks.md`, and a detached execution lane such as TaskFlow or A2A evidence workers when any is true:

- 2+ repos;
- cross-broker / Team1-Team2 handoff;
- Terminal Brief / evidence-ledger / live canary round;
- deploy/restart/release/DB mutation/replay is in scope;
- work must survive restarts or wait on human approval.

## Spec-first workflow

1. Classify the change as Small, Medium, or Large.
2. For Medium/Large, write a feature spec before implementation.
3. Run a clarification pass when the spec is underspecified.
4. Convert the accepted spec into an implementation plan.
5. Run an analysis pass for consistency, coverage, and safety before task execution.
6. Convert the plan into tasks with evidence requirements.
7. Use the quality checklist before implementation and again before closeout.
8. Execute in the smallest safe lane.
9. Close out with evidence, safety boundary confirmation, and Wiki/runbook follow-up when reusable.

## References

- GitHub Spec Kit: https://github.com/github/spec-kit
- GitHub Spec Kit documentation: https://github.github.io/spec-kit/
- A2A spec template: `docs/spec-templates/a2a-feature-spec.md`
- A2A plan template: `docs/spec-templates/a2a-plan.md`
- A2A task template: `docs/spec-templates/a2a-tasks.md`
- A2A clarify template: `docs/spec-templates/a2a-clarify.md`
- A2A analyze template: `docs/spec-templates/a2a-analyze.md`
- A2A checklist template: `docs/spec-templates/a2a-checklist.md`
