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

Use focused checks while editing, then run the relevant release-gate subset:

```bash
npm run check:layout
npm run check:packages
npm run check:monorepo-reentry
npm run check:monorepo-import-rehearsal
npm run check:monorepo-ci-parity
```

For broader source changes, run:

```bash
npm run test:conformance
npm run scan:public-readiness
npm run scan:readiness-gates
```

`npm run check` is the root release gate. It may require external scanner
tooling locally; GitHub CI installs the supported scanner path for PRs.

## Development Boundaries

Implementation changes still belong in the split repos until a fresh import
rehearsal and CI parity proof make `a2a-plane` authoritative. A PR in this repo
may update docs, contracts, fixtures, validators, and rehearsal policy without
moving package ownership.

`agent-olympics` is not an A2A development surface in this repo.
