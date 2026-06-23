# Public A2A Nexus Quickstart Umbrella

Use `a2a-nexus` as the canonical public start-here repository for A2A Nexus implementation work. It contains the broker, Docker runner, OpenClaw reference plugin, contracts, public-safe demos, release gates, and issue routing.

The older split repositories (`a2a-plane`, `a2a-broker`, `openclaw-plugin-a2a`, and `a2a-docker-runner`) are provenance/history references unless a maintainer explicitly points to an active mirror. Do not treat them as authoritative for new implementation issues.

## Repository Map

| Surface | Start here when you need | Canonical boundary |
| --- | --- | --- |
| [`jinwon-int/a2a-nexus`](https://github.com/jinwon-int/a2a-nexus) | Project overview, local quickstarts, cross-package coordination, compatibility/readiness docs, release/provenance gates, and issue routing | Canonical implementation source for A2A Nexus |
| `packages/broker/` | Broker HTTP/JSON-RPC behavior, task API, worker registration, health/profile, broker CI | Broker runtime and API implementation |
| `packages/openclaw-plugin-a2a/` | OpenClaw Gateway integration, adapter configuration, diagnostics, request/status/cancel mapping, event/wake bridge | Reference OpenClaw plugin implementation |
| `packages/docker-runner/` | Isolated repository patch execution, worker bootstrap, artifact capture, PR/Done/Block evidence | Docker runner worker implementation |

## First Reader Path

1. Read [`README.md`](../../README.md) for the canonical source status and repo map.
2. Run the local-only [`five-minute quickstart`](../quickstart.md) when you want a disposable loopback broker plus echo worker path.
3. Use [`docs/demo/split-repo-local-demo.md`](../demo/split-repo-local-demo.md) when you want to inspect the three-package story inside this monorepo.
4. Use [`docs/external-harness-quickstart.md`](../external-harness-quickstart.md) if you are integrating a non-OpenClaw harness.
5. Check [`docs/compatibility/README.md`](../compatibility/README.md), [`docs/issue-routing.md`](../issue-routing.md), and [`docs/release-checklist.md`](../release-checklist.md) before making compatibility or release claims.

## Issue Routing

Open unclear or cross-repo issues in `a2a-nexus` first. Once the implementation owner is obvious, apply the source label and route the fix to the owning package path:

- `source:a2a-plane`: monorepo-level public docs, roadmap, cross-package compatibility, release/provenance gates, security/readiness policy, examples, contracts, and topology decisions.
- `source:a2a-broker`: broker HTTP/JSON-RPC behavior, task lifecycle, worker registry, persistence, health/profile endpoints, status/cancel semantics, and broker test failures.
- `source:openclaw-plugin-a2a`: OpenClaw adapter configuration, diagnostics, Gateway integration behavior, request/status/cancel mapping, operator event handling, and plugin package issues.
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
