# A2A Monorepo CI Parity Matrix

> **Snapshot date:** 2026-06-07
> **Parent:** [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511)
> **Child:** [a2a-plane#514](https://github.com/jinwon-int/a2a-plane/issues/514)
> **Status:** phase 0 matrix recorded. Split repo CI remains canonical.

## Summary

This matrix records the current CI and package-boundary gap between the split
implementation repos and the `a2a-plane` staged workspace. It does not declare
monorepo package parity green, and it does not approve a canonical flip.

The result is intentionally conservative:

- Split repo CI remains canonical for broker, Docker runner, and OpenClaw
  plugin implementation truth.
- `a2a-plane` keeps first-class contract, conformance, scanner, and release
  gate checks for the umbrella workspace.
- The current `packages/*` mirrors are still stale and must not become
  authoritative until a fresh import rehearsal proves equal-or-stricter package
  coverage.
- Agent Olympics is out of scope for A2A monorepo CI parity, package boundary,
  import rehearsal, and issue routing.

## Package Boundary Matrix

| Surface | Split repo canonical CI | Plane workspace job today | Parity status | Required before authoritative |
| --- | --- | --- | --- | --- |
| Broker | `jinwon-int/a2a-broker` `ci`: `npm ci`, `npm test`; source `test` runs `build`, script syntax checks, and built JS tests. | `broker` job: `npm ci --ignore-scripts --include=dev`, `npm run check -w packages/broker`, root `scan:public-readiness`. | Not green for canonical flip. Plane mirror is stale and its broker build omits current split-repo build-info generation and script syntax checks. | Fresh prefix import from `fae438a4fba301c2a9a02ca7cb11282867327920`; preserve `scripts/generate-build-info.mjs`; compare `npm ci` lifecycle behavior; prove script syntax checks and test globs; decide actions v4/v5 policy. |
| Docker runner | `jinwon-int/a2a-docker-runner` `ci`: `npm ci`, `check`, `build`, `lint`, `test`, fail-closed `pre-pr-bootstrap-guard`; release-gate adds chaos E2E and release candidate dry-run evidence. | `docker-runner` job: root install, package `npm run check`, root `scan:public-readiness`. | Not green for canonical flip. Plane job is narrower than split CI and does not cover release-gate dry-run behavior. | Fresh prefix import from `dc43cc1704bbc00abd8600cc05b2a1d5f4d1bdfe`; preserve CLI/package files; add build/lint/test/pre-pr-bootstrap parity; model release-gate dry-run evidence without tag/publish; decide artifact policy. |
| OpenClaw plugin | `jinwon-int/openclaw-plugin-a2a` `ci`: `npm ci`, `scan:public-readiness`, `smoke:a2a-conformance`, `npm test`; package build copies `openclaw.plugin.json`; `prepack` scans then builds. | `plugin` job: `npm ci --ignore-scripts --include=dev`, `npm run check -w packages/openclaw-plugin-a2a`, root `scan:public-readiness`. | Not green for canonical flip. Plane mirror lacks current bin/docs/files shape and does not run plugin-local public scan or A2A conformance smoke. | Fresh prefix import from `a2e521271483ef0b6a29907c8228f0a442dd2db9`; preserve `openclaw` peer boundary; preserve manifest copy/prepack behavior; add plugin-local scan and conformance smoke; verify package files/bin exports. |

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

These are umbrella gates, not proof that the stale package mirrors can replace
the split repos.

## Known CI Differences

| Difference | Current finding | Required decision |
| --- | --- | --- |
| GitHub Actions versions | Split repos use `actions/checkout@v5` and `actions/setup-node@v5`; `a2a-plane` uses v4 for both. | Align or explicitly accept the version drift before treating plane jobs as equivalent. |
| Install lifecycle | Split repo CI uses `npm ci`; plane CI uses `npm ci --ignore-scripts --include=dev`. | Prove lifecycle-script suppression is safe for all imported packages, or split package jobs must run lifecycle-equivalent checks. |
| Broker build side effects | Split broker build generates build-info; plane broker mirror only runs `tsc`. | Preserve and validate build-info generation after import. |
| Runner release policy | Split runner has an approval-gated release workflow with dry-run evidence and isolated tag path. | Mirror release-gate evidence without creating tags, releases, npm packages, images, deploys, or live mutations. |
| Plugin packaging | Split plugin build copies `openclaw.plugin.json`, exposes CLI bins, and `prepack` scans then builds. | Preserve manifest packaging, bin exports, OpenClaw peer dependency, and local fixture boundary. |
| Scanner coverage | Split plugin runs plugin-local `scan:public-readiness`; plane runs root public readiness. | Keep root scanner and add/retain package-local scanners where split repos have them. |

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
