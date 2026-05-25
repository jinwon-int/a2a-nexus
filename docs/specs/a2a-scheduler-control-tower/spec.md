# Scheduler / Control Tower: Worker Capacity, Dry-Run, and Assignment Policy

> **R34 (2026-05-25):** This spec defines the A2A scheduler/control-tower policy slice for
> capacity-aware worker assignment, dry-run acceptance, libero/validator role routing,
> stuck/backoff safety gates, and source-only activation boundaries.
>
> Companion contracts: [Worker Registration](../contracts/a2a/worker-registration.md),
> [Worker Capability Profile](../contracts/a2a/worker-capability-profile.md),
> [Task Lifecycle](../contracts/a2a/task-lifecycle.md),
> [Broker Handoff Protocol](../contracts/a2a/broker-handoff-protocol.md).
>
> Parent roadmap: [#434](https://github.com/jinwon-int/a2a-plane/issues/434)
> Assigned issue: [#448](https://github.com/jinwon-int/a2a-plane/issues/448)

---

## Problem

The A2A fleet has multiple live workers across three broker lanes (Team1 Seoseo, Team2 Gwakga, and
cross-broker handoff). The next operational bottleneck is no longer whether a worker can connect; it
is whether the broker can safely allocate work without overloading a node, leaving tasks stuck, or
bypassing validation gates. Operators currently lack deterministic, test-covered policies for:

1. **Capacity-aware assignment** — how many tasks a worker can handle concurrently, and what happens
   when a worker signals pressure.
2. **Scheduler dry-run** — how to preview what the broker would do without mutating state.
3. **Libero/validator routing** — which workers should handle validation-heavy or inspection-heavy
   tasks that require explicit cross-check before merge.
4. **Stuck/backoff safety** — when a task is considered stuck, how long to back off, and when to
   escalate.
5. **Source-only activation** — how to test and verify scheduler policy changes using only
   repository source/docs/tests, without touching live infrastructure.

## Scope

### In scope

- Worker capacity model: concurrency limits, pressure classes, queue depth semantics.
- Scheduler assignment algorithm: selection heuristics, preference ordering, recommendation
  explanations.
- Dry-run acceptance criteria: deterministic no-mutation preview with GO/NO-GO gates.
- Libero/validator role assignment rules: which workload strengths map to validation duties,
  and how the scheduler distinguishes libero tasks from execution tasks.
- Stuck/backoff safety gates: stale thresholds, retry budgets, backoff schedules, escalation
  paths.
- Source-only activation boundaries: what constitutes a source-only change and what preconditions
  must hold before a scheduler policy is live.
- Cross-check of the three broker lanes (Team1 Seoseo, Team2 Gwakga, cross-broker handoff).

### Out of scope

- Production deploy, Gateway/broker/worker restart or reload, live canary, or provider/Telegram
  send — these require separate explicit operator approval.
- Production DB mutation, prune, migration, or replay — not authorized by this spec.
- Manual Terminal Brief ACK or replay — not authorized by this spec.
- Historical outbox replay — not authorized by this spec.
- Automatic dispatch policy activation — the scheduler spec defines criteria, but activation
  remains an operator-controlled gate.
- Release/tag/npm publish — not authorized by this spec.
- Credential movement or secret value disclosure — not authorized by this spec.
- Repository visibility change or history rewrite — not authorized by this spec.
- Force-push — not authorized by this spec.
- Issue close/finalizer comment execution or PR merge — not authorized by this spec without
  separate explicit operator approval.

---

## 1. Worker Capacity Semantics

### 1.1 Capacity Profile Extensions

The [Worker Capability Profile](../contracts/a2a/worker-capability-profile.md) defines
`maxConcurrentTasks`, pressure classes, and workload strengths. This section extends those
fields with scheduler-specific capacity dimensions.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxConcurrentTasks` | `number` | `1` | Maximum concurrent tasks the worker can handle (inherited from Capability Profile). |
| `softConcurrencyLimit` | `number` | `maxConcurrentTasks - 1` | Threshold at which the scheduler emits a capacity-warning trace but still assigns a task. Below this limit, assignment is preferred; at or above it, the scheduler deprioritizes the worker unless no alternative exists. |
| `queueDepth` | `number` | `0` | Number of tasks currently queued for this worker (read-only). The scheduler should not count queued tasks toward `maxConcurrentTasks` unless the worker's `queueCapacityClass` is `critical`. |
| `queueCapacityClass` | `string` | `normal` | Queue depth class: `normal` (depth ≤ maxConcurrentTasks), `elevated` (depth ≤ 2× maxConcurrentTasks), `high` (depth ≤ 4× maxConcurrentTasks), `critical` (depth > 4× maxConcurrentTasks). When `critical`, the scheduler SHOULD stop queuing new tasks for this worker. |
| `capacityScore` | `number` | `1.0` | Composite score derived from memory pressure, storage pressure, Docker cache pressure, and recent timeout frequency. Range 0.0 (critical) to 1.0 (healthy). Internal scheduler signal; not exposed to the worker registration API. |

### 1.2 Capacity Scoring

The scheduler computes a composite `capacityScore` for each worker based on its last published
profile:

```
capacityScore = w_memory × w_storage × w_docker × w_timeout × w_recentTasks
```

Where each weight is derived from the corresponding pressure class:

| Pressure Class | Weight |
| --- | --- |
| `low` / `none` / `healthy` | 1.0 |
| `moderate` / `rare` / `degraded` | 0.8 |
| `high` / `frequent` / `unhealthy` | 0.5 |
| `critical` / `unknown` | 0.2 |

If a pressure class is unknown or absent, the scheduler uses 0.5 (conservative).

The resulting `capacityScore` drives scheduling tiers:

| Score Range | Scheduling Tier | Behavior |
| --- | --- | --- |
| 0.8–1.0 | Green | Full assignment eligibility. |
| 0.5–0.8 | Yellow | Eligible but deprioritized; task latency expected to increase. |
| 0.2–0.5 | Orange | Eligible only for low-resource workloads (docs, evidence, inspection). Heavy workloads (build-test, code-patch) blocked. |
| 0.0–0.2 | Red | No new assignments until profile refreshes above threshold. |

### 1.3 Rebalance Trigger Conditions

The scheduler re-evaluates worker capacity and may rebalance queued tasks when any of the following
occur:

1. A worker publishes an updated capability profile (via registration or periodic refresh).
2. A new worker registers for a workload type that has queued tasks.
3. A task completes on a worker, freeing capacity below `softConcurrencyLimit`.
4. A worker's stale profile transitions from stale-warning to stale-expired.
5. A stuck detection fires for an assigned task (see §4).

Rebalancing re-runs the assignment algorithm for queued tasks only. It does not preempt running
tasks or cancel claimed tasks.

### 1.4 Capacity Evidence in Terminal Briefs

When the scheduler identifies capacity as a contributing factor in task completion or blocking, the
Terminal Brief phrasing follows the conventions defined in
[Worker Capability Profile § "Capacity-Limited Slow Lane Phrasing"](../contracts/a2a/worker-capability-profile.md#capacity-limited-slow-lane-phrasing-in-terminal-brief--closeout-reports).

---

## 2. Scheduler Dry-Run Acceptance Criteria

A scheduler dry-run is a no-mutation preview of the assignment algorithm. It produces an
evidence packet containing the candidate assignments, the `recommendationReason` for each, and
any capacity or blocking signals. The dry-run must pass all acceptance criteria before the
operator considers live activation.

### 2.1 Dry-Run Evidence Packet

```
{
  "kind": "a2a.scheduler-dryrun-report",
  "runId": "<run-identifier>",
  "timestamp": "<ISO-8601>",
  "mode": "dry-run",
  "failClosed": true,
  "defaultDecision": "NO-GO",
  "workers": [
    {
      "workerName": "<name>",
      "capacityScore": 0.85,
      "schedulingTier": "green",
      "queuedTasks": 2,
      "runningTasks": 1,
      "recommendation": "preferred"
    }
  ],
  "gates": { /* see §2.2 */ },
  "decision": "GO" | "NO-GO",
  "sourcePublicExecution": "NO-GO"
}
```

### 2.2 Mandatory DRY-RUN Gates

Every scheduler dry-run report must evaluate these gates. All gates must be GO for the dry-run
to return a GO decision. The default decision is always NO-GO.

| Gate ID | Description | GO Condition |
| --- | --- | --- |
| `brokerCapacityReadiness` | Broker has capacity data for each known worker. | At least one worker with non-stale profile; all expected workers have non-expired profiles. |
| `assignmentDeterminism` | Identical input produces identical output. | Two runs with the same worker profiles and queue state return the same recommendations. |
| `staleProfileBoundary` | No assignment relies on a stale-expired profile. | All workers used in recommendations have profiles within `staleProfileHardTimeoutMs`. |
| `capacityBoundaryRespected` | No worker is assigned more tasks than `maxConcurrentTasks`. | Every recommendation respects soft/hard concurrency limits. |
| `noMutationEvidence` | No state was mutated during the dry-run. | Evidence packet includes a `noMutationHash` proving no DB, queue, or assignment side effects. |
| `recommendationReasonPresent` | Every recommendation has a reason string. | All `recommendationReason` fields are non-empty. |
| `replayIdempotent` | Identical dry-run with same input yields identical output and no state leak. | Two consecutive dry-runs produce identical evidence packets. |
| `sourcePublicExecution` | Source-only execution boundary respected. | Dry-run mode is not `live`/`execute`; `sourcePublicExecution` is `NO-GO`. |

### 2.3 Dry-Run Exit Paths

| Decision | Meaning | Next steps |
| --- | --- | --- |
| `GO` | All gates pass; the scheduler assignment is valid for the current state. | Operator may proceed to simulate or execute mode with separate approval. |
| `NO-GO` | One or more gates failed. | Fix the failing gate and re-run the dry-run. Fail-closed: no live actions proceed. |
| `BLOCKED` | Evidence packet is incomplete, profiles are too stale, or the dry-run itself detected a safety issue. | Operator intervention required; do not re-run until the block is resolved. |

### 2.4 Dry-Run → Simulate → Execute Progression

Source-only scheduler changes follow a three-stage activation pipeline:

1. **Dry-run** (no mutation): produces the evidence packet above. All gates must pass.
2. **Simulate** (read-only with live reflection): the scheduler evaluates live worker profiles
   and queue state but still does not mutate assignment state. Produces a simulate report.
3. **Execute** (live assignment): operator-approved activation that applies the scheduler
   policy to live task dispatch.

Each stage requires explicit operator approval for the next. Stage evidence builds on the
previous; simulate cannot skip a failing dry-run.

---

## 3. Libero / Validator Assignment Rules

Libero and validator tasks are distinct from execution tasks. The scheduler must distinguish them
and route them to appropriate workers.

### 3.1 Role Definitions

- **Execution task**: a task that produces a patch, evidence, documentation, or fixture change.
  Carries workload strengths such as `code-patch`, `build-test`, `docs-evidence`, or `fixtures`.
- **Libero task**: a task that cross-checks, validates, or reviews the output of an execution task
  or a set of execution tasks. Carries workload strengths `validation-libero` or `inspection`.
  Libero tasks may originate from the broker, a handoff, or a validation gate.
- **Validator task**: a libero-like task that performs structured conformance checks against
  a contract or fixture specification. Carries workload strength `validation-libero` with
  a `validatorMode` hint.

### 3.2 Assignment Rules

| Rule | Description |
| --- | --- |
| **Same-team preference** | A libero/validator task SHOULD be assigned to a worker on the same team as the execution task it validates, unless the team lacks a libero-qualified worker. |
| **Cross-team mandatory** | If the execution task involved cross-broker handoff, the libero/validator MUST be assigned to the destination broker's team, not the source broker's team. |
| **Execution-worker exclusion** | A worker that produced the execution output MUST NOT serve as the libero/validator for the same task or a sibling task in the same round. The scheduler must reject self-validation. |
| **Capacity check** | Libero/validator workers must have `workloadStrengths` including `validation-libero` and a `capacityScore` ≥ 0.5 (yellow tier or better). |
| **Explicit override** | An operator may override the libero/validator assignment, but the override must be recorded in the assignment evidence and include a reason. |

### 3.3 Validation Assertions

Each libero or validator assignment must include these assertions in the recommendation evidence:

- `liberoWorkerName`: the selected libero worker.
- `executionWorkerName`: the worker that produced the execution task output.
- `sameTeam`: whether the libero and execution workers share a team.
- `selfValidationBlocked`: whether self-validation was detected and blocked (must be `true` or `not-applicable`).
- `capacityQualified`: whether the libero worker passed the capacity check.
- `overrideReason`: present only when an operator override was used.

---

## 4. Stuck / Backoff Safety Gates

Tasks that fail to make progress within expected bounds must be detected and handled
deterministically.

### 4.1 Stuck Detection

A task is considered **stuck** when it remains in the `running` state for longer than
`stuckTimeoutMs` without producing any terminal evidence (PR, Done, Block) and without any
detectable output in the last `stuckActivityWindowMs`.

| Parameter | Recommended Default | Description |
| --- | --- | --- |
| `stuckTimeoutMs` | 1 800 000 (30 min) | Wall-clock time since state transitioned to `running`. |
| `stuckActivityWindowMs` | 600 000 (10 min) | Time since last detectable activity (log output, status pings, progress evidence). |
| `stuckCheckIntervalMs` | 300 000 (5 min) | How often the scheduler checks for stuck tasks. |

### 4.2 Backoff Schedule

When a task is detected as stuck or fails, the scheduler applies a backoff before reassigning:

| Consecutive Failure Count | Backoff Duration | Action |
| --- | --- | --- |
| 1 | 60 000 ms (1 min) | Re-queue with backoff annotation. |
| 2 | 300 000 ms (5 min) | Re-queue; emit `retry-warning` trace. |
| 3 | 1 800 000 ms (30 min) | Re-queue; block the same worker from the same task. |
| 4 | 7 200 000 ms (2 h) | Re-queue; emit `retry-escalation` trace; notify operator. |
| 5+ | BLOCKED | No further retry. Task transitions to `blocked` with reason `max-retries-exceeded`. Operator intervention required. |

### 4.3 Worker-Level Stuck Throttle

In addition to per-task backoff, the scheduler maintains a worker-level stuck counter:

| Consecutive Stuck Tasks (any task on same worker) | Throttle Action |
| --- | --- |
| 1–2 | Warning trace; no throttle. |
| 3 | Deprioritize worker for 10 min. |
| 5 | Deprioritize worker for 60 min. |
| 10 | Block new assignments to the worker; operator review required. |

The worker-level stuck counter resets when the worker produces a successful terminal outcome
(PR or Done).

### 4.4 Escalation Path

If a stuck task reaches `max-retries-exceeded` or a worker is blocked for 10+ consecutive stuck
tasks:

1. The scheduler transitions the task to `blocked` with reason `stuck-escalation` and a
   reference to the stuck-detection evidence.
2. The scheduler emits an operator-visible notification (via the broker's notification channel,
   not a live provider send).
3. The operator reviews the stuck evidence and decides: re-queue, reassign, cancel, or
   override the safety gate.

---

## 5. Source-Only Activation Boundaries

Scheduler policy changes to the A2A Plane repository (source/docs/tests only) must obey the
following activation boundaries.

### 5.1 What Constitutes a Source-Only Change

A source-only change is any change limited to:

- `docs/` — documentation, spec, validation matrices, runbooks
- `contracts/` — policy and specification contracts (no implementation code)
- `scripts/` — test scripts, validation tools, scanner logic (read-only by design)
- Root metadata files: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODEOWNERS`,
  `CHANGELOG.md`, `LICENSE`
- `.github/` — issue templates, CI configuration, PR templates
- `examples/`, `fixtures/` — examples, fixture data, conformance fixtures

### 5.2 What Is NOT Source-Only

A change that touches any of these is NOT source-only and requires the full Simulate → Execute
pipeline plus separate operator approval:

- `packages/broker/` — broker runtime code
- `packages/openclaw-plugin-a2a/` — OpenClaw plugin runtime code
- `packages/docker-runner/` — Docker runner runtime code
- Live infrastructure configuration (gateway, channel, provider, credential wiring)
- Repository visibility metadata or secret store
- Database schemas or migration files

### 5.3 Preconditions for Activation

Before a source-only scheduler policy change can be considered ready for live activation, all of
these must hold:

1. **Dry-run passes**: the scheduler spec dry-run (see §2) returns GO on a representative
   evidence packet.
2. **Validation tests pass**: all relevant `check-*` test scripts pass in CI or local run.
3. **Libero cross-check passes**: a libero/validator lane has reviewed and approved the policy
   change (see §6 validation matrix).
4. **No stale profile dependencies**: no worker used in the policy's recommended assignments
   has a stale-expired profile.
5. **Capacity boundary tested**: the policy has been tested against a fixture with at least one
   worker at each capacity tier (green, yellow, orange, red).
6. **Operator approval recorded**: explicit operator approval for the live activation is
   recorded as a separate evidence entry, distinct from the dry-run or validation output.

### 5.4 Source-Only Activation Is Always NO-GO

Until all preconditions in §5.3 are met, and **operator approval is recorded separately**,
source-only execution remains **NO-GO**. No scheduler policy change in `docs/` or `contracts/`
alone authorizes live dispatch, broker capacity mutation, queue manipulation, or terminal state
changes.

---

## 6. Three-Broker Lane Cross-Check

### 6.1 Lane Summary

| Broker Lane | Broker ID | Team | Primary Role | Worker Examples |
| --- | --- | --- | --- | --- |
| Team1 Seoseo | `seoseo` | Team1 | Primary A2A broker; owns scheduler/capacity model and terminal-brief routing. | bangtong, nosuk, sogyo, yukson |
| Team2 Gwakga | `gwakga` | Team2 | Cross-team broker; receives handoffs and manages Team2 worker pool. | soonwook |
| Cross-broker Handoff | (dual) | Team1→Team2 | Handoff protocol bridge; relay tasks between brokers without cross-worker attachment. | (no workers; peers only) |

### 6.2 Cross-Check Findings

| Dimension | Team1 Seoseo | Team2 Gwakga | Cross-broker Handoff | Libero Decision |
| --- | --- | --- | --- | --- |
| Worker capacity profile schema | Defined in `contracts/a2a/worker-capability-profile.md`; Team1 workers publish profiles. | Not yet published; Team2 uses default heuristics. | N/A — brokers do not register each other as workers. | Team1 capacity model is sufficient for spec. Team2 can adopt later. |
| Libero/validator routing | Team1 has libero-qualified workers (yukson) with `validation-libero` strength. | Team2 libero evidence is sparse (`check-team2-*` scripts exist but no dedicated libero worker). | Handoff recipient team's libero rules apply per §3.2. | Cross-team libero assignment is defined and testable. Team2 adoption deferred. |
| Stuck/backoff handling | Stuck detection gaps exist at the scheduler level; individual workers self-report timeouts. | Similar gap; Team2 relies on broker-level retry semantics. | Handoff protocol does not define stuck escalation for relayed tasks. | Scheduler-level stuck/backoff gates (§4) fill the gap. Handoff stuck escalation needs follow-up spec. |
| Capacity-limited slow lane phrasing | Supported in capability profile contract. | Not yet adopted. | Terminal evidence relay in handoff should preserve capacity annotations. | Adopt across all three lanes in next round. |
| Source-only activation | Specified in §5 of this document. | Separate activation path may be needed for Team2-specific changes. | Handoff protocol changes are not source-only; they require full simulate pipeline. | Consistent with existing Team1 activation boundaries. |
| Dry-run capability | `scripts/a2a-source-dryrun-aggregator.mjs` and orchestrator exist. | Team2 has no independent dry-run tooling. | N/A. | Team1 dry-run tooling is sufficient for spec validation. Team2 may adopt or remain default. |

### 6.3 Integration Risks

1. **Team2 capacity model gap**: Team2 workers do not publish capability profiles. The scheduler
   must use conservative defaults (`maxConcurrentTasks=1`, `capacityScore=0.5`) for unknown
   workers. This is safe but suboptimal. Team2 should adopt the capability profile contract
   before cross-team capacity-aware scheduling is enabled.
2. **Handoff stuck escalation**: The broker handoff protocol does not define what happens when a
   relayed task is stuck. The handoff status model has `timed_out` but no stuck-detection
   escalation path. This spec defines the scheduler-level gates; the handoff contract should
   be extended separately to handle stuck escalations.
3. **Libero availability**: If the only libero-qualified worker on the destination team is
   unavailable or capacity-constrained, the scheduler must fall back to an execution worker or
   block the task. The fallback behavior should be explicitly documented before cross-team
   libero routing is enabled.

### 6.4 Recommendation

- **Merge this spec** into the A2A Plane `main` branch as a contract/spec reference.
- **Defer Team2 capacity profile adoption** to a follow-up issue; the spec is forward-compatible.
- **File a follow-up issue** for handoff stuck escalation handling in the broker handoff protocol.
- **File a follow-up issue** for libero fallback behavior when the preferred libero worker is
   unavailable.

---

## 7. Safety and Approval Boundaries

### 7.1 Secrets and Private Data

This spec references only public-safe worker names (`bangtong`, `nosuk`, `sogyo`, `yukson`,
`soonwook`, `gwakga`, `seoseo`) and public GitHub issue/PR identifiers. It does not contain
host names, IP addresses, file system paths, provider tokens, API keys, credentials, or
private topology information.

### 7.2 Human Approval Required For

- [ ] Production deploy, Gateway/broker/worker restart or reload
- [ ] Live canary, provider/Telegram send, or terminal-outbox ACK
- [ ] Production DB mutation, prune, migration, or replay
- [ ] Manual Terminal Brief ACK or replay
- [ ] Historical outbox replay
- [ ] Automatic dispatch policy activation
- [ ] Release/tag/npm publish
- [ ] Credential movement or secret value disclosure
- [ ] Repository visibility change or history rewrite
- [ ] Force-push
- [ ] Issue close/finalizer comment execution or PR merge
- [x] **None of the above**

### 7.3 Broker Foreground Liveness

This spec is a documentation-only change. It does not involve broker foreground sessions,
subagent dispatch, TaskFlow execution, or live worker interaction. All content is static
policy text.

---

## 8. Evidence Contract

This spec document itself is the primary evidence. Validation evidence is produced by the
companion validation matrix at
`docs/validation/team1-yukson-scheduler-control-tower-libero.md`.

| Artifact | Path |
| --- | --- |
| Spec | `docs/specs/a2a-scheduler-control-tower/spec.md` |
| Validation matrix | `docs/validation/team1-yukson-scheduler-control-tower-libero.md` |
| Parent roadmap | [#434](https://github.com/jinwon-int/a2a-plane/issues/434) |
| Assigned issue | [#448](https://github.com/jinwon-int/a2a-plane/issues/448) |

## 9. Rollback / Failure Handling

- **What indicates failure?** The spec is documentation only; no runtime state is mutated.
  Failure would be a rejected PR or a found contradiction with existing contracts during review.
- **What state must be restored?** None. The PR branch is the only delta; revert the branch or
  close the PR without merging.
- **What cleanup is safe without additional approval?** Branch deletion, PR close, or revert
  commit.
- **What cleanup requires fresh approval?** None. No production state was touched.

## 10. Wiki / Runbook Follow-Up

This spec documents reusable operating knowledge for scheduler capacity, assignment, and
activation. Follow-up tasks:

- [ ] File a handoff stuck escalation issue (cross-reference §6.3 caveat 2).
- [ ] File a libero fallback behavior issue (cross-reference §6.3 caveat 3).
- [ ] Add a checklist entry in the compatibility matrix for Team2 capacity profile adoption.
