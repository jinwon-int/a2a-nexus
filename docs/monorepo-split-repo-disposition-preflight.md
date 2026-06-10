# A2A Monorepo Split-repo Disposition Preflight

> **Snapshot date:** 2026-06-10
> **Active coordination:** [a2a-nexus#553](https://github.com/jinwon-int/a2a-nexus/issues/553)
> **Source commit:** `8a675ce88ac30c04a23bb7357805dbd479fd8ae1`
> **Operator approval:** `승인: split repo disposition preflight 진행`
> **Decision:** `GO_PR_FIRST_SOURCE_ONLY_PREFLIGHT`; actual split-repo disposition execution remains `NO_GO / Waiting`.

## Summary

`a2a-nexus` is now `MONOREPO_PACKAGES_CANONICAL` after the source-state canonical
flip. This packet is the next safe step: it defines the future split-repo
disposition plan without changing any external repository settings.

Recommended future candidate:

```text
futureCandidateDisposition = ACTIVE_PROVENANCE_MIRROR
actualDispositionExecution = NO_GO / Waiting / separate approval required
```

`read_only_archive` and `archived_redirect` remain explicit non-candidates for
immediate execution because they remove emergency hotfix and provenance paths too
early.

## Repository Facts (read-only)

| Surface | Split repo | Canonical monorepo path | Current external state | Future candidate |
| --- | --- | --- | --- | --- |
| broker | `jinwon-int/a2a-broker` | `packages/broker` | active, public, unarchived | `active_provenance_mirror` |
| docker runner | `jinwon-int/a2a-docker-runner` | `packages/docker-runner` | active, public, unarchived | `active_provenance_mirror` |
| OpenClaw plugin A2A | `jinwon-int/plugin-a2a` (`jinwon-int/openclaw-plugin-a2a` legacy alias) | `packages/openclaw-plugin-a2a` | active, public, unarchived | `active_provenance_mirror` |

Read-only lookup note: `jinwon-int/openclaw-plugin-a2a` resolves to
`jinwon-int/plugin-a2a`; the canonical split-repo entry is `plugin-a2a`, with the
legacy alias retained for operator communication and issue/provenance searches.

## A2AD Evidence

Primary A2AD preflight round:

- Round: `a2ad-splitdispo-preflight-20260610T150452Z`
- Evidence: `/tmp/a2ad-splitdispo-preflight-20260610T150452Z-evidence.json`

Usable analysis:

- Team1 / Seoseo:
  - `sogyo` — `698ace07-4fa4-478e-a248-a8c6a7dc9fce` — done
  - `nosuk` — `5c3a779a-6ae3-4959-828a-d97b26099340` — done
  - `bangtong` — `529fe5ae-a031-48ea-8ecc-8dadf1fafd6e` — done
- Team2 / Gwakga:
  - `dungae` — `9f567857-657a-4369-97de-eb542fb32ffc` — done
  - `jingun` — `5fdd7b86-4a57-4487-9640-f1919890627e` — done
  - `soonwook` — `1a4e693d-6a3e-4b2f-9430-97c2da791a75` — done

Finalizer synthesis: GO for source-only preflight. Future candidate is
`active_provenance_mirror`. Keep archive/read-only/redirect, settings mutation,
ownership transfer, release/publish/deploy, DB/secret/provider/Terminal ACK,
force-push/history rewrite on HOLD.

## Preflight Gates

| Gate | Value |
| --- | --- |
| `operatorApprovalPhraseMatched` | `true` |
| `canonicalSourceFlipResultMerged` | `true` |
| `repoFactsReadOnlyCaptured` | `true` |
| `pluginAliasDeduped` | `true` |
| `rollbackOwnerFieldsRecorded` | `true` |
| `communicationPlanRequired` | `true` |
| `emergencyHotfixFallbackRequired` | `true` |
| `futureExecutionApprovalRequired` | `true` |
| `preflightOnly` | `true` |
| `externalRepoMutationPerformed` | `false` |

## Future Execution Requirements

A later execution packet must name all of these before any external repo setting
mutation:

- repo-by-repo target disposition;
- repo-specific operator owner and rollback owner;
- communication/notice plan;
- issue/PR/tag provenance notice;
- conflict policy for split repo vs monorepo changes;
- emergency hotfix fallback;
- exact GitHub settings/API action and rollback command;
- post-change verification plan;
- separate fresh approval.

## GO / NO-GO Fields

| Field | Value |
| --- | --- |
| `preflightAllowed` | `true` |
| `activeProvenanceMirrorCandidateRecorded` | `true` |
| `actualSplitRepoDispositionApproved` | `false` |
| `readOnlyArchiveApproved` | `false` |
| `archivedRedirectApproved` | `false` |
| `repoSettingsMutationApproved` | `false` |
| `packageOwnershipTransferred` | `false` |
| `externalLiveMutationPerformed` | `false` |
| `decision` | `GO_PR_FIRST_SOURCE_ONLY_PREFLIGHT__DISPOSITION_EXECUTION_HOLD` |

## No-live Boundary

This packet performs no split repo archive, read-only switch, redirect,
permission change, repo visibility change, GitHub settings mutation, package
ownership transfer, release tag, GitHub Release, npm publish, Docker/GHCR
publish, deploy, restart, DB mutation, secret movement, provider send, Telegram
send, Terminal ACK/replay, force-push, or history rewrite.
