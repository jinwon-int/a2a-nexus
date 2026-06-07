# A2A Monorepo CI Parity Matrix

> **Snapshot date:** 2026-06-07
> **Parent:** [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511)
> **Child:** [a2a-plane#514](https://github.com/jinwon-int/a2a-plane/issues/514)
> **Phase-1 refresh:** [a2a-plane#528](https://github.com/jinwon-int/a2a-plane/issues/528)
> **Phase-2 rehearsal:** [a2a-plane#530](https://github.com/jinwon-int/a2a-plane/issues/530)
> **Phase-3 gate:** [a2a-plane#534](https://github.com/jinwon-int/a2a-plane/issues/534)
> **Phase-3 CI jobs:** [a2a-plane#536](https://github.com/jinwon-int/a2a-plane/issues/536)
> **Phase-4 import candidate:** [a2a-plane#538](https://github.com/jinwon-int/a2a-plane/issues/538)
> **Status:** phase-4 fresh prefix import candidate is under package CI parity validation; split repo CI remains canonical until the candidate is merged and a separate canonical-flip approval exists.

## Summary

This matrix records the current CI and package-boundary gap between the split
implementation repos and the `a2a-plane` staged workspace. It does not declare
monorepo package parity green, and it does not approve a canonical flip.

The result is intentionally conservative:

- Split repo CI remains canonical for broker, Docker runner, and OpenClaw
  plugin implementation truth.
- `a2a-plane` keeps first-class contract, conformance, scanner, and release
  gate checks for the umbrella workspace.
- The `#538` candidate replaces `packages/*` with fresh tracked split-repo
  trees and then proves them under package-local parity jobs.
- Even when package parity is green, canonical flip remains blocked until a
  separate operator decision records that split-repo implementation truth can
  move.
- Agent Olympics is out of scope for A2A monorepo CI parity, package boundary,
  import rehearsal, and issue routing.

## Package Boundary Matrix

| Surface | Split repo canonical CI | Plane workspace job today | Parity status | Required before authoritative |
| --- | --- | --- | --- | --- |
| Broker | `jinwon-int/a2a-broker` `ci`: `npm ci`, `npm test`; source `test` runs `build`, script syntax checks, and built JS tests. | `broker` job: `npm ci --include=dev`, `node scripts/run-monorepo-package-ci-parity.mjs broker`; runner executes source-equivalent `npm test`, package `check` alias, build-info generation, syntax checks, built JS tests, and `npm pack --dry-run`. | Fresh import candidate is package-CI green locally; canonical flip remains blocked. | Candidate imports `f9f4af5a76649a37b8a3d492805b6e5f410683a6`; keep split repo canonical until PR/CI and separate flip approval complete. |
| Docker runner | `jinwon-int/a2a-docker-runner` `ci`: `npm ci`, `check`, `build`, `lint`, `test`, fail-closed `pre-pr-bootstrap-guard`; release-gate adds chaos E2E and release candidate dry-run evidence. | `docker-runner` job: `npm ci --include=dev`, `node scripts/run-monorepo-package-ci-parity.mjs docker-runner`; runner executes `check`, `build`, `lint`, `test`, pre-PR bootstrap guard, chaos E2E, no-publish release-candidate parity audit, package metadata checks, and `npm pack --dry-run`. | Fresh import candidate is package-CI green locally; canonical flip remains blocked. | Candidate imports `269a0ef90737158b41f8da26241b9f7f4b14af5e`; no tag/release/publish path is authorized. |
| OpenClaw plugin | `jinwon-int/openclaw-plugin-a2a` `ci`: `npm ci`, `scan:public-readiness`, `smoke:a2a-conformance`, `npm test`; package build copies `openclaw.plugin.json`; `prepack` scans then builds. | `plugin` job: `npm ci --include=dev`, `node scripts/run-monorepo-package-ci-parity.mjs openclaw-plugin-a2a`; runner executes plugin-local public-readiness scan, A2A conformance smoke, tests, `prepack`, manifest copy check, OpenClaw peer-boundary check, and `npm pack --dry-run`. | Fresh import candidate is package-CI green locally; canonical flip remains blocked. | Candidate imports `a2e521271483ef0b6a29907c8228f0a442dd2db9` with monorepo-compatible `tsc` and `check` aliases only. |

## Shared Umbrella Gates

The plane workspace still owns cross-repo evidence that split repos do not each
duplicate:

- path-filtered package jobs for broker, runner, plugin, contracts, docs,
  scripts, and root changes;
- `test:conformance` for contract fixtures and adapter interface checks;
- `scan:external-secrets` and `scan:readiness-gates`;
- compatibility baseline and repo-protection baseline checks;
- monorepo decision validators:
  - `check:monorepo-reentry`;
  - `check:monorepo-import-rehearsal`;
  - `check:monorepo-ci-parity`.

These are umbrella gates. In `#538` they are used to test the fresh import
candidate; they still are not a canonical flip approval by themselves.

## Known CI Differences

| Difference | Current finding | Required decision |
| --- | --- | --- |
| GitHub Actions versions | Split repos use `actions/checkout@v5` and `actions/setup-node@v5`; `a2a-plane` package jobs now use v5 for both. | Keep v5 alignment in future package jobs. |
| Install lifecycle | Split repo CI uses `npm ci`; plane package jobs now use `npm ci --include=dev` without `--ignore-scripts`. | Re-check lifecycle behavior after the next fresh prefix import. |
| Broker build side effects | Split broker build generates build-info; plane broker package CI now validates build-info generation and syntax-check targets. | Compare generated content after import before treating the mirror as authoritative. |
| Runner release policy | Split runner has an approval-gated release workflow with dry-run evidence and isolated tag path. | Plane package CI models release-candidate evidence only as no-publish dry-run; non-dry-run tag/release/publish remains blocked. |
| Plugin packaging | Split plugin build copies `openclaw.plugin.json`, exposes CLI bins, and `prepack` scans then builds. | Plane package CI validates manifest copy, prepack, scanner, smoke, and peer boundary; split bin/files drift remains a fresh-import comparison item. |
| Scanner coverage | Split plugin runs plugin-local `scan:public-readiness`; plane now runs the plugin-local scanner plus the root scanner. | Keep root and package-local scanners green. |

## Phase-1 Refresh (#528)

The 2026-06-07 KST phase-1 refresh updated the current split-repo source refs
used by the matrix:

| Surface | Current split ref | Current conclusion |
| --- | --- | --- |
| Broker | `fae438a4fba301c2a9a02ca7cb11282867327920` | Still not green for canonical flip; build-info generation and script syntax checks remain missing from plane parity. |
| Docker runner | `269a0ef90737158b41f8da26241b9f7f4b14af5e` | Drift increased again after phase 1; plane still lacks build/lint/test/pre-pr guard and release-gate dry-run parity. |
| OpenClaw plugin | `a2e521271483ef0b6a29907c8228f0a442dd2db9` | Still not green for canonical flip; plugin-local public scan and A2A conformance smoke remain split-repo gates. |

The phase-1 result is still **not green for canonical flip**. Package jobs must
be equal-or-stricter than split repo CI before implementation truth can move.

## Phase-2 Parity Gate (#530)

The phase-2 prefix rehearsal makes the parity gate repeatable: every package now
has a fresh source ref, a throwaway prefix-import diff summary, and an explicit
blocker list before any package mirror refresh PR.

| Surface | Fresh rehearsal ref | Rehearsal drift | Equal-or-stricter package CI? | Blocking gate |
| --- | --- | --- | --- | --- |
| Broker | `fae438a4fba301c2a9a02ca7cb11282867327920` | 633 added-or-untracked, 86 changed, 12 removed | No | Plane must preserve source `npm ci` lifecycle behavior, build-info generation, script syntax checks, and the broader split-repo test glob before a mirror refresh. |
| Docker runner | `269a0ef90737158b41f8da26241b9f7f4b14af5e` | 79 added-or-untracked, 31 changed, 0 removed | No | Plane must add or prove `check`, `build`, `lint`, `test`, `pre-pr-bootstrap-guard`, release-candidate dry-run, and package metadata parity. |
| OpenClaw plugin | `a2e521271483ef0b6a29907c8228f0a442dd2db9` | 67 added-or-untracked, 53 changed, 4 removed | No | Plane must preserve plugin-local public scan, A2A conformance smoke, `openclaw.plugin.json` copy/prepack behavior, bin/files metadata, and OpenClaw peer boundary. |

This is a source-only parity gate, not a live operation. It does not run release
flows, create tags, publish packages or images, deploy, restart Gateway/broker
workers, send provider/Telegram messages, replay Terminal Brief ACKs, mutate DB
state, or move credentials.

Phase-3 should remain blocked until the package jobs either match or exceed the
split repo gates above, or the remaining gaps are explicitly approved as
accepted risk in a separate operator decision.

## Phase-3 Package CI Gate (#534)

The phase-3 package CI gate turns the phase-2 blocker into an explicit release
gate before any package mirror refresh. It is still source-only: it records the
minimum equal-or-stricter package jobs required for broker, Docker runner, and
OpenClaw plugin mirrors, then keeps mirror refresh blocked until those jobs are
present or an operator records an accepted-risk exception.

The gate requires every package mirror refresh candidate to prove:

- GitHub Actions checkout/setup-node policy is aligned with split repo CI or
  the version drift is explicitly accepted.
- `npm ci` lifecycle behavior is preserved, or `--ignore-scripts` has a
  package-local lifecycle-equivalent proof.
- Split-repo package scanners and smoke tests remain package-local where the
  source repo owns them.
- Release/tag/package/image evidence is modeled as dry-run or no-publish
  validation only; no tag, release, npm publish, Docker publish, deploy, or
  restart is authorized.
- Package metadata, `bin` exports, `files`, manifests, and build side effects
  are verified before the mirror becomes authoritative.

The validated fixture is
[`fixtures/current-state/monorepo-phase3-package-ci-gate.json`](../fixtures/current-state/monorepo-phase3-package-ci-gate.json)
and the release-gate check is
`check:monorepo-phase3-package-ci-gate`. The package CI runner added for
`a2a-plane#536` is `scripts/run-monorepo-package-ci-parity.mjs`, and the root
release gate also runs `check:monorepo-package-ci-parity-jobs`.

This wired concrete package jobs, but did not itself refresh `packages/*` as
implementation truth.

## Phase-4 Fresh Prefix Import Candidate (#538)

The phase-4 candidate imports tracked files from fresh split-repo refs into the
three package paths, then runs the package parity jobs before any canonical
flip:

| Surface | Candidate source ref | Candidate parity evidence | Remaining decision |
| --- | --- | --- | --- |
| Broker | `f9f4af5a76649a37b8a3d492805b6e5f410683a6` | `node scripts/run-monorepo-package-ci-parity.mjs broker` passed locally. | PR/CI evidence and separate canonical-flip approval. |
| Docker runner | `269a0ef90737158b41f8da26241b9f7f4b14af5e` | `node scripts/run-monorepo-package-ci-parity.mjs docker-runner` passed locally. | PR/CI evidence and separate canonical-flip approval. |
| OpenClaw plugin | `a2e521271483ef0b6a29907c8228f0a442dd2db9` | `node scripts/run-monorepo-package-ci-parity.mjs openclaw-plugin-a2a` passed locally. | PR/CI evidence and separate canonical-flip approval. |

The candidate uses `git archive` tracked-tree imports, not history-preserving
subtree merges. Closed issue/PR history remains in the split repos; future
source provenance must cite the split repo and source ref. This is acceptable
for the candidate PR because it is not a canonical flip and it keeps rollback
as a normal PR revert.

## Canonical Flip Gate

The canonical flip gate remains closed.

The next monorepo action must be a fresh import rehearsal into a disposable or
staged workspace, followed by a CI parity PR that proves every package job is
equal-or-stricter than the split repo gate. Until then, package implementation
changes belong in the split repos.

## No-live Boundary

This matrix does not authorize repository import into `main`, history rewrite,
canonical flip, branch protection changes, release tags, GitHub Releases, npm
or Docker publication, repository visibility changes, production deploys,
Gateway/broker/worker restarts, database mutation, provider or Telegram sends,
Terminal ACK/replay, credential movement, destructive cleanup, or worker-owned
GitHub mutation.
