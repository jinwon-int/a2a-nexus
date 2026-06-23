# A2A Issue Routing Policy

> **Status:** current policy after the `a2a-nexus` canonical-source flip. New implementation work starts in `jinwon-int/a2a-nexus`; older split repositories are provenance/history references unless a maintainer explicitly marks a mirror active for a specific task.

## Default Routing

Open unclear or cross-repo issues in `a2a-nexus` first. Route implementation work by source label and package path once the boundary is clear.

| Label | Owning surface in `a2a-nexus` | Use when |
| --- | --- | --- |
| `source:a2a-plane` | monorepo-level docs/contracts/examples/scripts | Public umbrella docs, contracts, fixtures, readiness gates, topology decisions, issue routing, release policy. |
| `source:a2a-broker` | `packages/broker/` | Broker API, task lifecycle, worker registry, dispatch/readiness gates, durable evidence, broker persistence. |
| `source:a2a-docker-runner` | `packages/docker-runner/` | Isolated execution, checkout hygiene, PR/Done/Block evidence, runner CLI/package, runner release dry-run evidence. |
| `source:openclaw-plugin-a2a` | `packages/openclaw-plugin-a2a/` | OpenClaw adapter behavior, request/status/cancel mapping, diagnostics, OpenClaw peer boundary. |

Do not create or use `source:agent-olympics` in A2A routing. Agent Olympics is an independent repository and not an A2A implementation package.

## Canonical Source Rules

- New ambiguous, cross-package, or policy issues go to `jinwon-int/a2a-nexus`.
- Package-specific bugs may still use the source labels above, but the PR and closeout evidence should live in `a2a-nexus` unless an operator explicitly approves a mirror-only fix.
- Preserve old split-repo issue/PR URLs as provenance, not as the authoritative queue for new work.
- keep closed issues and PRs in their original repos; do not transfer or rewrite historical records during routing cleanup.
- Avoid close keywords that accidentally close legacy issues in the wrong repo.
- Keep public evidence redacted and source-only unless an operator explicitly approves deploy/restart/send/visibility actions.
