# Contract: Certification Battery v0

Issue: [a2a-nexus#1487](https://github.com/jinwon-int/a2a-nexus/issues/1487). Related primitives: [finalizer verdict](./finalizer-verdict.md), [product artifact certificate](./product-artifact-certificate.md), and [completion certificate](./completion-certificate.md).

Status: source-only contract slice. This document defines a deterministic battery pack and result object for pinned software-artifact checks. It does **not** create a badge, hosted registry, certification authority, GitHub Release, npm/Docker publication, CI-OIDC issuer, SLSA/Sigstore reimplementation, TEE path, or live signing-key operation.

## 1. Positioning

A certification battery answers a narrow question:

> Can a third party re-run the same pinned checks against the same pinned artifact and reproduce the same finite battery result?

It does not answer:

> Is this software safe, bug-free, legally compliant, high quality, or broadly endorsed?

That boundary is the load-bearing distinction between deterministic `battery` verdicts and independent `judgment` verdicts in [Finalizer Verdict v1](./finalizer-verdict.md). Battery verdicts can claim reproducibility for pinned checks; judgment verdicts must explicitly disclaim reproducibility.

## 2. Battery pack shape

A battery pack names the deterministic checks, the pinned target profile, and the no-live execution constraints:

```jsonc
{
  "schemaVersion": "a2a.certification-battery.pack.v0",
  "canonicalization": "rfc8785-jcs-v1",
  "batteryId": "mcp-plugin-baseline-public-safe",
  "batteryVersion": "mcp-plugin-baseline-v0",
  "subjectProfile": "public-safe-mcp-plugin",
  "target": {
    "kind": "mcp-plugin",
    "name": "example-public-safe-mcp-plugin",
    "artifactKind": "git-repository",
    "repo": "example/mcp-plugin-fixture",
    "commitSha": "0123456789abcdef0123456789abcdef01234567",
    "artifactHashes": ["sha256:..."]
  },
  "checks": [
    {
      "id": "manifest-schema",
      "kind": "schema",
      "inputRefs": ["plugin-manifest.json"],
      "expected": "pass",
      "reproducible": true,
      "noLive": true
    }
  ],
  "deterministic": true,
  "registryRequired": false,
  "badgeRequired": false,
  "attestationIntegration": {
    "reviewed": ["github-actions-oidc", "sigstore", "slsa"],
    "posture": "reuse-existing-attestation-infra; do-not-reimplement"
  }
}
```

Rules:

1. `deterministic` MUST be `true`.
2. Every check MUST set `reproducible: true` and `noLive: true`.
3. The target MUST include an immutable binding: `commitSha` or at least one `sha256:` artifact hash.
4. Mutable refs may appear only as context; they are never sufficient for verification.
5. A pack MUST NOT contain private repository URLs, credentials, raw local host paths, provider identifiers, or production broker endpoints.

## 3. Battery result shape

A battery result binds one pack run to the exact pack hash and target artifact:

```jsonc
{
  "schemaVersion": "a2a.certification-battery.result.v0",
  "canonicalization": "rfc8785-jcs-v1",
  "packRef": {
    "batteryId": "mcp-plugin-baseline-public-safe",
    "batteryVersion": "mcp-plugin-baseline-v0",
    "packHash": "sha256:..."
  },
  "subject": { "kind": "mcp-plugin", "commitSha": "..." },
  "run": {
    "kind": "fixture-replay",
    "runner": "local-conformance",
    "executedAt": "2026-07-09T00:00:00Z",
    "liveNetwork": false,
    "providerSend": false,
    "registryWrite": false
  },
  "checkResults": [
    { "id": "manifest-schema", "status": "pass", "outputHash": "sha256:..." }
  ],
  "decision": "pass",
  "resultHash": "sha256:..."
}
```

Rules:

1. `packRef.packHash` MUST equal `sha256:JCS(pack)`.
2. `subject` MUST equal the pack target.
3. Every required pack check MUST have exactly one corresponding result.
4. `decision` is `pass` only when every check result is `pass` and all no-live flags remain false/disabled.
5. `resultHash` MUST equal `sha256:JCS(result sans resultHash)`.

## 4. Verdict and certificate composition

The deterministic battery result composes with existing primitives instead of creating a new trust stack:

| Need | Reused primitive |
|---|---|
| Deterministic GO/NO-GO verdict | `finalizer-verdict.md` with `kind: "battery"` |
| Independent non-deterministic review | `finalizer-verdict.md` with `kind: "judgment"` |
| Claim-bound public artifact certification | `product-artifact-certificate.md` |
| Evidence packet / source bundles | `docs/attestation-bundle.md` |
| JCS hashing / offline verification | `scripts/lib/a2a-offline-verify.mjs` |

Battery verdict assurance MUST include `reproducibility` in `proves` and MUST NOT put `reproducibility` in `doesNotProve`. Judgment verdict assurance MUST do the opposite.

## 5. Value without badge or registry

A battery is useful before any public badge/registry exists because a consumer can:

1. read the battery pack,
2. re-run or inspect the same pinned checks,
3. verify the result hash and battery verdict binding,
4. compare the finite claims in a product-artifact certificate,
5. decide whether those finite claims matter for their integration.

A registry or badge may later index already-generated battery results, but it is not needed for the battery to be useful.

## 6. External demand and extraction gate

Repo extraction remains deferred until external demand is recorded. The contract therefore carries a demand-signal ledger rather than pretending that registry demand already exists.

- `extractionReadiness.externalDemandSignals[]` records demand signals and their source.
- Signals may be `operator-roadmap`, `partner-request`, `third-party-adoption`, or `public-issue`.
- A signal with only `operator-roadmap` weight is not enough for extraction.
- `extractionReadiness.decision` MUST remain `defer-extraction-until-external-demand` until at least one external signal is observed.

## 7. v0 boundaries

This v0 slice does not authorize:

- hosted registry, badge, or CA operation;
- package, Docker, npm, marketplace, or GitHub Release publication;
- live CI-OIDC/Sigstore issuance;
- SLSA/Sigstore/TEE reimplementation;
- credential movement, key issuance, key rotation, or private-key printing;
- provider sends, broker/worker deploys/restarts, DB/ACK/replay/prune/migration, or payment-rail integration.

Those require separate operator approval and fresh validation.

## 8. Reference fixture and verifier

The public-safe reference fixture is [`fixtures/contract/certification-battery.json`](../../fixtures/contract/certification-battery.json). The source-only verifier library is `scripts/lib/certification-battery-verifier.mjs`, and the conformance check is:

```bash
node test/conformance/check-certification-battery.mjs
```
