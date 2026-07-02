import { describe, it } from "node:test";

import { expect } from "../test-helpers/expect.js";

import {
  diagnoseTask,
  detectStuckTasks,
  getStuckPhase,
  getStaleThresholdMs,
  getPhaseRetryCap,
  computeTaskPhaseAge,
  buildOperatorBlockers,
  computeReportSeverity,
  normalizeErrorSignature,
  hasRepeatedErrorSignature,
  DEFAULT_STALE_PHASE_THRESHOLDS,
  DEFAULT_PHASE_RETRY_CAPS,
  DEFAULT_REPEATED_ERROR_THRESHOLD,
  DEFAULT_SCHEDULER_CONTROL_TOWER_CONFIG,
  type StuckTaskDiagnosis,
  type StuckPhase,
  type SchedulerControlTowerConfig,
  type OperatorBlocker,
} from "./task-stuck-detection.js";

import type { TaskError, TaskRecord, TaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskRecord> & { id: string; status: TaskStatus }): TaskRecord {
  const now = Date.now();
  return {
    intent: "chat",
    requester: { id: "user-1", kind: "user" },
    target: { id: "worker-1", kind: "node" },
    targetNodeId: "workerbeta",
    payload: {},
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
    ...overrides,
    id: overrides.id,
    status: overrides.status,
  };
}

function futureAgo(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

// ---------------------------------------------------------------------------
// getStuckPhase
// ---------------------------------------------------------------------------

describe("getStuckPhase", () => {
  it("returns queued for queued status", () => {
    expect(getStuckPhase("queued")).toBe("queued");
  });
  it("returns claimed for claimed status", () => {
    expect(getStuckPhase("claimed")).toBe("claimed");
  });
  it("returns running for running status", () => {
    expect(getStuckPhase("running")).toBe("running");
  });
  it("returns undefined for terminal/blocked statuses", () => {
    expect(getStuckPhase("succeeded")).toBeUndefined();
    expect(getStuckPhase("failed")).toBeUndefined();
    expect(getStuckPhase("canceled")).toBeUndefined();
    expect(getStuckPhase("blocked")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getStaleThresholdMs
// ---------------------------------------------------------------------------

describe("getStaleThresholdMs", () => {
  it("returns correct thresholds per phase", () => {
    expect(getStaleThresholdMs("queued", DEFAULT_STALE_PHASE_THRESHOLDS)).toBe(300_000);
    expect(getStaleThresholdMs("claimed", DEFAULT_STALE_PHASE_THRESHOLDS)).toBe(120_000);
    expect(getStaleThresholdMs("running", DEFAULT_STALE_PHASE_THRESHOLDS)).toBe(600_000);
  });
});

// ---------------------------------------------------------------------------
// getPhaseRetryCap
// ---------------------------------------------------------------------------

describe("getPhaseRetryCap", () => {
  it("returns correct caps per phase", () => {
    expect(getPhaseRetryCap("queued", DEFAULT_PHASE_RETRY_CAPS)).toBe(3);
    expect(getPhaseRetryCap("claimed", DEFAULT_PHASE_RETRY_CAPS)).toBe(3);
    expect(getPhaseRetryCap("running", DEFAULT_PHASE_RETRY_CAPS)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeTaskPhaseAge
// ---------------------------------------------------------------------------

describe("computeTaskPhaseAge", () => {
  it("uses updatedAt as primary timestamp", () => {
    const task = makeTask({ id: "t1", status: "queued", updatedAt: futureAgo(10_000) });
    const age = computeTaskPhaseAge(task, Date.now());
    expect(Math.abs(age - 10_000) < 100).toBe(true);
  });

  it("falls back to createdAt when updatedAt is not parseable", () => {
    const task = makeTask({
      id: "t2",
      status: "queued",
      createdAt: futureAgo(5_000),
      updatedAt: "invalid-date",
    });
    const age = computeTaskPhaseAge(task, Date.now());
    expect(Math.abs(age - 5_000) < 100).toBe(true);
  });

  it("returns 0 when neither timestamp is parseable", () => {
    const task = makeTask({
      id: "t3",
      status: "queued",
      createdAt: "bad",
      updatedAt: "bad",
    });
    expect(computeTaskPhaseAge(task, Date.now())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diagnoseTask — fresh tasks (within thresholds)
// ---------------------------------------------------------------------------

describe("diagnoseTask — fresh (within thresholds)", () => {
  it("returns fresh for queued task under threshold", () => {
    const task = makeTask({ id: "t1", status: "queued", updatedAt: futureAgo(10_000) });
    const d = diagnoseTask(task, DEFAULT_STALE_PHASE_THRESHOLDS, DEFAULT_PHASE_RETRY_CAPS, Date.now());
    expect(d.verdict).toBe("fresh");
    expect(d.stuckPhase).toBe("queued");
    expect(d.thresholdMs).toBe(300_000);
  });

  it("returns fresh for terminal tasks with no stuckPhase", () => {
    const task = makeTask({ id: "t2", status: "succeeded" });
    const d = diagnoseTask(task, DEFAULT_STALE_PHASE_THRESHOLDS, DEFAULT_PHASE_RETRY_CAPS, Date.now());
    expect(d.verdict).toBe("fresh");
    expect(d.stuckPhase).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// diagnoseTask — stale (exceeds thresholds)
// ---------------------------------------------------------------------------

describe("diagnoseTask — stale (exceeds threshold)", () => {
  it("flags queued task past stale threshold", () => {
    const task = makeTask({ id: "t1", status: "queued", updatedAt: futureAgo(400_000) });
    const d = diagnoseTask(task, DEFAULT_STALE_PHASE_THRESHOLDS, DEFAULT_PHASE_RETRY_CAPS, Date.now());
    expect(d.verdict).toBe("stale");
    expect(d.stuckPhase).toBe("queued");
    expect(d.thresholdMs).toBe(300_000);
  });

  it("flags claimed task past stale threshold", () => {
    const task = makeTask({ id: "t2", status: "claimed", updatedAt: futureAgo(180_000) });
    const d = diagnoseTask(task, { ...DEFAULT_STALE_PHASE_THRESHOLDS, claimedStaleAfterMs: 120_000 }, DEFAULT_PHASE_RETRY_CAPS, Date.now());
    expect(d.verdict).toBe("stale");
    expect(d.stuckPhase).toBe("claimed");
  });

  it("flags running task past stale threshold", () => {
    const task = makeTask({ id: "t3", status: "running", updatedAt: futureAgo(700_000) });
    const d = diagnoseTask(task, { ...DEFAULT_STALE_PHASE_THRESHOLDS, runningStaleAfterMs: 600_000 }, DEFAULT_PHASE_RETRY_CAPS, Date.now());
    expect(d.verdict).toBe("stale");
    expect(d.stuckPhase).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// diagnoseTask — retry cap exceeded
// ---------------------------------------------------------------------------

describe("diagnoseTask — retry cap exceeded", () => {
  it("flags retry cap exceeded when requeueCount >= max", () => {
    const task = makeTask({
      id: "t1",
      status: "queued",
      requeueCount: 3,
      updatedAt: futureAgo(5000),
    });
    const d = diagnoseTask(task, DEFAULT_STALE_PHASE_THRESHOLDS, { ...DEFAULT_PHASE_RETRY_CAPS, maxQueuedRetries: 3 }, Date.now());
    expect(d.verdict).toBe("retry_cap_exceeded");
    expect(d.stuckPhase).toBe("queued");
    expect(d.phaseRequeueCount).toBe(3);
    expect(d.maxPhaseRetries).toBe(3);
  });

  it("retry cap takes priority over stale (even if under time threshold)", () => {
    const task = makeTask({
      id: "t2",
      status: "claimed",
      requeueCount: 5,
      updatedAt: futureAgo(10_000),
    });
    const d = diagnoseTask(task, DEFAULT_STALE_PHASE_THRESHOLDS, { ...DEFAULT_PHASE_RETRY_CAPS, maxClaimedRetries: 3 }, Date.now());
    expect(d.verdict).toBe("retry_cap_exceeded");
    expect(d.stuckPhase).toBe("claimed");
  });

  it("not exceeded when requeueCount is below cap", () => {
    const task = makeTask({
      id: "t3",
      status: "queued",
      requeueCount: 2,
      updatedAt: futureAgo(10_000),
    });
    const d = diagnoseTask(task, { ...DEFAULT_STALE_PHASE_THRESHOLDS, queuedStaleAfterMs: 5000 }, DEFAULT_PHASE_RETRY_CAPS, Date.now());
    // Age > threshold but requeueCount under cap => stale, not cap_exceeded
    expect(d.verdict).toBe("stale");
    expect(d.phaseRequeueCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// detectStuckTasks — full report
// ---------------------------------------------------------------------------

describe("detectStuckTasks", () => {
  const now = Date.now();

  function t(id: string, status: TaskStatus, ageMs: number, requeueCount?: number): TaskRecord {
    return makeTask({
      id,
      status,
      updatedAt: futureAgo(ageMs),
      requeueCount,
      createdAt: futureAgo(ageMs + 10_000),
    });
  }

  it("returns ok for all fresh tasks", () => {
    const tasks = [
      t("t1", "queued", 10_000),
      t("t2", "running", 30_000),
      t("t3", "succeeded", 0),
    ];
    const report = detectStuckTasks(tasks, undefined, now);
    expect(report.severity).toBe("ok");
    expect(report.totalActiveTasks).toBe(2);
    expect(report.blockers).toHaveLength(0);
  });

  it("detects stale queued tasks", () => {
    const tasks = [
      t("t1", "queued", 400_000),
    ];
    const report = detectStuckTasks(tasks, {
      staleThresholds: { queuedStaleAfterMs: 300_000, claimedStaleAfterMs: 120_000, runningStaleAfterMs: 600_000 },
    }, now);
    expect(report.severity).toBe("warning");
    expect(report.staleByPhase.queued).toBe(1);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0].phase).toBe("queued");
    expect(report.blockers[0].severity).toBe("warning");
  });

  it("detects retry cap exceeded as critical", () => {
    const tasks = [
      t("t1", "queued", 10_000, 5),
    ];
    const report = detectStuckTasks(tasks, {
      retryCaps: { maxQueuedRetries: 3, maxClaimedRetries: 3, maxRunningRetries: 3 },
    }, now);
    expect(report.severity).toBe("critical");
    expect(report.capExceededByPhase.queued).toBe(1);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0].severity).toBe("critical");
    expect(report.blockers[0].phase).toBe("queued");
  });

  it("reports multiple phases simultaneously", () => {
    const tasks = [
      t("t1", "queued", 400_000),
      t("t2", "running", 700_000),
    ];
    const report = detectStuckTasks(tasks, {
      staleThresholds: { queuedStaleAfterMs: 300_000, claimedStaleAfterMs: 120_000, runningStaleAfterMs: 600_000 },
    }, now);
    expect(report.staleByPhase.queued).toBe(1);
    expect(report.staleByPhase.running).toBe(1);
    expect(report.blockers).toHaveLength(2);
    const phases = report.blockers.map((b) => b.phase);
    expect(phases).toContain("queued");
    expect(phases).toContain("running");
  });

  it("caps diagnoses at 50 entries", () => {
    const tasks: TaskRecord[] = [];
    for (let i = 0; i < 100; i++) {
      tasks.push(t(`t${i}`, "queued", 400_000));
    }
    const report = detectStuckTasks(tasks, {
      staleThresholds: { queuedStaleAfterMs: 300_000, claimedStaleAfterMs: 120_000, runningStaleAfterMs: 600_000 },
    }, now);
    expect(report.diagnoses).toHaveLength(50);
    // Stale count should still reflect all 100
    expect(report.staleByPhase.queued).toBe(100);
  });

  it("includes backoff schedule", () => {
    const tasks = [t("t1", "queued", 400_000)];
    const report = detectStuckTasks(tasks, undefined, now);
    expect(report.backoffSchedule).toBeDefined();
    expect(report.backoffSchedule!.entries.length).toBeGreaterThan(0);
    expect(report.backoffSchedule!.config.baseMs).toBeGreaterThan(0);
  });

  it("includes lane label", () => {
    const tasks = [t("t1", "queued", 10_000)];
    const report = detectStuckTasks(tasks, { laneLabel: "workeralpha-lane-3" }, now);
    expect(report.laneLabel).toBe("workeralpha-lane-3");
  });

  it("only analyzes non-terminal tasks", () => {
    const tasks = [
      t("t1", "succeeded", 0),
      t("t2", "failed", 0),
      t("t3", "canceled", 0),
    ];
    const report = detectStuckTasks(tasks, undefined, now);
    expect(report.totalActiveTasks).toBe(0);
    expect(report.diagnoses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildOperatorBlockers
// ---------------------------------------------------------------------------

describe("buildOperatorBlockers", () => {
  function diag(taskId: string, phase: StuckPhase, verdict: "stale" | "retry_cap_exceeded"): StuckTaskDiagnosis {
    return {
      taskId,
      currentStatus: phase as TaskStatus,
      stuckPhase: phase,
      verdict,
      ageMs: 500_000,
      thresholdMs: 300_000,
      phaseRequeueCount: 3,
      maxPhaseRetries: 3,
    };
  }

  it("builds warning blockers for stale tasks", () => {
    const blockers = buildOperatorBlockers(
      [diag("t1", "queued", "stale")],
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      new Date().toISOString(),
    );
    const staleBlocker = blockers.find((b) => b.severity === "warning");
    expect(staleBlocker).toBeDefined();
    expect(staleBlocker!.affectedTaskIds).toContain("t1");
  });

  it("builds critical blockers for cap exceeded", () => {
    const blockers = buildOperatorBlockers(
      [diag("t1", "queued", "retry_cap_exceeded")],
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      new Date().toISOString(),
    );
    const criticalBlocker = blockers.find((b) => b.severity === "critical");
    expect(criticalBlocker).toBeDefined();
    expect(criticalBlocker!.phase).toBe("queued");
  });

  it("empty diagnoses produce no blockers", () => {
    const blockers = buildOperatorBlockers(
      [],
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      new Date().toISOString(),
    );
    expect(blockers).toHaveLength(0);
  });

  it("caps affectedTaskIds at 20", () => {
    const diags: StuckTaskDiagnosis[] = [];
    for (let i = 0; i < 30; i++) {
      diags.push(diag(`t${i}`, "queued", "stale"));
    }
    const blockers = buildOperatorBlockers(
      diags,
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      new Date().toISOString(),
    );
    const queuedBlocker = blockers.find((b) => b.phase === "queued" && b.severity === "warning");
    expect(queuedBlocker).toBeDefined();
    expect(queuedBlocker!.totalAffected).toBe(30);
    expect(queuedBlocker!.affectedTaskIds).toHaveLength(20);
  });

  it("generates actionable recommendation", () => {
    const blockers = buildOperatorBlockers(
      [diag("t1", "running", "retry_cap_exceeded")],
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      new Date().toISOString(),
    );
    expect(blockers[0].recommendedAction.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// computeReportSeverity
// ---------------------------------------------------------------------------

describe("computeReportSeverity", () => {
  it("returns ok for empty blockers", () => {
    expect(computeReportSeverity([])).toBe("ok");
  });

  it("returns warning when only warning blockers exist", () => {
    const blockers: OperatorBlocker[] = [
      {
        id: "warn-1",
        title: "test",
        description: "test",
        severity: "warning",
        affectedTaskIds: [],
        totalAffected: 0,
        generatedAt: new Date().toISOString(),
        recommendedAction: "none",
      },
    ];
    expect(computeReportSeverity(blockers)).toBe("warning");
  });

  it("returns critical when at least one critical blocker exists", () => {
    const blockers: OperatorBlocker[] = [
      {
        id: "warn-1",
        title: "test",
        description: "test",
        severity: "warning",
        affectedTaskIds: [],
        totalAffected: 0,
        generatedAt: new Date().toISOString(),
        recommendedAction: "none",
      },
      {
        id: "crit-1",
        title: "test",
        description: "test",
        severity: "critical",
        affectedTaskIds: [],
        totalAffected: 0,
        generatedAt: new Date().toISOString(),
        recommendedAction: "none",
      },
    ];
    expect(computeReportSeverity(blockers)).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// Integration: config merging
// ---------------------------------------------------------------------------

describe("config merging in detectStuckTasks", () => {
  it("uses defaults when no overrides provided", () => {
    const report = detectStuckTasks([], undefined, Date.now());
    expect(report.config.staleThresholds.queuedStaleAfterMs).toBe(300_000);
    expect(report.config.retryCaps.maxQueuedRetries).toBe(3);
    expect(report.laneLabel).toBe("default");
    expect(report.config.repeatedErrorThreshold).toBe(DEFAULT_REPEATED_ERROR_THRESHOLD);
  });

  it("merges partial overrides", () => {
    const report = detectStuckTasks([], {
      laneLabel: "workeralpha-lane-4",
      staleThresholds: { queuedStaleAfterMs: 60_000, claimedStaleAfterMs: 120_000, runningStaleAfterMs: 600_000 },
    }, Date.now());
    expect(report.laneLabel).toBe("workeralpha-lane-4");
    expect(report.config.staleThresholds.queuedStaleAfterMs).toBe(60_000);
    expect(report.config.staleThresholds.claimedStaleAfterMs).toBe(120_000); // default
    expect(report.config.staleThresholds.runningStaleAfterMs).toBe(600_000); // default
  });

  it("overrides repeatedErrorThreshold when provided", () => {
    const report = detectStuckTasks([], {
      repeatedErrorThreshold: 4,
    }, Date.now());
    expect(report.config.repeatedErrorThreshold).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// normalizeErrorSignature
// ---------------------------------------------------------------------------

describe("normalizeErrorSignature", () => {
  it("returns identical signatures for the same message", () => {
    const a = normalizeErrorSignature({ message: "ECONNREFUSED at gateway" });
    const b = normalizeErrorSignature({ message: "ECONNREFUSED at gateway" });
    expect(a).toBe(b);
  });

  it("strips ISO-8601 timestamps from messages", () => {
    const a = normalizeErrorSignature({ message: "failed at 2026-06-25T00:36:48.884Z" });
    const b = normalizeErrorSignature({ message: "failed at 2027-01-01T12:00:00.000Z" });
    expect(a).toBe(b);
  });

  it("strips unix epoch milliseconds from messages", () => {
    const a = normalizeErrorSignature({ message: "poll failed ts=1748105408884" });
    const b = normalizeErrorSignature({ message: "poll failed ts=1748106000000" });
    expect(a).toBe(b);
  });

  it("strips tmp paths", () => {
    const a = normalizeErrorSignature({ message: "ENOENT /tmp/agent-12345/run.log" });
    const b = normalizeErrorSignature({ message: "ENOENT /tmp/agent-67890/run.log" });
    expect(a).toBe(b);
  });

  it("strips UUID-like ids", () => {
    const a = normalizeErrorSignature({ message: "task 550e8400-e29b-41d4-a716-446655440000 timed out" });
    const b = normalizeErrorSignature({ message: "task 6fa459ea-ee8a-3ca4-894e-db77e160355e timed out" });
    expect(a).toBe(b);
  });

  it("strips hex hash-like ids", () => {
    const a = normalizeErrorSignature({ message: "object abc123def456 not found" });
    const b = normalizeErrorSignature({ message: "object 9876543210ab not found" });
    expect(a).toBe(b);
  });

  it("strips PIDs", () => {
    const a = normalizeErrorSignature({ message: "killed pid=12345" });
    const b = normalizeErrorSignature({ message: "killed pid=67890" });
    expect(a).toBe(b);
  });

  it("strips duration values", () => {
    const a = normalizeErrorSignature({ message: "after 1500ms" });
    const b = normalizeErrorSignature({ message: "after 8500ms" });
    expect(a).toBe(b);
  });

  it("keeps different error categories distinct", () => {
    const sigA = normalizeErrorSignature({ message: "ECONNREFUSED at gateway" });
    const sigB = normalizeErrorSignature({ message: "ETIMEDOUT at gateway" });
    expect(sigA).not.toBe(sigB);
  });

  it("uses error code if present", () => {
    const sigA = normalizeErrorSignature({ code: "ECONNREFUSED", message: "different body" });
    const sigB = normalizeErrorSignature({ code: "ETIMEDOUT", message: "different body" });
    expect(sigA).not.toBe(sigB);
  });

  it("normalizes the same code + message equivalently across calls", () => {
    const sigA = normalizeErrorSignature({ code: "E_HANDSHAKE", message: "tls failed at 2026-06-25T00:00:00Z" });
    const sigB = normalizeErrorSignature({ code: "E_HANDSHAKE", message: "tls failed at 2026-06-25T00:01:00Z" });
    expect(sigA).toBe(sigB);
  });

  it("returns empty string for empty error", () => {
    expect(normalizeErrorSignature({ message: "" })).toBe("");
  });

  it("accepts a raw string message", () => {
    const sigA = normalizeErrorSignature("worker pid=1234 crashed");
    const sigB = normalizeErrorSignature("worker pid=5678 crashed");
    expect(sigA).toBe(sigB);
  });
});

// ---------------------------------------------------------------------------
// hasRepeatedErrorSignature
// ---------------------------------------------------------------------------

describe("hasRepeatedErrorSignature", () => {
  function err(message: string, code?: string): TaskError {
    return code ? { code, message } : { message };
  }

  it("returns false for an empty history", () => {
    expect(hasRepeatedErrorSignature([], 2)).toBe(false);
  });

  it("returns false when there are fewer errors than the threshold", () => {
    expect(
      hasRepeatedErrorSignature([err("boom")], 2),
    ).toBe(false);
  });

  it("returns true when the last N errors share a signature", () => {
    expect(
      hasRepeatedErrorSignature(
        [err("ECONNREFUSED"), err("ECONNREFUSED")],
        2,
      ),
    ).toBe(true);
  });

  it("returns false when the last N errors have different signatures", () => {
    expect(
      hasRepeatedErrorSignature(
        [err("ECONNREFUSED"), err("ETIMEDOUT")],
        2,
      ),
    ).toBe(false);
  });

  it("uses only the trailing N errors for comparison", () => {
    // Earlier error is different but the last 2 are identical.
    expect(
      hasRepeatedErrorSignature(
        [err("OTHER"), err("ECONNREFUSED"), err("ECONNREFUSED")],
        2,
      ),
    ).toBe(true);
    // Earlier identical errors are followed by a different one — last 2 differ.
    expect(
      hasRepeatedErrorSignature(
        [err("ECONNREFUSED"), err("ECONNREFUSED"), err("OTHER")],
        2,
      ),
    ).toBe(false);
  });

  it("normalizes volatile tokens across the trailing window", () => {
    expect(
      hasRepeatedErrorSignature(
        [
          err("failed at 2026-06-25T00:00:00Z"),
          err("failed at 2026-06-25T01:00:00Z"),
        ],
        2,
      ),
    ).toBe(true);
  });

  it("treats threshold <= 1 as a single-error check", () => {
    expect(hasRepeatedErrorSignature([err("any")], 1)).toBe(true);
    expect(hasRepeatedErrorSignature([], 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// diagnoseTask — repeated_error_early_stop
// ---------------------------------------------------------------------------

describe("diagnoseTask — repeated_error_early_stop", () => {
  function taskWithHistory(history: TaskError[]): TaskRecord {
    return makeTask({
      id: "rep-1",
      status: "running",
      updatedAt: futureAgo(5_000),
      requeueCount: 0,
      errorHistory: history,
    });
  }

  it("returns repeated_error_early_stop when last N error signatures repeat", () => {
    const task = taskWithHistory([
      { message: "ECONNREFUSED at gateway" },
      { message: "ECONNREFUSED at gateway" },
    ]);
    const d = diagnoseTask(
      task,
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      Date.now(),
      { repeatedErrorThreshold: 2 },
    );
    expect(d.verdict).toBe("repeated_error_early_stop");
    expect(d.stuckPhase).toBe("running");
    expect(d.repeatedErrorCount).toBe(2);
    expect(d.errorSignature).toBeDefined();
  });

  it("does not trigger when the last N errors are different", () => {
    const task = taskWithHistory([
      { message: "ECONNREFUSED at gateway" },
      { message: "ETIMEDOUT at gateway" },
    ]);
    const d = diagnoseTask(
      task,
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      Date.now(),
      { repeatedErrorThreshold: 2 },
    );
    expect(d.verdict).not.toBe("repeated_error_early_stop");
  });

  it("normalizes volatile tokens (timestamps, PIDs, paths) so equivalent errors match", () => {
    const task = taskWithHistory([
      { message: "poll failed at 2026-06-25T00:00:00Z pid=1234 /tmp/agent-1/r.log" },
      { message: "poll failed at 2026-06-25T00:01:00Z pid=5678 /tmp/agent-2/r.log" },
    ]);
    const d = diagnoseTask(
      task,
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      Date.now(),
      { repeatedErrorThreshold: 2 },
    );
    expect(d.verdict).toBe("repeated_error_early_stop");
  });

  it("does not trigger when errorHistory is absent", () => {
    const task = makeTask({ id: "t-x", status: "running", updatedAt: futureAgo(5_000) });
    const d = diagnoseTask(
      task,
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      Date.now(),
      { repeatedErrorThreshold: 2 },
    );
    expect(d.verdict).not.toBe("repeated_error_early_stop");
    expect(d.repeatedErrorCount).toBe(0);
    expect(d.errorSignature).toBeUndefined();
  });

  it("retry_cap_exceeded still takes precedence over repeated_error_early_stop", () => {
    const task = taskWithHistory([
      { message: "ECONNREFUSED at gateway" },
      { message: "ECONNREFUSED at gateway" },
    ]);
    task.requeueCount = 10;
    task.status = "running";
    const d = diagnoseTask(
      task,
      DEFAULT_STALE_PHASE_THRESHOLDS,
      { maxQueuedRetries: 3, maxClaimedRetries: 3, maxRunningRetries: 3 },
      Date.now(),
      { repeatedErrorThreshold: 2 },
    );
    expect(d.verdict).toBe("retry_cap_exceeded");
  });

  it("stale verdict is preserved when repeated_error is absent", () => {
    const task = makeTask({
      id: "t-stale",
      status: "running",
      updatedAt: futureAgo(700_000),
    });
    const d = diagnoseTask(
      task,
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      Date.now(),
      { repeatedErrorThreshold: 2 },
    );
    expect(d.verdict).toBe("stale");
  });

  it("fresh verdict is preserved when under all thresholds", () => {
    const task = makeTask({
      id: "t-fresh",
      status: "running",
      updatedAt: futureAgo(5_000),
    });
    const d = diagnoseTask(
      task,
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      Date.now(),
      { repeatedErrorThreshold: 2 },
    );
    expect(d.verdict).toBe("fresh");
  });

  it("repeated_error_early_stop is additive when only the last window matches", () => {
    // First error is different; the last 2 match.
    const task = taskWithHistory([
      { message: "DIFFERENT" },
      { message: "ECONNREFUSED at gateway" },
      { message: "ECONNREFUSED at gateway" },
    ]);
    const d = diagnoseTask(
      task,
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      Date.now(),
      { repeatedErrorThreshold: 2 },
    );
    expect(d.verdict).toBe("repeated_error_early_stop");
    expect(d.repeatedErrorCount).toBe(2);
  });

  it("uses DEFAULT_REPEATED_ERROR_THRESHOLD when override omitted", () => {
    const errors = Array.from({ length: DEFAULT_REPEATED_ERROR_THRESHOLD }, () => ({
      message: "ECONNREFUSED",
    }));
    const task = taskWithHistory(errors);
    const d = diagnoseTask(
      task,
      DEFAULT_STALE_PHASE_THRESHOLDS,
      DEFAULT_PHASE_RETRY_CAPS,
      Date.now(),
    );
    expect(d.verdict).toBe("repeated_error_early_stop");
  });

  it("regression: existing retry_cap_exceeded verdict is preserved when no error history is present", () => {
    // Regression guard for the additivity contract: introducing repeated_error
    // detection must not change the verdict for tasks that hit the retry cap.
    const task = makeTask({
      id: "t-cap",
      status: "running",
      requeueCount: 5,
      updatedAt: futureAgo(5_000),
    });
    const d = diagnoseTask(
      task,
      DEFAULT_STALE_PHASE_THRESHOLDS,
      { maxQueuedRetries: 3, maxClaimedRetries: 3, maxRunningRetries: 3 },
      Date.now(),
      { repeatedErrorThreshold: 2 },
    );
    expect(d.verdict).toBe("retry_cap_exceeded");
    expect(d.stuckPhase).toBe("running");
    expect(d.phaseRequeueCount).toBe(5);
    expect(d.maxPhaseRetries).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// detectStuckTasks — repeated_error_early_stop aggregation
// ---------------------------------------------------------------------------

describe("detectStuckTasks — repeated_error_early_stop aggregation", () => {
  const now = Date.now();

  function tWithErrors(
    id: string,
    status: TaskStatus,
    ageMs: number,
    history: TaskError[],
    requeueCount?: number,
  ): TaskRecord {
    return makeTask({
      id,
      status,
      updatedAt: futureAgo(ageMs),
      createdAt: futureAgo(ageMs + 10_000),
      errorHistory: history,
      requeueCount,
    });
  }

  it("counts repeated-error diagnoses in repeatedErrorByPhase", () => {
    const tasks = [
      tWithErrors(
        "rep-1",
        "running",
        5_000,
        [
          { message: "ECONNREFUSED at gateway" },
          { message: "ECONNREFUSED at gateway" },
        ],
      ),
    ];
    const report = detectStuckTasks(tasks, undefined, now);
    expect(report.repeatedErrorByPhase.running).toBe(1);
    expect(report.repeatedErrorByPhase.queued).toBe(0);
    expect(report.repeatedErrorByPhase.claimed).toBe(0);
  });

  it("emits a critical operator blocker for repeated-error early-stop", () => {
    const tasks = [
      tWithErrors(
        "rep-1",
        "running",
        5_000,
        [
          { message: "ECONNREFUSED at gateway" },
          { message: "ECONNREFUSED at gateway" },
        ],
      ),
    ];
    const report = detectStuckTasks(tasks, undefined, now);
    const blocker = report.blockers.find((b) => b.id.startsWith("repeated-error-"));
    expect(blocker).toBeDefined();
    expect(blocker!.severity).toBe("critical");
    expect(blocker!.phase).toBe("running");
    expect(blocker!.affectedTaskIds).toContain("rep-1");
    expect(blocker!.totalAffected).toBe(1);
    expect(blocker!.recommendedAction.length).toBeGreaterThan(10);
  });

  it("regression: stale-only tasks do not emit a repeated-error blocker", () => {
    const tasks = [
      makeTask({
        id: "stale-1",
        status: "running",
        updatedAt: futureAgo(700_000),
      }),
    ];
    const report = detectStuckTasks(tasks, {
      staleThresholds: DEFAULT_STALE_PHASE_THRESHOLDS,
    }, now);
    expect(report.staleByPhase.running).toBe(1);
    expect(report.repeatedErrorByPhase.running).toBe(0);
    const blocker = report.blockers.find((b) => b.id.startsWith("repeated-error-"));
    expect(blocker).toBeUndefined();
  });

  it("different errors across the history do not trigger the blocker", () => {
    const tasks = [
      tWithErrors(
        "diff-1",
        "running",
        5_000,
        [
          { message: "ECONNREFUSED at gateway" },
          { message: "ETIMEDOUT at gateway" },
        ],
      ),
    ];
    const report = detectStuckTasks(tasks, undefined, now);
    expect(report.repeatedErrorByPhase.running).toBe(0);
    const blocker = report.blockers.find((b) => b.id.startsWith("repeated-error-"));
    expect(blocker).toBeUndefined();
  });

  it("respects repeatedErrorThreshold override on the aggregate report", () => {
    const tasks = [
      tWithErrors(
        "rep-1",
        "running",
        5_000,
        [
          { message: "ECONNREFUSED at gateway" },
          { message: "ECONNREFUSED at gateway" },
          { message: "ECONNREFUSED at gateway" },
        ],
      ),
    ];
    // threshold 3 should match (3 trailing errors same)
    const r3 = detectStuckTasks(tasks, { repeatedErrorThreshold: 3 }, now);
    expect(r3.repeatedErrorByPhase.running).toBe(1);
    // threshold 4 should NOT match (only 3 trailing)
    const r4 = detectStuckTasks(tasks, { repeatedErrorThreshold: 4 }, now);
    expect(r4.repeatedErrorByPhase.running).toBe(0);
  });
});
