import test from "node:test";
import assert from "node:assert/strict";

import { aggregateWorkerLatencyProfiles, workerIdentityForTask } from "./task-stats.js";
import type { AuditEvent, TaskRecord } from "./types.js";

function task(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    intent: "analyze",
    status: "succeeded",
    targetNodeId: overrides.assignedWorkerId ?? "worker-a",
    payload: {},
    message: "private message body that must never leak",
    requester: { id: "operator-1", kind: "node", role: "operator" },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:10.000Z",
    ...overrides,
  } as TaskRecord;
}

function event(action: AuditEvent["action"], targetId: string, at: string): AuditEvent {
  return { id: `${targetId}-${action}-${at}`, actorId: "broker", action, targetType: "task", targetId, createdAt: at };
}

function chainEvents(id: string, times: { created: string; claimed: string; started: string; terminal: string }, status: "succeeded" | "failed" | "canceled"): AuditEvent[] {
  const terminalAction = status === "succeeded" ? "task.succeeded" : status === "failed" ? "task.failed" : "task.canceled";
  return [
    event("task.created", id, times.created),
    event("task.claimed", id, times.claimed),
    event("task.started", id, times.started),
    event(terminalAction, id, times.terminal),
  ];
}

test("aggregates latency and outcomes separately per worker", () => {
  const tasks = [
    task({ id: "t1", assignedWorkerId: "worker-a" }),
    task({ id: "t2", assignedWorkerId: "worker-a", status: "failed", error: { code: "handler_exit_nonzero", message: "x" } }),
    task({ id: "t3", assignedWorkerId: "worker-b" }),
  ];
  const events = [
    ...chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:02.000Z", started: "2026-09-01T00:00:03.000Z", terminal: "2026-09-01T00:00:13.000Z" }, "succeeded"),
    ...chainEvents("t2", { created: "2026-09-01T01:00:00.000Z", claimed: "2026-09-01T01:00:04.000Z", started: "2026-09-01T01:00:05.000Z", terminal: "2026-09-01T01:00:45.000Z" }, "failed"),
    ...chainEvents("t3", { created: "2026-09-01T02:00:00.000Z", claimed: "2026-09-01T02:00:01.000Z", started: "2026-09-01T02:00:02.000Z", terminal: "2026-09-01T02:00:06.000Z" }, "succeeded"),
  ];

  const response = aggregateWorkerLatencyProfiles(tasks, events);

  assert.equal(response.schemaVersion, "a2a.worker-latency-profiles.v1");
  assert.equal(response.viewMode, "read_only_advisory");
  assert.equal(response.automaticRoutingPolicy, "none");
  assert.equal(response.coverage.workers, 2);
  assert.equal(response.coverage.truncatedWorkers, 0);
  assert.equal(response.coverage.tasksWithoutWorkerIdentity, 0);

  const a = response.profiles.find((profile) => profile.workerId === "worker-a");
  const b = response.profiles.find((profile) => profile.workerId === "worker-b");
  assert.ok(a && b);

  assert.equal(a.terminalTasks, 2);
  assert.equal(a.completeChains, 2);
  assert.deepEqual(a.byStatus, { succeeded: 1, failed: 1, canceled: 0 });
  assert.deepEqual(a.failureCodes.top, [{ code: "handler_exit_nonzero", count: 1 }]);
  // t1: run 10s, t2: run 40s → nearest-rank: p50 picks ceil(0.5·2)=1st → 10000; p95 picks 2nd → 40000.
  assert.equal(a.latency.runMs.p50Ms, 10000);
  assert.equal(a.latency.runMs.p95Ms, 40000);
  assert.equal(a.latency.queueMs.p50Ms, 2000);

  assert.equal(b.terminalTasks, 1);
  assert.deepEqual(b.byStatus, { succeeded: 1, failed: 0, canceled: 0 });
  assert.equal(b.latency.runMs.p50Ms, 4000);
});

test("emission order is deterministic (terminal volume desc, then workerId asc) and maxWorkers truncates with a count", () => {
  const tasks = [
    task({ id: "t1", assignedWorkerId: "worker-c" }),
    task({ id: "t2", assignedWorkerId: "worker-c" }),
    task({ id: "t3", assignedWorkerId: "worker-a" }),
    task({ id: "t4", assignedWorkerId: "worker-b" }),
  ];
  const events = [
    ...chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "succeeded"),
    ...chainEvents("t2", { created: "2026-09-01T00:01:00.000Z", claimed: "2026-09-01T00:01:01.000Z", started: "2026-09-01T00:01:02.000Z", terminal: "2026-09-01T00:01:05.000Z" }, "succeeded"),
    ...chainEvents("t3", { created: "2026-09-01T00:02:00.000Z", claimed: "2026-09-01T00:02:01.000Z", started: "2026-09-01T00:02:02.000Z", terminal: "2026-09-01T00:02:05.000Z" }, "succeeded"),
    ...chainEvents("t4", { created: "2026-09-01T00:03:00.000Z", claimed: "2026-09-01T00:03:01.000Z", started: "2026-09-01T00:03:02.000Z", terminal: "2026-09-01T00:03:05.000Z" }, "succeeded"),
  ];

  const response = aggregateWorkerLatencyProfiles(tasks, events, { maxWorkers: 2 });

  // worker-c has 2 terminals (volume desc first); worker-a beats worker-b on the 1-terminal tie via workerId asc.
  assert.deepEqual(response.profiles.map((profile) => profile.workerId), ["worker-c", "worker-a"]);
  assert.equal(response.coverage.workers, 3);
  assert.equal(response.coverage.truncatedWorkers, 1);
});

test("counts tasks without a usable worker identity and ignores non-terminal tasks", () => {
  const tasks = [
    task({ id: "t1", assignedWorkerId: undefined as unknown as string, targetNodeId: undefined as unknown as string }),
    task({ id: "t2", assignedWorkerId: "worker-a", status: "failed", error: { code: "nope", message: "x" } }),
  ];
  const events = chainEvents("t2", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "failed");

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  assert.equal(response.coverage.tasksWithoutWorkerIdentity, 1);
  assert.equal(response.coverage.workers, 1);
  assert.equal(response.profiles[0]?.workerId, "worker-a");
  assert.equal(response.profiles[0]?.terminalTasks, 1);
});

test("non-monotonic chains are excluded from latency samples without becoming private leaks", () => {
  const tasks = [task({ id: "t1", assignedWorkerId: "worker-a", status: "failed", error: { code: "handler_exit_nonzero", message: "x" } })];
  const events = [
    event("task.created", "t1", "2026-09-01T00:00:10.000Z"),
    // claimed before created — non-monotonic, must not feed samples.
    event("task.claimed", "t1", "2026-09-01T00:00:01.000Z"),
    event("task.started", "t1", "2026-09-01T00:00:02.000Z"),
    event("task.failed", "t1", "2026-09-01T00:00:05.000Z"),
  ];

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const profile = response.profiles[0];
  assert.ok(profile);
  assert.equal(profile.completeChains, 0);
  assert.equal(profile.latency.runMs.count, 0);
  assert.equal(profile.latency.queueMs.count, 0);
  assert.equal(profile.latency.totalMs.count, 0);
  assert.equal(profile.terminalTasks, 1);
  assert.deepEqual(profile.failureCodes.top, [{ code: "handler_exit_nonzero", count: 1 }]);
});

test("failure code lists are bounded and deterministically ordered", () => {
  const tasks = Array.from({ length: 9 }, (_, index) =>
    task({ id: `t${index}`, assignedWorkerId: "worker-a", status: "failed", error: { code: `code-${index % 3}`, message: "x" } }),
  );
  const events = tasks.flatMap((t, index) =>
    chainEvents(t.id, { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "failed"),
  );

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const profile = response.profiles[0];
  assert.ok(profile);
  assert.ok(profile.failureCodes.top.length <= 5);
  // 3 distinct codes, each 3 occurrences — code asc tie-break.
  assert.deepEqual(profile.failureCodes.top.map((row) => row.code), ["code-0", "code-1", "code-2"]);
  assert.deepEqual(profile.failureCodes.top.map((row) => row.count), [3, 3, 3]);
});

test("workerIdentityForTask prefers assignedWorkerId and falls back to targetNodeId", () => {
  assert.equal(workerIdentityForTask(task({ id: "t1", assignedWorkerId: "w1" })), "w1");
  assert.equal(workerIdentityForTask(task({ id: "t2", assignedWorkerId: undefined as unknown as string, targetNodeId: "w2" })), "w2");
});

test("profiles carry no free-form task content", () => {
  const tasks = [task({ id: "t1", assignedWorkerId: "worker-a", message: "super-secret-private-message" })];
  const events = chainEvents("t1", { created: "2026-09-01T00:00:00.000Z", claimed: "2026-09-01T00:00:01.000Z", started: "2026-09-01T00:00:02.000Z", terminal: "2026-09-01T00:00:05.000Z" }, "succeeded");

  const response = aggregateWorkerLatencyProfiles(tasks, events);
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes("super-secret-private-message"));
  assert.ok(!serialized.toLowerCase().includes("message"));
});
