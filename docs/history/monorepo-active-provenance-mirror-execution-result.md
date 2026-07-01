# A2A Monorepo Active Provenance Mirror Execution Result

> **Snapshot date:** 2026-06-10
> **Active coordination:** [a2a-nexus#553](https://github.com/jinwon-int/a2a-nexus/issues/553)
> **Source commit before packet:** `458f2f91c6ff5849e9080b14307870ec281364dc`
> **Operator approval:** `승인: split repo active provenance mirror execution 진행`
> **Decision:** `GO_EXECUTED_DOCS_ONLY_ACTIVE_PROVENANCE_MIRROR__EXTERNAL_SURFACES_HOLD`

## Summary

The split repositories have been converted to **active provenance mirrors** by
PR-first documentation/source notices only. They remain active public repositories
for history, issue/PR/tag provenance, and emergency reference. The canonical
implementation source remains `jinwon-int/a2a-nexus`:

- `packages/broker`
- `packages/docker-runner`
- `packages/openclaw-plugin-a2a`

No repository was archived, made read-only, redirected, renamed, hidden, or
mutated through settings.

## Merged split-repo PRs

| Surface | Split repo | Canonical path | PR | Merge commit |
| --- | --- | --- | --- | --- |
| Broker | `jinwon-int/a2a-broker` | `packages/broker` | [#1364](https://github.com/jinwon-int/a2a-broker/pull/1364) | `c8f3417c355cbdb9ae6708157577310911848c3e` |
| Docker runner | `jinwon-int/a2a-docker-runner` | `packages/docker-runner` | [#373](https://github.com/jinwon-int/a2a-docker-runner/pull/373) | `f48a578b6736054c03a1a94896ac9ade6ba5924b` |
| OpenClaw plugin A2A | `jinwon-int/plugin-a2a` | `packages/openclaw-plugin-a2a` | [#466](https://github.com/jinwon-int/plugin-a2a/pull/466) | `6ac71b0c6afee8dbdfbc7c430825885e066495a4` |

Each PR added or updated:

- `README.md` canonical-source notice;
- `MIRROR_NOTICE.md` with active provenance mirror status, source routing,
  explicit non-actions, and rollback path.

`jinwon-int/openclaw-plugin-a2a` remains a legacy alias/context for
`jinwon-int/plugin-a2a` and `packages/openclaw-plugin-a2a`.

## A2AD Evidence

Primary round:

- `a2ad-active-provenance-mirror-20260610T155109Z`
- Evidence: `/tmp/a2ad-active-provenance-mirror-20260610T155109Z-evidence.json`

Focused Team1 retry round:

- `a2ad-active-provenance-mirror-team1-retry-20260610T155535Z`
- Evidence: `/tmp/a2ad-active-provenance-mirror-team1-retry-20260610T155535Z-evidence.json`

Usable analysis:

- Team1 / Seoseo:
  - `sogyo` — `73d550ac-c307-4a22-8f63-716fbd7381c4` — done
  - `nosuk` — `6222f191-f8ec-4dcf-8624-fd0f79eb8c2c` — focused retry done
  - `bangtong` — `04a2a987-ea53-43ac-8411-2e88595203da` — focused retry done
- Team2 / Gwakga:
  - `dungae` — `37049939-74ac-4296-b2e4-9b55f0c56bbe` — done
  - `jingun` — `275f582c-7ee2-42f5-a371-1be078c75310` — done
  - `soonwook` — `82f184b0-87ac-4dd4-bc98-0d347c492c2f` — done

Superseded guardrails:

- `nosuk` — `c0de37f5-1369-412a-84df-4962f4cd5c57` — blocked because the
  first payload was truncated/appeared to have zero files; superseded by focused retry.
- `bangtong` — `a307a5c8-bb62-4506-a8a7-211435669a65` — blocked because the
  first payload was truncated/appeared to have zero files; superseded by focused retry.

Finalizer synthesis: GO for docs-only active provenance mirror execution. Split
repos receive README/MIRROR_NOTICE source-routing notices and remain active public
provenance mirrors. Archive/read-only/redirect, settings mutation, ownership
transfer, release/publish/deploy, DB/secret/provider/Terminal ACK, force-push,
and history rewrite remain HOLD.

## Verification

Split repo PRs:

- `a2a-broker#1364` — GitHub Actions `build` checks passed; `seoseo-ai` approved; merged `2026-06-10T16:04:51Z`.
- `a2a-docker-runner#373` — GitHub Actions `build` checks passed; `seoseo-ai` approved; merged `2026-06-10T16:04:59Z`.
- `plugin-a2a#466` — GitHub Actions `build` checks passed; `seoseo-ai` approved; merged `2026-06-10T16:05:10Z`.

Post-merge read-only verification confirmed:

- each split repo has `MIRROR_NOTICE.md` with `ACTIVE_PROVENANCE_MIRROR`;
- each split repo README contains `Canonical source notice (2026-06-10)`;
- each split repo remains `archived=false`;
- active provenance mirror branches have no remote refs remaining.

## No-live Boundary

This execution does **not** perform or authorize repository archive/read-only/
redirect, repository settings mutation, visibility or permission changes, package
ownership transfer, release tag, GitHub Release, npm publish, Docker/GHCR publish,
deploy, restart, DB mutation/replay, secret/credential movement, provider send,
Telegram send, Terminal ACK/replay, force-push, or history rewrite.

## Rollback

Rollback is PR-first:

1. Revert the README banner and `MIRROR_NOTICE.md` file in each split repo.
2. Revert this `a2a-nexus` execution result packet or replace it with a follow-up
   correction packet.
3. No external settings rollback is required because no settings were changed.
