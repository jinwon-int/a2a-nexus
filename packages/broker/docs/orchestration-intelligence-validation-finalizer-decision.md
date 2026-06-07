# A2A Orchestration Intelligence v2 validation finalizer decision

The validation finalizer decision packet is a source-only Phase 2.4 packet for
the roadmap in [#968](https://github.com/jinwon-int/a2a-broker/issues/968).
It consumes the validation operator decision evidence packet and records the
single broker-finalizer disposition for the next source-only step.

This packet is deliberately not an executor gate. It does not grant execution
approval, create runtime executors, dispatch broker tasks, spawn workers, send
providers, perform Terminal ACK/replay, mutate a database, deploy or restart
services, publish releases, or move credentials.

## Finalizer states

- `ready_for_next_source_step`: accepted operator evidence allows the finalizer
  to open the next source-only planning packet if needed.
- `waiting_for_operator_decision`: operator decision evidence is missing.
- `operator_decision_conflict`: decision evidence references a conflicting
  review request.
- `operator_decision_blocked`: the operator decision evidence was blocked by
  its review-request state.
- `collect_more_validation_evidence`: accepted decision asks for more paired
  validation evidence.
- `approval_boundary_review_required`: accepted decision stops closeout for a
  separate approval-boundary review.
- `candidate_revision_required`: accepted decision asks for candidate revision
  before another review.

## CLI

```bash
npm run orchestration_intelligence_validation_finalizer_decision -- \
  --input fixtures/orchestration-intelligence/validation-finalizer-decision.ready.json
```

Use `--json` for the raw packet.

## Boundary

`ready_for_next_source_step` means source-only roadmap advancement only. Any
runtime executor, broker dispatch, worker spawn, provider send, Terminal
ACK/replay, DB mutation, deploy/restart, release, or credential movement remains
separately approval-gated.
