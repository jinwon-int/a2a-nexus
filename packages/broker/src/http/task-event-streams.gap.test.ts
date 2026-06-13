import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { InMemoryA2ABroker } from "../core/broker.js";
import {
  handleTaskEventStream,
  handleWorkerAssignmentEventStream,
} from "./task-event-streams.js";
import { handleOperatorEventStream } from "./operator-events.js";

// Minimal req/res doubles that capture the SSE bytes the handler writes.
function makeReqRes(headers: Record<string, string> = {}) {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = headers;

  const chunks: string[] = [];
  const res = {
    writableEnded: false,
    writeHead() {},
    flushHeaders() {},
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  return { req, res: res as unknown as ServerResponse<IncomingMessage>, chunks };
}

function parseSse(chunks: string[]): Array<{ event: string; data: string; id?: string }> {
  const text = chunks.join("");
  const events: Array<{ event: string; data: string; id?: string }> = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    let event: string | undefined;
    let data: string | undefined;
    let id: string | undefined;
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data = line.slice("data: ".length);
      else if (line.startsWith("id: ")) id = line.slice("id: ".length);
    }
    if (event) events.push({ event, data: data ?? "", id });
  }
  return events;
}

function registerWorker(broker: InMemoryA2ABroker, nodeId = "worker-1"): void {
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

test("task event stream delivers an update emitted in the snapshot→subscribe gap exactly once (#660)", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-1");
  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-1", kind: "node", role: "operator" },
    message: "race probe",
    payload: {},
  });

  const { req, res, chunks } = makeReqRes();
  handleTaskEventStream(req, res, {
    broker,
    task,
    heartbeatMs: 0,
    // Emit a live update at the exact snapshot→subscribe boundary. With the
    // pre-fix ordering the subscription was not yet registered and this update
    // was dropped.
    afterSnapshot: () => {
      broker.claimTask(task.id, "worker-1");
    },
  });

  const events = parseSse(chunks);
  assert.ok(events.some((e) => e.event === "task-snapshot"), "snapshot must open the stream");
  const updates = events.filter((e) => e.event === "task-status-update");
  assert.equal(updates.length, 1, "the gap update is delivered exactly once (not dropped, not duplicated)");
  assert.equal(JSON.parse(updates[0]!.data).reason, "claimed");
});

test("worker-assignment stream delivers an assignment emitted in the snapshot→subscribe gap (#660)", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-1");

  const { req, res, chunks } = makeReqRes();
  handleWorkerAssignmentEventStream(req, res, {
    broker,
    workerId: "worker-1",
    heartbeatMs: 0,
    afterSnapshot: () => {
      broker.createTask({
        intent: "analyze",
        requester: { id: "hub", kind: "node", role: "hub" },
        target: { id: "worker-1", kind: "node", role: "operator" },
        assignedWorkerId: "worker-1",
        message: "gap assignment",
        payload: {},
      });
    },
  });

  const events = parseSse(chunks);
  assert.ok(events.some((e) => e.event === "worker-assignment-snapshot"), "snapshot must open the stream");
  const assignments = events.filter((e) => e.event === "worker-assignment");
  assert.equal(assignments.length, 1, "the gap assignment is delivered exactly once");
});

test("operator stream delivers an event emitted in the snapshot→subscribe gap exactly once (#660)", () => {
  let seq = 0;
  const listeners = new Set<(event: { seq: number; event: string; data: unknown }) => void>();
  const emit = (data: unknown) => {
    seq += 1;
    const ev = { seq, event: "operator-event", data };
    for (const listener of listeners) listener(ev);
    return ev;
  };

  const { req, res, chunks } = makeReqRes();
  handleOperatorEventStream(req, res, {
    currentSnapshot: () => ({ summary: { queue: { total: 0 } } }) as never,
    replayEvents: () => [],
    subscribe: (listener) => {
      listeners.add(listener as never);
      return () => listeners.delete(listener as never);
    },
    replayWindow: () => ({ oldestBufferedSeq: null, currentSeq: seq }),
    heartbeatMs: 0,
    afterSnapshot: () => {
      emit({ hello: "gap" });
    },
  });

  const events = parseSse(chunks);
  assert.ok(events.some((e) => e.event === "operator-snapshot"), "snapshot must open the stream");
  const ops = events.filter((e) => e.event === "operator-event");
  assert.equal(ops.length, 1, "the gap event is delivered exactly once");
});
