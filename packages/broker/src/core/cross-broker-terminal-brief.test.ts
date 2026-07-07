import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import { emptySnapshot, type BrokerSnapshot, type BrokerStateStore } from "./store.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";

function isProjectionRow(event: TerminalTaskOutboxEvent): boolean {
  return event.payload.notificationOwnership?.terminalAckPermittedByProjection === false;
}

function projectionRows(events: TerminalTaskOutboxEvent[]): TerminalTaskOutboxEvent[] {
  return events.filter(isProjectionRow);
}

function operatorRows(events: TerminalTaskOutboxEvent[]): TerminalTaskOutboxEvent[] {
  return events.filter((event) => event.id.includes("cross-broker-operator"));
}

function assertProjectionOwnership(event: TerminalTaskOutboxEvent | undefined, ownerBrokerId: string): asserts event is TerminalTaskOutboxEvent {
  assert.ok(event);
  assert.deepEqual(event.payload.notificationOwnership, {
    ownerBrokerId,
    scope: "parent-broker-only",
    providerSendPermittedByProjection: false,
    terminalAckPermittedByProjection: false,
    reason: "cross-broker projection rows are aggregation evidence only; provider send and terminal ACK belong to a separate parent-broker operator-facing Terminal Brief row",
  });
}

function assertOperatorFacingRow(event: TerminalTaskOutboxEvent | undefined): asserts event is TerminalTaskOutboxEvent {
  assert.ok(event);
  assert.equal(event.payload.notificationOwnership, undefined);
  assert.equal(event.receipt.status, "accepted");
  assert.equal(event.ack, undefined);
  assert.equal(event.attempts, 0);
  assert.equal(event.ackAudit?.decision, "pending");
  assert.match(event.ackAudit?.reason ?? "", /operator-facing Terminal Brief row/);
}

function registerWorker(broker: InMemoryA2ABroker, nodeId = "worker-child"): void {
  broker.registerWorker({
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
}

function createParentRound(broker: InMemoryA2ABroker, id = "round-parent"): void {
  registerWorker(broker);
  broker.createTask({
    id,
    intent: "chat",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-child", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-child",
    message: `parent ${id}`,
  });
}

function projection(overrides: Partial<Parameters<InMemoryA2ABroker["ingestCrossBrokerTerminalBriefProjection"]>[0]> = {}) {
  return {
    parentRoundId: "round-parent",
    originBrokerId: "child-broker-a",
    brokerOfRecordId: "parent-broker",
    childTaskId: "child-task-1",
    parentRoundTotal: "5",
    parentRoundOrder: "1",
    status: "succeeded" as const,
    summary: "child completed safely",
    taskBrief: "minimal safe patch",
    evidenceUrl: "https://github.com/acme/example/issues/1#issuecomment-done",
    completedAt: "2026-05-13T01:00:00.000Z",
    emittedAt: "2026-05-13T01:00:01.000Z",
    ...overrides,
  };
}

test("cross-broker Terminal Brief ingest is idempotent by parentRoundId/originBrokerId", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const first = broker.ingestCrossBrokerTerminalBriefProjection(projection());
  assert.equal(first.accepted, true);
  assert.equal(first.replayed, false);
  assert.equal(first.ack.terminalAck, false);

  const replay = broker.ingestCrossBrokerTerminalBriefProjection(projection());
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.ack.decision, "duplicate_replay");
  assert.equal(replay.record.replayCount, 1);

  const records = broker.listCrossBrokerTerminalBriefProjections({ parentRoundId: "round-parent" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.originBrokerId, "child-broker-a");

  const allTerminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  const terminalEvents = projectionRows(allTerminalEvents);
  const operatorEvents = operatorRows(allTerminalEvents);
  assert.equal(terminalEvents.length, 1);
  assert.equal(operatorEvents.length, 1);
  assert.equal(terminalEvents[0]?.payload.taskId, "child-task-1");
  assert.equal(operatorEvents[0]?.payload.taskId, "child-task-1");
  assertOperatorFacingRow(operatorEvents[0]);
  assert.equal(terminalEvents[0]?.payload.worker, "child-broker-a");
  assert.equal(terminalEvents[0]?.payload.run, "round-parent");
  assert.equal(terminalEvents[0]?.payload.parentRoundTotal, 5);
  assert.equal(terminalEvents[0]?.payload.parentRoundOrder, 1);
  assert.equal(terminalEvents[0]?.payload.parentRoundProgress, 1);
  assert.equal(terminalEvents[0]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: child-broker-a(완료 1/5)");
  assert.equal(terminalEvents[0]?.payload.status, "succeeded");
  assert.equal(terminalEvents[0]?.payload.testSummary, "child completed safely");
  assert.equal(terminalEvents[0]?.payload.doneUrl, "https://github.com/acme/example/issues/1#issuecomment-done");
  assert.deepEqual(terminalEvents[0]?.payload.crossBrokerHandoff, {
    parentRoundId: "round-parent",
    originBrokerId: "parent-broker",
    handoffBrokerId: "child-broker-a",
    originTaskId: "child-task-1",
  });
  assertProjectionOwnership(terminalEvents[0], "parent-broker");
  assert.equal(terminalEvents[0]?.ackAudit?.decision, "pending");
  assert.match(terminalEvents[0]?.ackAudit?.reason ?? "", /evidence only/);

  broker.ingestCrossBrokerTerminalBriefProjection(projection());
  assert.equal(broker.getTerminalTaskEventOutbox().subscribe().length, 2, "duplicate projection must not duplicate parent Terminal Brief output");
});

test("cross-broker Terminal Brief projection preserves the rendered handoff title line for parent notifier", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    childWorkerId: "workerzeta",
    parentRoundTotal: "3",
    parentRoundOrder: "2",
    terminalBriefTitle: "A2A Terminal Brief 완료: workerzeta(완료 2/3)",
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.record.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 2/3)");
  assert.equal(Object.hasOwn(result.record, "terminalBriefText"), false);

  const [terminalEvent] = projectionRows(broker.getTerminalTaskEventOutbox().subscribe());
  assert.equal(terminalEvent?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 2/3)");
  assert.equal(terminalEvent?.payload.title, "A2A Terminal Brief 완료: workerzeta(완료 2/3)");
  assert.equal(Object.hasOwn(terminalEvent?.payload ?? {}, "terminalBriefText"), false);
  assert.equal(Object.hasOwn(terminalEvent?.payload ?? {}, "terminalBriefTemplate"), false);
});

test("cross-broker Terminal Brief ingest rejects wrong-origin packets", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ brokerOfRecordId: "other-parent" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "wrong_origin");
  assert.equal(result.ack.terminalAck, false);
  assert.equal(broker.listCrossBrokerTerminalBriefProjections().length, 0);
});

test("cross-broker Terminal Brief ingest rejects missing parent rounds", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  registerWorker(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundId: "missing-round" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_parent");
  assert.equal(result.ack.terminalAck, false);
});

test("cross-broker Terminal Brief ingest rejects stale replay over a newer aggregate", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const newer = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    summary: "newer child terminal state",
    completedAt: "2026-05-13T02:00:00.000Z",
    emittedAt: "2026-05-13T02:00:01.000Z",
  }));
  assert.equal(newer.accepted, true);

  const stale = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    summary: "stale overwrite attempt",
    completedAt: "2026-05-13T01:30:00.000Z",
    emittedAt: "2026-05-13T01:30:01.000Z",
  }));
  assert.equal(stale.accepted, false);
  assert.equal(stale.ack.code, "stale_replay");

  const stored = broker.getCrossBrokerTerminalBriefProjection("round-parent", "child-broker-a");
  assert.equal(stored?.summary, "newer child terminal state");
});

test("cross-broker Terminal Brief projection carries parent round denominator into outbox progress", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const knownTotal = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "parent-broker",
    childWorkerId: "workerepsilon",
    parentRoundTotal: "7",
    parentRoundOrder: "5",
  }));
  assert.equal(knownTotal.accepted, true);
  assert.equal(knownTotal.record.parentRoundTotal, 7);
  assert.equal(knownTotal.record.childWorkerId, "workerepsilon");

  const secondTotal = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "child-broker-b",
    childTaskId: "child-task-2",
    childWorkerId: "workerbeta",
    parentRoundTotal: "3",
    parentRoundOrder: "2",
    completedAt: "2026-05-13T01:05:00.000Z",
    emittedAt: "2026-05-13T01:05:01.000Z",
  }));
  assert.equal(secondTotal.accepted, true);
  assert.equal(secondTotal.record.parentRoundTotal, 3);

  const allTerminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(operatorRows(allTerminalEvents).length, 2);
  const terminalEvents = projectionRows(allTerminalEvents);
  assert.equal(terminalEvents.length, 2);
  assert.equal(terminalEvents[0]?.payload.parentRoundId, "round-parent");
  assert.equal(terminalEvents[0]?.payload.originBrokerId, "brokerbeta");
  assert.equal(terminalEvents[0]?.payload.brokerOfRecordId, "parent-broker");
  assert.equal(terminalEvents[0]?.payload.run, "round-parent");
  assert.equal(terminalEvents[0]?.payload.worker, "workerepsilon");
  assert.equal(terminalEvents[0]?.payload.parentRoundTotal, 7);
  assert.equal(terminalEvents[0]?.payload.parentRoundOrder, 5);
  assert.equal(terminalEvents[0]?.payload.parentRoundProgress, 1);
  assert.equal(terminalEvents[0]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerepsilon(완료 5/7)");
  assert.equal(terminalEvents[0]?.payload.title, "A2A Terminal Brief 완료: workerepsilon(완료 5/7)");
  assert.deepEqual(terminalEvents[0]?.payload.crossBrokerHandoff, {
    parentRoundId: "round-parent",
    originBrokerId: "parent-broker",
    handoffBrokerId: "brokerbeta",
    originTaskId: "child-task-1",
    childWorkerId: "workerepsilon",
  });
  assertProjectionOwnership(terminalEvents[0], "parent-broker");
  assert.equal(terminalEvents[1]?.payload.run, "round-parent");
  assert.equal(terminalEvents[1]?.payload.worker, "workerbeta");
  assert.equal(terminalEvents[1]?.payload.parentRoundTotal, 3);
  assert.equal(terminalEvents[1]?.payload.parentRoundProgress, 2);
  assert.equal(terminalEvents[1]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerbeta(완료 2/3)");
});

test("brokeralpha-origin parent keeps distinct brokerbeta handoff children and explicit order", () => {
  const parentRoundId = "a2a-r13-terminal-brief-realround-20260514T013556Z";
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRound(broker, parentRoundId);

  const workerepsilon = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId,
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: parentRoundId + "-05-workerepsilon",
    childWorkerId: "workerepsilon",
    parentRoundTotal: 7,
    parentRoundOrder: 5,
    summary: "workerepsilon completed brokerbeta handoff evidence for brokeralpha parent",
  }));
  const workerzeta = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId,
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: parentRoundId + "-06-workerzeta",
    childWorkerId: "workerzeta",
    parentRoundTotal: 7,
    parentRoundOrder: 6,
    completedAt: "2026-05-13T01:05:00.000Z",
    emittedAt: "2026-05-13T01:05:01.000Z",
  }));

  assert.equal(workerepsilon.accepted, true);
  assert.equal(workerzeta.accepted, true);

  const records = broker.listCrossBrokerTerminalBriefProjections({ parentRoundId, originBrokerId: "brokerbeta" });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.childWorkerId), ["workerepsilon", "workerzeta"]);

  const allTerminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(operatorRows(allTerminalEvents).length, 2);
  const terminalEvents = projectionRows(allTerminalEvents);
  assert.equal(terminalEvents.length, 2);
  assert.equal(terminalEvents[0]?.payload.run, parentRoundId);
  assert.equal(terminalEvents[0]?.payload.worker, "workerepsilon");
  assert.equal(terminalEvents[0]?.payload.parentRoundProgress, 1);
  assert.equal(terminalEvents[0]?.payload.parentRoundTotal, 7);
  assert.equal(terminalEvents[0]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerepsilon(완료 5/7)");
  assertProjectionOwnership(terminalEvents[0], "brokeralpha");
  assert.equal(terminalEvents[1]?.payload.worker, "workerzeta");
  assert.equal(terminalEvents[1]?.payload.parentRoundProgress, 2);
  assert.equal(terminalEvents[1]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 6/7)");
});

test("cross-broker Terminal Brief projection is symmetric for brokerbeta-owned parent rounds", () => {
  const parentRoundId = "a2a-r12-brokerbeta-origin-round";
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokerbeta" });
  createParentRound(broker, parentRoundId);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId,
    originBrokerId: "brokeralpha",
    brokerOfRecordId: "brokerbeta",
    childTaskId: "brokeralpha-handoff-child",
    childWorkerId: "workerepsilon",
    parentRoundTotal: 7,
    parentRoundOrder: 5,
    summary: "brokeralpha handoff child completed for the brokerbeta aggregate",
  }));

  assert.equal(result.accepted, true);
  assert.equal(result.record.brokerOfRecordId, "brokerbeta");
  assert.equal(result.record.originBrokerId, "brokeralpha");
  assert.equal(result.ack.terminalAck, false);

  const records = broker.listCrossBrokerTerminalBriefProjections({ parentRoundId, originBrokerId: "brokeralpha" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.brokerOfRecordId, "brokerbeta");

  const [terminalEvent] = projectionRows(broker.getTerminalTaskEventOutbox().subscribe());
  assert.equal(terminalEvent?.payload.run, parentRoundId);
  assert.equal(terminalEvent?.payload.worker, "workerepsilon");
  assert.equal(terminalEvent?.payload.parentRoundTotal, 7);
  assert.equal(terminalEvent?.payload.parentRoundProgress, 1);
  assert.equal(terminalEvent?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerepsilon(완료 5/7)");
  assert.deepEqual(terminalEvent?.payload.crossBrokerHandoff, {
    parentRoundId,
    originBrokerId: "brokerbeta",
    handoffBrokerId: "brokeralpha",
    originTaskId: "brokeralpha-handoff-child",
    childWorkerId: "workerepsilon",
  });
  assertProjectionOwnership(terminalEvent, "brokerbeta");
});

test("cross-broker Terminal Brief projection redacts unsafe content and fails closed for ACKs", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    summary: "done token=fake-token-placeholder at /work/repo/raw-session.log",
    taskBrief: "secret=abc123 /home/alice/private",
    terminalBriefTitle: "A2A token=fake-token-placeholder /root/private",
    evidenceUrl: "file:///work/repo/private.log",
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.ack.terminalAck, false);
  assert.equal(result.record.summary, "done token=[redacted] at [path]");
  assert.equal(result.record.taskBrief, "secret=[redacted] [path]");
  assert.equal(result.record.terminalBriefTitle, "A2A token=[redacted] [path]");
  assert.equal(result.record.evidenceUrl, undefined);
  assert.equal(Object.hasOwn(result.record, "terminalBriefText"), false);
  assert.doesNotMatch(JSON.stringify(result.record), /fake-token-placeholder|\/work\/repo|\/home\/alice|\/root\/private|file:\/\//);

  const forbiddenAck = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "child-broker-b",
    terminalAck: true,
  }));
  assert.equal(forbiddenAck.accepted, false);
  assert.equal(forbiddenAck.ack.code, "terminal_ack_forbidden");
  assert.equal(forbiddenAck.ack.terminalAck, false);
  assert.equal(broker.getCrossBrokerTerminalBriefProjection("round-parent", "child-broker-b"), undefined);
});

test("cross-broker Terminal Brief projections survive broker snapshot persistence", () => {
  let snapshot: BrokerSnapshot = emptySnapshot();
  const store: BrokerStateStore = {
    load: () => snapshot,
    save: (next) => {
      snapshot = structuredClone(next);
    },
  };

  const broker = new InMemoryA2ABroker(store, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);
  broker.ingestCrossBrokerTerminalBriefProjection(projection());

  const restored = new InMemoryA2ABroker(undefined, snapshot, { brokerId: "parent-broker" });
  assert.equal(restored.getCrossBrokerTerminalBriefProjection("round-parent", "child-broker-a")?.summary, "child completed safely");
});

test("Terminal Brief dispatch guard rejects projection with missing parentRoundId", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  // empty parentRoundId is caught by normalizeRequest as bad_request before
  // the dispatch metadata guard runs; this validates the fail-closed path.
  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundId: "" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "bad_request");
  assert.match(result.ack.reason, /parentRoundId/);
});

test("Terminal Brief dispatch guard rejects projection with missing originBrokerId", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  // empty originBrokerId is caught by normalizeRequest as bad_request before
  // the dispatch metadata guard runs; this validates the fail-closed path.
  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ originBrokerId: "" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "bad_request");
  assert.match(result.ack.reason, /originBrokerId/);
});

test("Terminal Brief dispatch guard rejects projection with missing parentRoundTotal", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundTotal: undefined }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_dispatch_metadata");
  assert.match(result.ack.reason, /parentRoundTotal/);
});

test("Terminal Brief dispatch guard rejects projection with non-positive parentRoundTotal", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundTotal: "0" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_dispatch_metadata");
  assert.match(result.ack.reason, /parentRoundTotal/);
});

test("Terminal Brief dispatch guard rejects projection with missing parentRoundOrder", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundOrder: undefined }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_dispatch_metadata");
  assert.match(result.ack.reason, /parentRoundOrder/);
});

test("Terminal Brief dispatch guard rejects projection with parentRoundOrder beyond total", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundTotal: "7", parentRoundOrder: "8" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_dispatch_metadata");
  assert.match(result.ack.reason, /parentRoundOrder/);
});

test("Terminal Brief dispatch guard accepts parentRoundNum as parentRoundOrder alias", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundOrder: undefined,
    parentRoundNum: "2",
    parentRoundTotal: "2",
    childWorkerId: "workerzeta",
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.record.parentRoundOrder, 2);

  const [event] = projectionRows(broker.getTerminalTaskEventOutbox().subscribe());
  assert.equal(event?.payload.parentRoundOrder, 2);
  assert.equal(event?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 2/2)");
});

test("Terminal Brief dispatch guard accepts projection lacking brokerOfRecordId (defaults to receiver broker)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ brokerOfRecordId: undefined }));
  // brokerOfRecordId is optional in the canonical schema; the receiving broker
  // uses its own configured id as the default.
  assert.equal(result.accepted, true);
});

test("Terminal Brief dispatch guard accepts valid brokeralpha-origin projection with workergamma compact title", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "brokeralpha",
    childWorkerId: "workergamma",
    parentRoundTotal: "7",
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.replayed, false);
  assert.equal(result.record.originBrokerId, "brokeralpha");
  assert.equal(result.record.parentRoundTotal, 7);
  assert.equal(result.record.childWorkerId, "workergamma");

  const allEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(allEvents.length, 2);
  assert.equal(operatorRows(allEvents).length, 1);
  const events = projectionRows(allEvents);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload.run, "round-parent");
  assert.equal(events[0]?.payload.worker, "workergamma");
  assert.equal(events[0]?.payload.parentRoundTotal, 7);
  assert.equal(events[0]?.payload.parentRoundProgress, 1);
  assert.equal(events[0]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 1/7)");
  assert.deepEqual(events[0]?.payload.crossBrokerHandoff, {
    parentRoundId: "round-parent",
    originBrokerId: "parent-broker",
    handoffBrokerId: "brokeralpha",
    originTaskId: "child-task-1",
    childWorkerId: "workergamma",
  });
  assertProjectionOwnership(events[0], "parent-broker");
});

test("Terminal Brief dispatch guard accepts valid brokerbeta-origin projection with workerepsilon compact title", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "brokerbeta",
    childWorkerId: "workerepsilon",
    parentRoundTotal: "10",
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.replayed, false);
  assert.equal(result.record.originBrokerId, "brokerbeta");
  assert.equal(result.record.parentRoundTotal, 10);
  assert.equal(result.record.childWorkerId, "workerepsilon");

  const allEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(allEvents.length, 2);
  assert.equal(operatorRows(allEvents).length, 1);
  const events = projectionRows(allEvents);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload.run, "round-parent");
  assert.equal(events[0]?.payload.worker, "workerepsilon");
  assert.equal(events[0]?.payload.parentRoundTotal, 10);
  assert.equal(events[0]?.payload.parentRoundProgress, 1);
  assert.equal(events[0]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerepsilon(완료 1/10)");
  assert.deepEqual(events[0]?.payload.crossBrokerHandoff, {
    parentRoundId: "round-parent",
    originBrokerId: "parent-broker",
    handoffBrokerId: "brokerbeta",
    originTaskId: "child-task-1",
    childWorkerId: "workerepsilon",
  });
  assertProjectionOwnership(events[0], "parent-broker");
});


test("workergamma compact Terminal Brief emitted on every terminal status: succeeded", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "brokeralpha",
    childTaskId: "workergamma-task-succeeded",
    childWorkerId: "workergamma",
    parentRoundTotal: "7",
    status: "succeeded",
    summary: "workergamma succeeded",
    completedAt: "2026-05-14T01:01:00.000Z",
    emittedAt: "2026-05-14T01:01:01.000Z",
  }));
  assert.equal(result.accepted, true);

  const events = broker.getTerminalTaskEventOutbox().subscribe();
  const event = events.find(e => e.payload.taskId === "workergamma-task-succeeded");
  assert.ok(event, "workergamma succeeded event must exist");
  assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 1/7)");
  assert.equal(event.payload.status, "succeeded");
});

test("workergamma compact Terminal Brief emitted on every terminal status: failed", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "brokeralpha",
    childTaskId: "workergamma-task-failed",
    childWorkerId: "workergamma",
    parentRoundTotal: "7",
    status: "failed",
    summary: "workergamma failed",
    completedAt: "2026-05-14T01:02:00.000Z",
    emittedAt: "2026-05-14T01:02:01.000Z",
  }));
  assert.equal(result.accepted, true);

  const events = broker.getTerminalTaskEventOutbox().subscribe();
  const event = events.find(e => e.payload.taskId === "workergamma-task-failed");
  assert.ok(event, "workergamma failed event must exist");
  assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 실패: workergamma(완료 1/7)");
  assert.equal(event.payload.status, "failed");
  assert.equal(event.payload.parentRoundProgress, 1);
});

test("workergamma compact Terminal Brief emitted on every terminal status: canceled", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "brokeralpha",
    childTaskId: "workergamma-task-canceled",
    childWorkerId: "workergamma",
    parentRoundTotal: "7",
    status: "canceled",
    summary: "workergamma canceled",
    completedAt: "2026-05-14T01:03:00.000Z",
    emittedAt: "2026-05-14T01:03:01.000Z",
  }));
  assert.equal(result.accepted, true);

  const events = broker.getTerminalTaskEventOutbox().subscribe();
  const event = events.find(e => e.payload.taskId === "workergamma-task-canceled");
  assert.ok(event, "workergamma canceled event must exist");
  assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 취소: workergamma(완료 1/7)");
  assert.equal(event.payload.status, "canceled");
  assert.equal(event.payload.parentRoundProgress, 1);
});

test("workergamma compact Terminal Brief emitted on every terminal status: blocked", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "brokeralpha",
    childTaskId: "workergamma-task-blocked",
    childWorkerId: "workergamma",
    parentRoundTotal: "7",
    status: "blocked",
    summary: "workergamma blocked",
    completedAt: "2026-05-14T01:04:00.000Z",
    emittedAt: "2026-05-14T01:04:01.000Z",
  }));
  assert.equal(result.accepted, true);

  const events = broker.getTerminalTaskEventOutbox().subscribe();
  const event = events.find(e => e.payload.taskId === "workergamma-task-blocked");
  assert.ok(event, "workergamma blocked event must exist");
  assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 차단: workergamma(완료 1/7)");
  assert.equal(event.payload.status, "blocked");
  assert.equal(event.payload.parentRoundProgress, 1);
});

test("cross-broker duplicate projection is idempotent; terminal event title unchanged", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  // First ingestion
  const first = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "brokeralpha",
    childTaskId: "unique-child-projection",
    childWorkerId: "workergamma",
    parentRoundTotal: "5",
    parentRoundOrder: "3",
    status: "succeeded",
  }));
  assert.equal(first.accepted, true);

  // Same projection ingested again (duplicate/replay)
  const second = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "brokeralpha",
    childTaskId: "unique-child-projection",
    childWorkerId: "workergamma",
    parentRoundTotal: "5",
    parentRoundOrder: "3",
    status: "succeeded",
  }));
  assert.equal(second.replayed, true);

  // Only ONE terminal event for this child
  const events = broker.getTerminalTaskEventOutbox().subscribe();
  const matching = events.filter(e => e.payload.taskId === "unique-child-projection");
  assert.equal(matching.length, 2, "duplicate projection must keep one projection row and one operator-facing row");
  assert.equal(projectionRows(matching).length, 1);
  assert.equal(operatorRows(matching).length, 1);

  const event = projectionRows(matching)[0];
  assert.ok(event);
  assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 3/5)");
  assert.equal(event.payload.status, "succeeded");
  assert.equal(event.payload.parentRoundProgress, 1);
  assert.equal(event.payload.parentRoundTotal, 5);
});

test("cross-broker mixed succeeded and failed projections: numerator counts terminal lanes", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  // First projection: failed
  const failed = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "brokeralpha",
    childTaskId: "failed-child",
    childWorkerId: "workergamma",
    parentRoundTotal: "7",
    status: "failed",
  }));
  assert.equal(failed.accepted, true);

  // Second projection: succeeded
  const succeeded = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "brokeralpha",
    childTaskId: "succeeded-child",
    childWorkerId: "workergamma",
    parentRoundTotal: "7",
    status: "succeeded",
  }));
  assert.equal(succeeded.accepted, true);

  const events = broker.getTerminalTaskEventOutbox().subscribe();

  const failedEvent = events.find(e => e.payload.taskId === "failed-child");
  assert.ok(failedEvent);
  // Failed projection still closes one lane for operator progress.
  assert.equal(failedEvent.payload.parentRoundProgress, 1);
  assert.equal(failedEvent.payload.terminalBriefTitle, "A2A Terminal Brief 실패: workergamma(완료 1/7)");
  assert.equal(failedEvent.payload.status, "failed");

  const succeededEvent = events.find(e => e.payload.taskId === "succeeded-child");
  assert.ok(succeededEvent);
  // Succeeded projection is the second terminal lane in the round, while the
  // rendered parent-owned title still preserves explicit parent order.
  assert.equal(succeededEvent.payload.parentRoundProgress, 2);
  assert.equal(succeededEvent.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 1/7)");
  assert.equal(succeededEvent.payload.status, "succeeded");
});

test("cross-broker Terminal Brief dedup uses stable notification idempotency key (ignores completedAt)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRound(broker);

  // First projection with earlier timestamp
  const first = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "round-parent",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "brokerbeta-task-01",
    childWorkerId: "workerepsilon",
    parentRoundTotal: "4",
    parentRoundOrder: "2",
    status: "succeeded",
    completedAt: "2026-05-14T10:00:00.000Z",
    emittedAt: "2026-05-14T10:00:01.000Z",
  }));
  assert.equal(first.accepted, true);
  assert.equal(first.replayed, false);

  // Second projection SAME logical notification (same parentRoundId, childTaskId,
  // status, owner) but DIFFERENT completedAt and emittedAt. The sourceDigest
  // changes (it includes completedAt), so the projection store replaces the
  // record as a newer aggregate. The outbox idempotency key deliberately
  // excludes completedAt, so the outbox returns the existing event.
  const second = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "round-parent",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "brokerbeta-task-01",
    childWorkerId: "workerepsilon",
    parentRoundTotal: "4",
    parentRoundOrder: "2",
    status: "succeeded",
    completedAt: "2026-05-14T11:00:00.000Z",
    emittedAt: "2026-05-14T11:00:01.000Z",
  }));
  assert.equal(second.accepted, true);
  // Different sourceDigest means the projection store treats this as a
  // newer aggregate, not a replay (sourceDigest ≠ stale replay check).
  assert.equal(second.replayed, false);

  // Must still be exactly 1 terminal event — outbox dedup by stable key
  // suppresses the duplicate even though the projection store accepted it.
  const allTerminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(allTerminalEvents.length, 2, "different completedAt must keep one projection row and one operator-facing row");
  const terminalEvents = projectionRows(allTerminalEvents);
  assert.equal(terminalEvents.length, 1, "different completedAt must not create duplicate projection rows");
  assert.equal(operatorRows(allTerminalEvents).length, 1, "different completedAt must not create duplicate operator-facing rows");

  // The outbox event payload reflects the first projection's completedAt
  // (it was not overwritten, only the dedup check returned the existing event).
  assert.equal(terminalEvents[0]?.payload.completedAt, "2026-05-14T10:00:00.000Z",
    "outbox event completedAt preserves first-accepted value");

  // But the projection store record was updated with the newer completedAt
  const stored = broker.getCrossBrokerTerminalBriefProjection("round-parent", "brokerbeta");
  assert.equal(stored?.completedAt, "2026-05-14T11:00:00.000Z",
    "projection store accepts newer completedAt without creating duplicate outbox event");
});

test("cross-broker Terminal Brief dedup key distinguishes multiple workers from same origin broker (no childTaskId)", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRound(broker);

  // workerepsilon projection WITHOUT childTaskId — only childWorkerId differentiates
  const workerepsilon = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "round-parent",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: undefined,
    childWorkerId: "workerepsilon",
    parentRoundTotal: "7",
    parentRoundOrder: "5",
    status: "succeeded",
    completedAt: "2026-05-14T10:00:00.000Z",
    emittedAt: "2026-05-14T10:00:01.000Z",
  }));
  assert.equal(workerepsilon.accepted, true);

  // workerzeta projection WITHOUT childTaskId — same parentRoundId, originBrokerId, different childWorkerId
  const workerzeta = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "round-parent",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: undefined,
    childWorkerId: "workerzeta",
    parentRoundTotal: "7",
    parentRoundOrder: "6",
    status: "succeeded",
    completedAt: "2026-05-14T10:05:00.000Z",
    emittedAt: "2026-05-14T10:05:01.000Z",
  }));
  assert.equal(workerzeta.accepted, true);

  // Both must have produced terminal events (no collision from missing childTaskId)
  const allTerminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(allTerminalEvents.length, 4, "two workers from same origin broker must each get projection and operator-facing rows");
  const terminalEvents = projectionRows(allTerminalEvents);
  assert.equal(terminalEvents.length, 2, "two workers from same origin broker must each get a projection row");
  assert.equal(operatorRows(allTerminalEvents).length, 2);

  const workers = terminalEvents.map(e => e.payload.worker);
  assert.ok(workers.includes("workerepsilon"), "workerepsilon must have a terminal event");
  assert.ok(workers.includes("workerzeta"), "workerzeta must have a terminal event");

  // Verify the projection store also has distinct records
  const records = broker.listCrossBrokerTerminalBriefProjections({ parentRoundId: "round-parent", originBrokerId: "brokerbeta" });
  assert.equal(records.length, 2, "projection store must have distinct records for both workers");
  assert.deepEqual(records.map(r => r.childWorkerId).sort(), ["workerepsilon", "workerzeta"]);
});

test("cross-broker Terminal Brief dedup key distinguishes same child task from different origin brokers", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRound(broker);

  const brokerbeta = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "round-parent",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "shared-child-task",
    childWorkerId: undefined,
    parentRoundTotal: "4",
    parentRoundOrder: "2",
    status: "succeeded",
    completedAt: "2026-05-14T10:00:00.000Z",
    emittedAt: "2026-05-14T10:00:01.000Z",
  }));
  assert.equal(brokerbeta.accepted, true);

  const otherBroker = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "round-parent",
    originBrokerId: "other-child-broker",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "shared-child-task",
    childWorkerId: undefined,
    parentRoundTotal: "4",
    parentRoundOrder: "3",
    status: "succeeded",
    completedAt: "2026-05-14T10:05:00.000Z",
    emittedAt: "2026-05-14T10:05:01.000Z",
  }));
  assert.equal(otherBroker.accepted, true);

  const allTerminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(allTerminalEvents.length, 4, "same child task id from different origin brokers must not collide");
  const terminalEvents = projectionRows(allTerminalEvents);
  assert.equal(terminalEvents.length, 2);
  assert.equal(operatorRows(allTerminalEvents).length, 2);
  assert.deepEqual(terminalEvents.map((e) => e.payload.originBrokerId).sort(), ["brokerbeta", "other-child-broker"]);
});

test("cross-broker Terminal Brief dedup key distinguishes ordered lanes when child id is absent", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRound(broker);

  const laneTwo = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "round-parent",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: undefined,
    childWorkerId: undefined,
    parentRoundTotal: "4",
    parentRoundOrder: "2",
    status: "succeeded",
    completedAt: "2026-05-14T10:00:00.000Z",
    emittedAt: "2026-05-14T10:00:01.000Z",
  }));
  assert.equal(laneTwo.accepted, true);

  const laneThree = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "round-parent",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: undefined,
    childWorkerId: undefined,
    parentRoundTotal: "4",
    parentRoundOrder: "3",
    status: "succeeded",
    completedAt: "2026-05-14T10:05:00.000Z",
    emittedAt: "2026-05-14T10:05:01.000Z",
  }));
  assert.equal(laneThree.accepted, true);

  const allTerminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(allTerminalEvents.length, 4, "ordered lanes without child ids must not collide");
  const terminalEvents = projectionRows(allTerminalEvents);
  assert.equal(terminalEvents.length, 2);
  assert.equal(operatorRows(allTerminalEvents).length, 2);
  assert.deepEqual(terminalEvents.map((e) => e.payload.parentRoundOrder).sort(), [2, 3]);
});

test("cross-broker Terminal Brief dedup key includes brokerOfRecordId in notification identity", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "shared-parent" });
  createParentRound(broker);

  // Same parent round, same child task, same status — different brokerOfRecordId
  const firstOwner = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "round-parent",
    originBrokerId: "child-broker-x",
    brokerOfRecordId: "shared-parent",
    childTaskId: "shared-child-42",
    parentRoundTotal: "3",
    parentRoundOrder: "1",
    status: "succeeded",
    completedAt: "2026-05-14T10:00:00.000Z",
  }));
  assert.equal(firstOwner.accepted, true);

  // Second projection with different brokerOfRecordId — should be accepted as new, not replayed
  const secondOwner = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "round-parent",
    originBrokerId: "child-broker-x",
    brokerOfRecordId: "other-broker",
    childTaskId: "shared-child-42",
    parentRoundTotal: "3",
    parentRoundOrder: "1",
    status: "succeeded",
    completedAt: "2026-05-14T10:00:00.000Z",
  }));
  // Different brokerOfRecordId is technically rejected by wrong_origin validation
  // for the primary broker. This test validates the idempotency key design —
  // different owner gives a different stableId even when other identity fields match.
  // The projection store recordKey already uses parentRoundId::originBrokerId::childKey
  // so the second projection gets a different recordKey anyway.
  assert.equal(secondOwner.accepted, false, "different brokerOfRecordId is rejected by origin check");
  assert.equal(secondOwner.ack.code, "wrong_origin");

  // Still only 1 accepted terminal event
  const terminalEvents = projectionRows(broker.getTerminalTaskEventOutbox().subscribe());
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0]?.payload.brokerOfRecordId, "shared-parent");
});

test("cross-broker Terminal Brief dedup only suppresses duplicates but preserves outbox event fields", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRound(broker);

  // First projection — accepted
  const first = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "round-parent",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "multiline-child",
    childWorkerId: "workerepsilon",
    parentRoundTotal: "5",
    parentRoundOrder: "3",
    status: "succeeded",
    summary: "completed successfully",
    completedAt: "2026-05-15T01:00:00.000Z",
  }));
  assert.equal(first.accepted, true);

  // Capture the outbox event for later comparison
  const beforeEvents = projectionRows(broker.getTerminalTaskEventOutbox().subscribe());
  const firstEvent = beforeEvents[0]!;

  // Six replays — each should increment replayCount but NOT add more outbox events
  for (let i = 0; i < 6; i++) {
    const replay = broker.ingestCrossBrokerTerminalBriefProjection(projection({
      parentRoundId: "round-parent",
      originBrokerId: "brokerbeta",
      brokerOfRecordId: "brokeralpha",
      childTaskId: "multiline-child",
      childWorkerId: "workerepsilon",
      parentRoundTotal: "5",
      parentRoundOrder: "3",
      status: "succeeded",
      summary: "completed successfully",
      completedAt: "2026-05-15T01:00:00.000Z",
    }));
    assert.equal(replay.accepted, true);
    assert.equal(replay.replayed, true, `replay #${i + 1} must be marked as replayed`);
    assert.equal(replay.record.replayCount, i + 1, `replayCount must be ${i + 1}`);
  }

  // Exactly 1 terminal event — all duplicates suppressed at operator-facing level
  const allAfterEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(allAfterEvents.length, 2, "replays must not produce additional outbox rows");
  assert.equal(operatorRows(allAfterEvents).length, 1);
  const afterEvents = projectionRows(allAfterEvents);
  assert.equal(afterEvents.length, 1, "replays must not produce additional projection rows");

  // Original outbox event fields preserved unchanged
  const currentEvent = afterEvents[0];
  assert.equal(currentEvent.id, firstEvent.id, "event id must be unchanged across replays");
  assert.equal(currentEvent.payload.status, "succeeded");
  assert.equal(currentEvent.payload.worker, "workerepsilon");
  assert.equal(currentEvent.payload.parentRoundTotal, 5);
  assert.equal(currentEvent.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerepsilon(완료 3/5)");

  // Internal metadata on the projection record shows replay count
  const stored = broker.getCrossBrokerTerminalBriefProjection("round-parent", "brokerbeta");
  assert.equal(stored?.replayCount, 6, "internal replayCount evidence is preserved across 6 replays");
  assert.equal(stored?.summary, "completed successfully");
});

function createParentRoundWithRouting(
  broker: InMemoryA2ABroker,
  id: string,
  initiatingBrokerId: string,
  teamScope: string,
): void {
  const workerId = "worker-child";
  if (!broker.getWorker(workerId)) {
    registerWorker(broker, workerId);
  }
  broker.createTask({
    id,
    intent: "chat",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: workerId, kind: "node", role: "analyst" },
    assignedWorkerId: workerId,
    message: `${initiatingBrokerId}-origin ${teamScope} round`,
    payload: {
      teamScope,
      initiatingBrokerId,
    },
  });
}

function routingProjection(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    parentRoundId: "brokeralpha-routing-round",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "child-task-routing-01",
    childWorkerId: "workerepsilon",
    parentRoundTotal: "2",
    parentRoundOrder: "1",
    status: "succeeded",
    summary: "brokerbeta handoff success",
    completedAt: "2026-05-16T01:00:00.000Z",
    emittedAt: "2026-05-16T01:00:01.000Z",
    ...overrides,
  };
}

function ingestRoutingProjection(
  broker: InMemoryA2ABroker,
  overrides: Record<string, unknown> = {},
): ReturnType<InMemoryA2ABroker["ingestCrossBrokerTerminalBriefProjection"]> {
  return broker.ingestCrossBrokerTerminalBriefProjection(
    routingProjection(overrides) as unknown as Parameters<InMemoryA2ABroker["ingestCrossBrokerTerminalBriefProjection"]>[0],
  );
}

test("routing: brokeralpha-origin Team1+Team2 parent accepts brokerbeta child projection via routing helper", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRoundWithRouting(broker, "brokeralpha-routing-round", "brokeralpha", "team1+team2");

  const result = ingestRoutingProjection(broker);
  assert.equal(result.accepted, true, "brokerbeta projection must be accepted by brokeralpha parent broker");
  assert.equal(result.replayed, false);
  assert.equal(result.record.originBrokerId, "brokerbeta");
  assert.equal(result.record.brokerOfRecordId, "brokeralpha");
  assert.equal(result.record.childWorkerId, "workerepsilon");
  assert.equal(result.record.parentRoundTotal, 2);
  assert.equal(result.record.parentRoundOrder, 1);
  assert.equal(result.ack.terminalAck, false);

  const allTerminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(operatorRows(allTerminalEvents).length, 1);
  const terminalEvents = projectionRows(allTerminalEvents);
  assert.equal(terminalEvents.length, 1);
  const event = terminalEvents[0];
  assert.equal(event?.payload.run, "brokeralpha-routing-round");
  assert.equal(event?.payload.worker, "workerepsilon");
  assert.equal(event?.payload.parentRoundTotal, 2);
  assert.equal(event?.payload.parentRoundProgress, 1);
  assert.equal(event?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerepsilon(완료 1/2)");
  assert.deepEqual(event?.payload.crossBrokerHandoff, {
    parentRoundId: "brokeralpha-routing-round",
    originBrokerId: "brokeralpha",
    handoffBrokerId: "brokerbeta",
    originTaskId: "child-task-routing-01",
    childWorkerId: "workerepsilon",
  });
  assertProjectionOwnership(event, "brokeralpha");
});

test("routing: brokerbeta-origin Team2+Team1 parent accepts brokeralpha child projection via routing helper", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokerbeta" });
  createParentRoundWithRouting(broker, "brokerbeta-routing-round", "brokerbeta", "team1+team2");

  const result = ingestRoutingProjection(broker, {
    parentRoundId: "brokerbeta-routing-round",
    originBrokerId: "brokeralpha",
    brokerOfRecordId: "brokerbeta",
    childTaskId: "brokerbeta-child-01",
    childWorkerId: "workerzeta",
    parentRoundTotal: "3",
    parentRoundOrder: "1",
  });
  assert.equal(result.accepted, true, "brokeralpha projection must be accepted by brokerbeta parent broker");
  assert.equal(result.record.originBrokerId, "brokeralpha");
  assert.equal(result.record.brokerOfRecordId, "brokerbeta");
  assert.equal(result.record.childWorkerId, "workerzeta");
  assert.equal(result.ack.terminalAck, false);

  const allTerminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(operatorRows(allTerminalEvents).length, 1);
  const terminalEvents = projectionRows(allTerminalEvents);
  assert.equal(terminalEvents.length, 1);
  const event = terminalEvents[0];
  assert.equal(event?.payload.run, "brokerbeta-routing-round");
  assert.equal(event?.payload.worker, "workerzeta");
  assert.equal(event?.payload.parentRoundTotal, 3);
  assert.equal(event?.payload.parentRoundProgress, 1);
  assert.equal(event?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 1/3)");
  assert.deepEqual(event?.payload.crossBrokerHandoff, {
    parentRoundId: "brokerbeta-routing-round",
    originBrokerId: "brokerbeta",
    handoffBrokerId: "brokeralpha",
    originTaskId: "brokerbeta-child-01",
    childWorkerId: "workerzeta",
  });
  assertProjectionOwnership(event, "brokerbeta");
});

test("routing: projection from wrong handoff broker is rejected by routing validation", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRoundWithRouting(broker, "brokeralpha-routing-round", "brokeralpha", "team1+team2");

  // Attempt projection from an unexpected broker (not the routing helper's
  // expected handoff broker for Team1+Team2 = brokerbeta)
  const result = ingestRoutingProjection(broker, {
    originBrokerId: "unexpected-broker",
  });
  assert.equal(result.accepted, false, "unexpected origin must be rejected");
  assert.equal(result.ack.code, "routing_mismatch");
  assert.equal(result.ack.terminalAck, false);
  assert.match(result.ack.reason, /handoff broker/);
  assert.equal(broker.listCrossBrokerTerminalBriefProjections().length, 0, "no projections stored");
});

test("routing: projection with mismatched brokerOfRecordId is caught by wrong_origin before routing check", () => {
  // The wrong_origin check in ingest() validates brokerOfRecordId against
  // receiver brokerId and rejects before routing validation runs. This is
  // correct because brokerOfRecordId must match the receiver broker — routing
  // only further constrains which originBrokerId is expected.
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRoundWithRouting(broker, "brokeralpha-routing-round", "brokeralpha", "team1+team2");

  const result = ingestRoutingProjection(broker, {
    brokerOfRecordId: "wrong-parent",
  });
  assert.equal(result.accepted, false, "mismatched brokerOfRecordId must be rejected");
  assert.equal(result.ack.code, "wrong_origin", "wrong_origin catches brokerOfRecordId mismatch before routing");
  assert.match(result.ack.reason, /addressed to broker-of-record/);
  assert.equal(broker.listCrossBrokerTerminalBriefProjections().length, 0);
});

test("routing: parent round without routing metadata falls back to existing validation", () => {
  // When the parent task has no teamScope/initiatingBrokerId, the routing
  // callback returns undefined and the projection store uses existing
  // validation (wrong_origin, missing_parent, etc.) without routing checks.
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRound(broker, "no-routing-round");

  // Projection with origin == receiving broker — the dispatch preflight catches
  // originBrokerId == receiverBrokerId before wrong_origin check.
  const selfOrigin = ingestRoutingProjection(broker, {
    parentRoundId: "no-routing-round",
    originBrokerId: "brokeralpha",
  });
  assert.equal(selfOrigin.accepted, false);
  assert.equal(selfOrigin.ack.code, "missing_dispatch_metadata", "dispatch preflight rejects self-origin before wrong_origin check");
  assert.equal(selfOrigin.ack.terminalAck, false);
});

test("routing: invalid initiatingBrokerId falls through to existing validation", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRoundWithRouting(broker, "bad-init-round", "unknown-broker", "team1-only");

  // The routing callback calls resolveTerminalBriefParentOriginRoute with an
  // unknown initiatingBrokerId, which returns ok:false. The callback returns
  // undefined, so existing validation applies.
  const result = ingestRoutingProjection(broker, {
    parentRoundId: "bad-init-round",
  });
  assert.equal(result.accepted, true, "falls through to existing validation without routing rejection");
  assert.equal(result.ack.terminalAck, false);
});

test("routing: brokeralpha Team1-only parent round falls through to dispatch preflight for self-origin", () => {
  // Team1-only rounds have handoff: null, so the routing callback returns
  // handoffBrokerId: undefined. The routing validation only checks
  // handoffBrokerId when it's non-undefined, so no mismatch is possible.
  // Self-origin projection is still caught by dispatch preflight.
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRoundWithRouting(broker, "team1-local-round", "brokeralpha", "team1-only");

  const selfOrigin = ingestRoutingProjection(broker, {
    parentRoundId: "team1-local-round",
    originBrokerId: "brokeralpha",
  });
  assert.equal(selfOrigin.accepted, false);
  assert.equal(selfOrigin.ack.code, "missing_dispatch_metadata", "dispatch preflight catches self-origin before routing gets to wrong_origin");
});

test("routing: broker A parent round with broker B worker preserves parent counts (2/2)", { timeout: 5000 }, async () => {
  // This is the end-to-end test from the assignment spec:
  // "Test proving broker A parent round with broker B worker addresses
  //  human-facing brief to broker A and preserves parent counts."
  const brokerA = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });

  // Broker A creates a Team1+Team2 parent round with 2 expected workers
  createParentRoundWithRouting(brokerA, "a2a-r854-parent", "brokeralpha", "team1+team2");

  // Broker B (brokerbeta) executes workerepsilon — projection arrives at broker A
  const workerepsilon = ingestRoutingProjection(brokerA, {
    parentRoundId: "a2a-r854-parent",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "brokerbeta-workerepsilon-task",
    childWorkerId: "workerepsilon",
    parentRoundTotal: "2",
    parentRoundOrder: "1",
    status: "succeeded",
    summary: "workerepsilon done",
    completedAt: "2026-05-16T02:00:00.000Z",
    emittedAt: "2026-05-16T02:00:01.000Z",
  });
  assert.equal(workerepsilon.accepted, true, "workerepsilon projection must be accepted");
  assert.equal(workerepsilon.record.originBrokerId, "brokerbeta");
  assert.equal(workerepsilon.record.brokerOfRecordId, "brokeralpha");
  assert.equal(workerepsilon.record.childWorkerId, "workerepsilon");

  // Broker B (brokerbeta) executes workerbeta — second projection arrives at broker A
  const workerbeta = ingestRoutingProjection(brokerA, {
    parentRoundId: "a2a-r854-parent",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "brokerbeta-workerbeta-task",
    childWorkerId: "workerbeta",
    parentRoundTotal: "2",
    parentRoundOrder: "2",
    status: "succeeded",
    summary: "workerbeta done",
    completedAt: "2026-05-16T02:05:00.000Z",
    emittedAt: "2026-05-16T02:05:01.000Z",
  });
  assert.equal(workerbeta.accepted, true, "workerbeta projection must be accepted");
  assert.equal(workerbeta.record.childWorkerId, "workerbeta");

  // Verify projections stored correctly
  const records = brokerA.listCrossBrokerTerminalBriefProjections({ parentRoundId: "a2a-r854-parent" });
  assert.equal(records.length, 2, "both projections must be stored");
  assert.deepEqual(
    records.map((r) => r.childWorkerId),
    ["workerepsilon", "workerbeta"],
    "projections in worker order",
  );

  // Verify terminal events have parent-round context (2/2), NOT child-local (1/1)
  const allTerminalEvents = brokerA.getTerminalTaskEventOutbox().subscribe();
  assert.equal(allTerminalEvents.length, 4, "two terminal projections and two operator-facing rows, one per child worker");
  assert.equal(operatorRows(allTerminalEvents).length, 2);
  const terminalEvents = projectionRows(allTerminalEvents);
  assert.equal(terminalEvents.length, 2, "two projection events, one per child worker");

  // First event: workerepsilon — parentRoundProgress 1/2
  const workerepsilonEvent = terminalEvents.find((e) => e.payload.worker === "workerepsilon");
  assert.ok(workerepsilonEvent, "workerepsilon terminal event exists");
  assert.equal(workerepsilonEvent?.payload.parentRoundProgress, 1, "workerepsilon: progress 1/2");
  assert.equal(workerepsilonEvent?.payload.parentRoundTotal, 2);
  assert.equal(workerepsilonEvent?.payload.parentRoundOrder, 1);
  assert.equal(workerepsilonEvent?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerepsilon(완료 1/2)");
  assert.equal(workerepsilonEvent?.payload.title, "A2A Terminal Brief 완료: workerepsilon(완료 1/2)");

  // Second event: workerbeta — parentRoundProgress 2/2
  const workerbetaEvent = terminalEvents.find((e) => e.payload.worker === "workerbeta");
  assert.ok(workerbetaEvent, "workerbeta terminal event exists");
  assert.equal(workerbetaEvent?.payload.parentRoundProgress, 2, "workerbeta: progress 2/2");
  assert.equal(workerbetaEvent?.payload.parentRoundTotal, 2);
  assert.equal(workerbetaEvent?.payload.parentRoundOrder, 2);
  assert.equal(workerbetaEvent?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerbeta(완료 2/2)");
  assert.equal(workerbetaEvent?.payload.title, "A2A Terminal Brief 완료: workerbeta(완료 2/2)");

  // Both addressed to broker A (human-facing brief shows broker A context)
  for (const event of terminalEvents) {
    assert.equal(event?.payload.brokerOfRecordId, "brokeralpha", "both events addressed to broker A");
    assert.equal(event?.payload.originBrokerId, "brokerbeta", "both events originate from broker B");
    assert.equal(event?.payload.parentRoundId, "a2a-r854-parent");
    assertProjectionOwnership(event, "brokeralpha");
  }
});

test("parent-owned cross-broker projection rows remain evidence-only; operator-facing ACK uses separate row", () => {
  // The receiving parent broker stores the projection row as aggregation
  // evidence only. Even when ownerBrokerId matches the local broker, provider
  // send, visibility receipt, and terminal ACK must happen on a separate
  // operator-facing Terminal Brief row.

  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokerbeta" });
  createParentRound(broker, "brokerbeta-parent-round");

  // Ingest a cross-broker Terminal Brief projection where brokerbeta is the parent broker
  // (brokerOfRecordId === "brokerbeta").  The projection comes from a brokeralpha worker
  // completing a handoff child for brokerbeta's parent round.
  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId: "brokerbeta-parent-round",
    originBrokerId: "brokeralpha",
    brokerOfRecordId: "brokerbeta",
    childTaskId: "brokerbeta-child-001",
    childWorkerId: "workerzeta",
    parentRoundTotal: "5",
    parentRoundOrder: "3",
    summary: "workerzeta completed brokeralpha handoff evidence for brokerbeta parent",
  }));

  assert.equal(result.accepted, true);
  assert.equal(result.ack.terminalAck, false, "projection ingest must not ACK");
  assert.equal(result.record.brokerOfRecordId, "brokerbeta", "brokerOfRecordId is brokerbeta (parent broker)");

  // Outbox event must carry evidence-only notification ownership.
  const outbox = broker.getTerminalTaskEventOutbox();
  const events = outbox.subscribe();
  assert.equal(events.length, 2);
  const event = projectionRows(events)[0]!;
  const operatorEvent = operatorRows(events)[0];
  assertOperatorFacingRow(operatorEvent);
  assert.equal(event.payload.run, "brokerbeta-parent-round");
  assert.equal(operatorEvent?.payload.run, "brokerbeta-parent-round");
  assert.equal(event.payload.worker, "workerzeta");
  assert.equal(operatorEvent?.payload.worker, "workerzeta");
  assert.equal(event.payload.parentRoundTotal, 5);
  assert.equal(event.payload.parentRoundOrder, 3);
  assert.equal(event.payload.parentRoundProgress, 1);
  assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 3/5)");
  assertProjectionOwnership(event, "brokerbeta");

  // ackAudit must start as "pending" — not acknowledged
  assert.equal(event.ackAudit?.decision, "pending");
  assert.match(event.ackAudit?.reason ?? "", /cross-broker terminal projection/);

  // Attempt 1: acknowledge must fail closed — terminalAckPermittedByProjection is false
  assert.throws(
    () => outbox.acknowledge(event.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-22T07:00:00.000Z",
    }),
    /terminal outbox ack rejected: parent-owned cross-broker projection/,
    "acknowledge must reject operator_visible ACK on evidence-only projection row",
  );

  // Audit trail must reflect the rejection
  const rejected = outbox.subscribe()[0]!;
  assert.equal(rejected.ackAudit?.decision, "rejected", "audit decision must be rejected after failed ack attempt");
  assert.match(rejected.ackAudit?.reason ?? "", /projection row is evidence-only/);
  assert.equal(rejected.attempts, 0, "attempts must not increment after rejected ack");

  // Attempt 2: recording provider_sent must fail closed — providerSendPermittedByProjection is false
  assert.throws(
    () => outbox.recordReceiptStatus(event.id, { status: "provider_sent" }),
    /terminal outbox receipt rejected: parent-owned cross-broker projection/,
    "recordReceiptStatus must reject provider_sent on evidence-only projection row",
  );

  // Attempt 3: recording operator_visible must fail closed for the same reason
  assert.throws(
    () => outbox.recordReceiptStatus(event.id, { status: "operator_visible" }),
    /terminal outbox receipt rejected: parent-owned cross-broker projection/,
    "recordReceiptStatus must reject operator_visible on evidence-only projection row",
  );

  // Attempt 4: recording current_session_visible must fail closed
  assert.throws(
    () => outbox.recordReceiptStatus(event.id, { status: "current_session_visible" }),
    /terminal outbox receipt rejected: parent-owned cross-broker projection/,
    "recordReceiptStatus must reject current_session_visible on evidence-only projection row",
  );

  // Safe: recording "accepted" is still permitted (it's initial non-send state)
  const acceptedStatus = outbox.recordReceiptStatus(event.id, { status: "accepted", updatedAt: "2026-05-22T07:00:00.000Z" });
  assert.ok(acceptedStatus, "recordReceiptStatus for accepted must still work on cross-broker projections");
  assert.equal(acceptedStatus?.receipt.status, "accepted", "receipt status remains accepted");

  // Safe: "timed_out" and "stale" and "failed" are non-send failure states
  const timedOutStatus = outbox.recordReceiptStatus(event.id, { status: "timed_out" });
  assert.ok(timedOutStatus, "recordReceiptStatus for timed_out must still work on cross-broker projections");
  assert.equal(timedOutStatus?.receipt.status, "timed_out");

  const operatorSent = outbox.recordReceiptStatus(operatorEvent!.id, { status: "provider_sent" });
  assert.equal(operatorSent?.receipt.status, "provider_sent");
  const operatorVisible = outbox.recordReceiptStatus(operatorEvent!.id, { status: "operator_visible" });
  assert.equal(operatorVisible?.receipt.status, "operator_visible");
  const operatorAck = outbox.acknowledge(operatorEvent!.id, {
    evidence: "operator_visible",
    acknowledgedAt: "2026-05-22T08:00:00.000Z",
  });
  assert.equal(operatorAck?.ack?.status, "receipt_confirmed");

  // Event must survive snapshot/restore with correct metadata
  const snapshot = broker.exportSnapshot().terminalOutbox ?? [];
  const restoredBroker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokerbeta" });
  restoredBroker.getTerminalTaskEventOutbox().restoreSnapshot(snapshot);
  const restoredEvents = restoredBroker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(restoredEvents.length, 2);
  assert.deepEqual(
    projectionRows(restoredEvents)[0]?.payload.notificationOwnership,
    event.payload.notificationOwnership,
    "notificationOwnership must survive snapshot/restore",
  );
  assert.equal(operatorRows(restoredEvents)[0]?.ack?.status, "receipt_confirmed");
});

test("no-live harness: brokeralpha parent → brokerbeta Team2 child → brokeralpha operator-facing synthetic Terminal Brief", () => {
  // =====================================================================
  // PHASE 1 — brokeralpha creates a parent round; brokerbeta Team2 children
  // produce terminal events that arrive as cross-broker projections
  // at brokeralpha.
  // =====================================================================
  const brokeralpha = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRoundWithRouting(brokeralpha, "brokeralpha-parent-887", "brokeralpha", "team1+team2");

  // Two brokerbeta Team2 workers produce succeeded terminal events →
  // cross-broker projections arrive at brokeralpha.
  const workerepsilonProj = ingestRoutingProjection(brokeralpha, {
    parentRoundId: "brokeralpha-parent-887",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "brokerbeta-workerepsilon-child",
    childWorkerId: "workerepsilon",
    parentRoundTotal: "2",
    parentRoundOrder: "1",
    status: "succeeded",
    summary: "workerepsilon completed",
    completedAt: "2026-05-22T10:00:00.000Z",
    emittedAt: "2026-05-22T10:00:01.000Z",
  });
  const workerbetaProj = ingestRoutingProjection(brokeralpha, {
    parentRoundId: "brokeralpha-parent-887",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "brokerbeta-workerbeta-child",
    childWorkerId: "workerbeta",
    parentRoundTotal: "2",
    parentRoundOrder: "2",
    status: "succeeded",
    summary: "workerbeta completed",
    completedAt: "2026-05-22T10:05:00.000Z",
    emittedAt: "2026-05-22T10:05:01.000Z",
  });

  assert.equal(workerepsilonProj.accepted, true, "workerepsilon projection accepted by brokeralpha");
  assert.equal(workerbetaProj.accepted, true, "workerbeta projection accepted by brokeralpha");

  const outbox = brokeralpha.getTerminalTaskEventOutbox();
  const allProjectedOutput = outbox.subscribe();
  const projectionEvents = projectionRows(allProjectedOutput);
  const automaticOperatorEvents = operatorRows(allProjectedOutput);
  assert.equal(allProjectedOutput.length, 4, "two projections plus two automatic operator-facing rows in brokeralpha outbox");
  assert.equal(projectionEvents.length, 2, "two projection events in brokeralpha outbox");
  assert.equal(automaticOperatorEvents.length, 2, "two operator-facing rows in brokeralpha outbox");

  // =====================================================================
  // CLAIM A — brokerbeta parent-owned rows ARE projection-relayed to brokeralpha
  // and carry notification ownership identifying brokeralpha as owner broker.
  // =====================================================================
  for (const event of projectionEvents) {
    assert.equal(event.payload.brokerOfRecordId, "brokeralpha", "projection addressed to brokeralpha");
    assert.equal(event.payload.originBrokerId, "brokerbeta", "projection originates from brokerbeta");
    assert.equal(event.payload.parentRoundId, "brokeralpha-parent-887", "belongs to brokeralpha parent round");
  }

  // =====================================================================
  // CLAIM B — Projection events on brokeralpha have evidence-only notification
  // ownership: NOT locally provider-sent or terminal-ACK-eligible.
  // =====================================================================
  for (const event of projectionEvents) {
    assert.deepEqual(
      event.payload.notificationOwnership,
      {
        ownerBrokerId: "brokeralpha",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
        reason:
          "cross-broker projection rows are aggregation evidence only; " +
          "provider send and terminal ACK belong to a separate " +
          "parent-broker operator-facing Terminal Brief row",
      },
      "projection has evidence-only notification ownership on brokeralpha",
    );

    // ACK must fail closed
    assert.throws(
      () =>
        outbox.acknowledge(event.id, {
          evidence: "operator_visible",
          acknowledgedAt: "2026-05-22T11:00:00.000Z",
        }),
      /terminal outbox ack rejected/,
      "projection ACK rejected on brokeralpha",
    );

    // provider_sent receipt status must fail closed
    assert.throws(
      () => outbox.recordReceiptStatus(event.id, { status: "provider_sent" }),
      /terminal outbox receipt rejected/,
      "projection provider_sent rejected on brokeralpha",
    );

    // operator_visible receipt must fail closed
    assert.throws(
      () => outbox.recordReceiptStatus(event.id, { status: "operator_visible" }),
      /terminal outbox receipt rejected/,
      "projection operator_visible rejected on brokeralpha",
    );

    // Non-send receipt statuses (accepted, timed_out) still permitted
    const accepted = outbox.recordReceiptStatus(event.id, { status: "accepted" });
    assert.ok(accepted, "accepted receipt still permitted on projection");
    const timedOut = outbox.recordReceiptStatus(event.id, { status: "timed_out" });
    assert.ok(timedOut, "timed_out receipt still permitted on projection");
  }

  // =====================================================================
  // CLAIM C — brokeralpha automatically owns operator-facing send/ACK-eligible
  // rows derived from the cross-broker projections. These rows have NO
  // notification ownership restriction and ARE ACK/provider-send eligible.
  // =====================================================================
  const operatorEvent = automaticOperatorEvents.find((event) => event.payload.taskId === "brokerbeta-workerepsilon-child");
  assertOperatorFacingRow(operatorEvent);

  const ackResult = outbox.acknowledge(operatorEvent.id, {
    evidence: "operator_visible",
    acknowledgedAt: "2026-05-22T12:00:00.000Z",
  });
  assert.ok(ackResult, "automatic operator-facing event ACK succeeds");
  assert.equal(ackResult?.ack?.status, "receipt_confirmed", "operator-facing event ack status confirmed");
  assert.equal(ackResult?.ack?.evidence, "operator_visible", "operator-facing event ack evidence stored");

  // Reset: rebuild clean projections without the ACK to test provider_sent.
  const cleanBroker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  createParentRoundWithRouting(cleanBroker, "brokeralpha-parent-887", "brokeralpha", "team1+team2");
  // Re-ingest the two projections
  ingestRoutingProjection(cleanBroker, {
    parentRoundId: "brokeralpha-parent-887",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "brokerbeta-workerepsilon-child",
    childWorkerId: "workerepsilon",
    parentRoundTotal: "2",
    parentRoundOrder: "1",
    status: "succeeded",
    summary: "workerepsilon completed",
    completedAt: "2026-05-22T10:00:00.000Z",
    emittedAt: "2026-05-22T10:00:01.000Z",
  });
  ingestRoutingProjection(cleanBroker, {
    parentRoundId: "brokeralpha-parent-887",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "brokerbeta-workerbeta-child",
    childWorkerId: "workerbeta",
    parentRoundTotal: "2",
    parentRoundOrder: "2",
    status: "succeeded",
    summary: "workerbeta completed",
    completedAt: "2026-05-22T10:05:00.000Z",
    emittedAt: "2026-05-22T10:05:01.000Z",
  });
  const cleanOutbox = cleanBroker.getTerminalTaskEventOutbox();
  const cleanOperatorEvent = operatorRows(cleanOutbox.subscribe())
    .find((e) => e.payload.taskId === "brokerbeta-workerepsilon-child");
  assertOperatorFacingRow(cleanOperatorEvent);

  // provider_sent succeeds on automatically materialized operator-facing row
  const sentResult = cleanOutbox.recordReceiptStatus(cleanOperatorEvent.id, {
    status: "provider_sent",
    updatedAt: "2026-05-22T12:30:00.000Z",
  });
  assert.ok(sentResult, "operator-facing event provider_sent succeeds");
  assert.equal(
    sentResult?.receipt.status,
    "provider_sent",
    "operator-facing event receipt status is provider_sent",
  );

  // operator_visible succeeds on automatically materialized operator-facing row
  const visibleResult = cleanOutbox.recordReceiptStatus(cleanOperatorEvent.id, {
    status: "operator_visible",
    updatedAt: "2026-05-22T12:35:00.000Z",
  });
  assert.ok(visibleResult, "operator-facing event operator_visible succeeds");
  assert.equal(
    visibleResult?.receipt.status,
    "operator_visible",
    "operator-facing event receipt status is operator_visible",
  );

  // Verify projection events on clean broker remain evidence-only
  const cleanProjectionEvents = projectionRows(cleanOutbox.subscribe()).filter((e) => e.payload.originBrokerId === "brokerbeta");
  assert.equal(cleanProjectionEvents.length, 2, "two projection events on clean broker");
  for (const projEvent of cleanProjectionEvents) {
    assert.throws(
      () => cleanOutbox.acknowledge(projEvent.id, {
        evidence: "operator_visible",
        acknowledgedAt: "2026-05-22T13:00:00.000Z",
      }),
      /terminal outbox ack rejected/,
      "projection ACK still rejected on clean broker",
    );
  }
});

test("cross-broker projections reach the canonical snapshot even when hot-persist is throttling (#1446)", () => {
  // The hot-persist fast path (pending hot rows within the retention interval)
  // writes only hot-table rows — and projections have no hot table. An ingest
  // persist that rides that branch is ACKed but absent from the canonical
  // blob, so a restart in the window loses the projection. Same class as the
  // wave-plan G3-d canary fix: snapshot-only state must force the full save.
  const saves: { kind: "full" | "hot"; briefs?: unknown[] }[] = [];
  const stubStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => {
      saves.push({ kind: "full", briefs: snapshot.crossBrokerTerminalBriefs });
    },
    saveHotEntities: () => {
      saves.push({ kind: "hot" });
    },
  };
  const broker = new InMemoryA2ABroker(stubStore, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  // Simulate concurrent hot activity inside the persist throttle window:
  // another operation's audit row is staged but not yet persisted when the
  // projection arrives (a fresh broker always starts inside the window).
  (broker as unknown as { pendingHot: { stageAuditEvent(event: unknown): void } }).pendingHot.stageAuditEvent({
    id: "audit-pending-1",
    actorId: "worker-child",
    action: "worker.heartbeat",
    targetType: "worker",
    targetId: "worker-child",
    createdAt: "2026-07-07T15:00:00.000Z",
  });

  saves.length = 0;
  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection());
  assert.equal(result.accepted, true);

  const fullSaves = saves.filter((entry) => entry.kind === "full");
  assert.ok(fullSaves.length >= 1, "projection ingest must produce a full canonical save, not a hot-only save");
  const briefs = fullSaves.at(-1)?.briefs as { parentRoundId?: string }[] | undefined;
  assert.equal(briefs?.[0]?.parentRoundId, "round-parent", "the canonical save must carry the ingested projection");
});
