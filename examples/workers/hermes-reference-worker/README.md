# Hermes reference worker dry-run

This directory contains a public-safe Hermes-style HTTP polling worker reference for
`a2a-plane#384` Phase 2. It is a local dry-run package, not a production worker
deployment.

The reference proves that a non-OpenClaw runtime can:

- register through `POST /workers/register`;
- heartbeat through `POST /workers/:nodeId/heartbeat`;
- poll assigned work through `GET /tasks?worker=<nodeId>&status=pending`;
- claim/start a local-safe task;
- post terminal Done evidence through `POST /tasks/:id/evidence`.
- persist a local redacted evidence manifest under
  `~/.hermes/a2a/artifacts/<task-id>/evidence.json` before relying on network
  delivery.

## Safety boundary

By default, the script only targets loopback brokers and only executes tasks whose
payload contains:

```json
{
  "mode": "hermes-reference-dry-run",
  "noLive": true
}
```

It refuses non-loopback broker URLs unless
`A2A_HERMES_REFERENCE_ALLOW_NON_LOOPBACK=1` is set. That override is for a
separately approved live canary only; do not use it for routine local smoke tests.

Do not point this example at production brokers, managed worker services,
provider transports, Telegram accounts, terminal outboxes, production databases,
or private secrets.

## Local smoke

From a clean checkout:

```bash
npm ci --ignore-scripts --include=dev
npm --workspace packages/broker run build
```

Terminal 1:

```bash
cd packages/broker
mkdir -p .local
HOST=127.0.0.1 \
PORT=18787 \
PUBLIC_BASE_URL=http://127.0.0.1:18787 \
STATE_FILE=.local/hermes-reference-worker-state.json \
STALE_REAPER_ENABLED=0 \
npm run start
```

Terminal 2, from repository root:

```bash
A2A_BROKER_URL=http://127.0.0.1:18787 \
python3 examples/workers/hermes-reference-worker/a2a_worker.py --action register

curl -s -X POST http://127.0.0.1:18787/tasks \
  -H 'Content-Type: application/json' \
  -H 'X-A2A-Requester-Id: local-operator' \
  -H 'X-A2A-Requester-Kind: node' \
  -H 'X-A2A-Requester-Role: operator' \
  -d @examples/workers/hermes-reference-worker/hermes-local-smoke-task.json

A2A_BROKER_URL=http://127.0.0.1:18787 \
python3 examples/workers/hermes-reference-worker/a2a_worker.py --action run-once

curl -s http://127.0.0.1:18787/tasks/hermes-local-smoke-1 \
  -H 'X-A2A-Requester-Id: local-operator' \
  -H 'X-A2A-Requester-Kind: node' \
  -H 'X-A2A-Requester-Role: operator'
```

Expected result: `hermes-local-smoke-1` reaches `succeeded` with redacted
Hermes reference Done evidence.

## Cron-shaped poll loop

For an approved local-only dry-run environment, copy the script into the Hermes
operator-local script directory and run it on a one-minute cron. Keep the broker
URL loopback unless a separate live canary packet has been approved.

```cron
* * * * * A2A_BROKER_URL=http://127.0.0.1:18787 python3 /path/to/a2a_worker.py --action run-once >> /path/to/a2a-worker.log 2>&1
```

The cron loop must remain `no_agent` style: it should poll broker state and post
terminal evidence without invoking an LLM just to check for work.

## Android / Termux native profile

For Gongyung/Daegyo-style mobile nodes, use the Android native worker runbook:
[`docs/hermes-android-native-worker-runbook.md`](../../../docs/hermes-android-native-worker-runbook.md).

The mobile profile keeps the same HTTP worker contract but adds:

- `runtimeFlavor=termux-hermes` and `gatewayRequired=false` registration metadata;
- local redacted evidence manifests under `~/.hermes/a2a/artifacts/`;
- a restart-safe loop shape for Termux:Boot, cron, or tmux;
- no broad OpenClaw Gateway install requirement on the Android node.
## Termux proot-distro development/testing

For experimental Termux Ubuntu/proot-distro setup notes, see [`docs/termux-proot-distro-a2a-runner.md`](../../../docs/termux-proot-distro-a2a-runner.md). This is for no-live development/testing only; production worker services should use the VPS/systemd deployment path.
