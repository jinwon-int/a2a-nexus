# Evidence: Goal Links and Monthly Spend Budgets (#2499)

Spec: [`spec.md`](spec.md) · Plan: [`plan.md`](plan.md) · Tasks: [`tasks.md`](tasks.md) · Issue: [#2499](https://github.com/jinwon-int/a2a-nexus/issues/2499)

This file is the finalizer's evidence packet for each slice PR. All lanes were `analysis-only` / `a2ad` / source-only / no-live. Each lane is worker-signed and broker-countersigned, with `completion.marked=true`. The finalizer read every verdict from the stored task result, not from a summary.

- Team 1 lanes ran on the Team 1 broker.
- Team 2 lanes ran on the Team 2 broker.
- No lane ran on the authoring node.
- Within each PR, every round used the same worker per team and area.
- Merges went through the merge queue as squash merges.
- Order per PR: A2A review PASS on the head, then the owner's merge approval in the conversation, then a `jinon86` review pinned to that exact head through the relay, then merge.

## PRs

| Slice | PR | Final head | Merge commit | Merged (UTC) |
|---|---|---|---|---|
| spec | #2506 | `faab180d` | `8c09808f` | 2026-11-06 10:33 |
| plan + tasks | #2507 | `a77d0498` | `7856ac9c` | 2026-11-06 11:50 |
| 1 — schema v14, goal link, goal routes | #2509 | `26ece83a` | `8ae4d641` | 2026-11-06 13:30 |
| 2 — spend ledger (record only) | #2510 | `9fc41844` | `88d65742` | 2026-11-07 01:29 |
| 3a — preconditions before enforcement | #2511 | `6d453c32` | `b1f4ce3c` | 2026-11-07 02:37 |
| 3b-1 — budgets, mode, evaluator, status | #2513 | `4b8f768f` | `35d7416c` | 2026-11-07 03:46 |
| 3b-2 — enforcement hooks (red first) | #2514 | `9f93e5de` | `c45eb506` | 2026-11-07 09:50 |
| 4 — alerts and runbook | #2515 | `398229f1` | `7ed26e97` | 2026-11-07 12:04 |

## Review lanes

| PR | Round | Lane round id (task id = round id + `:1-<worker>`) | Verdict |
|---|---|---|---|
| #2509 | 1 | `a2a-pr2509-review-20261106T122224Z` | REVISE |
| #2509 | 2 | `a2a-pr2509-rereview-20261106T131950Z` | PASS |
| #2510 | 1 | `a2a-pr2510-review-20261106T135801Z` | REVISE |
| #2510 | 2 | `a2a-pr2510-rereview-20261106T142835Z` | PASS |
| #2511 | 1 | `a2a-pr2511-review-team1-20261107T020700Z` | PASS |
| #2511 | 1 | `a2a-pr2511-review-team2-20261107T020700Z` | REVISE (1 major) |
| #2511 | 2 | `a2a-pr2511-rereview-team1-20261107T022545Z` | PASS |
| #2511 | 2 | `a2a-pr2511-rereview-team2-20261107T022545Z` | PASS |
| #2513 | 1 | `a2a-pr2513-review-team1-core-20261107T030929Z` | PASS |
| #2513 | 1 | `a2a-pr2513-review-team1-http-20261107T030929Z` | PASS |
| #2513 | 1 | `a2a-pr2513-review-team2-core-20261107T030929Z` | REVISE (1 major) |
| #2513 | 1 | `a2a-pr2513-review-team2-http-20261107T030929Z` | REVISE (1 major) |
| #2513 | 2 | `a2a-pr2513-rereview-{team1,team2}-{core,http}-20261107T033320Z` | PASS ×4 |
| #2514 | 1 | `a2a-pr2514-review-team1-core-20261107T081403Z` | PASS |
| #2514 | 1 | `a2a-pr2514-review-team1-http-20261107T081403Z` | REVISE (1 major) |
| #2514 | 1 | `a2a-pr2514-review-team2-core-20261107T081403Z` | PASS |
| #2514 | 1 | `a2a-pr2514-review-team2-http-20261107T081403Z` | REVISE (2 major) |
| #2514 | 2 | `a2a-pr2514-rereview-{team1,team2}-{core,http}-20261107T084257Z` | PASS ×4 |
| #2515 | 1 | `a2a-pr2515-review-team1-core-20261107T105837Z` | PASS |
| #2515 | 1 | `a2a-pr2515-review-team1-http-20261107T105837Z` | REVISE (1 major, runbook) |
| #2515 | 1 | `a2a-pr2515-review-team2-core-20261107T105837Z` | PASS |
| #2515 | 1 | `a2a-pr2515-review-team2-http-20261107T105837Z` | PASS |
| #2515 | 2 | `a2a-pr2515-rereview-team1-http-20261107T110624Z` | PASS (docs-only delta) |

#2506 (spec) and #2507 (plan and tasks) are documents the owner accepted directly (decisions of 2026-11-06); no A2A lane ran on them.

For #2515, round 2 re-reviewed only the docs-only delta (`08302f85..398229f1`) in the one lane that had returned REVISE; the other three lanes' round-1 PASS was on `08302f85`, and the delta touched no code.

The full task ids (with the worker id) are recorded in each PR's review comments. Those comments also hold the per-round findings, the fix map and the CI results on the exact head. The ids are left out here because worker ids are internal fleet identifiers.

## Red-first (plan requirement, slice 3b-2)

- **Red:** `5e9795c7` (tests only) → [run 42352673952](https://github.com/jinwon-int/a2a-nexus/actions/runs/42352673952), 20 failures, all in the new enforcement tests.
- **Green:** `52240543` (implementation) → [run 42354556873](https://github.com/jinwon-int/a2a-nexus/actions/runs/42354556873), all required checks green.

## Follow-ups

- #2512: in-process SQLite full save inside a batch hits a nested `BEGIN IMMEDIATE`. Found while testing slice 3a. A read-only check on 2026-11-07 showed both fleet brokers on worker-thread persistence, which is not affected (see the issue; re-check live).
- #2516: cross-broker spend aggregation (Team 1 + Team 2).
- #2517: reconcile `docs/specs/a2a-goal-mode/schema.json` with `GoalStatus`.
- #2518: cost and usage telemetry for Codex, Hermes and patch lanes.
- #2519: signed usage telemetry (spec decision 12).
- #2520: carried review minors from slices 3b-2 and 4.

## Not performed

No deploy, restart, migration, canary, DB change or enforcement mode change. As of 2026-11-07 KST, none of this work had been deployed to a production broker (see #2499). Deployment state changes: check live before relying on it.
- Deploying v14 is a database migration: it needs a broker DB backup and the owner's approval (runbook §1).
- Moving a broker to `shadow`, and later to `on`, is a separate owner approval each time, per broker.
