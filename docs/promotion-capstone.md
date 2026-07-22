# Promotion-ready quickstart capstone

This capstone is the canonical external-user path for proving A2A Nexus can be checked out, built, and exercised locally without live services. It closes the product-surface gap tracked by #665 and follows the A2AD direction from #663. Stable/experimental promotion decisions remain linked to #649.

Safety boundary: every command below is no-live and local-only. Do not use production brokers, production databases, live provider transports, Telegram accounts, terminal outboxes, private hostnames, real credentials, or managed worker services. This capstone requires no production deploy, no Gateway/broker/worker restart, no Telegram send, no provider send, no release/tag/npm publish, and no database migration or prune. Configuration examples are placeholder-only.

## Stable vs experimental surfaces

| Surface | Status | Evidence |
| --- | --- | --- |
| Local loopback broker + echo worker | Stable capstone path | `docs/quickstart.md`, `examples/local/local-quickstart-task.json`, `npm run smoke:quickstart` |
| External harness boundary fixture | Stable conformance fixture | `docs/external-harness-quickstart.md`, `fixtures/external-harness/no-live-conformance.json`, `npm run check:external-harness-conformance` |
| OpenClaw plugin adapter boundary | Stable reference integration, not a core dependency | `packages/openclaw-plugin-a2a`, quickstart placeholder config |
| Docker runner package boundary | Experimental until #649 promotion gates decide stable category | `packages/docker-runner`, package CI parity only |
| Public release/promotion labels | Experimental | Tracked by #649; this capstone does not publish or tag anything |

## 5-minute path — fresh checkout to local loopback smoke

Use this when an external reader wants a deterministic first pass from a fresh checkout to local A2A Nexus smoke evidence.

```bash
git clone https://github.com/jinwon-int/a2a-nexus.git
cd a2a-nexus
npm ci --ignore-scripts --include=dev
npm run smoke:quickstart
```

What this proves:

- the root workspace can build from a fresh checkout;
- `docs/quickstart.md` remains conformant;
- `docs/promotion-capstone.md` remains conformant;
- release-gate tests remain wired;
- the path is no-live, local-only, and evidence-only.

To exercise the loopback broker and dummy/echo worker manually after the smoke preflight, use the package-scoped local path:

```bash
cd packages/broker
npm run build
npm run start:local
```

In a second terminal:

```bash
cd packages/broker
LOCAL_A2A_BROKER_URL=http://127.0.0.1:8787 \
LOCAL_A2A_WORKER_ID=local-echo-worker \
npm run worker:echo
```

Submit the checked-in no-live fixture from repository root:

```bash
curl -s -X POST http://127.0.0.1:8787/tasks \
  -H 'Content-Type: application/json' \
  -H 'X-A2A-Requester-Id: local-operator' \
  -H 'X-A2A-Requester-Kind: node' \
  -H 'X-A2A-Requester-Role: operator' \
  -d @examples/local/local-quickstart-task.json
```

Expected evidence is `Done` or a clear local `Block`. Provider-send success and provider message ids are not terminal ACK, human-seen proof, requester-visible receipt, or promotion evidence.

## 20-minute path — package-boundary capstone

Use this after the 5-minute path when validating that the repository layout demonstrates broker, worker, adapter/plugin, and runner boundaries without production secrets.

1. Broker boundary: inspect and run the local broker package path in `packages/broker` using `npm run build` and `npm run start:local` only on `http://127.0.0.1:8787`.
2. Worker boundary: use the built-in echo worker via `npm run worker:echo` with `LOCAL_A2A_WORKER_ID=local-echo-worker`; do not point workers at managed brokers.
3. Adapter/plugin boundary: read the placeholder-only OpenClaw reference integration in `packages/openclaw-plugin-a2a` and the quickstart config. Do not insert real edge secrets, tokens, provider ids, private hostnames, Telegram ids, or operator paths.
4. External harness boundary: run `npm run check:external-harness-conformance` and review `docs/external-harness-quickstart.md` plus `fixtures/external-harness/no-live-conformance.json`.
5. Docker runner boundary: treat `packages/docker-runner` as experimental until #649 promotes it. Package CI parity can be run locally, but this capstone does not start production containers or publish images.
6. Repository gates: run `npm run check:promotion-capstone`, `npm run check:quickstart-conformance`, and `npm run check` before opening a PR.

## Quality-floor consistency

The named `promotion-capstone` CI lane runs a source-only consistency check over the three package coverage-baseline contracts. Each package must keep its `coverage:baseline` command, reporter, reporter test, package-CI command/metadata entries, and `a2a-nexus.coverage-baseline.v1` schema aligned. Package manifests and TypeScript configs are parsed as JSON; reporter assertions are limited to the exported baseline builder and floor declaration markers.

| Package | Coverage floor on live main | `noUnusedLocals` | Consistency evidence |
| --- | --- | --- | --- |
| `packages/broker` | #1506 Enforced per-module line floors | Pending | `coverage:baseline`, reporter + reporter test, package-CI command/metadata |
| `packages/docker-runner` | #1576 Enforced per-module line floors | Enabled | `coverage:baseline`, reporter + reporter test, package-CI command/metadata |
| `packages/openclaw-plugin-a2a` | measure-only (`floor: null`) | Enabled | `coverage:baseline`, reporter + reporter test, package-CI command/metadata |

The docker-runner floors merged in #1576 are `config.js` 94%, `execution-orchestrator.js` 96%, `execution-proof.js` 95%, `execution-proof-signing.js` 90%, `redaction.js` 95%, and `runner.js` 85%.

The broker reporter is the exact source of truth for its #1506 floor. Against exact main `9ef9b26c8b04b659983dadb01c2777f4f8bd1a59` on Node 22, the deterministic built tests `dist/core/broker-policy.test.js`, `dist/core/provenance.test.js`, and `dist/core/release-evidence.test.js` measured `broker-policy.js` 85.06%, `provenance.js` 99.00%, and `release-evidence.js` 98.66% line coverage. The enforced conservative floors are `broker-policy.js` 84% (measured 85.06%), `provenance.js` 98% (measured 99.00%), and `release-evidence.js` 97% (measured 98.66%). A missing module measurement, malformed report, lower measurement, or failed underlying coverage test process fails closed.

Remaining #1506 work is explicit: the plugin coverage floor, broker `noUnusedLocals`, and async-safety approval. This capstone consistency slice references #1506 and does not close it.

## Named CI lane

The GitHub Actions workflow has a named `promotion-capstone` lane. It runs the capstone conformance check and the 5-minute smoke path for docs, scripts, root workflow/package changes, and main branch pushes. The lane is intentionally no-live and does not require production secrets.

## Troubleshooting

### stale split docs

If a command in this capstone disagrees with `docs/quickstart.md`, `docs/external-harness-quickstart.md`, or package scripts, treat the docs as stale split docs. Fix the smallest doc/check pair in the same PR and rerun `npm run check:promotion-capstone` plus `npm run check:quickstart-conformance`.

### missing env

The 5-minute path should not require real `.env` files. If a command asks for a provider token, Telegram id, private hostname, or production broker secret, stop and file/fix the path as a no-live violation. Placeholder-only config is acceptable; real secrets are not.

### broker-id routing

Loopback smoke uses a single local broker. If a task appears routed to the wrong broker id, confirm `LOCAL_A2A_BROKER_URL=http://127.0.0.1:8787`, the requester headers in `docs/quickstart.md`, and any `brokerId` fields in local fixtures before assuming a worker failure.

### no-live evidence-only tasks

Capstone task submissions are no-live evidence-only tasks. They may produce `Done` or a local setup `Block`; they must not trigger provider sends, Telegram sends, terminal-outbox ACK, Gateway/broker/worker restart, database mutation, release, or publish actions.

## Issue links

- Parent direction round: #663
- Stable category promotion tracker: #649
- Capstone tracker: #665
