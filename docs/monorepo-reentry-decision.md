# A2A Monorepo Re-entry Decision

> **Decision date:** 2026-06-07
> **Status:** Re-entry decision recorded by [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511); active follow-up is tracked by [#514](https://github.com/jinwon-int/a2a-plane/issues/514), [#515](https://github.com/jinwon-int/a2a-plane/issues/515), and [#517](https://github.com/jinwon-int/a2a-plane/issues/517)
> **Decision:** proceed with a staged umbrella workspace rehearsal, not an immediate canonical monorepo flip.

## Summary

Seo Jin On re-opened the monorepo question after the
[`a2a-plane#506`](https://github.com/jinwon-int/a2a-plane/issues/506) current-state
integration and effectiveness wave. The direction is valid: if A2A keeps
growing, the cost of a later consolidation will grow too. The safe answer is
not a one-shot import or canonical-source flip. The safe answer is a staged
monorepo-shaped rehearsal while the split implementation repos remain
canonical.

The concrete decision is:

> Build and validate a staged monorepo workspace under `a2a-plane` first. The
> split implementation repos remain canonical until import rehearsal, CI parity,
> docs migration, CODEOWNERS, branch protection, and explicit operator sign-off
> are complete.

`agent-olympics` is an independent repository and is outside the A2A monorepo
re-entry scope. The A2A rehearsal must not add an `agent-olympics` package,
mirror path, import gate, or issue-routing lane.

## Why This Re-enters The Decision

The previous topology decision, [#473](https://github.com/jinwon-int/a2a-plane/issues/473),
recommended holding full monorepo consolidation. Its re-entry criteria required
an operator-initiated discussion, import rehearsal, docs migration, CODEOWNERS
split, CI parity, and explicit sign-off.

`#511` satisfies the operator-initiated trigger. It does not satisfy the cutover
gates. That means planning and rehearsal may proceed, but canonical migration
may not.

## Codex Read-Only Cross-Check Evidence

The first monorepo re-entry review used temporary Codex native read-only
cross-check lanes, not routed Team1 or Team2 A2A workers. Their evidence should
not be counted as Team1/Team2 benchmark evidence.

Those read-only lanes agreed on the same shape:

| Lane | Finding |
| --- | --- |
| Repo/package layout | `a2a-plane` already has `packages/*`, but those package mirrors are stale compared with the split repos. |
| GitHub/history/release | Closed issue/PR history should stay in original repos; use `#511` as the finalizer hub; do not bulk-migrate old issues. |
| CI/tooling | Keep path-filtered per-package jobs, contract/conformance jobs, scanner gates, and split repo CI parity until proven equivalent. |
| Security/public-private | Keep independent private benchmark repositories out of the public A2A monorepo/package scope. |
| Operator/developer UX | Use an additive `a2a-monorepo-next` rehearsal. Do not mutate existing local checkouts or flip canonical ownership during planning. |

## Current Repo Facts

| Repo | Current role | Cutover implication |
| --- | --- | --- |
| `a2a-plane` | Public start-here, contracts, docs, release gates, compatibility, current-state smoke. | Becomes the rehearsal workspace and decision hub. |
| `a2a-broker` | Broker runtime, worker registry, task lifecycle, dispatch/readiness gates, durable evidence. | Import only after history-preserving rehearsal and CI parity. |
| `a2a-docker-runner` | Isolated execution, checkout hygiene, PR/Done/Block evidence, runner CLI/package. | Preserve approval-gated release/tag workflow and CLI package boundary. |
| `openclaw-plugin-a2a` | OpenClaw adapter, requester-visible status, diagnostics, ACK boundary. | Preserve plugin manifest packaging and OpenClaw peer boundary. |

The existing local `a2a-monorepo` checkout is an old `a2a-plane` branch/workspace
and must not be treated as the new canonical cutover base.

## Target Rehearsal Layout

```text
a2a-plane/
  packages/
    broker/
    docker-runner/
    openclaw-plugin-a2a/
  contracts/
  fixtures/
  docs/
  scripts/
  scanner/
  .github/workflows/
```

## Gates Before Canonical Flip

| Gate | Required evidence | Status |
| --- | --- | --- |
| Operator re-entry | Explicit operator request to revisit monorepo after `#506`. | Green |
| Import rehearsal | Disposable history-preserving import from clean upstream refs into prefixed paths. | Not started |
| CI parity | Monorepo package jobs match or exceed split repo build/test/scanner coverage. | Not started |
| Docs migration | README, current-state, developer, operator, migration, and backlink docs explain canonical state. | Not started |
| CODEOWNERS | Package-level ownership and review routes are defined. | Not started |
| Branch protection | `a2a-plane/main` protection is reviewed before any canonical flip. | Not started |
| Release/package policy | npm/GitHub Packages, tags, images, and CLI canonical names are decided. | Not started |
| Final sign-off | Operator approves canonical source flip after all evidence is green. | Not granted |

## Implementation Phases

### Phase 0: Decision And Rehearsal Plan

- Record this decision in `#511`.
- Add a fixture/validator that keeps the staged decision from drifting.
- Open child issues for import rehearsal, CI parity, docs/CODEOWNERS, and
  branch protection/release policy.
- Record the import rehearsal plan in
  [`docs/monorepo-import-rehearsal.md`](monorepo-import-rehearsal.md) and keep it
  validated by `npm run check:monorepo-import-rehearsal`.
- Keep all implementation repos canonical.

### Phase 1: Disposable Rehearsal

- Create a fresh additive rehearsal workspace from clean upstream refs.
- Use history-preserving prefix import where practical; do not squash away
  provenance by default.
- Compare package manifests, scripts, CI, and scanner gates against split repos.
- Discard the rehearsal if parity is not clean.

### Phase 2: Workspace PR Without Canonical Flip

- Open a PR that updates workspace docs, layout, and parity checks.
- Preserve old repos as canonical source and provenance archives.
- Do not move releases, tags, packages, or issue authority.

### Phase 3: Canonical Flip Decision

- Revisit only after all gates are green.
- Require a separate explicit operator approval.
- If approved, freeze split repo writes, route new work through `a2a-plane`,
  preserve old issue/PR history with backlinks, and keep rollback ready.

## Issue Tracker Strategy

- Use `a2a-plane#511` as the finalizer hub for the decision.
- Keep closed issues and PR history in their original repos.
- Do not bulk-transfer old closed issues or PRs.
- Use future labels such as `source:a2a-broker`, `source:a2a-docker-runner`,
  and `source:openclaw-plugin-a2a`.
- After an approved cutover, route new work to `a2a-plane` and leave old repos
  with README/pinned-issue backlinks.

## Out-of-Scope Repositories

`agent-olympics` is not an A2A implementation repository. Do not track it as an
A2A package, monorepo import target, public mirror gate, issue-routing label, or
phase 0/1 blocker in this repository.

## No-live Safety Boundary

This decision does not authorize repository imports, history rewrites, branch
protection changes, release tags, GitHub Releases, npm or Docker publication,
repository visibility changes, production deploys, Gateway/broker/worker
restarts, database mutation, provider or Telegram sends, Terminal ACK/replay,
credential movement, destructive cleanup, or worker-owned GitHub mutation.
