# Hermes / Native Worker Contract

## Purpose

Define the canonical broker contract for Hermes/native workers — lightweight,
mobile-compatible workers that do **not** require a full OpenClaw Gateway on
device. This document covers registration, enrollment health, and evidence
submission semantics.

## Background

Hermes workers (runtime flavor `termux-hermes`) run on battery-powered mobile
nodes (Termux, Android, embedded). They differ from Gateway workers in several
ways:

- No full OpenClaw Gateway on-device; `gatewayRequired=false`
- Source-only, no-live, read-only task capability by policy
- Shorter stale window (30 s online, 90 s disconnected) to handle Doze/sleep
- Evidence is **redacted** — summary/output only, never raw credentials,
  provider message-ids, terminal ACK payloads, or session text
- Provider-accepted/message-id evidence is **separate** from terminal ACK/read/
  visibility evidence

## Registration Contract

Hermes workers register via `POST /workers/register` with the following
canonical fields:

```json
{
  "nodeId": "<worker-id>",
  "role": "analyst",
  "displayName": "Hermes Agent Ref Worker",
  "brokerUrl": "http://<hermes-node>:<port>",
  "workerMode": "mobile",
  "capabilities": {
    "canAnalyze": true,
    "canBackfill": false,
    "canPatchWorkspace": true,
    "canPromoteLive": false,
    "workspaceIds": ["public-safe-reference"],
    "environments": ["research"],
    "runtimeFlavor": "termux-hermes",
    "gatewayRequired": false
  },
  "metadata": {
    "runtime": "hermes-agent",
    "transport": "http-poll"
  }
}
```

### Key fields

| Field | Hermes value | Meaning |
|-------|-------------|---------|
| `capabilities.runtimeFlavor` | `"termux-hermes"` | Declares native Hermes runtime |
| `capabilities.gatewayRequired` | `false` | No full OpenClaw Gateway on-device |
| `workerMode` | `"mobile"` | Battery-powered; short stale window |
| `capabilities.canPromoteLive` | `false` | Source-only; no live promotion |
| `metadata.runtime` | `"hermes-agent"` | Self-descriptive runtime identifier |
| `metadata.transport` | `"http-poll"` | HTTP long-poll transport (not SSE) |

### Environment variables

When using the `worker.ts` daemon, Hermes worker capability flags can be set
via environment variables:

```
WORKER_RUNTIME_FLAVOR=termux-hermes
A2A_WORKER_RUNTIME_FLAVOR=termux-hermes
WORKER_GATEWAY_REQUIRED=false
A2A_WORKER_GATEWAY_REQUIRED=false
WORKER_MODE=mobile
A2A_WORKER_MODE=mobile
```

Implementation-lane readiness can be declared with the following variables.
Each `WORKER_` variable also accepts the listed `A2A_WORKER_` alias; when both
forms are defined, the `WORKER_` form wins.

| Variable | `A2A_` alias | Allowed values | Meaning |
|----------|---------------|----------------|---------|
| `WORKER_IMPLEMENTATION_CAPABLE` | `A2A_WORKER_IMPLEMENTATION_CAPABLE` | `true` or `false` | Declares whether the worker can perform implementation work. This variable must be set to declare the discrete profile. |
| `WORKER_IMPLEMENTATION_RUNTIME` | `A2A_WORKER_IMPLEMENTATION_RUNTIME` | `claude-native`, `codex-native`, or `provider-native` | Native implementation runtime available to the worker. |
| `WORKER_IMPLEMENTATION_PROVIDER_ID` | `A2A_WORKER_IMPLEMENTATION_PROVIDER_ID` | Secret-safe provider ID, such as `anthropic` or `openai` | Provider route used by the runtime. IDs are normalized to lowercase and must be 1–64 characters matching `[a-z0-9][a-z0-9._:/+-]*`. |
| `WORKER_IMPLEMENTATION_MODEL_TIER` | `A2A_WORKER_IMPLEMENTATION_MODEL_TIER` | Secret-safe model-tier ID, such as `claude-sonnet-5` | Model tier used for implementation work. It follows the same normalization and character rules as the provider ID. |
| `WORKER_IMPLEMENTATION_AVAILABILITY` | `A2A_WORKER_IMPLEMENTATION_AVAILABILITY` | `configured`, `canary_passed`, `entitlement_failed`, or `disabled` | Current readiness state of the provider/runtime route. |
| `WORKER_IMPLEMENTATION_LAST_VERIFIED_AT` | `A2A_WORKER_IMPLEMENTATION_LAST_VERIFIED_AT` | ISO 8601 timestamp, such as `2026-07-26T00:00:00.000Z` | Time of the most recent verification. The value must be non-empty, secret-safe, and at most 128 characters. |
| `WORKER_IMPLEMENTATION_EVIDENCE_ID` | `A2A_WORKER_IMPLEMENTATION_EVIDENCE_ID` | Secret-safe evidence ID, such as `worker-canary-20260726` | Reference to the verification evidence. The value must be non-empty and at most 128 characters; never put a token, credential, credential path, or raw provider response here. |

Set `WORKER_IMPLEMENTATION_AVAILABILITY=configured` when the runtime is
installed but has not completed a real implementation canary.
`canary_passed` is an attestation that the canary succeeded, not merely a
description of an installed runtime. See the
[implementation-lane readiness policy](../../../docs/implementation-lane-readiness.md)
for the complete readiness rules.

Capabilities can instead be declared through `WORKER_CAPABILITIES_JSON` (or
`A2A_WORKER_CAPABILITIES_JSON`):

```
WORKER_CAPABILITIES_JSON='{"canAnalyze":true,"canPatchWorkspace":true,"workspaceIds":["public-safe"],"environments":["research"],"runtimeFlavor":"termux-hermes","gatewayRequired":false}'
```

The JSON blob takes precedence for the existing capability flags, but
`implementationCapability` is the exception. When
`WORKER_IMPLEMENTATION_CAPABLE` (or its `A2A_` alias) is set to `true` or
`false`, the discrete `WORKER_IMPLEMENTATION_*` profile replaces the entire
`implementationCapability` object from the JSON blob; the two profiles are not
merged. This lets an operator grant or revoke implementation readiness without
rewriting the capabilities document. If neither the discrete profile nor a
JSON `implementationCapability` is declared, the worker remains eligible for
its legacy lanes but is ineligible for implementation work.

## Enrollment Health

Enrollment health tracks whether a worker is online, stale, or disconnected.
It uses **mobile-aware** thresholds because Hermes nodes may briefly sleep
(Doze, lid close, network suspend).

### Heartbeat

Workers send periodic heartbeats to `POST /workers/:id/heartbeat`:

```json
{
  "metadata": {
    "runtime": "hermes-agent",
    "heartbeat": "ok"
  }
}
```

The broker updates `lastSeenAt` and returns the current worker record.
Unchanged heartbeats are persisted at most once per 60 s to reduce write load;
in-memory liveness is updated on every request.

### Stale / disconnected thresholds

| State | Time since last heartbeat | Meaning |
|-------|--------------------------|---------|
| `health_ok` | ≤ 30 s | Normal operation |
| `stale` | 30 s – 90 s | Brief offline; tasks may still be claimed |
| `disconnected` | > 90 s | Extended absence; likely fully offline |

These thresholds are defined in `broker.ts` as `MOBILE_OFFLINE_AFTER_MS`
(30,000) and `MOBILE_DISCONNECTED_AFTER_MS` (90,000). Persistent (non-mobile)
workers use `DEFAULT_WORKER_OFFLINE_AFTER_MS` (90,000).

### Read model

The broker read model (`/dashboard`, `/workers/:id`, `/workers`) surfaces
mobile health when `workerMode === "mobile"`:

```json
{
  "nodeId": "mobilealpha",
  "status": "online",
  "workerMode": "mobile",
  "mobileHealth": "health_ok",
  "lastSeenAt": "2026-05-28T13:55:00.000Z",
  "capabilities": {
    "runtimeFlavor": "termux-hermes",
    "gatewayRequired": false
  }
}
```

Possible `mobileHealth` values:
- `"health_ok"` — heartbeat within mobile stale window
- `"stale"` — heartbeat within extended stale window (30–90 s)
- `"disconnected"` — heartbeat beyond extended window
- `undefined` — not a mobile worker

## Evidence Submission

Hermes workers submit terminal evidence via `POST /tasks/:id/evidence`.

### Canonical evidence shape

```json
{
  "workerId": "<the-claiming-worker-id>",
  "outcome": "done",
  "result": {
    "summary": "Hermes-style worker produced redacted terminal evidence",
    "output": {
      "referenceWorker": "hermes-agent",
      "openClawRequired": false
    }
  }
}
```

### Evidence outcomes

| Outcome | Task transition | Meaning |
|---------|----------------|---------|
| `done` | `running → succeeded` | Task completed without PR |
| `pr` | `running → succeeded` | Task completed with PR evidence |
| `blocked` | `running → failed` | Task blocked by policy or preflight |
| `failed` | `running → failed` | Task failed with error |

Outcomes `done` and `pr` call `broker.completeTask()`; outcomes `blocked` and
`failed` call `broker.failTask()`.

### Provider-accepted vs terminal ACK evidence

Hermes workers **must** distinguish these two evidence categories:

1. **Provider-accepted / message-id evidence** — proof that a message was
   accepted by the provider (e.g., provider returned `200 OK` with a message
   id). This is **not** terminal ACK evidence. It confirms the send surface
   accepted the payload but says nothing about read/visibility.

2. **Terminal ACK / read / visibility evidence** — proof that the recipient
   read or received the message (e.g., Telegram read receipt, terminal
   outbox ACK). Hermes workers do **not** generate this evidence; it is
   produced by the broker terminal-brief lifecycle.

Hermes evidence is always **source-only, redacted**:
- No raw credentials, tokens, or private keys
- No provider session payloads
- No terminal ACK payloads or receipt identifiers
- `summary` is a human-readable outcome note
- `output` is a JSON object with safe structured metadata

### Redacted evidence example for blocked outcomes

```json
{
  "workerId": "mobilealpha",
  "outcome": "blocked",
  "error": {
    "code": "blocked",
    "message": "worker posted blocked evidence: Preflight check failed: no-live gate rejected"
  },
  "result": {
    "summary": "Blocked: preflight no-live gate rejected live promotion attempt",
    "note": "Hermes worker cannot promote to live; gatewayRequired=false"
  }
}
```

## Resource-Aware Policy (GO/NO-GO)

Hermes workers must comply with the `mobilealpha-hermes` preset policy:

- `readOnly=true`
- `noLiveSend=true`
- `noMutation=true`
- `mobileLowPower=true`
- `gatewayRequired=false`
- `promote_to_live` **not** in `allowedTaskTypes`
- `maxConcurrent` ≤ 2

See [resource-aware-worker-policy.md](resource-aware-worker-policy.md) and
`src/core/resource-aware-worker-policy.ts` for full details.

## Test Coverage

Hermes/native worker contract tests are in:

| File | What it covers |
|------|---------------|
| `src/server.test.ts` | End-to-end HTTP poll + evidence flow (`server accepts a broker-agnostic Hermes-style worker poll and evidence flow`) |
| `src/core/broker.test.ts` | Capability metadata preservation, stale/offline mobile health, redacted evidence |
| `src/core/worker.test.ts` | Daemon-level Hermes worker env variables and registration |
| `src/core/resource-aware-worker-policy.test.ts` | GO/NO-GO onboarding for mobilealpha/Hermes workers |

## Related

- [Resource-aware worker policy](resource-aware-worker-policy.md)
- [Worker capability registry](worker-capability-registry.md)
- [Worker subagent orchestration policy](worker-subagent-orchestration-policy.md)
- Issue: [a2a-broker#961](https://github.com/jinwon-int/a2a-broker/issues/961)
- Parent: a2a-plane#503 (a2a-plane#503, internal tracker private)
