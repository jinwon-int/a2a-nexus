# Agent Work Proof Bundle v0

Issue: [a2a-nexus#1481](https://github.com/jinwon-int/a2a-nexus/issues/1481). Related primitives: [finalizer verdict](./finalizer-verdict.md), [verifiable analysis report](./verifiable-analysis-report.md), [certification battery](./certification-battery.md), and [completion certificate](./completion-certificate.md).

`a2a-agent-work-proof` answers one narrow question:

> Did this bound agent task produce a hash-bound, signed, offline-verifiable evidence bundle that a third party can check without our broker, dashboard, provider credentials, private logs, or live services?

It does **not** prove the analysis is correct, generally safe, legally settled, payment-authorized, or that a judgment verdict is deterministically reproducible.

## 1. Source-only scope

The v0 bundle is a composition layer over existing A2A Nexus proof primitives. It does not introduce a new trust root.

A valid source-only bundle includes:

1. a verifiable analysis report product package;
2. a deterministic certification battery fixture/result/verdict package;
3. a signed completion certificate for the bound task subject;
4. an artifact manifest that hashes the included proof artifacts;
5. a signed work-proof finalizer verdict that binds the manifest and evidence hashes;
6. explicit public-safety and extraction-boundary flags.

The local fixture is [`../../fixtures/contract/agent-work-proof-bundle.json`](../../fixtures/contract/agent-work-proof-bundle.json), with public-key-only keyring [`../../fixtures/contract/agent-work-proof-keyring.json`](../../fixtures/contract/agent-work-proof-keyring.json).

## 2. Bundle schema

```json
{
  "schemaVersion": "a2a.agent-work-proof.bundle.v0",
  "canonicalization": "rfc8785-jcs-v1",
  "proofId": "sample-agent-work-proof-source-only-001",
  "sourceOnly": true,
  "noLive": true,
  "task": {
    "taskId": "sample-verifiable-analysis-report-dogfood-001",
    "workerId": "worker:sample-analysis",
    "resultHash": "sha256:...",
    "intent": "analyze",
    "mode": "analysis-only",
    "artifactHashes": ["sha256:...", "sha256:..."]
  },
  "evidenceHashes": {
    "reportProductHash": "sha256:JCS(evidence.reportProduct)",
    "certificationBatteryHash": "sha256:JCS(evidence.certificationBattery)",
    "completionCertificateHash": "sha256:JCS(evidence.completionCertificate)"
  },
  "artifactManifestHash": "sha256:JCS(artifactManifest)",
  "artifactManifest": { "schemaVersion": "a2a.agent-work-proof.artifactManifest.v0" },
  "evidence": {
    "reportProduct": { "schemaVersion": "a2a.verifiable-analysis-report.product.v0" },
    "certificationBattery": { "meta": { "schemaVersion": "a2a.certification-battery.fixture.v0" } },
    "completionCertificate": { "schemaVersion": "a2a.completion.certificate.v0" }
  },
  "workProofVerdict": { "schemaVersion": "a2a.finalizer.verdict.v1" }
}
```

All hashes use the shared RFC 8785/JCS primitive from `scripts/lib/a2a-offline-verify.mjs`.

## 3. Verification rules

The offline verifier is:

```bash
node scripts/verify-agent-work-proof.mjs \
  fixtures/contract/agent-work-proof-bundle.json \
  --keyring fixtures/contract/agent-work-proof-keyring.json \
  --json
```

It fails closed unless all of these pass:

- bundle `schemaVersion`, `canonicalization`, `sourceOnly`, and `noLive`;
- `task` matches the embedded report task id, worker key id, and result provenance hash;
- `evidenceHashes.*` equal `sha256:JCS(...)` of the embedded proof artifacts;
- embedded verifiable analysis report product verifies green;
- embedded certification battery verifies green;
- embedded completion certificate verifies green with an exact expected subject;
- artifact manifest contains exactly the report product, certification battery, and completion certificate artifacts with matching hashes;
- work-proof finalizer verdict verifies as `kind="judgment"`, `decision="go"`, and exact subject-bound to all evidence hashes plus `artifactManifestHash`;
- public-safety flags and string scans do not show private paths, raw logs, tokens, provider IDs, Telegram IDs, or private keys;
- extraction remains deferred until external demand.

## 4. Public safety invariants

The v0 fixture must remain safe to commit and quote in public issue/PR closeout:

- no host-private paths or runtime bootstrap files;
- no raw session dumps or provider payload logs;
- no provider tokens, GitHub tokens, edge secrets, or private keys;
- no Telegram IDs or private operator account identifiers;
- no release, registry write, badge publication, dashboard launch, deploy/restart, provider send, database mutation, ACK/replay, visibility change, or live broker fetch.

The keyring fixture contains public keys only. Private keys used to create the synthetic fixture are never written to the repository.

## 5. Assurance boundary

Agent work proof proves:

- evidence artifacts were bundled;
- hashes and signatures bind the bundle to a task subject;
- offline verification can replay the integrity checks without broker/API/token access.

Agent work proof does **not** prove:

- analytical correctness;
- general safety or absence of all vulnerabilities;
- deterministic reproducibility of judgment verdicts;
- payment authorization, funds availability, or legal settlement;
- registry, badge, marketplace, or release approval.

## 6. Extraction boundary

The v0 fixture has value without any registry or badge because a third party can verify it locally. Standalone repo extraction, SDK publication, GitHub Actions examples, badges, registry, and external promotion remain separate approval-gated slices and should wait for an external demand signal.
