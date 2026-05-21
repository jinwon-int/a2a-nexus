# Implementation Plan: Gongyung Hermes Lightweight A2A Worker Profile

## Linked spec

- Spec: `docs/specs/a2a-gongyung-lightweight-worker/spec.md`
- Tracker: `jinwon-int/a2a-plane#393`
- Prior art: `jinwon-int/a2a-plane#384` (Hermes Broker-Agnostic Worker Contract)

## Size classification

- [ ] Small
- [x] Medium
- [ ] Large

Reason: Phase 1 adds spec docs, worker card, fixture, and test validation in `a2a-plane`. A production Gongyung worker registration on the live broker remains a separate Medium/Large operational approval.

## Affected repos/components

- `a2a-plane`: spec docs, worker card fixture, test validation.
- `a2a-broker`: no change — existing registration, capabilities, and evidence routes already accept the lightweight metadata pattern.
- `a2a-docker-runner`: no change.
- `openclaw-plugin-a2a`: no change.
- `Hermes Agent`: reference implementation notes only.

## Execution lane

- [x] Seoseo direct Phase 1 source PR in `a2a-plane`.
- [ ] Production Gongyung registration: separate operational approval.

Why this lane is safe: it modifies local source/docs/tests only and does not touch production broker state.

## Data/control flow

1. Operator approves Gongyung worker profile spec.
2. Operator (or Hermes Agent) registers Gongyung with `workerProfile=lightweight`, `dockerAvailable=false` metadata.
3. Broker accepts the registration as a normal `mobile` worker with restricted capabilities.
4. Broker assigns lightweight-only tasks (documentation, research, reports, evidence review, canary/reporting).
5. If the broker assigns a task with `dockerRequired`, `buildRequired`, `testRequired`, `repoPatch`, or `untrustedCode`, Gongyung's task handler rejects it with `outcome=blocked` and a clear reason.
6. Accepted tasks write output under `~/.hermes/a2a/artifacts/<task-id>/`.
7. Terminal evidence includes a manifest with `taskId`, `workerId`, `status`, `filesProduced`, `redactionStatement`, `limitations`, and `timestamp`.
8. Evidence is redacted before submission.

## Tests and validation

- `node --test scripts/check-gongyung-lightweight-worker.test.mjs`
- `npm run test:conformance`
- `git diff --check`
- GitHub Actions check on PR.

## Rollout plan

- Merge source PR after local and CI validation.
- Do not deploy, restart, register Gongyung against the live broker, send provider notifications, or change any production routing.
- Create a separate tracker/approval packet before any production Gongyung worker registration.

## Rollback plan

- Revert PR.
- No production state cleanup is required.
