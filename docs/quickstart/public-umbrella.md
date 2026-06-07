# Public A2A Umbrella Quickstart

Use `a2a-plane` as the public start-here repository for A2A. It explains the repo map, safety boundaries, local docs path, and issue routing across the split implementation repos.

The split layout is intentional per the [topology decision record](../topology-decision-record.md). Do not treat the umbrella docs as a monorepo cutover decision. Until an operator-initiated re-entry triggers consolidation, the current public source repositories remain canonical for their own implementation boundaries.

## Repository Map

| Repository | Start here when you need | Canonical boundary |
| --- | --- | --- |
| [`jinwon-int/a2a-plane`](https://github.com/jinwon-int/a2a-plane) | Project overview, public quickstarts, cross-repo coordination, compatibility/readiness docs, release/provenance gates | Umbrella docs, contracts, examples, public policy, issue routing, topology decisions |
| [`jinwon-int/a2a-broker`](https://github.com/jinwon-int/a2a-broker) | Broker service behavior, task API, worker registration, status/cancel flow, Agent Card/profile, broker CI | Broker runtime and API implementation |
| [`jinwon-int/openclaw-plugin-a2a`](https://github.com/jinwon-int/openclaw-plugin-a2a) | OpenClaw Gateway integration, adapter configuration, diagnostics, request/status/cancel mapping, event/wake bridge | Reference OpenClaw plugin implementation |
| [`jinwon-int/a2a-docker-runner`](https://github.com/jinwon-int/a2a-docker-runner) | Isolated repository patch execution, worker bootstrap, artifact capture, PR/Done/Block evidence | Docker runner worker implementation |

## First Reader Path

1. Read [`docs/current-state.md`](../current-state.md) for the active #506 wave, live child issues, and safety boundary.
2. Read [`README.md`](../../README.md) for the public source status and repo map.
3. Use this page to decide which repository owns your question or change.
4. Run the local-only [`five-minute quickstart`](../quickstart.md) when you want a disposable loopback broker plus echo worker path.
5. Use [`docs/demo/split-repo-local-demo.md`](../demo/split-repo-local-demo.md) when you want to inspect the three-package story (broker AgentCard, plugin diagnostics, runner dry-run evidence).
6. Use [`docs/external-harness-quickstart.md`](../external-harness-quickstart.md) if you are integrating a non-OpenClaw harness.
7. Check [`docs/compatibility/README.md`](../compatibility/README.md) and [`docs/release-checklist.md`](../release-checklist.md) before making compatibility or release claims.

## Issue Routing

Open unclear or cross-repo issues in `a2a-plane` first. Once the implementation owner is obvious, route the fix or follow-up issue to the owning repository:

- `a2a-plane`: public docs, roadmap, cross-repo compatibility, release/provenance gates, security/readiness policy, examples, contracts, and repo-topology decisions.
- `a2a-broker`: broker HTTP/JSON-RPC behavior, task lifecycle, worker registry, persistence, health/profile endpoints, status/cancel semantics, and broker test failures.
- `openclaw-plugin-a2a`: OpenClaw adapter configuration, diagnostics, Gateway integration behavior, request/status/cancel mapping, operator event handling, and plugin package issues.
- `a2a-docker-runner`: isolated patch execution, repository checkout behavior, worker evidence, artifact capture, local runner configuration, container hardening, and runner package issues.

When a change needs multiple repos, keep the coordinating issue in `a2a-plane` and link the implementation PRs or child issues from there.

## Current Umbrella Trackers

- [a2a-plane#506](https://github.com/jinwon-int/a2a-plane/issues/506) — active current-state integration and A2A effectiveness wave.
- [a2a-plane#507](https://github.com/jinwon-int/a2a-plane/issues/507) — current-state docs and checkout hygiene.
- [a2a-plane#508](https://github.com/jinwon-int/a2a-plane/issues/508) — no-live cross-repo integration smoke spec.

Completed historical trackers:

- [a2a-plane#473](https://github.com/jinwon-int/a2a-plane/issues/473) — adopted split-repo topology decision. Decision recorded in [`docs/topology-decision-record.md`](../topology-decision-record.md).
- [a2a-plane#477](https://github.com/jinwon-int/a2a-plane/issues/477) — public repo map and quickstart umbrella docs. Merged via #484.
- [a2a-plane#478](https://github.com/jinwon-int/a2a-plane/issues/478) — public-source security, secret-history, license, and provenance scan groundwork.
- [a2a-plane#479](https://github.com/jinwon-int/a2a-plane/issues/479) — public release, version, and provenance checklist groundwork.
- [a2a-plane#480](https://github.com/jinwon-int/a2a-plane/issues/480) — local public demo and quickstart scenario across broker, plugin, and runner.

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
