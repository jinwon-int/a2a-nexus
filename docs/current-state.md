# A2A Current State

> **Snapshot date:** 2026-07-13
> **Active coordination:** [a2a-nexus#1498](https://github.com/jinwon-int/a2a-nexus/issues/1498) (repository hardening umbrella; the monorepo canonical flip is complete — recorded below)
> **Status:** public alpha, actual source-state canonical flip executed for `a2a-nexus` packages at source level; external/live execution-sensitive actions remain separated.

This page is the current public source-of-truth index for the A2A monorepo
surface. The staged canonical flip is complete — `a2a-nexus` packages are
`MONOREPO_PACKAGES_CANONICAL` (recorded below); the former split repositories
are archived and private, holding provenance history only. It separates current
work from historical public-readiness and topology gates.

## Current validation entrypoints

The operator-facing script surface is intentionally large, so the current entrypoint rule is three-tiered rather than script deletion:

| Situation | Command path | Source of truth |
|---|---|---|
| Local quick check | Focused package/doc command for touched files | [`docs/ops/script-surface-entrypoints.md`](ops/script-surface-entrypoints.md) |
| PR check | `npm run check` | [`docs/release-gate.md`](release-gate.md) |
| Public candidate check | `npm run scan:public-readiness`, `npm run scan:external-secrets`, and relevant package/readiness audit | [`docs/ops/script-surface-tier-manifest.json`](ops/script-surface-tier-manifest.json) |

The per-package script-surface counts are not restated here (they drift as scripts land); the committed source of truth is the script-surface manifest and the ratcheting budget. Read the current counts with `node scripts/lib/script-surface-manifest.mjs`, and see the enforced budgets in `scripts/check-script-budget.mjs` (`node scripts/check-script-budget.mjs`).

## Current Active Work

The monorepo canonical-flip planning lane (`a2a-nexus#553`) is complete; it is
recorded below for continuity:

| Issue | Owning repo | Purpose |
| --- | --- | --- |
| [a2a-nexus#553](https://github.com/jinwon-int/a2a-nexus/issues/553) | `a2a-nexus` | Closed 2026-06-11 (completed). Actual source-state canonical flip executed: `packages/broker`, `packages/docker-runner`, and `packages/openclaw-plugin-a2a` are `MONOREPO_PACKAGES_CANONICAL`. External/live execution-sensitive actions remain separated. |

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

The staged monorepo migration is finished. It ran as phases `#514` through
`a2a-nexus#553`, each phase producing a readiness packet, an approval packet,
a preflight and an execution-result document, plus a `check:monorepo-*`
release-gate step pinning it. The terminal states those phases reached are:

- **`MONOREPO_PACKAGES_CANONICAL`** — `packages/broker`, `packages/docker-runner`
  and `packages/openclaw-plugin-a2a` are the canonical source.
- **Mirrors archived** — `jinwon-int/a2a-broker`, `jinwon-int/a2a-docker-runner`
  and `jinwon-int/plugin-a2a` carry README/MIRROR_NOTICE source-routing notices
  and are now **archived and private**. They reached `ACTIVE_PROVENANCE_MIRROR`
  during the migration and were archived afterwards; verified against the GitHub
  API on 2026-08-09. An outside reader cannot open them, so do not cite them as
  reachable references.

Package ownership transfer, release/publish/deploy, DB, secret, provider send,
Terminal ACK/replay, force-push, and history rewrite were never in scope of the
migration and remain separate HOLD surfaces requiring explicit operator approval.

The per-phase packets and their release-gate steps were retired once the
migration reached those terminal states; they described intermediate decision
points (`NO_GO / Waiting`, "split repo CI remains canonical") that no longer
hold and had begun to contradict this document. `docs/topology-decision-record.md`
records the topology history.

The `#515` docs, CODEOWNERS, and issue-routing policy is documented in
[`docs/history/migration.md`](history/migration.md), [`docs/operators.md`](operators.md),
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

The remaining `fixtures/current-state/*.json` snapshots and their release-gate
steps are governed by
[`docs/snapshot-retention-policy.md`](snapshot-retention-policy.md), which
defines when a superseded migration-phase snapshot may be retired and which
terminal-state invariants must stay. Live-behavior gates are never retired
under that policy — the migration-phase snapshots retired here were not
live-behavior gates.

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
