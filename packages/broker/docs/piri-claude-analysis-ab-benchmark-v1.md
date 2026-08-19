# Piri vs Claude Code analysis A/B benchmark v1

This runbook defines the paired, broker-backed comparison required by
`a2a-nexus#1797`. It compares piri (`kimi-coding/k3`) with the Claude Code
adapter mapped to Z.AI `glm-5.2[1m]` without treating the 2026-08-07 single
pair as a statistical result.

## Safety and approval boundary

The checked-in manifest and evaluator are source-only and do not dispatch
tasks. Every real arm invokes a model provider, so a fresh operator approval
must name the manifest revision, five pairs, the 50-request Kimi reservation,
the broker, and the target workers. Deployment, worker restart, credential
access, cross-broker mutation, and terminal ACK/replay remain separate approval
boundaries.

Before the first arm:

1. Verify both workers are idle and report the intended adapter/provider/model.
   Preserve a timestamped registry/config evidence reference in each arm.
   **The worker's env/metadata label is not sufficient adapter evidence**: a
   true adapter arm requires the target worker's resolved analysis bridge
   command (`A2A_PIRI_ANALYSIS_BIN` → `A2A_HERMES_ANALYSIS_BIN` →
   `A2A_OPENCLAW_ANALYSIS_BIN` → `OPENCLAW_BIN` → default) to actually point at
   the matching bridge binary. On 2026-08-19 a worker labeled `claude_code`
   (stale runtime-flavor hint) executed `piri-a2a-analysis-bridge.mjs` for
   every "claude" arm. The evaluator therefore requires each arm's
   `runtimeEvidence.bridgeBinary` (the handler-reported `bridgeCommand`
   basename) and fails closed when it contradicts the claimed adapter.
2. Record a provider-backed Kimi 5-hour remaining-request snapshot. Do not run
   when fewer than 100 of 359 requests remain or telemetry is unavailable.
3. Bind every task to manifest `baseRevision` and compute one canonical input
   digest. Both arms of a pair must carry that exact digest.
4. Randomize arm order per pair, run sequentially, and use a fresh session for
   every arm. Abort when a piri sample exceeds ten requests or the total piri
   reservation exceeds 50.

## Four measurement axes

- Schema fit: the broker result must contain `analysisStatus`,
  `analysisSummary`, `findings`, `risks`, `recommendations`, and
  `evidenceRefs` with the expected types.
- Quality: an independent scorer awards the same 4/3/2/1 rubric for
  correctness, source grounding, risk identification, and actionability. Each
  award requires a rationale and evidence references.
- Cost: `executionTelemetry.modelRequests` is mandatory for both arms. Token
  and USD values are reported only when the underlying CLI supplies them; they
  must never be invented. Kimi budget accounting uses request count.
- Latency: execution latency comes from the bridge telemetry; broker wall time
  comes from task creation/completion timestamps.

The deliberately incomplete `insufficient-evidence-calibration` sample should
return `blocked`. A confident `done` is a quality failure, not a stronger
answer.

## Evaluation

Store broker task IDs, evidence URLs, exact input digests, outputs, telemetry,
timestamps, and independent rubric scores in a result JSON. Then run:

```bash
node scripts/piri-claude-analysis-ab-benchmark.mjs \
  --manifest fixtures/piri-claude-analysis-ab/manifest-v1.json \
  --results /path/to/results.json
```

The evaluator fails closed on missing pairs, mismatched inputs, missing
broker-backed evidence, reused task IDs, unbalanced/non-sequential arm order,
truncated or missing request counts, budget gate violations, or incomplete
rubric scoring. A valid aggregate is evidence for a decision; it does not
itself deploy, switch defaults, or close the issue.
