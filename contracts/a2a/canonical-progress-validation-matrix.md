# Canonical n/N Progress Validation Matrix (v1)

> **v1 (2026-05-16, R29):** Defines the canonical n/N progress semantics for A2A Terminal Brief aggregation. This is a source-only validation gate; it does not authorize deploy, restart, live provider send, terminal-outbox ACK, database mutation, or secret rotation.

Parent: a2a-plane#370 (a2a-plane#370, internal tracker private)
Lane: a2a-plane#376 (a2a-plane#376, internal tracker private)
Run: `a2a-r29-terminal-brief-canonical-progress-correction-20260516T1412Z`

## Purpose

This contract defines the canonical n/N semantics that all aggregation points (closeout reconciler, round closeout reconciler, parent aggregation, Terminal Brief title rendering) must follow. It is a **validation matrix gate**: scenarios that pass verify the semantics; scenarios that fail indicate a counting bug or semantic drift.

## n/N Definition

**n = number of canonical child tasks that reached a terminal `succeeded` state.**
**N = total number of canonical child tasks in the parent round.**

### Must be TRUE

1. `completed` = count of unique canonical child tasks with terminal status `succeeded`.
2. `total` = count of all canonical child tasks registered in the parent round.
3. `totalKnown` = `true` when the parent broker can enumerate all canonical child tasks at aggregation time.
4. Order of completion (which task finished first, last, or in between) is irrelevant to n/N.
5. Multiple terminal events for the same canonical task produce the same `completed` count (idempotency).

### Must be FALSE (must not inflate completed)

- **Lane order**: n is not the position of a worker in a dispatch lane.
- **Event sequence**: n is not the count of terminal events received.
- **Origin-local projection count**: n is not the number of projection entries in the parent broker's ledger.
- **Retries**: superseded original failed attempts must not increment `completed` beyond unique succeeded tasks.
- **Duplicates/replays**: re-processing the same terminal event (same deliveryId, same taskId, same terminal status) must not increment `completed`.
- **Failed/cancelled/blocked tasks**: must not be counted in `completed` (they remain part of `total`).
- **Out-of-order**: changing the order of terminal event arrival must not change `completed`.
- **sessionKey**: must not appear in the n/N text, Terminal Brief title, body summary, or evidence URLs.
- **ACK/read/visibility/approval**: n/N is evidence projection only — not terminal ACK, read receipt, operator visibility proof, or operator approval.

## Scenarios

| ID | Name | Description |
| --- | --- | --- |
| C01 | canonical-task-completed-count | n/N uses completed canonical child tasks; not lane order, event sequence, or origin-local projection |
| C02 | retry-superseded-original-does-not-inflate-completed | Original failed attempt superseded by retry must not inflate completed |
| C03 | duplicate-replay-does-not-inflate-completed | Same delivery replayed must not increment completed |
| C04 | failed-cancelled-do-not-count-as-completed | Failed/cancelled tasks are part of total but not completed |
| C05 | out-of-order-completion-count-is-order-independent | Order of terminal arrival does not change completed |
| C06 | single-task-1-1-fallback | Single canonical task renders 1/1 on success |
| C07 | cross-broker-aggregation-counts-canonical-tasks-not-projections | Cross-broker n/N reflects canonical child tasks, not projection count |
| C08 | sessionKey-redacted-from-progress-evidence | sessionKey must not appear in n/N title, summary, or evidence |
| C09 | ack-read-visibility-boundary | n/N is evidence projection, not ACK/read/visibility/approval |
| C10 | go-gate-safety-boundary | Source-only GO does not authorize live actions |

## Safety gates

1. **Source-only**: This matrix reads source code and runs local conformance tests. It does not deploy, restart, send, mutate, or approve.
2. **No live provider send**: Provider accepted-send evidence is send-acceptance only (receipt level 1), not read/visibility/terminal ACK.
3. **No terminal-outbox ACK**: Matrix does not mutate terminal-outbox ACK rows.
4. **No database mutation**: Matrix does not read or write production database state.
5. **No secret movement**: Matrix does not read, disclose, rotate, or transport secret values.
6. **Runtime/bootstrap hygiene**: Before this matrix is attached to a PR, confirm `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**` do not enter the branch or artifact evidence.
7. **Every scenario must fail closed**: If a scenario cannot be validated, it must produce a FAIL result (not skip/pass-by-default).

## Fixture

Machine-readable coverage: `fixtures/contract/canonical-progress-validation-matrix.json`
Conformance test: `node test/conformance/check-canonical-progress-validation-matrix.mjs`

### Running the validation

```sh
node test/conformance/check-canonical-progress-validation-matrix.mjs
```

Expected output: JSON report with `verdict: "PASS"` and all 10 scenario groups passing their checks.

## Evidence requirements

A PR/Done/Block closeout for this contract must provide:

- The contract document path and fixture path.
- Local conformance command output showing `PASS` for all scenarios.
- Confirmation that evidence is redacted and no live provider send, ACK mutation, deploy, restart, or secret operation occurred.
- Runtime/bootstrap hygiene confirmation (before PR creation): no `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` files enter the branch or artifact evidence.
- Explicit statement that this matrix is source-only and does not authorize deploy/restart/live-send/ACK/DB-mutation.

## Related

- [Parent Terminal Brief Aggregation Contract](parent-terminal-brief-aggregation.md) — defines the parent-broker projection and title rendering for n/N.
- [Terminal Result Semantics](terminal-semantics.md) — defines receipt levels, ACK boundary, and evidence projection.
- R28 `a2a-plane#370` terminal-brief-command-center-aggregation — parent round for this correction lane.
