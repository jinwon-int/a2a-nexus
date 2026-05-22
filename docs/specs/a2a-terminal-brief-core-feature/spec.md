# Feature Spec: A2A Terminal Brief — Core Feature Definition

## Problem

Terminal Brief has been developed across multiple rounds (R6 R6 synthesis, R12/R13 parent-origin routing,
R15 all-hands structured metadata, R23/R25/R26/R27 sibling lanes) as an operational notification and
evidence-accumulation mechanism for parent-round dispatch closeout. Its design is documented across
contracts (`parent-terminal-brief-aggregation.md`, `terminal-semantics.md`, `broker-handoff-protocol.md`),
spec packages (`a2a-terminal-brief-parent-origin-routing/`, `a2a-terminal-brief-canary/`), broker source
(`terminal-brief-routing-contract.ts`), and multiple libero validation artifacts. However, no single
document treats **Terminal Brief as a core A2A feature** with unified definition of:
- the Team1 local lane path (same-broker child dispatch and Terminal Brief send);
- the Team2 Gwakga handoff path (cross-broker child projection);
- parent broker finalizer ownership and the no-local-send rule;
- acceptance matrix with concrete gates;
- approval boundaries and safety invariants.

This spec fills that gap by consolidating the six rounds of design decisions into one stable reference.

## User / operator stories

- As an operator dispatching a Team1-only round, I want Seoseo to own the parent round and send the
  Terminal Brief without involving Gwakga, so that Team2 resources are not consumed for Team1 work.
- As an operator dispatching a Team1+Team2 round, I want Seoseo to own the parent round while Gwakga
  relays Team2 child projections back to Seoseo, so that there is exactly one operator-facing
  Terminal Brief sender per round.
- As a Team1/Seoseo finalizer, I want to own the parent-round closeout decision for Team1-origin
  rounds, so that accountability is clear and there is no split-finalizer ambiguity.
- As a Team2/Gwakga worker, I want to produce terminal evidence for my Team2 child tasks and relay
  it to the parent broker's projection ledger, but I must NOT send my own parent-round Terminal Brief
  notification for parent-owned Team2 rows, so that operator-facing notification remains single-sourced.
- As an operator reviewing a round's Terminal Brief evidence, I want a predictable acceptance matrix
  so I can verify that every lane met its contractual obligations before finalizer closeout.

## Actors

| Actor | Broker ID | Team | Role in parent round |
| --- | --- | --- | --- |
| **Seoseo** | `seoseo` | `team1` | Parent/origin broker, finalizer of record for Team1-origin rounds |
| **Gwakga** | `gwakga` | `team2` | Handoff broker for Team2 child tasks; evidence relay only |
| **Parent broker** | varies | n/a | Broker that renders the aggregate Terminal Brief notification |
| **Origin broker** | varies | n/a | Broker that minted the parent round metadata |
| **Finalizer** | varies | n/a | Person or automated agent that renders the aggregate GO/NO-GO decision |
| **Worker** | varies | team1 or team2 | Execution surface that produces PR/Done/Block evidence |

> **Deterministic broker assignment:** In the current v1 symmetric contract, `originBrokerId` is the
> broker that minted `parentRoundId`. For Seoseo-initiated rounds, `originBrokerId = seoseo` and
> `parentBrokerId = seoseo`. For Gwakga-initiated rounds, `originBrokerId = gwakga` and
> `parentBrokerId = gwakga`. The "initiating broker is both parent and origin" invariant applies
> for both brokers — there is no asymmetric default.

## Core Terminal Brief semantics

### Four receipt levels (frozen at v0)

| Level | Name | Meaning | ACK-safe? |
| --- | --- | --- | --- |
| 1 | accepted-send | Provider accepted the send request (message id returned). Non-ACK lifecycle evidence. | No |
| 2 | requester-visible receipt | Message appeared in a GitHub issue/PR comment observable by the requesting system. | No |
| 3 | operator-visible receipt | Human operator explicitly confirmed seeing the Terminal Brief. | No (evidence) |
| 4 | terminal ACK | Terminal outbox ACK contract satisfied through an explicit ACK-safe evidence path. | Yes |

**Invariant:** `providerAccepted`, `sendStatus: accepted`, `sendStatus: sent`, and provider `messageId`
are always level 1 (accepted-send only). They are never level 2, 3, or 4. Terminal-outbox ACK mutation
requires explicit operator approval.

### Concise title format

Default known-total completed-worker title:

```
A2A Terminal Brief <상태>: <worker>(<n>/<N>)
```

Example: `A2A Terminal Brief 완료: yukson(4/7)` (known total=7).  
Unknown-total fallback: `A2A Terminal Brief 완료: yukson(2)` (no denominator).  
Non-completed status: `A2A Terminal Brief <상태>: <worker>(<n>/<N>)` — bounded status labels defined
by the parent contract.

Constraints:
- Maximum length: 80 characters.
- Forbidden content: task ids, child issue URLs, PR/Done/Block URLs, terminal evidence body,
  broker IDs (child, handoff, or otherwise), provider message ids, receipt status, ACK state,
  raw logs, secrets, private paths, runtime/bootstrap file names.
- Title source: parent broker aggregation ledger, not child broker local state.
- Title is NOT proof of: provider delivery, operator receipt, operator approval, or terminal-outbox ACK.

### Body/evidence separation

Title and body are separate fields. The title must not contain evidence body content, child issue
URLs, broker IDs, or ACK state. The body must not contain `terminalBriefTitle` or re-render the
round title as an evidence header. A body-only field with blank/fallback title is a projection error
and must fail closed.

## Team1 local lane path

### Route

When the parent broker `seoseo` dispatches a Team1-only round:

```
Seoseo (origin/parent)
  └─ mints parentRoundId, originBrokerId=seoseo, parentBrokerId=seoseo
  └─ assigns Team1 child tasks directly (no handoff)
  └─ each Team1 worker produces terminal PR/Done/Block evidence
  └─ Seoseo renders per-child Terminal Brief titles from its aggregation ledger
  └─ Seoseo is the sole operator-facing Terminal Brief sender
  └─ Gwakga is NOT involved
```

### Child dispatch metadata

Each Team1 child task must carry:

```json
{
  "parentRoundId": "<round-id>",
  "originBrokerId": "seoseo",
  "parentBrokerId": "seoseo",
  "parentRoundTotal": <lane-count>,
  "parentRoundOrder": <1-based-index>
}
```

### Terminal Brief send

For each terminal transition (done/pr/blocked) of a Team1 child:

1. Seoseo reads terminal evidence from the child task result.
2. Seoseo renders a concise title from its aggregation ledger.
3. Seoseo dispatches the notification through an OpenClaw-routed outbound lifecycle path
   (no direct Telegram Bot API or curl path).
4. The provider send success is recorded as accepted-send evidence (level 1), never as ACK.

### Fail-closed rules

| Condition | Response |
| --- | --- |
| Missing `parentRoundId` for Team1 child | Block — refuse dispatch |
| Missing `originBrokerId` | Block — refuse dispatch |
| `originBrokerId != seoseo` for Seoseo-initiated round | Block — origin mismatch |
| Gwakga receives Team1 parent metadata | Block — Team1 work must not reach Gwakga |
| Title exceeds 80 chars | Block — title must be truncated or notification deferred |

## Team2 Gwakga handoff path

### Route

When the parent broker `seoseo` dispatches a Team1+Team2 round:

```
Seoseo (origin/parent)
  ├─ mints parentRoundId, originBrokerId=seoseo, parentBrokerId=seoseo, parentRoundTotal=N
  ├─ assigns Team1 child tasks directly (see Team1 local lane path)
  └─ creates handoff envelope → Gwakga (handoffBrokerId=gwakga)
       for each Team2 child task, with metadata:
       {
         "parentRoundId": "<round-id>",
         "originBrokerId": "seoseo",
         "parentBrokerId": "seoseo",
         "handoffBrokerId": "gwakga",
         "parentRoundTotal": <lane-count>,
         "parentRoundOrder": <1-based-index>
       }
       └─ Gwakga receives handoff envelope
            ├─ creates child task as broker of record (brokerOfRecord=gwakga)
            ├─ assigns Team2 worker to produce terminal PR/Done/Block evidence
            └─ relays redacted terminal evidence BACK to Seoseo's projection ledger
               (NOT to its own aggregation ledger)
```

### Handoff envelope fields

| Field | Minted by | Copied? | Consumed by |
| --- | --- | --- | --- |
| `parentRoundId` | Seoseo (origin) | Yes — into envelope | Gwakga (handoff broker), Seoseo (projection) |
| `originBrokerId` | Seoseo (origin) | Yes — immutable | Gwakga, projection verifier |
| `parentBrokerId` | Seoseo (origin) | Yes — immutable | Gwakga (must relay evidence back to this broker) |
| `handoffBrokerId` | Seoseo (origin) | Yes — per child | Gwakga (identifies itself as handoff) |
| `parentRoundTotal` | Seoseo (origin) | Yes — immutable | Parent broker title renderer |
| `parentRoundOrder` | Seoseo (origin) | Yes — per child | Child broker, parent projection |
| `childTaskId` | Gwakga (child broker of record) | Not copied back | Parent projection ledger |
| `childIssueUrl` | Gwakga | Not copied back | Parent projection ledger |
| `terminalEvidenceUrl` | Gwakga | Not copied back | Parent projection ledger |

### Parent-owned Team2 rows: no-local-send requirement

**This is the critical ownership invariant:**

> For Team2 child tasks that are parent-owned (the parent round was minted by Seoseo), Gwakga
> must NOT send, render, update, retract, ACK, or otherwise dispatch its own operator-facing
> parent-round Terminal Brief notification. Gwakga's role is limited to:
> 1. Creating the child task as broker of record.
> 2. Producing redacted terminal evidence (PR/Done/Block).
> 3. Relaying that evidence to Seoseo's parent projection ledger.
>
> **Gwakga must never send a parent-round aggregate notification to any provider or outbound
> lifecycle path for a round where `originBrokerId != gwakga`.**

Enforcement:

| Condition | Rule | Fail-closed |
| --- | --- | --- |
| Gwakga detects `originBrokerId != gwakga` in handoff metadata | Gwakga must NOT render/send/update parent-round Terminal Brief | Block — Gwakga must reject parent-round send attempts for non-own rounds |
| Gwakga evidence relay to Seoseo succeeds | Seoseo renders the title from its own aggregation ledger | Normal path |
| Gwakga evidence relay to Seoseo fails | Gwakga may fall back to local operator notification as a failure-safety path, but the notification body MUST state it is a *relay failure notification*, NOT a parent-round Terminal Brief | Block — relay-failure fallback must not impersonate parent-round notification |
| Gwakga child task reaches terminal state | Evidence must be relayed to Seoseo BEFORE any local notification (if any) | Block — evidence must reach parent broker first |

### Handoff fail-closed rules

| Condition | Response |
| --- | --- |
| Handoff envelope missing `parentRoundId` | Block — refuse task creation |
| Handoff envelope missing `originBrokerId` | Block — refuse task creation |
| `originBrokerId == gwakga` but envelope originates from Seoseo | Block — origin mismatch |
| Gwakga child evidence relay fails | Block — fall back to local notification, mark projection `blocked` |
| Parentless projection (no matching parent round on Seoseo) | Block — `missing_parent` error |
| Gwakga sends parent-round notification for Seoseo-origin round | BLOCK — report ownership violation immediately |

## Parent broker finalizer ownership

### Finalizer assignment

For every parent round, exactly one broker is the **finalizer of record**. The finalizer is the
broker that minted `parentRoundId` and `originBrokerId`.

| Round origin | Finalizer | Finalizer broker ID |
| --- | --- | --- |
| Team1-origin (Seoseo) | Seoseo operator or automated finalizer | `seoseo` |
| Team2-origin (Gwakga) | Gwakga operator or automated finalizer | `gwakga` |

### Finalizer responsibilities

1. **Review lane evidence**: Collect all child lane terminal evidence (PR URLs, Done comments,
   Block markers) from the aggregation ledger.
2. **Run go/nogo matrix**: Verify all gates pass before closeout (see Acceptance matrix below).
3. **Render aggregate decision**: Post `GO`, `NO-GO`, or `BLOCKED` decision on the parent issue.
4. **Ensure no live-impact leak**: Confirm no unapproved deploy, restart, provider send, DB mutation,
   terminal-outbox ACK, release, or visibility change occurred.
5. **Verify runtime/bootstrap hygiene**: Confirm `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`,
   `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**` absent from branch diffs and artifact evidence.
6. **Close parent issue** (if `GO`) or document blockers (if `NO-GO`/`BLOCKED`).

### Finalizer exclusivity

No entity other than the assigned finalizer may:
- Close the parent issue.
- Render the aggregate GO/NO-GO/BLOCKED decision.
- Claim parent-round closeout authority.

If the assigned finalizer becomes unavailable, a new finalizer must be explicitly assigned by
operator approval, not by silent broker failover. The new assignment must be documented in
a parent issue comment.

### Team1 finalizer (Seoseo) closeout handoff

When all Team1 and Team2 child lanes have reached a terminal state, Seoseo's finalizer
produces a closeout handoff packet that includes:

```json
{
  "finalizerId": "seoseo",
  "parentRoundId": "<runId>",
  "aggregateDecision": "GO|NO_GO|BLOCKED",
  "laneStatuses": {
    "<worker-id>": { "status": "pr|done|blocked|cancelled", "evidenceUrl": "<url>" }
  },
  "safetyConfirmed": true,
  "hygieneConfirmed": true
}
```

## No-local-send requirement for parent-owned Team2 rows

This is the central ownership invariant for cross-broker Terminal Brief routing.

### Definition

**Parent-owned Team2 rows** are Team2 child tasks created through a handoff envelope where
`originBrokerId` and `parentBrokerId` equal the initiating broker (Seoseo for Team1-origin rounds),
and the child broker of record is `gwakga`.

### Requirement

For parent-owned Team2 rows, Gwakga must **not** perform any local send, update, retract, or ACK
of the parent-round aggregate Terminal Brief notification. Gwakga's Terminal Brief responsibilities
are limited to:

1. **Child terminal evidence production**: Produce PR/Done/Block evidence for the child task.
2. **Evidence relay**: Project redacted evidence to Seoseo's parent aggregation ledger.
3. **Relay-failure fallback**: If evidence relay to Seoseo fails, Gwakga may notify its own operator
   about the relay failure. The notification must be clearly labeled as a relay failure notice and
   must not impersonate the parent-round Terminal Brief.

### Enforcement

| Gate | Pass condition | Fail-closed |
| --- | --- | --- |
| Parent-owned Team2 rows reach terminal state | Evidence is relayed to Seoseo before any local notification | Block if local notification precedes relay |
| Gwakga relay to Seoseo succeeds | Seoseo renders concise title from its ledger | Normal path |
| Gwakga relay to Seoseo fails but Gwakga falls back to local notification | Local notification says "Terminal Brief relay failure" not "Terminal Brief" | Block if fallback claims parent-round ownership |
| Non-own round detection | Gwakga detects `originBrokerId != gwakga` and must not send parent-round Terminal Brief | Block — reject parent-round send attempts |
| Symmetric reverse (Gwakga-origin round) | Seoseo follows the same no-local-send rules for parent-owned Team1 rows through Seoseo handoff | Block if Seoseo sends parent-round notification for Gwakga-origin round |

### Network of ownership

```
Team1-origin round (Seoseo finalizer):
  Team1 children → Seoseo renders Terminal Brief (local send OK)
  Team2 children → Gwakga relays evidence back → Seoseo renders Terminal Brief (Gwakga: no local send)

Team2-origin round (Gwakga finalizer):
  Team2 children → Gwakga renders Terminal Brief (local send OK)
  Team1 children → Seoseo relays evidence back → Gwakga renders Terminal Brief (Seoseo: no local send)
```

**Invariant:** The broker matching `parentBrokerId` is the only broker that may render and dispatch
the parent-round aggregate Terminal Brief notification. The other broker is a child/handoff broker
and must not render or dispatch that round's aggregate notification.

## Acceptance matrix

### Gate definitions

| # | Gate | Required condition | Evidence source | Fail-closed |
| --- | --- | --- | --- | --- |
| G1 | Parent metadata propagation | Every child task (Team1 direct + Team2 handoff) carries `parentRoundId`, `originBrokerId`, `parentBrokerId`, `parentRoundTotal`, `parentRoundOrder`. Handoff children also carry `handoffBrokerId`. No field is missing, rewritten, or inconsistent across children. | Broker task query, lane issue bodies, handoff envelope inspection | Block if any field missing or mismatched |
| G2 | Four-case routing invariant | The four routing cases (Seoseo-Team1-only, Seoseo-Team1+2, Gwakga-Team2-only, Gwakga-Team1+2) each produce correct parent/origin/handoff/child-broker assignments. `initiatingBroker == originBrokerId == parentBrokerId` for standard operator-facing cases. | `contracts/a2a/parent-terminal-brief-aggregation.md` v1 four-case matrix, `fixtures/contract/terminal-brief-parent-origin-routing.json` | Block if any case violates the invariant |
| G3 | Concise title format | Each per-child terminal transition renders `A2A Terminal Brief <상태>: <worker>(<n>/<N>)` with known total, or `<상태>: <worker>(<n>)` unknown-total fallback. Title ≤80 chars; forbidden content absent. | Title evidence from parent aggregation ledger or test fixture | Block if title exceeds 80 chars or contains forbidden content |
| G4 | Body/evidence separation | Title and body are separate fields. Title has no evidence content, URLs, broker IDs, or ACK state. Body has no `terminalBriefTitle`. | Projection schema test, notification adapter test | Block if concatenated or leaking |
| G5 | Parent-only notification ownership | Only the broker matching `parentBrokerId` may render/dispatch parent-round aggregate Terminal Brief. Handoff/child brokers must not send their own parent notification. | Broker routing contract test (`terminal-brief-routing-contract.ts`), handoff scenario tests | Block if handoff broker sends parent notification |
| G6 | No-local-send for parent-owned rows | Gwakga does NOT render/send parent-round Terminal Brief for Seoseo-origin rows. Seoseo does NOT render/send Gwakga-origin parent-round Terminal Brief. | Cross-broker handoff test, safety matrix test | Block if any local send detected for non-own round |
| G7 | Receipt/ACK boundary | Provider accepted-send is level 1 (non-ACK). No contract or code path promotes accepted-send to ACK. Four-level receipt vocabulary is frozen at v0. | `contracts/a2a/terminal-semantics.md`, `contracts/compatibility/terminal-evidence-ack-boundary.md`, `fixtures/terminal-evidence/accepted-send-non-ack.json` | Block if promotion detected or v0 freeze violated |
| G8 | Broker finalizer assignment | Exactly one broker is the finalizer of record (matching `originBrokerId`). No other entity closes the parent issue or renders the aggregate decision. | Parent issue closeout comment, finalizer handoff packet | Block if non-assigned finalizer acts |
| G9 | All lanes terminal | Every child lane has reached `done`, `pr`, `blocked`, or `cancelled`. | Broker `/tasks` query, lane issue comments | Block if any lane non-terminal |
| G10 | Evidence completeness | Every terminal lane has PR URL, Done comment, or Block comment with redacted evidence. | Lane issue inspection | Block if missing |
| G11 | No live-impact leak | No unapproved deploy, restart, provider send, DB mutation, terminal-outbox ACK, release, visibility change, force-push, or secret rotation occurred. | Lane evidence, safety confirmation block | Block if any detected |
| G12 | Runtime/bootstrap hygiene | Branch diffs, PR bodies, issue comments, and artifact evidence exclude `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`. | Pre-PR guard scan, artifact inspection | Block if files found |
| G13 | Redacted evidence | No secrets, host-specific private paths, token-shaped literals, raw session dumps, or runtime context files in evidence. | Evidence review | Block if identified |
| G14 | Approval separation | No evidence entry claims approval authority. PR/Done/Block markers are evidence only, not operator approval. | Comment review | Block if approval claimed |

### Aggregate decision

| All gates pass | **GO** — close parent issue, record closeout evidence |
| --- | --- |
| One or more fail (no unsafe) | **NO-GO** — document blockers, wait for resolution |
| Unsafe condition detected (G11, G12, G13, or G14 violation) | **BLOCKED** — escalate to operator, do not close |

## Safety and approval boundaries

### Prohibited actions (requiring separate explicit operator approval)

| Action | Approval requirement |
| --- | --- |
| Production deploy of Gateway, broker, or worker | Fresh operator approval comment naming the exact deploy scope and target |
| Gateway/broker/worker restart or reload | Operator approval comment naming the service and window |
| Live provider/Telegram canary or notification send | Operator approval naming the exact task id, round id, and provider target |
| Production DB mutation, prune, or migration | Operator approval naming the exact mutation scope |
| Terminal-outbox ACK mutation or replay | Operator approval with terminal outbox row ids |
| Historical outbox replay | Operator approval with replay scope justification |
| Release, tag, or npm publish | Operator approval naming the exact version |
| Secret rotation, movement, or disclosure | Operator approval with secret reference (not value) |
| Repository visibility change | Operator approval |
| Force-push or history rewrite | Operator approval |

### This spec does NOT authorize

This spec defines the Terminal Brief core feature contract for source-only documentation, tests,
and validation. It does not authorize any of the actions listed in the prohibited actions table
above. Each PR or validation lane that references this spec must separately confirm that no
prohibited action was taken.

### Secrets and private data

No secrets, bot tokens, provider URLs, host-specific paths, Telegram identifiers, raw session dumps,
runtime/bootstrap context files, or production outbox/DB contents are permitted in spec definitions,
fixtures, tests, validation evidence, or issue/PR comments. Evidence must be redacted and bounded.

### Broker foreground liveness

Spec, fixture, and validation work runs in detached or read-only mode. Implementation rounds should
use subagents, TaskFlow, or A2A evidence workers with the finalizer only coordinating and reporting.
No round defined by this spec should run as a long broker Telegram/DM foreground session.

### Runtime/bootstrap and artifact hygiene gate

Before PR creation or evidence publication, fail closed if any of the following OpenClaw
runtime/bootstrap context files would enter the branch diff, PR body, issue comments,
or artifact evidence:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Offending paths must be reported exactly with repo-relative or artifact-relative paths.

## Verification

### Conformance checks

| Check | Command | Covers |
| --- | --- | --- |
| Terminal Brief routing guard | `npm run check:terminal-brief-routing` | Four receipt levels, allow/forbidden routes, providerAccepted non-ACK invariant |
| Message ID ACK boundary | `npm run check:message-id-ack-boundary` | Provider accepted-send is level 1, never ACK |
| Contract fixture conformance | `npm run check:contract-fixtures` (`test:conformance`) | Parent-origin routing fixture, parent aggregation fixture, terminal brief canary fixture |
| Team1 plane gates | `npm run check:team1-yukson-plane-gates` | Cross-cutting plane gate validation |
| Full release gate | `npm run check` | All layout, conformance, package, and readiness checks |

### Hygiene scan

```bash
find . \( -path './.git' -o -path './node_modules' -o -path './packages/*/node_modules' \) \
  -prune -o \( -name AGENTS.md -o -name SOUL.md -o -name USER.md -o -name TOOLS.md -o \
  -name HEARTBEAT.md -o -name IDENTITY.md -o -path './.openclaw/*' \) -print
git status --short --ignored
```

## Residual risk

| Risk | Description | Mitigation | Fail-closed |
| --- | --- | --- | --- |
| Metadata drift | Round spec or handoff envelope adds/renames/removes fields without updating fixtures | Fixture conformance tests in CI; sibling lane cross-check | Block if fixture mismatch |
| Title format regression | Title exceeds 80 chars or contains forbidden content | Max-length and forbidden-content assertion in conformance test | Block if regression |
| No-local-send enforcement gap | Gwakga sends parent-round Terminal Brief for Seoseo-origin round due to missing guard | Routing contract test, handoff scenario tests, positive/negative fixture | BLOCK if detected |
| Cross-broker relay failure | Gwakga evidence relay to Seoseo fails; fallback may impersonate parent-round notification | Explicit relay-failure labeling requirement; projection fails `blocked` | Block if fallback claims ownership |
| Finalizer handoff ambiguity | Seoseo unavailable and no explicit handoff to new finalizer | Documented assignment rule: new finalizer requires operator approval comment | Block without approval |
| Runtime/bootstrap hygiene drift | New contributor or tooling introduces guard paths | Pre-PR scan; public-readiness scan in CI | Block if detected |

## Evidence contract

Each PR or validation lane referencing this spec must produce evidence that includes:

- Repo-relative path to this spec document.
- Verification commands run and their exit codes.
- Confirmation that all gates in the acceptance matrix are evaluated.
- Confirmation that no prohibited action was taken.
- Runtime/bootstrap hygiene scan result.
- Safety confirmation block covering all prohibited actions.
- Residual risk notes with any new risks discovered during validation.
- GO/NO-GO/BLOCKED decision with justification.

## Rollback / failure handling

- **Failure mode**: Gate violation, metadata mismatch, no-local-send violation, hygiene leak,
  or prohibited action detected.
- **Restore**: Revert source changes (git revert of offending PR). Projection metadata entries
  become `blocked` or `conflict` — do not delete or overwrite.
- **Safe cleanup**: Reverted PR diff, redacted evidence, and projection rollback metadata are
  safe to produce without additional approval.
- **Requires approval**: Re-running a dispatched round, replaying historical evidence, or
  reopening a closed parent issue requires fresh operator approval naming the exact scope.

## Reference map

| Artifact | Path | Purpose |
| --- | --- | --- |
| Core feature spec (this document) | `docs/specs/a2a-terminal-brief-core-feature/spec.md` | Canonical Terminal Brief core feature definition |
| Parent-origin routing spec | `docs/specs/a2a-terminal-brief-parent-origin-routing/spec.md` | Four-case routing contract |
| Canary spec | `docs/specs/a2a-terminal-brief-canary/spec.md` | Live-canary hardening protocol |
| Parent aggregation contract | `contracts/a2a/parent-terminal-brief-aggregation.md` | Aggregation lifecycle, projection fields, title semantics |
| Terminal semantics contract | `contracts/a2a/terminal-semantics.md` | Result types, receipt levels, ACK boundary |
| Broker handoff protocol | `contracts/a2a/broker-handoff-protocol.md` | Envelope shape, peer permissions, evidence relay |
| Team1 dispatch wrapper runbook | `docs/specs/a2a-team1-dispatch-wrapper/runbook.md` | Team1 dispatch command, metadata propagation, finalizer handoff |
| Team2/Gwakga onboarding runbook | `packages/broker/docs/team2-gwakga-worker-onboarding-retargeting.md` | Team2 worker registration and retargeting |
| Routing contract source | `packages/broker/src/core/terminal-brief-routing-contract.ts` | Pure broker-side guard for transport routes |
| Parent-origin routing fixture | `fixtures/contract/terminal-brief-parent-origin-routing.json` | Machine-readable four-case invariant |
| Parent aggregation fixture | `fixtures/contract/parent-terminal-brief-aggregation.json` | Projection field requirements |
| Accepted-send non-ACK fixture | `fixtures/terminal-evidence/accepted-send-non-ack.json` | Receipt-level 1 non-ACK boundary |
| R6 synthesis | `docs/r6-terminal-brief-openclaw-routing-synthesis.md` | Historical routing synthesis and unsafe bypass patterns |
