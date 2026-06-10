# Mobile worker preflight

`npm run mobile_worker_preflight` builds a source-only/no-live preflight packet
for Termux/mobile A2A workers such as Daegyo.

It is designed for the case where mobile transport is recoverable but broker
status can flip to `stale` because Android/Termux sleep, poll intervals, tmux
supervisor state, local-forward listeners, or wake-lock state do not match the
broker stale/disconnected thresholds.

Example:

```bash
npm run mobile_worker_preflight -- \
  --input fixtures/mobile-worker-preflight/slow-polling.json
```

JSON output:

```bash
npm run mobile_worker_preflight -- \
  --input fixtures/mobile-worker-preflight/healthy-mobile.json \
  --json
```

The input can be either a top-level mobile worker object or a fixture with an
`input`/`mobileWorkerInput` object:

```json
{
  "input": {
    "nodeId": "daegyo",
    "workerMode": "termux-mobile",
    "status": "stale",
    "lastSeenAgeSec": 50,
    "pollIntervalSec": 300,
    "staleAfterSec": 30,
    "disconnectedAfterSec": 90,
    "tmuxSessionPresent": true,
    "localForwardPresent": true,
    "wakeLockHeld": false,
    "activeLanePlanned": true,
    "isolatedWorkspaceRootConfigured": true,
    "isolatedWorkspaceRootShape": "~/.hermes/a2a-workspaces/<homeBrokerId>/<taskId>"
  }
}
```

The packet classifies the supplied state into:

- `ready`
- `degraded`
- `needs_wake_lock`
- `poll_interval_too_slow`
- `workspace_isolation_missing`
- `supervisor_missing`
- `local_forward_missing`
- `disconnected`
- `not_mobile_worker`

Safety boundaries:

- no broker, Gateway, worker, Android, Termux, tmux, SSH, or host state is read;
- no worker is dispatched;
- no `termux-wake-lock` or poll interval change is executed;
- no DB state is mutated;
- no service is deployed or restarted;
- no provider or Telegram message is sent;
- no Terminal Brief ACK/replay is performed;
- no credential or secret is moved or printed;
- no mobile workspace directory is created, deleted, or modified.

This differs from the Docker-runner doctor. Docker-runner doctor checks the
containerized runner profile and mounted OpenClaw config before Docker workers
run long tasks. Mobile worker preflight instead evaluates supplied mobile
signals for Android/Termux workers where the risk is foreground/background
sleep, slow polling, missing tmux supervisor, or missing local-forward listener.

## Non-docker research task policy

Gongyung and Daegyo should be treated as **non-docker Hermes research workers**.
They are not Docker runner nodes, but they are ordinary A2A workers for safe
research work. A mobile/non-docker worker may accept a task when all of the
following are true:

- `intent` is `analyze` or `verify`;
- `policyContext.liveImpact !== true`;
- `policyContext.targetEnvironment` is absent or `research`;
- `payload.noLive === true`;
- `payload.mode` is one of `analysis-only`, `readonly-analysis`,
  `a2ad-analysis`, `local-hermes-smoke`, or `hermes-reference-dry-run`;
- the payload does not request Docker execution, live mutation, provider send,
  or generic GitHub write/proof-marker execution.

This lets Team1/Team2 A2A and A2AD no-live rounds dispatch ordinary
analysis-only children to Gongyung and Daegyo while still blocking
Docker-dependent and live-impact lanes. Keep `parentRoundId`,
`parentRoundTotal`, and `parentRoundOrder` on the task record for ordinary A2A
round grouping; do not duplicate `parentRoundId` inside `payload` unless the
payload intentionally carries Terminal Brief dispatch metadata.

Use the output as an operator review packet. If it recommends wake-lock, lower
poll interval, worker restart, tunnel repair, or mobile workspace
creation/configuration, perform those as separate live operations with explicit
approval.

## Active-lane readiness

The packet computes `readyForActiveLane` from the overall `state` plus isolated
workspace readiness. `readyForActiveLane=true` requires `state === "ready"` and
`workspaceIsolation === "configured"` so Android/Termux workers do not run
active implementation lanes in the same filesystem area as long-lived Hermes,
OpenClaw, provider, or home-directory state.

| `state` | `readyForActiveLane` | Meaning |
|---|---|---|
| `ready` | `true` only when workspace isolation is configured | All liveness signals pass; worker can receive active-lane tasks only if the isolated workspace contract is also satisfied. |
| `degraded` | `false` | Warn-level signals exist (e.g. stale last-seen window, missing wake-lock). Assignment possible after operator review. |
| `needs_wake_lock` | `false` | Timing is clean but Termux wake-lock is not held and an active lane is planned. Hold wake-lock before dispatch. |
| `poll_interval_too_slow` | `false` | Poll interval cannot satisfy broker stale threshold. Lower `pollIntervalSec` before active lane use. |
| `workspace_isolation_missing` | `false` | Mobile worker liveness may be healthy, but active task outputs could mix with local settings or shared state. Configure isolated per-task workspaces before dispatch. |
| `supervisor_missing` | `false` | Tmux supervisor or session is absent. Repair supervisor before dispatch. |
| `local_forward_missing` | `false` | Local-forward tunnel is absent. Restore tunnel before active lane use. |
| `disconnected` | `false` | Last-seen exceeds `disconnectedAfterSec` or status is `disconnected`. Wait for a fresh heartbeat. |
| `not_mobile_worker` | `false` | `workerMode` is not a Termux/mobile profile. Use Docker-runner or gateway health checks. |

The input field `activeLanePlanned` controls whether missing wake-lock blocks
active-lane readiness:

- **`activeLanePlanned: true`** — Missing wake-lock produces `needs_wake_lock`
  state. The packet recommends holding a wake-lock before dispatching active
  work.
- **`activeLanePlanned: false`** — Missing wake-lock produces
  `wake_lock_not_required` (pass signal). The worker is still `ready` for
  non-active operations such as supervised standby, evidence collection, or
  read-only analysis. It is not `readyForActiveLane` until workspace isolation
  is configured.

## Isolated mobile workspace contract

Android/Termux workers cannot rely on Docker filesystem isolation, so active
implementation lanes need a per-task workspace rooted away from long-lived local
settings and credential-bearing paths.

Accepted root shapes:

```text
~/.hermes/a2a-workspaces/<homeBrokerId>/<taskId>/
$A2A_MOBILE_WORK_ROOT/<homeBrokerId>/<taskId>/
```

Expected task-local subdirectories:

```text
repo/
artifacts/
evidence/
tmp/
```

Active task outputs must not be written into:

- general `~/.hermes/` paths outside the dedicated `a2a-workspaces` root;
- `~/.openclaw/` or other runtime config trees;
- normal home files such as shell profiles, global caches, or shared checkouts;
- shared Wiki/cache/checkouts except read-only;
- credential, provider, auth, SSH, or secret paths.

The preflight packet records only the configured root shape and policy state. It
does not create directories or inspect device files. Forbidden path shapes fail
closed as `workspace_isolation_missing` with the
`workspace_isolation_forbidden_path` signal.

### Using the fixtures for active-lane readiness validation

All fixtures live in `fixtures/mobile-worker-preflight/` and can be run with:

```bash
npm run mobile_worker_preflight -- \
  --input fixtures/mobile-worker-preflight/<fixture-name>.json [--json]
```

The following fixture matrix documents the expected active-lane readiness
outcome for each scenario:

| Fixture | workerMode | activeLanePlanned | Expected state | readyForActiveLane | Key signal |
|---|---|---|---|---|---|
| `healthy-mobile.json` | termux-mobile | true | `ready` | true | All pass |
| `healthy-mobile-no-active-lane.json` | termux-mobile | false | `ready` | false | wake_lock_not_required, workspace_isolation_not_required |
| `wake-lock-recommended.json` | termux-mobile | true | `needs_wake_lock` | false | wake_lock_recommended |
| `slow-polling.json` | termux-mobile | true | `poll_interval_too_slow` | false | poll_interval_too_slow |
| `degraded-timing.json` | termux-mobile | true | `needs_wake_lock` | false | last_seen_stale_window |
| `disconnected-mobile.json` | termux-mobile | true | `disconnected` | false | last_seen_disconnected_window |
| `missing-supervisor-local-forward.json` | android-termux | true | `supervisor_missing` | false | supervisor_missing |
| `no-tmux-not-expected.json` | termux-mobile | true | `ready` | true | supervisor_not_expected |
| `hermes-mobile-healthy.json` | hermes-mobile | true | `ready` | true | All pass |
| `missing-isolated-workspace.json` | termux-mobile | true | `workspace_isolation_missing` | false | workspace_isolation_missing |
| `forbidden-workspace-path.json` | termux-mobile | true | `workspace_isolation_missing` | false | workspace_isolation_forbidden_path |
| `non-mobile-worker.json` | docker-runner | false | `not_mobile_worker` | false | not_mobile_worker |

### Signal-to-state mapping

```
supervisor_missing ────────────► supervisor_missing
local_forward_missing ─────────► local_forward_missing
workspace_isolation_missing ───► workspace_isolation_missing
workspace_isolation_forbidden ─► workspace_isolation_missing
disconnected ──────────────────► disconnected
poll_interval_too_slow ────────► poll_interval_too_slow
wake_lock_recommended ─────────► needs_wake_lock
  + wake_lock_unknown
only warn signals ───────► degraded
no fail & no warn ───────► ready
not_mobile_worker ───────► not_mobile_worker
```

### Boundary guarantee

All fixtures and the packet builder maintain:

- No live broker state read
- No host state read
- No `termux-wake-lock` execution
- No poll interval change
- No worker dispatch
- No DB mutation
- No deploy or restart
- No provider or Telegram send
- No Terminal ACK/replay
- No secret movement
- No mobile workspace directory create/delete/mutation
