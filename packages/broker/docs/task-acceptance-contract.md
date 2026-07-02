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

`validateTaskCompletionEvidence()` rejects completion when a task declares `payload.acceptance` but the submitted result has no `validation.verdict === "pass"`. This holds even for custom handlers that never ran the acceptance step: absence of evidence is a failure, not a pass. Custom handlers may also run the command themselves (or an equivalent check) and submit their own passing validation payload.

## Dispatcher guidance

- Use repo-relative commands that the worker's working directory can execute (`npm run check`, a scoped gate script). The runner lane (#1219) covers containerized patch verification; this contract covers the worker process itself.
- One acceptance command per task. If a task needs several checks, wrap them in one script or split the task — heterogeneous bundles are how deliverables get dropped (#1194).
- Timeouts: pick roughly 2× the command's normal duration; the default 120s suits most gate scripts.

Implementation: `src/worker-acceptance.ts`; behavior tests: `src/worker-acceptance.test.ts` (including a real broker + worker round trip for pass and fail paths).
