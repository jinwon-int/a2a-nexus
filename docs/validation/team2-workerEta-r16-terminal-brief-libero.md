# Team2/workerEta R16 Terminal Brief notification fix libero validation

Issue: a2a-plane#316 (a2a-plane#316, internal tracker private)
Parent: [a2a-broker#631](https://github.com/jinwon-int/a2a-broker/issues/631)
Run: `r16-terminal-brief-libero-workerEta-20260514T0937Z`
Lane: `workerEta` / Team2 libero validation
Start marker: [a2a-plane#316 comment](a2a-plane#316 (internal tracker, private)#issuecomment-4449532046)

This is a redacted, no-live validation artifact for the R16 Terminal Brief live notification fix. It performs repository and GitHub evidence review only. It does not deploy, restart Gateway/broker/worker services, reload runtime config, send a live provider or Telegram canary, mutate/prune/migrate production databases, manually ACK or replay Terminal Brief terminal-outbox rows, replay historical tasks, publish a release/tag, move or disclose secrets, force-push, rewrite history, change repository visibility, or execute operator approval.

## Decision

**R16 closeout is `NO-GO / Waiting`.** The fix cannot be treated as complete until the broker payload lane and plugin notification-attempt lane each publish terminal PR, Done, or Block evidence, required tests are green, and a separate explicit operator approval authorizes any one-shot live canary scope.

Safe current closeout for this lane: this PR documents the validation matrix, canary checklist, and fail-closed merge criteria. It is not approval to merge implementation PRs, deploy/reload, send a provider canary, record Terminal Brief ACK, or claim operator-visible receipt/read visibility.

## R16 validation matrix

| Gate | Required R16 behavior | Current evidence snapshot | Closeout state |
| --- | --- | --- | --- |
| Broker payload metadata preservation | Terminal-outbox payload projection preserves the R15 structured Terminal Brief fields needed by renderer/projection: `parentRoundId`, `originBrokerId`, `brokerOfRecordId` or handoff/broker-of-record equivalent, `parentRoundOrder`/`parentRoundIndex`, `parentRoundTotal`, `childWorkerId`, human summary/body text, and `title`/`terminalBriefTitle`. | Parent [a2a-broker#631](https://github.com/jinwon-int/a2a-broker/issues/631) reports live canary rows with structured fields still null while summary survives. Broker lane [a2a-broker#632](https://github.com/jinwon-int/a2a-broker/issues/632) has Start evidence only at this snapshot. | `NO-GO / Waiting`; require broker PR/tests proving persisted task payload/result metadata survives into terminal-outbox records. |
| Plugin terminal-outbox poller attempt observability | For a fresh, allowed Terminal Brief row, the Gateway/plugin poller must record an observable bounded attempt: selected row id/task id, allowlist decision, cursor input/output, attempt count/timestamp, redacted provider adapter result, and skip/failure reason when no send occurs. | Plugin lane [openclaw-plugin-a2a#313](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/313) has Start evidence only. Parent #631 reports `attempts:0`, `receipt.status=accepted`, `ackAudit.decision=pending`, no `ack`, no `deliveredAt`, and no task-specific Telegram send log after the runtime update. | `NO-GO / Waiting`; require plugin PR/tests showing attempts are visible without leaking provider/chat secrets. |
| Cursor, allowlist, and backlog behavior | Polling must start from a safe cursor/`after_id` baseline, restrict live notification to an exact approved task/terminal-outbox id, and skip old windows/backlog rows without advancing into data loss. Cursor changes and allowlist decisions must be inspectable in dry-run/test output. | Parent #631 says a temporary cursor/allowlist did not produce a notification attempt. No terminal implementation evidence is posted yet for #313/#632. | `NO-GO`; a future canary must show only the approved fresh row was considered and no historical row was sent. |
| No historical replay, manual ACK/replay, or DB mutation | Validation and tests must not prune/mutate production DBs, manually mark terminal ACK, replay terminal-outbox rows, replay historical tasks, or broaden provider-send scope. Any production probe requires explicit operator approval naming the one fresh canary row and rollback criteria. | This lane performed docs/tests only. Parent and child issues state the same safety boundary. | `PASS for this validation PR`; remains a hard blocker for implementation/canary evidence. |
| Provider accepted-send versus receipt/ACK/read boundary | Provider accepted-send, provider message IDs, Telegram send logs, GitHub PR/Done/Block comments, and Terminal Brief text are evidence inputs only. They are not requester-visible receipt, operator-visible receipt, read visibility, terminal ACK, terminal-outbox ACK, or operator approval. | Existing A2A Nexus boundary checks remain the local source of truth: `contracts/a2a/terminal-semantics.md`, `contracts/compatibility/terminal-evidence-ack-boundary.md`, `fixtures/terminal-evidence/accepted-send-non-ack.json`, and `npm run check:message-id-ack-boundary`. | `PASS for wording`; live activation remains `NO-GO` until separate receipt/ACK evidence and explicit operator approval exist. |
| Runtime/bootstrap hygiene | Branch diff, PR body, issue comments, and artifact evidence must exclude OpenClaw runtime/bootstrap context files and unredacted session transcripts. If any denied path enters the branch or evidence, fail closed before PR creation and report the exact repo-relative or artifact-relative path. | Intended diff is limited to this validation document, its test, and package test wiring. | `PASS if final guard stays clean`; fail closed on any offending path. |

## R16 lane snapshot

| Worker | Repo issue | Assigned scope | Snapshot |
| --- | --- | --- | --- |
| `workerEpsilon` | [openclaw-plugin-a2a#313](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/313) | Fix plugin terminal-outbox poll loop, cursor/allowlist handling, attempt observability, and adapter result accounting. | Start evidence only at validation snapshot. |
| `workerZeta` | [a2a-broker#632](https://github.com/jinwon-int/a2a-broker/issues/632) | Preserve structured Terminal Brief metadata in broker terminal-outbox payload projection. | Start evidence only at validation snapshot. |
| `workerEta` | a2a-plane#316 (a2a-plane#316, internal tracker private) | This independent libero matrix and canary checklist. | Start evidence plus this PR after runner closeout. |

Start, queued, running, provider accepted-send, GitHub comment creation, and PR creation are not terminal lane evidence. Count a sibling lane as terminal only when it has an explicit PR, Done, or Block marker with linked checks/evidence.

## Future operator-approved canary checklist

A future live canary is allowed only after #632 and #313 land and a fresh explicit operator approval names the exact runtime update/reload scope, approved task or terminal-outbox id, provider route, maximum provider-send count, rollback/abort criteria, and evidence redaction requirements.

### Preconditions

- Broker and plugin branches are merged/deployed through the normal approved path; this validation PR does not deploy them.
- One fresh Terminal Brief candidate row is created after the cursor baseline; no old/backlog row is eligible.
- Allowlist is exact to the approved row/task, with `maxProviderSends=1` for the canary window.
- Evidence capture redacts provider/chat identifiers, tokens, host-private paths, raw environment values, and runtime context dumps.

### Pass criteria

- Broker terminal-outbox payload contains non-null structured metadata required by the renderer/projection.
- Plugin poller logs or artifacts show the fresh row selected by cursor and allowlist, with exactly one bounded notification attempt.
- Adapter result is recorded as provider accepted-send or provider failure/skipped with reason; the state is observable without exposing secrets.
- No historical/backlog row is attempted, replayed, ACKed, pruned, or mutated.
- Provider accepted-send is reported as non-ACK evidence only; terminal ACK, read visibility, requester-visible receipt, and operator-visible receipt remain separate fields/signals.

### Fail / abort criteria

- Required structured payload fields are still null or only available in top-level caller metadata.
- Attempts remain zero for the approved fresh row, or observability cannot distinguish skipped, failed, and sent states.
- More than one provider send is attempted, any old/backlog row is considered for send, or cursor handling is ambiguous.
- Any manual DB mutation, prune, terminal ACK, replay, historical task replay, secret exposure, or runtime/bootstrap evidence leak is required to make the result look successful.
- Provider accepted-send/message id must not be described as terminal ACK, read visibility, human-seen proof, or operator approval.

## Required checks before R16 closeout

- Broker lane #632 has PR/Done/Block evidence with tests for metadata extraction from persisted payload/result data into terminal-outbox projection.
- Plugin lane #313 has PR/Done/Block evidence with tests for cursor/allowlist/backlog handling and observable attempt accounting.
- `npm run check:message-id-ack-boundary` remains green for A2A Nexus receipt/ACK wording.
- This lane's validation test passes and the final diff remains docs/tests/package wiring only.
- No production deploy/restart/reload, live provider/Telegram send, DB mutation/prune/migration, Terminal Brief ACK/replay, historical outbox replay, release/tag, secret movement/disclosure, force-push/history rewrite, or visibility change occurred in this validation lane.
- Branch diff, PR body, issue comments, and artifact evidence exclude OpenClaw runtime/bootstrap context files. Before PR creation, fail closed and report exact repo-relative or artifact-relative offending paths for any `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`, `BOOTSTRAP.md`, `MEMORY.md`, or `memory/**` file.

## Verification performed for this lane

- Inspected parent [a2a-broker#631](https://github.com/jinwon-int/a2a-broker/issues/631), broker child [#632](https://github.com/jinwon-int/a2a-broker/issues/632), plugin child [openclaw-plugin-a2a#313](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/313), and this issue a2a-plane#316 (a2a-plane#316, internal tracker private).
- Added a local validation test that fails if required R16 gates, canary pass/fail criteria, ACK/receipt separation, or bootstrap hygiene language are removed.
- Confirmed this patch adds documentation/test evidence only and does not create runtime/bootstrap files in the repository.
