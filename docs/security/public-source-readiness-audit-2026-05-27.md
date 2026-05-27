# Public Source Readiness Audit - 2026-05-27

Issues: [a2a-plane#473](https://github.com/jinwon-int/a2a-plane/issues/473), [a2a-plane#478](https://github.com/jinwon-int/a2a-plane/issues/478), [a2a-plane#479](https://github.com/jinwon-int/a2a-plane/issues/479)

Related follow-up issues: [a2a-broker#951](https://github.com/jinwon-int/a2a-broker/issues/951), [a2a-broker#952](https://github.com/jinwon-int/a2a-broker/issues/952), [openclaw-plugin-a2a#454](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/454), [a2a-docker-runner#343](https://github.com/jinwon-int/a2a-docker-runner/issues/343)

This is a public-safe evidence document for the current split A2A repository layout. It records repository metadata, CI/provenance signals, stale public/private documentation gaps, and release blockers without raw secrets, raw scanner output, private endpoint values, production logs, provider identifiers, Telegram identifiers, or session transcripts.

No approval-gated action is authorized by this audit. In particular, this document does not authorize repository visibility changes, tag creation, GitHub Release creation, npm publication, Docker/image publication, deploys, Gateway/broker/worker restarts, production database mutation, provider or Telegram sends, terminal-outbox ACK/replay, credential movement, secret rotation, history rewrite, or force-push.

## Evidence Sources

Read-only checks performed from a clean `jinwon-int/a2a-plane` checkout and GitHub CLI metadata queries:

- `gh repo view jinwon-int/<repo> --json nameWithOwner,visibility,isPrivate,defaultBranchRef,licenseInfo,url,description,pushedAt`
- `gh release list --repo jinwon-int/<repo> --limit 10`
- `gh api repos/jinwon-int/<repo>/tags --paginate --jq '.[].name'`
- `gh run list --repo jinwon-int/<repo> --limit 5 --json databaseId,displayTitle,headBranch,headSha,status,conclusion,workflowName,createdAt,updatedAt,url`
- `gh api repos/jinwon-int/<repo>/contents/package.json` for package metadata where present
- `gh api repos/jinwon-int/<repo>/contents` for root license/README file presence
- `gh api repos/jinwon-int/<repo>/contents/.github/workflows` for workflow file presence
- `gh search code 'private OR NO-GO OR no-go OR source-public repo:jinwon-int/<repo>' --json path,repository --limit 20`

## Classification Key

| Class | Meaning |
|---|---|
| `blocker` | Must be resolved before claiming product release, package/image publication, or broader public promotion readiness. |
| `gap` | Public-source state can be understood, but metadata/docs/provenance is incomplete or stale. |
| `risk` | Not immediately blocking for source-public review, but can mislead operators or public users if left unresolved. |
| `clear` | No current gap found from this read-only check. |

## Audit Matrix

| Repo | Visibility | License/package metadata status | Source-public tag/release state | CI/provenance evidence | Stale private / NO-GO docs | Classification |
|---|---|---|---|---|---|---|
| [`jinwon-int/a2a-plane`](https://github.com/jinwon-int/a2a-plane) | `PUBLIC`; default branch `main`; latest observed push `2026-05-27T02:48:04Z` | GitHub license detection: MIT. Root `LICENSE` present. Root `package.json` has `private: true`, `license: MIT`, and description still says "Private A2A Plane candidate." This is acceptable for a docs/coordination repo if intentionally non-publishable, but the description is stale. | Tag `source-public-20260511` present. No GitHub Release returned by `gh release list --limit 10`. Treat as source-public snapshot, not product release. | Latest observed main CI success: run `26487694546`, workflow `ci`, commit `c706af1e52b1dc40348d6522de22734b1ad57980`, `2026-05-27T02:48:06Z`, <https://github.com/jinwon-int/a2a-plane/actions/runs/26487694546>. | `docs/public-readiness.md` and `docs/security/r3-secret-history-disposition.md` still contain historical "repo/source repos remain private" language. Some NO-GO material is valid fail-closed history, but needs a current-state preface or supersession note for PUBLIC repos. | `gap`: stale private wording and private package description. `blocker`: no product release/provenance approval and no current external scanner evidence in this audit. |
| [`jinwon-int/a2a-broker`](https://github.com/jinwon-int/a2a-broker) | `PUBLIC`; default branch `main`; latest observed push `2026-05-27T06:32:47Z` | GitHub license detection: none. No root `LICENSE` listed by contents API. `package.json` has `private: true`, version `0.1.0`, no `license`, and description "Minimal standalone A2A broker scaffold." This blocks package-public readiness and makes source license posture ambiguous from repo metadata. | Tag `source-public-20260511` present. No GitHub Release returned by `gh release list --limit 10`. | Latest observed main CI success: run `26494956650`, workflow `ci`, commit `09d244172f71bb49d8397fa613b76e59bd2f1e74`, `2026-05-27T06:32:48Z`, <https://github.com/jinwon-int/a2a-broker/actions/runs/26494956650>. Recent title "Align Docker broker build provenance" is useful provenance work, but it is not a release approval. | `docs/source-public-final-approval-execution-plan.md` and source-public orchestrator files remain relevant fail-closed evidence. Code search also shows source-public test/orchestrator files. No raw values reviewed or copied. | `blocker`: missing license metadata and `private: true` before npm/package release. `gap`: no GitHub Release; release provenance remains source-only. `risk`: follow broker compatibility/trust work in broker#951/#952 before broad interoperability claims. |
| [`jinwon-int/openclaw-plugin-a2a`](https://github.com/jinwon-int/openclaw-plugin-a2a) | `PUBLIC`; default branch `main`; latest observed push `2026-05-26T06:58:39Z` | GitHub license detection: none. No root `LICENSE` listed by contents API. `package.json` has `private: true`, version `0.1.0`, no `license`, and a constrained `files` allowlist. This is safe against accidental npm publish but blocks package-public readiness. | Tag `source-public-20260511` present. No GitHub Release returned by `gh release list --limit 10`. | Latest observed main CI success: run `26437367093`, workflow `ci`, commit `345a2dda01291865dbce6c1d9b89371dc688bfd6`, `2026-05-26T06:58:41Z`, <https://github.com/jinwon-int/openclaw-plugin-a2a/actions/runs/26437367093>. | `docs/plugin-go-no-go-projection.md` and source-public / no-live proof tests remain fail-closed evidence. They should be cross-linked from current release docs if still authoritative. | `blocker`: missing license metadata and `private: true` before npm release. `gap`: no release artifact or product tag. `risk`: plugin protocol-profile visibility is tracked in plugin#454. |
| [`jinwon-int/a2a-docker-runner`](https://github.com/jinwon-int/a2a-docker-runner) | `PUBLIC`; default branch `main`; latest observed push `2026-05-26T23:49:34Z` | GitHub license detection: MIT. Root `LICENSE` present. `package.json` has `private: false`, package name `@openclaw/a2a-docker-runner`, version `0.1.0`, but no `license` field and no `files` allowlist. This is the closest to npm-public shape but still needs package metadata hardening before publication. | Tag `source-public-20260511` present. No GitHub Release returned by `gh release list --limit 10`. | Latest observed main CI success: run `26481858759`, workflow `ci`, commit `70c8ad078fd9dd4da346189cd4c8cfad480e71cb`, `2026-05-26T23:49:35Z`, <https://github.com/jinwon-int/a2a-docker-runner/actions/runs/26481858759>. Workflow files include `ci.yml` and `release-gate.yml`. | Code search found a private/no-go/source-public hit in `src/scanner.test.ts`; likely test-fixture coverage, not a public-doc blocker by itself. Review before publishing package tarballs. | `blocker`: no explicit npm/image publication approval and package metadata lacks `license`/`files`. `gap`: no GitHub Release; runner Go/Java evidence path tracked in runner#343. |

## Current Split-Repo Interpretation

The four repositories are already public source repositories. The current safe interpretation is:

- `source-public-20260511` marks a source-public snapshot marker across the split repos.
- It is not a semantic version, product release tag, npm package release, Docker/image release, compatibility certification, or operator approval.
- `a2a-plane` is the coordination/docs surface for public-source readiness and split-vs-monorepo tracking under #473.
- `a2a-broker`, `openclaw-plugin-a2a`, and `a2a-docker-runner` still carry independent CI, package metadata, release, and provenance obligations.

## Blockers and Gaps

| ID | Class | Applies to | Finding | Required next step |
|---|---|---|---|---|
| B1 | blocker | all repos | No explicit approval in this audit for tag, GitHub Release, npm publish, Docker/image publish, deploy, restart, DB mutation, live send, terminal ACK/replay, credential movement, or history rewrite. | Keep all publication/live actions blocked until a separate operator approval names the exact repo, version/artifact, command/action, and rollback/no-op boundary. |
| B2 | blocker | `a2a-broker`, `openclaw-plugin-a2a` | No GitHub-detected license and no root `LICENSE` found by contents API. `package.json` also lacks `license`. | Add/confirm approved license files and package license fields before product release or package publication. |
| B3 | blocker | `a2a-broker`, `openclaw-plugin-a2a` | `package.json` has `private: true`. This is safe against accidental npm publish but incompatible with npm release. | Keep as-is for source-public review; change only in a separately approved package-publication PR. |
| B4 | blocker | `a2a-docker-runner` | `package.json` has `private: false` but no `license` field and no `files` allowlist. | Add package-public hardening before npm publication; review package tarball contents with `npm pack --dry-run` in a publication-preflight PR. |
| G1 | gap | all repos | GitHub Release list is empty for the checked repos. | Treat source-public as snapshot-only; create release notes and artifacts only after explicit release approval. |
| G2 | gap | `a2a-plane` | Root package description and historical docs still use private-candidate/private-source language although repos are now public. | Add supersession notes or update current-state docs without deleting historical NO-GO evidence. |
| G3 | gap | all repos | This audit did not produce current external secret-history scanner evidence. | Run supported scanner tooling in an approved environment and record redacted counts/status only. |
| R1 | risk | `a2a-broker` | External A2A SDK/TCK and signed AgentCard trust posture is still being tracked in broker#951/#952. | Do not claim broad official A2A compatibility or signed metadata support until those issues close or docs explicitly defer them. |
| R2 | risk | `openclaw-plugin-a2a` | Plugin-side protocol profile visibility is tracked in plugin#454. | Do not let public docs imply plugin diagnostics cover REST/gRPC/push notification surfaces until implemented or explicitly deferred. |
| R3 | risk | `a2a-docker-runner` | Go/Java evidence support is tracked in runner#343. | Keep default evidence claims scoped to currently supported repo families until runner#343 closes. |

## Sanitized Verification Summary

- GitHub metadata checks confirmed all four repos are `PUBLIC`.
- Tags API confirmed `source-public-20260511` exists in all four repos.
- `gh release list --limit 10` returned no release rows for all four repos.
- Recent GitHub Actions runs for all four repos showed completed successful `ci` runs.
- Package metadata inspection found safe anti-publish settings in broker/plugin (`private: true`), a non-publishable coordination root in plane (`private: true`), and a publishable-shaped runner package that still lacks package metadata hardening.
- Code search found source-public / no-go / private references that appear to be historical/fail-closed docs and tests. This audit records file paths only and does not copy matched secret-like values or raw logs.

## Current Decision

Decision: **source-public audit complete, product release NO-GO / waiting**.

The split repos can be described as public source repositories with a shared `source-public-20260511` marker and recent green CI. They should not be described as released products, approved npm packages, approved Docker images, signed provenance artifacts, or complete public-promotion surfaces until the blockers above are closed and the release checklist is satisfied.
