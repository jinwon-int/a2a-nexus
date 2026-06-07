# A2A Monorepo Import Rehearsal Plan

> **Snapshot date:** 2026-06-07
> **Parent:** [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511)
> **Child:** [a2a-plane#513](https://github.com/jinwon-int/a2a-plane/issues/513)
> **Phase-1 refresh:** [a2a-plane#528](https://github.com/jinwon-int/a2a-plane/issues/528)
> **Phase-2 rehearsal:** [a2a-plane#530](https://github.com/jinwon-int/a2a-plane/issues/530)
> **Phase-3 gate:** [a2a-plane#534](https://github.com/jinwon-int/a2a-plane/issues/534)
> **Phase-3 CI jobs:** [a2a-plane#536](https://github.com/jinwon-int/a2a-plane/issues/536)
> **Phase-4 import candidate:** [a2a-plane#538](https://github.com/jinwon-int/a2a-plane/issues/538)
> **Phase-5 readiness gate:** [a2a-plane#541](https://github.com/jinwon-int/a2a-plane/issues/541)
> **Phase-6 branch protection packet:** [a2a-plane#543](https://github.com/jinwon-int/a2a-plane/issues/543)
> **Status:** phase-4 fresh prefix import candidate merged through #540; split repos remain canonical until branch protection/ruleset approval and separate canonical-flip approval.

## Summary

This document turns the monorepo re-entry decision into a concrete import
rehearsal and mirror freshness plan. The `#538` candidate imported fresh
tracked trees into `packages/*` through PR `#540`, but it still does not flip
canonical ownership.

The immediate finding is that `a2a-plane/packages/*` is useful as an umbrella
workspace shape, but it is not current enough to become canonical. The split
implementation repositories still own runtime truth during phase 0/1:

- `jinwon-int/a2a-broker`
- `jinwon-int/a2a-docker-runner`
- `jinwon-int/openclaw-plugin-a2a`

## Mirror Freshness Snapshot

| Surface | Split repo head | Plane package path | Split tracked files | Plane tracked files | Freshness verdict |
| --- | --- | --- | ---: | ---: | --- |
| Broker | `fae438a4fba301c2a9a02ca7cb11282867327920` | `packages/broker` | 857 | 236 | stale mirror; split repo canonical |
| Docker runner | `0aafede5e9869ea78da2707fe5e334d9530cba96` | `packages/docker-runner` | 137 | 59 | stale mirror; split repo canonical |
| OpenClaw plugin | `a2e521271483ef0b6a29907c8228f0a442dd2db9` | `packages/openclaw-plugin-a2a` | 179 | 116 | stale mirror; split repo canonical |

Tracked-file counts are not a quality score. They are a drift signal: the
package mirrors cannot be trusted as source-of-truth without a rehearsal import
and CI parity check.

## Phase-1 Freshness Refresh (#528)

The 2026-06-07 KST phase-1 refresh collected fresh split-repo heads before any
canonical flip or import-to-main decision. The result remains conservative:

- `a2a-broker` still matches the phase-0 source head but the plane package is
  much smaller than the split repo.
- `a2a-docker-runner` moved from the previous snapshot to
  `0aafede5e9869ea78da2707fe5e334d9530cba96`; the split repo now has 137
  tracked files versus 59 in the plane package mirror.
- `openclaw-plugin-a2a` keeps the same source head but the split repo now has
  179 tracked files versus 116 in the plane package mirror.

No package mirror is fresh enough to become canonical. The next source change
must be a fresh prefix import rehearsal plus CI parity evidence, not a direct
canonical flip.

## Phase-2 Fresh Prefix Rehearsal (#530)

The 2026-06-07 KST phase-2 rehearsal used fresh default-branch source heads and
a disposable detached worktree based on the #529 merge commit
`e2ed672ac7a082e39a20ffd43d64d516413c153d`. Each split repo was archived from
Git and expanded into its prefixed `packages/*` path in the throwaway worktree
only. The rehearsal imported tracked files only, did not import to `main`, and
did not flip canonical ownership.

| Surface | Fresh split repo head | Tracked split / plane files | Rehearsal package status | Manifest/script result | Phase-3 blocker |
| --- | --- | ---: | --- | --- | --- |
| Broker | `fae438a4fba301c2a9a02ca7cb11282867327920` | 857 / 236 | 633 added-or-untracked, 86 changed, 12 removed | 119 source-only scripts, 4 plane-only scripts, `build` and `test` differ | Too much package drift; preserve source script checks and build-info behavior before mirror refresh. |
| Docker runner | `269a0ef90737158b41f8da26241b9f7f4b14af5e` | 138 / 59 | 79 added-or-untracked, 31 changed, 0 removed | 5 source-only scripts, `check` and `lint` differ, `files` and `license` differ | Split head moved after #529; plane package job is still narrower than source `check/build/lint/test/pre-pr` gates. |
| OpenClaw plugin | `a2e521271483ef0b6a29907c8228f0a442dd2db9` | 179 / 116 | 67 added-or-untracked, 53 changed, 4 removed | 2 source-only scripts, 1 plane-only script, `build`, `prepack`, and `test:gateway` differ | Plugin-local scan, A2A conformance smoke, bin/files metadata, and manifest-copy behavior are not yet mirrored. |

Generated/build artifact exclusion: the rehearsal used `git archive`, so
`node_modules`, untracked build output, and local temporary files were not
imported. None of the three split repos had tracked `dist`, `build`,
`coverage`, or `node_modules` paths in this rehearsal snapshot.

Phase-3 should **not** be a package mirror refresh PR yet. The next step is to
close the package CI parity blockers in the matrix, then perform a mirror
refresh only after the package jobs are equal-or-stricter than split repo CI.

## Phase-3 Package CI Gate (#534)

The next monorepo action is the phase-3 package CI gate, not a package mirror
refresh. The gate records package-local CI requirements before any refreshed
prefix import can be proposed for `packages/broker`, `packages/docker-runner`,
or `packages/openclaw-plugin-a2a`.

The gate keeps these conditions blocked until proven:

- broker package jobs preserve source `npm ci` behavior, build-info generation,
  script syntax checks, and the broader split-repo test glob;
- Docker runner package jobs include `check`, `build`, `lint`, `test`,
  `pre-pr-bootstrap-guard`, chaos/no-live evidence, release-candidate dry-run,
  and package metadata checks;
- OpenClaw plugin package jobs keep plugin-local public-readiness scanning,
  A2A conformance smoke, manifest copy/prepack behavior, bin/files metadata,
  and the OpenClaw peer boundary.

The fixture
[`fixtures/current-state/monorepo-phase3-package-ci-gate.json`](../fixtures/current-state/monorepo-phase3-package-ci-gate.json)
and `check:monorepo-phase3-package-ci-gate` make the blocker release-gate
visible. A future mirror refresh PR must either satisfy the recorded package
jobs or cite a separate operator decision that accepts the remaining parity
risk.

## Phase-3 Package CI Jobs (#536)

The package CI job implementation is source-only and no-live. The workflow now
uses `actions/checkout@v5`, `actions/setup-node@v5`, and `npm ci --include=dev`
for package jobs, then calls
`scripts/run-monorepo-package-ci-parity.mjs` for each package surface:

- `broker`: package check, build-info generation, dispatch helper syntax
  checks, built JS tests, and `npm pack --dry-run`.
- `docker-runner`: `check`, `build`, `lint`, `test`,
  `pre-pr-bootstrap-guard`, no-live chaos evidence, no-publish
  release-candidate dry-run evidence, package metadata checks, and
  `npm pack --dry-run`.
- `openclaw-plugin-a2a`: plugin-local public-readiness scan,
  A2A conformance smoke, tests, prepack, manifest copy, OpenClaw peer-boundary
  check, and `npm pack --dry-run`.

This makes CI parity executable before mirror refresh, but it still does not
refresh package content or approve canonical ownership. The next import
rehearsal must run these jobs against a fresh prefix import and compare any
remaining package metadata/bin/files drift before `packages/*` can become
authoritative.

## Phase-4 Fresh Prefix Import Candidate (#538)

The `#538` candidate starts from the `#537` merge commit
`1eb67fa55f756c9b47db4ec9b6b1d604683c618d`, removes the existing package
mirrors, and expands fresh split-repo tracked trees into the same package paths
with `git archive`. It intentionally imports tracked files only; ignored build
outputs, `node_modules`, coverage, and local temporary files are excluded.

| Surface | Fresh split repo head | Split tracked files | Target path | Candidate validation |
| --- | --- | ---: | --- | --- |
| Broker | `f9f4af5a76649a37b8a3d492805b6e5f410683a6` | 869 | `packages/broker` | `node scripts/run-monorepo-package-ci-parity.mjs broker` passed locally. |
| Docker runner | `269a0ef90737158b41f8da26241b9f7f4b14af5e` | 138 | `packages/docker-runner` | `node scripts/run-monorepo-package-ci-parity.mjs docker-runner` passed locally. |
| OpenClaw plugin | `a2e521271483ef0b6a29907c8228f0a442dd2db9` | 179 | `packages/openclaw-plugin-a2a` | `node scripts/run-monorepo-package-ci-parity.mjs openclaw-plugin-a2a` passed locally. |

Candidate-only compatibility patches are limited to package/workspace
execution:

- Broker and OpenClaw plugin add `check: npm test` so the root
  `check:packages` gate can run package checks without weakening source tests.
- OpenClaw plugin uses `tsc` from npm script PATH instead of a nested
  `./node_modules/typescript` path so workspace-hoisted installs and split
  installs both work.
- Docker runner uses the latest split-repo `release-candidate-parity-audit`
  script as the no-publish release evidence path; tag/release creation remains
  blocked.

This import mode is not history-preserving. Closed issue/PR provenance remains
in the split implementation repos, while the candidate PR records exact source
refs and package parity evidence. If the candidate regresses, rollback is a
normal PR revert; split repos remain canonical.

## Phase-5 Canonical Flip Readiness (#541)

The phase-5 gate records readiness evidence before any ownership transfer. It
uses the #540 merge commit `31273ce05b7e53655e3d8847a8d77ff1cd2f6d05`, the
green package parity CI run, split-repo provenance policy, rollback path, and
GO/NO-GO fields. The decision remains `NO_GO / Waiting` because #540 was not
history-preserving, branch protection/release/package policy execution has not
been approved, and no operator canonical-flip approval exists.

## Phase-6 Branch Protection Approval Packet (#543)

The phase-6 packet records the settings gate that must be decided before any
canonical flip: `a2a-plane/main` is still not protected and has no repository
rulesets, while `#542` proved the latest monorepo readiness packet under green
CI. The packet proposes required-check and review fields but does not apply
settings. Split repos remain canonical until settings and canonical-flip
approvals are both explicit and separate.

## Rehearsal Strategy

Use a fresh additive workspace, for example `a2a-monorepo-next`. Do not reuse
the existing local `a2a-monorepo` checkout and do not repurpose stale package
mirrors as canonical source.

Preferred import mode:

1. Start from clean upstream refs.
2. Import each split repo into a prefixed path:
   - `packages/broker`
   - `packages/docker-runner`
   - `packages/openclaw-plugin-a2a`
3. Preserve useful history where practical through a history-preserving prefix
   import rehearsal. Do not squash by default.
4. Prefix, rename, or drop colliding tags only after documenting the tag policy.
5. Compare manifests, scripts, CI, scanner gates, package metadata, and build
   side effects against split repos.
6. Discard the rehearsal workspace if any parity gate is unclear.

## Rollback / Discard Points

| Phase | Safe rollback point |
| --- | --- |
| Source ref collection | Stop and keep split repos canonical. |
| Prefix import rehearsal | Delete the disposable rehearsal workspace. |
| Manifest/script comparison | Keep source changes in split repos until parity is defined. |
| CI parity rehearsal | Keep split repo CI authoritative until all package jobs are green. |
| Workspace PR | Merge docs/layout/parity checks only; no canonical flip. |

## Required Report Fields

Every import rehearsal report must include:

- source repo and source ref;
- target path;
- import method;
- tag collision policy;
- issue/PR provenance policy;
- package manifest/script differences;
- CI parity status;
- scanner gate status;
- rollback/discard point;
- finalizer decision.

## No-live Boundary

This plan does not authorize repository import into `main`, history rewrite,
canonical flip, branch protection changes, release tags, GitHub Releases, npm
or Docker publication, repository visibility changes, production deploys,
Gateway/broker/worker restarts, database mutation, provider or Telegram sends,
Terminal ACK/replay, credential movement, destructive cleanup, or worker-owned
GitHub mutation.
