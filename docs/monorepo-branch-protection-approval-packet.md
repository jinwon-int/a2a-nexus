# A2A Monorepo Branch Protection Approval Packet

> **Snapshot date:** 2026-06-08
> **Parent:** [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511)
> **Phase-5 readiness gate:** [a2a-plane#541](https://github.com/jinwon-int/a2a-plane/issues/541)
> **Phase-5 PR:** [a2a-plane#542](https://github.com/jinwon-int/a2a-plane/pull/542)
> **Phase-6 approval packet:** [a2a-plane#543](https://github.com/jinwon-int/a2a-plane/issues/543)
> **Phase-7 disposition packet:** [a2a-plane#545](https://github.com/jinwon-int/a2a-plane/issues/545)
> **Status:** approval packet only; GitHub settings changes are still `NO_GO / Waiting`.

## Summary

The imported `packages/*` candidate is package-CI green, and the phase-5
canonical-flip readiness packet is merged. The next canonical-flip blocker is
not source code: it is the operator decision for `a2a-plane/main` branch
protection or ruleset coverage.

Current decision:

```text
branchProtectionDecision = NO_GO / Waiting
settingsChanged = false
canonicalFlipDecision = NO_GO / Waiting
```

This packet records the exact read-only state and the required-check proposal a
future operator approval can act on. It does not apply branch protection,
rulesets, permissions, CODEOWNERS enforcement, canonical ownership transfer, or
any release action.

## Live Read-only Posture

Evidence was collected on 2026-06-08 KST with read-only GitHub CLI/API calls.

| Surface | Current evidence | Meaning |
| --- | --- | --- |
| `jinwon-int/a2a-plane/main` branch protection | `GET /branches/main/protection` returned `404 Branch not protected` | No protected `main` baseline is currently active. |
| `jinwon-int/a2a-plane` rulesets | `GET /repos/jinwon-int/a2a-plane/rulesets` returned `[]` | No repository ruleset is currently active. |
| Latest green monorepo CI | PR `#542`, run `27099569029`, head `71fb92a4bede59f76c4599867f19843ced162b6e` | Root and package gates are green after the phase-5 readiness packet. |

## Required-check Candidate

A future branch protection/ruleset approval should name the exact checks and
how skipped path-aware jobs are handled. The minimum candidate is:

| Check | Requirement |
| --- | --- |
| `paths-filter` | Required for all PRs so package/doc/root path decisions are visible. |
| `setup` | Required for all PRs. |
| `layout` | Required for repo layout and package map changes. |
| `contracts` | Required for contract and conformance-relevant changes. |
| `check` | Required for root release gate, scanner, conformance, and monorepo packet validators. |
| `broker` | Required when `packages/broker/**`, broker-owned package metadata, or broker package parity scripts are touched. |
| `docker-runner` | Required when `packages/docker-runner/**`, runner-owned package metadata, or runner package parity scripts are touched. |
| `plugin` | Required when `packages/openclaw-plugin-a2a/**`, plugin-owned metadata, or plugin package parity scripts are touched. |

The `docs` job may remain path-filtered and skipped when no docs-only check is
needed. Skipped package jobs must not be treated as proof that an untouched
package stayed fresh; `paths-filter` must make the skip reason explicit.

## Review And Ruleset Decisions Still Needed

These fields are not approved by this packet:

| Field | Proposed default | Current status |
| --- | --- | --- |
| Protected `main` | Require PRs for source changes, no direct canonical changes to `main`. | Not applied. |
| Required PR review | At least one approving review before merge. | Not applied. |
| CODEOWNERS review | Enforce after package ownership is explicitly accepted, not before. | Not applied. |
| Up-to-date branch or merge queue | Require up-to-date branches or an equivalent merge queue/ruleset. | Not applied. |
| Stale review dismissal | Dismiss stale approvals after new commits. | Not applied. |
| Admin coverage | Operator must decide explicitly; safer canonical-flip default is to include admins. | Not applied. |
| Critical path rulesets | Protect `.github/workflows/**`, `scripts/**`, `packages/**`, `contracts/**`, `fixtures/**`, and `scanner/**`. | Not applied. |

## Approval Text Shape

A valid future approval must be explicit and separate from canonical flip,
release, deploy, provider send, or credential work. It should name:

- repository: `jinwon-int/a2a-plane`;
- branch or ruleset target: `main` and any critical-path patterns;
- required checks and package path behavior;
- PR review count and whether CODEOWNERS is enforced;
- stale-review, up-to-date branch, merge queue, and admin coverage choices;
- rollback/no-op path if the settings change is declined or misapplied.

Generic phrases such as "continue", "looks good", or green CI are not branch
protection approval.

Follow-up `a2a-plane#545` records the split-repo disposition and rollback owner
packet required before a canonical flip. This branch protection packet does not
settle split-repo disposition.

## Rollback / No-op Path

If the operator declines settings changes, no source rollback is required.
Split repos remain canonical implementation/provenance sources, and
`a2a-plane/packages/*` stays a CI-green candidate only.

If a future approved settings change is misapplied, the rollback must be a
settings-only change scoped to the approved repository and branch/ruleset. It
must not include source history rewrite, force-push, package publication,
split-repo archival, or canonical ownership transfer.

## GO / NO-GO Fields

| Field | Value |
| --- | --- |
| `latestMonorepoCiGreen` | `true` |
| `branchProtectionCurrentlyAbsent` | `true` |
| `rulesetsCurrentlyAbsent` | `true` |
| `requiredCheckCandidateRecorded` | `true` |
| `operatorBranchProtectionApproval` | `false` |
| `settingsChanged` | `false` |
| `canonicalFlipApproved` | `false` |
| `decision` | `NO_GO / Waiting` |

## No-live Boundary

This packet does not authorize branch protection application, ruleset
application, permission changes, CODEOWNERS enforcement changes, canonical
flip, package ownership transfer, release tags, GitHub Releases, npm or Docker
publication, repository visibility changes, split repo archival, production
deploys, Gateway/broker/worker restarts, database mutation, provider or
Telegram sends, Terminal ACK/replay, historical replay, credential movement,
destructive cleanup, force-push, history rewrite, or worker-owned GitHub
mutation.
