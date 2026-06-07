# A2A Monorepo Branch Protection And Release Policy

> **Snapshot date:** 2026-06-07
> **Parent:** [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511)
> **Child:** [a2a-plane#517](https://github.com/jinwon-int/a2a-plane/issues/517)
> **Status:** phase 0 policy recorded. No branch protection or release settings were changed.

## Summary

This policy defines the branch-protection, tag, release, and package-publishing
requirements that must be green before `a2a-plane` can become a canonical
monorepo source. It is a source-only policy. It does not modify GitHub settings,
create tags, create releases, publish packages or images, archive repositories,
or flip canonical ownership.

Live check on 2026-06-07 KST found `a2a-plane/main` branch protection absent:
the GitHub branch protection API returned `404 Branch not protected`.

## Canonical Flip Gate

No canonical flip can happen until all of these are green and linked from an
explicit operator sign-off:

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Import rehearsal | Fresh history-preserving prefix import from clean split repo refs. | Not green |
| CI parity | Monorepo package jobs equal or stricter than split repo CI. | Matrix recorded; not green |
| Docs/CODEOWNERS | Migration, operator, developer, issue-routing, and CODEOWNERS drafts recorded. | Draft recorded; not final cutover |
| Branch protection | `a2a-plane/main` protection/ruleset policy approved and applied. | Not green; API returned 404 |
| Release/package policy | Tag/release/npm/GHCR/Docker namespace policy approved. | This policy recorded; no publish approval |
| Operator sign-off | Separate approval names exact canonical flip scope. | Not granted |

## Branch Protection Requirements

Before canonical monorepo ownership can be considered, `a2a-plane/main` should
have an explicitly approved protection or ruleset baseline:

- required status checks for `paths-filter`, `setup`, `layout`, `contracts`,
  `broker`, `docker-runner`, `plugin`, and `check`, or an approved equivalent
  ruleset that covers the same surfaces;
- require branches to be up to date before merge, unless an operator explicitly
  accepts a merge-queue or squash-only alternative;
- require at least one pull request review;
- require CODEOWNERS review if GitHub settings support it for the approved
  review model;
- block force pushes and branch deletion;
- decide whether administrators are included;
- decide whether linear history is required.

These are settings changes and require a separate explicit approval. This PR
does not perform them.

## Tag Policy

Existing source-public tags remain historical source snapshot markers. For
example, `source-public-20260511` currently points to
`83bc1519ebc4b45d9c1ddc4be2a9011fb4b210b4`.

Rules:

- do not move, delete, or reinterpret historical source-public tags;
- do not treat source-public tags as semantic releases; source-public tags are
  not semantic releases;
- prefix or namespace any future monorepo rehearsal tags before use;
- create no new tag without a separate approval naming repo, tag, target SHA,
  annotated/signed/lightweight decision, and confirmation that no publish or
  deploy is bundled.

## Package Namespace Policy

| Surface | Current package posture | Monorepo policy before approval |
| --- | --- | --- |
| Root `a2a-plane` | Private workspace package. | Remains non-published coordination workspace. |
| Broker | Split repo package is private. | No npm publish; package metadata remains rehearsal-only until release approval. |
| Docker runner | Split repo owns the public CLI/package boundary. | Preserve split `@openclaw/a2a-docker-runner` trust boundary; no monorepo publish or rename without approval. |
| OpenClaw plugin | Split repo package is private and has OpenClaw peer boundary. | No npm publish; preserve manifest/prepack/peer boundary before any release decision. |
| Docker/GHCR images | No monorepo image publication approved. | No build/push/sign/publish path without separate image approval. |

`npm pack --dry-run` may be used only as local evidence in a clean checkout when
the output is sanitized and no publish side effect occurs. `npm publish`,
registry dist-tag mutation, GitHub Packages, GHCR, Docker Hub, release assets,
and image signing remain blocked.

## Provenance Archives

The split repos remain provenance archives and canonical implementation sources
during phase 0/1. Closed issues, PRs, release evidence, and source-public
snapshot history stay in their original repos. If a future canonical flip is
approved, add backlinks and pinned issues rather than bulk-transferring closed
history.

Agent Olympics (`agent-olympics`) is independent and is not part of this
policy's package, release, branch-protection, or monorepo import scope.

## No-live Boundary

This policy does not authorize branch protection changes, ruleset changes,
repository archive, visibility changes, tag creation or movement, GitHub
Releases, npm/GitHub Packages/GHCR/Docker publication, production deploys,
Gateway/broker/worker restarts, database mutation, provider or Telegram sends,
Terminal ACK/replay, credential movement, history rewrite, force push,
destructive cleanup, or worker-owned GitHub mutation.
