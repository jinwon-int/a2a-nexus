# Feature Spec: mobile-alpha Hermes Lightweight A2A Worker Profile

## Problem

mobile-alpha runs as an Android/Termux Hermes-style worker on a mobile-constrained
node (limited memory, Doze/suspend windows, no Docker, no direct GitHub push).
The existing Hermes broker-agnostic worker contract
(`docs/specs/hermes-worker-integration/`, a2a-plane#384 (internal tracker, private)) defines the base HTTP transport but
does not distinguish mobile workers from Docker-runner or desktop workers. A
mobile worker needs a narrower admission envelope to avoid being assigned tasks
it cannot safely execute.

## Worker identity

- **NodeId in practice:** `mobile-alpha` (Android Termux)
- **Runtime:** Hermes Agent (non-OpenClaw, non-Docker-runner)
- **Transport:** HTTP polling over Tailscale or local loopback
- **workerMode:** `mobile` (30 s stale threshold, 1-3 capacity slots)
- **dockerAvailable:** `false`
- **openClawRequired:** `false`
- **mustTreatAsDockerRunner:** `false`

mobile-alpha MUST NOT be treated as a Docker Runner patch/build/test worker.
Any task whose intent, payload, or target implies `executorMode=docker`,
`runnerScope=github`, `WORKER_HANDLER_COMMAND=docker`, or
`A2A_EXECUTOR_MODE=auto-with-docker-fallback` MUST be rejected at admission
time.

## Scope

### In scope

- Define the mobile-alpha Hermes worker capability profile.
- Specify allowed lightweight task classes.
- Specify rejected/handoff task classes.
- Specify fixed artifact/evidence manifest requirements.
- Specify redaction rules for evidence output.
- Specify fail-closed admission semantics.
- Add a local validation test for admission semantics.
- Source-only changes; live runtime actions remain out of scope.

### Out of scope

- Live registration of a mobile-alpha worker against a production broker.
- Production broker/Gateway/worker restart or deploy.
- Live provider or Telegram canary.
- Production database, queue, or terminal-outbox mutation (DB mutation/prune/replay).
- Manual terminal ACK/replay or historical replay.
- OpenClaw plugin SDK changes.
- Secret movement, credential disclosure, release/tag, repository visibility.
- Actual Hermes Agent native tooling implementation for mobile-alpha.
- Docker-runner worker or CI worker profile changes.

## Allowed lightweight task classes

A task is admissible for mobile-alpha only when **all** of the following hold.

### Admissible intents

| Intent | Rationale |
|--------|-----------|
| `analyze` | Read-only review of logs, diffs, or evidence. No mutation. |
| `research` | Read-only research and issue triage. |
| `report` | Small structured reports and status summaries. |
| `review` | Lightweight code/doc review. No heavy gate or regression. |
| `clarify` | Ask clarifying questions. |
| `observe` | Status-only monitoring; no proof submission. |
| `check_readiness` | Lightweight readiness scan. |
| `cross_check` | Cross-reference two data sources (read-only). |
| `hermes-ops` | Telegram/Hermes-specific operational checks. |
| `canary` | Non-mutating A2A canary/reporting work. |

### Admissible team modes (from mobile-safety-lane.ts)

| Mode | Lane | Proof level |
|------|------|-------------|
| `fanout` | `full` | `lightweight` |
| `review` | `full` | `lightweight` |
| `swarm` | `observe` | `none` |
| *(any other)* | NO-GO | — |

### Resource constraints

| Constraint | Value |
|------------|-------|
| `maxConcurrentTasks` | 1 (overridable to 2 with explicit config) |
| `canRunHeavyProof` | `false` |
| `canPushToGitHub` | `false` |
| `workerMode` | `mobile` |
| Heartbeat stale threshold | 30 s |
| Max capacity slots | 3 |

## Rejected / handoff task classes

A task MUST be rejected with a structured `NO-GO` signal or handed off to a
capable target when any of the following match.

### Rejected outright (admission → fail-closed)

| Pattern | Reason |
|---------|--------|
| `intent` includes `docker`, `patch_repo`, `build_repo`, `test_repo` | mobile-alpha is not a Docker Runner |
| `executorMode` is `docker` or `auto-with-docker-fallback` | mobile-alpha has no Docker daemon |
| `runnerScope` is `all-github` or `github-patch` | mobile-alpha has no GitHub push capability |
| `intent` is `split` or `swarm` (non-observe) | Mobile profile blocks these at lane level |
| `canRunHeavyProof` required by task metadata | mobile-alpha cannot run full E2E gates |
| Task payload contains `forceFullGate: true` | Explicit heavy gate not allowed |
| Task requires `capabilities.canPatchWorkspace` with workspace type `docker` | Docker workspace not available |
| Task requires `capabilities.canPromoteLive` | No live promotion from mobile |

Equivalent capability flags MUST also reject or hand off the task before
execution:

- `dockerRequired`
- `buildRequired`
- `testRequired`
- `repoPatch`
- `untrustedCode`
- `dependencyHeavy`
- `serviceRestart`
- `brokerDBMutation`
- `credentialMovement`
- `productionACK`

### Handoff classes (admission → delegate to hub)

| Pattern | Handoff target | Rationale |
|---------|----------------|-----------|
| `intent` is `propose_patch` or `propose_params` | `node-hub`, `broker-alpha`, or `worker-eta` | Proposal creation needs a persistent writer |
| `intent` is `apply_local_change` targeting a workspace mobile-alpha cannot reach | Configured handoff target | Workspace not on mobile filesystem |
| GitHub write required (commit, push, PR create) | Configured `githubWriteHandoff` | `canPushToGitHub: false` |
| Full proof gate (`full_gate`, `full_proof_loop`, `full_regression`) | `node-hub` or CI runner | Heavy proof delegated |

### Handoff when Docker runner semantics detected

If the task payload or metadata contains ANY of:

- `executorMode` field set to `docker`, `auto`, or `auto-with-docker-fallback`
- `runnerScope` field set to `all-github`, `github-patch`, or `all`
- `WORKER_HANDLER_COMMAND` environment variable (explicit or inferred)
- `A2A_EXECUTOR_MODE` environment variable reference
- `A2A_DOCKER_RUNNER_SCOPE` environment variable reference

Then the task MUST be **rejected** (not silently ignored). The rejection MUST
include a structured NO-GO signal with reason
`"mobileAlpha_not_docker_runner"`.

This is a **hard boundary**: mobile-alpha runs on Android/Termux with no Docker
daemon, no `docker` CLI, and no GitHub credential store. Any task that expects
Docker execution, GitHub patch/build/test workflow, or CI-level runner semantics
cannot execute on mobile-alpha and must not be admitted.

### Base contract rejection semantics

A task that matches the above rejection criteria MUST NOT be silently dropped.
The worker MUST respond with a structured `NoGoSignal` (or equivalent error
envelope) so the broker can:

1. Record the NO-GO admission decision in the audit log.
2. Requeue the task for a capable worker (e.g. Docker runner).
3. Increment the task's `requeueCount`. When `requeueCount` exceeds
   `BROKER_MAX_REQUEUE_ATTEMPTS` (default 5), the task is dead-lettered
   with `error.code = "exceeded_requeue_limit"`.

This preserves the broker's existing stale-reaper and dead-letter semantics.

## Fixed artifact / evidence manifest requirements

Fixed artifact root:

```text
~/.hermes/a2a/artifacts/<task-id>/
```

Admission evidence manifest:

```text
~/.hermes/a2a/artifacts/<task-id>/evidence.json
```

The admission evidence manifest MUST include:

- `taskId`
- `workerId` set to `mobile-alpha`
- `status` set to `accepted`, `rejected`, or `handoff`
- `files`
- `redactionStatement`
- `limitations` when relevant
- `timestamp`

Every mobile-alpha worker evidence submission MUST include exactly these fields:

```json
{
  "workerId": "mobile-alpha",
  "outcome": "done" | "blocked" | "failed",
  "result": {
    "summary": "<one-line human-readable summary>",
    "output": {
      "mobileAlphaProfile": "hermes-worker",
      "openClawRequired": false,
      "runtimeFlavor": "termux-hermes",
      "profileVersion": 1
    },
    "artifacts": [
      {
        "path": "<repo-relative path to artifact>",
        "kind": "evidence" | "manifest" | "log" | "diff" | "test_output",
        "redacted": true
      }
    ]
  }
}
```

### Requirements

1. **`workerId`** MUST match the registered mobile-alpha node id.
2. **`outcome`** MUST be one of `done`, `blocked`, or `failed`. `pr` is not
   supported because mobile-alpha cannot push GitHub branches.
3. **`openClawRequired`** MUST be `false`.
4. **`runtimeFlavor`** MUST be `"termux-hermes"`.
5. **`profileVersion`** MUST be `1` for this profile.
6. **`artifacts`** MUST be present (may be empty). Each artifact MUST declare
   `redacted: true` when the artifact may contain private paths, hostnames,
   device identifiers, or session metadata.

### Manifest inline check

The evidence MUST pass an inline schema validation before submission.
A `manifest ok` check MUST verify that:

- `workerId` is present and non-empty.
- `outcome` is one of the three allowed values.
- `result.output.mobileAlphaProfile` equals `"hermes-worker"`.
- `result.output.openClawRequired` is `false`.
- `result.output.runtimeFlavor` equals `"termux-hermes"`.
- `result.output.profileVersion` is `1`.
- Every artifact in `artifacts` has `path`, `kind`, and `redacted` fields.
- No evidence field contains a raw device identifier (IMEI, Android ID,
  Tailscale node key), raw session dump, or provider token.

If any check fails, the evidence MUST NOT be submitted. The worker MUST report
a structured `blocked` outcome with `summary` describing the manifest failure.

## Redaction rules

### Must redact (before any artifact, issue, or PR evidence)

- Device identifiers: IMEI, Android ID, device serial, hardware UUID.
- Network identifiers: Tailscale node key, Tailscale machine name beyond
  the `nodeId`, MAC addresses.
- Session metadata: raw OpenClaw session dumps, execution trace IDs that
  embed host or device identifiers.
- Provider tokens: Telegram bot tokens, API keys, edge secrets.
- Host-specific private paths: `/data/data/com.termux/...` paths, internal
  storage paths.
- Runtime environment variables that contain secrets.

### Must keep (safe evidence content)

- `nodeId` (`mobile-alpha` is a public-safe handle).
- Outcome, summary, artifact paths, artifact kinds, profile metadata.
- Test output summaries, exit codes, assertion results.
- `manifest ok` or manifest failure descriptions without raw values.
- Commit SHAs, repo-relative paths, diff fragments without secrets.

### Redaction strategy

- Replace each redacted value with `<redacted>`.
- Do not omit the field entirely; the presence of `<redacted>` signals that
  redaction was applied.
- When a whole artifact is redacted, set `redacted: true` on its entry.

## Fail-closed admission semantics

The mobile-alpha Hermes worker SHALL implement a fail-closed admission function
with the following semantics.

### Signature

```
admit(task: AdmittableTask) → AdmissionDecision
```

### AdmissionDecision

```typescript
type AdmissionDecision =
  | { ok: true; lane: "full" | "observe"; proofLevel: "lightweight" | "none" }
  | { ok: false; noGoSignal: NoGoSignal };
```

### Decision rules (in order)

1. **Runtime guard:** If the task payload or metadata contains Docker runner
   indicators (see "Rejected / handoff task classes" above), return
   `{ ok: false, noGoSignal: { reason: "mobileAlpha_not_docker_runner", ... } }`.
   This check is evaluated first so Docker runner tasks are never assigned
   to a mobile Hermes worker regardless of other fields.
2. **Intent guard:** If the task `intent` is in the rejected set (docker,
   patch_repo, build_repo, test_repo), return NO-GO.
3. **Mode guard:** Evaluate the team mode against the mobile profile (see
   `mobile-safety-lane.ts`). If the mode is not in `allowedModes` or
   `observeOnlyModes`, return NO-GO.
4. **Capability guard:** If the task requires capabilities mobile-alpha does not
   have (heavy proof, GitHub push, Docker workspace, live promotion), return NO-GO.
5. **Resource guard:** If the task would exceed `maxConcurrentTasks`, return NO-GO
   with reason `"at_capacity"`.
6. **Admit:** Return `{ ok: true, lane: ..., proofLevel: ... }`.

### Rejection does not destroy the task

NO-GO from mobile-alpha is NOT a terminal task failure at the broker level. The
broker's existing stale-reaper logic handles requeueing. mobile-alpha does not
mark the task as `failed`; it simply refuses to claim it. If the broker has
already assigned the task to mobile-alpha, mobile-alpha MUST call
`POST /tasks/:id/evidence` with `outcome: "blocked"` and
`summary: "mobile-alpha Hermes worker: task not admitted (mobileAlpha_not_docker_runner)"`
(adjusted for the specific rejection reason).

### Unknown mode default

Any task mode, intent, or capability that is not explicitly listed in the
allowed or handoff sets MUST default to NO-GO. This ensures that new task
classes are not silently accepted by an out-of-date worker profile.

## Success criteria

- [ ] The mobile-alpha profile gives a clear answer for every task class:
      admit with lightweight proof, observe only, handoff, or reject.
- [ ] The admission function rejects Docker runner tasks before any other check.
- [ ] The artifact/evidence manifest schema is validated by a local test.
- [ ] Redaction rules are documented and enforceable.
- [ ] All profile spec, plan, and tasks are under `docs/specs/mobile-alpha-hermes-worker-profile/`.
- [ ] The change performs no live production action.

## Safety and approval boundaries

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

- No production registration, broker/Gateway/worker deploy or restart.
- No live provider sends, Telegram notifications, or canary.
- No database or terminal-outbox mutation.
- No manual ACK/replay.
- No release/tag publication.
- No repository visibility changes.
- No secret rotation or credential disclosure.
- All changes are source-only (docs/specs + validation tests under
  `packages/openclaw-plugin-a2a/tests/`).

## Rollback

Revert the spec docs and test additions. No production state is created.
