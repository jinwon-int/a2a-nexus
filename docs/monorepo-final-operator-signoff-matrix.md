# A2A Monorepo Final Operator Sign-off Matrix

> **Snapshot date:** 2026-06-08
> **Parent:** [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511)
> **Phase-6 branch protection packet:** [a2a-plane#544](https://github.com/jinwon-int/a2a-plane/pull/544)
> **Phase-7 split-repo disposition packet:** [a2a-plane#546](https://github.com/jinwon-int/a2a-plane/pull/546)
> **Phase-8 release/package/tag packet:** [a2a-plane#548](https://github.com/jinwon-int/a2a-plane/pull/548)
> **Phase-9 final sign-off issue:** [a2a-plane#549](https://github.com/jinwon-int/a2a-plane/issues/549)
> **Phase-10 operator handoff issue:** [a2a-plane#551](https://github.com/jinwon-int/a2a-plane/issues/551)
> **Status:** final operator matrix only; canonical flip, package ownership transfer, release, tag, publish, settings changes, and split-repo disposition execution remain `NO_GO / Waiting`.

## Summary

The monorepo now has tracked-tree package candidates, package CI parity jobs,
branch protection approval fields, split-repo disposition options, rollback
owner fields, and release/package/tag approval fields. This matrix consolidates
those packets into the final operator sign-off checklist that must be answered
before any canonical flip or execution-sensitive action.

Current decision:

```text
operatorFinalDecision = NO_GO / Waiting
canonicalFlipDecision = NO_GO / Waiting
packageOwnershipDecision = NO_GO / Waiting
releasePackageTagDecision = NO_GO / Waiting
branchProtectionDecision = NO_GO / Waiting
splitRepoDispositionDecision = NO_GO / Waiting
rollbackOwnerDecision = NO_GO / Waiting
```

## Prior Packet Evidence

| Gate | Evidence | Current posture |
| --- | --- | --- |
| Package candidate import | `a2a-plane#540` merged `31273ce05b7e53655e3d8847a8d77ff1cd2f6d05`. | Package CI green; not canonical. |
| Canonical flip readiness | `a2a-plane#542` merged `3a0f1abc6da4a16b3b6ea5a0a56e19d541082e4d`. | Readiness packet recorded; operator approval missing. |
| Branch protection approval | `a2a-plane#544` merged `ff4390a3fbcb0f7fb85235c78eb3facc4a667495`. | Settings not applied; approval fields pending. |
| Split-repo disposition and rollback | `a2a-plane#546` merged `03cb496a145c130186f6d08a3fd9fd12dc04ef31`. | Split repos remain canonical; post-flip rollback owner missing. |
| Release/package/tag approval | `a2a-plane#548` merged `7aefab9f870ccc5ed7ecfff8bcfaf6554f6b22e6`. | Release, tag, npm, Docker/GHCR, and package ownership execution all blocked. |

## Final Sign-off Matrix

No row is approved by this matrix.

| Area | Required owner/evidence before GO | Current status |
| --- | --- | --- |
| Branch protection or ruleset | Operator owner, exact repository/branch/ruleset target, required checks, review count, CODEOWNERS choice, admin coverage, settings rollback owner. | `NO_GO / Waiting` |
| Split repo disposition | Operator owner, repo-by-repo option, communication plan, undo owner for read-only/archive/redirect settings. | `NO_GO / Waiting` |
| Release tag and GitHub Release | Operator owner, tag name, target commit, signing policy, release repository, release mode, artifact list, rollback/yank policy. | `NO_GO / Waiting` |
| npm publish | Operator owner, package names, versions, registry, access, dist-tag, provenance flag, registry account custodian, and package withdrawal or deprecation rollback plan. | `NO_GO / Waiting` |
| Docker/GHCR publish | Operator owner, image names, registries, tags, build contexts, provenance/SBOM policy, rollback tag policy. | `NO_GO / Waiting` |
| Package ownership transfer | Operator owner, canonical implementation source, package owner, split repo conflict policy, issue/PR provenance policy. | `NO_GO / Waiting` |
| Canonical flip | Operator owner, accepted-risk register, final green CI evidence, branch protection posture, rollback owner, abort conditions. | `NO_GO / Waiting` |

## Abort Conditions

Any of these conditions keeps the final matrix at `NO_GO / Waiting`:

- no named operator owner for the action;
- no rollback owner for the action;
- missing exact target repository, branch, package, image, tag, or release;
- missing latest CI evidence for the tree being accepted;
- branch protection or ruleset posture not explicitly accepted;
- split repo disposition not explicitly accepted;
- package ownership transfer not explicitly accepted;
- release/package/tag approval not explicitly accepted;
- any live deploy, restart, DB mutation, provider send, Terminal ACK/replay,
  credential movement, visibility change, force-push, or history rewrite is
  bundled with the canonical flip approval.

## GO / NO-GO Fields

| Field | Value |
| --- | --- |
| `priorPacketsRecorded` | `true` |
| `branchProtectionApprovalReady` | `false` |
| `splitRepoDispositionApproved` | `false` |
| `releasePackageTagApproved` | `false` |
| `packageOwnershipTransferApproved` | `false` |
| `rollbackOwnerAssigned` | `false` |
| `canonicalFlipApproved` | `false` |
| `operatorFinalApproval` | `false` |
| `decision` | `NO_GO / Waiting` |

## Required Follow-up Before Execution

A future execution packet must name the human operator owner, exact execution
surface, target SHA/tag/package/image/release, latest green CI run, rollback
owner, abort conditions, and accepted risks. It must be separate from this
source-only matrix.

Follow-up `a2a-plane#551` records the operator approval handoff packet. It is
still source-only and leaves the operator response `UNANSWERED` with every
execution-sensitive action at `NO_GO / Waiting`.

## No-live Boundary

This matrix does not authorize canonical flip, package ownership transfer,
branch protection or ruleset changes, permission changes, CODEOWNERS
enforcement changes, split repo archive/read-only/redirect changes, release
tag creation or movement, GitHub Release creation, npm publication, Docker or
GHCR publication, repository visibility changes, production deploys,
Gateway/broker/worker restarts, database mutation, provider or Telegram sends,
Terminal ACK/replay, historical replay, credential movement, destructive
cleanup, force-push, history rewrite, or worker-owned GitHub mutation.
