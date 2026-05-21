# Feature Spec: Gongyung Hermes Lightweight Worker Profile

## Problem

Gongyung is a Hermes-only / Hermes-dedicated Android Termux device. OpenClaw was retired from Gongyung on 2026-05-20 KST. The existing `docs/specs/hermes-worker-integration/` packet (jinwon-int/a2a-plane#384) defines a broker-agnostic worker contract for Hermes-style workers, but it does not define Gongyung's *limited, durable operating mode* as a lightweight A2A worker that cannot use Docker Runner isolation.

Gongyung cannot practically obtain Docker Runner benefits for:

- worker-local contamination prevention
- reproducible containerized execution
- dependency isolation
- resource/cleanup boundaries

Therefore a Gongyung-specific profile is needed that documents allowed/rejected task classes, fixed artifact paths, evidence manifest requirements, and secret redaction rules.

## Prior art

This profile builds on the Hermes broker-agnostic worker contract defined in `docs/specs/hermes-worker-integration/` (jinwon-int/a2a-plane#384). Gongyung inherits the same registration, heartbeat, polling, and evidence submission API defined there, while adding the admission rules and artifact contract specific to a lightweight non-Docker worker on Termux.

## User / operator stories

- As a broker operator, I can distinguish Gongyung/Hermes lightweight workers from VPS Docker Runner workers by their capability profile.
- As a Gongyung worker, I can accept lightweight non-Docker tasks and reject or hand off tasks that require Docker isolation.
- As a finalizer, I can verify that Gongyung's admission rules prevent Docker/build/test/untrusted-code tasks from executing on a non-isolated Termux device.
- As a task author, I can check whether a task is suitable for Gongyung dispatch by reviewing its capability flags.

## Scope

### In scope

- Define the Gongyung Hermes lightweight worker capability profile.
- Document allowed task classes and rejected/handoff task classes.
- Require a fixed artifact root: `~/.hermes/a2a/artifacts/<task-id>/`.
- Require an `evidence.json` manifest with: task id, worker id `gongyung`, accepted/rejected/handoff status, files produced, redaction statement, limitations, and timestamp.
- Require secret redaction rules: no token, secret, password, private key, or session cookie value may be copied into evidence.
- Reference the completed jinwon-int/a2a-plane#384 Hermes/non-OpenClaw worker integration as prior art.
- Add admission test that asserts the expected spec path and reject/handoff rules for `dockerRequired`, `buildRequired`, `testRequired`, `repoPatch`, and `untrustedCode`.

### Out of scope

- Production Gongyung worker registration, deploy, or restart.
- Broker/Gateway/Hermes restart, DB mutation/prune/migration.
- Live provider/Telegram canary or terminal ACK/replay.
- Secret movement, token changes, credential disclosure.
- Release/tag publication or repository visibility changes.
- Any change that requires production liveness checking or operator handoff.
- Docker Runner profile changes.

## Gongyung Worker Capability Profile

### Identity

- **workerId**: `gongyung`
- **runtime**: `hermes-agent`
- **platform**: `android-termux`
- **dockerAvailable**: `false`
- **openClawRequired**: `false`

### Allowed task classes

Tasks whose `intent` or `payload.capabilities` match one of:

- `analyze` — documentation cleanup or synthesis
- `research` — read-only research and issue triage
- `report` — small structured reports
- `review` — proof/evidence review
- `hermes-ops` — Telegram/Hermes-specific operational checks
- `canary` — non-mutating A2A canary/reporting work

### Rejected or handoff task classes

Tasks with any of the following flags set MUST be rejected (with evidence) or handed off to a VPS Docker Runner worker:

- `dockerRequired` — Docker isolation required
- `buildRequired` — code build or compilation
- `testRequired` — test execution requiring sandbox
- `repoPatch` — git patch or code modification on the repo
- `untrustedCode` — execution of untrusted or user-supplied code
- `dependencyHeavy` — dependency-heavy installs requiring isolation
- `serviceRestart` — service restart/deploy/migration
- `brokerDBMutation` — broker DB mutation/prune/replay
- `credentialMovement` — credential movement or token changes
- `productionACK` — anything needing production ACK/replay or live notification semantics

### Artifact contract

```
Fixed artifact root:  ~/.hermes/a2a/artifacts/<task-id>/
Evidence manifest:    evidence.json
```

`evidence.json` fields:

| Field | Required | Description |
|---|---|---|
| `taskId` | yes | The A2A task identifier |
| `workerId` | yes | Always `"gongyung"` |
| `status` | yes | `"accepted"`, `"rejected"`, or `"handoff"` |
| `files` | yes | Array of file paths produced (relative to artifact root) |
| `redactionStatement` | yes | Statement that no secrets/credentials/tokens were included |
| `limitations` | no | Any limitation notes relevant to the evidence |
| `timestamp` | yes | ISO 8601 timestamp of evidence generation |

### Secret redaction rules

- No token, secret, password, private key, or session cookie value may be copied into evidence.
- Any output that could contain credential values must be redacted or excluded.
- The `redactionStatement` in `evidence.json` must explicitly confirm compliance.

## Success criteria

- [x] Gongyung Hermes worker profile is documented under `docs/specs/gongyung-hermes-worker-profile/`.
- [x] Allowed task classes are explicitly listed.
- [x] Rejected/handoff task classes are explicitly listed with flag names.
- [x] Artifact output path and evidence manifest fields are specified.
- [x] Secret redaction and no-credential-output boundaries are explicit.
- [x] The profile references the completed jinwon-int/a2a-plane#384 as prior art.
- [x] Admission test asserts expected path and reject/handoff rules.
- [x] No live broker/Gateway/Hermes restart, DB mutation, replay, deploy, token movement, or production notification is required.

## Safety and approval boundaries

### Secrets and private data

This is a spec-only document. It does not contain or produce credentials. The artifact contract mandates secret redaction rules for any future Gongyung worker evidence.

### Human approval required for

- [ ] production deploy
- [ ] Gateway/broker/worker/service restart
- [ ] live canary/provider send
- [ ] DB mutation/prune/migration/replay
- [ ] manual Terminal Brief ACK/replay
- [ ] release/tag
- [ ] secret rotation/movement
- [ ] force push/history rewrite
- [x] none of the above

### Broker foreground liveness

This spec packet documents a worker profile only. No foreground session impact.

## Evidence contract

Each change must produce:

- affected repos/files list;
- PR link;
- test/lint/check results;
- CI status when available;
- risk notes;
- rollback/failure notes;
- final recommendation or blocker.

## Rollback / failure handling

- Revert this PR.
- No production state is created.
- Existing worker registration behavior is unaffected.

## Wiki/runbook follow-up

- Operator documentation should reference this profile when Gongyung worker enablement is separately approved.
