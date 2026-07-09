# Escrow Release Proof Bundle v0

Issue: [a2a-nexus#1482](https://github.com/jinwon-int/a2a-nexus/issues/1482). Related primitives: [completion certificate](./completion-certificate.md), [agent work proof](./agent-work-proof.md), [finalizer verdict](./finalizer-verdict.md).

## Purpose

`a2a-escrow-proof` is a source-only proof layer for one question:

> Were declared release conditions evaluated against offline-verifiable A2A evidence?

It is **not** a payment rail, escrow custodian, settlement engine, refund engine, chargeback authority, or live webhook contract. A valid proof can support an operator decision in a future rail-specific integration, but it never moves money or authorizes payment by itself.

## Source-only safety boundary

Every v0 bundle MUST declare:

```json
{
  "sourceOnly": true,
  "noLive": true,
  "paymentBoundary": {
    "paymentRailCall": false,
    "escrowCustody": false,
    "fundsMovement": false,
    "providerCredentialRequired": false,
    "rawCardDataPresent": false,
    "liveWebhookDeployed": false,
    "automaticCapture": false,
    "payoutExecuted": false,
    "refundExecuted": false,
    "releaseExecuted": false
  }
}
```

The verifier MUST fail closed if any of those flags are absent or true.

## Bundle shape

A v0 bundle has schema `a2a.escrow-release-proof.bundle.v0` and contains:

| Field | Meaning |
|---|---|
| `proofId` | Stable sample/proof identifier. |
| `agentWorkProofHash` | `sha256:JCS(agentWorkProof)`. |
| `agentWorkProof` | Embedded `a2a.agent-work-proof.bundle.v0` object verified by `scripts/verify-agent-work-proof.mjs`. |
| `releaseConditionHash` | `sha256:JCS(releaseCondition)`. |
| `releaseCondition` | Source-only release condition object. |
| `releaseDecision` | Derived decision: `release_authorized`, `release_rejected`, or `release_pending`. |
| `releaseVerdict` | Signed finalizer verdict over the release decision subject. |
| `paymentBoundary` | Required no-live/no-custody/no-rail flags. |
| `publicSafety` | Required public-safe fixture flags. |
| `assurance` | What the bundle proves and what it explicitly does not prove. |
| `extractionReadiness` | Future repo/CLI/live-rail extraction remains deferred. |

## Release condition shape

A v0 release condition has schema `a2a.escrow-release.condition.v0` and MUST include:

- `sourceOnly=true` and `noLive=true`;
- `providerCredentialRequired=false`;
- a hash-only payment reference, not raw provider identifiers or raw card data;
- `requiredEvidence.agentWorkProofHash` equal to the bundle's agent-work-proof hash;
- `requiredEvidence.signedVerdictRequired=true`;
- deterministic checks that include `certification-battery`;
- an explicit `approval` object;
- zero or more `checks` with statuses from `met`, `failed`, `blocked`, `inconclusive`, `pending`.

## Decision semantics

The offline verifier derives the expected release decision from the condition and embedded proof:

| Evidence state | Expected decision | Reason |
|---|---|---|
| Embedded agent work proof fails | `release_rejected` | Proof composition is invalid. |
| Any condition status is `failed`, `blocked`, or `inconclusive` | `release_rejected` | Non-green evidence never authorizes release. |
| Any condition status is `pending` | `release_pending` | A required condition is not complete. |
| Approval is required but not approved | `release_pending` | Approval-required and release-pending are separate from authorization. |
| External rail conditions are present | `release_pending` | A2A source-only layer does not evaluate rail-side state. |
| All deterministic/source-only conditions are met and approval is not required or already satisfied | `release_authorized` | The source-only release condition evaluates green. |

A `release_authorized` source-only proof means only that the declared offline release condition evaluated green. It does **not** mean a payment provider authorized a charge, funds are available, escrow is held, chargeback liability is resolved, or a live payout/refund/release was executed.

## Signed release verdict

`releaseVerdict` MUST be an `a2a.finalizer.verdict.v1` judgment verdict. Its subject MUST be:

```json
{
  "kind": "escrow-release-proof",
  "proofId": "...",
  "releaseConditionHash": "sha256:...",
  "agentWorkProofHash": "sha256:...",
  "paymentReferenceHash": "sha256:...",
  "decision": "release_authorized"
}
```

For `release_authorized`, the finalizer decision MUST be `go`. For `release_rejected` or `release_pending`, the finalizer decision MUST be `no-go`. This keeps blocked or inconclusive evidence from being framed as a release authorization.

## Public fixture and verifier

The source-only sample fixture is:

- [`fixtures/contract/escrow-release-proof.json`](../../fixtures/contract/escrow-release-proof.json)
- [`fixtures/contract/escrow-release-proof-keyring.json`](../../fixtures/contract/escrow-release-proof-keyring.json)

Verify it locally:

```bash
node scripts/verify-escrow-release-proof.mjs \
  fixtures/contract/escrow-release-proof.json \
  --keyring fixtures/contract/escrow-release-proof-keyring.json
```

Conformance check:

```bash
node test/conformance/check-escrow-release-proof.mjs
```

## Non-goals

This contract deliberately excludes:

- payment provider calls;
- funds movement;
- escrow custody;
- payout, capture, refund, or release execution;
- raw provider IDs, card data, Telegram IDs, private paths, raw logs, secrets, or private keys in fixtures;
- legal settlement or chargeback-liability decisions;
- #1488 dispute-packet delegation semantics;
- broker policy live-mode changes, deploy/restart, DB/outbox/ACK/replay/prune/migration, provider sends, or canaries.

#1488 remains a separate child layer for user-delegation dispute packets. This v0 slice only proves source-only release-condition evaluation.
