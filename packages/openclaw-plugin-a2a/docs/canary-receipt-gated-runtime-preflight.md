# Receipt-gated notifier canary runtime preflight

This is the plugin-side preflight for `jinwon-int/a2a-broker#241` and
`jinwon-int/plugin-a2a#177`. It prepares the canary update for the
terminal-outbox notifier without performing any live operation.

## Canary update target

Deploy the plugin canary at the corrective receipt-gated monitor projection commit:

- Issue: <https://github.com/jinwon-int/plugin-a2a/issues/177>
- Target commit: `4f30c03aaea2df99b5a5e81670f50cf585a16480`
- Scope: monitor-status deploy preflight projection for terminal-outbox cursor, backlog, notification attempt, and receipt-gated ACK evidence.

If a newer commit supersedes this target, update this document before the
operator canary deploy so the runtime target is explicit and reviewable.

## Safety boundary

This preflight is intentionally no-live-send and no-ACK:

- Do not perform a production deploy.
- Do not restart Gateway.
- Do not send a live Telegram message.
- Do not post a real `terminal-outbox/ack`.
- Provider/Gateway send success alone is **not** terminal ACK evidence.

A terminal-outbox record may be ACKed only after current-session/user-visible
receipt evidence or an explicit manual operator receipt. Provider acceptance
without one of those receipts must leave the record unacked and replayable.

## Local verification

From the repository root, run:

```bash
npm ci
scripts/canary-receipt-gated-preflight.sh
```

The script records the expected canary target commit, verifies the checkout, and
runs the local gates that exercise the receipt-gated path:

1. `npm run build`
2. `node --test test/operator-event-bridge.test.mjs`
3. `npm test`

The targeted operator event bridge test includes the no-live receipt-gated
runtime behavior and deploy-preflight projection: provider/Gateway send success
without current-session/manual receipt stays visibly distinct from
operator-visible receipt and does not advance terminal cursor/ACK state, while
receipt-confirmed notifications may do so.

For the live-readiness round (`jinwon-int/a2a-broker#294`),
`a2a.monitor.status` also projects a bounded `liveReadiness` block from broker
diagnostics. It reports canary checks, canonical `PR`/`Done`/`Block` evidence
acceptance, missing evidence, and queue hygiene signals (`queued`, `claimed`,
`running`, `stale`, `timedOut`). Any missing evidence or active/stale/timed-out
queue signal blocks readiness, and the projection keeps all live operations
(`providerSend`, `terminalOutboxAck`, Gateway restart, deploy) explicitly false.

## Operator gate after merge

If the canary requires live Telegram delivery, Gateway restart, production
deploy, or a real terminal-outbox ACK, stop and request operator approval with
the exact operation and target commit. Those actions are outside this PR's safe
preflight scope.
