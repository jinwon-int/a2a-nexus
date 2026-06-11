# Terminal Brief Delivery Adapter Contract

Terminal Brief sidecar delivery is harness-neutral. The sidecar owns broker
polling, cursor storage, replay suppression, duplicate handling, and terminal
outbox ACK decisions. A delivery adapter owns only the final operator transport.

The bundled OpenClaw message notifier is one adapter implementation, not a core
sidecar dependency. Hermes, non-OpenClaw agents, or another harness can provide
their own adapter with the same stdin/stdout contract.

## Adapter Process Contract

The sidecar invokes the configured delivery command once per Terminal Brief
envelope.

Input on stdin is a single JSON object:

~~~json
{
  "kind": "a2a.operator.notification",
  "version": 1,
  "id": "terminal-brief-task-1",
  "dedupeKey": "terminal-brief-task-1",
  "type": "success",
  "severity": "info",
  "deliveryOwner": "openclaw.plugin-notifier",
  "deliveryTarget": "operator-main-session",
  "title": "A2A Terminal Brief 완료: worker(1/1)",
  "text": "A2A Terminal Brief 완료: worker(1/1)\nsummary",
  "evidence": {
    "schema": "a2a.operator.notification.evidence",
    "version": 1,
    "taskId": "terminal-brief-task-1",
    "worker": "worker"
  }
}
~~~

Output on stdout must be a single JSON receipt decision:

~~~json
{
  "ackTerminalEvent": false,
  "terminalReceiptStatus": "produced",
  "reason": "provider accepted send but operator-visible receipt is not confirmed",
  "receiptId": "provider-message-id-if-known"
}
~~~

ACK-eligible output requires one of the two explicit receipt sources:

~~~json
{
  "ackTerminalEvent": true,
  "confirmationSource": "current_session_visible",
  "receiptId": "harness-visible-receipt-id",
  "reason": "operator-visible receipt confirmed"
}
~~~

~~~json
{
  "ackTerminalEvent": true,
  "confirmationSource": "manual_operator_receipt",
  "receiptId": "manual-receipt-id",
  "reason": "operator manually confirmed receipt"
}
~~~

confirmation_source, source, receiptMode, receipt_mode, receiptProjection,
receipt_projection, and evidence are accepted aliases. operator_visible and
user_visible normalize to current_session_visible. operator_confirmed normalizes
to manual_operator_receipt.

## Receipt Safety

The adapter must not set ackTerminalEvent: true for these states by themselves:

- provider accepted
- provider sent
- provider delivered if known
- provider message id
- queue accepted
- dry-run

Those states can be reported in reason or receiptId alone; in that fail-closed
case the sidecar keeps the broker terminal-outbox row replayable until
current-session-visible or manual operator receipt is confirmed.

Harness-neutral adapters that successfully produce an operator-facing artifact
without receipt evidence can return a non-ACK terminal receipt status:

~~~json
{
  "ackTerminalEvent": false,
  "terminalReceiptStatus": "produced",
  "receiptId": "hermes-gongyung:gongyung:terminal-brief-task-1",
  "reason": "spooled for Gongyung review"
}
~~~

For 'accepted', 'started', 'produced', 'provider_sent', and
'provider_accepted', the sidecar records '/a2a/tasks/terminal-outbox/receipt'
and advances its cursor, but it does not call the ACK endpoint. The broker row
therefore remains unacknowledged and terminal ACK remains blocked until an
adapter later returns current-session-visible or manual operator receipt
evidence.

If an adapter exits non-zero, times out, returns invalid JSON, or returns
ackTerminalEvent: true without an accepted confirmation source, the sidecar
fails closed and does not ACK the terminal event.

## OpenClaw Adapter

The package includes a2a-terminal-brief-openclaw-message, which calls openclaw
message send --json and converts the OpenClaw result into this receipt decision
contract.

~~~bash
a2a-terminal-brief-sidecar \
  --base-url http://127.0.0.1:8787 \
  --cursor-file ~/.openclaw/a2a-terminal-brief-sidecar/cursor.json \
  --delivery-command a2a-terminal-brief-openclaw-message \
  --delivery-command-arg --channel \
  --delivery-command-arg telegram \
  --delivery-command-arg --target \
  --delivery-command-arg telegram:<operator-chat-id>
~~~

## Hermes Or Other Harness Adapter

A Hermes or non-OpenClaw adapter should preserve the same boundary:

~~~bash
a2a-terminal-brief-sidecar \
  --base-url http://127.0.0.1:8787 \
  --cursor-file ~/.openclaw/a2a-terminal-brief-sidecar/cursor.json \
  --delivery-command /opt/hermes/bin/a2a-terminal-brief-adapter \
  --delivery-command-arg --operator \
  --delivery-command-arg gongyung
~~~

The sidecar does not need to know whether the adapter talks to OpenClaw, Hermes,
another agent harness, or a local operator UI. It only trusts the normalized
receipt decision JSON.

## Bundled Hermes/Gongyung Skeleton Adapter

The package also includes a2a-terminal-brief-hermes-gongyung as a public-safe
Hermes/Gongyung adapter skeleton. It does not call OpenClaw, Telegram, provider
transports, or Hermes live messaging by default. Its default behavior is
dry-run/spool-only, so it returns ackTerminalEvent: false with
terminalReceiptStatus: produced.

Dry-run spool example:

~~~bash
a2a-terminal-brief-sidecar \
  --base-url http://127.0.0.1:8787 \
  --cursor-file ~/.openclaw/a2a-terminal-brief-sidecar/cursor.json \
  --delivery-command a2a-terminal-brief-hermes-gongyung \
  --delivery-command-arg --operator \
  --delivery-command-arg gongyung \
  --delivery-command-arg --spool-file \
  --delivery-command-arg ~/.hermes/a2a-terminal-brief-spool.jsonl
~~~

The spool file is operator-review evidence only; it is not terminal receipt
evidence and must not ACK broker terminal-outbox rows. The sidecar may record
the broker receipt status as produced so it can advance its local cursor without
claiming terminal ACK.
Rendered envelopes label the requested operator proof as `Required receipt proof`
so spool-only artifacts do not look like actual receipt or ACK evidence.

The skeleton can project a receipt only when another approved Hermes/Gongyung
path has already confirmed one of the accepted receipt sources:

~~~bash
a2a-terminal-brief-hermes-gongyung --manual-receipt-id manual:gongyung:20260518
a2a-terminal-brief-hermes-gongyung --visible-receipt-id hermes:gongyung:visible:20260518
~~~

Those explicit options are intended as adapter integration seams, not as proof
that provider send or queue acceptance is enough. Provider accepted/message-id
states still return ackTerminalEvent: false unless the adapter can map them to
current-session-visible or manual operator receipt evidence.

The skeleton can also read a local receipt evidence file. This is the preferred
Hermes/Gongyung integration shape because the live harness can write a small
receipt record independently, while the sidecar adapter stays no-live and
fail-closed:

~~~bash
a2a-terminal-brief-hermes-gongyung \
  --operator gongyung \
  --spool-file ~/.hermes/a2a-terminal-brief-spool.jsonl \
  --receipt-evidence-file ~/.hermes/a2a-terminal-brief-receipts.jsonl \
  --receipt-max-age-ms 600000
~~~

Receipt evidence may be JSONL, a JSON array, or one JSON object. The newest
matching valid record wins. A record must match the envelope by envelopeId,
dedupeKey, or taskId; must match the configured operator; must include
receiptId; and must include a fresh observedAt or updatedAt timestamp.

~~~json
{
  "schema": "a2a.terminalBrief.hermesGongyung.receipt.v1",
  "operator": "gongyung",
  "envelopeId": "terminal-brief-task-1",
  "confirmationSource": "current_session_visible",
  "status": "visible",
  "receiptId": "hermes:gongyung:visible:20260518T071500Z",
  "observedAt": "2026-05-18T07:15:00.000Z"
}
~~~

~~~json
{
  "schema": "a2a.terminalBrief.hermesGongyung.receipt.v1",
  "operator": "gongyung",
  "taskId": "terminal-brief-task-1",
  "receiptMode": "manual_operator_receipt",
  "status": "operator_confirmed",
  "receiptId": "manual:gongyung:20260518T071500Z",
  "observedAt": "2026-05-18T07:15:00.000Z"
}
~~~

Evidence for provider_sent, provider_accepted, queue accepted, or spool
production remains non-ACK evidence. Missing, stale, mismatched, malformed, or
provider-only evidence returns ackTerminalEvent: false and terminalReceiptStatus
failed or stale.
