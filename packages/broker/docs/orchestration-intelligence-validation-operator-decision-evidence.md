# A2A Orchestration Intelligence v2 validation operator decision evidence

The validation operator decision evidence ingestor is a source-only Phase 2.4
packet for the roadmap in [#968](https://github.com/jinwon-int/a2a-broker/issues/968).
It consumes a validation operator review request and optional decision evidence,
then classifies whether that evidence is accepted, missing, conflicting, or
blocked by the request state.

This packet records decision evidence only. It does not grant execution
approval. It does not create runtime executors, dispatch broker tasks, spawn
workers, send providers, perform Terminal ACK/replay, mutate a database, deploy
or restart services, publish releases, or move credentials.

## Evidence states

- `decision_evidence_accepted`: decision evidence matches the current review
  request and is compatible with the request state.
- `decision_evidence_missing`: no decision evidence was provided.
- `decision_evidence_conflicting`: evidence references a different review
  request idempotency key.
- `decision_blocked_by_request_state`: the decision attempts to advance while
  the request still requires missing evidence, approval-boundary reconciliation,
  or degraded-candidate review.

## CLI

```bash
npm run orchestration_intelligence_validation_operator_decision_evidence -- \
  --input fixtures/orchestration-intelligence/validation-operator-decision-evidence.accepted.json
```

Use `--json` for the raw packet.

## Boundary

Accepted decision evidence is still source-only evidence. A future execution,
runtime dispatch, worker spawn, provider send, Terminal ACK/replay, DB mutation,
deploy/restart, release, or credential movement remains separately
approval-gated.
