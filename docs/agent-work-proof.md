# Agent work proof

**Do not ask a reader to believe that an agent did the work. Give them a local bundle that proves what was produced, how it is bound, and what it does not prove.**

`a2a-agent-work-proof` is the composition product above the existing A2A proof primitives. It packages a verifiable analysis report, deterministic battery result, completion certificate, artifact manifest, and signed work-proof verdict so a third party can verify the task evidence without your broker, dashboard, provider account, private logs, or secrets.

## 30-second model

1. **Report:** the agent produced a source-grounded report with provenance.
2. **Battery:** deterministic checks ran against pinned artifacts.
3. **Completion certificate:** declared completion conditions were evaluated for the bound task subject.
4. **Manifest:** every proof artifact is content-hashed.
5. **Work-proof verdict:** an independent judgment signs the exact task/evidence hash set.
6. **Verifier:** `verify-agent-work-proof.mjs` replays all of the above offline and fails closed on tampering.

## Verify the sample bundle

```bash
node scripts/verify-agent-work-proof.mjs \
  fixtures/contract/agent-work-proof-bundle.json \
  --keyring fixtures/contract/agent-work-proof-keyring.json \
  --json
```

Expected result:

```json
{
  "green": true,
  "proofId": "sample-agent-work-proof-source-only-001"
}
```

The conformance wrapper is:

```bash
node test/conformance/check-agent-work-proof.mjs
```

It also mutates the fixture to confirm fail-closed behavior for:

- source-only flag violations;
- evidence hash tampering;
- report product tampering;
- certification battery tampering;
- completion certificate subject/signature mismatch;
- artifact manifest safety and artifact-list mismatch;
- work-proof verdict subject/key mismatch;
- extraction boundary drift;
- private path leakage.

## What the sample proves

The fixture demonstrates that a third party can verify:

| Evidence | Bound by | Offline verifier |
|---|---|---|
| verifiable analysis report product | report hash, artifact manifest hash, finalizer verdict | `verifyAnalysisReportProductPackage` |
| certification battery fixture | pack/result hashes, battery verdict, product artifact certificate | `verifyCertificationBatteryBundle` |
| completion certificate | signed certificate, exact task subject, decision semantics | `verifyCompletionCertificate` |
| work-proof bundle | artifact manifest hash + all evidence hashes + signed verdict | `verifyAgentWorkProofBundle` |

## What it does not prove

The bundle is intentionally honest about non-claims:

- analytical correctness;
- general safety;
- absence of all vulnerabilities;
- legal settlement;
- payment authorization or funds availability;
- deterministic reproducibility of judgment verdicts;
- registry, badge, release, marketplace, or public-promotion approval.

## Source-only boundary

This slice is only contract + fixture + offline verifier + conformance. It does not:

- create a new repository;
- publish an npm package, Docker image, tag, release, registry entry, or badge;
- launch a broker dashboard;
- fetch live broker data;
- deploy/restart brokers, workers, Gateway, or Docker runners;
- mutate DB/outbox/ACK/replay/prune/migration state;
- send provider/Telegram messages;
- move, expose, or require secrets/private keys;
- change repository visibility.

The fixture keyring contains public keys only. Synthetic private keys are generated in a temporary fixture builder and never committed.

## Extraction posture

The current decision is `defer-extraction-until-external-demand`. The sample bundle has standalone value because it is locally verifiable, but SDK publication, Actions examples, registry/badge work, and standalone repo extraction should remain separate approval-gated slices.
