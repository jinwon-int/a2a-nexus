# Script retirement inventory — 2026-07

Source-only discovery inventory for issue #1288 work unit 1. This document classifies the current release-gate manifest entries plus `scripts/archive/*.mjs` before any default-path downgrade, deletion, or budget ratchet. The inventory is de-duplicated in the summary row count, but the two detailed sections below cover **all 64 manifest entries** and **all 40 archive files** explicitly.

## Scope and safety

- Scope: inventory only; no file deletion, no manifest downgrade, no script-budget ratchet, no broker test rewrite.
- Boundary: this is a source-only PR artifact. It performs no release/tag/package publication, deploy/restart, provider send, database mutation, or GitHub settings mutation.
- Conservative rule: entries without an explicit round marker (`rNN`, `rNNb`) or manifest `class: round` stay `unknown / keep by default` until a later PR proves safe downgrade.

## RED evidence before inventory

```text
docs/ops/script-retirement-inventory-2026-07.md: absent
node scripts/run-release-gate.mjs --list: 64 active test file(s)
active entries under scripts/archive/: 37
obvious rNN round entries in default list: 24
```

## Summary

| Surface | Count | Notes |
|---|---:|---|
| release-gate manifest entries | 64 | `scripts/release-gate-manifest.json` active list before any downgrade |
| archive files | 40 | `scripts/archive/*.mjs` |
| de-duplicated inventory rows | 67 | 64 manifest entries plus 3 archive-only files; archive detail section still lists all 40 archive files |
| completed historical round verification | 19 | candidate pool for work unit 2 opt-in downgrade; no deletion implied |
| live gate | 27 | keep in default path unless a later owner proves otherwise |
| unknown / keep by default | 21 | conservative hold; needs source review before downgrade |

## Release-gate manifest classification

| File | Manifest class | Classification | Target round / reason |
|---|---|---|---|
| `scripts/check-dependency-advisories.test.mjs` | `gate` | live gate | current default manifest gate |
| `scanner/readiness/fail-closed-gates.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-compatibility-baselines.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/libero-public-preflight-closeout.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-no-diff-closeout-guidance.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/lib/a2ad-preset-ux-contract.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-quickstart-conformance.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-external-harness-conformance.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-message-id-ack-boundary.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/archive/check-team1-source-public-readiness-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-evidence-nochange-hardening-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-public-approval-packet-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-dryrun-orchestrator-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-public-approval-rehearsal-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/a2a-source-public-approval-rehearsal.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/archive/check-team1-workerDelta-source-public-approval-rehearsal-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/check-team2-source-public-approval-rehearsal.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/archive/check-team1-source-public-execution-orchestrator-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-parent-round-dispatch-guardrails-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/a2a-source-public-execution-orchestrator.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/a2a-spec-first-taskflow-runtime.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/archive/check-team2-final-go-no-go-semantics-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-ops-stability-standards-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-terminal-brief-activation-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team2-terminal-brief-activation-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-config-schema-skew-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team2-config-schema-parity-libero.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/round-merge-preflight.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/archive/check-team1-workerDelta-public-readiness-after-78261-close.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-public-readiness-gate-synthesis.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-db-lifecycle-cleanup-go-nogo.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/check-a2a-allhands-stability-closeout-gates.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/archive/check-team1-workerDelta-plane-gates-527-497-294.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-plane-gates-527-497-294-r22-lightweight.test.mjs` | `round` | completed historical round verification | R22 |
| `scripts/archive/check-team2-workerEta-stability-r7-risk-review.test.mjs` | `round` | completed historical round verification | R7 |
| `scripts/archive/check-team2-workerEta-r9-concise-terminal-brief-runtime-readiness.test.mjs` | `round` | completed historical round verification | R9 |
| `scripts/archive/check-team2-workerEta-r9b-terminal-brief-activation-readiness.test.mjs` | `round` | completed historical round verification | R9B |
| `scripts/archive/check-team2-workerEta-r8-ops-dashboard-readiness.test.mjs` | `round` | completed historical round verification | R8 |
| `scripts/archive/check-team2-workerEta-r11-libero-cross-team-risk-review.test.mjs` | `round` | completed historical round verification | R11 |
| `scripts/archive/check-team2-workerEta-r12-libero-cross-team-origin-routing-risk-review.test.mjs` | `round` | completed historical round verification | R12 |
| `scripts/archive/check-team2-workerEta-r13-terminal-brief-realround-libero.test.mjs` | `round` | completed historical round verification | R13 |
| `scripts/archive/check-team2-workerEta-r15-structured-terminal-brief-libero.test.mjs` | `round` | completed historical round verification | R15 |
| `scripts/archive/check-team1-workerDelta-r15-allhands-structured-terminal-brief-lane.test.mjs` | `round` | completed historical round verification | R15 |
| `scripts/archive/check-team2-workerEta-r16-terminal-brief-libero.test.mjs` | `round` | completed historical round verification | R16 |
| `scripts/archive/check-team2-workerEta-r20-libero-go-nogo-retry.test.mjs` | `round` | completed historical round verification | R20 |
| `scripts/archive/check-team2-workerEta-r22-broker-lightweight-libero.test.mjs` | `round` | completed historical round verification | R22 |
| `scripts/archive/check-team2-workerEta-r23-terminal-brief-taskflow-monorepo-libero.test.mjs` | `round` | completed historical round verification | R23 |
| `scripts/archive/check-team1-workerGamma-r25-ops-readiness-terminal-brief.test.mjs` | `round` | completed historical round verification | R25 |
| `scripts/archive/check-team1-workerDelta-r25-team2-terminal-brief-ops-readiness-libero.test.mjs` | `round` | completed historical round verification | R25 |
| `scripts/archive/check-team1-workerDelta-r27-canary-hardening-libero.test.mjs` | `round` | completed historical round verification | R27 |
| `scripts/check-team1-dispatch-wrapper-runbook.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/archive/check-team1-workerAlpha-residue-cleanup-go-nogo.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-go-nogo-evidence-pack.test.mjs` | `gate` | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/a2a-worker-readiness-preflight.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/a2a-skill-guard.test.mjs` | `gate` | live gate | current default manifest gate |
| `test/conformance/check-terminal-evidence-state-machine.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-runtime-hardening-docs.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-issue-closeout-hygiene.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-disposition-references.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-round-quality-scorecard.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-workflow-permissions.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-workflow-action-pinning.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/a2a-warn-log-aggregate.test.mjs` | `gate` | live gate | current default manifest gate |
| `scripts/check-release-gate-manifest-coverage.test.mjs` | `gate` | live gate | current default manifest gate |

## Archive file classification

| File | Manifest status | Classification | Target round / reason |
|---|---|---|---|
| `scripts/archive/check-team1-config-schema-skew-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-evidence-nochange-hardening-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-ops-stability-standards-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-dryrun-orchestrator-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-parent-round-dispatch-guardrails-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-public-approval-packet-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-public-approval-rehearsal-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-public-execution-orchestrator-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-public-readiness-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerAlpha-residue-cleanup-go-nogo.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-concise-brief-r9.test.mjs` | archive-only | completed historical round verification | R9 |
| `scripts/archive/check-team1-workerDelta-db-lifecycle-cleanup-go-nogo.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-go-nogo-evidence-pack.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-plane-gates-527-497-294-r22-lightweight.test.mjs` | listed in release-gate manifest | completed historical round verification | R22 |
| `scripts/archive/check-team1-workerDelta-plane-gates-527-497-294.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-public-readiness-after-78261-close.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-public-readiness-gate-synthesis.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-r15-allhands-structured-terminal-brief-lane.test.mjs` | listed in release-gate manifest | completed historical round verification | R15 |
| `scripts/archive/check-team1-workerDelta-r25-team2-terminal-brief-ops-readiness-libero.test.mjs` | listed in release-gate manifest | completed historical round verification | R25 |
| `scripts/archive/check-team1-workerDelta-r27-canary-hardening-libero.test.mjs` | listed in release-gate manifest | completed historical round verification | R27 |
| `scripts/archive/check-team1-workerDelta-source-public-approval-rehearsal-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-terminal-brief-activation-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-terminal-brief-live-activation-checklist.test.mjs` | archive-only | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerGamma-r25-ops-readiness-terminal-brief.test.mjs` | listed in release-gate manifest | completed historical round verification | R25 |
| `scripts/archive/check-team1-workerGamma-r26-no-live-terminal-brief-integration-rehearsal.test.mjs` | archive-only | completed historical round verification | R26 |
| `scripts/archive/check-team2-config-schema-parity-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team2-final-go-no-go-semantics-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team2-terminal-brief-activation-libero.test.mjs` | listed in release-gate manifest | unknown / keep by default | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team2-workerEta-r11-libero-cross-team-risk-review.test.mjs` | listed in release-gate manifest | completed historical round verification | R11 |
| `scripts/archive/check-team2-workerEta-r12-libero-cross-team-origin-routing-risk-review.test.mjs` | listed in release-gate manifest | completed historical round verification | R12 |
| `scripts/archive/check-team2-workerEta-r13-terminal-brief-realround-libero.test.mjs` | listed in release-gate manifest | completed historical round verification | R13 |
| `scripts/archive/check-team2-workerEta-r15-structured-terminal-brief-libero.test.mjs` | listed in release-gate manifest | completed historical round verification | R15 |
| `scripts/archive/check-team2-workerEta-r16-terminal-brief-libero.test.mjs` | listed in release-gate manifest | completed historical round verification | R16 |
| `scripts/archive/check-team2-workerEta-r20-libero-go-nogo-retry.test.mjs` | listed in release-gate manifest | completed historical round verification | R20 |
| `scripts/archive/check-team2-workerEta-r22-broker-lightweight-libero.test.mjs` | listed in release-gate manifest | completed historical round verification | R22 |
| `scripts/archive/check-team2-workerEta-r23-terminal-brief-taskflow-monorepo-libero.test.mjs` | listed in release-gate manifest | completed historical round verification | R23 |
| `scripts/archive/check-team2-workerEta-r8-ops-dashboard-readiness.test.mjs` | listed in release-gate manifest | completed historical round verification | R8 |
| `scripts/archive/check-team2-workerEta-r9-concise-terminal-brief-runtime-readiness.test.mjs` | listed in release-gate manifest | completed historical round verification | R9 |
| `scripts/archive/check-team2-workerEta-r9b-terminal-brief-activation-readiness.test.mjs` | listed in release-gate manifest | completed historical round verification | R9B |
| `scripts/archive/check-team2-workerEta-stability-r7-risk-review.test.mjs` | listed in release-gate manifest | completed historical round verification | R7 |

## Work unit 2 candidate set

These entries are candidates for opt-in historical downgrade in a later PR. They are not deleted here.

| File | Reason |
|---|---|
| `scripts/archive/check-team1-workerDelta-plane-gates-527-497-294-r22-lightweight.test.mjs` | R22 |
| `scripts/archive/check-team2-workerEta-stability-r7-risk-review.test.mjs` | R7 |
| `scripts/archive/check-team2-workerEta-r9-concise-terminal-brief-runtime-readiness.test.mjs` | R9 |
| `scripts/archive/check-team2-workerEta-r9b-terminal-brief-activation-readiness.test.mjs` | R9B |
| `scripts/archive/check-team2-workerEta-r8-ops-dashboard-readiness.test.mjs` | R8 |
| `scripts/archive/check-team2-workerEta-r11-libero-cross-team-risk-review.test.mjs` | R11 |
| `scripts/archive/check-team2-workerEta-r12-libero-cross-team-origin-routing-risk-review.test.mjs` | R12 |
| `scripts/archive/check-team2-workerEta-r13-terminal-brief-realround-libero.test.mjs` | R13 |
| `scripts/archive/check-team2-workerEta-r15-structured-terminal-brief-libero.test.mjs` | R15 |
| `scripts/archive/check-team1-workerDelta-r15-allhands-structured-terminal-brief-lane.test.mjs` | R15 |
| `scripts/archive/check-team2-workerEta-r16-terminal-brief-libero.test.mjs` | R16 |
| `scripts/archive/check-team2-workerEta-r20-libero-go-nogo-retry.test.mjs` | R20 |
| `scripts/archive/check-team2-workerEta-r22-broker-lightweight-libero.test.mjs` | R22 |
| `scripts/archive/check-team2-workerEta-r23-terminal-brief-taskflow-monorepo-libero.test.mjs` | R23 |
| `scripts/archive/check-team1-workerGamma-r25-ops-readiness-terminal-brief.test.mjs` | R25 |
| `scripts/archive/check-team1-workerDelta-r25-team2-terminal-brief-ops-readiness-libero.test.mjs` | R25 |
| `scripts/archive/check-team1-workerDelta-r27-canary-hardening-libero.test.mjs` | R27 |
| `scripts/archive/check-team1-workerDelta-concise-brief-r9.test.mjs` | R9 |
| `scripts/archive/check-team1-workerGamma-r26-no-live-terminal-brief-integration-rehearsal.test.mjs` | R26 |

## Work unit 2 hold set

These entries remain default/unknown until a later PR proves they are not live gates.

| File | Reason |
|---|---|
| `scripts/check-dependency-advisories.test.mjs` | live gate in current manifest |
| `scanner/readiness/fail-closed-gates.test.mjs` | live gate in current manifest |
| `scripts/check-compatibility-baselines.test.mjs` | live gate in current manifest |
| `scripts/libero-public-preflight-closeout.test.mjs` | live gate in current manifest |
| `scripts/check-no-diff-closeout-guidance.test.mjs` | live gate in current manifest |
| `scripts/lib/a2ad-preset-ux-contract.test.mjs` | live gate in current manifest |
| `scripts/check-quickstart-conformance.test.mjs` | live gate in current manifest |
| `scripts/check-external-harness-conformance.test.mjs` | live gate in current manifest |
| `scripts/check-message-id-ack-boundary.test.mjs` | live gate in current manifest |
| `scripts/archive/check-team1-source-public-readiness-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-evidence-nochange-hardening-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-public-approval-packet-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-dryrun-orchestrator-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-public-approval-rehearsal-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/a2a-source-public-approval-rehearsal.test.mjs` | live gate in current manifest |
| `scripts/archive/check-team1-workerDelta-source-public-approval-rehearsal-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/check-team2-source-public-approval-rehearsal.test.mjs` | live gate in current manifest |
| `scripts/archive/check-team1-source-public-execution-orchestrator-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-source-parent-round-dispatch-guardrails-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/a2a-source-public-execution-orchestrator.test.mjs` | live gate in current manifest |
| `scripts/a2a-spec-first-taskflow-runtime.test.mjs` | live gate in current manifest |
| `scripts/archive/check-team2-final-go-no-go-semantics-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-ops-stability-standards-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-terminal-brief-activation-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team2-terminal-brief-activation-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-config-schema-skew-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team2-config-schema-parity-libero.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/round-merge-preflight.test.mjs` | live gate in current manifest |
| `scripts/archive/check-team1-workerDelta-public-readiness-after-78261-close.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-public-readiness-gate-synthesis.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-db-lifecycle-cleanup-go-nogo.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/check-a2a-allhands-stability-closeout-gates.test.mjs` | live gate in current manifest |
| `scripts/archive/check-team1-workerDelta-plane-gates-527-497-294.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/check-team1-dispatch-wrapper-runbook.test.mjs` | live gate in current manifest |
| `scripts/archive/check-team1-workerAlpha-residue-cleanup-go-nogo.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/archive/check-team1-workerDelta-go-nogo-evidence-pack.test.mjs` | archive without explicit rNN marker; review before downgrade |
| `scripts/a2a-worker-readiness-preflight.test.mjs` | live gate in current manifest |
| `scripts/a2a-skill-guard.test.mjs` | live gate in current manifest |
| `test/conformance/check-terminal-evidence-state-machine.mjs` | live gate in current manifest |
| `scripts/check-runtime-hardening-docs.test.mjs` | live gate in current manifest |
| `scripts/check-issue-closeout-hygiene.test.mjs` | live gate in current manifest |
| `scripts/check-disposition-references.test.mjs` | live gate in current manifest |
| `scripts/check-round-quality-scorecard.test.mjs` | live gate in current manifest |
| `scripts/check-workflow-permissions.test.mjs` | live gate in current manifest |
| `scripts/check-workflow-action-pinning.test.mjs` | live gate in current manifest |
| `scripts/a2a-warn-log-aggregate.test.mjs` | live gate in current manifest |
| `scripts/check-release-gate-manifest-coverage.test.mjs` | live gate in current manifest |
| `scripts/archive/check-team1-workerDelta-terminal-brief-live-activation-checklist.test.mjs` | archive without explicit rNN marker; review before downgrade |

## Next PR requirements

- Work unit 2 must use this inventory as its input and only move the candidate set to opt-in/historical execution after a red→green list-diff proof. Prefer an explicit historical opt-in/tier meaning over relying only on the older `archived: true` skip wording.
- Work unit 2 must record before/after `node scripts/run-release-gate.mjs --list` counts and default CI duration.
- Work unit 3 may ratchet script budgets only after an actual script-count reduction is observed.
- Work unit 4 must prove broker `test` command set equivalence before replacing the one-liner.
