# Governance

A2A Nexus is maintained by the repository owner and repository administrators. CODEOWNERS provides review routing for files and packages; it is not a stable public maintainer roster and does not move finalizer or operator authority.

## Decision making

Maintainers review issues and pull requests through the normal GitHub review process. Documentation, tests, examples, and code changes must include appropriate validation evidence.


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
the GitHub ruleset itself is an approval-sensitive action (see the
[branch protection approval packet](docs/history/monorepo-branch-protection-approval-packet.md)).

## Maintainer changes

CODEOWNERS is the current review-routing source. Maintainer or team changes should be made by repository administrators and should not be inferred from ordinary issue or PR participation.
