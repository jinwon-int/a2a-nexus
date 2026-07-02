# Team2/workerEta Stability R7 risk review and compatibility matrix

Parent: [a2a-broker#548](https://github.com/jinwon-int/a2a-broker/issues/548)
Plane lane: a2a-plane#282 (a2a-plane#282, internal tracker private)
Run: `a2a-stability-r7-20260513T101831Z`
Snapshot: `2026-05-13T10:25Z`

This is a redacted, no-live Team2 libero validation artifact. It reviews cross-team Stability R7 compatibility for broker liveness, read-only/libero task semantics, canary/receipt gates, PR-less evidence lanes, and Terminal Brief deployment-readiness evidence. It does not deploy or restart Gateway/broker/worker services, mutate or prune production databases, replay or ACK terminal-outbox rows, send live provider/Telegram messages, change secrets or visibility, publish a release/tag, rewrite history, force-push, or execute approval.

## Decision summary

**Decision: `NO-GO / Waiting` for production activation.** The compatibility matrix is safe as repository evidence, but it is not broker liveness closure, read-only/libero implementation closure, live canary authorization, Terminal Brief ACK evidence, or deployment approval.

At this snapshot, the R7 sibling lanes discovered from the run id have Start evidence only or no terminal PR/Done/Block evidence observed by this lane:

- [a2a-broker#549](https://github.com/jinwon-int/a2a-broker/issues/549) — Team1 workerGamma broker liveness hot-table/queue hardening.
- [a2a-broker#550](https://github.com/jinwon-int/a2a-broker/issues/550) — Team2 workerEpsilon broker read-only validation semantics and evidence export.
- [a2a-docker-runner#237](https://github.com/jinwon-int/a2a-docker-runner/issues/237) — Team1 workerAlpha runner support for PR-less validation tasks.
- [a2a-docker-runner#238](https://github.com/jinwon-int/a2a-docker-runner/issues/238) — Team2 workerZeta runner parity/stress fixtures for validation lanes.
- [openclaw-plugin-a2a#294](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/294) — Team1 workerBeta plugin UX for read-only/libero task evidence.
- a2a-plane#281 (a2a-plane#281, internal tracker private) — Team1 workerDelta libero contract and gate matrix.

Safe closeout for this lane may say: **Team2 documented the R7 cross-team compatibility matrix and local validation passed; aggregate R7 readiness remains `NO-GO / Waiting` until sibling lanes publish terminal PR/Done/Block evidence, broker implementation evidence lands, runtime/bootstrap hygiene is clean, and any live-impact action receives fresh explicit operator approval.**

## Compatibility matrix

| Area | Team1 lanes must prove | Team2 lanes must prove | Compatible closeout | Fail-closed divergence |
| --- | --- | --- | --- | --- |
| Broker liveness and OOM risk | `a2a-broker#549` supplies bounded hot-table/state-growth, queue hygiene, and memory evidence without production mutation. | `a2a-broker#550` keeps evidence export bounded, idempotent, and safe for read-only validation consumers. | `NO-GO / Waiting` until both broker-side implementation/evidence lanes have terminal evidence and show CPU/heap/backlog risk is bounded. | Any lane claims #497/#548 readiness from docs alone, unbounded table scans, stale queue snapshots, or production restart/DB cleanup without approval. |
| Read-only/libero task semantics | `a2a-docker-runner#237` supports PR-less validation tasks with Start plus Done/Block evidence instead of a false patch failure. | `a2a-docker-runner#238` stress/parity fixtures preserve patch-lane no-diff failure while allowing explicit read-only validation no-change closeout. | `intent=verify` or `intent=analyze` with read-only modes may close without a PR; `github-propose-patch` still needs a real diff/PR or Block evidence. | GitHub issue metadata is coerced into patch mode, or a patch-producing lane posts Done with no repository changes. |
| Canary, receipt, and replay gates | Broker/plugin evidence keeps provider accepted-send and Telegram message ids separate from requester/operator-visible receipt. | Team2 validation rejects any cross-broker or Terminal Brief projection that upgrades provider acceptance into operator-visible receipt or approval evidence. | Canary/readiness evidence is no-live by default; any live canary is one-shot, allowlisted, replay-protected, and separately approved. | Provider `messageId`, `accepted`, `sent`, GitHub comment success, or Terminal Brief text is treated as read receipt, human-seen proof, approval proof, or terminal-outbox acknowledgement. |
| PR-less evidence lanes | Team1 runner/plugin UX surfaces bounded Done/Block evidence for no-change validation tasks. | Team2 runner/broker semantics preserve a terminal kind (`done` or `block`), stable issue URLs, and bounded command output for PR-less lanes. | PR-less evidence is valid only for explicit read-only/libero work; no-diff patch-lane protection remains mandatory. | Runner reports false success for empty patch output, or hides a valid validation Done/Block because no branch/PR exists. |
| Terminal Brief deployment-readiness evidence | Terminal Brief projections remain no-live evidence summaries and include no approval or ACK side effects. | Cross-team aggregation uses stable keys and child issue/PR/Done/Block URLs without replaying historical outbox entries. | Terminal Brief readiness can summarize evidence, but production activation remains blocked until explicit operator approval names the exact action. | Terminal Brief sends live provider messages, replays stale outbox rows, mutates terminal ACK state, or implies deployment approval. |
| Runtime/bootstrap hygiene | Lane artifacts and comments exclude secrets, raw logs, host-private paths, provider payloads, and OpenClaw context files. | Team2 libero fails closed before PR/Done/Block if denied paths enter the branch or artifact evidence. | Evidence is bounded, redacted, and repository-relative; denied path names may appear only as policy references. | Any actual `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` content/path enters the branch or evidence payload as leaked runtime context. |

## Risk review

| Risk | Current posture | Required gate before GO | Owner evidence |
| --- | --- | --- | --- |
| Broker CPU/heap/OOM from hot-table growth | Open residual risk. R7 has Start evidence but no terminal implementation proof observed here. | Bounded state access/persistence, representative growth test, health output with memory/table/outbox counts, and no unapproved production cleanup. | `a2a-broker#549`, `a2a-broker#550`, residual tracker `a2a-broker#497`. |
| PR-less validation false failure or false Done | Open compatibility risk. The runner must distinguish read-only validation from patch production. | Runner/broker fixtures prove no-change read-only validation can close with Done/Block while no-diff patch tasks fail closed. | `a2a-docker-runner#237`, `a2a-docker-runner#238`, tracker `a2a-broker#527`. |
| Receipt/canary evidence inflation | Open safety risk. Provider-accepted evidence is useful ledger evidence only. | No-live canary/replay proof, idempotency keys, stale/backlog suppression, and explicit operator approval before any live send or ACK mutation. | `a2a-broker#294`, plugin UX `openclaw-plugin-a2a#294`, broker R7 lanes. |
| Cross-broker Terminal Brief aggregation | Evidence-only until proven bounded and idempotent. | Stable projection key, parent/lane IDs, child terminal evidence URL, no-provider-send/no-ACK/no-read-receipt flags, and no historical replay. | Parent `a2a-broker#548`, Plane libero `a2a-plane#281/#282`. |
| Runtime/bootstrap leakage | Must be checked before PR, Done, or Block evidence. | `git status --short` and deny-path scan show no actual OpenClaw context files or `.openclaw/**` artifacts in the branch/evidence. | This lane plus runner preflight. |

## Required local verification

```bash
npm run check:team2-workerEta-stability-r7-risk-review
npm run check:layout
npm run check:no-diff-closeout-guidance
git status --short --ignored
```

## Closeout boundary

This lane may produce PR evidence for the matrix above. If later refreshed as no-change evidence, Done or Block comments must include the no-change rationale and the risk matrix summary. In either case, the safe aggregate state remains `NO-GO / Waiting`; do not claim production deployment-readiness, live canary authorization, terminal ACK/read receipt, broker OOM closure, or source-public/visibility approval from this validation alone.
