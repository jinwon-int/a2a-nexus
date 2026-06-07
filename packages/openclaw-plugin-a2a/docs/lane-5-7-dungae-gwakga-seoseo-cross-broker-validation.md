# Lane 5/7 — Dungae Gwakga→Seoseo Cross-Broker Validation

- **Run:** `a2a-terminal-brief-completion-20260523T015723Z`
- **Lane:** 5/7
- **Worker:** dungae (Team2)
- **Lane issue:** https://github.com/jinwon-int/openclaw-plugin-a2a/issues/441
- **Parent tracker:** https://github.com/jinwon-int/a2a-plane/issues/427

## Goal

Validate from the Gwakga/Team2 side that Seoseo-owned parent rounds keep Gwakga child/origin rows **evidence-only**, avoid Gwakga-local operator-facing duplicate Briefs, and confirm the **parent synthetic row** is the only operator-facing Terminal Brief candidate.

## Validation Summary

| Requirement | Status | Evidence |
|---|---|---|
| Gwakga child/origin rows stay evidence-only | ✅ Verified | Tests confirm no local operator notification or ACK for cross-broker parent-owned rows |
| No Gwakga-local operator-facing duplicate Briefs | ✅ Verified | Dedupe test confirms duplicate task IDs produce no extra operator-facing messages |
| Parent synthetic row is only operator-facing candidate | ✅ Verified | Seoseo-side test confirms synthetic Brief is delivered; Gwakga-side confirms suppression |
| All 122 existing cross-broker tests pass | ✅ Verified | 64 bridge tests + 56 projection/receipt tests + 2 canary tests all pass |

## Test Evidence

### 1. Gwakga child origin rows stay evidence-only

The Gwakga bridge detects Seoseo-owned parent rounds via `notificationOwnership.ownerBrokerId: "seoseo"`, `parentOwnedTerminalBrief: true`, and `crossBrokerHandoff.originBrokerId: "seoseo"`. The `shouldSuppressLocalCrossBrokerTerminalNotification` function suppresses the local operator notification.

Tests that verify this suppression:

- **`test/operator-event-bridge.test.mjs` — test 61** `"cross-broker suppresses child 1/1 operator Brief for Seoseo-owned parent round at Gwakga"`
  ```js
  assert.equal(sent.length, 0, "Gwakga must not send operator-facing Brief for child 1/1 owned by Seoseo");
  assert.equal(relayed.length, 1, "Gwakga must relay cross-broker projection to Seoseo for child 1/1");
  assert.equal(acks.length, 0, "Gwakga must not ACK terminal outbox for Seoseo-owned Brief visibility");
  ```

- **`test/operator-event-bridge.test.mjs` — test 62** `"cross-broker suppresses child 1/2 operator Brief for Seoseo-owned parent round at Gwakga"`
  Same assertions for a 1-of-2 round scenario, confirming partial rounds are also suppressed.

- **`test/operator-event-bridge.test.mjs` — test 55** `"operator bridge relays cross-broker child Terminal Briefs without local operator notification"`
  ```js
  assert.equal(sent.length, 0, "handoff broker must not send operator-facing Terminal Brief locally");
  assert.equal(acks.length, 0, "handoff broker must not ACK local terminal outbox for parent-owned Brief visibility");
  ```

- **`test/operator-event-bridge.test.mjs` — tests 56, 57** Suppression variants for `parentOwnerBrokerId` alone and `notificationOwnership` scope.

- **`tests/operator-event-bridge-terminal-outbox-relay-success.test.ts`** — confirms relay stops local notification after successful relay.

- **`tests/operator-event-bridge-terminal-outbox-relay-failure.test.ts`** — confirms relay exhaustion does NOT fall through to local notification.

### 2. No duplicate operator-facing Briefs

- **`test/operator-event-bridge.test.mjs` — test 63** `"cross-broker dedupe via taskNotificationKey prevents duplicate visible sends for repeated projection"`
  ```js
  assert.equal(sent.length, 0, "Gwakga must not send operator-facing Brief for dedupe test (Seoseo-owned)");
  assert.equal(relayed.length, 2, "both original and duplicate relay projections should be forwarded");
  ```

### 3. Parent synthetic row is the operator-facing candidate

- **`test/operator-event-bridge.test.mjs` — test 60** `"operator bridge notifies parent-side synthetic cross-broker Terminal Briefs locally"`
  At the Seoseo bridge, the synthetic event (id starting with `terminal:cross-broker`) bypasses suppression and generates an operator-facing notification.

  ```js
  assert.equal(sent[0].taskId, "child-1");
  assert.equal(sent[0].runId, "parent-seoseo");
  assert.equal(relayed.length, 0, "parent synthetic cross-broker event must not be relayed back");
  ```

- **`test/operator-event-bridge.test.mjs` — test 64** `"cross-broker parent-side synthetic Seoseo operator Brief has correct title scoped to parent round"`
  Verifies the Seoseo-side synthetic Brief title contains the parent round order context (`1/2`), not a misleading `1/1`.

  ```js
  assert.ok(sent[0].title.includes("1/2") || sent[0].title.includes("완료"),
    `synthetic brief title "${sent[0].title}" must contain parent round order context`);
  ```

### 4. Projection integrity (Gwakga → Seoseo relay format)

- **`tests/cross-broker-terminal-relay.test.ts`** — 19 tests covering projection structure, receipt blocks, evidence preservation, summary redaction, metadata nesting, parent-round context, and `parentRoundOrder`/`parentRoundTotal` propagation.
- **`tests/no-live-canary.test.ts`** — 36 tests covering receipt boundary gating.
- **`tests/terminal-brief-receipt-gate-no-live-proof.test.ts`** — 5 tests covering the full rehearsal/plan/projection chain.

All 56 projection + receipt tests pass (0 failures).

### 5. Full operator event bridge cross-broker tests

```text
ok 54 - operator bridge relays only fresh post-cursor cross-broker terminal outbox projections
ok 55 - operator bridge relays cross-broker child Terminal Briefs without local operator notification
ok 56 - operator bridge suppresses child Terminal Briefs when parentOwnerBrokerId is the only ownership field
ok 57 - operator bridge suppresses parent-broker-only child Briefs with explicit notification ownership
ok 58 - operator bridge sends parent-broker-only Briefs when local broker owns notification
ok 59 - operator bridge notifies local broker-owned Terminal Briefs when no handoff broker is configured
ok 60 - operator bridge notifies parent-side synthetic cross-broker Terminal Briefs locally
ok 61 - cross-broker suppresses child 1/1 operator Brief for Seoseo-owned parent round at Gwakga
ok 62 - cross-broker suppresses child 1/2 operator Brief for Seoseo-owned parent round at Gwakga
ok 63 - cross-broker dedupe via taskNotificationKey prevents duplicate visible sends for repeated projection
ok 64 - cross-broker parent-side synthetic Seoseo operator Brief has correct title scoped to parent round
```

## Residual Risks (Lane 5/7 perspective)

These risks are acknowledged but are **outside the Gwakga/Team2 scope** of this lane — they belong to the Seoseo/parent side or are shared cross-cutting concerns documented in the parent validation doc:

1. **Seoseo-side synthetic Brief acceptance evidence is test-harness only** — The Seoseo operator-facing `operator_visible` receipt comes from a fake `notifyOperator` callback. End-to-end Seoseo operator visibility requires a live OpenClaw runtime. (Seoseo scope.)

2. **No cross-broker projection receipt format inspection on the Seoseo side** — The projection payload that Seoseo ingests is tested for field types but a full schema inspection on the Seoseo ingestion side is not done in this repo. (Seoseo scope.)

3. **Gwakga-configurable `handoffBrokerId` assumption** — Suppression depends on `handoffBrokerId` matching `operatorEvents.localBrokerId`. A misconfigured `localBrokerId` would cause suppression to fail open. This is documented in `docs/gwakga-seoseo-cross-broker-no-live-validation.md`.

4. **Cross-broker relay skip logging** — Historical/stale projections are silently skipped; the log is trusted. In production, an operator should verify backlog during drain.

## Approval-Sensitive Blockers

None from the Gwakga/Team2 side. The suppression logic is correct and comprehensively tested:

- `shouldSuppressLocalCrossBrokerTerminalNotification` in `src/operator-event-bridge.ts` (line 1173) correctly gates on `isParentBrokerOnlyTerminalPayload`, `isTerminalPayloadOwnedByLocalBroker`, and the presence of cross-broker handoff metadata.
- `shouldSuppressLocalNotificationForCrossBrokerHandoff` (line 1000) correctly preserves parent-owned suppression even when the relay fails.
- `isParentSyntheticCrossBrokerTerminalEvent` (line 994) ensures Seoseo-side synthetic events (id starting with `terminal:cross-broker`) bypass suppression.
- `buildA2ACrossBrokerTerminalProjection` in `src/cross-broker-terminal-relay.ts` correctly maps `parentRoundOrder`/`parentRoundTotal` and generates the `terminalBriefTitle` for parent relay.
- `isParentOwnedTerminalPayload` (line 278) correctly identifies parent-owned payloads via scope, owner, and broker ID comparisons.

## Changed Files (this lane)

- `docs/lane-5-7-dungae-gwakga-seoseo-cross-broker-validation.md` — this validation evidence document.

## Recommendation

**Done** from the Gwakga/Team2 side. The codebase correctly:
1. Keeps Seoseo-owned parent round Gwakga child/origin rows as evidence-only (suppressed, relayed, not notified locally)
2. Avoids duplicate operator-facing Briefs at Gwakga via `taskNotificationKey` deduplication
3. Confirms the Seoseo parent synthetic row as the only operator-facing Terminal Brief candidate

Seoseo can proceed with finalization of this round as broker/finalizer of record.
