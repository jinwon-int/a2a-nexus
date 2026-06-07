# Complexity Execution Plan Preflight Seal (#989)

Consumes a `ComplexityExecutionPlanDraftPacket` (#982) and produces a
deterministic sealed review packet that verifies approval envelope lineage,
no-live boundaries, plan state, worker eligibility hints, rollback/abort
fields, and idempotency before any later operator approval or dispatch
request layer.

## Chain position

```
recommendation (#TBD) → approval envelope draft (#978)
  → execution plan draft (#982)
    → **preflight seal (#989) ← this module**
      → operator approval / dispatch request (future)
```

The preflight seal is the last **source-only/no-live** transformation before
any operator review or dispatch. It encodes a hard fail-closed guarantee:
if any safety invariant is violated, the seal state is not
`preflight_seal_ready`.

## Seal state machine

```
                        ┌──────────────────────┐
                        │  plan_safety_blocked  │  ← source plan decision
                        └───────┬──────────────┘
                                │ fail
                                ▼
                        ┌──────────────────────┐
                        │    lineage_invalid    │  ← missing idempotency keys
                        └───────┬──────────────┘
                                │ fail
                                ▼
                        ┌──────────────────────┐
                        │  boundary_violation   │  ← no-live boundary true
                        └───────┬──────────────┘
                                │ fail
                                ▼
                        ┌──────────────────────┐
                        │  semantic_violation   │  ← invariant violation
                        └───────┬──────────────┘
                                │ fail
                                ▼
                        ┌──────────────────────┐
                        │  seal_failed_closed   │  ← multiple categories fail
                        └──────────────────────┘

                              all pass →
                        ┌──────────────────────┐
                        │ preflight_seal_ready  │  ← usable for operator review
                        └──────────────────────┘
```

## Checks performed

| Code | Category | Description |
|------|----------|-------------|
| `plan_kind` | Identity | Kind is `complexity-execution-plan-draft.packet` |
| `plan_version` | Identity | Version is 1 |
| `plan_decision` | Plan state | Decision recognized (not safety blocked) |
| `lineage_envelope_key` | Lineage | `sourceEnvelopeIdempotencyKey` present |
| `lineage_recommendation_key` | Lineage | `sourceRecommendationIdempotencyKey` present |
| `envelope_category` | Lineage | Category is recognized |
| `idempotency_key` | Lineage | Plan `idempotencyKey` present |
| `boundary_*` (9) | Boundaries | Each no-live boundary is `false` |
| `semantic_*` (4) | Semantics | `planDraftOnly`, `approvalNotGranted`, `sourceOnlyNoLive`, `planStepsNotExecuted` all `true` |
| `execution_blocked_consistency` | Plan state | `executionBlocked` consistent with mode |
| `approval_required_consistency` | Plan state | `approvalRequired` consistent with mode |
| `steps_structure` | Plan state | At least one step exists |

## Worker eligibility

The seal extracts from the plan's steps:

- **Roles requested**: deduplicated roles across all steps
- **Subagent steps planned**: count of `subagent_sequential` and `subagent_parallel` steps
- **Approval steps planned**: count of `approval_gate` steps
- **Operator review steps planned**: count of `operator_review` steps
- **Parallel/sequential flags**: whether those step kinds are present
- **Approval gate present**: whether an `approval_gate` step exists

## Rollback/abort

At the preflight stage, **no steps have been executed**. Rollback is not
required. The seal reports:

- `rollbackRequired: false`
- `stepsExecuted: 0`
- `stepsBlocked`: number of steps with `executionBlocked: true`
- `stepsPendingApproval`: number of steps with `requiresApproval: true`

## No-live enforcement

The packet's `boundaries` and `semantics` blocks are statically set to
`false`/`true` as appropriate. Every seal asserts:

```
brokerStateRead:          false   hostStateRead:             false
workerDispatch:           false   subagentSpawn:             false
taskFlowMutation:         false   dbMutation:                false
deployOrRestart:          false   providerMessageSent:       false
terminalAckPerformed:     false   secretMovement:            false
approvalGranted:          false   executionDispatched:       false

preflightSealOnly:        true    sourceOnlyNoLive:          true
suppliedPlanOnly:         true    sealDoesNotGrantApproval:  true
sealDoesNotDispatchExecution: true
```

## Public API

```ts
// Build the seal from a ComplexityExecutionPlanDraftPacket
function buildComplexityExecutionPlanPreflightSeal(
  plan: ComplexityExecutionPlanDraftPacket,
  options?: { now?: string },
): ComplexityExecutionPlanPreflightSealPacket;

// Render to human-readable markdown (pure, no IO)
function renderComplexityExecutionPlanPreflightSealMarkdown(
  packet: ComplexityExecutionPlanPreflightSealPacket,
): string;

// Extract a ComplexityExecutionPlanDraftPacket from various input shapes
function extractExecutionPlanDraftForPreflightSeal(
  input: unknown,
): ComplexityExecutionPlanDraftPacket;

// Validate bootstrap context isolation
function checkPreflightSealBootstrapContextIsolation(): string[];

// Key types
type ComplexityExecutionPlanPreflightSealState =
  | "preflight_seal_ready"
  | "plan_safety_blocked"
  | "lineage_invalid"
  | "boundary_violation"
  | "semantic_violation"
  | "seal_failed_closed";

interface ComplexityExecutionPlanPreflightSealPacket { /* … */ }
interface ComplexityExecutionPlanPreflightSealCheck { /* … */ }
interface ComplexityExecutionPlanPreflightSealVerification { /* … */ }
```

## Fixtures

Located in `fixtures/complexity-execution-plan-preflight-seal/`:

| Fixture | Description |
|---------|-------------|
| `simple-autonomous-preflight-input.json` | Simple autonomous plan (approval not required) |
| `moderate-sequential-preflight-input.json` | Moderate sequential plan with approval gate |
| `complex-parallel-preflight-input.json` | Complex parallel plan with multiple subagent roles |
| `critical-blocked-preflight-input.json` | Critical plan safety blocked — produces `seal_failed_closed` |

## CLI

```sh
npm run complexity_execution_plan_preflight_seal -- \
  --input fixtures/complexity-execution-plan-preflight-seal/simple-autonomous-preflight-input.json \
  [--json|--markdown] [--now <iso>]
```

## Test coverage

13 tests covering:

- All 4 fixtures loaded and produce source-only packets
- Autonomous, operator-approval-gated, and complex parallel seal states
- Fail-closed for safety-blocked, boundary-violation, semantic-violation,
  and lineage-invalid inputs
- Unknown decision produces warn but does not block
- Extraction from direct and wrapped inputs
- Markdown rendering for ready and blocked states
- Deterministic idempotency key (identical inputs → identical seal key)

## Related

- Parent issue: [#982 — Complexity execution plan draft][982]
- Grandparent: [#978 — Finalizer approval envelope draft][978]
- Pattern: [#988 — Mobile worker preflight][988]
- Pattern: [#963 — Terminal brief sidecar dispatcher preflight seal][963]

[982]: https://github.com/jinwon-int/a2a-broker/issues/982
[978]: https://github.com/jinwon-int/a2a-broker/issues/978
[988]: https://github.com/jinwon-int/a2a-broker/issues/988
[963]: https://github.com/jinwon-int/a2a-broker/issues/963
