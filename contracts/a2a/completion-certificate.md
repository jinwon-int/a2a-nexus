# Contract: Completion Certificate v0

Issue: [a2a-nexus#1395](https://github.com/jinwon-int/a2a-nexus/issues/1395). Parent track: [a2a-nexus#1393](https://github.com/jinwon-int/a2a-nexus/issues/1393).

Status: source-only contract slice. This document defines the proof object that can later be handed to an external payment rail or AP2 Intent Mandate evaluator. It does **not** implement payment movement, escrow custody, provider sends, or any live rail integration.

## 1. Positioning

A2A Nexus is the **condition-satisfaction proof layer**, not the payment rail.

- The broker coordinates task execution and can produce verifiable task evidence.
- Batteries and finalizer verdicts decide whether declared conditions were met.
- A completion certificate packages those results into a signed, offline-verifiable object.
- A separate payment rail may choose to release escrow after verifying the certificate.

This separation keeps A2A out of funds custody and makes payment integration an approval-gated adapter problem instead of a broker lifecycle state change.

## 2. Non-goals and approval boundary

This contract does not authorize:

- holding, releasing, refunding, or moving funds;
- Stripe, x402, AP2, bank, card-network, or wallet API calls;
- provider sends, Telegram sends, Terminal Brief ACK/replay, DB migration/prune, release/tag/package publication, or secret movement;
- broker or worker deployment/restart to enable payment behavior.

Any live adapter that calls a payment rail requires a separate operator approval, separate credentials, a no-live rehearsal, and a rollback plan.

## 3. Declared completion conditions

Tasks that want a payment-release proof MAY declare `payload.completionConditions`. Absence of this field preserves current task behavior byte-for-byte.

```jsonc
{
  "completionConditions": {
    "schemaVersion": "a2a.completion.conditions.v0",
    "requiredBatteries": ["unit-tests", "contract-conformance"],
    "requiredVerdict": "go",
    "artifactHashRequired": true,
    "externalConditions": [
      {
        "id": "ap2-intent-mandate-condition",
        "kind": "payment-rail-declared-condition",
        "description": "Payment rail condition identifier; evaluated outside A2A Nexus."
      }
    ]
  }
}
```

Rules:

1. `schemaVersion` is required when the object is present.
2. `requiredBatteries[]` names deterministic battery verdicts. A certificate may report missing batteries, but it must not mark the condition met.
3. `requiredVerdict` is currently `"go"` only; a non-`go` or missing judgment verdict fails the condition.
4. `artifactHashRequired=true` requires the certificate subject to bind at least one `sha256:` artifact or result hash.
5. `externalConditions[]` are declarations only. They may be copied into the certificate as unresolved or externally-attested conditions, but A2A does not evaluate them unless a future adapter contract says how.
6. Forward compatibility is fail-closed for required A2A-evaluable conditions: an unknown `conditionResults[].kind` MUST NOT be marked `met` unless a later contract defines that kind. Unknown external rail declarations remain `external-pending` and never authorize release by themselves.

## 4. Completion certificate shape

```jsonc
{
  "schemaVersion": "a2a.completion.certificate.v0",
  "canonicalization": "rfc8785-jcs-v1",
  "subject": {
    "kind": "task-result",
    "taskId": "task-123",
    "workerId": "worker-alpha",
    "resultHash": "sha256:...",
    "artifactHashes": ["sha256:..."]
  },
  "conditions": {
    "schemaVersion": "a2a.completion.conditions.v0",
    "requiredBatteries": ["unit-tests"],
    "requiredVerdict": "go",
    "artifactHashRequired": true,
    "externalConditions": []
  },
  "conditionResults": [
    {
      "id": "battery:unit-tests",
      "kind": "battery",
      "status": "met",
      "evidenceRef": "battery-verdict:unit-tests:sha256:..."
    },
    {
      "id": "judgment:finalizer-go",
      "kind": "finalizer-verdict",
      "status": "met",
      "evidenceRef": "finalizer-verdict:sha256:..."
    },
    {
      "id": "artifact-hash-bound",
      "kind": "artifact-hash",
      "status": "met",
      "evidenceRef": "sha256:..."
    }
  ],
  "decision": "eligible",
  "issuedAt": "2026-07-08T00:00:00Z",
  "expiresAt": "2026-07-15T00:00:00Z",
  "issuer": {
    "kind": "broker",
    "brokerId": "broker-alpha",
    "keyId": "broker:broker-alpha:completion:v1"
  },
  "assurance": {
    "proves": ["condition-evaluation-occurred", "subject-binding", "certificate-integrity"],
    "doesNotProve": ["payment-authorized", "funds-available", "legal-settlement", "analytical-correctness"],
    "disclaimer": "Attests that A2A Nexus evaluated declared task completion conditions for the bound subject. It does not move funds or certify legal payment eligibility."
  },
  "sig": {
    "protected": "...",
    "signature": "..."
  }
}
```

The signature covers `JCS(certificate sans sig)`. The subject must bind the exact task result or artifact hashes used for the condition evaluation so the certificate cannot be replayed against a different task, worker, or artifact. The source-only offline verifier is `scripts/verify-completion-certificate.mjs` (library: `scripts/lib/completion-certificate-verifier.mjs`), with conformance coverage in `test/conformance/check-completion-certificate-verifier.mjs`; it checks integrity and fail-closed semantics only, not payment authorization.

## 5. Condition result semantics

`conditionResults[].status` is one of:

- `met` — condition satisfied with the named evidence;
- `unmet` — condition evaluated and failed;
- `missing` — required evidence was absent;
- `external-pending` — condition belongs to an external payment rail and was not evaluated by A2A.

Certificate `decision` is:

- `eligible` only when all A2A-evaluable required conditions are `met` and all declared external conditions are either absent or explicitly outside A2A evaluation;
- `not-eligible` when an A2A-evaluable required condition is `unmet` or `missing`;
- `external-pending` when the certificate is otherwise eligible but requires an external rail assertion before release.

A payment rail adapter must not treat `external-pending` as release authorization.

## 6. Relationship to existing primitives

| Need | Existing primitive reused |
|---|---|
| Deterministic checks | `kind="battery"` finalizer verdicts in [finalizer-verdict](./finalizer-verdict.md) |
| Independent judgment | `kind="judgment"` finalizer verdicts in [finalizer-verdict](./finalizer-verdict.md) |
| Subject binding | result/artifact hashes already used by signed provenance and verdict gates |
| Offline verification | JCS/JWS verifier primitives in `scripts/lib/a2a-offline-verify.mjs` |
| Blocking before side effects | Existing `approval_required` / verdict gate patterns; no new lifecycle state in v0 |

The certificate composes evidence; it does not invent a new notion of correctness.

## 7. Payment rail adapter interface boundary

A future adapter may expose this TypeScript-shaped boundary:

```ts
export interface PaymentRailAdapter {
  holdEscrow(input: {
    taskId: string;
    amount: { currency: string; value: string };
    conditions: CompletionConditionsV0;
  }): Promise<{ escrowId: string }>;

  releaseEscrow(input: {
    escrowId: string;
    certificate: CompletionCertificateV0;
  }): Promise<{ releaseId: string }>;

  refundEscrow(input: {
    escrowId: string;
    reason: string;
  }): Promise<{ refundId: string }>;
}
```

v0 defines the boundary only. A concrete adapter must be opt-in, rail-specific, credential-isolated, replay-safe, idempotent, and approval-gated.

## 8. Minimum future implementation slices

1. Schema/fixture gate for `completionConditions` and certificate shape. **Landed:** `fixtures/contract/completion-certificate.json` and `test/conformance/check-completion-certificate.mjs`.
2. Offline certificate verifier that checks JCS/JWS signature, subject binding, issuer key, expiry, and assurance invariants. **Landed:** `scripts/verify-completion-certificate.mjs`, `scripts/lib/completion-certificate-verifier.mjs`, and `test/conformance/check-completion-certificate-verifier.mjs`.
3. Report-only certificate generator for completed no-live tasks. **Landed:** `scripts/generate-completion-certificate.mjs`, `scripts/lib/completion-certificate-generator.mjs`, and `test/conformance/check-completion-certificate-generator.mjs`.
4. Only after the above: payment rail adapter rehearsal with fake/no-live rail.
5. Only after explicit approval: live rail integration.

The source-only fixture gate is represented by [`../../fixtures/contract/completion-certificate.json`](../../fixtures/contract/completion-certificate.json) and checked with `node test/conformance/check-completion-certificate.mjs`. It validates decision semantics and safety invariants only; cryptographic signature verification remains slice 2.

## 9. Safety invariants

- A certificate is never a Terminal ACK, read receipt, payment receipt, or legal settlement proof.
- `payment-authorized` and `funds-available` must remain in `assurance.doesNotProve` unless a future external rail proof is added.
- Private payment credentials and account identifiers must never appear in certificates, fixtures, PR bodies, issue comments, or logs.
- Unknown certificate fields must be ignored by readers but preserved by signers only if covered by JCS; enforcement gates should fail closed on unknown required condition kinds.
