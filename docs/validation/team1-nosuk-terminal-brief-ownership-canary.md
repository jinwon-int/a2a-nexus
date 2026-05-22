# Team1/nosuk Terminal Brief ownership canary spec and runbook

Parent: [a2a-broker#863](https://github.com/jinwon-int/a2a-broker/issues/863)
Child issue: [a2a-plane#413](https://github.com/jinwon-int/a2a-plane/issues/413)
Run: `terminal-brief-all-hands-20260521-863-l03-nosuk`
Parent broker/finalizer: `seoseo`
Team2 handoff broker: `gwakga`
Worker: `nosuk`
Lane: 3/7
Team: Team1
Snapshot: `2026-05-21T06:28Z`

This is a no-live specification and runbook for the Terminal Brief ownership canary lane 3/7. It defines the acceptance matrix and safety gate expectations for parent broker (Seoseo) ownership of the operator-facing aggregation and Team2 child (Gwakga) suppression of local 1/1 or 1/2 operator briefs.

This document performs repository and GitHub evidence review only. It does not deploy, restart, reload Gateway/broker/worker processes, send a live provider or Telegram canary, mutate production databases or terminal-outbox rows, perform manual ACK/replay or historical outbox replay, change secrets or repository visibility, publish a release/tag, rewrite history, force-push, or execute approval.

## Lane context

The nosuk lane (3/7) is positioned between the Team1 sibling lanes and the Team2/Gwakga handoff lanes. As such it must:

1. Define parent broker Terminal Brief ownership rules: Seoseo is the only broker that may render or send the operator-facing parent-round aggregate Terminal Brief.
2. Define Team2 child suppression rules: Gwakga handoff children must not produce local operator-facing Terminal Briefs (e.g. "A2A Terminal Brief 완료: dungae(1/1)" or "A2A Terminal Brief 완료: jingun(1/2)").
3. Establish the acceptance matrix that validates both ownership and suppression in this round.

## Target compact Terminal Brief title for this lane

As order 3 of 7 in this round:

```
A2A Terminal Brief 완료: nosuk(3/7)
```

Title constraints:
- Source: `seoseo` parent aggregation ledger, not child issue body or child broker local state.
- Maximum length: ≤80 characters.
- Forbidden content: no task ids, child issue URLs, PR/Done/Block URLs, evidence body, child broker ID, handoff broker ID, provider message ID, receipt state, ACK state, raw logs, secrets, private paths, or runtime/bootstrap file names.
- Status label: `완료` (Korean).
- Denominator `/7` is the broker-assigned child task total for this round, not a global constant.
- Not proof of: provider delivery, operator receipt, approval, or terminal-outbox ACK.

## 7-child parent round title proof (synthetic, no-live)

| Order | Worker | Team | Broker of record | Parent projection owner | Required parent-rendered title | Local child notification |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `bangtong` | Team1 | `seoseo` | `seoseo` | `A2A Terminal Brief 완료: bangtong(1/7)` | disabled; parent owns notification |
| 2 | `sogyo` | Team1 | `seoseo` | `seoseo` | `A2A Terminal Brief 완료: sogyo(2/7)` | disabled; parent owns notification |
| 3 | `nosuk` | Team1 | `seoseo` | `seoseo` | `A2A Terminal Brief 완료: nosuk(3/7)` | disabled; parent owns notification |
| 4 | `yukson` | Team1 | `seoseo` | `seoseo` | `A2A Terminal Brief 완료: yukson(4/7)` | disabled; parent owns notification |
| 5 | `dungae` | Team2 | `gwakga` | `seoseo` | `A2A Terminal Brief 완료: dungae(5/7)` | suppressed; Gwakga relays projection only |
| 6 | `jingun` | Team2 | `gwakga` | `seoseo` | `A2A Terminal Brief 완료: jingun(6/7)` | suppressed; Gwakga relays projection only |
| 7 | `soonwook` | Team2 | `gwakga` | `seoseo` | `A2A Terminal Brief 완료: soonwook(7/7)` | suppressed; Gwakga relays projection only |

Parent projection owner is always `seoseo` for all seven children regardless of broker of record. Gwakga receives the handoff metadata (`parentRoundId`, `originBrokerId=seoseo`, `crossBrokerHandoff`) but must not emit its own operator-facing aggregate. For Team2 rows, "suppressed" means: Gwakga must not emit a local `1/1` or `1/2` brief, and must relay only the bounded projection back to Seoseo.

## Acceptance matrix: Parent broker ownership

| Gate | Required condition | Fail-closed / NO-GO trigger |
| --- | --- | --- |
| P1. Seoseo is sole parent broker | Seoseo owns the `parentRoundId` and `originBrokerId` for the entire round. No other broker may replace, rewrite, or claim Seoseo's origin metadata. | A non-Seoseo broker renders or sends the aggregate parent-round Terminal Brief. A child lane's metadata rewrites `originBrokerId`. |
| P2. Parent metadata in every child dispatch | Every child carries `parentRoundId=terminal-brief-all-hands-20260521-863`, `originBrokerId=seoseo`, `parentRoundTotal=7`, and stable lane order. Team2 handoff children include `crossBrokerHandoff` with `originParentBrokerId=seoseo`. | Missing, rewritten, or inconsistent metadata across children; handoff metadata cannot be joined to parent round. |
| P3. Parent-only notification ownership | Seoseo is the only broker that may render/send the operator-facing parent-round aggregate Terminal Brief. Direct Team1 children publish redacted terminal evidence to the parent ledger but must not send duplicate local Terminal Brief notifications. | Any Team1 or Team2 child lane sends a duplicate parent-facing Notification or Terminal Brief that competes with Seoseo's aggregate. |
| P4. Parent projection stability | Replay with the same `projectionKey` returns the existing projection and records `newProjectionCreated=false`. Same-key/different-payload becomes `conflict` and fails closed. | Duplicate projection creates a second Terminal Brief entry; conflict does not produce visible error. |
| P5. Provider accepted-send = non-ACK | Provider accepted-send, message ID, GitHub comments, Terminal Brief titles, and PR/Done/Block URLs remain evidence inputs only. They are not receipt, ACK, or approval. | Any `accepted`, `sent`, provider `messageId`, GitHub comment, or Terminal Brief title promoted to receipt, ACK, or approval. |

## Acceptance matrix: Team2 child suppression

| Gate | Required condition | Fail-closed / NO-GO trigger |
| --- | --- | --- |
| S1. Gwakga suppresses local operator brief | Gwakga handoff children (dungae, jingun, soonwook) must not produce a local operator-facing Terminal Brief with a 1/1 or 1/2 count. Gwakga relays a bounded projection back to Seoseo only. | Gwakga emits `A2A Terminal Brief 완료: dungae(1/1)` or equivalent local aggregate. A Gwakga-operator sees a "1 of 1" or "1 of 2" brief as if it owns the parent round. |
| S2. Gwakga relays cross-broker projection correctly | Gwakga projection to Seoseo preserves `parentRoundId`, `originBrokerId=seoseo`, `crossBrokerHandoff.originParentBrokerId=seoseo`, and child-specific metadata. Projection must not claim Gwakga as origin. | Projection rewrites `originBrokerId` to `gwakga`. Projection omits `parentRoundId`. Projection lacks `crossBrokerHandoff`. |
| S3. No duplicate local child Terminal Brief | No child broker sends a duplicate Terminal Brief that competes with or precedes the parent aggregate. Team2 handoff broker must not emit its own operator-facing notification. | Duplicate notification observed from Gwakga. Two Terminal Briefs with the same parent round metadata from different brokers. |
| S4. Team2 terminal evidence format | Team2 terminal evidence (PR/Done/Block) uses the same vocabulary: `liveProviderSend=false`, `terminalOutboxAckMutated=false`, `isApproval=false`, `isTerminalAck=false`, `isReadReceipt=false`. | Team2 evidence introduces a different vocabulary or claims ACK/read state from provider accepted-send. |
| S5. Order suppression by broker of record | A broker (Gwakga) that has only `n` child tasks in a round with `N` total must display `(n/N)` only through the parent aggregation, not through its own local brief. | Gwakga displays `(n/N)` locally with N > child count, implying it owns the full round. Or Gwakga displays `(n/n)` locally (e.g. 1/1) with n < N, suppressing the parent total context. |

## Combined acceptance matrix: Team1 and Team2 lanes

| Gate | Applies to | Required condition | Fail-closed / NO-GO trigger |
| --- | --- | --- | --- |
| A1. Metadata propagation | All 7 lanes | Every child includes `parentRoundId`, `originBrokerId=seoseo`, `parentRoundTotal=7`, and lane order. Team2 includes `crossBrokerHandoff`. | Missing, inconsistent, or rewritten metadata in any child. |
| A2. Compact title format | All 7 lanes | Title is `A2A Terminal Brief 완료: <worker>(<order>/7)`, ≤80 chars, no forbidden content. Team2 titles use the parent total `/7`, not `1/1` or `1/2`. | Wrong denominator, forbidden content, Team2 title breaks format. |
| A3. Parent-only aggregate ownership | All 7 lanes | Seoseo alone renders/sends the aggregate parent-round Terminal Brief. Children suppress local duplicates. | Child sends competing aggregate. Team2 sends Gwakga-local aggregate. |
| A4. Receipt/ACK boundary | All 7 lanes | Provider accepted-send remains non-ACK. Terminal Brief titles, GitHub comments, and PR/Done/Block URLs are evidence inputs only. | Any promotion of send evidence to ACK, receipt, or approval. |
| A5. Symmetric routing | All 7 lanes | Origin-based routing: Seoseo-origin rounds owned by Seoseo. Gwakga-origin rounds (future) would be owned by Gwakga. Metadata encodes direction explicitly. | Code or docs special-case Seoseo; Gwakga owns a Seoseo-origin parent; Seoseo owns a Gwakga-origin parent. |
| A6. Replay/idempotency | All 7 lanes | Same `projectionKey` returns existing projection, `newProjectionCreated=false`. Same-key/different-payload becomes `conflict`. | Duplicate projection, stale/backlog replay, or retry without idempotency guard. |
| A7. Team2 suppression | Team2 lanes (5–7) | Gwakga does not emit local 1/1 or 1/2 brief. Gwakga relays bounded projection to Seoseo only. | Gwakga local aggregate, duplicate notification, or Gwakga claims origin ownership. |
| A8. Evidence hygiene | All 7 lanes | No live provider send, DB mutation, terminal-outbox ACK, restart, visibility change, force-push, release, or automatic merge. Redacted evidence only. | Any live-impact action without separate operator approval. |
| A9. Runtime/bootstrap hygiene | All 7 lanes | `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**` absent from branch diff, PR body, issue comments, and artifact evidence. | Any guard path detected; report exact repo-relative paths and Block. |

## Runbook: ownership canary validation steps

### Prerequisites

- GitHub CLI (`gh`) authenticated for the `jinwon-int` org.
- Node.js 22+ with `npm` available.

### Step 1: Verify parent metadata in child dispatch

```bash
# Verify parent issue body specifies parentRoundTotal=7 and seoseo as finalizer.
gh issue view https://github.com/jinwon-int/a2a-broker/issues/863

# Verify child issue body includes parent reference and lane order.
gh issue view https://github.com/jinwon-int/a2a-plane/issues/413
```

Expected: Parent body has scope, safety boundaries, and known child total=7. Child body references parent issue and identifies lane 3/7.

### Step 2: Verify compact title format across all lanes

```bash
# Check that all 7 lane Start comments or issue bodies use (n/7) format.
# Team2 lanes must not use (1/1) or (1/2) format.
```

### Step 3: Run conformance tests

```bash
npm run check:terminal-brief-routing
node test/conformance/check-terminal-brief-canary-acceptance.mjs
node test/conformance/check-terminal-evidence-ack-boundary.mjs
node test/conformance/check-contract-fixtures.mjs
```

Expected: All tests pass with no failures related to parent metadata, title format, or ownership routing.

### Step 4: Verify Team2 suppression evidence

```bash
# Check Team2 lane issues for any sign of local Gwakga aggregate.
gh issue view https://github.com/jinwon-int/a2a-broker/issues/864 --json body,comments 2>/dev/null || echo "Team2 lane issue not accessible"
gh issue view https://github.com/jinwon-int/a2a-broker/issues/865 --json body,comments 2>/dev/null || echo "Team2 lane issue not accessible"
gh issue view https://github.com/jinwon-int/a2a-plane/issues/415 --json body,comments 2>/dev/null || echo "Team2 lane issue not accessible"
```

Expected: No Team2 lane produces a local Gwakga aggregate or a 1/1/1/2 brief. All use `(n/7)` format with Seoseo as parent.

### Step 5: Verify accepted-send boundary

```bash
node test/conformance/check-terminal-evidence-ack-boundary.mjs
```

Expected: Pass — receipt/ACK separation is enforced; accepted-send remains non-ACK.

### Step 6: Verify runtime/bootstrap hygiene

```bash
find . \( -path './.git' -o -path './node_modules' -o -path './packages/*/node_modules' \) -prune -o \
  \( -name AGENTS.md -o -name SOUL.md -o -name USER.md -o -name TOOLS.md -o \
     -name HEARTBEAT.md -o -name IDENTITY.md -o -path './.openclaw/*' \) -print
git status --short --ignored
```

Expected: No guard paths found in branch or staged changes.

## Current decision

**Decision: `GO_CANDIDATE` for the ownership canary spec and runbook.**

This document defines the acceptance matrix for parent broker (Seoseo) ownership and Team2 child (Gwakga) suppression. Parent metadata propagation, compact title format, Seoseo-origin routing symmetry, and receipt/ACK boundary are specified from the parent issue acceptance criteria and existing contracts.

For this lane (3/7), the compact per-child Terminal Brief title is `A2A Terminal Brief 완료: nosuk(3/7)`. The `/7` denominator is the broker-assigned child task total for this round, not an absolute/global value.

Live activation, parent aggregate sending, and any canary provider send remain `NO-GO / Waiting` until:
- All 7 lanes post PR/Done/Block terminal evidence.
- Seoseo as parent broker separately renders and sends the aggregate parent-round Terminal Brief.
- Fresh explicit operator approval separately authorizes the one-shot canary send scope.

## Sibling lane ownership matrix

| Lane | Worker | Issue | Team | Broker of record | Required suppression rule |
| --- | --- | --- | --- | --- | --- |
| 1 | bangtong | [a2a-plane#409](https://github.com/jinwon-int/a2a-plane/issues/409) | Team1 | `seoseo` | Direct child; parent-owned notification |
| 2 | sogyo | [openclaw-plugin-a2a#445](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/445) | Team1 | `seoseo` | Direct child; parent-owned notification |
| 3 | nosuk | [a2a-plane#413](https://github.com/jinwon-int/a2a-plane/issues/413) | Team1 | `seoseo` | Direct child; parent-owned notification |
| 4 | yukson | [a2a-plane#414](https://github.com/jinwon-int/a2a-plane/issues/414) | Team1 | `seoseo` | Direct child; parent-owned notification |
| 5 | dungae | [a2a-broker#864](https://github.com/jinwon-int/a2a-broker/issues/864) | Team2 | `gwakga` | Handoff child; suppresses local 1/1 brief |
| 6 | jingun | [a2a-broker#865](https://github.com/jinwon-int/a2a-broker/issues/865) | Team2 | `gwakga` | Handoff child; suppresses local 1/2 brief |
| 7 | soonwook | [a2a-plane#415](https://github.com/jinwon-int/a2a-plane/issues/415) | Team2 | `gwakga` | Handoff child; suppresses local 1/2 brief |

## Residual risk matrix

| Risk area | Required proof | Current risk posture | Fail-closed condition |
| --- | --- | --- | --- |
| Parent metadata propagation | Every child includes `parentRoundId`, `originBrokerId=seoseo`, `parentRoundTotal=7`, and lane order. Team2 children include `crossBrokerHandoff` with `originParentBrokerId=seoseo`. | Specified in parent issue acceptance criteria and this document; runtime enforcement depends on broker dispatch implementation. | Dispatch missing required field, rewrites origin, or accepts partial metadata across lanes. |
| Compact title correctness | Per-child titles follow `A2A Terminal Brief 완료: <worker>(<order>/7)` format with denominator from broker parent-round assignment. | Documented target titles for all 7 lanes; constraints and forbidden content defined. | Title exceeds 80 chars, contains forbidden content, treats `/7` as a global constant, or Team2 uses `1/1` or `1/2`. |
| Seoseo-origin parent ownership | Parent Terminal Brief owner is `seoseo` (origin broker). Gwakga must not render its own parent notification. | Specified in acceptance matrix P1–P3, S1–S3. | Gwakga renders Seoseo-origin parent notification; ownership ambiguous or split across brokers. |
| Gwakga suppression | Gwakga handoff children produce no local operator-facing 1/1 or 1/2 brief. Gwakga relays bounded projection to Seoseo only. | Specified in acceptance matrix S1–S5. | Gwakga local aggregate observed; duplicate notification; Gwakga claims origin ownership. |
| Receipt/ACK separation | Provider accepted-send stays non-ACK. Terminal Brief titles, comments, URLs remain evidence inputs, not receipt/ACK/approval. | Frozen contract and fixture semantics; no live canary or ACK attempted by this lane. | Any `accepted`, `sent`, `messageId`, GitHub comment, or Terminal Brief title promoted to receipt, ACK, or approval. |
| Replay/stale suppression | Same projectionKey returns existing projection; `newProjectionCreated=false`. Same-key/different-payload becomes `conflict`. | Not executed in this lane; approval-gated future work. | Duplicate projection, stale/backlog replay, terminal-outbox ACK mutation, or retry without idempotency guard. |
| Runtime/bootstrap hygiene | Branch diff, PR body, issue comments, and artifact evidence exclude OpenClaw runtime/bootstrap context files. | Pre-publication scan confirms guard paths absent. | Any context file or `.openclaw/**` path enters branch or artifacts; report exact repo-relative paths and Block. |

## Safety confirmation

This lane:

- Did not deploy or restart any Gateway, broker, or worker service.
- Did not mutate production databases or terminal-outbox ACK rows.
- Did not send any live provider or Telegram message beyond normal A2A task completion notifications.
- Did not perform manual Terminal Brief ACK/replay or historical outbox replay.
- Did not change secrets, repository visibility, or release state.
- Did not rewrite history or force-push.
- Did not execute approval without fresh explicit operator approval.
- Provider accepted/message-id evidence is provider-accepted evidence only, never read/visibility/terminal ACK.
- Used redacted repository evidence only (contracts, fixtures, prior validation documents, test output).
- Confirmed runtime/bootstrap hygiene before evidence publication (guard paths absent).

## Local validation commands

```bash
# Run terminal-brief routing check
npm run check:terminal-brief-routing

# Run canary acceptance conformance
node test/conformance/check-terminal-brief-canary-acceptance.mjs

# Run message-id ACK boundary check
node test/conformance/check-terminal-evidence-ack-boundary.mjs

# Run contract fixture conformance
node test/conformance/check-contract-fixtures.mjs

# Hygiene scan
find . \( -path './.git' -o -path './node_modules' -o -path './packages/*/node_modules' \) -prune -o \
  \( -name AGENTS.md -o -name SOUL.md -o -name USER.md -o -name TOOLS.md -o \
     -name HEARTBEAT.md -o -name IDENTITY.md -o -path './.openclaw/*' \) -print
git status --short --ignored
```

## Closeout boundary

This lane publishes PR evidence for the ownership canary spec/runbook document. It must not claim aggregate activation GO, live canary authorization, deploy/reload approval, terminal ACK/read receipt, or source-public/visibility approval. It also must not treat `/7` as a global constant; it is only this round's broker-assigned child task total.
