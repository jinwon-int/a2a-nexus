# A2A Nexus Final Operator Sign-off / Canonical Source Packet

> **Snapshot date:** 2026-06-10
> **Active parent:** [a2a-nexus#553](https://github.com/jinwon-int/a2a-nexus/issues/553)
> **Historical parent:** a2a-plane#511 (a2a-plane#511, internal tracker private)
> **Historical final sign-off issue:** a2a-plane#549 (a2a-plane#549, internal tracker private)
> **Historical operator handoff issue:** a2a-plane#551 (a2a-plane#551, internal tracker private)
> **Latest active packet:** [a2a-nexus#566](https://github.com/jinwon-int/a2a-nexus/pull/566), merge `bf36a68ab8a38c0fbea0710d979c165d4f9b07f9`
> **Status:** final source-only packet; canonical source declaration is `GO_CANDIDATE / PR-first`, while canonical flip execution, package ownership transfer, release, publish, deploy, DB, credential, Terminal ACK/replay, and split-repo archive/read-only/redirect actions remain `NO_GO / Execution separate`.

## Summary

`a2a-nexus` has now accumulated the source-only evidence needed to prepare a
final operator sign-off / canonical source declaration packet:

- current-state drift closeout and selective PR lane completed;
- branch protection/ruleset packet merged and the `a2a-nexus-main-required-checks`
  ruleset is active on `main`;
- split-repo disposition / rollback-owner packet merged, keeping split repos at
  `active_canonical` and treating `active_mirrored` as candidate-only;
- release/package/tag packet remains separate and unexecuted;
- the latest main commit is `bf36a68ab8a38c0fbea0710d979c165d4f9b07f9`.

Current decision:

```text
operatorFinalDecision = GO_CANDIDATE / PR-first / source-only
canonicalSourceDecision = GO_CANDIDATE / PR-first source declaration
canonicalFlipExecution = NO_GO / Execution separate
packageOwnershipTransfer = NO_GO / Execution separate
releasePackageTagDecision = NO_GO / Waiting
splitRepoDispositionExecution = NO_GO / active_canonical remains
```

This packet is deliberately not a live execution packet. It records that the next
safe monorepo step is to declare `a2a-nexus/packages/*` as the PR-first canonical
source candidate while preserving every irreversible or runtime-sensitive action
as a separate approval surface.

## Active Packet Evidence

### Source-only A2A Round

The finalizer used a Team1+Team2 source-only A2A round for this packet. Workers
were instructed not to modify files, deploy, restart services, mutate databases,
move credentials, send providers/Telegram, ACK/replay Terminal rows, publish, or
change split-repo settings.

| Team | Broker | Worker | Task | Status |
| --- | --- | --- | --- | --- |
| Team1 | `seoseo` | `sogyo` | `83607748-813f-47c9-a9de-edab7e44cad2` | `done` |
| Team1 | `seoseo` | `nosuk` | `04f8b5b0-bf19-471b-9794-e87647f83ca9` | `done` |
| Team1 | `seoseo` | `bangtong` | `5fc18add-d580-4bec-940b-42c924148011` | `done` |
| Team2 | `gwakga` | `dungae` | `506d9d8a-d652-495c-bc7c-75da1aba6425` | `done` |
| Team2 | `gwakga` | `jingun` | `8abf24cb-4a91-4126-8b86-98e5a252a26f` | `done` via supplemental source-bundle retry |
| Team2 | `gwakga` | `soonwook` | `0c5e41be-fe6d-4d78-aaf8-a903f9ad1d9b` | `done` |

- Primary round: `a2a-finalpacket-retry-20260610T123212Z`.
- Supplemental Jingun retry: `a2a-finalpacket-jingun-retry-20260610T123834Z`.
- Local evidence files: `/tmp/a2a-finalpacket-retry-20260610T123212Z-evidence.json`
  and `/tmp/a2a-finalpacket-jingun-retry-20260610T123834Z-evidence.json`.
- Worker GitHub comments were disabled; this packet records the finalizer-owned
  synthesis instead.

### Prior Packet / Repository Evidence

| Gate | Evidence | Current posture |
| --- | --- | --- |
| Active drift closeout | `a2a-nexus#562`, merge `9669f9098459c9f17bdea0193bc428593b0ef2d5` | Current-state lane recorded; no import-needed code PR remained after post-#562 A2A review. |
| Operator handoff | `a2a-nexus#563`, merge `910a796b9540cb839a8fa4a1148aa38a90694eea` | Operator owner and PR-first approval record captured; execution stayed separate. |
| Branch protection/ruleset | `a2a-nexus#564`, merge `33de5b493e4f4d156a5900ad4d924a138147329c`; ruleset `17499616` | `main` ruleset active with required review/check gates. No further settings change in this packet. |
| Split-repo disposition / rollback | `a2a-nexus#566`, merge `bf36a68ab8a38c0fbea0710d979c165d4f9b07f9` | Split repos remain `active_canonical`; archive/read-only/redirect remains blocked. |
| Historical final sign-off | `a2a-plane#550`, merge `7200a91a92bbdbc82855a5a22321d704fdf2ca29`; issue `a2a-plane#549` | Historical matrix retained for lineage only; superseded for active `a2a-nexus#553` packet routing. |

## Canonical Source Candidates

The following paths are canonical source candidates for the next PR-first
monorepo declaration. This does not transfer package ownership or archive split
repos.

| Surface | `a2a-nexus` path | Split repo / provenance store | Packet decision |
| --- | --- | --- | --- |
| Broker | `packages/broker` | `jinwon-int/a2a-broker` | `canonical_source_candidate`; execution not approved |
| Docker runner | `packages/docker-runner` | `jinwon-int/a2a-docker-runner` | `canonical_source_candidate`; execution not approved |
| OpenClaw A2A plugin | `packages/openclaw-plugin-a2a` | `jinwon-int/plugin-a2a` (`openclaw-plugin-a2a` legacy alias) | `canonical_source_candidate`; execution not approved |

## Final Sign-off Matrix

Rows marked `GO_CANDIDATE / PR-first` approve only this source packet and a future
PR-first declaration. They do not approve live execution.

| Area | Required owner/evidence before execution GO | Current status |
| --- | --- | --- |
| Branch protection or ruleset | Exact ruleset target, required checks, rollback owner, and accepted settings posture. | `RECORDED / Active`; no further settings mutation in this packet. |
| Split repo disposition | Repo-by-repo posture, communication plan, undo owner for read-only/archive/redirect settings. | `RECORDED / active_canonical remains`; archive/read-only/redirect `NO_GO`. |
| Release tag and GitHub Release | Operator owner, tag name, target commit, signing policy, artifact list, yank/rollback policy. | `NO_GO / Waiting`. |
| npm publish | Package names, versions, registry, access, dist-tag, provenance, registry owner, rollback policy. | `NO_GO / Waiting`. |
| Docker/GHCR publish | Image names, registries, tags, build contexts, provenance/SBOM, rollback tags. | `NO_GO / Waiting`. |
| Package ownership transfer | Source-of-truth policy, package owner, split-repo conflict handling, issue/PR provenance policy. | `GO_CANDIDATE / PR-first source declaration`; transfer execution `NO_GO`. |
| Canonical flip | Exact commit, latest green CI, accepted-risk register, rollback owner, abort conditions. | `GO_CANDIDATE / PR-first source declaration`; execution `NO_GO`. |

## GO / NO-GO Fields

| Field | Value |
| --- | --- |
| `priorPacketsRecorded` | `true` |
| `branchProtectionRulesetActive` | `true` |
| `splitRepoDispositionPacketRecorded` | `true` |
| `canonicalSourceDeclarationPrFirstApproved` | `true` |
| `releasePackageTagApproved` | `false` |
| `packageOwnershipTransferApproved` | `false` |
| `canonicalFlipExecutionApproved` | `false` |
| `operatorFinalExecutionApproval` | `false` |
| `decision` | `GO_CANDIDATE / PR-first / source-only` |

## Abort Conditions

Any of these conditions returns the packet to hold:

- latest CI for the accepted tree is missing, red, or stale;
- ruleset `17499616` is disabled or required checks are removed;
- split-repo archive/read-only/redirect is bundled with this source packet;
- release/tag/npm/Docker/GHCR publish is bundled with this source packet;
- deploy/restart/DB mutation/credential movement/provider send/Telegram send or
  Terminal ACK/replay is bundled with this source packet;
- registry or package owner transfer is bundled with this source packet;
- force-push, history rewrite, destructive cleanup, or worker-owned GitHub
  mutation is bundled with this source packet.

## Required Follow-up Before Execution

A future execution packet must be separate and must name:

- exact target commit, branch, package, image, tag, release, or repo setting;
- human operator owner and rollback owner;
- latest green CI run for the accepted tree;
- split-repo conflict and provenance policy;
- registry/package owner custody and rollback policy if publishing or ownership
  transfer is requested;
- explicit abort conditions;
- explicit statement that release/deploy/DB/secret/provider/Terminal ACK/replay
  remain excluded unless individually approved.

## No-live Boundary

This matrix does not authorize canonical flip execution, package ownership
transfer, branch protection or ruleset changes, permission changes, CODEOWNERS
enforcement changes, split repo archive/read-only/redirect changes, release tag
creation or movement, GitHub Release creation, npm publication, Docker or GHCR
publication, repository visibility changes, production deploys,
Gateway/broker/worker restarts, database mutation, provider or Telegram sends,
Terminal ACK/replay, historical replay, credential movement, destructive cleanup,
force-push, history rewrite, or worker-owned GitHub mutation.
