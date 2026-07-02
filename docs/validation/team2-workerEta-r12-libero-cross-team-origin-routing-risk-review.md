# Team2/workerEta R12 libero cross-team origin-routing risk review

Issue: a2a-plane#302 (a2a-plane#302, internal tracker private)
Parent broker tracker: [a2a-broker#598](https://github.com/jinwon-int/a2a-broker/issues/598)
Run: `a2a-r12-origin-terminal-brief-guard-20260513T235116Z`
Origin/finalizer broker for this dispatch: `brokerAlpha`
Lane: `workerEta` / Team2 libero cross-team origin-routing risk review
Snapshot: `2026-05-13T23:55Z`

This is a redacted, no-live libero validation artifact for the R12 origin-routing guard round. It uses repository and GitHub issue evidence only. It does not deploy, restart, reload Gateway/broker/worker processes, send a live provider or Telegram canary, mutate production databases or terminal-outbox rows, perform terminal ACK/replay or historical outbox replay, change secrets or repository visibility, publish a release/tag, rewrite history, force-push, or execute approval.

## Decision

**Decision: `NO-GO / Waiting` for activation and live routing changes.** The R12 dispatch has Start evidence across the seven child lanes, but no child lane had terminal PR, Done, or Block evidence at this snapshot. Parent Terminal Brief aggregation must therefore remain blocked until all child lanes publish terminal evidence and the parent round proves origin-based routing, symmetric handoff metadata, receipt/ACK separation, replay suppression, runtime/bootstrap hygiene, and fresh explicit operator approval for any live-impact action.

Safe closeout for this lane may say: **Team2 documented the R12 cross-team origin-routing risk review and local validation passed; aggregate R12 activation remains `NO-GO / Waiting` until all sibling lanes publish terminal PR/Done/Block evidence, the origin-routing guard proves brokerAlpha-origin and brokerBeta-origin symmetry, runtime/bootstrap hygiene is clean, and any deploy/reload/live canary/ACK action receives fresh explicit operator approval.**

## Required R12 metadata contract

Every R12 child task must carry the parent aggregation tuple exactly:

| Field | Required R12 value | Fail-closed condition |
| --- | --- | --- |
| `parentRoundId` | `a2a-r12-origin-terminal-brief-guard-20260513T235116Z` | Missing, rewritten, or inconsistent across children. |
| `originBrokerId` | `brokerAlpha` for this round | Missing, hard-coded to the handoff broker, or not equal to the commanding broker. |
| `parentRoundTotal` | `7` | Missing when known, mismatched across children, or rendered as `(n/?)`. |
| `parentBrokerId` / Terminal Brief owner | Must equal `originBrokerId`; `brokerAlpha` for this round | Handoff/execution broker owns or duplicates the parent Terminal Brief. |
| `terminalEvidenceKind` | `PR`, `Done`, or `Block` only | Start/running/provider accepted-send evidence is counted as terminal closeout. |

Team2 handoff children must also carry a directionally explicit handoff tuple:

| Field | Required R12 handoff value | Fail-closed condition |
| --- | --- | --- |
| `crossBrokerHandoff.parentRoundId` | `a2a-r12-origin-terminal-brief-guard-20260513T235116Z` | Handoff metadata cannot be joined back to the parent round. |
| `crossBrokerHandoff.originBrokerId` | `brokerAlpha` | Handoff payload assumes brokerBeta origin for a brokerAlpha-commanded round. |
| `crossBrokerHandoff.handoffBrokerId` | `brokerBeta` | Handoff broker is absent, ambiguous, or treated as parent owner. |

## Symmetric origin-routing rule

The guard must be origin-based, not brokerAlpha-hardcoded:

1. If `brokerAlpha` initiates/commands the parent round, the parent Terminal Brief aggregation is owned by `brokerAlpha`.
2. If `brokerBeta` initiates/commands a future parent round, the parent Terminal Brief aggregation is owned by `brokerBeta`.
3. Handoff/execution broker is not the Terminal Brief owner unless it is also the origin/parent broker.
4. Cross-broker metadata must encode direction explicitly, for example brokerAlpha→brokerBeta for this R12 dispatch and brokerBeta→brokerAlpha for the symmetric future case.
5. Post-dispatch verification must reject snapshots where `originBrokerId`, `parentRoundId`, `parentRoundTotal`, or `crossBrokerHandoff` are missing or mismatched within the 30–60 second verification window.

## R12 evidence snapshot

| Lane | Required output before it can count | Snapshot evidence observed | Libero result |
| --- | --- | --- | --- |
| Team1/workerGamma — [a2a-broker#599](https://github.com/jinwon-int/a2a-broker/issues/599) | Origin Terminal Brief dispatch guard that fails closed on missing parent metadata. | Start marker only: [issuecomment-4446102891](https://github.com/jinwon-int/a2a-broker/issues/599#issuecomment-4446102891). | `NO-GO / Waiting`; Start is not terminal evidence. |
| Team1/workerBeta — [openclaw-plugin-a2a#305](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/305) | Plugin Terminal Brief origin-routing boundary with provider accepted-send separated from receipt and ACK. | Start marker only: [issuecomment-4446103638](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/305#issuecomment-4446103638). | `NO-GO / Waiting`; plugin routing safety cannot be inferred from Start. |
| Team1/workerAlpha — [a2a-broker#600](https://github.com/jinwon-int/a2a-broker/issues/600) | Post-dispatch metadata verifier for broker task snapshots within 30–60 seconds. | Start marker only: [issuecomment-4446104273](https://github.com/jinwon-int/a2a-broker/issues/600#issuecomment-4446104273). | `NO-GO / Waiting`; verifier proof remains open until terminal evidence. |
| Team1/workerDelta — a2a-plane#301 (a2a-plane#301, internal tracker private) | Symmetric origin-broker contract for brokerAlpha-origin and brokerBeta-origin rounds. | Start marker only: [issuecomment-4446103922](a2a-plane#301 (internal tracker, private)#issuecomment-4446103922). | `NO-GO / Waiting`; contract symmetry remains unproven. |
| Team2/workerEpsilon — [a2a-broker#601](https://github.com/jinwon-int/a2a-broker/issues/601) | brokerBeta-origin symmetry broker validation and no ownership steal on handoff. | Start marker only: [issuecomment-4446104403](https://github.com/jinwon-int/a2a-broker/issues/601#issuecomment-4446104403). | `NO-GO / Waiting`; future brokerBeta-origin path remains open. |
| Team2/workerZeta — [a2a-docker-runner#249](https://github.com/jinwon-int/a2a-docker-runner/issues/249) | Runner metadata propagation parity for parent/handoff fields without artifact leaks. | Start marker only: [issuecomment-4446103689](https://github.com/jinwon-int/a2a-docker-runner/issues/249#issuecomment-4446103689). | `NO-GO / Waiting`; runner propagation cannot be counted until terminal evidence. |
| Team2/workerEta — a2a-plane#302 (a2a-plane#302, internal tracker private) | This libero cross-team origin-routing risk review with tests and hygiene guard. | Start marker: [issuecomment-4446104078](a2a-plane#302 (internal tracker, private)#issuecomment-4446104078). | Pass for validation shape only after this PR/test evidence exists; aggregate remains `NO-GO / Waiting`. |

## Cross-team origin-routing risk matrix

| Risk area | Required R12 proof | Current risk posture | Fail-closed condition |
| --- | --- | --- | --- |
| Origin metadata propagation | Every child includes `parentRoundId`, `originBrokerId`, and `parentRoundTotal=7`; Team2 handoff children include the full `crossBrokerHandoff` tuple. | Open until broker, runner, and contract lanes publish terminal evidence. | Dispatch or post-dispatch snapshot lacks any required field, rewrites origin, or accepts partial metadata. |
| Symmetric parent ownership | Parent Terminal Brief owner is derived from `originBrokerId`, so brokerAlpha-origin routes to brokerAlpha and future brokerBeta-origin routes to brokerBeta. | Open; this lane is no-live review only and did not execute a future brokerBeta-origin dispatch. | Code or docs special-case brokerAlpha, let brokerBeta own a brokerAlpha-origin parent, or let brokerAlpha own a brokerBeta-origin parent. |
| Handoff broker containment | Handoff/execution broker may relay bounded child evidence but must not render, send, update, retract, or ACK the parent Terminal Brief unless it is also origin. | Open until Team2 broker/runner lanes produce terminal evidence. | Handoff broker steals ownership, emits duplicate local parent notifications, or omits direction in `crossBrokerHandoff`. |
| Receipt, provider, and ACK separation | Provider accepted-send/message id, GitHub comments, Terminal Brief titles, and PR/Done/Block URLs remain evidence inputs only, not receipt/ACK/approval. | Open; no live canary or ACK was authorized or attempted by this lane. | Any `accepted`, `sent`, provider `messageId`, GitHub comment, or Terminal Brief title is promoted to requester-visible receipt, operator-visible receipt, terminal ACK, terminal-outbox ACK, or approval. |
| Replay/stale suppression | Same origin/handoff/evidence tuple is idempotent, historical outbox rows are not replayed, and post-dispatch verification cannot mint duplicate parent Terminal Brief rows. | Not executed; future approval-gated work only. | Duplicate Terminal Brief projection, stale/backlog replay, terminal-outbox ACK mutation, or retry from historical rows occurs without fresh explicit operator approval. |
| Runtime/bootstrap and artifact hygiene | Branch diff, PR body, issue comments, and artifact evidence exclude secrets, host-private paths, raw session dumps, provider targets, and OpenClaw runtime/bootstrap context. | Local deny-path scan is required before PR/Done/Block. | Any actual runtime context file or `.openclaw/**` path enters branch or artifacts; report exact repo-relative or artifact-relative paths and Block instead of success. |

## Required local verification

```bash
npm run check:team2-workerEta-r12-libero-cross-team-origin-routing-risk-review
npm run check:message-id-ack-boundary
npm run check:layout
git status --short --ignored
find . \( -path './.git' -o -path './node_modules' \) -prune -o \
  \( -name AGENTS.md -o -name SOUL.md -o -name USER.md -o -name TOOLS.md -o \
     -name HEARTBEAT.md -o -name IDENTITY.md -o -path './.openclaw/*' \) -print
```

## Runtime/bootstrap hygiene guard

Before PR creation, Done, or Block evidence, fail closed if any OpenClaw runtime/bootstrap context file would enter the branch diff, PR body, issue comments, or artifact bundle. Offending paths must be reported exactly, including `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.

Mentioning these names as deny-list policy is allowed; including their contents, host-private paths, raw session dumps, provider payloads, chat IDs, secrets, or OpenClaw cache-boundary content is not allowed.

## Closeout boundary

This lane may publish PR evidence for the document and regression test above. It must not claim R12 activation GO, live canary authorization, deploy/reload approval, terminal ACK/read receipt, broker origin-routing closure, future brokerBeta-origin proof, or source-public/visibility approval. If later refreshed as no-change validation, the terminal Done/Block marker must include the no-change rationale, the sibling evidence snapshot, and the hygiene result.
