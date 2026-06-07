# Team1 Comment-Only Closeout Runbook

This is the first guarded external-write shape for Team1 closeout automation.
It is intentionally narrower than full closeout automation.

## Modes

- `dry_run`: render the exact finalizer draft, target issue URL, idempotency
  marker, blockers, and safety gates. It does not post anything.
- `comment_only`: may post one GitHub comment only after operator approval,
  granted GitHub comment permission, an approved closeout plan, and no existing
  comment with the same idempotency marker.

## Idempotency

Each draft begins with:

```text
<!-- a2a:comment-only-closeout v=1 key=<auto-closeout-idempotency-key> -->
```

Before posting, the finalizer must list existing comments on the target issue
and suppress the post if any comment body already contains that marker. A
duplicate is a successful no-op, not a failure.

## Permission Failure Handling

If GitHub App or CLI comment permission is denied, the finalizer reports
`plannedAction=blocked` and keeps the exact draft available for manual review.
It must not partially close an issue, merge a PR, ACK/replay Terminal Brief,
mutate the broker DB, restart/deploy services, send providers, publish a
release, or move secrets.

## Rollback / No-Op

- `dry_run` rollback: discard the rendered packet.
- duplicate marker: no-op; keep the existing comment as the idempotency record.
- permission denied: no-op; fix permissions or use an explicitly approved manual
  comment path.
- mistaken comment: add a human correction comment. Do not edit history or close
  the issue automatically from this workflow.

## Required Operator Gate

`comment_only` posting requires explicit operator approval for that closeout
decision. Approval for a comment does not imply approval for issue close, PR
merge, manual Terminal Brief ACK/replay, DB mutation, restart/deploy, provider
send, release, or secret movement.
