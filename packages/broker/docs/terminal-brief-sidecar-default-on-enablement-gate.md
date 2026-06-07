# Terminal Brief sidecar default-on enablement gate

terminal-brief-sidecar-default-on-enablement-gate is a source-only/no-live
review packet for issue #774. It consumes accepted default-on approval evidence
from the #773 ingestor and renders the final pre-runtime enablement review.

It does not enable default-on, send providers, ACK terminal rows, mutate broker
state, spawn or restart sidecar processes, deploy services, replay history,
publish releases, or move secrets.

## Input

The gate expects an accepted
`a2a-broker.terminal-brief-sidecar-default-on-approval-evidence-ingestor.packet`.
That input must already contain both operator-visible receipt proof and matching
`approval_grant` evidence for `approve_terminal_brief_default_on_enablement`.

`provider_accepted` remains transport evidence only and is not visibility proof.
`approval_grant` evidence remains source evidence only and does not execute a
grant or enable default-on by itself.

## Boundary

The packet keeps these fields false by construction:

- `approvalRequestDispatchPermitted`
- `approvalGrantPermitted`
- `defaultOnPermitted`
- `providerSendPermitted`
- `terminalAckPermitted`
- `dbMutationPermitted`
- `executionPermitted`
- `processSpawnPermitted`
- `sidecarStartPermitted`

Accepted output may feed a later runtime mutation plan. That later plan still
requires explicit operator approval before any config or service change.

## CLI

```bash
npm run terminal_brief_sidecar_default_on_enablement_gate -- \
  --input fixtures/terminal-brief/sidecar-default-on-enablement-gate.no-live.json \
  --json
```

The command exits `0` only for `state=ready_for_default_on_enablement_review`.
