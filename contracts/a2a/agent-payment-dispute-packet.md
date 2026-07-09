# Agent Payment Dispute Packet v0

Issue: [a2a-nexus#1488](https://github.com/jinwon-int/a2a-nexus/issues/1488). Parent proof: [Escrow Release Proof Bundle v0](./escrow-release-proof.md). Related primitives: [Agent Work Proof Bundle v0](./agent-work-proof.md), [Completion Certificate v0](./completion-certificate.md), [Finalizer Verdict v1](./finalizer-verdict.md).

## Purpose

`a2a-agent-payment-dispute-packet` is a source-only evidence packet for one dispute question:

> If a user later says “I did not authorize this agentic payment,” can the operator show the delegated authority, scope match, agent identity, completion proof, and release decision as one offline-verifiable bundle?

It is **not** a payment rail, PSP adapter, card-network authorization record, escrow custodian, fraud engine, legal identity provider, tax/regulatory compliance decision, chargeback authority, or live webhook contract.

## Product boundary

Good positioning:

> We do not move money. We make release decisions auditable.

Payment rails keep doing authorization, tokenization, settlement, fraud, and disputes. Nexus provides source-only evidence for the missing agentic question: did the agent have delegated authority, did it stay within scope, and did it satisfy the release conditions?

## Bundle shape

A v0 packet has schema `a2a.agent-payment-dispute-packet.v0` and MUST include:

| Field | Meaning |
|---|---|
| `packetId` | Stable packet identifier. |
| `sourceOnly`, `noLive` | Both must be `true`. |
| `dispute` | Hash-only dispute claim and payment reference. |
| `mandate` | User-delegation payload plus `sha256:JCS(mandatePayload)`. |
| `agentIdentity` | Hash/reference-only agent identity verification result. |
| `taskContract` | Task, merchant, amount, product, acceptance, and payment-reference binding. |
| `scopeDecision` | Recomputable scope-decision checks and reason codes. |
| `escrowReleaseProofHash` | `sha256:JCS(escrowReleaseProof)`. |
| `escrowReleaseProof` | Embedded source-only escrow release proof from #1482. |
| `completionProof` | Binding from escrow release proof to completion/release evidence. |
| `releaseDecision` | Recomputed `release_authorized`, `release_rejected`, or `release_pending`. |
| `packetVerdict` | Signed finalizer verdict over packet subject. |
| `paymentBoundary` | Required false flags for rails/funds/custody/card/live actions. |
| `publicSafety` | Required false flags for private paths, tokens, provider IDs, Telegram IDs, card data, raw logs/session dumps, and PII. |
| `doesNotProve` / `assurance` | Required disclaimer boundary. |
| `extractionReadiness` | Future product extraction and PSP/live adapter remain approval-gated. |

## Source-only safety boundary

Every valid packet MUST declare all of these fields as `false`:

```json
{
  "paymentBoundary": {
    "paymentRailCall": false,
    "paymentAuthorization": false,
    "fundsMovement": false,
    "escrowCustody": false,
    "providerCredentialRequired": false,
    "rawCardDataPresent": false,
    "rawPanPresent": false,
    "rawCvvPresent": false,
    "liveWebhookDeployed": false,
    "captureExecuted": false,
    "payoutExecuted": false,
    "refundExecuted": false,
    "releaseExecuted": false,
    "networkAuthorizationClaimed": false,
    "chargebackDecisionFinal": false,
    "legalIdentityVerifiedByNexus": false
  }
}
```

The verifier MUST fail closed if any flag is missing or true.

## Mandate requirements

The user-delegation object has schema `a2a.agent-payment-mandate.v0` and MUST be machine-verifiable. A free-form prompt is not enough.

Required properties:

- hash/reference-only user reference (`userRefHash`), never raw user identity;
- bound agent key (`agentKeyId`);
- scope fields: `intent`, `maxAmount`, `merchantAllowlist`, optional `productRefHash`, `deadline`, `freshApprovalRequired`;
- authorization verification with a hash/reference-only assertion;
- privacy flags declaring no raw card data, raw user identifier, or raw signature material.

## Scope-decision checks

The source-only verifier recomputes these checks from the packet inputs:

| Check id | Pass condition | Failure / pending result |
|---|---|---|
| `agent_identity_verified` | Agent identity verifies and matches mandate subject. | `AGENT_UNVERIFIED` |
| `intent_allowed_by_mandate` | Task intent equals mandate scope intent. | `INTENT_NOT_AUTHORIZED` |
| `amount_within_cap` | Task amount is within mandate `maxAmount` and currency. | `AMOUNT_EXCEEDED` |
| `merchant_allowed` | Merchant and optional product are within scope. | `MERCHANT_SCOPE_MISMATCH` |
| `mandate_not_expired` | Verifier time is before scope deadline. | `MANDATE_EXPIRED` |
| `fresh_user_approval` | `not_required`, or required and approved. | `APPROVAL_REQUIRED_MISSING` / pending |
| `payment_reference_bound_to_task` | Dispute, task, and escrow proof all bind the same hash-only payment reference. | `PAYMENT_REFERENCE_NOT_BOUND` |
| `completion_proof_valid` | Embedded escrow release proof is valid and release-allowed. | `COMPLETION_CONDITIONS_NOT_MET` / `PROOF_TAMPERED` |

## Decision semantics

| Evidence state | Expected decision | Reason code |
|---|---|---|
| No mandate payload | `release_rejected` | `NO_USER_DELEGATION` |
| Mandate hash/signature/verification invalid | `release_rejected` | `MANDATE_SIGNATURE_INVALID` |
| Agent identity invalid or not bound to mandate | `release_rejected` | `AGENT_UNVERIFIED` |
| Payment reference not bound to task/release proof | `release_rejected` | `PAYMENT_REFERENCE_NOT_BOUND` |
| Intent not authorized | `release_rejected` | `INTENT_NOT_AUTHORIZED` |
| Amount above cap | `release_rejected` | `AMOUNT_EXCEEDED` |
| Merchant/product outside scope | `release_rejected` | `MERCHANT_SCOPE_MISMATCH` |
| Mandate expired | `release_rejected` | `MANDATE_EXPIRED` |
| Fresh approval required but missing | `release_pending` | `APPROVAL_REQUIRED_MISSING` |
| Completion/release evidence invalid | `release_rejected` | `COMPLETION_CONDITIONS_NOT_MET` or `PROOF_TAMPERED` |
| All source-only checks pass | `release_authorized` | `RELEASE_AUTHORIZED` |

`release_authorized` here means only that the packet supports source-only release-authorization evidence. It does not execute, approve, or settle payment.

## Reason code vocabulary

Positive / defense-supporting:

- `USER_DELEGATION_VALID`
- `AGENT_IDENTITY_VERIFIED`
- `SCOPE_MATCHED`
- `PAYMENT_REFERENCE_BOUND_TO_TASK`
- `COMPLETION_CERTIFICATE_VALID`
- `DETERMINISTIC_CONDITIONS_PASSED`
- `NO_TAMPER_DETECTED`
- `RELEASE_AUTHORIZED`

Negative / user-protective:

- `NO_USER_DELEGATION`
- `MANDATE_SIGNATURE_INVALID`
- `INTENT_NOT_AUTHORIZED`
- `AMOUNT_EXCEEDED`
- `MERCHANT_SCOPE_MISMATCH`
- `MANDATE_EXPIRED`
- `APPROVAL_REQUIRED_MISSING`
- `AGENT_UNVERIFIED`
- `PAYMENT_REFERENCE_NOT_BOUND`
- `COMPLETION_CONDITIONS_NOT_MET`
- `PROOF_TAMPERED`
- `INCONCLUSIVE_EVIDENCE`

## Verifier

```bash
node scripts/verify-agent-payment-dispute-packet.mjs \
  fixtures/contract/agent-payment-dispute-packet.json \
  --keyring fixtures/contract/agent-payment-dispute-packet-keyring.json \
  --json
```

The verifier returns `green=true` only when the packet is internally consistent, source-only, public-safe, hash-bound, and signed. It returns `releaseAllowed=true` only when the packet is green **and** the recomputed decision is `release_authorized`.

## Non-goals

- No live Visa/Mastercard/Stripe/Adyen/x402/AP2 call.
- No real authorization, capture, refund, payout, or escrow custody.
- No PCI card data handling.
- No final chargeback or legal-liability decision.
- No production webhook endpoint.
- No provider credentials, private keys, Telegram IDs, private paths, raw session dumps, or production data.
