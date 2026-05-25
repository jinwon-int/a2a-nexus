# A2A Plane Demo Guide

Welcome to the A2A Plane demo packaging. This directory is the public-safe entry point for external operators evaluating A2A Plane from a fresh checkout. All demos use only loopback networking, placeholder credentials, and no-live-send task fixtures.

> **Status:** private-readiness candidate. Do not make this repository public until every gate in [`docs/public-readiness.md`](../public-readiness.md) is closed and an operator explicitly approves the visibility change.

## Component map

```text
┌───────────────────────────────────────────────────────────────────┐
│  A2A Plane (this checkout)                                         │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ packages/broker/              Task lifecycle, worker API    │  │
│  │ packages/docker-runner/       Isolated GitHub patch worker  │  │
│  │ packages/openclaw-plugin-a2a/ OpenClaw Gateway adapter      │  │
│  ├─────────────────────────────────────────────────────────────┤  │
│  │ contracts/a2a/                Shared task lifecycle types   │  │
│  │ contracts/compatibility/      Baseline compatibility matrix │  │
│  ├─────────────────────────────────────────────────────────────┤  │
│  │ docs/                         Quickstart, demos, gates      │  │
│  │ examples/                     Public-safe task fixtures     │  │
│  │ scripts/                      CI, conformance, release gate │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘

External repos (mapped into this monorepo for validation):
  a2a-broker            → packages/broker/
  a2a-docker-runner     → packages/docker-runner/
  openclaw-plugin-a2a   → packages/openclaw-plugin-a2a/
```

## Demo paths

| Demo | Guide | Requires | Expected outcome |
|------|-------|----------|------------------|
| Single-node quickstart | [`docs/quickstart.md`](../quickstart.md) | Node.js 22+, npm, local checkout | Echo task reaches `succeeded` with Done evidence |
| Two-broker handoff | [`docs/demo/two-broker-demo.md`](two-broker-demo.md) | Docker, Docker Compose, local checkout | Broker registers peer, cross-broker task reaches terminal state |
| External harness | [`docs/external-harness-quickstart.md`](../external-harness-quickstart.md) | Node.js 22+, npm | Conformance checks pass for non-OpenClaw harness |
| Canonical demo | [`docs/canonical-demo.md`](../canonical-demo.md) | (Documentation-only) | Sequence diagram and evidence rules |

## Secret-handling rules

All demo paths follow the same security rules:

1. **No real secrets in docs.** Every credential location in documentation is a masked placeholder (`${VARIABLE_NAME}`, `<masked-host>`, `<placeholder>`).
2. **No real secrets in examples.** Every `.env.example`, `task.json`, and `docker-compose.yml` uses placeholder or default-loopback values.
3. **No credential disclosure in evidence.** Issue comments, PR descriptions, logs, and screenshots must redact broker URLs, provider IDs, Telegram chat IDs, node IDs, and host paths.
4. **Secrets live outside the checkout.** Credential files (`.env`, `credentials.json`, `secrets/`) are gitignored and never committed.
5. **Fail closed on bootstrap context.** Before any PR is opened, verify that no OpenClaw runtime/bootstrap context file (see [`docs/release-checklist.md`](../release-checklist.md)) would enter the branch or attached evidence.

### Secret location reference

| Credential | Environment variable | Placeholder file | Purpose |
|-----------|---------------------|------------------|---------|
| Edge secret | `EDGE_SECRET` / `A2A_EDGE_SECRET` | `packages/broker/.env.example` | Broker request authentication |
| Broker identity | `A2A_BROKER_ID` | `packages/broker/.env.example` | Stable broker-of-record identifier |
| Worker identity | `WORKER_ID` | `packages/broker/.env.example` | Worker registration name |
| Home broker lease | `A2A_HOME_BROKER_ID` | `packages/broker/.env.example` | Worker-to-broker pinning guard |
| Public base URL | `PUBLIC_BASE_URL` | `packages/broker/.env.example` | Agent card URL for external callers |

## Health checks

Every running broker exposes a `GET /health` endpoint that returns broker identity, version, build info, uptime, persistence backend, worker configuration, stale-reaper status, and rate-limit pressure. Use the helper script at [`examples/demo/health-check.sh`](../../examples/demo/health-check.sh) for a quick health probe, or curl directly:

```bash
curl -s http://127.0.0.1:8787/health | head -1
# {"ok":true,"service":"a2a-broker",...}
```

The broker Docker Compose file also includes a container-level healthcheck that polls `/health` every 10 seconds.

Detailed task and worker health is available at:

- `GET /workers/capacity` — worker capacity summary
- `GET /tasks/diagnostics` — bulk task diagnostic scan
- `GET /alerts` — monitoring-friendly alert projection

## Teardown

### Local (no Docker)

```bash
# Stop the broker and echo worker with Ctrl+C in their terminals.
# Clean up persisted state (if any):
rm -f /tmp/a2a-broker-state.json
rm -rf /tmp/a2a-broker-sqlite/

# Verify no leftover processes:
lsof -i :8787 2>/dev/null || echo "Port 8787 is free"
```

### Docker Compose

```bash
docker compose -f packages/broker/docker-compose.yml down -v --remove-orphans
```

### Two-broker Docker Compose

```bash
docker compose -f packages/broker/examples/docker-compose.trading-partners.yml down -v --remove-orphans
```

See the helper script at [`examples/demo/teardown.sh`](../../examples/demo/teardown.sh) for an all-in-one teardown.

## Safety rules (all demos)

- Use only loopback broker URLs (`http://127.0.0.1:8787`).
- Do not point demo paths at production brokers, databases, provider transports, Telegram accounts, or terminal outboxes.
- Do not restart production Gateway/broker/worker services.
- Do not ACK/replay terminal outbox events or terminal briefs.
- Do not publish releases, create tags, or change repository visibility.
- Provider-send success is **accepted-send evidence only** — not operator-visible receipt, human-seen proof, or terminal ACK evidence.

## Conformance

All demo guides are validated by the quickstart conformance check:

```bash
npm run check:quickstart-conformance
```

This read-only check verifies structural markers, deterministic command references, loopback URLs, and placeholder safety.
