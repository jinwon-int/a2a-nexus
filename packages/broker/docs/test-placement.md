# Broker test placement policy

This policy keeps broker route tests out of a single append-only file and reduces merge conflicts during A2A PR batches.

## Rule

Add new HTTP/JSON-RPC broker tests to the file that owns the route surface. Do **not** append new unrelated tests to the largest nearby file just because it is convenient.

If no file owns the route surface yet, create a new `src/server-<surface>.test.ts` file and import shared helpers from `src/server-test-helpers.ts`.

## Current surfaces

| Surface | Preferred test file |
|---|---|
| A2A JSON-RPC / agent-card facade | `src/server-a2a-jsonrpc.test.ts` |
| A2A SSE / streaming message routes | `src/server-a2a-sse-streams.test.ts` |
| Dialectic / A2AD route behavior | `src/server-dialectic.test.ts` |
| E2E regression-only broker behavior | `src/server-e2e-regression.test.ts` |
| Health / diagnostics | `src/server-health-diagnostics.test.ts`, `src/server-health-regression.test.ts` |
| Orchestration plans | `src/server-orchestration-plans.test.ts` |
| Persistence ACK / queue diagnostics | `src/server-persistence-ack.test.ts` |
| SQLite read paths | `src/server-sqlite-readpaths.test.ts` |
| Terminal Brief gates | `src/server-terminal-brief-gates.test.ts` |
| Terminal Brief sidecar default-on gates | `src/server-terminal-brief-sidecar-default-on-gates.test.ts` |
| Worker/task lifecycle routes | `src/server-workers-tasks.test.ts` |

## Shared helpers

Use `src/server-test-helpers.ts` for shared server fixtures and helpers, including:

- `startTestServer`
- `jsonHeaders`
- `registerTestWorker`
- `createTaskRequest`
- `createDeferred`
- `waitFor`
- `readAllSseEvents`
- `readSseEventsUntil`
- `withEnv`

When a helper is useful in more than one surface file, move it to `server-test-helpers.ts` instead of copying it.

## Size guardrail

Keep each per-surface test file under roughly **2,500 lines**. If a file approaches that size, split by a narrower route family before adding another unrelated block.

As of the A2A remaining-issue closeout round for #645, `server-workers-tasks.test.ts` is the closest to the limit and should be split next if worker/task route coverage grows.

## Non-goals

This document does not change broker behavior and does not complete the `server.ts` Phase 2 extraction work. The remaining #645 implementation work is to continue extracting self-contained helper clusters and route modules from `server.ts` until the file is meaningfully smaller.
