# Feature Spec: Gongyung Hermes Lightweight A2A Worker Profile

## Problem

Gongyung is now a Hermes-only / Hermes-dedicated Android Termux device. OpenClaw was retired from Gongyung on 2026-05-20 KST, and the device must not be treated as a normal OpenClaw Docker patch/build worker.

A previous Hermes/non-OpenClaw A2A path was validated under [#384](../hermes-worker-integration/spec.md): Gongyung/Hermes could register, heartbeat, poll/claim/start, and submit evidence through the broker. This issue is a follow-up to define the *limited, durable operating mode* for Gongyung as a lightweight A2A worker.

## Worker identity

Gongyung must not serve as a peer to VPS Docker Runner workers for patch/build/test tasks because Android Termux cannot provide:

- worker-local contamination prevention
- reproducible containerized execution
- dependency isolation
- resource/cleanup boundaries

Instead, Gongyung operates under a lightweight Hermes-native profile with the following characteristics:

## Allowed task classes

Gongyung accepts:

- documentation cleanup or synthesis
- read-only research and issue triage
- small structured reports
- proof/evidence review
- Telegram/Hermes-specific operational checks
- non-mutating A2A canary/reporting work

## Rejected or handoff task classes

Gongyung rejects (or hands off to a VPS worker) any task with these flags:

- `dockerRequired` — task depends on Docker isolation
- `buildRequired` — task requires a build/test pipeline
- `testRequired` — task runs automated tests
- `repoPatch` — task patches tracked repository content
- `untrustedCode` — task executes untrusted external code

The worker MUST inspect the task payload for the above flags and respond with outcome `blocked` and a clear rejection reason before any mutable work begins.

## Artifact output path

Gongyung uses a fixed local artifact root:

```
~/.hermes/a2a/artifacts/<task-id>/
```

All task output (terminal evidence body, structured data files) must be written under this directory. No output outside this directory is permitted.

## Evidence manifest

Every terminal evidence submission must include a manifest with:

| Field | Required | Description |
| --- | --- | --- |
| `taskId` | yes | The broker-assigned task id |
| `workerId` | yes | `gongyung` |
| `status` | yes | `accepted`, `rejected`, `handoff` |
| `filesProduced` | yes | Array of relative paths under the artifact root |
| `redactionStatement` | yes | Short statement that no secrets, tokens, or private paths were included |
| `limitations` | yes | Description of any limits encountered (e.g. memory, offline, missing tools) |
| `timestamp` | yes | ISO-8601 timestamp of evidence creation |

## Secret redaction and boundary

The lightweight profile must:

- Inspect evidence body for secret-like patterns before submission (see `secretLikePatterns` in conformance fixtures).
- Never include raw session dumps, full logs, provider tokens, API keys, private host paths, or credential values.
- Never include OpenClaw runtime/bootstrap context file names (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`).

## Registration metadata

When Gongyung registers with the broker, it sends:

```json
{
  "nodeId": "gongyung",
  "role": "analyst",
  "displayName": "Gongyung Hermes Lightweight Worker",
  "workerMode": "mobile",
  "capabilities": {
    "canAnalyze": true,
    "canBackfill": false,
    "canPatchWorkspace": false,
    "canPromoteLive": false,
    "workspaceIds": ["hermes-gongyung"],
    "environments": ["research"]
  },
  "metadata": {
    "runtime": "hermes-agent",
    "openClawRequired": "false",
    "transport": "http-poll",
    "workerProfile": "lightweight",
    "dockerAvailable": "false",
    "deviceClass": "android-termux"
  }
}
```

## Heartbeat metadata

During heartbeat, Gongyung may refresh metadata to indicate current state:

```json
{
  "metadata": {
    "runtime": "hermes-agent",
    "heartbeat": "ok",
    "workerProfile": "lightweight",
    "batteryLevel": "85",
    "networkStatus": "wifi"
  }
}
```

## Success criteria

- [ ] Gongyung/Hermes worker profile is documented as non-Docker, lightweight, and restricted.
- [ ] Admission rules reject or hand off Docker/build/test/untrusted-code tasks.
- [ ] Artifact/evidence output path and manifest fields are specified.
- [ ] Secret redaction and no-credential-output boundaries are explicit.
- [ ] The profile references the completed #384 Hermes/non-OpenClaw worker integration as prior art.
- [ ] No live broker/Gateway/Hermes restart, DB mutation, replay, deploy, token movement, or production notification is required to close the source/spec issue.

## Safety and approval boundaries

This spec is source-only. It does not approve or perform:

- production Gongyung worker registration against the live broker
- broker/Gateway/worker deploys or restarts
- live provider/Telegram sends
- database or terminal-outbox mutation
- manual ACK/replay, release/tag publication
- repository visibility changes
- secret rotation or credential disclosure

Any production Gongyung worker enablement requires a separately approved operational step because it involves broker credential/proxy decisions.

## Related documents

- [Hermes Worker Integration](../hermes-worker-integration/spec.md) — prior art for Hermes/non-OpenClaw worker contract (#384)
- [Worker Registration](../../contracts/a2a/worker-registration.md) — base worker registration contract
- [Worker Capability Profile](../../contracts/a2a/worker-capability-profile.md) — capability profile contract
