import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectHotTableGrowth,
  computeAdaptiveLoadLimits,
  DEFAULT_SINGLE_TABLE_WARNING_ROWS,
  DEFAULT_SINGLE_TABLE_CRITICAL_ROWS,
  DEFAULT_AUDIT_RUNTIME_LIMIT_WARNING_RATIO,
  DEFAULT_HEAP_BUDGET_REDUCTION_FACTOR,
  DEFAULT_HEAP_BUDGET_MINIMUM_FRACTION,
} from "./hot-table-growth.js";
import type { BrokerHotTableLoadMetrics, BrokerHotTableRuntimeLoadLimits } from "./store.js";

const smallMetrics: BrokerHotTableLoadMetrics = {
  tables: {
    broker_tasks: {
      count: 50,
      maxPayloadBytes: 100_000,
      runtimeLoad: { limit: 2000, loadedCount: 50, skippedCount: 0, activeCount: 5, terminalCount: 45 },
    },
    broker_audit_events: {
      count: 200,
      maxPayloadBytes: 1_000,
      runtimeLoad: { limit: 5000, loadedCount: 200, skippedCount: 0 },
    },
    broker_terminal_outbox: {
      count: 30,
      maxPayloadBytes: 2_000,
      unackedCount: 5,
      runtimeLoad: { limit: 1000, loadedCount: 30, skippedCount: 0 },
    },
  },
};

// Helpers: build metrics at various scales
function scaleMetrics(factor: number): BrokerHotTableLoadMetrics {
  return {
    tables: {
      broker_tasks: {
        count: 50 * factor,
        maxPayloadBytes: 110_000,
        runtimeLoad: { limit: 2000, loadedCount: Math.min(50 * factor, 2000), skippedCount: Math.max(0, 50 * factor - 2000), activeCount: 5 * factor, terminalCount: 45 * factor },
      },
      broker_audit_events: {
        count: 200 * factor,
        maxPayloadBytes: 1_200,
        runtimeLoad: { limit: 5000, loadedCount: Math.min(200 * factor, 5000), skippedCount: Math.max(0, 200 * factor - 5000) },
      },
      broker_terminal_outbox: {
        count: 30 * factor,
        maxPayloadBytes: 2_100,
        unackedCount: 5 * factor,
        runtimeLoad: { limit: 1000, loadedCount: Math.min(30 * factor, 1000), skippedCount: Math.max(0, 30 * factor - 1000) },
      },
    },
  };
}

describe("projectHotTableGrowth", () => {
  it("produces a projection from current metrics", () => {
    const projection = projectHotTableGrowth({ current: smallMetrics });

    assert.equal(projection.kind, "broker.hot-table-growth.projection");
    assert.equal(typeof projection.generatedAt, "string");
    assert.equal(projection.hasPrior, false);
    assert.equal(projection.priorGeneratedAt, null);
    assert.ok(projection.totalEstimatedMemoryBytes > 0);
    assert.equal(projection.tables.length, 3);
    assert.deepEqual(projection.tables.map((t) => t.table), ["broker_tasks", "broker_audit_events", "broker_terminal_outbox"]);
  });

  it("reports ok severity for small hot tables", () => {
    const projection = projectHotTableGrowth({ current: smallMetrics });

    assert.equal(projection.overallSeverity, "ok");
    assert.ok(projection.tables.every((t) => t.severity === "ok"));
  });

  it("uses measured total payload bytes instead of count times max payload for outlier-heavy tables", () => {
    const outlierHeavy = structuredClone(smallMetrics);
    outlierHeavy.tables.broker_tasks = {
      count: 600,
      maxPayloadBytes: 900_000,
      totalPayloadBytes: 31_200_000,
      runtimeLoad: { limit: 2000, loadedCount: 600, skippedCount: 0, activeCount: 25, terminalCount: 575 },
    };

    const projection = projectHotTableGrowth({ current: outlierHeavy, prior: outlierHeavy });
    const tasks = projection.tables.find((t) => t.table === "broker_tasks")!;

    assert.equal(tasks.maxPayloadBytes, 900_000);
    assert.equal(tasks.totalPayloadBytes, 31_200_000);
    assert.equal(tasks.memoryEstimateBasis, "totalPayloadBytes");
    assert.equal(tasks.estimatedMemoryBytes, 31_200_000);
    assert.equal(tasks.severity, "ok");
    assert.equal(projection.overallSeverity, "ok");
  });

  it("reports ok when all tables are empty", () => {
    const empty: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: { count: 0, maxPayloadBytes: 0, runtimeLoad: { limit: 2000, loadedCount: 0, skippedCount: 0, activeCount: 0, terminalCount: 0 } },
        broker_audit_events: { count: 0, maxPayloadBytes: 0, runtimeLoad: { limit: 5000, loadedCount: 0, skippedCount: 0 } },
        broker_terminal_outbox: { count: 0, maxPayloadBytes: 0, unackedCount: 0, runtimeLoad: { limit: 1000, loadedCount: 0, skippedCount: 0 } },
      },
    };
    const projection = projectHotTableGrowth({ current: empty });

    assert.equal(projection.overallSeverity, "ok");
    assert.equal(projection.totalEstimatedMemoryBytes, 0);
  });

  it("warns when a single table exceeds the warning row threshold", () => {
    const manyTasks = structuredClone(smallMetrics);
    manyTasks.tables.broker_tasks.count = DEFAULT_SINGLE_TABLE_WARNING_ROWS + 1;
    manyTasks.tables.broker_tasks.runtimeLoad = {
      limit: 2000, loadedCount: DEFAULT_SINGLE_TABLE_WARNING_ROWS + 1, skippedCount: 0,
      activeCount: 5, terminalCount: DEFAULT_SINGLE_TABLE_WARNING_ROWS - 4,
    };

    const projection = projectHotTableGrowth({ current: manyTasks });

    assert.equal(projection.overallSeverity, "warning");
    assert.ok(projection.tables.find((t) => t.table === "broker_tasks")!.severity === "warning");
  });

  it("does not warn solely because protected audit rows exceed the generic row threshold", () => {
    const auditResidue = structuredClone(smallMetrics);
    const auditLimit = 5000;
    auditResidue.tables.broker_audit_events.count = 2500;
    auditResidue.tables.broker_audit_events.maxPayloadBytes = 2500;
    auditResidue.tables.broker_audit_events.runtimeLoad = {
      limit: auditLimit,
      loadedCount: 2500,
      skippedCount: 0,
    };

    const projection = projectHotTableGrowth({
      current: auditResidue,
      prior: auditResidue,
      runtimeLoadLimits: {
        terminalTasks: 2000,
        auditEvents: auditLimit,
        terminalOutboxEvents: 1000,
      },
    });

    const auditTable = projection.tables.find((t) => t.table === "broker_audit_events")!;
    assert.equal(auditTable.severity, "ok");
    assert.equal(projection.overallSeverity, "ok");
    assert.equal(projection.warnings.length, 0);
  });

  it("warns when audit rows approach the runtime cap", () => {
    const auditResidue = structuredClone(smallMetrics);
    const auditLimit = 5000;
    const warningCount = Math.ceil(auditLimit * DEFAULT_AUDIT_RUNTIME_LIMIT_WARNING_RATIO);
    auditResidue.tables.broker_audit_events.count = warningCount;
    auditResidue.tables.broker_audit_events.maxPayloadBytes = 2500;
    auditResidue.tables.broker_audit_events.runtimeLoad = {
      limit: auditLimit,
      loadedCount: warningCount,
      skippedCount: 0,
    };

    const projection = projectHotTableGrowth({ current: auditResidue });

    const auditTable = projection.tables.find((t) => t.table === "broker_audit_events")!;
    assert.equal(auditTable.severity, "warning");
    assert.equal(auditTable.operatorAction, "observe");
    assert.match(auditTable.operatorActionReason ?? "", /no skipped rows/);
    assert.equal(projection.overallSeverity, "warning");
  });

  it("classifies total memory warning without readiness pressure as observe", () => {
    const steady = structuredClone(smallMetrics);
    steady.tables.broker_tasks.count = 662;
    steady.tables.broker_tasks.maxPayloadBytes = 131_000;
    steady.tables.broker_tasks.runtimeLoad = {
      limit: 2000,
      loadedCount: 662,
      skippedCount: 0,
      activeCount: 20,
      terminalCount: 642,
    };
    steady.tables.broker_tombstones = {
      count: 295,
      maxPayloadBytes: 128_000,
      runtimeLoad: { limit: 1000, loadedCount: 295, skippedCount: 0 },
    };
    steady.tables.broker_audit_events.count = 4923;
    steady.tables.broker_audit_events.maxPayloadBytes = 3000;
    steady.tables.broker_audit_events.runtimeLoad = {
      limit: 5000,
      loadedCount: 4923,
      skippedCount: 0,
    };

    const projection = projectHotTableGrowth({
      current: steady,
      prior: steady,
      processMemory: {
        rssBytes: 220_000_000,
        heapTotalBytes: 120_000_000,
        heapUsedBytes: 80_000_000,
        heapLimitBytes: 4_000_000_000,
      },
    });

    assert.equal(projection.overallSeverity, "warning");
    assert.equal(projection.operatorAction, "observe");
    assert.match(projection.operatorActionReason ?? "", /monitor trend/);
    assert.equal(projection.readinessDegradation?.overallRisky, false);
    assert.equal(projection.readinessDegradation?.overallWarning, false);
    assert.ok(projection.warnings.some((w) => /no prune action needed/.test(w)));
  });

  it("criticals when a single table exceeds the critical row threshold", () => {
    const manyTasks = structuredClone(smallMetrics);
    manyTasks.tables.broker_tasks.count = DEFAULT_SINGLE_TABLE_CRITICAL_ROWS + 1;
    manyTasks.tables.broker_tasks.runtimeLoad = {
      limit: 2000, loadedCount: 2000, skippedCount: DEFAULT_SINGLE_TABLE_CRITICAL_ROWS - 1999,
      activeCount: 5, terminalCount: DEFAULT_SINGLE_TABLE_CRITICAL_ROWS - 4,
    };

    const projection = projectHotTableGrowth({ current: manyTasks });

    assert.equal(projection.overallSeverity, "critical");
    const tasksTable = projection.tables.find((t) => t.table === "broker_tasks")!;
    assert.equal(tasksTable.severity, "critical");
    assert.ok(tasksTable.runtimeSkipped > 0);
  });

  it("does not treat steady-state audit at cap as critical", () => {
    // broker_audit_events at 5000/5000 with skipped=0, growth=0, moderate memory
    // → should be warning, not critical
    const steadyAudit = structuredClone(smallMetrics);
    steadyAudit.tables.broker_audit_events.count = 5000;
    steadyAudit.tables.broker_audit_events.maxPayloadBytes = 2500;
    steadyAudit.tables.broker_audit_events.runtimeLoad = {
      limit: 5000,
      loadedCount: 5000,
      skippedCount: 0,
    };

    // Provide a prior snapshot with same count → zero growth
    const prior = structuredClone(steadyAudit);
    const projection = projectHotTableGrowth({ current: steadyAudit, prior });

    const auditTable = projection.tables.find((t) => t.table === "broker_audit_events")!;
    assert.notEqual(auditTable.severity, "critical", "steady-state audit at cap should not be critical");
    assert.equal(auditTable.severity, "warning", "steady-state audit at cap should warn");
    assert.notEqual(projection.overallSeverity, "critical", "overall should not be critical from audit alone");
  });

  it("includes at-runtime-cap in summary when audit is at limit without skipped rows", () => {
    // broker_audit_events exactly at 5000/5000 cap, skippedCount=0, zero growth,
    // moderate memory. This is the "at runtime load cap, no prune candidates"
    // scenario — the summary should clearly label it as runtime cap pressure.
    const steadyAudit = structuredClone(smallMetrics);
    steadyAudit.tables.broker_audit_events.count = 5000;
    steadyAudit.tables.broker_audit_events.maxPayloadBytes = 2500;
    steadyAudit.tables.broker_audit_events.runtimeLoad = {
      limit: 5000,
      loadedCount: 5000,
      skippedCount: 0,
    };

    const prior = structuredClone(steadyAudit);
    const projection = projectHotTableGrowth({ current: steadyAudit, prior });

    const auditTable = projection.tables.find((t) => t.table === "broker_audit_events")!;
    // Summary should contain "at runtime cap" text
    assert.match(auditTable.summary, /at runtime cap/, "summary should flag runtime cap operation");
    // Summary should not mention skipped/cleanup to avoid suggesting prune is needed
    assert.doesNotMatch(auditTable.summary, /skip/, "no skipped rows, summary should not mention skip");
  });

  it("adds safe-operator-guidance warning for audit at steady-state cap", () => {
    // broker_audit_events exactly at 5000/5000 cap, skipped=0, no other pressure.
    // The buildWarnings should include a context note explaining this is
    // steady-state ring-buffer operation, not a cleanup emergency.
    const steadyAudit = structuredClone(smallMetrics);
    steadyAudit.tables.broker_audit_events.count = 5000;
    steadyAudit.tables.broker_audit_events.maxPayloadBytes = 2500;
    steadyAudit.tables.broker_audit_events.runtimeLoad = {
      limit: 5000,
      loadedCount: 5000,
      skippedCount: 0,
    };

    const prior = structuredClone(steadyAudit);
    const projection = projectHotTableGrowth({ current: steadyAudit, prior });

    // Should have a warning about steady-state ring-buffer operation
    const steadyStateWarning = projection.warnings.find(
      (w) => w.includes("steady-state ring-buffer") || w.includes("no prune action needed"),
    );
    assert.ok(
      steadyStateWarning,
      `expected a steady-state warning in projection warnings: ${JSON.stringify(projection.warnings)}`,
    );
    // Should mention how to adjust if needed
    assert.match(
      steadyStateWarning!,
      /BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS/,
      "steady-state warning should mention how to adjust the cap",
    );
    // Should NOT imply prune/cleanup is the next action
    assert.doesNotMatch(
      steadyStateWarning!,
      /prune candidates|cleanup needed|requires cleanup/,
      "steady-state warning should not imply cleanup is needed",
    );
  });

  it("criticals audit at cap when count materially exceeds runtime cap", () => {
    // broker_audit_events at 6500/5000 (30% over cap → exceeds 20% overshoot)
    const overshootAudit = structuredClone(smallMetrics);
    overshootAudit.tables.broker_audit_events.count = 6500;
    overshootAudit.tables.broker_audit_events.maxPayloadBytes = 2500;
    overshootAudit.tables.broker_audit_events.runtimeLoad = {
      limit: 5000,
      loadedCount: 5000,
      skippedCount: 1500,
    };

    const projection = projectHotTableGrowth({ current: overshootAudit });

    const auditTable = projection.tables.find((t) => t.table === "broker_audit_events")!;
    assert.equal(auditTable.severity, "critical", "audit exceeding cap by 20%+ should be critical");
  });

  it("criticals audit at cap with high growth rate", () => {
    // broker_audit_events at 5000/5000 with 50%+ growth
    const current = structuredClone(smallMetrics);
    current.tables.broker_audit_events.count = 5000;
    current.tables.broker_audit_events.maxPayloadBytes = 2500;
    current.tables.broker_audit_events.runtimeLoad = {
      limit: 5000,
      loadedCount: 5000,
      skippedCount: 0,
    };

    const prior = structuredClone(current);
    prior.tables.broker_audit_events.count = 3000;
    prior.tables.broker_audit_events.runtimeLoad = {
      limit: 5000,
      loadedCount: 3000,
      skippedCount: 0,
    };

    const projection = projectHotTableGrowth({ current, prior });

    const auditTable = projection.tables.find((t) => t.table === "broker_audit_events")!;
    // 5000 from 3000 = 67% growth > 50% threshold
    assert.equal(auditTable.severity, "critical", "audit at cap with high growth should be critical");
  });

  it("criticals audit at cap with memory pressure", () => {
    // broker_audit_events at 5000/5000 with huge payload → memory exceeds critical
    const memPressure = structuredClone(smallMetrics);
    memPressure.tables.broker_audit_events.count = 5000;
    memPressure.tables.broker_audit_events.maxPayloadBytes = 200_000; // 5000 * 200KB = 1 GB
    memPressure.tables.broker_audit_events.runtimeLoad = {
      limit: 5000,
      loadedCount: 5000,
      skippedCount: 0,
    };

    const projection = projectHotTableGrowth({ current: memPressure });

    const auditTable = projection.tables.find((t) => t.table === "broker_audit_events")!;
    assert.equal(auditTable.severity, "critical", "audit at cap with memory pressure should be critical");
  });

  it("criticals audit at cap with critical skipped ratio", () => {
    // broker_audit_events at 5000/5000 with high skipped ratio
    const skippedPressure = structuredClone(smallMetrics);
    skippedPressure.tables.broker_audit_events.count = 5000;
    skippedPressure.tables.broker_audit_events.maxPayloadBytes = 2500;
    skippedPressure.tables.broker_audit_events.runtimeLoad = {
      limit: 5000,
      loadedCount: 1000,
      skippedCount: 4000, // 80% skipped → exceeds 70% critical
    };

    const projection = projectHotTableGrowth({ current: skippedPressure });

    const auditTable = projection.tables.find((t) => t.table === "broker_audit_events")!;
    assert.equal(auditTable.severity, "critical", "audit at cap with critical skipped ratio should be critical");
  });

  it("warns when aggregate row count exceeds total warning threshold", () => {
    const big = scaleMetrics(60); // total ~16,800 rows
    const projection = projectHotTableGrowth({ current: big });

    assert.equal(projection.overallSeverity, "critical");
    assert.ok(projection.warnings.length > 0);
  });

  it("computes growth rate with a prior snapshot", () => {
    const prior = scaleMetrics(1);
    const current = scaleMetrics(2); // double

    const projection = projectHotTableGrowth({ current, prior });

    assert.equal(projection.hasPrior, true);
    const tasksTable = projection.tables.find((t) => t.table === "broker_tasks")!;
    assert.equal(tasksTable.priorCount, 50);
    assert.equal(tasksTable.currentCount, 100);
    assert.equal(tasksTable.growthDelta, 50);
    assert.ok(tasksTable.growthRate !== null && tasksTable.growthRate > 0.9);
  });

  it("reports negative growth as zero rate", () => {
    const prior = scaleMetrics(2);
    const current = scaleMetrics(1); // halved

    const projection = projectHotTableGrowth({ current, prior });

    const tasksTable = projection.tables.find((t) => t.table === "broker_tasks")!;
    assert.equal(tasksTable.growthDelta, -50);
    assert.ok(tasksTable.growthRate !== null && tasksTable.growthRate < 0);
  });

  it("flags runtime-skipped rows as a warning when ratio is high", () => {
    const metrics = scaleMetrics(70); // tasks will be 3500, cap at 2000 → 1500 skipped

    const projection = projectHotTableGrowth({ current: metrics });

    const tasksTable = projection.tables.find((t) => t.table === "broker_tasks")!;
    assert.ok(tasksTable.runtimeSkipped > 0);
    const skippedRatio = tasksTable.runtimeSkipped / (tasksTable.runtimeLoaded + tasksTable.runtimeSkipped);
    assert.ok(skippedRatio >= 0.3);
    // Should be critical because skipped > 70%
  });

  it("warns about memory pressure when estimated footprint is large", () => {
    const heavy: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 600,
          maxPayloadBytes: 120_000,
          runtimeLoad: { limit: 2000, loadedCount: 600, skippedCount: 0, activeCount: 5, terminalCount: 595 },
        },
        broker_audit_events: {
          count: 1500,
          maxPayloadBytes: 2000,
          runtimeLoad: { limit: 5000, loadedCount: 1500, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 400,
          maxPayloadBytes: 3000,
          unackedCount: 200,
          runtimeLoad: { limit: 1000, loadedCount: 400, skippedCount: 0 },
        },
      },
    };
    // ~600 * 120KB = 72 MB + ~3 MB + ~1.2 MB = ~76 MB

    const projection = projectHotTableGrowth({ current: heavy });

    assert.ok(projection.totalEstimatedMemoryBytes > 70_000_000);
    // 76 MB is below 100 MB warning, so should be ok unless other conditions trigger
  });

  it("includes prior snapshot timestamp when provided", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      prior: smallMetrics,
      priorGeneratedAt: "2026-05-12T00:00:00.000Z",
    });

    assert.equal(projection.hasPrior, true);
    assert.equal(projection.priorGeneratedAt, "2026-05-12T00:00:00.000Z");
  });

  it("respects custom thresholds", () => {
    const custom = projectHotTableGrowth({
      current: smallMetrics,
      thresholds: {
        singleTableWarningRows: 10,
      },
    });

    assert.equal(custom.overallSeverity, "warning");
    assert.ok(
      custom.tables
        .filter((t) => t.currentCount > 0)
        .every((t) => t.severity === "warning"),
    );
  });

  it("produces empty warnings list when everything is ok", () => {
    const projection = projectHotTableGrowth({ current: smallMetrics });

    // Only the "no prior" note
    assert.equal(projection.warnings.length, 1);
    assert.match(projection.warnings[0], /No prior snapshot/);
  });

  it("exposes runtime load limits in the projection", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      runtimeLoadLimits: {
        terminalTasks: 1000,
        auditEvents: 2000,
        terminalOutboxEvents: 500,
      },
    });

    assert.equal(projection.runtimeLoadLimits.terminalTasks, 1000);
    assert.equal(projection.runtimeLoadLimits.auditEvents, 2000);
    assert.equal(projection.runtimeLoadLimits.terminalOutboxEvents, 500);
  });

  it("uses provided generatedAt timestamp", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      generatedAt: "2026-05-13T06:00:00.000Z",
    });

    assert.equal(projection.generatedAt, "2026-05-13T06:00:00.000Z");
  });

  it("deterministic: same input → same output", () => {
    const a = projectHotTableGrowth({ current: smallMetrics, generatedAt: "2026-05-13T00:00:00.000Z" });
    const b = projectHotTableGrowth({ current: smallMetrics, generatedAt: "2026-05-13T00:00:00.000Z" });

    assert.deepEqual(a.overallSeverity, b.overallSeverity);
    assert.deepEqual(a.warnings, b.warnings);
    assert.deepEqual(a.totalEstimatedMemoryBytes, b.totalEstimatedMemoryBytes);
    assert.deepEqual(
      a.tables.map((t) => t.severity),
      b.tables.map((t) => t.severity),
    );
  });

  it("warns when projected memory exceeds the memory warning threshold", () => {
    const memHeavy: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 1000,
          maxPayloadBytes: 110_000,
          runtimeLoad: { limit: 2000, loadedCount: 1000, skippedCount: 0, activeCount: 5, terminalCount: 995 },
        },
        broker_audit_events: {
          count: 2000,
          maxPayloadBytes: 2000,
          runtimeLoad: { limit: 5000, loadedCount: 2000, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 500,
          maxPayloadBytes: 3000,
          unackedCount: 100,
          runtimeLoad: { limit: 1000, loadedCount: 500, skippedCount: 0 },
        },
      },
    };
    // ~110 MB + ~4 MB + ~1.5 MB = ~116 MB, above 100 MB warning

    const projection = projectHotTableGrowth({ current: memHeavy });

    assert.equal(projection.overallSeverity, "warning");
    assert.ok(projection.warnings.some((w) => w.includes("exceeds warning threshold")));
  });

  it("warningsTruncated is false when warnings fit within default limit", () => {
    // 5 warnings (3 tables + memory + no-prior) are well under DEFAULT_MAX_WARNINGS (10)
    const manyWarnings = structuredClone(smallMetrics);
    manyWarnings.tables.broker_tasks.count = 1500;
    manyWarnings.tables.broker_tasks.runtimeLoad = {
      limit: 2000, loadedCount: 1500, skippedCount: 0, activeCount: 5, terminalCount: 1495,
    };
    manyWarnings.tables.broker_audit_events.count = 6000;
    manyWarnings.tables.broker_audit_events.runtimeLoad = {
      limit: 5000, loadedCount: 5000, skippedCount: 1000,
    };
    manyWarnings.tables.broker_terminal_outbox.count = 50;
    manyWarnings.tables.broker_terminal_outbox.runtimeLoad = {
      limit: 1000, loadedCount: 50, skippedCount: 0,
    };

    const projection = projectHotTableGrowth({ current: manyWarnings });

    assert.ok(projection.warnings.length > 0);
    assert.equal(projection.warningsTruncated, false);
  });

  it("sets warningsTruncated when maxWarnings is low", () => {
    // 4 table warnings + memory warning + no-prior = 6 total; maxWarnings=2 → truncated
    const many: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 1500,
          maxPayloadBytes: 100_000,
          runtimeLoad: { limit: 2000, loadedCount: 1500, skippedCount: 0, activeCount: 5, terminalCount: 1495 },
        },
        broker_audit_events: {
          count: 2000,
          maxPayloadBytes: 2000,
          runtimeLoad: { limit: 5000, loadedCount: 2000, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 30,
          maxPayloadBytes: 2000,
          unackedCount: 5,
          runtimeLoad: { limit: 1000, loadedCount: 30, skippedCount: 0 },
        },
        broker_exchanges: {
          count: 1200,
          maxPayloadBytes: 3000,
          runtimeLoad: { limit: 1000, loadedCount: 1000, skippedCount: 200 },
        },
        broker_proposals: {
          count: 1100,
          maxPayloadBytes: 2500,
          runtimeLoad: { limit: 1000, loadedCount: 1000, skippedCount: 100 },
        },
      },
    };

    const projection = projectHotTableGrowth({ current: many, maxWarnings: 2 });

    assert.equal(projection.warnings.length, 2);
    assert.equal(projection.warningsTruncated, true);
  });

  it("warningsTruncated is false when maxWarnings equals total warning count", () => {
    const many: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 1500,
          maxPayloadBytes: 100_000,
          runtimeLoad: { limit: 2000, loadedCount: 1500, skippedCount: 0, activeCount: 5, terminalCount: 1495 },
        },
        broker_audit_events: {
          count: 2000,
          maxPayloadBytes: 2000,
          runtimeLoad: { limit: 5000, loadedCount: 2000, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 30,
          maxPayloadBytes: 2000,
          unackedCount: 5,
          runtimeLoad: { limit: 1000, loadedCount: 30, skippedCount: 0 },
        },
        broker_exchanges: {
          count: 1200,
          maxPayloadBytes: 3000,
          runtimeLoad: { limit: 1000, loadedCount: 1000, skippedCount: 200 },
        },
      },
    };
    // 3 table warnings + no-prior note = 4 total; audit rows remain below the
    // runtime-cap warning threshold, so they are not noisy by count alone.
    const projection = projectHotTableGrowth({ current: many, maxWarnings: 4 });

    assert.equal(projection.warnings.length, 4);
    assert.equal(projection.warningsTruncated, false);
  });

  it("warningsTruncated is false when there are zero warnings", () => {
    const empty: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: { count: 0, maxPayloadBytes: 0, runtimeLoad: { limit: 2000, loadedCount: 0, skippedCount: 0, activeCount: 0, terminalCount: 0 } },
        broker_audit_events: { count: 0, maxPayloadBytes: 0, runtimeLoad: { limit: 5000, loadedCount: 0, skippedCount: 0 } },
        broker_terminal_outbox: { count: 0, maxPayloadBytes: 0, unackedCount: 0, runtimeLoad: { limit: 1000, loadedCount: 0, skippedCount: 0 } },
      },
    };
    // Provide prior so we skip the "no prior" note
    const projection = projectHotTableGrowth({ current: empty, prior: empty, priorGeneratedAt: "2026-05-12T00:00:00.000Z" });

    assert.equal(projection.warnings.length, 0);
    assert.equal(projection.warningsTruncated, false);
  });

  it("includes processMemory and readinessDegradation when processMemory is supplied", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 500_000_000,
        heapTotalBytes: 400_000_000,
        heapUsedBytes: 350_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    assert.ok(projection.processMemory, "processMemory should be present");
    assert.equal(projection.processMemory!.heapUsedRatio, 0.684); // 350/512
    assert.ok(projection.readinessDegradation, "readinessDegradation should be present");
    // 68% heap < 80% threshold, so no heap pressure
    assert.equal(projection.readinessDegradation!.heapPressure, false);
  });

  it("sets heapPressure when heap usage exceeds 80%", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 800_000_000,
        heapTotalBytes: 750_000_000,
        heapUsedBytes: 450_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    // 450/512 ≈ 0.879 → > 0.8, so heapPressure = true
    assert.equal(projection.readinessDegradation!.heapPressure, true);
    assert.equal(projection.readinessDegradation!.overallRisky, true);
  });

  it("includes snapshotMetrics when snapshotMetrics is supplied", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      snapshotMetrics: {
        lastSnapshotBytes: 2_500_000,
        lastPersistDurationMs: 320,
        lastSnapshotAt: "2026-05-14T12:00:00.000Z",
      },
    });

    assert.ok(projection.snapshotMetrics);
    assert.equal(projection.snapshotMetrics!.lastSnapshotBytes, 2_500_000);
    assert.equal(projection.snapshotMetrics!.lastPersistDurationMs, 320);
    assert.equal(projection.snapshotMetrics!.lastSnapshotAt, "2026-05-14T12:00:00.000Z");
  });

  it("sets memoryPressure when hot-table memory exceeds 50% of heap limit", () => {
    const heavy: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 8000,
          maxPayloadBytes: 50_000,
          runtimeLoad: { limit: 2000, loadedCount: 2000, skippedCount: 6000, activeCount: 5, terminalCount: 7995 },
        },
        broker_audit_events: {
          count: 500,
          maxPayloadBytes: 1000,
          runtimeLoad: { limit: 5000, loadedCount: 500, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 30,
          maxPayloadBytes: 2000,
          unackedCount: 5,
          runtimeLoad: { limit: 1000, loadedCount: 30, skippedCount: 0 },
        },
      },
    };
    // ~400 MB estimated memory, heap limit = 512 MB → 400/512 ≈ 0.78 > 0.5 → memoryPressure = true
    const projection = projectHotTableGrowth({
      current: heavy,
      processMemory: {
        rssBytes: 600_000_000,
        heapTotalBytes: 500_000_000,
        heapUsedBytes: 400_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    assert.equal(projection.readinessDegradation!.memoryPressure, true);
    assert.equal(projection.readinessDegradation!.overallRisky, true);
  });

  it("sets hydrationPressure when a critical table has skipped runtime rows", () => {
    const metrics: BrokerHotTableLoadMetrics = scaleMetrics(105);
    // broker_tasks: 5250 rows, terminal cap 2000 → 3250 skipped, severity "critical" (>= 5000)
    const projection = projectHotTableGrowth({
      current: metrics,
      processMemory: {
        rssBytes: 300_000_000,
        heapTotalBytes: 250_000_000,
        heapUsedBytes: 200_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    const tasksTable = projection.tables.find((t) => t.table === "broker_tasks")!;
    assert.equal(tasksTable.severity, "critical");
    assert.ok(tasksTable.runtimeSkipped > 0);
    assert.equal(projection.readinessDegradation!.hydrationPressure, true);
    assert.equal(projection.readinessDegradation!.overallRisky, true);
  });

  it("sets overallWarning when heap is above 60% but below 80%", () => {
    // heapUsed: 350 MB, heapLimit: 512 MB → 68% > 60% (warning) but < 80% (not critical)
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 500_000_000,
        heapTotalBytes: 400_000_000,
        heapUsedBytes: 350_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    assert.equal(projection.readinessDegradation!.heapPressure, false);
    assert.equal(projection.readinessDegradation!.overallRisky, false);
    assert.equal(projection.readinessDegradation!.overallWarning, true);
  });

  it("sets overallWarning when hot-table memory exceeds 35% but not 50% of heap", () => {
    // estimated memory = ~51 MB, heap limit = 128 MB → 51/128 ≈ 0.40 > 0.35 (warning) but < 0.5 (not critical)
    const moderate: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 400,
          maxPayloadBytes: 120_000,
          runtimeLoad: { limit: 2000, loadedCount: 400, skippedCount: 0, activeCount: 5, terminalCount: 395 },
        },
        broker_audit_events: {
          count: 1000,
          maxPayloadBytes: 2000,
          runtimeLoad: { limit: 5000, loadedCount: 1000, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 50,
          maxPayloadBytes: 3000,
          unackedCount: 10,
          runtimeLoad: { limit: 1000, loadedCount: 50, skippedCount: 0 },
        },
      },
    };
    // ~48 MB + 2 MB + 0.15 MB ≈ 50.15 MB
    const projection = projectHotTableGrowth({
      current: moderate,
      processMemory: {
        rssBytes: 200_000_000,
        heapTotalBytes: 150_000_000,
        heapUsedBytes: 100_000_000,
        heapLimitBytes: 128_000_000,
      },
    });

    const rd = projection.readinessDegradation!;
    assert.equal(rd.memoryPressure, false);
    assert.equal(rd.overallRisky, false);
    assert.equal(rd.overallWarning, true);
  });

  it("sets overallWarning when a warning-level table has skipped rows", () => {
    // broker_tasks: 1200 rows × 10 KB = 12 MB → warning-level bytes (> 10 MB)
    // runtimeLoad: limit=1000, skippedCount=200 → skipped > 0
    const withWarningSkipped: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 1200,
          maxPayloadBytes: 10_000,
          runtimeLoad: { limit: 1000, loadedCount: 1000, skippedCount: 200, activeCount: 5, terminalCount: 1195 },
        },
        broker_audit_events: {
          count: 500,
          maxPayloadBytes: 1000,
          runtimeLoad: { limit: 5000, loadedCount: 500, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 30,
          maxPayloadBytes: 2000,
          unackedCount: 5,
          runtimeLoad: { limit: 1000, loadedCount: 30, skippedCount: 0 },
        },
      },
    };

    const projection = projectHotTableGrowth({
      current: withWarningSkipped,
      processMemory: {
        rssBytes: 300_000_000,
        heapTotalBytes: 250_000_000,
        heapUsedBytes: 200_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    // heap 200/512 ≈ 39% < 60% → no heap warning
    // memory ~12 MB + 0.5 MB + 0.06 MB ≈ 12.6 MB / 512 MB ≈ 2.5% < 35% → no memory warning
    // but broker_tasks: severity="warning" (12 MB > 10 MB threshold), skippedCount=200 → hydrationWarning=true
    const rd = projection.readinessDegradation!;
    assert.equal(rd.heapPressure, false);
    assert.equal(rd.memoryPressure, false);
    assert.equal(rd.overallRisky, false);
    assert.equal(rd.overallWarning, true);
  });

  it("overallWarning is false when no signals are elevated", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 200_000_000,
        heapTotalBytes: 150_000_000,
        heapUsedBytes: 100_000_000,
        heapLimitBytes: 512_000_000,
      },
    });
    // heap 100/512 ≈ 20% < 60%
    // memory ~53 MB / 512 MB ≈ 10% < 35%
    // no skipped rows → no hydration warning

    assert.equal(projection.readinessDegradation!.overallWarning, false);
  });
});

describe("computeAdaptiveLoadLimits", () => {
  const defaultLimits: BrokerHotTableRuntimeLoadLimits = {
    terminalTasks: 2000,
    auditEvents: 5000,
    terminalOutboxEvents: 1000,
  };

  const processMemory = { heapUsedBytes: 350_000_000, heapLimitBytes: 4_000_000_000 };

  it("returns original limits unchanged when heap pressure is low and memory pressure is low", () => {
    const result = computeAdaptiveLoadLimits(
      processMemory,
      2_000_000, // total estimated hot-table memory is 2 MB vs 4 GB heap → 0.05% → no memory pressure
      defaultLimits,
    );

    assert.equal(result.guardTriggered, false);
    assert.equal(result.guardReason, null);
    assert.equal(result.adaptiveTerminalTaskLimit, 2000);
    assert.equal(result.adaptiveAuditEventLimit, 5000);
    assert.equal(result.adaptiveOutboxLimit, 1000);
    assert.equal(result.reductionFactor, DEFAULT_HEAP_BUDGET_REDUCTION_FACTOR);
  });

  it("reduces limits when heap pressure exceeds 80% threshold", () => {
    // 3.6 GB used / 4 GB limit = 90% → heap pressure
    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 3_600_000_000, heapLimitBytes: 4_000_000_000 },
      500_000, // small memory, only heap pressure
      defaultLimits,
    );

    assert.equal(result.guardTriggered, true);
    assert.ok(result.guardReason!.includes("heap at 90%"));
    // reduction factor 2: 2000/2=1000, 5000/2=2500, 1000/2=500
    assert.equal(result.adaptiveTerminalTaskLimit, 1000);
    assert.equal(result.adaptiveAuditEventLimit, 2500);
    assert.equal(result.adaptiveOutboxLimit, 500);
  });

  it("reduces limits when hot-table memory exceeds 50% of heap limit", () => {
    // 0 MB heap used / 4 GB limit = 0% → no heap pressure.
    // 3 GB hot-table memory / 4 GB heap limit = 75% > 50% → memory pressure
    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 1_000, heapLimitBytes: 4_000_000_000 },
      3_000_000_000,
      defaultLimits,
    );

    assert.equal(result.guardTriggered, true);
    assert.ok(result.guardReason!.includes("75%"));
    assert.equal(result.adaptiveTerminalTaskLimit, 1000);
    assert.equal(result.adaptiveAuditEventLimit, 2500);
    assert.equal(result.adaptiveOutboxLimit, 500);
  });

  it("applies minimum fraction floor and never returns zero", () => {
    // Extreme heap pressure: 99% heap used
    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 3_960_000_000, heapLimitBytes: 4_000_000_000 },
      1_000,
      defaultLimits,
    );

    // reduction factor 2: 2000/2=1000, minimum fraction 0.25: 2000*0.25=500 → floor is max(1000, 500) = 1000
    // Still 1000 because the floor of 500 is below the factor'd 1000
    assert.equal(result.adaptiveTerminalTaskLimit, 1000);
    assert.equal(result.adaptiveAuditEventLimit, 2500);
    assert.equal(result.adaptiveOutboxLimit, 500);
  });

  it("minimum fraction floor prevents starvation for very small limits", () => {
    const smallLimits: BrokerHotTableRuntimeLoadLimits = {
      terminalTasks: 1,
      auditEvents: 2,
      terminalOutboxEvents: 3,
    };

    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 3_600_000_000, heapLimitBytes: 4_000_000_000 },
      0,
      smallLimits,
    );

    // reduction factor 2: 1/2=0, floor = max(0, max(1, 1*0.25)) = max(0,1) = 1
    // 2/2=1, floor = max(1, max(1, 2*0.25)) = max(1,1) = 1
    // 3/2=1, floor = max(1, max(1, 3*0.25)) = max(1,1) = 1
    assert.equal(result.adaptiveTerminalTaskLimit, 1);
    assert.equal(result.adaptiveAuditEventLimit, 1);
    assert.equal(result.adaptiveOutboxLimit, 1);
  });

  it("accepts custom reduction factor and minimum fraction", () => {
    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 3_600_000_000, heapLimitBytes: 4_000_000_000 },
      0,
      defaultLimits,
      { reductionFactor: 4, minimumFraction: 0.1 },
    );

    // reduction factor 4: 2000/4=500, 5000/4=1250, 1000/4=250
    // floor = max(1, 2000*0.1) = 200, etc.
    // floor is always below the factor'd values, so factor wins
    assert.equal(result.adaptiveTerminalTaskLimit, 500);
    assert.equal(result.adaptiveAuditEventLimit, 1250);
    assert.equal(result.adaptiveOutboxLimit, 250);
    assert.equal(result.reductionFactor, 4);
  });

  it("does not reduce when heapLimit is zero (edge case)", () => {
    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 3_600_000_000, heapLimitBytes: 0 },
      3_000_000_000,
      defaultLimits,
    );

    // heapLimit = 0, so both ratios are 0 or NaN → no pressure
    assert.equal(result.guardTriggered, false);
    assert.equal(result.adaptiveTerminalTaskLimit, 2000);
  });

  it("includes adaptiveLoadLimits in readinessDegradation when guard triggers", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 4_000_000_000,
        heapTotalBytes: 3_900_000_000,
        heapUsedBytes: 3_600_000_000,
        heapLimitBytes: 4_000_000_000,
      },
      runtimeLoadLimits: defaultLimits,
    });

    assert.ok(projection.readinessDegradation);
    assert.equal(projection.readinessDegradation!.heapPressure, true);
    assert.ok(projection.readinessDegradation!.adaptiveLoadLimits);
    assert.equal(projection.readinessDegradation!.adaptiveLoadLimits!.guardTriggered, true);
    assert.equal(projection.readinessDegradation!.adaptiveLoadLimits!.adaptiveTerminalTaskLimit, 1000);
  });

  it("omits adaptiveLoadLimits from readinessDegradation when guard is not triggered", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 200_000_000,
        heapTotalBytes: 180_000_000,
        heapUsedBytes: 100_000_000,
        heapLimitBytes: 4_000_000_000,
      },
      runtimeLoadLimits: defaultLimits,
    });

    assert.ok(projection.readinessDegradation);
    assert.equal(projection.readinessDegradation!.heapPressure, false);
    assert.equal(projection.readinessDegradation!.adaptiveLoadLimits, undefined);
  });
});
