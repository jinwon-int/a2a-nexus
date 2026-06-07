# Terminal Brief sidecar default-on execution approval request

terminal-brief-sidecar-default-on-execution-approval-request is a
source-only/no-live request draft packet for issue #780. It consumes the ready
default-on execution/rollback envelope from #779 and renders the operator
approval request text for a later runtime config write and sidecar restart.

It does not send the approval request, grant approval, execute the envelope,
write config, enable default-on, send providers, ACK terminal rows, mutate
broker/TaskFlow state, spawn or restart sidecar processes, restart brokers,
deploy services, replay history, publish releases, or move secrets.

## Input

The route expects a ready
`a2a-broker.terminal-brief-sidecar-default-on-execution-rollback-envelope.packet`.
That input must have `state=ready_for_execution_approval_review`,
`executionEnvelopeReady=true`, no executable command template, no env or
secret values, and no executable rollback.

## Boundary

The packet keeps these fields false by construction:

- `dispatchPermitted`
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
- `executionPermitted`
- `processSpawnPermitted`
- `brokerRestartPermitted`

Accepted output may feed a later operator-visible approval delivery step. That
later step still only asks for approval; it is not the runtime executor.

## CLI

```bash
npm run terminal_brief_sidecar_default_on_execution_approval_request -- \
  --input fixtures/terminal-brief/sidecar-default-on-execution-approval-request.no-live.json \
  --json
```

The command exits `0` only for
`state=execution_approval_request_draft_ready`.
