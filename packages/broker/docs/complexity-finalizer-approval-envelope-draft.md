# Finalizer Approval Envelope Draft — #978

Consumes a `ComplexityOrchestrationRecommendationPacket` (#971 Team2) and produces a deterministic approval-request envelope draft. This module is source-only, no-live, and separates three concerns:

| Phase | Module | Responsibility |
|-------|--------|----------------|
| #970 | `task-complexity-classifier` | Classify task complexity |
| #971 | `complexity-orchestration-recommendation` | Recommend orchestration action + roles |
| **#978** | **`finalizer-approval-envelope-draft`** | **Produce approval request envelope draft** |
| future | *(not implemented)* | Grant or execute approval |

## Data Flow

```
Task input → #970 Classifier → #971 Recommendation → #978 Envelope Draft → [future Approval Grant]
```

## Approval Envelope Categories

| #971 Action | Envelope Category | Autonomous? | Subagents? | Description |
|---|---|---|---|---|
| `direct_execution` | `approval_not_required` | Yes | No | Safe to proceed without operator involvement |
| `sequential_subagent` | `operator_approval_required` | Gated | Requested only | Operator must explicitly approve before execution |
| `parallel_subagents` | `operator_approval_required` | Gated | Requested only | Operator must explicitly approve before execution |
| `operator_review` | `operator_review_required` | **BLOCKED** | **No** | Operator must review; approval CANNOT be autonomous |

## Safety Invariant: `operator_review` → No Autonomous Execution

When the recommendation action is `operator_review` (produced by critical complexity), the envelope draft:

- Sets `autonomousApprovalPossible: false`
- Sets `semantics.autonomousExecutionBlockedForOperatorReview: true`
- Sets `subagentSpawnPermitted: false`
- Sets `directExecutionPermitted: false`
- Sets `liveDeploymentPermitted: false`
- Sets `approvalMode: "operator_review_gated"`

This is **static** — the envelope itself enforces the safety boundary. No runtime check, no live state inspection, no operator override path exists in this module. The safety is in the data shape.

For `sequential_subagent` and `parallel_subagents`, the envelope records a request draft only. It never grants subagent spawn permission by itself; a later approval-grant path would be required.

## Source-Only / No-Live Enforcement

All boundary and semantics fields are hardcoded to `false` or the relevant safety value. See the type definition in the source for the complete list.

## Public API

### `buildFinalizerApprovalEnvelopeDraft(recommendation, options?)`

**Input:** `ComplexityOrchestrationRecommendationPacket`
**Output:** `FinalizerApprovalEnvelopeDraftPacket`

Pure function. Deterministic for the same recommendation + timestamp. Idempotency key is SHA-256 of the stable-serialized recommendation + envelope category.

### `renderFinalizerApprovalEnvelopeDraftMarkdown(packet)`

Returns a human-readable Markdown string. No IO, no side effects.

### `extractOrchestrationRecommendationFromEnvelope(input)`

Extracts the source `ComplexityOrchestrationRecommendationPacket` from an envelope or any object wrapping one. Throws if the packet kind is not recognised.

## Test Coverage

44 tests across 13 suites:

| Suite | Tests | What it covers |
|---|---|---|
| `buildFinalizerApprovalEnvelopeDraft` | 4 | Action → category mapping (all four actions) |
| `full pipeline (#970→#971→#978)` | 5 | End-to-end from classifier input to envelope |
| `safety invariant` | 3 | operator_review cannot become autonomous |
| `idempotency key stability` | 4 | Deterministic key generation |
| `safety block` | 1 | Unknown action → fail closed |
| `generatedAt timestamp` | 2 | Timestamp handling |
| `requested items` | 3 | Per-role items, shape, content |
| `next actions` | 4 | Per-envelope guidance |
| `renderFinalizerApprovalEnvelopeDraftMarkdown` | 6 | Markdown output shape |
| `extractOrchestrationRecommendationFromEnvelope` | 5 | Extractor with multiple key shapes |
| `source recommendation key carry-through` | 2 | Idempotency key traceability |
| `symbolic boundary enforcement` | 2 | All boundaries false, semantics correct |
| `pipeline separation` | 3 | Kinds differ, no grant/dispatch fields |

## No-Code-Coverage Exclusions

The module's static boundary checks (`boundaries.*`, `semantics.*`) are tested symbolically but not via coverage analysis. They are constants, not branches.
