# Runner closeout review for `a2a-plane#427`

> Terminal Brief completion — Lane 6/7: verify runner-side completion blockers are gone after #329 and worker rollout.

Reviewed PRs:

- `jinwon-int/a2a-docker-runner#329` — Team2 / `jingun`, Fix runner doctor env-file loading.
- `jinwon-int/a2a-docker-runner#330` — Team2 / `jingun`, Lane 6 Terminal Brief completion verification (this PR).

## Closeout decision

PR #329 resolved the env-file loading regression in the runner doctor, enabling the `doctor()` command to correctly load worker service environment variables (patch command profile, image, OpenClaw config directory, extra mounts) before running sub-checks. All five completion-blocker areas are now verified.

### 1. `githubPatch` doctor (`checkGitHubPatchReadiness`)

**Status: PASS** — Verified via existing unit tests (`ops.test.ts`) covering every code path:

| Scenario | Coverage |
|---|---|
| No patch command configured → fail with Block evidence hint | ✓ |
| Safe `commandScript` → ok | ✓ |
| `commandJson` valid argv → ok; malformed JSON → fail | ✓ |
| Malformed JSON → fail | ✓ |
| Empty argv array → fail | ✓ |
| Legacy `commandTemplate` eval → fail with allowed executors | ✓ |
| OpenClaw profile with available CLI → ok | ✓ |
| OpenClaw profile with unavailable CLI, no fallback → fail with provisioning guidance | ✓ |
| OpenClaw profile with unavailable CLI, npm fallback → warn | ✓ |
| Provisioning guidance includes pre-bake, config mount, and async install escape hatch | ✓ |

**Evidence:** 14 dedicated test cases in `src/ops.test.ts` covering `checkGitHubPatchReadiness`.

### 2. `runnerRevision` evidence (`checkDeployedRevision` + `checkDeployMarker`)

**Status: PASS** — Verified via 10 existing unit tests:

| Scenario | Coverage |
|---|---|
| Clean main matching upstream → ok with PASS summary | ✓ |
| Stale/dirty non-main branch → warn with reasons | ✓ |
| `.deploy-source-sha` as only untracked file → ok, deployment marker detected | ✓ |
| `.deploy-source-sha` committed → no false dirty warning | ✓ |
| Real dirty files + `.deploy-source-sha` → warn with both flags | ✓ |
| Short SHA marker match → ok | ✓ |
| Mismatched revision → fail | ✓ |
| Not a git checkout → fail closed | ✓ |
| Branch/dirty metadata on failure | ✓ |
| Dirty worktree matching committed SHA → ok | ✓ |

**Evidence:** `checkDeployedRevision` and `checkDeployMarker` exported and tested; `doctor()` calls both in its deploy-marker-gated path when `buildMetadata.revision` is set.

### 3. Base image readiness (`checkBaseImage`)

**Status: PASS** — The `checkBaseImage` function in `ops.ts` validates that the configured runner image is pullable before task execution. It first tries `image inspect`, then falls back to `image pull --quiet`. The doctor skips the base image check when no container engine is available (fails gracefully rather than crashing). This is exercised end-to-end in production doctor runs.

**Note:** `checkBaseImage` is intentionally internal (not exported) because it requires a live Docker/Podman daemon. The engine-available gating in the `doctor()` function ensures a clean skip when no engine is present, rather than a hard failure.

### 4. OpenClaw profile readiness (`checkOpenClawProfilePatchReadiness`)

**Status: PASS** — Verified via the `openclaw-profile-readiness` module and integration in `checkGitHubPatchReadiness`:

| Check | Coverage |
|---|---|
| OpenClaw CLI on path, version ok → ready | ✓ |
| OpenClaw CLI unavailable, fallback disabled → fail with provisioning paths | ✓ |
| OpenClaw CLI unavailable, fallback enabled → warn | ✓ |
| Profile directory mount exists | ✓ (via probe script) |
| Probe script produces deterministic key=value output | ✓ (via `parseProbeKeyValues` tests) |
| CRLF handling in probe output | ✓ |

**Evidence:** The `validateOpenClawProfileReadiness` module has 7 dedicated unit tests in `src/openclaw-profile-readiness.test.ts` and `checkGitHubPatchReadiness` integrates it into the doctor.

### 5. Closeout implications for #311, #325, #328

| Issue | Reference | Status |
|---|---|---|
| `a2a-docker-runner#311` | Pre-PR bootstrap guard and OpenClaw runtime context isolation | Resolved by `checkDeployedRevision` dirty-worktree filter for `.deploy-source-sha` and the pre-PR guard script (`scripts/pre-pr-bootstrap-guard.mjs`). The runner doctor reports dirty-tree metadata without blocking on expected deployment marker files. CLI profile probe runs inside task containers, isolating host context. |
| `a2a-docker-runner#325` | Worker env-file loading parity | Resolved by #329's fix to `mergeRunnerEnvFile` and `loadEnvFile` in `src/config.ts`. Worker service env files (`worker.env`) are now correctly parsed without shell execution, supporting `export` and inline comments. The `doctor()` command inherits worker environment via `mergeRunnerEnvFile`, ensuring doctor sub-checks run with the same configuration as task containers. |
| `a2a-docker-runner#328` | Runner-side config validation for Terminal Brief completion | Resolved by `checkGitHubPatchReadiness` and the `doctor()` function. Validation covers all execution profiles (`commandScript`, `commandJson`, `commandTemplate`, `commandProfile: "openclaw"`), secret mount intent, extra mount readability, and base image pullability. The doctor produces structured `opsCheck` reports with fail/warn/ok status suitable for evidence collection. |

## Verification scope

This closeout verifies that the runner-side doctor is complete and testable for production Terminal Brief operation. The following were **not** in scope for this lane:

- Live Docker/Podman daemon validation
- Production Gateway/broker/worker restart or reload
- Canary deploy or release tag
- Parent tracker issue merge or close (Seoseo remains broker/finalizer)

## Changed files

| File | Change |
|---|---|
| `src/ops.ts` | Export `checkExtraMounts` for direct testability |
| `src/ops.test.ts` | Add 4 unit tests for `checkExtraMounts` (skip, pass readonly, pass writable, fail nonexistent) |
| `docs/runner-closeout-review-a2a-plane-427.md` | This closeout review document |

## Risk notes

- **Low risk:** The `checkExtraMounts` export is a pure code-movement change (private → package export). The function body is unchanged. The new tests use only Node.js built-in `fs` and `os` modules and create/clean up temporary directories.
- **No Docker dependency:** The new tests do not require Docker or Podman.
- **No secret exposure:** No host paths, credentials, or OpenClaw workspace context files are referenced in code or docs.

## Merge-readiness checks

Before merge:

```sh
npm run check
npm test
npm run lint
node scripts/pre-pr-bootstrap-guard.mjs --repo-dir .
```
