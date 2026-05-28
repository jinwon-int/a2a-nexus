# Split-Repo Local Demo Quickstart

A no-live public local demo showing the three-package A2A Plane story: broker AgentCard/profile, plugin diagnostics/profile visibility, and docker-runner dry-run evidence. Intended for first-time evaluators who want to see each split-repo component's role without live brokers, providers, or deployments.

**Parent:** [#473](https://github.com/jinwon-int/a2a-plane/issues/473)
**Tracking:** [#480](https://github.com/jinwon-int/a2a-plane/issues/480)
**Completed upstream issues:** [#951](https://github.com/jinwon-int/a2a-broker/issues/951), [#454](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/454), [#343](https://github.com/jinwon-int/a2a-docker-runner/issues/343)

## Safety boundary

This guide uses only loopback URLs (`http://127.0.0.1:8787`) and checked-in fixtures. Do not point it at production brokers, databases, provider transports, Telegram accounts, terminal outboxes, or OpenClaw Gateway deployments. No production deploy, Gateway restart, live provider send, database mutation, terminal-outbox ACK, secret exposure, release publish, history rewrite, or force push.

## Repo topology

```text
┌───────────────────────────────────────────────────────────┐
│  a2a-plane (this repo) — umbrella docs, contracts,        │
│  examples, cross-repo coordination                        │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ packages/broker/          AgentCard/profile, worker │  │
│  │                          registration, task API     │  │
│  ├─────────────────────────────────────────────────────┤  │
│  │ packages/openclaw-plugin-a2a/  Diagnostics, config  │  │
│  │                              schema, event bridge   │  │
│  ├─────────────────────────────────────────────────────┤  │
│  │ packages/docker-runner/     Dry-run evidence        │  │
│  │                            manifests, artifacts     │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

Each package lives in its own upstream repo — see [public-umbrella.md](../quickstart/public-umbrella.md) for the full repo map.

## Prerequisites

- Node.js 22+
- npm
- local checkout of this repository

```bash
npm ci --ignore-scripts --include=dev
```

## 1. Broker — AgentCard/profile inspection

The broker exposes an AgentCard — a discoverable profile at `/.well-known/agent-card.json` that describes capabilities, skills, and protocol version ([a2a-broker#951](https://github.com/jinwon-int/a2a-broker/issues/951)).

Start the broker on loopback:

```bash
cd packages/broker
npm run build
npm run start:local
```

In another terminal, inspect the AgentCard:

```bash
curl -s http://127.0.0.1:8787/.well-known/agent-card.json | python3 -m json.tool
```

Expected fields:
- `name` — broker service name
- `description` — coordination service summary
- `url` — A2A JSON-RPC endpoint
- `version`, `protocolVersion` — compatibility metadata
- `capabilities` — streaming and push-notification flags
- `skills` — registered skill set (analyze, propose_patch, validate_change, etc.)
- `provider` — optional organization identifier

Then inspect worker capacity and health:

```bash
curl -s http://127.0.0.1:8787/workers/capacity | python3 -m json.tool
curl -s http://127.0.0.1:8787/health | python3 -m json.tool
```

Stop the broker with `Ctrl+C` when done.

## 2. Plugin — diagnostics/profile visibility

The OpenClaw A2A plugin config schema and diagnostics surface are in `packages/openclaw-plugin-a2a/`. The plugin exposes its config profile through `openclaw.plugin.json` and diagnostics through Gateway monitoring handlers ([openclaw-plugin-a2a#454](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/454)).

Inspect the plugin config schema (deterministic, no install needed):

```bash
python3 -m json.tool packages/openclaw-plugin-a2a/openclaw.plugin.json
```

Key sections:
- `configSchema.properties` — baseUrl, edgeSecret, requester, operatorEvents, wakeOnTask
- `uiHints` — human-readable label/help for each config field
- `activation` — lifecycle trigger (onStartup)

The plugin exposes diagnostic visibility through:
- Gateway runtime bridge (`src/gateway-runtime-bridge.ts`) — runtime status
- Monitoring handlers (`src/gateway-monitoring-handlers.ts`) — operator-facing diagnostics
- Standalone broker client (`standalone-broker-client.ts`) — direct broker integration

Run the plugin's own deterministic conformance checks:

```bash
cd packages/openclaw-plugin-a2a
npm ci --ignore-scripts --include=dev
npm test
```

This runs the unit test suite against the plugin's config schema, gateway handlers, handoff visibility policy, and agent card discovery. All tests are no-live and read-only.

## 3. Docker runner — dry-run evidence

The docker-runner produces structured evidence manifests for every task execution. The dry-run mode reports candidates without performing destructive operations ([a2a-docker-runner#343](https://github.com/jinwon-int/a2a-docker-runner/issues/343)).

Inspect the canonical task fixture:

```bash
python3 -m json.tool packages/docker-runner/examples/task.canonical.json
```

Expected structure:
- `id`, `intent`, `mode` — task identity
- `commands` — deterministic shell commands
- `issueUrl`, `requestedBy`, `timeoutMs` — task metadata
- `env` — environment overrides

The runner also exposes a `--dry-run` flag for the cleanup command:

```bash
cd packages/docker-runner
npm run build
node dist/cli.js cleanup --ttl 24h --dry-run 2>&1 || true
```

In dry-run mode the runner reports candidate expired directories without deletion.

The runner's task manifest structure includes:
- `task` — normalized task definition
- `status` — done, failed, or budget_limited
- `stdout`, `stderr` — redacted and bounded execution logs
- `prUrl` — pull request URL when mode is github-propose-patch
- `artifacts` — collected file manifest with checksums
- `receiptTrace` — delivery receipt chain evidence

The terminal evidence contract is documented in the runner's fixture examples:

```bash
python3 -m json.tool packages/docker-runner/examples/runner-terminal-evidence-fixture.json
```

## 4. Conformance check

Run the deterministic conformance check that validates all three split-repo components:

```bash
npm run check:split-repo-local-demo
```

This validates:
- Split-repo local demo fixture structure and no-live safety
- Broker AgentCard/profile fixture expectations
- Plugin diagnostics/profile visibility fixture expectations
- Docker-runner dry-run evidence fixture expectations
- All safety flags are false (no production deploy, no live send, etc.)

## Summary

| Step | Component | What you verified | Upstream issue |
|------|-----------|-------------------|----------------|
| 1 | Broker | AgentCard JSON-RPC profile, worker capacity, health | [#951](https://github.com/jinwon-int/a2a-broker/issues/951) |
| 2 | Plugin | Config schema, diagnostics surface, unit tests | [#454](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/454) |
| 3 | Docker runner | Dry-run evidence, task manifest structure | [#343](https://github.com/jinwon-int/a2a-docker-runner/issues/343) |
| 4 | Plane umbrella | Conformance check across all three packages | [#480](https://github.com/jinwon-int/a2a-plane/issues/480) |

## Where to go next

- [Five-minute quickstart](../quickstart.md) — full local broker + echo worker path
- [Demo overview](README.md) — component map, demo paths, health checks
- [Public umbrella quickstart](../quickstart/public-umbrella.md) — repo map and issue routing
- [Topology decision record](../topology-decision-record.md) — why the repo split is intentional

## Safety checklist

Before sharing any evidence:
- [ ] No production broker, database, provider, or Telegram was touched
- [ ] No Gateway or broker service was restarted
- [ ] No terminal-outbox ACK or terminal brief was replayed
- [ ] No releases, tags, or npm/Docker publications were created
- [ ] No repository visibility was changed
- [ ] No history was rewritten or force-pushed
- [ ] All URLs in evidence are loopback (`http://127.0.0.1:8787`) or GitHub issue links
- [ ] All secrets, tokens, and private paths are redacted
- [ ] OpenClaw runtime/bootstrap context files are excluded from the branch
