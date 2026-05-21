# Tasks: Gongyung Hermes Lightweight Worker Profile

## Preconditions

- [x] Feature spec is linked and accepted: `docs/specs/gongyung-hermes-worker-profile/spec.md`.
- [x] Implementation plan is linked and accepted: `docs/specs/gongyung-hermes-worker-profile/plan.md`.
- [x] Size classification is recorded: Small.
- [x] Approval-sensitive actions are explicitly in scope or out of scope: out-of-scope list in spec.md.
- [x] Broker of record / finalizer is identified: Seoseo.

## Implementation tasks

- [x] Create spec packet under `docs/specs/gongyung-hermes-worker-profile/` with `analyze.md`, `plan.md`, `spec.md`, `tasks.md`.
- [x] Document allowed task classes: analyze, research, report, review, hermes-ops, canary.
- [x] Document rejected/handoff task classes with flag names: `dockerRequired`, `buildRequired`, `testRequired`, `repoPatch`, `untrustedCode`, `dependencyHeavy`, `serviceRestart`, `brokerDBMutation`, `credentialMovement`, `productionACK`.
- [x] Document fixed artifact root: `~/.hermes/a2a/artifacts/<task-id>/`.
- [x] Document evidence manifest fields and secret redaction rules.
- [x] Reference prior art: jinwon-int/a2a-plane#384.
- [x] Add admission conformance test at `scripts/check-gongyung-hermes-worker-profile.test.mjs`.
- [x] Run targeted validation.
- [x] Confirm no live Gateway/broker/deploy actions in scope.

## Evidence checklist

For each task, attach:

- [x] repo/branch/commit or PR link;
- [x] test/build/lint command and result;
- [x] CI/check URL or status;
- [x] risk notes;
- [x] rollback notes;
- [x] approval-sensitive actions not performed;
- [x] blocker or final recommendation.

## Risk notes

1. Path correctness: spec packet must live at `docs/specs/gongyung-hermes-worker-profile/` per closeout contract. Any other path will fail the admission test.
2. No source code change: broker/worker/plugin code is not modified, so existing behavior is preserved.
3. No production risk: this is a source-only doc+test change.

## Final closeout

- [x] Exactly one finalizer made the closeout decision: Seoseo (broker/finalizer of record).
- [x] Evidence supports the decision: PR URL, CI green, admission test passes.
- [x] Follow-up issues are linked: jinwon-int/a2a-plane#393.
- [x] Wiki/runbook update is linked or explicitly not needed: not needed for source/spec packet.
- [x] No unapproved deploy/restart/canary/DB/ACK/replay/release/secret action occurred.
