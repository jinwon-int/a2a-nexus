# Terminal Brief sidecar default-on final live execution packet

terminal-brief-sidecar-default-on-final-live-execution is a source-only/no-live
packet for issue #792. It consumes a ready default-on runtime executor gate and
renders the final live execution review envelope: target config identity,
checkpoint requirement, rollback command template, execution command template,
sidecar apply command template, healthcheck command template, and abort
conditions.

It does not execute default-on. It does not create a checkpoint, restore a
checkpoint, write config, enable default-on, start or restart the sidecar,
dispatch or invoke executors, spawn processes, send providers, ACK terminal
rows, mutate DB or TaskFlow state, restart Gateway/brokers, replay history,
publish releases, or move secrets.

## Ready condition

The packet reaches `ready_for_final_live_execution_review` only when the input
runtime executor gate is `ready_for_runtime_executor_review` and preserves all
no-live boundaries.

Any source gate that unexpectedly permits runtime mutation, config write,
default-on enablement, sidecar start/restart, executor dispatch/invocation,
process spawn, provider send, terminal ACK, DB/TaskFlow mutation, or
Gateway/broker restart blocks this packet.

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
- checkpointCreationPermitted
- rollbackExecutionPermitted

Ready output means final source review is ready. It is not execution
authorization and is not a runtime mutation.

## CLI

Command:

npm run terminal_brief -- terminal_brief_sidecar_default_on_final_live_execution --input fixtures/terminal-brief/sidecar-default-on-final-live-execution.no-live.json --json

The command exits 0 only for `state=ready_for_final_live_execution_review`.
