# Public Release Provenance Checklist

Issues: [a2a-plane#473](https://github.com/jinwon-int/a2a-plane/issues/473), [a2a-plane#478](https://github.com/jinwon-int/a2a-plane/issues/478), [a2a-plane#479](https://github.com/jinwon-int/a2a-plane/issues/479)

Related follow-up issues: [a2a-broker#951](https://github.com/jinwon-int/a2a-broker/issues/951), [a2a-broker#952](https://github.com/jinwon-int/a2a-broker/issues/952), [openclaw-plugin-a2a#454](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/454), [a2a-docker-runner#343](https://github.com/jinwon-int/a2a-docker-runner/issues/343)

This checklist distinguishes a source-public snapshot from a product release for the current split A2A repositories:

- [`jinwon-int/a2a-plane`](https://github.com/jinwon-int/a2a-plane)
- [`jinwon-int/a2a-broker`](https://github.com/jinwon-int/a2a-broker)
- [`jinwon-int/openclaw-plugin-a2a`](https://github.com/jinwon-int/openclaw-plugin-a2a)
- [`jinwon-int/a2a-docker-runner`](https://github.com/jinwon-int/a2a-docker-runner)

Completing this checklist is documentation work only. It does not create tags, GitHub Releases, npm packages, Docker/images, deployments, restarts, database mutations, live provider/Telegram sends, terminal ACK/replay, credential movement, secret rotation, visibility changes, history rewrites, or force-pushes.

## Definitions

| Term | Meaning | What it does not mean |
|---|---|---|
| Source-public snapshot | A public repository state intended for source review, with redacted docs and a marker such as `source-public-20260511`. | Not a semantic version, GitHub Release, npm package, Docker/image artifact, compatibility certification, signed provenance attestation, or operator approval. |
| Product release | A named version with release notes, immutable tag, CI evidence, license/package metadata, compatibility matrix, and explicit approval for the exact release action. | Not implied by public visibility, green CI, source-public tags, or merged docs PRs. |
| Package publication | Publishing to a package registry such as npm. | Not implied by `package.json` presence, `version`, or `private: false`. |
| Image publication | Publishing a Docker/OCI image or artifact digest to a registry. | Not implied by Dockerfiles, build scripts, or CI success. |
| Provenance evidence | Links to exact commits, CI runs, release notes, checksums/digests, package tarball dry-run output, scanner summaries, and approval comments. | Not raw logs, secrets, private paths, provider IDs, Telegram IDs, terminal transcripts, or unredacted scanner findings. |

## Approval Gates

Every action below requires separate explicit operator approval. Approval must name the exact repo(s), version/tag/artifact, action, and allowed command class. Generic phrases such as "looks good", "docs ready", "green CI", or "continue" are not release approval.

| Gate | Requires explicit approval before | Minimum approval text must include |
|---|---|---|
| Tag gate | Creating or moving any tag, including semantic versions and new source-public markers. | Repo, tag name, target commit SHA, whether tag is annotated/signed/lightweight, and confirmation that no deploy/publish is bundled. The `a2a-docker-runner` release-gate workflow is being hardened to split validation from the non-dry-run tag path and attach tag creation to the `release` GitHub Environment (see [#485](https://github.com/jinwon-int/a2a-plane/issues/485), [a2a-docker-runner#345](https://github.com/jinwon-int/a2a-docker-runner/pull/345), `.github/workflows/release-gate.yml`). |
| GitHub Release gate | Drafting, publishing, editing, or marking a GitHub Release as latest/prerelease. | Repo, tag, release name, release notes source, artifact policy, and whether the release is draft/prerelease/latest. |
| npm gate | Running `npm publish`, changing `private` to `false` for a currently private package, or publishing package provenance. | Package name, version, registry, tag/dist-tag, tarball dry-run evidence, and rollback/deprecation plan. |
| Docker/image gate | Building for publication, pushing, signing, or attaching image artifacts/digests. | Image name, registry, tag, digest/provenance plan, base image policy, and rollback/deprecation plan. |
| Visibility gate | Changing repository visibility or transferring/mirroring repos. | Repo, target visibility/owner, reason, and confirmation that no release/publish/deploy is bundled. |
| Live/runtime gate | Deploying, restarting Gateway/broker/worker, mutating production DBs, sending live provider/Telegram messages, terminal ACK/replay, or moving credentials. | Exact target service/action, risk, rollback/no-op boundary, and evidence capture plan. |

## Source-Public Snapshot Checklist

Use this checklist to validate source-public review status only.

- [ ] Confirm the repository is intended to be public source at the checked commit.
- [ ] Record the exact commit SHA and branch.
- [ ] Confirm `source-public-20260511` or a newer source-public marker exists and points to the intended source snapshot.
- [ ] Confirm the marker is documented as source-public, not product release.
- [ ] Confirm current CI result for the exact commit or document why only latest-main CI is available.
- [ ] Run repository-local public-readiness checks where available and record pass/fail plus finding counts only.
- [ ] Run or link external secret-history scanner evidence where available; if unavailable, record fail-closed blocker status.
- [ ] Confirm public docs do not expose raw secrets, private endpoints, provider IDs, Telegram IDs, raw session dumps, host-private paths, credential values, or production data.
- [ ] Preserve historical NO-GO evidence as historical, but add current-state notes when docs still claim repos are private after they became public.
- [ ] Link open follow-up issues for compatibility, trust metadata, diagnostics, package metadata, and runner support gaps.

## Product Release Checklist

Use this checklist only after source-public review is clean. A product release remains **NO-GO** until every required row is satisfied or explicitly waived by the operator in a linked approval comment.

| Area | Required evidence |
|---|---|
| Version boundary | Version name, release type (`alpha`, `beta`, `stable`, docs-only), repo list, and exact commits. |
| Tag policy | Tag name, target commit SHA, signed/annotated decision, and proof no tag exists or that update approval exists. |
| Release notes | Public-safe release notes with known limitations, compatibility scope, unsupported surfaces, and rollback/no-op instructions. |
| CI | Green CI for each release commit, with links to workflow runs. |
| Local checks | Fresh checkout install/build/test commands for each repo, with sanitized pass/fail summary. |
| License | GitHub-detected license and root license file for each release repo; package `license` field where packages are published. |
| Package metadata | `name`, `version`, `private`, `license`, `files`, `exports`/entrypoints, package README, changelog, and `npm pack --dry-run` summary for npm candidates. |
| Image metadata | Docker/OCI image name, tag, digest, build source commit, base image policy, SBOM/provenance plan, and registry target for image candidates. |
| Compatibility | Compatibility matrix including exact official A2A SDK/TCK references or a public-safe deferred statement. Broker#951 is the tracker for official SDK/TCK drift. |
| Trust metadata | Signed AgentCard / secure-passport posture, or explicit deferral. Broker#952 is the tracker. |
| Plugin diagnostics | Plugin-visible broker protocol profile or explicit deferral. Plugin#454 is the tracker. |
| Runner coverage | Supported repo families and explicit unsupported/fail-closed behavior. Runner#343 tracks Go/Java evidence support. |
| Secret/history scan | Redacted external scanner summary and disposition, with no matched secret values copied. |
| Stale docs | Current-state notes for old private/NO-GO docs so users can distinguish historical gates from current blockers. |
| Approval | Linked operator approval naming exact release/tag/publish/image action. |

## Repo-Specific Release Preconditions

| Repo | Source-public state | Product release prerequisites |
|---|---|---|
| `a2a-plane` | Public docs/coordination repo with MIT license and `source-public-20260511` marker. Root package is `private: true`. | Decide whether it remains a non-published coordination/docs package. Update stale private-candidate description and supersede historical private-visibility docs. Link #473 split-vs-monorepo decision. |
| `a2a-broker` | Public source repo with source-public marker and green CI. Package is `private: true`; license metadata absent in GitHub/package metadata. | Add/confirm license, package metadata, release notes, compatibility matrix, official A2A SDK/TCK drift posture (#951), trust metadata posture (#952), and explicit release/publish approvals. |
| `openclaw-plugin-a2a` | Public source repo with source-public marker and green CI. Package is `private: true`; license metadata absent in GitHub/package metadata. | Add/confirm license, package metadata, package files allowlist, plugin protocol diagnostics or deferral (#454), and explicit npm release approval. |
| `a2a-docker-runner` | Public source repo with MIT root license, source-public marker, green CI, and package `private: false`. | Package `license` and `files` allowlist plus release/tag workflow approval gating are tracked by [#485](https://github.com/jinwon-int/a2a-plane/issues/485) and [a2a-docker-runner#345](https://github.com/jinwon-int/a2a-docker-runner/pull/345). Remaining: run package tarball dry-run, decide image publication boundary, close or defer Go/Java evidence support (#343), configure the `release` GitHub Environment with required reviewers before non-dry-run use, and obtain explicit npm/image approval. |

## Publication Command Boundary

Allowed before approval:

- Read-only GitHub metadata checks.
- Local docs checks.
- Local build/test/scan commands that do not contact production, publish artifacts, send messages, mutate DBs, restart services, move credentials, or alter history.
- `npm pack --dry-run` only when performed in a clean checkout with no publish side effects and sanitized output.

Blocked until explicit approval:

- `git tag`, `git push --tags`, or moving/deleting tags.
- `gh release create`, `gh release edit`, or publishing release assets.
- `npm publish`, package visibility changes, registry token movement, or dist-tag mutation.
- Docker/OCI image push/sign/publish, registry credential movement, or production image retagging.
- Deploys, Gateway/broker/worker restarts, production database mutation, live provider/Telegram sends, terminal ACK/replay, credential movement, secret rotation, history rewrite, force-push, or repository visibility changes.

## Minimum Release Evidence Packet

Before requesting any release approval, prepare a single public-safe packet containing:

- Repo/version table with exact commit SHAs.
- CI run links for each repo.
- Local check summary with command names and pass/fail counts only.
- License/package metadata table.
- Secret/history scanner summary with counts/classes only.
- Compatibility/trust/diagnostics/runner-support status and linked issues.
- Release notes draft.
- Proposed tag/release/npm/image actions listed separately.
- Explicit statement that no approval-gated action has already been performed.

## Current Decision

Decision: **source-public snapshot documented; product release, npm publication, Docker/image publication, and GitHub Release creation remain NO-GO / waiting**.

The current split repos can be reviewed as public source. They are not approved release artifacts until this checklist is completed and the operator approves the exact publication actions.
