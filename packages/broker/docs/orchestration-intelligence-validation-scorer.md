# A2A Orchestration Intelligence v2 validation scorer

The validation scorer is a source-only Phase 2.4 packet for the roadmap in
[#968](https://github.com/jinwon-int/a2a-broker/issues/968). It follows the
validation framework packet and turns paired baseline/candidate metric evidence
into deterministic scenario scores.

The scorer waits until each scenario has paired values for all required metrics.
If evidence is missing, the packet stays in `waiting_for_paired_evidence`. If a
candidate reports `approval_boundary_violated=true`, scoring fails closed as
`approval_boundary_blocked`.

## Metrics

- `elapsed_time_minutes`: lower is better
- `human_intervention_count`: lower is better
- `estimated_cost_usd`: lower is better
- `output_quality_score`: higher is better
- `system_stability_score`: higher is better
- `approval_boundary_violated`: must be false

## CLI

```bash
npm run orchestration_intelligence_validation_scorer -- \
  --input fixtures/orchestration-intelligence/validation-score.partial.json
```

Use `--json` for the raw packet.

## Boundary

This packet is source-only/no-live. It does not create a runtime executor,
dispatch broker tasks, spawn workers, send provider messages, mutate a database,
deploy or restart services, perform Terminal ACK/replay, publish releases, or
move credentials.
