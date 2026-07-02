# Two-Broker Demo

This guide walks through a local two-broker A2A Nexus demo using Docker Compose. The topology demonstrates cross-broker worker registration, broker identity, and task handoff between two brokers — without deploying to production or using live provider transports.

> **Safety:** This demo uses only loopback Docker networking and placeholder credentials. Do not substitute production brokers, databases, provider transports, Telegram accounts, or terminal outboxes.

## Prerequisites

- Docker and Docker Compose plugin (v2.22+)
- Local checkout of this repository
- No existing broker running on port 8787

## Topology

```text
┌──────────────┐     ┌──────────────┐
│  a2a-broker  │     │  peer-broker │
│  :8787       │◄────│  :8788       │
│  broker-a    │     │  broker-b    │
└──────┬───────┘     └──────┬───────┘
       │                    │
       │  worker-gamma-worker   │  worker-beta-worker
       │  (echo)            │  (echo)
       └────────────────────┘
```

Each broker runs in its own container with a separate state volume. Workers register with the local broker.

## 1. Build the broker image

From the repository root:

```bash
docker compose -f packages/broker/examples/docker-compose.trading-partners.yml build
```

## 2. Start the two-broker stack

```bash
docker compose -f packages/broker/examples/docker-compose.trading-partners.yml up -d
```

Wait for both brokers to be healthy (usually 5-10 seconds):

```bash
docker compose -f packages/broker/examples/docker-compose.trading-partners.yml ps
# Both services should show "healthy"
```

## 3. Verify health endpoints

```bash
# First broker (operator-facing)
curl -s http://127.0.0.1:8787/health | python3 -m json.tool

# Second broker (peer)
curl -s http://127.0.0.1:8788/health | python3 -m json.tool
```

Expected fields:
- `ok: true`
- `service`: `a2a-broker` (broker A) or `peer-broker` (broker B)
- `brokerId`: configured identity
- `persistence`: backend kind and state version

## 4. Register a worker with each broker

```bash
# Register worker-gamma worker with broker A
curl -s -X POST http://127.0.0.1:8787/workers/register \
  -H 'Content-Type: application/json' \
  -d '{
    "nodeId": "worker-gamma-worker",
    "role": "analyst",
    "kind": "node",
    "capabilities": {
      "canAnalyze": true,
      "canBackfill": true,
      "canPatchWorkspace": true
    },
    "workspaceIds": ["demo"],
    "environments": ["development"],
    "homeBrokerId": "broker-a"
  }'

# Register worker-beta worker with broker B
curl -s -X POST http://127.0.0.1:8788/workers/register \
  -H 'Content-Type: application/json' \
  -d '{
    "nodeId": "worker-beta-worker",
    "role": "analyst",
    "kind": "node",
    "capabilities": {
      "canAnalyze": true,
      "canBackfill": true,
      "canPatchWorkspace": true
    },
    "workspaceIds": ["demo"],
    "environments": ["development"],
    "homeBrokerId": "broker-b"
  }'
```

## 5. Submit a task to broker A

```bash
curl -s -X POST http://127.0.0.1:8787/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "two-broker-demo-1",
    "intent": "validate_change",
    "requester": {
      "id": "local-operator",
      "kind": "node",
      "role": "operator"
    },
    "target": {
      "id": "worker-gamma-worker",
      "kind": "node",
      "role": "analyst"
    },
    "assignedWorkerId": "worker-gamma-worker",
    "message": "two-broker demo task",
    "payload": {
      "mode": "local-echo-smoke",
      "noLive": true,
      "replaySafe": true,
      "expectedTerminalEvidence": "Done"
    },
    "taskOrigin": "operator"
  }'
```

Expected response: `201 Created` with the full task record.

## 6. Check worker capacity across brokers

```bash
# Broker A capacity
curl -s http://127.0.0.1:8787/workers/capacity | python3 -m json.tool

# Broker B capacity
curl -s http://127.0.0.1:8788/workers/capacity | python3 -m json.tool
```

## 7. Run a health probe

```bash
# Quick multi-endpoint health check
for port in 8787 8788; do
  echo "=== Broker :$port ==="
  curl -s "http://127.0.0.1:$port/health" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok:', d.get('ok'), '| service:', d.get('service'), '| version:', d.get('version'))"
  curl -s "http://127.0.0.1:$port/workers/capacity" | python3 -c "import sys,json; d=json.load(sys.stdin); print('workers:', d.get('totalWorkers', 0), '| offline:', d.get('offlineWorkers', 0))"
done
```

## Teardown

Stop the two-broker stack and remove volumes:

```bash
docker compose -f packages/broker/examples/docker-compose.trading-partners.yml down -v --remove-orphans
```

Verify ports are released:

```bash
lsof -i :8787 2>/dev/null || echo "Port 8787 free"
lsof -i :8788 2>/dev/null || echo "Port 8788 free"
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Broker container exits immediately | Missing `.env` or bad build | Run `docker compose build` from `packages/broker/` and ensure `.env` exists |
| `curl` returns `connection refused` | Broker not yet healthy | Wait for `docker compose ps` to show `healthy` |
| Worker registration returns 429 | Rate limit hit | Retry after 60 seconds or set `RATE_LIMIT_MAX_REQUESTS=100` |
| Health endpoint missing fields | Broker version mismatch | Rebuild with `docker compose build` |
| Port 8787 already in use | Existing broker process | Run teardown above, or use `PORT=8789` for a different port |

## Reference

- Broker compose file: `packages/broker/examples/docker-compose.trading-partners.yml`
- Broker env template: `packages/broker/.env.example`
- Broker API spec: `packages/broker/docs/api-spec-draft.md`
- Demo overview: [`docs/demo/README.md`](README.md)
