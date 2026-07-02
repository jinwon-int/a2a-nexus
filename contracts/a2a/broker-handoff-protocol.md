# Broker-to-broker handoff protocol (minimal slice, v0 Freeze)

> **v0 Freeze (2026-05-09):** Handoff envelope shape, peer permissions, status relay,
> and terminal evidence relay are frozen as the Contract v0 handoff baseline.
> Changes to envelope fields or peer permission scopes require a v0→v1 plan.

This contract defines the safe handoff boundary between the broker-alpha/Team1 broker and the broker-beta/Team2 broker.

It is intentionally peer-to-peer: brokers exchange handoff envelopes, status, and redacted terminal evidence. They do **not** register each other as workers, attach the other team's workers, or gain normal task execution rights on the peer broker.

## Actors

- **Source broker**: the broker that owns the original operator/GitHub request.
- **Destination broker**: the broker that creates and owns the destination team task.
- **Broker of record**: must be the destination broker for the destination task. All claim/start/complete/fail behavior remains under that broker's worker policy.
- **Shared evidence board**: GitHub issue/PR/wiki links used only as redacted references.

## Peer permissions

Peer credentials are scoped. The minimal permission set is:

- `handoff:create` — request a destination task for a handoff envelope.
- `handoff:status` — read status/result for an existing handoff.
- `handoff:evidence` — relay terminal PR/Done/Block evidence as metadata.
- `handoff:comment` — optional permission for a broker-side comment relay. This does not imply live provider send rights.

A peer missing the required scope fails closed before task creation or evidence mutation.

## Create request envelope

```json
{
  "sourceBrokerId": "broker-alpha",
  "destinationBrokerId": "broker-beta",
  "brokerOfRecord": "broker-beta",
  "idempotencyKey": "issue-23:team2:work-slice",
  "sourceIssueUrl": "a2a-plane#23 (internal tracker, private)",
  "sourceTaskUrl": "a2a-plane#23 (internal tracker, private)#issuecomment-redacted",
  "requestedTeamId": "team1",
  "summary": "Small bounded request summary"
}
```

### Parent Terminal Brief metadata (optional, symmetric)

When the handoff is part of a parent Terminal Brief aggregation round, the envelope may carry parent
metadata. These fields enable symmetric origin-broker flow where the origin broker and parent broker
may be the same or different brokers:

- `parentRoundId` — stable parent round id minted by the origin broker.
- `originBrokerId` — broker that created the parent round; immutable after minting.
- `parentBrokerId` — broker rendering the aggregate Terminal Brief notification.

In the symmetric v1 contract (see `parent-terminal-brief-aggregation.md`), `parentBrokerId` may differ
from `originBrokerId`. The handoff envelope carries both so the child broker can relay terminal
evidence back to the correct parent projection ledger regardless of which broker owns the notification.

Parent metadata invariants:

1. When `parentRoundId` is present, `originBrokerId` and `parentBrokerId` are both required.
2. `originBrokerId` must not be rewritten by the destination broker or replay handlers.
3. The destination broker must relay terminal evidence to the parent broker identified by `parentBrokerId`,
   not to its own aggregation ledger.

`requestedTeamId` is the authenticated requesting/source team, not a grant to attach destination workers. The destination side remains defined by `destinationBrokerId` and `brokerOfRecord`; worker routing and terminal state mutation stay under the destination broker's own policy.

Required invariants:

1. `brokerOfRecord` equals `destinationBrokerId`.
2. `idempotencyKey` identifies one logical handoff. Replays with the same logical envelope return the existing destination task.
3. Reuse of an idempotency key for a different source/destination/team/link is a conflict, not a second dispatch.
4. Peer identity must match `sourceBrokerId` and have `handoff:create`.
5. Peer team identity must match `requestedTeamId`; a handoff must fail closed if the source broker tries to authenticate as the destination team.

## Status/result relay

The source broker may query by idempotency key or subscribe to a read-only event stream when it has `handoff:status`. Status records include:

- source broker id
- destination broker id
- destination task id
- broker of record
- state: `accepted`, `running`, `succeeded`, `blocked`, `refused`, `timed_out`, or `canceled`
- redacted terminal evidence when present

Status polling must not expose worker secrets, raw terminal logs, provider payloads, or host-specific paths.

## Terminal evidence relay

Terminal evidence is metadata only:

```json
{
  "kind": "block",
  "url": "a2a-plane#23 (internal tracker, private)#issuecomment-redacted",
  "summary": "Block: test failed after [redacted] in [path]",
  "redacted": true
}
```

Allowed terminal kinds are PR, Done, and Block. Evidence relay does not ACK terminal outbox rows and does not prove provider delivery by itself. ACK remains a separate operator/provider receipt flow.

## Safety boundaries

- Keep the repository private.
- No repository visibility change, deploy, Gateway/broker/worker restart, production DB mutation, live provider/Telegram message, terminal-outbox ACK, secret rotation/disclosure, history rewrite, or force-push without explicit operator approval.
- No cross-worker registration: broker-alpha does not register broker-beta as a worker, broker-beta does not register broker-alpha as a worker, and Team2 workers are not attached to the broker-alpha broker.
- Evidence must be redacted and bounded; no raw session dumps or OpenClaw runtime/bootstrap files.
- Parent Terminal Brief metadata in handoff envelopes is symmetric: either broker may be the origin. The destination broker must respect `parentBrokerId` as the notification renderer, even when it differs from `originBrokerId`.

## Minimal test obligations

A practical implementation should prove:

- successful handoff creates exactly one destination task for an idempotency key;
- duplicate handoff returns the existing destination task;
- missing auth or missing scope is refused;
- destination broker is broker of record;
- terminal PR/Done/Block evidence is relayed as redacted metadata only;
- missing `handoff:evidence` scope cannot relay terminal evidence.
