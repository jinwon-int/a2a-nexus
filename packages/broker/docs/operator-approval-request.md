# Operator Approval Request for Sealed Execution Plan

> **Issue**: [#990 Team2 Dungae](https://github.com/jinwon-int/a2a-broker/issues/990)
> **Parent**: [#968](https://github.com/jinwon-int/a2a-broker/issues/968)
> **Status**: Draft (source-only, no-live)

## Overview

The `operator-approval-request` module sits at the end of the complexity pipeline:

```
complexity classifier (#970)
  → orchestration recommendation (#971)
    → approval envelope draft (#978)
      → execution plan draft (#982)
        → preflight seal (#989)
          → operator approval request (#990)  ← THIS MODULE
```

It consumes a `ComplexityExecutionPlanPreflightSealPacket` (#989) and produces a
deterministic, operator-facing **approval request draft** — before any
separately-gated execution or sealing path.

The approval request presents:

| Field | Description |
|---|---|
| `selectedPlanId` | Which execution plan is being requested for approval |
| `risks` | Categorized risk summary (critical/high/medium/low/none) |
| `requiredApprovals` | Required approval gates (who/what must approve) |
| `abortConditions` | Conditions that trigger automatic abort |
| `evidenceRefs` | Links to supporting evidence artifacts |
| `idempotencyKey` | Deterministic key for idempotent submission |
| `expiration` | Approval expiration guidance (hard/soft) |
| `operatorNotes` | Actionable notes for the operator |

## Safety Boundaries

The approval request is **strictly a draft**. It does NOT:

- Grant approval — `boundaries.approvalGranted = false`
- Dispatch execution — `boundaries.executionDispatched = false`
- Seal a plan — `semantics.performsSeal = false`
- Open an execution window — `semantics.opensExecutionWindow = false`
- Mutate DB — `semantics.performsDbMutation = false`
- Deploy or restart services — `semantics.performsRuntimeRestartOrDeploy = false`
- Move secrets — `semantics.movesSecretsOrCredentials = false`
- Send provider messages — `semantics.performsProviderSend = false`
- Perform ACK/replay — `semantics.performsTerminalAck = false`

All execution/dispatch/live mutation booleans remain `false`.

## Execution Mode Mapping

The approval request state depends on the execution mode from the source plan:

| Execution Mode | Request State | Autonomous Exec | Notes |
|---|---|---|---|
| `autonomous` | `approval_not_needed` | Blocked: `false` | No operator review needed |
| `operator_notify` | `approval_request_ready` | Blocked: `false` | Notification before execution |
| `operator_approval_gated` | `approval_request_ready` | Blocked: `false` | Explicit approval required |
| `operator_review_gated` | `approval_request_ready` | **Blocked: `true`** | Mandatory review, all blocked |
| (unknown) | `approval_request_blocked` | Blocked: `true` | Safety block |

### Autonomous

- No operator approval required
- Low-severity risk profile
- No required approval gates
- Soft abort conditions only

### Operator notify

- Operator notification required before execution
- Low-severity risk profile
- Optional acknowledgment gate
- Soft abort conditions

### Operator approval gated

- Explicit operator approval required before execution
- Medium-severity risk profile
- One mandatory approval gate
- Hard abort on operator decline or expiration
- 24-hour approval window

### Operator review gated

- **All execution is BLOCKED** pending operator review
- Critical-severity risk profile
- All gates mandatory
- Hard abort on all operator decline paths
- 12-hour approval window
- **No autonomous execution under any circumstances**

## Risk Profiles

### Autonomous / Operator notify

- **Risk severity**: Low
- **Acknowledgment**: Not required
- **Mitigation**: Review plan details; monitor execution logs

### Operator approval gated

- **Risk severity**: Medium
- **Risks**:
  - Subagent execution requires explicit approval
  - Subagent complexity with moderate orchestration
- **Acknowledgment**: Required for subagent roles

### Operator review gated

- **Risk severity**: Critical
- **Risks**:
  - Critical execution — autonomous execution BLOCKED
  - No autonomous subagent permitted
  - Potential live impact
- **Acknowledgment**: Required for all risks

## Abort Conditions

| Mode | Hard Aborts | Soft Aborts |
|---|---|---|
| Autonomous | — | Execution failure |
| Operator notify | — | Notification delivery failure |
| Operator approval gated | Operator declines, Approval expiry | Subagent execution failure |
| Operator review gated | All paths blocked, Decline after review, Review window expiry | — |

## Evidence References

- **Preflight seal**: Always required (URI: `seal:<idempotencyKey>`)
- **Execution plan draft**: Referenced through `sourcePlanIdempotencyKey`
- **Approval envelope draft**: Required for operator_approval_gated mode
- **Orchestration recommendation**: Required for operator_review_gated mode

## API

### `buildOperatorApprovalRequestFromPreflightSeal(seal, options?)`

Consumes a `ComplexityExecutionPlanPreflightSealPacket` and returns an
`OperatorApprovalRequestPacket`.

```typescript
import { buildOperatorApprovalRequestFromPreflightSeal } from "./operator-approval-request.js";

const request = buildOperatorApprovalRequestFromPreflightSeal(seal, {
  now: "2026-06-01T12:00:00.000Z", // optional, defaults to Date.now()
});
```

### `renderOperatorApprovalRequestMarkdown(packet)`

Renders an `OperatorApprovalRequestPacket` to human-readable markdown. Pure
function — no IO, no side effects.

```typescript
import { renderOperatorApprovalRequestMarkdown } from "./operator-approval-request.js";

const markdown = renderOperatorApprovalRequestMarkdown(request);
```

## CLI

```bash
npx tsx scripts/operator-approval-request.mjs <input.json> [--pretty]
```

Reads a `ComplexityExecutionPlanPreflightSealPacket` from a JSON file and outputs
the rendered markdown to stdout.

## Tests

```bash
npx tsx --test src/core/operator-approval-request.test.ts
```

Coverage:

- Packet structure and kind/version
- Execution mode → approval request mapping (all 5 modes)
- Full pipeline: #970 → #971 → #978 → #982 → #989 → #990
- Risk profiles per mode
- Required approvals per mode
- Abort conditions per mode
- Evidence references
- Approval expiration computation
- Idempotency key stability
- Title and summary generation
- Markdown rendering
- Next actions
- Symbolic boundary enforcement
- Pipeline separation (no overlap with prior pipeline packet kinds)
- Blocker generation for safety-blocked plans
- No-live boolean enforcement

## Fixtures

Located in `fixtures/operator-approval-request/`:

```
fixtures/operator-approval-request/
  simple-autonomous-plan.json             # Trace: source execution plan packet
  simple-autonomous-preflight-seal.json   # Input: preflight seal packet
  simple-autonomous-request.json          # Output: approval request packet
  simple-autonomous-request.md            # Output: rendered markdown
  moderate-sequential-plan.json
  moderate-sequential-preflight-seal.json
  moderate-sequential-request.json
  moderate-sequential-request.md
  complex-parallel-plan.json
  complex-parallel-preflight-seal.json
  complex-parallel-request.json
  complex-parallel-request.md
  critical-blocked-plan.json
  critical-blocked-preflight-seal.json
  critical-blocked-request.json
  critical-blocked-request.md
```

Generated by `scripts/generate-operator-approval-request-fixtures.ts`.

To regenerate:

```bash
npx tsx scripts/generate-operator-approval-request-fixtures.ts
```

## Related

- [Complexity execution plan draft (#982)](./complexity-execution-plan-draft.md)
- [Approval envelope draft (#978)](./complexity-finalizer-approval-envelope-draft.md)
- [Orchestration recommendation (#971)](./complexity-orchestration-recommendation-dry-run.md)
- [Preflight seal docs](./terminal-brief-sidecar-dispatcher-preflight-seal.md)

## References

- Issue: https://github.com/jinwon-int/a2a-broker/issues/990
- Parent: https://github.com/jinwon-int/a2a-broker/issues/968
- Run ID: `a2a-oi-v2-plan-review-20260529T1236Z`
- Task ID: `a2a-oi-v2-990-dungae-20260529T1236Z`
