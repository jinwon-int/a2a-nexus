import { createHash } from "node:crypto";

import { DEFAULT_BROKER_RETENTION_POLICY } from "./broker.js";
import { DEFAULT_TERMINAL_TASK_OUTBOX_RETENTION } from "./terminal-event-outbox.js";
import type {
  SqliteBrokerStateStore,
  SqliteCanonicalSnapshotRetentionSyncResult,
  SqliteHotRetentionApplyResult,
  SqliteHotRetentionPlan,
} from "./store.js";
import type { AuditEvent, TaskRecord } from "./types.js";

export type BrokerCleanupRiskClass = "low" | "medium" | "high";

/**
 * Actionability of a cleanup table plan — tells operators whether prune
 * candidates are actionable or purely advisory/retention signals.
 *
 * - `retention_not_due`: Records are past the retention window but within
 *   the max-records cap; no action needed until the cap is exceeded.
 * - `advisory`: Prune candidates exist but require explicit operator
 *   marking/approval before execution.
 * - `executable`: Prune candidates are safe to execute under the current
 *   operator plan (e.g. a safe prune plan exists for this table).
 */
export type CleanupActionability = "retention_not_due" | "advisory" | "executable";

export interface BrokerCleanupPlanOptions {
  nowMs?: number;
  taskRetentionMs?: number;
  maxTerminalTasks?: number;
  /**
   * Cumulative serialized-byte budget for retained terminal task rows (#1768).
   * Defaults to the retention policy's `maxTerminalTaskBytes`. Without it the
   * plan is count-only and cannot see the budget that actually gates canonical
   * snapshot writes.
   */
  maxTerminalTaskBytes?: number;
  auditRetentionMs?: number;
  maxAuditEvents?: number;
  workerRetentionMs?: number;
  maxInactiveWorkers?: number;
  terminalOutboxRetentionMs?: number;
  maxAcknowledgedTerminalOutboxEvents?: number;
  protectedTaskIds?: string[];
  protectedWorkerIds?: string[];
}

export interface BrokerCleanupTablePlan extends SqliteHotRetentionPlan {
  stableId: string;
  pruneCount: number;
  retainedCount: number;
  /** Number of records retained solely because the max-records cap (e.g.
   * maxTerminalRecords or maxInactiveWorkers) kept them from the prune set.
   * These items are past the retention window but under the cap limit. */
  retainedByCapCount: number;
  /**
   * Actionability of this table's prune candidates.
   *
   * - `retention_not_due`: retainedByCapCount > 0 and no prune candidates;
   *   these rows are retained by the current cap, not eligible for cleanup.
   * - `advisory`: prune candidates exist but require explicit operator
   *   approval before execution (the default for worker/outbox tables).
   * - `executable`: prune candidates may be executed under a safe operator
   *   prune plan.
   */
  actionability: CleanupActionability;
  reason: string;
  riskClass: BrokerCleanupRiskClass;
  executionBlockedByDefault?: boolean;
}

export interface BrokerCleanupPlan {
  kind: "broker.cleanup.plan";
  mode: "dry-run";
  planId: string;
  generatedAt: string;
  options: Required<BrokerCleanupPlanOptions>;
  tableCounts: Record<string, number>;
  summary: {
    candidateTables: number;
    totalPruneCandidates: number;
    highestRisk: BrokerCleanupRiskClass;
    executionRequires: string[];
  };
  tables: BrokerCleanupTablePlan[];
  notes: string[];
}

export interface BrokerCleanupExecutionOptions {
  approvalToken?: string;
  confirmation?: string;
  backupProof?: string;
  allowWorkerPrune?: boolean;
  actorId?: string;
}

export interface BrokerCleanupExecutionResult {
  kind: "broker.cleanup.execution";
  planId: string;
  appliedAt: string;
  results: SqliteHotRetentionApplyResult[];
  canonicalSnapshotSync: SqliteCanonicalSnapshotRetentionSyncResult;
  auditEvent: AuditEvent;
  rollbackNotes: string[];
}

export const BROKER_CLEANUP_CONFIRMATION = "APPLY_BROKER_CLEANUP_PLAN";

const DEFAULT_CLEANUP_OPTIONS: Required<Omit<BrokerCleanupPlanOptions, "nowMs" | "protectedTaskIds" | "protectedWorkerIds">> = {
  taskRetentionMs: DEFAULT_BROKER_RETENTION_POLICY.terminalRetentionMs,
  maxTerminalTasks: DEFAULT_BROKER_RETENTION_POLICY.maxTerminalTasks,
  maxTerminalTaskBytes: DEFAULT_BROKER_RETENTION_POLICY.maxTerminalTaskBytes,
  auditRetentionMs: DEFAULT_BROKER_RETENTION_POLICY.auditRetentionMs,
  maxAuditEvents: DEFAULT_BROKER_RETENTION_POLICY.maxAuditEvents,
  workerRetentionMs: DEFAULT_BROKER_RETENTION_POLICY.inactiveWorkerRetentionMs,
  maxInactiveWorkers: DEFAULT_BROKER_RETENTION_POLICY.maxInactiveWorkers,
  terminalOutboxRetentionMs: DEFAULT_BROKER_RETENTION_POLICY.terminalRetentionMs,
  maxAcknowledgedTerminalOutboxEvents: DEFAULT_TERMINAL_TASK_OUTBOX_RETENTION,
};

const RISK_ORDER: BrokerCleanupRiskClass[] = ["low", "medium", "high"];
const TERMINAL_TASK_STATUSES = new Set<TaskRecord["status"]>(["succeeded", "failed", "canceled"]);

export function buildBrokerCleanupPlan(
  store: SqliteBrokerStateStore,
  input: BrokerCleanupPlanOptions = {},
): BrokerCleanupPlan {
  const nowMs = input.nowMs ?? Date.now();
  const normalized = normalizeCleanupOptions(input, nowMs);
  // Use a bounded read for active-worker discovery; 2000 rows covers typical non-terminal task sets
  // without unbounded heap materialization. Cleanup planning uses dedicated planHot*Retention methods
  // that evaluate every row for retention decisions.
  const tasks = store.readHotTasks({ maxRows: 2000 });
  const activeWorkerIds = new Set(
    tasks
      .filter((task) => !TERMINAL_TASK_STATUSES.has(task.status))
      .flatMap((task) => [task.assignedWorkerId, task.claimedBy].filter((value): value is string => Boolean(value))),
  );
  const protectedWorkerIds = [...new Set([...normalized.protectedWorkerIds, ...activeWorkerIds])].sort();

  const taskPlan = store.planHotTaskRetention({
    nowMs,
    retentionMs: normalized.taskRetentionMs,
    maxTerminalRecords: normalized.maxTerminalTasks,
    maxTerminalRecordBytes: normalized.maxTerminalTaskBytes,
    protectedTaskIds: normalized.protectedTaskIds,
  });
  const workerPlan = store.planHotWorkerRetention({
    nowMs,
    retentionMs: normalized.workerRetentionMs,
    maxInactiveWorkers: normalized.maxInactiveWorkers,
    protectedWorkerIds,
  });
  const auditPlan = store.planHotAuditRetention({
    nowMs,
    retentionMs: normalized.auditRetentionMs,
    maxRecords: normalized.maxAuditEvents,
    protectedIds: {
      taskIds: taskPlan.retainedIds,
      workerIds: workerPlan.retainedIds,
    },
  });
  const terminalOutboxPlan = store.planHotTerminalOutboxRetention({
    nowMs,
    retentionMs: normalized.terminalOutboxRetentionMs,
    maxAcknowledgedRecords: normalized.maxAcknowledgedTerminalOutboxEvents,
  });

  const tables = [
    decoratePlan(taskPlan, "terminal task rows older than retention/cap window", "medium"),
    decoratePlan(auditPlan, "audit rows outside retention/cap window after protected target coverage", "low"),
    decoratePlan(workerPlan, "inactive worker rows outside retention/cap window", "high", true),
    decoratePlan(
      terminalOutboxPlan,
      "acknowledged terminal outbox rows older than retention/cap window; unacked rows are always retained",
      "high",
      true,
    ),
  ];
  const tableCounts = store.readHotEntityTableCounts();
  const candidateTables = tables.filter((plan) => plan.pruneCount > 0).length;
  const totalPruneCandidates = tables.reduce((sum, plan) => sum + plan.pruneCount, 0);
  const highestRisk = tables.reduce<BrokerCleanupRiskClass>(
    (highest, plan) => plan.pruneCount > 0 && RISK_ORDER.indexOf(plan.riskClass) > RISK_ORDER.indexOf(highest)
      ? plan.riskClass
      : highest,
    "low",
  );
  const generatedAt = new Date(nowMs).toISOString();
  const planId = stableHash({
    generatedAt,
    options: normalized,
    tables: tables.map(({ table, cutoffMs, retainedIds, pruneIds, riskClass }) => ({
      table,
      cutoffMs,
      retainedIds,
      pruneIds,
      riskClass,
    })),
  });

  return {
    kind: "broker.cleanup.plan",
    mode: "dry-run",
    planId,
    generatedAt,
    options: normalized,
    tableCounts,
    summary: {
      candidateTables,
      totalPruneCandidates,
      highestRisk: totalPruneCandidates === 0 ? "low" : highestRisk,
      executionRequires: [
        "matching approvalToken equal to planId",
        `confirmation string ${BROKER_CLEANUP_CONFIRMATION}`,
        "non-empty backupProof/checkpoint evidence",
        "separate allowWorkerPrune=true when worker rows are candidates",
      ],
    },
    tables,
    notes: [
      "This is a dry-run discovery/plan only; no rows are mutated by buildBrokerCleanupPlan.",
      `Tables with actionability "retention_not_due" have records past the retention window but within BOTH the max-records cap and the byte budget. These are not actionable cleanup candidates.`,
      `Terminal task pruning is bounded by maxTerminalTaskBytes as well as maxTerminalTasks (#1768). The byte budget only ever reaches rows already past the retention window; rows inside the window are never offered as prune candidates.`,
      `Audit prune candidates are coupled to task retention: audit rows are protected while their target task is retained, so pruning tasks releases their audit rows in the same plan. Expect the audit count to move whenever the task count does — read both numbers together before approving.`,
      ...(tables.some((plan) => plan.byteBudgetUnreachable)
        ? [
          `A table reports byteBudgetUnreachable: the byte budget is still exceeded after every past-retention row was offered for pruning. Pruning alone cannot fit this budget — either the retention window must shorten or the budget must rise. This plan will not delete rows inside the retention window to close the gap.`,
        ]
        : []),
      `Tables with actionability "advisory" have prune candidates that require operator review and explicit approval before execution.`,
      "Worker-row pruning is fail-closed by default because stale rows may still be valid home-broker records.",
      "Terminal outbox pruning is dry-run-only here; unacked rows remain protected until a separate operator ACK/prune approval path exists.",
      "Execution appends a broker.cleanup.applied audit row after pruning; rollback is restore from the backup/checkpoint named in backupProof.",
      "Provider accepted-send receipts are not terminal ACK evidence and are not used as cleanup proof.",
    ],
  };
}

export function executeBrokerCleanupPlan(
  store: SqliteBrokerStateStore,
  plan: BrokerCleanupPlan,
  options: BrokerCleanupExecutionOptions,
): BrokerCleanupExecutionResult {
  const blockers = validateCleanupExecution(plan, options);
  if (blockers.length > 0) {
    throw new Error(`broker cleanup execution blocked: ${blockers.join("; ")}`);
  }
  const appliedAt = new Date().toISOString();
  const results = store.applyHotRetentionPlans(plan.tables);
  const auditEvent: AuditEvent = {
    id: `broker-cleanup-${plan.planId}-${Date.parse(appliedAt)}`,
    actorId: options.actorId?.trim() || "operator.cleanup",
    action: "broker.cleanup.applied",
    targetType: "broker",
    targetId: plan.planId,
    note: JSON.stringify({
      backupProof: options.backupProof,
      rollback: "restore the broker SQLite file from the referenced backup/checkpoint, then restart/reload under operator control",
      results,
    }),
    createdAt: appliedAt,
  };
  store.upsertHotAuditEvents([auditEvent]);
  const canonicalSnapshotSync = store.syncCanonicalSnapshotWithHotRetentionPlans(plan.tables, auditEvent);
  return {
    kind: "broker.cleanup.execution",
    planId: plan.planId,
    appliedAt,
    results,
    canonicalSnapshotSync,
    auditEvent,
    rollbackNotes: [
      "Stop broker writes before rollback.",
      "Restore the SQLite state file from backupProof/checkpoint evidence.",
      "Run cleanup plan again in dry-run mode to confirm candidate counts before resuming normal operation.",
    ],
  };
}

export function validateCleanupExecution(
  plan: BrokerCleanupPlan,
  options: BrokerCleanupExecutionOptions,
): string[] {
  const blockers: string[] = [];
  if (options.approvalToken !== plan.planId) {
    blockers.push("approvalToken does not match planId");
  }
  if (options.confirmation !== BROKER_CLEANUP_CONFIRMATION) {
    blockers.push(`confirmation must equal ${BROKER_CLEANUP_CONFIRMATION}`);
  }
  if (typeof options.backupProof !== "string" || options.backupProof.trim().length === 0) {
    blockers.push("backupProof is required before cleanup execution");
  }
  const workerPlan = plan.tables.find((table) => table.table === "broker_workers");
  if ((workerPlan?.pruneCount ?? 0) > 0 && options.allowWorkerPrune !== true) {
    blockers.push("worker prune candidates require allowWorkerPrune=true because stale workers may still be valid home-broker records");
  }
  const terminalOutboxPlan = plan.tables.find((table) => table.table === "broker_terminal_outbox");
  if ((terminalOutboxPlan?.pruneCount ?? 0) > 0) {
    blockers.push("terminal outbox prune candidates are dry-run-only; require separate operator ACK/prune approval path");
  }
  return blockers;
}

function normalizeCleanupOptions(
  input: BrokerCleanupPlanOptions,
  nowMs: number,
): Required<BrokerCleanupPlanOptions> {
  return {
    nowMs,
    taskRetentionMs: normalizeNonNegativeInteger(input.taskRetentionMs, DEFAULT_CLEANUP_OPTIONS.taskRetentionMs),
    maxTerminalTasks: normalizeNonNegativeInteger(input.maxTerminalTasks, DEFAULT_CLEANUP_OPTIONS.maxTerminalTasks),
    maxTerminalTaskBytes: normalizeNonNegativeInteger(
      input.maxTerminalTaskBytes,
      DEFAULT_CLEANUP_OPTIONS.maxTerminalTaskBytes,
    ),
    auditRetentionMs: normalizeNonNegativeInteger(input.auditRetentionMs, DEFAULT_CLEANUP_OPTIONS.auditRetentionMs),
    maxAuditEvents: normalizeNonNegativeInteger(input.maxAuditEvents, DEFAULT_CLEANUP_OPTIONS.maxAuditEvents),
    workerRetentionMs: normalizeNonNegativeInteger(input.workerRetentionMs, DEFAULT_CLEANUP_OPTIONS.workerRetentionMs),
    maxInactiveWorkers: normalizeNonNegativeInteger(input.maxInactiveWorkers, DEFAULT_CLEANUP_OPTIONS.maxInactiveWorkers),
    terminalOutboxRetentionMs: normalizeNonNegativeInteger(input.terminalOutboxRetentionMs, DEFAULT_CLEANUP_OPTIONS.terminalOutboxRetentionMs),
    maxAcknowledgedTerminalOutboxEvents: normalizeNonNegativeInteger(
      input.maxAcknowledgedTerminalOutboxEvents,
      DEFAULT_CLEANUP_OPTIONS.maxAcknowledgedTerminalOutboxEvents,
    ),
    protectedTaskIds: normalizeStringArray(input.protectedTaskIds),
    protectedWorkerIds: normalizeStringArray(input.protectedWorkerIds),
  };
}

function decoratePlan(
  plan: SqliteHotRetentionPlan,
  reason: string,
  riskClass: BrokerCleanupRiskClass,
  executionBlockedByDefault = false,
): BrokerCleanupTablePlan {
  const retainedByCapCount = plan.retainedByCapCount ?? 0;
  const pruneCount = plan.pruneIds.length;
  return {
    ...plan,
    stableId: stableHash({ table: plan.table, cutoffMs: plan.cutoffMs, pruneIds: plan.pruneIds }),
    pruneCount,
    retainedCount: plan.retainedIds.length,
    retainedByCapCount,
    actionability: computeActionability(pruneCount, retainedByCapCount, executionBlockedByDefault),
    reason,
    riskClass,
    ...(executionBlockedByDefault ? { executionBlockedByDefault } : {}),
  };
}

function computeActionability(
  pruneCount: number,
  retainedByCapCount: number,
  _executionBlockedByDefault: boolean,
): CleanupActionability {
  // actionability captures how the table's records should be treated:
  //
  // - retention_not_due: Records past the retention window are all
  //   retained by the max-records cap AND the byte budget (#1768), or there
  //   are no prune candidates.
  //   Nothing is eligible for pruning. These are retention/advisory policy
  //   signals, not executable cleanup items.
  //
  // - advisory: Prune candidates exist but require operator review and
  //   explicit approval before execution. This is the default for all
  //   tables during dry-run plan creation.
  //
  // - executable: (reserved) The operator plan has marked this table's
  //   prune candidates as safe to execute. Not returned during dry-run.
  //
  // During dry-run plan creation, all tables with prune candidates
  // default to "advisory". Execution requires passing through
  // executeBrokerCleanupPlan with matching approval. The
  // executionBlockedByDefault field on worker/outbox tables signals
  // extra guardrails (allowWorkerPrune, separate ACK path) — but all
  // tables are advisory until the operator explicitly executes.
  if (pruneCount === 0) {
    return "retention_not_due";
  }
  if (retainedByCapCount > 0) {
    // Some records past retention are retained by cap, but pruneCount > 0
    // means others exceed the cap. The pruneable records are advisory.
    return "advisory";
  }
  return "advisory";
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeStringArray(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))].sort();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
