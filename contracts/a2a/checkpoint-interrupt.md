# Durable Checkpoint & Human-Interrupt Contract (v0 Freeze)

> **v0 Freeze (2026-05-09):** Checkpoint states, interrupt transitions, pause/resume semantics,
> safe replay guarantees, audit trace export boundaries, and artifact version lineage are frozen
> as the Contract v0 baseline. No new checkpoint states or interrupt decision types may be added
> without a v0→v1 compatibility plan.

This contract defines the public-safe contract for durable checkpoint, human interrupt, pause/resume,
safe replay, audit trace export, and artifact version lineage in A2A Nexus operations. It builds on
the existing [task lifecycle](./task-lifecycle.md), [cancellation & idempotency](./cancellation-idempotency.md),
and [terminal result semantics](./terminal-semantics.md) contracts.

It is intentionally a policy-only document. It defines what safe behavior looks like at the contract
level without prescribing implementation details or implying production DB mutation.

## 1. Checkpoint Semantics

### 1.1 What a checkpoint is

A checkpoint is a safe, deterministic pause point in task execution where:

- The task state, in-progress artifact references, and worker identity are recorded in a redacted,
  machine-readable form.
- Recovery from the checkpoint produces an identical pre-pause task state and does not re-execute
  side effects that completed before the checkpoint.
- The checkpoint record never contains secret values, private endpoint names, provider identifiers,
  raw session dumps, or host-specific paths.

### 1.2 Checkpoint states

Checkpoint states are transitory. They are not terminal task states. A task in a checkpoint state
is still logically active and tracked by the broker.

| State | Meaning | Allowed next states |
|---|---|---|
| `paused` | Task execution safely suspended at a checkpoint. Worker released. | `running` (resume), `blocked` (escalation), `cancelled` |
| `awaiting_operator` | Task cannot proceed without operator input (human interrupt). | `running` (operator approved), `blocked` (operator refused), `cancelled` (timeout/operator cancel) |

`paused` and `awaiting_operator` are non-terminal transitory states. Only `done`, `pr`, `blocked`,
and `cancelled` are terminal (see [task-lifecycle.md](./task-lifecycle.md)).

### 1.3 Checkpoint obligations

When a worker reaches a checkpoint, it must:

1. Record the checkpoint with a `checkpointId`, the task artifact references at the checkpoint, and
   a redacted summary of what was accomplished before the pause.
2. Stop mutable operations: no file writes, git operations, or branch changes after the checkpoint
   until resumed.
3. Not mutate terminal-outbox ACK records.
4. Not open or push a PR from checkpoint state.

When a worker resumes from a checkpoint, it must:

1. Verify that the task's parent run and broker-of-record have not changed since the checkpoint.
2. Re-establish the task context from checkpoint state before performing any new mutable operations.
3. Not replay already-completed idempotent operations that have visible effects.

### 1.4 Checkpoint lifecycle transitions

```
       ┌─────────┐
       │ running │
       └────┬────┘
            │ worker.checkpoint
            ▼
       ┌─────────┐
       │ paused  │────────► cancelled
       └────┬────┘         (operator cancel / timeout)
            │ worker.resume (operator or automated)
            ▼
       ┌─────────┐
       │ running │────► done / pr / blocked / cancelling
       └─────────┘
```

When a task is `paused`, the broker must:

- Release the worker assignment.
- Track the checkpoint id, artifact references, and pause reason.
- Honor the pause timeout (default: 24 hours; configurable per-broker).
- Transition to `cancelled` if the pause timeout expires without resume.

When a task is resumed from `paused`:

- A worker claims the task and receives the checkpoint context.
- The resumed task carries the same `taskId` and `idempotencyKey`.
- The task event stream records `task.paused` and `task.resumed` events for audit trace.

## 2. Human-Interrupt Semantics

### 2.1 What a human interrupt is

A human interrupt occurs when a worker determines that safe task completion requires explicit
operator input. The worker cannot proceed without an operator decision. This is not a failure
or a block — it is a bounded paused state with a required decision path.

### 2.2 Interrupt decision types

| Decision type | Meaning | Worker behavior |
|---|---|---|
| `safety_gate` | Operator must confirm a safety-sensitive operation is acceptable | Present redacted summary of the operation and the risk; wait for operator decision |
| `ambiguous_scope` | Task instructions are unclear or contradictory | Present the ambiguity and suggested resolution paths; wait for operator clarification |
| `approval_required` | Task requires permission the worker cannot self-grant | Present the required permission and the proposed action; wait for operator approval |
| `conflict_detected` | Worker detected a conflict (e.g., branch, lock, concurrent task) | Present the conflict and resolution options; wait for operator direction |

### 2.3 Human-interrupt lifecycle

```
       ┌─────────┐
       │ running │
       └────┬────┘
            │ worker.interrupt(decisionType, summary)
            ▼
  ┌───────────────────┐
  │ awaiting_operator │────────► cancelled
  └────────┬──────────┘         (operator cancel / timeout)
           │ operator.decide(action)
           ▼
       ┌─────────┐
       │ running │────► done / pr / blocked / cancelling / paused
       └─────────┘
```

When a task is `awaiting_operator`, the broker must:

- Surface the interrupt to the operator with the redacted decision summary.
- Track the interrupt id, decision type, and requested decision timestamp.
- Honor the interrupt timeout (default: 24 hours; configurable per-broker).
- Transition to `cancelled` if the interrupt timeout expires without operator response.

When the operator responds:

- The `operator.decide` event records: decision type, operator action (`approved`, `refused`,
  `clarified`), and a redacted operator comment.
- If `approved` or `clarified`: task transitions to `running` with the operator context.
- If `refused`: task transitions to `blocked` with the refusal reason as blocking evidence.

### 2.4 Safety gates for human interrupts

- Interrupt summaries must be redacted: no secret keys, private paths, or raw internal state.
- The interrupt must not expose worker internal reasoning or provider credentials.
- Operator decisions are recorded as audit events; they are not terminal evidence by themselves.
- A refused interrupt is `blocked` evidence, satisfying the Block terminal contract.

## 3. Safe Replay Semantics

### 3.1 What safe replay means

Safe replay means that re-executing a completed idempotent operation produces the same evidence,
does not create duplicate side effects, and does not mutate terminal state.

### 3.2 Replay guarantees

| Guarantee | Scope | Enforcement |
|---|---|---|
| Idempotent operation replay | Per-task, per-worker | Idempotency key deduplication at broker level ([cancellation-idempotency.md](./cancellation-idempotency.md)) |
| Checkpoint resume replay | Per-task, per-checkpoint | Checkpoint id deduplication; resume from checkpoint does not replay completed pre-checkpoint operations |
| Terminal state immutability | Per-task | Terminal states (`done`, `pr`, `blocked`, `cancelled`) cannot be replayed into non-terminal states |
| Evidence immutability | Per-task terminal evidence | Terminal evidence once posted cannot be overwritten by replay |

### 3.3 Replay safety boundaries

- Replay must never mutate terminal-outbox ACK records.
- Replay must never cause a live provider send.
- Replay must never create a second PR or duplicate artifact for the same task.
- Replay of a checkpointed task must surface the same checkpoint id and artifact references.

## 4. Audit Trace Export

### 4.1 What the audit trace is

The audit trace is a sequence of state transition events for a task, from acceptance to terminal
state. It is a debugging and compliance artifact, not a production database view.

### 4.2 Audit trace export boundaries

- Export must be redacted: no secret values, private endpoints, provider identifiers, or raw
  session dumps.
- Export format is a deterministic JSON array of state transition events with timestamps.
- Export must not include provider message ids at any receipt level above accepted-send.
- Export must not include terminal-outbox ACK values.

### 4.3 Export schema

```json
{
  "taskId": "task-redacted-example",
  "idempotencyKey": "issue-NNN:teamN:scope",
  "brokerOfRecord": "gwakga",
  "events": [
    {
      "sequence": 1,
      "type": "task.accepted",
      "state": "queued",
      "at": "REDACTED-TIMESTAMP"
    }
  ],
  "redacted": true,
  "exportedAt": "REDACTED-TIMESTAMP"
}
```

### 4.4 Audit trace non-goals

- The audit trace is not a live dashboard or monitoring system.
- The audit trace does not prove provider delivery.
- The audit trace is not a substitute for the broker's own persistence layer.
- Export does not imply production DB copy or migration.

## 5. Artifact Version Lineage

### 5.1 What artifact version lineage is

Artifact version lineage tracks the chain of artifacts produced by follow-up and refinement tasks.
It allows operators and workers to understand which version of an artifact was used as input for
a subsequent task.

### 5.2 Lineage fields

| Field | Required | Description |
|---|---|---|
| `artifactPath` | yes | Repo-relative path to the artifact. |
| `versionRef` | yes | Reference to the version (e.g., commit SHA, PR number, or task evidence id). |
| `parentVersionRef` | no | The version ref this artifact was derived from. |
| `producingTaskId` | no | The task id that produced this version. |
| `producingRunId` | no | The run id that this task belonged to. |

### 5.3 Lineage rules

1. Artifact paths must be repo-relative and public-safe (no host-specific paths).
2. Version refs must be deterministic (commit SHA, PR number, or stable evidence id).
3. Lineage records are metadata; they do not contain the artifact content itself.
4. Lineage must not expose which worker or broker host produced the artifact beyond the public-safe
   task id.
5. Follow-up tasks should reference the parent artifact version when the task is scoped as
   a refinement or continuation of prior work.

### 5.4 Example (redacted)

```json
{
  "artifactPath": "contracts/a2a/checkpoint-interrupt.md",
  "versionRef": "pr-REDACTED",
  "parentVersionRef": "issue-93-evaluation",
  "producingTaskId": "task-redacted-example",
  "producingRunId": "run-redacted-example"
}
```

## 6. Conformance Fixture

A machine-readable fixture is maintained at:

- `fixtures/contract/checkpoint-interrupt.json`

The fixture defines:
- Checkpoint state definitions
- Human-interrupt scenarios (safety_gate, ambiguous_scope, approval_required, conflict_detected)
- Pause/resume transitions
- Replay safety assertions
- Audit trace export schema validation
- Artifact version lineage example

The fixture is validated by the contract conformance check:
- `node test/conformance/check-contract-fixtures.mjs`

## 7. Safety Boundaries

When implementing or testing checkpoint and interrupt behavior, these safety boundaries apply:

- No production deployment, restart, or broker reconfiguration.
- No database mutation (checkpoint records are fixtures/tests only; production persistence
  rollout is a separate implementation phase per [durable-persistence-path.md](../../packages/broker/docs/durable-persistence-path.md)).
- No live provider/Telegram send.
- No terminal-outbox ACK mutation.
- No secret rotation or disclosure.
- No repository visibility change.
- Checkpoint and interrupt examples must be redacted, deterministic, and not imply production
  DB mutation.

## 8. Relationship to Other Contracts

| Contract | Relationship |
|---|---|
| [task-lifecycle.md](./task-lifecycle.md) | Defines base states and transitions. Checkpoint adds `paused` and `awaiting_operator` as transitory states. |
| [cancellation-idempotency.md](./cancellation-idempotency.md) | Defines cancellation paths and idempotency keys. Checkpoint resume uses the same idempotency guarantees. |
| [terminal-semantics.md](./terminal-semantics.md) | Defines Done/PR/Block evidence. Interrupt refusal produces Block evidence. |
| [broker-handoff-protocol.md](./broker-handoff-protocol.md) | Checkpoints do not cross broker boundaries. A paused task is not a handoff. |
| [worker-registration.md](./worker-registration.md) | Workers declare checkpoint and interrupt support via capabilities. |

## 9. Decision Record: Issue #93 Evaluation

This contract records the decisions from [issue #93](https://github.com/jinwon-int/a2a-plane/issues/93)
evaluation of durable checkpoint, human interrupt, and trace policy.

### Accepted

| Item | Decision | Location in this contract |
|---|---|---|
| Resumable checkpoints | Accepted. `paused` state with checkpoint id, artifact refs, and resume semantics. | §1 |
| Human interrupt / operator decision states | Accepted. `awaiting_operator` state with four decision types. | §2 |
| State transition trace export | Accepted. Redacted JSON export schema with deterministic event sequence. | §4 |
| Artifact version lineage | Accepted. Metadata-only lineage with repo-relative paths and deterministic refs. | §5 |
| Safe replay semantics | Accepted. Idempotency-guaranteed replay with checkpoint deduplication. | §3 |

### Rejected / Deferred

| Item | Decision | Rationale |
|---|---|---|
| LangGraph-style durable execution engine | Rejected for A2A Nexus. Not needed at the contract level; the broker already has cancel/reconcile/heartbeat patterns. | Added complexity without clear A2A Nexus benefit. The contract-level checkpoint/interrupt semantics here are sufficient. |
| Microsoft Agent Framework-style workflow orchestration | Rejected for A2A Nexus. Overlaps with broker task routing and worker capability gating. | A2A Nexus tasks are bounded units of work, not long-running DAG workflows. |
| Production persistence rollout | Deferred to implementation phase per [durable-persistence-path.md](../../packages/broker/docs/durable-persistence-path.md). | This contract defines policy; SQLite-backed persistence is a separate implementation phase. |
| Cross-broker checkpoint relay | Deferred. | Checkpoints are per-broker. Cross-broker state relay is a handoff concern, handled by [broker-handoff-protocol.md](./broker-handoff-protocol.md). |
| Live audit dashboards | Rejected for v0. | Audit trace export is file-based only. Live dashboards require operator infrastructure not in scope. |

### Remaining blockers for issue #93 closure

- [ ] SQLite-backed persistence implementation phase (tracked in broker docs).
- [ ] Worker capability gating for `checkpoint` and `humanInterrupt` capabilities.
- [ ] Operator notification path for `awaiting_operator` state (requires operator infrastructure).

These blockers are implementation concerns, not contract gaps. The contract semantics defined in this
document are complete for v0. Issue #93 can advance to "implementation tracking" with these blockers
recorded as separate implementation issues.

## 10. Decision Record: Issue #130 — Post-78261 Terminal Evidence & Replay Safety

This contract records the decisions from [issue #130](https://github.com/jinwon-int/a2a-plane/issues/130)
post-78261 terminal evidence, replay safety, and readiness gate mapping.

### Accepted

| Item | Decision | Location / Rationale |
|---|---|---|
| Provider accepted-send as non-ACK evidence | Accepted. Provider-returned message id and send success are accepted-send evidence only — not requester-visible receipt, operator-visible receipt, terminal ACK, human-seen proof, or terminal-outbox ACK. | §3 (Safe Replay), [terminal-semantics.md](./terminal-semantics.md) |
| No-duplicate replay proof | Accepted. Idempotency-key deduplication and checkpoint-id deduplication together guarantee at-most-once PR/artifact creation per task. | §3.2, §3.3 |
| NO-GO public readiness | Accepted. Public-readiness remains NO-GO until A2A-owned terminal evidence conformance, replay-safe/no-duplicate proof, scanner/readiness evidence, and explicit operator approval are complete. | This contract §7 |
| Scanner evidence fitness | Accepted. Scanner/readiness conformance must validate terminal evidence format, non-ACK semantics, and no-duplicate replay guarantees. | [terminal-semantics.md](./terminal-semantics.md) fixture conformance |
| Safety gate encoding | Accepted. All safety gates (no deploy/restart/live send/terminal ACK/DB mutation/secret/visibility change) are encoded in contract documents and validated by conformance fixtures. | §7, fixture validation |

### Rejected / Deferred

| Item | Decision | Rationale |
|---|---|---|
| Live canary delivery test | Rejected for v0. Requires live provider send, which violates the deploy/restart/live-send safety gate. | Canary readiness is validated through contract conformance and scanner fixtures, not live delivery. |
| Operator-facing terminal ACK | Deferred. Terminal ACK requires separate operator infrastructure and approval path. Accepted-send is sufficient for v0 evidence. | Operator ACK infrastructure is a separate implementation phase, not a contract gap. |
| Production persistence rollout | Deferred — same as #93 disposition. | Tracked separately per [durable-persistence-path.md](../../packages/broker/docs/durable-persistence-path.md). |

### Remaining blockers for issue #130 closure

- [ ] Scanner conformance fixtures for non-ACK evidence validation.
- [ ] No-duplicate replay canary harness (broker-level, tracked in broker issues).
- [ ] Explicit operator approval path for public-readiness GO transition.

These blockers are implementation concerns, not contract gaps. The contract semantics defined in this
document are complete for v0. Issue #130 can advance to "implementation tracking" with these blockers
recorded as separate implementation issues.

## 11. Cross-Reference: Issue #93 / #130 Contract-Level Closure

| Issue | Scope | Contract Status | Remaining Implementation Work |
|---|---|---|---|
| [#93](https://github.com/jinwon-int/a2a-plane/issues/93) | Durable checkpoint, human interrupt, trace policy | Closed at contract level (§9) | SQLite persistence, worker capability gating, operator notification path |
| [#130](https://github.com/jinwon-int/a2a-plane/issues/130) | Post-78261 terminal evidence, replay safety, readiness gates | Closed at contract level (§10) | Scanner conformance, replay canary harness, operator approval path |

Both issues are contract-complete for v0. All remaining work is implementation-phase tracking under
separate broker/plugin/runner issues. No new contract states or interrupt decision types are required.
