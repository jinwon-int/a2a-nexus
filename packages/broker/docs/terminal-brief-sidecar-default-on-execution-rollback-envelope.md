# Terminal Brief sidecar default-on execution rollback envelope

terminal-brief-sidecar-default-on-execution-rollback-envelope is a
source-only/no-live review packet for issue #778. It consumes the ready
default-on runtime mutation plan from #777 and renders the final
execution/rollback envelope for operator review.

It does not execute commands, write config, enable default-on, send providers,
ACK terminal rows, mutate broker/TaskFlow state, spawn or restart sidecar
processes, restart brokers, deploy services, replay history, publish releases,
or move secrets.

## Input

The envelope expects a ready
`a2a-broker.terminal-brief-sidecar-default-on-runtime-mutation-plan.packet`.
That input must have `state=ready_for_runtime_mutation_review`,
`configChange.applied=false`, and an execution envelope that is not executable.

## Boundary

The packet keeps these fields false by construction:

- `executionApprovalRequestPermitted`
- `runtimeMutationPermitted`
- `configWritePermitted`
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

Accepted output may feed a later explicit execution approval request. That later
path still requires fresh operator approval before any config write or service
change.

## CLI

```bash
npm run terminal_brief_sidecar_default_on_execution_rollback_envelope -- \
  --input fixtures/terminal-brief/sidecar-default-on-execution-rollback-envelope.no-live.json \
  --json
```

The command exits `0` only for `state=ready_for_execution_approval_review`.
