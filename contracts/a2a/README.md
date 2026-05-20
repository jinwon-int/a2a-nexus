# A2A Shared Contracts (v0 Freeze)

Public-safe contract skeletons for A2A protocol and task lifecycle behavior.

> **v0 Freeze (2026-05-09):** These contracts are frozen as the Contract v0 baseline for A2A Plane cross-broker compatibility.
> The v0 surface includes task lifecycle states/transitions, worker registration read-model assumptions,
> cancellation & idempotency semantics, terminal evidence result types, and the accepted-send non-ACK boundary.
> No new states, result types, or receipt levels may be added without a v0→v1 compatibility plan.

## Contracts

- [Task lifecycle](./task-lifecycle.md)
- [Terminal result semantics](./terminal-semantics.md)
- [Worker registration and read-model assumptions](./worker-registration.md)
- [Cancellation & idempotency](./cancellation-idempotency.md)
- [Broker-to-broker handoff protocol](./broker-handoff-protocol.md)
- [Parent Terminal Brief aggregation](./parent-terminal-brief-aggregation.md)
- [Durable checkpoint & human interrupt](./checkpoint-interrupt.md)
- [R20 stability gate](./r20-stability-gate.md) — hot-table persistence, queue/outbox hygiene, no-live canary boundaries, stale R14 PR reconciliation
- [R31 worker capability profile](./worker-capability-profile.md) — worker capability profile schema, assignment recommendation semantics, capacity-limited slow lane phrasing
- [Embedded execution stability policy](./embedded-execution-stability-policy.md) — container isolation, config domain sanitization, workspace hygiene, session store guard, post-completion fail-closed checks for Docker Runner embedded OpenClaw execution
- [Approval-gated auto-closeout action reconciliation](./action-reconciliation.md) — cross-repo contract between a2a-broker and a2a-plane for approval-gated auto-closeout action reconciliation, idempotency keys, rollback/no-op criteria, and canary gate

## Compatibility

- [Terminal evidence ACK boundary](../compatibility/terminal-evidence-ack-boundary.md)

## Fixtures

Machine-readable reference fixtures for broker/plugin/runner validation:

### Contract v0 fixtures

- [Task lifecycle state transitions](../../fixtures/contract/task-lifecycle.json)
- [Worker registration & capabilities](../../fixtures/contract/worker-registration-capabilities.json)
- [Cancellation & idempotency scenarios](../../fixtures/contract/cancellation-idempotency.json)
- [Terminal evidence examples](../../fixtures/contract/terminal-evidence.json)
- [Parent Terminal Brief aggregation canary](../../fixtures/contract/parent-terminal-brief-aggregation.json)
- [Checkpoint & human-interrupt scenarios](../../fixtures/contract/checkpoint-interrupt.json)
- [R20 stability gate](../../fixtures/contract/r20-stability-gate.json) — machine-readable R20 gate fixture
- [R31 worker capability profile](../../fixtures/contract/worker-capability-profile.json) — worker capability profile fixture
- [Embedded execution stability policy](../../fixtures/contract/embedded-execution-stability-policy.json) — machine-readable embedded execution stability policy fixture
- [Action reconciliation](../../fixtures/contract/action-reconciliation.json) — approval-gated auto-closeout action reconciliation scenarios
- [External harness no-live conformance](../../fixtures/external-harness/no-live-conformance.json) — public-safe external harness fixture for OpenClaw-agnostic no-live integration

### Compatibility fixtures

- [Accepted-send non-ACK boundary](../../fixtures/terminal-evidence/accepted-send-non-ack.json)

## Conformance

- `node test/conformance/check-contract-fixtures.mjs` — validates contract v0 fixtures
- `node test/conformance/check-terminal-evidence-ack-boundary.mjs` — validates accepted-send non-ACK fixture

These documents intentionally avoid private endpoint names, provider identifiers, secret values, host-specific paths, and raw session evidence.
