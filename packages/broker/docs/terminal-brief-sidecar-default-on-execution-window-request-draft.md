# Terminal Brief sidecar default-on execution window request draft

`terminal-brief-sidecar-default-on-execution-window-request-draft` is a
source-only/no-live packet after the final live execution review packet. It
renders the fresh operator execution window request that a broker finalizer can
review before a separate approval/send step.

It does not send the request, grant approval, create checkpoints, restore
checkpoints, write config, enable default-on, apply or restart the sidecar,
dispatch/invoke an executor, spawn a process, send providers, ACK/replay
terminal rows, mutate DB/TaskFlow state, restart Gateway/broker, release,
publish, or move secrets.

## Input

Provide a ready
`a2a-broker.terminal-brief-sidecar-default-on-final-live-execution.packet`.

The fixture shape is:

```json
{
  "defaultOnFinalLiveExecutionPacket": { "...": "packet" },
  "executionWindowRequestDraft": {
    "requestedBy": "broker-finalizer",
    "operatorTarget": "terminal-brief-default-on",
    "executionWindowReference": "tb-sidecar-default-on-execution-window:fixture-794",
    "approvalWindowMinutes": 10
  }
}
```

The generated draft uses this required reply:

```text
fresh operator execution window 승인
```

That reply is still evidence for a later step. It does not execute the mutation
by itself.

## CLI

```bash
npm run terminal_brief_sidecar_default_on_execution_window_request_draft -- \
  --input fixtures/terminal-brief/sidecar-default-on-execution-window-request-draft.no-live.json \
  --json
```

Expected ready output:

- `state=execution_window_request_draft_ready`
- `sourceOnlyNoLive=true`
- `executionWindowRequestDraftReady=true`
- `executionWindowRequestDispatchPermitted=false`
- `checkpointCreationPermitted=false`
- `configWritePermitted=false`
- `defaultOnPermitted=false`
- `sidecarRestartPermitted=false`
- `executorInvocationPermitted=false`
- `executionPermitted=false`
- `processSpawnPermitted=false`

## HTTP

```bash
curl -X POST "$BROKER_URL/terminal-brief/sidecar/default-on-execution-window-request-draft" \
  -H "content-type: application/json" \
  --data-binary @fixtures/terminal-brief/sidecar-default-on-execution-window-request-draft.no-live.json
```

When broker edge auth is configured, include the normal
`x-a2a-edge-secret`, `x-a2a-requester-id`, and `x-a2a-requester-role` headers.

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
