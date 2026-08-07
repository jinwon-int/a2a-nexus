# Repository health metrics

[`GOVERNANCE.md`](../../GOVERNANCE.md) commits to measuring repository health by
review-evidence cardinality and closeout completeness rather than pull-request
velocity. That commitment is a principle; this document is the measurable
definition behind it — what each metric counts, which API or checker produces
it, what the floor is, and what a breach means.

This is the last open scope bullet of [issue #1507][issue-1507] ("define metrics
that prefer review evidence cardinality and closeout completeness over PR
velocity").

> **No-go boundary:** this document defines measurement only. It does not delete
> branches, change branch protection, rulesets, or CODEOWNERS, close or reopen
> issues, or mutate any GitHub state. Every figure below is produced by
> read-only API reads or existing read-only checkers. Deploy, restart, live
> send, database, ACK, and release actions are out of scope.

## 1. REC — review-evidence cardinality

**Definition.** For one pull request, the number of distinct logins that
submitted an `APPROVED` review on it and are not the pull request's author.

**Scope — in-scope pull requests.** Merged pull requests whose `base.ref` equals
the repository default branch (`main`).

Stacked patch pull requests — an `a2a-patch-*` head merging into an
`a2a-patch-*` base — are **out of scope**. The ruleset
`a2a-nexus-main-required-checks` targets `~DEFAULT_BRANCH`, so it does not apply
to them by design; their content reaches `main` only through a base pull request
that *is* in scope and *is* subject to the floor.

This scoping rule is not cosmetic. Measuring REC over *all* merged pull requests
reports a false floor breach: on 2026-08-08 that naive query flagged
[#1720][pr-1720] and [#1693][pr-1693] as approval-free merges. Both are stacked
patch pull requests whose base was another `a2a-patch-*` branch, and the ruleset
had `required_approving_review_count: 1` with `bypass_actors: []` continuously
since 2026-06-10 (ruleset version `40034335`). Re-scoping to `base.ref == main`
returns a 0% breach rate. **A REC report that does not state its base-ref scope
is not a REC report.**

**Source.** `GET /repos/{owner}/{repo}/pulls/{number}/reviews`, counting
`state == "APPROVED"` where `user.login != pull_request.user.login`.

**Floor.** `REC >= 1` for every in-scope merged pull request. The floor is
enforced at merge time by the ruleset (`required_approving_review_count: 1`,
`bypass_actors: []`), so this metric is an independent read-back of an enforced
invariant, not the enforcement itself.

**Breach.** Any in-scope merged pull request with `REC == 0`. A single breach
means the ruleset was weakened, bypassed, or scoped away from a branch that
reaches `main` — investigate the ruleset version history
(`GET /repos/{owner}/{repo}/rulesets/{id}/history`) before assuming reviewer
behaviour changed.

## 2. Reviewer bus factor and concentration

**Definition.** Over a window of in-scope merged pull requests:

- **bus factor** — the number of distinct author-independent approvers;
- **max approver share** — the largest single approver's share of all
  author-independent approvals in the window.

**Floor.** `bus factor >= 2`. This is the metric form of the CODEOWNERS primary
plus designated backup reviewer described in `GOVERNANCE.md` and encoded in
[`.github/CODEOWNERS`](../../.github/CODEOWNERS).

**Watch threshold.** `max approver share >= 80%` means review ownership is
re-concentrating even though the bus factor still reads 2 — the exact failure
#1507 was opened against. It is a signal to review routing, not an automatic
breach.

## 3. CC — closeout completeness

**Definition.** Over issues closed with `state_reason == "completed"` that
contain a task list, the fraction whose items are all reconciled. An issue is
reconciled when every task-list box is checked, **or** it carries the
`closeout-exception` label together with a comment recording an item-by-item
disposition whose citations resolve.

**Source.** [`scripts/check-issue-closeout-hygiene.mjs`](../../scripts/check-issue-closeout-hygiene.mjs)
for the reconciliation state and
[`scripts/check-disposition-references.mjs`](../../scripts/check-disposition-references.mjs)
for citation resolvability. Both run weekly in
[`closeout-hygiene.yml`](../../.github/workflows/closeout-hygiene.yml).

**Enforcement cutoff.** `2026-07-02T06:00:00Z` (`ENFORCEMENT_CUTOFF` in the
checker). Closes before it are reported as a legacy count and are not breaches;
closes at or after it are.

**Floor.** `CC == 100%` for closes at or after the cutoff.

**Breach.** A red `closeout-hygiene` run *is* this metric reporting a breach.
It resolves by reopening the issue or applying `closeout-exception` with an
item-by-item disposition — never by re-running the job. A red run that is left
red is not a flaky check; it is an unread floor breach.

## 4. Pull-request velocity

Merged pull requests per unit time is a **denominator**, not a target. It
normalizes the metrics above (a 0% REC breach rate over 3 pull requests is
weaker evidence than over 60) and has no floor of its own. Raising velocity
never satisfies a floor in sections 1–3, and a high merge rate is not evidence
of review health.

## Baseline snapshot — 2026-08-08

Read-only measurement over `jinwon-int/a2a-nexus`. Reproduce with the API reads
named in each section; the figures below are a dated observation, not a
committed invariant.

| Metric | Window | Value | Floor | State |
| --- | --- | --- | --- | --- |
| REC floor breaches | 60 merged PRs with `base.ref == main`, 2026-07-29 .. 2026-08-07 | 0 (60/60 have `REC >= 1`) | `REC >= 1` | meets floor |
| Reviewer bus factor | same window | 2 (the primary CODEOWNERS account and the designated backup) | `>= 2` | meets floor, no margin |
| Max approver share | same window | 58.3% (the designated backup account, 35/60 approvals) | watch at 80% | below watch threshold |
| CC | issues closed `completed` with a task list, at/after the 2026-07-02 cutoff | 20.0% (8 of 40 reconciled) | 100% | **breach** |

Scope note for the REC row: 13 stacked patch pull requests in the same API page
were excluded as out-of-scope per section 1.

**Open breach.** CC is the only metric below its floor. The weekly
`closeout-hygiene` workflow has failed on every scheduled run since 2026-07-06
(2026-07-06, 07-13, 07-20, 07-27, 08-03 — five consecutive runs). The 2026-08-03
run named five violations within its rolling 14-day window (#1602, #1506, #1503,
#1501, #1500); the 40-issue measurement above is the full post-cutoff population,
which the 14-day window does not show. The monitor was working the whole time —
what was missing was a reader.

Because the reading gap, not the checker, is the defect here, remediation is
tracked separately rather than inside #1507: dispositioning 32 already-closed
issues is issue-closure work under each issue's own owner, and #1507's scope
bullet is the metric definition.

[issue-1507]: https://github.com/jinwon-int/a2a-nexus/issues/1507
[pr-1720]: https://github.com/jinwon-int/a2a-nexus/pull/1720
[pr-1693]: https://github.com/jinwon-int/a2a-nexus/pull/1693
