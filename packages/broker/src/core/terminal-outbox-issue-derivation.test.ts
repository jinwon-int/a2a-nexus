// #2051 — the terminal outbox's `payload.issue` guard must not be looser than
// the snapshot schema that later validates the same row.
//
// `githubIssueNumber` lives in the *opaque* task payload (`normalizeTaskPayload`
// copies the record through verbatim, and `createTaskRequestSchema` omits
// `payload` for exactly that reason), so the only place the store contract can
// be enforced is the core writer that lifts the field out —
// `buildTerminalTaskPayload`. Reverting its guard to the old
// `typeof issue === "number" && Number.isFinite(issue)` makes both negative and
// fractional cases below fail: the value is persisted and then rejected by
// `terminalOutboxEventSchema` on the next snapshot load (#1504/#1725 shape).
import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryA2ABroker } from "./broker.js";
import { createOwnedTask, registerWorker } from "./broker-test-helpers.js";
import { emptySnapshot } from "./store-snapshot-io.js";
import { buildTerminalTaskPayload } from "./terminal-event-outbox.js";
import { brokerSnapshotSchema, terminalOutboxPayloadIssueSchema } from "./store-schemas.js";
import type { BrokerStateStore } from "./store.js";
import type { TaskRecord } from "./types.js";

function taskWith(issue: unknown): TaskRecord {
  return {
    id: "task-issue-guard",
    targetNodeId: "worker-a",
    requester: { id: "hub" },
    target: { id: "worker-a" },
    intent: "analysis",
    payload: { githubRepo: "jinwon-int/a2a-nexus", githubIssueNumber: issue },
    artifactIds: [],
    status: "succeeded",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  } as unknown as TaskRecord;
}

test("terminal outbox payload.issue is derived from the snapshot schema, not restated", () => {
  // The guard is read off the store schema, so it cannot drift from it.
  assert.equal(terminalOutboxPayloadIssueSchema.safeParse(12).success, true);
  assert.equal(terminalOutboxPayloadIssueSchema.safeParse(0).success, true);
  assert.equal(terminalOutboxPayloadIssueSchema.safeParse(undefined).success, true);
  assert.equal(terminalOutboxPayloadIssueSchema.safeParse(-5).success, false);
  assert.equal(terminalOutboxPayloadIssueSchema.safeParse(3.5).success, false);
});

test("buildTerminalTaskPayload drops issue numbers the snapshot schema would reject", () => {
  assert.equal(buildTerminalTaskPayload(taskWith(-5)).issue, undefined);
  assert.equal(buildTerminalTaskPayload(taskWith(3.5)).issue, undefined);
  assert.equal(buildTerminalTaskPayload(taskWith(Number.POSITIVE_INFINITY)).issue, undefined);
  assert.equal(buildTerminalTaskPayload(taskWith("42")).issue, undefined);
  // Regression guard: the normal path is untouched.
  assert.equal(buildTerminalTaskPayload(taskWith(2051)).issue, 2051);
  assert.equal(buildTerminalTaskPayload(taskWith(0)).issue, 0);
  assert.equal(buildTerminalTaskPayload(taskWith(2051)).repo, "jinwon-int/a2a-nexus");
});

test("a task carrying a negative githubIssueNumber still yields a loadable snapshot", () => {
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: () => {},
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  registerWorker(broker, "worker-a");
  // The create request itself accepts this: `payload` is opaque by design.
  const task = createOwnedTask(broker, "task-negative-issue", "worker-a", {
    payload: { githubRepo: "jinwon-int/a2a-nexus", githubIssueNumber: -5 },
  });
  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  const event = broker.getTerminalTaskEventOutbox().subscribe()[0]!;
  assert.equal(event.payload.issue, undefined);
  // The operator-facing row survives — it is the whole point of dropping the
  // unusable field instead of failing the completion closed.
  assert.equal(event.payload.taskId, task.id);
  assert.equal(event.payload.repo, "jinwon-int/a2a-nexus");

  const snapshot = (broker as unknown as { exportSnapshot: () => unknown }).exportSnapshot();
  const parsed = brokerSnapshotSchema.safeParse(snapshot);
  assert.equal(
    parsed.success,
    true,
    parsed.success ? "" : JSON.stringify(parsed.error.issues.filter((issue) => issue.path[0] === "terminalOutbox")),
  );
});
