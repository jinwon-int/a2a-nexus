# A2A Nexus Split-repo Disposition And Rollback Owner Packet

> **Snapshot date:** 2026-06-10
> **Parent:** [a2a-nexus#553](https://github.com/jinwon-int/a2a-nexus/issues/553)
> **Operator approval record:** [a2a-nexus#563](https://github.com/jinwon-int/a2a-nexus/pull/563), merge `910a796b9540cb839a8fa4a1148aa38a90694eea`
> **Branch protection / ruleset packet:** [a2a-nexus#564](https://github.com/jinwon-int/a2a-nexus/pull/564), ruleset `17499616 / a2a-nexus-main-required-checks`
> **A2A review round:** `a2a-splitdisposition-20260610T110759Z`
> **Status:** disposition/rollback packet only; split repos stay `active_canonical` and all archive/read-only/redirect actions remain `NO_GO / Waiting for scoped approval`.

## Summary

`jinwon-int/a2a-nexus` is now the active monorepo planning target. Branch
protection is enforced through repository ruleset `a2a-nexus-main-required-checks`,
but that does not transfer implementation ownership or settle split-repo
provenance. This packet updates the historical `a2a-plane` split-repo packet into
an `a2a-nexus`-specific disposition and rollback-owner packet.

Current decision:

```text
splitRepoDispositionDecision = NO_GO / Waiting
rollbackOwnerDecision = NO_GO / Waiting
canonicalFlipDecision = GO_CANDIDATE / PR-first; execution separated
settingsChanged = ruleset only; split repos unchanged
```

No split repository is archived, made read-only, redirected, renamed, hidden, or
treated as non-canonical by this packet.

## Current Source Lineage

| Surface | Split repo | Monorepo target | Current disposition | Candidate next posture |
| --- | --- | --- | --- | --- |
| Broker | `jinwon-int/a2a-broker` | `packages/broker` | `active_canonical` | keep `active_canonical`; consider `active_mirrored` only after owner/cadence approval |
| Docker runner | `jinwon-int/a2a-docker-runner` | `packages/docker-runner` | `active_canonical` | keep `active_canonical`; consider `active_mirrored` only after owner/cadence approval |
| OpenClaw plugin | `jinwon-int/plugin-a2a` (`openclaw-plugin-a2a` legacy alias) | `packages/openclaw-plugin-a2a` | `active_canonical` | keep `active_canonical`; consider `active_mirrored` only after owner/cadence approval |

The tracked-tree import lineage remains evidence only. It is not
history-preserving and does not replace split repo issue/PR/tag provenance.

## A2A Review Evidence

Parent round: `a2a-splitdisposition-20260610T110759Z`.

Team1 / Seoseo:

- `sogyo`: active_canonical is the only safe current posture; if forced,
  active_mirrored is less risky than read_only_archive, but still not approved.
- `nosuk`: rollback owner fields and abort conditions must be explicit before
  any read-only/archive/redirect setting.
- `bangtong`: live-safety boundary must keep archive/read-only/redirect,
  release/package/tag, canonical flip, DB/Terminal ACK, credentials, deploy, and
  force-push on HOLD.

Team2 / Gwakga:

- `dungae`: active_canonical remains safest; active_mirrored and ownership
  transfer are NO-GO while provenance and rollback risks remain unresolved.
- `jingun`: all three split repos should keep active_canonical; communication,
  provenance, and rollback owner gaps need packet coverage.
- `soonwook`: GO/NO-GO fields are appropriately conservative; watch plugin alias
  duplication and keep release/package/tag/package ownership separated.

Worker summaries:

- `seoseo/sogyo`: analysis bridge done: split-disposition 문서는 active_canonical 기본 상태를 유지하고 있으며 어떤 disposition 변경도 승인되지 않음. 모든 차단 조건(롤백 소유자 미할당, 브랜치 보호 미적용, 릴리스 게이트 미통과)이 해소되지 않아 active_mirrored나 read_only_archive 모두 조기 적용 위험. active_mirrored는 분할 저장소를 계속 활성 상태로 유지해 작업 연속성을 보장하지만 운용 복잡성 증가. read_only_archive는 정식 전환 전에 유일한 실구현 저장소를 동결시켜 긴급 패치 경로를 차단하므로 더 위험. 다음 패킷으로는 둘 다 승인하지…
- `seoseo/nosuk`: analysis bridge done: a2a-nexus 분할 저장소(disposition) 및 롤백 소유자 패킷 분석: 현재 모든 결정은 NO_GO/Waiting 상태이며, 롤백 소유자 필드는 정의되었으나 할당되지 않았습니다. 분할 저장소는 active_canonical 상태를 유지하고 있고, archive/read-only/redirect 승인은 없습니다. 브랜치 보호 패킷은 준비되었지만 실제 설정 변경은 보류 중입니다.
- `seoseo/bangtong`: analysis bridge done: 증거 묶음에 포함된 a2a-nexus 분할 레포지션 처리/롤백 소유자 패킷 문서를 분석했습니다. 이 패킷은 분할 레포지션 결정과 롤백 소유자 할당을 기록하기 위한 문서용 게이트로, 아직 어떤 변경도 승인하지 않습니다. 실시간 안전 경계는 분할 레포지션의 보존 상태(archive/read-only/redirect 금지), 브랜치 보호 및 규칙셋 적용 금지, 릴리스/패키지/태그 발행 금지, 캐노니컬 플립 금지, 그리고 롤백 소유자 미할당 상태를 유지하는 것입니다. 모든 'HOLD' 항목은 명시적으로 문서화되어 있으며, 추후 단계에서 운영자 승인이 필요합니다.
- `gwakga/dungae`: analysis bridge done: Team2(dungae) 관점에서 평가한 split repo disposition: 현재 active_canonical이 유일하게 안전한 상태이며, active_mirrored 및 ownership transfer는 4개의 해결되지 않은 리스크로 인해 NO_GO. tracked-tree import는 history-preserving이 아니므로 ownership transfer 시 git 계보가 단절됨. 모든 split repo는 active_canonical 유지, rollback owner는 미지정 상태 유지 권고.
- `gwakga/jingun`: analysis bridge done: a2a-nexus 분할 저장소 처리(disposition) 현황 분석 결과: 3개 분할 저장소(a2a-broker, a2a-docker-runner, plugin-a2a) 모두 active_canonical 기본 상태 유지 중, 모든 주요 결정(NO_GO/Waiting)은 보류 상태. 롤백 소유자 미지정, 정식 전환(canonical flip) 차단, 출처(provenance) 분산, 증거 품질 이슈 존재. 총 4개 위험 항목과 7개 권장사항 도출.
- `gwakga/soonwook`: analysis bridge done: a2a-nexus 분할 저장소 처분(disposition) 및 롤백 소유자 패킷에 대한 source-only 검증 완료. 현재 모든 GO/NO-GO 필드는 일관되게 NO_GO/Waiting으로 설정되어 있으며, 이는 적절한 보수적 자세다. 다만 main 브랜치 CI 실패(자동병합 워크플로우), 브랜치 보호 미적용, 롤백 소유자 미지정, plugin-a2a 중복 등재 등 4건의 주목할 만한 이슈가 확인되었다. 증거는 충분히 구조화되어 있고 판독 가능하다.

## Disposition Options

No option other than the current state is approved by this packet.

| Option | Meaning | Current status | Approval required before use |
| --- | --- | --- | --- |
| `active_canonical` | Split repo remains the implementation source and provenance store. | Active default for all split repos. | None; current state. |
| `active_mirrored` | Split repo remains active while changes are mirrored into `a2a-nexus/packages/*` by PR. | Candidate only. | Explicit owner, cadence, conflict policy, and rollback owner approval. |
| `read_only_archive` | Split repo stops accepting implementation changes but remains visible for provenance. | HOLD / not approved. | Repo-by-repo settings approval, communication plan, and emergency hotfix fallback. |
| `archived_redirect` | Split repo is archived or redirected to `a2a-nexus`. | HOLD / not approved. | Repo-by-repo archive/redirect approval, rollback plan, and user/provenance notice. |

Finalizer synthesis for this packet: keep `active_canonical` for broker,
docker-runner, and plugin split repos. Record `active_mirrored` as the least risky
future transition candidate, but do not execute it here.

## Rollback Owner Fields

Rollback must be assigned before any ownership transfer or split-repo settings
change.

| Scenario | Required owner field | Current status |
| --- | --- | --- |
| Before canonical flip | Revert or follow-up PR owner for `a2a-nexus/packages/*` candidate regressions. | `seoseo finalizer` owns PR-first revert/follow-up documentation; split repos stay canonical. |
| Active mirrored conflict | Owner for resolving split repo vs monorepo mirror conflicts and deciding winning source. | Not assigned; active_mirrored remains candidate only. |
| After canonical flip | Owner for reverting `a2a-nexus/packages/*` and deciding whether split repo hotfixes resume. | Not assigned; canonical flip remains blocked. |
| Misapplied split repo disposition | Owner responsible for undoing read-only/archive/redirect settings. | Not assigned; no settings change allowed. |
| Release/package regression | Owner for tag deletion policy, GitHub Release yank, npm deprecate/unpublish policy, Docker/GHCR rollback tag. | Not assigned and release/package/tag remains blocked. |

## Accepted-risk Register

These risks are recorded, not fully accepted for execution:

| Risk | Current posture |
| --- | --- |
| Tracked-tree import is not history-preserving. | Accepted for candidate evidence only; not accepted for ownership transfer. |
| Closed split-repo issues/PRs/tags remain outside `a2a-nexus`. | Keep split repos as active provenance stores. |
| Branch protection/ruleset now exists on `a2a-nexus/main`. | Risk reduced by ruleset `17499616`, but it does not approve disposition. |
| Split repo disposition is undecided. | Options recorded; current state remains active_canonical. |
| Post-flip rollback owner is unassigned. | Canonical flip remains blocked. |
| Release/package/tag policy execution is unapproved. | Publication remains blocked and separate. |
| Plugin repo naming has alias drift. | Use `jinwon-int/plugin-a2a` as current repo, `openclaw-plugin-a2a` as legacy alias/path context. |

## Required Follow-up Before Execution

A future execution approval must be separate and must name:

- repo-by-repo target disposition;
- operator owner and rollback owner;
- communication/notice plan for users and existing issue/PR provenance;
- conflict policy for split repo vs monorepo package changes;
- emergency hotfix fallback if a split repo becomes read-only or archived;
- exact settings/API action and rollback command;
- accepted risks and abort conditions.

Generic approval, green CI, or the existence of branch protection is not split
repo disposition approval.

## Release/package/tag Boundary

Historical `a2a-plane#547` remains the release/package/tag approval packet for
this lineage. The active `a2a-nexus#553` refresh does not create release tags,
GitHub Releases, npm packages, Docker/GHCR images, package ownership changes, or
canonical flip. Release/package/tag execution remains `NO_GO / Waiting` and must
be handled by a separate scoped approval packet.

## Final sign-off Boundary

Historical `a2a-plane#549` remains the final operator sign-off matrix for this
lineage. This `a2a-nexus#553` split disposition refresh feeds that matrix with
current `a2a-nexus` evidence only; it does not grant final canonical flip,
package ownership transfer, release/package/tag, split-repo disposition, or live
execution approval.

## GO / NO-GO Fields

| Field | Value |
| --- | --- |
| `splitReposRemainCanonical` | `true` |
| `a2aNexusRulesetApplied` | `true` |
| `dispositionOptionsRecorded` | `true` |
| `rollbackOwnerFieldsRecorded` | `true` |
| `acceptedRiskRegisterRecorded` | `true` |
| `splitRepoDispositionApproved` | `false` |
| `activeMirroredApproved` | `false` |
| `readOnlyArchiveApproved` | `false` |
| `archivedRedirectApproved` | `false` |
| `postFlipRollbackOwnerAssigned` | `false` |
| `packageOwnershipTransferred` | `false` |
| `canonicalFlipApproved` | `false` |
| `decision` | `NO_GO / Waiting; active_canonical remains current state` |

## No-live Boundary

This packet does not authorize split repo archive/read-only/redirect changes,
permission changes, CODEOWNERS enforcement changes, canonical flip, package
ownership transfer, release tags, GitHub Releases, npm or Docker/GHCR
publication, repository visibility changes, production deploys,
Gateway/broker/worker restarts, database mutation, provider or Telegram sends,
Terminal ACK/replay, historical replay, credential movement, destructive
cleanup, force-push, history rewrite, or worker-owned GitHub mutation.
