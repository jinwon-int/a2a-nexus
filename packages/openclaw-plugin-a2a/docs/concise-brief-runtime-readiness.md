# Concise Terminal Brief renderer — runtime readiness check

Plugin-side runtime readiness for compact parent-round Terminal Brief titles.
Covers `jinwon-int/plugin-a2a#299` and `jinwon-int/a2a-broker#560`.
Run: `a2a-r9-concise-brief-runtime-20260513T134143Z`

## Purpose

Verify that active plugin code uses `A2A Terminal Brief 완료: worker(1/3)`
as the default manager-facing title contract, with concrete worker names and
parent-round progress substituted (for example
`A2A Terminal Brief 완료: workerBeta(1/7)`) for direct broker workers and
cross-broker projected children. The renderer must preserve parent-broker
aggregation metadata (roundNum, roundTotal, parentRoundProgress, parentRoundTotal)
and deliver only through parent-owned notification routing.

This is a **no-live** readiness check. No Gateway restart, no production deploy,
no live Telegram/ACK.

## Requirements coverage

| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| 1 | Default parent-round title contract `"A2A Terminal Brief 완료: worker(1/3)"`, substituting concrete worker and progress | ✅ | `A2A_OPERATOR_TERMINAL_BRIEF_DEFAULT_TITLE_FORMAT` and `renderA2AOperatorTerminalBriefDefaultTitle()` in `operator-terminal-notifier.ts` |
| 2 | Parent-broker aggregation metadata preserved | ✅ | Fields: `parentRoundProgress`, `parentRoundTotal`, `roundNum`, `roundTotal`, `roundProgress.completed`, `crossBrokerHandoff` |
| 3 | Parent-only notification ownership | ✅ | `deliveryOwner: "openclaw.plugin-notifier"`, `deliveryTarget: "operator-main-session"` |
| 4 | No-live proof/activation plan | ✅ | Receipt-gated adapter, dry-run harness, preflight helper; this doc is the activation plan |
| 5 | Adapter text renderer uses compact titles | ✅ | `renderOperatorNotificationText()` in `operator-notification-adapter.ts` — `renderCompactOperatorNotificationTitle()` reads `roundNum`/`parentRoundProgress`/`roundProgress.completed` |
| 6 | Round progress fallback when total unknown | ✅ | No denominator → worker-only label (e.g. `A2A Terminal Brief 완료: workerBeta 작업`) |
| 7 | 7-child no-live rehearsal | ✅ | Tests cover multi-worker round progress through origin titles (brokerAlpha, brokerBeta) and cross-broker projection fields |

## Test verification

### Local run

From repository root:

```bash
npm ci
npm run build
node --test tests/operator-terminal-notifier.test.ts
```

Expected: **27 tests pass**, 0 fail — covers:

- `buildA2AOperatorTerminalOutboxNotificationEnvelope` — concise titles (14 tests)
  - worker+round progress, mid-round completion, final worker completion
  - crossBrokerHandoff metadata, parentRoundNum, parentRoundProgress+parentRoundTotal
  - roundProgress.completed, fallback variants, failure/block types
- `buildA2AOperatorTerminalNotificationEnvelope` — concise titles (4 tests)
  - live terminal event, metadata, crossBroker metadata, absent progress fallback
- `renderOperatorNotificationText` — broker progress fields (3 tests)
  - parentRoundProgress/parentRoundTotal, roundProgress.completed/parentRoundTotal, no-denominator fallback
- `buildA2AOpenClawTelegramOperatorNotification` (1 test)
- `createA2ATelegramSafeDryRunNotificationHarness` (2 tests)
- Origin coverage — brokerAlpha, brokerBeta cross-broker (2 tests)
- Evidence preserved in body (1 test)

### No-live canary harness

```bash
node --test tests/no-live-canary.test.ts
```

Expected: **36 tests pass**, 0 fail — covers:

- Notification disabled → no send (6 tests)
- Provider accepted-send ≠ operator-visible receipt (5 tests)
- Operator-visible receipt required for ACK eligibility (5 tests)
- ACK eligibility → gated on operator-visible receipt only (6 tests)
- Canary round-trip: dry-run → Telegram projection → no live send (8 tests)
- Receipt gap projection — provider send ≠ operator ACK (6 tests)

## Direct child round-progress fixture

The following parent-round metadata fields are recognised by the compact title renderer.
They are read in fallback order by `readEnvelopeRoundNum()` and `readEnvelopeRoundTotal()`
in both the notifier and the adapter:

```
parentRoundNum       → direct field priority
parentRoundProgress  → broker projection fallback
roundProgress.completed → broker-compatible fallback

roundTotal           → direct field priority
parentRoundTotal     → broker projection fallback
```

A 7-child parent round (workers 1-7, all direct) projects as:

```
Worker 1 → A2A Terminal Brief 완료: workerBeta(1/7)
Worker 2 → A2A Terminal Brief 완료: workerEpsilon(2/7)
Worker 3 → A2A Terminal Brief 완료: brokerAlpha(3/7)
Worker 4 → A2A Terminal Brief 완료: brokerBeta(4/7)
Worker 5 → A2A Terminal Brief 완료: namu(5/7)
Worker 6 → A2A Terminal Brief 완료: pado(6/7)
Worker 7 → A2A Terminal Brief 완료: bada(7/7)
```

If parentRoundTotal is unavailable for any worker, the renderer falls back to
worker-only label (no round progress in title). The full evidence body remains
unchanged.

## Cross-broker child projection

Cross-broker (handoff) children carry `crossBrokerHandoff` metadata which
preserves the origin broker's round progress. `readRoundNum` in the notifier
reads `parentRoundNum` from the handoff payload, which feeds into `formatRoundProgress`
to produce the compact title.

Example: Team2/brokerBeta workers projected through brokerAlpha as the parent broker:

```
A2A Terminal Brief 완료: brokerBeta(4/7)
```

The title uses the handoff broker's round position without requiring a live
broker query. Full evidence (child task URL, broker URL, body text) is
preserved in the body.

## Approval-gated activation plan

This plan documents the exact steps to activate concise Terminal Brief titles
in a production Gateway. Steps flagged `[OPERATOR]` require operator approval;
all others are local/code-only.

### Step 1: Review — no-code

- [OPERATOR] Review this readiness document.
- [OPERATOR] Confirm the current checkout contains the concise renderer from
  `plugin-a2a#291` / `1122bb4` (or later main).
- [OPERATOR] Verify the branch does not contain OpenClaw runtime/bootstrap
  context files (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`,
  `IDENTITY.md`, `.openclaw/**`).

### Step 2: Local verification — no live operations

- Run `npm ci && npm run build`.
- Run `node --test tests/operator-terminal-notifier.test.ts` — expect 27 pass.
- Run `node --test tests/no-live-canary.test.ts` — expect 36 pass.

### Step 3: Plugin rebundle — Gateway-safe path

- Use the existing PR/CI pipeline; the runner handles `npm ci`, build, test.
- The runner also handles `git commit`, `git push`, and PR creation.
- No Gateway restart is needed at this stage because the concise renderer is a
  code change within the existing plugin adapter — it does not alter the
  Gateway config, event bridge wiring, or notification routing.

### Step 4: Gateway activation gate

- [OPERATOR] Merge the PR.
- [OPERATOR] Wait for CI to pass on main.
- [OPERATOR] Reload or restart the Gateway to pick up the rebuilt plugin.
  - The concise renderer activates automatically with the updated `dist/` files.
  - Preflight checks (`preflightA2AOperatorNotificationRuntime`) confirm
    notification readiness before any live send.
  - The receipt-gated dry-run harness remains the default; live Telegram sends
    require explicit operator opt-in.

### Step 5: Post-activation verification — dry run only

- [OPERATOR] After Gateway restart, run a dry-run notification projection
  before enabling live sends. Use the broker `/operator/task-report` endpoint
  to trigger a notification and verify the compact title format in the
  projection artifact.
- [OPERATOR] Confirm the projection shows `A2A Terminal Brief <type>: <worker>(n/7)`.
- [OPERATOR] Do not enable live notification sends until the dry-run
  projection passes review.

## Safety boundary

This readiness check is intentionally no-live:

- No production deploy or Gateway restart (listed as operator gate steps
  above, not executed here).
- No live Telegram/provider send.
- No terminal-outbox ACK or replay.
- No production DB mutation or migration.
- No secret or visibility change.
- Provider/Gateway send success alone is **never** terminal ACK evidence.

## Related

- [`canary-receipt-gated-runtime-preflight.md`](./canary-receipt-gated-runtime-preflight.md)
  — receipt-gated notifier preflight (template for this doc)
- [`operator-terminal-notification-receipts.md`](./operator-terminal-notification-receipts.md)
  — receipt policy for terminal notifications
- [`operator-approval-gate.md`](./operator-approval-gate.md) — operator approval
  gate definition
- [`alpha-boundaries.md`](./alpha-boundaries.md) — permanent no-live-send defaults
