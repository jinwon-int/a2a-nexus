# plugin-a2a

[![ci](https://github.com/jinwon-int/a2a-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/jinwon-int/a2a-nexus/actions/workflows/ci.yml)

A2A broker adapter plugin, developed in the `jinwon-int/a2a-nexus` monorepo
under `packages/openclaw-plugin-a2a`.

> Public-readiness note: this package is intentionally marked `private` and
> should be treated as an unpublished/private-candidate plugin until the exact
> supported OpenClaw plugin-SDK baseline is validated in the compatibility
> matrix. Do not interpret the temporary `openclaw` peer range as a public
> wildcard compatibility guarantee.

## Repository role in the A2A layout

`plugin-a2a` is the OpenClaw-facing adapter for the A2A stack.

It owns:

- OpenClaw gateway/plugin methods for A2A task request, status, cancel, and monitoring projection
- broker client configuration and task/error mapping at the plugin boundary
- plugin-owned protocol compatibility docs and regression coverage for OpenClaw ↔ broker handoff
- the migration target for A2A-specific runtime ownership that should not remain in OpenClaw core

It does **not** own the broker control plane, Docker Compose-managed broker process, or Docker task execution. Those are intentionally separate monorepo/private-candidate components with public-safe names `a2a-broker` and `a2a-docker-runner`. Plugin status may surface compact broker runtime-owner metadata for operators, but this repo must not control Docker Compose or systemd.

Current production shape as of 2026-04-30:

```text
OpenClaw/plugin request → a2a-broker task lifecycle → worker handler → a2a-docker-runner for GitHub patch execution
```

This repo remains the plugin home and compatibility boundary, not the home for all A2A runtime code.
## Current scope

This repo is the extracted home for the plugin-owned OpenClaw integration surface that talks to `a2a-broker`.

Current plugin id:

- `a2a-broker-adapter`

Current ownership:

- broker client configuration
- OpenClaw gateway method handlers for `a2a.task.*`
- plugin-owned request, update, cancel, and status projection boundary over broker APIs
- opt-in broker operator event bridge surfaced through `a2a.monitor.status`
- broker task status and error mapping
- plugin-local request validation and error shaping

## Why this repo exists

The long-term split is:

- `openclaw/openclaw`: generic seams only
- `plugin-a2a`: OpenClaw adapter and orchestration ownership
- `a2a-broker`: standalone broker domain logic

That keeps the A2A workstream parallelizable without leaving permanent A2A-specific behavior in OpenClaw core.

## Current status

This is an initial extraction snapshot from the in-repo OpenClaw extension package.
A small amount of runtime ownership still lives in the OpenClaw tree today, so this repo should be treated as the plugin home and migration target, not yet the final fully independent cut.

## Source-of-truth docs

Primary docs under [`docs/`](./docs) drive the remaining work. Start there before opening follow-up issues:

- [`docs/migration-plan.md`](./docs/migration-plan.md) — inventory of what still lives in OpenClaw core (notably the delegated-task runtime in the `sessions_send` path), the plugin-SDK seams that need to be added, the dependency-aware order to do the extraction in, and the broker contract fields that must stay aligned.
- [`docs/protocol.md`](./docs/protocol.md) — the durable-runtime boundary this plugin currently owns, including how `a2a.task.request | update | cancel | status` map onto broker lifecycle calls and what fields must round-trip intact.
- [`docs/agent-card-discovery.md`](./docs/agent-card-discovery.md) — A2A agent-card discovery profile, capability flags, local/dev fixture, production opt-in/redaction requirements, and a public-safe companion-worker example for a TweetClaw-enabled X/Twitter automation node.
- [`docs/regression-matrix.md`](./docs/regression-matrix.md) — scenario-by-scenario coverage plan for plugin-to-broker lifecycle behavior (success, timeout, stale worker / requeue / dead-letter, auth failure, rate limit, mapping/error shaping, cancel, not-found), with automated-vs-smoke classification and a plugin-symptom → broker-cause correlation table.
- [`docs/compatibility-matrix.md`](./docs/compatibility-matrix.md) — compatibility definition across plugin release, OpenClaw seam baseline, and supported `a2a-broker` version/schema ranges.
- [`docs/alpha-boundaries.md`](./docs/alpha-boundaries.md) — what "alpha" means for this plugin, operational constraints, and exit criteria for leaving alpha.
- [`docs/public-stable-readiness.md`](./docs/public-stable-readiness.md) — public-safe plugin config placeholders, compatibility boundary, and no-live-notification defaults for stable readiness checks.
- [`docs/operator-install-checklist.md`](./docs/operator-install-checklist.md) — operator-facing install and configuration checklist, diagnostics commands reference, safety boundary summary, and verification runbook. Start here as a new operator.
- [`docs/operator-terminal-notification-receipts.md`](./docs/operator-terminal-notification-receipts.md) — receipt-confirmed ack policy for terminal operator notifications; Gateway/provider send success alone must not ack broker terminal-outbox events.
- [`docs/goal-operator-ux.md`](./docs/goal-operator-ux.md) — plugin-side goal method surface and concise operator summaries that distinguish child task success from goal achievement.

Supporting issue docs:

- [`docs/sessions-send-hook-contract.md`](./docs/sessions-send-hook-contract.md) — plugin-owned expectations for the future `sessions_send` interception hook, what remains plugin-owned vs core-owned in the dispatch-flip step, and the migration / verification checklist for plugin issue #7.
- [`docs/remote-handoff-visibility-policy.md`](./docs/remote-handoff-visibility-policy.md) — operator-safe defaults for remote handoff allow/deny/missing-target/approval-required/error visibility mapping and the coordinated release trigger.
- [`docs/legacy-delete-gate-audit.md`](./docs/legacy-delete-gate-audit.md) — active-owner mapping and concrete delete blockers for legacy issue #12 / parent #6.

## Current executable coverage

The repo now carries standalone tests that lock down the plugin-owned boundary without depending on OpenClaw core internals:

- request mapping into broker `createTask`
- execution-status writes driving broker `claim -> start -> complete`
- cancel mapping into broker cancel fan-out payloads
- broker status projection back into monitoring-friendly gateway fields
- metadata round-trip for `correlationId`, `parentRunId`, requester/target refs, `expectedOutput`, and case-context payload
- operator event snapshot/summary/alert projection with visible reconnect/failure state
- local/dev A2A agent-card discovery fixture with required fields, capability flags, redaction checks, and production exposure marked opt-in
- terminal operator notification receipt policy: no live cursor/outbox ack from provider/Gateway success alone
- goal-level operator summaries for active, paused, blocked, and budget-limited objectives

Run them with:

```bash
npm test
```

## Next migration steps

Tracked in detail in [`docs/migration-plan.md`](./docs/migration-plan.md). Summary:

1. land plugin-SDK seams in OpenClaw core (sessions-send hook, wait-run handle, cancel fan-out, heartbeat timer)
2. re-home the delegation decision behind the new sessions-send hook
3. move the remaining broker-backed delegated-task runtime out of OpenClaw core
4. add standalone tests per the regression matrix once the runtime lives here
5. publish a stable install path and compatibility matrix with `a2a-broker`
6. decide whether to keep the plugin id as `a2a-broker-adapter` or rename it in a compatibility-safe way

## Android / Termux validation note

Validated on Android Termux with:

- Node `v24.14.0`
- globally installed `openclaw` package already present on the node
- sibling `a2a-broker` clone used for the smoke path

### Termux-specific install and build quirks

1. If this repo is cloned under an existing OpenClaw workspace, plain `npm install` may try to satisfy the `openclaw` peer from the ancestor tree and hit Android-only install failures such as `@lancedb/lancedb ... Unsupported platform: android`.
2. Termux does not provide `/usr/bin/env`, so the usual `node_modules/.bin/tsc` shim fails with `bad interpreter`. The build script therefore uses `node ./node_modules/typescript/bin/tsc -p tsconfig.json` instead of relying on the shim.
3. TypeScript still needs the OpenClaw plugin SDK available as a resolvable package. On a Termux node that already has OpenClaw installed globally, symlink the global package into local `node_modules` before building.

### Repeatable Termux build steps

```bash
git clone <plugin-repo-url>
cd plugin-a2a
npm install --legacy-peer-deps
ln -sfn "$(npm root -g)/openclaw" node_modules/openclaw
npm run build
```

### Delegated-task smoke path used for validation

Broker and worker were started locally from a sibling `a2a-broker` checkout, then the plugin's gateway broker client created a delegated task against the broker.

Recommended local smoke settings on Termux:

- broker: increase local rate-limit headroom for smoke runs, for example `RATE_LIMIT_MAX_REQUESTS=120` and `WORKER_RATE_LIMIT_MAX_REQUESTS=240`
- worker: prefer `WORKER_POLL_INTERVAL_MS=1000` for local smoke runs

Why: aggressive local polling can trip broker 429 rate limits before the first queued task is processed, especially when the requester is also polling task status.

Observed successful smoke result:

- task submitted through the plugin client from the Termux node
- target worker: `<termux-smoke-worker>`
- final execution status: `completed`
- final delivery status: `skipped`
- returned output included the echoed task message and succeeded broker status

This validates that the standalone plugin can build on Termux, reach a standalone broker, and complete at least one delegated-task round trip when the environment is configured with the Termux-specific workarounds above.

##  Operator quick-start

New operators should start with the dedicated
[`docs/operator-install-checklist.md`](./docs/operator-install-checklist.md) document.
It covers:

- **Plugin installation** — build-from-source steps for all platforms.
- **Configuration checklist** — per-field guidance with safety-default emphasis.
- **Diagnostics commands** — `a2a.monitor.status` (including preflight mode),
  `a2a.alerts.list`, and `a2a.task.status` with example request/response patterns.
- **Safety boundaries** — accepted-send vs ACK policy, no-live-send defaults,
  status wording semantics, and the full non-ACK status set.
- **Verification runbook** — a copy-paste sequence of `npm run` commands that
  exercise all pre-flight and conformance checks without live sends.

### Single-task diagnostics from the Gateway

```bash
# Full operator status projection (broker health + no-live rehearsal + readiness)
# Gateway RPC: a2a.monitor.status

# No-live preflight — checks readiness layers without sending or ACKing
# a2a.monitor.status with params.operatorEvents.preflight=true

# Single-task diagnostics by taskId
# a2a.monitor.status with params.taskId

# Operator alerts
# a2a.alerts.list

# Task-level status (executionStatus + deliveryStatus)
# a2a.task.status
```

All diagnostics surfaces are read-only. They do not send messages, restart the
Gateway, or ACK terminal outbox records. See the
[operator install checklist](./docs/operator-install-checklist.md#4-verification-diagnostics-commands)
for full request/response patterns.

## Community

- [`SECURITY.md`](./SECURITY.md) — vulnerability reporting and safety invariants
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — development setup, safety gates, and PR checklist
- [Issue templates](https://github.com/jinwon-int/a2a-nexus/issues) — bug report template and issue tracker configuration
