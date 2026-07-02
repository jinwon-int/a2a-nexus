# A2A Work Mode Routing Rules

These rules turn the 2026-06-06 work-mode benchmark into default operator
choices for brokeralpha solo work, Team1 orchestration, and hybrid evidence rounds.

This is a source-only routing policy. It does not dispatch workers, deploy or
restart Gateway or broker services, mutate databases, ACK or replay Terminal
Brief rows, send provider or Telegram canaries, publish releases, move
credentials, or change repository visibility.

## Inputs

Use these inputs before choosing a mode:

| Input | Why it matters |
|---|---|
| Work profile | Small source fixes and deterministic docs usually finish faster solo. |
| Ambiguity | Multiple plausible causes or proposals benefit from parallel evidence. |
| Approval boundary | Runtime, credential, release, and visibility actions need one finalizer. |
| Write-set shape | Independent modules can support parallel work; coupled files usually cannot. |
| Worker health | Team1 only helps when worker capacity is healthy and not already saturated. |
| Operator urgency | Urgent known-fix work should avoid orchestration startup overhead. |

## Default Mode Table

| Work profile | Default | Reason |
|---|---|---|
| Narrow, well-understood source fix | `solo` | The benchmark's solo small-patch sample closed in 98s with no rework. |
| Predictable docs or runbook update | `solo` | Solo runbook-policy replay closed in 230s; Team1 policy replay took longer and used much more worker time. |
| Small or medium RCA with one likely code path | `solo` first | Solo RCA used less wall-clock and total worker time in the current replay set. |
| Ambiguous RCA with several plausible causes | `team1` evidence, brokeralpha finalizer | Parallel lanes can gather broader evidence, but finalizer cleanup remains required. |
| Multiple candidate PRs, conflicting recommendations, or Block evidence | `team1` | Candidate review is the clearest observed Team1 fit. |
| Approval-boundary closeout, stale lane cleanup, or cross-lane operational synthesis | `hybrid` or `team1` evidence, brokeralpha finalizer | Team1 can reduce brokeralpha active effort, but merge/closeout authority stays single-owner. |
| Late supplemental review after a Team1 round | `hybrid` | Bounded helper evidence is useful; avoid double-counting the same worker cost in benchmark aggregates. |
| Live deploy, rollback, DB mutation, Terminal Brief ACK/replay, provider send, release, secret, or visibility change | brokeralpha finalizer only; helper evidence only after explicit approval | These actions must not be delegated as independent worker decisions. |
| Urgent operator-facing bug with known fix path | `solo` | Startup and finalizer overhead can dominate the actual fix. |

## Decision Gate

Pick `solo` when at least one of these is true:

- The likely change is narrow, deterministic, or already localized.
- The work touches tightly coupled files where parallel writes would collide.
- The task is urgent and the expected implementation is shorter than Team1
  startup plus finalizer review.
- The work crosses a live-operation, credential, release, visibility, DB,
  provider-send, or Terminal Brief ACK/replay boundary.
- Worker capacity is stale, busy, degraded, or unknown.

Pick `team1` when all of these are true:

- The task can be split into independent evidence lanes or candidate proposals.
- There is meaningful ambiguity, several plausible fixes, or competing PRs.
- Worker health and capacity are good enough to avoid known stale-lane residue.
- The finalizer can spend time comparing evidence and cleaning up unselected
  branches, stale close wording, and superseded PRs.
- The operator is optimizing for breadth or confidence rather than fastest
  single-answer latency.

Pick `hybrid` when these are true:

- brokeralpha owns the implementation or finalizer path.
- A bounded helper review would reduce risk, compare alternatives, or validate a
  late supplemental PR.
- The helper scope is evidence-only and has a clear stop condition.

## Finalizer Requirements

Every `team1` or `hybrid` round needs exactly one brokeralpha finalizer. The finalizer
owns:

- selecting or rejecting worker PRs;
- editing stale close/fix wording that would close the wrong parent issue;
- deciding whether Block evidence is sufficient for a no-merge closeout;
- closing superseded worker PRs and documenting why;
- checking CI, issue auto-close, and Wiki/log follow-up;
- enforcing approval boundaries before any runtime or external mutation.

Workers and subagents provide evidence packets only. They must not independently
merge, close parent issues, ACK Terminal Brief rows, replay providers, restart
services, mutate production state, publish releases, move credentials, or change
repository visibility.

## Pre-Dispatch Checklist

Before Team1 or hybrid dispatch:

1. Confirm the task is not a simple solo default by the table above.
2. Check current worker capacity and stale-task state through `/workers/capacity`
   and `/dashboard`. Do not use `/workers` or `/workers/:id` alone as a dispatch
   GO/NO-GO signal when unchanged heartbeat persistence is throttled.
3. Define the exact evidence lanes and stop conditions.
4. Name the brokeralpha finalizer and the parent issue.
5. State whether worker output may include PRs, read-only evidence, or both.
6. Include no-change/read-only flags for evidence-only lanes.
7. Require safe parent wording such as `Related issue:` or `Refs`, not
   `Closes`/`Fixes`, unless the finalizer intentionally owns parent closeout.

For repeatable records, render a source-only pre-dispatch decision packet before
the round:

```bash
npm run work_mode_pre_dispatch_decision -- \
  --input fixtures/work-mode-pre-dispatch/team1-candidate-review.json
```

The packet is a decision artifact only; it never dispatches workers by itself.
Dispatch helpers can also consume the fixture or rendered packet with
`--work-mode-decision` and will fail closed when it recommends `solo`.

## Closeout Checklist

Before merging or closing after Team1/hybrid work:

1. Compare selected and unselected worker evidence.
2. Check for late Done/Block comments and stale running tasks.
3. Update stale PR bodies that imply automatic parent closeout.
4. Record superseded PR decisions and close unneeded branches when appropriate.
5. Verify required CI and issue auto-close behavior.
6. Decide whether Family Wiki or operational log updates are required.
7. Send a concise operator report with PRs, commits, checks, and boundaries.

## Benchmark Evidence

The second-pass benchmark aggregate used 12 replay records and excluded the
overlapping hybrid `#1279` record from headline aggregates because that worker
cost is already counted in the Team1 `#1253` candidate-review sample.

Observed signals:

- `solo` median decision time: 421s.
- `team1` median decision time: 902.5s.
- `solo` median total worker time: 252s.
- `team1` median total worker time: 2836s.
- `solo` average rework: 0.2.
- `team1` average rework: 3.5.
- Team1's strongest active-effort reduction signal was operational closeout,
  where brokeralpha active effort fell from 669s solo to 117s with Team1 evidence.

Use these as routing heuristics, not universal speed claims. The replay set is
still small, and several task-type comparisons are not same-difficulty pairs.

## Related

- `docs/a2a-work-mode-benchmark-v1.md`
- `docs/a2a-work-mode-pre-dispatch-decision.md`
- `docs/a2a-work-mode-benchmark-analysis-2026-06-06.md`
- `docs/worker-subagent-orchestration-policy.md`
- `docs/round-closeout-reconcile.md`
