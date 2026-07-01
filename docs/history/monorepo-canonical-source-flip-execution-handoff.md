# A2A Monorepo Canonical Source Flip Execution Handoff Packet

> **Snapshot date:** 2026-06-10
> **Active coordination:** [a2a-nexus#553](https://github.com/jinwon-int/a2a-nexus/issues/553)
> **Source commit:** `b8e863d5a251a6603f3caf9329d1bb0dfb5c6fe0`
> **Prior packet:** [PR #567](https://github.com/jinwon-int/a2a-nexus/pull/567)
> **Decision:** `GO_PR_FIRST_SOURCE_ONLY`; actual canonical flip execution remains `NO_GO / Waiting`.

## Summary

This packet is the next safe step after the final operator sign-off / canonical source packet. It does **not** execute the canonical flip. It records the exact handoff fields that a later, separately approved execution packet must satisfy before `packages/broker`, `packages/docker-runner`, and `packages/openclaw-plugin-a2a` can be treated as the live authoritative implementation source.

The active `a2a-nexus` ruleset is already in force:

```text
ruleset = a2a-nexus-main-required-checks
rulesetId = 17499616
target = main
enforcement = active
requiredChecks = paths-filter, setup, layout, contracts, check
requiredApprovingReviews = 1
strictRequiredStatusChecksPolicy = true
bypassActors = []
```

## Handoff Decision

```text
handoffDecision = GO_PR_FIRST_SOURCE_ONLY
canonicalSourceDeclaration = GO_CANDIDATE / PR-first / source-only
actualCanonicalFlipExecution = NO_GO / Waiting / separate approval required
```

This means a PR may document and validate the execution handoff. It does not mean the operator has approved repository settings mutation, split-repo archive or read-only changes, release/publish/deploy, database mutation, credential movement, provider send, or Terminal ACK/replay.

## A2A Evidence

Primary source-only round:

- Round: `a2a-canonicalflip-20260610T131555Z`
- Evidence: `/tmp/a2a-canonicalflip-20260610T131555Z-evidence.json`

Supplemental rounds:

- `a2a-canonicalflip-retry-20260610T132021Z` — `/tmp/a2a-canonicalflip-retry-20260610T132021Z-evidence.json`
- `a2a-canonicalflip-sogyo-retry-20260610T132313Z` — `/tmp/a2a-canonicalflip-sogyo-retry-20260610T132313Z-evidence.json`

Usable analysis was received from:

- Team1 / Seoseo:
  - `nosuk` — `b997a57c-b0b6-4c6d-b445-6fe4af0af558` — `done`
  - `bangtong` — `c439b2b1-91fc-45bf-aa31-4124dd48fe20` — `done`
- Team2 / Gwakga:
  - `dungae` — `26394e42-b149-42a1-84c7-29b986f2e934` — `done`
  - `jingun` — `ca63c06d-2ebc-4d66-8361-7f40c83bf72a` — supplemental `done`
  - `soonwook` — `a9dd22d7-ed78-43fb-8832-27b50bc67dae` — `done`

Dissent / guardrail:

- `sogyo` — `930f0f6f-e467-46fd-bea0-8bdb7114b991` — reported the execution handoff as blocked if it is interpreted as actual canonical flip execution. The finalizer treats this as a safety guard: the PR-first handoff may advance, but every actual execution-sensitive action stays `NO_GO / Waiting` until a separate approval.

## GO / NO-GO Fields

| Field | Value |
| --- | --- |
| `finalOperatorSignoffPacketMerged` | `true` |
| `a2aNexusRulesetActive` | `true` |
| `requiredReviewEnforced` | `true` |
| `requiredChecksNamed` | `true` |
| `canonicalSourceCandidatesNamed` | `true` |
| `rollbackAbortOwnerRecorded` | `true` |
| `sourceOnlyA2aEvidenceRecorded` | `true` |
| `handoffPrAllowed` | `true` |
| `actualCanonicalFlipApproved` | `false` |
| `packageOwnershipTransferred` | `false` |
| `splitRepoDispositionExecuted` | `false` |
| `releasePublishDeployApproved` | `false` |
| `settingsMutationApproved` | `false` |
| `decision` | `GO_PR_FIRST_SOURCE_ONLY__EXECUTION_NO_GO_WAITING` |

## Remaining Separate Approvals

The following must stay separate from this PR and require explicit operator approval before any mutation:

- actual canonical flip execution;
- split-repo archive/read-only/redirect;
- package ownership transfer;
- release tag and GitHub Release creation;
- npm publish;
- Docker/GHCR publish;
- deploy or restart;
- DB mutation or replay;
- secret or credential movement;
- provider or Telegram send;
- Terminal ACK or replay;
- GitHub settings changes beyond the existing active ruleset.

## Rollback / Abort Policy

Before actual execution, rollback is a normal PR revert of this handoff packet or a follow-up PR restoring the prior docs, fixture, and checker state.

After actual execution, rollback is intentionally not defined here. The later execution packet must assign an execution owner, rollback owner, abort criteria, and verification gates before any state mutation.

## No-live Boundary

This packet performs no GitHub settings mutation, canonical flip state mutation, package ownership transfer, split-repo archive/read-only/redirect, release tag, GitHub Release, npm publish, Docker/GHCR publish, deploy, restart, DB mutation, secret movement, provider send, Telegram send, Terminal ACK/replay, force-push, or history rewrite.
