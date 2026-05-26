# A2A Round Coordinator Spec

> **Spec** for the coded broker polling and result collector slice of the A2A
> round coordinator. Defines the lifecycle states, cursor/backoff polling model,
> human finalizer boundary, approval-sensitive action gates, and safe transition
> path from human-polling to broker-side collection.
>
> **Lane issue:** [a2a-plane#467](https://github.com/jinwon-int/a2a-plane/issues/467)
> **Parent tracker:** [a2a-broker#927](https://github.com/jinwon-int/a2a-broker/issues/927)
> **Run:** `a2a-team1-round-coordinator-20260526T201140KST`
> **Lane owner:** nosuk (Team1)
> **Broker/finalizer of record:** `seoseo`

---

## 1. Purpose

Replace repeated human-driven broker polling and worker-result transcription with
a deterministic, source-controlled broker-side projection that collects round
state, classifies lane status (pending/running/succeeded/failed/stale/timeout),
and emits a review bundle that the human finalizer (`seoseo`) can act upon —
without performing any approval-sensitive action automatically.

## 2. Round coordinator lifecycle

The round coordinator manages the lifecycle of an A2A parent round from creation
through closeout-ready. It assumes the dispatch-wrapper creates the issues and
broker tasks; the coordinator tracks them.

### 2.1 States

```
                        ┌──────────┐
                        │  SEEDED  │ round manifest created, no tasks observed yet
                        └────┬─────┘
                             │ First task observation arrives
                             ▼
                        ┌──────────┐
                        │ TRACKING │ tasks dispatched, lanes being collected
                        └────┬─────┘
                             │
                    ┌────────┴────────┐
                    │                 │
                    ▼                 ▼
             ┌──────────┐     ┌────────────┐
             │ ALL_DONE  │     │ TIMED_OUT  │ deadline reached with incomplete lanes
             └─────┬─────┘     └──────┬─────┘
                   │                  │
                   ▼                  ▼
             ┌──────────┐     ┌────────────┐
             │ COLLECTED │     │ PARTIAL    │ some lanes done, some timed out
             └─────┬─────┘     └──────┬─────┘
                   │                  │
                   └──────┬──────────┘
                          ▼
                    ┌──────────┐
                    │  READY   │ finalizer-review bundle prepared; human reviews
                    └────┬─────┘
                         │ Seoseo performs final closeout via existing Go/No-Go matrix
                         ▼
                    ┌──────────┐
                    │ CLOSED   │ (terminal — managed by closeout reconciler)
                    └──────────┘
```

### 2.2 State transitions

| Transition | Condition | Action |
|---|---|---|
| SEEDED → TRACKING | First task observation for any expected worker | Start cursor, begin polling |
| TRACKING → ALL_DONE | All expected workers have terminal evidence | Stop polling, begin finalization |
| TRACKING → TIMED_OUT | Deadline reached, not all lanes terminal | Snapshot partial state |
| TRACKING → CONTINUE | Polling completes successfully; next cycle scheduled | Advance cursor, apply backoff |
| ALL_DONE → COLLECTED | All terminal evidence assembled and deduplicated | Generate closeout bundle |
| TIMED_OUT → PARTIAL | Some lanes terminal, some stuck/timeout | Include missing-lane notes |
| COLLECTED → READY | Closeout bundle emitted for human review | Set `readyForFinalizer: true` |
| PARTIAL → READY | Partial bundle emitted for human review | Set `readyForFinalizer: true`, add `partial: true` flag |
| READY → CLOSED | Seoseo executes closeout via Go/No-Go matrix | No automatic transition; coordinated externally |

### 2.3 Cursor-based polling

The coordinator uses an immutable cursor to track which task observations it has
already seen, avoiding re-processing and enabling idempotent replay.

**Cursor schema:**

```json
{
  "roundId": "a2a-team1-<descriptor>-<timestamp>",
  "cursor": "<offset-token or ISO timestamp>",
  "observedTaskIds": ["<task-uuid-1>", "<task-uuid-2>", ...],
  "observedAt": "<ISO-8601>"
}
```

**Cursor rules:**

- The cursor is advanced monotonically (never rewound).
- A new poll uses the last cursor timestamp to query `tasks?since=<cursor>`.
- New tasks beyond the cursor are appended to observedTaskIds.
- If the broker returns empty results, the cursor is not advanced (stays at same position).
- On service restart, the cursor is loaded from the last persisted checkpoint.

### 2.4 Backoff collector behavior

To avoid hammering the broker when no progress is expected, the collector uses
exponential backoff with jitter.

**Backoff parameters:**

| Parameter | Default | Notes |
|---|---|---|
| `initialIntervalMs` | 5_000 (5s) | First poll delay after TRACKING |
| `maxIntervalMs` | 300_000 (5 min) | Ceiling for backoff |
| `backoffFactor` | 2.0 | Each retry doubles the interval |
| `jitterRatio` | 0.2 | ±20% random jitter |
| `fastPollCount` | 3 | Number of fast polls before backoff starts |

**Backoff algorithm (pseudocode):**

```
poll_count = 0
interval = initialIntervalMs

loop:
  results = broker.queryTasks(since=cursor)
  if results.new_observations.length > 0:
    poll_count = 0  // reset on progress
    interval = initialIntervalMs
  else:
    poll_count += 1
    if poll_count > fastPollCount:
      interval = min(interval * backoffFactor, maxIntervalMs)
  
  sleep(interval * (1 + uniform(-jitterRatio, +jitterRatio)))
```

**When to stop polling:**
- All lanes terminal → transition to ALL_DONE immediately, stop polling.
- Deadline reached → transition to TIMED_OUT, stop polling.
- Operator explicitly cancels the round.

## 3. Collector: lane status classification

Each expected worker lane is classified into one of the following statuses based
on the most recent task observation and the round deadline.

### 3.1 Status definitions

| Status | Meaning | Trigger |
|---|---|---|
| `pending` | No observation yet, still within deadline | No task record, or task in `queued`/`claimed` |
| `running` | Active work, updated recently | Task status = `running`, age < stale threshold |
| `succeeded` | Completed with PR/Done/Block evidence | Task status = `succeeded`, evidence URL present |
| `failed` | Completed without acceptable evidence | Task status = `succeeded`, no evidence URL (missing-evidence) |
| `stale` | Last update exceeds stale threshold, not terminal | Age > `staleAfterMs`, status not terminal |
| `timeout` | Deadline passed, lane not terminal | Tick > deadline, status not PR/Done/Block/Cancelled |
| `cancelled` | Explicitly cancelled | Task cancelled or lane explicitly dropped |
| `blocked` | Task reported blocked or round blocked condition | Task status = `failed`/`blocked` with evidence, or projection blocked |

### 3.2 Classification priority

Classification is evaluated in order (first match wins):

1. Cancelled — if the lane or task is explicitly cancelled.
2. Blocked — if the terminal task has block evidence.
3. Timeout — if the deadline has passed and lane is not terminal.
4. Stale — if the last observation exceeds `staleAfterMs` and status is non-terminal.
5. Succeeded — if the task is terminal with evidence (PR/Done).
6. Failed — if the task is terminal without evidence.
7. Running — if the task is actively updating within stale threshold.
8. Pending — fallback (no observation, still within deadline).

### 3.3 Evidence requirements

Each successful lane must produce at least one of:

- `prUrl` — URL of the merged/created PR
- `doneCommentUrl` — URL of the Done comment on the issue
- `blockCommentUrl` — URL of the Block comment with explanation
- `branchUrl` — URL of the work branch (when PR is not yet created)

If a terminal lane lacks all of the above, it is classified as `failed`
(missing-evidence) and the closeout bundle flags it as needing operator attention.

## 4. Closeout bundle format

The collector emits a closeout bundle — a read-only JSON document — for the
human finalizer's review.

### 4.1 Bundle schema

```json
{
  "$schemaVersion": "a2a.round-coordinator.closeout-bundle.v1",
  "roundId": "a2a-team1-<descriptor>-<timestamp>",
  "generatedAt": "<ISO-8601>",
  "state": "READY",
  "partial": false,
  "parentIssueUrl": "https://github.com/jinwon-int/a2a-plane/issues/N",
  "deadline": "<ISO-8601>",
  "deadlineReached": false,
  "staleAfterMs": 1800000,
  "lanes": [
    {
      "order": 1,
      "worker": "bangtong",
      "repo": "jinwon-int/a2a-plane",
      "role": "broker",
      "status": "succeeded",
      "taskId": "task-uuid-1",
      "issueUrl": "https://github.com/jinwon-int/a2a-plane/issues/N",
      "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/449",
      "evidenceKind": "pr",
      "updatedAt": "<ISO-8601>",
      "ageMs": 120000,
      "summary": "Broker round manifest schema and storage",
      "risks": []
    }
  ],
  "summary": {
    "totalLanes": 4,
    "terminal": 3,
    "pending": 1,
    "failed": 0,
    "stale": 0,
    "timeout": 0,
    "blocked": 0,
    "cancelled": 0
  },
  "risks": [
    {
      "lane": 3,
      "severity": "info",
      "description": "Worker nosuk still running; last update 2 min ago."
    }
  ],
  "finalizerAction": {
    "required": true,
    "recommended": "REVIEW",
    "gates": {
      "allLanesTerminal": false,
      "deadlineRespected": true,
      "evidenceCompleteness": true,
      "noLiveActionLeak": true,
      "runtimeBootstrapHygiene": true,
      "seoseoFinalizerRequired": true
    }
  },
  "safetyConfirmation": {
    "noProductionDeploy": true,
    "noGatewayRestart": true,
    "noBrokerWorkerRestart": true,
    "noLiveProviderSend": true,
    "noDbMutation": true,
    "noTerminalAck": true,
    "noOutboxReplay": true,
    "noReleaseTagPublish": true,
    "noCredentialMovement": true,
    "noSecretDisclosure": true,
    "noVisibilityChange": true,
    "noHistoryRewrite": true,
    "noForcePush": true,
    "noAutomaticClose": true,
    "noAutomaticMerge": true,
    "noAutomaticApproval": true
  }
}
```

### 4.2 Bundle confidentiality

The closeout bundle may contain issue URLs, PR URLs, and worker identifiers.
It must never contain:

- Secret values, tokens, passwords, or API keys
- Provider identifiers (Telegram chat IDs, etc.)
- Host-specific private paths or IPs
- Raw session dumps or OpenClaw runtime context
- Personal information of operators or workers

## 5. Human finalizer boundary

The coordinator explicitly stops short of performing approval-sensitive actions.
The human finalizer (`seoseo`) retains exclusive control over:

### 5.1 Finalizer-owned actions

| Action | Finalizer Only | Notes |
|---|---|---|
| Post Go/No-Go decision on parent issue | Yes | Must use existing closeout go/no-go matrix |
| Close parent issue | Yes | Only `seoseo` may close |
| Review closeout bundle and approve retry | Yes | Operator comments override |
| Escalate blocked or unsafe conditions | Yes | Human judgment required |
| Override stale/timeout classification | Yes | Manual intervention path |

### 5.2 Coordinator-owned actions (safe to automate)

| Action | Automated | Notes |
|---|---|---|
| Query broker task state | Yes | Read-only, no mutation |
| Classify lane status | Yes | Deterministic, rule-based |
| Build closeout bundle | Yes | Read-only, no write |
| Advance cursor | Yes | No external side-effect |
| Apply backoff | Yes | Timer only, no external call |
| Detect deadline expiry | Yes | Clock-based, read-only |
| Flag missing evidence | Yes | Alert in bundle only |

## 6. Approval-sensitive action gates

The coordinator must refuse to perform (or must require a separate explicit
operator override for) the following actions.

### 6.1 Always-refused actions (no override)

These actions are never automated by the round coordinator under any configuration:

- Parent issue close
- PR merge
- Automatic approval or ACK
- Terminal-outbox ACK/replay
- Historical outbox replay
- Production database mutation, prune, or migration
- Gateway/broker/worker restart or reload
- Live provider/Telegram canary or notification
- Release, tag, or npm publish
- Credential movement or secret value disclosure
- Repository visibility change
- History rewrite or force-push

### 6.2 Override-gated actions (require explicit operator comment)

The coordinator may be adapted in future to support these, but only when:

1. An explicit operator comment on the parent issue names the specific action and scope.
2. A policy override flag is set in the round manifest.

These actions include:
- Posting a comment on a child lane issue (informational, not approval)
- Querying worker-origin repositories beyond the known roster
- Setting a longer deadline beyond the default maximum

## 7. Resource-aware worker policy

Each worker registered with the round coordinator carries capability and resource
policy metadata that the collector uses to interpret results correctly.

### 7.1 Worker capability fields

```json
{
  "workerId": "bangtong",
  "role": "broker",
  "maxConcurrency": 1,
  "allowedTaskTypes": ["propose_patch", "analyze", "verify"],
  "noLive": true,
  "noMutation": true,
  "lowPower": false,
  "mobileStandby": false,
  "defaultStaleAfterMs": 1800000,
  "defaultTimeoutMs": 7200000
}
```

### 7.2 Gongyung/Hermes — mobile standby profile

The Gongyung/Hermes worker is treated as a read-only evidence source by default:

```json
{
  "workerId": "gongyung",
  "role": "mobile-standby",
  "maxConcurrency": 1,
  "allowedTaskTypes": ["monitor", "notify"],
  "noLive": true,
  "noMutation": true,
  "lowPower": true,
  "mobileStandby": true,
  "defaultStaleAfterMs": 300000,
  "defaultTimeoutMs": 3600000
}
```

The coordinator treats mobile-standby lanes as advisory — their absence does not
block a round closeout, but their evidence is included for awareness.

### 7.3 Daegyo — Team2 worker candidate

Daegyo follows the same resource policy model as other Team1/Team2 workers:

```json
{
  "workerId": "daegyo",
  "role": "worker",
  "maxConcurrency": 1,
  "allowedTaskTypes": ["propose_patch", "analyze", "verify"],
  "noLive": true,
  "noMutation": true,
  "lowPower": false,
  "mobileStandby": false,
  "defaultStaleAfterMs": 1800000,
  "defaultTimeoutMs": 7200000
}
```

The coordinator does not distinguish Daegyo from other workers for lane tracking
and classification purposes.

## 8. Transition path: human polling → broker-side collection

This spec defines stage 1 of a multi-stage transition from fully human-polled
rounds to broker-side automated collection.

### 8.1 Stage 1: Coordinator-assisted (this spec)

| What | How |
|---|---|
| Round manifest | Created by human (via dispatch-wrapper or direct issue) |
| Broker task query | Automated cursor-based polling (read-only) |
| Lane classification | Deterministic rule-based classification |
| Closeout bundle | Automated JSON generation |
| Finalizer review | Human reads bundle, makes judgment |
| Closeout execution | Human via Go/No-Go matrix (existing process) |
| Source of truth | a2a-plane docs + broker state |

### 8.2 Stage 2: Coordinator-guided (future, not yet specified)

| What | How |
|---|---|
| Closeout comment draft | Auto-generated from bundle, human reviews and posts |
| Missing evidence alert | Proactive notification to human |
| Retry recommendation | Heuristic suggestion, human decides |
| Cross-team status | Aggregate view across Team1/Team2 rounds |

### 8.3 Stage 3: Coordinated closeout (future, requires explicit policy)

| What | How |
|---|---|
| Comment posting | Auto-post bundle summary when all safe (human opt-in) |
| Issue close | Only after separate operator approval (never default) |

### 8.4 Rollback path

If at any stage the automated collection produces incorrect results:

1. The human finalizer overrides by posting a correction comment on the parent issue.
2. The coordinator's cursor can be reset to a known-good checkpoint.
3. The closeout bundle is regenerated from scratch.
4. No data is mutated — the cursor checkpoint is the only mutable state.

## 9. Team1/Team2/cross-team examples

### 9.1 Team1 round (4 lanes, all succeeded)

```json
{
  "roundId": "a2a-team1-scheduler-dispatch-20260520T120000Z",
  "workers": ["bangtong", "sogyo", "nosuk", "yukson"],
  "deadline": "20260521T120000Z",
  "laneResults": {
    "bangtong": { "status": "succeeded", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/449" },
    "sogyo":   { "status": "succeeded", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/450" },
    "nosuk":   { "status": "succeeded", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/451" },
    "yukson":  { "status": "succeeded", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/452" }
  },
  "summary": {
    "decision": "READY",
    "terminalLanes": 4,
    "blockedLanes": 0,
    "finalizerAction": "REVIEW_AND_CLOSE"
  }
}
```

### 9.2 Team1 round with one stale lane

```json
{
  "roundId": "a2a-team1-round-coordinator-20260526T201140KST",
  "workers": ["bangtong", "sogyo", "nosuk", "yukson"],
  "deadline": "20260527T201140KST",
  "laneResults": {
    "bangtong": { "status": "succeeded", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/449" },
    "sogyo":   { "status": "succeeded", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/450" },
    "nosuk":   { "status": "running", "lastUpdate": "20260526T201140Z", "ageMs": 1800000 },
    "yukson":  { "status": "succeeded", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/452" }
  },
  "risks": [
    { "lane": 3, "worker": "nosuk", "severity": "warning", "description": "No update for 30 min (stale threshold exceeded)." }
  ],
  "summary": {
    "decision": "READY_PARTIAL",
    "terminalLanes": 3,
    "staleLanes": 1,
    "finalizerAction": "REVIEW_AND_DECIDE"
  }
}
```

### 9.3 Team2 round (cross-team example)

```json
{
  "roundId": "a2a-team2-hermes-integration-20260525T090000Z",
  "workers": ["soonwook", "gwakga", "gongyung"],
  "deadline": "20260526T090000Z",
  "laneResults": {
    "soonwook": { "status": "succeeded", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/440" },
    "gwakga":   { "status": "blocked", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/issues/441" },
    "gongyung": { "status": "succeeded", "evidenceUrl": null, "mobileStandby": true }
  },
  "risks": [
    { "lane": 2, "worker": "gwakga", "severity": "blocker", "description": "Cross-broker handoff blocked due to config mismatch." },
    { "lane": 3, "worker": "gongyung", "severity": "info", "description": "Mobile-standby lane: evidence advisory only." }
  ],
  "summary": {
    "decision": "BLOCKED",
    "terminalLanes": 2,
    "blockedLanes": 1,
    "finalizerAction": "ESCALATE_BLOCKER"
  }
}
```

### 9.4 Cross-team round (Team1 + Team2)

```json
{
  "roundId": "a2a-cross-team-terminal-brief-20260522T140000Z",
  "workers": ["bangtong", "sogyo", "soonwook", "gwakga"],
  "deadline": "20260524T140000Z",
  "laneResults": {
    "bangtong": { "status": "succeeded", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/445" },
    "sogyo":   { "status": "succeeded", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/446" },
    "soonwook": { "status": "timeout", "lastUpdate": "20260523T100000Z" },
    "gwakga":  { "status": "succeeded", "evidenceUrl": "https://github.com/jinwon-int/a2a-plane/pull/447" }
  },
  "risks": [
    { "lane": 3, "worker": "soonwook", "severity": "blocker", "description": "Team2 worker timed out before deadline." }
  ],
  "summary": {
    "decision": "READY_PARTIAL",
    "terminalLanes": 3,
    "timedOutLanes": 1,
    "finalizerAction": "DECIDE_RETRY_OR_CONTINUE"
  }
}
```

## 10. Interaction with existing components

### 10.1 Dispatch wrapper

The coordinator is downstream of the dispatch wrapper. The dispatch wrapper
creates the parent issue, child issues, and broker tasks. The coordinator
reads task state via the broker API; it does not create issues or tasks.

### 10.2 Closeout go/no-go matrix

The coordinator produces the `READY` state and closeout bundle. The existing
closeout go/no-go matrix (`a2a-parent-round-closeout-go-nogo`) consumes the
bundle and produces the final GO/NO_GO/BLOCKED decision. The coordinator does
not replace or duplicate the matrix — it feeds it.

### 10.3 Round closeout reconciler

The reconciler (`packages/broker/src/github/round-closeout-reconcile.ts`) can
also consume coordinator-produced closeout bundles for its reconciliation
classifications, but does not require them. The reconciler and coordinator are
complementary: the reconciler classifies past state; the coordinator manages
in-progress collection.

### 10.4 Broker task state

The coordinator queries the broker's `/tasks` endpoint (or equivalent store)
with a `since` cursor parameter. It does not write task state, mutate tasks,
or manage task lifecycle beyond observation.

## 11. Source-only / no-live declaration

This spec defines a **source-only / no-live-impact** component. All coordinator
operations are read-only (querying task state, classifying lanes, building
bundles) or timer-only (backoff, deadline detection). The coordinator does not
write to GitHub, send live provider messages, mutate broker state, or execute
approval-sensitive actions.

Any future extension that adds write operations requires explicit operator
approval and a separate spec update.

## 12. Safety confirmation

| Property | Value |
|---|---|
| Source-only / no-live | Yes |
| No production deploy or restart | Yes |
| No broker/worker/Gateway restart | Yes |
| No live provider/Telegram send | Yes |
| No production DB mutation | Yes |
| No terminal-outbox ACK or replay | Yes |
| No release/tag/npm publish | Yes |
| No credential movement or disclosure | Yes |
| No repository visibility change | Yes |
| No history rewrite or force-push | Yes |
| No automatic issue close | Yes |
| No automatic PR merge | Yes |
| No automatic approval | Yes |
| Seoseo retains finalizer authority | Yes |

## 13. Related documents

- [Round coordinator operator runbook](./runbook.md)
- [Round coordinator schema](./schema.json)
- [Parent-round closeout go/no-go runbook](../a2a-parent-round-closeout-go-nogo/runbook.md)
- [Team1 dispatch-wrapper runbook](../a2a-team1-dispatch-wrapper/runbook.md)
- [Scheduler control tower](../a2a-scheduler-control-tower/spec.md)
- [Round closeout reconciler](../../../packages/broker/src/github/round-closeout-reconcile.ts)
- [Task lifecycle contract](../../../contracts/a2a/task-lifecycle.md)
- [Terminal semantics contract](../../../contracts/a2a/terminal-semantics.md)
- [Broker handoff protocol](../../../contracts/a2a/broker-handoff-protocol.md)
- [Evidence projection contract](../../../contracts/a2a/github-evidence-projection.md)
