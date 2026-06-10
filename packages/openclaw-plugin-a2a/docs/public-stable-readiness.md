# Public/stable readiness notes

This note documents the public-safe configuration boundary for the OpenClaw A2A plugin adapter. It is intended for operators wiring a private/local `a2a-broker` to OpenClaw without copying host-specific values into docs, examples, or issues.

## Public-safe plugin configuration

Use placeholders in shared docs and issue evidence. Do not paste real broker URLs, edge secrets, node IDs, Telegram targets, bot tokens, cookies, or raw runtime dumps.

```json
{
  "plugins": {
    "entries": {
      "a2a-broker-adapter": {
        "enabled": true,
        "config": {
          "baseUrl": "https://broker.example.test",
          "edgeSecret": "${A2A_EDGE_SECRET}",
          "requester": {
            "id": "openclaw-operator",
            "kind": "service",
            "role": "operator"
          },
          "operatorEvents": {
            "enabled": false,
            "notification": {
              "enabled": false,
              "channel": "telegram",
              "to": "telegram:<operator-chat-id>"
            }
          },
          "wakeOnTask": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

Field notes:

- `baseUrl` is the broker HTTP(S) endpoint. Use loopback/private URLs only in local notes; use `https://broker.example.test` in public examples.
- `edgeSecret` is optional and sensitive. Prefer a secret reference placeholder such as `${A2A_EDGE_SECRET}` in docs; never record the literal secret.
- `requester.id`, `requester.kind`, and `requester.role` set the default requester headers sent to the broker (`x-a2a-requester-*`). Keep IDs generic in public examples.
- `operatorEvents.enabled` only enables the broker operator-event bridge. It does not by itself enable live notification sends.
- `operatorEvents.notification.enabled` is a second explicit gate for legacy per-worker terminal notification delivery. Leave it `false` for public/stable defaults.
- `wakeOnTask.enabled` is opt-in. Leave it `false` unless the OpenClaw/broker deployment has validated the wake path.

## Diagnostics commands (read-only operator verification)

The plugin exposes these diagnostics surfaces for operators to verify configuration
and broker connectivity without live sends or Gateway restarts:

| Command | Purpose | Safety |
|---------|---------|--------|
| `a2a.monitor.status` | Full operator status projection (health, readiness, receipt gaps) | Read-only; no messages, no ACK |
| `a2a.monitor.status` (preflight mode) | Checks all four readiness layers with `operatorEvents.preflight=true` | No-live; reports `liveSendPerformed=false` |
| `a2a.alerts.list` | Fetches operator-facing alerts from broker diagnostics | Read-only |
| `a2a.task.status` | Fetches specific task execution/delivery status | Read-only |

See [`docs/operator-install-checklist.md`](./operator-install-checklist.md#4-verification-diagnostics-commands)
for full request/response patterns and verification runbook.

## Provider-accepted evidence: permanent fail-closed policy (#229)

As of `jinwon-int/plugin-a2a#229` (direction reset post-#78261-close),
provider-accepted delivery is **permanently insufficient for terminal-outbox ACK
evidence**. The upstream `openclaw/openclaw#78261` was closed by a maintainer
without merge; the plugin's fail-closed stance is now an intentional permanent
policy, not a temporary gate awaiting an upstream PR.

Provider-accepted-only states (`providerAccepted: true`, `provider_accepted: true`,
`accepted: true`, `sendAccepted: true`, `status: "accepted"`, `status: "sent"`,
`status: "provider_sent"`) are explicitly skipped by the plugin's receipt-boundary
gate (`candidateIsAcceptedButNotAcknowledged`). These states may indicate the
provider/Gateway accepted the send request, but they do not prove the operator
saw the message.

Terminal ACK requires one of:

1. **Current-session/user-visible receipt** — the channel adapter returns
   `currentSessionVisible: true` or equivalent with a `confirmed`/`delivered` status.
2. **Manual operator receipt** — an explicit `manualReceiptConfirmed: true` or
   equivalent operator confirmation.

This policy is enforced by:

- The receipt-boundary gate (`candidateIsAcceptedButNotAcknowledged`) in
  `src/operator-notification-adapter.ts`.
- `OPERATOR_VISIBLE_TERMINAL_RECEIPT_PROJECTIONS` in `src/delegated-task-runtime.ts`,
  which only recognizes `current_session_visible` and `manual_operator_receipt`.
- The conformance smoke gate (`receiptRuntimeBoundary`) in
  `src/conformance-smoke-gate.ts`.
- `scripts/scan-public-readiness.sh` which enforces fail-closed no-live-send.

Provider-accepted-only evidence will never become terminal ACK evidence. The
receipt bar remains at current-session-visible or manual-operator receipt
evidence only.

## Compatibility boundary

Until those boundaries are validated together, `plugin-a2a` remains a
private/unpublished plugin package. The repository's temporary `openclaw` peer
range is not a public wildcard compatibility claim.

Public/stable readiness is conditional on all three boundaries matching:

1. OpenClaw exposes the plugin seams required by the release (sessions-send hook, wait-run handle, cancel fan-out, timer/gateway runtime seams as documented in the compatibility matrix).
2. The plugin and broker agree on the auth/requester header contract and task/error/status vocabulary.
3. Broker schema assumptions match the matrix row for the release.

Do not broaden version ranges in release notes unless these boundaries have been validated together. A green plugin test run alone is not proof that a private broker deployment or live notification path is compatible.

## Notification and terminal-outbox safety

The public/stable default is **no live operator notification delivery**:

- `operatorEvents.enabled=false`
- `operatorEvents.notification.enabled=false`
- no Gateway restart, live Telegram send, DB mutation, or terminal-outbox ACK as part of docs validation

Provider/Gateway send acceptance is not a terminal-outbox ACK. A terminal notification can only be ACKed after a current-session/user-visible receipt or an explicit manual operator receipt, as defined in [`operator-terminal-notification-receipts.md`](./operator-terminal-notification-receipts.md).

Use dry-run/projection tests for public evidence. If a live send is needed, pause for explicit operator approval and keep secrets/targets redacted in the resulting evidence.

### Quick-start verification (no-live, read-only)

```bash
# 1. Build
npm ci && npm run build

# 2. Public-readiness scan (must pass)
npm run scan:public-readiness

# 3. Full test suite
npm test

# 4. No-live canany
node --test tests/no-live-canary.test.ts

# 5. Status wording safety tests
node --test tests/status-card-wording.test.ts
```

All commands are no-live: no Telegram messages, no Gateway restarts,
no terminal-outbox ACKs.

See [`docs/operator-install-checklist.md`](./operator-install-checklist.md#9-verification-runbook-quick-start)
for the complete runbook.
