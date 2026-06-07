# A2A Orchestration Intelligence v2 validation operator review request

The validation operator review request is a source-only Phase 2.4 packet for
the roadmap in [#968](https://github.com/jinwon-int/a2a-broker/issues/968). It
consumes the validation finalizer review packet and converts its state into an
operator-facing review request.

This packet is a review request draft only. It does not grant execution
approval. It does not create runtime executors, dispatch broker tasks, spawn
workers, send providers, perform Terminal ACK/replay, mutate a database, deploy
or restart services, publish releases, or move credentials.

## Request states

- `operator_review_request_ready`: validation results are ready to present to
  the operator as source-only review evidence.
- `evidence_incomplete`: paired baseline/candidate metrics are still missing.
- `approval_boundary_blocked`: an approval-boundary violation blocks review
  until reconciled.
- `candidate_review_required`: all evidence is present, but degraded candidate
  metrics require broker/operator review.

## CLI

```bash
npm run orchestration_intelligence_validation_operator_review_request -- \
  --input fixtures/orchestration-intelligence/validation-operator-review-request.ready.json
```

Use `--json` for the raw packet.

## Boundary

This packet is source-only/no-live. A ready packet may be shown to an operator
as review evidence, but any execution approval, runtime dispatch, worker spawn,
provider send, Terminal ACK/replay, DB mutation, deploy/restart, release, or
credential movement remains a separate approval-gated action.
