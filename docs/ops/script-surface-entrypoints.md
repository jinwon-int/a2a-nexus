# Script surface operator entrypoints

This guide is the operator-facing entrypoint layer for the large npm/script surface. The script classification baseline remains [`script-surface-tier-manifest.json`](script-surface-tier-manifest.json), validated by `node scripts/lib/script-surface-manifest.mjs`.

The goal is not to delete scripts. The goal is to make the first command obvious for the common operating situation while keeping required gates, manual wrappers, historical checks, approval packets, and package-publication checks visible.

## Current script baseline

| Package surface | Package file | Current minimum | Source of truth |
|---|---|---:|---|
| Root workspace | `package.json` | `100` scripts | `docs/ops/script-surface-tier-manifest.json` |
| Broker package | `packages/broker/package.json` | `150` scripts | `docs/ops/script-surface-tier-manifest.json` |

Verify the current count and tier classification with:

```bash
node scripts/lib/script-surface-manifest.mjs
node scripts/lib/script-surface-manifest.mjs --json
```

A cleanup PR must not reduce required-gate coverage or remove manual/legacy wrappers unless it also proves the callers, runbooks, CI references, and compatibility/rollback behavior were updated.

## Three operator entrypoints

| Situation | Primary command path | Use when | Must not imply |
|---|---|---|---|
| Local quick check | Focused package or doc command for touched files | You are editing one package, fixture, or document and need fast feedback. | Passing a focused check is not release, publication, deploy, or live-operation approval. |
| PR check | `npm run check` | You are preparing a normal pull request. This runs the ordinary release gate tiers. | Do not skip public-readiness or secret/history checks because path-filtered CI skipped package jobs. |
| Public candidate check | `npm run scan:public-readiness` + `npm run scan:external-secrets` + relevant package/readiness audit such as `node scripts/build-release-candidate-evidence.mjs --out-dir artifacts/release-candidate` | You are preparing external/public-alpha, release/package, or repo-split candidate evidence. | This still does not authorize tags, releases, npm/Docker/GHCR publication, homepage metadata, visibility changes, or live operations. |

## Local quick check menu

Pick the smallest command that covers the touched surface, then run the PR check before opening or merging a broad PR.

| Touched surface | Focused command examples |
|---|---|
| Markdown docs only | `npm run check:markdown-links` |
| Public docs, examples, issue templates, metadata | `npm run scan:public-readiness` |
| Compatibility matrix/contracts | `npm run check:compatibility-baselines`; `npm run test:conformance` |
| Root release-gate inventory or script tiers | `npm run check:release-gate-inventory`; `node scripts/lib/script-surface-manifest.mjs` |
| Broker source | `npm --workspace packages/broker run check`; focused broker `node --test ...` when a specific test is touched |
| Docker runner source | `npm --workspace packages/docker-runner run check`; `npm --workspace packages/docker-runner test` |
| Harness bridge scripts (`packages/broker/scripts/*-a2a-*-bridge.mjs`) | focused `node --test packages/broker/scripts/<bridge>.test.mjs`; `npm --workspace packages/broker test` for the full manifest |

If the touched files span more than one row, run each focused command or skip directly to `npm run check`.

## PR check

Use the root gate for ordinary pull requests:

```bash
npm run check
```

This is the default fail-closed PR gate. It executes the `core` and `public-readiness` release-gate tiers, which are the only tiers — every inventoried step runs on this path. The former opt-in historical-transition, approval-gated and package-publication tiers were emptied in #1779 and removed in #2257 B6.

Useful inspection commands:

```bash
npm run release-gate -- --list
npm run release-gate -- --only-tier core
```

Inspection and tier-narrowing modes are evidence-gathering only. They do not authorize an approval-sensitive action by themselves.

## Public candidate check

Before treating a change as a public/release/package candidate, run the public-facing checks explicitly and record the output in the PR or issue closeout:

```bash
npm run scan:public-readiness
npm run scan:external-secrets
npm run check:markdown-links
node scripts/lib/script-surface-manifest.mjs
```

Add package-specific or release-specific checks when the candidate claims package or compatibility readiness:

```bash
npm run check:packages
npm run test:conformance
npm run check:compatibility-baselines
```

None of these checks — nor the default release gate — creates tags, GitHub Releases, npm publishes, Docker/GHCR images, homepage metadata, production deployments, broker/Gateway/worker restarts, provider sends, DB/outbox/ACK/replay mutations, or secret movement. Package publication stays a separate, explicitly approved action (the former `package-publication` release-gate tier was emptied in #1779 and removed in #2257 B6).

## Script cleanup rule

Script cleanup is a separate operation from entrypoint documentation.

A PR may rename, retire, or consolidate a script only when it documents all of the following:

1. which manifest rule changed;
2. why required-gate coverage did not shrink;
3. which callers, runbooks, CI jobs, and docs were updated;
4. whether a compatibility wrapper or rollback path is kept;
5. which validation commands proved the new surface.

Until that evidence exists, keep manual and legacy scripts classified rather than deleted.
