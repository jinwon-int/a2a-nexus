# Terminal Brief sidecar default-on live executor

terminal-brief-sidecar-default-on-live-executor is a source-only, fail-closed
packet after the final runtime mutation executor gate. It renders the live
executor review surface and inert operation templates for the later live
execution step, but it does not arm or perform any runtime action.

It does not create checkpoints, execute rollback, write config, enable
default-on, apply or restart the sidecar, dispatch/invoke an executor, spawn a
process, send providers, ACK/replay terminal rows, mutate DB/TaskFlow state,
restart Gateway/broker, release, publish, or move secrets.

## Input

Provide either an
a2a-broker.terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate.packet
or the raw no-live approval evidence fixture accepted by the previous ingestors.

The accepted source criteria are:

- final runtime mutation executor gate state is ready_for_final_runtime_mutation_executor_review
- finalRuntimeMutationExecutorGateReady=true
- sourceOnlyNoLive=true
- every runtime/action permission remains false
- every runtime/action integration contract remains false
- boundary semantics still show no checkpoint, rollback, config write,
  default-on enablement, sidecar start/restart, executor dispatch/invocation,
  process spawn, provider send, terminal ACK, DB/TaskFlow mutation, restart,
  release, publish, or secret movement

## Output state

Expected ready output is still not execution:

- state=awaiting_final_live_execution_approval
- liveExecutorReviewReady=true
- finalLiveExecutionApprovalRequired=true
- finalLiveExecutionApprovalAccepted=false
- executionArmed=false
- executionPerformed=false
- checkpointCreationPermitted=false
- configWritePermitted=false
- defaultOnPermitted=false
- executionPermitted=false
- processSpawnPermitted=false

The packet includes planned operation templates for checkpoint creation, config
write, sidecar apply, and post-apply healthcheck. Every operation has
permitted=false, performed=false, and requiresFinalApproval=true.

## CLI

    npm run terminal_brief -- terminal_brief_sidecar_default_on_live_executor \
      --input fixtures/terminal-brief/sidecar-default-on-execution-window-approval-evidence-ingestor.no-live.json \
      --json

## HTTP

    curl -X POST "$BROKER_URL/terminal-brief/sidecar/default-on-live-executor" \
      -H "content-type: application/json" \
      --data-binary @fixtures/terminal-brief/sidecar-default-on-execution-window-approval-evidence-ingestor.no-live.json

When broker edge auth is configured, include the normal x-a2a-edge-secret,
x-a2a-requester-id, and x-a2a-requester-role headers.

## Boundary

This is the last source-only executor surface before a later explicit live
execution approval can be requested. It proves the executor packet exists and is
fail-closed; it is not the live default-on mutation.
