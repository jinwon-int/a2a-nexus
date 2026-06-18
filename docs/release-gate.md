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
| `historical-transition` | No | Canonical/split-repo transition evidence gates retained for audit or targeted review. |
| `approval-gated` | No | Operator-approval handoff/signoff packets; these are explicit approval surfaces, not ordinary PR smoke. |
| `package-publication` | No | Release/package/tag publication policy checks; these do not imply publish approval. |

The default selection currently runs 22 of 41 inventoried steps (`core` + `public-readiness`). Historical transition, approval, and package-publication paths remain available but are no longer hidden inside every ordinary PR gate.

Useful commands:

```sh
# Default ordinary PR gate: core + public-readiness.
npm run check

# Show the default selection without executing commands.
npm run release-gate -- --list

# Run every inventoried step, including historical/approval/publication gates.
npm run release-gate -- --all

# Add a specific opt-in tier to the default selection.
npm run release-gate -- --tier historical-transition
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
