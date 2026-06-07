# Terminal Brief sidecar default-on runtime execution request draft

terminal-brief-sidecar-default-on-runtime-execution-request-draft is a
source-only packet builder for the last approval-request draft before any live
Terminal Brief default-on runtime mutation.

It consumes a ready
`a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-final-gate.packet`
and renders the final operator-visible request text for a later explicit
runtime executor.

It does not send the request, grant approval, execute an approval grant, write
config, enable default-on, start or restart the sidecar, dispatch or invoke an
executor, spawn a process, send providers, ACK terminal rows, mutate
broker/TaskFlow state, restart brokers or Gateway, replay history, publish
releases, or move secrets.

## Input

The route expects a ready runtime execution final gate packet:

- `state=ready_for_runtime_execution_final_review`
- `finalGate.gateReady=true`
- `readiness.runtimeExecutionFinalGateReady=true`
- all runtime/action permission flags remain `false`

The CLI fixture may also include the final gate source envelope and options; the
builder derives the same ready final gate packet before drafting the request.

## Boundary

The packet keeps these fields false by construction:

- `dispatchPermitted`
- `runtimeExecutionRequestDispatchPermitted`
- `approvalGrantPermitted`
- `runtimeMutationPermitted`
- `configWritePermitted`
- `defaultOnPermitted`
- `sidecarRestartPermitted`
- `liveActivationPermitted`
- `providerSendPermitted`
- `terminalAckPermitted`
- `dbMutationPermitted`
- `taskFlowMutationPermitted`
- `startExecutorDispatchPermitted`
- `executorInvocationPermitted`
- `executionPermitted`
- `processSpawnPermitted`
- `sidecarStartPermitted`
- `brokerRestartPermitted`
- `gatewayRestartPermitted`

Accepted output may feed a later separately approved delivery step that sends
the request to the operator. It is still not the runtime executor.

## CLI

```bash
npm run terminal_brief_sidecar_default_on_runtime_execution_request_draft -- \
  --input fixtures/terminal-brief/sidecar-default-on-runtime-execution-request-draft.no-live.json \
  --json
```

The command exits `0` only for
`state=runtime_execution_request_draft_ready`.
