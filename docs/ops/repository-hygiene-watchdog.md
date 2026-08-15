# Repository hygiene watchdog

The `repository-hygiene-watchdog` GitHub Actions workflow checks weekly and on
manual dispatch for two read-only findings. A finding produces a GitHub
Actions warning and fails the job so it cannot disappear into a successful
run.

## Check 1 — merged-branch residue (#1507)

Same-repository pull request head branches that still exist after their pull
request was merged.

This is a read-only recurrence guard for [issue #1507][issue-1507]. It does not
delete branches, change branch protection or rulesets, enable automatic branch
deletion, edit CODEOWNERS, or perform any deploy, restart, live send, database,
ACK, release, or other operational action.

## Classification

The checker reads repository metadata, the complete branch inventory, closed
pull requests, and the default-branch workflow-run inventory through GitHub's
REST API. Results are deterministic: branches are sorted by name and linked
pull requests by number.

A branch is reported only when all of these conditions hold:

- a closed pull request has a non-null `merged_at`;
- the PR head repository is this repository, not a fork;
- the PR head ref matches a branch that still exists; and
- the branch is neither `main`, the repository's current default branch, nor a
  branch GitHub marks as protected.

A deleted PR head, closed-but-unmerged PR, fork-only head, protected branch,
`main`, and a differently named default branch are ignored. The same-repository
check is deliberate: a fork PR can use the same head branch name as an
unrelated base-repository branch.

## Check 2 — default-branch run redness (2026-08-15 review follow-up)

Every workflow whose **latest run on the default branch** concluded `failure`
or `startup_failure` is reported. Motivation: on 2026-08-14 the main push CI
run failed on a transient `dorny/paths-filter` archive download error and
stayed red because no recurring lane watched main; a weekly watchdog failure
bounds that kind of silent redness to at most one week.

Classification rules:

- only runs whose `head_branch` is the default branch are considered, so
  pull-request lanes never raise a finding;
- per workflow, only the newest run (highest run id) counts — an older failed
  run is cleared by any newer completed run of the same workflow;
- `cancelled`, `timed_out`, `skipped`, in-progress, and neutral conclusions are
  not redness: a superseded or deliberately cancelled run is not a failed lane.

## Permissions and failure behavior

The workflow grants only:

```yaml
permissions:
  contents: read
  pull-requests: read
  actions: read
```

Checkout credentials are not persisted. Every API request made by the checker
uses `GET`; it has no mutation path. Missing credentials, malformed API
responses, API errors, and pagination beyond the safety limit fail closed.

When residue is found, the failure lists the branch, its current head SHA, and
the merged PR number or numbers. Operators should review the finding and use a
separately approved cleanup manifest/process if deletion is appropriate. A
watchdog failure is evidence only and is not deletion approval.

When redness is found, the failure lists the workflow, run id, conclusion,
event, creation time, and run URL. Transient runner/infrastructure failures
(for example a pinned-action archive download error) are resolved by re-running
the failed jobs; a real regression needs a reviewed fix PR. The watchdog never
re-runs anything.

## Local verification

The evaluator and API behavior use dependency-free Node tests with injected
fixtures; they make no live requests:

```bash
node --test scripts/lib/check-repository-hygiene-watchdog.test.mjs
node --test scripts/check-workflow-permissions.test.mjs
node --test scripts/check-workflow-action-pinning.test.mjs
```

Do not run the checker CLI merely as a local test: with `GITHUB_TOKEN` and
`GITHUB_REPOSITORY` it reads current GitHub state. Use the fixture suite above.

[issue-1507]: https://github.com/jinwon-int/a2a-nexus/issues/1507
