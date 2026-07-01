# Team2/Soonwook R15 structured Terminal Brief libero validation

Issue: a2a-plane#312 (a2a-plane#312, internal tracker private)
Parent: [a2a-broker#623](https://github.com/jinwon-int/a2a-broker/issues/623)
Run: `a2a-r15-allhands-structured-terminal-brief-20260514T065457Z`
Lane: `soonwook` / Team2 libero validation
Start marker: [a2a-plane#312 comment](a2a-plane#312 (internal tracker, private)#issuecomment-4448410547)

This is a redacted, no-live validation artifact. It performs repository and GitHub evidence review only. It does not deploy, restart, reload, send live provider or Telegram canaries, mutate or prune production databases, replay or ACK Terminal Brief outbox rows, replay historical tasks, publish a release/tag, move or disclose secrets, force-push, rewrite history, change repository visibility, or execute operator approval.

## Decision

**R15 closeout is `NO-GO / Waiting` until every R15 child lane publishes terminal PR, Done, or Block evidence, the broker `a2a-broker#621` R14 failure is fixed or explicitly superseded, and the R15 implementation PRs prove the structured Terminal Brief metadata path end to end.**

Safe current closeout for this lane: this PR may document the validation matrix and merge plan. It is not approval to merge sibling PRs, deploy, reload, send a live canary, record Terminal Brief ACK, or claim operator-visible receipt.

## End-to-end validation matrix

| Gate | Required R15 behavior | Current evidence snapshot | Closeout state |
| --- | --- | --- | --- |
| Canonical task payload metadata | Dispatchers, storage, cross-broker handoff, outbox projection, and plugin rendering use one persisted structured Terminal Brief metadata object. Required fields include `parentRoundId`, `originBrokerId`, `handoffBrokerId` when applicable, `parentRoundTotal`, `parentRoundIndex`, `childWorkerId`, human `taskSummary` or `taskDescription`, and optional `terminalBriefTitle`. | Parent [#623](https://github.com/jinwon-int/a2a-broker/issues/623) defines the R15 shape. Broker schema/fail-closed lane [#624](https://github.com/jinwon-int/a2a-broker/issues/624) has Start/direct-task evidence only at snapshot. | `NO-GO / Waiting`; must land with tests before final R15 closeout. |
| Fail-closed creation | Known Terminal Brief fields supplied at top-level, legacy metadata, or caller-only layers are normalized into persisted `task.payload` or rejected before dispatch with an actionable error. Cross-broker/all-hands tasks missing parent/origin/order/handoff metadata must fail before terminal completion. | R15 issue [#624](https://github.com/jinwon-int/a2a-broker/issues/624) covers this; R14 failing PR [a2a-broker#621](https://github.com/jinwon-int/a2a-broker/pull/621) shows this remains merge-blocked until CI is green or R15 supersedes it. | `NO-GO`; `a2a-broker#621` must not merge while failing. |
| Post-dispatch snapshot verifier | Within 30-60 seconds, a verifier confirms the persisted origin and handoff broker task snapshots retained parent round, origin, handoff, order, total, worker, and human summary fields. It must detect the R14 class where top-level metadata was accepted by a caller but absent from persisted payload. | Broker verifier/fan-in lane [#625](https://github.com/jinwon-int/a2a-broker/issues/625) has Start/direct-task evidence only at snapshot. | `NO-GO / Waiting`; requires PR/tests and a no-live verification artifact. |
| Cross-broker origin fan-in | Team2/Gwakga terminal events for an origin-broker round project back to the origin/commanding broker parent aggregation and do not remain Gwakga-local accepted notifications. | [#623](https://github.com/jinwon-int/a2a-broker/issues/623) names Gwakga as direct coordinator for this R15 run because `/a2a assign` ingestion is blocked by [#627](https://github.com/jinwon-int/a2a-broker/issues/627). Fan-in hardening is assigned to [#625](https://github.com/jinwon-int/a2a-broker/issues/625). | `NO-GO / Waiting`; merge only after #625 proves stable projection keys and no duplicate parent Terminal Brief rows. |
| Compact renderer fallback order | Renderer prefers `terminalBriefTitle`, then `childWorkerId(parentRoundIndex/parentRoundTotal)`, then human `taskSummary`/`taskDescription`/`taskBrief`; runner summaries such as `docker runner completed ...` are evidence fallback only, not primary `업무:` text. | Plugin lane [openclaw-plugin-a2a#311](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/311) and runner lane [a2a-docker-runner#255](https://github.com/jinwon-int/a2a-docker-runner/issues/255) have Start/direct-task evidence only at snapshot. | `NO-GO / Waiting`; require renderer tests and runner evidence compatibility tests. |
| Runner summary precedence | Runner artifacts and PR/Done/Block comments preserve human Terminal Brief summaries and keep machine completion text as secondary evidence. | Runner [#255](https://github.com/jinwon-int/a2a-docker-runner/issues/255) is open; R14 runner PR [#254](https://github.com/jinwon-int/a2a-docker-runner/pull/254) is clean but must not override the R15 renderer fallback contract. | `GO_CANDIDATE` for independent R14 merge after guard checks; R15 still waiting on #255. |
| Plane contract fixtures | Plane contracts/conformance fixtures cover canonical metadata, malformed top-level-only metadata rejection/normalization, Seoseo-origin to Gwakga-handoff to origin fan-in, compact renderer fallback, and accepted-send/non-ACK evidence boundaries. | Plane contract lane a2a-plane#311 (a2a-plane#311, internal tracker private) has Start/direct-task evidence only at snapshot. | `NO-GO / Waiting`; merge before this libero closeout is treated as final. |
| GitHub assignment ingestion | `/a2a assign` issue comments create broker tasks or fail closed with diagnostics. Direct broker task creation can be used only as a documented workaround for this R15 run. | [a2a-broker#627](https://github.com/jinwon-int/a2a-broker/issues/627) documents that GitHub comment ingestion is blocked; parent [#623 comment](https://github.com/jinwon-int/a2a-broker/issues/623#issuecomment-4448416430) records direct task creation for all seven lanes. | `BLOCKER` for claiming normal GitHub assignment is fixed; not a production action. |
| Provider accepted/message-id boundary | Provider accepted-send, provider message IDs, GitHub comment URLs, PR creation, Terminal Brief titles, and runner summaries are evidence inputs only. They are not requester-visible receipt, operator-visible receipt, human-seen proof, terminal ACK, terminal-outbox ACK, or approval. | Existing contracts and checks preserve this boundary: `contracts/a2a/terminal-semantics.md`, `contracts/compatibility/terminal-evidence-ack-boundary.md`, `fixtures/terminal-evidence/accepted-send-non-ack.json`, and `npm run check:message-id-ack-boundary`. | `PASS for wording`; R15 activation remains `NO-GO` until separate receipt proof and explicit operator approval exist. |

## R15 lane snapshot

| Order | Worker | Repo issue | Assigned scope | Snapshot |
| --- | --- | --- | --- | --- |
| 1/7 | `bangtong` | [a2a-broker#624](https://github.com/jinwon-int/a2a-broker/issues/624) | Canonical Terminal Brief metadata schema and fail-closed task creation. | Start/direct-task evidence only. |
| 2/7 | `sogyo` | [openclaw-plugin-a2a#311](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/311) | Structured compact renderer fallback order and non-ACK wording. | Start/direct-task evidence only. |
| 3/7 | `nosuk` | [a2a-broker#627](https://github.com/jinwon-int/a2a-broker/issues/627) | GitHub `/a2a assign` ingestion endpoint/poller/diagnostics blocker. | Start/direct-task evidence only. |
| 4/7 | `yukson` | a2a-plane#311 (a2a-plane#311, internal tracker private) | Plane contract/conformance matrix for metadata, fan-in, renderer, and ACK boundary. | Start/direct-task evidence only. |
| 5/7 | `dungae` | [a2a-broker#625](https://github.com/jinwon-int/a2a-broker/issues/625) | Post-dispatch verifier and cross-broker origin fan-in. | Start/direct-task evidence only. |
| 6/7 | `jingun` | [a2a-docker-runner#255](https://github.com/jinwon-int/a2a-docker-runner/issues/255) | Runner summary/evidence compatibility. | Start/direct-task evidence only. |
| 7/7 | `soonwook` | a2a-plane#312 (a2a-plane#312, internal tracker private) | This libero end-to-end validation and merge/closeout plan. | Start evidence plus this PR after runner closeout. |

Start, queued, running, provider accepted-send, GitHub comment creation, and PR creation are not terminal lane evidence. Count a lane as terminal only when it has an explicit PR, Done, or Block marker and linked checks/evidence.

## Open R14 PR disposition

| PR | Current checks / merge state | Disposition for R15 |
| --- | --- | --- |
| [a2a-broker#620](https://github.com/jinwon-int/a2a-broker/pull/620) | CI green; `CLEAN`. | `MERGE_CANDIDATE` after fresh rebase/checks and bootstrap/artifact guard. It is adjacent hot-table retention hardening and does not replace R15 structured metadata gates. |
| [a2a-broker#621](https://github.com/jinwon-int/a2a-broker/pull/621) | CI failing; `BLOCKED`. | `MERGE_BLOCKED`. Do not merge unless fixed and revalidated. If R15 #624/#625 supersede the same dispatch/fan-in guard changes, close #621 into R15 with an explicit supersession comment. |
| [a2a-broker#622](https://github.com/jinwon-int/a2a-broker/pull/622) | CI green; `CLEAN`. | `MERGE_CANDIDATE` after fresh checks; worker onboarding/retargeting support can merge before R15 final closeout if it does not conflict with #624/#625/#627. |
| [a2a-broker#626](https://github.com/jinwon-int/a2a-broker/pull/626) | CI green; `CLEAN`. | `MERGE_CANDIDATE` after fresh checks; edge-secret diagnostics are independent. Keep secret values out of artifacts. |
| [openclaw-plugin-a2a#310](https://github.com/jinwon-int/openclaw-plugin-a2a/pull/310) | CI green; `CLEAN`. | `MERGE_CANDIDATE` only if compatible with the R15 renderer contract in #311. If #311 rewrites the same notifier/relay paths, close or merge-forward #310 into the R15 plugin PR instead. |
| [a2a-docker-runner#254](https://github.com/jinwon-int/a2a-docker-runner/pull/254) | CI green; `CLEAN`. | `MERGE_CANDIDATE` after checking temporary evidence files are redacted and do not contain runtime/bootstrap context. R15 #255 remains required for human-summary precedence. |
| a2a-plane#310 (a2a-plane PR #310, internal tracker private) | CI green; `CLEAN`. | `MERGE_CANDIDATE` for R14 two-broker validation docs/tests, then layer R15 #311/#312 on top. If conflicts appear, merge-forward the matrix into R15 and close #310 as superseded. |

## Recommended R15 merge and closeout sequence

1. **Stop the known-bad R14 path:** keep [a2a-broker#621](https://github.com/jinwon-int/a2a-broker/pull/621) blocked until CI is green or it is closed as superseded by R15.
2. **Land canonical broker creation first:** merge the R15 [#624](https://github.com/jinwon-int/a2a-broker/issues/624) PR only after tests prove canonical payload persistence and fail-closed rejection/normalization of top-level-only metadata.
3. **Land broker verifier/fan-in second:** merge the R15 [#625](https://github.com/jinwon-int/a2a-broker/issues/625) PR after #624 or with a rebased combined branch. Required tests: persisted snapshot verifier, origin/handoff parity, stable projection keys, no duplicate parent Terminal Brief rows, and no historical outbox replay.
4. **Resolve GitHub ingestion separately:** close [#627](https://github.com/jinwon-int/a2a-broker/issues/627) with a PR or Block marker before claiming `/a2a assign` works. Direct task creation is acceptable evidence for this R15 run only because the workaround is documented on [#623](https://github.com/jinwon-int/a2a-broker/issues/623#issuecomment-4448416430).
5. **Land plugin renderer:** merge the R15 [openclaw-plugin-a2a#311](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/311) PR after tests prove title/body separation, human summary precedence, runner-summary demotion, compact known-total and unknown-total rendering, and accepted-send/non-ACK wording.
6. **Land runner compatibility:** merge the R15 [a2a-docker-runner#255](https://github.com/jinwon-int/a2a-docker-runner/issues/255) PR after tests/evidence prove PR/Done/Block artifacts preserve human Terminal Brief summaries and do not leak runtime/bootstrap files.
7. **Land plane contracts:** merge the R15 a2a-plane#311 (a2a-plane#311, internal tracker private) PR after contract fixtures cover canonical metadata, malformed metadata rejection/normalization, origin fan-in, renderer fallback order, and provider accepted-send non-ACK semantics.
8. **Land libero closeout:** merge this a2a-plane#312 (a2a-plane#312, internal tracker private) PR only after the validation matrix still matches current sibling PR states, or update it before merge.
9. **Parent closeout:** post parent [#623](https://github.com/jinwon-int/a2a-broker/issues/623) Done/Block only after all seven child lanes have terminal PR/Done/Block markers, required checks are green, and any remaining R14 supersession comments are posted. Production activation, live canary, deploy/reload, and Terminal Brief ACK remain separate explicit-approval gates.

## Required checks before any R15 merge

- Relevant repo CI/build/test suite is green on the final branch.
- `npm run check:message-id-ack-boundary` remains green for A2A Nexus contract wording.
- New or changed tests cover both success and fail-closed cases for the lane.
- PR body and issue closeout state whether provider accepted-send/message IDs are non-ACK evidence only.
- No production deploy/restart/reload, live provider/Telegram send, DB mutation/prune/migration, Terminal Brief ACK/replay, historical outbox replay, release/tag, secret movement/disclosure, force-push/history rewrite, or visibility change occurred.
- Branch diff, PR body, issue comments, and artifact evidence exclude OpenClaw runtime/bootstrap context files. Before PR creation, fail closed and report exact repo-relative or artifact-relative offending paths for any `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`, `BOOTSTRAP.md`, `MEMORY.md`, or `memory/**` file.

## Verification performed for this lane

- Inspected parent [a2a-broker#623](https://github.com/jinwon-int/a2a-broker/issues/623), child a2a-plane#312 (a2a-plane#312, internal tracker private), and sibling R15 lane issues.
- Inspected open R14 PR status across broker, plugin, runner, and plane repositories.
- Ran local A2A Nexus validation checks listed in the PR evidence.
- Confirmed this patch adds documentation/test evidence only and does not create runtime/bootstrap files in the repository.
