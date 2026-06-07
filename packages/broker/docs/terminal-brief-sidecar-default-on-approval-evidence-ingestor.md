# Terminal Brief sidecar default-on approval evidence ingestor

terminal-brief-sidecar-default-on-approval-evidence-ingestor is a
source-only/no-live packet for issue #772. It consumes the default-on approval
request draft packet and explicit receipt/approval evidence records.

It records evidence only. It does not send the approval request, grant approval,
enable default-on, send providers, ACK terminal rows, mutate state, spawn or
restart the sidecar, deploy services, replay history, publish releases, or move
secrets.

## Accepted evidence

The ingestor accepts default-on approval evidence only when both sides are
present and non-conflicting:

| Evidence | Meaning | Accepted for source criteria |
|---|---|---|
| current_session_visible | The approval request was visible in the current operator session. | Yes, as receipt proof |
| manual_operator_confirmation | Operator manually confirmed the approval request receipt. | Yes, as receipt proof |
| approval_grant | Explicit grant matching approve_terminal_brief_default_on_enablement and the approval target/reference. | Yes, as approval evidence |
| provider_accepted | Provider/adapter accepted a send. | No; transport evidence only |

provider_accepted alone is never visibility proof. approval_grant evidence is
still evidence only; it does not grant approval or enable default-on by itself.

## Boundary

The packet keeps these fields false by construction:

- approvalRequestDispatchPermitted
- approvalGrantPermitted
- defaultOnPermitted
- providerSendPermitted
- terminalAckPermitted
- dbMutationPermitted
- executionPermitted
- processSpawnPermitted
- sidecarStartPermitted

Accepted evidence may feed a later default-on enablement gate. That later gate
must still be separate from this ingestor.

## CLI

Command:

npm run terminal_brief_sidecar_default_on_approval_evidence_ingestor -- --input fixtures/terminal-brief/sidecar-default-on-approval-evidence-ingestor.no-live.json --json

The command exits 0 only for state=accepted; insufficient, stale,
conflicting, rejected, or blocked packets exit non-zero.
