# Escrow release proof

**Do not ask a reader to trust that an agent should release funds. Give them a local proof that the release conditions were evaluated — and make clear that the proof does not move money.**

`a2a-escrow-proof` is a source-only release-condition proof slice. It composes the existing [agent work proof](agent-work-proof.md), completion-certificate, deterministic battery, and signed finalizer verdict primitives into a payment-boundary-safe bundle.

## Thirty-second model

1. A task produces an offline-verifiable agent work proof.
2. A source-only release condition references that proof by hash.
3. Deterministic checks and signed verdict evidence are evaluated locally.
4. The verifier derives `release_authorized`, `release_rejected`, or `release_pending`.
5. A signed release verdict binds the decision to the condition and proof hash.

That is the whole product slice. It is a proof of **condition evaluation**, not a payment integration.

## Try it locally

```bash
node scripts/verify-escrow-release-proof.mjs \
  fixtures/contract/escrow-release-proof.json \
  --keyring fixtures/contract/escrow-release-proof-keyring.json
```

Expected result for the sample fixture:

```text
GREEN — release condition verified as authorized
```

For machine-readable output:

```bash
node scripts/verify-escrow-release-proof.mjs \
  fixtures/contract/escrow-release-proof.json \
  --keyring fixtures/contract/escrow-release-proof-keyring.json \
  --json
```

## What the sample proves

| Claim | How it is checked |
|---|---|
| The bundle is source-only/no-live | Required top-level and payment-boundary flags. |
| The agent work proof is valid | Embedded proof is verified by `scripts/verify-agent-work-proof.mjs`. |
| The release condition binds the proof | `agentWorkProofHash` and `releaseConditionHash` are recomputed with JCS. |
| Deterministic checks are referenced | `requiredEvidence.deterministicChecks` includes `certification-battery`. |
| Failed/blocked/inconclusive conditions do not authorize release | The verifier derives `release_rejected` for those states. |
| Approval-required and release-pending are distinct | `approvalState` and `releaseState` are separate fields. |
| The release decision is signed | `releaseVerdict` is an `a2a.finalizer.verdict.v1` subject-bound judgment. |

## What it does not prove

A green escrow-release proof does **not** prove:

- payment authorization;
- funds availability;
- escrow custody;
- legal settlement;
- chargeback liability;
- card-network authorization;
- live rail execution;
- payout/capture/refund/release execution;
- analytical correctness of the original agent work.

## Why this matters

Completion and work-proof artifacts are useful, but a future payment or escrow-like product needs a narrow object that answers: "What exact release condition evaluated green, and what proof was used?"

This slice provides that object while keeping live rail integration separately approval-gated.

## Files

- Contract: [`contracts/a2a/escrow-release-proof.md`](../contracts/a2a/escrow-release-proof.md)
- Fixture: [`fixtures/contract/escrow-release-proof.json`](../fixtures/contract/escrow-release-proof.json)
- Public-key keyring: [`fixtures/contract/escrow-release-proof-keyring.json`](../fixtures/contract/escrow-release-proof-keyring.json)
- Verifier: [`scripts/verify-escrow-release-proof.mjs`](../scripts/verify-escrow-release-proof.mjs)
- Conformance: [`test/conformance/check-escrow-release-proof.mjs`](../test/conformance/check-escrow-release-proof.mjs)

## Boundaries

This sample performs no provider calls, broker calls, payment rail calls, Telegram sends, DB/outbox/ACK/replay mutation, deploy/restart, key movement, registry write, badge publication, or live webhook deployment.

#1488 dispute packets remain a separate child layer. This page covers only #1482 release-condition proof.
