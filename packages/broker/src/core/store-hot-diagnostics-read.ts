// Hot-entity diagnostics READ paths extracted from store.ts (#1289 R4
// L-store-4). The operator/health read surfaces over the SQLite hot tables —
// invalid-row scans, mirror status vs the canonical snapshot, audit heartbeat
// churn, terminal-outbox backlog classification, and table load metrics — plus
// the hot-entity table constants and payload-parse helpers these paths and the
// store's own read paths share. Pure move: state access is callback-injected
// via HotDiagnosticsReadContext; SqliteBrokerStateStore keeps the six public
// readHot* methods as delegators. This module imports nothing from store.js
// (schemas and types come from leaf modules), so there is no import cycle.
import type { DatabaseSync } from "node:sqlite";

import type { z } from "zod";

import type {
  BrokerHotAuditDiagnostics,
  BrokerHotEntityDiagnostics,
  BrokerHotEntityMirrorMismatch,
  BrokerHotEntityMirrorRetentionWindow,
  BrokerHotEntityMirrorStatus,
  BrokerHotHintCounts,
  BrokerHotTerminalOutboxDiagnostics,
  BrokerInvalidHotEntityRow,
} from "./hot-diagnostics.js";
import { taskSchema, workerSchema } from "./store-schemas.js";
import type {
  BrokerHotTableLoadMetricEntry,
  BrokerHotTableLoadMetrics,
  BrokerSnapshot,
  SqliteBrokerLoadSource,
} from "./store-contracts.js";

export const HOT_AUDIT_RECENT_WINDOW_MS = 10 * 60 * 1000;
export const HOT_AUDIT_HEARTBEAT_CHURN_WARNING_COUNT = 20;
export const SQLITE_HOT_ENTITY_TABLES = [
  "broker_exchanges",
  "broker_exchange_messages",
  "broker_proposals",
  "broker_artifacts",
  "broker_validations",
  "broker_tasks",
  "broker_tombstones",
  "broker_workers",
  "broker_audit_events",
  "broker_terminal_outbox",
] as const;
export const SQLITE_HOT_ENTITY_HINT_TABLES = [
  "broker_exchanges",
  "broker_exchange_messages",
  "broker_proposals",
  "broker_artifacts",
  "broker_validations",
  "broker_tasks",
  "broker_tombstones",
  "broker_workers",
  "broker_audit_events",
  "broker_terminal_outbox",
] as const;
export type SqliteHotEntityTable = typeof SQLITE_HOT_ENTITY_TABLES[number];
type BrokerSnapshotArrayKey = Exclude<{
  [K in keyof BrokerSnapshot]: BrokerSnapshot[K] extends unknown[] | undefined ? K : never;
}[keyof BrokerSnapshot], undefined>;
export const SQLITE_HOT_ENTITY_SNAPSHOT_KEYS: Record<SqliteHotEntityTable, BrokerSnapshotArrayKey> = {
  broker_exchanges: "exchanges",
  broker_exchange_messages: "exchangeMessages",
  broker_proposals: "proposals",
  broker_artifacts: "artifacts",
  broker_validations: "validations",
  broker_tasks: "tasks",
  broker_tombstones: "tombstones",
  broker_workers: "workers",
  broker_audit_events: "auditEvents",
  broker_terminal_outbox: "terminalOutbox",
};

export function coerceSqliteCount(row: { count?: number | bigint } | undefined): number {
  return typeof row?.count === "bigint"
    ? Number(row.count)
    : typeof row?.count === "number" ? row.count : 0;
}

export function readSqlitePayload(row: unknown, tableName: string): string {
  if (
    typeof row === "object" &&
    row !== null &&
    "payload" in row &&
    typeof row.payload === "string"
  ) {
    return row.payload;
  }
  throw new Error(`missing payload column from ${tableName}`);
}

export function parseHotEntityPayloadResult<T>(row: unknown, schema: z.ZodType<T>, tableName: string): { success: true; data: T } | { success: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(readSqlitePayload(row, tableName));
  } catch (error) {
    return { success: false, error: sanitizeDiagnosticValue(error instanceof Error ? error.message : String(error)) };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { success: false, error: sanitizeDiagnosticValue(parsed.error.issues[0]?.message ?? "unknown schema error") };
  }
  return { success: true, data: parsed.data };
}

function sanitizeDiagnosticValue(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value ?? "unknown");
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

function coalesceInvalidHotEntityRows(rows: BrokerInvalidHotEntityRow[]): BrokerInvalidHotEntityRow[] {
  const byKey = new Map<string, BrokerInvalidHotEntityRow>();
  for (const row of rows) {
    const key = `${row.table}\u0000${row.primaryKey}\u0000${row.schemaError}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += row.count;
    } else {
      byKey.set(key, { ...row });
    }
  }
  return [...byKey.values()];
}

function countSnapshotEntities(snapshot: BrokerSnapshot): Record<string, number> {
  return Object.fromEntries(
    Object.values(SQLITE_HOT_ENTITY_SNAPSHOT_KEYS).map((key) => [key, (snapshot[key] ?? []).length]),
  );
}

function parseTerminalOutboxEventPayload(payload: unknown): {
  payload?: {
    status?: unknown;
    brokerOfRecordId?: unknown;
    worker?: unknown;
    crossBrokerHandoff?: { childWorkerId?: unknown };
    notificationOwnership?: { terminalAckPermittedByProjection?: unknown };
  };
  receipt?: { status?: unknown };
} | null {
  if (typeof payload !== "string" || !payload.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isAckIneligibleTerminalOutboxEvent(event: ReturnType<typeof parseTerminalOutboxEventPayload>): boolean {
  return event?.payload?.notificationOwnership?.terminalAckPermittedByProjection === false;
}

// Baseline-unused helper preserved by the move (was equally unused in store.ts).
export function isAckIneligibleTerminalOutboxPayload(payload: unknown): boolean {
  return isAckIneligibleTerminalOutboxEvent(parseTerminalOutboxEventPayload(payload));
}

function terminalOutboxAgeBucket(createdAt: unknown, nowMs: number): "lt1d" | "1to7d" | "7to14d" | "gte14d" | "unknown" {
  if (typeof createdAt !== "string") return "unknown";
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return "unknown";
  const ageMs = Math.max(0, nowMs - createdAtMs);
  const dayMs = 24 * 60 * 60 * 1000;
  if (ageMs < dayMs) return "lt1d";
  if (ageMs < 7 * dayMs) return "1to7d";
  if (ageMs < 14 * dayMs) return "7to14d";
  return "gte14d";
}

function incrementDiagnosticsCounter(counter: Record<string, number>, value: unknown): void {
  const key = typeof value === "string" && value.trim() ? value.trim() : "unknown";
  counter[key] = (counter[key] ?? 0) + 1;
}

// #1763: the diagnostics path must be able to observe that the canonical
// snapshot row exists but could not be parsed, instead of only ever seeing a
// parsed snapshot or a thrown error. `error` carries the original throw so the
// caller can rethrow it verbatim when the row IS on the serving path.
export type CanonicalSnapshotRowRead =
  | { status: "ok"; snapshot: BrokerSnapshot }
  | { status: "absent" }
  | {
      status: "unreadable";
      reason: "too_large" | "parse_failed";
      bytes: number;
      maxBytes: number;
      updatedAt?: string;
      error: unknown;
    };

export interface HotDiagnosticsReadContext {
  db: DatabaseSync;
  maxHotRuntimeNonTerminalTasks: number;
  maxHotRuntimeTerminalTasks: number;
  maxHotRuntimeAuditEvents: number;
  maxHotRuntimeTerminalOutboxEvents: number;
  // #1763: `hot-tables` means the canonical row is a mirror, not the load
  // source, so an unreadable row degrades to a bounded field. Under `snapshot`
  // the row IS load-bearing and diagnostics keep failing closed.
  loadSource: SqliteBrokerLoadSource;
  readCanonicalSnapshotRow(): CanonicalSnapshotRowRead;
  readLastPersistDiagnostics(): {
    lastPersistAt: string | undefined;
    lastPersistSkippedFullSnapshot: boolean;
    lastHotHintCounts: BrokerHotHintCounts | undefined;
    lastPersistError: { kind: string; message: string; at: string } | undefined;
    lastFullSnapshotShedTerminal: number | undefined;
  };
  readTableIds(tableName: "broker_audit_events"): string[];
  readTableCount(tableName: SqliteHotEntityTable): number;
}

export function readHotEntityDiagnostics(context: HotDiagnosticsReadContext): BrokerHotEntityDiagnostics {
  return {
    invalidRows: coalesceInvalidHotEntityRows([
      ...readInvalidHotTaskRows(context),
      ...readInvalidHotWorkerRows(context),
    ]),
  };
}

function readInvalidHotTaskRows(context: HotDiagnosticsReadContext): BrokerInvalidHotEntityRow[] {
  return (context.db
    .prepare(
      `SELECT id AS primaryKey, payload FROM (
         SELECT id, payload, updated_at
         FROM broker_tasks
         WHERE status NOT IN ('succeeded', 'failed', 'canceled')
         ORDER BY updated_at DESC, id ASC
         LIMIT ?
       )
       UNION ALL
       SELECT id AS primaryKey, payload FROM (
         SELECT id, payload, updated_at
         FROM broker_tasks
         WHERE status IN ('succeeded', 'failed', 'canceled')
         ORDER BY updated_at DESC, id ASC
         LIMIT ?
       )`,
    )
    .all(context.maxHotRuntimeNonTerminalTasks, context.maxHotRuntimeTerminalTasks) as Array<{
    primaryKey?: unknown;
    payload?: unknown;
  }>).flatMap((row): BrokerInvalidHotEntityRow[] => {
      const parsed = parseHotEntityPayloadResult(row, taskSchema, "broker_tasks");
      if (parsed.success) {
        return [];
      }
      return [{
        table: "broker_tasks",
        primaryKey: sanitizeDiagnosticValue(row.primaryKey),
        schemaError: parsed.error,
        count: 1,
      }];
    });
}

function readInvalidHotWorkerRows(context: HotDiagnosticsReadContext): BrokerInvalidHotEntityRow[] {
  const invalidRows = (context.db
    .prepare("SELECT node_id AS primaryKey, payload FROM broker_workers ORDER BY node_id ASC")
    .all() as Array<{ primaryKey?: unknown; payload?: unknown }>).flatMap((row): BrokerInvalidHotEntityRow[] => {
      const parsed = parseHotEntityPayloadResult(row, workerSchema, "broker_workers");
      if (parsed.success) {
        return [];
      }
      return [{
        table: "broker_workers",
        primaryKey: sanitizeDiagnosticValue(row.primaryKey),
        schemaError: parsed.error,
        count: 1,
      }];
    });
  return coalesceInvalidHotEntityRows(invalidRows);
}

export function readHotEntityMirrorStatus(context: HotDiagnosticsReadContext): BrokerHotEntityMirrorStatus {
  const tableCounts = readHotEntityTableCounts(context);
  // #1763: read the persist diagnostics BEFORE touching the canonical row.
  // These two reads used to be in the opposite order, which made the
  // `canonicalDegraded` tolerance below unreachable whenever the canonical row
  // was itself unparsable — the throw happened first and took the whole
  // /health response down with it.
  const persistDiag = context.readLastPersistDiagnostics();
  const canonicalRead = context.readCanonicalSnapshotRow();
  if (canonicalRead.status === "unreadable") {
    if (context.loadSource !== "hot-tables") {
      // The canonical row is the load source here, so an unreadable row is a
      // real invariant failure. Keep failing closed (#1736): rethrow verbatim
      // and let /health classify it into its bounded 500 body.
      throw canonicalRead.error;
    }
    // Hot tables are authoritative and healthy; the canonical mirror being
    // stale/oversized/corrupt is a degradation to report, not an outage.
    return {
      ok: true,
      tableCounts,
      mismatches: [],
      canonicalSnapshot: {
        status: "unreadable",
        reason: canonicalRead.reason,
        bytes: canonicalRead.bytes,
        maxBytes: canonicalRead.maxBytes,
        ...(canonicalRead.updatedAt ? { updatedAt: canonicalRead.updatedAt } : {}),
      },
    };
  }
  const snapshot = canonicalRead.status === "ok" ? canonicalRead.snapshot : undefined;
  const canonicalDegraded =
    persistDiag.lastPersistSkippedFullSnapshot ||
    persistDiag.lastPersistError?.kind === "full_snapshot_overflow" ||
    (persistDiag.lastFullSnapshotShedTerminal ?? 0) > 0;
  if (canonicalDegraded) {
    // Whenever the canonical row is intentionally behind the hot tables —
    // incremental hint-only mode, overflow-degraded write, or budget shedding
    // (#1578) — treat the hot tables as authoritative for mirror health until
    // the next clean full snapshot/checkpoint. The canonical row may be stale
    // or absent entirely in this state; drift or absence is expected and must
    // not surface as corruption. Manual drift after a clean full persist is
    // still detected when none of these hold.
    return {
      ok: true,
      tableCounts,
      ...(snapshot ? { snapshotCounts: countSnapshotEntities(snapshot) } : {}),
      mismatches: [],
    };
  }
  if (!snapshot) {
    return {
      ok: Object.values(tableCounts).every((count) => count === 0),
      tableCounts,
      mismatches: Object.entries(tableCounts)
        .filter(([, tableCount]) => tableCount !== 0)
        .map(([table, tableCount]) => ({
          table,
          snapshotKey: SQLITE_HOT_ENTITY_SNAPSHOT_KEYS[table as SqliteHotEntityTable],
          tableCount,
          snapshotCount: 0,
        })),
    };
  }

  const snapshotCounts = countSnapshotEntities(snapshot);
  const snapshotAuditIds = new Set((snapshot.auditEvents ?? []).map((event) => event.id));
  const retentionWindows: BrokerHotEntityMirrorRetentionWindow[] = [];
  const mismatches: BrokerHotEntityMirrorMismatch[] = SQLITE_HOT_ENTITY_TABLES.flatMap((table): BrokerHotEntityMirrorMismatch[] => {
    const snapshotKey = SQLITE_HOT_ENTITY_SNAPSHOT_KEYS[table];
    const tableCount = tableCounts[table] ?? 0;
    const snapshotCount = snapshotCounts[snapshotKey] ?? 0;
    if (table === "broker_audit_events") {
      const hotAuditIds = context.readTableIds("broker_audit_events");
      const hotAuditIdsAreSnapshotRows = hotAuditIds.every((id) => snapshotAuditIds.has(id));
      if (tableCount < snapshotCount && hotAuditIdsAreSnapshotRows) {
        retentionWindows.push({
          table,
          snapshotKey,
          tableCount,
          snapshotCount,
          reason: "audit_hot_retention",
          prunedCount: snapshotCount - tableCount,
        });
        return [];
      }
      if (tableCount === snapshotCount && hotAuditIdsAreSnapshotRows) {
        return [];
      }
      return [{
        table,
        snapshotKey,
        tableCount,
        snapshotCount,
        reason: tableCount === snapshotCount ? "id_drift" as const : "count_drift" as const,
      }];
    }
    if (tableCount === snapshotCount) {
      return [];
    }
    return [{ table, snapshotKey, tableCount, snapshotCount }];
  });
  return {
    ok: mismatches.length === 0,
    tableCounts,
    snapshotCounts,
    mismatches,
    ...(retentionWindows.length > 0 ? { retentionWindows } : {}),
  };
}

export function readHotEntityTableCounts(context: HotDiagnosticsReadContext): Record<string, number> {
  return Object.fromEntries(
    SQLITE_HOT_ENTITY_TABLES.map((table) => [table, context.readTableCount(table)]),
  );
}

export function readHotAuditDiagnostics(context: HotDiagnosticsReadContext): BrokerHotAuditDiagnostics {
  const total = context.readTableCount("broker_audit_events");
  const workerHeartbeat = coerceSqliteCount(
    context.db.prepare("SELECT COUNT(*) AS count FROM broker_audit_events WHERE action = 'worker.heartbeat'").get() as
      | { count?: number | bigint }
      | undefined,
  );
  const taskHeartbeat = coerceSqliteCount(
    context.db.prepare("SELECT COUNT(*) AS count FROM broker_audit_events WHERE action = 'task.heartbeat'").get() as
      | { count?: number | bigint }
      | undefined,
  );
  const heartbeat = workerHeartbeat + taskHeartbeat;
  const heartbeatRatio = total > 0 ? heartbeat / total : 0;
  const workerHeartbeatRatio = total > 0 ? workerHeartbeat / total : 0;
  const taskHeartbeatRatio = total > 0 ? taskHeartbeat / total : 0;
  const recentCutoff = new Date(Date.now() - HOT_AUDIT_RECENT_WINDOW_MS).toISOString();
  const recentTotal = coerceSqliteCount(
    context.db.prepare("SELECT COUNT(*) AS count FROM broker_audit_events WHERE created_at >= ?").get(recentCutoff) as
      | { count?: number | bigint }
      | undefined,
  );
  const recentWorkerHeartbeat = coerceSqliteCount(
    context.db.prepare("SELECT COUNT(*) AS count FROM broker_audit_events WHERE action = 'worker.heartbeat' AND created_at >= ?").get(recentCutoff) as
      | { count?: number | bigint }
      | undefined,
  );
  const recentTaskHeartbeat = coerceSqliteCount(
    context.db.prepare("SELECT COUNT(*) AS count FROM broker_audit_events WHERE action = 'task.heartbeat' AND created_at >= ?").get(recentCutoff) as
      | { count?: number | bigint }
      | undefined,
  );
  const recentHeartbeat = recentWorkerHeartbeat + recentTaskHeartbeat;
  const recentHeartbeatRatio = recentTotal > 0 ? recentHeartbeat / recentTotal : 0;
  const recentWorkerHeartbeatRatio = recentTotal > 0 ? recentWorkerHeartbeat / recentTotal : 0;
  const recentTaskHeartbeatRatio = recentTotal > 0 ? recentTaskHeartbeat / recentTotal : 0;
  const warnings: string[] = [];
  if (total > 8_000) {
    warnings.push(`broker_audit_events has ${total} rows; expected SQLite hot-table retention near 5000`);
  }
  if (recentHeartbeat >= HOT_AUDIT_HEARTBEAT_CHURN_WARNING_COUNT && recentHeartbeatRatio > 0.8) {
    warnings.push(`heartbeat audit events are ${Math.round(recentHeartbeatRatio * 100)}% of broker_audit_events in the last ${Math.round(HOT_AUDIT_RECENT_WINDOW_MS / 60_000)} minutes`);
  }
  return {
    total,
    heartbeat,
    heartbeatRatio,
    workerHeartbeat,
    workerHeartbeatRatio,
    taskHeartbeat,
    taskHeartbeatRatio,
    recentWindowMs: HOT_AUDIT_RECENT_WINDOW_MS,
    recentTotal,
    recentHeartbeat,
    recentHeartbeatRatio,
    recentWorkerHeartbeat,
    recentWorkerHeartbeatRatio,
    recentTaskHeartbeat,
    recentTaskHeartbeatRatio,
    warnings,
  };
}

export function readHotTerminalOutboxDiagnostics(context: HotDiagnosticsReadContext): BrokerHotTerminalOutboxDiagnostics {
  const nowMs = Date.now();
  const total = context.readTableCount("broker_terminal_outbox");
  const ackedRow = context.db.prepare(
    "SELECT COUNT(*) AS count FROM broker_terminal_outbox WHERE acknowledged_at IS NOT NULL",
  ).get() as { count?: number | bigint } | undefined;
  const acked = coerceSqliteCount(ackedRow);
  const rawUnacked = total - acked;
  const unackedRows = context.db.prepare(
    "SELECT created_at AS createdAt, payload FROM broker_terminal_outbox WHERE acknowledged_at IS NULL ORDER BY created_at ASC",
  ).all() as Array<{ createdAt?: string; payload?: string }>;
  let ackIneligibleUnacked = 0;
  let oldestUnackedCreatedAt: string | null = null;
  const ageBuckets: BrokerHotTerminalOutboxDiagnostics["ageBuckets"] = {
    lt1d: 0,
    "1to7d": 0,
    "7to14d": 0,
    gte14d: 0,
    unknown: 0,
  };
  const byTerminalStatus: Record<string, number> = {};
  const byReceiptStatus: Record<string, number> = {};
  const byBrokerOfRecord: Record<string, number> = {};
  const byWorker: Record<string, number> = {};
  for (const row of unackedRows) {
    const event = parseTerminalOutboxEventPayload(row.payload);
    incrementDiagnosticsCounter(byTerminalStatus, event?.payload?.status);
    incrementDiagnosticsCounter(byReceiptStatus, event?.receipt?.status);
    incrementDiagnosticsCounter(byBrokerOfRecord, event?.payload?.brokerOfRecordId);
    incrementDiagnosticsCounter(byWorker, event?.payload?.worker ?? event?.payload?.crossBrokerHandoff?.childWorkerId);
    incrementDiagnosticsCounter(ageBuckets, terminalOutboxAgeBucket(row.createdAt, nowMs));
    if (isAckIneligibleTerminalOutboxEvent(event)) {
      ackIneligibleUnacked += 1;
      continue;
    }
    if (oldestUnackedCreatedAt === null && typeof row.createdAt === "string") {
      oldestUnackedCreatedAt = row.createdAt;
    }
  }
  const ackEligibleUnacked = Math.max(0, rawUnacked - ackIneligibleUnacked);
  const unacked = ackEligibleUnacked;
  const unackedRatio = total > 0 ? unacked / total : 0;
  const oldestUnackedAgeMs = oldestUnackedCreatedAt !== null
    ? nowMs - Date.parse(oldestUnackedCreatedAt)
    : null;
  const actionableBacklog = ackEligibleUnacked > 0 && oldestUnackedAgeMs !== null && oldestUnackedAgeMs > 7 * 24 * 60 * 60 * 1000;
  const classification: BrokerHotTerminalOutboxDiagnostics["classification"] = actionableBacklog
    ? "actionable_review_required"
    : ackEligibleUnacked > 0
      ? "recent_unacked_watch"
      : ackIneligibleUnacked > 0
        ? "ack_ineligible_historical_residue"
        : "clean";
  const warnings: string[] = [];
  if (unacked > 500) {
    warnings.push(`broker_terminal_outbox has ${unacked} unacked entries; may indicate stalled provider delivery`);
  }
  if (oldestUnackedAgeMs !== null && oldestUnackedAgeMs > 7 * 24 * 60 * 60 * 1000) {
    warnings.push(`oldest unacked terminal outbox entry is ${Math.round(oldestUnackedAgeMs / (24 * 60 * 60 * 1000))} days old`);
  }
  return {
    total,
    acked,
    rawUnacked,
    unacked,
    ackEligibleUnacked,
    ackIneligibleUnacked,
    unackedRatio,
    oldestUnackedCreatedAt,
    oldestUnackedAgeMs,
    classification,
    actionableBacklog,
    ageBuckets,
    byTerminalStatus,
    byReceiptStatus,
    byBrokerOfRecord,
    byWorker,
    warnings,
  };
}

export function readHotTableLoadMetrics(context: HotDiagnosticsReadContext): BrokerHotTableLoadMetrics {
  const tables: Record<string, BrokerHotTableLoadMetricEntry> = {};
  for (const table of SQLITE_HOT_ENTITY_TABLES) {
    const count = context.readTableCount(table);
    const maxPayloadBytes = count === 0 ? 0 : readMaxPayloadBytes(table, context);
    const totalPayloadBytes = count === 0 ? 0 : readTotalPayloadBytes(table, context);
    const entry: BrokerHotTableLoadMetricEntry = { count, maxPayloadBytes, totalPayloadBytes };
    if (table === "broker_tasks") {
      const terminalCount = readTerminalTaskCount(context);
      const activeCount = count - terminalCount;
      const terminalLoadedCount = Math.min(terminalCount, context.maxHotRuntimeTerminalTasks);
      entry.runtimeLoad = {
        limit: context.maxHotRuntimeTerminalTasks,
        loadedCount: activeCount + terminalLoadedCount,
        skippedCount: Math.max(0, terminalCount - terminalLoadedCount),
        activeCount,
        terminalCount,
      };
    } else if (table === "broker_audit_events") {
      const loadedCount = Math.min(count, context.maxHotRuntimeAuditEvents);
      entry.runtimeLoad = {
        limit: context.maxHotRuntimeAuditEvents,
        loadedCount,
        skippedCount: Math.max(0, count - loadedCount),
      };
    } else if (table === "broker_terminal_outbox") {
      const unackedRow = context.db
        .prepare(
          "SELECT COUNT(*) AS count FROM broker_terminal_outbox WHERE acknowledged_at IS NULL",
        )
        .get() as { count?: number | bigint } | undefined;
      const unackedCount = coerceSqliteCount(unackedRow);
      const loadedCount = Math.min(count, context.maxHotRuntimeTerminalOutboxEvents);
      entry.unackedCount = unackedCount;
      entry.runtimeLoad = {
        limit: context.maxHotRuntimeTerminalOutboxEvents,
        loadedCount,
        skippedCount: Math.max(0, count - loadedCount),
      };
    }
    tables[table] = entry;
  }
  return { tables };
}

function readMaxPayloadBytes(table: SqliteHotEntityTable, context: HotDiagnosticsReadContext): number {
  const maxRow = context.db
    .prepare(`SELECT COALESCE(MAX(LENGTH(payload)), 0) AS maxLen FROM ${table}`)
    .get() as { maxLen?: number | bigint } | undefined;
  return typeof maxRow?.maxLen === "bigint"
    ? Number(maxRow.maxLen)
    : typeof maxRow?.maxLen === "number" ? maxRow.maxLen : 0;
}

function readTotalPayloadBytes(table: SqliteHotEntityTable, context: HotDiagnosticsReadContext): number {
  const sumRow = context.db
    .prepare(`SELECT COALESCE(SUM(LENGTH(payload)), 0) AS totalLen FROM ${table}`)
    .get() as { totalLen?: number | bigint } | undefined;
  return typeof sumRow?.totalLen === "bigint"
    ? Number(sumRow.totalLen)
    : typeof sumRow?.totalLen === "number" ? sumRow.totalLen : 0;
}

function readTerminalTaskCount(context: HotDiagnosticsReadContext): number {
  const row = context.db
    .prepare("SELECT COUNT(*) AS count FROM broker_tasks WHERE status IN ('succeeded', 'failed', 'canceled')")
    .get() as { count?: number | bigint } | undefined;
  return coerceSqliteCount(row);
}
