# Standalone worker terminal evidence validation

This note validates the second reference worker shape for A2A Nexus terminal evidence. It is documentation-only evidence: it does not register a worker, contact a broker, send provider messages, or mutate terminal-outbox ACK state.

## Reference worker shape

The second worker lane is a generic HTTP worker, represented by `examples/workers/standalone-http-worker/worker-card.json`, with these boundaries:

- it uses a public-safe worker name, coarse capabilities, and a policy version;
- it may claim and run tasks through the broker worker contract, but the example uses only loopback or placeholder endpoints;
- it can finish with exactly one terminal result: `done`, `pr`, or `blocked`;
- it does not require OpenClaw runtime files, Gateway settings, provider IDs, raw session logs, private host paths, or live notification accounts.

## Terminal evidence mapping

The same terminal evidence standard applies to this worker shape as to the OpenClaw lane:

| Terminal result | Evidence allowed from a standalone worker | Evidence not allowed |
|---|---|---|
| `done` | Redacted summary, changed files if any, and exact validation commands with results. | Provider message id, provider accepted-send status, or terminal-outbox ACK mutation. |
| `pr` | Pull request URL or runner-prepared PR evidence plus exact validation commands with results. | Treating a branch push, notification delivery, or chat send as operator-visible ACK. |
| `blocked` | Safe blocker reason, missing prerequisite, or approval needed. | Raw secrets, private endpoint values, raw session dumps, or history rewrites. |

Provider acceptance remains accepted-send evidence only. It is never terminal ACK evidence for this standalone worker lane.

## Safe validation commands

Run from the repository root:

```bash
cat examples/workers/standalone-http-worker/worker-card.json
npm run check
```

Passing these commands shows the public-safe worker card is inspectable and the repository release gate still enforces layout, conformance fixtures, package metadata, public-readiness scanning, readiness gates, terminal-brief routing, and compatibility baselines. A future runnable HTTP worker can add a local-only smoke test under `examples/workers/**`, but it should not expand terminal evidence claims until that test is part of the validation evidence.
