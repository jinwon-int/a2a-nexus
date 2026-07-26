# Terminal Brief sidecar default-on final runtime mutation executor gate

terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate is a
source-only/no-live review packet after the execution window approval evidence
ingestor. It checks that the fresh operator execution window evidence is
accepted and renders the last source-only gate before any later live runtime
executor step.

It does not send the execution window request, grant or execute approval, create
checkpoints, restore checkpoints, write config, enable default-on, apply or
restart the sidecar, dispatch/invoke an executor, spawn a process, send
providers, ACK/replay terminal rows, mutate DB/TaskFlow state, restart
Gateway/broker, release, publish, or move secrets.

## Input

Provide either an
a2a-broker.terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.packet
or the raw no-live approval evidence fixture accepted by that ingestor.

The accepted source criteria are:

- execution window approval evidence state is accepted
- receiptEvidenceAccepted=true
- approvalEvidenceAccepted=true
- executionWindowApprovalEvidenceAccepted=true
- providerAcceptedIsVisibilityProof=false
- approvalGrantEvidenceExecutesGrant=false
- every runtime/action permission remains false

## CLI

    npm run terminal_brief -- terminal_brief_sidecar_default_on_final_runtime_mutation_executor_gate \
      --input fixtures/terminal-brief/sidecar-default-on-execution-window-approval-evidence-ingestor.no-live.json \
      --json

Expected ready output:

- state=ready_for_final_runtime_mutation_executor_review
- sourceOnlyNoLive=true
- finalRuntimeMutationExecutorGateReady=true
- checkpointCreationPermitted=false
- rollbackExecutionPermitted=false
- configWritePermitted=false
- defaultOnPermitted=false
- sidecarRestartPermitted=false
- startExecutorDispatchPermitted=false
- executorInvocationPermitted=false
- executionPermitted=false
- processSpawnPermitted=false

## HTTP

    curl -X POST "$BROKER_URL/terminal-brief/sidecar/default-on-final-runtime-mutation-executor-gate" \
      -H "content-type: application/json" \
      --data-binary @fixtures/terminal-brief/sidecar-default-on-execution-window-approval-evidence-ingestor.no-live.json

When broker edge auth is configured, include the normal x-a2a-edge-secret,
x-a2a-requester-id, and x-a2a-requester-role headers.

## Boundary

The packet always keeps these false:

- execution window request dispatch
- approval grant / approval grant execution
- checkpoint creation / rollback execution
- runtime mutation / config write
- Terminal Brief default-on enablement
- sidecar start/restart/apply
- live activation / provider send
- terminal ACK/replay
- DB/TaskFlow mutation
- start executor dispatch / executor invocation / process spawn
- Gateway/broker restart
- release/publish
- secret movement
