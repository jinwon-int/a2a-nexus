# Release gate diet closeout

Closeout evidence for #1201.

## Default gate

`npm run check` runs `node scripts/release-gate.mjs` with the default tiers:

- `core`
- `public-readiness`

Current default selection: `31/50` inventory steps.

The historical / approval / package-publication tiers are intentionally excluded from ordinary PR checks.

## Explicit historical path

Historical and approval-sensitive checks remain runnable through one aggregate command:

```bash
npm run check:historical
```

That command uses `--only-tier` so it does **not** accidentally re-run default tiers; it selects only:

- `historical-transition` (`14` steps)
- `approval-gated` (`3` steps)
- `package-publication` (`2` steps)

## Script-surface ratchet

The root npm script surface was reduced from `120` to `100` by deleting direct per-round archive wrappers that pointed into `scripts/archive/`. Those files remain in the repository and remain executable through the release-gate inventory / `check:historical` path.

`check:script-budget` now ratchets `rootNpmScripts` to `100`, preventing silent regrowth.

## Non-goals

No archived evidence files were deleted. No public-readiness, secret-scan, approval-record, compatibility, package, or source-layout gate was weakened.
