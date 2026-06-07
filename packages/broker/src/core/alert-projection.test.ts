/**
 * Alert projection tests — Node built-in test runner.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectAlerts,
  projectHotTableGrowthAlerts,
} from "./alert-projection.js";
import type {
  TaskDiagnosticReport,
  TaskRecord,
  TaskTombstone,
  WorkerRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    exchangeId: undefined,
    intent: "chat",
    requester: { id: "seoseo", kind: "node", role: "hub" },
    target: { id: "bangtong", kind: "node", role: "live-trader" },
    workspace: undefined,
    message: "test",
    proposalId: undefined,
    artifactIds: [],
    assignedWorkerId: "bangtong",
    via: undefined,
    policyContext: undefined,
    targetNodeId: "bangtong",
    payload: {},
    status: "running",
    claimedAt: new Date(Date.now() - 300_000).toISOString(),
    completedAt: undefined,
    claimedBy: "bangtong",
    result: undefined,
    error: undefined,
    requeueCount: 0,
    lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeReport(
  overrides: Partial<TaskDiagnosticReport> = {},
  taskOverrides: Partial<TaskRecord> = {},
): TaskDiagnosticReport {
  const task = makeTask(taskOverrides);
  return {
    taskId: task.id,
    diagnosticStatus: "active",
    brokerState: "healthy",
    reconcileNeeded: false,
    interruption: undefined,
    task,
    currentStatusDurationMs: 60_000,
    stalenessMs: undefined,
    brokerHints: {
      staleLease: false,
      staleWorker: false,
      cancellationRequested: false,
      requeued: false,
      lastRequeueAt: undefined,
      lastRequeueReason: undefined,
      workerLastSeenAt: undefined,
      tombstoneReason: undefined,
    },
    tombstone: undefined,
    lifecycle: {
      createdAt: task.createdAt,
      claimedAt: task.claimedAt,
      lastHeartbeatAt: task.lastHeartbeatAt,
    },
    ...overrides,
  };
}

function makeWorker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    nodeId: "worker-a",
    role: "analyst",
    displayName: "Worker A",
    brokerUrl: undefined,
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
    metadata: undefined,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    updatedAt: new Date(Date.now() - 600_000).toISOString(),
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("projectAlerts", () => {
  const nowMs = 1_000_000_000;

  it("returns empty alerts when all tasks are active", () => {
    const reports = [makeReport({ diagnosticStatus: "active" })];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 0);
    assert.equal(result.totalScanned, 1);
    assert.equal(result.counts.critical, 0);
    assert.equal(result.counts.warning, 0);
  });

  it("produces a warning alert for stale tasks under critical threshold", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "stale",
        stalenessMs: 180_000,
        currentStatusDurationMs: 180_000,
      }),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "task_stale");
    assert.equal(result.alerts[0]!.severity, "warning");
    assert.equal(result.alerts[0]!.taskId, "task-1");
    assert.equal(result.counts.warning, 1);
  });

  it("produces a critical alert for stale tasks over critical threshold", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "stale",
        stalenessMs: 700_000,
        currentStatusDurationMs: 700_000,
      }),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.severity, "critical");
  });

  it("produces a warning for long-running tasks", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "long_running",
        currentStatusDurationMs: 5_400_000,
      }),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "task_long_running");
    assert.equal(result.alerts[0]!.severity, "warning");
  });

  it("produces a critical alert for very long-running tasks", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "long_running",
        currentStatusDurationMs: 18_000_000,
      }),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.severity, "critical");
  });

  it("produces alert for dead-lettered tombstone", () => {
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "dead_lettered",
            durationMs: 300_000,
            requeueCount: 5,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          } satisfies TaskTombstone,
        },
        { status: "failed" },
      ),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "task_dead_lettered");
    assert.equal(result.alerts[0]!.severity, "critical");
  });

  it("produces alert for worker_lost tombstone", () => {
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "worker_lost",
            durationMs: 200_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          } satisfies TaskTombstone,
        },
        { status: "failed" },
      ),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "task_worker_lost");
    assert.equal(result.alerts[0]!.severity, "warning");
  });

  it("produces alert for timeout tombstone", () => {
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "timeout",
            durationMs: 600_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          } satisfies TaskTombstone,
        },
        { status: "failed" },
      ),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "task_timeout");
  });

  it("compacts failed tombstone error metadata so alert scans stay bounded", () => {
    const largeDetails = { output: "x".repeat(200_000) };
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "failed",
            durationMs: 100_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
            error: {
              code: "worker_failed",
              message: "failure " + "m".repeat(5_000),
              details: largeDetails,
            },
          },
        },
        { id: "task-1", status: "failed" },
      ),
    ];

    const result = projectAlerts(reports, { nowMs });
    const error = result.alerts[0]!.metadata.error as Record<string, unknown>;
    assert.equal(error.code, "worker_failed");
    assert.equal(error.messageTruncated, true);
    assert.equal(error.detailsOmitted, true);
    assert.equal(typeof error.detailsBytes, "number");
    assert.ok(JSON.stringify(result.alerts[0]).length < 2_000);
    assert.doesNotMatch(JSON.stringify(result.alerts[0]), /xxxxxxxx/);
  });

  it("produces alerts for failed and canceled tombstones at info severity", () => {
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "failed",
            durationMs: 100_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          },
        },
        { id: "task-1", status: "failed" },
      ),
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-2",
            terminalStatus: "canceled",
            tombstoneReason: "canceled",
            durationMs: 50_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          },
        },
        { id: "task-2", status: "canceled" },
      ),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 2);
    assert.ok(result.alerts.every((a) => a.severity === "info"));
    assert.equal(result.counts.info, 2);
  });

  it("sorts alerts by severity (critical > warning > info)", () => {
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "failed",
            durationMs: 100_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          },
        },
        { status: "failed" },
      ),
      makeReport({
        diagnosticStatus: "stale",
        stalenessMs: 180_000,
        currentStatusDurationMs: 180_000,
      }),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts[0]!.severity, "warning");
    assert.equal(result.alerts[1]!.severity, "info");
  });

  it("generates deterministic alert ids", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "stale",
        stalenessMs: 180_000,
        currentStatusDurationMs: 180_000,
      }),
    ];
    const r1 = projectAlerts(reports, { nowMs });
    const r2 = projectAlerts(reports, { nowMs });
    assert.equal(r1.alerts[0]!.id, r2.alerts[0]!.id);
    assert.equal(r1.alerts[0]!.id, "task_stale:task-1");
  });

  it("projects hot-table growth alerts for warning-level tables", () => {
    const projection = {
      kind: "broker.hot-table-growth.projection" as const,
      generatedAt: "2026-05-27T01:00:00.000Z",
      hasPrior: true,
      priorGeneratedAt: "2026-05-26T01:00:00.000Z",
      totalEstimatedMemoryBytes: 150_000_000,
      overallSeverity: "warning" as const,
      tables: [
        {
          table: "broker_tasks",
          currentCount: 1200,
          maxPayloadBytes: 110_000,
          estimatedMemoryBytes: 132_000_000,
          runtimeLimit: 2000,
          runtimeLoaded: 1200,
          runtimeSkipped: 0,
          priorCount: 800,
          growthDelta: 400,
          growthRate: 0.5,
          severity: "warning" as const,
          summary: "broker_tasks: 1200 rows, ~126.0 MB in-memory, +50.0% growth",
        },
        {
          table: "broker_audit_events",
          currentCount: 300,
          maxPayloadBytes: 1_000,
          estimatedMemoryBytes: 300_000,
          runtimeLimit: 5000,
          runtimeLoaded: 300,
          runtimeSkipped: 0,
          priorCount: 250,
          growthDelta: 50,
          growthRate: 0.2,
          severity: "ok" as const,
          summary: "broker_audit_events: 300 rows, ~293.0 KB in-memory",
        },
        {
          table: "broker_terminal_outbox",
          currentCount: 50,
          maxPayloadBytes: 2_000,
          estimatedMemoryBytes: 100_000,
          runtimeLimit: 1000,
          runtimeLoaded: 50,
          runtimeSkipped: 0,
          priorCount: 50,
          growthDelta: 0,
          growthRate: 0,
          severity: "ok" as const,
          summary: "broker_terminal_outbox: 50 rows, ~97.7 KB in-memory",
        },
      ],
      runtimeLoadLimits: { terminalTasks: 2000, auditEvents: 5000, terminalOutboxEvents: 1000 },
      warnings: ["WARNING: broker_tasks: 1200 rows, ~126.0 MB in-memory, +50.0% growth"],
      warningsTruncated: false,
    };
    const alerts = projectHotTableGrowthAlerts(projection, "2026-05-27T01:00:00.000Z");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.kind, "hot_table_growth");
    assert.equal(alerts[0]!.severity, "warning");
    assert.equal(alerts[0]!.id, "hot_table_growth:broker_tasks");
    assert.equal(alerts[0]!.subject.kind, "storage");
    assert.equal(alerts[0]!.subject.id, "broker_tasks");
    assert.match(alerts[0]!.summary, /WARNING/);
    assert.equal(alerts[0]!.metadata.table, "broker_tasks");
    assert.equal(alerts[0]!.metadata.currentCount, 1200);
    assert.equal(alerts[0]!.metadata.estimatedMemoryBytes, 132_000_000);
    assert.equal(alerts[0]!.metadata.operatorAction, "investigate");
    assert.equal(alerts[0]!.metadata.runtimeLimit, 2000);
  });

  it("projects hot-table growth alerts for critical-level tables", () => {
    const projection = {
      kind: "broker.hot-table-growth.projection" as const,
      generatedAt: "2026-05-27T01:00:00.000Z",
      hasPrior: true,
      priorGeneratedAt: "2026-05-26T01:00:00.000Z",
      totalEstimatedMemoryBytes: 600_000_000,
      overallSeverity: "critical" as const,
      tables: [
        {
          table: "broker_tasks",
          currentCount: 6000,
          maxPayloadBytes: 120_000,
          estimatedMemoryBytes: 720_000_000,
          runtimeLimit: 2000,
          runtimeLoaded: 2000,
          runtimeSkipped: 4000,
          priorCount: 4000,
          growthDelta: 2000,
          growthRate: 0.5,
          severity: "critical" as const,
          summary: "broker_tasks: 6000 rows, ~686.6 MB in-memory, +50.0% growth, 4000 rows (67%) skipped from heap",
        },
        {
          table: "broker_audit_events",
          currentCount: 6000,
          maxPayloadBytes: 2_000,
          estimatedMemoryBytes: 12_000_000,
          runtimeLimit: 5000,
          runtimeLoaded: 5000,
          runtimeSkipped: 1000,
          priorCount: 3000,
          growthDelta: 3000,
          growthRate: 1.0,
          severity: "critical" as const,
          summary: "broker_audit_events: 6000 rows, ~11.4 MB in-memory, +100.0% growth, 1000 rows (17%) skipped from heap",
        },
        {
          table: "broker_terminal_outbox",
          currentCount: 30,
          maxPayloadBytes: 2_000,
          estimatedMemoryBytes: 60_000,
          runtimeLimit: 1000,
          runtimeLoaded: 30,
          runtimeSkipped: 0,
          priorCount: 25,
          growthDelta: 5,
          growthRate: 0.2,
          severity: "ok" as const,
          summary: "broker_terminal_outbox: 30 rows, ~58.6 KB in-memory",
        },
      ],
      runtimeLoadLimits: { terminalTasks: 2000, auditEvents: 5000, terminalOutboxEvents: 1000 },
      warnings: ["CRITICAL: broker_tasks: ...", "CRITICAL: broker_audit_events: ..."],
      warningsTruncated: false,
    };
    const alerts = projectHotTableGrowthAlerts(projection, "2026-05-27T01:00:00.000Z");
    assert.equal(alerts.length, 2);
    assert.ok(alerts.every((a) => a.kind === "hot_table_growth"));
    assert.ok(alerts.every((a) => a.severity === "critical"));
    assert.equal(alerts[0]!.id, "hot_table_growth:broker_tasks");
    assert.equal(alerts[1]!.id, "hot_table_growth:broker_audit_events");
    assert.match(alerts[0]!.summary, /CRITICAL/);
    assert.match(alerts[1]!.summary, /CRITICAL/);
    assert.equal(alerts[0]!.metadata.runtimeSkipped, 4000);
  });

  it("limits hot-table growth alerts to MAX_HOT_TABLE_GROWTH_ALERTS", () => {
    const tables = Array.from({ length: 10 }, (_, i) => ({
      table: `broker_table_${i}`,
      currentCount: 5000 + i,
      maxPayloadBytes: 10_000,
      estimatedMemoryBytes: 50_000_000 + i * 1_000_000,
      runtimeLimit: null,
      runtimeLoaded: 5000 + i,
      runtimeSkipped: 0,
      priorCount: null,
      growthDelta: 0,
      growthRate: null,
      severity: "warning" as const,
      summary: `broker_table_${i}: ${5000 + i} rows, ~47.7 MB in-memory`,
    }));
    const projection = {
      kind: "broker.hot-table-growth.projection" as const,
      generatedAt: "2026-05-27T01:00:00.000Z",
      hasPrior: false,
      priorGeneratedAt: null,
      totalEstimatedMemoryBytes: 500_000_000,
      overallSeverity: "warning" as const,
      tables,
      runtimeLoadLimits: { terminalTasks: 2000, auditEvents: 5000, terminalOutboxEvents: 1000 },
      warnings: [],
      warningsTruncated: false,
    };
    const alerts = projectHotTableGrowthAlerts(projection, "2026-05-27T01:00:00.000Z");
    // Should emit at most 5 alerts (MAX_HOT_TABLE_GROWTH_ALERTS)
    assert.ok(alerts.length <= 5);
    assert.equal(alerts.length, 5);
    // Ensure the truncation prefers the first tables in the projection.
    assert.equal(alerts[0]!.subject.id, "broker_table_0");
    assert.equal(alerts[4]!.subject.id, "broker_table_4");
  });

  it("produces no alerts when all tables have ok severity", () => {
    const projection = {
      kind: "broker.hot-table-growth.projection" as const,
      generatedAt: "2026-05-27T01:00:00.000Z",
      hasPrior: true,
      priorGeneratedAt: "2026-05-26T01:00:00.000Z",
      totalEstimatedMemoryBytes: 5_000_000,
      overallSeverity: "ok" as const,
      tables: [
        {
          table: "broker_tasks",
          currentCount: 50,
          maxPayloadBytes: 100_000,
          estimatedMemoryBytes: 5_000_000,
          runtimeLimit: 2000,
          runtimeLoaded: 50,
          runtimeSkipped: 0,
          priorCount: 45,
          growthDelta: 5,
          growthRate: 0.111,
          severity: "ok" as const,
          summary: "broker_tasks: 50 rows, ~4.8 MB in-memory",
        },
      ],
      runtimeLoadLimits: { terminalTasks: 2000, auditEvents: 5000, terminalOutboxEvents: 1000 },
      warnings: [],
      warningsTruncated: false,
    };
    const alerts = projectHotTableGrowthAlerts(projection, "2026-05-27T01:00:00.000Z");
    assert.equal(alerts.length, 0);
  });

  it("includes hot-table growth alerts when projected from projectAlerts options", () => {
    const projection = {
      kind: "broker.hot-table-growth.projection" as const,
      generatedAt: "2026-05-27T01:00:00.000Z",
      hasPrior: true,
      priorGeneratedAt: "2026-05-26T01:00:00.000Z",
      totalEstimatedMemoryBytes: 150_000_000,
      overallSeverity: "warning" as const,
      tables: [
        {
          table: "broker_tasks",
          currentCount: 1200,
          maxPayloadBytes: 110_000,
          estimatedMemoryBytes: 132_000_000,
          runtimeLimit: 2000,
          runtimeLoaded: 1200,
          runtimeSkipped: 0,
          priorCount: 800,
          growthDelta: 400,
          growthRate: 0.5,
          severity: "warning" as const,
          summary: "broker_tasks: 1200 rows, ~126.0 MB in-memory, +50.0% growth",
        },
      ],
      runtimeLoadLimits: { terminalTasks: 2000, auditEvents: 5000, terminalOutboxEvents: 1000 },
      warnings: ["WARNING: broker_tasks: 1200 rows, ~126.0 MB in-memory, +50.0% growth"],
      warningsTruncated: false,
    };
    const result = projectAlerts([], { hotTableGrowth: projection, nowMs: 1_000_000_000 });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "hot_table_growth");
    assert.equal(result.alerts[0]!.severity, "warning");
    assert.equal(result.countsByKind.hot_table_growth, 1);
  });

  it("includes hot-table growth alerts alongside task alerts when both are present", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "stale",
        stalenessMs: 300_000,
        currentStatusDurationMs: 300_000,
      }),
    ];
    const projection = {
      kind: "broker.hot-table-growth.projection" as const,
      generatedAt: "2026-05-27T01:00:00.000Z",
      hasPrior: true,
      priorGeneratedAt: "2026-05-26T01:00:00.000Z",
      totalEstimatedMemoryBytes: 150_000_000,
      overallSeverity: "warning" as const,
      tables: [
        {
          table: "broker_tasks",
          currentCount: 1200,
          maxPayloadBytes: 110_000,
          estimatedMemoryBytes: 132_000_000,
          runtimeLimit: 2000,
          runtimeLoaded: 1200,
          runtimeSkipped: 0,
          priorCount: 800,
          growthDelta: 400,
          growthRate: 0.5,
          severity: "warning" as const,
          summary: "broker_tasks: 1200 rows, ~126.0 MB in-memory, +50.0% growth",
        },
      ],
      runtimeLoadLimits: { terminalTasks: 2000, auditEvents: 5000, terminalOutboxEvents: 1000 },
      warnings: ["WARNING: broker_tasks: 1200 rows, ~126.0 MB in-memory, +50.0% growth"],
      warningsTruncated: false,
    };
    const result = projectAlerts(reports, {
      staleWarningMs: 120_000,
      staleCriticalMs: 600_000,
      hotTableGrowth: projection,
      nowMs: 1_000_000_000,
    });
    assert.ok(result.alerts.length >= 2);
    const kinds = result.alerts.map((a) => a.kind);
    assert.ok(kinds.includes("task_stale"));
    assert.ok(kinds.includes("hot_table_growth"));
    // Sorting: critical > warning > info — both are warning-level
    assert.equal(result.countsByKind.task_stale, 1);
    assert.equal(result.countsByKind.hot_table_growth, 1);
  });

  it("skips hot-table growth alerts when projection is null or undefined", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "stale",
        stalenessMs: 300_000,
        currentStatusDurationMs: 300_000,
      }),
    ];
    // null input
    const r1 = projectAlerts(reports, {
      staleWarningMs: 120_000,
      hotTableGrowth: null,
      nowMs: 1_000_000_000,
    });
    assert.ok(r1.alerts.every((a) => a.kind !== "hot_table_growth"));
    // undefined input (no option)
    const r2 = projectAlerts(reports, {
      staleWarningMs: 120_000,
      nowMs: 1_000_000_000,
    });
    assert.ok(r2.alerts.every((a) => a.kind !== "hot_table_growth"));
  });

  it("projects worker heartbeat_missed alerts from worker.lastSeenAt", () => {
    const result = projectAlerts([], {
      nowMs,
      workers: [
        makeWorker({
          nodeId: "worker-stale",
          lastSeenAt: new Date(nowMs - 180_000).toISOString(),
        }),
      ],
      workerHeartbeatMissedAfterMs: 120_000,
    });

    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "worker.heartbeat_missed");
    assert.equal(result.alerts[0]!.severity, "warning");
    assert.equal(result.alerts[0]!.subject.kind, "worker");
    assert.equal(result.alerts[0]!.subject.id, "worker-stale");
    assert.equal(result.alerts[0]!.workerId, "worker-stale");
    assert.equal(result.alerts[0]!.taskId, undefined);
    assert.equal(result.countsByKind["worker.heartbeat_missed"], 1);
  });
});
