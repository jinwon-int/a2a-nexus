# Archived script surface

Round-specific and one-off validation scripts move here in dedicated move-only
PRs. Use `scripts/release-gate-manifest.json` and
`docs/ops/release-gate-step-inventory.json` as the source of truth before moving
any script, and do not mix `git mv` archive sweeps with semantic script edits.

## This directory is not an execution boundary

`docs/scripts-lifecycle.md` describes `scripts/archive/` as "not run by the
gate". That is a statement about intent, not about behaviour, and the two have
disagreed in practice.

`scripts/run-release-gate.mjs` decides what to skip from the **`archived` flag on
the manifest entry**, never from the path. A file can sit in this directory and
still run on every release gate — 18 of them do today. Verify with:

```bash
node scripts/run-release-gate.mjs --list | grep scripts/archive/
```

So moving a file here is step 2 of the retirement flow, not the whole of it. A
round script is genuinely retired only when its manifest entry is gone; until
then the move is cosmetic and the check still blocks releases.
