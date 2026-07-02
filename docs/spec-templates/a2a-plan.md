# Implementation Plan: <name>

## Linked spec

- Spec: <issue/PR/path>

## Size classification

- [ ] Small
- [ ] Medium
- [ ] Large

Reason:

## Affected repos/components

- `a2a-plane`:
- `a2a-broker`:
- `a2a-docker-runner`:
- `openclaw-plugin-a2a`:
- worker/node config:
- Wiki/runbooks:
- other:

## Broker / worker / finalizer roles

- Broker of record / finalizer:
- Workers:
- Libero/validator:
- Human approval owner:

## Execution lane

- [ ] Direct small change
- [ ] Isolated subagent
- [ ] Broker-owned TaskFlow
- [ ] TaskFlow + A2A evidence workers
- [ ] Other:

Why this lane is safe:

## Data/control flow

Describe the intended flow, including cross-broker, Terminal Brief, evidence, or approval boundaries if relevant.

## Tests and validation

- Oracle independence / finalizer coverage review:
- Red-to-green evidence for new gates or scanners:
- Discovery inventory for cleanup/removal tasks:
- Follow-up issue materialization for multi-stage plans:
- Lane-to-PR mapping (default one lane = one PR; deviations require finalizer approval):
- Unit tests:
- Contract/conformance tests:
- Build/lint/typecheck:
- Dry-run/doctor checks:
- CI checks:
- Live canary, if separately approved:

## Rollout plan

- Source PR order:
- Merge/rehearsal order:
- Deployment gate, if separately approved:
- Communication/Terminal Brief expectations:

## Rollback plan

- Revert path:
- Config rollback:
- State cleanup:
- Approval required before cleanup:

## Closeout evidence

- Finalizer decision:
- Evidence links:
- Tests/checks:
- Approval-sensitive actions not performed:
- Wiki/runbook update:
