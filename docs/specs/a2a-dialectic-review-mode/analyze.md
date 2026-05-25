# Spec Analysis: A2AD Dialectic Review Mode

## Inputs

- Spec: `docs/specs/a2a-dialectic-review-mode/spec.md`
- Tasks: `docs/specs/a2a-dialectic-review-mode/tasks.md`
- Related issues: [#436](https://github.com/jinwon-int/a2a-plane/issues/436)
- Parent tracker: [#443](https://github.com/jinwon-int/a2a-plane/issues/443)
- Existing reference: `packages/broker/src/trading-dialectic/` (trading-specific implementation)

## Consistency checks

- [x] Problem statement matches the proposed scope — roadmap issue #436 explicitly calls for
  role templates, evidence packet shape, broker synthesis, and opt-in boundaries.
- [x] User/operator stories cover thesis, antithesis, rebuttal, synthesis, and broker roles.
- [x] In-scope and out-of-scope sections are cleanly separated; no deployment, DB mutation,
  or restart items are in scope.
- [x] Tasks cover every implementation and validation item in the plan (Phase 1: fixtures
  and conformance; Phase 2: broker source; Phase 3: dispatch wrapper).
- [x] Rollback/failure handling exists — cancellation preserves completed phases, and
  each phase submission is independently validated.

## Safety checks

- [x] Secrets/private data handling is explicit — role assignments use agent IDs, not
  credentials; broker must redact sessionKey/nodeId from public evidence.
- [x] Approval-sensitive actions are named and not silently included — all deployment,
  restart, DB mutation items are explicitly out of scope.
- [x] Broker foreground liveness risk is addressed — A2AD mode uses detached subagent
  or script-based worker dispatch; broker is not blocked during phase execution.
- [x] Worker isolation boundary is addressed — each role is a separate worker task;
  no cross-role access to other phases' data before submission.
- [x] Evidence requirements are sufficient for finalizer judgment — synthesisCard
  includes facts, assumptions, risks, tests, dissenting notes, and recommendation.
- [x] Wiki/runbook follow-up is identified — Team1 operator runbook update is deferred
  to Phase 3.

## A2A routing / ownership checks

- [x] Exactly one broker of record/finalizer is named: the operator who owns the review.
- [x] Team1/Team2/cross-team ownership is unambiguous — A2AD is broker-agnostic; each
  phase worker is registered with the owning broker.
- [x] Handoff/cross-broker behavior is explicit — A2AD tasks may be children of
  parent-round dispatches following the existing handoff contract.
- [x] Duplicate operator-facing notifications are prevented — the review produces one
  evidence packet; parent-round aggregation follows existing Terminal Brief rules.
- [x] Failure fallback behavior is explicit — phase timeouts cancel; operator may
  reassign roles.

## Coverage gaps

| Gap | Severity | Required fix before implementation? | Owner |
| --- | --- | --- | --- |
| No explicit maximum review duration | Low | No | May be added in broker implementation |
| Rebuttal-waiver path (skip rebuttal explicitly) | Low | No | Documented as optional; clarify if operator must specify at creation |
| Role reassignment during active review | Medium | No | Deferred to Phase 2; requires operator approval |
| Multi-reviewer / multi-critic aggregate | Low | No | Out of scope for the first slice |
| A2AD evidence packet in terminal-outbox | Low | No | Deferred — existing terminal evidence patterns apply |

## Analysis outcome

- [x] Ready for specification PR.
- [ ] Needs plan update.
- [ ] Needs tasks update.
