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

- **Acceptance runs on the worker host, in the worker service's own working directory — not in the task workspace, and not in the container.** `runTaskAcceptance()` calls `spawnSync` with no `cwd` option, so the command inherits the worker process's cwd (for a deployed worker, something like `/opt/a2a-broker-worker`). A repo-relative file assertion such as `grep -qx '...' docs/canary/file.md` therefore fails structurally, however correct the patch is.
- **Put workspace file verification in the container, not here.** The runner lane (#1219) runs its post-patch verification after `cd /work/<repoPath>`, so the *same* command can pass there and fail in acceptance. Write host acceptance against something the host can actually reach: a PR lookup (`gh api`, `gh pr list`), a service probe, or an absolute path.
- **Do not use `gh pr list --search` for a PR the task just created.** GitHub's search index lags by seconds, so the lookup returns nothing and acceptance fails on a PR that exists. Use a listing that does not go through the search index, plus a short retry loop — e.g. `gh pr list --json headRefName | grep <round-id>`.
- Use repo-relative commands only when the worker's own cwd is the relevant tree (`npm run check`, a scoped gate script, in workers that run inside the repo). This contract covers the worker process itself; containerized patch verification is the runner lane's job.
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

### Hybrid-subagent scope enforcement: two distinct guards (#1348 / #1376)

For `executionMode: "hybrid-subagent"` patch lanes, `declaredScope.paths` is
enforced by **two guards with different trust postures** — the difference is
load-bearing:

- **Post-run evidence gate** (`hybridDeclaredScopePreflight`, #1348): runs the
  #1235 directory-boundary write-set matcher over the runner's **self-reported**
  `filesChanged`. Catches honest scope drift, but a malicious/buggy runner can
  write out of scope and under-report (`filesChanged: []`) to evade it. This is
  a lint/readback guard, not a write-prevention boundary.
- **Write-point readback** (`hybridWritePointPreflight`, #1376): independently
  inspects the runner's git worktree (`git status --porcelain -z`) and runs the
  same matcher over the **actual** touched paths — no trust in self-report. An
  under-reporting runner fails closed (`hybrid_declared_scope_writepoint_violation`).
  When the worktree is not git-inspectable it degrades to self-report only; the
  v1 trust posture (opt-in trusted self-fleet, no auto-merge of hybrid PRs)
  covers that residual gap.

#### Live canary evidence requirements

A hybrid-subagent live canary (e.g. the H2 retry for #1348) must attach the
following evidence so the round is auditable end-to-end:

- **Task id** — the originating issue/round id (e.g. `#1348`) the canary refs.
- **`executionMode: "hybrid-subagent"`** — recorded on the payload so the lane
  is classified as an opt-in hybrid patch, not a plain runner patch.
- **`subagentBudget`** — the `{ max, remaining }` budget the canary ran under.
- **`declaredScope`** — the exact `paths` allow-list the patch stayed within.
- **PR URL** — the opened pull request; its body refs the task (`Refs #1348`),
  never `Closes`/`Fixes`, so the issue is not auto-resolved by the canary.
- **Review/merge checks** — the docs/markdown-link check result plus PR review
  state, reported alongside `filesChanged` and `tests`.
- **Trusted self-fleet / no-auto-merge boundary** — the canary preserves the v1
  trust posture: opt-in trusted self-fleet only, and hybrid PRs are never
  auto-merged without human review.
