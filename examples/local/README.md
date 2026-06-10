# Local A2A Nexus echo quickstart

This directory contains a no-live local task fixture for the five-minute quickstart in `docs/quickstart.md`.

## Safety boundary

Use only loopback broker URLs such as `http://127.0.0.1:8787`. Do not use production brokers, managed worker services, real provider transports, Telegram accounts, terminal outboxes, production databases, or private secrets.

## Run

From a clean checkout:

```bash
npm ci --ignore-scripts --include=dev
cd packages/broker
npm run build
```

Terminal 1:

```bash
npm run start:local
```

Terminal 2:

```bash
npm run worker:echo
```

Terminal 3, from repository root:

```bash
curl -s -X POST http://127.0.0.1:8787/tasks \
  -H 'Content-Type: application/json' \
  -H 'X-A2A-Requester-Id: local-operator' \
  -H 'X-A2A-Requester-Kind: node' \
  -H 'X-A2A-Requester-Role: operator' \
  -d @examples/local/local-quickstart-task.json

curl -s http://127.0.0.1:8787/tasks/local-smoke-1 \
  -H 'X-A2A-Requester-Id: local-operator' \
  -H 'X-A2A-Requester-Kind: node' \
  -H 'X-A2A-Requester-Role: operator'
```

Expected result: the task reaches `succeeded` with echo-style Done evidence. If it returns `Block`, keep the blocker local and do not substitute production infrastructure.

## Accepted-send is non-ACK

Provider-send success (a returned message id) is accepted-send evidence only. It is not requester-visible receipt, operator-visible receipt, human-seen proof, or terminal ACK. Only PR, Done, or Block evidence from the A2A worker qualifies as terminal evidence.

## Replay-safe

This task fixture is replay-safe: submitting the same task id (`local-smoke-1`) a second time must produce the same terminal result without duplicate side effects. Workers must treat replayed task ids as idempotent. Do not submit duplicate tasks expecting different behavior.
