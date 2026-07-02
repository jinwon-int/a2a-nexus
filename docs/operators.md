# A2A Operator Guide

> **Status:** current public-alpha operator guide. It is source-only and no-live; it does not authorize deployment, restart, release, publication, promotion, visibility, secret, DB/outbox/ACK/replay, provider-send, or history-rewrite actions.

## Roles

| Role | Responsibility | Boundary |
| --- | --- | --- |
| `operator` | Grants explicit approval for approval-sensitive actions when the action, target, and rollback/no-op boundary are named. | Ordinary issue/PR discussion, A2A worker output, and local tests are not approval. |
| `finalizer` | Closes PR/issue evidence loops, verifies CI/local gates, checks no-live boundaries, and confirms whether operator approval records exist. | The finalizer does not inherit operator authority from CODEOWNERS, package ownership, or worker assignment. |

Role changes must be made by repository administrators through an explicit commit or settings change. Public records should use role names and GitHub review context rather than personal messaging channels.

## Operator Decision Points

The operator must explicitly approve any action that changes runtime, release, visibility, promotion, external publication, or canonical source authority. Planning alone is not that approval.

Separate approval is required for:

- canonical source flip;
- branch protection or required-check mutation;
- repository archive, transfer, or visibility change;
- release tag, GitHub Release, npm publish, Docker publish, or GHCR publish;
- production deploy, Gateway restart, broker restart, or worker restart;
- database, queue, terminal-outbox, or Terminal ACK/replay mutation;
- provider, Telegram, notification, homepage, or external-promotion sends/metadata changes;
- credential movement, rotation, or disclosure;
- history rewrite, force push, or destructive cleanup.

## Current Operator Reading Order

1. [`README.md`](../README.md) for the public-alpha summary and safe local evaluation path.
2. [`quickstart.md`](quickstart.md) for a disposable loopback broker/worker path.
3. [`architecture.md`](architecture.md) and [`positioning.md`](positioning.md) for public-safe project framing.
4. [`release-readiness.md`](release-readiness.md) and [`release-checklist.md`](release-checklist.md) for release/package readiness criteria.
5. [`external-listings.md`](external-listings.md) for the gated external directory workflow.
6. [`history/README.md`](history/README.md) for completed migration and rehearsal records.
7. [`pr-review-guardrails.md`](pr-review-guardrails.md) before assisted PR review or merge batches.

## Finalizer Boundary

CODEOWNERS routes review attention. It does not move finalizer authority to A2A workers or package owners. A finalizer remains responsible for closeout judgment, no-live boundary checks, and operator sign-off evidence.

Before closing an issue or merging a closeout PR, the finalizer must compare every issue checklist item and acceptance criterion against concrete artifacts. Bulk closeout is a NO-GO unless the finalizer writes an issue-by-issue disposition that names completed items, deferred follow-ups, and skipped approval-sensitive actions. For A2A rounds, the default mapping is one implementation lane to one PR; consolidating lanes into one PR requires an explicit finalizer note explaining why review coverage is preserved.

This rule is machine-monitored (#1210): the scheduled [`closeout-hygiene`](../.github/workflows/closeout-hygiene.yml) workflow runs `scripts/check-issue-closeout-hygiene.mjs` and fails on issues closed as completed with unchecked task-list items. Deviations require the `closeout-exception` label plus an item-by-item disposition comment before close. Disposition comments are themselves checked: `scripts/check-disposition-references.mjs` (same workflow) fails when a disposition cites a PR, workflow run, or repo path that does not exist — a reconciliation that points at nothing is not a reconciliation (#1220).

### Finalizer judgment rules (#1220)

- **Oracle independence.** Never judge a round with a detector or gate that the same round built — the detector's blind spots are the implementation's blind spots (#1194 RC-A; observed in #1204). The reference for completion is always the issue's own acceptance criteria, read from the issue text.
- **Standard rejection reasons.** A PR that adds a new gate, scanner rule, or test without a red→green log (the check failing on the pre-change tree) is returned, not merged. A task whose spec demands mutation evidence is returned without the mutation log. These are standard dispositions, not discretionary calls.
- **Verification methodology.** When judging that an artifact is absent, sweep synonyms before concluding (a doc named `process-local-*` satisfies a "per-process" requirement), and trace config-layer defaults before reading runtime conditionals as opt-in (`config.ts` defaults flow into `runner.ts` guards). Both failure modes produced false findings in #1209.

## Approval records

Approval-sensitive execution records live under `fixtures/approvals/` and are validated by `npm run check:approval-records`. New approval records must use `approverRole: "operator"` and must not include personal-channel or raw-secret fields.

## Agent Olympics Boundary

`agent-olympics` is independent. It must not be treated as an A2A package, source label, issue-routing lane, or blocker for A2A Nexus public-alpha work.
