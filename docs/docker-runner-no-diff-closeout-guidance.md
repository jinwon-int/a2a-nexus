# Docker Runner Branch/No-Diff PR Failure — Plane Closeout Guidance

Issue: #102 (a2a-plane#102, internal tracker private)
Parent hardening: [jinwon-int/a2a-broker#446](https://github.com/jinwon-int/a2a-broker/issues/446)
Roadmap: [jinwon-int/a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294)
Failed evidence lane: [jinwon-int/a2a-broker#443](https://github.com/jinwon-int/a2a-broker/issues/443)

## Decision

**Active guidance / class documented.** This document defines the plane-side operator closeout procedure for the Docker Runner branch ownership mismatch class observed in the nosuk lane. It does not authorize deploys, service restarts, production database mutations, live provider/Telegram sends, terminal-outbox ACK mutations, secret rotation, secret disclosure, history rewrites, or force-pushes.

## Classification: No-Commits / Branch Ownership Mismatch

When a Docker Runner `github-propose-patch` task completes with `ok: true` but produces zero commits between the runner branch and `origin/main`, the plane **must** classify the outcome as a **branch ownership mismatch** rather than a successful no-op or clean Done.

### Failure signature

| Signal | Expected | Observed in nosuk lane |
|---|---|---|
| Runner exit status | `ok: true`, `status: "completed"` | Matches |
| PR URL in evidence | Present (expected in propose_patch mode) | Absent |
| Commits between runner branch and `origin/main` | ≥1 patch commit | **0 (no diff)** |
| Runner branch | Matches task checkout branch | May differ from expected (ownership mismatch) |
| HEAD SHA vs `origin/main` SHA | HEAD ahead of origin/main | HEAD == origin/main (no divergence) |

### Root cause

The Docker Runner container cloned the target repo and executed the configured patch commands, but the resulting working tree produced **no commits distinct from `origin/main`**. This occurs when:

1. **Branch ownership mismatch**: The runner checked out a branch that was not the intended patch branch (e.g., the runner started on `main` instead of a feature branch, or a previous checkout left the repo in an unexpected state).
2. **Command no-op**: The patch command(s) executed but produced no file changes (e.g., a `propose_patch` task with missing or misconfigured patch command scripts).
3. **Pre-existing fix**: The issue was already resolved on `main` before the runner task executed, making the patch a true no-op.

In all cases, the plane must treat the absence of a PR + zero-diff evidence as a **blocking condition** for the evidence lane, not as a clean closeout.

## Operator Closeout Procedure

### Step 1: Collect evidence

Before closing the lane or accepting the runner result as terminal evidence, collect the following from the runner artifacts and task metadata:

| Evidence field | Source | Example |
|---|---|---|
| **task ID** | `task.json` → `id`, runner `result.taskId` | `"task-nosuk-042"` |
| **runner branch** | `result.github.branch`, artifact `branch=` line | `"fix/issue-42"` or `"main"` |
| **current branch** (if different) | Container logs or `git branch` output in artifacts | `"a2a-patch-20260509-..."` |
| **HEAD SHA** | `result.github.commit`, artifact `commit=` / `sha=` line | `"9ac8228..."` |
| **origin/main SHA** | `git rev-parse origin/main` captured in runner logs | `"9ac8228..."` |
| **issue URL** | `task.issueUrl`, `result.github.issueUrl` | `"a2a-plane#102 (internal tracker, private)"` |
| **branch URL** | Derived from runner branch + repo | `"a2a-plane (internal tracker, private)tree/fix/issue-42"` |
| **no-diff marker** | `git diff origin/main...HEAD --stat` → empty output, or `HEAD == origin/main` comparison | `"no-diff: HEAD equals origin/main"` |
| **branch-mismatch marker** | When runner branch ≠ expected patch branch, or branch URL points to `main` | `"branch-mismatch: expected fix/issue-42, got main"` |

### Step 2: Determine classification

```
if (HEAD SHA == origin/main SHA) {
  if (runner branch != expected patch branch) {
    → BRANCH_MISMATCH  // Different branch than task requested
  } else if (no commits between HEAD and origin/main) {
    → ZERO_DIFF  // Same branch, zero divergence
  }
} else {
  if (no PR URL in evidence) {
    → MISSING_PR  // Commits exist but PR not created (different failure class)
  }
}
```

| Classification | Closeout action | Marker |
|---|---|---|
| **BRANCH_MISMATCH** | Block the lane. Evidence is a branch ownership failure — the runner operated on an unintended branch. Re-dispatch the task after verifying branch checkout configuration. | `branch-mismatch` |
| **ZERO_DIFF** | Block the lane. The patch command produced no changes. Verify patch command configuration (`A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT` / `A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON`). | `no-diff` |
| **MISSING_PR** | Block the lane. Commits exist but PR creation failed. Review runner logs for GitHub API failures. | `missing-pr` |

> **Important**: None of these outcomes should be classified as `Done`. They are all Block evidence that requires operator (seoseo) attention before the lane can close.

### Step 3: Post evidence

When the lane is blocked with a no-diff/branch-mismatch classification:

1. Post a Block comment on the linked issue (the runner's `collectGitHubEvidence` posts this automatically when `!result.ok` or no PR URL is detected).
2. Preserve the evidence fields listed in Step 1 in the lane closeout record.
3. Reference [jinwon-int/a2a-broker#446](https://github.com/jinwon-int/a2a-broker/issues/446) as the parent broker fix tracking issue.
4. Do not close the lane until the broker-side fix is validated and a re-dispatched task produces a valid PR.

### Step 4: Re-dispatch after fix

After the broker fix in [jinwon-int/a2a-broker#446](https://github.com/jinwon-int/a2a-broker/issues/446) is deployed:

1. Verify the runner task configuration includes correct branch checkout settings.
2. Verify patch command configuration is present and valid.
3. Re-dispatch the task with the same issue URL.
4. Confirm the re-dispatched task produces a PR with ≥1 commit distinct from `origin/main`.

## Safety Constraints (mandatory)

All closeout activity must obey these constraints:

- **No production deploy/restart.** This document is plane-side guidance only.
- **No Gateway/broker/worker restart.** Evidence collection and classification are read-only.
- **No production DB mutation.** Do not modify broker task tables or terminal outbox rows during closeout.
- **No live provider/Telegram send.** Block/Done markers are GitHub comments, not live notifications.
- **No terminal-outbox ACK.** Provider send success is not receipt evidence.
- **No raw secret logging.** Redact tokens, private paths, and host-specific identifiers from all evidence.
- **Do not weaken OpenClaw runtime/bootstrap file leak checks.** The guard paths (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`) must not enter the branch or evidence.

## Public-Readiness Status

**NO-GO / Waiting.** This closeout guidance does not unblock public repository visibility:

- Upstream PR [openclaw/openclaw#78261](https://github.com/openclaw/openclaw/pull/78261) is closed/superseded. Do not claim public-readiness is unblocked by that closure; provider message-id evidence remains non-ACK and A2A terminal evidence/replay-safety/scanner/operator-approval gates still apply.
- External secret scanner evidence remains unavailable (fail-closed).
- Explicit operator approval for repository visibility is still required.

The public-readiness decision matrix in [docs/public-readiness.md](./public-readiness.md) remains authoritative. This document is an operator procedure reference only — it does not override, amend, or satisfy any public-readiness gate.

## Cross-References

| Reference | Description |
|---|---|
| [jinwon-int/a2a-broker#446](https://github.com/jinwon-int/a2a-broker/issues/446) | Parent broker hardening issue for branch ownership mismatch fix |
| [jinwon-int/a2a-broker#443](https://github.com/jinwon-int/a2a-broker/issues/443) | Failed evidence lane for nosuk no-diff PR failure |
| [jinwon-int/a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294) | A2A broker roadmap |
| a2a-plane#102 (internal tracker, private) (a2a-plane#102, internal tracker private) | This plane closeout issue |
| [openclaw/openclaw#78261](https://github.com/openclaw/openclaw/pull/78261) | Closed/superseded upstream context; no longer a merge gate |
| [docs/public-readiness.md](./public-readiness.md) | Authoritative public-readiness decision matrix |
| [packages/docker-runner/docs/design.md](../packages/docker-runner/docs/design.md) | Docker Runner task lifecycle design |
| [packages/docker-runner/docs/integration.md](../packages/docker-runner/docs/integration.md) | Handler integration and failure modes |

## Version

- **Schema version**: `a2a.plane.closeout-guidance.v1`
- **Created**: 2026-05-09
- **Lane**: nosuk
- **Round**: R8 (post-R7 closeout refresh)
