# Team1/yukson R13 compact Terminal Brief acceptance matrix

Issue: a2a-plane#305 (a2a-plane#305, internal tracker private)
Parent: [a2a-broker#607](https://github.com/jinwon-int/a2a-broker/issues/607)
Primary guard: [a2a-broker#598](https://github.com/jinwon-int/a2a-broker/issues/598)
Run: `a2a-r13-terminal-brief-realround-20260514T013556Z`
Origin broker/finalizer: `seoseo`
Lane: Team1/yukson
Order: 4/7
Round: A2A R13 — compact Terminal Brief real-round guard and aggregation verification
Snapshot: `2026-05-14T01:37Z`

This is the R13 Team1/yukson acceptance matrix for the compact Terminal Brief real-round guard and aggregation verification. It validates parent metadata propagation, compact title format with known total, Seoseo-origin cross-broker routing, receipt/ACK boundary preservation, and runtime/bootstrap hygiene. It does not deploy or restart Gateway/broker/worker, send a live provider/Telegram canary beyond normal A2A task completion notifications, mutate production databases or terminal-outbox ACK rows, perform manual Terminal Brief ACK/replay or historical outbox replay, change secrets or repository visibility, publish a release/tag, rewrite history, force-push, or execute approval without fresh explicit operator approval. Provider accepted/message-id evidence is provider-accepted evidence only, never read/visibility/terminal ACK.

## Target compact Terminal Brief title

As order 4 of 7 in this round:

```
A2A Terminal Brief 완료: yukson(4/7)
```

This follows the known-total format defined in `contracts/a2a/parent-terminal-brief-aggregation.md` (Concise title semantics). The denominator is not a global constant: it is the broker-assigned child task total for the parent round / dispatch scope. R13 uses `/7` because Seoseo assigned seven child tasks in this specific round. The compact title is per-child terminal evidence sent/emitted to the origin/commanding broker, not proof of provider delivery, operator receipt, approval, or terminal-outbox ACK.

## Evidence snapshot

| Lane / source | Required evidence for R13 | Snapshot evidence | Validation result |
| --- | --- | --- | --- |
| Parent dispatch — [a2a-broker#607](https://github.com/jinwon-int/a2a-broker/issues/607) | Round lane list, safety gates, known child total=7, Seoseo finalizer. Parent scope: compact Terminal Brief real-round guard and aggregation verification. | Parent issue body records scope, safety boundaries, and known total. Child lane Start evidence posted across 7 lanes. | Pass for dispatch context only; does not prove activation or aggregation. |
| Primary guard — [a2a-broker#598](https://github.com/jinwon-int/a2a-broker/issues/598) | Fail-closed guard: cross-broker child payloads must include `parentRoundId`, `originBrokerId`, parent total/order metadata, and explicit `crossBrokerHandoff` for handoff children. | Issue open with requirement definition; R13 dispatch enforces parent metadata. | Pass for contract/guard definition; runtime enforcement depends on broker implementation. |
| Team1/yukson lane — a2a-plane#305 (a2a-plane#305, internal tracker private) | This acceptance matrix: update or verify contracts/runbooks for parent metadata, compact title format, origin-broker routing symmetry. | PR/Done evidence from this validation document; local test pass results. | Pass for acceptance matrix shape and local validation. |
| Brokers/sibling lanes | Team1/Team2 remain at Start or PR/Done/Block evidence at lane issues. | Known from parent broker aggregation view; individual lane issues across a2a-broker, a2a-plane, openclaw-plugin-a2a, a2a-docker-runner. | Open until each lane publishes terminal evidence. |

## Acceptance gate checklist

| Gate | Pass condition | Fail / NO-GO condition | Current status |
| --- | --- | --- | --- |
| G1. Parent aggregation metadata in child dispatch | Every R13 child carries `parentRoundId=a2a-r13-terminal-brief-realround-20260514T013556Z`, `originBrokerId=seoseo`, `parentRoundTotal=7`, and order field. Team2 handoff children carry explicit `crossBrokerHandoff` tuple. | Missing, rewritten, or inconsistent metadata across children; handoff metadata cannot be joined to parent round. | Pass: parent-terminal-brief-aggregation.md contract defines metadata lifecycle; R13 dispatch enforces parent metadata. |
| G2. Per-child compact title — dynamic assigned total | Each child terminal transition (`succeeded`/`failed`/`cancelled`/`blocked`) emits/sends a compact Terminal Brief to the origin/commanding broker using `A2A Terminal Brief <상태>: <worker>(n/<assignedChildTaskTotal>)`. For R13, `<assignedChildTaskTotal>` is 7 because the broker assigned seven child tasks. Title ≤80 chars; forbidden content excluded. | Title exceeds 80 chars; treats 7 as a global constant; uses wrong assigned total/order; includes task ids, child issue URLs, evidence URLs, broker IDs, receipt/ACK status, or runtime/bootstrap file names. | Pass: contract defines known-total format with examples; target title `A2A Terminal Brief 완료: yukson(4/7)` is within constraints for this R13 dispatch. |
| G3. Seoseo-origin parent Terminal Brief ownership | Parent broker `seoseo` renders the aggregate Terminal Brief title for the R13 round. Handoff/execution brokers (Gwakga) must not send their own parent round notification. | Gwakga sends a Seoseo-origin parent notification; title ownership ambiguous or split across brokers. | Pass: parent-terminal-brief-aggregation.md sections "Parent-only notification ownership" and symmetric rules define ownership by `originBrokerId`. |
| G4. Body/evidence separation | Title and body are separate fields. Title contains no evidence body content, child issue URLs, broker IDs, or ACK state. Body does not contain `terminalBriefTitle`. | Concatenated title+body block; title leaking evidence content; body-only notification with blank title. | Pass: contract Body/evidence separation section defines 4 gates; fixture proves separate rendering. |
| G5. Receipt/ACK boundary | 4-level receipt vocabulary is frozen at v0. Provider accepted-send is non-ACK. Terminal Brief title, GitHub comments, PR/Done/Block URLs remain evidence inputs, not receipt/ACK/approval. | Any contract change or code path promotes `providerAccepted` or `messageId` or Terminal Brief title to ACK, conflation of receipt levels, or terminal-outbox ACK without operator approval. | Pass: terminal-semantics.md v0 freeze; accepted-send non-ACK fixture; prior validation matrices enforce separation. |
| G6. Symmetric origin-broker routing | Origin-based routing: Seoseo-origin rounds owned by Seoseo; Gwakga-origin rounds owned by Gwakga (for future rounds). Metadata encodes direction explicitly. | Code or docs special-case Seoseo; Gwakga owns a Seoseo-origin parent; or Seoseo owns a Gwakga-origin parent. | Pass: parent-terminal-brief-aggregation.md v1 includes symmetric sections; R12 changes proved symmetric contract. |
| G7. Post-dispatch metadata verification | Post-dispatch verifier asserts `parentRoundId`, `originBrokerId`, `parentRoundTotal`, and `crossBrokerHandoff` (when applicable) on broker task snapshots within 30–60 seconds. | Verifier missing, window exceeded, or metadata mismatch not detected. | Open: depends on broker lane terminal evidence; documentation verified. |
| G8. Runtime/bootstrap hygiene | No `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` in branch diff, PR body, issue comments, or artifact evidence. | Any guard path detected in branch, PR, comment, or artifact. | Pass (pre-publication): scan confirmed guard paths absent. |
| G9. Fresh explicit operator approval for live actions | No deploy/restart/reload, live canary, DB mutation, ACK/replay, secret/visibility change, release, force-push, or approval execution without fresh explicit operator approval. | Any live-impact action executed without documented approval. | Pass: no live action was taken by this lane. |

## GO/NO-GO decision matrix

| Aggregate state | Required gates | Allowed closeout |
| --- | --- | --- |
| `GO for acceptance matrix` | G1–G4, G6 pass with linked contract/fixture/validation evidence; G5 receipt boundary documented; G7 documented (broker-specific); G8 hygiene clean; G9 safety confirmed. | PR/Done evidence may say the R13 acceptance matrix is documented and validated; activation/aggregation remains parent-broker-gated. |
| `GO_CANDIDATE / Needs operator approval` | G1–G6 pass, G7 verifier documented, G8 clean, and G9 not violated, but parent broker aggregation has not yet completed all lane closeouts. | PR/Done evidence may request finalizer review; must not claim R13 final completion or authorize live actions. |
| `NO-GO / Waiting` | Any required gate has Start-only/missing evidence, receipt/ACK boundaries disputed, metadata inconsistent, or hygiene scan failing. | Current state for lanes without terminal evidence. |
| `BLOCK` | Any safety gate violated: missing parent metadata across children, unapproved live canary/ACK/DB mutation/secret change/release/visibility change, runtime/bootstrap context files entering branch or artifacts, or raw private evidence leak. | Stop and report exact offending issue, gate violation, or repo-relative paths. |

### Current aggregate decision

**Decision: `GO_CANDIDATE / Needs finalizer closeout` for the acceptance matrix. This lane verifies the per-child Terminal Brief semantics for yukson(4/7): every child terminal transition must emit/send its own compact Terminal Brief to the origin/commanding broker. Parent/final summary closeout is separate from these per-child terminal emits.**

The R13 Team1/yukson acceptance matrix is documented and locally validated. Parent metadata propagation, compact title format, Seoseo-origin routing symmetry, and receipt/ACK boundary are verified from existing contracts, fixtures, and validation artifacts. The primary guard (a2a-broker#598) fail-closed condition is met: `parentRoundId`, `originBrokerId`, and known total metadata are present in the R13 dispatch.

For this lane, the compact per-child Terminal Brief title is `A2A Terminal Brief 완료: yukson(4/7)`. The `/7` denominator is the R13 broker-assigned child task total, not an absolute/global value. This per-child terminal emit is separate from any parent/final summary.

## R13 residual risk matrix

| Risk area | Required R13 proof | Current risk posture | Fail-closed condition |
| --- | --- | --- | --- |
| Parent metadata propagation | Every child includes `parentRoundId=a2a-r13-terminal-brief-realround-20260514T013556Z`, `originBrokerId=seoseo`, `parentRoundTotal=7`, and order. Team2 handoff children include explicit `crossBrokerHandoff` tuple. | Verified via contract and dispatch definition; runtime enforcement depends on broker implementation. | Dispatch missing any required field, rewrites origin, or accepts partial metadata across lanes. |
| Compact title correctness | Per-child titles follow known-total format with a dynamic denominator sourced from broker parent-round assignment metadata. For R13 that assigned total is 7. | Contract defines format; target title `A2A Terminal Brief 완료: yukson(4/7)` is documented and within constraints. | Title exceeds 80 chars, contains forbidden content, treats denominator as a global constant, or uses wrong assigned total/order. |
| Seoseo-origin parent ownership | Parent Terminal Brief owner is `seoseo` (origin broker). Gwakga handoff/execution lane must not render its own parent notification. | Contract and symmetric rules define origin-based ownership. | Gwakga renders Seoseo-origin parent notification; ownership ambiguous or split. |
| Receipt/ACK separation | Provider accepted-send, message ID, GitHub comments, Terminal Brief titles, and PR/Done/Block URLs remain evidence inputs only, not receipt/ACK/approval. | Frozen contract and fixtures; no live canary or ACK attempted by this lane. | Any `accepted`, `sent`, provider `messageId`, GitHub comment, or Terminal Brief title promoted to receipt, ACK, or approval. |
| Replay/stale suppression | Same origin/handoff/evidence tuple is idempotent; historical outbox rows not replayed; no duplicate parent Terminal Brief rows. | Not executed in this lane; approval-gated future work only. | Duplicate projection, stale/backlog replay, terminal-outbox ACK mutation, or retry from historical rows without fresh explicit operator approval. |
| Runtime/bootstrap hygiene | Branch diff, PR body, issue comments, and artifact evidence exclude secrets, host-private paths, raw session dumps, provider targets, and OpenClaw runtime/bootstrap context. | Pre-publication scan confirms guard paths absent. | Any context file or `.openclaw/**` path enters branch or artifacts; report exact repo-relative paths and Block. |

## 7-child parent round title proof (synthetic, no-live)

The following table illustrates the synthetic title format for the seven children assigned in the R13 round. The denominator comes from this round's broker assignment count; another round may have a different denominator. No provider send, DB mutation, or terminal-outbox ACK was performed.

| Order | Worker | Team | Broker of record | Title |
| --- | --- | --- | --- | --- |
| 1 | `n/a` | Team1 | `seoseo` | `A2A Terminal Brief 완료: n/a(1/7)` |
| 2 | `n/a` | Team1 | `seoseo` | `A2A Terminal Brief 완료: n/a(2/7)` |
| 3 | `n/a` | Team1 | `seoseo` | `A2A Terminal Brief 완료: n/a(3/7)` |
| 4 | `yukson` | Team1 | `seoseo` | `A2A Terminal Brief 완료: yukson(4/7)` |
| 5 | `n/a` | Team2 | `gwakga` (projected) | `A2A Terminal Brief 완료: n/a(5/7)` |
| 6 | `n/a` | Team2 | `gwakga` (projected) | `A2A Terminal Brief 완료: n/a(6/7)` |
| 7 | `n/a` | Team2 | `gwakga` (projected) | `A2A Terminal Brief 완료: n/a(7/7)` |

Title constraints verified for every row:
- Source: parent broker (`seoseo`) aggregation ledger, not child issue body or child broker local state.
- Maximum length: ≤80 characters.
- Forbidden content: no task ids, child issue URLs, PR/Done/Block URLs, evidence body, child broker ID, handoff broker ID, provider message ID, receipt state, ACK state, raw logs, secrets, private paths, or runtime/bootstrap file names.
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

Guard scan performed at snapshot time on branch `a2a-patch-20260514-013721-a2a-r13-terminal-brief-realround-20260514T013556Z-04-yukson`:

Result: **PASS** — no guard paths detected in branch diff or staged changes.

## Local validation commands

```bash
# Check layout
npm run check:layout

# Run terminal-brief routing check
npm run check:terminal-brief-routing

# Run team1-yukson plane gates validation
npm run check:team1-yukson-plane-gates

# Run message-id ACK boundary check
npm run check:message-id-ack-boundary

# Run contract fixture conformance
npm run check:contract-fixtures

# Hygiene scan
find . \( -path './.git' -o -path './node_modules' -o -path './packages/*/node_modules' \) -prune -o \
  \( -name AGENTS.md -o -name SOUL.md -o -name USER.md -o -name TOOLS.md -o \
     -name HEARTBEAT.md -o -name IDENTITY.md -o -path './.openclaw/*' \) -print
git status --short --ignored
```

## Closeout boundary

This lane publishes PR evidence for the acceptance matrix document. It must not claim R13 activation GO, live canary authorization, deploy/reload approval, terminal ACK/read receipt, or source-public/visibility approval. It also must not treat `/7` as a global constant; it is only the R13 broker-assigned child task total.
