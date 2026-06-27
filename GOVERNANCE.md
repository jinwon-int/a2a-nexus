# Governance

A2A Nexus is maintained by the repository owner and repository administrators. CODEOWNERS provides review routing for files and packages; it is not a stable public maintainer roster and does not move finalizer or operator authority.

## Decision making

Maintainers review issues and pull requests through the normal GitHub review process. Documentation, tests, examples, and code changes must include appropriate validation evidence.

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
[branch protection approval packet](docs/monorepo-branch-protection-approval-packet.md)).

## Maintainer changes

CODEOWNERS is the current review-routing source. Maintainer or team changes should be made by repository administrators and should not be inferred from ordinary issue or PR participation.
