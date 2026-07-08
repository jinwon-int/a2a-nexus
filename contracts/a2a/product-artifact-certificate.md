# Contract: Product Artifact Certificate v0

Issue: [a2a-nexus#1385](https://github.com/jinwon-int/a2a-nexus/issues/1385). Related primitives: [finalizer verdict](./finalizer-verdict.md), [attestation bundle](../../docs/attestation-bundle.md), and [completion certificate](./completion-certificate.md).

Status: source-only contract slice. This document defines the certificate object for independently attesting finite, reproducible claims about a pinned software artifact. It does **not** implement a hosted registry, package publication, CI-OIDC issuance, TEE execution, or any live signing-key operation.

## 1. Positioning

A2A Nexus product certification is a **claim-bound evidence layer**, not a general quality badge.

The certificate says:

> A named attester ran pinned batteries and/or an independent finalizer review against this exact artifact, and the listed finite claims had the recorded outcomes.

It does not say:

> This product is safe, bug-free, legally compliant, or generally high quality.

That distinction is load-bearing for #1385. The product surface is useful only if consumers can verify exactly what was checked, against which artifact hash, by which attested environment, with which limits.

## 2. Subject and artifact binding

A certificate subject MUST bind to immutable artifact identifiers:

```jsonc
{
  "subject": {
    "kind": "product-artifact",
    "name": "example-mcp-server",
    "artifactKind": "git-repository",
    "repo": "owner/name",
    "ref": "refs/tags/v1.2.3",
    "commitSha": "0123456789abcdef0123456789abcdef01234567",
    "artifactHashes": ["sha256:..."]
  }
}
```

Rules:

1. `kind` is always `"product-artifact"` for this contract.
2. At least one immutable binding is required: `commitSha` for Git artifacts, or one or more `sha256:` `artifactHashes` for built artifacts.
3. Mutable refs such as branch names may appear only as context; they are never sufficient for verification.
4. A certificate MUST NOT contain private repository URLs, credentials, account identifiers, or raw host-specific paths.

## 3. Claim vocabulary

Each claim is finite and battery-shaped. A v0 certificate MAY use these claim kinds:

| Claim kind | Meaning | Example evidence |
|---|---|---|
| `dependency-provenance` | dependency/SBOM checks ran against the artifact | SBOM hash, vulnerability scan battery |
| `secret-scan` | configured secret patterns found no unredacted secret in scanned paths | scanner battery verdict |
| `capability-boundary` | declared runtime capabilities were compared with observed/static evidence | declared-vs-observed battery |
| `egress-boundary` | network egress claims were tested or statically checked within the stated scope | egress battery |
| `reproducible-build` | build output hash reproduced under the stated environment | build battery |
| `independent-review` | a judgment verdict reviewed the artifact and evidence packet | finalizer verdict |

Unknown claim kinds are allowed for forward compatibility only when they carry `status: "not-evaluated"`. A verifier MUST fail closed if an unknown claim is marked `pass`.

## 4. Certificate shape

```jsonc
{
  "schemaVersion": "a2a.product-artifact.certificate.v0",
  "canonicalization": "rfc8785-jcs-v1",
  "subject": {
    "kind": "product-artifact",
    "name": "example-mcp-server",
    "artifactKind": "git-repository",
    "repo": "owner/name",
    "commitSha": "0123456789abcdef0123456789abcdef01234567",
    "artifactHashes": ["sha256:..."]
  },
  "batteryVersion": "mcp-plugin-baseline-v0",
  "claims": [
    {
      "id": "secret-scan:no-high-confidence-findings",
      "kind": "secret-scan",
      "status": "pass",
      "evidenceRef": "attestation-bundle:sha256:...",
      "scope": ["src/**", "package.json"],
      "limitations": ["patterns-only", "does-not-prove-absence-of-all-secrets"]
    },
    {
      "id": "review:independent-finalizer",
      "kind": "independent-review",
      "status": "pass",
      "evidenceRef": "finalizer-verdict:sha256:...",
      "limitations": ["judgment-not-reproducible"]
    }
  ],
  "decision": "certified",
  "issuedAt": "2026-07-08T00:00:00Z",
  "expiresAt": "2026-10-08T00:00:00Z",
  "issuer": {
    "kind": "attested-environment",
    "attesterSubject": "repo:owner/certifier:workflow_ref:..."
  },
  "assurance": {
    "proves": ["claim-evaluation-occurred", "subject-binding", "certificate-integrity"],
    "doesNotProve": ["general-safety", "bug-free", "legal-compliance", "marketplace-approval", "absence-of-all-vulnerabilities"],
    "disclaimer": "Attests finite claim outcomes for a pinned artifact. It is not a general quality, safety, or legal certification."
  },
  "sig": { "protected": "...", "signature": "..." }
}
```

The signature covers `JCS(certificate sans sig)`. The issuer may be a static certificate key or an attested CI/OIDC identity, following the same trust split described in the finalizer verdict contract.

## 5. Decision semantics

Certificate `decision` is:

- `certified` — every required known claim is `pass` and the certificate passes integrity checks;
- `not-certified` — at least one required known claim is `fail` or `missing`;
- `partial` — optional claims passed but the required profile was not complete;
- `not-evaluated` — the artifact binding was recorded but no certification claim was evaluated.

A consumer MUST display `partial` and `not-evaluated` as non-certifying states.

## 6. Relationship to existing A2A primitives

| Need | Existing primitive reused |
|---|---|
| Artifact/result integrity | `sha256:` result and artifact hashes |
| Deterministic check outcomes | `kind="battery"` finalizer verdicts |
| Independent review | `kind="judgment"` finalizer verdicts |
| Evidence packaging | `docs/attestation-bundle.md` |
| Offline verification | JCS/JWS verifier primitives in `scripts/lib/a2a-offline-verify.mjs` |
| Payment release proof | `completion-certificate.md` composes these claims only after task completion |

The product certificate is deliberately a composition layer. It does not create a new signing stack or move broker trust into product marketing.

## 7. v0 boundaries

This v0 slice does not authorize:

- hosted registry or badge publication;
- package, Docker, npm, marketplace, or release publication;
- live CI-OIDC/Sigstore issuance;
- TEE execution or closed-source inspection;
- credential movement, key issuance, key rotation, or private-key printing;
- provider sends, broker/worker deploys/restarts, DB/ACK/replay/prune/migration, or payment-rail integration.

Those are separate operator-approved lanes.

## 8. Minimum future implementation slices

1. JSON schema + fixture checker for `a2a.product-artifact.certificate.v0`.
2. Offline verifier that checks JCS/JWS integrity, subject binding, issuer allowlist, expiry, and assurance invariants.
3. Report-only generator for public GitHub repositories at pinned commits.
4. Optional badge/registry prototype using only already-generated certificates.
5. Only after explicit approval: live attested issuance workflow or TEE/private-code variants.
