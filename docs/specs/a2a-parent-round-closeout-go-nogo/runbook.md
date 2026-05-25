# Parent-Round Closeout Runbook

> **Contract:** `contracts/a2a/parent-round-closeout-go-nogo-matrix.md`
> **Fixture:** `fixtures/contract/parent-round-closeout-go-nogo-matrix.json`
> **Validation:** `scripts/check-parent-round-closeout-go-nogo-matrix.mjs`
>
> This runbook is for the operator evaluating a parent-round closeout via the go/no-go matrix.
> It covers both automated (scanner) and manual (operator approval) gates.

## Prerequisites

- Parent round metadata is available: `parentRoundId`, `parentRoundTotal`, `parentRoundOrder`,
  `parentRoundProgress`, `originBrokerId`, `brokerOfRecordId`, `parentBrokerId`.
- All N child lanes have reached a terminal state or been explicitly cancelled.
- The operator has access to the parent issue on GitHub.
- The evaluating broker has read access to all lane evidence.
- The `gh` CLI is authenticated with a token that has `issue:read` scope (and `issues:write` if
  closeout is intended).

## Step 1: Gather lane evidence

For each child lane in the parent round:

```bash
# For lanes with PR evidence:
gh pr view <pr-url> --json state,mergedAt,body

# For lanes with Done evidence:
# Read the done comment on the issue or drill-evidence artifact.

# For lanes with Block evidence:
# Read the block comment on the issue or drill-evidence artifact.
```

Verify that each lane's terminal evidence carries all required fields (see
[Evidence requirements](#evidence-requirements) in the contract).

## Step 2: Run the go/no-go matrix evaluator

```bash
node scripts/check-parent-round-closeout-go-nogo-matrix.mjs \
  --spec docs/specs/a2a-parent-round-closeout-go-nogo/schema.json \
  --round-metadata <path-to-round-metadata.json> \
  --lane-evidence <path-to-lane-evidence.json>
```

The evaluator outputs a JSON report with:

- `decision`: `GO`, `NO_GO`, or `BLOCKED`
- `gateResults`: status of each gate (PASS/FAIL/BLOCKED)
- `blockers`: details of any FAIL or BLOCKED gates

### Interpreting results

| Decision | Meaning | Next step |
|---|---|---|
| `GO` | All gates pass. The parent round is closeable by Seoseo. | Proceed to Step 3. |
| `NO_GO` | One or more gates fail but no unsafe condition. | Proceed to Step 4. |
| `BLOCKED` | An unsafe condition was detected (evidence not redacted, runtime/bootstrap leak, 403, or conflict). | Proceed to Step 5. |

## Step 2a: Comment-only mode (optional)

For a read-only comment on the parent issue without closing it:

```bash
node scripts/check-parent-round-closeout-go-nogo-matrix.mjs \
  --spec docs/specs/a2a-parent-round-closeout-go-nogo/schema.json \
  --round-metadata <path-to-round-metadata.json> \
  --lane-evidence <path-to-lane-evidence.json> \
  --mode comment_only
```

### When to use comment_only

- You want a human-readable draft on the issue before deciding whether to close.
- You want cross-team visibility of the closeout matrix.
- You need to verify GitHub permissions before full closeout.

### What comment_only produces

| Output | Value |
|--------|-------|
| `decision` | GO/NO_GO/BLOCKED (same evaluation as dry-run) |
| `commentPosted` | true (if GO and permission check passes) |
| `issueClosed` | false (never closes the issue) |
| `commentUrl` | URL of the posted comment |
| `idempotencyKey` | Key used for suppression |
| `duplicateSuppressed` | true if same key/payload already posted |

### Example draft comment (GO decision)

```markdown
## A2A Parent Round Closeout — GO (comment-only)

**Parent round:** a2a-team1-round-001
**Origin broker:** seoseo
**Parent broker:** seoseo
**Decision:** GO (all gates pass)
**Mode:** comment_only — this issue is **not** closed

### Lane summary

| Lane | Terminal kind | Evidence |
|------|--------------|----------|
| 1 | PR | https://github.com/jinwon-int/a2a-plane/pull/449 |
| 2 | Done | Resolved all blocking checks |
| 3 | Done | Updated runbook with rollback section |
| 4 | PR | https://github.com/jinwon-int/a2a-plane/pull/450 |

### Gate results (all PASS)

[...gate details...]

### Safety disclaimer

This is a comment-only notification. The parent issue remains open.
No PRs were merged. No terminal ACK was performed. No production
mutation occurred.
```

### comment_only NO_GO or BLOCKED

If the matrix returns NO_GO or BLOCKED in comment_only mode, no comment is posted.
The operator is expected to resolve the gates first, then re-run.

### Rollback from comment_only

If a comment_only post was erroneous:

1. **Do not delete the comment.** Comments are evidence. Post a follow-up correction instead.
2. **The issue remains open** — no further action needed.
3. **Do not mutate the closeout ledger.**

## Step 3: GO — Execute closeout (Seoseo only)

Only Seoseo (or a broker explicitly designated as finalizer) may execute parent issue closeout.

### 3a. Post the Go decision comment

```bash
gh issue comment <parent-issue-url> \
  --body "$(cat closeout-comment-body.md)"
```

The comment body must include:

- The go/no-go matrix decision (`GO`)
- A summary of each lane's terminal evidence (PR/Done/Block/Cancelled by count)
- The `parentRoundId`, `originBrokerId`, `parentBrokerId`
- A statement confirming all gates passed
- The closeout idempotency key

### 3b. Close the parent issue

```bash
gh issue close <parent-issue-url> \
  --comment "Parent-round closeout completed. See Go decision comment for details."
```

### 3c. Record the closeout in the ledger

```json
{
  "parentRoundId": "...",
  "decision": "GO",
  "closeoutCommentUrl": "https://github.com/.../issues/N#issuecomment-...",
  "closeoutTimestamp": "<ISO-8601>",
  "idempotencyKey": "a2a-parent-round-closeout:<parentRoundId>:<originBrokerId>:<timestamp>",
  "duplicateSuppressed": false,
  "github403Detected": false
}
```

## Step 4: NO_GO — Resolve and retry

### Common NO_GO causes

| Gate | Typical cause | Resolution |
|---|---|---|
| G1 All lanes terminal | A lane is still `queued` or `running` | Wait for the lane to finish, or cancel it explicitly. |
| G2 Lane evidence completeness | A terminal lane has missing evidence | The lane must be re-executed or the evidence manually completed. |
| G3 Required metadata | A metadata field is missing or invalid | Fix the metadata at the orchestrator/broker level. |
| G6 No live action leak | A lane's evidence shows an unapproved live action | The round is permanently NO_GO for this lane; operator must decide. |
| G9 Seoseo finalizer | Non-Seoseo broker attempted closeout | Only Seoseo may close. Inform Seoseo. |

### Retry

1. Fix the underlying cause (wait for lanes, complete evidence, fix metadata).
2. Re-run the go/no-go matrix evaluator (Step 2).
3. A new idempotency key is derived from the new evaluation timestamp (rounded to hour).
4. Repeat until Go or operator escalation.

## Step 5: BLOCKED — Operator escalation

### Common BLOCKED causes

| Gate | Typical cause | Resolution |
|---|---|---|
| G4 Evidence redaction | Lane evidence contains secrets, private paths, or raw dumps | Review and redact; operator may unblock. |
| G5 Runtime/bootstrap hygiene | Branch or artifact contains `AGENTS.md`, `SOUL.md`, `USER.md`, etc. | Remove offending files; operator may unblock after confirmation. |
| G7 GitHub permission | 403 on comment post or issue close | Fix token scope or repo write permission; operator may unblock. |
| G8 Idempotency conflict | Same key, different payload | Operator must review both payloads and decide which is authoritative. |
| G10 Cross-lane projection blocked | A lane's parent projection has state `blocked` | Operator reviews the blocked lane's evidence. |

### Unblock procedure

1. Review the BLOCKED gate(s) and the evidence.
2. If the block is resolvable (redact files, fix token, resolve conflict):
   a. Make the fix.
   b. Re-run the go/no-go matrix evaluator.
   c. If re-run returns Go, proceed to Step 3.
   d. If re-run returns No-Go, proceed to Step 4.
3. If the block is not resolvable (permanent permission issue, unsafe task):
   a. Leave the parent round in BLOCKED state.
   b. Post a block summary comment on the parent issue.

## Step 6: Post-closeout verification

After closeout (Go → CLOSEOUT state):

1. Verify the parent issue is closed.
2. Verify the Go decision comment is visible on the issue.
3. Verify no duplicate comments were posted (idempotency held).
4. Verify no unapproved side effects: no PRs merged automatically, no releases published,
   no live provider messages sent, no database mutations, no terminal-outbox ACK rows changed.
5. Verify runtime/bootstrap files did not enter any published evidence.

## Rollback considerations

### Closeout rollback

If closeout was erroneous:

1. **Comment rollback**: The Go decision comment is evidence. Do not delete it. If the operator
   determines the closeout was incorrect, post a follow-up comment explaining the reversal.
2. **Issue reopen**: The operator may reopen the parent issue with a comment explaining why.
   This is not automated.
3. **No data mutation**: Rollback does not delete ledger entries, mutate terminal outbox, or
   restart services.

### comment_only rollback

If a comment_only post was erroneous:

1. **Do not delete the comment.** Comments are evidence. Post a follow-up correction.
2. **The issue remains open** — no further action needed.
3. **No ledger mutation.**

### No-op rollback (403 or permission failure)

If GitHub 403 is detected:

1. **No comment was posted or issue was closed** (depending on when the 403 occurred).
2. Record the 403 in the closeout ledger with `operatorActionRequired: true`.
3. The round transitions to BLOCKED state. Operator must resolve the permission issue and
   re-run.
4. Rollback is **metadata-only**: no evidence is deleted or overwritten.

### Explicit non-actions (always preserved across rollback)

No rollback operation may perform any of:

- Parent issue close
- PR merge
- Manual terminal ACK/replay
- Historical outbox replay
- Production DB mutation
- Gateway/broker/worker restart
- Live provider/Telegram send
- Secret rotation or disclosure
- Repository visibility change
- Force-push or history rewrite
- Release, tag, or npm publish

If any of these would be needed for recovery, contact the Seoseo operator.

## Emergency stop

If a serious safety violation is detected mid-evaluation:

1. Abort the evaluation (Ctrl+C / SIGINT the script).
2. Verify no GitHub write operations were performed (check the closeout ledger).
3. Post an explanatory comment on the parent issue.
4. Contact the Seoseo finalizer operator.
