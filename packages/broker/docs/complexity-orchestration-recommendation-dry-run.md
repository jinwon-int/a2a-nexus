# Complexity orchestration recommendation dry-run

`npm run complexity_orchestration_recommendation` builds a no-live
orchestration recommendation packet from source-visible task complexity input.
It is a finalizer/operator surface for #970 and #971, not an executor.

Example:

```bash
npm run complexity_orchestration_recommendation -- \
  --input fixtures/complexity-orchestration-recommendation/complex-source-only.json
```

JSON output:

```bash
npm run complexity_orchestration_recommendation -- \
  --input fixtures/complexity-orchestration-recommendation/critical-approval-gated.json \
  --json
```

The dry-run accepts either:

- a top-level `input` or `taskComplexityInput` object with `intent`,
  `targetEnvironment`, optional `policyContext`, and optional count signals;
- a raw `TaskComplexityInput` object;
- optional `bounds`, `now`, and `format`.

Safety boundaries:

- no broker, worker, Gateway, host, or DB state is read;
- no subagent or executor is spawned;
- no broker task or TaskFlow record is created;
- no DB state is mutated;
- no service is deployed or restarted;
- no provider or Telegram message is sent;
- no terminal ACK/replay is performed;
- no credential or secret is moved or printed.

Critical or approval-gated fixtures must render `operator_review` and require
explicit operator approval before any later runtime action.
