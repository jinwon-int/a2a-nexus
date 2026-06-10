# npm scripts inventory and consolidation guide

`package.json` contains many operator-facing script entrypoints. Some of them are
intentionally separate approval/evidence gates, so script cleanup must start with
an inventory and caller audit rather than a bulk delete.

## Inventory commands

```bash
npm run scripts_inventory
npm run scripts_inventory -- --json
npm run scripts_inventory -- --caller-audit
npm run scripts_inventory -- --caller-audit --json
```

The inventory groups scripts by family, counts repeated `npm run build && node
scripts/...` wrappers, labels common workflow stages such as approval, evidence,
gate, execution, and review-closeout, and can scan repository files for direct
`npm run <script>` caller references.

## Current baseline

Current baseline from `npm run scripts_inventory -- --caller-audit --json`:

- Total scripts: `138`
- Searched caller files: `845`
- Scripts with caller references: `109`
- Total caller references: `359`

High-churn families:

- `terminal_brief_sidecar`: `38` scripts, all `38` are build+node wrappers; `74` caller refs across `38` scripts.
- `orchestration_intelligence`: `15` scripts, all `15` are build+node wrappers; `15` caller refs across `14` scripts.
- `terminal_brief`: `13` scripts, `12` build+node wrappers; `29` caller refs across `13` scripts.
- `worker_orchestration`: `10` scripts, all `10` are build+node wrappers; `18` caller refs across `6` scripts.
- `core`: `10` scripts; `65` caller refs across `7` scripts.
- `tests`: `15` scripts; `63` caller refs across `7` scripts.
- `other`: `25` scripts; `67` caller refs across `16` scripts.

Treat those counts as an audit target, not a deletion list.

## Caller audit scope

The caller audit scans text files likely to contain operator references, including
Markdown docs, workflow YAML, JSON fixtures, shell scripts, and JS/TS helper
files. It intentionally skips generated or dependency-heavy paths such as:

- `.git/`
- `node_modules/`
- `dist/`
- `build/`
- `coverage/`
- `package.json` and `package-lock.json`

The audit is conservative. Manual operators may still run scripts that are not
visible in repository text, so absence of a caller reference is not sufficient
for deletion.

## Safe consolidation sequence

1. Run `npm run scripts_inventory -- --caller-audit --json` and save the output
   as PR evidence.
2. Search docs, cron, CI, and runbooks for each candidate script before removal.
3. Move repeated stage runners behind one canonical CLI only when the behavior is
   truly shared, for example `scripts/terminal-brief-sidecar.mjs --stage <name>`.
4. Keep compatibility wrapper scripts for at least one deprecation window.
5. Replace old commands with warning wrappers before removal.
6. Remove wrappers only after operator runbooks, CI, and cron no longer reference
   them and rollback is documented.

## First safe PR candidates

Prefer additive changes first:

- Add or update the caller audit baseline.
- Add a canonical runner that delegates to existing scripts without changing
  behavior.
- Add tests proving representative standalone commands and runner subcommands
  return the same exit code and output shape.

Avoid first-step bulk deletion.

## Do not bulk-delete

Terminal Brief and sidecar scripts often encode approval boundaries. Removing a
script can silently bypass or break an operator gate, so every removal must name
its replacement command, caller-audit evidence, validation evidence, and rollback
path.
