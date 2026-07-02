# Operator-approved execution plan dispatch request

Issue: [#991](https://github.com/jinwon-int/a2a-broker/issues/991)
Parent: [#968](https://github.com/jinwon-int/a2a-broker/issues/968)
Run: `a2a-oi-v2-plan-review-20260529T1236Z`
Lane: Team2 — workereta

This layer sits after the operator approval request draft (#990). It converts a
sanitized approval request packet plus explicit operator approval evidence into
a deterministic dispatch request that an adapter or finalizer can consume.

The dispatch request separates:

- what the operator approval request prescribes;
- what the operator explicitly approved, denied, or left pending; and
- which steps are permanently blocked (operator review steps that can never
  become approved).

It is deliberately non-executing: the output is a source-only dispatch request
that never dispatches, invokes, spawns, starts, enables live activation, sends
providers, deploys, restarts Gateway/broker/workers, ACKs Terminal Briefs,
mutates a production database, posts to the community, merges/approves PRs,
rewrites history, or force-pushes.

## Input shape

The canonical builder consumes:

- `OperatorApprovalRequestPacket` (#990), directly or under
  `operatorApprovalRequest`, `approvalRequest`, `request`, or `packet`;
- `OperatorApprovalInput` with `planDecision`, `stepDecisions`, `operator`,
  optional `comment`, and optional `approvalReference`;
- optional dispatch request options (`mode`, `operatorIdentity`, or
  `dispatchRequestReference`).

This PR adds the pure source module and tests only. It does not add a live
broker route or dispatch CLI.

## States

| State | Meaning |
| --- | --- |
| `dispatch_request_ready` | Execution plan is ready and operator has approved (fully or partially). |
| `waiting_for_execution_plan` | Execution plan draft is not yet ready. |
| `waiting_for_operator_approval` | Operator has not yet provided approval decisions. |
| `plan_denied` | Operator explicitly denied the plan. |
| `plan_stale` | Execution plan is stale and must be refreshed. |
| `plan_safety_blocked` | Execution plan is safety blocked (unknown envelope category or invariant failure). |
| `blocked` | Generic blocked state. |

## Packet contents

The bundle contains:

- a deterministic dispatch request packet with `idempotencyKey` derived from
  the source execution plan idempotency key, approval decisions, operator
  identity, and dispatch request reference;
- source execution plan references: `executionPlanIdempotencyKey`,
  `executionPlanDecision`, `executionPlanMode`, `executionBlocked`,
  `approvalRequired`;
- operator approval metadata: `operatorIdentity`, `planDecision`,
  `approvalReference`, `operatorComment`, and step decision counts;
- categorized dispatch items: `approvedItems`, `deniedItems`, `pendingItems`,
  `blockedPermanentlyItems`;
- evidence references for the dispatch chain;
- blockers, next actions, and excluded approval-sensitive actions.

## Safety invariants

### operator_review steps CAN NEVER become approved

The dispatch request enforces a hard invariant: any step with
`kind === "operator_review"` is placed in `blockedPermanentlyItems` regardless
of what the operator approval input says. An operator cannot accidentally
(or maliciously) approve a review-critical step through this packet.

Evidence:

- The `categorizeSteps` helper always maps `operator_review` steps to
  `blocked_permanently` status, overriding any operator decision.
- The `blockers` list includes a safety block line if an operator attempts to
  approve a review step.
- `semantics.operatorReviewStepsRemainBlocked` is `true` when any review step
  exists.

### Dispatch does not execute

All safety gates are statically set to `false`:

- `readiness.dispatchPermitted: false`
- `readiness.executorInvocationPermitted: false`
- `readiness.processSpawnPermitted: false`
- `readiness.sidecarStartPermitted: false`
- `readiness.executionPermitted: false`

All `integrationContract` and `semantics` execution fields are `false`.

### Idempotency

The `idempotencyKey` is derived from the source execution plan idempotency key,
the approval plan decision, operator identity, dispatch request reference, and
generation timestamp. Identical inputs produce identical keys.

## Fixture format

```json
{
  "input": {
    "intent": "...",
    "targetEnvironment": "...",
    "policyContext": { ... },
    "complexitySignals": { ... }
  },
  "operatorApproval": {
    "planDecision": "plan_approved",
    "stepDecisions": [
      { "stepId": "step-abc123", "status": "approved", "comment": "OK" },
      { "stepId": "step-def456", "status": "denied", "comment": "Blocked" }
    ],
    "operator": "operator-name",
    "approvalReference": "approval-ref-001"
  }
}
```

## Safety boundaries

This dispatch request does **not**:

- dispatch or invoke any executor;
- spawn any process or start/stop the sidecar;
- enable Terminal Brief default-on;
- send live provider/Hermes/mobilealpha/Telegram/OpenClaw messages;
- ACK, replay, or mutate terminal receipt rows;
- merge PRs, close issues, or post GitHub comments;
- create TaskFlow records or mutate broker DB state;
- deploy, restart, or reconfigure Gateway/broker/workers;
- perform historical replay, release, publish, or version tag;
- move, expose, or print secrets or credentials.

Any future live dispatch adapter must preserve separation between:

1. dispatch request (this packet);
2. real executor dispatch (separate gate);
3. idempotent action execution;
4. receipt/visibility evidence.

Each live step needs explicit operator approval and its own idempotency boundary.

## Runtime/bootstrap context safety

Before any PR or artifact evidence is produced, fail closed if runtime/bootstrap
context files would enter the branch or evidence, including `AGENTS.md`,
`SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or
`.openclaw/**`. The dispatch request itself only emits sanitized ids, step
labels, evidence references, and decision fields.
