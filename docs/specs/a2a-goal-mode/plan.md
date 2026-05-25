# Implementation Plan: A2A Goal Mode — Persistent Objective Execution

## Linked spec

- Spec: `docs/specs/a2a-goal-mode/spec.md`
- Design tracker: `jinwon-int/a2a-plane#442`
- Parent adoption tracker: `jinwon-int/a2a-plane#443`

## Size classification

- [ ] Small
- [x] Medium
- [ ] Large

Reason: this PR is design/docs-only in one repo. Broker runtime implementation of Goal Mode would be Large and must be planned separately.

## Affected repos/components

- `a2a-plane`: design docs/spec/plan/tasks/contract/schema/fixture only.
- `a2a-broker`: referenced as future integration target, no change in this PR.
- `a2a-docker-runner`: no change.
- `openclaw-plugin-a2a`: no change.
- worker/node config: no change.
- Wiki/runbooks: no change in this PR.

## Broker / worker / finalizer roles

- Broker of record / finalizer for this docs PR: Seoseo.
- Workers: none required.
- Libero/validator: GitHub Actions and local release-gate validation.
- Human approval owner: Seo Jin On for any future runtime automation.

## Execution lane

- [x] Direct docs change
- [ ] Isolated subagent
- [ ] Broker-owned TaskFlow
- [ ] TaskFlow + A2A evidence workers

Why this lane is safe: the current change is a source documentation/design PR only. It does not mutate runtime, run live canaries, create TaskFlow jobs, or create broker tasks.

## Data/control flow

The design documents define the future Goal Mode flow:

1. Operator defines an objective (short name, scope, success criteria, approval gates).
2. A goal run is created with the durable goal object schema and an initial `idle` state.
3. The operator dispatches a planning request or the planner loop activates deterministically.
4. The planner reads current goal state, examines accumulated evidence, and decides the next bounded A2A task(s) to dispatch.
5. Each task proceeds through the standard A2A lifecycle (queued → claimed → running → done|pr|blocked).
6. Worker evidence is collected into the goal object's evidence log.
7. Re-plan occurs after each completed or blocked slice.
8. Approval-gated actions move the goal to `awaiting_approval` instead of executing.
9. The goal reaches a terminal state (`completed`, `blocked`, `cancelled`) or loops back to planning.

## Tests and validation

- `git diff --check`
- `npm run check:layout`
- `npm run test:release-gate`
- `node -e "JSON.parse(fs.readFileSync('docs/specs/a2a-goal-mode/schema.json','utf8'))"` — schema parse check
- `node -e "JSON.parse(fs.readFileSync('fixtures/contract/a2a-goal-mode.json','utf8'))"` — fixture parse check
- GitHub Actions `check`

## Rollout plan

1. Add spec, plan, tasks, contract, schema, and fixture.
2. Open PR referencing #442.
3. Validate locally and via GitHub Actions.
4. Merge only if docs-only checks pass.
5. Future issue/PR can implement broker runtime after design review.

## Rollback plan

Revert the docs/contract/schema/fixture PR. No runtime state or config cleanup needed.

## Closeout evidence

- PR URL.
- Merge commit if merged.
- Validation results.
- Comment on #442.
- Safety boundary confirmation.
