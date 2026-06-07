# A2A Monorepo Branch And Release Package Policy

> **Snapshot date:** 2026-06-07
> **Issue:** [a2a-plane#517](https://github.com/jinwon-int/a2a-plane/issues/517)
> **Status:** reviewed and documented; no GitHub settings, release, tag, package, image, visibility, or canonical-source change is approved.

This document records the branch protection and release/package policy required
before `a2a-plane` can become any canonical monorepo source. It is a source-only
policy record. It does not change GitHub settings, move packages, create tags,
publish artifacts, archive repositories, or flip canonical ownership.

## Live Evidence

Evidence was collected on 2026-06-07 KST with read-only GitHub CLI/API calls.
Only status fields and finding counts are recorded.

| Repo | Visibility | Default branch | Branch protection | Rulesets | Release API | Tags |
| --- | --- | --- | --- | --- | --- | --- |
| `jinwon-int/a2a-plane` | Public | `main` | None; protection API returned `404 Branch not protected` | None | No releases returned | `source-public-20260511` |
| `jinwon-int/a2a-broker` | Public | `main` | Required `build`, strict/up-to-date; no PR review; admins not enforced | None | No releases returned | `source-public-20260511` |
| `jinwon-int/a2a-docker-runner` | Public | `main` | Required `build`, strict/up-to-date; no PR review; admins not enforced | None | No releases returned | `source-public-20260511` |
| `jinwon-int/openclaw-plugin-a2a` | Public | `main` | Required `build`, strict/up-to-date; no PR review; linear history and conversation resolution enabled | None | No releases returned | `source-public-20260511` |

GitHub Packages inventory could not be verified with the current token because
the organization packages API requires `read:packages`. That absence of package
inventory evidence is not approval to publish. Package and image publication
remain NO-GO until a separate operator approval names the package, namespace,
version, registry, and dry-run evidence.

## Branch Protection Policy

Before any canonical flip, `a2a-plane/main` must have a protection/ruleset
baseline that is at least as strict as the split repos and is appropriate for a
monorepo workspace.

Required before canonical source authority can move:

| Requirement | Policy |
| --- | --- |
| Protected `main` | `a2a-plane/main` must be protected. Direct pushes to `main` are not the canonical-change path. |
| Required checks | Require stable root checks: `paths-filter`, `setup`, `layout`, `contracts`, and `check`. Package jobs `broker`, `docker-runner`, and `plugin` must either be required when touched or guarded by path-aware rulesets so skipped jobs do not hide package drift. |
| PR review | Require at least one approved PR review before merge. |
| CODEOWNERS review | Enforce CODEOWNERS review after package ownership has been accepted as final, not merely draft routing. |
| Up-to-date branch | Require branches to be up to date before merge, or use an equivalent merge queue/ruleset. |
| Stale review handling | Dismiss stale approvals when new commits are pushed. |
| Admin coverage | Decide explicitly whether admins are included; the safer default for canonical flip is to include administrators. |
| Critical path rulesets | Add rulesets or equivalent review gates for `.github/workflows/**`, `scripts/**`, `packages/**`, `contracts/**`, `fixtures/**`, and `scanner/**`. |
| History policy | Squash merge is acceptable for source-only docs/checker PRs. History-preserving package import remains a separate rehearsal decision and must not be inferred from squash merges. |

These settings are GitHub settings-only changes. This PR does not apply them.
Applying any setting above requires a separate operator approval that names the
repository, branch, exact protection, and whether administrators are included.

## Release And Package Policy

The split repos remain canonical implementation sources until CI parity,
package mirror freshness, branch protection, release/package policy, docs,
CODEOWNERS, and final operator sign-off are all green.

| Surface | Current policy before canonical flip |
| --- | --- |
| Historical tag `source-public-20260511` | Preserve as historical provenance. Do not move, delete, or reuse it. |
| GitHub Releases | No release creation from `a2a-plane` under #517. Release drafts, prereleases, and public releases require separate approval. |
| npm packages | No npm publish from `a2a-plane` under #517. Future names must preserve consumer expectations and avoid claiming canonical monorepo authority before flip approval. |
| GitHub Packages | Inventory is unverified due `read:packages` scope absence. Treat as NO-GO until verified and approved. |
| Docker/GHCR images | No Docker or GHCR publication under #517. Runner release-gate evidence may be modeled as dry-run only. |
| Package versions | Keep package version claims experimental until split-repo CI parity and package metadata parity are proven. |
| Split repos | Keep `a2a-broker`, `a2a-docker-runner`, and `openclaw-plugin-a2a` as canonical source/provenance archives. Do not archive or redirect them without separate approval. |

Future release/package approval must be separate from branch protection
approval. A valid approval must name the package or image, version, registry,
tag strategy, dry-run evidence, and rollback/disposition path.

The phase-8 release/package/tag approval packet is tracked in
[`a2a-plane#547`](https://github.com/jinwon-int/a2a-plane/issues/547) and
documented in
[`docs/monorepo-release-package-tag-approval-packet.md`](../monorepo-release-package-tag-approval-packet.md).
It records the package metadata and approval fields only; it does not create
tags, GitHub Releases, npm packages, Docker images, or package ownership
changes.

## Canonical Flip Gate

The canonical flip gate remains closed.

This #517 review completes the policy documentation gate only. It does not make
the overall monorepo cutover green because package CI parity, package mirror
freshness, final CODEOWNERS enforcement, protected branch settings, package
publication evidence, and operator final sign-off are still not granted.

## No-live Boundary

This policy does not authorize repository import into `main`, history rewrite,
canonical flip, branch protection changes, ruleset changes, permission changes,
release tags, GitHub Releases, npm publication, Docker or GHCR publication,
repository archive/visibility change, production deploys, Gateway/broker/worker
restarts, database mutation, provider or Telegram sends, Terminal ACK/replay,
credential movement, destructive cleanup, or worker-owned GitHub mutation.
