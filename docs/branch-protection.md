# Branch Protection Invariant for Auto-merge

This document records the branch protection / ruleset state that the
[`auto-merge`](../.github/workflows/auto-merge.yml) workflow depends on to stay
safe. It is the stable, ongoing reference for that invariant. The settings it
describes are applied; the one-off approval packet that planned their rollout
was retired once they were.

> **No-go boundary:** This document does not apply, change, or remove branch
> protection or rulesets. GitHub settings mutation remains a separate,
> operator-approved action (see [`GOVERNANCE.md`](../GOVERNANCE.md)).

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
  - `finalizer-verdict-gate` (#1499, enforced 2026-08-07)
- treat the path-aware package checks (`broker`, `docker-runner`, `plugin`) as
  required when their paths are touched. Skipped package jobs on unrelated PRs
  must not be read as proof a package stayed fresh; `paths-filter` makes the
  skip reason explicit.
- block merges on new high-or-critical CodeQL findings via a `code_scanning`
  ruleset rule (#1499, enforced 2026-08-07):
  `{ tool: "CodeQL", security_alerts_threshold: "high_or_higher", alerts_threshold: "errors" }`.

### Verdict-required vs verdict-optional paths

`finalizer-verdict-gate` is safe to require globally because it is **carrier-scoped,
not path-scoped**. It verifies whatever verdicts a PR carries; it does not decide
which PRs must carry one.

- **Verdict-optional (the default).** A PR with no files under
  `.a2a/finalizer-verdicts/` passes as "no verdict-carrying changes". Every
  ordinary PR is in this class, which is why requiring the check did not block
  the existing flow.
- **Verdict-required (carrier PRs).** A PR that places `<slug>.json` there has
  each verdict verified in enforce mode against the PR head SHA, fail-closed:
  registered key, subject bound to that head, `decision === "go"`, independent of
  the producing worker keys.

So the guarantee this required check buys is **"an attached verdict is real"**,
not **"every change was independently finalized"**. Do not describe it as the
latter — `contracts/a2a/finalizer-verdict.md` and
`.a2a/finalizer-verdicts/README.md` state the same boundary.

Both directions were verified live on 2026-08-07 rather than assumed: a PR with
no verdict files passed the required check and merged (#1752), and a PR carrying
a forged verdict produced `finalizer-verdict-gate: FAILURE` with
`mergeable: MERGEABLE` but `mergeStateStatus: BLOCKED` (#1754, closed unmerged).

### Before changing this ruleset

The ruleset API is a **whole-object `PUT`**. Omitting a rule does not leave it
alone — it deletes it. On 2026-08-07 an operator-approved protection change on a
sibling repo silently dropped an existing required check exactly this way, and it
was only caught by comparing merge timestamps against check-completion times.

Read the current ruleset, build the new payload from that readback, apply, then
**re-read and diff the controls you did not intend to touch** — at minimum
`required_status_checks`, `required_approving_review_count`,
`dismiss_stale_reviews_on_push`, `strict_required_status_checks_policy`,
`enforcement`, and `bypass_actors`.

This repo's ruleset has `bypass_actors: []` and `current_user_can_bypass: never`.
There is **no admin escape hatch** here: a ruleset that blocks everything can only
be undone by another `PUT`. Keep a rollback payload before applying.

The exact required-check list and its path-aware handling now live in the
applied ruleset itself, not in a planning document. Read effective rules with
`gh api repos/<owner>/<repo>/rules/branches/main` (and any classic protection
separately) and keep status-check contexts in sync with the job names in
[`ci.yml`](../.github/workflows/ci.yml).

### Required checks as of 2026-08-15

```
paths-filter, setup, layout, broker, docker-runner, contracts, docs,
promotion-capstone, check, finalizer-verdict-gate,
TCK readiness projection is current,
promoted TCK category — agent_card,
promoted TCK sub-category — version negotiation,
promoted TCK sub-category — artifact/message projection,
promoted TCK sub-category — error codes and ErrorInfo,
promoted TCK sub-category — task not found / invalid task,
promoted TCK sub-category — streaming / subscribe ordering
```

The seven `TCK …` contexts are the job names of the promoted-category gate
(`.github/workflows/tck-promoted-gate.yml`, #1500 enforcement follow-up,
2026-08-15). Requiring them is safe only because that workflow runs on every
pull request and skips the TCK jobs through an intra-workflow `changes` filter
when no TCK-affecting path is touched: skipped jobs satisfy required checks.
It would **not** be safe to require checks from a workflow-level
`paths:`-filtered workflow — non-matching PRs would never report and every
unrelated PR would deadlock.

`plugin` was removed from this list when `packages/openclaw-plugin-a2a` and its
CI job were retired. A required check whose job no longer exists never reports,
so it blocks every PR — deleting a job and leaving its context in the ruleset is
a merge deadlock. Removing a job and removing its required check are one change,
even though one lands in a PR and the other is a settings mutation.

This list is a snapshot for orientation, not the source of truth. The ruleset is,
and it is mutable — read it with the command above before relying on it.

## Merge queue rollout

CI preparation is separate from settings activation. The `ci`, `codeql`,
`tck-promoted-gate` and `finalizer-verdict-gate` workflows accept `merge_group`.
Path filters compare `merge_group.base_sha` with `merge_group.head_sha`, not a
moving default branch, so the complete queued diff determines package/TCK jobs.
Queue jobs check out the synthetic group commit, not an individual PR head.

After this preparation merges, an operator may add only a `merge_queue` rule to
the freshly read ruleset, preserving reviews, required checks, CodeQL, strictness
and bypass actors. Initial target: `ALLGREEN`, `SQUASH`, one entry per build/merge,
60-minute check timeout. This document does not assert activation has occurred.

`auto-merge` retains its conservative `CLEAN` filter and requests queue admission
with `gh pr merge --auto --squash --match-head-commit`. A racing head update is
rejected. It is a best-effort convenience, not a liveness guarantee: if review
arrives after CI, or a PR is `BEHIND`, a maintainer may request admission with
`gh pr merge NUMBER --auto --squash --match-head-commit REVIEWED_FULL_SHA`
without bypassing required controls. Record that full SHA during review; if it
moves, re-review rather than silently substituting the latest head.
Repository branch cleanup happens after actual merge, not enqueue.

### Queue verification checklist

- Record the reviewed PR head separately from the synthetic queue SHA and
  `merge_group` run URL. Use exact-head admission; never reuse approval after
  a head change or on another PR.
- Inspect effective rules **and** classic protection. Their required-context
  union, not just either list, must report on the queue commit.
- Confirm path-selected package/TCK jobs execute when relevant; a legitimate
  unrelated-path skip is not evidence that the package was tested.
- Record the actual merged PR state and commit after queue checks complete.
  Admission or an earlier green PR build alone does not close the rollout.

### Signed verdict boundary

The existing gate stays fail-closed and verifies against the event head (the
synthetic SHA on queue events). A verdict signed for an individual PR SHA is
**not** a signature for the combined queue commit. No carrier JSON is currently
tracked; ordinary no-carrier PRs remain supported. Verdict-carrying queue groups
are not claimed supported: a PR-head-bound verdict will block them. Do not skip
the gate, accept an arbitrary ancestor SHA, or switch to warn to admit a carrier.
A separately reviewed group-to-PR evidence-binding design is required before
using carriers through the queue; until then stop and escalate that lane.

Activation requires a real `merge_group` run on `gh-readonly-queue/main/...`
with all required contexts satisfied and the PR actually merged. Keep the
pre-change ruleset payload. If activation deadlocks, re-read and remove only the
new queue rule, verifying all unrelated controls remain unchanged; do not blindly
PUT an old snapshot over concurrent settings changes. No broker restart,
provider call, deployment or release is authorized by this source change.

## How to verify the invariant holds

These are read-only checks; none of them mutate settings.

```bash
# Effective rules include ruleset-based protection; classic protection may be 404.
gh api repos/jinwon-int/a2a-nexus/rules/branches/main

# Repository rulesets must list the main ruleset (not an empty array).
gh api repos/jinwon-int/a2a-nexus/rulesets

# A normal green PR should report CLEAN; an unreviewed PR should NOT.
gh pr view <number> --json mergeStateStatus
```

A classic-protection `404` alone does not mean the branch is unprotected.
Inspect effective rules and any classic protection together. If neither enforces
the required review/check controls, the auto-merge invariant is **not** satisfied:
either apply the approval-gated ruleset or disable `auto-merge` until it is in place.

## Failure mode if this regresses

If a future change relaxes or removes the ruleset while `auto-merge` stays
enabled, the `CLEAN` gate silently weakens and PRs can merge without review.
Treat any relaxation of `main` protection and any change to `auto-merge.yml` as
linked: update this document, the approval packet's required-check list, and the
workflow together.
