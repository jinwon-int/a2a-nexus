# A2A Goal Mode Lifecycle Contract (v0 Draft)

> **v0 Draft (2026-05-25):** This contract defines the durable goal object schema,
> lifecycle states, approval gates, planner loop contract, idempotency/resume behavior,
> and worker evidence format for A2A Goal Mode. It is a companion to the
> [task lifecycle](./task-lifecycle.md) and [terminal semantics](./terminal-semantics.md)
> contracts.
>
> **Status:** Design draft. No runtime automation is enabled. Broker implementation
> must add a separate v0→v1 compatibility plan before any production use.
>
> **Lane issue:** [a2a-plane#442](https://github.com/jinwon-int/a2a-plane/issues/442)
> **Broker/finalizer of record:** `seoseo`

---

## 1. Durable Goal Object Schema

A goal run is identified by a `goalRunId` and carries a frozen-at-creation objective
descriptor plus mutable runtime state. The schema is designed for append-only mutation
of the event log and safe snapshot-based resume.

### 1.1 Top-level fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `goalRunId` | `string` | yes | Stable unique identifier. Format: `a2a-goal-<descriptor>-<utc-timestamp>`. |
| `schemaVersion` | `string` | yes | Schema version identifier. Must be `a2a.goal-mode.v1`. |
| `objective` | `object` | yes | Immutable objective descriptor (see §1.2). |
| `state` | `string` | yes | Current lifecycle state. One of the values in §2. |
| `stateHistory` | `StateEntry[]` | yes | Ordered append-only list of state transitions. |
| `eventLog` | `EventEntry[]` | yes | Append-only ordered event log. |
| `planner` | `object` | yes | Planner loop state (see §4). |
| `evidence` | `EvidenceEntry[]` | yes | Collected worker evidence entries (see §6). |
| `approvalGates` | `ApprovalGate[]` | yes | Detected and surfaced approval gates (see §3). |
| `idempotencyKey` | `string` | yes | Goal creation idempotency key. Stable across retries. |
| `createdAt` | `string` (ISO-8601) | yes | Goal creation timestamp. |
| `updatedAt` | `string` (ISO-8601) | yes | Last mutation timestamp. |
| `completedAt` | `string` (ISO-8601) | no | Terminal state timestamp. |

### 1.2 Objective descriptor (`objective`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | yes | Short human-readable goal name. |
| `description` | `string` | yes | Concise objective statement. |
| `scope` | `object` | yes | Work area constraints (see below). |
| `successCriteria` | `string[]` | yes | Measurable success criteria. |
| `evidenceRequirements` | `string[]` | yes | Types of evidence each slice must produce. |
| `budgetLimits` | `object` | yes | Budget and safety limits (see below). |
| `operatorControls` | `string[]` | yes | Available control actions. |

### 1.3 Scope sub-object (`objective.scope`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repos` | `string[]` | no | Allowed GitHub repositories (`org/repo`). |
| `allowedWorkAreas` | `string[]` | yes | Allowed work types (see §6.1). |
| `forbiddenActions` | `string[]` | yes | Explicitly forbidden actions (see §3). |

### 1.4 Budget and safety limits (`objective.budgetLimits`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxConcurrentWorkers` | `number` | no | Maximum concurrent dispatched tasks. Default: 1. |
| `maxRuntimeSecondsPerSlice` | `number` | no | Maximum wall-clock time per dispatched task. |
| `maxTotalSlices` | `number` | no | Maximum plan-dispatch-collect cycles. |
| `retryPolicy` | `object` | no | Retry/backoff config (see §5.3). |
| `staleDetectionSeconds` | `number` | no | Seconds of no progress before stale detection. Default: 3600. |

### 1.5 State entry (`stateHistory[]`)

| Field | Type | Description |
| --- | --- | --- |
| `previousState` | `string` | State before the transition. |
| `newState` | `string` | State after the transition. |
| `transitionReason` | `string` | Why the transition occurred. |
| `timestamp` | `string` (ISO-8601) | When the transition occurred. |
| `triggeredBy` | `string` | What triggered it: `planner`, `operator`, `worker`, `system`. |

### 1.6 Event entry (`eventLog[]`)

| Field | Type | Description |
| --- | --- | --- |
| `eventId` | `string` | Unique event id within this goal run. |
| `eventType` | `string` | Event type: `plan`, `dispatch`, `evidence_collected`, `approval_gate_detected`, `approval_granted`, `replan`, `pause`, `resume`, `cancel`, `block`, `complete`. |
| `summary` | `string` | Human-readable one-line summary. |
| `details` | `object` | Structured details (event-type-specific). |
| `timestamp` | `string` (ISO-8601) | When the event was recorded. |

The event log is append-only. No entry is ever deleted or modified after creation.
This provides auditability for reconstructing why each next action was chosen.

### 1.7 Evidence entry (`evidence[]`)

See §6 for the full evidence format.

### 1.8 Approval gate entry (`approvalGates[]`)

See §3 for the full approval gate format.

### 1.9 Forbidden state content

The goal object must never contain:

- Secret values, tokens, passwords, or API keys.
- Provider identifiers (Telegram chat IDs, worker host names, private endpoints).
- Host-specific private paths or IP addresses.
- Raw session dumps or OpenClaw runtime context.
- Raw command stdout/stderr output.
- Broker edge secrets or Gateway auth tokens.
- Runtime/bootstrap context file names (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`,
  `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`).

---

## 2. Lifecycle States

### 2.1 State machine

```text
                  ┌─────────────────────────────────────────────┐
                  │                                             │
                  v                                             │
┌────────┐   ┌──────────┐   ┌────────────┐   ┌──────────────┐  │
│  idle  │──>│ planning │──>│dispatching │──>│collecting     │  │
└────────┘   └──────────┘   └────────────┘   │evidence      │  │
                  ^                           └──────┬───────┘  │
                  │                                  │          │
                  └──────────────────────────────────┘          │
                        (re-plan after evidence)                │
                                                                 │
              ┌────────────────────┬────────────────┬────────────┘
              │                    │                │
              v                    v                v
       ┌────────────┐      ┌───────────┐      ┌──────────┐
       │awaiting    │      │ blocked   │      │completed │
       │approval    │      └───────────┘      └──────────┘
       └─────┬──────┘
             │                    ┌───────────┐
             ├───> (resume) ─────>│ planning  │ (re-enter planning)
             │                    └───────────┘
             v
       ┌───────────┐
       │ cancelled │
       └───────────┘
```

### 2.2 State definitions

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `idle` | Goal created. No planning has started. | `planning`, `blocked`, `cancelled` |
| `planning` | Planner loop is active: reading state, deciding next tasks. | `dispatching`, `awaiting_approval`, `blocked`, `cancelled` |
| `dispatching` | One or more bounded A2A tasks are being dispatched to workers. | `collecting_evidence`, `awaiting_approval`, `blocked`, `cancelled` |
| `collecting_evidence` | Workers are running or have reported evidence. Awaiting all dispatched slices to terminal. | `planning`, `awaiting_approval`, `blocked`, `cancelled`, `completed` |
| `awaiting_approval` | An approval-gated action was detected. Paused until operator decision. | `planning` (if approved or rejected-safe-resume), `cancelled`, `blocked` |
| `blocked` | Goal cannot continue due to an unrecoverable condition. | `cancelled`, `idle` (only if operator force-resets) |
| `completed` | All success criteria met. Terminal. | none |
| `cancelled` | Explicitly cancelled by operator. Terminal. | none |

### 2.3 Transition rules

- **`planning` → `dispatching`**: The planner has decided one or more bounded tasks.
  Each task carries the `goalRunId` and a unique `sliceId`. The `eventLog` records
  the plan decision and the set of slice IDs.

- **`dispatching` → `collecting_evidence`**: All dispatched slices have been accepted
  by an A2A worker (reached `claimed` state). Slices that fail dispatch (rejected,
  no worker available) transition back to `planning` for re-planning.

- **`collecting_evidence` → `planning`**: All dispatched slices have terminal evidence
  (done, pr, or blocked). The planner re-evaluates the objective and decides the next
  iteration: either more slices (continue) or completion.

- **Any state → `blocked`**: The goal state, planner input, worker evidence, or broker
  health indicates an unrecoverable condition: stale workers, permission failure,
  unresolvable evidence gap, or unfixable goal state corruption.

- **Any non-terminal state → `cancelled`**: Operator explicit cancellation.
  The `eventLog` records the cancellation source and any partial evidence.

- **`collecting_evidence` → `completed`**: The planner determines all success criteria
  are met. No further slices are needed. Terminal.

- **`awaiting_approval` → `planning`**: The operator has explicitly approved the
  requested action, or has explicitly declined with a safe-resume directive that
  allows re-planning around the blocked action.

### 2.4 State vs. time

A goal that remains in `planning` or `dispatching` beyond `staleDetectionSeconds`
without any progress logged in `eventLog` should be flagged as potentially stale.
The operator is notified but the state is not automatically advanced.

---

## 3. Approval Gates

Approval gates are detected by the planner loop when the next planned action falls
into a forbidden or restricted category. The goal moves to `awaiting_approval` and
the gate is recorded in `approvalGates[]`.

### 3.1 Approval gate entry schema

| Field | Type | Description |
| --- | --- | --- |
| `gateType` | `string` | Gate type (see §3.2). |
| `detectedAt` | `string` (ISO-8601) | When the gate was detected. |
| `summary` | `string` | Human-readable description of what action would be taken. |
| `scope` | `string` | What would be affected: repo, worker, config, service. |
| `proposedActions` | `string[]` | Concrete actions that triggered the gate. |
| `status` | `string` | `pending`, `approved`, `declined`, `superseded`. |
| `decidedAt` | `string` (ISO-8601) | When operator decision was recorded. |
| `decisionSource` | `string` | Reference to the operator decision comment or record. |

### 3.2 Gate types

| Gate type | Description | Default response |
| --- | --- | --- |
| `deploy` | Production deploy of broker, worker, or Gateway. | Block. Require explicit operator approval. |
| `restart` | Gateway/broker/worker/service restart or reload. | Block. Require explicit operator approval. |
| `live_canary` | Live provider/Telegram canary or notification send. | Block. Require explicit operator approval. |
| `db_mutation` | Production DB mutation, prune, or migration. | Block. Require explicit operator approval. |
| `terminal_ack_replay` | Manual Terminal Brief ACK/replay. | Block. Require explicit operator approval. |
| `release_tag` | Release or npm publish. | Block. Require explicit operator approval. |
| `secret_movement` | Credential rotation, secret movement, token disclosure. | Block. Require explicit operator approval. |
| `force_push` | History rewrite or force-push. | Block. Require explicit operator approval. |
| `visibility_change` | Repository visibility change (public/private). | Block. Require explicit operator approval. |
| `issue_close` | Automatic GitHub issue closure. | Block. Require explicit operator approval. |
| `pr_merge` | Automatic PR merge. | Block. Require explicit operator approval. |

### 3.3 Approval surfacing

When a gate is detected, the planner loop must:

1. Record the gate in `approvalGates[]` with `status: "pending"`.
2. Transition the goal state to `awaiting_approval`.
3. Append an event to `eventLog` with `eventType: "approval_gate_detected"`.
4. Make no further autonomous progress until the operator responds.

The operator response is recorded as:

- `approved`: The specific action and scope are approved. The goal resumes in `planning`.
- `declined`: The action is declined. The planner re-plans around it.
- `declined_with_resume`: The action is declined, but the goal may re-plan to avoid it.

### 3.4 No inferred approval

Evidence entries, provider accepted-send telemetry, PR/Done/Block markers, and
Start comments are **evidence only**. They are not operator approval for any of
the gate types listed above. A separate explicit operator comment naming the
specific action and scope is required.

---

## 4. Planner Loop Contract

### 4.1 Purpose

The planner loop is the deterministic decision engine that reads the current goal
state and accumulated evidence, then decides the next bounded A2A task(s) to dispatch.
It is not an AI agent — it is a rule-based or schema-driven evaluation that produces
a deterministic plan output.

### 4.2 Inputs

The planner receives:

1. The current goal object (state, eventLog, evidence, approvalGates).
2. The objective descriptor (immutable).
3. Optional external context: broker health, worker availability, CI status on open PRs.

### 4.3 Decision model

The planner evaluates the objective's success criteria against accumulated evidence
and decides one of:

| Decision | Action |
| --- | --- |
| `start` | No slices dispatched yet. Plan the first bounded task(s). |
| `continue` | Some evidence collected, but success criteria not fully met. Plan next slice(s). |
| `replan_blocked` | A blocked worker result exists. Re-plan to avoid the blocking condition or produce a goal-level Block. |
| `await_approval` | Next action triggers an approval gate. Pause. |
| `complete` | All success criteria met. Transition to `completed`. |

### 4.4 Plan output

Each plan decision produces:

| Field | Type | Description |
| --- | --- | --- |
| `sliceId` | `string` | Unique slice id. Format: `<goalRunId>:slice:<N>`. |
| `summary` | `string` | What this slice should accomplish. |
| `workerRequirements` | `object` | Required worker capabilities, preferred workload types. |
| `repoScope` | `string[]` | Which repos the slice may modify. |
| `evidenceExpectations` | `string[]` | What evidence the worker should produce (see §6). |
| `forbiddenActions` | `string[]` | Actions the worker must not take in this slice. |
| `approvalGateHits` | `string[]` | Which approval gate types this slice would trigger, if any. |

### 4.5 Re-planning rules

- **After evidence**: When all dispatched slices reach a terminal state (done, pr,
  or blocked), the planner runs again.
- **Blocked slice**: A single blocked slice does not block the entire goal. The planner
  may dispatch alternative slices that avoid the blocking condition. A goal-wide block
  occurs only if the planner determines no safe alternative path exists.
- **Idempotent planning**: Running the planner with the same state and evidence must
  produce the same plan output (deterministic behavior).

### 4.6 Planner loop boundaries

- The planner does not execute external actions itself. It produces plan outputs.
- A separate dispatch mechanism (broker task creation) reads the plan output and
  dispatches bounded A2A tasks.
- The planner does not make final closeout decisions. Only the operator/broker/finalizer
  may declare a goal `completed` or `cancelled`.

---

## 5. Idempotency and Resume Behavior

### 5.1 Goal creation idempotency

Every goal creation must carry an `idempotencyKey` scoped to the operator/Gateway.
Replays of the same key return the existing goal object without modification.

```text
Format: a2a-goal-mode:create:<operatorId>:<objectiveName>:<utcTimestamp>
```

- If the key is new: create the goal object and return it.
- If the key exists AND the objective descriptor matches: return the existing goal object (no-op replay).
- If the key exists BUT the objective descriptor differs: reject as `409 Conflict`.

### 5.2 Slice dispatch idempotency

Each planned slice carries a `sliceId` that serves as the idempotency key for the
corresponding A2A task. The broker must return the existing task if the key has been used.

```text
Format: <goalRunId>:slice:<sliceNumber>:<workerId>
```

- If the slice ID is new: create and dispatch the task.
- If the slice ID exists AND the plan output matches: return the existing task (replay).
- If the slice ID exists BUT the plan output differs: reject as `409 Conflict`.

### 5.3 Retry/backoff policy

| Scenario | Behavior |
| --- | --- |
| Worker rejected task | Re-plan without that worker. Max 3 re-plans. |
| Worker timeout | Mark worker as potentially stale. Re-plan on different worker. |
| Broker unavailable | Retry dispatch with exponential backoff (1s, 2s, 4s, 8s, max 30s). |
| Event log write conflict | Retry the mutation with the latest snapshot. |

### 5.4 Resume after restart

If the broker restarts while a goal is in `planning`, `dispatching`, or
`collecting_evidence`:

1. Load the latest goal object snapshot from durable storage.
2. Re-evaluate all pending slices: which have terminal evidence, which are still
   `queued`/`claimed`/`running`, and which were lost.
3. For slices that were `queued` or `claimed` but no evidence exists: the planner
   may re-dispatch with a new idempotency slice id (different timestamp).
4. For slices with terminal evidence: proceed to collect and evaluate.
5. For slices whose worker evidence is inconclusive or missing: mark as blocked
   and re-plan around them.
6. Continue the planner loop from the loaded state.

### 5.5 Stale/stuck detection

| Condition | Detection | Action |
| --- | --- | --- |
| No event log activity for `staleDetectionSeconds` | Timestamp check on `updatedAt` vs clock | Flag as potentially stale. Notify operator. |
| Worker `claimed` for > `maxRuntimeSecondsPerSlice` | Broker task age | Flag as stuck. Re-plan or block. |
| Planner re-plans > 3 times without dispatch | Planner loop counter | Block. Operator intervention required. |

---

## 6. Worker Evidence Format for Goal Slices

### 6.1 Allowed work areas

Slices may carry one or more of the following work area labels:

| Label | Description |
| --- | --- |
| `source-patch` | Code or documentation changes in a repository. |
| `validation-run` | Running tests, scans, or validation commands. |
| `inspection` | Repository inspection, audit, or policy check. |
| `fixtures` | Fixture creation and maintenance. |
| `evidence-only` | Producing evidence/checklist entries without changing files. |
| `read-only-check` | Read-only inspection. No mutations. |

### 6.2 Worker evidence packet

Each dispatched slice must produce a worker evidence packet as part of the A2A
task's terminal evidence. The format extends the standard A2A evidence (done/pr/blocked)
with goal-mode-specific fields.

```json
{
  "goalRunId": "a2a-goal-<descriptor>-<timestamp>",
  "sliceId": "<goalRunId>:slice:<N>",
  "workArea": "source-patch",
  "result": "done|pr|blocked",
  "summary": "Concise summary of what was accomplished.",
  "changedFiles": [
    {"path": "path/to/changed/file.md", "changeType": "added|modified|deleted"}
  ],
  "evidenceUrls": ["https://github.com/.../pull/N"],
  "checkResults": [
    {"check": "npm run check:layout", "status": "pass|fail", "output": "redacted"}
  ],
  "blockerInfo": {
    "category": "safety|permission|evidence_gap|capacity",
    "reason": "Why the worker could not proceed."
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
    "noForcePush": true
  },
  "approvalGateRequired": null
}
```

### 6.3 Approval-sensitive evidence

If the worker determined that the requested slice would trigger an approval gate,
the evidence packet includes:

```json
{
  "...existing fields...",
  "approvalGateRequired": {
    "gateType": "deploy|restart|live_canary|db_mutation|terminal_ack_replay|release_tag|secret_movement|force_push|visibility_change|issue_close|pr_merge",
    "summary": "What the worker would have needed to do.",
    "scope": "What would be affected."
  }
}
```

### 6.4 Evidence redaction rules

Worker evidence must follow the same redaction rules as the goal object (§1.9).
No secrets, private paths, raw dumps, or runtime context files.

---

## 7. Example End-to-End Flow

### 7.1 Operator objective

```text
Objective: "Add a public quickstart guide to a2a-plane"
Scope:
  repos: [jinwon-int/a2a-plane]
  allowedWorkAreas: [source-patch, validation-run, evidence-only]
  forbiddenActions: [deploy, restart, live_canary, db_mutation]
SuccessCriteria:
  - docs/quickstart.md exists
  - docs/quickstart.md is linked from README.md
  - Example task JSON in examples/ works with the current broker
```

### 7.2 Goal creation

```text
goalRunId: a2a-goal-quickstart-guide-20260525T120000Z
state: idle
```

### 7.3 Planner iteration 1

```
state: planning
decision: start
Plan:
  slice 1: "Create quickstart guide skeleton"
  workArea: source-patch
  repo: jinwon-int/a2a-plane
```

### 7.4 Dispatch and collect

```
state: dispatching → collecting_evidence
Worker produces: docs/quickstart.md draft → PR #123
```

### 7.5 Planner iteration 2

```
state: planning
decision: continue
Plan:
  slice 2: "Update README.md link to quickstart"
  slice 3: "Validate example task JSON against broker"
```

### 7.6 Planner iteration 3

```
state: planning
decision: complete
Goal transitions to completed.
eventLog: "All 3 criteria met. Slices: 3/3 terminal."
```

### 7.7 Goal terminal state

```json
{
  "goalRunId": "a2a-goal-quickstart-guide-20260525T120000Z",
  "state": "completed",
  "evidence": [
    {"sliceId": "...slice:1", "result": "pr", "prUrl": "https://github.com/jinwon-int/a2a-plane/pull/123"},
    {"sliceId": "...slice:2", "result": "pr", "prUrl": "https://github.com/jinwon-int/a2a-plane/pull/124"},
    {"sliceId": "...slice:3", "result": "done", "summary": "Validation passed against broker v1.2.3"}
  ],
  "approvalGates": [],
  "eventLog": [
    {"eventType": "plan", "summary": "Plan iteration 1: slice 1"},
    {"eventType": "dispatch", "summary": "Slice 1 dispatched"},
    {"eventType": "evidence_collected", "summary": "Slice 1: PR #123"},
    {"eventType": "plan", "summary": "Plan iteration 2: slices 2, 3"},
    {"eventType": "dispatch", "summary": "Slices 2, 3 dispatched"},
    {"eventType": "evidence_collected", "summary": "Slice 2: PR #124, Slice 3: done"},
    {"eventType": "plan", "summary": "All criteria met. Complete."},
    {"eventType": "complete", "summary": "Goal completed: 3 slices, 2 PRs, 0 blocks"}
  ]
}
```

---

## 8. Safety Boundaries

1. **No autonomous execution**: This contract does not enable runtime automation.
   The planner loop, dispatch mechanism, and broker state machine are design-only
   until explicitly reviewed and separately approved.

2. **No approval inference**: Evidence entries (Start, PR, Done, Block) are evidence
   only. They are not operator approval for deploy, restart, live canary, DB mutation,
   Terminal ACK, release, secret movement, or any other gate type.

3. **No credential storage**: The goal object must never hold secrets, tokens,
   private endpoints, or raw session data.

4. **No automatic issue close**: The goal planner must not close GitHub issues,
   merge PRs, or modify repository visibility without explicit operator approval.

5. **No foreground flooding**: Goal progress summaries and approval notifications
   should be designed for detached delivery, not broker foreground sessions.

6. **Seoseo remains Team1 broker/finalizer of record**: Only Seoseo may render
   final closeout decisions for Team1 goal rounds.

---

## 9. Related Documents

- [A2A Task Lifecycle Contract](./task-lifecycle.md)
- [Terminal Semantics Contract](./terminal-semantics.md)
- [Worker Capability Profile Contract](./worker-capability-profile.md)
- [Worker Registration Contract](./worker-registration.md)
- [A2A Spec-First TaskFlow Bridge](../../docs/specs/a2a-spec-first-taskflow-bridge/spec.md)
- [A2A Spec-First TaskFlow Runtime](../../docs/specs/a2a-spec-first-taskflow-runtime/spec.md)
- [Team1 Dispatch Wrapper Runbook](../../docs/specs/a2a-team1-dispatch-wrapper/runbook.md)
- [Goal Mode Feature Spec](../../docs/specs/a2a-goal-mode/spec.md)
- [Goal Object Schema](../../docs/specs/a2a-goal-mode/schema.json)
- [Goal Object Fixture](../../fixtures/contract/a2a-goal-mode.json)
