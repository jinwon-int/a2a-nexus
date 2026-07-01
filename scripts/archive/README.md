# Archived script surface

Round-specific and one-off validation scripts should move here only in dedicated move-only PRs. This closeout adds the archive target and keeps existing executable paths stable so release-gate inventory and historical tests remain reproducible.

Use `scripts/release-gate-manifest.json` and `docs/ops/release-gate-step-inventory.json` as the source of truth before moving any script. Do not mix `git mv` archive sweeps with semantic script edits.
