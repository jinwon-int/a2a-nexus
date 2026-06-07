# Five-minute local quickstart

This guide is the external-reader path for a disposable local A2A Plane broker plus a dummy/echo worker. A2A Plane is the independent broker/worker project; OpenClaw is used here as the first/reference integration only. Do not point this path at production brokers, production databases, live provider transports, Telegram accounts, or terminal outboxes.

## Prerequisites

- Node.js 22 or newer
- npm matching the lockfile
- a local checkout of this repository

Install dependencies without lifecycle scripts:

```bash
npm ci --ignore-scripts --include=dev
```

Run a deterministic pre-flight smoke check (no network, no live services):

```bash
npm run smoke:quickstart
```

This builds all workspace packages and validates quickstart conformance and release-gate tests.

If you are integrating a non-OpenClaw harness, use the external harness path after this local smoke:

~~~bash
npm run check:external-harness-conformance
~~~

The public-safe guide is docs/external-harness-quickstart.md; it keeps OpenClaw as a reference integration only and validates the no-live fixture in fixtures/external-harness/no-live-conformance.json.

## 1. Run the local A2A Plane broker

From the broker workspace, use the package's documented local start command:

```bash
cd packages/broker
npm run build
npm run start:local
```

(If you skipped the root-level `npm run smoke:quickstart` step above, first run `cd packages/broker && npm ci --ignore-scripts --include=dev`.)

Use only loopback URLs such as `http://127.0.0.1:8787`. Do not substitute a production broker or restart a managed service.

## 2. Start a dummy or echo worker

Start the built-in local echo worker fixture:

```bash
cd packages/broker
LOCAL_A2A_BROKER_URL=http://127.0.0.1:8787 \
LOCAL_A2A_WORKER_ID=<local-echo-worker> \
npm run worker:echo
```

The worker registers as `local-echo-worker` and uses the built-in `echo` handler. Keep it attached only to the loopback broker.

## 2a. Verify broker health

Once the broker is running, confirm the health endpoint responds:

```bash
curl -s http://127.0.0.1:8787/health | python3 -m json.tool
```

Expected output includes:
- `"ok": true`
- `"service": "a2a-broker"`
- `"version"` with the broker package version
- `"uptimeSec"` counting seconds since broker start
- `"persistence"` describing the state backend
- `"staleReaper"` with reaper configuration and status

A detailed multi-endpoint probe script is available at:

```bash
bash examples/demo/health-check.sh
```

## 3. Connect the reference OpenClaw plugin locally

Use placeholder-only configuration for local development. This verifies the reference integration path; it does not make OpenClaw a required runtime for A2A Plane itself:

```json
{
  "plugins": {
    "entries": {
      "a2a-broker-adapter": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:8787",
          "edgeSecret": "${A2A_EDGE_SECRET}",
          "requester": {
            "id": "local-openclaw-node",
            "kind": "node",
            "role": "operator"
          },
          "operatorEvents": {
            "enabled": false,
            "notification": {
              "enabled": false
            }
          },
          "wakeOnTask": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

Never include real tokens, private hostnames, provider identifiers, Telegram chat IDs, or operator-specific paths in examples, screenshots, issue comments, or PR evidence.

## 4. Submit a no-live test task

Submit the checked-in no-live task fixture from repository root:

```bash
curl -s -X POST http://127.0.0.1:8787/tasks \
  -H 'Content-Type: application/json' \
  -H 'X-A2A-Requester-Id: local-operator' \
  -H 'X-A2A-Requester-Kind: node' \
  -H 'X-A2A-Requester-Role: operator' \
  -d @examples/local/local-quickstart-task.json
```

Expected terminal evidence is one of:

- `Done` with a short echoed result
- `Block` with a clear local setup blocker

Provider-send success (message id returned by a provider) is accepted-send evidence only — it is not requester-visible receipt, operator-visible receipt, human-seen proof, or terminal ACK. Do not treat a provider message id as Done or PR evidence.

## 5. Verify public-readiness checks

Return to the repository root:

```bash
npm run check
```

The public-readiness scan must remain clean before any PR is opened.

Also run the quickstart conformance check directly:

```bash
npm run check:quickstart-conformance
```

## 6. Teardown

When you are done with the local demo, stop the broker and worker processes.

### If running Node.js directly (npm run start:local)

Press `Ctrl+C` in both terminals. Clean up persisted state and verify the port is released:

```bash
rm -f /tmp/a2a-broker-state.json
rm -rf /tmp/a2a-broker-sqlite/
lsof -i :8787 2>/dev/null || echo "Port 8787 is free"
```

### If running via Docker Compose

```bash
docker compose -f packages/broker/docker-compose.yml down -v --remove-orphans
```

A comprehensive teardown script is available:

```bash
bash examples/demo/teardown.sh
```

This script stops Docker stacks, kills local broker processes, cleans state files, and verifies port release.

## Where to go next

- [Demo overview](docs/demo/README.md) — component map, demo paths, health checks, security rules
- [Two-broker demo](docs/demo/two-broker-demo.md) — cross-broker task handoff with Docker Compose
- [External harness quickstart](docs/external-harness-quickstart.md) — non-OpenClaw harness integration
- [Canonical demo description](docs/canonical-demo.md) — sequence diagram and evidence rules
- [Ecosystem guide](docs/ecosystem-guide.md) — full repository map and Korean/English terms

## Safety checklist

Before sharing evidence, confirm:

- repository is public as of 2026-05-27; evidence is still redacted and no new visibility, transfer, publication, or promotion action occurred
- no production deploy, Gateway/broker/worker restart, database mutation, provider send, Telegram send, terminal-outbox ACK, secret rotation, history rewrite, or force push occurred
- evidence is redacted and does not include raw session dumps, private paths, hostnames, tokens, provider IDs, Telegram IDs, or OpenClaw runtime/bootstrap files
- docs and issue/PR evidence introduce the project as A2A Plane, with OpenClaw described only as the first/reference integration
- provider message id / send success is accepted-send evidence only — it is not requester-visible receipt, operator-visible receipt, human-seen proof, or terminal ACK
- task submissions are replay-safe: a duplicate task id must produce the same terminal result without re-execution; workers must treat replayed task ids as idempotent
