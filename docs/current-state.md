# A2A Current State

> **Snapshot date:** 2026-06-10
> **Active coordination:** [a2a-nexus#553](https://github.com/jinwon-int/a2a-nexus/issues/553)
> **Status:** public alpha, actual source-state canonical flip executed for `a2a-nexus` packages at source level; external/live execution-sensitive actions remain separated.

This page is the current public source-of-truth index for the A2A split-repo
surface. It separates current work from historical public-readiness and
topology gates.

## Current Active Work

The active A2A coordination work is the `a2a-nexus#553` monorepo canonical
planning lane after operator approval:

| Issue | Owning repo | Purpose |
| --- | --- | --- |
| [a2a-nexus#553](https://github.com/jinwon-int/a2a-nexus/issues/553) | `a2a-nexus` | Actual source-state canonical flip executed: `packages/broker`, `packages/docker-runner`, and `packages/openclaw-plugin-a2a` are `MONOREPO_PACKAGES_CANONICAL`. External/live execution-sensitive actions remain separated. |

Recently completed broker-mode work is recorded for continuity only:
`a2a-broker#1320` and `a2a-broker#1321` are not the active `a2a-plane`
monorepo coordination lane.

The completed monorepo re-entry decision is recorded in
[`docs/history/monorepo-reentry-decision.md`](history/monorepo-reentry-decision.md) and
validated by `scripts/check-monorepo-reentry-decision.mjs`. The decision is to
build a staged umbrella workspace rehearsal first, while split implementation
repos remain canonical during phase 0/1.

Completed current-state and monorepo groundwork:

| Issue | Owning repo | Purpose |
| --- | --- | --- |
| a2a-plane#506 (a2a-plane#506, internal tracker private) | `a2a-plane` | Closed parent wave: current-state integration and A2A effectiveness. |
| a2a-plane#507 (a2a-plane#507, internal tracker private) | `a2a-plane` | Closed: current-state docs and checkout hygiene. |
| a2a-plane#508 (a2a-plane#508, internal tracker private) | `a2a-plane` | Closed: no-live cross-repo integration smoke. |
| [a2a-broker#1318](https://github.com/jinwon-int/a2a-broker/issues/1318) | `a2a-broker` | Closed: work-mode decision evidence across Team1/hybrid dispatch paths. |
| [a2a-docker-runner#358](https://github.com/jinwon-int/a2a-docker-runner/issues/358) | `a2a-docker-runner` | Closed: read-only/no-change evidence on clean `main`. |
| [openclaw-plugin-a2a#457](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/457) | `openclaw-plugin-a2a` | Closed: requester-visible no-live status conformance fixture. |
| a2a-plane#511 (a2a-plane#511, internal tracker private) | `a2a-plane` | Closed: monorepo re-entry decision, staged umbrella rehearsal first. |
| a2a-plane#513 (a2a-plane#513, internal tracker private) | `a2a-plane` | Closed: import rehearsal and mirror freshness checks. |
| a2a-plane#514 (a2a-plane#514, internal tracker private) | `a2a-plane` | Closed: CI parity and package boundary matrix; split repo CI remains canonical. |
| a2a-plane#515 (a2a-plane#515, internal tracker private) | `a2a-plane` | Closed: monorepo docs, CODEOWNERS, and issue-routing policy. |
| a2a-plane#517 (a2a-plane#517, internal tracker private) | `a2a-plane` | Closed: branch protection and release/package policy before canonical flip. |
| a2a-plane#528 (a2a-plane#528, internal tracker private) | `a2a-plane` | Closed: phase-1 import rehearsal gate refresh after the all-repo audit. |
| a2a-plane#530 (a2a-plane#530, internal tracker private) | `a2a-plane` | Closed: phase-2 fresh prefix import rehearsal and equal-or-stricter package CI parity gate evidence. |
| a2a-plane#534 (a2a-plane#534, internal tracker private) | `a2a-plane` | Closed: phase-3 package CI gate fixture/checker/release-gate blocker before package mirror refresh. |
| a2a-plane#536 (a2a-plane#536, internal tracker private) | `a2a-plane` | Closed: package CI parity jobs wired into GitHub Actions and root release gate. |
| a2a-plane#538 (a2a-plane#538, internal tracker private) | `a2a-plane` | Closed: phase-4 fresh tracked-tree import candidate under package CI parity jobs. |
| a2a-plane#541 (a2a-plane#541, internal tracker private) | `a2a-plane` | Closed: phase-5 canonical-flip readiness packet and provenance gate. |
| a2a-plane#543 (a2a-plane#543, internal tracker private) | `a2a-plane` | Closed: phase-6 branch protection approval packet and required-checks dry-run. |
| a2a-plane#545 (a2a-plane#545, internal tracker private) | `a2a-plane` | Closed: phase-7 split-repo disposition and rollback owner packet before canonical flip. |
| a2a-plane#547 (a2a-plane#547, internal tracker private) | `a2a-plane` | Closed: phase-8 release/package/tag approval packet and dry-run inventory before release, publish, ownership transfer, or canonical flip. |
| a2a-plane#549 (a2a-plane#549, internal tracker private) | `a2a-plane` | Closed: phase-9 final operator sign-off matrix with every execution field held at `NO_GO / Waiting`. |

The `#508` no-live smoke is documented in
[`docs/current-state-no-live-integration-smoke.md`](current-state-no-live-integration-smoke.md)
and validated by
`scripts/check-current-state-no-live-integration-smoke.mjs`. It uses injected
source fixtures only and must not perform live broker, provider, Gateway,
Terminal ACK, deployment, credential, release, visibility, or destructive
checkout actions.

The `#514` CI parity and package boundary matrix is documented in
[`docs/history/monorepo-ci-parity-matrix.md`](history/monorepo-ci-parity-matrix.md) and
validated by `scripts/check-monorepo-ci-parity-matrix.mjs`. It records that the
current `packages/*` mirrors are not green for canonical flip and that split
repo CI remains canonical until a fresh import rehearsal proves
equal-or-stricter package coverage.

The `#530` phase-2 rehearsal is documented in
[`docs/history/monorepo-import-rehearsal.md`](history/monorepo-import-rehearsal.md) and
[`docs/history/monorepo-ci-parity-matrix.md`](history/monorepo-ci-parity-matrix.md). It records
fresh split repo refs and throwaway prefix-import evidence, then keeps phase-3
package mirror refresh blocked until package jobs are equal-or-stricter than
split repo CI.

The `#531` merge closed `#530` with source-only docs, fixtures, and checker
evidence. It did not import packages into `main`, flip canonical ownership, or
perform live operations.

The `a2a-plane#534` phase-3 package CI gate is documented in
[`docs/history/monorepo-ci-parity-matrix.md`](history/monorepo-ci-parity-matrix.md),
[`docs/history/monorepo-import-rehearsal.md`](history/monorepo-import-rehearsal.md), and
[`fixtures/current-state/monorepo-phase3-package-ci-gate.json`](../fixtures/current-state/monorepo-phase3-package-ci-gate.json).
`a2a-plane#536` wired the package CI parity runner into GitHub Actions and the
root release gate. `a2a-plane#540` closed `a2a-plane#538` by importing tracked
split-repo trees into `packages/*` under those jobs, but still did not approve
canonical ownership, release, deploy, provider send, Terminal ACK, or
credential movement.

The `#541` phase-5 readiness packet is documented in
[`docs/history/monorepo-canonical-flip-readiness.md`](history/monorepo-canonical-flip-readiness.md)
and validated by `scripts/check-monorepo-canonical-flip-readiness.mjs`. It
records #540 merge evidence, split-repo provenance policy, rollback path, and
GO/NO-GO fields while keeping the canonical flip decision at `NO_GO / Waiting`.
It merged through `a2a-plane#542`.

The `#543` phase-6 branch protection approval packet is documented in
[`docs/history/monorepo-branch-protection-approval-packet.md`](history/monorepo-branch-protection-approval-packet.md)
and validated by `scripts/check-monorepo-branch-protection-approval-packet.mjs`.
It records the live read-only finding that `a2a-plane/main` is not branch
protected and has no rulesets, then proposes required-check and review decision
fields without applying any GitHub settings.

The `#545` phase-7 split-repo disposition and rollback owner packet is
documented in
[`docs/history/monorepo-split-repo-disposition-rollback.md`](history/monorepo-split-repo-disposition-rollback.md)
and validated by `scripts/check-monorepo-split-repo-disposition-rollback.mjs`.
It keeps the split implementation repos canonical while recording active,
mirrored, read-only, and archive/redirect options plus rollback owner fields
for before-flip and after-flip scenarios.

The active `a2a-nexus#553` split-repo disposition refresh updates the same
packet for the `a2a-nexus` target after #563/#564. It records Team1+Team2
source-only A2A evidence and keeps `a2a-broker`, `a2a-docker-runner`, and
`plugin-a2a` at `active_canonical`. `active_mirrored` is candidate-only;
read-only/archive/redirect, package ownership transfer, release/package/tag,
deploy, DB, secret, provider send, and Terminal ACK/replay remain separate
`NO_GO / Waiting` actions.

The `#547` phase-8 release/package/tag approval packet is documented in
[`docs/history/monorepo-release-package-tag-approval-packet.md`](history/monorepo-release-package-tag-approval-packet.md)
and validated by
`scripts/check-monorepo-release-package-tag-approval-packet.mjs`. It records
candidate package metadata, release/tag/npm/Docker approval fields, and dry-run
commands while keeping every execution field at `NO_GO / Waiting`.

The active `a2a-nexus#553` final operator sign-off / canonical source packet is
documented in
[`docs/history/monorepo-final-operator-signoff-matrix.md`](history/monorepo-final-operator-signoff-matrix.md)
and validated by
`scripts/check-monorepo-final-operator-signoff-matrix.mjs`. It supersedes the
historical `a2a-plane#549` matrix for active `a2a-nexus` routing, records
Team1+Team2 source-only A2A evidence, and marks canonical source declaration as
`GO_CANDIDATE / PR-first / source-only` for `packages/broker`,
`packages/docker-runner`, and `packages/openclaw-plugin-a2a`. Canonical flip
execution, package ownership transfer, release/package/tag, split-repo
archive/read-only/redirect, deploy, DB, secret, provider send, and Terminal
ACK/replay remain separate `NO_GO / Waiting` actions.


The active `a2a-nexus#553` canonical source flip execution handoff packet is
documented in
[`docs/history/monorepo-canonical-source-flip-execution-handoff.md`](history/monorepo-canonical-source-flip-execution-handoff.md)
and validated by
`scripts/check-monorepo-canonical-source-flip-execution-handoff.mjs`. It records
`GO_PR_FIRST_SOURCE_ONLY` for the handoff PR while actual canonical flip execution remains separate `NO_GO / Waiting`. worker-beta's dissent is recorded as a
safety guardrail: if the packet is interpreted as actual execution, it is
blocked; only the source-only handoff may advance.



The active `a2a-nexus#553` actual canonical flip execution preflight packet is
documented in
[`docs/history/monorepo-actual-canonical-flip-execution-preflight.md`](history/monorepo-actual-canonical-flip-execution-preflight.md)
and validated by
`scripts/check-monorepo-actual-canonical-flip-execution-preflight.mjs`. It records
`GO_PR_FIRST_SOURCE_ONLY_PREFLIGHT` and the final approval phrase required for a
future execution run, while actual canonical flip execution remains separate
`NO_GO / Waiting` with no state mutation performed.



The active `a2a-nexus#553` actual canonical flip execution result is
documented in
[`docs/history/monorepo-actual-canonical-flip-execution-result.md`](history/monorepo-actual-canonical-flip-execution-result.md)
and validated by
`scripts/check-monorepo-actual-canonical-flip-execution-result.mjs`. It records
`MONOREPO_PACKAGES_CANONICAL` and confirms that source-state-only actual canonical flip execution has been performed for `packages/broker`, `packages/docker-runner`, and `packages/openclaw-plugin-a2a`; split-repo archive/read-only/redirect, package ownership transfer, release/publish/deploy, DB, secret, provider send, Terminal ACK/replay, GitHub settings changes beyond the existing ruleset, force-push, and history rewrite remain separate HOLD surfaces.



The active `a2a-nexus#553` split-repo disposition preflight is documented in
[`docs/history/monorepo-split-repo-disposition-preflight.md`](history/monorepo-split-repo-disposition-preflight.md)
and validated by `scripts/check-monorepo-split-repo-disposition-preflight.mjs`.
It records `ACTIVE_PROVENANCE_MIRROR` as the future candidate disposition after
`MONOREPO_PACKAGES_CANONICAL`, while actual archive/read-only/redirect, repo
settings mutation, package ownership transfer, release/publish/deploy, DB,
secret, provider send, Terminal ACK/replay, force-push, and history rewrite
remain separate HOLD surfaces.



The active `a2a-nexus#553` active provenance mirror execution result is
documented in
[`docs/history/monorepo-active-provenance-mirror-execution-result.md`](history/monorepo-active-provenance-mirror-execution-result.md)
and validated by `scripts/check-monorepo-active-provenance-mirror-execution-result.mjs`.
It records that `jinwon-int/a2a-broker`, `jinwon-int/a2a-docker-runner`, and
`jinwon-int/plugin-a2a` have received README/MIRROR_NOTICE source-routing
notices and are now `ACTIVE_PROVENANCE_MIRROR` repositories for history,
issue/PR/tag provenance, and emergency reference. They remain active/public and
were not archived, made read-only, redirected, renamed, hidden, or mutated
through settings. Package ownership transfer, release/publish/deploy, DB,
secret, provider send, Terminal ACK/replay, force-push, and history rewrite
remain separate HOLD surfaces.

The active operator approval handoff packet is documented in
[`docs/history/monorepo-operator-approval-handoff.md`](history/monorepo-operator-approval-handoff.md)
and validated by `scripts/check-monorepo-operator-approval-handoff.mjs`. It
supersedes the historical unanswered `a2a-plane#551` packet after
`a2a-plane#550` merged `7200a91a92bbdbc82855a5a22321d704fdf2ca29`; it records
the Telegram approval `승인` from the operator / operator for PR-first canonical
planning at `9669f9098459c9f17bdea0193bc428593b0ef2d5`, plus #562 CI and
post-#562 A2A safe2 evidence. It does not directly perform branch protection,
split repo disposition, release, publish, deploy, restart, credential movement,
provider send, or Terminal ACK/replay.

The `#515` docs, CODEOWNERS, and issue-routing policy is documented in
[`docs/migration.md`](migration.md), [`docs/operators.md`](operators.md),
[`docs/developers.md`](developers.md), [`docs/issue-routing.md`](issue-routing.md),
and [`.github/CODEOWNERS`](../.github/CODEOWNERS). It is validated by
`scripts/check-monorepo-docs-routing.mjs` and keeps `agent-olympics` outside A2A
source labels and package routing.

The `#517` branch protection and release/package policy is documented in
[`docs/release/monorepo-branch-release-package-policy.md`](release/monorepo-branch-release-package-policy.md)
and validated by `scripts/check-monorepo-branch-release-package-policy.mjs`. It
keeps branch protection changes, release/tag creation, npm/GitHub Packages
publication, Docker/GHCR publication, and canonical flip actions blocked until
separate explicit operator approval.

## Snapshot retention

The `fixtures/current-state/*.json` snapshots above and their
`check:monorepo-*` release-gate steps are governed by
[`docs/snapshot-retention-policy.md`](snapshot-retention-policy.md), which
defines when a superseded migration-phase snapshot may be retired and which
terminal-state invariants must stay. Live-behavior gates are never retired
under that policy.

## Completed Historical Gates

These issues are completed and should not be treated as active blockers:

| Issue | State | Current meaning |
| --- | --- | --- |
| a2a-plane#473 (a2a-plane#473, internal tracker private) | Closed | Adopted topology decision: keep split implementation repos and strengthen `a2a-plane` as the umbrella. |
| a2a-plane#478 (a2a-plane#478, internal tracker private) | Closed | Public-source security, secret-history, license, and provenance scan groundwork completed. |
| a2a-plane#479 (a2a-plane#479, internal tracker private) | Closed | Public release, version, and provenance checklist groundwork completed. |
| a2a-plane#480 (a2a-plane#480, internal tracker private) | Closed | Local public demo and quickstart scenario completed. |
| a2a-plane#75 (a2a-plane#75, internal tracker private) | Closed | Historical post-rename public-readiness parent; superseded by later public alpha and #506 work. |
| [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294) | Closed | Historical stability roadmap; do not cite as an active blocker. |

## Ownership Boundaries

| Surface | Owns | Does not own |
| --- | --- | --- |
| `a2a-plane` | Public start-here docs, repo map, cross-repo coordination, source-of-truth pointers, active tracker index, no-live integration smoke spec, compatibility/readiness matrices, finalizer synthesis templates. | Broker runtime, runner execution, plugin Gateway behavior, live operations truth. |
| `a2a-broker` | Task lifecycle, worker registry/capacity, dispatch/readiness gates, work-mode decision enforcement, durable task/run records, evidence contract, stale/cancel/reconcile semantics. | Container execution, OpenClaw UX, benchmark scoring. |
| `a2a-docker-runner` | Isolated execution, repo checkout hygiene, PR/Done/Block evidence, `readOnlyValidation` / `allowNoChanges`, artifact manifests, runner chaos/smoke reliability. | Routing decisions, task lifecycle authority, finalizer decisions. |
| `openclaw-plugin-a2a` | OpenClaw adapter boundary: request/status/cancel mapping, operator-visible status, diagnostics, broker profile projection, provider-accepted-not-ACK policy. | Broker state machine, Docker execution, repo topology. |

`agent-olympics` is an independent repository and is intentionally outside the
A2A current-state backlog, package map, monorepo rehearsal, and issue routing
scope.

## Checkout Hygiene

Use a clean current checkout before making source changes or citing local evidence:

```bash
git status --porcelain=v1
git fetch --prune origin
git switch main
git merge --ff-only origin/main
git status --short --branch
```

Optional worktree metadata cleanup must start with a dry run:

```bash
git worktree prune --dry-run
```

Run `git worktree prune` only when the dry-run output references missing temporary paths and no active worktree. Do not use `git reset --hard`, `git clean -fd`, force-push, destructive branch deletion, or history rewrite as part of normal #506/#507 hygiene.

## Boundaries

This current-state and monorepo phase 0 backlog is source/no-live by default. It does not authorize live A2A dispatch, production deploys, Gateway/broker/worker restarts, provider or Telegram sends, DB/queue/terminal-outbox mutation, Terminal ACK/replay, credential movement, release/tag/npm/Docker publication, repository visibility changes, canonical monorepo flip, repository import into `main`, history rewrite, or destructive local cleanup.
