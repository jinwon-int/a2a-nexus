# Team2/workerEta R9b Terminal Brief activation readiness validation

Issue: a2a-plane#294 (a2a-plane#294, internal tracker private)
Parent broker tracker: [a2a-broker#567](https://github.com/jinwon-int/a2a-broker/issues/567)
Run: `a2a-r9b-terminal-brief-activation-readiness-20260513T152714Z`
Lane: `workerEta` / Team2 libero cross-team validation and risk review

This is a redacted, no-live readiness artifact. It performs repository evidence review only. It does not deploy, restart, reload Gateway/broker/worker processes, send a live provider or Telegram message, mutate production databases or terminal-outbox rows, perform manual ACK/replay or historical outbox replay, change secrets or repository visibility, publish a release/tag, rewrite history, force-push, or execute approval.

## Closeout evidence rule

**Decision: `NO-GO / Waiting` for live activation.** The no-live packet below is a `GO_CANDIDATE` for operator review only after all seven child lanes have terminal PR, Done, or Block evidence. Start, queued, running, provider accepted-send, GitHub comment success, local tests, and Terminal Brief titles are evidence inputs only; they are not closeout evidence, operator approval, requester-visible receipt, operator-visible receipt, terminal ACK, or terminal-outbox ACK.

Parent aggregation must count **PR/Done/Block evidence only**:

| Evidence marker | Counts in parent packet? | Boundary |
| --- | --- | --- |
| Start marker only | No | Shows work began; cannot close or activate. |
| PR marker | Yes, as pending implementation/review evidence | Does not imply merge, deployment, approval, receipt, or ACK. |
| Done marker | Yes, as terminal lane evidence | Must remain no-live unless it links separate explicit operator approval. |
| Block marker | Yes, as terminal lane evidence | Keeps aggregate `NO-GO / Waiting` until resolved. |

## Parent-broker aggregation metadata

The parent broker of record is `brokerAlpha` for [a2a-broker#567](https://github.com/jinwon-int/a2a-broker/issues/567). `brokerBeta` may relay bounded Team2 child projections, but it is not the parent notification owner.

| Field | Required value for this R9b round | Fail-closed condition |
| --- | --- | --- |
| `parentRoundId` | `a2a-r9b-terminal-brief-activation-readiness-20260513T152714Z` | Missing, rewritten, or inconsistent across children. |
| `originBrokerId` | `brokerAlpha` | Any child or handoff broker claims origin ownership. |
| `parentBrokerId` | `brokerAlpha` | Parent-only notification ownership moves without a contract-version change. |
| `parentRoundTotal` | `7` | Unknown or mismatched totals render only unknown-total fallback, never `(n/?)`. |
| `handoffBrokerId` | `brokerBeta` only for Team2 relayed children | Handoff broker sends a duplicate local parent-round Terminal Brief. |
| `brokerOfRecord` | The child lane's source broker/repo owner for evidence provenance | Evidence URL cannot be traced to PR/Done/Block marker. |
| `projectionKey` | Stable tuple of `parentRoundId`, `originBrokerId`, child worker, child issue, and terminal evidence kind | Replay creates a second Terminal Brief projection or replays historical outbox rows. |
| `terminalEvidenceKind` | `PR`, `Done`, or `Block` | Start/running/provider delivery is projected as terminal closeout. |
| `noLiveFlags` | `liveProviderSend=false`, `terminalOutboxAckMutated=false`, `isApproval=false`, `isTerminalAck=false`, `isReadReceipt=false` | Any flag is absent, true, or inferred from provider/GitHub evidence. |

A replay of the same child evidence with the same `projectionKey` must return the existing projection and create no second Terminal Brief entry, no live send, no terminal ACK, and no backlog replay.

## Compact parent-round titles

Known-total parent titles must stay compact and parent-rendered. Each title is the parent notification title only; the evidence body and URLs remain separate fields.

| Order | Worker | Tracker | Parent title | Owner |
| --- | --- | --- | --- | --- |
| 1 | `workerGamma` | `a2a-broker#568` | `A2A Terminal Brief 완료: workerGamma(1/7)` | `brokerAlpha` |
| 2 | `workerBeta` | `openclaw-plugin-a2a#300` | `A2A Terminal Brief 완료: workerBeta(2/7)` | `brokerAlpha` |
| 3 | `workerAlpha` | `a2a-broker#569` | `A2A Terminal Brief 완료: workerAlpha(3/7)` | `brokerAlpha` |
| 4 | `workerDelta` | `a2a-plane#293` | `A2A Terminal Brief 완료: workerDelta(4/7)` | `brokerAlpha` |
| 5 | `workerEpsilon` | `a2a-broker#570` | `A2A Terminal Brief 완료: workerEpsilon(5/7)` | `brokerAlpha`; relayed by `brokerBeta` if needed |
| 6 | `workerZeta` | `a2a-docker-runner#244` | `A2A Terminal Brief 완료: workerZeta(6/7)` | `brokerAlpha`; relayed by `brokerBeta` if needed |
| 7 | `workerEta` | `a2a-plane#294` | `A2A Terminal Brief 완료: workerEta(7/7)` | `brokerAlpha`; relayed by `brokerBeta` if needed |

Unknown-total fallback remains valid only when `parentRoundTotal` is absent by design: `A2A Terminal Brief 완료: workerEta(7)`. It must not emit a slash-question-mark denominator or any fabricated denominator.

## Parent-only notification ownership

1. `brokerAlpha` is the initiating parent broker and the only broker that may render, send, update, or retract the operator-facing parent-round Terminal Brief for this R9b packet.
2. Team1 child brokers may publish redacted PR/Done/Block evidence to the parent ledger, but they must not send duplicate local parent-round Terminal Brief notifications.
3. `brokerBeta` may relay a bounded Team2 projection back to `brokerAlpha`; it must keep local child notification disabled and must not own the operator-facing title.
4. Provider accepted-send, GitHub comment URLs, Terminal Brief projection rows, and compact titles remain non-ACK evidence. They are not read receipts, human-seen proof, terminal ACK, terminal-outbox ACK, or operator approval.

## Receipt/ACK boundary proof

| Signal | Allowed classification | Explicitly not |
| --- | --- | --- |
| Provider accepted-send or message id | Provider transport accepted-send evidence | Requester-visible receipt, operator-visible receipt, terminal ACK, terminal-outbox ACK, approval. |
| GitHub issue/PR/Done/Block URL | Requester-visible ledger evidence for the parent packet | Human-seen receipt, live provider proof, terminal ACK, approval. |
| Parent Terminal Brief title/body | Redacted parent-owned evidence summary | Operator approval, read receipt, terminal-outbox mutation, canary completion. |
| Operator-visible receipt | A separate receipt signal defined by the operator path | Provider accepted-send, GitHub comment, or Terminal Brief title alone. |
| Terminal ACK / terminal-outbox ACK | A separate ACK-safe event after receipt and approval gates pass | Provider id, GitHub URL, Start marker, PR marker, Done marker, Block marker, or local test output. |

The safe invariant is: `providerAccepted != operatorVisibleReceipt != terminalAck != approval`. No R9b evidence may promote provider acceptance, GitHub comments, compact titles, or Start/PR/Done/Block markers into ACK or approval.

## GO/NO-GO packet

| Gate | Required evidence before live activation | Current no-live posture | Decision |
| --- | --- | --- | --- |
| G1. All seven child lanes terminal | Each child has PR, Done, or Block evidence linked in the parent ledger; Start-only evidence is excluded. | This artifact defines the validation rule; parent aggregation must verify live GitHub evidence separately. | `NO-GO / Waiting` until complete. |
| G2. Parent metadata stable | `parentRoundId`, `originBrokerId`, `parentBrokerId`, `parentRoundTotal`, `brokerOfRecord`, and `projectionKey` are present and consistent. | Required fields and fail-closed conditions documented. | `GO_CANDIDATE` for no-live review. |
| G3. Compact title rendering | Known-total titles use `A2A Terminal Brief 완료: <worker>(n/7)` and stay separate from body/evidence. | Seven expected titles documented. | `GO_CANDIDATE` for no-live review. |
| G4. Parent-only notification ownership | Only `brokerAlpha` owns parent-round operator notification; `brokerBeta` relay remains bounded and local notification disabled. | Ownership rule documented. | `GO_CANDIDATE` for no-live review. |
| G5. Receipt/ACK separation | Provider, GitHub, Terminal Brief, receipt, ACK, and approval signals stay distinct. | Boundary proof documented; no ACK mutation performed. | `GO_CANDIDATE` for no-live review. |
| G6. Replay/stale suppression | Same `projectionKey` deduplicates; historical outbox rows are not replayed; no manual ACK/replay. | Required invariant documented only. | `NO-GO / Waiting` until implementation/runtime proof is linked. |
| G7. Fresh operator approval | Separate explicit operator approval names exact reload/update scope and any one fresh canary provider send. | No approval requested or executed here. | `NO-GO / Waiting`. |
| G8. Rollback/no-live restoration | Rollback plan restores no-live posture and verifies no duplicate sends, ACK mutations, or backlog replay. | Plan documented below; not executed. | `NO-GO / Waiting` until approved run evidence exists. |

Safe closeout language: **R9b Terminal Brief activation readiness is documented as a no-live, parent-owned, replay-safe `GO_CANDIDATE` packet, while live activation remains `NO-GO / Waiting` until all terminal child evidence is linked and a fresh explicit operator approval authorizes the exact update/reload plus any one-shot canary scope.**

## Approval-gated activation and rollback plan (not executed)

These steps are a future operator packet only; this lane did not execute them.

1. **Pre-activation freeze:** collect PR/Done/Block URLs for all seven children, recompute parent aggregation with `parentRoundTotal=7`, verify compact titles, and run the runtime/bootstrap hygiene guard.
2. **Fresh explicit operator approval:** require a separate approval that names the exact broker/runtime update or reload and whether one fresh canary provider send is authorized. No approval means no deploy, reload, restart, live provider send, terminal ACK, DB mutation, or replay.
3. **One fresh canary at most:** if approved, create or select a fresh canary task only. Never use a historical outbox row, replayed backlog item, or manual ACK/replay as canary evidence.
4. **Receipt-before-ACK check:** capture provider accepted-send separately from operator-visible receipt. Do not record terminal ACK or terminal-outbox ACK until the ACK-safe receipt path is explicitly satisfied.
5. **Post-canary verification:** prove `liveProviderSend<=1`, `terminalOutboxAckMutated` only changes after receipt/ACK gates, no duplicate Terminal Brief projection was created, and no stale task was replayed.
6. **Rollback:** restore no-live posture, disable any temporary canary allowance, confirm local child notification remains disabled, and link redacted rollback evidence to the parent ledger.
7. **Abort path:** if any gate fails, publish Block evidence and keep the aggregate decision `NO-GO / Waiting`; do not retry by replaying historical outbox rows.

## Runtime/bootstrap hygiene guard

Before PR creation, closeout, or artifact publication, fail closed if OpenClaw runtime/bootstrap context files would enter the branch or artifact evidence. Report exact repo-relative or artifact-relative offending paths, including: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`.

This artifact intentionally contains no secrets, no host-specific private paths, no chat IDs, no raw session dumps, no provider tokens, and no OpenClaw cache boundary content.
