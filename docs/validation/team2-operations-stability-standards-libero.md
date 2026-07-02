# Team2 operations stability + standards alignment libero cross-validation

Run: `a2a-ops-stability-and-standards-20260511T063530Z`
Parent: a2a-plane#232 (a2a-plane#232, internal tracker private)
Lane: Team2/workerEta, a2a-plane#234 (a2a-plane#234, internal tracker private)
Snapshot: `2026-05-11T06:55:00Z`

This is a redacted, no-live Team2 libero cross-validation of the operations-stability and A2A standards-alignment round. It checks issue/PR evidence only. It does not execute source-public approval, approval execution, release, repository visibility change, live provider or Telegram send, Terminal Brief ACK, production deploy/restart, Gateway/broker/worker restart, database mutation, secret change, history rewrite, force-push, automatic merge, or community posting.

## Libero verdict

**Round decision: `NO-GO / Waiting`.** The round cannot be treated as complete while any required Team1 or Team2 lane has only Start evidence, no terminal PR/Done/Block marker, an open/unmerged required PR, missing CI/test disposition, or missing explicit operator approval for any live-impact action.

Most referenced standards-alignment and historical operations-policy lanes have merged PR evidence, but the current runner false-failure recovery lane is still Start-only at this snapshot. That unresolved lane is enough to keep the aggregate in `NO-GO / Waiting`; the safe closeout is to preserve the matrix and refresh it after sibling terminal evidence lands.

## Current lane evidence matrix

| Area | Lane evidence | Snapshot evidence | Libero result |
| --- | --- | --- | --- |
| Runner false-failure recovery — [a2a-docker-runner#199](https://github.com/jinwon-int/a2a-docker-runner/issues/199) | Non-zero exit after successful PR creation should recover as completed, with tests proving false-failure does not mask real failures. | Start marker only: https://github.com/jinwon-int/a2a-docker-runner/issues/199#issuecomment-4418161724 | `NO-GO` until terminal PR/Done/Block evidence and test disposition exist. |
| Isolated runner visibility/cleanup — [a2a-docker-runner#159](https://github.com/jinwon-int/a2a-docker-runner/issues/159) | Runtime visibility, workspace cleanup, and safety policy hardening. | Closed by merged PR https://github.com/jinwon-int/a2a-docker-runner/pull/165 (`775fa35`); issue comments record main CI passed and no live provider/terminal ACK action. | Pass as prior merged operations-stability evidence; still not enough to close this round while #199 is unresolved. |
| Durable checkpoint / interrupt / trace policy — a2a-plane#93 (a2a-plane#93, internal tracker private) | Policy decision record for checkpointing, human interrupt, trace, and replay boundaries. | Closed by merged PR a2a-plane PR #180 (internal tracker, private) (`cea5ef5`); comments keep production persistence/live delivery deferred and approval-gated. | Pass for policy shape and no-live boundary. |
| Broker A2A task semantics — [a2a-broker#431](https://github.com/jinwon-int/a2a-broker/issues/431) | Map broker lifecycle to A2A 1.0 task states and terminal immutability. | PR marker https://github.com/jinwon-int/a2a-broker/issues/431#issuecomment-4411063434; merged PR https://github.com/jinwon-int/a2a-broker/pull/434 (`d8f7dc6`). | Pass after merge; terminal immutability remains a required compatibility invariant. |
| Worker Capability / AgentCard registry — [a2a-broker#432](https://github.com/jinwon-int/a2a-broker/issues/432) | Discovery and assignment safety registry compatible with task-state lane. | Done/PR evidence: https://github.com/jinwon-int/a2a-broker/issues/432#issuecomment-4410749661 and https://github.com/jinwon-int/a2a-broker/issues/432#issuecomment-4410750381; merged PR https://github.com/jinwon-int/a2a-broker/pull/433 (`215bb71`). | Pass after merge; public discovery must remain capability-scoped and operator-controlled. |
| Plugin conformance smoke gate — [openclaw-plugin-a2a#234](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/234) | Non-live A2A Inspector/a2a-python smoke gate for the plugin/broker public seam. | PR marker https://github.com/jinwon-int/openclaw-plugin-a2a/issues/234#issuecomment-4410918194; merged PR https://github.com/jinwon-int/openclaw-plugin-a2a/pull/235 (`625121c`). Follow-up evidence records no-provider-send invariant checks. | Pass after merge for no-live conformance shape. |
| Team2 libero cross-validation — a2a-plane#234 (a2a-plane#234, internal tracker private) | Independent cross-validation of Team1 and Team2 lane outputs against this matrix. | Start marker exists; this patch supplies the redacted validation artifact and regression test. | Pass for validation shape only; aggregate remains `NO-GO / Waiting`. |

## Cross-validation rules

1. **All required lanes need terminal evidence.** A Start marker is a claim, not completion. A PR marker is not enough unless the matrix also records merge/CI/test disposition or an explicit Done/Block closeout.
2. **No-live stays no-live.** Local tests, docs, merged PRs, scanner output, and provider message IDs are evidence inputs only; none become requester-visible receipt, operator-visible receipt, human-seen proof, Terminal Brief ACK, terminal-outbox ACK, source-public approval, or live execution authorization.
3. **Operator approval remains separate.** Even after every technical lane is green, source-public execution, release, visibility change, live sends, deploys/restarts, and production mutations require a later explicit operator approval naming exact refs and allowed actions.
4. **Compatibility terms must agree across repos.** Broker task-state semantics, Worker Capability/AgentCard discovery, plugin conformance, and runner closeout handling must all preserve additive public seams, terminal immutability, capability-scoped assignment, and fail-closed evidence handling.
5. **Fail closed on runtime/bootstrap hygiene.** Branch diff, PR body, issue comments, and artifact evidence must exclude `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**`. If any deny path would enter the branch or evidence, report the exact repo-relative offending paths and block instead of creating success evidence.

## Safe closeout

The safe closeout for this lane is a PR/Done marker saying Team2 cross-validation completed and the aggregate remains **`NO-GO / Waiting`** because [a2a-docker-runner#199](https://github.com/jinwon-int/a2a-docker-runner/issues/199) has Start-only evidence at this snapshot. Refresh this libero matrix after #199 and any later sibling lanes publish terminal PR/Done/Block evidence with tests, runtime/bootstrap hygiene remains clean, and any live-impact action has separate explicit operator approval.
