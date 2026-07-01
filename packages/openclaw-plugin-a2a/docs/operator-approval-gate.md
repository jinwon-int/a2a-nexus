# Operator Approval Gate — Live Send Boundary

Issue: [jinwon-int/plugin-a2a#247](https://github.com/jinwon-int/plugin-a2a/issues/247)
Parent: a2a-plane#174 (internal tracker, private) (a2a-plane#174, internal tracker private)
Post-#78261 health round: [jinwon-int/plugin-a2a#249](https://github.com/jinwon-int/plugin-a2a/issues/249)
Parent round: a2a-plane#181 (internal tracker, private) (a2a-plane#181, internal tracker private)
Run: `a2a-post-78261-health-readiness-20260510T024701Z`

## Safety boundary

The plugin operates with a fail-closed receipt-runtime boundary. **No live
Telegram message, Gateway restart, production deploy, or terminal-outbox ACK
may proceed without explicit operator approval.**

This boundary is enforced across these layers:

| Layer | Gate | Fail-Closed Behaviour |
|-------|------|-----------------------|
| Config | `operatorEvents.notification.enabled` | Must be `true`; otherwise `resolveOperatorNotificationTarget` returns `undefined` |
| Notification adapter | `createA2AOperatorNotificationAdapter` | Returns `undefined` when no target is configured |
| Runtime preflight | `preflightA2AOperatorNotificationRuntime` | Returns `safeToRestartGateway: false` when any check fails |
| Receipt projection | `normalizeReceiptProjection` | Only `current_session_visible` and `manual_operator_receipt` are valid; provider-only acceptance is rejected |
| Telegram dry-run | `createA2ATelegramSafeDryRunNotificationHarness` | Never sends live; records in-memory only with `dryRun: true` |
| Conformance smoke gate | `createA2AConformanceSmokeGate` | All `safeOperations` are explicitly `false` |

## Receipt-ACK eligibility matrix

Only operator-visible receipt projections can produce ACK-eligible notification
envelopes. Provider acceptance alone is never sufficient.

| Projection | Envelope Produced? | ACK Eligible? |
|------------|-------------------|---------------|
| `current_session_visible` | ✅ Yes | ✅ Yes |
| `manual_operator_receipt` | ✅ Yes | ✅ Yes |
| `provider_send_success` | ❌ No | ❌ No |
| `send_ok` | ❌ No | ❌ No |
| `delivery_sent` | ❌ No | ❌ No |
| `<empty or missing>` | ❌ No | ❌ No |
| any other string | ❌ No | ❌ No |

## Post-#78261 evidence semantics

Per the #78261 closure, the following evidence semantics are unambiguous:

1. **Provider accepted-send is non-ACK.** A provider message-id or send-success
   response proves only that the provider accepted the message for delivery. It
   does not prove read receipt, operator visibility, or terminal completion.

2. **Live notification is approval-gated.** No notification may be sent to a
   live channel (Telegram, etc.) without explicit operator approval. The dry-run
   harness records everything in-memory without external sends.

3. **No bypass path exists.** Every code path that could produce a notification
   envelope is receipt-projection-gated:

   | Code path | Gate |
   |-----------|------|
   | SSE event → `buildA2AOperatorTerminalNotificationEnvelope` | `readOperatorReceiptProjection()` returns `undefined` for non-operator-visible projections → envelope is `undefined` |
   | Terminal-outbox poll → `buildA2AOperatorTerminalOutboxNotificationEnvelope` | `readOperatorReceiptProjection()` returns `undefined` for non-operator-visible projections → envelope is `undefined` |
   | Operator-notification adapter → `readReceiptConfirmationSource` | `candidateIsAcceptedButNotAcknowledged()` rejects provider-only statuses before ACK eligibility |

### Non-ACK statuses (provider-only evidence)

The `candidateIsAcceptedButNotAcknowledged` function explicitly rejects these
statuses as provider-acceptance-only (non-ACK):

- `accepted`, `queued`, `sent`, `provider_sent`
- `provider_send_success`, `provider_accepted_send`
- `message_sent`, `send_ok`, `delivery_sent`, `send_success`
- `gateway_provider_send_success`
- Boolean flags: `accepted`, `providerAccepted`, `provider_accepted`, `sendAccepted`, `send_accepted`, `delivered`

### Valid receipt projections

Only these projections are eligible for notification envelope production:

- `current_session_visible` — the message is visible in the operator's current session
- `manual_operator_receipt` — the operator has manually confirmed receipt

All other strings (including `provider_send_success`, `send_ok`, `delivery_sent`, empty, missing)
are rejected at the `normalizeReceiptProjection` gate.

## Operator approval checklist

Before the operator approves any live send, verify these conditions:

- [ ] `operatorEvents.enabled` is `true` in plugin config
- [ ] `operatorEvents.notification.enabled` is `true`
- [ ] `operatorEvents.notification.to` (or `chatId`) is configured
- [ ] Runtime preflight returns `safeToRestartGateway: true`
- [ ] Dry-run canary harness has been exercised and all tests pass
- [ ] Receipt projection in the payload is `current_session_visible` or `manual_operator_receipt` (not provider-only)
- [ ] The notification envelope carries a non-empty `dedupeKey`

For a proposed Terminal Brief live canary, run `a2a.monitor.status` with
`operatorEvents.preflight=true` and the proposed `operatorEvents.enabled` /
`operatorEvents.notification` values before Gateway restart or outbox polling.
The no-live response must return `decision="GO"` and
`safeToRestartGateway=true`; it also must state that no live send, provider
send, or terminal-outbox ACK was performed. If the response reports
`providerSendMode="transport_only_unacknowledged"`, treat that as a
transport-only canary path, never as terminal ACK evidence.

### Explicit approval gates

Each of these actions requires its own explicit operator approval:

1. **Live Telegram delivery** — `createA2AOperatorNotificationAdapter.notify()` with a real runtime
2. **Gateway restart** — `openclaw gateway restart` with notification enabled
3. **Production deploy** — any change to the running plugin configuration
4. **Terminal-outbox ACK** — advancing the cursor/ACK state on a broker terminal-outbox record

### Running the no-live canary

```bash
npm ci
npm run build
node --test tests/no-live-canary.test.ts
```

The canary exercises all four boundary conditions (notification disabled,
provider accepted-only, operator-visible receipt, ACK eligibility) without
sending any live message or mutating any external state.
