# Monorepo migration document index

The `a2a-nexus` monorepo migration (split repos → canonical `packages/*` source)
was executed in stages, each with its own decision record, rehearsal, gate, or
execution-result doc. There are 15 such documents; this index is the single
entry point so readers do not have to open all of them. **Start at the top
("current end state") — the lower sections are historical provenance.**

> These documents are retained (not consolidated into one) because several are
> pinned by data-driven validators in `docs/ops/data-driven-validation-registry.json`
> and `scripts/check-monorepo-*.mjs`. Removing or merging them would break those
> release-gate checks. This index provides the consolidation *navigationally*
> without disturbing that tooling.

## Current end state

- [`monorepo-actual-canonical-flip-execution-result.md`](monorepo-actual-canonical-flip-execution-result.md)
  — the executed canonical flip making `packages/*` the source of truth. This is
  the authoritative current-state record.

## Decision and re-entry

- [`monorepo-reentry-decision.md`](monorepo-reentry-decision.md) — the decision
  to re-enter a monorepo layout after the split-repo phase.
- [`monorepo-canonical-flip-readiness.md`](monorepo-canonical-flip-readiness.md)
  — readiness assessment before the flip.

## Rehearsal and CI parity

- [`monorepo-import-rehearsal.md`](monorepo-import-rehearsal.md) — import
  rehearsal and mirror freshness checks.
- [`monorepo-ci-parity-matrix.md`](monorepo-ci-parity-matrix.md) — per-package CI
  parity matrix vs. the split repos.
- [`monorepo-migration-checklist.md`](monorepo-migration-checklist.md) — staged
  migration checklist.

## Approval and handoff packets (operator-gated)

- [`monorepo-operator-approval-handoff.md`](monorepo-operator-approval-handoff.md)
- [`monorepo-canonical-source-flip-execution-handoff.md`](monorepo-canonical-source-flip-execution-handoff.md)
- [`monorepo-final-operator-signoff-matrix.md`](monorepo-final-operator-signoff-matrix.md)
- [`monorepo-branch-protection-approval-packet.md`](monorepo-branch-protection-approval-packet.md)
  (see also [`branch-protection.md`](branch-protection.md) for the steady-state invariant)
- [`monorepo-release-package-tag-approval-packet.md`](monorepo-release-package-tag-approval-packet.md)

## Execution results and split-repo disposition

- [`monorepo-actual-canonical-flip-execution-preflight.md`](monorepo-actual-canonical-flip-execution-preflight.md)
- [`monorepo-active-provenance-mirror-execution-result.md`](monorepo-active-provenance-mirror-execution-result.md)
- [`monorepo-split-repo-disposition-preflight.md`](monorepo-split-repo-disposition-preflight.md)
- [`monorepo-split-repo-disposition-rollback.md`](monorepo-split-repo-disposition-rollback.md)
