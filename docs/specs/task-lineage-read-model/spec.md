# Feature Spec: Task Lineage Read Model (children / leaves / lineage)

Origin: a2a-nexus#1635 (P1-B). Related: #1636 (ratchet lane PoC), #1504
(shared-state contract), #1601 (dispatch efficiency epic), #1503 (complexity
budget). Source-only spec — this document does not approve live schema
execution, migration, deployment, restart, canary, or cross-broker mutation.

## Problem

Broker tasks already form an implicit DAG. `A2ATaskRequest.parentTaskId`,
round stamps (`parentRoundId` / `parentRoundTotal` / `parentRoundOrder`), and
`referenceTaskIds` are recorded at creation time, but there is **no traversal
read API**. Today a dispatcher (or operator) cannot ask:

1. **"What was already tried on top of this result?"** — follow-up dispatches
   re-issue work that a prior child already attempted (duplicate work,
   wasted tokens, conflicting artifacts).
2. **"Where is the unclaimed frontier?"** — leaves of the DAG are the natural
   claim candidates for autonomous continuation, but they cannot be listed.
3. **"Which chain produced this outcome?"** — replay, audit, and closeout
   reconciliation currently reconstruct ancestry by hand from round ids and
   timestamps.

Prior art (validated in #1635): Karpathy AgentHub exposed exactly three DAG
queries — `children <hash>`, `leaves`, `lineage <hash>` — over a commit DAG
and they were sufficient to coordinate swarms without a merge model. The
broker already owns a superset of the underlying data.

### Naming boundary (required to avoid collision)

`review-lifecycle` already ships a **ReviewLineage** concept
(`packages/broker/src/review-lifecycle/`, `docs/specs/bounded-pr-review-lifecycle/`):
a bounded intra-review-loop chain of correction generations with an intent
contract and budget. That is **not** this feature. This spec introduces
**task lineage** — a read-only projection over the *task* parent graph.
Specs, code, routes, and metrics MUST use the `task-lineage` qualifier and
MUST NOT reuse the bare word `lineage` where it could bind to the
review-lifecycle domain.

## User / operator stories

- As a **round coordinator**, before dispatching a follow-up wave on task T,
  I call `tasks/children(T)` so that I do not re-dispatch a hypothesis that
  already has a terminal child.
- As a **worker** picking up autonomous work, I call `tasks/leaves` scoped
  to a round or intent so that I can claim frontier work instead of
  re-entering a resolved branch.
- As an **operator**, I call `tasks/lineage(T)` so that I can audit the full
  parent chain that produced a terminal artifact, including cross-round
  continuation.
- As a **closeout reconciler**, I use `tasks/children(parentRoundId)` to
  verify that every stamped child of a round reached a terminal state
  before closeout (complements `parentRoundTotal`).

## Actors

- Round coordinator / dispatcher (a2ad manifest lanes, wave-plan stages)
- Workers (claim and continuation decisions)
- Operators (audit, replay, closeout)
- Closeout reconciler (existing `closeout-reconciler`)

## Scope

### In scope

- A **read-only projection** built from existing task records
  (`parentTaskId`, `parentRoundId`, `referenceTaskIds`, status, timestamps).
  No new write path; the projection is rebuildable from the task store.
- Three query surfaces (JSON-RPC first; HTTP read routes optional phase 2):
  - `tasks/children` — direct children of a task id.
  - `tasks/lineage` — ancestor chain to the root, depth-bounded.
  - `tasks/leaves` — tasks with no recorded children, filterable by
    `parentRoundId`, `intent`, `status`, and time range.
- Explicit semantics for partial parentage (a task with no parent is its own
  root; a task with missing parent record is reported with
  `parentMissing: true`, never silently re-rooted).
- Cycle guard: any detected parent cycle fails closed with a structured
  error (`task_lineage_cycle`), never loops.
- Golden fixtures replaying at least two recorded rounds plus a hand-built
  multi-generational DAG (branch + rejoin + orphan).
- Performance bounds: single-projection queries answered from the live task
  store or an in-memory index rebuilt on demand; no new durable table in v1.

### Out of scope

- Any mutation of the task graph (no re-parenting, no pruning, no DAG write
  model). Compaction/archival policy remains with snapshot-retention.
- Changes to ReviewLineage (review-lifecycle) behavior, schema, or routes.
- Semantic duplicate detection (AgentHub explicitly left this out; so do we).
- Cross-broker lineage aggregation (cross-broker references stay payload
  metadata; v1 answers within the broker of record only).
- Using lineage as a finalizer/verdict input. Lineage is a
  dispatch/audit aid; it MUST NOT become an evidence source for terminal
  verdicts in v1 (mirrors the #1373 K3 boundary for injected knowledge).

## Contracts

### TaskLineageNodeV1

```jsonc
{
  "taskId": "task-123",
  "parentTaskId": "task-100",        // null for roots
  "parentMissing": false,            // true when parentTaskId is set but no record exists
  "parentRoundId": "pr-review-r2-20260612-195514", // optional, as recorded
  "referenceTaskIds": ["task-099"],  // optional, as recorded (identifiers only)
  "intent": "pr-review",
  "status": "completed",
  "requesterId": "libero",
  "assignedWorkerId": "worker-1",
  "createdAt": "2026-07-26T00:00:00Z",
  "depth": 2                          // distance from this query's anchor
}
```

Unknown fields fail closed (canonical parser rule, consistent with
review-lifecycle parsers).

### tasks/children

Request: `{ "taskId": "task-100", "limit": 200, "cursor": "…" }`.
Response: ordered children (createdAt, then taskId) of `TaskLineageNodeV1`
with `depth: 1`, plus `nextCursor`. `parentRoundTotal`-consistency hint:
when every child shares one `parentRoundId`, the response includes
`round: { parentRoundId, stampedTotal, observedChildren }` so callers can
see incomplete rounds without a second query.

### tasks/lineage

Request: `{ "taskId": "task-123", "maxDepth": 32 }`.
Response: ordered ancestor chain from the anchor up to the root (or
`maxDepth`), each a `TaskLineageNodeV1`, plus
`truncated: boolean` and `rootReached: boolean`. A cycle or a depth beyond
`maxDepth` never throws an opaque error: cycle → `task_lineage_cycle`;
depth → `truncated: true, rootReached: false`.

### tasks/leaves

Request: `{ "parentRoundId": "…", "intent": "…", "status": ["completed"],
"since": "…", "until": "…", "limit": 200, "cursor": "…" }` (all filters
optional, AND-combined).
Response: tasks with no recorded children matching the filters. Leaves are
the claimable frontier candidates; the response is a candidate list, not a
claim decision — claim policy remains with the existing dispatcher gates.

## Safety and approval boundaries

- Read-only. No mutation endpoint is added.
- No new durable state in v1; the projection is derived and rebuildable.
- Lineage output is dispatch/audit aid only — not evidence, not a verdict
  input, not a finalizer input.
- Cycle/orphan anomalies fail closed with structured errors and are counted
  in operator-visible metrics (`task_lineage.cycle_detected`,
  `task_lineage.parent_missing`).
- Human approval required for: any later promotion to a durable projection
  table, any cross-broker aggregation, any use in finalizer/verdict paths.

## Success criteria

1. Golden fixtures: for the recorded rounds in the fixture set,
   `tasks/children(parentRoundId anchor)` returns exactly the stamped child
   set, and `round.stampedTotal` vs `observedChildren` matches the recorded
   closeout state.
2. A hand-built fixture with a branch, a rejoin via `referenceTaskIds`, an
   orphan (`parentMissing`), and an injected cycle yields: correct leaves,
   correct lineage chains, `parentMissing: true` on the orphan, and a
   fail-closed `task_lineage_cycle` error respectively.
3. No regression in existing read paths (task projection, exchange read,
   closeout reconciler) — measured by the existing broker test suite plus
   the new fixtures.
4. Dispatcher dry-run demonstration: a recorded duplicate-follow-up scenario
   shows `tasks/children` returning the prior terminal child, i.e., the
   duplicate-prevention use case is exercisable end to end.
