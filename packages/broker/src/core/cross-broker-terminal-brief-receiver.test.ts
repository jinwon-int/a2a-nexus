import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCrossBrokerTerminalBriefProjectionFromEvent,
  pollCrossBrokerTerminalBriefReceiver,
  type CrossBrokerTerminalBriefReceiverFetch,
} from "./cross-broker-terminal-brief-receiver.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";

const CONFIG = {
  sourceBrokerId: "gwakga",
  sourceBaseUrl: "http://127.0.0.1:8799",
  destinationBrokerId: "seoseo",
  destinationBaseUrl: "http://127.0.0.1:8787",
  edgeSecret: "test-edge-secret",
  cursor: "terminal:old",
  limit: 25,
  reconcileUnacked: true,
};

function event(overrides: Partial<TerminalTaskOutboxEvent> = {}): TerminalTaskOutboxEvent {
  return {
    id: "terminal:gwakga-child-1",
    kind: "task.terminal",
    taskEventId: 42,
    createdAt: "2026-06-02T13:00:00.000Z",
    receipt: { status: "accepted", updatedAt: "2026-06-02T13:00:00.000Z" },
    attempts: 0,
    payload: {
      taskId: "gwakga-child-1",
      status: "succeeded",
      parentRoundId: "seoseo-parent-round",
      originBrokerId: "seoseo",
      brokerOfRecordId: "seoseo",
      run: "seoseo-parent-round",
      taskDescription: "Team2 child finished",
      worker: "jingun",
      taskBrief: "Cross-broker child",
      doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/1206#issuecomment-done",
      testSummary: "Team2 child completed safely",
      createdAt: "2026-06-02T12:59:00.000Z",
      updatedAt: "2026-06-02T13:00:00.000Z",
      completedAt: "2026-06-02T13:00:00.000Z",
      parentRoundTotal: 8,
      parentRoundOrder: 6,
      terminalBriefTitle: "A2A Terminal Brief 완료: jingun(완료 6/8)",
      crossBrokerHandoff: {
        parentRoundId: "seoseo-parent-round",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        originTaskId: "seoseo-parent-task-1",
        childWorkerId: "jingun",
      },
      notificationOwnership: {
        ownerBrokerId: "seoseo",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
        reason: "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
      },
    },
    ...overrides,
  };
}

test("buildCrossBrokerTerminalBriefProjectionFromEvent maps child broker event to parent projection", () => {
  const projection = buildCrossBrokerTerminalBriefProjectionFromEvent(event(), CONFIG);

  assert.deepEqual(projection, {
    parentRoundId: "seoseo-parent-round",
    originBrokerId: "gwakga",
    brokerOfRecordId: "seoseo",
    childTaskId: "gwakga-child-1",
    childRunId: "seoseo-parent-round",
    childWorkerId: "jingun",
    status: "succeeded",
    summary: "Team2 child completed safely",
    taskBrief: "Cross-broker child",
    terminalBriefTitle: "A2A Terminal Brief 완료: jingun(완료 6/8)",
    evidenceUrl: "https://github.com/jinwon-int/a2a-broker/issues/1206#issuecomment-done",
    completedAt: "2026-06-02T13:00:00.000Z",
    emittedAt: "2026-06-02T13:00:00.000Z",
    parentRoundTotal: 8,
    parentRoundOrder: 6,
    terminalAck: false,
  });
});

test("pollCrossBrokerTerminalBriefReceiver posts parent-owned child events and advances cursor on success", async () => {
  const calls: Array<{ url: string; headers?: Record<string, string>; body?: string }> = [];
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers, body: init?.body });
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [event()], cursor: "terminal:gwakga-child-1" });
    }
    return jsonResponse(202, { accepted: true, replayed: false, ack: { decision: "accepted" } });
  };

  const result = await pollCrossBrokerTerminalBriefReceiver(CONFIG, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(result.fetched, 1);
  assert.equal(result.posted, 1);
  assert.equal(result.accepted, 1);
  assert.equal(result.cursorToPersist, "terminal:gwakga-child-1");
  assert.match(calls[0].url, /after_id=terminal%3Aold/);
  assert.match(calls[0].url, /reconcile_unacked=true/);
  assert.match(calls[1].url, /\/a2a\/cross-broker\/terminal-briefs$/);
  assert.equal(JSON.parse(calls[1].body ?? "{}").originBrokerId, "gwakga");
});

test("pollCrossBrokerTerminalBriefReceiver can authenticate source and destination with separate edge secrets", async () => {
  const calls: Array<{ url: string; headers?: Record<string, string>; body?: string }> = [];
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers, body: init?.body });
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [event()], cursor: "terminal:gwakga-child-1" });
    }
    return jsonResponse(202, { accepted: true, replayed: false, ack: { decision: "accepted" } });
  };

  const result = await pollCrossBrokerTerminalBriefReceiver({
    ...CONFIG,
    edgeSecret: "legacy-fallback-secret",
    sourceEdgeSecret: "gwakga-source-secret",
    destinationEdgeSecret: "seoseo-destination-secret",
  }, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(calls[0].headers?.["x-a2a-edge-secret"], "gwakga-source-secret");
  assert.equal(calls[1].headers?.["x-a2a-edge-secret"], "seoseo-destination-secret");
});

test("pollCrossBrokerTerminalBriefReceiver ignores non-parent-owned events but keeps source cursor", async () => {
  const localEvent = event({
    id: "terminal:local",
    payload: {
      ...event().payload,
      notificationOwnership: undefined,
      crossBrokerHandoff: undefined,
      brokerOfRecordId: "gwakga",
    },
  });
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url) => {
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [localEvent], cursor: "terminal:local" });
    }
    throw new Error("destination should not be called");
  };

  const result = await pollCrossBrokerTerminalBriefReceiver(CONFIG, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(result.ignored, 1);
  assert.equal(result.posted, 0);
  assert.equal(result.cursorToPersist, "terminal:local");
});

test("pollCrossBrokerTerminalBriefReceiver does not advance cursor on missing parent", async () => {
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url) => {
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [event()], cursor: "terminal:gwakga-child-1" });
    }
    return jsonResponse(404, {
      accepted: false,
      ack: {
        code: "missing_parent",
        reason: "parent round seoseo-parent-round is not present on this broker",
      },
    });
  };

  const result = await pollCrossBrokerTerminalBriefReceiver(CONFIG, fetchImpl);

  assert.equal(result.ok, false);
  assert.equal(result.posted, 1);
  assert.equal(result.cursorToPersist, "terminal:old");
  assert.deepEqual(result.blocked, [{
    eventId: "terminal:gwakga-child-1",
    code: "missing_parent",
    reason: "parent round seoseo-parent-round is not present on this broker",
  }]);
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}
