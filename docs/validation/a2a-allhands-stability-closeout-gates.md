# A2A read-only libero and stability closeout gates

Parent: [a2a-broker#539](https://github.com/jinwon-int/a2a-broker/issues/539)
Plane lane: a2a-plane#276 (a2a-plane#276, internal tracker private)
Primary trackers: [a2a-broker#527](https://github.com/jinwon-int/a2a-broker/issues/527), [a2a-broker#497](https://github.com/jinwon-int/a2a-broker/issues/497), [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294)
Snapshot: `2026-05-13T04:49Z`

This is a redacted, no-live Team2/workerEta libero validation artifact for the brokerAlpha-origin all-hands round. It is documentation/spec evidence only. It does not deploy, restart, mutate production databases or terminal-outbox rows, replay or ACK Terminal Brief outbox items, send provider or Telegram messages, expose secrets, publish a release, force-push, rewrite history, or approve repository visibility changes.

## Decision summary

- `a2a-broker#527` is a valid broker hardening requirement: GitHub read-only validation/libero work needs a first-class evidence lane that can finish with Start plus Done/Block comments without requiring a PR or repository diff.
- The existing no-diff false-Done guard must remain mandatory for patch-producing lanes such as `github-propose-patch`. A patch task that produces no commits and no PR is still Block evidence, not Done.
- `a2a-broker#497` and `a2a-broker#294` remain open residual-risk trackers. This plane patch defines operator closeout gates; it does not close broker OOM/state-growth, receipt-semantics, queue-hygiene, canary, deploy, cleanup, or ACK work.
- brokerAlpha-origin cross-broker Terminal Brief aggregation may be used as redacted evidence only when it is idempotent, bounded, and explicitly non-ACK/non-read-receipt/non-approval.

## `#527` read-only GitHub validation lane gate

The lane passes only if broker/runner evidence proves all of the following:

| Gate | Required evidence | Fail-closed condition |
| --- | --- | --- |
| Canonical read-only shape | A GitHub task with issue metadata uses `intent=verify` or `intent=analyze` and a read-only mode such as `github-verify`, `github-read-only-validation`, or `read-only-analysis`. | Broker coerces the task into `intent=propose_patch` or `payload.mode=github-propose-patch` only because GitHub issue metadata is present. |
| Evidence comments | The linked GitHub issue has a Start marker plus a Done or Block marker containing bounded validation commands/results. | Missing Start, missing terminal Done/Block, or terminal evidence is only an empty diff. |
| No PR/diff requirement | The read-only lane may finish with no repository changes and no PR when the Done/Block evidence explains the validation result. | Runner rejects a true read-only validation as `OpenClaw produced no repository changes; refusing false Done.` |
| Patch-lane guard preserved | `github-propose-patch` tasks still require a real diff and PR, or they produce Block/failure evidence. | Any patch task with no commits/no PR is marked Done or success. |
| Terminal Brief classification | Terminal Brief reports read-only validation Done/Block accurately and does not convert provider send success into receipt or ACK. | Completion/failure is hidden, duplicated, replayed from historical outbox, or treated as operator-visible receipt/terminal ACK. |
| Artifact hygiene | Branch diff, PR body, issue comments, and artifacts exclude secrets, raw logs, host-private paths, provider payloads, session dumps, and OpenClaw runtime/bootstrap context. | Any unsafe payload enters success evidence. |

The `a2a-plane#240` observed case in `a2a-broker#527` is the regression fixture: workerEta performed read-only validation, found the stale `issues/239` link for `a2a-plane#240`, and passed `npm run check:layout` plus `npm run check:no-diff-closeout-guidance`, but the runner failed because the task had been forced into the patch lane. A future broker fix should allow that exact validation shape to close with read-only Done/Block evidence while preserving patch-lane no-diff protection.

Suggested read-only validation commands for this plane-side gate:

```bash
npm run check:layout
npm run check:no-diff-closeout-guidance
npm run check:allhands-stability-closeout-gates
```

## `#497/#294` operator closeout gates

These gates are residual-risk criteria for broker stability and roadmap closeout. They are not production instructions and do not authorize deploy/restart, DB cleanup/prune, WAL mutation, live send, or terminal-outbox ACK.

### Broker hot-table memory/OOM gate (`a2a-broker#497`)

Before anyone claims stability closure, require all of:

- merged broker evidence for bounded SQLite hot-table loading, lazy/paged state access, retention, or equivalent memory-bounded behavior;
- read-only health/readiness output that reports process memory, heap/RSS pressure, relevant table counts, terminal outbox total/acked/unacked counts, and stale queue indicators without secrets or host-private paths;
- regression or soak evidence showing representative task/audit/outbox growth does not require unbounded startup heap or full snapshot serialization for each hot-row mutation;
- dry-run-first cleanup/prune controls with backup evidence before any production DB mutation;
- a closeout note explicitly separating source/test readiness from any later approved deploy, restart, cleanup, terminal ACK, live send, or secret change.

### Receipt/canary/queue gate (`a2a-broker#294`)

Before anyone claims roadmap closure, require all of:

- provider accepted-send, GitHub comment projection, and Terminal Brief evidence remain non-ACK and non-read-receipt evidence;
- projected terminal events preserve `isApproval: false`, `isTerminalAck: false`, and `isReadReceipt: false` unless a separate contract and operator approval say otherwise;
- live canary or notification activation is disabled by default and requires a fresh one-shot allowlist, replay suppression, explicit operator approval, bounded receipt proof, and post-run restoration evidence;
- queue hygiene shows no stale claimed/running work, no unbounded terminal-outbox backlog, and a clear no-change/evidence-only outcome path for validation/libero tasks;
- all GitHub evidence comments are bounded summaries, not raw logs, provider payloads, secrets, host-specific private paths, OpenClaw runtime/bootstrap context, or manual ACK/replay transcripts.

## brokerAlpha-origin cross-broker Terminal Brief evidence gate

For the all-hands round, brokerAlpha is the initiating parent broker while Team2 work may be handed off through brokerBeta. Accept a cross-broker Terminal Brief projection only if it includes:

- a stable projection key or idempotency marker;
- parent and lane references for `a2a-broker#539` and `a2a-plane#276` or the specific child lane;
- child issue or PR/Done/Block evidence URL;
- bounded summary and terminal kind (`pr`, `done`, or `block`);
- explicit non-live flags: no provider send, no terminal-outbox ACK, no read receipt, no approval, no historical outbox replay;
- runtime/bootstrap hygiene confirmation before the projection is copied into parent evidence.

If no projection has arrived yet, the correct aggregate state is `NO-GO / Waiting`, not `Done`. If a projection includes unsafe content, mark parent evidence as `Block` with a sanitized reason instead of copying the unsafe payload.

Suggested read-only watch commands:

```bash
gh issue view 539 --repo jinwon-int/a2a-broker --json comments,url,title,state
gh issue view 276 --repo a2a-plane (internal tracker, private) --json comments,url,title,state
gh search issues 'a2a-broker#539 OR a2a-plane#276 owner:jinwon-int' --json repository,number,title,state,url,commentsCount --limit 50
```

## Runtime/bootstrap hygiene gate

Before publishing PR, Done, or Block evidence for this lane, fail closed if any OpenClaw runtime/bootstrap context path would enter the branch or artifacts. Report the exact repo-relative offending paths and do not create success evidence.

Denied paths:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Safe closeout language for this lane is: **the read-only validation and stability gates are documented and tested; aggregate broker readiness remains `NO-GO / Waiting` until `#527/#497/#294` have merged implementation evidence, safe health/canary proof, runtime/bootstrap hygiene is clean, and any live-impact action has separate explicit operator approval.**
