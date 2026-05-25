# Parent-Round Closeout Go/No-Go Matrix (v0)

> **v0 (2026-05-20):** Automatic parent-round closeout go/no-go matrix defining the state machine,
> metadata, evidence requirements, idempotency, and GitHub 403 rollback/no-op behavior for Team1
> source-only/no-live auto-closeout. This contract does not authorize production auto-closeout,
> production deploy, worker/broker/Gateway restart, live Telegram/provider send, production DB
> mutation/prune/migration, terminal ACK/replay, historical outbox replay, release/tag/publish,
> credential movement, secret disclosure, automatic PR merge, or parent issue close.

## Motivation

A parent round aggregates N child lanes (worker tasks) toward a single parent issue. When all N
lanes reach a terminal result (PR, Done, or Block), the parent round may be a candidate for
automatic closeout. This contract specifies the exact decision matrix that determines whether the
parent round is Go (closeable), No-Go (not yet ready), or Blocked (unsafe to close), and what
evidence must accompany each outcome.

## Actors

- **Parent broker**: broker that owns the parent round (aggregation ledger, notification dispatch).
  Metadata field: `parentBrokerId`.
- **Origin broker**: broker that created the parent round metadata. May equal or differ from the
  parent broker. Metadata field: `originBrokerId`.
- **Broker of record**: broker that owns the specific child lane's lifecycle, worker assignment,
  and terminal evidence production. Metadata field: `brokerOfRecordId`.
- **Worker**: execution surface that produces a terminal PR/Done/Block result for one lane.
- **Seoseo**: designated finalizer broker. No other broker may close the parent issue.

## State machine

### Parent-round lifecycle states

```
                          ┌──────────────────────────────────────────────────┐
                          │                                                  │
                          ▼                                                  │
                    ┌──────────┐                                            │
                    │  ACTIVE  │                                            │
                    └────┬─────┘                                            │
                         │                                                  │
                         │ All N lanes terminal (PR/Done/Block/cancelled)    │
                         ▼                                                  │
                    ┌────────────┐                                          │
                    │ CANDIDATE  │── Go decision ──► ┌──────────┐           │
                    └─────┬──────┘                    │ CLOSEOUT │           │
                          │                           │(Seoseo   │           │
                          │ No-Go: missing lanes,     │ only)    │           │
                          │ pending evidence,         └──────────┘           │
                          │ or blocked projection                           │
                          ▼                                                  │
                    ┌──────────┐     ┌────────────────────────────────────────┘
                    │ WAITING  │────► New child lane arrives or
                    └──────────┘     retry re-dispatched
                                     → back to ACTIVE
```

| State | Meaning | Allowed next states |
|---|---|---|
| `ACTIVE` | Parent round is open; child lanes are being dispatched and worked. `parentRoundProgress < parentRoundTotal`. | `CANDIDATE`, `BLOCKED` |
| `CANDIDATE` | All N lanes have terminal results (PR/Done/Block/cancelled). The parent round is eligible for closeout evaluation. | `CLOSEOUT`, `WAITING`, `BLOCKED` |
| `CLOSEOUT` | Seoseo has approved and executed the closeout: a Go/comment/close action on the parent issue. Terminal. | — |
| `WAITING` | At CANDIDATE, the go/no-go matrix returned No-Go. The round waits for missing lanes, retries, or operator intervention. | `ACTIVE` |
| `BLOCKED` | At any state, the go/no-go matrix returned Blocked (unsafe evidence, permission failure, or redaction violation). Terminal. | — |

### Child lane terminal events → aggregation

Each child lane produces one terminal event:

```
child: PR ──► parent projection: pr evidence
child: Done ──► parent projection: done evidence
child: Block ──► parent projection: block evidence
child: Cancelled ──► parent projection: cancelled evidence
```

When `parentRoundProgress == parentRoundTotal` (all N lanes have produced terminal projections
or are explicitly cancelled), the parent round transitions from `ACTIVE` to `CANDIDATE`.

### Candidate → closeout decision flow

1. Verify `parentRoundProgress >= parentRoundTotal` (all lanes accounted for).
2. Compute the go/no-go matrix from all lane projections.
3. If Go → Seoseo (and only Seoseo) may close the parent issue:
   a. Post a Go decision comment with the matrix summary.
   b. Close the parent issue.
   c. Transition to `CLOSEOUT`.
4. If No-Go → transition to `WAITING`. The round stay open for retries or new lanes.
5. If Blocked → transition to `BLOCKED`. Seoseo reviews and either overrides (Go) or leaves
   blocked.

## Go/No-Go matrix

### Decision outputs

| Output | Meaning |
|---|---|
| `GO` | All gates pass; the parent round may be closed by Seoseo. |
| `NO_GO` | One or more gates have not passed, but the round is not unsafe. Wait for resolution. |
| `BLOCKED` | A gate detected unsafe evidence, permission failure, or redaction violation. Requires operator review. |

### Gates

Each gate evaluates to `PASS`, `FAIL`, or `BLOCKED`. A single `BLOCKED` sets the overall
decision to `BLOCKED`. A single `FAIL` with no `BLOCKED` gates sets the overall decision to
`NO_GO`. All gates must `PASS` for a `GO` decision.

| # | Gate | Fail condition | Blocked condition | Automated under source-only? |
|---|---|---|---|---|
| G1 | **All lanes terminal** | One or more lanes still in `queued`, `claimed`, or `running` state | — | Yes (read-only status check) |
| G2 | **Lane evidence completeness** | Any terminal lane has no evidence URL, no terminal summary, or missing projection fields | — | Yes (read-only validation) |
| G3 | **Required metadata present** | Missing any of: `parentRoundId`, `parentRoundTotal`, `parentRoundOrder`, `parentRoundProgress`, `originBrokerId`, `brokerOfRecordId`, `parentBrokerId` | — | Yes (read-only validation) |
| G4 | **Evidence redaction** | — | Any lane's terminal evidence contains unredacted secrets, runtime/bootstrap files, provider IDs, host-private paths, or raw session dumps | Yes (automated scanner), but BLOCKED always requires operator review |
| G5 | **Runtime/bootstrap hygiene** | — | `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` found in branch diff, PR comment, or artifact evidence | Yes (automated scan); BLOCKED always requires operator |
| G6 | **No live action leak** | Any lane's terminal evidence shows `liveProviderSend: true`, `terminalOutboxAckMutated: true`, `isApproval: true`, `isTerminalAck: true`, `isReadReceipt: true`, or an unapproved production-side effect | — | Yes (read-only check of evidence booleans) |
| G7 | **GitHub permission check** | — | GitHub API returns 403 on comment post or issue close attempt | No — always requires operator approval |
| G8 | **Idempotency check** | Duplicate closeout already recorded with the same `parentRoundId` | Conflicting idempotency key (same key, different payload) | Yes (read-only check); conflict requires operator |
| G9 | **Seoseo finalizer** | The broker attempting closeout is not Seoseo | — | Always operator-gated; Seoseo is never automated |
| G10 | **Cross-lane projection status** | Any lane's parent projection has state `pending` or `conflict` | Any lane's parent projection has state `blocked` | Yes (read-only check); blocked requires operator |

### Decision algorithm

```
if any gate == BLOCKED:
    decision = BLOCKED
elif any gate == FAIL:
    decision = NO_GO
else:
    decision = GO

default decision (no input / startup): NO_GO
source-only execution mode: NO_GO (must be overridden by Seoseo operator decision)
```

### Gate actionibility matrix

| Gate | Can automated scanner PASS it? | Can automated scanner FAIL it? | Can automated scanner BLOCK it? | Operator override available? |
|---|---|---|---|---|
| G1 All lanes terminal | Yes | Yes | No | No (gates must resolve naturally) |
| G2 Lane evidence completeness | Yes | Yes | No | No (missing evidence must be produced) |
| G3 Required metadata present | Yes | Yes | No | No (metadata must be present) |
| G4 Evidence redaction | Yes | Yes | Yes (auto-block) | Yes (operator may review and unblock) |
| G5 Runtime/bootstrap hygiene | Yes | Yes | Yes (auto-block) | Yes (operator may review and unblock) |
| G6 No live action leak | Yes | Yes | No | No (live action leak is permanent fail) |
| G7 GitHub permission check | Yes (read-only 403 probe) | Yes | Yes (403 = auto-block) | Yes (operator must review and approve) |
| G8 Idempotency check | Yes | Yes | Yes (conflict = auto-block) | Yes (operator reviews conflict) |
| G9 Seoseo finalizer | Yes (read-only check) | Yes | No | Only Seoseo can close; non-Seoseo cannot override |
| G10 Cross-lane projection status | Yes | Yes | Yes (blocked projection) | Yes (operator reviews blocked lane) |

## Required metadata

Every parent round and every child lane projection must carry these metadata fields:

| Field | Scope | Required | Description |
|---|---|---|---|
| `parentRoundId` | Parent round | Yes | Stable id minted by `originBrokerId` before first child dispatch. Immutable for the round lifetime. |
| `parentRoundTotal` | Parent round | Yes | Total number of child lanes in this round (N). Must be set before child dispatch begins. |
| `parentRoundOrder` | Parent round | Yes | Order of this lane within the parent round (1-indexed, ≤ `parentRoundTotal`). |
| `parentRoundProgress` | Parent round | Yes | Number of child lanes that have reached a terminal state. Must be ≤ `parentRoundTotal`. |
| `originBrokerId` | Parent round | Yes | Broker that created the parent round metadata. Immutable. |
| `brokerOfRecordId` | Child lane | Yes | Broker that owns the child lane's lifecycle and terminal evidence. |
| `parentBrokerId` | Parent round | Yes | Broker that owns the parent round aggregation and notification dispatch. May equal or differ from `originBrokerId`. |

### Metadata validation rules

1. All seven fields are required for the round-level closeout evaluation. If any field is missing
   from the parent round metadata, the closeout evaluation must fail gate G3.
2. `parentRoundId` must be stable across all child projections in the round. A mismatch between
   child projections and the parent round is a conflict (blocked gate G8).
3. `parentRoundOrder` must be unique within the round. Duplicate orders constitute a metadata
   conflict.
4. `parentRoundProgress` must never exceed `parentRoundTotal`. A progress > total value is a
   validation error that blocks closeout.
5. `originBrokerId` must not be rewritten by child brokers, handoff brokers, or replay handlers.
6. `brokerOfRecordId` is per-lane; a lane may have a different broker of record than the parent
   broker or origin broker.

## Evidence requirements

### PR evidence (terminal kind = `pr`)

| Field | Required | Description |
|---|---|---|
| `terminalKind` | Yes | Must be `pr` |
| `terminalEvidenceUrl` | Yes | PR URL (https://github.com/.../pull/N) |
| `prUrl` | Yes | Same as `terminalEvidenceUrl` |
| `changedFilesSummary` | Yes | Count or brief summary of changed files |
| `rootCheckResult` | Yes | Pass/fail for root-level checks (lint, test, conformance) |
| `safetyConfirmation` | Yes | Statement that no live actions were performed |
| `redacted` | Yes | Must be `true` |
| `liveProviderSend` | Yes | Must be `false` |
| `terminalOutboxAckMutated` | Yes | Must be `false` |
| `isApproval` | Yes | Must be `false` |
| `isTerminalAck` | Yes | Must be `false` |
| `isReadReceipt` | Yes | Must be `false` |

### Done evidence (terminal kind = `done`)

| Field | Required | Description |
|---|---|---|
| `terminalKind` | Yes | Must be `done` |
| `terminalSummary` | Yes | Human-readable summary of what was done |
| `changedFiles` | Yes | List or count of changed files |
| `checksRun` | Yes | What validation checks were executed |
| `safetyConfirmation` | Yes | Statement that no live actions were performed |
| `redacted` | Yes | Must be `true` |
| `liveProviderSend` | Yes | Must be `false` |
| `terminalOutboxAckMutated` | Yes | Must be `false` |
| `isApproval` | Yes | Must be `false` |
| `isTerminalAck` | Yes | Must be `false` |
| `isReadReceipt` | Yes | Must be `false` |

### Block evidence (terminal kind = `block`)

| Field | Required | Description |
|---|---|---|
| `terminalKind` | Yes | Must be `block` |
| `blockerCategory` | Yes | One of: `unsafe`, `impossible`, `permission_denied`, `redaction_violation`, `metadata_conflict`, `operator_abort` |
| `blockerReason` | Yes | Concise human-readable reason |
| `safeEvidenceLinks` | Yes | Links to any safe redacted evidence supporting the block decision |
| `redacted` | Yes | Must be `true` |
| `liveProviderSend` | Yes | Must be `false` |
| `terminalOutboxAckMutated` | Yes | Must be `false` |
| `isApproval` | Yes | Must be `false` |
| `isTerminalAck` | Yes | Must be `false` |
| `isReadReceipt` | Yes | Must be `false` |

### Cancelled evidence (terminal kind = `cancelled`)

| Field | Required | Description |
|---|---|---|
| `terminalKind` | Yes | Must be `cancelled` |
| `cancellationSource` | Yes | One of: `operator`, `timeout`, `block_escalation` |
| `cancellationSummary` | Yes | Brief reason for cancellation |
| `partialWorkNotPromoted` | Yes | Confirmation that no partial work was promoted, merged, or released |
| `redacted` | Yes | Must be `true` |
| `liveProviderSend` | Yes | Must be `false` |
| `terminalOutboxAckMutated` | Yes | Must be `false` |
| `isApproval` | Yes | Must be `false` |
| `isTerminalAck` | Yes | Must be `false` |
| `isReadReceipt` | Yes | Must be `false` |

## Idempotency and duplicate notification handling

### Idempotency key

Every parent-round closeout evaluation must carry an idempotency key:

```
idempotencyKey = "a2a-parent-round-closeout:<parentRoundId>:<originBrokerId>:<decisionTimestamp>"
```

The key is derived from the parent round metadata and the current evaluation timestamp rounded
to the nearest hour (to allow re-evaluation within the same hour window without key conflicts).

### Replay suppression

1. **First evaluation**: Create a closeout record with the idempotency key. If Go, post the
   closeout comment and close the parent issue.
2. **Replay (same key, same payload)**: Return the existing closeout record. Do not post a
   duplicate comment or mutate the parent issue again. Set `duplicateSuppressed: true`.
3. **Conflict (same key, different payload)**: Reject the new evaluation. The previous
   closeout record is preserved. Set `conflictDetected: true` and require operator review.

### Duplicate notification handling

| Scenario | Behavior |
|---|---|
| Multiple lanes post PR/Done/Block at the same time | Each projection has its own `projectionKey`. The parent aggregation ledger deduplicates by `projectionKey`. No duplicate parent notifications. |
| Same lane reaches terminal twice (replay) | Replay with identical `projectionKey` returns existing projection; `newProjectionCreated: false`. |
| Parent round reaches CANDIDATE multiple times | Only the first evaluation that returns Go produces a closeout action (comment + close). All subsequent evaluations are suppressed by the idempotency key. |
| Same parent round evaluated by different brokers | Each broker has its own idempotency key scope (includes `brokerOfRecordId`). Only Seoseo's evaluation may result in closeout. Other brokers' evaluations are informational only. |
| GitHub webhook re-delivers the same event | The idempotency key is computed from the event payload, not the webhook delivery id. Same event → same key → suppressed. |
| Broker restarts mid-evaluation | The idempotency key check is performed atomically before any irreversible action. A restart causes the evaluation to retry with the same key; the existing record is returned. |

## GitHub 403 rollback/no-op behavior

### Detection

When GitHub API returns HTTP 403 during closeout-related operations:

1. **Comment post 403**: GitHub refuses to create the closeout comment (e.g., repo archived,
   comment disabled, rate-limited, token lacks `issue:write` scope).
2. **Issue close 403**: GitHub refuses to close the parent issue (e.g., repo archived, token
   lacks `issues:write` scope).

### Rollback procedure (no-op safe)

For a **comment post 403**:

1. Do not retry the comment post automatically. Retrying a 403 is unlikely to succeed and may
   escalate rate limits.
2. Record the 403 as evidence in the closeout ledger:
   ```json
   {
     "github403Detected": true,
     "github403Operation": "issue_comment_create",
     "github403ResponseSummary": "HTTP 403: token lacks `issue:write` scope or repo is archived",
     "closeoutState": "comment_failed",
     "issueCloseNotAttempted": true,
     "operatorActionRequired": true
   }
   ```
3. Transition the parent round to `BLOCKED` state (not failed, not waiting).
4. Set the gate G7 (GitHub permission check) to `BLOCKED`.
5. The overall decision becomes `BLOCKED`. No parent issue close is attempted.

For an **issue close 403** (comment already posted, close fails):

1. Do not retry the close automatically.
2. Record the 403 as evidence:
   ```json
   {
     "github403Detected": true,
     "github403Operation": "issue_close",
     "github403ResponseSummary": "HTTP 403: token lacks `issues:write` scope or repo is archived",
     "closeoutState": "close_failed",
     "commentPosted": true,
     "operatorActionRequired": true
   }
   ```
3. Transition the parent round to `BLOCKED` state (the comment exists but the issue is still
   open).
4. Set the gate G7 to `BLOCKED`.
5. The overall decision becomes `BLOCKED`.

### No-op safety invariants

1. A 403 rollback never: deletes the comment, reopens the issue, mutates the terminal outbox,
   restarts services, sends provider messages, or modifies production databases.
2. A 403 rollback is always metadata-only: ledger records + state transition.
3. The operator is always notified (via the blocked state and the `operatorActionRequired: true`
   flag). No automated retry is attempted.
4. If the 403 is transient (token scope was added since), the operator may manually override
   the `BLOCKED` gate and retry closeout. The automation will not retry.

## Wiki / Runbook update candidates

The following Wiki and runbook artifacts should be created or updated when this contract is
adopted:

### New artifacts

| Artifact | Location | Content |
|---|---|---|
| Parent-round closeout runbook | `docs/specs/a2a-parent-round-closeout-go-nogo/runbook.md` | Step-by-step operator runbook for evaluating the go/no-go matrix, reading gate status, and executing closeout |
| Closeout state machine diagram | `docs/specs/a2a-parent-round-closeout-go-nogo/state-machine.md` | Mermaid state machine diagram with all states and transitions |
| GitHub 403 troubleshooting guide | `docs/specs/a2a-parent-round-closeout-go-nogo/github-403-guide.md` | Troubleshooting guide for GitHub 403 during closeout |
| Closeout validation fixture | `fixtures/contract/parent-round-closeout-go-nogo-matrix.json` | Synthetic fixture covering Go, No-Go, Blocked scenarios, with idempotency and 403 coverage |
| Validation script | `scripts/check-parent-round-closeout-go-nogo-matrix.mjs` | Node.js script that validates the fixture against the matrix |

### Existing artifacts to update

| Artifact | Update |
|---|---|
| `contracts/a2a/github-evidence-projection.md` | Add a note referencing the parent-round closeout matrix for how 403 affects evidence projection |
| `docs/validation/parent-terminal-brief-aggregation-checklist.md` | Add a cross-reference section for closeout gate checks |

## Comment-only mode

`comment_only` is a closeout mode that posts a GitHub comment on the parent issue with the
go/no-go matrix summary and finalizer draft, but does **not** close the issue, merge any PR,
ACK terminal outbox rows, or perform any other write action. This addresses the comment_only
approval gate requirement from [#437](https://github.com/jinwon-int/a2a-plane/issues/437).

### When to use comment_only

- Operator wants a human-readable draft before committing to close.
- Preflight review of the closeout evidence and matrix decision.
- Cross-team visibility before the finalizer (Seoseo) closes the issue.
- Catching permission errors before attempting full closeout.

### What comment_only does

1. Evaluates the full go/no-go matrix (same as `dry-run`/`simulate`).
2. If the matrix returns GO, produces a draft comment body containing:
   - The go/no-go matrix decision (GO/NO_GO/BLOCKED).
   - A summary of each lane's terminal evidence (PR/Done/Block/Cancelled by count).
   - The parent round metadata (`parentRoundId`, `originBrokerId`, `parentBrokerId`).
   - A statement confirming all gates passed (or failed/blocked if not GO).
   - The closeout idempotency key.
   - A disclaimer that this is a comment-only notification; the issue is **not** closed.
3. Posts the comment to the parent issue via GitHub API.
4. Records the comment URL in the closeout ledger.
5. Returns `commentPosted: true`, `issueClosed: false`.

### What comment_only does NOT do

| Action | Status |
|--------|--------|
| Close the parent issue | ❌ Disabled — requires separate operator approval |
| Merge any PR | ❌ Disabled |
| ACK terminal outbox rows | ❌ Disabled |
| Historical outbox replay | ❌ Disabled |
| Production DB mutation | ❌ Disabled |
| Gateway/broker/worker restart | ❌ Disabled |
| Live provider/Telegram send | ❌ Disabled |
| Secret rotation or disclosure | ❌ Disabled |
| Force-push or history rewrite | ❌ Disabled |

### comment_only idempotency

The same idempotency key rules apply:

- `idempotencyKey = "a2a-parent-round-closeout:<parentRoundId>:<originBrokerId>:<decisionTimestamp>"`
- First run: create the closeout record, post the comment.
- Replay (same key, same payload): return existing record with `duplicateSuppressed: true`. No duplicate comment.
- Conflict (same key, different payload): reject with `conflictDetected: true`. Operator review required.

### comment_only draft generation

Before posting, the draft must be operator-visible for review. The draft is produced in
Markdown format and includes:

```markdown
## A2A Parent Round Closeout — GO (comment-only)

**Parent round:** <parentRoundId>
**Origin broker:** <originBrokerId>
**Parent broker:** <parentBrokerId>
**Decision:** GO (all gates pass)
**Mode:** comment_only — this issue is **not** closed

### Lane summary

| Lane | Terminal kind | Evidence |
|------|--------------|----------|
| 1 | PR | <pr-url> |
| 2 | PR | <pr-url> |
| 3 | Done | <done-summary> |
| 4 | ... | ... |

### Gate results (all PASS)

- All lanes terminal: PASS
- Lane evidence completeness: PASS
- ...

### Idempotency

Key: `<idempotency-key>`
Duplicate suppressed: false

### Safety disclaimer

This is a comment-only notification. The parent issue remains open.
No PRs were merged. No terminal ACK was performed. No production
mutation occurred.
```

### comment_only gate (G11)

The comment_only gate evaluates:

1. Mode is `comment_only` (not `dry-run` or `simulate`).
2. A non-empty draft comment body is produced and operator-visible.
3. GitHub permission check passes (can post comments).
4. Idempotency check passes (no duplicate or conflict).
5. All other closeout gates pass.

If the gate fails, the overall decision becomes NO_GO (not BLOCKED — the existing
evaluation is still valid, just not ready for comment posting).

### Rollback from comment_only

If a comment_only post was erroneous:

1. **Do not delete the comment**. Comments are evidence. If the operator determines the
   draft was incorrect, post a follow-up comment explaining the correction.
2. **Do not close the issue**. comment_only never closes the issue. The operator retains full
   control.
3. **Do not mutate the closeout ledger**. The existing comment posted record stands as
   evidence. If a new comment_only evaluation produces a corrected draft, it will use a new
   idempotency key (different timestamp).

## Explicit non-actions (safety boundaries)

Regardless of mode (`dry-run`, `simulate`, `comment_only`), the following actions require
separate explicit operator approval and are never executed automatically:

| Action | Approval format |
|--------|----------------|
| Parent issue close | Comment naming the exact issue URL |
| PR merge | Comment naming the exact PR URL |
| Manual terminal ACK/replay | Comment with terminal outbox row IDs |
| Historical outbox replay | Comment with replay scope justification |
| Production DB mutation/prune/migration | Comment naming exact mutation scope |
| Gateway/broker/worker restart | Comment naming the service and window |
| Live provider/Telegram send | Comment naming exact task ID, round ID, and provider target |
| Secret rotation/movement/disclosure | Comment with secret reference (not value) |
| Repository visibility change | Comment |
| Force-push or history rewrite | Comment |
| Release, tag, or npm publish | Comment naming exact version |

These non-actions are also recorded in the `forbiddenLiveFlags` array of the closeout schema.
Any evidence showing any of these flags as `true` causes gate G6 (no live action leak) to fail.

## Safety gates

1. **source-only**: This contract is source-only documentation and fixture/script code. It does
   not, by itself, enable production auto-closeout. A separate operator approval gate and
   configuration change is required for production activation.
2. **no-live**: No action in this contract authorizes production deploy, broker/worker/Gateway
   restart, live Telegram/provider send, production DB mutation/prune/migration, terminal
   ACK/replay, historical outbox replay, release/tag/publish, credential movement, secret
   disclosure, automatic PR merge, or parent issue close.
3. **comment_only gate**: Even in comment_only mode, the draft must be operator-visible before
   posting. No close/merge/ACK/replay/DB mutation/restart/deploy is performed.
4. **Seoseo finalizer**: Only Seoseo may close the parent issue. No other broker, worker, or
   automated process may issue the close command.
5. **Provider accepted/message-id evidence**: Provider accepted/message-id evidence is
   accepted-send only (receipt level 1). It is never read/visibility proof (level 3), terminal
   ACK (level 4), or operator approval.
6. **Runtime/bootstrap hygiene**: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`,
   `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**` must not enter the branch, PR text, issue
   comment, or artifact evidence. If detected, block the closeout with exact repo-relative
   offending paths.
7. **Default NO_GO**: The default decision without explicit input is `NO_GO`. Source-only
   execution mode is `NO_GO` until overridden by a Seoseo operator decision.

## Activation plan (approval-gated, not executed)

This contract does not authorize live activation. The following approval-gated steps document
the future activation plan:

| Step | Action | Automation level | Operator approval required? |
|---|---|---|---|
| A1 | Verify the go/no-go matrix script reads the parent round metadata and produces correct Go/No-Go/Blocked output | Automated (test run) | No (read-only test of already-merged code) |
| A2 | Verify idempotency key derivation and replay suppression in the matrix script | Automated (test run) | No |
| A3 | Verify GitHub 403 simulation produces correct rollback/no-op ledger entry | Automated (test run with mock 403) | No |
| A4 | Enable the closeout evaluator in a staging environment with read-only mode | Staging config | Yes (operator approval naming staging env) |
| A5 | Execute one staging round: dispatch synthetic lanes, verify CANDIDATE→Go matrix, verify the evaluator produces correct evidence but does not close the issue | One-shot staging run | Yes (separate approval naming task id and round id) |
| A6 | Verify no live actions, no unapproved GitHub API calls outside the synthetic round | Audit | No (read-only post-action check) |
| A7 | Present GO decision to Seoseo operator for production activation | — | Yes (explicit GO approval naming production round, scope, and provider target) |
