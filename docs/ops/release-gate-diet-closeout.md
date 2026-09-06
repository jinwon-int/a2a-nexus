# Release gate diet closeout

Closeout evidence for #1201.

> **Superseded in part.** The non-default tiers described below
> (`historical-transition`, `approval-gated`, `package-publication`) were
> emptied when the monorepo migration ceremony was retired in #1779, and the
> `check:historical` aggregate npm script was deleted with them. The tier names
> are still declared in `docs/ops/release-gate-step-inventory.json`, but they
> now hold **zero** steps. This document is kept as the #1201 record; the
> sections below are historical, not runnable instructions.

## Default gate

`npm run check` runs `node scripts/release-gate.mjs` with the default tiers:

- `core`
- `public-readiness`

Default selection at #1201 closeout: `31/50` inventory steps. As of #1779 the
inventory holds `53` steps and the default tiers select **all** of them
(`core` 42, `public-readiness` 11) — verify with
`npm run --silent release-gate -- --list`.

At closeout the historical / approval / package-publication tiers were
intentionally excluded from ordinary PR checks.

## Explicit historical path (retired)

Historical and approval-sensitive checks were runnable through one aggregate
command, `npm run check:historical`, which used `--only-tier` so it did **not**
accidentally re-run the default tiers. It selected only:

- `historical-transition` (`14` steps at closeout, `0` today)
- `approval-gated` (`3` steps at closeout, `0` today)
- `package-publication` (`2` steps at closeout, `0` today)

#1779 deleted every step in those tiers — they had rotted unobserved (15 of 20
failed on main) — and deleted the `check:historical` script with them. **Do not
run `npm run check:historical`; it no longer exists.** A non-default tier, if
one is reintroduced, is selected directly:

```bash
node scripts/release-gate.mjs --only-tier <tier>
```

## Script-surface ratchet

The root npm script surface was reduced from `120` to `100` by deleting direct per-round archive wrappers that pointed into `scripts/archive/`. Those files remain in the repository; the surviving ones are executed by `npm run test:release-gate` through their `scripts/release-gate-manifest.json` entries (see `scripts/archive/README.md` — the directory is not the execution boundary, the manifest entry is). The `check:historical` path they were reachable through no longer exists.

`check:script-budget` now ratchets `rootNpmScripts` to `100`, preventing silent regrowth.

## Non-goals

No archived evidence files were deleted. No public-readiness, secret-scan, approval-record, compatibility, package, or source-layout gate was weakened.
