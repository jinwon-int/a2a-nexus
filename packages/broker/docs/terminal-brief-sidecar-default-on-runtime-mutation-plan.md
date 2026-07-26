# Terminal Brief sidecar default-on runtime mutation plan

terminal-brief-sidecar-default-on-runtime-mutation-plan is a source-only/no-live
review packet for issue #776. It consumes the accepted default-on enablement gate
from #775 and renders the final runtime mutation plan for operator review.

It does not write config, enable default-on, send providers, ACK terminal rows,
mutate broker/TaskFlow state, spawn or restart sidecar processes, restart
brokers, deploy services, replay history, publish releases, or move secrets.

## Input

The plan expects a ready
`a2a-broker.terminal-brief-sidecar-default-on-enablement-gate.packet`.
That input must already have `state=ready_for_default_on_enablement_review`
and keep all runtime permissions false.

`provider_accepted` remains transport evidence only and is not visibility proof.
`approval_grant` evidence remains source evidence only and does not execute a
grant or enable default-on by itself.

## Boundary

The packet keeps these fields false by construction:

- `runtimeMutationPermitted`
- `configWritePermitted`
- `approvalGrantPermitted`
- `defaultOnPermitted`
- `liveActivationPermitted`
- `providerSendPermitted`
- `terminalAckPermitted`
- `dbMutationPermitted`
- `taskFlowMutationPermitted`
- `executionPermitted`
- `processSpawnPermitted`
- `sidecarStartPermitted`
- `sidecarRestartPermitted`
- `brokerRestartPermitted`

Accepted output may feed a later explicitly approved runtime mutation executor.
That later path still requires fresh operator approval before any config or
service change.

## CLI

```bash
npm run terminal_brief -- terminal_brief_sidecar_default_on_runtime_mutation_plan \
  --input fixtures/terminal-brief/sidecar-default-on-runtime-mutation-plan.no-live.json \
  --json
```

The command exits `0` only for `state=ready_for_runtime_mutation_review`.
