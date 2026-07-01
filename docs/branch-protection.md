# Branch Protection Invariant for Auto-merge

This document records the branch protection / ruleset state that the
[`auto-merge`](../.github/workflows/auto-merge.yml) workflow depends on to stay
safe. It is the stable, ongoing reference for that invariant. The dated,
approval-gated execution plan for *applying* the settings lives in
[`history/monorepo-branch-protection-approval-packet.md`](history/monorepo-branch-protection-approval-packet.md);
this file describes the steady-state requirement those settings must satisfy.

> **No-go boundary:** This document does not apply, change, or remove branch
> protection or rulesets. GitHub settings mutation remains a separate,
> operator-approved action (see the approval packet and [`GOVERNANCE.md`](../GOVERNANCE.md)).

## Why auto-merge needs this

`auto-merge` runs after the `ci` workflow completes and merges only PRs that
GitHub itself reports as `mergeStateStatus == "CLEAN"`. `CLEAN` means *required
reviews are approved, required status checks pass, and there is no conflict*.

That single gate is only meaningful when branch protection actually marks
reviews and checks as **required**. If `main` has no protection, GitHub can
report `mergeStateStatus` values such as `UNSTABLE` or `HAS_HOOKS` — but it can
also report `CLEAN` for a PR with **no approving review** and **no required
checks**, because there is nothing to make those "required". In that state the
workflow would merge unreviewed PRs. The workflow code calls this out inline
(`auto-merge.yml`, the `mergeStateStatus != "CLEAN"` filter): the gate assumes
protection is present and is **not** a substitute for it.

## Required state

For auto-merge to be safe, `jinwon-int/a2a-nexus` `main` must enforce a ruleset
(recommended name `a2a-nexus-main-required-checks`) with at least:

- require a pull request before merge;
- require at least one approving review;
- dismiss stale approvals when new commits are pushed;
- require the branch to be up to date (or use a merge queue that does not break
  auto-merge);
- include administrators unless an operator explicitly exempts them;
- mark the always-required CI checks as **required status checks**:
  - `paths-filter`
  - `setup`
  - `layout`
  - `contracts`
  - `check`
- treat the path-aware package checks (`broker`, `docker-runner`, `plugin`) as
  required when their paths are touched. Skipped package jobs on unrelated PRs
  must not be read as proof a package stayed fresh; `paths-filter` makes the
  skip reason explicit.

The exact required-check list and its path-aware handling come from the
["Required-check Candidate"](history/monorepo-branch-protection-approval-packet.md#required-check-candidate)
and ["Proposed Settings Shape For Later Approval"](history/monorepo-branch-protection-approval-packet.md#proposed-settings-shape-for-later-approval)
sections of the approval packet; keep the two in sync.

## How to verify the invariant holds

These are read-only checks; none of them mutate settings.

```bash
# Branch protection must NOT be "404 Branch not protected" once a ruleset is applied.
gh api repos/jinwon-int/a2a-nexus/branches/main/protection >/dev/null && echo "protected"

# Repository rulesets must list the main ruleset (not an empty array).
gh api repos/jinwon-int/a2a-nexus/rulesets

# A normal green PR should report CLEAN; an unreviewed PR should NOT.
gh pr view <number> --json mergeStateStatus
```

If branch protection is absent (`404`) or the ruleset list is empty, the
auto-merge invariant is **not** satisfied: either apply the approval-gated
ruleset or disable the `auto-merge` workflow until it is in place.

## Failure mode if this regresses

If a future change relaxes or removes the ruleset while `auto-merge` stays
enabled, the `CLEAN` gate silently weakens and PRs can merge without review.
Treat any relaxation of `main` protection and any change to `auto-merge.yml` as
linked: update this document, the approval packet's required-check list, and the
workflow together.
