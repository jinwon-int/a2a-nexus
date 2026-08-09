# Governance

A2A Nexus is maintained by the repository owner and repository administrators. CODEOWNERS provides review routing for files and packages; it is not a stable public maintainer roster and does not move finalizer or operator authority.

## Decision making

Maintainers review issues and pull requests through the normal GitHub review process. Documentation, tests, examples, and code changes must include appropriate validation evidence.

## Review policy

Review protects the author's approved intent and the repository's evidence trail, not reviewer preference.

- **Author-independent review.** Every pull request must be approved by a reviewer who is not its author; the author cannot be the sole approver. `main` branch protection enforces at least one approving review, and the approving review must come from a role distinct from the PR author. This holds regardless of merge automation or high throughput.
- **Backup reviewer path.** To avoid a single-reviewer bottleneck and bus-factor risk, review routing names a designated backup reviewer in addition to the primary CODEOWNERS reviewer. When the primary reviewer is unavailable, the backup reviewer provides the author-independent approval so review does not silently degrade into self-approval or an unbounded wait.
- **Review evidence over velocity.** Repository health is measured by review-evidence cardinality and closeout completeness — linked issue, CI status, no-live boundaries, and any required approval records — not by pull-request velocity alone. A high merge rate does not substitute for author-independent review evidence, and closeout must name approval-sensitive actions that were not performed. The measurable definition of these metrics — what each one counts, the API or checker that produces it, and its floor — is [`docs/ops/repository-health-metrics.md`](docs/ops/repository-health-metrics.md); pull-request velocity is a denominator there, never a target.


## Roles and authority

A2A Nexus uses role-based authority in public records. Public documentation should refer to roles, not personal messaging channels or individual operator names.

| Role | Authority | Current holder reference | Delegation rule |
| --- | --- | --- | --- |
| `operator` | May approve approval-sensitive actions listed below when the approval names the exact action, target, and rollback/no-op boundary. | Repository owner/admin handle in GitHub review context. | Changes only by repository administrator commit or settings change with public-safe evidence. |
| `finalizer` | Verifies closeout evidence, no-live boundaries, linked issues, CI, and whether operator approval evidence exists before merge/closeout. | Assigned in the PR or issue closeout packet. | May not approve operator-gated actions unless also acting with explicit `operator` approval evidence. |

Approval-sensitive actions must have a structured record when they move beyond planning. See [`docs/specs/approval-record.md`](docs/specs/approval-record.md) and `fixtures/approvals/`.

## Approval-sensitive actions

Issues, pull requests, and local verification do not authorize:

- production deploys or service restarts
- production DB or terminal-outbox mutation
- live provider, Telegram, or notification sends
- releases, tags, package publication, or image publication
- secret movement, disclosure, or rotation
- repository visibility changes or transfers
- history rewrites or force pushes

These require separate explicit operator approval naming the exact action, target, and rollback/no-op boundary.

## Branch protection and auto-merge

The [`auto-merge`](.github/workflows/auto-merge.yml) workflow relies on `main`
branch protection to keep merges gated on review and required checks. The
steady-state requirement is documented in
[`docs/branch-protection.md`](docs/branch-protection.md); applying or changing
the GitHub ruleset itself is an approval-sensitive action.

## Maintainer changes

CODEOWNERS is the current review-routing source. Maintainer or team changes should be made by repository administrators and should not be inferred from ordinary issue or PR participation.
