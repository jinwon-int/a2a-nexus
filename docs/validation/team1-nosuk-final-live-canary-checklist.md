# Final Approval-Gated Live Canary Checklist

**Team1/nosuk — Lane 3/7**

Parent tracker: <https://github.com/jinwon-int/a2a-plane/issues/427>
Lane issue: <https://github.com/jinwon-int/a2a-plane/issues/428>
Run: `a2a-terminal-brief-completion-20260523T015723Z`
Worker: `nosuk`
Team: `team1`
Parent broker/finalizer of record: `seoseo`
Team2 handoff broker: `gwakga`
Snapshot: `2026-05-23T02:02Z`

---

## Purpose

This document is the final approval-gated live canary checklist. It defines the exact plan, pass/fail assertions, cursor rules, rollback/stop points, and evidence fields for each of the four live canary paths that must be ready before a Seoseo operator can authorize a live Terminal Brief canary.

This is a **validation/spec artifact only**. It does not execute, authorize, or deploy any live canary. It does not restart Gateway/broker/worker services, send live provider messages, mutate production DB or terminal-outbox ACK rows, perform terminal brief ACK/replay or historical outbox replay, change secrets or repository visibility, publish releases, rewrite history, or execute approval.

---

## Four-Path Coverage Matrix

| # | Path | Direction | Broker initiator | Broker receiver | Cursor source | Canary preflight scope | Rollback scope |
|---|------|-----------|-----------------|-----------------|---------------|------------------------|----------------|
| P1 | Team1 local | Seoseo → Seoseo-local child | `seoseo` | `seoseo` (self) | Team1 terminal outbox, `seoseo` cursor ledger | Preflight, poll, cleanup | Metadata-only projection rollback |
| P2 | Team2 local | Gwakga → Gwakga-local child | `gwakga` | `gwakga` (self) | Team2 terminal outbox, `gwakga` cursor ledger | Preflight, poll, cleanup | Metadata-only projection rollback |
| P3 | Seoseo-parent→Gwakga-child | Seoseo(parent) → Gwakga(child) | `seoseo` | `gwakga` | Seoseo parent outbox projection; Gwakga child receipt cursor | Cross-broker preflight, relay poll, cleanup | Projection revocation; child evidence blocked; parent projection set to `blocked` |
| P4 | Gwakga-parent→Seoseo-child (reverse, optional) | Gwakga(parent) → Seoseo(child) | `gwakga` | `seoseo` | Gwakga parent outbox projection; Seoseo child receipt cursor | Cross-broker preflight, relay poll, cleanup | Same as P3; add `parentRoundOriginCheck` to avoid routing conflict with Seoseo-origin rounds |

### P1 — Team1 local live canary

**Scope:** One Team1 child broker (`seoseo`) sending a Terminal Brief notification to an operator through the local Telegram/DM channel. The canary covers the preflight/poll/receipt/cleanup lifecycle defined in `docs/specs/a2a-terminal-brief-canary/spec.md` — only for the Team1 local path.

**Cursor selection:**
- Cursor source: Team1 broker terminal outbox (`seoseo` cursor ledger).
- Selection rule: latest timestamp wins; all earlier candidates are stale.
- If cursor candidates are empty → fail closed; visible error; poller not started.

**Pass/fail assertions:**

| # | Assertion | Preflight/Poll/Cleanup | Pass condition | Fail condition |
|---|-----------|------------------------|----------------|----------------|
| T1-1 | Cursor is latest | Preflight before each poll cycle | Selected cursor matches latest outbox entry | Stale cursor selected; replayed cursor triggers duplicate evidence |
| T1-2 | Task not already terminal | Preflight | Task state is `active`/`running`/`claimed` | Task is `done`/`cancelled`/`failed` → poller NOT started; visible error |
| T1-3 | Config shape normalization | Preflight | Object-backed config normalizes to canonical array form | Unrecognized shape → visible error; poller not started |
| T1-4 | `sessionKey` present on all monitor calls | Preflight + Poll | Every `a2a.monitor.status` call includes explicit non-empty `sessionKey` | Missing/empty `sessionKey` → visible error; never silent empty state |
| T1-5 | Backlog suppression for active task | Poll | `backlogCount` correctly reflects pending entries | False backlog suppression (backlog clear when task complete but poller still running) |
| T1-6 | Mid-poll terminal detection stops poller | Poll | Terminal state detected within 1 poll cycle → poller stops | Poller continues beyond 1 cycle after terminal transition |
| T1-7 | Evidence is redacted | Receipt + Cleanup | `sessionKey` presence logged as `sessionKey: <present>`, never raw value; no secrets, host paths, bootstrap files in output | Raw session key, secret, host path, or bootstrap file path in evidence |
| T1-8 | `operatorEvents` restored on exit | Cleanup (all exit paths) | `operatorEvents` restored to `{"enabled": false}` on success, error, and interrupt | `operatorEvents` left as `{"enabled": true}` on any exit path |

**Rollback/stop points:**

| Stop point | Condition | Action | Approval needed? |
|------------|-----------|--------|-----------------|
| S1-1 | Preflight fails any T1-1 through T1-4 | Poller not started; metadata-only projection emitted with state `blocked`; no provider send | No (automatic) |
| S1-2 | Mid-poll terminal detected (T1-6) | Poller stopped; evidence redacted; `operatorEvents` restored | No (automatic) |
| S1-3 | Cleanup fails (T1-8) | Visible error emitted; Gateway `operatorEvents` may be stuck at `true`; operator must manually restore | Yes — operator must manually verify and restore |
| S1-4 | Evidence unredacted (T1-7) | Block evidence; do not publish PR/Done; operator must redact or reprocess | Yes — fresh evidence required |

**Exact evidence fields (P1):**

```json
{
  "pathId": "P1",
  "pathName": "Team1 local live canary",
  "brokerInitiator": "seoseo",
  "brokerReceiver": "seoseo",
  "cursorSource": "seoseo-cursor-ledger",
  "latestCursorId": "<cursor-id>",
  "staleCursorsRejected": <count>,
  "taskState": "active | running | terminal (NOT started)",
  "configShape": "object | array | invalid",
  "configNormalized": true | false,
  "sessionKeyPresent": true,
  "pollerStarted": true | false,
  "backlogSuppressionSignal": false,
  "midPollTerminalDetected": true | false,
  "pollerStoppedWithinOneCycle": true | false | "N/A",
  "operatorEventsRestored": true | false | "N/A",
  "restoredValue": { "enabled": false },
  "exitPath": "success | error | interrupt",
  "liveProviderSend": false,
  "terminalOutboxAckMutated": false,
  "isApproval": false,
  "isTerminalAck": false,
  "isReadReceipt": false,
  "rollbackTriggered": false,
  "rollbackType": "N/A"
}
```

---

### P2 — Team2 local live canary

**Scope:** One Team2 child broker (`gwakga`) sending a Terminal Brief notification to a Team2 operator through the local Telegram/DM channel. The canary covers the same preflight/poll/receipt/cleanup lifecycle as P1, adapted for the Team2 broker infrastructure.

**Cursor selection:**
- Cursor source: Team2 broker terminal outbox (`gwakga` cursor ledger).
- Selection rule: latest timestamp wins; all earlier candidates are stale.
- If cursor candidates are empty → fail closed; visible error; poller not started.
- Team2 cursor must respect the same monotonic advancement rule as Team1.

**Pass/fail assertions:**

| # | Assertion | Preflight/Poll/Cleanup | Pass condition | Fail condition |
|---|-----------|------------------------|----------------|----------------|
| T2-1 | Cursor is latest (Team2 ledger) | Preflight before each poll cycle | Selected cursor matches latest Team2 outbox entry | Stale cursor selected; replayed cursor triggers duplicate evidence |
| T2-2 | Task not already terminal | Preflight | Task state is `active`/`running`/`claimed` | Task is `done`/`cancelled`/`failed` → poller NOT started; visible error |
| T2-3 | Config shape normalization (Team2) | Preflight | Object-backed config normalizes to canonical form | Unrecognized shape → visible error |
| T2-4 | `sessionKey` present (Team2) | Preflight + Poll | Every Team2 monitor call includes explicit non-empty `sessionKey` | Missing/empty `sessionKey` → visible error |
| T2-5 | No local aggregate for parent-owned rows | Preflight | Team2 knows the row is parent-owned (origin broker `seoseo`) → suppresses local `1/1` or `1/2` brief | Team2 emits `A2A Terminal Brief 완료: dungae(1/1)` or equivalent local aggregate for parent-owned rows |
| T2-6 | Mid-poll terminal detection | Poll | Terminal state detected within 1 poll cycle → poller stops | Poller continues beyond 1 cycle |
| T2-7 | Evidence is redacted (Team2) | Receipt + Cleanup | No secrets, host paths, bootstrap files | Raw sensitive data in evidence |
| T2-8 | `operatorEvents` restored (Team2) | Cleanup | Restored to `{"enabled": false}` | Left as `{"enabled": true}` |

**Rollback/stop points:**

| Stop point | Condition | Action | Approval needed? |
|------------|-----------|--------|-----------------|
| S2-1 | Preflight fails any T2-1 through T2-5 | Poller not started; projection blocked | No (automatic) |
| S2-2 | Team2 emits local aggregate for parent-owned row (T2-5) | Immediate stop; projection blocked; parent broker alerted | Yes — Seoseo must verify cross-broker suppression |
| S2-3 | Mid-poll terminal | Poller stopped; evidence redacted | No (automatic) |
| S2-4 | Cleanup fails | Operator must manually restore `operatorEvents` | Yes |
| S2-5 | Evidence unredacted | Block evidence; do not publish | Yes |

**Exact evidence fields (P2):**

```json
{
  "pathId": "P2",
  "pathName": "Team2 local live canary",
  "brokerInitiator": "gwakga",
  "brokerReceiver": "gwakga",
  "cursorSource": "gwakga-cursor-ledger",
  "latestCursorId": "<cursor-id>",
  "staleCursorsRejected": <count>,
  "taskState": "active | running | terminal (NOT started)",
  "configShape": "object | array | invalid",
  "configNormalized": true | false,
  "sessionKeyPresent": true,
  "pollerStarted": true | false,
  "localAggregateSuppressed": true | false | "N/A",
  "parentRoundOriginCheckPassed": true | false,
  "backlogSuppressionSignal": false,
  "midPollTerminalDetected": true | false,
  "pollerStoppedWithinOneCycle": true | false | "N/A",
  "operatorEventsRestored": true | false | "N/A",
  "restoredValue": { "enabled": false },
  "exitPath": "success | error | interrupt",
  "liveProviderSend": false,
  "terminalOutboxAckMutated": false,
  "isApproval": false,
  "isTerminalAck": false,
  "isReadReceipt": false,
  "rollbackTriggered": false,
  "rollbackType": "N/A"
}
```

---

### P3 — Seoseo-parent-to-Gwakga-child live canary

**Scope:** Seoseo (parent broker) sends a cross-broker Terminal Brief notification to a Gwakga (handoff child broker). This path validates the parent-to-child handoff protocol (`contracts/a2a/broker-handoff-protocol.md`) and the cross-broker cursor/inbox lifecycle.

**Cursor selection:**
- Parent cursor source: Seoseo parent terminal outbox projection ledger (`seoseo` cursor ledger).
- Child relay cursor source: Gwakga child receipt inbox (`gwakga` handoff receipt cursor).
- Selection rules:
  - Parent cursor: latest projection entry wins.
  - Child cursor: latest handoff receipt entry wins.
  - Parent cursor drives `openclaw_outbound_lifecycle` dispatch to child.
  - Child cursor drives child-initiated relay to parent (evidence projection).
- Both cursors must advance monotonically and independently.

**Pass/fail assertions:**

| # | Assertion | Phase | Pass condition | Fail condition |
|---|-----------|-------|----------------|----------------|
| T3-1 | Parent cursor is latest (Seoseo projection ledger) | Parent preflight | Selected cursor matches latest parent projection | Stale parent cursor → blocked |
| T3-2 | Child relay cursor is latest (Gwakga receipt ledger) | Child preflight | Selected cursor matches latest Gwakga receipt | Stale child cursor → blocked |
| T3-3 | Parent projection has `crossBrokerHandoff` metadata | Parent preflight | `crossBrokerHandoff.originParentBrokerId` = `seoseo` | Missing handoff metadata → fail-closed |
| T3-4 | Gwakga child knows it is not the origin broker | Child preflight | `originBrokerId` = `seoseo`; Gwakga does not claim ownership | Gwakga rewrites `originBrokerId` to `gwakga` |
| T3-5 | Gwakga does not emit local aggregate | Child preflight + Poll | Parent-owned rows suppressed; `brokerOfRecord` respects handoff | Local `1/1` or `1/2` brief from Gwakga |
| T3-6 | Parent projection redacted before dispatch | Parent evidence | No secrets, host paths, raw session dumps, bootstrap files | Unredacted parent projection reaches child |
| T3-7 | Child relay redacted before parent projection | Child evidence | No secrets, host paths, raw session dumps, bootstrap files | Unredacted child relay reaches parent |
| T3-8 | `operatorEvents` restored on both brokers | Cleanup (both sides) | Both Seoseo and Gwakga restore `{"enabled": false}` | Either broker leaves `operatorEvents` enabled |
| T3-9 | No duplicate parent projection | Idempotency check | Same `projectionKey` → returns existing projection; `newProjectionCreated` = `false` | Duplicate projection or conflict |

**Rollback/stop points:**

| Stop point | Condition | Action | Approval needed? |
|------------|-----------|--------|-----------------|
| S3-1 | Parent preflight fails (T3-1, T3-3, T3-6) | Parent projection blocked; no dispatch to child | No (automatic) |
| S3-2 | Child preflight fails (T3-2, T3-4, T3-5) | Child relay blocked; parent alert | Yes — Seoseo must verify child broker state |
| S3-3 | Child emits local aggregate (T3-5) | Immediate stop; parent alerted; projection set to `blocked` | Yes — Seoseo must verify cross-broker suppression |
| S3-4 | Unredacted projection in either direction (T3-6, T3-7) | Block evidence; do not publish; operator must reprocess | Yes |
| S3-5 | `operatorEvents` not restored on either broker (T3-8) | Visible error; operator must manually restore | Yes |
| S3-6 | `projectionKey` conflict (T3-9) | `conflict` state; operator must resolve payload mismatch | Yes |

**Exact evidence fields (P3):**

```json
{
  "pathId": "P3",
  "pathName": "Seoseo-parent-to-Gwakga-child live canary",
  "brokerInitiator": "seoseo",
  "brokerReceiver": "gwakga",
  "parentCursorSource": "seoseo-projection-ledger",
  "parentLatestCursorId": "<cursor-id>",
  "parentStaleCursorsRejected": <count>,
  "childCursorSource": "gwakga-handoff-receipt-ledger",
  "childLatestCursorId": "<cursor-id>",
  "childStaleCursorsRejected": <count>,
  "parentProjectionMetadata": {
    "parentRoundId": "<round-id>",
    "originBrokerId": "seoseo",
    "crossBrokerHandoff": {
      "originParentBrokerId": "seoseo"
    }
  },
  "gwakgaLocalAggregateSuppressed": true | false,
  "parentProjectionRedacted": true,
  "childRelayRedacted": true,
  "operatorEventsRestoredSeoseo": true | false | "N/A",
  "operatorEventsRestoredGwakga": true | false | "N/A",
  "projectionKey": "<key>",
  "projectionConflict": false,
  "duplicateSuppressed": true | false | "N/A",
  "liveProviderSend": false,
  "terminalOutboxAckMutated": false,
  "isApproval": false,
  "isTerminalAck": false,
  "isReadReceipt": false,
  "rollbackTriggered": false,
  "rollbackType": "N/A"
}
```

---

### P4 — Gwakga-parent-to-Seoseo-child live canary (reverse, optional)

**Scope:** Gwakga acts as parent broker and sends a cross-broker Terminal Brief notification to Seoseo as handoff child. This is the inverse of P3. It is **optional** — it must only be activated when a Gwakga-origin parent round exists and the `parentRoundOriginCheck` passes.

**Why optional:** The current Terminal Brief round is Seoseo-origin. A reverse Gwakga-parent-to-Seoseo-child canary is not required for this closeout round, but the checklist must be prepared for future rounds where Gwakga is the origin broker.

**Cursor selection:**
- Parent cursor source: Gwakga parent terminal outbox projection ledger.
- Child relay cursor source: Seoseo child receipt inbox.
- Selection rules: same monotonic advancement as P3, reversed.
- Additional check: `parentRoundOriginCheck` must confirm the parent round is Gwakga-origin before proceeding.

**Pass/fail assertions:**

| # | Assertion | Phase | Pass condition | Fail condition |
|---|-----------|-------|----------------|----------------|
| T4-1 | Parent cursor is latest (Gwakga projection ledger) | Parent preflight | Selected cursor matches latest Gwakga projection | Stale parent cursor → blocked |
| T4-2 | Child relay cursor is latest (Seoseo receipt ledger) | Child preflight | Selected cursor matches latest Seoseo receipt | Stale child cursor → blocked |
| T4-3 | `parentRoundOriginCheck`: Gwakga is origin broker | Gateway preflight | `originBrokerId` = `gwakga` | `originBrokerId` ≠ `gwakga` → do not proceed; this is a Seoseo-origin round |
| T4-4 | Seoseo child knows it is not the origin broker | Child preflight | `originBrokerId` = `gwakga`; Seoseo does not rewrite it | Seoseo rewrites `originBrokerId` to `seoseo` |
| T4-5 | Seoseo does not emit local aggregate for parent-owned rows | Child preflight | Parent-owned rows suppressed | Local aggregate from Seoseo for Gwakga-owned rows |
| T4-6 | Parent projection redacted before dispatch | Parent evidence | No secrets, host paths, bootstrap files | Unredacted projection |
| T4-7 | Child relay redacted | Child evidence | No secrets, host paths, bootstrap files | Unredacted relay |
| T4-8 | `operatorEvents` restored on both brokers | Cleanup | Both brokers restore `{"enabled": false}` | Either broker leaves it enabled |
| T4-9 | No duplicate parent projection | Idempotency | Same `projectionKey` → existing projection returned | Duplicate or conflict |

**Rollback/stop points:**

| Stop point | Condition | Action | Approval needed? |
|------------|-----------|--------|-----------------|
| S4-1 | `parentRoundOriginCheck` fails (T4-3) | Canary not started; projection blocked; message: "Gwakga is not origin broker; check P3 instead" | No (automatic) |
| S4-2 | Parent preflight fails (T4-1, T4-6) | Parent projection blocked | No (automatic) |
| S4-3 | Child preflight fails (T4-2, T4-4, T4-5, T4-7) | Child relay blocked; parent alert | Yes |
| S4-4 | Seoseo emits local aggregate for Gwakga-owned rows (T4-5) | Immediate stop; parent alerted | Yes |
| S4-5 | `operatorEvents` not restored (T4-8) | Visible error; operator must manually restore | Yes |
| S4-6 | `projectionKey` conflict (T4-9) | `conflict` state; operator must resolve | Yes |

**Exact evidence fields (P4):**

```json
{
  "pathId": "P4",
  "pathName": "Gwakga-parent-to-Seoseo-child live canary (reverse, optional)",
  "brokerInitiator": "gwakga",
  "brokerReceiver": "seoseo",
  "parentCursorSource": "gwakga-projection-ledger",
  "parentLatestCursorId": "<cursor-id>",
  "parentStaleCursorsRejected": <count>,
  "childCursorSource": "seoseo-handoff-receipt-ledger",
  "childLatestCursorId": "<cursor-id>",
  "childStaleCursorsRejected": <count>,
  "parentRoundOriginCheckPassed": true | false,
  "originBrokerId": "gwakga",
  "seoseoLocalAggregateSuppressed": true | false | "N/A",
  "parentProjectionRedacted": true,
  "childRelayRedacted": true,
  "operatorEventsRestoredGwakga": true | false | "N/A",
  "operatorEventsRestoredSeoseo": true | false | "N/A",
  "projectionKey": "<key>",
  "projectionConflict": false,
  "duplicateSuppressed": true | false | "N/A",
  "liveProviderSend": false,
  "terminalOutboxAckMutated": false,
  "isApproval": false,
  "isTerminalAck": false,
  "isReadReceipt": false,
  "rollbackTriggered": false,
  "rollbackType": "N/A"
}
```

---

## Cross-Path Validation Matrix

| Check | P1 | P2 | P3 | P4 |
|-------|----|----|----|----|
| Cursor monotonicity enforced | ✅ T1-1 | ✅ T2-1 | ✅ T3-1, T3-2 | ✅ T4-1, T4-2 |
| Preflight checks terminal state | ✅ T1-2 | ✅ T2-2 | ✅ T3-3, T3-4 | ✅ T4-3, T4-4 |
| Config shape normalization | ✅ T1-3 | ✅ T2-3 | N/A (cross-broker) | N/A (cross-broker) |
| `sessionKey` requirement | ✅ T1-4 | ✅ T2-4 | N/A (broker-initiated) | N/A (broker-initiated) |
| No local aggregate for parent-owned rows | N/A (Seoseo is parent) | ✅ T2-5 | ✅ T3-5 | ✅ T4-5 |
| Mid-poll terminal detection | ✅ T1-6 | ✅ T2-6 | N/A (relay model) | N/A (relay model) |
| Redacted evidence | ✅ T1-7 | ✅ T2-7 | ✅ T3-6, T3-7 | ✅ T4-6, T4-7 |
| `operatorEvents` restore | ✅ T1-8 | ✅ T2-8 | ✅ T3-8 | ✅ T4-8 |
| Idempotency projection | N/A (local) | N/A (local) | ✅ T3-9 | ✅ T4-9 |
| `parentRoundOriginCheck` | N/A | N/A | N/A (Seoseo is parent) | ✅ T4-3 |

---

## Pre-Flight Checklist (Required Before Any Live Canary)

- [ ] All 7 lanes of round `a2a-terminal-brief-completion-20260523T015723Z` have posted terminal evidence (PR/Done/Block), and the parent round closeout go/no-go matrix returns GO.
- [ ] The five hardening gaps from `docs/specs/a2a-terminal-brief-canary/spec.md` are covered by acceptance fixtures and pass conformance.
- [ ] `sessionKey` requirement is enforced in the canary preflight code (gap 2).
- [ ] Config shape normalization handles both object-backed and array-backed forms (gap 3).
- [ ] Cursor selection always picks the latest terminal outbox cursor (gap 4).
- [ ] `operatorEvents` restore is implemented on both success and failure exit paths (gap 5).
- [ ] Cross-broker handoff metadata (`originBrokerId`, `parentRoundId`, `crossBrokerHandoff`) is present in every projection for P3/P4.
- [ ] Gwakga suppression of local `1/1`/`1/2` briefs is implemented for Team2 rows (P2, P3).
- [ ] `parentRoundOriginCheck` is implemented for the reverse path (P4).
- [ ] Runtime/bootstrap hygiene scan passes: no `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` in branch diff or evidence.
- [ ] Seoseo operator has provided fresh explicit approval for the live canary execution scope.

---

## Approval Gate Requirements

The live canary is **NOT authorized** unless:

1. **All pre-flight items above are completed.**
2. **Seoseo** (parent broker/finalizer of record) separately renders and sends the aggregate parent-round Terminal Brief — this checklist does not authorize that send.
3. **Fresh explicit operator approval** is given for the exact canary path (P1, P2, P3, and/or P4), including which broker(s) and which cursor ledger(s) are involved.
4. **Provider accepted/message-id evidence** remains accepted-send telemetry only — never read/visibility/Terminal ACK. No terminal-outbox ACK mutation occurs.
5. **No production deploy, Gateway/broker/worker restart, DB mutation, force-push, release, or visibility change** is performed as part of this canary; those require separate operator approval.

---

## Safety Confirmation

This lane:

- **Did not deploy or restart** any Gateway, broker, or worker service.
- **Did not mutate production databases** or terminal-outbox ACK rows.
- **Did not send any live provider or Telegram message** beyond normal A2A task completion notifications.
- **Did not perform manual Terminal Brief ACK/replay or historical outbox replay.**
- **Did not change secrets, repository visibility, or release state.**
- **Did not rewrite history or force-push.**
- **Did not execute approval** without fresh explicit operator approval.
- **Provider accepted/message-id evidence** is provider-accepted evidence only — never read/visibility/terminal ACK.
- **Confirmed runtime/bootstrap hygiene:** `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**` are absent from branch diff and artifact evidence.
- **Seoseo remains parent broker/finalizer of record** for this completion round.

---

## Reference Map

| Artifact | Path | Purpose |
|----------|------|---------|
| This checklist | `docs/validation/team1-nosuk-final-live-canary-checklist.md` | Final approval-gated live canary plan with cursors, pass/fail assertions, rollback/stop points, and evidence fields |
| Canary protocol spec | `docs/specs/a2a-terminal-brief-canary/spec.md` | Terminal Brief live-canary protocol and five hardening gaps |
| Canary acceptance fixture | `fixtures/contract/terminal-brief-canary-acceptance.json` | Frozen assertions for the five hardening gaps |
| Canary acceptance test | `test/conformance/check-terminal-brief-canary-acceptance.mjs` | Validates fixture against spec acceptance criteria |
| Canary acceptance template | `test/conformance/check-contract-fixtures.mjs` | Validates all contract fixtures for hygiene |
| Ownership canary | `docs/validation/team1-nosuk-terminal-brief-ownership-canary.md` | Parent broker ownership and Team2 child suppression matrix |
| Parent aggregation checklist | `docs/validation/parent-terminal-brief-aggregation-checklist.md` | Parent-round aggregation evidence checklist |
| Closeout go/nogo matrix | `fixtures/contract/parent-round-closeout-go-nogo-matrix.json` | Parent-round closeout go/no-go matrix fixture |
| Closeout go/nogo validator | `scripts/check-parent-round-closeout-go-nogo-matrix.mjs` | Validates go/no-go decisions for parent-round closeout |
| Routing contract | `packages/broker/src/core/terminal-brief-routing-contract.ts` | Broker-side routing guard for Terminal Brief transports |
| Handoff protocol | `contracts/a2a/broker-handoff-protocol.md` | Cross-broker handoff metadata and projection rules |
| Terminal semantics | `contracts/a2a/terminal-semantics.md` | Receipt levels and ACK boundaries |
| Parent issue | `a2a-plane#427` | Parent tracker for this completion round |
| Lane issue | `a2a-plane#428` | This lane's issue for cursor-safe final live canary plan |
| Run ID | `a2a-terminal-brief-completion-20260523T015723Z` | This run |
