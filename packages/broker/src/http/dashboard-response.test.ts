import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardAttention } from "./dashboard-response.js";

function dashboardFixture(overrides: Record<string, unknown> = {}) {
  return {
    observability: {
      queuePressure: {
        staleWorkerAssignments: 0,
        oldestClaimed: null,
        oldestRunning: null,
      },
      workerHealth: {
        staleWorkersWithActiveTasks: [],
      },
      recovery: {
        recentDeadLetters: [],
      },
    },
    ...overrides,
  } as any;
}

function persistenceQueueFixture(overrides: Record<string, unknown> = {}) {
  return {
    kind: "broker.persistence.queue",
    enabled: true,
    mode: "worker_thread",
    state: "healthy",
    capacity: 10,
    queued: 0,
    active: 0,
    inFlight: 0,
    available: 10,
    closing: false,
    aborted: false,
    ...overrides,
  } as any;
}

function requestPressureFixture(generalBusiest: Array<{ remaining: number }> = [], workerBusiest: Array<{ remaining: number }> = []) {
  return {
    general: { busiest: generalBusiest },
    worker: { busiest: workerBusiest },
  } as any;
}

test("buildDashboardAttention reports no attention items for healthy inputs", () => {
  const attention = buildDashboardAttention({
    dashboard: dashboardFixture(),
    staleReaper: { enabled: true, intervalMs: 1000, olderThanSec: 60 },
    persistenceQueue: persistenceQueueFixture(),
    requestPressure: requestPressureFixture(),
  } as any);

  assert.deepEqual(attention, { highestSeverity: "none", items: [] });
});

test("buildDashboardAttention prioritizes critical stale assignment signals", () => {
  const attention = buildDashboardAttention({
    dashboard: dashboardFixture({
      observability: {
        queuePressure: {
          staleWorkerAssignments: 2,
          oldestClaimed: { id: "task-1", statusAgeSec: 130 },
          oldestRunning: null,
        },
        workerHealth: {
          staleWorkersWithActiveTasks: ["worker-1"],
        },
        recovery: {
          recentDeadLetters: ["task-dead"],
        },
      },
    }),
    staleReaper: { enabled: true, intervalMs: 1000, olderThanSec: 60, lastRequeued: 1 },
    persistenceQueue: persistenceQueueFixture({ state: "saturated", inFlight: 10, available: 0 }),
    requestPressure: requestPressureFixture([{ remaining: 0 }], [{ remaining: 1 }]),
  } as any);

  assert.equal(attention.highestSeverity, "critical");
  assert.deepEqual(
    attention.items.map((item) => item.code),
    [
      "stale-worker-assignments",
      "stale-workers-with-active-tasks",
      "aged-claimed-task",
      "dead-lettered-tasks",
      "stale-reaper-requeues",
      "persistence-queue-saturated",
      "rate-limit-saturation",
    ],
  );
});
