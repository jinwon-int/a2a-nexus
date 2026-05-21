# Analysis: Gongyung Hermes Lightweight A2A Worker Profile

## Existing broker support

Repository inspection confirms the broker already supports the lightweight worker pattern through existing infrastructure:

- `packages/broker/src/core/types.ts`: `RegisterWorkerRequest` accepts arbitrary `metadata` (string-to-string map), `WorkerCapabilities` with boolean flags, and `workerMode`, allowing Gongyung's lightweight profile to register without new fields.
- `packages/broker/src/core/broker.ts`: `registerWorker` and `heartbeatWorker` store and refresh metadata without validation against specific OpenClaw fields.
- `packages/broker/src/server.ts`: `POST /workers/register`, `POST /workers/:nodeId/heartbeat`, `GET /tasks?worker=`, `POST /tasks/:id/evidence` all accept Hermes-style workers without modification.
- `contracts/a2a/worker-registration.md` already documents `runtime=hermes-agent`, `transport=http-poll`, and `openClawRequired=false` metadata patterns.

## Gap closed by this spec

Before this spec, Gongyung had no documented operating mode:

- Gongyung was an Android Termux node with OpenClaw retired; the device's capabilities and restrictions were not written down.
- Workers with `dockerAvailable=false`, `workerProfile=lightweight`, and `deviceClass=android-termux` had no guidance on task admission, artifact output, or evidence manifest requirements.
- The existing Hermes integration (#384) proved a generic non-OpenClaw worker could participate in the broker lifecycle, but it did not define a specific lightweight profile.

This spec closes the gap by:

1. Defining the Gongyung/Hermes lightweight worker identity.
2. Enumerating allowed and rejected task classes with explicit flag names.
3. Specifying a fixed artifact output root.
4. Requiring a structured evidence manifest with redaction boundary.
5. Referencing #384 as the prior Hermes integration baseline.

## Safety boundary

This analysis used repository inspection and local tests only. It did not perform:

- production Gongyung worker registration
- production broker deploy/restart
- Gateway restart
- live provider/Telegram send
- production database or terminal-outbox mutation
- manual ACK/replay
- release/tag publication
- repository visibility changes
- secret movement
- credential disclosure
