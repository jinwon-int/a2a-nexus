# A2A Operator Guide

> **Status:** phase 0 operator guide for monorepo rehearsal. It is source-only and no-live.

## Operator Decision Points

The operator must explicitly approve any action that changes runtime, release,
visibility, or canonical source authority. Monorepo planning alone is not that
approval.

Separate approval is required for:

- canonical source flip;
- branch protection or required-check mutation;
- repository archive, transfer, or visibility change;
- release tag, GitHub Release, npm publish, or Docker publish;
- production deploy, Gateway restart, broker restart, or worker restart;
- database, queue, terminal-outbox, or Terminal ACK/replay mutation;
- provider or Telegram sends;
- credential movement, rotation, or disclosure;
- history rewrite, force push, or destructive cleanup.

## Current Operator Reading Order

1. [`current-state.md`](current-state.md) for active issues and closed groundwork.
2. [`monorepo-reentry-decision.md`](monorepo-reentry-decision.md) for the staged umbrella decision.
3. [`monorepo-import-rehearsal.md`](monorepo-import-rehearsal.md) for import policy.
4. [`monorepo-ci-parity-matrix.md`](monorepo-ci-parity-matrix.md) for package/CI gaps.
5. [`migration.md`](migration.md), [`developers.md`](developers.md), and
   [`issue-routing.md`](issue-routing.md) for phase 0 workflow.

## Finalizer Boundary

CODEOWNERS routes review attention. It does not move finalizer authority to A2A
workers or package owners. A single finalizer remains responsible for closeout
judgment, no-live boundary checks, and operator sign-off evidence.

## Agent Olympics Boundary

`agent-olympics` is independent. It must not be treated as an A2A package,
monorepo import target, source label, issue-routing lane, or blocker for A2A
monorepo phase 0/1.
