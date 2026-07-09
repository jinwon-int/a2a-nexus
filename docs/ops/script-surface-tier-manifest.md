# Script surface tier manifest

`docs/ops/script-surface-tier-manifest.json` is the canonical additive
classification for the root and broker npm/script validation surface introduced
for #1150.

The goal is operating-cost reduction without feature or gate deletion:

- keep required release/safety gates explicit;
- classify manual, diagnostic, approval-gated, and test-helper scripts;
- fail closed when required scripts disappear or become unclassified;
- give future cleanup PRs a stable baseline before retiring wrappers.

## Operator entrypoint layer

Use [script-surface-entrypoints.md](script-surface-entrypoints.md) when choosing which command to run for a local edit, an ordinary PR, or a public/release candidate. That guide is an operator-facing overlay on this manifest; it does not replace the manifest as the classification baseline.

The three operator entrypoints are:

| Situation | Command path | Boundary |
|---|---|---|
| Local quick check | focused package/doc command for touched files | Fast feedback only; not release or live-operation approval. |
| PR check | `npm run check` | Default ordinary PR gate; required gates stay explicit. |
| Public candidate check | `npm run scan:public-readiness` + `npm run scan:external-secrets` + relevant package/readiness audit | Evidence for public/release/package decisions only; not publication approval. |

## Commands

```bash
node scripts/lib/script-surface-manifest.mjs
node scripts/lib/script-surface-manifest.mjs --json
```

## Current baseline

The guard validates:

- root `package.json`: at least `100` scripts;
- broker `packages/broker/package.json`: at least `150` scripts;
- required root gates such as `release-gate`, `check:release-gate-inventory`,
  `scan:public-readiness`, `check:layout`, `check:packages`, and
  `test:release-gate`;
- required broker gates such as `build`, `check`, `test`, `release_gate`,
  `scripts_inventory`, `rollout_guard`, and
  `worker_signature_rollout_preflight`.

## Cleanup rule

Do not bulk-delete scripts. A later PR may retire or rename a script only after
it proves:

1. the manifest classification was updated deliberately;
2. required-gate coverage did not shrink;
3. caller/runbook/CI references were updated;
4. rollback or compatibility wrapper behavior is documented.
