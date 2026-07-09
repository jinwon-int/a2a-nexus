# docs/ index (three tiers)

The documentation surface is split into three tiers (#1290 R5). The
repository-level entry-point ordering lives in the [root README](../README.md)
and is unchanged; this index is the map of everything under `docs/`.

## Getting started (users and external contributors)

- [quickstart.md](quickstart.md) — five-minute local quickstart
- [architecture.md](architecture.md) — conceptual architecture map
- [trust-boundaries.md](trust-boundaries.md) — trust primitives and approval boundaries
- [developers.md](developers.md) — package surfaces and local validation
- [contribution-entry-points.md](contribution-entry-points.md) — first-contribution guide
- [conformance.md](conformance.md) — running the public conformance runner
- [canonical-demo.md](canonical-demo.md) — public-safe no-live demo flow
- [ecosystem-guide.md](ecosystem-guide.md) — ecosystem orientation
- [external-harness-quickstart.md](external-harness-quickstart.md) — non-OpenClaw harness quickstart
- [promotion-capstone.md](promotion-capstone.md) — external-user local capstone
- [public-alpha-landing.md](public-alpha-landing.md) — landing-page content
- [positioning.md](positioning.md) — landscape and positioning
- [known-limitations.md](known-limitations.md) — limitations
- [attestation-bundle.md](attestation-bundle.md) — attestation bundle format
- [adapter-migration-path.md](adapter-migration-path.md) — adapter migration design
- [topology-decision-record.md](topology-decision-record.md) — topology ADR
- [termux-proot-distro-a2a-runner.md](termux-proot-distro-a2a-runner.md) — Termux worker setup

## Operating (operators and finalizers)

- [operators.md](operators.md) — operator guide (roles, approval points, failure classification)
- [current-state.md](current-state.md) — living source-of-truth and coordination index
- [a2a-constitution.md](a2a-constitution.md) — governance and safety baseline
- [a2ad-round-dispatch.md](a2ad-round-dispatch.md) — round dispatch workflow and conventions
- [implementation-pipeline.md](implementation-pipeline.md) — implementation process contract
- [issue-routing.md](issue-routing.md) — issue routing policy
- [pr-review-guardrails.md](pr-review-guardrails.md) — review/merge runbook
- [release-gate.md](release-gate.md) — release-gate mechanics
- [ops/script-surface-entrypoints.md](ops/script-surface-entrypoints.md) — local quick check / PR check / public candidate check entrypoints
- [release-checklist.md](release-checklist.md) — release evidence checklist
- [release-readiness.md](release-readiness.md) — readiness-vs-publication matrix
- [publicization-roadmap.md](publicization-roadmap.md) — gated publicization roadmap
- [promotion-announcement.md](promotion-announcement.md) — gated promotion prep
- [external-listings.md](external-listings.md) — listing submission prep
- [branch-protection.md](branch-protection.md) — branch-protection invariant
- [scripts-lifecycle.md](scripts-lifecycle.md) — scripts lifecycle classes
- [snapshot-retention-policy.md](snapshot-retention-policy.md) — retention policy
- [fleet-routing-guard.md](fleet-routing-guard.md) — worker routing preflight
- [current-state-no-live-integration-smoke.md](current-state-no-live-integration-smoke.md) — source-only smoke
- [docker-runner-no-diff-closeout-guidance.md](docker-runner-no-diff-closeout-guidance.md) — closeout guidance
- [hermes-android-native-worker-runbook.md](hermes-android-native-worker-runbook.md) — native worker runbook
- [hermes-native-worker-enrollment-runbook.md](hermes-native-worker-enrollment-runbook.md) — enrollment runbook
- [hermes-native-worker-conformance-checklist.md](hermes-native-worker-conformance-checklist.md) — acceptance checklist

Operational subdirectories: [ops/](ops/) (ledgers, scorecards, machine-read
registries), [demo/](demo/), [compatibility/](compatibility/),
[security/](security/), [validation/](validation/), [roadmap/](roadmap/).

## Records (completed work)

Completed, dated, or superseded records live in [history/](history/README.md)
— see its index. Two forwarding stubs remain at the old top-level paths for
externally linkable records ([public-readiness.md](public-readiness.md),
[promotion-validation.md](promotion-validation.md)). The naming and placement
convention for new dated reports is in
[operators.md](operators.md) ("Dated report naming and placement").
