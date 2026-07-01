# Implementation Plan: A2A Spec-First TaskFlow Runtime Dry-Run

## Linked spec

- Spec: `docs/specs/a2a-spec-first-taskflow-runtime/spec.md`
- Implementation tracker: `a2a-plane#324 (internal tracker, private)`
- Parent adoption tracker: `a2a-plane#315 (internal tracker, private)`

## Size classification

- [ ] Small
- [x] Medium
- [ ] Large

Reason: this is a source-public dry-run command plus tests in one repo. Live TaskFlow automation would be Large and separate.

## Affected repos/components

- `a2a-plane`: scripts, docs, fixture, package scripts.
- `a2a-broker`: referenced by fixture only.
- `a2a-docker-runner`: no change.
- `openclaw-plugin-a2a`: referenced by fixture only.
- worker/node config: no change.
- Wiki/runbooks: no change.

## Broker / worker / finalizer roles

- Broker of record / finalizer: Gwakga.
- Workers: none required for this PR.
- Libero/validator: local release-gate and GitHub Actions.
- Human approval owner: the operator for any future live runtime automation.

## Execution lane

- [x] Direct source-public dry-run implementation
- [ ] Isolated subagent
- [ ] Broker-owned TaskFlow
- [ ] TaskFlow + A2A evidence workers

Why this lane is safe: it creates no live TaskFlow jobs and performs no external mutation.

## Data/control flow

1. CLI loads a fail-closed schema.
2. Without input, it prints `NO_GO` dry-run metadata.
3. With a packet, it validates state fields, approval boundaries, child lanes, and redaction rules.
4. On safe input, it emits a managed TaskFlow draft.
5. If approval is requested, it emits `NEEDS_OPERATOR_APPROVAL` and `waitJson`.
6. Unsafe inputs return `NO_GO` and non-zero exit.

## Tests and validation

- Unit tests: `node --test scripts/a2a-spec-first-taskflow-runtime.test.mjs`
- Contract/schema sanity: JSON parse through command.
- Build/lint/typecheck: N/A for this script-only repo.
- Dry-run/doctor checks: valid fixture command.
- CI checks: GitHub Actions `check`.
- Live canary: not in scope.

## Rollout plan

- Source PR only.
- Merge after local and CI validation.
- No deploy, provider send, or runtime enablement.

## Rollback plan

- Revert PR.
- No config rollback, state cleanup, or approval-required cleanup.

## Closeout evidence

- PR URL.
- Tests/checks.
- Approval-sensitive actions not performed.
- Wiki/runbook update not required for dry-run.
