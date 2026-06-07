# Terminal Brief sidecar default-on execution approval evidence ingestor

terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor is a
source-only/no-live packet for issue #782. It consumes the default-on execution
approval request draft packet and explicit operator receipt/approval evidence.

It records evidence only. It does not send approval requests, grant approval,
write runtime config, enable default-on, restart the sidecar, send providers,
ACK terminal rows, mutate DB or TaskFlow state, spawn processes, execute the
rollback envelope, deploy services, replay history, publish releases, or move
secrets.

## Accepted evidence

The ingestor accepts execution approval evidence only when both sides are
present and non-conflicting:

| Evidence | Meaning | Accepted for source criteria |
|---|---|---|
| current_session_visible | The execution approval request was visible in the current operator session. | Yes, as receipt proof |
| manual_operator_confirmation | Operator manually confirmed the execution approval request receipt. | Yes, as receipt proof |
| approval_grant | Explicit grant matching approve_terminal_brief_default_on_execution and the approval target/reference. | Yes, as approval evidence |
| provider_accepted | Provider/adapter accepted a send. | No; transport evidence only |

provider_accepted alone is never visibility proof. approval_grant evidence is
still source evidence only; it does not grant approval or execute default-on by
itself.

## Boundary

The packet keeps these fields false by construction:

- executionApprovalRequestDispatchPermitted
- approvalGrantPermitted
- runtimeMutationPermitted
- configWritePermitted
- defaultOnPermitted
- sidecarRestartPermitted
- providerSendPermitted
- terminalAckPermitted
- dbMutationPermitted
- taskFlowMutationPermitted
- executionPermitted
- processSpawnPermitted
- sidecarStartPermitted
- brokerRestartPermitted

Accepted evidence may feed a later runtime execution gate. That later gate must
still be separate from this ingestor and must perform its own final checks.

## CLI

Command:

npm run terminal_brief_sidecar_default_on_execution_approval_evidence_ingestor -- --input fixtures/terminal-brief/sidecar-default-on-execution-approval-evidence-ingestor.no-live.json --json

The command exits 0 only for state=accepted; insufficient, stale, conflicting,
rejected, or blocked packets exit non-zero.
