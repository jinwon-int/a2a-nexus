# Terminal Brief sidecar default-on runtime execution final gate

terminal-brief-sidecar-default-on-runtime-execution-final-gate is a
source-only/no-live packet for issue #784. It consumes accepted default-on
execution approval evidence and renders the last broker/finalizer review packet
before any later runtime executor path.

It does not execute default-on. It does not write config, enable default-on,
start or restart the sidecar, dispatch or invoke executors, spawn processes,
send providers, ACK terminal rows, mutate DB or TaskFlow state, restart
Gateway/brokers, replay history, publish releases, or move secrets.

## Ready condition

The final gate reaches `ready_for_runtime_execution_final_review` only when the
input execution approval evidence packet is accepted and contains both:

- accepted receipt evidence
- accepted approval evidence

The input must also preserve all no-live boundaries. Any source packet that
unexpectedly permits config write, default-on enablement, sidecar restart,
executor invocation, process spawn, provider send, terminal ACK, DB/TaskFlow
mutation, or broker restart blocks this gate.

## Boundary

The packet keeps these fields false by construction:

- runtimeMutationPermitted
- configWritePermitted
- defaultOnPermitted
- sidecarRestartPermitted
- providerSendPermitted
- terminalAckPermitted
- dbMutationPermitted
- taskFlowMutationPermitted
- startExecutorDispatchPermitted
- executorInvocationPermitted
- executionPermitted
- processSpawnPermitted
- sidecarStartPermitted
- brokerRestartPermitted
- gatewayRestartPermitted

Ready output means final source review is ready. It is not execution
authorization and is not a runtime mutation.

## CLI

Command:

npm run terminal_brief_sidecar_default_on_runtime_execution_final_gate -- --input fixtures/terminal-brief/sidecar-default-on-runtime-execution-final-gate.no-live.json --json

The command exits 0 only for `state=ready_for_runtime_execution_final_review`.
