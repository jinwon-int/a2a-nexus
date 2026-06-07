# A2A Adaptive Work Mode Selector

This source-only selector records the A2A execution lane after a short planning
and output-estimation step. It keeps work-mode mechanics out of the user-facing
request path: the operator gives a normal instruction, the broker/session
estimates the task shape, then records the selected lane before execution.

The selector record does not dispatch workers, restart services, mutate
databases, ACK or replay Terminal Brief rows, send providers, publish releases,
move credentials, or change repository visibility.

## Flow

```text
user instruction
  -> intake
  -> short plan / task decomposition
  -> output, duration, risk, evidence, and role estimate
  -> workMode decision record
  -> execution lane
```

## Modes

| Mode | Use when | Fallback |
| --- | --- | --- |
| `solo` | Short, low-risk, no durable evidence or role split needed; also forced when live/approval boundaries or degraded broker health are present. | `solo` |
| `a2a_direct` | One worker and one evidence packet are useful, but internal fanout would add more overhead than value. | `solo` |
| `a2a_hybrid` | One worker should own the task while internal implement, validate, and evidence roles produce one synthesized packet. | `a2a_direct` |
| `a2a_team` | Multiple repos/nodes need independent evidence packets from broker-level workers. | `a2a_hybrid` |
| `a2ad` | The core task is a decision or tradeoff that benefits from thesis, antithesis, rebuttal, and synthesis. | `a2a_hybrid` |

## Decision Record

```json
{
  "workMode": "a2a_hybrid",
  "reason": "one worker should own the task while internal roles reduce rework",
  "estimatedOutputSize": "medium",
  "estimatedDuration": "moderate",
  "riskLevel": "medium",
  "needsEvidence": true,
  "needsValidation": true,
  "needsDurableState": true,
  "roleSplit": ["implement", "validate", "evidence", "finalizer"],
  "fallbackMode": "a2a_direct"
}
```

The actual packet also includes `sourceOnlyDecision: true`,
`plannedBeforeModeSelection: true`, and `dispatchAllowedByThisRecord: false`.
Those fields are intentional guardrails: the selector explains a lane, but does
not authorize dispatch by itself.

## Representative No-Live Fixtures

```bash
npm run adaptive_work_mode_selector -- \
  --input fixtures/adaptive-work-mode-selector/short-answer.json
npm run adaptive_work_mode_selector -- \
  --input fixtures/adaptive-work-mode-selector/single-repo-code-patch.json
npm run adaptive_work_mode_selector -- \
  --input fixtures/adaptive-work-mode-selector/pr-tests-validation.json
npm run adaptive_work_mode_selector -- \
  --input fixtures/adaptive-work-mode-selector/multi-node-evidence.json
npm run adaptive_work_mode_selector -- \
  --input fixtures/adaptive-work-mode-selector/decision-debate.json
```

Expected classifications:

| Fixture | Expected mode |
| --- | --- |
| `short-answer.json` | `solo` |
| `single-repo-code-patch.json` | `a2a_direct` |
| `pr-tests-validation.json` | `a2a_hybrid` |
| `multi-node-evidence.json` | `a2a_team` |
| `decision-debate.json` | `a2ad` |

## Guardrails

- Do not ask the user to choose a mode unless the choice changes risk, cost, or
  approval boundaries materially.
- Do not select `a2a_hybrid`, `a2a_team`, or `a2ad` before a plan/output
  estimate exists.
- Do not use heavy modes for small tasks unless a fixture or record shows a
  concrete validation/debate/evidence need.
- If broker health is degraded, select `solo` or defer A2A execution.
- If live deploy/restart, DB mutation, Terminal Brief ACK/replay, provider send,
  release, or credential movement enters scope, stop at approval required.

## Related

- `docs/a2a-work-mode-pre-dispatch-decision.md`
- `docs/worker-subagent-orchestration-policy.md`
- `docs/a2a-work-mode-benchmark-analysis-2026-06-06.md`
- `jinwon-int/a2a-broker#1320`
- `jinwon-int/a2a-broker#1321`
