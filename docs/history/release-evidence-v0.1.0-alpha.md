# v0.1.0-alpha release evidence packet

Prepared for #1286 on 2026-07-05. This packet is source-only evidence for the `v0.1.0-alpha` tag/release decision and does not publish packages, push images, deploy, restart services, mutate production data, send provider messages, or change repository visibility.

## Candidate

| Field | Value |
|---|---|
| Tag | `v0.1.0-alpha` |
| Candidate branch/PR | Release prep PR URL is filled in the PR body; final packet closeout records the merged PR URL |
| Candidate commit | Filled from the squash merge commit before tag creation |
| Operator approval | Operator approved “준비 PR + tag/Release 생성까지 승인” in the 2026-07-05 Telegram session |
| Package publication | Out of scope |
| Docker/GHCR publication | Out of scope |
| Production deploy/restart | Out of scope |

## Version-field consistency

| Package | Source version | Release tag disposition |
|---|---:|---|
| `a2a-broker` | `0.1.0` | Covered by `v0.1.0-alpha`; package remains private/unpublished |
| `@openclaw/a2a-docker-runner` | `0.1.0` | Covered by `v0.1.0-alpha`; npm publication remains out of scope |
| `plugin-a2a` | `0.1.0` | Covered by `v0.1.0-alpha`; package remains private/unpublished |

The package manifests use `0.1.0` as the source-state SemVer base. The git tag adds the alpha promotion qualifier without approving npm/Docker publication. The root workspace is private and intentionally has no package version because it is not a publication target.

## Candidate evidence checklist

This mirrors the 11 checklist bullets in `docs/release-readiness.md`.

| # | Checklist item | Evidence / disposition |
|---:|---|---|
| 1 | candidate commit SHA and branch/PR URL | Prep PR records branch; final merge commit recorded before tag |
| 2 | `npm ci --ignore-scripts --include=dev` from a clean checkout | Required before tag; local PR validation records command output |
| 3 | `npm run check` | Required before tag; local + CI validation records command output |
| 4 | `npm run smoke:quickstart` when supported | Required if local environment supports full quickstart; otherwise record skip reason |
| 5 | `npm run check:markdown-links` | Required before tag |
| 6 | `npm run scan:public-readiness` | Required before tag; current prep run is `ok=true`, 0 failures, with existing non-blocking warnings recorded separately |
| 7 | `npm run scan:external-secrets` | Required before tag, accepting only synthetic fixture findings; current prep run reported 23 exact synthetic fixture findings and passed |
| 8 | package contents audit for selected package surface | No package publication selected; source tree/package metadata reviewed only |
| 9 | license and NOTICE review | MIT `LICENSE` present; no separate NOTICE required at this alpha tag |
| 10 | public API / compatibility boundary review | Compatibility matrix and contract fixtures remain in release gate |
| 11 | known limitations and rollback/deprecation expectations | `docs/known-limitations.md`, `docs/public-readiness.md`, and this packet keep alpha/no-production boundaries explicit |

## Public-readiness warning disposition

The current prep run of `npm run scan:public-readiness` is passing with 0 failures and 120 warnings. The warnings are pre-existing public-readiness markers (internal node identifier examples and operator-name fixtures) that the scanner classifies as non-blocking in strict mode. They do not authorize publication beyond the GitHub tag/release.

## Merge-train disposition

This #1286 preparation is a single source-only PR. The multi-PR merge-train preflight in `docs/release-checklist.md` is therefore not applicable to the prep PR itself. If the tag/release decision is batched with any other PR, run `npm run round:merge-preflight -- <pr> [<pr> ...]` before merging the first PR in that batch.

## Tag/release execution plan

After the prep PR merges and all candidate checks pass:

1. Confirm `git status --short --branch` is clean on `main` and `origin/main`.
2. Create annotated tag `v0.1.0-alpha` on the merge commit.
3. Push the tag to `origin`.
4. Create a GitHub Release named `v0.1.0-alpha` using the `CHANGELOG.md` section as release notes.
5. Verify `gh release view v0.1.0-alpha` and `git ls-remote --tags origin v0.1.0-alpha`.
6. Do not run npm publish, Docker/GHCR push, deploy, restart, provider send, DB mutation, or visibility change.

## Rollback / no-op boundary

If tag or release verification fails before public consumption, delete only the just-created GitHub Release/tag after operator review. Do not rewrite branch history. If the tag is already consumed externally, leave it immutable and create a follow-up corrective tag/release note.
