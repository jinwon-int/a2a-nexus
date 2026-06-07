# Operator approval request

**State**: READY FOR REVIEW

- **generatedAt**: 2026-06-01T12:00:00.000Z
- **idempotencyKey**: operator-approval-request:1458e31702f1aa7c502c13ee
- **selectedPlanId**: complexity-execution-plan:bfb2d2639d7e7601f7f0716c

## Request details

**CRITICAL: Operator review required for operator_review**

CRITICAL: The execution plan for "operator_review" requires operator review. All execution is BLOCKED pending operator review. The plan has 2 step(s) at critical complexity. 3 risk(s) identified, 1 mandatory approval gate(s) required, 3 abort condition(s) defined. Autonomous execution is not permitted under any circumstances.

### Source plan

- **executionMode**: operator_review_gated
- **executionBlocked**: true
- **approvalRequired**: true
- **envelopeCategory**: operator_review_required
- **action**: operator_review
- **complexity**: critical
- **stepCount**: 2

- **sourcePlanIdempotencyKey**: complexity-execution-plan:bfb2d2639d7e7601f7f0716c
- **sourceEnvelopeIdempotencyKey**: complexity-finalizer-approval-envelope:ac294018d5643e0760ba1865
- **sourceRecommendationIdempotencyKey**: complexity-orch-recommendation:89d1150bab068f102e55c456

## Risks

### [CRITICAL] Critical execution — autonomous execution BLOCKED

Plan involves critical complexity. Autonomous execution is blocked pending operator review.

- **requiresAcknowledgment**: true
- **mitigation**: Manual operator review is mandatory. Do NOT bypass the review gate.

### [HIGH] No autonomous subagent permitted

No subagent or execution step may proceed autonomously. All paths are blocked.

- **requiresAcknowledgment**: true
- **mitigation**: Operator must manually review and explicitly unblock each step.

### [HIGH] Potential live impact

Critical execution plans may affect live systems. Review must be thorough.

- **requiresAcknowledgment**: true
- **mitigation**: Check all safety gates, verify rollback paths, and ensure evidence is complete.

## Required approvals

### Operator review gate (mandatory)

Operator must complete review before ANY execution can proceed. All paths are blocked.

- **gateId**: gate-07ab172a13b5
- **approver**: authorized operator
- **mandatory**: true

## Abort conditions

### Operator review required — all paths blocked

- **type**: 🔴 Hard abort
- **trigger**: All execution steps are blocked until operator completes review.
- **severity**: critical

### Operator declines after review

- **type**: 🔴 Hard abort
- **trigger**: Operator completes review and declines or blocks execution.
- **severity**: critical

### Review window expires without decision

- **type**: 🔴 Hard abort
- **trigger**: The operator review window expires without a decision from the operator.
- **severity**: high

## Evidence references

- **Complexity execution plan preflight seal**: `seal:complexity-execution-plan-preflight-seal:8468a50b251c7ca8f2a03a4a` *(required)*
- **Execution plan draft**: `plan:complexity-execution-plan:bfb2d2639d7e7601f7f0716c` *(required)*
- **Approval envelope draft**: `source-approval-envelope-draft` *(required)*
- **Orchestration recommendation**: `source-orchestration-recommendation` *(required)*

## Approval expiration

- **expiresAt**: 2026-06-02T00:00:00.000Z
- **reason**: Critical execution plans must be reviewed promptly. Expired reviews require re-evaluation.
- **hardExpiry**: true

## Operator notes

- CRITICAL: All execution is BLOCKED pending operator review.
- No autonomous subagent spawn or execution is permitted under any circumstances.
- Operator review must complete and explicitly grant approval.
- This approval request does NOT and CANNOT grant approval autonomously.
- After review, a separate approval grant path is required.

## Blockers
*(none)*

## Next actions
- Action "operator_review" (critical) requires operator review. Autonomous execution is BLOCKED.
- Route this request to the operator review channel. No subagent spawn, no execution.
- Operator review must complete and explicitly grant approval before any action.
- This request does NOT and CANNOT grant approval autonomously.
- All execution steps are blocked until review completes.

## Boundaries (no-live enforcement)

- **runtimeBehaviorChanged**: false
- **mandatoryProductionSpawn**: false
- **brokerDispatchSemanticsChanged**: false
- **taskFlowMutation**: false
- **dbMutation**: false
- **deployOrRestart**: false
- **secretMovement**: false
- **approvalGranted**: false
- **executionDispatched**: false
- **providerMessageSent**: false
- **terminalAckPerformed**: false
- **sealedPlanConsumed**: false
- **executionWindowOpened**: false

## Semantics

- **approvalRequestDraftOnly**: true
- **approvalNotGranted**: true
- **autonomousExecutionBlocked**: true
- **sourceOnlyNoLive**: true
- **planStepsNotExecuted**: true
- **performsGitHubMutation**: false
- **performsProviderSend**: false
- **performsTerminalAck**: false
- **performsRuntimeRestartOrDeploy**: false
- **performsDbMutation**: false
- **createsTaskFlowRecords**: false
- **performsHistoricalReplay**: false
- **performsReleaseOrPublish**: false
- **movesSecretsOrCredentials**: false
- **performsApprovalGrant**: false
- **performsExecutionDispatch**: false
- **performsSeal**: false
- **opensExecutionWindow**: false

This operator approval request is a draft only. It does not grant approval, dispatch execution, seal a plan, open an execution window, mutate DB, deploy/restart services, move secrets, send provider messages, or perform ACK/replay. All execution/dispatch/live mutation booleans remain false. A separate, later approval grant path is required before any execution.