import assert from "node:assert/strict";
import test from "node:test";

import { emptySnapshot, type BrokerSnapshot } from "./store.js";
import { fitSnapshotToBudget, SnapshotOverflowError } from "./store-snapshot-fit.js";

function fatTask(
  id: string,
  status: BrokerSnapshot["tasks"][number]["status"],
  bytes: number,
  completedAt?: string,
): BrokerSnapshot["tasks"][number] {
  return {
    id,
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: id,
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: { blob: "x".repeat(bytes) },
    status,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:01:00.000Z",
    ...(completedAt === undefined ? {} : { completedAt }),
    taskOrigin: "api",
  };
}

test("fitSnapshotToBudget keeps a fitting snapshot untouched", () => {
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    tasks: [fatTask("task-active", "queued", 100)],
  };
  const fit = fitSnapshotToBudget(snapshot, 50 * 1024);
  assert.equal(fit.shedTerminalTasks, 0);
  assert.deepEqual(fit.snapshot.tasks.map((task) => task.id), ["task-active"]);
  assert.ok(Buffer.byteLength(fit.payload, "utf8") <= 50 * 1024);
});

test("fitSnapshotToBudget sheds oldest terminal tasks first and preserves sidecars", () => {
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    tasks: [
      fatTask("task-active", "queued", 100),
      fatTask("term-oldest", "succeeded", 8 * 1024, "2026-07-01T01:00:00.000Z"),
      fatTask("term-middle", "failed", 8 * 1024, "2026-07-02T01:00:00.000Z"),
      fatTask("term-newest", "succeeded", 8 * 1024, "2026-07-03T01:00:00.000Z"),
    ],
    wavePlans: [
      {
        planId: "wave-1",
        goalId: "goal-1",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        status: "active",
        waves: [],
      } as unknown as NonNullable<BrokerSnapshot["wavePlans"]>[number],
    ],
  };
  // Budget fits active + newest terminal only.
  const fit = fitSnapshotToBudget(snapshot, 12 * 1024);
  assert.ok(fit.shedTerminalTasks >= 1);
  const ids = fit.snapshot.tasks.map((task) => task.id);
  assert.ok(ids.includes("task-active"), "non-terminal tasks are never shed");
  assert.ok(!ids.includes("term-oldest"), "oldest terminal sheds first");
  assert.deepEqual(fit.snapshot.wavePlans, snapshot.wavePlans, "sidecars are never shed");
  assert.ok(Buffer.byteLength(fit.payload, "utf8") <= 12 * 1024);
});

test("fitSnapshotToBudget sheds to zero terminal tasks when required", () => {
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    tasks: [
      fatTask("task-active", "running", 100),
      fatTask("term-a", "succeeded", 6 * 1024, "2026-07-01T01:00:00.000Z"),
      fatTask("term-b", "canceled", 6 * 1024, "2026-07-02T01:00:00.000Z"),
    ],
  };
  const fit = fitSnapshotToBudget(snapshot, 2 * 1024);
  assert.equal(fit.shedTerminalTasks, 2);
  assert.deepEqual(fit.snapshot.tasks.map((task) => task.id), ["task-active"]);
});

test("fitSnapshotToBudget throws SnapshotOverflowError when non-terminal state alone exceeds budget", () => {
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    tasks: [fatTask("task-huge", "queued", 64 * 1024)],
  };
  assert.throws(
    () => fitSnapshotToBudget(snapshot, 4 * 1024),
    (error: unknown) =>
      error instanceof SnapshotOverflowError &&
      /exceeds max size/.test(error.message) &&
      error.maxBytes === 4 * 1024,
  );
});

test("fitSnapshotToBudget throws when only terminal tasks existed and they still cannot help", () => {
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    tasks: [
      fatTask("term-huge-a", "failed", 32 * 1024, "2026-07-01T01:00:00.000Z"),
      fatTask("term-huge-b", "failed", 32 * 1024, "2026-07-02T01:00:00.000Z"),
    ],
    auditEvents: [
      {
        id: "audit-huge",
        at: "2026-07-01T00:00:00.000Z",
        type: "note",
        detail: "y".repeat(64 * 1024),
      } as unknown as BrokerSnapshot["auditEvents"][number],
    ],
  };
  assert.throws(
    () => fitSnapshotToBudget(snapshot, 4 * 1024),
    (error: unknown) => error instanceof SnapshotOverflowError,
  );
});
