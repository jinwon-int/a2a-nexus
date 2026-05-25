# Cursor and Outbox Health Acceptance Criteria

> **Roadmap:** [#438](https://github.com/jinwon-int/a2a-plane/issues/438)
> **Parent:** [#433](https://github.com/jinwon-int/a2a-plane/issues/433)
>
> This document defines the acceptance criteria for Terminal Brief cursor state, outbox health
> summary, and inbox visibility. It is source-only and no-live: it does not authorize production
> deploy, restart, DB mutation, terminal ACK, provider send, or automatic replay.

## Purpose

The operator needs visibility into Terminal Brief pending/unacked state, cursor health, duplicate
suppression, and broker outbox summaries without inspecting raw database rows. This document
defines what constitutes acceptable cursor/outbox health for operator-facing workflows.

## Definitions

| Term | Definition |
|------|------------|
| **Cursor** | The broker-side tracking position for Terminal Brief outbox rows: which rows have been acknowledged, which are pending, and which are ineligible for ACK. |
| **Outbox** | The broker's record of Terminal Brief messages sent to operators. Each row represents one notification attempt. |
| **Inbox** | The operator-facing view of pending Terminal Brief items that have not yet been acknowledged. |
| **GivenCursor** | The cursor position at a specific point in time, used to determine which rows are eligible for follow-up. |
| **rawUnacked** | All outbox rows that lack an ACK record, regardless of eligibility. |
| **actionableUnacked** | Subset of rawUnacked rows that are ACK-eligible (level-4 receipt capable) and have not been acknowledged. |
| **ackIneligible** | Subset of rawUnacked rows that cannot be ACKed (e.g., provider accepted-send evidence only, level 1). |
| **crossBrokerProjection** | A parent-owned projection row visible to the child broker for awareness, but not actionable by the child broker. |

## Acceptance criteria

### AC1: Pending/unacked inbox visibility

The operator can see whether there is any actionable Terminal Brief backlog without inspecting
raw database rows.

**Must have:**
- A query or view that returns total outbox rows, acked rows, raw unACK rows, actionable unACK rows,
  and ACK-ineligible rows.
- Rows are grouped or filterable by broker, worker, or round.
- The output distinguishes delivery acceptance (receipt level 1-2) from terminal ACK (level 4).
- The output does **not** require, trigger, or imply any state mutation.

**Must not:**
- Mutate broker DB, terminal outbox, or ACK state during read.
- Automatically replay or re-send unacked rows.
- Automatically ACK rows based on view access.
- Surface provider message IDs as terminal ACK evidence.

### AC2: Cursor state display

The cursor state per broker and cross-broker relay is visible.

**Must have:**
- Current cursor position per broker (last processed outbox row id or timestamp).
- Cross-broker relay cursor (where the last projection was relayed to the parent broker).
- A health indicator: OK if cursor is advancing; STALLED if no movement in N hours; UNKNOWN if
  cursor cannot be determined.
- Timestamp of last cursor update.

**Must not:**
- Artificially advance or reset the cursor during a read-only status check.
- Claim stalled cursor without configurable threshold (default: 4 hours).

### AC3: Projection row classification

Parent-owned/cross-broker projection rows do not show as false blockers in the child broker's
inbox.

**Must have:**
- Projection rows are labeled with `originBrokerId` and `parentBrokerId`.
- A child broker's inbox excludes projections where the child broker is not `parentBrokerId`
  (cross-broker projections are visible for awareness only).
- rawUnacked vs actionable unacked vs ACK-ineligible projection rows are classified according
  to the receipt level rules in the Terminal Brief core contract.

**Must not:**
- Surface parent-only projections as actionable blockers on the child broker.
- Create implicit parent rounds for orphan projections.

### AC4: Duplicate prevention and replay visibility

Duplicate state can be audited after a Gateway/broker restart without automatically replaying
historical outbox rows.

**Must have:**
- Duplicate detection by idempotency key: same key + same payload returns existing projection
  with `newProjectionCreated: false`.
- Replay visibility: the operator can see whether a given outbox row is a first-send or a replay.
- Cursor persistence across restart: the cursor position is persisted and survives broker restart.
- After restart, the operator can audit cursor and duplicate state without triggering replay of
  historical rows.

**Must not:**
- Automatically replay historical outbox rows on broker start.
- Automatically ACK any outbox row on cursor initialization.
- Require manual ACK of every historical row before normal operation resumes.

### AC5: Per-broker outbox health summary

A per-broker outbox health summary suitable for Telegram brief, CLI, or dashboard.

**Must have:**
- Total outbox rows.
- Total acked rows.
- Total raw unACK rows.
- Total actionable unACK rows.
- Total ACK-ineligible rows.
- Total cross-broker projection rows (awareness-only, not actionable).
- Stale/unusual conditions flagged (e.g., >100 unacked rows, stalled cursor >4h).
- Timestamp of the most recent outbox row and most recent ACK.

**Must not:**
- Include raw provider message IDs, terminal body content, or operator PII.
- Automatically perform any write action as part of the health check.
- Require DB admin access to produce the summary.

### AC6: Explicit non-actions

The health view is read-only and does not perform any of the following:

- Manual terminal ACK or replay
- Historical outbox replay
- Production DB mutation, prune, or migration
- Live provider/Telegram canary or send
- Gateway/broker/worker restart or reload
- Secret rotation or disclosure
- Repository visibility change
- Force-push or history rewrite
- Release, tag, or npm publish

Provider accepted/message-id evidence in the health summary is provider-accepted evidence only
(receipt level 1-2), never terminal ACK (level 4) or operator approval.

## Delivery acceptance vs terminal ACK

The following outbox row states are **always** level 1 (accepted-send) and must never be
promoted to terminal ACK (level 4) in any health view:

| State | Level | Notes |
|-------|-------|-------|
| `providerAccepted` | 1 | Provider confirmed send acceptance |
| `providerMessageId` | 1 | Provider-assigned message identifier |
| `sendStatus: accepted` | 1 | Gateway-level send acceptance |
| `sendStatus: sent` | 1 | Gateway-level sent confirmation |
| GitHub issue/PR comment | 2 | Requester-visible evidence ledger entry |

Terminal ACK (level 4) requires one of:
- `manual_operator_receipt` — human operator explicitly confirmed receipt.
- `current_session_visible` — the ACK evidence is visible in the current session.

**Plus:** explicit operator approval naming the exact terminal outbox row IDs.

## Rollback and no-replay guidance

- **Rollback** is metadata-only: correct a projection state to `blocked` or `conflict`, preserve
  the original projection key, add a redacted rollback reason. Do not delete or overwrite rows.
- **No automatic replay**: after broker restart, cursor state is loaded from persisted storage.
  No historical outbox rows are replayed unless a new dispatch specifically creates them.
- **Duplicate replay**: replaying a projection with the same `projectionKey` returns the
  existing entry. No duplicate notification is created. This applies even after restart.

## Verification

To verify cursor/outbox health acceptance criteria:

```bash
# Outbox health summary (read-only)
node scripts/check-cursor-outbox-health.mjs \
  --spec docs/specs/a2a-parent-round-closeout-go-nogo/schema.json \
  --fixture fixtures/contract/cursor-outbox-health.json

# Delivery acceptance vs ACK boundary (read-only)
node scripts/check-message-id-ack-boundary.mjs
```

## Safety confirmation

This document:
- Does not authorize production deploy, restart, or any live action.
- Does not authorize terminal ACK, replay, or ACK mutation.
- Does not authorize production DB mutation or migration.
- Does not authorize provider/Telegram send outside approved GitHub comments.
- Does not authorize secret disclosure, visibility change, force-push, or release.
- Provider accepted/message-id evidence is provider-accepted only.
- Runtime/bootstrap hygiene is confirmed before evidence publication.
