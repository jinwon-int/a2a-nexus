# Done: Wire `resolveTerminalBriefParentOriginRoute` into Cross-Broker Terminal Brief Lifecycle

## Summary

Fulfills #854 and #856 by wiring the pure routing helper (extended in PR #857) into the actual cross-broker Terminal Brief projection lifecycle. The routing helper is now called inside `CrossBrokerTerminalBriefProjectionStore.ingest()` to validate incoming projections against the expected handoff topology derived from the parent round's `teamScope`/`initiatingBrokerId` metadata.

## Changes

### `src/core/cross-broker-terminal-brief.ts`
- **New `ParentRoundRoutingInfo` interface** — minimal routing info (initiatingBrokerId, parentBrokerId, handoffBrokerId, etc.) consumed by the projection store for origin validation.
- **New `getParentRoundRouting` callback** in `CrossBrokerTerminalBriefProjectionStoreOptions` — the store calls this during ingest to get routing info for a parent round.
- **Routing validation in `ingest()`** — after standard wrong-origin and missing-parent checks, validates:
  - `originBrokerId` matches `routing.handoffBrokerId` (for cross-team routes)
  - `brokerOfRecordId` matches `routing.parentBrokerId`
- **New reject code** `"routing_mismatch"` for routing validation failures.

### `src/core/broker.ts`
- **Imports** `resolveTerminalBriefParentOriginRoute` and `normalizeTerminalBriefTeamScope` from `terminal-brief-routing.ts`.
- **Wires `getParentRoundRouting` callback** — extracts `teamScope` and `initiatingBrokerId` from the parent task payload, calls `resolveTerminalBriefParentOriginRoute`, and returns the routing info for the store.

### `src/core/cross-broker-terminal-brief.test.ts`
8 new test cases:

| Test | Verifies |
|------|----------|
| Seoseo Team1+Team2 parent accepts Gwakga child | ✅ Correct routing acceptance with parent counts (1/2) |
| Gwakga Team2+Team1 parent accepts Seoseo child | ✅ Symmetric routing acceptance |
| Wrong handoff broker rejected | ✅ `routing_mismatch` code |
| Wrong brokerOfRecordId caught first by wrong_origin | ✅ Existing guard takes precedence |
| No routing metadata → existing validation | ✅ Fallthrough without `routing_mismatch` |
| Invalid initiatingBrokerId → fallthrough | ✅ Unknown broker returns undefined from callback |
| Team1-only self-origin falls through | ✅ No handoff validation on single-team rounds |
| **Broker A + Broker B worker → 2/2 parent counts** | ✅ End-to-end: Seoseo gets 2 Gwakga projections, terminal events show (1/2) and (2/2), notification owner is Seoseo |

## What Was Already Correct (no changes needed)

- **Outbox projection** (`terminal-event-outbox.ts:enqueueCrossBrokerProjection`) — already constructs `crossBrokerHandoff`, `notificationOwnership`, `parentRoundProgress`, and `terminalBriefTitle` with correct 2/2 display format.
- **Metadata schema** (`terminal-brief-metadata.ts`) — canonical metadata validation already handles cross-broker fields.
- **No ACK/replay/live-send conflation** — `terminalAck` is always `false` on projections, and ACK requests are rejected at ingest.

## Risk Notes

- **Low risk.** All routing validation is additive — non-routing-tagged parent rounds (the current state) behave exactly as before. The `getParentRoundRouting` callback returns `undefined` when metadata is absent, so existing cross-broker flows are unaffected.
- **Routing helper uses hardcoded broker registrations** (seoseo=team1, gwakga=team2). This matches existing test conventions. The callback returns `undefined` for unknown brokers, falling through to standard validation.

## Contract Coverage

- `resolveTerminalBriefParentOriginRoute` is now actually **called** in production code (was dead code after PR #857)
- `ParentRoundRoutingInfo` is exported for external consumers
- Rejection produces `routing_mismatch` code with descriptive reason
- All 36 cross-broker + 108 broker + 9 routing tests pass
