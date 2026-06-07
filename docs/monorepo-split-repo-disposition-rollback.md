# A2A Monorepo Split-repo Disposition And Rollback Owner Packet

> **Snapshot date:** 2026-06-08
> **Parent:** [a2a-plane#511](https://github.com/jinwon-int/a2a-plane/issues/511)
> **Phase-4 import candidate:** [a2a-plane#540](https://github.com/jinwon-int/a2a-plane/pull/540)
> **Phase-5 readiness gate:** [a2a-plane#542](https://github.com/jinwon-int/a2a-plane/pull/542)
> **Phase-6 branch protection packet:** [a2a-plane#544](https://github.com/jinwon-int/a2a-plane/pull/544)
> **Phase-7 disposition packet:** [a2a-plane#545](https://github.com/jinwon-int/a2a-plane/issues/545)
> **Phase-8 release/package/tag packet:** [a2a-plane#547](https://github.com/jinwon-int/a2a-plane/issues/547)
> **Status:** disposition packet only; split repos stay canonical and canonical flip is still `NO_GO / Waiting`.

## Summary

The `packages/*` candidate in `a2a-plane` is current enough for CI rehearsal,
but it is not an ownership transfer. Before a future canonical flip, the
operator must decide what happens to each split implementation repository and
who owns rollback after the flip.

Current decision:

```text
splitRepoDispositionDecision = NO_GO / Waiting
rollbackOwnerDecision = NO_GO / Waiting
canonicalFlipDecision = NO_GO / Waiting
```

## Current Source Lineage

| Surface | Split repo | Imported source ref | Plane target | Current disposition |
| --- | --- | --- | --- | --- |
| Broker | `jinwon-int/a2a-broker` | `f9f4af5a76649a37b8a3d492805b6e5f410683a6` | `packages/broker` | Active canonical source/provenance repo |
| Docker runner | `jinwon-int/a2a-docker-runner` | `269a0ef90737158b41f8da26241b9f7f4b14af5e` | `packages/docker-runner` | Active canonical source/provenance repo |
| OpenClaw plugin | `jinwon-int/openclaw-plugin-a2a` | `a2e521271483ef0b6a29907c8228f0a442dd2db9` | `packages/openclaw-plugin-a2a` | Active canonical source/provenance repo |

`a2a-plane#540` merged the tracked-tree package candidate as
`31273ce05b7e53655e3d8847a8d77ff1cd2f6d05`. `a2a-plane#542` merged the
canonical-flip readiness gate as
`3a0f1abc6da4a16b3b6ea5a0a56e19d541082e4d`. `a2a-plane#544` merged the
branch protection approval packet as
`ff4390a3fbcb0f7fb85235c78eb3facc4a667495`.

## Disposition Options

No option is approved by this packet.

| Option | Meaning | Approval needed before use |
| --- | --- | --- |
| `active_canonical` | Split repo remains the implementation source; `a2a-plane/packages/*` is a candidate mirror only. | None; this is the current default. |
| `active_mirrored` | Split repo remains active, while package changes are mirrored into `a2a-plane` through PRs. | Operator approval for mirroring owner, cadence, and conflict handling. |
| `read_only_archive` | Split repo accepts no new implementation changes but stays available for issues/PR provenance. | Explicit repo-by-repo settings approval and communication plan. |
| `archived_redirect` | Split repo is archived or redirected to `a2a-plane`. | Explicit repo-by-repo archive/redirect approval plus rollback path. |

The default remains `active_canonical` for all three split repos until a future
operator decision names a different option.

## Rollback Owner Fields

Rollback must be decided before any ownership transfer.

| Scenario | Required owner field | Current status |
| --- | --- | --- |
| Before canonical flip | Revert or follow-up PR owner for `a2a-plane` package candidate regressions. | Recorded as normal PR revert path; split repos stay canonical. |
| After canonical flip | Owner responsible for reverting `a2a-plane/packages/*` and deciding whether split repo hotfixes resume. | Not assigned. |
| Misapplied split repo disposition | Owner responsible for undoing read-only/archive/redirect settings. | Not assigned. |
| Release/package regression | Owner responsible for release/tag/npm/Docker rollback. | Not assigned and still release-gated. |

## Accepted-risk Register

These risks must be explicitly accepted or resolved before canonical flip:

| Risk | Current posture |
| --- | --- |
| Import is tracked-tree archive, not history-preserving. | Accepted only for candidate evidence; not accepted for ownership transfer. |
| Closed split-repo issues/PRs remain in split repos. | Keep split repos as provenance stores. |
| `a2a-plane/main` branch protection/ruleset settings are not applied. | Approval packet exists; execution not approved. |
| Split repo disposition is undecided. | This packet records options only. |
| Post-flip rollback owner is unassigned. | Canonical flip remains blocked. |
| Release/package/tag policy execution is unapproved. | Publication remains blocked and is carried forward into `a2a-plane#547`. |

## Release/package/tag Follow-up

`a2a-plane#547` records the phase-8 release/package/tag approval packet. It is
the next source-only gate after this disposition packet and does not approve
release tags, GitHub Releases, npm publication, Docker/GHCR publication,
package ownership transfer, or canonical flip.

## GO / NO-GO Fields

| Field | Value |
| --- | --- |
| `splitReposRemainCanonical` | `true` |
| `dispositionOptionsRecorded` | `true` |
| `rollbackOwnerFieldsRecorded` | `true` |
| `acceptedRiskRegisterRecorded` | `true` |
| `splitRepoDispositionApproved` | `false` |
| `postFlipRollbackOwnerAssigned` | `false` |
| `canonicalFlipApproved` | `false` |
| `decision` | `NO_GO / Waiting` |

## No-live Boundary

This packet does not authorize split repo archive/read-only/redirect changes,
branch protection application, ruleset application, permission changes,
CODEOWNERS enforcement changes, canonical flip, package ownership transfer,
release tags, GitHub Releases, npm or Docker publication, repository
visibility changes, production deploys, Gateway/broker/worker restarts,
database mutation, provider or Telegram sends, Terminal ACK/replay, historical
replay, credential movement, destructive cleanup, force-push, history rewrite,
or worker-owned GitHub mutation.
