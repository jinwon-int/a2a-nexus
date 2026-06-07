# A2A Current State

> **Snapshot date:** 2026-06-07
> **Active umbrella:** [a2a-plane#506](https://github.com/jinwon-int/a2a-plane/issues/506)
> **Status:** public alpha, source/no-live validation wave active.

This page is the current public source-of-truth index for the A2A split-repo
surface. It separates current work from historical public-readiness and
topology gates.

## Current Active Work

The only active A2A coordination wave is:

- [a2a-plane#506](https://github.com/jinwon-int/a2a-plane/issues/506) - A2A current-state integration and effectiveness wave.

Child work from that wave:

| Issue | Owning repo | Purpose |
| --- | --- | --- |
| [a2a-plane#507](https://github.com/jinwon-int/a2a-plane/issues/507) | `a2a-plane` | Refresh current-state docs and checkout hygiene. |
| [a2a-plane#508](https://github.com/jinwon-int/a2a-plane/issues/508) | `a2a-plane` | Define the no-live cross-repo integration smoke. |
| [a2a-broker#1318](https://github.com/jinwon-int/a2a-broker/issues/1318) | `a2a-broker` | Enforce work-mode decision evidence across Team1/hybrid dispatch paths. |
| [a2a-docker-runner#358](https://github.com/jinwon-int/a2a-docker-runner/issues/358) | `a2a-docker-runner` | Re-smoke read-only/no-change evidence on clean `main`. |
| [openclaw-plugin-a2a#457](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/457) | `openclaw-plugin-a2a` | Add requester-visible no-live status conformance fixture. |
| [agent-olympics#205](https://github.com/jinwon-int/agent-olympics/issues/205) | `agent-olympics` | Add A2A effectiveness benchmark record format. |

The `#508` no-live smoke is documented in
[`docs/current-state-no-live-integration-smoke.md`](current-state-no-live-integration-smoke.md)
and validated by
`scripts/check-current-state-no-live-integration-smoke.mjs`. It uses injected
source fixtures only and must not perform live broker, provider, Gateway,
Terminal ACK, deployment, credential, release, visibility, or destructive
checkout actions.

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
| `agent-olympics` | Neutral benchmark format: solo vs A2A result packets, judging dimensions, evidence/latency/cost/rework metrics, seed benchmark records. | A2A runtime, dispatch transport, live runner approval. |

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

This current-state wave is source/no-live by default. It does not authorize live A2A dispatch, production deploys, Gateway/broker/worker restarts, provider or Telegram sends, DB/queue/terminal-outbox mutation, Terminal ACK/replay, credential movement, release/tag/npm/Docker publication, repository visibility changes, or destructive local cleanup.
