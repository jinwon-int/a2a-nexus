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
applied ruleset itself, not in a planning document. Read the live list with
`gh api repos/<owner>/<repo>/branches/main/protection --jq
.required_status_checks.contexts` and keep it in sync with the job names in
[`ci.yml`](../.github/workflows/ci.yml).

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
