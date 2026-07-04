# Task acceptance contract

> **Status:** worker-side acceptance contract (#1218, umbrella #1217). Source-only; adds no privileges — the acceptance command runs with the same trust boundary as the task handler itself.

A dispatcher can make "what must pass for this task to be done" part of the task itself, instead of prose in an issue. Attach a machine-checkable command to the task payload:

```json
{
  "payload": {
    "acceptance": {
      "command": ["npm", "run", "check"],
      "expectExitCode": 0,
      "timeoutMs": 120000
    }
  }
}
```

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `command` | yes | — | argv array, executed without a shell |
| `expectExitCode` | no | `0` | exit code that counts as pass |
| `timeoutMs` | no | `120000` | bounds a hung command; timeout is a fail |

## Worker behavior

After the handler succeeds, `A2ABrokerWorker` runs the acceptance command and records the outcome as `result.validation` (`kind: "smoke"`, `metrics.acceptance: true`, exit code, duration):

- **pass** → the task completes with the validation payload attached; the requester and finalizer can read the verdict and metrics from the task record without re-running anything.
- **fail / timeout** → the task is failed with `error.code: "acceptance_failed"` instead of completing. A deliverable that does not pass its own acceptance never reaches `succeeded`.
- **malformed acceptance** → the task is failed with `acceptance_malformed`. A dispatcher that tried to specify acceptance must not silently lose it to a typo (fail-closed).

## Fail-closed evidence rule

`validateTaskCompletionEvidence()` rejects completion when a task declares `payload.acceptance` but the submitted result has no passing smoke validation evidence. This holds even for custom handlers that never ran the acceptance step: absence of evidence is a failure, not a pass. Custom handlers may also run the command themselves (or an equivalent check) and submit their own passing validation payload.

For tasks that require several evidence kinds, submit the optional multi-validation form:

```json
{
  "result": {
    "validations": [
      { "kind": "smoke", "verdict": "pass", "metrics": { "acceptance": true } },
      { "kind": "review", "nodeId": "reviewer-b", "verdict": "pass", "note": "diff matches spec" }
    ]
  }
}
```

When `result.validations[]` is present, acceptance evidence is matched by `kind: "smoke"`. The legacy singleton `result.validation` path remains accepted only for tasks created before `2026-07-04T02:30:00.000Z`; for tasks created at or after that cutoff, a singleton non-smoke validation is rejected with `acceptance_evidence_missing`. Pre-cutoff singleton non-smoke passes still emit `legacy_acceptance_validation_kind_mismatch` so old task records remain auditable without retroactive invalidation.

A `kind: "smoke"` validation with `verdict: "pass"` is the required broker evidence. `metrics.acceptance`/`metrics.exitCode` are recommended and produced by `runTaskAcceptance()`, but they are not required at this cutoff: custom handlers may submit equivalent smoke evidence, and the phase-2 change is intentionally limited to closing the review-verdict-as-acceptance fail-open path.

## Dispatcher guidance

- Use repo-relative commands that the worker's working directory can execute (`npm run check`, a scoped gate script). The runner lane (#1219) covers containerized patch verification; this contract covers the worker process itself.
- One acceptance command per task. If a task needs several checks, wrap them in one script or split the task — heterogeneous bundles are how deliverables get dropped (#1194).
- Timeouts: pick roughly 2× the command's normal duration; the default 120s suits most gate scripts.

Implementation: `src/worker-acceptance.ts`; behavior tests: `src/worker-acceptance.test.ts` (including a real broker + worker round trip for pass and fail paths).

## Broker-side Definition-of-Ready lint (#1234)

Patch/implementation tasks are also linted at creation time so underspecified work is visible before a worker starts. The rollout is deliberately two-stage:

- Default mode is `warn`: the broker accepts the task and emits a structured `spec_underspecified` warning.
- `enforce` mode rejects new underspecified patch tasks with `error.code: "spec_underspecified"` and `error.details.missing`.

Enable enforce mode with `A2A_TASK_READINESS_MODE=enforce` (or `BROKER_TASK_READINESS_MODE=enforce`) or by passing `taskReadinessMode: "enforce"` to `createBrokerServer` / `InMemoryA2ABroker`. Existing task-id idempotency is checked before readiness lint, so replaying an already-created task does not retroactively apply a stricter mode.

Required fields for patch/implementation tasks:

| Payload field | Meaning |
| --- | --- |
| `acceptance` | Machine-checkable acceptance command using the contract above. |
| `declaredScope.paths` | Non-empty list of repo paths the patch is allowed/expected to touch. P2 defines this field; scope-drift lanes consume it later. |
| `evidenceGate` | Non-empty operator-facing RED/GREEN evidence description. |

Analysis/read-only tasks (`intent: "analyze"`, read-only validation modes, etc.) are exempt. Implementation: `src/task-readiness.ts`; behavior tests: `src/task-readiness.test.ts`.
