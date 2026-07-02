# A2A Orchestration Intelligence v2 broker dispatch approval decision evidence

The broker dispatch approval decision evidence packet is the source-only packet
that follows the broker dispatch approval request for roadmap
[#968](https://github.com/jinwon-int/a2a-broker/issues/968).

It consumes the broker dispatch approval request's readiness and classifies
the operator's decision evidence into deterministic states.

## Decision states

| State | Meaning |
|---|---|
| `broker_dispatch_approval_evidence_accepted` | All checks pass; evidence recorded as source-only readiness |
| `broker_dispatch_approval_evidence_missing` | No operator decision evidence provided yet |
| `broker_dispatch_approval_evidence_rejected` | Operator explicitly rejected broker dispatch approval |
| `broker_dispatch_approval_evidence_expired` | Operator approval evidence has expired |
| `broker_dispatch_approval_evidence_conflicting` | Evidence references a different request or upstream state |
| `broker_dispatch_approval_evidence_invalid` | One or more checks failed (mismatched phrase, scope, etc.) |
| `broker_dispatch_approval_request_not_ready` | Upstream broker dispatch approval request is incomplete |
| `broker_dispatch_boundary_review_required` | Upstream approval-boundary review is required before proceeding |
| `broker_dispatch_candidate_revision_required` | Upstream candidate revision is required before proceeding |

## Decision evidence dimensions

- broker dispatch approval request is ready (`dispatch_approval_request_ready`)
- decision kind is `approval_grant`
- operator matches the request
- approval phrase matches exactly
- approvedAt is parseable and not in the future
- approval is not expired
- target repo and issue match
- dispatch scope covers the requested scope
- conditions are explicitly accepted
- revocation or expiry is documented

All dimensions must pass for `broker_dispatch_approval_evidence_accepted`.

## Runtime evidence patch

When the decision evidence is accepted, the packet emits a conservative
runtime readiness evidence patch:

- `runtimeExecutorDesignReviewed=true`
- `explicitRuntimeApprovalPresent=true`
- `brokerDispatchApprovalPresent=true` (source readiness flag only)
- `validationEvidenceFresh=true`
- `workerSpawnApprovalPresent=false`
- `mobilebetaMobileScopeResolved=false`
- `rollbackAbortCriteriaDocumented=false`
- `liveBoundaryPlanDocumented=false`

**`brokerDispatchApprovalPresent=true` does not imply:**
- runtime executor enablement
- actual broker task dispatch
- worker or subagent spawn
- live provider send
- mobilebeta/mobile expansion
- rollback or live readiness
- deployment permission

## CLI

```bash
npm run orchestration_intelligence_broker_dispatch_approval_decision_evidence -- \
  --input fixtures/orchestration-intelligence/broker-dispatch-approval-decision-evidence.accepted.json
```

Use `--json` for the raw packet.

## Boundary

This packet is source/docs/tests only. It records explicit broker dispatch
approval evidence for a later readiness gate, but it does not grant execution
approval, create broker tasks, invoke executors, spawn workers/subagents, mutate
TaskFlow/DB, send providers, or touch live services. All fail-closed readiness
fields except `brokerDispatchApprovalPresent` remain false; even that field is a
source-evidence-only flag, not runtime permission.
