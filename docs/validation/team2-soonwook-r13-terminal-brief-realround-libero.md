# Team2/Soonwook R13 compact Terminal Brief real-round libero validation

Issue: a2a-plane#306 (a2a-plane#306, internal tracker private)
Parent broker tracker: [a2a-broker#607](https://github.com/jinwon-int/a2a-broker/issues/607)
Primary guard: [a2a-broker#598](https://github.com/jinwon-int/a2a-broker/issues/598)
Run: `a2a-r13-terminal-brief-realround-20260514T013556Z`
Origin/finalizer broker for this dispatch: `seoseo`
Team2 handoff broker when applicable: `gwakga`
Lane: `soonwook` / Team2 libero validation
Order: `7/7`
Target compact title: `A2A Terminal Brief 완료: soonwook(7/7)`
Snapshot: `2026-05-14T01:39Z`

This is a redacted, no-live validation artifact for the R13 compact Terminal Brief real-round. It uses repository and GitHub issue evidence only. It does not restart Gateway, broker, or worker processes; reload live services; deploy; run a live provider or Telegram canary beyond normal A2A task completion notifications; mutate production databases or terminal-outbox rows; perform manual Terminal Brief ACK/replay or historical outbox replay; change secrets or repository visibility; publish a release/tag; rewrite history; force-push; or execute approval.

## Decision

**Decision: `NO-GO / Waiting` for parent finalizer closeout at this snapshot.** R13 dispatch and Start evidence exist across all seven lanes, but no sibling lane had terminal PR, Done, or Block evidence in the observed issue snapshot. Seoseo can use this lane as validation evidence for the compact-title and guard checklist shape, but parent aggregation must not close until every child lane publishes terminal PR/Done/Block evidence and the parent finalizer verifies metadata, title, ownership, receipt, ACK, replay, and runtime/bootstrap hygiene.

Safe closeout for this lane may say: **Team2/Soonwook documented the R13 compact Terminal Brief real-round validation and local checks passed; aggregate R13 finalizer closeout remains `NO-GO / Waiting` until all seven lanes publish terminal PR/Done/Block evidence and Seoseo verifies parent-only ownership, exact parent metadata, compact title behavior, and receipt/ACK separation.**

## Required R13 parent metadata and compact title contract

Every R13 child task must preserve the parent aggregation tuple exactly:

| Field | Required R13 value | Fail-closed condition |
| --- | --- | --- |
| `parentRoundId` | `a2a-r13-terminal-brief-realround-20260514T013556Z` | Missing, rewritten, truncated, or inconsistent across children. |
| `originBrokerId` | `seoseo` | Missing, rewritten to the handoff/execution broker, or not equal to the commanding broker. |
| `parentRoundTotal` | `7` | Missing when known, mismatched across children, or rendered as an unknown-total title. |
| `parentRoundOrder` / lane order | `1/7` through `7/7`; this lane is `7/7` | Missing, duplicated, out of range, or inconsistent with the dispatched task id. |
| `parentBrokerId` / Terminal Brief owner | Must equal `originBrokerId`; `seoseo` for this round | Gwakga or any child execution broker owns, updates, duplicates, retracts, or ACKs the parent Terminal Brief. |
| `terminalEvidenceKind` | `PR`, `Done`, or `Block` only | Start/running/provider accepted-send evidence is counted as terminal closeout. |
| Compact title | `A2A Terminal Brief 완료: <worker>(n/7)`; this lane target is `A2A Terminal Brief 완료: soonwook(7/7)` | Details are moved into the title, the title omits the known total, or body/evidence is treated as ACK proof. |

Team2 handoff children must also carry directionally explicit handoff metadata:

| Field | Required R13 handoff value | Fail-closed condition |
| --- | --- | --- |
| `crossBrokerHandoff.parentRoundId` | `a2a-r13-terminal-brief-realround-20260514T013556Z` | Handoff metadata cannot be joined back to the parent round. |
| `crossBrokerHandoff.originBrokerId` | `seoseo` | Handoff payload assumes Gwakga origin for this Seoseo-commanded round. |
| `crossBrokerHandoff.handoffBrokerId` | `gwakga` | Handoff broker is absent, ambiguous, or treated as parent owner. |

## Parent-only Terminal Brief ownership rule

1. Seoseo initiated/commanded this R13 parent round, so Seoseo owns the parent Terminal Brief aggregation.
2. Gwakga may execute Team2 handoff work and relay bounded child evidence, but Gwakga must not own, duplicate, ACK, or close the Seoseo-origin parent Terminal Brief.
3. A future Gwakga-origin parent round must aggregate to Gwakga; the guard must remain origin-based and not Seoseo-hardcoded.
4. Provider accepted-send, provider message id, GitHub comment URLs, compact titles, and task completion notifications are evidence inputs only. They are not requester-visible receipt, operator-visible receipt, terminal ACK, terminal-outbox ACK, or approval.
5. Historical terminal-outbox replay and manual ACK/replay remain blocked unless a fresh explicit operator approval names the exact action and item.

## R13 evidence snapshot

| Lane | Required output before it can count | Snapshot evidence observed | Libero result |
| --- | --- | --- | --- |
| Team1/bangtong — [a2a-broker#608](https://github.com/jinwon-int/a2a-broker/issues/608) | Fail-closed dispatch guard implementation for missing parent metadata. | Dispatch expected title `A2A Terminal Brief 완료: bangtong(1/7)` at [issuecomment-4446617399](https://github.com/jinwon-int/a2a-broker/issues/608#issuecomment-4446617399); Start marker at [issuecomment-4446632710](https://github.com/jinwon-int/a2a-broker/issues/608#issuecomment-4446632710). | `NO-GO / Waiting`; Start is not terminal evidence. |
| Team1/sogyo — [openclaw-plugin-a2a#307](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/307) | Plugin/runtime compact Terminal Brief verification with receipt/ACK boundary. | Dispatch expected title `A2A Terminal Brief 완료: sogyo(2/7)` at [issuecomment-4446618127](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/307#issuecomment-4446618127); Start marker at [issuecomment-4446626360](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/307#issuecomment-4446626360). | `NO-GO / Waiting`; plugin receipt safety cannot be inferred from Start. |
| Team1/nosuk — [a2a-broker#609](https://github.com/jinwon-int/a2a-broker/issues/609) | Parent aggregation and ACK-boundary hardening. | Dispatch expected title `A2A Terminal Brief 완료: nosuk(3/7)` at [issuecomment-4446620137](https://github.com/jinwon-int/a2a-broker/issues/609#issuecomment-4446620137); Start marker at [issuecomment-4446630702](https://github.com/jinwon-int/a2a-broker/issues/609#issuecomment-4446630702). | `NO-GO / Waiting`; ACK-boundary hardening remains open until terminal evidence. |
| Team1/yukson — a2a-plane#305 (a2a-plane#305, internal tracker private) | Contracts/runbook for all-hands metadata and finalizer acceptance matrix. | Dispatch expected title `A2A Terminal Brief 완료: yukson(4/7)` at [issuecomment-4446622958](a2a-plane#305 (internal tracker, private)#issuecomment-4446622958); Start marker at [issuecomment-4446629898](a2a-plane#305 (internal tracker, private)#issuecomment-4446629898). | `NO-GO / Waiting`; contract/runbook proof remains open until terminal evidence. |
| Team2/dungae — [a2a-broker#610](https://github.com/jinwon-int/a2a-broker/issues/610) | Gwakga handoff parity for Seoseo-origin parent ownership. | Dispatch expected title `A2A Terminal Brief 완료: dungae(5/7)` at [issuecomment-4446623706](https://github.com/jinwon-int/a2a-broker/issues/610#issuecomment-4446623706); Start marker at [issuecomment-4446632488](https://github.com/jinwon-int/a2a-broker/issues/610#issuecomment-4446632488). | `NO-GO / Waiting`; handoff parity cannot be counted from Start. |
| Team2/jingun — [a2a-docker-runner#251](https://github.com/jinwon-int/a2a-docker-runner/issues/251) | Runner evidence context and compact titles without artifact leaks. | Dispatch expected title `A2A Terminal Brief 완료: jingun(6/7)` at [issuecomment-4446624377](https://github.com/jinwon-int/a2a-docker-runner/issues/251#issuecomment-4446624377); Start markers at [issuecomment-4446629640](https://github.com/jinwon-int/a2a-docker-runner/issues/251#issuecomment-4446629640) and [issuecomment-4446639319](https://github.com/jinwon-int/a2a-docker-runner/issues/251#issuecomment-4446639319). | `NO-GO / Waiting`; runner leak guard and terminal evidence remain open. |
| Team2/soonwook — a2a-plane#306 (a2a-plane#306, internal tracker private) | This libero validation of compact titles, parent-only ownership, and guard aggregation evidence. | Dispatch expected title `A2A Terminal Brief 완료: soonwook(7/7)` at [issuecomment-4446625430](a2a-plane#306 (internal tracker, private)#issuecomment-4446625430); Start markers at [issuecomment-4446630442](a2a-plane#306 (internal tracker, private)#issuecomment-4446630442) and [issuecomment-4446638467](a2a-plane#306 (internal tracker, private)#issuecomment-4446638467). | Pass for validation shape only after this PR/Done evidence exists; aggregate remains `NO-GO / Waiting`. |

## R13 closeout risk matrix

| Risk area | Required R13 proof | Current risk posture | Fail-closed condition |
| --- | --- | --- | --- |
| Guard completeness for #598 | Dispatch/preflight rejects missing `parentRoundId`, `originBrokerId`, known total/order, and Team2 `crossBrokerHandoff`; post-dispatch verifier checks snapshots within the expected window. | Open until broker implementation lanes publish terminal evidence. | Any child is accepted with missing/mismatched parent metadata, or verifier treats partial metadata as success. |
| Compact title behavior | Terminal Brief title stays compact as `A2A Terminal Brief 완료: <worker>(n/7)` while details remain in body/evidence. | Dispatch comments show the expected title for all seven lanes; no terminal PR/Done/Block evidence observed yet. | Title expands with body details, drops known total, uses unknown total despite `7`, or hides needed evidence in the title. |
| Parent-only ownership | Parent aggregation is owned by `originBrokerId=seoseo`; Gwakga execution lanes cannot steal or duplicate parent ownership. | Open until Team2 broker/runner evidence proves handoff containment. | Handoff broker owns, duplicates, retracts, ACKs, or closes the Seoseo-origin parent Terminal Brief. |
| Receipt and ACK safety | Provider accepted/message-id, GitHub URLs, compact titles, and normal completion notifications remain non-ACK evidence. | No live canary, manual ACK, historical replay, deploy, restart, or DB mutation was authorized or performed by this lane. | Provider accepted-send or message id is promoted to read/visibility proof, terminal ACK, terminal-outbox ACK, or approval. |
| Replay/stale suppression | Historical outbox rows are not replayed; parent aggregation is idempotent across child PR/Done/Block inputs. | Not proven by this lane; waits on broker/plugin/runner terminal evidence. | Stale/backlog terminal rows send duplicate Terminal Briefs or advance ACK state without a fresh explicit operator approval. |
| Runtime/bootstrap and artifact hygiene | Branch diff, PR body, issue comments, and artifact evidence exclude secrets, host-private paths, raw session dumps, provider targets, and OpenClaw runtime/bootstrap context. | Local deny-path scan is required before PR/Done/Block. | Any actual runtime context file or `.openclaw/**` path enters branch or artifacts; report exact repo-relative or artifact-relative paths and Block instead of success. |

## Required local verification

```bash
npm run check:team2-soonwook-r13-terminal-brief-realround-libero
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

This lane may publish PR or Done evidence for the document and regression test above. It must not claim R13 parent closeout, #598 full closure, live canary authorization, deploy/reload approval, terminal ACK/read receipt, broker origin-routing closure, Gwakga-origin proof, or source-public/visibility approval. If later refreshed as no-change validation, the terminal Done/Block marker must include the no-change rationale, sibling evidence snapshot, and hygiene result.
