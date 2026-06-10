# Source-Public Execution Orchestrator

**Issue:** [#263](https://github.com/jinwon-int/plugin-a2a/issues/263)
**Parent:** [a2a-plane#218](https://github.com/jinwon-int/a2a-plane/issues/218)
**Run:** `a2a-source-public-execution-orchestrator-20260511T023207Z`

## Overview

The source-public execution orchestrator converts approved evidence packets (from the approval rehearsal module) into deterministic, explicitly operator-gated execution plans. It is a **simulation/dry-run layer only** — it never executes approval, visibility changes, provider sends, or terminal ACK.

## Key Capabilities

### 1. Deterministic Execution Plans
- Takes a `SourcePublicApprovalPacket` (or full rehearsal report) and produces a `SourcePublicExecutionPlan`
- Every plan is deterministically reproducible given the same inputs
- Plans carry explicit `runId`, `producedAt`, and `schema` markers

### 2. Dry-Run / Simulate Mode
- All execution steps are either `simulateOnly` or `operatorGated`
- Steps like `execute_approval`, `visibility_change`, `release_publish`, `provider_notify`, and `terminal_acknowledge` are **always simulate-only**
- Mode is always `dry_run` or `simulate` in this round

### 3. Scanner / History Binding
- Binds execution plans to GitHub issue URLs, PR URLs, and comment evidence
- Produces a `manifestDigest` (deterministic hash) for plan integrity verification
- Scanner artifacts include `evidenceSource` for traceability

### 4. Rollback / Abort Runbook
- Every step has explicit `rollbackAction` and `abortAction`
- Global abort path available at any point
- Per-step partial rollback paths via `runbook.partialRollbacks`

### 5. Idempotency / Replay Protection
- Each plan carries a unique `dedupeKey` derived from the source packet
- `IdempotencyGuard` includes `registered: false`, `replayDetected: false`, and a cryptographic nonce
- Deterministic key generation prevents accidental duplicate execution

### 6. Preflight Failure Semantics
- Comprehensive preflight checks before any step proceeds
- Each check carries `passed`, `required`, `message`, and optional `remediation`
- Failures cascade: hard blockers → `NO_GO`, waivable → `NEEDS_OPERATOR_APPROVAL`

## Usage

```typescript
import {
  buildSourcePublicExecutionPlan,
  simulateSourcePublicExecution,
  validateExecutionPlan,
  projectExecutionStatus,
} from "plugin-a2a";

// Build a plan from an approval packet
const plan = buildSourcePublicExecutionPlan(
  { approvalPacket: rehearsalReport },
  config,
  { runId: "my-run" },
);

// Simulate explicitly
const simulated = simulateSourcePublicExecution(
  { approvalPacket: packet },
  config,
);

// Validate plan integrity
const validation = validateExecutionPlan(plan);
if (!validation.valid) {
  console.error("Plan validation failed:", validation.errors);
}

// Project operator-facing status
const status = projectExecutionStatus(plan);
console.log(`Status: ${status.status} — ${status.summary}`);
```

## Decision Flow

```
Approval Rehearsal → GO_CANDIDATE / NEEDS_OPERATOR_APPROVAL / NO_GO
                         ↓
    buildSourcePublicExecutionPlan()
                         ↓
    ExecutionPlan with: steps, preflight, binding, runbook, idempotency
                         ↓
    validateExecutionPlan() → valid / invalid
                         ↓
    projectExecutionStatus() → ready / awaiting_operator / needs_attention / blocked
```

## Safety Invariants

All plans carry immutable safety invariants:
- `liveExecution: false` — never executes
- `visibilityChange: false` — never changes visibility
- `noApprovalExecution: true` — approval is never executed
- `noReleasePublication: true` — no release is published
- `noProviderSend: true` — never sends to live providers
- `noTerminalAck: true` — never produces terminal ACK
- `noDeploy: true` — never deploys
- `noDbMutation: true` — never mutates DB
- `operatorGated: true` — always requires operator approval

## Non-Goals

- No source-public execution, release publication, or visibility change
- No production deploy/restart, Gateway/broker/worker restart
- No live provider/Telegram send, terminal ACK
- No DB mutation, secret change, history rewrite, or force-push
