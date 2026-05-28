# Operator Event Bridge: Safety Layer Classification

For [a2a-plane#474](https://github.com/jinwon-int/a2a-plane/issues/474).

## Scope

Classifies every independent safety/blocking layer in the
`operator-event-bridge` notification path and identifies the minimal safe
simplification path that preserves:

- Approval gates (explicit operator/permission checks before live sends)
- Terminal ACK boundaries (receipt evidence requirements before acknowledging
  terminal outbox events)

See also: [canary-receipt-gated-runtime-preflight.md](./canary-receipt-gated-runtime-preflight.md)

---

## Layer Classification Table

| # | Layer | Source | Classification | Why |
|---|-------|--------|----------------|-----|
| 1 | Config Gate (triple boolean) | `operator-notification-adapter.ts` `preflightA2AOperatorNotificationRuntime()` | PRODUCTION-ESSENTIAL | Three separate preflight checks (`plugin_activation`, `operator_events_enabled`, `notification_target`) each report a distinct diagnostic. Flattening would lose operator-visible root-cause granularity. Keep as-is. |
| 2 | Preflight Fuse | `operator-notification-adapter.ts` `preflightRuntimeAdapter()` | PRODUCTION-ESSENTIAL (approval gate) | Verifies the runtime adapter resolves and advertises receipt capability without a live send. This is the explicit operator approval gate. |
| 3 | One-shot notification fuse (`terminalOutboxNotificationFuseTripped`) | `operator-event-bridge.ts` `processTerminalOutboxOnce()` | PRODUCTION-ESSENTIAL | Runtime circuit breaker: after a terminal outbox notification is rejected/not-acked, all subsequent outbox notifications are blocked until operator provides a manual receipt. Prevents notification storms. |
| 4 | Receipt gate (`getA2AOperatorTerminalReceiptGate`) | `operator-terminal-notifier.ts` | PRODUCTION-ESSENTIAL (Terminal ACK boundary) | Broker SSE events must carry a receipt projection (`current_session_visible` / `manual_operator_receipt`) before the bridge considers notification. This is the Terminal ACK boundary itself. |
| 5 | **Dedupe suppression (4× Sets)** | `operator-event-bridge.ts` `maybeNotifyOperator()` + `processTerminalOutboxOnce()` | **MERGEABLE** | Two pairs of near-identical Sets (`notifiedDedupeKeys` + `notifiedTaskKeys`, `pendingNotificationDedupeKeys` + `pendingNotificationTaskKeys`) each serve the same purpose. The `buildTaskNotificationKey` helper already prefixes keys with `task:` vs `dedupe:`, so a single merged Set per pair preserves all semantics with no key collision. **Changed in #474.** |
| 6 | Historical replay suppression | `operator-event-bridge.ts` `shouldSuppressHistoricalTerminalEventReplay()` / `shouldSuppressHistoricalTerminalOutboxReplay()` | BOOTSTRAP/DEBUG | Startup safety mechanisms that prevent replay floods after Gateway restart. Separate concern from per-notification safety layers. Document only. |
| 7 | Terminal Outbox Poll `afterId` / `cursor` gating | `operator-event-bridge.ts` `processTerminalOutboxOnce()` | PRODUCTION-ESSENTIAL | Event-driven cursor progression prevents re-sending already-processed rows. Harmless and necessary. |

---

## Simplification Applied

### Merged: `notifiedDedupeKeys` + `notifiedTaskKeys` → `notifiedKeys`

**Before:** Two Sets checked and populated independently for completed
notification deduplication:

```ts
notifiedDedupeKeys: Set<string>;
notifiedTaskKeys: Set<string>;
```

**After:** Single Set holding both raw dedupe keys and `task:`-prefixed keys.
Collision is impossible because `buildTaskNotificationKey` always prefixes with
`task:` when a taskId exists and `dedupe:` otherwise, while the raw dedupeKey
never starts with either prefix.

**Proof:** The dedupeKey is built from
`[eventId, taskId, type, createdAt, prUrl]` which never begins with `task:` or
`dedupe:`. The task-key is built as `task:${taskId}` or `dedupe:${dedupeKey}`.
These are disjoint string spaces.

### Merged: `pendingNotificationDedupeKeys` + `pendingNotificationTaskKeys` → `pendingNotificationKeys`

**Same reasoning** applied to in-flight notification deduplication.

### Why we did NOT merge/hide:

- **One-shot fuse & receipt gate** — distinct mechanisms that protect against
  different failure modes. Keeping them separate aids debugging.
- **Historical replay suppression** — separate lifecycle concern; affects
  startup only.
- **Config/preflight gates** — diagnostic granularity has proven useful during
  operator canary rollouts.
