# A2A Nexus Branch Protection / Ruleset Execution Packet

> **Snapshot date:** 2026-06-10
> **Parent:** [a2a-nexus#553](https://github.com/jinwon-int/a2a-nexus/issues/553)
> **Operator approval record:** [a2a-nexus#563](https://github.com/jinwon-int/a2a-nexus/pull/563), merge `910a796b9540cb839a8fa4a1148aa38a90694eea`
> **A2A review round:** `a2a-branchpacket-20260610T093001Z`
> **Status:** execution packet only; GitHub settings changes are still `NO_GO / Waiting for scoped approval`.

## Summary

The active monorepo target is now `jinwon-int/a2a-nexus`. PR #563 recorded the
operator approval as `GO_CANDIDATE / PR-first`, but execution-sensitive actions
remain separated. This packet replaces the stale `a2a-plane` branch-protection
packet with an `a2a-nexus`-specific branch protection / ruleset execution packet.

Current decision:

```text
branchProtectionDecision = PACKET_READY / Waiting scoped approval
settingsChanged = false
canonicalFlipDecision = GO_CANDIDATE / PR-first; execution separated
```

This packet does **not** apply branch protection, create rulesets, enforce
CODEOWNERS, change permissions, archive/read-only/redirect split repos, publish
releases/packages/images, deploy, restart, mutate DB/Terminal rows, move
credentials, force-push, or rewrite history.

## Live Read-only Posture

Evidence was collected with read-only GitHub CLI/API calls.

- Repository: `jinwon-int/a2a-nexus`
- Branch: `main`
- Current main: `910a796b9540cb839a8fa4a1148aa38a90694eea`
- Open PRs: `0`
- Branch protection API: `404 Branch not protected`
- Repository rulesets API: `[]`
- Latest approval PR CI: [run 27264318468](https://github.com/jinwon-int/a2a-nexus/actions/runs/27264318468), PR #563 head `784c2a7f88d55a568e14424a1798dded2963bd21`, green.

## A2A Review Evidence

Parent round: `a2a-branchpacket-20260610T093001Z`.

Team1:

- `sogyo`: blocked the stale packet because it still cited `a2a-plane`; required an `a2a-nexus`-specific packet and CI/job inventory.
- `nosuk`: confirmed the packet should remain no-live, but requested explicit rollback owner/path and `a2a-nexus` CI mapping.
- `bangtong`: confirmed `a2a-nexus/main` is unprotected and needs a packet; settings stay HOLD until scoped approval.

Team2:

- `dungae`: confirmed import-needed for an `a2a-nexus`-specific packet; stale `a2a-plane` refs must be replaced.
- `jingun`: confirmed split repo disposition, release, publish, and deploy remain HOLD and must not be changed by this packet.
- `soonwook`: validated GO/NO-GO and rollback fields; emphasized no settings mutation and fresh scoped approval before enforcement.

## CI Job Inventory

The `a2a-nexus` workflow `.github/workflows/ci.yml` defines these jobs:

- `paths-filter`
- `setup`
- `layout`
- `broker`
- `docker-runner`
- `plugin`
- `contracts`
- `docs`
- `check`

Path filters:

- `broker`: `packages/broker/**`
- `docker-runner`: `packages/docker-runner/**`
- `plugin`: `packages/openclaw-plugin-a2a/**`
- `contracts`: `contracts/**`, `fixtures/**`
- `docs`: `docs/**`
- `scripts`: `scripts/**`, `scanner/**`
- `root`: `package.json`, `package-lock.json`, `.github/workflows/**`, `.gitleaks.toml`

## Required-check Candidate

A future scoped approval should name the exact checks and how path-aware skipped
jobs are handled.

Always required:

- `paths-filter`
- `setup`
- `layout`
- `contracts`
- `check`

Path-aware package checks:

- `broker`: required when `packages/broker/**`, `contracts/**`, root files, or broker parity scripts are touched.
- `docker-runner`: required when `packages/docker-runner/**`, root files, or docker-runner parity scripts are touched.
- `plugin`: required when `packages/openclaw-plugin-a2a/**`, `contracts/**`, root files, plugin manifests, or plugin package metadata are touched.

The `docs` job may remain path-filtered for docs-only changes. Skipped package
jobs must not be treated as proof that an untouched package stayed fresh;
`paths-filter` must make the skip reason explicit.

## Split-repo Disposition Boundary

This branch protection packet does not settle split-repo disposition. The
historical split-repo disposition and rollback-owner packet remains referenced
at `a2a-plane#545`, and the active `a2a-nexus#553` lane carries the current
`a2a-nexus` refresh through
[`docs/monorepo-split-repo-disposition-rollback.md`](monorepo-split-repo-disposition-rollback.md).
No split repo is archived, made read-only, redirected, renamed, or treated as
non-canonical by this packet.

## Final Sign-off Boundary

The prior final operator sign-off matrix remains referenced at `a2a-plane#549`.
This `a2a-nexus` branch protection packet only prepares the branch
protection/ruleset execution evidence; it does not grant final canonical flip,
release, package ownership transfer, split-repo disposition, or live execution
approval.

## Proposed Settings Shape For Later Approval

Recommended ruleset name: `a2a-nexus-main-required-checks`.

Recommended values for a later settings-only execution:

- target repository: `jinwon-int/a2a-nexus`
- target branch: `main`
- require PR before merge
- require at least one approving review
- dismiss stale approvals after new commits
- require up-to-date branch or merge queue if it does not break auto-merge
- include administrators unless the operator explicitly exempts them
- defer CODEOWNERS review until package ownership transfer is explicitly accepted
- protect critical paths: `.github/workflows/**`, `scripts/**`, `packages/**`, `contracts/**`, `fixtures/**`, `scanner/**`

## Evaluation / Enforcement Phases

1. **Packet PR phase** — this PR only records the plan, checks, rollback path,
   and abort conditions.
2. **Scoped approval phase** — operator must approve the settings mutation in a
   separate message or PR/issue comment that names the repo, branch, required
   checks, review/admin policy, and rollback owner.
3. **Evaluate-only phase** — prepare JSON/API payload and read back current state;
   do not enforce if any required check name is absent or path-aware behavior is
   ambiguous.
4. **Enforce phase** — apply settings only after the scoped approval and dry-run
   readback are clean.
5. **Readback phase** — verify the ruleset/protection exists and that a normal PR
   remains mergeable when checks are green.

## Rollback / No-op Path

Rollback owner: `seoseo finalizer` performs settings-only rollback after Seo Jin
On approval; the operator retains operator decision authority.

Allowed rollback: delete or disable only the created `a2a-nexus/main` ruleset or
branch protection.

Rollback must not include source history rewrite, force-push, package
publication, split repo archive/read-only/redirect, canonical ownership transfer,
release/tag creation, deploy/restart, DB/Terminal ACK, provider send, credential
movement, or destructive cleanup.

## Abort Conditions

Abort before settings mutation if any of these are true:

- target branch is no longer `910a796b9540cb839a8fa4a1148aa38a90694eea` or is not explicitly re-approved;
- a required check name is absent from GitHub status-check rollups;
- a dry-run would block clean docs-only or package-scoped PRs unexpectedly;
- rollback owner is unavailable;
- approval is ambiguous or bundled with release, deploy, DB, credential, provider send, Terminal ACK, force-push, or split repo disposition work.

## GO / NO-GO Fields

- `latestMonorepoCiGreen`: `true`
- `branchProtectionCurrentlyAbsent`: `true`
- `rulesetsCurrentlyAbsent`: `true`
- `requiredCheckCandidateRecorded`: `true`
- `executionPacketRecorded`: `true`
- `operatorBranchProtectionApproval`: `false`
- `settingsChanged`: `false`
- `canonicalFlipApproved`: `false`
- `decision`: `PACKET_READY / Waiting scoped approval`

## No-live Boundary

This packet does not authorize branch protection application, ruleset
application, permission changes, CODEOWNERS enforcement changes, canonical flip,
package ownership transfer, release tags, GitHub Releases, npm or Docker/GHCR
publication, repository visibility changes, split repo archive/read-only/redirect,
production deploys, Gateway/broker/worker restarts, database mutation, provider
or Telegram sends, Terminal ACK/replay, historical replay, credential movement,
destructive cleanup, force-push, history rewrite, or worker-owned GitHub
mutation.
