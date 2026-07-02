# Operator terminal notification receipt policy

Terminal broker/outbox notifications are only considered acknowledged after a receipt-confirmed delivery.

## Ack rule

The plugin **must not** advance/persist the operator-event cursor for a terminal notification merely because a Telegram/Gateway provider call returned success. Provider success only means the message was accepted by the transport path; it does not prove the operator saw it.

A terminal notification may be acknowledged only when one of these confirmations exists:

1. **Current-session/user-visible receipt** — the channel adapter returns a receipt indicating the message is visible in the current operator session, for example `delivery.currentSessionVisible: true`, `receipt.userVisible: true`, or `confirmation.source: "current_session_visible"` with a delivered/confirmed status.
2. **Manual operator receipt** — an explicit operator/manual confirmation is present, for example `receipt.manualReceiptConfirmed: true`, `operatorReceiptConfirmed: true`, or `confirmation.source: "manual_operator_receipt"` with a delivered/confirmed status.

Dry-run projection remains local and may advance dry-run state because it never claims live Telegram receipt.

### Accepted-vs-acknowledged compatibility

If OpenClaw/core channel receipts expose separate `accepted` and `acknowledged` fields, the plugin treats them as different states. `accepted: true`, `providerAccepted: true`, or `status: "accepted"`/`"sent"` only means the provider/Gateway accepted the send request, so it must not become a terminal-outbox ACK by itself. The same receipt must also carry an explicit operator-visible acknowledgement such as `acknowledged: true` plus `currentSessionVisible: true`, or one of the manual receipt shapes above.

### Monitor/status projection states

`a2a.monitor.status` projects receipt gaps into operator-safe states: `accepted`, `sent`, `provider-delivered-if-known`, `operator-visible`, `timed_out`, `stale`, and `failed`. Only `operator-visible` with current-session/manual confirmation is ACK-eligible. Provider `accepted`, `sent`, or delivery-if-known states remain visible as pending receipt gaps so transport success is never misreported as operator receipt.

## Preflight before Gateway restart or live smoke

Per-worker terminal/completion Telegram sends are disabled by default. The preferred operator flow is to read the broker `/operator/task-report` endpoint and summarize the round once from the main operator session; do not add cron or worker-side Telegram sends.

Before asking an operator to restart Gateway or run a live Telegram smoke, run a dry preflight that verifies all four readiness layers without sending a message or acknowledging terminal outbox:

1. **Plugin activation** — `plugins.entries.a2a-broker-adapter.enabled=true` or the plugin is present in the allowlist.
2. **Operator-event bridge** — `plugins.entries.a2a-broker-adapter.config.operatorEvents.enabled=true`.
3. **Notification opt-in and target/runtime** — `operatorEvents.notification.enabled=true`, `operatorEvents.notification.to` (or `chatId`) resolves to the intended channel target, and the Gateway runtime can load that channel's outbound adapter. Stale `to`/`chatId`/`channel` values are ignored while either enabled gate is false.
4. **Terminal-outbox fuse state** — if the active bridge already has a tripped one-shot notification fuse or pending manual receipt debt, the preflight must return `BLOCK` before another Gateway restart/live canary. Resolve the operator-visible/manual receipt path first; provider accepted-send evidence is still not terminal ACK evidence.

The exported `preflightA2AOperatorNotificationRuntime(config, runtime, deps?)` helper is intentionally receipt-safe: it may resolve the runtime adapter and inspect supplied terminal-outbox projection state, but it must not call `sendText`, send Telegram, restart Gateway, or post a terminal-outbox ACK. Its `notificationTarget` projection distinguishes `ready`, `disabled`, `missing`, and `blocked` so operators can tell whether a configured target is active, explicitly disabled/stale, absent, or gated by plugin/operator-events activation. Any failing check means live-send, Gateway restart, and real ACK remain operator approval gates; report the exact failed prerequisite instead of proceeding.

Gateway operators can run the same no-live check through `a2a.monitor.status` by setting `operatorEvents.preflight=true` and, when testing a proposed live canary config, passing the proposed `operatorEvents.enabled` and `operatorEvents.notification` values in the request params. The response has `kind: "a2a.operator.notification.preflight"`, `mode: "no-live"`, `decision: "GO" | "BLOCK"`, `safeToRestartGateway`, and the raw `preflight` result. It must report `liveSendPerformed=false`, `providerSendPerformed=false`, and `terminalOutboxAckPerformed=false`.

When an operator has a known terminal-outbox cursor, include `operatorEvents.terminalOutboxCursor` in the same preflight request. The handler reads broker terminal-outbox history with `reconcile_unacked=false` and blocks if accepted/pending rows after that cursor still lack operator-visible/manual receipt evidence. This history lookup is read-only and must not become replay, provider-send, or terminal ACK.

If `operatorEvents.notification.allowUnconfirmedProviderSend=true` is present, the preflight labels `providerSendMode="transport_only_unacknowledged"`. That mode can only prove the provider transport accepts a send; it is not terminal ACK evidence and still requires a current-session/manual receipt before an outbox ACK may be recorded.

## Cross-broker parent-owned routing

When brokerAlpha commands a Team2/brokerBeta child task, the child Terminal Brief must be parent-owned rather than brokerBeta-local. The broker payload should carry `crossBrokerHandoff.parentRoundId`, `crossBrokerHandoff.originBrokerId`, `crossBrokerHandoff.handoffBrokerId`, and either `terminalBrief.parentOwnedTerminalBrief=true` or `notificationOwnership.owner="parent"`/`"origin"`. The resulting terminal-outbox row uses the origin/parent broker as notification owner and marks the handoff broker projection as aggregation evidence only.

On the handoff Gateway, set `operatorEvents.localBrokerId` to the local broker id, for example `brokerBeta`. The local notifier must suppress parent-owned cross-broker rows instead of sending them to the local Telegram target. If `operatorEvents.crossBrokerTerminalRelay.enabled=true`, relay only rows with `crossBrokerHandoff` plus parent-broker-only notification ownership back to the configured origin broker. Team2-only rows without parent-owned handoff metadata remain brokerBeta-local and are not projected to brokerAlpha.

Do not use a broad always-on `allowedIds`/cursor window as the production routing rule. `allowedIds` and cursor windows are canary tools: open them narrowly for one approved test, verify projection and receipt behavior, then close them. The steady-state safety boundary is metadata-based: parent-owned handoff rows relay; local-only rows stay local.

### Operator-facing summary wording for cross-broker projections

Cross-broker projection summaries must make the bounded evidence nature visible to operators. Follow these conventions:

1. **Do not claim terminal ACK completion.** Use phrasing like "terminal evidence relayed" or "projection delivered" instead of "lane completed" or "task acknowledged."
2. **Always prefix projection rows.** Start summaries with the round/lane label ("Lane N: ...") so parent aggregation can group rows by round.
3. **Separate child task success from projection delivery.** A child task may produce terminal evidence; the cross-broker projection of that evidence to the parent broker is a separate operation that must be called out explicitly.
4. **Use "no direct ACK" or "bounded terminal evidence" consistently.** The receipt reason field already carries this language; operator-facing summaries at the goal level should echo it so aggregated reports do not conflate provider send with terminal ACK.
5. **Include round progress.** Summaries that reference `parentRoundOrder/parentRoundTotal` help operators track overall round completion alongside per-lane projection status.

Example operator-facing summary string for a cross-broker projection row:

> Lane 2/7: cross-broker projection-only handling verified — parent-owned remote rows, localBrokerId safety, no direct ACK. Receipt: provider_only (provider delivery receipt only; not operator-visible ACK).

Example goal-level aggregation summary:

> 2/7 lanes terminal; 5 pending projection relay. Child task success is evidence, not final achievement.

## Runbook

If live Telegram/Gateway send reports success but the operator does not receive the message:

1. Treat the terminal notification as **unacknowledged**.
2. Do not manually advance the stored operator-event cursor unless the operator confirms receipt.
3. Re-run in dry-run/projection mode first to verify envelope rendering and dedupe.
4. Resume live delivery only after the channel adapter can produce one of the confirmed receipt shapes above, or after the operator explicitly records manual receipt confirmation.
5. Keep the broker terminal event replayable until the confirmed receipt is recorded.

## Evidence

This policy was added after the live-send discrepancy captured in `jinwon-int/a2a-broker#241`, comment `4362567686`: Gateway reported success, but the operator did not receive the Telegram message. The fix prevents notifier code from treating provider/Gateway acceptance as broker terminal-outbox acknowledgement.

## Plugin-owned terminal outbox polling

For live broker terminal delivery, the plugin notifier polls `GET /a2a/tasks/terminal-outbox` with `reconcile_unacked=true`, renders each compact `task.terminal` record, and only posts `POST /a2a/tasks/terminal-outbox/ack` after the outbound adapter returns a current-session/user-visible receipt or an explicit manual operator receipt. Provider/Gateway send success without that receipt leaves the outbox record unacked and replayable on the next reconcile poll.
