# Feature Spec: A2A Goal Mode — Persistent Objective Execution

> **Lane issue:** [a2a-plane#442](https://github.com/jinwon-int/a2a-plane/issues/442)
> **Parent tracker:** [a2a-plane#443](https://github.com/jinwon-int/a2a-plane/issues/443)
> **Phase:** Spec-first design slice (lane 2/4)
> **Status:** Design proposal. This document does not enable runtime automation.

## Problem

Every A2A run today is a bounded one-shot dispatch: the operator formulates a task,
the broker assigns a worker, the worker produces a patch or Block, and the finalizer
closes out. There is no durable abstraction for an operator-defined **objective** that
spans multiple tasks, requires iterative planning, crosses approval gates, and resumes
across broker restarts.

Current limitations:

- No goal-level state survives the individual task lifecycle. Multi-task objectives
  require the operator to manually track which slices are done and which are next.
- No structured planner loop. The operator must decide what bounded task to dispatch
  next based on ad-hoc evidence rather than a deterministic re-planning contract.
- No cross-task idempotency. If the broker restarts mid-round, previously dispatched
  tasks may be re-queued, creating duplicate PRs or comments.
- No approval-gate awareness at the goal level. A goal that requires deploy, live
  canary, or DB mutation has no structured mechanism to pause, surface the request,
  and resume after operator sign-off.
- No goal-level evidence aggregation. Terminal evidence from each task is reported
  independently; the operator must reconstruct the overall picture.

The **Goal Mode** abstraction fills this gap: a durable goal object, a deterministic
planner loop, and a controlled evidence-to-decision pipeline that composes A2A's
existing bounded task workflows into persistent objective execution.

## User / operator stories

- **As an operator**, I want to create a goal run from a short objective statement
  and have the system plan, dispatch, collect evidence, re-plan, and surface approval
  gates — all without me manually tracking which slice is next.

- **As a broker/finalizer**, I want a goal status endpoint that shows every planned
  slice, its dispatch state, collected evidence, and the next decision point, so I
  can review progress without reading every separate lane issue.

- **As a worker**, I want to receive bounded tasks that look identical to existing
  A2A tasks (claimable, runnable, evidencable) but carry a goal-run parent id so
  my evidence links back to the persistent objective.

- **As a maintainer**, I want idempotency markers on every goal-level action so
  broker restarts, network retries, and status-polling loops never duplicate work.

- **As a security reviewer**, I want approval-gated actions detected and surfaced
  at the goal level instead of silently executed or scattered across lane evidence.

## Scope

### In scope

- Define the **durable goal object schema** (fields, versioning, source references).
- Define **lifecycle states** and allowed transitions for a goal run.
- Define **approval gate types** and the mechanism for surfacing approval requests.
- Define the **planner loop contract**: input, decision model, dispatch, re-plan.
- Define **idempotency and resume behavior**: restart-safe state, dedupe key derivation,
  replay detection, conflict handling.
- Define **worker evidence format** for goal slices: what a worker reports back to
  the goal-level aggregator.
- Define **acceptance checklist** with GO/NO-GO conditions for implementation.
- Include a **full concrete example** mapping an operator objective through the goal
  lifecycle to illustrate every concept.
- All of the above is source-only documentation. No runtime automation is enabled.

### Out of scope

- Broker runtime implementation of the goal state machine or planner loop.
- CLI/API command surface for creating, inspecting, or cancelling goal runs.
- Live broker integration (no broker HTTP routes, no Gateway commands).
- Production deploy, restart, live canary, provider send.
- DB mutation, prune, migration, or replay.
- Manual Terminal Brief ACK/replay.
- Release/tag or npm publish.
- Secret movement, credential rotation, or token disclosure.
- Automatic goal creation from GitHub issues or roadmap items.
- Telegram/DM projection of goal summaries (future integration lane).
- Replacing existing finite A2A task workflows; Goal Mode composes them.

## Success criteria

- [ ] Spec documents the goal object schema with all required fields.
- [ ] Spec documents lifecycle states and allowed transitions.
- [ ] Spec documents approval gate types and surfacing mechanism.
- [ ] Spec documents the planner loop contract.
- [ ] Spec documents idempotency and resume behavior.
- [ ] Spec documents worker evidence format for goal slices.
- [ ] Spec includes a concrete end-to-end example.
- [ ] Plan and tasks documents exist for this design slice.
- [ ] Contracts file exists for the goal lifecycle.
- [ ] JSON schema and fixture file exist for the goal object.
- [ ] Acceptance checklist is included.
- [ ] No runtime automation is enabled by this PR.

## Safety and approval boundaries

### Secrets and private data

Goal object state must never contain:
- Secret values, tokens, passwords, or API keys.
- Provider identifiers (Telegram chat IDs, worker host names, private endpoints).
- Host-specific private paths or IP addresses.
- Raw session dumps or OpenClaw runtime context.
- Raw command stdout/stderr output.
- Broker edge secrets or Gateway auth tokens.

Goal object state should contain only:
- Repo/issue/PR URLs.
- Summary strings, status labels, and decision text.
- Redacted evidence references (URLs, check names, manifest hashes).
- Timestamps and idempotency markers.

### Human approval required for

- [x] production deploy
- [x] Gateway/broker/worker/service restart
- [x] live canary/provider send
- [x] DB mutation/prune/migration/replay
- [x] manual Terminal Brief ACK/replay
- [x] release/tag
- [x] secret rotation/movement
- [x] force push/history rewrite

This design spec does not approve any of the above. Approval-gate types are documented
so the planner loop can detect them and pause, but no automatic execution is enabled.

### Broker foreground liveness

Goal Mode progress summaries and approval-gate notifications should be designed for
detached delivery (Telegram/DM in future lanes, not foreground broker sessions).
This design slice does not implement any delivery mechanism.

## Evidence contract

This design PR must include:

- Changed files list.
- Links to spec, plan, tasks, contracts, schema, and fixture.
- Validation commands and results.
- Safety boundary statement.
- Explicit note that no runtime behavior changed.
- PR URL referencing issue #442.

## Rollback / failure handling

This is a source-only design PR. Rollback is limited to reverting documentation files.
No runtime state, database entries, or broker tasks are created. No cleanup actions
are required beyond reverting the git changes.

## Related documents

- [A2A Task Lifecycle Contract](../../contracts/a2a/task-lifecycle.md)
- [Terminal Semantics Contract](../../contracts/a2a/terminal-semantics.md)
- [Worker Capability Profile](../../contracts/a2a/worker-capability-profile.md)
- [A2A Spec-First TaskFlow Bridge](../a2a-spec-first-taskflow-bridge/spec.md)
- [A2A Spec-First TaskFlow Runtime Rehearsal](../a2a-spec-first-taskflow-runtime/spec.md)
- [Team1 Dispatch Wrapper Runbook](../a2a-team1-dispatch-wrapper/runbook.md)
- [Goal Mode Lifecycle Contract](../../contracts/a2a/goal-mode-lifecycle.md)
- [Goal Object Schema](./schema.json)
