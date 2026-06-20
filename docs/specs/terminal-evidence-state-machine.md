# Terminal Evidence State Machine

This spec defines the minimal A2A Nexus terminal-evidence state machine for #965 / #957.

It is a source-only/no-live contract. It does not authorize broker deploys, provider sends, terminal-outbox mutation, Terminal Brief ACK/replay, DB replay, releases, secret movement, or visibility changes.

## Core boundary

`provider_accepted is not terminal ACK`.

A provider accepting a send, returning a message id, or reporting transport acceptance is only provider-side acceptance evidence. It is not proof that the operator saw the event, acknowledged it, or approved closeout.

`operator_visible is not terminal ACK`.

`operator_visible` means the broker or plugin produced an operator-facing projection that can be inspected by the operator. It may be user/operator visible, but it is still not an ACK and must not be treated as final operator consent.

`acknowledged is the only operator-owned terminal ACK state`.

`acknowledged` requires explicit operator-owned evidence such as current-session-visible/manual operator confirmation. It is the only ACK state in this contract.

## State table

| State | Owner | Terminal for closeout | Operator visible | Meaning |
|---|---|---:|---:|---|
| `accepted` | broker | false | false | Broker accepted task/evidence envelope. |
| `claimed` | worker | false | false | Worker claimed the lane. |
| `started` | worker | false | false | Worker began execution. |
| `provider_accepted` | provider | false | false | Provider accepted a send/transport request; not ACK. |
| `operator_visible` | broker | false | true | Broker/plugin produced an operator-facing projection; not ACK. |
| `done` | worker | true | true | Worker completed without a PR/blocker. |
| `blocked` | worker | true | true | Worker cannot complete and supplied a blocker. |
| `failed` | worker | true | true | Worker failed with error evidence. |
| `acknowledged` | operator | true | true | Operator-owned ACK/receipt proof exists. |

## Finalizer ownership

The finalizer owner is carried by `finalizerOwner` in the source-only `workModeDecision` or equivalent finalizer packet. The operator-facing owner is carried by `operatorFacingOwner`.

Only the broker/finalizer path should promote evidence into `operator_visible`. Workers emit worker-owned terminal evidence (`done`, `blocked`, `failed`) and must not synthesize `acknowledged`.

## Examples

### Done

`started -> done`

Worker emits redacted completion evidence. It counts for closeout, but it is not operator ACK.

### Block

`started -> blocked`

Worker emits a blocker reason. It counts as a terminal worker result, not an operator ACK.

### PR

`started -> done` with `terminalEvidenceKind=pr`

PR is modeled as terminal worker evidence attached to `done`, not as a separate ACK. GitHub PR/comment/provider message ids are evidence references, not ACK proof.

### Provider accepted

`started -> provider_accepted`

Transport/provider accepted the send. This does not count for closeout and is not operator-visible by itself.

### Operator visible

`provider_accepted|done|blocked|failed -> operator_visible`

Broker/plugin produced the operator-facing projection. It is visible but still not terminal ACK.

### Acknowledged

`operator_visible|done|blocked|failed -> acknowledged`

Operator-owned receipt evidence exists. This is terminal ACK.

## Contract files

- Schema: `contracts/a2a/terminal-evidence.schema.json`
- Fixture: `fixtures/contract/terminal-evidence-state-machine.json`
- Conformance: `test/conformance/check-terminal-evidence-state-machine.mjs`
