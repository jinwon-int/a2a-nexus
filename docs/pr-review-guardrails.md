# PR review and merge guardrail runbook

> Status: source-only operator runbook. This document does not authorize live
> service restarts, provider/default-model changes, force-pushes, database
> mutation, Terminal Brief ACK/replay, or release/publication actions.

This runbook is for Hermes-assisted review/merge work in `a2a-nexus` when the
operator needs to avoid long stalls, GraphQL quota failures, or dirty worktree
side effects.

## Failure pattern this prevents

Observed PR-review stalls can happen without `a2a`/`a2ad` runtime involvement.
The common failure chain is:

1. Hermes gateway or subagents run PR-review work on an unstable default model
   such as `openai-codex / gpt-5.5`.
2. Non-streaming subagent calls hit the no-byte watchdog and spend roughly
   `90s × 3 retries` per child before failing.
3. `gh pr list` and other `gh pr *` commands can consume or require GitHub
   GraphQL quota. When GraphQL remaining reaches `0`, those commands fail even
   while REST `core` quota remains available.
4. A failed merge/review attempt can leave the repo on a PR branch with
   untracked scan output, conflict residue, or other dirty files.
5. Follow-up review work starts from that dirty worktree and compounds the
   failure.

## Hard gates before reviewing a PR

Run the healthcheck from the repository root or pass `--worktree` explicitly:

```bash
node scripts/pr-review-healthcheck.mjs --worktree /root/work/a2a/a2a-nexus --repo jinwon-int/a2a-nexus
```

The healthcheck is read-only by default. It reports:

- Hermes model/delegation config summary without secrets;
- GitHub REST/core vs GraphQL rate limits;
- dirty worktree status;
- open PR inventory via REST;
- recent Hermes timeout/rate-limit log lines.

If the worktree is dirty, do **not** run `git reset --hard` by default. First
inspect:

```bash
git status --porcelain=v1 -uall
```

If the operator wants the current worktree cleared for review, create a safety
stash including untracked files:

```bash
git stash push -u -m "safety-stash-before-pr-review-$(date -u +%Y%m%d_%H%M%S)"
```

The healthcheck can do that only when explicitly invoked with `--stash`:

```bash
node scripts/pr-review-healthcheck.mjs --stash
```

## Model timeout guard

Before launching delegation-heavy PR reviews, check Hermes config and recent
logs:

```bash
node scripts/pr-review-healthcheck.mjs --log-lines 120
```

Risk signal:

- default model/provider is `gpt-5.5 / openai-codex`;
- `delegation.model` and `delegation.provider` are empty, so subagents inherit
  the default;
- logs contain `Non-streaming API call stale`, `timed out after 90s`, or
  `API call failed after 3 retries` for subagents.

Preferred mitigation is scoped to PR-review/delegation work rather than a global
default change:

1. Run review agents with an explicit stable model/provider override, or
2. set a dedicated delegation model/provider for the PR-review session/profile,
   then restart/reload only after operator approval.

Do not change live Hermes defaults or delegation provider settings without
operator approval.

## GitHub GraphQL exhaustion fallback

If `gh pr list`, `gh pr view`, or `gh pr checks` fails and GraphQL remaining is
`0`, check REST quota:

```bash
gh api rate_limit --jq '.resources | {core, graphql, search}'
```

When REST `core.remaining` is available, use REST endpoints instead of GraphQL:

```bash
# Open PR inventory
gh api 'repos/OWNER/REPO/pulls?state=open&per_page=100'

# PR details
gh api 'repos/OWNER/REPO/pulls/PR_NUMBER'

# Changed files
gh api 'repos/OWNER/REPO/pulls/PR_NUMBER/files?per_page=100'

# Check runs and combined statuses for the PR head SHA
HEAD_SHA=$(gh api 'repos/OWNER/REPO/pulls/PR_NUMBER' --jq '.head.sha')
gh api "repos/OWNER/REPO/commits/$HEAD_SHA/check-runs"
gh api "repos/OWNER/REPO/commits/$HEAD_SHA/status"
```

`node scripts/pr-review-healthcheck.mjs --pr PR_NUMBER` performs these REST
reads and avoids `gh pr list` GraphQL paths.

## Clean review workflow

Use a clean worktree or throwaway clone per PR batch:

```bash
mkdir -p /tmp/a2a-review
rm -rf /tmp/a2a-review/a2a-nexus
 git clone https://github.com/jinwon-int/a2a-nexus.git /tmp/a2a-review/a2a-nexus
cd /tmp/a2a-review/a2a-nexus
node scripts/pr-review-healthcheck.mjs --repo jinwon-int/a2a-nexus
```

For each PR:

```bash
PR=615
node scripts/pr-review-healthcheck.mjs --repo jinwon-int/a2a-nexus --pr "$PR"
git fetch origin "pull/$PR/head:review-pr-$PR"
git switch "review-pr-$PR"
git diff --stat origin/main...HEAD
git diff origin/main...HEAD --name-only
npm test
```

Then decide:

- **Merge** only after the branch is up to date, required checks are green, and
  there are no unresolved blocking review issues.
- **Docs-only** still needs stale branch update/rebase if required by protection,
  plus required checks before merge.
- **Request changes** when there is a blocking issue; leave a GitHub review with
  evidence instead of trying to force a merge.
- **Keep open / supersede** only with an explicit PR comment explaining the
  blocking state and next action.

## Merge boundary

The runbook does not grant approval for:

- force-push or history rewrite;
- branch protection/ruleset mutation;
- release tags, GitHub Releases, npm or Docker publication;
- production deploy/restart;
- database, queue, ACK/replay, or visibility changes;
- secrets or permission changes;
- Hermes gateway restart/reload or default model change.

Those require separate operator approval.
