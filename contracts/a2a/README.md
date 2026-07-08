# A2A Shared Contracts (v0 Freeze)

Public-safe contract skeletons for A2A protocol and task lifecycle behavior.

> **v0 Freeze (2026-05-09):** These contracts are frozen as the Contract v0 baseline for A2A Nexus cross-broker compatibility.
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
- [Terminal Brief core contract v1](./terminal-brief-core-contract.md)
- [Durable checkpoint & human interrupt](./checkpoint-interrupt.md)
- [R20 stability gate](./r20-stability-gate.md) — hot-table persistence, queue/outbox hygiene, no-live canary boundaries, stale R14 PR reconciliation
- [R31 worker capability profile](./worker-capability-profile.md) — worker capability profile schema, assignment recommendation semantics, capacity-limited slow lane phrasing
- [Embedded execution stability policy](./embedded-execution-stability-policy.md) — container isolation, config domain sanitization, workspace hygiene, session store guard, post-completion fail-closed checks for Docker Runner embedded OpenClaw execution
- [Approval-gated auto-closeout action reconciliation](./action-reconciliation.md) — cross-repo contract between a2a-broker and a2a-plane for approval-gated auto-closeout action reconciliation, idempotency keys, rollback/no-op criteria, and canary gate
- [Adapter receipt capability](./adapter-receipt-capability.md) — capability levels C1–C6 for non-OpenClaw/Hermes/spool Terminal Brief adapters, mapping produced/spooled/provider-only states to the four receipt levels, and explicit non-ACK boundary for adapter-level evidence
- [Harness-neutral analysis adapter](./harness-neutral-analysis-adapter.md) — source-only analysis task inputs, adapter output fields, evidence classes, and finalizer counting rules independent of Hermes/OpenClaw/Docker-runner harnesses
- [Constrained node-op lane](./node-op-lane.md) — allowlisted node-local fleet operation contract; explicitly rejects raw shell/exec and freezes approval, readiness, integrity, redaction, and rollback gates
- [Completion certificate](./completion-certificate.md) — source-only proof object for declared task completion conditions; composes battery/judgment verdicts for external payment-release evaluators without moving funds or integrating live rails
- [Product artifact certificate](./product-artifact-certificate.md) — source-only claim-bound certificate for pinned software artifacts; separates finite evidence claims from broad safety/quality marketing

## Compatibility

- [Terminal evidence ACK boundary](../compatibility/terminal-evidence-ack-boundary.md)
- [A2A TCK and v0→v1 compatibility plan](../compatibility/a2a-tck-and-v0-to-v1-compatibility-plan.md) — TCK lane (#916 / wave #922). Maps frozen v0 contracts to executable TCK categories, defines the v0→v1 rules, and classifies fixture validators versus TCK gates.

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
- [Harness-neutral analysis adapter](../../fixtures/contract/harness-neutral-analysis-adapter.json) — source-only analysis evidence classification scenarios for substantive, wrapper-only, source-blocked, handler-artifact, queued, and provider/model-failure lanes
- [Completion certificate](../../fixtures/contract/completion-certificate.json) — source-only completion proof fixtures for eligible, not-eligible, external-pending, and fail-closed payment-boundary cases
- [External harness no-live conformance](../../fixtures/external-harness/no-live-conformance.json) — public-safe external harness fixture for OpenClaw-agnostic no-live integration

### Compatibility fixtures

- [Accepted-send non-ACK boundary](../../fixtures/terminal-evidence/accepted-send-non-ack.json)

## Conformance

- `node test/conformance/check-contract-fixtures.mjs` — validates contract v0 fixtures
- `node test/conformance/check-completion-certificate.mjs` — validates completion certificate source-only condition fixtures and payment-boundary invariants
- `node test/conformance/check-completion-certificate-verifier.mjs` — validates the source-only offline completion certificate verifier against signature, subject-binding, expiry, issuer-key, and assurance-boundary negative cases
- `node test/conformance/check-completion-certificate-generator.mjs` — validates the report-only no-live completion certificate generator and generator→verifier round-trip
- `node scripts/generate-completion-certificate.mjs <report.json> --signing-key <ed25519-private.pem>` — emits a signed report-only completion certificate from a public-safe no-live report; this is not payment release authorization
- `node scripts/verify-completion-certificate.mjs <certificate.json> --keyring <keyring.json>` — independently verifies a signed completion certificate offline; this is an integrity check, not payment release authorization
- `node test/conformance/check-terminal-evidence-ack-boundary.mjs` — validates accepted-send non-ACK fixture
- `node test/conformance/check-a2a-tck-plan.mjs` — validates the A2A TCK and v0→v1 compatibility plan spec, fixture, gate mapping, and external-harness reference (#916)

These documents intentionally avoid private endpoint names, provider identifiers, secret values, host-specific paths, and raw session evidence.
