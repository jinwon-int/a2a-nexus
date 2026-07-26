# Terminal Brief Auto-Closeout Planner

Issue #833 adds the fail-closed automatic parent-round closeout planner. It wraps the
[terminal-brief completion watcher](terminal-brief-completion-watcher.md) and
[final-count closeout candidate](terminal-brief-final-count-closeout.md) with policy-mode
gating and a deterministic closeout plan.

The planner consumes a `TerminalBriefFinalCountCloseoutCandidate` (or raw inputs to build one),
applies a policy mode, and returns a `TerminalBriefAutoCloseoutPlan` that describes what action
is permitted and what blocks remain.

This is the second lane (lane 2/4) of the Team1 auto-closeout design run (parent
[#832](https://github.com/jinwon-int/a2a-broker/issues/832)).

## No-live quick run

Run:

    npm run terminal_brief -- terminal_brief_auto_closeout_planner \
      --input fixtures/terminal-brief/auto-closeout-planner.candidate.no-live.json \
      --policy-mode draft \
      --markdown

Expected output starts with:

    Plan: fail-closed automatic closeout — approved
    Policy mode: draft
    Parent round: round-833-no-live
    Closeout candidate status: candidate
    Idempotency key: auto-closeout:...

## Policy modes

| Mode              | Description                                                   | Action kinds                         | executePermitted |
|-------------------|---------------------------------------------------------------|--------------------------------------|------------------|
| `off`             | Blocks all closeout actions (safe default)                    | `operator_review`                    | false            |
| `draft`           | Produces a candidate plan but no executable actions           | `noop`                               | false            |
| `comment_only`    | Allows a closeout comment on the parent issue                 | `comment`                            | false (wired later) |
| `comment_and_close` | Allows closeout comment plus GitHub issue close             | `comment`, `comment_and_close`       | false (wired later) |

In this source-only slice, **all** actions have `executePermitted=false`. Future rounds wire
the actual GitHub API calls.

## Plan decisions

- **approved** — the closeout candidate is ready under the active policy mode. Actions list
  what the plan _would_ do when wired.
- **blocked** — evidence conflicts, missing workers, or candidate blockers prevent closeout.
- **waiting** — no final-count signal observed yet; still collecting evidence.
- **policy_denied** — policy mode is `off` (or another non-actionable mode with no blockers).

## Idempotency

The idempotency key combines:

- parentRoundId
- lane set (worker, state, evidenceUrl, parentRoundProgress, parentRoundTotal) sorted by worker
- policy mode
- count of final N/N signals
- evidence revisions (hash per worker)

Duplicate N/N signals or repeated polls with unchanged evidence produce the same key. This
prevents double-comment or double-close even when the planner is called multiple times.

Evidence revisions can be used by callers to signal that lane evidence has changed (e.g. a
PR URL was added or a worker retried). Different revisions produce different idempotency keys.

## Fail-closed boundary

The planner tracks these gates in `failClosedBoundary`:

| Gate                      | Behavior                                                     |
|---------------------------|--------------------------------------------------------------|
| `policyPreventsAction`    | Policy mode `off` → no action possible                      |
| `tokenMissing`            | Warning only; GitHub token simulated as absent               |
| `conflictingEvidence`     | Conflicting totals (3/3 and 4/4) → blocked                  |
| `missingEvidence`         | Zero terminal events for an expected worker → blocked       |
| `missingCiEvidence`       | No CI pass URLs for comment/close mode → warning             |
| `prNotMergeable`          | PR merge SHA not available → warning (not fail-closed in slice) |
| `operatorOverridePresent` | Manual override unblocks; flagged in warnings                |

## Receipt and safety boundaries

The planner inherits all safety semantics from the underlying completion watcher and
final-count closeout. Provider-accepted/message-id evidence is never treated as terminal ACK,
read receipt, visibility proof, or operator approval.

This module is source/no-live safe. It reads local JSON evidence and policy configuration,
and renders JSON or markdown. It never performs:

- GitHub PR merge or issue close (requires future wiring + operator policy)
- live provider/Telegram/Hermes/OpenClaw send
- terminal ACK/replay
- Gateway/broker/worker/sidecar restart or deploy
- broker DB mutation/prune/migration
- historical replay
- release/tag/npm publish
- secret or credential movement

## CLI

```text
npm run terminal_brief -- terminal_brief_auto_closeout_planner \
  --input <fixture.json> \
  --policy-mode <off|draft|comment_only|comment_and_close> \
  --parent-round-id <id> \
  [--json|--markdown]
```

Exit codes:

- 0: plan decision is `approved`
- 1: plan decision is `blocked` or `policy_denied`
- 2: CLI error (missing input, invalid mode)

## What remains manual after this slice

This source-only slice defines the planner contract and policy gating. The following remain
for future rounds:

1. Wire `executePermitted=true` for GitHub comment API calls under `comment_only` policy.
2. Wire `executePermitted=true` for GitHub issue close under `comment_and_close` policy.
3. Integrate real GitHub token/permission checks (not simulated).
4. Add real CI status lookups via GitHub API or status callbacks.
5. Add PR merge SHA verification via GitHub API.
6. Wire the planner into a broker endpoint (`POST /terminal-brief/auto-closeout/plan`).
7. Wire the planner into the operator heartbeat or closeout workflow trigger.
