# A2A Monorepo Migration Guide

> **Status:** phase 0 rehearsal policy for a2a-plane#515 (a2a-plane#515, internal tracker private). This guide does not authorize a canonical flip.

## Current State

The A2A monorepo direction is active, but the split implementation repos remain
canonical:

- `jinwon-int/a2a-broker`
- `jinwon-int/a2a-docker-runner`
- `jinwon-int/openclaw-plugin-a2a`

`a2a-plane` is the public umbrella, contracts, fixtures, release/readiness gate,
and coordination workspace. The current `packages/*` mirrors are not green for
canonical ownership. See
[`history/monorepo-ci-parity-matrix.md`](../history/monorepo-ci-parity-matrix.md).

## What This Migration Is

This migration is staged:

1. Record the decision and guardrails.
2. Prove import rehearsal from clean upstream refs.
3. Prove CI/package parity equal to or stricter than split repo CI.
4. Draft docs, CODEOWNERS, and issue routing.
5. Review branch protection and release/package policy.
6. Ask for explicit operator sign-off before any canonical flip.

The branch protection and release/package policy review is recorded by
[`release/monorepo-branch-release-package-policy.md`](../release/monorepo-branch-release-package-policy.md)
for #517 (a2a-plane#517, internal tracker private). It keeps
branch protection changes, GitHub Releases, npm/GitHub Packages, Docker/GHCR
publication, and canonical flip actions blocked until separate explicit
operator approval.

## What This Migration Is Not

This guide does not approve:

- old issue or PR transfer;
- repository archive or visibility change;
- branch protection mutation;
- release tags, GitHub Releases, npm publish, or Docker publish;
- production deploys or Gateway/broker/worker restarts;
- provider or Telegram sends;
- Terminal ACK/replay;
- credential movement;
- history rewrite or force push;
- canonical monorepo flip.

## Readiness States

| State | Meaning | Current status |
| --- | --- | --- |
| Historical decision | Previous topology decision and public-readiness history. | Preserved in `#473` and historical docs. |
| Active monorepo rehearsal | Planning and validation under `a2a-plane`; split repos canonical. | Active. |
| Stable release readiness | Package publication and stable support claims. | Not granted. |
| Live deploy readiness | Runtime deploy/restart/canary authority. | Not granted. |
| Terminal ACK/replay | Terminal-outbox or operator-visible ACK mutation. | Not granted. |
| Package publish | npm, Docker, GitHub Release, or tag creation. | Not granted. |
| Repo visibility | Public/private/archive mutation. | Not granted. |

## Provenance And Backlinks

Closed issues and PRs stay in their original repos. If a future canonical flip is
approved, split repos should keep a README notice and pinned issue pointing to
the new `a2a-plane` issue location. Do not bulk-transfer closed history.

`agent-olympics` is independent and is not an A2A package, import target,
issue-routing lane, or public mirror gate.
