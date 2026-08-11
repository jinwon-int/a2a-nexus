# Cross-broker Terminal Brief receiver — deployment artifact

Canonical service artifact for running
`packages/broker/scripts/cross-broker-terminal-brief-receiver.mjs` as a
systemd service on the **parent/destination broker host**. One service
instance handles exactly one direction; the two-broker symmetric topology
(contracts/a2a/parent-terminal-brief-aggregation.md, four-case routing
matrix) uses one instance per direction:

| Instance | Source (child producer) | Destination (parent ledger) | Runs on |
| --- | --- | --- | --- |
| forward (`brokerbeta-to-brokeralpha`) | `brokerbeta` | `brokeralpha` | broker-alpha host |
| reverse (`brokeralpha-to-brokerbeta`) | `brokeralpha` | `brokerbeta` | broker-beta host |

The receiver polls the source broker's `GET /a2a/tasks/terminal-outbox`,
filters parent-owned cross-broker terminal events, and POSTs redacted
projections to the destination broker's
`POST /a2a/cross-broker/terminal-briefs`. It never ACKs outbox rows, never
performs provider sends, and never mutates child task lifecycle.

## Invariants the runtime already enforces (do not re-implement in ops)

- **Cursor durability**: the cursor file survives restarts; polls resume
  from the persisted cursor (`CROSS_BROKER_CURSOR_FILE`). Each direction
  MUST use its own cursor file — sharing one file across directions
  corrupts both lanes.
- **Replay convergence**: duplicate polls and replays converge onto a
  single projection per `(parentRoundId, originBrokerId, childKey)`; the
  destination returns `duplicate_replay` and no second operator-facing
  event is emitted.
- **Non-blocking permanent rejects**: `missing_parent`, `stale_replay`, and
  malformed/wrong-addressed events are reported as `skipped` and the cursor
  advances past them, so an old unrelated terminal event cannot wedge the
  lane. Transport/authorization failures stay `blocked` and freeze the
  cursor for at-least-once retry.
- **Fail closed**: malformed, unsigned (when sender-proof trust is pinned),
  wrong-parent, wrong-origin, and unauthorized evidence is rejected by the
  destination broker's ingest ladder.

## Files

- `a2a-cross-broker-terminal-brief-receiver@.service` — systemd template
  unit; the instance name selects the environment file, e.g.
  `systemctl enable a2a-cross-broker-terminal-brief-receiver@brokeralpha-to-brokerbeta`.
- `receiver.env.example` — environment template. Copy to
  `/etc/a2a/cross-broker-receiver/<direction>.env`, fill in values, and set
  root-only permissions (`chmod 0600`).

## Credentials (never commit real values)

- Peer credentials are **minimum-scope**: the source-side credential needs
  only `handoff:status` (outbox poll), the destination-side credential only
  `handoff:evidence` (projection ingest). Do NOT reuse a broker's general
  edge secret as a peer credential.
- Secrets are file-based (`*_FILE` variables). Files must be root-only
  (0600); the runner and the broker registry loader fail closed on
  group/other-accessible files.
- The destination broker provisions the peer registry
  (`A2A_PEER_CREDENTIALS_FILE`) with sha256 digests only. The raw secret
  exists only on the sending host.
- Sender-proof: once the destination pins the source broker's public key
  (`CROSS_BROKER_SENDER_PROOF_KEYS_FILE`), the receiver must be configured
  with `CROSS_BROKER_SENDER_PROOF_PRIVATE_KEY_FILE` or every projection
  fails closed. Roll out sender-side config before pinning.
- Credential provisioning/rotation and service enablement on live hosts are
  operator-approval-gated actions; this artifact only defines the shape.

## Validation before enabling the unit

```sh
# Read-only dry run (single poll; writes nothing but the cursor file):
set -a; . /etc/a2a/cross-broker-receiver/<direction>.env; set +a
node packages/broker/scripts/cross-broker-terminal-brief-receiver.mjs --once
```

Expected output: a JSON line with `ok`, `fetched/ignored/posted/accepted/
replayed`, plus `blocked` (retryable, cursor frozen) and `skipped`
(permanent, cursor advanced) arrays. Secrets never appear in the output.
