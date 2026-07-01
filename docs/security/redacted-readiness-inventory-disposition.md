# Redacted Readiness Inventory Disposition

Status: source-level disposition for #881 public-readiness review.
Scope: redacted metadata only; this document does **not** include matched values and does **not** replace an external secret/history scanner (`gitleaks` or `trufflehog`).

## Current local inventory

- Command: `node scripts/redacted-readiness-inventory.mjs`
- Result: `ok=true`
- Total redacted metadata findings: `81`
- Matched values: intentionally not printed or copied into this document.

### By kind

| kind | count | disposition |
|---|---:|---|
| `absolute-private-path` | 25 | Allowed only as redacted fixture/config-path metadata. Review before visibility approval; do not publish raw paths. |
| `github-token-shape` | 14 | Synthetic test scanner/token-shape fixtures. Keep as test-only; external scanner must still run clean. |
| `private-topology-term` | 40 | CODEOWNERS/docs/test topology labels. Public-safe only as owner/topology metadata after operator review. |
| `secret-assignment` | 2 | Code paths that reference secret-bearing env/config names, not committed secret values in this inventory output. Keep redacted and externally scan before approval. |

### Files by redacted kind

| file | redacted kind counts | disposition |
|---|---|---|
| `.github/CODEOWNERS` | `private-topology-term`=10 | Ownership/topology metadata; review as public owner-map disclosure before visibility approval. |
| `contracts/a2a/github-evidence-projection.md` | `absolute-private-path`=1 | Documentation/protocol metadata; keep historical context with current-state caveats. |
| `docs/release/repo-protection-baseline.md` | `private-topology-term`=1 | Documentation/protocol metadata; keep historical context with current-state caveats. |
| `examples/workers/hermes-reference-worker/a2a_worker.py` | `secret-assignment`=1 | Example worker env/header handling; verify no literal secret values before visibility approval. |
| `packages/broker/docs/a2a-http-signature-profile-v1.md` | `private-topology-term`=1 | Documentation/protocol metadata; keep historical context with current-state caveats. |
| `packages/broker/docs/phase-8-peer-status-rfc.md` | `private-topology-term`=1 | Documentation/protocol metadata; keep historical context with current-state caveats. |
| `packages/broker/docs/yukson-1032-a2ad-followup-03-review.md` | `private-topology-term`=1 | Documentation/protocol metadata; keep historical context with current-state caveats. |
| `packages/broker/scripts/public-readiness-scan.test.mjs` | `github-token-shape`=1 | Test fixture metadata; keep synthetic/redacted. |
| `packages/broker/scripts/round-coordinator-closeout-dry-run.test.mjs` | `github-token-shape`=2 | Test fixture metadata; keep synthetic/redacted. |
| `packages/broker/src/core/cross-broker-terminal-brief.test.ts` | `absolute-private-path`=1 | Test fixture metadata; keep synthetic/redacted. |
| `packages/broker/src/core/request-security.test.ts` | `private-topology-term`=1 | Test fixture metadata; keep synthetic/redacted. |
| `packages/broker/src/core/task-events.test.ts` | `absolute-private-path`=5 | Test fixture metadata; keep synthetic/redacted. |
| `packages/broker/src/github/handoff-receiver.test.ts` | `github-token-shape`=1 | Test fixture metadata; keep synthetic/redacted. |
| `packages/broker/src/openclaw-handler-artifact.test.ts` | `private-topology-term`=3 | Test fixture metadata; keep synthetic/redacted. |
| `packages/docker-runner/docs/openclaw-cli-provisioning.md` | `absolute-private-path`=1 | Documentation/protocol metadata; keep historical context with current-state caveats. |
| `packages/docker-runner/src/config.test.ts` | `absolute-private-path`=1 | Test fixture metadata; keep synthetic/redacted. |
| `packages/docker-runner/src/config.ts` | `secret-assignment`=1 | Source/config scanner pattern metadata; review before visibility approval. |
| `packages/docker-runner/src/github-evidence.test.ts` | `github-token-shape`=3 | Test fixture metadata; keep synthetic/redacted. |
| `packages/docker-runner/src/runner-manifest.test.ts` | `github-token-shape`=1 | Test fixture metadata; keep synthetic/redacted. |
| `packages/docker-runner/src/scanner.test.ts` | `absolute-private-path`=1, `github-token-shape`=6 | Test fixture metadata; keep synthetic/redacted. |
| `packages/docker-runner/src/task-normalizer.test.ts` | `private-topology-term`=22 | Test fixture metadata; keep synthetic/redacted. |
| `packages/openclaw-plugin-a2a/src/metadata-roundtrip.test.ts` | `absolute-private-path`=2 | Test fixture metadata; keep synthetic/redacted. |
| `packages/openclaw-plugin-a2a/test/operator-event-bridge.test.mjs` | `absolute-private-path`=7 | Test fixture metadata; keep synthetic/redacted. |
| `packages/openclaw-plugin-a2a/tests/cross-broker-terminal-relay.test.ts` | `absolute-private-path`=1 | Test fixture metadata; keep synthetic/redacted. |
| `packages/openclaw-plugin-a2a/tests/github-evidence-projection.test.ts` | `absolute-private-path`=1 | Test fixture metadata; keep synthetic/redacted. |
| `scripts/a2a-source-dryrun-aggregator.test.mjs` | `absolute-private-path`=1 | Test fixture metadata; keep synthetic/redacted. |
| `scripts/a2a-source-public-approval-rehearsal.test.mjs` | `absolute-private-path`=1 | Test fixture metadata; keep synthetic/redacted. |
| `scripts/a2a-source-public-execution-orchestrator.test.mjs` | `absolute-private-path`=1 | Test fixture metadata; keep synthetic/redacted. |
| `scripts/a2a-source-public-final-go-nogo-gate.test.mjs` | `absolute-private-path`=1 | Test fixture metadata; keep synthetic/redacted. |

## Operator gates that remain outside this PR

- Run `npm run scan:external-secrets` with a supported external scanner installed (`gitleaks` or `trufflehog`) and record clean, redacted evidence.
- Obtain explicit operator approval before any GitHub visibility change (`private -> public`).
- Re-run `npm run scan:public-readiness`, `node scripts/redacted-readiness-inventory.mjs`, and the external scanner immediately before approval.

## Closeout note for #881

This disposition closes the PR-addressable redacted-inventory documentation slice only. It does not close #881 by itself because external scanner evidence and explicit visibility approval remain separate gates.
