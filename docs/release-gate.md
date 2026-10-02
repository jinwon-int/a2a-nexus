# Release Gate

The monorepo release gate is intentionally local and fail-closed. It does not deploy, restart broker/worker services, mutate production data, send live provider messages, or ACK terminal outbox records.

## CI install path

CI and local release validation use:

```sh
npm ci --ignore-scripts --include=dev
npm run check
```

`--ignore-scripts` keeps dependency installation side-effect free. Package build/test scripts run only when the explicit release gate invokes package-local checks.

## Root gate tiers

`npm run check` runs `scripts/release-gate.mjs`. The runner reads the source-backed inventory at [`docs/ops/release-gate-step-inventory.json`](ops/release-gate-step-inventory.json) and, by default, executes only the ordinary PR tiers:

| Tier | Default? | Purpose |
|---|---:|---|
| `core` | Yes | Monorepo layout, packages, contract/conformance, runtime safety, compatibility, script-budget, and release-gate self-checks. |
| `public-readiness` | Yes | Public-readiness scanners and current-state docs guards that must stay current even while the repo is private. |

These are the only tiers, and the default selection runs every inventoried step (check the current count with `npm run release-gate -- --list`). The former opt-in tiers — `historical-transition`, `approval-gated`, `package-publication` — were emptied in #1779 (15 of their 20 steps had silently failed on main because nothing ran them) and removed in #2257 B6. `--only-tier`/`--tier` with one of those names now fails closed as an unknown tier. A gate worth keeping belongs on the default path; reintroducing a tier means adding it to `TIER_CONSUMER` in `scripts/lib/release-gate-steps.mjs` together with its first step, and the inventory check rejects a declared tier with no steps.

Useful commands:

```sh
# Default ordinary PR gate: core + public-readiness.
npm run check

# Show the default selection without executing commands.
npm run release-gate -- --list

# Run only one tier (e.g. to iterate on a core failure).
npm run release-gate -- --only-tier core
```

## External secret/history scan

The default root gate keeps the external scan wrapper in the `public-readiness` tier:

```sh
npm run scan:external-secrets
```

The wrapper runs supported redacted scanners when available (`gitleaks` and/or `trufflehog`) and fails closed when neither scanner is installed. See [R4 External Scan and Release Dry-Run Freeze](./security/r4-external-scan-and-freeze.md) for the redacted evidence template and dry-run boundary.

## No-live smoke boundary

Focused smoke tests used by this gate must be mock/offline checks unless an operator explicitly authorizes a live lane. In particular, the release gate must not:

- change repository visibility;
- deploy or restart Gateway, broker, or worker services;
- mutate production databases;
- send live provider or Telegram messages;
- ACK terminal outbox records;
- rotate, disclose, or write secrets;
- rewrite Git history or force push.

A public release candidate must link the CI run for the candidate commit and keep `contracts/compatibility/matrix.md` at exact source commits/tags for imported packages and exact fixture/release baselines for external compatibility claims.
