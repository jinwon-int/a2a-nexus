# Mobile Worker Health Runbook

> **mobilealpha**, **mobilebeta** — Team1 Hermes/Termux mobile workers running on Android
> devices. These nodes connect via HTTP poll and may sleep briefly (Android Doze, lid
> close, network suspend).
>
> **#2065 scope note:** there is **no enforced 3-task concurrency limit** for mobile
> workers. Earlier revisions of this runbook described a "reduced capacity of 3
> concurrent slots"; that overstated computed telemetry as an enforcement claim and
> has been removed. The peer-status slot count does not set executor concurrency
> or grant admission; policy and fast-lane decisions are unchanged.

## Detecting Mobile Workers

A worker is classified as **mobile** when its `WorkerRecord.workerMode` is `"mobile"`.
Mobile workers are typically registered with:

- `runtimeFlavor: "termux-hermes"`
- `workerMode: "mobile"`
- `canAnalyze: true`
- `canPromoteLive: false`
- no Docker runner requirement

Treat mobilealpha and mobilebeta as **non-docker Hermes research workers**, not as
reference-only special cases. They can receive ordinary no-live/read-only
`analyze` or `verify` tasks, including A2A/A2AD round tasks, when task policy is
research-only and the payload is explicitly no-live. They must still reject
Docker-runner, live-impact, provider-send, and generic GitHub-write executor
payloads unless a separate approved proof-marker path is used.

## Health States (broker-facing status)

The `WorkerFleetSummary.byNode` and `WorkerCapacitySummaryItem` responses include
two mobile-specific fields for mobile workers:

| Field | Type | Present When |
|---|---|---|
| `workerMode` | `"persistent"` \| `"mobile"` | When recorded; absent remains absent |
| `mobileHealth` | `"health_ok"` \| `"stale"` \| `"disconnected"` | Only when `workerMode === "mobile"` |

### State Table

```mermaid
graph LR
    A[Online] -->|>30s no heartbeat| B[Stale]
    B -->|heartbeat received| A
    B -->|>90s no heartbeat| C[Disconnected]
    C -->|worker re-registers| A
```

| mobileHealth | lastSeenAgeSec | Meaning | Operator action |
|---|---|---|---|
| `health_ok` | ≤ 30s | Worker heartbeating normally within its mobile window | None |
| `stale` | > 30s, ≤ 90s | Worker missed 1–2 heartbeat cycles; may be briefly sleeping or on battery | Check device connectivity if pattern persists |
| `disconnected` | > 90s | Worker unreachable for an extended period; likely offline or power-cycled | Investigate device health; may have lost network or battery died |

> **Note:** The generic `status` field (`"online"` / `"stale"`) reflects the
> mobile-aware stale threshold (30s default). A worker with `status: "stale"`
> and `mobileHealth: "health_ok"` should not occur — they are kept in sync.

## Thresholds (code constants)

The mobile-specific constants drive `/dashboard`, `/workers/capacity` and
their `mobileHealth` projection. Raw `GET /workers` and `GET /workers/:id`
already use the common configured threshold and do not synthesize mobileHealth.
Since #2065, `a2a.peer.status` also uses the common `workerOfflineAfterMs ??
DEFAULT_WORKER_OFFLINE_AFTER_MS` (90 s) window with 10 advisory busy slots.
A supplied legacy `mobileOfflineAfterMs` takes precedence for mobile workers
only; `??` preserves explicit zero and overrides longer than the common window.

| Constant | Value | Applies to |
|---|---|---|
| `DEFAULT_WORKER_OFFLINE_AFTER_MS` | 90,000 (90 s) | Persistent workers on dashboard surfaces; every mode on `a2a.peer.status` (common default) |
| `MOBILE_OFFLINE_AFTER_MS` | 30,000 (30 s) | Mobile workers on dashboard/mobileHealth surfaces only |
| `MOBILE_DISCONNECTED_AFTER_MS` | 90,000 (90 s) | Mobile workers — disconnected threshold (dashboard/mobileHealth surfaces) |

## Code Locations

- **Types**: `src/core/types.ts` — `WorkerMobileHealth`, `WorkerFleetSummary`, `WorkerCapacitySummaryItem`
- **Stale detection**: `src/core/broker-worker-status.ts` — `effectiveOfflineAfterMs()`, `computeWorkerMobileHealth()`, `isWorkerStale()`
- **Dashboard**: `src/core/broker.ts` — `getDashboard()` (workers section)
- **Capacity**: `src/core/broker.ts` — `getWorkerCapacitySummary()` (per-item loop)

## Known Mobile Workers

| Node ID | Team | Device | Notes |
|---|---|---|---|
| `mobilealpha` | Team1 | Termux (Android) | Non-docker Hermes research worker; accepts no-live/read-only analysis tasks. |
| `mobilebeta` | Team2 | Termux (Android) | Non-docker Hermes research worker; accepts no-live/read-only analysis tasks. |

## operatorEvents Payload Constraint

The `mobileHealth` and `workerMode` fields are **only** present in the broker-facing
status APIs (`getDashboard`, `getWorkerCapacitySummary`). They are **not** added
to `TerminalTaskOutboxEvent` (the `operatorEvents` SSE/outbox payload), in order
to avoid inflating high-churn event streams with per-worker metadata.

## Operational Notes

1. **Mobile workers may briefly go stale** during Android Doze or after a network
   handoff. A single stale event is not cause for alarm; check `lastSeenAgeSec`
   to assess recency.
2. **No per-mode concurrency limit is enforced.** There is no universal
   "3 concurrent tasks" cap for mobile workers; `activeTaskCount` is computed
   telemetry and does not read or set executor concurrency. The read-only
   `a2a.peer.status` view additionally
   reports an advisory busy hint (`active + queued` vs a fixed budget of 10,
   identical for every mode) — it is telemetry, never an admission permission.
3. **Surface semantics differ by design.** Dashboard/`mobileHealth` windows are
   mode-aware (30 s / 90 s per the table above), while `a2a.peer.status` uses
   the common 90 s window, so between 30 s and 90 s of heartbeat age a mobile
   worker can be `stale` on the dashboard while `a2a.peer.status` still reports
   `ok`. Past its resolved window, `a2a.peer.status` reports `health: "stale"`;
   unregistered targets report `health: "unreachable"`.
4. If a mobile worker remains disconnected for an extended period (>14 days by
   default retention), it becomes a cleanup candidate for `discoverCleanupCandidates`.

## Dashboard Example

```json
{
  "workers": {
    "total": 3,
    "online": 2,
    "stale": 1,
    "byNode": [
      {
        "nodeId": "brokeralpha",
        "role": "hub",
        "status": "online",
        "activeTaskCount": 0,
        "lastSeenAgeSec": 5
      },
      {
        "nodeId": "mobilealpha",
        "role": "analyst",
        "status": "online",
        "workerMode": "mobile",
        "mobileHealth": "health_ok",
        "activeTaskCount": 1,
        "lastSeenAgeSec": 12
      },
      {
        "nodeId": "mobilebeta",
        "role": "analyst",
        "status": "stale",
        "workerMode": "mobile",
        "mobileHealth": "stale",
        "activeTaskCount": 0,
        "lastSeenAgeSec": 45
      }
    ]
  }
}
```
