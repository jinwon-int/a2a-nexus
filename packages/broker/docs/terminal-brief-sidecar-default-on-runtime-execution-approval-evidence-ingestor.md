# Terminal Brief sidecar default-on runtime execution approval evidence ingestor

terminal-brief-sidecar-default-on-runtime-execution-approval-evidence-ingestor is
a source-only evidence classifier for the final Terminal Brief default-on
runtime mutation approval reply.

It consumes a ready
`a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-request-draft.packet`
and operator evidence such as the exact reply
`execute default-on runtime mutation 승인`.

It does not send the request, grant approval, execute an approval grant, write
config, enable default-on, start or restart the sidecar, dispatch or invoke an
executor, spawn a process, send providers, ACK terminal rows, mutate
broker/TaskFlow state, restart brokers or Gateway, replay history, publish
releases, or move secrets.

## Accepted Evidence

Accepted state requires both:

- operator-visible receipt proof:
  `current_session_visible` or `manual_operator_confirmation`
- matching runtime execution approval evidence:
  `approval_grant` with `approvedAction=execute_terminal_brief_default_on_runtime_mutation`
  and `approvedTarget` matching either the operator target or execution request
  reference.

`provider_accepted` remains transport evidence only. It is not visibility
proof. `approval_grant` evidence remains source evidence only; this ingestor
does not grant approval or execute runtime mutation.

## Boundary

The packet keeps these fields false by construction:

- `runtimeExecutionRequestDispatchPermitted`
- `approvalGrantPermitted`
- `approvalGrantExecutionPermitted`
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

Accepted output may feed a later separately approved runtime executor gate. It
is still not the runtime executor.

## CLI

```bash
npm run terminal_brief -- terminal_brief_sidecar_default_on_runtime_execution_approval_evidence_ingestor \
  --input fixtures/terminal-brief/sidecar-default-on-runtime-execution-approval-evidence-ingestor.no-live.json \
  --json
```

The command exits `0` only for `state=accepted`.
