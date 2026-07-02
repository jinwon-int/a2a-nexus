# A2A Spec-First TaskFlow Bridge

Status: design proposal. This document does not enable runtime automation.

## Purpose

The A2A Spec-First protocol gives Medium/Large work a durable packet:

```text
spec.md → clarify.md → plan.md → analyze.md → tasks.md → checklist.md
```

TaskFlow should eventually provide the durable runtime state for that packet:

```text
spec-first packet → managed TaskFlow → linked child evidence tasks → approval waits → finalizer closeout
```

TaskFlow owns orchestration state. It does **not** own business judgment. The broker/finalizer remains responsible for final closeout decisions.

## Non-goals

- Do not auto-run every Medium/Large GitHub issue.
- Do not infer approval from a spec, plan, issue label, PR check, or successful provider send.
- Do not store secrets, raw logs, raw session dumps, private endpoints, or production DB/outbox contents in TaskFlow state.
- Do not perform deploy/restart/live canary/DB mutation/manual ACK/replay/release/secret movement from this bridge without separate approval.

## Managed flow identity

Suggested controller id:

```text
a2a-plane/spec-first-taskflow-bridge
```

Suggested goal:

```text
A2A spec-first: <issue title or spec name>
```

The owner session should be the broker/finalizer session that initiated the work or accepted ownership.

## State schema

Store only minimal resumable state in `stateJson`.

```json
{
  "protocol": "a2a-spec-first",
  "version": 1,
  "source": {
    "issueUrl": "https://github.com/jinwon-int/a2a-broker/issues/634",
    "specPath": "docs/specs/a2a-terminal-brief-parent-origin-routing/spec.md",
    "planPath": "docs/specs/a2a-terminal-brief-parent-origin-routing/plan.md",
    "tasksPath": "docs/specs/a2a-terminal-brief-parent-origin-routing/tasks.md"
  },
  "classification": {
    "size": "large",
    "reason": "cross-repo Terminal Brief routing contract"
  },
  "ownership": {
    "brokerOfRecord": "broker-beta",
    "finalizer": "broker-beta",
    "humanApprovalOwner": "operator"
  },
  "affectedRepos": [
    "a2a-plane",
    "a2a-broker",
    "openclaw-plugin-a2a"
  ],
  "approvalBoundaries": {
    "deploy": "not-approved",
    "restart": "not-approved",
    "liveCanary": "not-approved",
    "providerSend": "not-approved",
    "dbMutation": "blocked",
    "terminalAckReplay": "blocked",
    "releaseTag": "not-approved",
    "secretMovement": "blocked"
  },
  "evidence": {
    "prs": [],
    "tests": [],
    "ci": [],
    "wiki": [],
    "blockers": []
  },
  "closeout": {
    "decision": null,
    "summary": null,
    "closedBy": null,
    "closedAt": null
  }
}
```

## Lifecycle states

| State | Meaning | Allowed next states |
|---|---|---|
| `spec_draft` | Spec exists but needs clarification or acceptance | `plan_ready`, `blocked` |
| `plan_ready` | Plan exists and affected components are known | `tasks_ready`, `blocked` |
| `tasks_ready` | Tasks exist and execution lane is selected | `dispatching`, `awaiting_approval`, `blocked` |
| `dispatching` | Child work is being created/linked | `collecting_evidence`, `blocked` |
| `collecting_evidence` | Child tasks/subagents are running or reporting | `ready_for_closeout`, `awaiting_approval`, `blocked` |
| `awaiting_approval` | Explicit operator approval is required | `collecting_evidence`, `ready_for_closeout`, `blocked` |
| `ready_for_closeout` | Evidence is complete enough for finalizer judgment | `closed`, `blocked` |
| `blocked` | Missing decision, unsafe state, failed validation, or unresolved evidence gap | prior safe state, `closed` if superseded |
| `closed` | Finalizer completed closeout | none |

## Wait metadata

When the flow waits, put the reason in `waitJson`.

Examples:

```json
{
  "kind": "operator_approval",
  "approvalType": "liveCanary",
  "requestedScope": "one bounded parent-seeded Terminal Brief canary",
  "blockedActions": ["liveCanary", "providerSend", "terminalAckReplay"]
}
```

```json
{
  "kind": "ci",
  "repo": "a2a-plane (internal tracker, private)",
  "pr": 319,
  "check": "check"
}
```

```json
{
  "kind": "child_tasks",
  "waitingFor": ["broker-lane", "plugin-lane", "plane-lane"]
}
```

## Child task linkage

Use `runTask(...)` or the equivalent future bridge wrapper to link child evidence work to the managed flow.

Each child task should have:

- lane id, e.g. `broker-lane`, `plugin-lane`, `plane-lane`, `libero`;
- target repo/component;
- expected evidence packet;
- timeout or checkpoint expectation;
- status mapped into parent flow evidence.

Child tasks provide evidence. They do not decide final closeout unless explicitly assigned as finalizer.

## Approval boundaries

TaskFlow can record approval requirements. It cannot approve them.

Approval-sensitive actions remain blocked until a human operator explicitly approves the exact action and scope:

- production deploy;
- Gateway/broker/worker/service restart;
- live canary/provider send;
- DB mutation/prune/migration/replay;
- manual Terminal Brief ACK/replay;
- release/tag;
- secret movement/output;
- force push/history rewrite.

## Example: mapping `a2a-broker#634`

Source packet:

- Issue: `https://github.com/jinwon-int/a2a-broker/issues/634`
- Spec: `docs/specs/a2a-terminal-brief-parent-origin-routing/spec.md`
- Plan: `docs/specs/a2a-terminal-brief-parent-origin-routing/plan.md`
- Tasks: `docs/specs/a2a-terminal-brief-parent-origin-routing/tasks.md`
- Size: Large
- Broker/finalizer: broker-beta

Suggested flow:

1. Create managed flow in `spec_draft` or `plan_ready` once the spec packet is accepted.
2. Move to `tasks_ready` when the task list names the plane, broker, and plugin lanes.
3. Link child evidence tasks:
   - `plane-contract-lane`
   - `broker-routing-lane`
   - `plugin-relay-lane`
   - `libero-validation-lane`
4. Move to `collecting_evidence` while PRs/tests run.
5. Move to `awaiting_approval` before any deploy/restart/live canary request.
6. Move to `ready_for_closeout` when source PRs are merged and evidence is complete.
7. broker-beta finalizer closes with GO/NO-GO and records follow-up runtime gate if needed.

## Phase 1 manual boundaries

The first implementation of this bridge should remain conservative:

- manual creation from a known spec packet is acceptable;
- no automatic scan of all GitHub issues;
- no automatic deploy/restart/canary;
- no automatic DB/outbox cleanup;
- no automatic terminal ACK/replay;
- no secret-bearing state.

## Dry-run runtime rehearsal

The first runtime-shaped implementation is a deterministic rehearsal command, not a live automation switch:

```bash
npm run a2a:taskflow-runtime -- --input fixtures/contract/a2a-spec-first-taskflow-runtime-dryrun.json
```

It validates a spec-first packet and emits a managed TaskFlow draft containing:

- `controllerId` and goal;
- `currentStep`;
- minimal `stateJson`;
- optional `waitJson` for operator approval;
- child evidence lane plans;
- exactly-one-finalizer closeout expectation;
- revision-safe mutation order.

The command remains fail-closed:

- `runtimeAutomationEnabled=true` is blocked;
- `--mode execute` is unsupported;
- approval-sensitive actions are blocked or represented as `awaiting_approval` waits;
- source-public execution remains `NO_GO`;
- secrets, raw session dumps, runtime bootstrap paths, and private paths are rejected.

## Future implementation notes

When implementation starts, use managed TaskFlow APIs and revision-safe mutations:

- `createManaged(...)`
- `runTask(...)`
- `setWaiting(...)`
- `resume(...)`
- `finish(...)` / `fail(...)`
- `requestCancel(...)` / `cancel(...)`

Carry the latest flow revision after every mutation.
