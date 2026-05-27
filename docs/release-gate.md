# Release Gate

The monorepo release gate is intentionally local and fail-closed. It does not deploy, restart broker/worker services, mutate production data, send live provider messages, or ACK terminal outbox records.

## CI install path

CI and local release validation use:

```sh
npm ci --ignore-scripts --include=dev
npm run check
```

`--ignore-scripts` keeps dependency installation side-effect free. Package build/test scripts run only when the explicit release gate invokes package-local `check` scripts.

## Root gate

`npm run check` runs `scripts/release-gate.mjs`, which executes these steps in order:

1. `npm run check:layout` — required monorepo paths exist.
2. `npm run test:conformance` — contract fixtures and terminal-evidence ACK-boundary fixtures remain valid.
3. `npm run check:packages` — every `packages/*/package.json` must define `scripts.check`, and each check must pass.
4. `npm run check:runner-import-smoke` — the Docker runner package import surface remains usable from the monorepo.
5. `npm run check:terminal-brief-routing` — production routing code must not bypass broker-owned delivery or treat provider acceptance as terminal ACK.
6. `npm run check:message-id-ack-boundary` — documentation and fixtures must not describe provider message IDs or send success as ACK evidence.
7. `npm run scan:public-readiness` — runtime/bootstrap files, token-shaped literals, and unsafe secret assignments must be absent from tracked or unignored candidate files.
8. `npm run scan:readiness-gates` — the fail-closed readiness spec must keep the aggregate decision at `NO-GO` unless every required gate is satisfied.
9. `npm run scan:external-secrets` — supported external secret/history scanners (`gitleaks` and/or `trufflehog`) must produce redacted clean evidence; the gate fails closed when neither scanner is installed.
10. `node scripts/check-compatibility-baselines.mjs` — compatibility matrix rows must carry exact current baselines and must not retain unsupported baseline placeholders.

## External secret/history scan

The integrated root gate includes the external scan wrapper:

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
