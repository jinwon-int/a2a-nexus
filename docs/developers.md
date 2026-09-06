# A2A Developer Guide

> **Status:** phase 0 developer guide for monorepo rehearsal. Split repos remain canonical until parity is proven.

## Package Surfaces

| Path | Surface | Boundary |
| --- | --- | --- |
| `packages/broker/` | Broker | Task lifecycle, worker registry, dispatch/readiness gates, durable evidence, broker API. |
| `packages/docker-runner/` | Docker runner | Isolated execution, checkout hygiene, PR/Done/Block evidence, runner CLI/package. |
| `packages/openclaw-plugin-a2a/` | OpenClaw plugin | Gateway adapter, request/status/cancel mapping, diagnostics, OpenClaw peer boundary. |
| `contracts/`, `fixtures/` | Shared contracts | Cross-package contracts and public-safe fixtures only. |

Do not import another package's internal `src/` path. Use package public
entrypoints or shared contract fixtures.

## Local Validation

Use the [script-surface operator entrypoints](ops/script-surface-entrypoints.md) to choose the validation level:

| Situation | Command path |
|---|---|
| Local quick check | focused package/doc command for the touched files |
| PR check | `npm run check` |
| Public candidate check | `npm run scan:public-readiness`, `npm run scan:external-secrets`, and relevant package/readiness audits |

Examples for focused checks while editing:

```bash
npm run check:layout
npm run check:packages
npm run check:monorepo-docs-routing
npm run check:release-gate-inventory
```

`check:monorepo-reentry`, `check:monorepo-import-rehearsal` and
`check:monorepo-ci-parity` were **deleted** with the rest of the monorepo
migration ceremony in #1779; they are not runnable. Use
`npm run --silent release-gate -- --list` to see the commands the gate actually
selects today.

For broader source changes, run:

```bash
npm run test:conformance
npm run scan:public-readiness
npm run scan:readiness-gates
```

`npm run check` is the root PR gate. It may require external scanner tooling locally; GitHub CI installs the supported scanner path for PRs. `docs/ops/script-surface-tier-manifest.json` remains the baseline for classifying the root and broker script surfaces; verify it with `node scripts/lib/script-surface-manifest.mjs`.

## Development Boundaries

Implementation changes still belong in the split repos until a fresh import
rehearsal and CI parity proof make `a2a-plane` authoritative. A PR in this repo
may update docs, contracts, fixtures, validators, and rehearsal policy without
moving package ownership.

`agent-olympics` is not an A2A development surface in this repo.
