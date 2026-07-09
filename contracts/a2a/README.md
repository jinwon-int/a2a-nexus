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
- [Certification battery](./certification-battery.md) — source-only deterministic test-pack/result/verdict contract for reproducible finite artifact checks before any registry/badge extraction
- [Verifiable analysis report](./verifiable-analysis-report.md) — offline-verifiable report bundle; source-only product package sample is documented in [docs/verifiable-analysis-report.md](../../docs/verifiable-analysis-report.md)
- [Agent work proof](./agent-work-proof.md) — source-only composition bundle for signed work-completion evidence, artifact manifest, deterministic battery, completion certificate, and offline verifier
- [Escrow release proof](./escrow-release-proof.md) — source-only release-condition proof for escrow-like decisions; no payment rail calls, custody, funds movement, or live release execution
- [Agent payment dispute packet](./agent-payment-dispute-packet.md) — source-only user-delegation/scope/completion/release evidence packet for agentic payment disputes; no rail, custody, PCI data, or final chargeback decision

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
- [Retrieval approval contract](../../fixtures/contract/retrieval-approval-contract.json) — source-only K2 GitHub-read request and egress allowlist approval packet fixture; no live fetch or proxy enablement
- [Retrieval source-carrier binding](../../fixtures/contract/retrieval-source-carrier-binding.json) — source-only K2 approval→snapshot→source-carrier→report binding fixture; no live fetch or proxy enablement
- [Certification battery](../../fixtures/contract/certification-battery.json) — source-only deterministic battery pack/result/verdict/certificate fixture for public-safe MCP/plugin checks; no registry/badge publication
- [Verifiable analysis report product package](../../fixtures/contract/verifiable-analysis-report-product.json) — source-only sample report package with report hash, artifact manifest, and signed finalizer verdict; no release/publish/dashboard action
- [Agent work proof bundle](../../fixtures/contract/agent-work-proof-bundle.json) — source-only work-completion evidence package with report product, certification battery, completion certificate, artifact manifest, and signed work-proof verdict
- [Escrow release proof bundle](../../fixtures/contract/escrow-release-proof.json) — source-only release-condition proof with hash-bound agent-work proof and signed release verdict; no rail/custody/funds action
- [Agent payment dispute packet](../../fixtures/contract/agent-payment-dispute-packet.json) — source-only dispute evidence packet with user-delegation mandate, scope decision, completion proof, and signed packet verdict; no rail/custody/PCI/chargeback action
- [External harness no-live conformance](../../fixtures/external-harness/no-live-conformance.json) — public-safe external harness fixture for OpenClaw-agnostic no-live integration

### Compatibility fixtures

- [Accepted-send non-ACK boundary](../../fixtures/terminal-evidence/accepted-send-non-ack.json)

## Conformance

- `node test/conformance/check-contract-fixtures.mjs` — validates contract v0 fixtures
- `node test/conformance/check-completion-certificate.mjs` — validates completion certificate source-only condition fixtures and payment-boundary invariants
- `node test/conformance/check-completion-certificate-verifier.mjs` — validates the source-only offline completion certificate verifier against signature, subject-binding, expiry, issuer-key, and assurance-boundary negative cases
- `node test/conformance/check-completion-certificate-generator.mjs` — validates the report-only no-live completion certificate generator and generator→verifier round-trip
- `node test/conformance/check-completion-certificate-fake-rail.mjs` — validates the fake/no-live payment rail rehearsal adapter decision mapping, idempotency, and no-live boundaries
- `node test/conformance/check-completion-certificate-live-approval-gate.mjs` — validates the source-only live rail approval-gate packet, canary/rollback requirements, approval freshness, and secret/no-live boundaries
- `node test/conformance/check-certification-battery.mjs` — validates source-only deterministic certification battery pack/result/verdict/certificate binding, public-safe MCP/plugin fixture value without registry/badge, and extraction demand-signal gate
- `node test/conformance/check-verifiable-analysis-report-product.mjs` — validates source-only report product package hash, artifact manifest, signed finalizer verdict, and public-safe sample boundaries
- `node test/conformance/check-agent-work-proof.mjs` — validates source-only agent work proof bundle composition, hashes, completion certificate, work-proof verdict, public-safety, and extraction-boundary negatives
- `node test/conformance/check-escrow-release-proof.mjs` — validates source-only escrow release-condition proof decisions, payment-boundary negatives, hash-bound agent-work proof, and signed release verdict
- `node test/conformance/check-agent-payment-dispute-packet.mjs` — validates source-only agent payment dispute packet delegation/scope/completion/release evidence, fail-closed reason codes, public-safety, and extraction-boundary negatives
- `node test/conformance/check-retrieval-approval-contract.mjs` — validates the K2 source-only retrieval allowlist approval packet: SHA-only GitHub request, deny-by-default egress guards, untrusted envelope, no-live safety, and raw-secret denial
- `node test/conformance/check-retrieval-source-carrier-binding.mjs` — validates source-only K2 binding from approval packet to signed snapshot, `untrusted_external_data` carrier, and verifiable analysis report citations
- `node scripts/generate-completion-certificate.mjs <report.json> --signing-key <ed25519-private.pem>` — emits a signed report-only completion certificate from a public-safe no-live report; this is not payment release authorization
- `node scripts/verify-completion-certificate.mjs <certificate.json> --keyring <keyring.json>` — independently verifies a signed completion certificate offline; this is an integrity check, not payment release authorization
- `node scripts/verify-agent-work-proof.mjs fixtures/contract/agent-work-proof-bundle.json --keyring fixtures/contract/agent-work-proof-keyring.json` — independently verifies the source-only agent work proof bundle offline; this is evidence integrity, not payment/release authorization
- `node scripts/verify-escrow-release-proof.mjs fixtures/contract/escrow-release-proof.json --keyring fixtures/contract/escrow-release-proof-keyring.json` — independently verifies the source-only escrow release-condition proof offline; this is condition-evaluation evidence, not live payment execution
- `node scripts/verify-agent-payment-dispute-packet.mjs fixtures/contract/agent-payment-dispute-packet.json --keyring fixtures/contract/agent-payment-dispute-packet-keyring.json` — independently verifies the source-only dispute evidence packet offline; this is delegation/scope/release evidence, not payment execution or final chargeback liability
- `node test/conformance/check-terminal-evidence-ack-boundary.mjs` — validates accepted-send non-ACK fixture
- `node test/conformance/check-a2a-tck-plan.mjs` — validates the A2A TCK and v0→v1 compatibility plan spec, fixture, gate mapping, and external-harness reference (#916)

These documents intentionally avoid private endpoint names, provider identifiers, secret values, host-specific paths, and raw session evidence.
