# A2A Current-State No-Live Integration Smoke

This smoke is the source-only integration proof for `a2a-plane#508`, under the active `a2a-plane#506` current-state wave.

It is not a live dispatch test. It is a deterministic umbrella packet that proves the current intended boundaries between the A2A repositories before any broader live or operational expansion.

## Scope

The smoke fixture lives at `fixtures/current-state/no-live-integration-smoke.json` and uses schema `a2a.current-state.no-live-integration-smoke.v1`.

It covers four phases:

1. `a2a-broker`: work-mode decision and dispatch gating dry-run.
2. `a2a-docker-runner`: read-only / no-change evidence classification.
3. `openclaw-plugin-a2a`: requester-visible status projection from injected broker fixtures.
4. `a2a-plane`: one finalizer packet that aggregates worker evidence and next actions.

The validator is `scripts/check-current-state-no-live-integration-smoke.mjs`.

## Required Boundaries

The fixture and finalizer packet must explicitly keep these actions false:

- live A2A dispatch
- provider or Telegram send
- DB mutation
- Terminal ACK/replay
- deploy/restart or Gateway restart
- credential movement
- worker-owned GitHub mutation
- repo visibility change
- release/tag/npm/Docker publish
- force-push/history rewrite
- destructive checkout cleanup

## Owning Repo Gaps

This smoke does not move implementation authority into `a2a-plane`.

- `a2a-broker#1318` owns mandatory/durable work-mode decision enforcement.
- `a2a-docker-runner#358` owns clean-main read-only/no-change evidence smoke.
- `openclaw-plugin-a2a#457` owns requester-visible status and ACK-boundary fixture coverage.

`agent-olympics` is independent and is not an A2A no-live smoke lane or A2A
owning-repo gap.

## Finalizer Packet

The finalizer packet should be the user-visible product of the smoke. It should show the tracker, repo owner, lane, worker/source, current state, evidence link, local checkout readiness, source-of-truth ref, no-live boundary status, blocker/risk, finalizer decision, next action, and Wiki/runbook follow-up.

Workers provide evidence only. broker-alpha remains the single finalizer.

## worker-gamma GitHub Patch Lane Smoke

This secondary smoke fixture lives at `fixtures/current-state/worker-gamma-patch-lane-smoke.json` and uses schema `a2a.worker-gamma.patch-lane-smoke.v1`. It is a focused, low-risk smoke under `a2a-nexus#1022` that proves `worker-gamma` can claim a `github-propose-patch` A2A task, produce a valid branch/PR, and include compact evidence without touching any live broker/Gateway/worker services.

### Scope

The fixture records only non-secret facts:

- `workerId`: `worker-gamma`
- `runtime`: `hermes-agent`
- `harness`: `hermes`
- `workerMode`: `persistent`
- Capability under test: `github-propose-patch`
- Broker boundary: broker-alpha broker-backed task, PR-first only
- PR is source-only: no deploy, no restart, no DB mutation, no Terminal ACK/replay, no provider/Telegram send, no secret movement

### Required Boundaries

The fixture enforces the same no-live boundary set as the parent smoke, plus explicit worker-specific constraints:

- Worker must not close the issue or merge the PR
- Finalizer validates PR and updates Family Wiki
- PR contains only source/docs/fixture changes, no raw secrets and no local env/session dumps
- Existing relevant checks pass, or exact blocker evidence is reported

### Acceptance

- Worker posts Start + PR/Done/Block evidence in GitHub comments
- PR is opened against `main`
- Evidence is compact and redacted-only
