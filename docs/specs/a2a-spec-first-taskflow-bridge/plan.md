# Implementation Plan: A2A Spec-First TaskFlow Bridge

## Linked spec

- Spec: `docs/specs/a2a-spec-first-taskflow-bridge/spec.md`
- Design tracker: `a2a-plane#322 (internal tracker, private)`
- Parent adoption tracker: `a2a-plane#315 (internal tracker, private)`

## Size classification

- [ ] Small
- [x] Medium
- [ ] Large

Reason: this PR is design/docs-only in one repo. Runtime implementation of the bridge would be Large and must be planned separately.

## Affected repos/components

- `a2a-plane`: design docs/spec/fixtures only.
- `a2a-broker`: referenced as future integration target, no change in this PR.
- `a2a-docker-runner`: no change.
- `openclaw-plugin-a2a`: no change.
- worker/node config: no change.
- Wiki/runbooks: no change in this PR.

## Broker / worker / finalizer roles

- Broker of record / finalizer for this docs PR: broker-beta.
- Workers: none required.
- Libero/validator: GitHub Actions and local release-gate validation.
- Human approval owner: the operator for any future runtime automation/deploy/canary.

## Execution lane

- [x] Direct docs change
- [ ] Isolated subagent
- [ ] Broker-owned TaskFlow
- [ ] TaskFlow + A2A evidence workers

Why this lane is safe: the current change is a source documentation/design PR only. It does not mutate runtime, run live canaries, or create TaskFlow jobs.

## Data/control flow

The design document defines the future bridge flow:

1. Operator or broker identifies Medium/Large A2A work.
2. Spec-first packet is created: `spec.md`, optional `clarify.md`, `plan.md`, optional `analyze.md`, `tasks.md`, optional `checklist.md`.
3. Future bridge creates a managed TaskFlow job with minimal state copied from the packet.
4. Child implementation/evidence tasks are linked to the flow.
5. Approval-sensitive actions move the flow to `awaiting_approval` instead of executing.
6. Evidence collection moves the flow to `ready_for_closeout`.
7. Broker/finalizer performs final judgment and closes the flow.

## Tests and validation

- `git diff --check`
- `npm run check:layout`
- `npm run test:release-gate`
- GitHub Actions `check`

## Rollout plan

1. Add docs/spec/plan/tasks and optional fixture.
2. Open PR referencing #322 and #315.
3. Validate locally and via GitHub Actions.
4. Merge only if docs-only checks pass.
5. Future issue/PR can implement runtime bridge after design review.

## Rollback plan

Revert the docs PR. No runtime state or config cleanup needed.

## Closeout evidence

- PR URL;
- merge commit if merged;
- validation results;
- comments on #322/#315;
- safety boundary confirmation.
