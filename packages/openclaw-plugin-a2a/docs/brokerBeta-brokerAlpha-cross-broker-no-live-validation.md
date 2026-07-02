# brokerBeta→brokerAlpha cross-broker no-live validation

_No-live validation harness for the route: brokerBeta origin row → brokerAlpha projection → brokerAlpha synthetic Terminal Brief → brokerAlpha operator-facing ACK, with no brokerBeta local operator brief._

- Lane: `jinwon-int/plugin-a2a#429`
- Run: `a2a-allhands-dev-20260522T064600Z`
- Parent: `a2a-plane#416 (internal tracker, private)`
- Worker: workerEta (team2)

## Route

```
brokerBeta (handoff broker, Team2)
  │
  │ 1. Origin row: child task completes at brokerBeta
  │    crossBrokerHandoff.originBrokerId = "brokerAlpha"
  │    notificationOwnership.ownerBrokerId = "brokerAlpha"
  │
  ├──2──→ brokerAlpha (parent broker, finalizer)
  │         │
  │         │ 3. Synthetic Terminal Brief generated at brokerAlpha
  │         │
  │         ├──4──→ brokerAlpha operator receives notification
  │         │
  │         └──5──→ brokerAlpha operator provides ACK
  │
  └── ✗ 6. No brokerBeta local operator brief (suppressed)
```

## Test evidence by route leg

### Leg 1: brokerBeta origin row produced

The handoff (brokerBeta) broker creates a terminal-outbox event with `crossBrokerHandoff` and parent-broker-only `notificationOwnership`. The brokerBeta bridge detects the cross-broker metadata and must *not* treat the row as a local brokerBeta Terminal Brief.

**Test:** `test/operator-event-bridge.test.mjs` — `"operator bridge relays cross-broker Terminal Brief projections"`
**Evidence (lines ~3810–3827):**
```
assert.equal(relayed[0].brokerOfRecordId, "brokerAlpha");
assert.equal(relayed[0].originBrokerId, "brokerBeta");
```
The projection `originBrokerId="brokerBeta"` confirms the origin row comes from brokerBeta, and `brokerOfRecordId="brokerAlpha"` confirms brokerAlpha is the parent broker of record.

### Leg 2: brokerAlpha receives the cross-broker projection

The brokerBeta bridge relays the projection to brokerAlpha via `relayTerminalProjection` callback. The relay status is tracked as `succeeded`.

**Test:** `test/operator-event-bridge.test.mjs` — `"operator bridge relays cross-broker Terminal Brief projections"`
**Evidence (line 3822, 3736–3740):**
```
assert.equal(relayed.length, 1, "expected child projection relay");
assert.equal(state.operator.terminalOutbox.crossBrokerRelay.status, "succeeded");
assert.equal(state.operator.terminalOutbox.crossBrokerRelay.relayed, 1);
assert.equal(state.operator.terminalOutbox.crossBrokerRelay.receiptGate.providerGatewaySendSuccess, "not_ack_evidence");
```

Related relay tests:

- `tests/operator-event-bridge-terminal-outbox-relay-success.test.ts` — "suppresses duplicate child-local operator notification after successful parent relay" — confirms exactly one projection is relayed, `originBrokerId="brokerBeta"`, `brokerOfRecordId="brokerAlpha"`.
- `tests/operator-event-bridge-terminal-outbox-relay-failure.test.ts` — exhausts retries without notifying locally at brokerBeta.
- `test/operator-event-bridge.test.mjs` — `"operator bridge relays only fresh post-cursor cross-broker terminal outbox projections"` — stale/old projections are skipped (line 3738: `relayed=1, skipped=1`).

### Leg 3: brokerAlpha generates synthetic Terminal Brief

The brokerAlpha (parent) side operator event bridge receives the relayed event (as a terminal-outbox row with `crossBrokerHandoff` where `handoffBrokerId="brokerBeta"` and `originBrokerId="brokerAlpha"`). Because brokerAlpha owns the notification (`handoffBrokerId="brokerAlpha"` matches the local broker), brokerAlpha generates a synthetic Terminal Brief.

**Test:** `test/operator-event-bridge.test.mjs` — `"operator bridge notifies parent-side synthetic cross-broker Terminal Briefs locally"`
**Evidence (lines 4211–4217):**
```
assert.equal(sent.length, 1, "expected parent-side synthetic Brief notification");
assert.equal(sent[0].taskId, "child-1");
assert.equal(sent[0].runId, "parent-brokerAlpha");
assert.equal(relayed.length, 0, "parent synthetic cross-broker event must not be relayed back");
```

### Leg 4: brokerAlpha operator-facing ACK

When the brokerAlpha-side `notifyOperator` returns a current-session-visible receipt, the brokerAlpha bridge ACKs the terminal-outbox at the broker with `operator_visible` evidence.

**Test:** `test/operator-event-bridge.test.mjs` — `"operator bridge notifies parent-side synthetic cross-broker Terminal Briefs locally"`
**Evidence (lines 4215–4217):**
```
assert.equal(acks.length, 1, "expected parent-side synthetic Brief ACK");
assert.equal(acks[0].receipt.evidence, "operator_visible");
```

The ACK evidence `operator_visible` explicitly proves the brokerAlpha operator-facing ACK is for a **current-session-visible receipt**, not provider send acceptance.

### Leg 5: No brokerBeta local operator brief (suppression)

brokerBeta must suppress the local Telegram notification for parent-owned rows. Multiple tests verify this from different metadata shapes.

**Test 1:** `test/operator-event-bridge.test.mjs` — `"operator bridge relays cross-broker Terminal Brief projections"`
**Evidence (lines 3825–3826):**
```
assert.equal(sent.length, 0, "handoff broker must not send operator-facing Terminal Brief locally");
assert.equal(acks.length, 0, "handoff broker must not ACK local terminal outbox for parent-owned Brief visibility");
```

**Test 2:** `test/operator-event-bridge.test.mjs` — `"operator bridge suppresses child Terminal Briefs when parentOwnerBrokerId is the only ownership field"`
**Evidence (lines 3896–3897):**
```
assert.equal(sent.length, 0, "handoff broker must suppress local Brief when parentOwnerBrokerId points elsewhere");
assert.equal(acks.length, 0, "handoff broker must not ACK parent-owned Brief visibility");
```

**Test 3:** `test/operator-event-bridge.test.mjs` — `"operator bridge suppresses parent-broker-only child Briefs with explicit notification ownership"`
**Evidence (lines ~3970–3975):**
```
assert.equal(sent.length, 0, "handoff broker must not send parent-broker-only Terminal Brief locally");
assert.equal(acks.length, 0, "handoff broker must not ACK parent-broker-only visibility");
```

**Test 4:** `tests/operator-event-bridge-terminal-outbox-relay-success.test.ts` — "suppresses duplicate child-local operator notification after successful parent relay"
**Evidence:**
```
assert.equal(notifications.length, 0, "successful relay must suppress duplicate child-local notification");
assert.equal(acked.length, 0, "child broker must not ACK a parent-owned Terminal Brief after relay success");
```

### No-live cross-cutting proof

All cross-broker terminal projections carry `providerGatewaySendSuccess: "not_ack_evidence"` and `originTerminalAckEligible: false` — provider send success is never treated as operator ACK.

**Test:** `tests/cross-broker-terminal-relay.test.ts`
- `buildA2ACrossBrokerTerminalProjection` — 12 tests covering projection structure, receipt blocks, evidence preservation, summary clamping/redaction, parent-round metadata, and provider-vs-receipt separation.
- `getCrossBrokerTerminalReceiptGap` — 7 tests covering receipt gap projection for accepted, delivered, operator-visible, confirmed, and failed states. All always return `terminalAckEligible=false`.

**Test:** `tests/no-live-canary.test.ts` — 36 tests (6 groups):
1. Notification disabled → no send (6 tests)
2. Provider accepted-send ≠ operator-visible receipt (5 tests)
3. Operator-visible receipt required for ACK eligibility (5 tests)
4. ACK eligibility → gated on operator-visible receipt only (6 tests)
5. Canary round-trip: dry-run → Telegram projection → no live send (8 tests)
6. Receipt gap projection — provider send ≠ operator ACK (6 tests)

### Cross-broker relay failure safety

When relay to the parent broker fails, brokerBeta must not fall through to send a local brief instead.

**Test:** `tests/operator-event-bridge-terminal-outbox-relay-failure.test.ts`
Verifies that exhausted relay retries still suppress local notification. brokerBeta does not treat relay failure as permission to notify locally.

## Verification commands

From the repository root:

```bash
npm ci 2>/dev/null
npm run build
```

```bash
# Leg 1+2+5 — brokerBeta bridge relay + suppression
node --test test/operator-event-bridge.test.mjs --test-name-pattern "operator bridge relays cross-broker Terminal Brief projections"

# Leg 3+4 — brokerAlpha synthetic Brief generation + ACK
node --test test/operator-event-bridge.test.mjs --test-name-pattern "operator bridge notifies parent-side synthetic cross-broker Terminal Briefs locally"

# Leg 5 — Parent owner suppression variants
node --test test/operator-event-bridge.test.mjs --test-name-pattern "operator bridge suppresses"

# Cross-broker relay success (suppression after relay)
node --test tests/operator-event-bridge-terminal-outbox-relay-success.test.ts

# Cross-broker relay failure (no local brief fallthrough)
node --test tests/operator-event-bridge-terminal-outbox-relay-failure.test.ts

# Cross-broker terminal projection + receipt gap
node --test tests/cross-broker-terminal-relay.test.ts

# No-live canary harness (full receipt boundary proof)
node --test tests/no-live-canary.test.ts

# Terminal Brief receipt gate no-live proof
node --test tests/terminal-brief-receipt-gate-no-live-proof.test.ts
```

Expected: all tests pass (0 failures).

## Verification output

### Cross-broker relay suppression (operator-event-bridge.test.mjs)

Tests 54–60 cover the exact route. All pass.

```
ok 54 - operator bridge relays only fresh post-cursor cross-broker terminal outbox projections
ok 55 - operator bridge relays cross-broker child Terminal Briefs without local operator notification
ok 56 - operator bridge suppresses child Terminal Briefs when parentOwnerBrokerId is the only ownership field
ok 57 - operator bridge suppresses parent-broker-only child Briefs with explicit notification ownership
ok 58 - operator bridge sends parent-broker-only Briefs when local broker owns notification
ok 59 - operator bridge notifies local broker-owned Terminal Briefs when no handoff broker is configured
ok 60 - operator bridge notifies parent-side synthetic cross-broker Terminal Briefs locally
1..60
# tests 60
# pass 60
# fail 0
```

### Cross-broker relay success (operator-event-bridge-terminal-outbox-relay-success.test.ts)

```
ok 1 - operator event bridge terminal outbox cross-broker relay success
  > suppresses duplicate child-local operator notification after successful parent relay
1..1
# pass 1
```

### Cross-broker relay failure (operator-event-bridge-terminal-outbox-relay-failure.test.ts)

```
ok 1 - operator event bridge terminal outbox cross-broker relay failure
  > exhausts without local operator notification or ACK
1..1
# pass 1
```

### Cross-broker terminal projection + receipt gap (cross-broker-terminal-relay.test.ts)

Projection builder (12 tests) + receipt gap (7 tests) = 19 tests.

```
1..19
# pass 19
```

### No-live canary harness (no-live-canary.test.ts)

36 tests across 6 groups.

```
1..36
# pass 36
```

### Terminal Brief receipt gate no-live proof (terminal-brief-receipt-gate-no-live-proof.test.ts)

4 suite proofs (rehearsal, execution, projection, full chain).

```
ok 5 - Terminal Brief receipt/activation gate plugin no-live proof
1..5
# pass 5
```

### Summary

| Test file | Tests | Pass |
|---|---|---|
| `test/operator-event-bridge.test.mjs` | 60 | 60 |
| `tests/operator-event-bridge-terminal-outbox-relay-success.test.ts` | 1 | 1 |
| `tests/operator-event-bridge-terminal-outbox-relay-failure.test.ts` | 1 | 1 |
| `tests/cross-broker-terminal-relay.test.ts` | 19 | 19 |
| `tests/no-live-canary.test.ts` | 36 | 36 |
| `tests/terminal-brief-receipt-gate-no-live-proof.test.ts` | 5 | 5 |
| **Total** | **122** | **122** |

All 122 tests pass. No OpenClaw runtime/bootstrap context files leaked into the repo.

## Residual risks

1. **Synthetic Terminal Brief format not yet validated in cross-broker context.** The brokerAlpha-side test verifies that `notifyOperator` is called with `taskId` and `runId`, but does not assert the exact Terminal Brief title/body text for a brokerBeta-sourced cross-broker projection. The concise-brief runtime readiness doc (`docs/concise-brief-runtime-readiness.md`) covers title format for brokerBeta cross-broker projections in unit tests (`operator-terminal-notifier.test.ts` lines 846–908), but no integration test verifies the synthetic Brief text produced by the full bridge when processing a cross-broker row.

2. **brokerAlpha-side synthetic Brief acceptance evidence is test-harness only.** The `operator_visible` evidence in the test comes from a fake `notifyOperator` callback returning `{ ackTerminalEvent: true, confirmationSource: "current_session_visible" }`. In a real deployment, the brokerAlpha operator must actually see the message in their session. The test proves the *bridge logic* is correct (routing, suppression, ACK evidence), but end-to-end brokerAlpha operator-visible receipt requires a live OpenClaw runtime with `currentSessionVisible` capability.

3. **No cross-broker projection receipt format inspection on the brokerAlpha side.** The relay test asserts projection fields (`originBrokerId`, `brokerOfRecordId`, `parentRoundId`) but does not verify the full projection payload that brokerAlpha ingests. If the broker ingestion schema or parent bridge projection parser changes, the relayed projection may become unparseable at brokerAlpha without this test catching it.

4. **brokerBeta-configurable `handoffBrokerId` assumption.** The existing tests hard-code `handoffBrokerId: "brokerBeta"` or `handoffBrokerId: "brokerAlpha"`. If the handoff broker ID changes in production configuration, the suppression logic (`shouldSuppressLocalCrossBrokerTerminalNotification`) operates on `options.handoffBrokerId`, which is set from `operatorEvents.localBrokerId`. A misconfigured `localBrokerId` would cause suppression to fail open (brokerBeta would briefly notify locally before the relay). The no-live canary test tests the logic, not the config.

5. **brokerAlpha-side synthetic Brief dedupe.** The parent-side test at line 4145 creates one event and expects one notification. If the brokerAlpha bridge receives duplicate relayed events (e.g., from retry logic), dedupe behavior for synthetic Briefs is not tested in this specific route context.

6. **Cross-broker relay skip logging is trusted.** When the brokerBeta bridge skips historical/stale projections (`relayed=1, skipped=1`), it logs the skip reason but does not assert that the skipped row's metadata matches what an operator would expect during a backlog drain. In production, a stale parent-owned row that was *intended* to be relayed would be silently skipped.

## Related

- [`docs/operator-terminal-notification-receipts.md`](./operator-terminal-notification-receipts.md) — receipt policy including cross-broker parent-owned routing
- [`docs/concise-brief-runtime-readiness.md`](./concise-brief-runtime-readiness.md) — compact title format for brokerBeta cross-broker projections
- [`tests/no-live-canary.test.ts`](../tests/no-live-canary.test.ts) — general no-live receipt boundary proof
- [`tests/cross-broker-terminal-relay.test.ts`](../tests/cross-broker-terminal-relay.test.ts) — cross-broker projection builder + receipt gap
- [`tests/terminal-brief-receipt-gate-no-live-proof.test.ts`](../tests/terminal-brief-receipt-gate-no-live-proof.test.ts) — receipt gate plugin projection proof
