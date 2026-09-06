// Regression tests for the unified parent-round progress implementation (B6).
//
// Before unification `applyRoundProgressMetadata` existed twice — in
// task-event-stream.ts and terminal-event-outbox.ts — with different guards and
// separate counter Maps, so the SSE compact terminal event and the Terminal
// Brief outbox could report different numerators for the same round.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import {
  RoundProgressTracker,
  applyRoundProgressMetadata,
} from "./round-progress-tracker.js";

function registerWorker(broker: InMemoryA2ABroker, nodeId: string): void {
  broker.registerWorker({
    nodeId,
    role: "operator",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default"],
      environments: ["research"],
    },
  });
}

function createRoundTask(
  broker: InMemoryA2ABroker,
  id: string,
  worker: string,
  payload: Record<string, unknown>,
) {
  return broker.createTask({
    id,
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: worker, kind: "node", role: "operator" },
    payload,
  });
}

describe("round progress parity between SSE stream and Terminal Brief outbox", () => {
  it("reports identical n/N on both surfaces for the same round", () => {
    const broker = new InMemoryA2ABroker();
    const workers = ["worker-1", "worker-2", "worker-3"];
    for (const worker of workers) registerWorker(broker, worker);

    workers.forEach((worker, index) => {
      const task = createRoundTask(broker, `round-child-${index + 1}`, worker, {
        parentRoundId: "shared-round",
        parentRoundTotal: 3,
      });
      broker.claimTask(task.id, worker);
      if (index === 1) {
        broker.failTask(task.id, worker, { message: "lane failed" });
      } else {
        broker.completeTask(task.id, worker, { summary: `child ${index + 1} done` });
      }
    });

    const streamEvents = broker.getTaskEventStream().subscribeTerminal();
    const outboxEvents = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(streamEvents.length, 3);
    assert.equal(outboxEvents.length, 3);

    const streamProgress = streamEvents.map((event) => ({
      taskId: event.taskId,
      progress: event.parentRoundProgress,
      terminalProgress: event.parentRoundTerminalProgress,
      total: event.parentRoundTotal,
    }));
    const outboxProgress = outboxEvents.map((event) => ({
      taskId: event.payload.taskId,
      progress: event.payload.parentRoundProgress,
      terminalProgress: event.payload.parentRoundTerminalProgress,
      total: event.payload.parentRoundTotal,
    }));

    assert.deepEqual(streamProgress, outboxProgress);
    assert.deepEqual(
      outboxProgress.map((entry) => entry.progress),
      [1, 2, 3],
    );
  });

  it("keeps both surfaces in step after a restart that restores the outbox", () => {
    const workers = ["worker-1", "worker-2", "worker-3"];
    const first = new InMemoryA2ABroker();
    for (const worker of workers) registerWorker(first, worker);
    workers.slice(0, 2).forEach((worker, index) => {
      const task = createRoundTask(first, `restart-child-${index + 1}`, worker, {
        parentRoundId: "restart-round",
        parentRoundTotal: 3,
      });
      first.claimTask(task.id, worker);
      first.completeTask(task.id, worker, { summary: `child ${index + 1} done` });
    });

    // Restart: only the persisted snapshot survives. Before unification the
    // stream counter restarted at zero while the outbox rebuilt from the
    // snapshot, so SSE and Terminal Brief disagreed on the numerator.
    const restarted = new InMemoryA2ABroker(undefined, first.exportSnapshot());
    for (const worker of workers) registerWorker(restarted, worker);
    const last = createRoundTask(restarted, "restart-child-3", "worker-3", {
      parentRoundId: "restart-round",
      parentRoundTotal: 3,
    });
    restarted.claimTask(last.id, "worker-3");
    restarted.completeTask(last.id, "worker-3", { summary: "child 3 done" });

    const streamEvent = restarted.getTaskEventStream().subscribeTerminal().at(-1);
    const outboxEvent = restarted.getTerminalTaskEventOutbox().subscribe().at(-1);
    assert.equal(outboxEvent?.payload.taskId, "restart-child-3");
    assert.equal(streamEvent?.taskId, "restart-child-3");
    assert.equal(outboxEvent?.payload.parentRoundProgress, 3);
    assert.equal(streamEvent?.parentRoundProgress, outboxEvent?.payload.parentRoundProgress);
  });

  it("omits progress when the round total is unknown or zero (outbox semantics)", () => {
    const tracker = new RoundProgressTracker();
    const withoutTotal: Record<string, unknown> = { taskId: "t1", run: "r1" };
    applyRoundProgressMetadata(withoutTotal as never, tracker);
    assert.equal(withoutTotal["parentRoundProgress"], undefined);
    // The counter still advanced, so the next lane with a known total is 2/2.
    const withTotal: Record<string, unknown> = { taskId: "t2", run: "r1", parentRoundTotal: 2 };
    applyRoundProgressMetadata(withTotal as never, tracker);
    assert.equal(withTotal["parentRoundProgress"], 2);

    const zeroTotal: Record<string, unknown> = { taskId: "t3", run: "r2", parentRoundTotal: 0 };
    applyRoundProgressMetadata(zeroTotal as never, tracker);
    assert.equal(zeroTotal["parentRoundProgress"], undefined, "never render n/0");
  });

  it("keeps parent lane order for parent-owned handoff rows", () => {
    const tracker = new RoundProgressTracker();
    const payload: Record<string, unknown> = {
      taskId: "handoff-child",
      run: "handoff-round",
      parentRoundTotal: 2,
      parentRoundOrder: 2,
      parentRoundProgressSource: "parent_round_order",
    };
    applyRoundProgressMetadata(payload as never, tracker);
    assert.equal(payload["parentRoundProgress"], 2);
    assert.equal(payload["parentRoundTerminalProgress"], 2);
  });

  it("counts each child once regardless of how many surfaces record it", () => {
    const tracker = new RoundProgressTracker();
    assert.equal(tracker.record("run", "task-a"), 1);
    assert.equal(tracker.record("run", "task-a"), 1);
    assert.equal(tracker.record("run", "task-b"), 2);
  });
});

describe("RoundProgressTracker bounds", () => {
  it("caps the number of retained run keys (least-recently-touched evicted)", () => {
    const tracker = new RoundProgressTracker({ maxRuns: 3 });
    for (let index = 0; index < 10; index += 1) {
      tracker.record(`run-${index}`, `task-${index}`);
    }
    assert.equal(tracker.size, 3);
    assert.equal(tracker.evictions, 7);
    assert.equal(tracker.count("run-0"), 0, "oldest run evicted");
    assert.equal(tracker.count("run-9"), 1, "newest run retained");
  });

  it("caps the child ids retained per run while keeping the observed count", () => {
    const tracker = new RoundProgressTracker({ maxChildrenPerRun: 2 });
    tracker.record("run", "a");
    tracker.record("run", "b");
    assert.equal(tracker.record("run", "c"), 3);
    assert.equal(tracker.size, 1);
  });

  it("evicts run keys after the idle TTL", () => {
    let now = 1_000;
    const tracker = new RoundProgressTracker({ ttlMs: 100, now: () => now });
    tracker.record("stale-run", "task-a");
    assert.equal(tracker.count("stale-run"), 1);
    now += 1_000;
    tracker.record("fresh-run", "task-b");
    assert.equal(tracker.count("stale-run"), 0);
    assert.equal(tracker.count("fresh-run"), 1);
    assert.equal(tracker.size, 1);
  });

  it("merges persisted rows additively on snapshot restore", () => {
    const tracker = new RoundProgressTracker();
    tracker.record("run", "live-child");
    tracker.mergeFrom([
      { run: "run", taskId: "restored-child" },
      { run: "run", taskId: "live-child" },
      { taskId: "no-run-child" },
    ]);
    assert.equal(tracker.count("run"), 2);
  });
});
