/**
 * Tests for the Terminal Brief bounded query and export API.
 *
 * Covers filtering, cursor pagination, exports (JSON, compact-round-up,
 * markdown-summary), round summaries, worker listing, and safety bounds.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  TerminalTaskEventOutbox,
  type TerminalTaskOutboxEvent,
} from "./terminal-event-outbox.js";
import {
  queryTerminalBriefEvents,
  queryTerminalBriefInbox,
  countTerminalBriefEvents,
  getTerminalBriefEvent,
  summarizeTerminalBriefInbox,
  exportTerminalBriefEvents,
  summarizeTerminalBriefRounds,
  listTerminalBriefWorkers,
} from "./terminal-brief-query-api.js";
import type { TaskRecord, TaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskRecord> & { id: string; status: TaskStatus }): TaskRecord {
  const now = new Date().toISOString();
  return {
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    completedAt: overrides.completedAt ?? now,
    payload: overrides.payload ?? {},
    result: overrides.result ?? {},
    ...overrides,
  } as TaskRecord;
}

function makeTerminalEvent(
  id: string,
  overrides: Partial<TerminalTaskOutboxEvent> = {},
): TerminalTaskOutboxEvent {
  const now = new Date().toISOString();
  return {
    id,
    kind: "task.terminal",
    taskEventId: 0,
    payload: {
      taskId: id,
      status: "succeeded",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      ...overrides.payload,
    },
    createdAt: now,
    receipt: {
      status: "accepted",
      updatedAt: now,
    },
    attempts: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Seeds for query tests
// ---------------------------------------------------------------------------

function seedOutbox(): TerminalTaskEventOutbox {
  const outbox = new TerminalTaskEventOutbox();
  const tasks: TaskRecord[] = [
    makeTask({ id: "task-1", status: "succeeded", payload: { worker: "brokeralpha", parentRoundId: "round-a", parentRoundTotal: 3, parentRoundOrder: 1, run: "round-a" } }),
    makeTask({ id: "task-2", status: "succeeded", payload: { worker: "workerepsilon", parentRoundId: "round-a", parentRoundTotal: 3, parentRoundOrder: 2, run: "round-a" } }),
    makeTask({ id: "task-3", status: "failed", payload: { worker: "workergamma", parentRoundId: "round-a", parentRoundTotal: 3, parentRoundOrder: 3, run: "round-a" } }),
    makeTask({ id: "task-4", status: "succeeded", payload: { worker: "brokerbeta", parentRoundId: "round-b", parentRoundTotal: 1, parentRoundOrder: 1, run: "round-b" } }),
    makeTask({ id: "task-5", status: "canceled", payload: { worker: "brokeralpha", parentRoundId: "round-c", parentRoundTotal: 2, parentRoundOrder: 1, run: "round-c" } }),
  ];

  for (const task of tasks) {
    outbox.enqueue(
      { id: 1, kind: task.status, taskId: task.id, timestamp: new Date().toISOString(), status: task.status } as any,
      task,
    );
  }

  // ACK task-1
  const event1 = outbox.snapshot().find((eventTarget) => eventTarget.payload.taskId === "task-1");
  if (event1) {
    outbox.acknowledge(event1.id, {
      evidence: "operator_visible",
      acknowledgedAt: new Date().toISOString(),
      note: "operator confirmed",
    });
  }

  return outbox;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("queryTerminalBriefEvents returns all events when no filter is applied", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox);
  assert.equal(result.events.length, 5);
  assert.ok(result.totalMatching >= 5);
});

test("queryTerminalBriefEvents paginates with cursor", () => {
  const outbox = seedOutbox();
  const page1 = queryTerminalBriefEvents(outbox, {}, {}, 2);
  assert.equal(page1.events.length, 2);
  assert.ok(page1.nextCursor);

  const page2 = queryTerminalBriefEvents(outbox, {}, { afterId: page1.nextCursor! }, 2);
  assert.equal(page2.events.length, 2);
  assert.ok(page2.nextCursor);

  const page3 = queryTerminalBriefEvents(outbox, {}, { afterId: page2.nextCursor! }, 2);
  assert.equal(page3.events.length, 1);
});

test("queryTerminalBriefEvents filters by parentRoundId", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox, { parentRoundId: "round-a" });
  assert.equal(result.events.length, 3);
  for (const event of result.events) {
    assert.equal(event.parentRoundId, "round-a");
  }
});

test("queryTerminalBriefEvents filters by worker", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox, { worker: "brokeralpha" });
  assert.equal(result.events.length, 2);
  for (const event of result.events) {
    assert.equal(event.worker, "brokeralpha");
  }
});

test("queryTerminalBriefEvents filters by acked status", () => {
  const outbox = seedOutbox();
  const acked = queryTerminalBriefEvents(outbox, { acked: true });
  assert.equal(acked.events.length, 1);
  assert.equal(acked.events[0]!.taskId, "task-1");
  assert.ok(acked.events[0]!.receiptConfirmed);

  const unacked = queryTerminalBriefEvents(outbox, { unacked: true });
  assert.equal(unacked.events.length, 4);
  for (const event of unacked.events) {
    assert.equal(event.receiptConfirmed, false);
  }
});

test("summarizeTerminalBriefInbox separates actionable backlog from projection rows", () => {
  const now = "2026-05-25T09:00:00.000Z";
  const outbox = new TerminalTaskEventOutbox({
    events: [
      makeTerminalEvent("acked-1", {
        receipt: { status: "operator_visible", updatedAt: now, evidence: "operator_visible" },
        ack: { status: "receipt_confirmed", evidence: "operator_visible", acknowledgedAt: now },
      }),
      makeTerminalEvent("provider-only-1", {
        receipt: { status: "provider_accepted", updatedAt: now },
      }),
      makeTerminalEvent("visible-unacked-1", {
        receipt: { status: "operator_visible", updatedAt: now, evidence: "operator_visible" },
      }),
      makeTerminalEvent("projection-1", {
        payload: {
          taskId: "projection-1",
          status: "succeeded",
          createdAt: now,
          updatedAt: now,
          notificationOwnership: {
            ownerBrokerId: "brokeralpha",
            scope: "parent-broker-only",
            providerSendPermittedByProjection: false,
            terminalAckPermittedByProjection: false,
            reason: "projection only",
          },
        },
        receipt: { status: "accepted", updatedAt: now },
      }),
      makeTerminalEvent("failed-1", {
        payload: {
          taskId: "failed-1",
          status: "failed",
          createdAt: now,
          updatedAt: now,
        },
        receipt: { status: "failed", updatedAt: now },
      }),
    ],
  });

  const summary = summarizeTerminalBriefInbox(outbox);
  const unacked = queryTerminalBriefEvents(outbox, { unacked: true });

  assert.equal(summary.total, 5);
  assert.equal(summary.acked, 1);
  assert.equal(summary.rawUnacked, 4);
  assert.equal(summary.actionableUnacked, 3);
  assert.equal(summary.ackEligibleUnacked, 1);
  assert.equal(summary.ackIneligibleProjectionRows, 1);
  assert.equal(summary.providerSendOnlyUnacked, 1);
  assert.equal(summary.erroredUnacked, 1);
  assert.equal(unacked.events.find((event) => event.id === "projection-1")?.ackIneligibleProjection, true);
  assert.equal(unacked.events.find((event) => event.id === "visible-unacked-1")?.ackEligibleUnacked, true);
});

test("queryTerminalBriefEvents filters by errored status", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox, { errored: true });
  // task-3 (failed) and task-5 (canceled) — errors include failed/timed_out/stale
  assert.equal(result.events.length, 2);
});

test("queryTerminalBriefEvents filters by task status", () => {
  const outbox = seedOutbox();
  const succeeded = queryTerminalBriefEvents(outbox, { taskStatus: "succeeded" });
  assert.equal(succeeded.events.length, 3);

  const failed = queryTerminalBriefEvents(outbox, { taskStatus: "failed" });
  assert.equal(failed.events.length, 1);
});

test("queryTerminalBriefEvents enforces limit bounds", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox, {}, {}, 300);
  // Should be capped at TERMINAL_BRIEF_QUERY_MAX_LIMIT (200), but since we
  // only have 5 events, all fit.
  assert.equal(result.events.length, 5);
  // Ensure negative limit defaults to 50
  const negResult = queryTerminalBriefEvents(outbox, {}, {}, -1);
  assert.ok(negResult.events.length <= 50);
});

test("countTerminalBriefEvents returns correct counts", () => {
  const outbox = seedOutbox();
  assert.equal(countTerminalBriefEvents(outbox), 5);
  assert.equal(countTerminalBriefEvents(outbox, { parentRoundId: "round-a" }), 3);
  assert.equal(countTerminalBriefEvents(outbox, { worker: "brokerbeta" }), 1);
});

test("getTerminalBriefEvent returns event by id", () => {
  const outbox = seedOutbox();
  const snapshot = outbox.snapshot();
  const target = snapshot[0]!;
  const result = getTerminalBriefEvent(outbox, target.id);
  assert.ok(result);
  assert.equal(result!.id, target.id);
});

test("getTerminalBriefEvent returns null for unknown id", () => {
  const outbox = seedOutbox();
  const result = getTerminalBriefEvent(outbox, "nonexistent");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Export tests
// ---------------------------------------------------------------------------

test("exportTerminalBriefEvents produces valid JSON", () => {
  const outbox = seedOutbox();
  const json = exportTerminalBriefEvents(outbox, {}, "json");
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 5);
  assert.ok(parsed[0]!.id);
  assert.ok(parsed[0]!.parentRoundId);
});

test("exportTerminalBriefEvents produces compact-round-up format", () => {
  const outbox = seedOutbox();
  const output = exportTerminalBriefEvents(outbox, {}, "compact-round-up");
  assert.ok(output.includes("✅"));
  assert.ok(output.includes("❌"));
  assert.ok(output.includes("○")); // unacked
  assert.ok(output.includes("brokeralpha") || output.includes("workerepsilon") || output.includes("workergamma"));
});

test("exportTerminalBriefEvents produces markdown-summary format", () => {
  const outbox = seedOutbox();
  const output = exportTerminalBriefEvents(outbox, {}, "markdown-summary");
  assert.ok(output.includes("|"));
  assert.ok(output.includes("Worker"));
  assert.ok(output.includes("Status"));
  assert.ok(output.includes("ACK"));
});

test("exportTerminalBriefEvents respects filter and limit", () => {
  const outbox = seedOutbox();
  const output = exportTerminalBriefEvents(outbox, { parentRoundId: "round-a" }, "json", 2);
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 2);
});

test("exportTerminalBriefEvents returns empty indicator for no matches", () => {
  const outbox = seedOutbox();
  const markdown = exportTerminalBriefEvents(outbox, { parentRoundId: "round-nonexistent" }, "markdown-summary");
  assert.ok(markdown.includes("No terminal brief events"));
});

// ---------------------------------------------------------------------------
// Round summary tests
// ---------------------------------------------------------------------------

test("summarizeTerminalBriefRounds groups by parentRoundId", () => {
  const outbox = seedOutbox();
  const summaries = summarizeTerminalBriefRounds(outbox);
  // round-a (3 events), round-b (1), round-c (1)
  assert.equal(summaries.length, 3);

  const roundA = summaries.find((s) => s.parentRoundId === "round-a");
  assert.ok(roundA);
  assert.equal(roundA!.workerCount, 3);
  assert.equal(roundA!.completedCount, 3); // 2 succeeded + 1 failed terminal lane
  assert.equal(roundA!.ackedCount, 1); // task-1 acked
  assert.equal(roundA!.failedCount, 1); // task-3 failed
  assert.equal(roundA!.pendingCount, 0); // failed terminal lanes count as completed progress
  assert.equal(roundA!.isComplete, true); // no observed Terminal Brief rows remain pending
});

test("summarizeTerminalBriefRounds respects maxRounds", () => {
  const outbox = seedOutbox();
  const summaries = summarizeTerminalBriefRounds(outbox, 1);
  assert.equal(summaries.length, 1);
});

// ---------------------------------------------------------------------------
// Worker list tests
// ---------------------------------------------------------------------------

test("listTerminalBriefWorkers returns unique workers", () => {
  const outbox = seedOutbox();
  const workers = listTerminalBriefWorkers(outbox);
  assert.ok(workers.includes("brokeralpha"));
  assert.ok(workers.includes("workerepsilon"));
  assert.ok(workers.includes("workergamma"));
  assert.ok(workers.includes("brokerbeta"));
  assert.equal(workers.length, 4);
});

test("listTerminalBriefWorkers filters by parentRoundId", () => {
  const outbox = seedOutbox();
  const workers = listTerminalBriefWorkers(outbox, { parentRoundId: "round-a" });
  assert.equal(workers.length, 3);
  assert.ok(workers.includes("brokeralpha"));
  assert.ok(workers.includes("workerepsilon"));
  assert.ok(workers.includes("workergamma"));
  assert.equal(workers.includes("brokerbeta"), false);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("empty outbox returns empty results", () => {
  const outbox = new TerminalTaskEventOutbox();
  const result = queryTerminalBriefEvents(outbox);
  assert.equal(result.events.length, 0);
  assert.equal(result.nextCursor, null);
  assert.equal(result.totalMatching, 0);

  const count = countTerminalBriefEvents(outbox);
  assert.equal(count, 0);
});

test("filters with no matches return empty", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox, { worker: "nonexistent" });
  assert.equal(result.events.length, 0);
  assert.equal(result.totalMatching, 0);
});

test("getTerminalBriefEvent fields are populated", () => {
  const outbox = seedOutbox();
  const snapshot = outbox.snapshot();
  const target = snapshot.find((eventTarget) => eventTarget.payload.taskId === "task-1");
  assert.ok(target);
  const result = getTerminalBriefEvent(outbox, target!.id);
  assert.ok(result);
  assert.equal(result!.status, "succeeded");
  assert.equal(result!.receiptConfirmed, true);
  assert.equal(result!.worker, "brokeralpha");
  assert.equal(result!.parentRoundId, "round-a");
});

test("compact-round-up on empty outbox returns fallback", () => {
  const outbox = new TerminalTaskEventOutbox();
  const output = exportTerminalBriefEvents(outbox, {}, "compact-round-up");
  assert.equal(output, "(no events)");
});

test("markdown-summary on empty outbox returns fallback", () => {
  const outbox = new TerminalTaskEventOutbox();
  const output = exportTerminalBriefEvents(outbox, {}, "markdown-summary");
  assert.ok(output.includes("No terminal brief events"));
});

// ---------------------------------------------------------------------------
// Non-mutation guard: read-only query operations must not alter outbox
// ---------------------------------------------------------------------------

test("queryTerminalBriefEvents does not mutate outbox state", () => {
  const outbox = seedOutbox();
  const before = outbox.snapshot().length;
  queryTerminalBriefEvents(outbox);
  queryTerminalBriefEvents(outbox, { unacked: true });
  queryTerminalBriefEvents(outbox, { parentRoundId: "round-a" }, { afterId: "nonexistent" }, 2);
  assert.equal(outbox.snapshot().length, before, "query must not add/remove events");
});

test("countTerminalBriefEvents does not mutate outbox state", () => {
  const outbox = seedOutbox();
  const before = outbox.snapshot().length;
  countTerminalBriefEvents(outbox);
  countTerminalBriefEvents(outbox, { worker: "brokeralpha" });
  countTerminalBriefEvents(outbox, { errored: true });
  assert.equal(outbox.snapshot().length, before, "count must not add/remove events");
});

test("getTerminalBriefEvent does not mutate outbox state", () => {
  const outbox = seedOutbox();
  const before = outbox.snapshot().length;
  const snapshot = outbox.snapshot();
  if (snapshot.length > 0) {
    getTerminalBriefEvent(outbox, snapshot[0]!.id);
  }
  getTerminalBriefEvent(outbox, "nonexistent");
  assert.equal(outbox.snapshot().length, before, "get must not add/remove events");
});

test("summarizeTerminalBriefInbox does not mutate outbox state", () => {
  const outbox = seedOutbox();
  const before = outbox.snapshot().length;
  const summary = summarizeTerminalBriefInbox(outbox);
  assert.equal(outbox.snapshot().length, before, "summarize must not add/remove events");
  // All summary fields are populated from a snapshot, not live state
  assert.equal(summary.kind, "a2a-broker.terminal-brief.inbox-summary");
  assert.ok(summary.notes.length > 0, "summary should include safe-practice notes");
});

test("queryTerminalBriefInbox reuses one outbox snapshot for summary and query", () => {
  const outbox = seedOutbox();
  const originalSnapshot = outbox.snapshot.bind(outbox);
  let snapshotCalls = 0;
  outbox.snapshot = (() => {
    snapshotCalls++;
    return originalSnapshot();
  }) as typeof outbox.snapshot;

  const inbox = queryTerminalBriefInbox(outbox, { unacked: true }, undefined, 2);
  assert.equal(snapshotCalls, 1, "combined inbox query should snapshot once");
  assert.equal(inbox.summary.total, 5);
  assert.equal(inbox.query.events.length, 2);
  assert.equal(inbox.query.totalMatching, 4);
});

test("exportTerminalBriefEvents does not mutate outbox state", () => {
  const outbox = seedOutbox();
  const before = outbox.snapshot().length;
  exportTerminalBriefEvents(outbox, {}, "json");
  exportTerminalBriefEvents(outbox, {}, "compact-round-up");
  exportTerminalBriefEvents(outbox, {}, "markdown-summary");
  exportTerminalBriefEvents(outbox, { parentRoundId: "round-a" }, "json", 2);
  assert.equal(outbox.snapshot().length, before, "export must not add/remove events");
});

test("summarizeTerminalBriefRounds does not mutate outbox state", () => {
  const outbox = seedOutbox();
  const before = outbox.snapshot().length;
  summarizeTerminalBriefRounds(outbox);
  assert.equal(outbox.snapshot().length, before, "round summary must not add/remove events");
});

test("listTerminalBriefWorkers does not mutate outbox state", () => {
  const outbox = seedOutbox();
  const before = outbox.snapshot().length;
  listTerminalBriefWorkers(outbox);
  listTerminalBriefWorkers(outbox, { parentRoundId: "round-b" });
  assert.equal(outbox.snapshot().length, before, "worker listing must not add/remove events");
});

// ---------------------------------------------------------------------------
// Duplicate/replay visibility: idempotent enqueue must not create duplicates
// ---------------------------------------------------------------------------

test("re-enqueuing the same task event returns existing event (no duplicate)", () => {
  const outbox = new TerminalTaskEventOutbox();
  const task = makeTask({
    id: "task-replay",
    status: "succeeded",
    payload: { worker: "brokeralpha", parentRoundId: "round-replay", run: "round-replay" },
  });
  const event = {
    id: 1,
    kind: "succeeded" as const,
    taskId: "task-replay",
    timestamp: new Date().toISOString(),
    status: "succeeded" as const,
    metadata: {},
  };

  // First enqueue
  const first = outbox.enqueue(event, task);
  assert.ok(first, "first enqueue should succeed");

  // Second enqueue with same task — should return existing event, not create duplicate
  const second = outbox.enqueue(event, task);
  assert.ok(second, "re-enqueue should succeed");
  assert.equal(second!.id, first!.id, "re-enqueue must return identical id");

  // Query API must see exactly one event
  const result = queryTerminalBriefEvents(outbox);
  assert.equal(result.events.length, 1, "query must show exactly one event, not duplicate");

  // Summary must show 1 total, 0 acked, 1 raw unacked
  const summary = summarizeTerminalBriefInbox(outbox);
  assert.equal(summary.total, 1);
  assert.equal(summary.rawUnacked, 1);
  assert.equal(summary.actionableUnacked, 1);
});

test("replayed event same idempotency key is not double-counted in inbox summary", () => {
  const outbox = new TerminalTaskEventOutbox();
  const task = makeTask({
    id: "task-replay-2",
    status: "succeeded",
    payload: { worker: "workergamma", parentRoundId: "round-dupe", run: "round-dupe" },
  });
  const event = {
    id: 1,
    kind: "succeeded" as const,
    taskId: "task-replay-2",
    timestamp: new Date().toISOString(),
    status: "succeeded" as const,
    metadata: {},
  };

  // Enqueue multiple times (simulating replay from Gateway)
  outbox.enqueue(event, task);
  outbox.enqueue(event, task);
  outbox.enqueue(event, task);

  // Inbox summary must still report 1 total, not 3
  const summary = summarizeTerminalBriefInbox(outbox);
  assert.equal(summary.total, 1, "replayed duplicates must not inflate inbox count");
  assert.equal(summary.rawUnacked, 1, "replayed duplicates must not inflate unacked count");
  assert.equal(summary.ackIneligibleProjectionRows, 0, "no projection rows for local re-enqueue");

  // Cursor state: latestCursor must point to the single event
  assert.ok(summary.latestCursor, "latestCursor must be present");
  assert.equal(summary.latestCursor, outbox.snapshot()[0]!.id, "latestCursor must match the single event id");
});

test("cross-broker projection re-enqueue is idempotent in query output", () => {
  const outbox = new TerminalTaskEventOutbox();
  const projection = {
    id: "proj-1",
    parentRoundId: "round-proj-replay",
    originBrokerId: "brokeralpha",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "child-1",
    childWorkerId: "workerbeta",
    status: "succeeded" as const,
    completedAt: new Date().toISOString(),
    emittedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    sourceDigest: "sha256-fake",
    replayCount: 0,
    ack: {
      decision: "accepted" as const,
      terminalAck: false as const,
      reason: "accepted via idempotent projection store",
      updatedAt: new Date().toISOString(),
    },
  };

  // First enqueue
  const first = outbox.enqueueCrossBrokerProjection(projection);
  assert.ok(first, "first projection enqueue should succeed");

  // Re-enqueue same projection (simulating replay/retransmission)
  const second = outbox.enqueueCrossBrokerProjection(projection);
  assert.ok(second, "re-enqueue of same projection should succeed (idempotent)");
  assert.equal(second!.id, first!.id, "re-enqueued projection must have the same id");

  // Query must see the evidence-only projection plus the materialized
  // operator-facing row, without duplicating either on replay.
  const result = queryTerminalBriefEvents(outbox);
  assert.equal(result.events.length, 2, "replayed projection must not create duplicate query rows");

  const projectionRow = result.events.find((event) => event.ackIneligibleProjection);
  const operatorRow = result.events.find((event) => event.id.includes("cross-broker-operator"));
  assert.ok(projectionRow, "projection row must be present");
  assert.ok(operatorRow, "operator-facing row must be present");
  assert.equal(projectionRow.ackIneligibleProjection, true, "projection row must be ack-ineligible");
  assert.equal(projectionRow.actionableUnacked, false, "projection must not be actionable");
  assert.equal(operatorRow.ackIneligibleProjection, false, "operator-facing row must be ACK-eligible");
  assert.equal(operatorRow.actionableUnacked, true, "operator-facing row must be actionable");

  // Inbox summary must separate the projection row from the actionable row.
  const summary = summarizeTerminalBriefInbox(outbox);
  assert.equal(summary.total, 2, "replayed projection must not inflate inbox count");
  assert.equal(summary.ackIneligibleProjectionRows, 1, "projection must be counted as ack-ineligible");
  assert.equal(summary.actionableUnacked, 1, "operator-facing row must appear in actionable backlog");
  assert.equal(summary.rawUnacked, 2, "projection and operator-facing rows are raw unacked");
});

test("replayed event after ACK shows correct receipt state", () => {
  const outbox = new TerminalTaskEventOutbox();
  const task = makeTask({
    id: "task-ack-replay",
    status: "succeeded",
    payload: { worker: "brokerbeta", parentRoundId: "round-ack-rp", run: "round-ack-rp" },
  });
  const event = {
    id: 1,
    kind: "succeeded" as const,
    taskId: "task-ack-replay",
    timestamp: new Date().toISOString(),
    status: "succeeded" as const,
    metadata: {},
  };

  const added = outbox.enqueue(event, task);
  assert.ok(added);

  // ACK the event
  outbox.acknowledge(added!.id, {
    evidence: "operator_visible",
    acknowledgedAt: new Date().toISOString(),
  });

  // Re-enqueue same event (simulating replay after ACK)
  const replayResult = outbox.enqueue(event, task);
  assert.ok(replayResult, "re-enqueue after ACK should still return event");
  assert.equal(replayResult!.id, added!.id, "re-enqueue must return same id");

  // Query must show acked status
  const result = queryTerminalBriefEvents(outbox);
  assert.equal(result.events.length, 1, "replay after ACK must not create duplicate");
  assert.equal(result.events[0]!.receiptConfirmed, true, "event must remain receipt-confirmed after replay");

  // Summary must still show 1 acked
  const summary = summarizeTerminalBriefInbox(outbox);
  assert.equal(summary.total, 1);
  assert.equal(summary.acked, 1);
  assert.equal(summary.rawUnacked, 0);
});

test("totalMatching and cursor are consistent across query pagination", () => {
  const outbox = seedOutbox();
  const page1 = queryTerminalBriefEvents(outbox, {}, {}, 2);
  assert.ok(page1.nextCursor, "first page must have cursor");

  const page2 = queryTerminalBriefEvents(outbox, {}, { afterId: page1.nextCursor! }, 2);
  assert.ok(page2.nextCursor, "second page must have cursor");

  const page3 = queryTerminalBriefEvents(outbox, {}, { afterId: page2.nextCursor! }, 2);
  // The cursor is always the last returned event's id, even on the last page
  // (the consumer uses cursor + afterId to detect exhaustion)
  assert.ok(page3.nextCursor, "last page cursor is the last event id");

  // Verify exhaustion: querying beyond the last event returns zero events
  const exhausted = queryTerminalBriefEvents(outbox, {}, { afterId: page3.nextCursor! }, 2);
  assert.equal(exhausted.events.length, 0, "beyond-last cursor must yield empty page");

  // totalMatching is consistent across pages
  assert.equal(page1.totalMatching, page2.totalMatching, "totalMatching must be stable across pagination");
  assert.equal(page2.totalMatching, page3.totalMatching, "totalMatching must be stable across all pages");

  // Sum of page sizes equals total (for small dataset)
  const totalReturned = page1.events.length + page2.events.length + page3.events.length;
  assert.equal(totalReturned, page1.totalMatching, "sum of page entries must equal totalMatching");
});

test("inbox summary latestCursor reflects the last outbox event", () => {
  const outbox = seedOutbox();
  const snapshot = outbox.snapshot();
  const summary = summarizeTerminalBriefInbox(outbox);
  const lastEvent = snapshot.at(-1);
  assert.ok(lastEvent, "must have at least one event");
  assert.equal(summary.latestCursor, lastEvent!.id, "latestCursor must match the last event id");

  // Cursor must be a valid non-empty string
  assert.ok(typeof summary.latestCursor === "string" && summary.latestCursor.length > 0, "latestCursor must be a non-empty string");
});

test("inbox summary includes all receipt status and task status breakdowns", () => {
  const outbox = new TerminalTaskEventOutbox({
    events: [
      makeTerminalEvent("e-started", { receipt: { status: "started", updatedAt: new Date().toISOString() } }),
      makeTerminalEvent("e-produced", { receipt: { status: "produced", updatedAt: new Date().toISOString() } }),
      makeTerminalEvent("e-stale", { receipt: { status: "stale", updatedAt: new Date().toISOString() } }),
      makeTerminalEvent("e-timedout", { receipt: { status: "timed_out", updatedAt: new Date().toISOString() } }),
      makeTerminalEvent("e-visible", {
        receipt: { status: "operator_visible", updatedAt: new Date().toISOString(), evidence: "operator_visible" },
      }),
    ],
  });

  const summary = summarizeTerminalBriefInbox(outbox);
  assert.equal(summary.total, 5);
  assert.equal(summary.rawUnacked, 5);

  // byReceiptStatus must have all five distinct statuses
  assert.ok(Object.keys(summary.byReceiptStatus).length >= 4, "must have multiple receipt statuses");

  // byTaskStatus must be populated
  assert.ok(Object.keys(summary.byTaskStatus).length >= 1, "must have task status breakdown");
  assert.ok(summary.byTaskStatus.succeeded, "must have succeeded task status count");
});
