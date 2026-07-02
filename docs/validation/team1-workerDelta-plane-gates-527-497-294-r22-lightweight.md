# Team1/workerDelta R22 lightweight/performance acceptance matrix

Lane issue: a2a-plane#331 (a2a-plane#331, internal tracker private)
Parent tracker: [a2a-broker#497](https://github.com/jinwon-int/a2a-broker/issues/497) — broker high CPU/memory and Node heap OOM
Roadmap tracker: [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294) — receipt semantics, queue hygiene, canary gates
Run: `a2a-r22-broker-lightweight-20260515T015139Z`
Broker of record: `brokerAlpha`
Team: `team1-brokerAlpha`
Worker: `workerDelta`

This is a **libero validation matrix** for the R22 broker lightweight/performance round. It defines acceptance criteria specifically for the lightweight/performance angle: memory bounds, /health latency, no behavior regression, no DB mutation or deploy assumptions. It cross-checks the team1 sibling roadmap inputs (workerGamma, workerAlpha, workerBeta) and verifies that accepted-send/non-ACK and Terminal Brief safety wording is preserved.

**This document does not overwrite or replace the existing gate packet at `team1-workerDelta-plane-gates-527-497-294.md`.** That document remains the authoritative gate matrix. This document adds lightweight/performance-specific acceptance criteria for this round.

---

## Cross-check: team1 sibling roadmap inputs

The three team1 sibling roadmap inputs (2026-05-09) were reviewed against the existing #497/#294 gates and the R22 lightweight/performance focus.

| Worker | Input | Lightweight/performance relevance | Cross-check finding |
| --- | --- | --- | --- |
| **workerGamma** | `docs/roadmap/team1-input-workerGamma-2026-05-09.md` | Quickstart ergonomics, broker-level developer experience, CI smoke test | **No lightweight angle.** Focused on developer experience and public-availability gate. Does not address broker memory/performance or #497/#294 acceptance criteria. Not a conflict — independent axis. |
| **workerAlpha** | `docs/roadmap/team1-input-workerAlpha-2026-05-09.md` | Verification strategy, scanner/readiness, CI matrix, rollback/no-go criteria | **Partial lightweight overlap.** Scanner, CI matrix, and rollback blocks also apply to performance regressions (e.g., scanner must catch regression-introducing paths). The G2 scanner gate is a prerequisite for any performance acceptance claim. No direct #497/#294 lightweight acceptance criteria defined. |
| **workerBeta** | `docs/roadmap/team1-input-workerBeta-2026-05-09.md` | Protocol contract, compatibility surface, ACK boundary, public/private clarity | **Direct lightweight overlap on ACK boundary.** The contract conformance test suite (30-day goal) and compatibility matrix (90-day goal) directly support verifying that accepted-send/non-ACK boundaries survive lightweight changes. The ACK boundary enforcement must remain invariant across any performance optimization. |

**Cross-check verdict:** All three sibling inputs are compatible with the existing #497/#294 gates and do not contradict or weaken the lightweight acceptance criteria defined below. No sibling input defines performance regression gates that duplicate or conflict with this matrix.

---

## Lightweight acceptance matrix: #497 (memory/heap/OOM)

These criteria are additive to Gate B in `team1-workerDelta-plane-gates-527-497-294.md`. They specifically address the lightweight/performance angle.

| Criterion | Acceptance pass | Fail-closed condition |
| --- | --- | --- |
| **R1. Memory bound for hot-table loading** | Evidence shows broker loads SQLite hot tables with a bounded working set (paged, lazy, or incremental). Startup heap does not grow proportionally to total task/audit/outbox row count. | No evidence of bounded loading; SQLite hot tables materialize all historical rows into live heap. |
| **R2. /health p95 latency under load** | /health endpoint responds within 500ms p95 under representative steady-state task/audit/outbox row counts (at least 660 tasks, 2000 audit events, 400 outbox rows). Measurement from safe local or redacted environment. | No latency evidence, measured p95 exceeds 500ms, or test uses unrealistically small row counts. |
| **R3. /health p99 latency under load** | /health endpoint responds within 1000ms p99 under the same representative row counts. | No latency evidence, p99 exceeds 1000ms, or measurement environment is not comparable to production. |
| **R4. No behavior regression for task lifecycle** | Existing task claim, status poll, cancel, and terminal evidence paths continue to function after lightweight changes. The existing contract conformance tests or equivalent pass. | Any lifecycle path breaks or returns different evidence shapes. |
| **R5. No DB mutation assumptions** | Lightweight/performance evidence does not require SQLite table mutation, row deletion, WAL checkpoint, or state change. All evidence is read-only or test-harness only. | Evidence requires production DB mutation, prune, or WAL modification. |
| **R6. No deploy/restart assumptions** | Lightweight/performance acceptance does not require broker restart, deployment, or container lifecycle change. | Acceptance requires deploy, restart, or service state change. |
| **R7. Terminal outbox independence** | Performance acceptance does not require terminal outbox ACK mutation, outbox row deletion, or outbox replay. | Outbox state must be modified or ACKed for performance evidence. |
| **R8. Heap RSS bounded under steady growth** | Evidence (from test harness or redacted environment) shows that heap and RSS remain bounded (not growing proportionally with cumulative task/audit/outbox rows) after representative load. | Heap or RSS grows monotonically with cumulative row count in a steady-state scenario. |

---

## Lightweight acceptance matrix: #294 (receipt semantics, canary, ACK boundary)

These criteria are additive to Gate C in `team1-workerDelta-plane-gates-527-497-294.md`. They specifically verify that safety wording and non-ACK boundaries survive lightweight changes.

| Criterion | Acceptance pass | Fail-closed condition |
| --- | --- | --- |
| **S1. Accepted-send non-ACK boundary preserved** | Every reference to provider message IDs, `providerAccepted`, `sendStatus: accepted/sent` in contracts, docs, fixtures, and tests remains labeled as accepted-send evidence only. No new language promotes these to ACK or receipt. | A contract, doc, fixture, or test change treats provider send success as terminal ACK, requester-visible receipt, or operator-visible receipt. |
| **S2. Terminal Brief safety wording preserved** | Terminal Brief docs (`parent-terminal-brief-aggregation.md`, `github-evidence-projection.md`, `terminal-semantics.md`) continue to state that Terminal Brief summaries are evidence ledger entries only, not terminal ACK, read receipt, visibility proof, or operator approval. | Any doc weakens the Terminal Brief safety wording, or implies Terminal Brief summary = terminal ACK. |
| **S3. No-live canary wording intact** | `receipt-gate-canary.ts` and any canary references remain pure no-delivery/no-real-ACK. No canary path is changed to permit live provider sends without explicit operator approval. | Canary path references live send, live ACK, or live notification without explicit one-shot allowlist and operator approval. |
| **S4. Replay safety invariant** | Duplicate sends or retries cannot mint a false terminal ACK. Idempotency keys, dedupe keys, or equivalent controls remain in place. | Replay produces duplicate terminal ACK mutations or false requester-visible receipts. |
| **S5. Read-only lightweight acceptance** | This matrix itself is read-only: it defines acceptance criteria without mutating DB, ACKing outbox, sending live notifications, deploying, restarting, or changing repository visibility. | Evidence publication requires any of the safety-gated actions listed above. |

---

## Fail-closed no-live/no-ACK boundary verification

Before any PR/Done/Block evidence for this lane, verify:

- [ ] No OpenClaw runtime/bootstrap context file enters the branch or artifact evidence (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`).
- [ ] No raw session dump, provider payload, token, PAT, host-private path, or chat ID appears in evidence.
- [ ] No production deploy, restart, or service state reference appears in evidence.
- [ ] No terminal-outbox ACK claim or outbox mutation reference appears in evidence.
- [ ] No live Telegram/provider send claim appears in evidence.
- [ ] Provider message IDs and send-status values are referenced as accepted-send evidence only.
- [ ] Terminal Brief summaries are labeled as evidence ledger entries, not terminal ACK, read receipt, visibility proof, or operator approval.
- [ ] Evidence is bounded and redacted: commands, exit statuses, finding counts/classes, commit SHA, and issue/PR URL references only.

---

## Aggregate decision

**Decision: `NO-GO / Waiting` for operational activation.** The lightweight/performance acceptance matrix is documented and locally validated. Production activation — including broker deploy/restart for lightweight fixes, DB prune, WAL mutation, terminal ACK, or live canary send — remains blocked until explicit operator approval names the exact action, scope, and run ID.

Safe Done/Block evidence for this lane may state: **the R22 lightweight acceptance matrix is documented and cross-checked against team1 sibling inputs; production activation remains `NO-GO / Waiting`.**

This lane does not implement broker-side lightweight fixes (heap bounds, SQLite paging, /health optimization, outbox hygiene) — those remain in the broker repo under #497. This lane provides the plane-side acceptance criteria and fail-closed boundaries that broker-side implementations must satisfy.

---

## Safety confirmation

This lane performed only repository inspection and documentation creation. It did not:

- Deploy, restart, or reconfigure any broker/Gateway/worker service
- Mutate a production database, SQLite/WAL state, or terminal-outbox records
- Send live provider or Telegram messages
- ACK terminal-outbox records
- Rotate, disclose, or write secrets
- Include raw secrets, private hostnames, provider IDs, or host-private paths
- Rewrite Git history or force-push
- Change repository visibility

Provider message IDs and send-status values remain accepted-send evidence only. They are not terminal ACK, requester-visible receipt, operator-visible receipt, human-seen proof, or operator approval.
