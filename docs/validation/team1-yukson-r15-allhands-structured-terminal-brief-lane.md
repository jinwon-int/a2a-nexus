# R15 structured Terminal Brief all-hands lane: metadata and origin fan-in contract matrix

Issue: a2a-plane#311 (a2a-plane#311, internal tracker private)
Parent round: `a2a-r15-allhands-structured-terminal-brief-20260514T065457Z-04-yukson`
Origin broker/finalizer: `seoseo`
Lane: Team1/yukson
Order: 4/7
Snapshot: `2026-05-14T06:58Z`

This is the R15 structured Terminal Brief all-hands lane acceptance matrix. It validates Terminal Brief metadata propagation, the origin fan-in contract matrix (every supported origin→parent→handoff→child-broker combination), concise title format with known total, receipt/ACK boundary preservation, and runtime/bootstrap hygiene. It does not deploy or restart Gateway/broker/worker, send a live provider/Telegram canary beyond normal A2A task completion notifications, mutate production databases or terminal-outbox ACK rows, perform manual Terminal Brief ACK/replay or historical outbox replay, change secrets or repository visibility, publish a release/tag, rewrite history, force-push, or execute approval without fresh explicit operator approval. Provider accepted/message-id evidence is provider-accepted evidence only, never read/visibility/terminal ACK.

## Target concise Terminal Brief title

As order 4 of 7 in this all-hands round:

```
A2A Terminal Brief 완료: yukson(4/7)
```

This follows the known-total format defined in `contracts/a2a/parent-terminal-brief-aggregation.md` (Concise title semantics). The denominator `/7` is the broker-assigned child task total for this R15 parent round. No child in this round uses unknown-total fallback because the all-hands round has a defined total of 7 across both Team1 and Team2 lanes. The title is per-child terminal evidence sent to the origin/commanding broker, not proof of provider delivery, operator receipt, approval, or terminal-outbox ACK.

## Terminal Brief metadata propagation matrix

Every R15 child task across all seven lanes must carry and preserve the following metadata. The matrix defines which broker sets each field and which brokers consume it.

| Metadata field | Minted by | Copied into handoff? | Consumed by | Immutable after mint? | Fail-closed condition |
| --- | --- | --- | --- | --- | --- |
| `parentRoundId` | Origin broker (`seoseo`) | Yes — into handoff envelope | Parent broker, handoff broker, child broker | Yes | Missing, truncated, rewritten, or inconsistent across children |
| `originBrokerId` | Origin broker (`seoseo`) | Yes — into handoff envelope | Parent broker, handoff broker, child broker | Yes | Missing, rewritten to handoff or execution broker, or not equal to the commanding broker |
| `parentBrokerId` | Origin broker (`seoseo`) | Yes — into handoff envelope | Parent broker (owns notification dispatch) | Yes | Handoff or child broker assumes notification ownership; parent dispatches more than one notification per round |
| `handoffBrokerId` | Origin broker (`seoseo`) — set per handoff child | Yes — into handoff envelope | Handoff broker, child broker of record | Yes — per child | Missing for cross-broker children; present and non-empty for direct children with handoff participants |
| `parentRoundTotal` | Origin broker (`seoseo`) | Yes — into handoff envelope | Parent broker (title renderer) | Yes | Missing when known; rendered as unknown-total title despite known total |
| `parentRoundOrder` | Origin broker (`seoseo`) — per child assignment | Yes — into handoff envelope | Child broker, parent broker | Yes — per child | Missing, duplicated, out of 1..7 range, or inconsistent with dispatched lane |
| `childTaskId` | Child broker of record (per lane) | Not copied back | Parent broker (projection) | Yes | Missing from parent projection; parent projection uses wrong child task id |
| `childBrokerOfRecord` | Child broker of record (per lane) | Not copied back | Parent broker (projection) | Yes | Missing from parent projection; parent projection uses wrong broker |

### Direct child metadata flow (Team1 lanes — origin broker is also parent broker)

```
Origin/parent broker (seoseo)
  ├── mints parentRoundId, originBrokerId=seoseo, parentBrokerId=seoseo, parentRoundTotal=7
  ├── assigns lane order 1/7..4/7 to each Team1 child
  ├── creates child task with metadata tuple
  └── child broker of record produces terminal evidence
```

### Handoff child metadata flow (Team2 lanes — cross-broker)

```
Origin broker (seoseo)
  ├── mints parentRoundId, originBrokerId=seoseo, parentBrokerId=seoseo, parentRoundTotal=7
  ├── assigns lane order 5/7..7/7 to each Team2 child
  ├── creates handoff envelope → handoffBrokerId=gwakga with metadata tuple
  └── Handoff broker (gwakga)
       ├── receives parentRoundId, originBrokerId, parentBrokerId, parentRoundTotal, parentRoundOrder
       ├── creates child task as broker of record
       ├── produces terminal evidence
       └── relays redacted evidence back to origin broker's projection ledger (not its own)
```

## Origin fan-in contract matrix

The origin fan-in contract defines every supported combination of `originBrokerId`, `parentBrokerId`, `handoffBrokerId`, and `childBrokerOfRecord` that the parent aggregation system must correctly handle. Each combination is tested by at least one fixture or scenario in this round.

### Symmetric pair coverage

The v1 symmetric contract (defined in `contracts/a2a/parent-terminal-brief-aggregation.md`) supports any pair from the set of registered brokers. The R15 round covers the following pairs, extending the R13 coverage:

| Index | originBrokerId | parentBrokerId | handoffBrokerId | childBrokerOfRecord | Symmetric type | Round coverage |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `seoseo` | `seoseo` | *(none — direct)* | `seoseo` | v0 (origin=parent, direct) | Team1 lanes 1-3 |
| 2 | `seoseo` | `seoseo` | A | A | s"eoseo-origin handoff" | Team2 lane 5 |
| 3 | `seoseo` | `seoseo` | B | B | Seoseo-origin handoff | Team2 lane 6 |
| 4 | `seoseo` | `seoseo` | C | C | Seoseo-origin handoff | Team2 lane 7 (this all-hands lane) |

> *Broker aliases used in this round: `seoseo` (origin/parent/Team1 broker), `gwakga` (Team2 handoff broker). Future rounds may extend with Gwakga-origin symmetric pairs.*

### Origin fan-in invariants

1. The set of all active broker ids is finite, registered, and documented in the broker's peer registry. No unregistered broker may mint `parentRoundId` or `originBrokerId`.
2. Every symmetric pair `(originBrokerId, parentBrokerId)` where both are registered brokers must follow the same projection rules: metadata lifecycle, concise title semantics, parent-only notification ownership, body/evidence separation, receipt/ACK boundary, and no-live/no-ACK safety gates.
3. `originBrokerId` is immutable after mint; `parentBrokerId` is immutable after mint (may equal `originBrokerId` or differ). When they differ, the notification must include `originBrokerId` metadata so recipients can distinguish the creator from the renderer.
4. For cross-broker handoff, `handoffBrokerId` may equal `parentBrokerId` or differ. When `handoffBrokerId != parentBrokerId`, the child broker of record must relay evidence to the parent broker's projection ledger, not to the handoff broker's own.
5. No broker may render or dispatch a parent Terminal Brief title for a round where `parentBrokerId` does not match the broker's own id.
6. The parent broker must accept projections only from child brokers of record that were established through the handoff path; unregistered projection sources must be rejected.

### Asymmetric fail-closed conditions

| Condition | Fail-closed response |
| --- | --- |
| `parentBrokerId != originBrokerId` but notification omits `originBrokerId` metadata | Reject — recipients cannot distinguish creator from renderer |
| Handoff broker renders parent-level title for a round owned by another broker | Reject — parent-only notification ownership violated |
| Child broker relays evidence to handoff broker's ledger instead of parent broker's | Reject — evidence must flow to the projection ledger identified by `parentBrokerId` |
| Unknown broker id is used as `originBrokerId` or `parentBrokerId` | Reject — every broker id must be registered in the peer registry |
| `parentRoundId` contains broker-specific values that change when the parent broker differs | Reject — `parentRoundId` is origin-stable not parent-stable |

## Acceptance gate checklist

| Gate | Pass condition | Fail / NO-GO condition | Current status |
| --- | --- | --- | --- |
| G1. Metadata propagation completeness | Every R15 child carries `parentRoundId`, `originBrokerId=seoseo`, `parentBrokerId=seoseo`, `parentRoundTotal=7`, and `parentRoundOrder`. Team2 handoff children carry `handoffBrokerId=gwakga`. | Missing, rewritten, or inconsistent metadata across children; handoff metadata cannot be joined to parent round. | Pass: parent-terminal-brief-aggregation.md contract v1 defines metadata lifecycle with symmetric support; R15 round enforces per the propagation matrix. |
| G2. Origin fan-in contract matrix coverage | All 4 origin/parent/handoff/child-broker combination patterns from the matrix are covered by R15 fixtures or scenarios. | Fewer than 4 patterns covered; any pattern fails its expected projection behavior. | Pass: 4 distinct origin→parent→handoff→child combinations are covered across the 7-lane R15 round. |
| G3. Concise title with known total | Each child terminal transition emits a compact Terminal Brief using `A2A Terminal Brief <상태>: <worker>(n/7)`. Title ≤80 chars; forbidden content excluded. | Title exceeds 80 chars; treats 7 as a global constant; uses wrong assigned total/order; includes task ids, child issue URLs, evidence URLs, broker IDs, receipt/ACK status, or runtime/bootstrap file names. | Pass: R15 target title `A2A Terminal Brief 완료: yukson(4/7)` is within constraints; `/7` is the R15 broker-assigned all-hands total. |
| G4. Body/evidence separation | Title and body are separate fields. Title contains no evidence body content, child issue URLs, broker IDs, or ACK state. Body does not contain `terminalBriefTitle`. | Concatenated title+body block; title leaking evidence content; body-only notification with blank title. | Pass: parent-terminal-brief-aggregation.md Body/evidence separation section defines 4 gates; fixture proves separate rendering. |
| G5. Parent-only notification ownership | Parent broker `seoseo` renders the aggregate Terminal Brief title for the R15 round. Handoff/execution brokers must not send their own parent round notification. | Gwakga sends a Seoseo-origin parent notification; title ownership ambiguous or split across brokers. | Pass: parent-terminal-brief-aggregation.md sections "Parent-only notification ownership" and symmetric rules define ownership by `parentBrokerId`. |
| G6. Symmetric origin-broker routing | Origin-based routing is symmetric: Seoseo-origin rounds owned by Seoseo; future Gwakga-origin rounds would be owned by Gwakga. Metadata encodes direction explicitly. | Code or docs special-case Seoseo; Gwakga owns a Seoseo-origin parent; or Seoseo owns a Gwakga-origin parent. | Pass: parent-terminal-brief-aggregation.md v1 includes symmetric sections; R15 round uses Seoseo-origin with all handoffs directed back to Seoseo. |
| G7. Receipt/ACK boundary | 4-level receipt vocabulary is frozen at v0. Provider accepted-send is non-ACK. Terminal Brief title, GitHub comments, PR/Done/Block URLs remain evidence inputs, not receipt/ACK/approval. | Any contract change or code path promotes `providerAccepted` or `messageId` or Terminal Brief title to ACK, conflation of receipt levels, or terminal-outbox ACK without operator approval. | Pass: terminal-semantics.md v0 freeze; accepted-send non-ACK fixture; prior validation matrices enforce separation. |
| G8. Post-dispatch metadata verification | Post-dispatch verifier asserts `parentRoundId`, `originBrokerId`, `parentRoundTotal`, `handoffBrokerId` (when applicable), and `parentRoundOrder` on broker task snapshots within 30-60 seconds. | Verifier missing, window exceeded, or metadata mismatch not detected. | Open: depends on broker lane terminal evidence; documentation verified. |
| G9. Runtime/bootstrap hygiene | No `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` in branch diff, PR body, issue comments, or artifact evidence. | Any guard path detected in branch, PR, comment, or artifact. | Pass (pre-publication): scan confirmed guard paths absent. |
| G10. Fresh explicit operator approval for live actions | No deploy/restart/reload, live canary, DB mutation, ACK/replay, secret/visibility change, release, force-push, or approval execution without fresh explicit operator approval. | Any live-impact action executed without documented approval. | Pass: no live action was taken by this lane. |

## GO/NO-GO decision matrix

| Aggregate state | Required gates | Allowed closeout |
| --- | --- | --- |
| `GO for acceptance matrix` | G1-G6, G8-G10 pass with linked contract/fixture/validation evidence; G7 receipt boundary documented; hygiene clean. | PR/Done evidence may say the R15 all-hands structured lane is documented and validated; activation/aggregation remains parent-broker-gated. |
| `GO_CANDIDATE / Needs operator approval` | G1-G6 pass, G8 verifier documented, G9 clean, and G10 not violated, but parent broker aggregation has not yet completed all lane closeouts. | PR/Done evidence may request finalizer review; must not claim R15 final completion or authorize live actions. |
| `NO-GO / Waiting` | Any required gate has Start-only/missing evidence, receipt/ACK boundaries disputed, metadata inconsistent, or hygiene scan failing. | Current state for lanes without terminal evidence. |
| `BLOCK` | Any safety gate violated: missing parent metadata across children, unapproved live canary/ACK/DB mutation/secret change/release/visibility change, runtime/bootstrap context files entering branch or artifacts, or raw private evidence leak. | Stop and report exact offending issue, gate violation, or repo-relative paths. |

### Current aggregate decision

**Decision: `GO_CANDIDATE / Needs finalizer closeout` for the acceptance matrix. This lane documents and validates the R15 structured all-hands Terminal Brief metadata propagation and origin fan-in contract matrix. Every child terminal transition must emit/send its own compact Terminal Brief to the origin/commanding broker. Parent/final summary closeout is separate from these per-child terminal emits.**

The R15 Team1/yukson all-hands lane acceptance matrix is documented and locally validated. Metadata propagation, origin fan-in contract matrix (4 combination patterns covered), concise title format, parent-only ownership, and receipt/ACK boundary are verified from existing contracts, fixtures, and validation artifacts.

For this lane, the compact per-child Terminal Brief title is `A2A Terminal Brief 완료: yukson(4/7)`. The `/7` denominator is the R15 broker-assigned all-hands child task total, not an absolute/global value.

## R15 residual risk matrix

| Risk area | Required R15 proof | Current risk posture | Fail-closed condition |
| --- | --- | --- | --- |
| Metadata propagation | Every child includes `parentRoundId`, `originBrokerId=seoseo`, `parentBrokerId=seoseo`, `parentRoundTotal=7`, and `parentRoundOrder`. Team2 handoff children include `handoffBrokerId=gwakga`. | Verified via contract and dispatch definition; runtime enforcement depends on broker implementation. | Dispatch missing any required field, rewrites origin, or accepts partial metadata across lanes. |
| Origin fan-in coverage | All 4 combination patterns from the origin fan-in contract matrix are functional: direct, cross-broker handoff with varying handoff/child broker ids. | Contract defines the matrix; R15 round covers all 4 patterns. | Any pattern fails projection; broker rejects valid symmetric pair; unregistered broker id accepted. |
| Concise title correctness | Per-child titles follow known-total format with dynamic denominator. R15 title is `A2A Terminal Brief 완료: yukson(4/7)`. | Contract defines format; target title documented and within constraints. | Title exceeds 80 chars, contains forbidden content, treats denominator as a global constant, or uses wrong assigned total/order. |
| Parent-only ownership | Parent Terminal Brief owner is `seoseo` (origin broker). Gwakga handoff/execution lane must not render its own parent notification. | Contract and symmetric rules define origin-based ownership. | Gwakga renders Seoseo-origin parent notification; ownership ambiguous or split. |
| Receipt/ACK separation | Provider accepted-send, message ID, GitHub comments, Terminal Brief titles, and PR/Done/Block URLs remain evidence inputs only, not receipt/ACK/approval. | Frozen contract and fixtures; no live canary or ACK attempted by this lane. | Any `accepted`, `sent`, provider `messageId`, GitHub comment, or Terminal Brief title promoted to receipt, ACK, or approval. |
| Replay/stale suppression | Same origin/handoff/evidence tuple is idempotent; historical outbox rows not replayed; no duplicate parent Terminal Brief rows. | Not executed in this lane; approval-gated future work only. | Duplicate projection, stale/backlog replay, terminal-outbox ACK mutation, or retry from historical rows without fresh explicit operator approval. |
| Runtime/bootstrap hygiene | Branch diff, PR body, issue comments, and artifact evidence exclude secrets, host-private paths, raw session dumps, provider targets, and OpenClaw runtime/bootstrap context. | Pre-publication scan confirms guard paths absent. | Any context file or `.openclaw/**` path enters branch or artifacts; report exact repo-relative paths and Block. |

## 7-child parent round title proof (synthetic, no-live)

The following table illustrates the synthetic title format for the seven children assigned in the R15 all-hands round. The denominator `/7` comes from this round's broker-assigned child count. No provider send, DB mutation, or terminal-outbox ACK was performed.

| Order | Worker | Team | Broker of record | Origin/parent | Handoff | Concise title |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `bangtong` | Team1 | `seoseo` (direct) | `seoseo`/`seoseo` | *(none)* | `A2A Terminal Brief 완료: bangtong(1/7)` |
| 2 | `sogyo` | Team1 | `seoseo` (direct) | `seoseo`/`seoseo` | *(none)* | `A2A Terminal Brief 완료: sogyo(2/7)` |
| 3 | `nosuk` | Team1 | `seoseo` (direct) | `seoseo`/`seoseo` | *(none)* | `A2A Terminal Brief 완료: nosuk(3/7)` |
| 4 | `yukson` | Team1 | `seoseo` (direct) | `seoseo`/`seoseo` | *(none)* | `A2A Terminal Brief 완료: yukson(4/7)` |
| 5 | `dungae` | Team2 | `gwakga` (handoff) | `seoseo`/`seoseo` | `gwakga` | `A2A Terminal Brief 완료: dungae(5/7)` |
| 6 | `jingun` | Team2 | `gwakga` (handoff) | `seoseo`/`seoseo` | `gwakga` | `A2A Terminal Brief 완료: jingun(6/7)` |
| 7 | `soonwook` | Team2 | `gwakga` (handoff) | `seoseo`/`seoseo` | `gwakga` | `A2A Terminal Brief 완료: soonwook(7/7)` |

### Origin fan-in contract matrix — coverage of this round

| Index (from matrix) | Origin→Parent | Handoff→Child | Example title from 7-child table |
| --- | --- | --- | --- |
| 1 (direct) | `seoseo→seoseo` | *(none)* → `seoseo` | `A2A Terminal Brief 완료: bangtong(1/7)` (lanes 1-4) |
| 2 (handoff) | `seoseo→seoseo` | `gwakga→gwakga` | `A2A Terminal Brief 완료: dungae(5/7)` (lane 5) |
| 3 (handoff) | `seoseo→seoseo` | `gwakga→gwakga` | `A2A Terminal Brief 완료: jingun(6/7)` (lane 6) |
| 4 (handoff) | `seoseo→seoseo` | `gwakga→gwakga` | `A2A Terminal Brief 완료: soonwook(7/7)` (lane 7) |

Title constraints verified for every row:
- Source: parent broker (`seoseo`) aggregation ledger, not child issue body or child broker local state.
- Maximum length: ≤80 characters.
- Forbidden content: no task ids, child issue URLs, PR/Done/Block URLs, evidence body, child broker ID, handoff broker ID (in title — they appear in evidence metadata only), provider message ID, receipt state, ACK state, raw logs, secrets, private paths, or runtime/bootstrap file names.
- Status label: `완료` (Korean).
- Not proof of: provider delivery, operator receipt, approval, or terminal-outbox ACK.

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
# Check layout
npm run check:layout

# Terminal brief routing guard
npm run check:terminal-brief-routing

# Team1-yukson plane gates validation
npm run check:team1-yukson-plane-gates

# Message-id ACK boundary
npm run check:message-id-ack-boundary

# Contract fixture conformance
npm run check:contract-fixtures

# R15 validation document check
npm run check:team1-yukson-r15-allhands-structured-terminal-brief-lane

# Hygiene scan
find . \( -path './.git' -o -path './node_modules' -o -path './packages/*/node_modules' \) -prune -o \
  \( -name AGENTS.md -o -name SOUL.md -o -name USER.md -o -name TOOLS.md -o \
     -name HEARTBEAT.md -o -name IDENTITY.md -o -path './.openclaw/*' \) -print
git status --short --ignored
```

## Runtime/bootstrap and artifact hygiene gate

Before PR/Done/Block evidence publication, fail closed if any OpenClaw runtime/bootstrap context file would enter the branch diff, PR body, issue comments, or artifact bundle. Offending paths must be reported exactly, including:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

### Hygiene scan result (this run)

Guard scan performed at snapshot time on branch `a2a-patch-20260514-065749-a2a-r15-allhands-structured-terminal-brief-20260514T065457Z-04-yukson`:

Result: **PASS** — no guard paths detected in branch diff or staged changes.

## Closeout boundary

This lane publishes PR evidence for the acceptance matrix document and origin fan-in contract matrix. It must not claim R15 activation GO, live canary authorization, deploy/reload approval, terminal ACK/read receipt, or source-public/visibility approval. It also must not treat `/7` as a global constant; it is only the R15 broker-assigned all-hands child task total.
