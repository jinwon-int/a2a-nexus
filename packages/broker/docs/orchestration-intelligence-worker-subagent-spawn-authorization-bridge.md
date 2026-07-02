# A2A Orchestration Intelligence v2 worker/subagent spawn authorization bridge

The worker/subagent spawn authorization bridge packet is the source-only step
after the OI v2 worker spawn approval decision evidence packet and the existing
`a2a-broker.worker-subagent-spawn-authorization-request.packet` draft.

It connects the two source chains:

- accepted OI v2 worker spawn approval decision evidence, where
  `workerSpawnApprovalPresent=true` is evidence only
- an existing v1 worker/subagent spawn authorization request draft, where all
  runtime mutation and live-action boundaries remain false

The output may report `bridge_ready` and render an operator/finalizer-reviewable
authorization bridge request. It does not grant authorization and does not
perform any runtime work.

## Readiness checks

The bridge reports ready only when:

- upstream OI v2 worker spawn approval decision evidence is accepted
- upstream OI v2 evidence remains source-only and grants no execution approval
- the v1 authorization request state is `authorization_request_draft_ready`
- v1 source-only boundaries are intact
- a finalizer is present
- recommended roles are mapped
- the v1 draft still requires a separate dispatch/spawn decision
- v1 semantics preserve the source-only contract

Any missing, rejected, expired, conflicting, stale, scope-mismatched,
authority-mismatched, or unsafe upstream evidence fails closed.

## CLI

```bash
npm run orchestration_intelligence_worker_subagent_spawn_authorization_bridge -- \
  --input fixtures/orchestration-intelligence/worker-subagent-spawn-authorization-bridge.ready.json
```

Use `--json` for the raw packet.

## Boundary

This packet is source/docs/tests only. It does not grant worker/subagent spawn
authorization, create broker tasks, invoke executors, spawn workers/subagents,
mutate TaskFlow/DB, send providers, ACK/replay Terminal rows, deploy/restart
services, publish releases, or move credentials.

The bridge keeps runtime spawn, broker dispatch, executor invocation, mobilebeta
mobile expansion, provider send, DB/TaskFlow mutation, Terminal ACK/replay,
deploy/restart, release/publish, and credential movement as separate future
approval gates.
