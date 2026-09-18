# Tasks: Task Assignment Entrypoint (#2187 Phase A+B)

## Preconditions

- [x] Issue #2187 read; baseline `main@f0618d1` checked out and verified.
- [x] Reuse targets confirmed importable: `runDispatch`, `validateManifest`,
      `fetchTask`, `deriveLaneId` from `a2a-dispatch-round.mjs`;
      `evaluateWorkerReadiness` from the preflight.
- [x] Script budget confirmed flat (160/160; `scripts/lib/` not counted).
- [x] Approval-sensitive actions out of scope: no deploy, no restart, no live
      dispatch, no credential movement, no DB/outbox mutation.

## Phase A — spec

- [x] `spec.md` with request/receipt contracts, state mapping, invariants.
- [x] `plan.md` with phases, risks, Phase C boundary.
- [x] `tasks.md` (this file).

## Phase B — source

- [x] `scripts/lib/task-assign-entrypoint.mjs` (36 exports; zero side effects).
- [x] Dispatcher additive `retryAfterMs`; dispatcher suite re-run green (67/67).
- [x] `scripts/lib/task-assign-entrypoint.test.mjs` — 43 tests covering the
      issue §5 mandatory scenarios, all passing locally.
- [x] Registered in `scripts/release-gate-manifest.json` (coverage gate).
- [x] `docs/agent-manual.md` updated in the same PR (usage-change rule).

## Local validation evidence

- [x] `node --test scripts/lib/task-assign-entrypoint.test.mjs` → 43/43.
- [x] `node --test scripts/a2a-dispatch-round.test.mjs` → 67/67.
- [x] `node scripts/check-script-budget.mjs` → ok (flat).
- [x] `node scripts/check-release-gate-manifest-coverage.mjs` → missing=0.
- [x] `node scripts/check-layout.mjs`, `node scripts/check-markdown-links.mjs`.

## Explicitly NOT done here (Phase C / separate approvals)

- [ ] Node-side skill (`a2a-task-poll`) rewiring PR on its owning repos.
- [ ] Host integration injecting `requestReceivedAt` + trusted context.
- [ ] Limited live pilot + comparison metrics (separate approval; holdout
      design fixed before measurement).
- [ ] Aggregate p50/p95 reporting layer over receipt timelines.
- [ ] Branch→SHA base-revision pinning (needs a read-only VCS lookup design).
