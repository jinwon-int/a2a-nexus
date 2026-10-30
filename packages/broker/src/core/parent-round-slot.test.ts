// #2339 PR-3b: one live projection per (parentRoundId, handoffBrokerId,
// parentRoundOrder) slot. A different child in the slot wins only with a later
// completedAt; the displaced record is kept as superseded and leaves the
// aggregate.
import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryA2ABroker } from "./broker.js";
import type { CrossBrokerTerminalBriefProjectionRequest } from "./completion/cross-broker-terminal-brief.js";
import { jsonHeaders, startTestServer } from "../server-test-helpers.js";

const PARENT = "brokeralpha";
const CHILD = "brokerbeta";
const ROUND = "brokeralpha-round-12";

function parentWithLegacyRound(): InMemoryA2ABroker {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: PARENT, knownBrokerIds: [CHILD] });
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["t"], environments: ["research"] },
  });
  broker.createTask({
    id: ROUND,
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "parent round",
    payload: { parentRoundTotal: 3 },
  });
  return broker;
}

function request(overrides: Partial<CrossBrokerTerminalBriefProjectionRequest> = {}): CrossBrokerTerminalBriefProjectionRequest {
  return {
    parentRoundId: ROUND,
    originBrokerId: PARENT,
    handoffBrokerId: CHILD,
    brokerOfRecordId: PARENT,
    childTaskId: `${ROUND}-t2`,
    childWorkerId: "workerzeta",
    status: "failed",
    completedAt: "2026-10-01T06:00:00.000Z",
    parentRoundTotal: 3,
    parentRoundOrder: 2,
    ...overrides,
  };
}

function rejectCode(result: ReturnType<InMemoryA2ABroker["ingestCrossBrokerTerminalBriefProjection"]>): string | undefined {
  return result.accepted ? undefined : result.ack.code;
}

test("PR-3b a retry child finishing later takes the slot; the first attempt is kept as superseded", () => {
  const broker = parentWithLegacyRound();
  const r1 = broker.ingestCrossBrokerTerminalBriefProjection(request());
  assert.equal(r1.accepted, true);

  const r2 = broker.ingestCrossBrokerTerminalBriefProjection(request({
    childTaskId: `${ROUND}-t2r2`,
    status: "succeeded",
    completedAt: "2026-10-01T06:20:00.000Z",
  }));
  assert.equal(r2.accepted, true);
  assert.ok(r2.accepted && !r2.replayed);

  // The aggregate (list/get) sees only r2 for slot 2.
  const live = broker.listCrossBrokerTerminalBriefProjections({ parentRoundId: ROUND });
  assert.deepEqual(live.map((record) => record.childTaskId), [`${ROUND}-t2r2`]);
  assert.equal(broker.getCrossBrokerTerminalBriefProjection(ROUND, PARENT)?.childTaskId, `${ROUND}-t2r2`);

  // r1 survives for audit, marked with the record that displaced it.
  const audit = broker.listCrossBrokerTerminalBriefProjections({ parentRoundId: ROUND, includeSuperseded: true });
  const superseded = audit.find((record) => record.childTaskId === `${ROUND}-t2`);
  assert.ok(superseded?.superseded);
  assert.equal(superseded.superseded.by, r2.accepted ? r2.record.id : "");
  assert.equal(broker.getCrossBrokerTerminalBriefDiagnostics().slotSuperseded, 1);

  // r2's operator row keeps the parent slot as its title numerator.
  const r2Row = broker.getTerminalTaskEventOutbox().subscribe().find((event) =>
    event.payload.taskId === `${ROUND}-t2r2` && !event.payload.notificationOwnership);
  assert.equal(r2Row?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 2/3)");
});

test("PR-3b a different child that completed at the same time or earlier is stale_replay", () => {
  const broker = parentWithLegacyRound();
  broker.ingestCrossBrokerTerminalBriefProjection(request({ completedAt: "2026-10-01T06:20:00.000Z" }));

  for (const completedAt of ["2026-10-01T06:20:00.000Z", "2026-10-01T06:10:00.000Z"]) {
    const late = broker.ingestCrossBrokerTerminalBriefProjection(request({ childTaskId: `${ROUND}-t2r2`, completedAt }));
    assert.equal(rejectCode(late), "stale_replay");
  }
  assert.deepEqual(
    broker.listCrossBrokerTerminalBriefProjections({ parentRoundId: ROUND }).map((record) => record.childTaskId),
    [`${ROUND}-t2`],
  );
  assert.equal(broker.getCrossBrokerTerminalBriefDiagnostics().slotSuperseded, 0);
});

test("PR-3b the same child's resend keeps duplicate_replay / stale_replay, and a later resend can win back the slot", () => {
  const broker = parentWithLegacyRound();
  broker.ingestCrossBrokerTerminalBriefProjection(request());
  const replay = broker.ingestCrossBrokerTerminalBriefProjection(request());
  assert.ok(replay.accepted && replay.replayed, "an identical resend is duplicate_replay");
  assert.equal(rejectCode(broker.ingestCrossBrokerTerminalBriefProjection(request({ completedAt: "2026-10-01T05:00:00.000Z", summary: "older" }))), "stale_replay");

  broker.ingestCrossBrokerTerminalBriefProjection(request({ childTaskId: `${ROUND}-t2r2`, completedAt: "2026-10-01T06:20:00.000Z" }));
  // The original child reports again, later still: it takes the slot back.
  const back = broker.ingestCrossBrokerTerminalBriefProjection(request({ completedAt: "2026-10-01T06:40:00.000Z", status: "succeeded" }));
  assert.equal(back.accepted, true);
  assert.deepEqual(
    broker.listCrossBrokerTerminalBriefProjections({ parentRoundId: ROUND }).map((record) => record.childTaskId),
    [`${ROUND}-t2`],
  );
  assert.equal(broker.listCrossBrokerTerminalBriefProjections({ parentRoundId: ROUND, includeSuperseded: true }).length, 2);
});

test("PR-3b slots are per parent round, handoff broker, and order", () => {
  const broker = parentWithLegacyRound();
  broker.ingestCrossBrokerTerminalBriefProjection(request());
  // A different order in the same round: a separate slot.
  assert.equal(broker.ingestCrossBrokerTerminalBriefProjection(request({ childTaskId: "lane-3", parentRoundOrder: 3 })).accepted, true);
  // Same order from a different handoff broker: a separate slot.
  assert.equal(
    broker.ingestCrossBrokerTerminalBriefProjection(request({ childTaskId: "gamma-lane-2", handoffBrokerId: "brokergamma" })).accepted,
    true,
  );
  assert.equal(broker.listCrossBrokerTerminalBriefProjections({ parentRoundId: ROUND }).length, 3);
  assert.equal(broker.getCrossBrokerTerminalBriefDiagnostics().slotSuperseded, 0);
});

test("PR-3b superseded records persist across a restart and stay out of the aggregate", () => {
  const broker = parentWithLegacyRound();
  broker.ingestCrossBrokerTerminalBriefProjection(request());
  broker.ingestCrossBrokerTerminalBriefProjection(request({ childTaskId: `${ROUND}-t2r2`, completedAt: "2026-10-01T06:20:00.000Z" }));

  const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot(), { brokerId: PARENT, knownBrokerIds: [CHILD] });
  assert.deepEqual(
    restarted.listCrossBrokerTerminalBriefProjections({ parentRoundId: ROUND }).map((record) => record.childTaskId),
    [`${ROUND}-t2r2`],
  );
  assert.equal(restarted.listCrossBrokerTerminalBriefProjections({ parentRoundId: ROUND, includeSuperseded: true }).length, 2);
  // The restored slot still guards against a stale rival.
  assert.equal(
    rejectCode(restarted.ingestCrossBrokerTerminalBriefProjection(request({ childTaskId: `${ROUND}-t2r3`, completedAt: "2026-10-01T06:10:00.000Z" }))),
    "stale_replay",
  );
});

test("PR-3b HTTP query hides superseded records unless include_superseded=true", async () => {
  const server = await startTestServer({ brokerId: PARENT, knownBrokerIds: [CHILD] });
  try {
    const broker = server.runtime.broker as InMemoryA2ABroker;
    broker.registerWorker({
      nodeId: "worker-a",
      role: "analyst",
      capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["t"], environments: ["research"] },
    });
    broker.createTask({
      id: ROUND,
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "parent round",
      payload: { parentRoundTotal: 3 },
    });
    broker.ingestCrossBrokerTerminalBriefProjection(request());
    broker.ingestCrossBrokerTerminalBriefProjection(request({ childTaskId: `${ROUND}-t2r2`, completedAt: "2026-10-01T06:20:00.000Z" }));

    const hub = jsonHeaders({ "x-a2a-requester-id": "hub-alpha", "x-a2a-requester-role": "hub" });
    const base = `${server.baseUrl}/a2a/cross-broker/terminal-briefs?parent_round_id=${ROUND}`;
    const live = await (await fetch(base, { headers: hub })).json() as { count: number };
    const audit = await (await fetch(`${base}&include_superseded=true`, { headers: hub })).json() as { count: number };
    assert.equal(live.count, 1);
    assert.equal(audit.count, 2);
  } finally {
    await server.close();
  }
});
