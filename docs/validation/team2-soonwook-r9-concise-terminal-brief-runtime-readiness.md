# Team2/Soonwook R9 concise Terminal Brief runtime readiness validation

Parent: [a2a-broker#560](https://github.com/jinwon-int/a2a-broker/issues/560)
Lane: a2a-plane#290 (a2a-plane#290, internal tracker private)
Runtime-readiness tracker: [openclaw-plugin-a2a#298](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/298)
Run: `a2a-r9-concise-brief-runtime-20260513T134143Z`
Parent broker: `seoseo`
Handoff broker for Team2/Gwakga children: `gwakga`
Known parent-round total: `7`

This is a redacted, no-live Team2/Soonwook libero validation artifact for the R9 concise Terminal Brief runtime-readiness all-hands round. It performs repository and GitHub evidence review only. It does not deploy, restart, reload Gateway/broker/worker processes, send a live provider or Telegram canary, mutate production databases or terminal-outbox rows, perform manual ACK/replay or historical outbox replay, change secrets or repository visibility, publish a release/tag, rewrite history, force-push, or execute approval.

## Decision

**Decision: `NO-GO / Waiting` for live activation; `GO_CANDIDATE` for the no-live readiness packet.**

R9 dispatch evidence shows the parent broker, parent round id, known total, and child lane mapping were created for the seven-child all-hands round. The safe closeout from this lane is repository evidence plus an approval-gated activation plan. It is not approval to deploy, reload, send a canary, record a Terminal Brief ACK, replay outbox history, or claim operator receipt.

## Parent aggregation metadata to preserve

The parent broker owns the operator-facing aggregation ledger for this round:

| Field | Required R9 value or rule |
| --- | --- |
| `parentRoundId` | `a2a-r9-concise-brief-runtime-20260513T134143Z`; minted once by `seoseo` and never rewritten by children or replay handlers. |
| `originBrokerId` | `seoseo`; copied into direct child metadata and Gwakga handoff envelopes. |
| `parentBrokerId` | `seoseo`; the only broker allowed to render/send the parent-round Terminal Brief. |
| `parentRoundTotal` | `7` when known; title renderer must use `(n/7)` for the seven R9 children. |
| `brokerOfRecord` | Direct Team1 children stay under `seoseo`; Team2/Gwakga handoff children use `gwakga` only for child lifecycle and terminal evidence. |
| `crossBrokerHandoff.parentRoundId` | Must equal the parent `parentRoundId` for Team2/Gwakga children. |
| `crossBrokerHandoff.originParentBrokerId` | Must remain `seoseo`; Gwakga must not replace it with itself. |
| `projectionKey` | Derived from `parentRoundId`, `originBrokerId`, child task id, and terminal kind. A replay with the same key returns the existing projection and creates no second Terminal Brief entry. |
| terminal flags | `liveProviderSend=false`, `terminalOutboxAckMutated=false`, `isApproval=false`, `isTerminalAck=false`, and `isReadReceipt=false` for this no-live proof. |

If any required parent metadata is missing, rewritten, or inconsistent, future dispatch must fail closed before the child task can be counted in the parent Terminal Brief.

## No-live seven-child title proof

The following synthetic projection table is the R9 no-live proof shape. It uses the dispatch evidence from `a2a-broker#560` and `a2a-plane#290` without sending provider messages or mutating broker state.

| n | Worker | Child issue | Broker of record | Parent projection owner | Required parent-rendered title | Local child notification |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `bangtong` | [a2a-broker#561](https://github.com/jinwon-int/a2a-broker/issues/561) | `seoseo` | `seoseo` | `A2A Terminal Brief 완료: bangtong(1/7)` | disabled; parent owns notification |
| 2 | `sogyo` | [openclaw-plugin-a2a#299](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/299) | `seoseo` | `seoseo` | `A2A Terminal Brief 완료: sogyo(2/7)` | disabled; parent owns notification |
| 3 | `nosuk` | [a2a-broker#562](https://github.com/jinwon-int/a2a-broker/issues/562) | `seoseo` | `seoseo` | `A2A Terminal Brief 완료: nosuk(3/7)` | disabled; parent owns notification |
| 4 | `yukson` | a2a-plane#289 (a2a-plane#289, internal tracker private) | `seoseo` | `seoseo` | `A2A Terminal Brief 완료: yukson(4/7)` | disabled; parent owns notification |
| 5 | `dungae` | [a2a-broker#563](https://github.com/jinwon-int/a2a-broker/issues/563) | `gwakga` | `seoseo` | `A2A Terminal Brief 완료: dungae(5/7)` | disabled; Gwakga relays projection only |
| 6 | `jingun` | [a2a-docker-runner#243](https://github.com/jinwon-int/a2a-docker-runner/issues/243) | `gwakga` | `seoseo` | `A2A Terminal Brief 완료: jingun(6/7)` | disabled; Gwakga relays projection only |
| 7 | `soonwook` | a2a-plane#290 (a2a-plane#290, internal tracker private) | `gwakga` | `seoseo` | `A2A Terminal Brief 완료: soonwook(7/7)` | disabled; Gwakga relays projection only |

Unknown-total fallback remains required for future partial or legacy rounds: `A2A Terminal Brief 완료: soonwook(7)`. The renderer must omit the denominator whenever the total is unknown rather than emitting any bogus total marker.

Title constraints for every row:

- source is the `seoseo` parent aggregation ledger, not the child issue body or child broker local state;
- maximum length is 80 characters;
- title must not include task ids, child issue URLs, PR/Done/Block URLs, evidence body, child broker id, handoff broker id, provider message id, receipt state, ACK state, raw logs, secrets, private paths, or runtime/bootstrap file names;
- title text is not proof of provider delivery, operator receipt, approval, or terminal-outbox ACK.

## Parent-only notification ownership

Parent-only notification ownership is mandatory for this R9 round:

1. `seoseo` is the initiating parent broker and the only broker that may render or send the operator-facing parent-round Terminal Brief.
2. Direct Team1 children can publish redacted terminal evidence to the parent ledger, but they must not send duplicate local Terminal Brief notifications.
3. Team2/Gwakga handoff children can manage child lifecycle and produce terminal PR/Done/Block evidence, but Gwakga must relay a bounded projection back to `seoseo` and keep local child notification disabled.
4. Provider accepted-send, GitHub comment URLs, Terminal Brief titles, and projection rows remain non-ACK evidence. They are not read receipts, human-seen proof, approval, and not Terminal Brief ACK evidence.

## Runtime readiness checks before activation

Before any operator can consider live activation, the runtime owner must capture bounded evidence that:

- the active `openclaw-plugin-a2a` checkout or installed plugin contains the concise renderer from `openclaw-plugin-a2a#291` / `1122bb4` or a later main commit with equivalent behavior;
- the dispatcher guard refuses all-hands or cross-broker dispatch when `parentRoundId`, `originBrokerId`, `parentBrokerId`, broker-of-record/handoff routing, and known total are missing or inconsistent;
- a no-live rehearsal produces the seven titles above and the unknown-total fallback without provider sends, Telegram sends, ACK mutations, DB writes, or historical outbox replay;
- parent projection replay with the same `projectionKey` returns the existing projection and records `newProjectionCreated=false`;
- runtime/bootstrap hygiene is clean before PR, Done, or Block evidence publication.

## Approval-gated activation plan

This lane did not execute the steps below. They are the minimal safe plan for a later operator-approved runtime window:

1. **Pre-approval packet:** attach this validation, the plugin/runtime version evidence, dispatcher guard evidence, no-live title rehearsal, replay/no-duplicate proof, rollback plan, and runtime/bootstrap hygiene results.
2. **Fresh explicit operator approval:** require a separate approval that names the exact runtime update/reload scope and, if needed, one fresh canary provider send. Prior Start/PR/Done/Block comments, tests, provider ids, or Terminal Brief text do not count.
3. **Apply only after approval:** back up relevant runtime/plugin configuration, update the plugin/runtime to the verified concise renderer build, and reload/restart only inside the approved scope. No approval means no reload/restart.
4. **One fresh canary at most:** use a new canary task bound to this parent round, never a historical outbox row or replayed backlog item.
5. **Receipt and ACK separation:** capture operator-visible or current-session-visible receipt evidence before any ACK-safe path is considered; provider accepted-send/message id alone is insufficient.
6. **Restore no-live posture:** disable canary/live-send allowances after the proof, record final no-live restoration evidence, and preserve the parent aggregation ledger for replay-safe audit.
7. **Rollback:** if title rendering, projection ownership, receipt proof, or runtime hygiene fails, stop activation, keep `terminalOutboxAckMutated=false`, mark the parent projection `blocked` or `conflict`, and post sanitized Block evidence.

## Runtime/bootstrap hygiene gate

Before publishing PR, Done, or Block evidence for this lane, fail closed if any OpenClaw runtime/bootstrap context path would enter the branch, PR body, issue comments, or artifacts. Report exact repo-relative or artifact-relative paths.

Denied paths:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Safe closeout language: **R9 concise Terminal Brief runtime readiness is documented as a no-live, parent-owned, replay-safe `GO_CANDIDATE` packet, while live activation remains `NO-GO / Waiting` until a fresh explicit operator approval authorizes the exact update/reload and any one-shot canary scope.**
