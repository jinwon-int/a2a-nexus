# a2a-js standard SDK adapter

This is the source-only first slice for external worker interop. It defines how an `a2aproject/a2a-js` Agent Card and task state map into the A2A Nexus broker surface without bypassing broker validation, write-set rules, finalizer gates, or redaction.

## Mapping

| a2a-js / A2A concept | A2A Nexus field | Notes |
|---|---|---|
| Agent Card `name` | worker `displayName` and sanitized `nodeId` suffix | Public-safe, no private host/node IDs. |
| Agent Card `supportedInterfaces[JSONRPC].url` | worker metadata `agentCardUrl` | Metadata only; not a production endpoint authorization. |
| Agent Card `capabilities.streaming` | worker capability `canStream` | Does not imply SSE subscription auth. |
| Agent Card skill text | `canAnalyze` / `canProposePatch` hints | Hints only; broker policy still decides routing. |
| task state `completed` | terminal evidence `done` | Finalizer still validates evidence quality. |
| task state `input-required` | terminal evidence `blocked` | Keeps operator-visible blocker semantics. |
| task state `failed` / `canceled` | terminal evidence `failed` / `canceled` | No auto-retry or ACK/replay side effects. |

## Safety invariants

- Add-only adapter layer; no changes to existing worker registration or task lifecycle authority.
- External payloads must still pass broker schema validation and requester/worker authorization.
- Fixtures use loopback URLs and public-safe names only.
- No package publish, release, live deploy/restart, DB mutation, terminal-outbox ACK/replay, provider send, or secret movement is implied.

## Implementation surface

- `packages/broker/src/adapters/a2a-js/standard-sdk-adapter.ts`
- `packages/broker/src/adapters/a2a-js/standard-sdk-adapter.test.ts`

Future slices can add a runnable roundtrip fixture once an operator approves any required external SDK dependency pin.
