# A2A Orchestration Intelligence v2 validation framework

This source-only packet defines the validation framework for the four #968 Phase
2.4 scenarios:

- Wiki large refactor
- Skill update sweep
- Complex architecture design
- A2A worker deployment

It records scenario scope, required before/after evidence slots, shared metrics,
and readiness. It does not run the scenarios, score the evidence, dispatch tasks,
spawn workers, send providers, ACK/replay terminals, mutate DB state, deploy,
restart services, publish releases, or move credentials.

## Metrics

The packet keeps the initial comparison focused on:

- elapsed time
- human intervention count
- estimated cost
- output quality score
- system stability score
- approval-boundary violation flag

All four scenarios must have paired baseline and candidate evidence before the
packet reports `framework_ready`.

## CLI

```bash
npm run orchestration -- orchestration_intelligence_validation_framework --input fixtures/orchestration-intelligence/validation-framework.partial.json
npm run orchestration -- orchestration_intelligence_validation_framework --input fixtures/orchestration-intelligence/validation-framework.partial.json --json
```

The CLI renders either Markdown or the deterministic packet JSON after the
normal TypeScript build.
