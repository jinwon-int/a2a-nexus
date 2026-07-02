# Terminal Brief Core Contract v1

> **v1 (2026-05-22):** This contract consolidates Terminal Brief as a core A2A feature. It is the
> concise reference for Team1 and Team2 dispatches. Detailed depth lives in the feature spec at
> `docs/specs/a2a-terminal-brief-core-feature/spec.md` and sibling contracts listed below.
>
> **v0 Freeze (2026-05-09):** Result types (Done, PR, Block), the four receipt levels, and the
> accepted-send non-ACK boundary are frozen. No new states, result types, or receipt levels may
> be added without a v0→v1 plan.

## Reference map (detailed contracts)

| Domain | Document | Path |
| --- | --- | --- |
| Feature spec (comprehensive) | Core feature definition | `docs/specs/a2a-terminal-brief-core-feature/spec.md` |
| Terminal result semantics | Receipt levels, ACK boundary | `contracts/a2a/terminal-semantics.md` |
| Parent aggregation lifecycle | Projection fields, symmetric rules | `contracts/a2a/parent-terminal-brief-aggregation.md` |
| Broker handoff protocol | Envelope shape, peer permissions | `contracts/a2a/broker-handoff-protocol.md` |
| GitHub evidence projection | Manifest-bound comment model | `contracts/a2a/github-evidence-projection.md` |
| ACK boundary compatibility | Accepted-send non-ACK fixture | `contracts/compatibility/terminal-evidence-ack-boundary.md` |
| **Adapter receipt capability** | **Non-OpenClaw/Hermes/spool adapter receipt levels, produced/spooled/provider-only non-ACK boundary** | **`contracts/a2a/adapter-receipt-capability.md`** |
| Parent-origin routing spec | Four-case routing contract | `docs/specs/a2a-terminal-brief-parent-origin-routing/spec.md` |
| Canary spec | Live-canary hardening protocol | `docs/specs/a2a-terminal-brief-canary/spec.md` |

---

## 1. Title format

### Default (known total)

```
A2A Terminal Brief <상태>: <worker>(<상태> <n>/<N>)
```

Example: `A2A Terminal Brief 완료: worker-delta(완료 3/7)`

### Unknown-total fallback

```
A2A Terminal Brief <상태>: <worker>(<상태> <n>)
```

Example: `A2A Terminal Brief 완료: worker-delta(완료 2)` (no denominator)

### Non-completed status

`<상태>` uses bounded status labels defined by the parent contract (e.g., `진행중`, `차단됨`, `취소됨`).

### Constraints

| Rule | Value |
| --- | --- |
| Max length | 80 characters |
| Forbidden title content | Task IDs, child issue URLs, PR/Done/Block URLs, terminal evidence body, child/handoff broker IDs, provider message IDs, receipt or ACK state, raw logs, secrets, private paths, runtime/bootstrap file names |
| Title source | Parent broker aggregation ledger only, never child broker local state |
| Title is NOT proof of | Provider delivery, operator receipt, operator approval, terminal-outbox ACK |

---

## 2. Ownership matrix

### Four routing cases

| Case | Initiator | Scope | Parent/origin broker | Execution path | Operator-facing sender |
| --- | --- | --- | --- | --- | --- |
| 1 | `broker-alpha` | Team1 only | `broker-alpha` | Team1 local only | `broker-alpha` |
| 2 | `broker-alpha` | Team1 + Team2 | `broker-alpha` | Team1 local + Team2 handoff through `broker-beta` | `broker-alpha` |
| 3 | `broker-beta` | Team2 only | `broker-beta` | Team2 local only | `broker-beta` |
| 4 | `broker-beta` | Team1 + Team2 | `broker-beta` | Team2 local + Team1 handoff through `broker-alpha` | `broker-beta` |

### Finalizer assignment

| Round origin | Finalizer | Finalizer broker ID |
| --- | --- | --- |
| Team1-origin (broker-alpha) | broker-alpha operator or automated finalizer | `broker-alpha` |
| Team2-origin (broker-beta) | broker-beta operator or automated finalizer | `broker-beta` |

**Invariant:** The broker matching `parentBrokerId` (which equals `originBrokerId` for standard operator-facing cases) is the only broker that may render and dispatch the parent-round aggregate Terminal Brief notification. The other broker is a child/handoff broker and must not render or dispatch that round's aggregate notification.

### Network of ownership

```
Team1-origin round (broker-alpha finalizer):
  Team1 children → broker-alpha renders Terminal Brief (local send OK)
  Team2 children → broker-beta relays evidence back → broker-alpha renders Terminal Brief (broker-beta: no local send)

Team2-origin round (broker-beta finalizer):
  Team2 children → broker-beta renders Terminal Brief (local send OK)
  Team1 children → broker-alpha relays evidence back → broker-beta renders Terminal Brief (broker-alpha: no local send)
```

---

## 3. Parent-owned handoff metadata

### Fields (minted by origin broker, immutable after mint)

| Field | Description | Required in handoff? |
| --- | --- | --- |
| `parentRoundId` | Stable round ID minted by origin broker | Yes |
| `originBrokerId` | Broker that created the parent round | Yes |
| `parentBrokerId` | Broker rendering the aggregate notification | Yes |
| `handoffBrokerId` | Broker receiving the child handoff | Yes (for cross-broker children) |
| `parentRoundTotal` | Total child lanes in the round (if known) | Yes |
| `parentRoundOrder` | 1-based lane order for this child | Yes |

### No-local-send rule (critical ownership invariant)

> **broker-beta must never send a parent-round aggregate notification for a round where `originBrokerId != broker-beta`.**
> **broker-alpha must never send a parent-round aggregate notification for a round where `originBrokerId != broker-alpha`.**

Enforcement:
- broker-beta detects `originBrokerId != broker-beta` in handoff metadata → must NOT render/send/update parent-round Terminal Brief → Block if attempted
- Evidence relay must reach the parent broker's projection ledger **before** any local notification (if any)
- Relay-failure fallback must be explicitly labeled as "Terminal Brief relay failure", never as a parent-round Terminal Brief

### Body/evidence separation

- Title and body are stored, transmitted, and rendered as **separate fields** (never concatenated)
- Title must NOT contain evidence URLs, broker IDs, ACK state, or body content
- Body must NOT contain `terminalBriefTitle`
- Body-only notification with blank/fallback title is a projection error → **fail closed**

---

## 4. ACK eligibility rules

### Four receipt levels (frozen at v0)

| Level | Name | ACK-safe? |
| --- | --- | --- |
| 1 | accepted-send | No |
| 2 | requester-visible receipt (GitHub comment) | No |
| 3 | operator-visible receipt | No (evidence) |
| 4 | terminal ACK (explicit ACK-safe evidence path) | Yes |

### Non-ACK invariants

| Item | Status |
| --- | --- |
| `providerAccepted`, `providerMessageId`, `sendStatus: accepted`, `sendStatus: sent` | Always level 1 (accepted-send only, **never** ACK) |
| GitHub issue/PR comment | Requester-visible evidence ledger entry (level 2), **never** ACK, read receipt, visibility proof, or operator approval |
| PR/Done/Block markers on issues | Evidence only; **never** operator approval |
| Terminal Brief title | Evidence identifier; **never** receipt, ACK, or approval |

### ACK eligibility (level 4)

Terminal-outbox ACK mutation requires **one** of:
- `manual_operator_receipt` — human operator explicitly confirmed receipt
- `current_session_visible` — the ACK evidence is visible in the current session

**Plus:** explicit operator approval naming the exact terminal outbox row IDs.

---

## 5. Legacy residue handling

### Definition

Terminal Brief **legacy residue** is any metadata, projection, title, or routing state that was produced under an earlier contract version (pre-v1, pre-v0 freeze) and has not been reconciled to the current contract's invariants.

### Classes

| Class | Definition | Policy |
| --- | --- | --- |
| **Pre-v0 metadata** | Created before the v0 freeze (2026-05-09). May use deprecated field shapes, missing symmetric fields, different title semantics. | Quarantined for inspection. Must be individually reconciled or explicitly retired before the quarantine window expires (2026-06-22). |
| **v0→v1 transition residue** | Created under v0 contract (2026-05-09 to 2026-05-22). May lack v1 symmetric fields (`handoffBrokerId` for symmetric cross-broker). | Reconcile on read: projection reader must treat missing v1 fields as v0-default (`parentBrokerId == originBrokerId`). No mutation of historical rows required. |
| **Stale projection** | A projection with stale state (`projectionState: pending`) on a parent round that has been closed for >7 days. | Report in residue scan. Do not mutate. If the parent round is closed and all lanes are terminal, stale `pending` projections are informational only. |
| **Orphan projection** | Projection with `parentRoundId` that has no matching parent round in the broker's active round registry. | Block on read. Report as `missing_parent` error. Do not auto-create an implicit parent round. |

### Handling rules

1. **Do not delete or overwrite** historical projection rows. Mark `projectionState: conflict` or `blocked` with a redacted reason.
2. **Do not replay** historical projections as new notifications. Replay with the same `projectionKey` must return the existing projection with `newProjectionCreated: false`.
3. **Residue scan** is read-only, idempotent, and must never call the notifier, mutate SQLite, or ACK rows.
4. **Residue cleanup** (prune, ACK, evict) requires operator approval naming each class, row scope, and action.
5. **Legacy residue does not block** release gate or one-shot live eligibility **during the quarantine window**. After quarantine expiry (2026-06-22), unhandled legacy residue blocks the migration health gate.

### Quarantine lifecycle

| Date | Event | Action required |
| --- | --- | --- |
| 2026-05-22 | v1 contract published | Quarantine opens for pre-v0 metadata |
| 2026-06-22 | Quarantine expiry | Either reconcile, retire, or extend quarantine with documented rationale |
| After expiry | Quarantine lapsed | Migration health gate fails if legacy residue remains unhandled |

---

## 6. Source-to-deploy verification checklist

This checklist must be evaluated before any PR/Done/Block evidence publication for a Terminal Brief contract change.

### Pre-PR gates

| # | Check | How | Fail-closed |
| --- | --- | --- | --- |
| P1 | Metadata completeness | Every fixture, spec, and contract carries `parentRoundId`, `originBrokerId`, `parentBrokerId`, `parentRoundTotal`, `parentRoundOrder`. Handoff fixtures also carry `handoffBrokerId`. | Block if any fixture/spec field missing |
| P2 | Title format conformance | Title ≤80 chars; follows `A2A Terminal Brief <상태>: <worker>(<상태> <n>/<N>)` or unknown-total fallback; forbidden content absent | Block if title exceeds limit or contains forbidden content |
| P3 | Body/evidence separation | Verifiable separation in projection schema: title and body are distinct fields | Block if concatenated |
| P4 | Parent-only ownership | No fixture, spec, or contract states that a handoff/child broker may send the parent-round aggregate notification | Block if ownership ambiguous |
| P5 | ACK boundary | Every reference to provider send success, message IDs, `providerAccepted` is labeled as accepted-send-only, never ACK | Block if promotion detected |
| P6 | Four-case routing invariant | All four routing cases (broker-alpha-local, broker-alpha-handoff, broker-beta-local, broker-beta-handoff) produce correct assignments | Block if any case violates invariant |
| P7 | No-local-send rule | broker-beta must not send broker-alpha-origin parent notification; broker-alpha must not send broker-beta-origin parent notification | Block if violation detected |
| P8 | Runtime/bootstrap hygiene | `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**` absent from branch diff and artifacts | Block if any found (report exact paths) |
| P9 | Redacted evidence | No secrets, host-private paths, token-shaped literals, raw session dumps in evidence | Block if identified |
| P10 | Safety confirmation block | Evidence states all prohibited actions were avoided (see §7) | Block if absent |

### Pre-deploy gates

| # | Check | How | Fail-closed |
| --- | --- | --- | --- |
| D1 | Conformance tests pass | `npm run test:conformance` exits 0 | Block if any failure |
| D2 | Terminal Brief routing guard | `npm run check:terminal-brief-routing` exits 0 | Block if any failure |
| D3 | Message ID ACK boundary | `npm run check:message-id-ack-boundary` exits 0 | Block if any failure |
| D4 | Plane gate validation | Relevant `npm run check:team1-worker-delta-plane-gates` or equivalent exits 0 | Block if any failure |
| D5 | Full release gate | `npm run check` exits 0 | Block if any failure |
| D6 | Hygiene scan clean | Guard path find exits 0 | Block if paths found |
| D7 | operator approval | Fresh explicit operator approval naming the exact deploy scope, target, and run ID | Block if approval missing or stale (>1 business day) |

### Post-deploy verification

| # | Check | How | Fail-closed |
| --- | --- | --- | --- |
| V1 | Metadata propagation | Spot-check 3 child tasks: all carry correct `parentRoundId`, `originBrokerId`, `parentBrokerId`, `parentRoundTotal`, `parentRoundOrder` | Block if any mismatch |
| V2 | Title rendering | Spot-check 3 titles: follow format, ≤80 chars, forbidden content absent | Block if any violation |
| V3 | No-local-send | Verify no broker-beta-origin parent notification for broker-alpha-origin round (and vice versa) | BLOCK — ownership violation |
| V4 | ACK boundary preserved | Verify provider accepted-send is not promoted to ACK | Block if promotion detected |
| V5 | Legacy residue scan | Run read-only residue scan; no unexpected orphan or stale projections | Block if anomaly found |
| V6 | Rollback capability | Rollback steps documented and verifiable | Block if rollback undefined |

---

## 7. Safety gate

### Prohibited actions (require separate explicit operator approval)

| Action | Approval requirement |
| --- | --- |
| Production deploy of Gateway, broker, or worker | Comment naming exact deploy scope and target |
| Gateway/broker/worker restart or reload | Comment naming the service and window |
| Live provider/Telegram canary or notification send | Comment naming exact task ID, round ID, and provider target |
| Production DB mutation, prune, or migration | Comment naming exact mutation scope |
| Terminal-outbox ACK mutation or replay | Comment with terminal outbox row IDs |
| Historical outbox replay | Comment with replay scope justification |
| Release, tag, or npm publish | Comment naming exact version |
| Secret rotation, movement, or disclosure | Comment with secret reference (not value) |
| Repository visibility change | Comment |
| Force-push or history rewrite | Comment |

### Safety confirmation block (required in every evidence publication)

```
This lane:
- Did not deploy or restart any Gateway, broker, or worker service.
- Did not mutate production databases or terminal-outbox ACK rows.
- Did not send any live provider or Telegram message outside approved GitHub comments.
- Did not perform manual Terminal Brief ACK/replay or historical outbox replay.
- Did not change secrets, repository visibility, or release state.
- Did not rewrite history or force-push.
- Did not execute approval without fresh explicit operator approval.
- Provider accepted/message-id evidence is provider-accepted evidence only.
- Redacted repository evidence only (contracts, fixtures, test output).
- Runtime/bootstrap hygiene confirmed before evidence publication.
```

---

## 8. Hygiene scan

```bash
# Guard path scan
find . \( -path './.git' -o -path './node_modules' -o -path './packages/*/node_modules' \) \
  -prune -o \( -name AGENTS.md -o -name SOUL.md -o -name USER.md -o -name TOOLS.md -o \
  -name HEARTBEAT.md -o -name IDENTITY.md -o -path './.openclaw/*' \) -print

# Diff check
git status --short --ignored
```

**Result: PASS** only if all paths are clean. Report exact repo-relative paths on failure.

---

## 9. Conformance

```bash
# Terminal Brief core contract conformance
node test/conformance/check-terminal-brief-core-contract.mjs

# Sibling checks
npm run test:conformance
npm run check:terminal-brief-routing
npm run check:message-id-ack-boundary

# Full suite
npm run check
```

---

## 10. Residual risk

| Risk | Description | Mitigation | Fail-closed |
| --- | --- | --- | --- |
| Metadata drift | Fields added/renamed/removed without updating fixtures | Fixture conformance tests in CI; sibling lane cross-check | Block if fixture mismatch |
| Title format regression | Title exceeds 80 chars or contains forbidden content | Max-length and forbidden-content assertion | Block if regression |
| No-local-send enforcement gap | Handoff broker sends parent notification due to missing guard | Routing contract test, positive/negative fixture | BLOCK if detected |
| Legacy residue quarantine neglect | Quarantine expires without resolution | Timestamp-based gate; CI alert on expiry | Block migration gate |
| Runtime/bootstrap hygiene drift | New files introduced | Pre-PR scan; release-gate scan | Block if detected |
| Approval ambiguity | Evidence marker interpreted as approval | Explicit approval-separated wording; evidence never claims approval | Block if approval claimed |

---

*This contract is source-only. No live provider send, terminal-outbox ACK, DB mutation, or any prohibited action is authorized by this document. Each PR or validation lane referencing this contract must include the full safety confirmation block and hygiene scan result.*
