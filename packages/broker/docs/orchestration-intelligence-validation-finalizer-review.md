# A2A Orchestration Intelligence v2 validation finalizer review

The validation finalizer review is a source-only Phase 2.4 packet for the
roadmap in [#968](https://github.com/jinwon-int/a2a-broker/issues/968). It
consumes the validation score packet and converts score state into an explicit
broker-finalizer review state.

This packet does not grant execution approval. A `review_ready` result only
means the score packet can be prepared for operator review. Runtime execution,
worker dispatch, deploys, restarts, provider sends, Terminal ACK/replay, DB
changes, releases, and credential movement still require separate approval.

## Review states

- `review_ready`: all scenarios are score-ready and no degraded metric needs
  broker review.
- `evidence_incomplete`: paired baseline/candidate metrics are still missing.
- `approval_boundary_blocked`: scoring found an approval-boundary violation.
- `candidate_needs_review`: all evidence is present, but at least one scenario
  has degraded candidate metrics.

## CLI

```bash
npm run orchestration -- orchestration_intelligence_validation_finalizer_review \
  --input fixtures/orchestration-intelligence/validation-finalizer-review.ready.json
```

Use `--json` for the raw packet.

## Boundary

This packet is source-only/no-live. It does not create a runtime executor,
dispatch broker tasks, spawn workers, send provider messages, mutate a database,
deploy or restart services, perform Terminal ACK/replay, publish releases, or
move credentials.
