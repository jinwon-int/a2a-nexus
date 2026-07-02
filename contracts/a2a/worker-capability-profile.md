# Worker Capability Profile and Assignment Contract (R31)

> **R31 (2026-05-16):** The worker capability profile schema, assignment semantics, and capacity-limited slow lane phrasing are defined. Brokers use the profile to distinguish worker capacity-limited latency from stuck/failed task behavior. No secrets, raw host logs, or private paths are collected.

This contract defines the canonical A2A worker capability profile and assignment recommendation semantics. It is a companion to [Worker Registration](./worker-registration.md) (which defines public-safe identity fields and coarse capability labels). This contract extends the registration with runtime capacity dimensions, workload strength labeling, and stale-profile handling that enable broker assignment optimization.

## Capability Profile Schema

Every worker may publish a `WorkerCapabilityProfile` alongside its registration. The profile is optional — workers that do not publish a profile receive conservative default assignment heuristics.

### Profile fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cpuCount` | `number` | no | Number of logical CPU cores available to the worker. |
| `cpuArchitectureClass` | `string` | no | Architecture class: `x64`, `arm64`, or `unknown`. |
| `memoryTotalClass` | `string` | no | Total memory class: `small` (<2 GB), `medium` (2-8 GB), `large` (8-32 GB), `xlarge` (>32 GB). |
| `memoryPressureClass` | `string` | no | Current memory pressure: `low`, `moderate`, `high`, `critical`. |
| `diskFreeClass` | `string` | no | Free disk space class: `low` (<5 GB), `medium` (5-50 GB), `high` (>50 GB). |
| `storagePressureClass` | `string` | no | Storage I/O or capacity pressure: `low`, `moderate`, `high`, `critical`. |
| `dockerAvailable` | `boolean` | no | Whether the Docker daemon (or equivalent container runtime) is available. |
| `dockerCachePressure` | `string` | no | Docker image/build cache pressure: `low`, `moderate`, `high`, `unknown`. `unknown` when Docker is unavailable. |
| `gatewayHealthSummary` | `string` | no | OpenClaw/Gateway/A2A worker health: `healthy`, `degraded`, `unhealthy`, `unknown`. |
| `recentTaskRuntimeClass` | `string` | no | Observed task runtime percentile: `fast` (<5 min), `medium` (5-30 min), `slow` (>30 min), `unknown`. |
| `recentTaskTimeoutClass` | `string` | no | Recent timeout frequency: `none`, `rare`, `frequent`, `unknown`. |
| `workloadStrengths` | `string[]` | no | Workload types this worker handles well. See [Workload strengths](#workload-strengths) below. |
| `freshnessTimestamp` | `string` (ISO-8601) | yes | When this profile was last updated. The broker uses this for stale-profile handling. |

### Workload strengths

The `workloadStrengths` field is an array of zero or more workload type labels. Valid labels:

| Label | Description |
| --- | --- |
| `code-patch` | Code changes, workspace patching |
| `build-test` | Build and test execution |
| `docs-evidence` | Documentation, evidence, and redaction |
| `validation-libero` | Validation checks, conformance testing, libero review |
| `canary` | Canary / staging verification |
| `inspection` | Repository inspection, audit, policy check |
| `fixtures` | Fixture creation and maintenance |

Workload strength labels are coarse and publicly safe. A worker must not expose workload-specific host paths, credentials, or topology through this field.

### Stale-profile handling

A profile whose `freshnessTimestamp` is older than `staleProfileTimeoutMs` (broker-configured, recommended default: 300 000 ms = 5 min) is treated as:

1. **Stale-warning**: broker logs and assignment traces note the profile age but may still use it for best-effort assignment. The `expectedLatencyClass` default shifts one level slower (e.g., `fast` → `medium`, `medium` → `slow`).
2. **Stale-expired**: when profile age exceeds `staleProfileHardTimeoutMs` (broker-configured, recommended default: 1 800 000 ms = 30 min), the broker must fall back to the conservative default heuristics for that worker.

Stale profiles must not be used for capacity-critical or latency-sensitive assignments.

### Forbidden profile content

The capability profile must never contain:

- Host names, IP addresses, or network topology.
- Private file system paths.
- Provider tokens, API keys, or secrets.
- Raw session dumps or full logs.
- Runtime/bootstrap context file names (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`).
- Worker-specific credentials or identity documents.

## Assignment Recommendation Semantics

When a broker considers a worker for task assignment, the profile informs the following recommendation attributes:

### Preferred workload

- `preferredWorkload`: `string[]` — The workload types from `workloadStrengths` that this worker is best suited for. Brokers SHOULD match the task's required workload type (e.g., `build-test` or `docs-evidence`) against this list. A task whose required workload appears in `preferredWorkload` is assigned higher priority than one that does not.

### Concurrency and build constraints

- `maxConcurrentTasks`: `number` (default: `1`) — Maximum concurrent tasks the worker can handle. A broker SHOULD NOT assign more than this many tasks to the worker simultaneously.
- `heavyBuildAllowed`: `boolean` (default: `false`) — Whether the worker can accept heavy build/test tasks. If `false` and the worker's `memoryTotalClass` is `small` or `medium`, the broker SHOULD prefer other workers for heavy build tasks.
- `expectedLatencyClass`: `string` (default: `medium`) — Expected task latency: `fast`, `medium`, `slow`. Brokers may use this to set task timeout expectations. The default shifts based on profile age (see [Stale-profile handling](#stale-profile-handling)).
- `operatorOverrideAllowed`: `boolean` (default: `true`) — Whether a human operator may override the broker's assignment recommendation for this worker. When `false`, the broker's automated recommendation is authoritative for non-operator-forced assignments.

### Recommendation explanation

When the broker assigns or avoids a worker, the assignment record SHOULD include a `recommendationReason` string explaining the recommendation, such as:

- `"preferred workload: code-patch"`
- `"avoided: heavyBuildAllowed=false, task is build-test"`
- `"avoided: stale profile"`
- `"preferred: expectedLatencyClass=fast"`
- `"avoided: memoryPressureClass=critical"`
- `"avoided: at maxConcurrentTasks"`
- `"preferred: operatorOverrideAllowed=true"`

## Capacity-Limited Slow Lane Phrasing in Terminal Brief / Closeout Reports

When a task completes or is blocked, and capacity constraints (rather than worker failure or timeout) are identified as a contributing factor, the Terminal Brief and closeout reports SHOULD use the following phrasing conventions:

### Slow lane due to capacity

- **In the terminal summary**: `"worker <name> was capacity-limited: <dimension> constraint (e.g., memoryPressureClass=high), leading to increased task latency. Task completed within expected bounds given the capacity state."`
- **In the blame/handoff note**: `"capacity-limited slow lane: worker <name> had <dimension> at <value>. No evidence of stuck/failed task behavior."`

### Blocked due to capacity

- **In the blocker reason**: `"worker <name> blocked on capacity: <dimension> at critical level (<value>). Task assignment re-queued for re-try on different worker."`

### Distinction from stuck/failed behavior

Capacity-limited latency MUST be explicitly distinguished from stuck/failed task behavior:

- **Capacity-limited**: The worker made progress but at reduced throughput. Terminal evidence shows partial or delayed completion. The summary states the capacity dimension and observed effect.
- **Stuck or failed**: The worker made no progress, lost state, or produced an error. Terminal evidence shows no output, error state, or timeout. The summary says `"worker <name> stuck/failed: <reason>"`.

Brokers and closeout reporters MUST NOT conflate capacity-limited latency with stuck/failed behavior. A task that eventually completes at reduced throughput is `done` or `pr`, not `blocked` or `cancelled`, unless it also meets the stuck/failed criteria.

### Examples

| Scenario | Terminal summary phrasing |
| --- | --- |
| Worker at high memory pressure, task completes 2x slower than baseline | `"worker worker-delta was capacity-limited: memoryPressureClass=high, leading to increased task latency. Task completed within expected bounds given the capacity state."` |
| Worker with no Docker cache, build task completes but slow | `"worker broker-beta was capacity-limited: dockerCachePressure=high (cold cache), leading to increased build latency. Task completed."` |
| Worker stuck due to segfault, no output produced | `"worker worker-epsilon stuck/failed: process crashed (segfault) during build step. No output produced."` |
| Worker at max concurrency, additional task queued | `"worker worker-gamma blocked on capacity: at maxConcurrentTasks (8). Task re-queued for different worker."` |

## Fixture

Machine-readable fixture for this contract:

- **Fixture**: `fixtures/contract/worker-capability-profile.json`
- **Conformance**: Validated by `node test/conformance/check-contract-fixtures.mjs`

## Safety

1. No deploy, restart, live canary, DB mutation, Terminal ACK mutation, replay, historical replay, or secret collection is authorized by this contract.
2. Profile data is optional and voluntary — workers opt into capability publication.
3. Profile contents are redacted-for-public and must not carry secrets, private paths, or host topology.
4. Stale profiles degrade gracefully; they never cause broker crashes or assignment deadlocks.
5. Capacity-limited slow lane phrasing must not be used to mask stuck/failed behavior or to infer terminal ACK from provider delivery signals.
