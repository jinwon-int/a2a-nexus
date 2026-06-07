# Terminal Brief sidecar default-on execution window approval evidence ingestor

terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor is
a source-only/no-live classifier after the execution window request draft. It
records whether the operator-visible receipt and the required approval reply are
present before a later, separate runtime mutation executor gate.

It does not send the request, grant or execute approval, create checkpoints,
restore checkpoints, write config, enable default-on, apply or restart the
sidecar, dispatch/invoke an executor, spawn a process, send providers,
ACK/replay terminal rows, mutate DB/TaskFlow state, restart Gateway/broker,
release, publish, or move secrets.

## Input

Provide a ready
a2a-broker.terminal-brief-sidecar-default-on-execution-window-request-draft.packet
plus evidence records.

The fixture shape is:

    {
      "defaultOnExecutionWindowRequestDraftPacket": { "...": "packet" },
      "executionWindowApprovalEvidence": {
        "records": [
          {
            "kind": "current_session_visible",
            "evidenceId": "visible:fixture"
          },
          {
            "kind": "approval_grant",
            "replyText": "fresh operator execution window 승인"
          }
        ]
      }
    }

Accepted evidence requires both:

- receipt proof: current_session_visible or manual_operator_confirmation
- approval proof: matching approval_grant for the execution window reference,
  requested action, operator target, and required reply

provider_accepted is only transport acceptance and is not visibility proof.
approval_grant evidence is only evidence classification and does not execute an
approval grant.

## CLI

    npm run terminal_brief_sidecar_default_on_execution_window_approval_evidence_ingestor -- \
      --input fixtures/terminal-brief/sidecar-default-on-execution-window-approval-evidence-ingestor.no-live.json \
      --json

Expected accepted output:

- state=accepted
- sourceOnlyNoLive=true
- receiptEvidenceAccepted=true
- approvalEvidenceAccepted=true
- executionWindowApprovalEvidenceAccepted=true
- providerAcceptedIsVisibilityProof=false
- approvalGrantEvidenceExecutesGrant=false
- checkpointCreationPermitted=false
- configWritePermitted=false
- defaultOnPermitted=false
- sidecarRestartPermitted=false
- executorInvocationPermitted=false
- executionPermitted=false
- processSpawnPermitted=false

## HTTP

    curl -X POST "$BROKER_URL/terminal-brief/sidecar/default-on-execution-window-approval-evidence" \
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
