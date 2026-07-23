# Bounded review-lineage simulations

These four public-safe JSON fixtures are the Phase 3.3 conformance scenarios
for issue #1518:

- `converging.json` — initial failure, one correction, resolution pass;
- `non-converging.json` — repeated finding signature stops the lineage;
- `moving-goalpost.json` — a new design preference cannot become a blocker;
- `scope-drift.json` — an out-of-scope candidate is rejected while the
  original head remains current.

`packages/broker/src/review-lifecycle/simulation-fixture.ts` strictly parses
each fixture and runs the existing pure lifecycle engine. The fixtures have no
broker, task-completion, retry, finalizer, network, persistence, branch-write,
or deployment authority.

Run the focused harness:

```bash
npx tsx --test packages/broker/src/review-lifecycle/simulation-fixture.test.ts
```

Actual task-completion observation remains a later contract-first slice. The
current review payload does not yet carry the complete frozen intent, diff
binding, stable finding ledger, and idempotency fields needed to construct
lossless lineage events.
