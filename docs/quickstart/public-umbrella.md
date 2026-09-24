# Public A2A Nexus Quickstart Umbrella

Use `a2a-nexus` as the canonical public start-here repository for A2A Nexus implementation work. It contains the broker, Docker runner, OpenClaw reference plugin, contracts, public-safe demos, release gates, and issue routing.

The older split repositories (`a2a-plane`, `a2a-broker`, `openclaw-plugin-a2a`, and `a2a-docker-runner`) are provenance/history references unless a maintainer explicitly points to an active mirror. Do not treat them as authoritative for new implementation issues.

## Repository Map

| Surface | Start here when you need | Canonical boundary |
| --- | --- | --- |
| [`jinwon-int/a2a-nexus`](https://github.com/jinwon-int/a2a-nexus) | Project overview, local quickstarts, cross-package coordination, compatibility/readiness docs, release/provenance gates, and issue routing | Canonical implementation source for A2A Nexus |
| `packages/broker/` | Broker HTTP/JSON-RPC behavior, task API, worker registration, health/profile, broker CI | Broker runtime and API implementation |
| `packages/broker/scripts/*-a2a-*-bridge.mjs` | Harness integration (Claude Code, Codex, Hermes, piri, OpenClaw): analysis/patch bridges, adapter contract conformance | Per-harness bridge surface; no privileged harness package |
| `packages/docker-runner/` | Isolated repository patch execution, worker bootstrap, artifact capture, PR/Done/Block evidence | Docker runner worker implementation |

## First Reader Path

1. Read [`README.md`](../../README.md) for the canonical source status and repo map.
2. Run the local-only [`five-minute quickstart`](../quickstart.md) when you want a disposable loopback broker plus echo worker path.
3. Read the public-safe [`architecture overview`](../architecture.md) for the conceptual broker/worker/finalizer/evidence map.
4. Use [`contribution entry points`](../contribution-entry-points.md) for safe first-task candidates.
5. Use [`docs/external-harness-quickstart.md`](../external-harness-quickstart.md) when you are integrating a harness — Claude Code, Codex, Hermes, piri, or your own — against the [adapter contract](../../contracts/a2a/platform-adapter-interface.md).
6. Check [`docs/compatibility/README.md`](../compatibility/README.md), [`docs/issue-routing.md`](../issue-routing.md), and [`docs/release-readiness.md`](../release-readiness.md) before making compatibility or release claims.

## Issue Routing

Open unclear or cross-repo issues in `a2a-nexus` first. Once the implementation owner is obvious, apply the source label and route the fix to the owning package path:

- `source:a2a-plane`: monorepo-level public docs, roadmap, cross-package compatibility, release/provenance gates, security/readiness policy, examples, contracts, and topology decisions.
- `source:a2a-broker`: broker HTTP/JSON-RPC behavior, task lifecycle, worker registry, persistence, health/profile endpoints, status/cancel semantics, and broker test failures.
- Harness adapter behaviour (OpenClaw, Claude Code, Codex, Hermes, piri bridges) routes to `source:a2a-broker`; the former `source:openclaw-plugin-a2a` label is retired (see [issue routing](../issue-routing.md)).
- `source:a2a-docker-runner`: isolated patch execution, repository checkout behavior, worker evidence, artifact capture, local runner configuration, container hardening, and runner package issues.

When a change spans multiple package paths, keep the coordinating issue in `a2a-nexus` and link package-specific PR evidence from there.

## Historical References

Completed split-repo trackers such as `a2a-plane#473` and `a2a-plane#477` remain useful provenance. Preserve old issue/PR URLs in evidence, but open new implementation work in `a2a-nexus`.

## Boundaries

This guide does not authorize:

- repository visibility changes
- production deploys or Gateway/broker/worker restarts
- production database, queue, or terminal-outbox mutation
- live provider, Telegram, or notification sends
- secret rotation, credential movement, or raw secret evidence
- release tags, GitHub Releases, npm publication, or Docker image publication
- destructive history rewrites or force pushes

Use placeholders and loopback examples only. Keep production broker URLs, tokens, node IDs, provider identifiers, Telegram IDs, host paths, raw logs, and runtime/bootstrap context out of public docs, issues, PR descriptions, screenshots, and artifacts.
