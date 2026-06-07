# A2A Current State

> **Snapshot date:** 2026-06-07
> **Active coordination:** [a2a-plane#541](https://github.com/jinwon-int/a2a-plane/issues/541)
> **Status:** public alpha, monorepo phase-5 canonical-flip readiness packet active after #540 imported fresh package candidates under package CI parity jobs; `#506` source/no-live validation wave completed.

This page is the current public source-of-truth index for the A2A split-repo
surface. It separates current work from historical public-readiness and
topology gates.

## Current Active Work

The active A2A coordination work is the monorepo phase-5 canonical-flip
readiness packet and provenance gate:

| Issue | Owning repo | Purpose |
| --- | --- | --- |
| [a2a-plane#541](https://github.com/jinwon-int/a2a-plane/issues/541) | `a2a-plane` | Record readiness, provenance, rollback, and remaining GO/NO-GO gates before any separate canonical-flip approval. |

Recently completed broker-mode work is recorded for continuity only:
`a2a-broker#1320` and `a2a-broker#1321` are not the active `a2a-plane`
monorepo coordination lane.

The completed monorepo re-entry decision is recorded in
[`docs/monorepo-reentry-decision.md`](monorepo-reentry-decision.md) and
validated by `scripts/check-monorepo-reentry-decision.mjs`. The decision is to
build a staged umbrella workspace rehearsal first, while split implementation
repos remain canonical during phase 0/1.

Completed current-state and monorepo groundwork:

| Issue | Owning repo | Purpose |
| --- | --- | --- |
| [a2a-plane#506](https://github.com/jinwon-int/a2a-plane/issues/506) | `a2a-plane` | Closed parent wave: current-state integration and A2A effectiveness. |
| [a2a-plane#507](https://github.com/jinwon-int/a2a-plane/issues/507) | `a2a-plane` | Closed: current-state docs and checkout hygiene. |
| [a2a-plane#508](https://github.com/jinwon-int/a2a-plane/issues/508) | `a2a-plane` | Closed: no-live cross-repo integration smoke. |
| [a2a-broker#1318](https://github.com/jinwon-int/a2a-broker/issues/1318) | `a2a-broker` | Closed: work-mode decision evidence across Team1/hybrid dispatch paths. |
| [a2a-docker-runner#358](https://github.com/jinwon-int/a2a-docker-runner/issues/358) | `a2a-docker-runner` | Closed: read-only/no-change evidence on clean `main`. |
| [openclaw-plugin-a2a#457](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/457) | `openclaw-plugin-a2a` | Closed: requester-visible no-live status conformance fixture. |
| [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511) | `a2a-plane` | Closed: monorepo re-entry decision, staged umbrella rehearsal first. |
| [a2a-plane#513](https://github.com/jinwon-int/a2a-plane/issues/513) | `a2a-plane` | Closed: import rehearsal and mirror freshness checks. |
| [a2a-plane#514](https://github.com/jinwon-int/a2a-plane/issues/514) | `a2a-plane` | Closed: CI parity and package boundary matrix; split repo CI remains canonical. |
| [a2a-plane#515](https://github.com/jinwon-int/a2a-plane/issues/515) | `a2a-plane` | Closed: monorepo docs, CODEOWNERS, and issue-routing policy. |
| [a2a-plane#517](https://github.com/jinwon-int/a2a-plane/issues/517) | `a2a-plane` | Closed: branch protection and release/package policy before canonical flip. |
| [a2a-plane#528](https://github.com/jinwon-int/a2a-plane/issues/528) | `a2a-plane` | Closed: phase-1 import rehearsal gate refresh after the all-repo audit. |
| [a2a-plane#530](https://github.com/jinwon-int/a2a-plane/issues/530) | `a2a-plane` | Closed: phase-2 fresh prefix import rehearsal and equal-or-stricter package CI parity gate evidence. |
| [a2a-plane#534](https://github.com/jinwon-int/a2a-plane/issues/534) | `a2a-plane` | Closed: phase-3 package CI gate fixture/checker/release-gate blocker before package mirror refresh. |
| [a2a-plane#536](https://github.com/jinwon-int/a2a-plane/issues/536) | `a2a-plane` | Closed: package CI parity jobs wired into GitHub Actions and root release gate. |
| [a2a-plane#538](https://github.com/jinwon-int/a2a-plane/issues/538) | `a2a-plane` | Closed: phase-4 fresh tracked-tree import candidate under package CI parity jobs. |

The `#508` no-live smoke is documented in
[`docs/current-state-no-live-integration-smoke.md`](current-state-no-live-integration-smoke.md)
and validated by
`scripts/check-current-state-no-live-integration-smoke.mjs`. It uses injected
source fixtures only and must not perform live broker, provider, Gateway,
Terminal ACK, deployment, credential, release, visibility, or destructive
checkout actions.

The `#514` CI parity and package boundary matrix is documented in
[`docs/monorepo-ci-parity-matrix.md`](monorepo-ci-parity-matrix.md) and
validated by `scripts/check-monorepo-ci-parity-matrix.mjs`. It records that the
current `packages/*` mirrors are not green for canonical flip and that split
repo CI remains canonical until a fresh import rehearsal proves
equal-or-stricter package coverage.

The `#530` phase-2 rehearsal is documented in
[`docs/monorepo-import-rehearsal.md`](monorepo-import-rehearsal.md) and
[`docs/monorepo-ci-parity-matrix.md`](monorepo-ci-parity-matrix.md). It records
fresh split repo refs and throwaway prefix-import evidence, then keeps phase-3
package mirror refresh blocked until package jobs are equal-or-stricter than
split repo CI.

The `#531` merge closed `#530` with source-only docs, fixtures, and checker
evidence. It did not import packages into `main`, flip canonical ownership, or
perform live operations.

The `a2a-plane#534` phase-3 package CI gate is documented in
[`docs/monorepo-ci-parity-matrix.md`](monorepo-ci-parity-matrix.md),
[`docs/monorepo-import-rehearsal.md`](monorepo-import-rehearsal.md), and
[`fixtures/current-state/monorepo-phase3-package-ci-gate.json`](../fixtures/current-state/monorepo-phase3-package-ci-gate.json).
`a2a-plane#536` wired the package CI parity runner into GitHub Actions and the
root release gate. `a2a-plane#540` closed `a2a-plane#538` by importing tracked
split-repo trees into `packages/*` under those jobs, but still did not approve
canonical ownership, release, deploy, provider send, Terminal ACK, or
credential movement.

The `#541` phase-5 readiness packet is documented in
[`docs/monorepo-canonical-flip-readiness.md`](monorepo-canonical-flip-readiness.md)
and validated by `scripts/check-monorepo-canonical-flip-readiness.mjs`. It
records #540 merge evidence, split-repo provenance policy, rollback path, and
GO/NO-GO fields while keeping the canonical flip decision at `NO_GO / Waiting`.

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

## Completed Historical Gates

These issues are completed and should not be treated as active blockers:

| Issue | State | Current meaning |
| --- | --- | --- |
| [a2a-plane#473](https://github.com/jinwon-int/a2a-plane/issues/473) | Closed | Adopted topology decision: keep split implementation repos and strengthen `a2a-plane` as the umbrella. |
| [a2a-plane#478](https://github.com/jinwon-int/a2a-plane/issues/478) | Closed | Public-source security, secret-history, license, and provenance scan groundwork completed. |
| [a2a-plane#479](https://github.com/jinwon-int/a2a-plane/issues/479) | Closed | Public release, version, and provenance checklist groundwork completed. |
| [a2a-plane#480](https://github.com/jinwon-int/a2a-plane/issues/480) | Closed | Local public demo and quickstart scenario completed. |
| [a2a-plane#75](https://github.com/jinwon-int/a2a-plane/issues/75) | Closed | Historical post-rename public-readiness parent; superseded by later public alpha and #506 work. |
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
