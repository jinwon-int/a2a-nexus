# A2A Monorepo Import Rehearsal Plan

> **Snapshot date:** 2026-06-07
> **Parent:** [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511)
> **Child:** [a2a-plane#513](https://github.com/jinwon-int/a2a-plane/issues/513)
> **Phase-1 refresh:** [a2a-plane#528](https://github.com/jinwon-int/a2a-plane/issues/528)
> **Status:** phase 0 planning. Split repos remain canonical.

## Summary

This document turns the monorepo re-entry decision into a concrete import
rehearsal and mirror freshness plan. It does not import repositories or flip
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
