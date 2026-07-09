# Verifiable analysis report

**Do not ask a reader to trust an analysis report. Give them a file they can verify offline.**

`a2a-verifiable-analysis-report` is the smallest extractable product slice from A2A Nexus: a source-grounded analysis result, the frozen source snapshots it cites, an artifact manifest, and a signed finalizer verdict that a third party can check without your broker, dashboard, worker fleet, private logs, provider IDs, or secrets.

In 30 seconds:

1. A worker produces an analysis result that cites frozen source snapshots by `contentHash`.
2. The result carries provenance, worker signature, and broker countersignature.
3. The product package records `reportHash = sha256:JCS(report)` and an artifact manifest for the files a recipient receives.
4. A finalizer signs a GO/NO-GO verdict over the exact `reportHash` and `artifactManifestHash`.
5. The recipient runs one local command; every check passes or the package is RED.

This is a proof artifact, not a correctness oracle. A GREEN package proves source grounding, integrity, and finalizer-review occurrence. It does **not** prove the analysis is correct, judgment is reproducible, or a release/publish/deploy is approved.

## Verify the public-safe sample

The sample fixtures are synthetic and source-only:

- Product package: [`../fixtures/contract/verifiable-analysis-report-product.json`](../fixtures/contract/verifiable-analysis-report-product.json)
- Public keyring: [`../fixtures/contract/verifiable-analysis-report-product-keyring.json`](../fixtures/contract/verifiable-analysis-report-product-keyring.json)

```bash
node scripts/verify-analysis-report.mjs \
  fixtures/contract/verifiable-analysis-report-product.json \
  --keyring fixtures/contract/verifiable-analysis-report-product-keyring.json \
  --product \
  --json
```

Expected shape:

```json
{
  "green": true,
  "checks": [
    { "id": "report-verifier", "ok": true },
    { "id": "report-hash", "ok": true },
    { "id": "artifact-manifest-hash", "ok": true },
    { "id": "artifact-manifest-report-artifact", "ok": true },
    { "id": "artifact-manifest-public-safety", "ok": true },
    { "id": "finalizer-verdict", "ok": true },
    { "id": "public-safe-report", "ok": true }
  ]
}
```

The conformance shortcut is:

```bash
node test/conformance/check-verifiable-analysis-report-product.mjs
npm run test:conformance
```

## What the product package verifies

| Check | What it proves | What it does not prove |
|---|---|---|
| `report-verifier` | The embedded [`verifiable-analysis-report/v1`](../contracts/a2a/verifiable-analysis-report.md) passes offline provenance, source snapshot, and source-binding checks. | The analysis is correct. |
| `report-hash` | `reportHash` equals `sha256:JCS(report)`. | The report is complete for every possible downstream use. |
| `artifact-manifest-hash` | `artifactManifestHash` equals `sha256:JCS(artifactManifest)`. | The files were published or released. |
| `artifact-manifest-report-artifact` | The manifest includes the report artifact bound to `reportHash`. | The manifest is an installer, package registry entry, or release note. |
| `artifact-manifest-public-safety` | The manifest declares no private paths, raw logs, tokens, or provider IDs. | A replacement package is safe if it skips scans. |
| `finalizer-verdict` | A signed GO verdict is subject-bound to the exact report and manifest hashes. | The finalizer judgment is deterministic or infallible. |
| `public-safe-report` | The sample report/manifest string leaves avoid obvious private paths and token forms. | A live run is safe without fresh redaction gates. |

## Source-only boundary

This sample and verifier do **not**:

- create a live broker dashboard;
- fetch live source data;
- restart or deploy broker/Gateway/worker services;
- mutate DB/outbox/ACK/replay/prune/migration state;
- send provider/Telegram notifications;
- create tags, GitHub Releases, npm packages, Docker images, or registry entries;
- move, rotate, disclose, or embed private key material.

Future extraction into a standalone repository, CLI package, static viewer, registry, badge, release, or public promotion remains separately approval-gated.
