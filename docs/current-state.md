# A2A Current State

> **Snapshot date:** 2026-06-07
> **Active coordination:** [a2a-plane#515](https://github.com/jinwon-int/a2a-plane/issues/515), [#517](https://github.com/jinwon-int/a2a-plane/issues/517), [a2a-broker#1320](https://github.com/jinwon-int/a2a-broker/issues/1320), and [#1321](https://github.com/jinwon-int/a2a-broker/issues/1321)
> **Status:** public alpha, post-`#511/#513` monorepo phase 0 backlog active; `#506` source/no-live validation wave completed.

This page is the current public source-of-truth index for the A2A split-repo
surface. It separates current work from historical public-readiness and
topology gates.

## Current Active Work

The active A2A coordination work is:

| Issue | Owning repo | Purpose |
| --- | --- | --- |
| [a2a-plane#515](https://github.com/jinwon-int/a2a-plane/issues/515) | `a2a-plane` | Draft monorepo docs, CODEOWNERS, and issue-routing policy. |
| [a2a-plane#517](https://github.com/jinwon-int/a2a-plane/issues/517) | `a2a-plane` | Review branch protection and release/package policy before any canonical flip. |
| [a2a-broker#1320](https://github.com/jinwon-int/a2a-broker/issues/1320) | `a2a-broker` | Research A2A hybrid worker mode with conditional subagent fanout. |
| [a2a-broker#1321](https://github.com/jinwon-int/a2a-broker/issues/1321) | `a2a-broker` | Design adaptive workMode selector after planning and output estimation. |

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
