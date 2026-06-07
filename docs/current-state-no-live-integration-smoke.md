# A2A Current-State No-Live Integration Smoke

This smoke is the source-only integration proof for `a2a-plane#508`, under the active `a2a-plane#506` current-state wave.

It is not a live dispatch test. It is a deterministic umbrella packet that proves the current intended boundaries between the A2A repositories before any broader live or operational expansion.

## Scope

The smoke fixture lives at `fixtures/current-state/no-live-integration-smoke.json` and uses schema `a2a.current-state.no-live-integration-smoke.v1`.

It covers five phases:

1. `a2a-broker`: work-mode decision and dispatch gating dry-run.
2. `a2a-docker-runner`: read-only / no-change evidence classification.
3. `openclaw-plugin-a2a`: requester-visible status projection from injected broker fixtures.
4. `agent-olympics`: live-runner boundary fixture validation for benchmark-only evidence.
5. `a2a-plane`: one finalizer packet that aggregates worker evidence and next actions.

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
- `agent-olympics#205` owns the benchmark record format after the no-live proof path is stable.

## Finalizer Packet

The finalizer packet should be the user-visible product of the smoke. It should show the tracker, repo owner, lane, worker/source, current state, evidence link, local checkout readiness, source-of-truth ref, no-live boundary status, blocker/risk, finalizer decision, next action, and Wiki/runbook follow-up.

Workers provide evidence only. Seoseo remains the single finalizer.
