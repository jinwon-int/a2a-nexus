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

### Phase 0 measurement note (2026-07-28)

A read-only live sample of the most recent 500 list-projected tasks showed:
Team1 `parentTaskId=4`, `parentRoundId=0`, `referenceTaskIds=0`; Team2
`parentTaskId=1`, `parentRoundId=0`, `referenceTaskIds=0`. The list projection
may omit lineage fields, so these counts describe that read surface rather
than proving the durable task records lack those fields. The two existing
round-coordinator closeout datasets (`all-complete.json` and
`mixed-states.json`) are the recorded round-shaped golden-fixture inputs for
v1; tests stamp their manifest round label onto projected `TaskRecord` values
without changing the recorded fixtures.

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
  - `tasks/children` — direct canonical/reference children of a task id, or
    stamped children of a parent round id.
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
- Treating `referenceTaskIds` as canonical ancestry or silently constructing a
  multi-parent lineage chain. The canonical ancestry chain is
  `parentTaskId`-only.
- Using lineage as a finalizer/verdict input. Lineage is a
  dispatch/audit aid; it MUST NOT become an evidence source for terminal
  verdicts in v1 (mirrors the #1373 K3 boundary for injected knowledge).

## Contracts

All v1 task-lineage request and response records are closed, versioned
contracts. Unknown keys, unknown discriminants, malformed dates, and values
outside the documented bounds fail closed.

### `TaskLineageNodeV1`

```jsonc
{
  "kind": "TaskLineageNodeV1",
  "taskId": "task-123",
  "parentTaskId": "task-100",        // null for roots or an unavailable parent
  "parentMissing": false,            // true when a recorded canonical parent is unavailable
  "parentRoundId": "pr-review-r2-20260612-195514", // optional, as recorded
  "referenceTaskIds": ["task-099"],  // visible reference targets only
  "intent": "analyze",
  "status": "succeeded",
  "requesterId": "libero",
  "assignedWorkerId": "worker-1",
  "createdAt": "2026-07-26T00:00:00Z",
  "depth": 2                          // distance from this query's anchor
}
```

`parentTaskId` is the sole canonical ancestry relation. `referenceTaskIds`
are typed reference edges used by children/leaves and rejoin detection; they
never replace the canonical parent. A child matching an anchor through both
relations is emitted once with both edge types. An unavailable canonical
parent is projected as `parentTaskId: null`, `parentMissing: true` so an
inaccessible identifier is not disclosed.

### `tasks/children`

The request MUST contain exactly one closed anchor:

- `{ "taskId": "task-100", "limit": 200, "cursor": "…" }` returns direct
  canonical-parent and reference children.
- `{ "parentRoundId": "round-100", "limit": 200, "cursor": "…" }` returns
  stamped round children.

Unknown anchors, both anchors, or neither anchor fail closed. The response is
ordered by `createdAt`, then `taskId`; every item has a
`TaskLineageChildV1` typed edge list (`canonical_parent`, `reference`, or
`round_stamp`) and a `TaskLineageNodeV1` at `depth: 1`. A child matching both
canonical and reference edges is deduplicated. Reference edges whose
canonical parent differs are reported as rejoins, but do not create a
multi-parent ancestry chain.

When the visible matching children have one consistent round stamp and
consistent positive `parentRoundTotal`, the response includes a closed
`TaskLineageRoundCompletenessHintV1` with `parentRoundId`, `stampedTotal`,
`observedChildren`, and `complete`. Inconsistent or unavailable totals are
reported only as bounded, identifier-free anomalies; hints and counts are
computed from readable tasks only.

### `tasks/lineage`

Request: `{ "taskId": "task-123", "maxDepth": 32 }`.
Response: ordered ancestor chain from the anchor up to the root (or
`maxDepth`), each a `TaskLineageNodeV1`, plus
`truncated: boolean` and `rootReached: boolean`. A cycle or a depth beyond
`maxDepth` never throws an opaque error: cycle → `task_lineage_cycle`;
depth → `truncated: true, rootReached: false`.

The default `maxDepth` is 32 canonical-parent hops and the hard maximum is
128. A recorded canonical parent that is missing or inaccessible ends the
visible chain with `parentMissing: true`, `rootReached: false`; it never
silently re-roots. Canonical parent cycles fail with the structured
`task_lineage_cycle` error and never disclose cycle member identifiers.

### `tasks/leaves`

Request: `{ "parentRoundId": "…", "intent": "…", "status": ["succeeded"],
"since": "…", "until": "…", "limit": 200, "cursor": "…" }` (all filters
optional, AND-combined).
Response: tasks with no visible canonical-parent or reference children
matching the filters. A task referenced by any visible child is not a leaf.
Filters are AND-combined; the status list is an OR only within that field.
Leaves are frontier candidates, not a claim decision — claim policy remains
with the existing dispatcher gates.

### Pagination and diagnostics

Children and leaves default to `limit=200` and reject limits above 1000.
Cursors are opaque, deterministic, length-bounded, query-bound tokens over a
stable `(createdAt, taskId)` position. Malformed tokens, tokens from another
method/anchor/filter/limit, and tokens whose position is unavailable fail
closed. Cursor material contains no task payload, message, result, error, or
artifact content.

Every successful response carries closed, bounded
`TaskLineageDiagnosticsV1`. Diagnostics contain aggregate safe anomaly codes
and counts only; they never carry task ids, parent/reference ids, messages,
payloads, results, errors, artifacts, or unbounded samples. Metrics use the
`task_lineage.*` namespace, never the review-lineage namespace.

### Visibility boundary

The projection is built once per query from the broker's canonical task read
source/repository snapshot, then reduced to tasks the requester may read under
the existing task-read authorization boundary. Inaccessible tasks are absent
before indexes, counts, cursors, anomalies, and round hints are built.
Unavailable parents and references do not disclose identifiers or distinguish
missing records from inaccessible records. Missing and inaccessible anchors
produce the same bounded task-not-found result. No per-item store scan is
permitted.

## Safety and approval boundaries

- Read-only. No mutation endpoint is added.
- No new durable state in v1; the projection is derived and rebuildable.
- Lineage output is dispatch/audit aid only — not evidence, not a verdict
  input, not a finalizer input.
- Cycle anomalies fail closed with a structured error. Cycle and unavailable
  parent observations use operator-safe metrics
  (`task_lineage.cycle_detected`, `task_lineage.parent_missing`) without
  identifier labels.
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
