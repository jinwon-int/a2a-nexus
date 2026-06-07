# Hot-Table Growth Alert Semantics

**Issue:** [#941](https://github.com/jinwon-int/a2a-broker/issues/941)
**Date:** 2026-05-27
**Author:** bangtong (Team1)

## 1. Purpose

Define how hot-table growth warnings become first-class operator alerts in the
`/a2a/operator/events` SSE stream and the `/alerts` endpoint, and how these
alerts stay bounded to prevent operator event payload growth.

## 2. Alert Kind

```typescript
export type AlertKind = /* …existing kinds… */ | "hot_table_growth";
```

Hot-table growth alerts use `AlertSubjectKind = "storage"` with the table name
as the subject id (e.g. `"broker_tasks"`).

**Alert id:** `"hot_table_growth:<table>"` — deterministic, enabling the
operator event stream to track open/resolve transitions.

## 3. Thresholds

Thresholds are defined in `src/core/hot-table-growth.ts` and project to alerts
via `projectHotTableGrowthAlerts()`:

| Condition | Alert Severity | Alert Id |
|---|---|---|
| Single table > 1,000 rows (or >=80% of runtime cap for `broker_audit_events`) | `warning` | per-table |
| Single table >= 5,000 rows (`broker_tasks`) | `critical` | per-table |
| Single table >= 5,000 rows (`broker_audit_events`) **without pressure signals** | `warning` | per-table |
| Single table >= 5,000 rows (`broker_audit_events`) **with** pressure signals (memory critical, skipped >70%, growth >50%, or count >120% of runtime cap) | `critical` | per-table |
| Estimated memory > 100 MB | `warning` | per-table |
| Estimated memory > 500 MB | `critical` | per-table |
| Growth rate > 50% | `warning` | per-table |
| Heap skipped ratio > 30% | `warning` | per-table |
| Heap skipped ratio > 70% | `critical` | per-table |

## 4. Payload Compactness

### Alert count bounding

`projectHotTableGrowthAlerts()` emits **at most 5 alerts** per projection
(`MAX_HOT_TABLE_GROWTH_ALERTS`). If more tables are degraded, only the first 5
warning/critical tables produce alerts. This keeps the operator event payload
bounded regardless of the number of hot tables.

### Alert metadata

Each alert carries a tightly scoped metadata payload:

```json
{
  "id": "hot_table_growth:broker_tasks",
  "kind": "hot_table_growth",
  "severity": "warning",
  "subject": { "kind": "storage", "id": "broker_tasks" },
  "summary": "WARNING: broker_tasks: 1200 rows, ~126.0 MB in-memory, +50.0% growth",
  "detectedAt": "2026-05-27T01:00:00.000Z",
  "metadata": {
    "table": "broker_tasks",
    "currentCount": 1200,
    "estimatedMemoryBytes": 132000000,
    "growthDelta": 400,
    "growthRate": 0.5,
    "runtimeSkipped": 0,
    "severity": "warning"
  }
}
```

No large nested objects. The `summary` string is a human-readable, finite-length
sentence constructed by the existing `buildTableSummary()`.

### Health endpoint bounding

The `/health` endpoint already:
- Caps warnings to `DEFAULT_MAX_WARNINGS` (10) in `hotTableGrowth.warnings`
- Truncates individual `body.error` / `body.warning` strings to **500 characters**
- Sets `warningsTruncated: true` when truncation occurred

## 5. Audit Table Persistence Note

The `broker_audit_events` warning uses an **audit-specific 80%-of-cap threshold**
(see `DEFAULT_AUDIT_RUNTIME_LIMIT_WARNING_RATIO` in `src/core/hot-table-growth.ts`), not
the generic 1,000-row single-table threshold. The table is self-pruning at its
runtime cap (`maxAuditEvents`, default 5,000) — the warning band is expected to
be **persistent** once the table reaches steady-state operation.

The severity classifier (`computeTableSeverity` in `src/core/hot-table-growth.ts`)
applies a more nuanced check for `broker_audit_events`: reaching the generic
single-table critical threshold (5,000 rows) is **not** sufficient for
`critical` severity when the table is in steady state. An actual pressure
signal — memory exceeding the critical threshold, a critical skipped-hydration
ratio, unbounded growth, or the row count materially exceeding the runtime cap
(>20% overshoot) — is required. When those conditions are absent, the audit
row count produces a `warning` severity instead, informing operators without
forcing `/health.ok: false`. See
[hot-table-health.md §3.3](./hot-table-health.md#33-audit-warning-semantics)
for the operator check sheet.

## 6. Operator Event Integration

Hot-table growth alerts flow through two paths:

### `/alerts` endpoint (REST)

The `/alerts` endpoint computes `projectHotTableGrowth` from the SQLite state
store (when available) and passes it to `projectAlerts()` via
`hotTableGrowth` option. The response includes both task-level and storage-level
alerts.

### `/a2a/operator/events` SSE stream

The `currentOperatorSnapshot()` function computes hot-table growth during each
operator event publish cycle. The resulting `hot_table_growth` alerts participate
in the normal alert-open/resolve lifecycle:

- **Alert opened:** An `operator-alert-opened` SSE event fires when a
  `hot_table_growth` alert appears that wasn't in the prior snapshot.
- **Alert resolved:** An `operator-alert-resolved` SSE event fires when a
  table's severity returns to `ok`.

This works because each alert id (`hot_table_growth:broker_tasks`) is
deterministic — the open/resolve diff logic in `publishOperatorAlertChanges()`
uses the alert id as the identity key.

## 6. Exposure in Health

The health endpoint already exposes the full `HotTableGrowthProjection` as
`body.hotTableGrowth`. This includes per-table counts, estimated memory,
runtime load metrics, growth rates, and readiness degradation flags.
No additional change to the health API was needed for this issue.

## 7. Test Coverage

New tests in `src/core/alert-projection.test.ts`:

| Test | What it verifies |
|---|---|
| `projects hot-table growth alerts for warning-level tables` | Single warning table produces one alert with correct kind/severity/summary/metadata |
| `projects hot-table growth alerts for critical-level tables` | Multiple critical tables produce alerts with correct id and CRITICAL prefix |
| `limits hot-table growth alerts to MAX_HOT_TABLE_GROWTH_ALERTS` | At most 5 alerts emitted regardless of table count |
| `produces no alerts when all tables have ok severity` | Zero alerts when no table is degraded |
| `includes hot-table growth alerts when projected from projectAlerts options` | End-to-end: `projectAlerts` receives `hotTableGrowth` and includes storage alerts |
| `includes hot-table growth alerts alongside task alerts when both are present` | Both alert kinds coexist in the same scan result |
| `skips hot-table growth alerts when projection is null or undefined` | Backwards compatible: null/undefined `hotTableGrowth` produces no storage alerts |

## 8. References

- `src/core/alert-projection.ts` — `projectHotTableGrowthAlerts()` function, `AlertKind` type
- `src/core/hot-table-growth.ts` — `projectHotTableGrowth()` and thresholds
- `src/server.ts` — `buildAlertScan()`, `currentOperatorSnapshot()`, `/alerts` endpoint
- `docs/hot-table-health.md` — RCA, mitigation, alert thresholds
- `docs/hot-table-retention-prune-runbook.md` — Retention policy and safe prune
