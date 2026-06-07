# Terminal Brief sidecar dispatcher approval handoff

This packet is source-only/no-live. It consumes a Terminal Brief sidecar dispatcher preflight seal packet and renders a human/operator approval handoff draft for a later dispatcher path.

It does not send the approval request, grant approval, execute an approval grant, dispatch or invoke an executor, spawn a process, start or stop the sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy services, replay history, publish releases, or move secrets.

## Input

- `a2a-broker.terminal-brief-sidecar-dispatcher-preflight-seal.packet`
- optional `dispatcherApprovalHandoff` options

The handoff only renders review material. A separate approved sender is required before any approval request dispatch, and a separate approved dispatcher path is required before any runtime action.

## Ready Criteria

The packet can reach `dispatcher_approval_handoff_ready` only when:

- dispatcher preflight seal state is `dispatcher_preflight_seal_ready`;
- dispatcher preflight seal readiness is true;
- the sealed envelope integrity is verified;
- the sealed envelope has not expired;
- every approval, dispatch, executor, process, sidecar, provider, terminal ACK, execution, and DB mutation permission remains fixed false.

## Safety Boundary

The following remain fixed false: approval request dispatch, approval grant, approval grant execution, start executor dispatch, executor invocation, process spawn, sidecar start, default-on, live activation, provider send, terminal ACK, DB mutation, and execution.

Provider accepted/send evidence remains non-ACK evidence. Current-session-visible or manual operator receipt is still required for terminal receipt confirmation.

## CLI

`npm run terminal_brief_sidecar_dispatcher_approval_handoff -- --input fixtures/terminal-brief/sidecar-dispatcher-approval-handoff.no-live.json --json`

## Route

`POST /terminal-brief/sidecar/dispatcher-approval-handoff`

The route is read-only and returns `cache-control: no-store`.
