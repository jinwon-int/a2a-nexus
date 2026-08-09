# Validation evidence index

This directory holds team- and round-specific **validation evidence**: closeout
gates, go/no-go matrices, readiness "libero" reviews, and acceptance checklists
produced while coordinating the broker/worker plane across teams.

Most of these are point-in-time coordination artifacts for a specific team
(`team1-*`, `team2-*`) and review round, not external-reader documentation.

## Relocation recommendation (partly executed)

These per-team, per-round evidence files are **internal-runbook candidates**:
they are operationally useful to the maintaining teams but add noise to the
public repository surface. The intended end state is to leave only durable,
externally-relevant validation specs here.

The 38 files whose only remaining pin was a retired round validator have been
removed; git history keeps them. What is left is either pinned by a validator
that still runs or named below as durable.

The remaining files are still **coupled to repository tooling** and cannot be
moved as a simple `git mv`:

- The surviving `team1-*` / `team2-*` files are pinned by dedicated validators
  under `scripts/check-<name>.test.mjs` (and a few shared validators such as
  `scripts/round-merge-preflight.test.mjs`). These read the doc by its exact
  path, so moving a doc requires updating its validator in the same change.
- Several files cross-link each other with relative `./<sibling>.md` links and
  reference fixtures under `../../fixtures/`, so a move must fix those relative
  paths too.

### Safe relocation procedure (per file)

When relocating any file from this directory:

1. Find every reference: `grep -rIl '<filename>' docs scripts fixtures`.
2. Move the file (`git mv`).
3. Update the validator path in its `scripts/check-*.test.mjs`.
4. Fix relative links in the moved file (fixtures/sibling docs) and in any doc
   that links to it.
5. Run `npm run check:markdown-links` and the affected `scripts/check-*.test.mjs`
   to confirm nothing broke.

Do this in small batches; do not bulk-move, because a too-narrow reference grep
(e.g. matching only `validation/<name>` and missing bare-filename or relative
`./` references) silently breaks links and validator tests.

## Durable, externally-relevant validation specs

These are not team/round artifacts and should stay in the public surface:

- [`standalone-worker-terminal-evidence.md`](standalone-worker-terminal-evidence.md)
- [`parent-terminal-brief-aggregation-checklist.md`](parent-terminal-brief-aggregation-checklist.md)
- [`cursor-outbox-health-acceptance-criteria.md`](cursor-outbox-health-acceptance-criteria.md)
- [`a2a-allhands-stability-closeout-gates.md`](a2a-allhands-stability-closeout-gates.md)

## Team coordination evidence (internal-runbook candidates)

The remaining `team1-*` and `team2-*` files in this directory are team
coordination evidence for specific review rounds. Treat them as internal-runbook
candidates pending the relocation procedure above. List them with:

```bash
ls docs/validation/team1-* docs/validation/team2-*
```
