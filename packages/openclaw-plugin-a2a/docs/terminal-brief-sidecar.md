# Terminal Brief Sidecar

The Terminal Brief sidecar is the long-running worker shape for always-on
Terminal Brief operation outside the OpenClaw Gateway event loop.

## Why

Gateway-side `operatorEvents` is useful for bounded canaries, but continuous
broker event consumption should not share the same OpenClaw Gateway event loop
that serves Telegram liveness and normal Gateway traffic. The sidecar keeps
cursor, duplicate suppression, rendering, and receipt bookkeeping in a separate
process.

## Safety Defaults

- Gateway `operatorEvents` is not required.
- Historical replay is suppressed by default.
- Startup unacked reconciliation is disabled by default.
- The default delivery mode is dry-run.
- The CLI sends broker requests as requester `terminal-brief-sidecar` with role `hub` by default; terminal-outbox subscription is restricted to hub/operator requesters.
- Dry-run renders Terminal Brief envelopes but does not provider-send or ACK terminal outbox rows.
- Provider accepted/message-id evidence is never treated as terminal ACK/read proof.
- Cursor state lives outside `openclaw.json`.

## CLI

Build first:

```bash
npm run build
```

Dry-run one poll cycle:

```bash
a2a-terminal-brief-sidecar --base-url http://127.0.0.1:8787 --cursor-file ~/.openclaw/a2a-terminal-brief-sidecar/cursor.json --requester-id terminal-brief-sidecar --requester-role hub --cursor terminal:latest-known-safe --allow-id terminal-brief-canary-task-id --once --dry-run
```

Live delivery must be supplied by an external notifier. The command receives one
Terminal Brief envelope as JSON on stdin and must return a receipt decision JSON
on stdout:

```json
{
  "ackTerminalEvent": true,
  "confirmationSource": "current_session_visible",
  "receiptId": "telegram:message:123",
  "reason": "operator-visible receipt confirmed"
}
```

Do not return `ackTerminalEvent: true` for provider accepted/send success alone.
Only current-session-visible or manual operator receipt may unlock terminal ACK.
External adapters that only spool or otherwise produce a non-visible operator
artifact can return `terminalReceiptStatus: "produced"`; the sidecar records
that broker receipt state and advances its cursor without ACKing the terminal
outbox row.
The full public adapter contract is documented in
[docs/terminal-brief-delivery-adapter-contract.md](terminal-brief-delivery-adapter-contract.md).

Example external mode:

```bash
a2a-terminal-brief-sidecar --base-url http://127.0.0.1:8787 --cursor-file ~/.openclaw/a2a-terminal-brief-sidecar/cursor.json --delivery-command /opt/a2a-terminal-brief/send-terminal-brief --allow-id terminal-brief-canary-task-id
```

The package also includes a receipt-safe OpenClaw CLI notifier adapter:

```bash
a2a-terminal-brief-openclaw-message \
  --channel telegram \
  --target telegram:<operator-chat-id> \
  --dry-run
```

It calls `openclaw message send --json` and returns `ackTerminalEvent: true`
only when the OpenClaw result explicitly carries `current_session_visible`,
`operator_visible`, or `manual_operator_receipt` style confirmation. A plain
provider/message-id send result returns `ackTerminalEvent: false`; that keeps
the broker terminal-outbox row replayable instead of treating transport
acceptance as receipt evidence.

## Doctor/Status Diagnostic Report

The sidecar includes a `--doctor` diagnostic surface that produces a comprehensive
no-live report of internal state, including cursor positions, stale rows, projection
queue depth, provider-only receipt counters, duplicate suppression metrics, and the
last operator-visible ACK evidence.

The doctor report is a read-only diagnostic tool: it does not start provider sends,
ACK terminal outbox rows, or perform any live side-effects.

```bash
a2a-terminal-brief-sidecar --base-url http://127.0.0.1:8787 --doctor
```

The report output is a JSON document with kind `a2a.terminalBrief.sidecar.doctorReport`:

| Section | Fields | Source |
|---------|--------|-------|
| `cursorState` | `operatorCursor`, `terminalOutboxCursor`, `cursorFile`, `cursorSnapshotUpdatedAt` | Cursor store snapshot |
| `staleRows` | Array of unacknowledged terminal outbox event projections | Bridge state `pendingUnacknowledged` |
| `projectionQueue` | `poller` config + `lastPoll` stats (`timestamp`, `count`, `pendingUnacknowledged`, `backlogDrain`) | Bridge state `terminalOutbox` |
| `duplicateSuppression` | `doctorDiagnostics` with dedupe key counts, fuse state | Bridge state internals |
| `lastOperatorVisibleAck` | `id`, `taskId`, `evidence`, `receiptId`, `acknowledgedAt`, `timestamp` | Bridge state `terminalOutbox.lastAck` |
| `dryRunNotifications` | Count of dry-run notifications seen | Sidecar tracking |
| `safety` | Safety flags (`liveSendRequiresExternalNotifier`, etc.) | Sidecar config defaults |

The `duplicateSuppression.doctorDiagnostics` object provides:

- `notifiedDedupeKeyCount` — unique dedupe keys notified so far (terminal event deduplication)
- `pendingNotificationDedupeKeyCount` — dedupe keys currently awaiting notification
- `notifiedTaskKeyCount` — unique task notification keys notified
- `pendingNotificationTaskKeyCount` — task keys awaiting notification
- `notificationFuseTripped` — whether the one-shot notification fuse has blocked further sends pending manual review
- `retryAfterCount` — active retry-after backoff timers
- `relayedTerminalOutboxIdCount` — terminal outbox IDs relayed cross-broker

### Safety notes

- The `--doctor` flag performs no live execution, provider sends, or terminal outbox
  ACKs. It calls `sidecar.doctor()` which reads the current in-memory bridge state
  and cursor store.
- The doctor report state is a snapshot; it may not reflect concurrent bridge
  activity if the sidecar is running in continuous mode.
- For a point-in-time snapshot, use `--doctor` on an idle sidecar or with `--once`.

The package also includes a Hermes/Gongyung skeleton adapter for non-OpenClaw
harness integration. It defaults to dry-run/spool-only and does not ACK terminal
outbox rows unless a separate approved path supplies explicit current-session
visible or manual operator receipt evidence. In spool-only mode it returns
`terminalReceiptStatus: "produced"`, which is receipt bookkeeping only, not
terminal ACK evidence:

~~~bash
a2a-terminal-brief-sidecar \
  --base-url http://127.0.0.1:8787 \
  --cursor-file ~/.openclaw/a2a-terminal-brief-sidecar/cursor.json \
  --delivery-command a2a-terminal-brief-hermes-gongyung \
  --delivery-command-arg --operator \
  --delivery-command-arg gongyung \
  --delivery-command-arg --spool-file \
  --delivery-command-arg ~/.hermes/a2a-terminal-brief-spool.jsonl \
  --allow-id terminal-brief-canary-task-id
~~~

Relevant environment variables:

- `A2A_BROKER_BASE_URL`: broker base URL.
- `A2A_EDGE_SECRET`: default edge-secret environment variable read by the CLI.
- `A2A_TERMINAL_BRIEF_REQUESTER_ID`: requester id. Defaults to `terminal-brief-sidecar`.
- `A2A_TERMINAL_BRIEF_REQUESTER_KIND`: requester kind. Defaults to `service`.
- `A2A_TERMINAL_BRIEF_REQUESTER_ROLE`: requester role. Defaults to `hub` because terminal-outbox subscription is restricted to hub/operator requesters.
- `A2A_TERMINAL_BRIEF_CURSOR_FILE`: cursor snapshot path.
- `A2A_TERMINAL_BRIEF_OPENCLAW_CHANNEL`: notifier channel. Defaults to `telegram`.
- `A2A_TERMINAL_BRIEF_OPENCLAW_TARGET`: notifier target chat/channel.
- `A2A_TERMINAL_BRIEF_OPENCLAW_ACCOUNT_ID`: optional channel account id.
- `A2A_TERMINAL_BRIEF_OPENCLAW_TIMEOUT_MS`: notifier send timeout.
- `OPENCLAW_BIN`: OpenClaw CLI path. Defaults to `openclaw`.

Hermes/Gongyung skeleton environment variables:

- A2A_TERMINAL_BRIEF_HERMES_OPERATOR: operator id. Defaults to gongyung.
- A2A_TERMINAL_BRIEF_HERMES_SPOOL_FILE: optional dry-run JSONL spool path.
- A2A_TERMINAL_BRIEF_HERMES_MANUAL_RECEIPT_ID: explicit manual receipt projection for approved adapter integration.
- A2A_TERMINAL_BRIEF_HERMES_VISIBLE_RECEIPT_ID: explicit current-session-visible receipt projection for approved adapter integration.

## Deployment Notes

Run the sidecar under systemd or Docker separately from OpenClaw Gateway. A
sidecar restart should not require an OpenClaw Gateway restart.

Recommended production posture:

1. Start with `--dry-run --once` and inspect rendered envelopes.
2. Use a narrow `--allow-id` for the first live canary.
3. Keep historical replay suppressed.
4. Verify OpenClaw Gateway `/readyz` and Telegram liveness before/after the sidecar run.
5. Only then consider a continuous sidecar process.

## Approval Boundaries

This sidecar source implementation does not approve production deploy,
OpenClaw Gateway restart, live provider send, terminal ACK/replay, DB
mutation/prune/migration, release/tag, or credential movement. Each production
step still requires separate operator approval.
