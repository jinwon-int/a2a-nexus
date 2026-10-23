// #2339 PR-1c: cross-broker projections for a registered parent round are
// judged against the registry (parent broker, handoff broker, anchors); rounds
// that were never registered keep the legacy task-id fallback.
import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryA2ABroker } from "./broker.js";
import type { CrossBrokerTerminalBriefProjectionRequest } from "./cross-broker-terminal-brief.js";
import type { ParentRoundMintInput } from "./parent-round-registry.js";
import { jsonHeaders, startTestServer } from "../server-test-helpers.js";

const PARENT = "brokeralpha";
const CHILD = "brokerbeta";
const ROUND = "brokeralpha-round-9";
const T0 = "2026-10-23T05:00:00.000Z";

function parentBroker(): InMemoryA2ABroker {
  return new InMemoryA2ABroker(undefined, undefined, { brokerId: PARENT, knownBrokerIds: [CHILD] });
}

function mint(overrides: Partial<ParentRoundMintInput> = {}): ParentRoundMintInput {
  return {
    parentRoundId: ROUND,
    originBrokerId: PARENT,
    parentBrokerId: PARENT,
    initiatingBrokerId: PARENT,
    teamScope: "team1",
    handoffBrokerId: CHILD,
    parentRoundTotal: 2,
    kind: "local-origin",
    mintedAt: T0,
    mintedBy: { requesterId: "hub-alpha", role: "hub" },
    ...overrides,
  };
}

function request(overrides: Partial<CrossBrokerTerminalBriefProjectionRequest> = {}): CrossBrokerTerminalBriefProjectionRequest {
  return {
    parentRoundId: ROUND,
    originBrokerId: PARENT,
    handoffBrokerId: CHILD,
    brokerOfRecordId: PARENT,
    childTaskId: "brokerbeta-child-1",
    childWorkerId: "workerzeta",
    status: "succeeded",
    completedAt: "2026-10-23T05:10:00.000Z",
    parentRoundTotal: 2,
    parentRoundOrder: 1,
    ...overrides,
  };
}

function rejectCode(result: ReturnType<InMemoryA2ABroker["ingestCrossBrokerTerminalBriefProjection"]>): string | undefined {
  return result.accepted ? undefined : result.ack.code;
}

test("PR-1c a registered round with no anchors rejects every projection as missing_anchor", () => {
  const broker = parentBroker();
  broker.mintParentRound(mint());

  const result = broker.ingestCrossBrokerTerminalBriefProjection(request());

  assert.equal(rejectCode(result), "missing_anchor");
  assert.match(result.ack.reason, /has no anchors yet/);
  assert.equal(broker.getTerminalTaskEventOutbox().size, 0, "nothing reaches the parent outbox");
  assert.equal(broker.getCrossBrokerTerminalBriefDiagnostics().missingAnchor, 1);
});

test("PR-1c an anchored child is accepted via the registry and counted as parent_resolved_via=registry", () => {
  const broker = parentBroker();
  broker.mintParentRound(mint());
  broker.addParentRoundAnchor(ROUND, "brokerbeta-child-1");

  const result = broker.ingestCrossBrokerTerminalBriefProjection(request());

  assert.equal(result.accepted, true);
  assert.ok(broker.getTerminalTaskEventOutbox().size > 0, "the parent renders the aggregate");
  const diagnostics = broker.getCrossBrokerTerminalBriefDiagnostics();
  assert.equal(diagnostics.parentResolvedViaRegistry, 1);
  assert.equal(diagnostics.parentResolvedViaLegacyTask, 0);
});

test("PR-1c the origin task anchor admits a child whose task id was not pre-registered", () => {
  const broker = parentBroker();
  broker.mintParentRound(mint({ anchors: ["brokeralpha-parent-task-1"] }));

  assert.equal(
    rejectCode(broker.ingestCrossBrokerTerminalBriefProjection(request({ childTaskId: "unlisted-child" }))),
    "missing_anchor",
    "without originTaskId an unlisted child is refused",
  );
  const result = broker.ingestCrossBrokerTerminalBriefProjection(
    request({ childTaskId: "unlisted-child", originTaskId: "brokeralpha-parent-task-1" }),
  );
  assert.equal(result.accepted, true);
});

test("PR-1c an unanchored future-dated projection cannot pre-empt the real child (L2 rebuttal)", () => {
  const broker = parentBroker();
  broker.mintParentRound(mint({ anchors: ["brokerbeta-child-1"] }));

  // An attacker-chosen child id with the same slot and a later completedAt.
  const forged = broker.ingestCrossBrokerTerminalBriefProjection(request({
    childTaskId: "forged-child",
    completedAt: "2026-10-23T05:12:00.000Z",
  }));
  assert.equal(rejectCode(forged), "missing_anchor");

  const real = broker.ingestCrossBrokerTerminalBriefProjection(request());
  assert.equal(real.accepted, true, "the real child is not turned into stale_replay");
});

test("PR-1c a registered handoff broker activates routing_mismatch and the parent broker gate", () => {
  const broker = parentBroker();
  broker.mintParentRound(mint({ anchors: ["brokerbeta-child-1"] }));

  assert.equal(
    rejectCode(broker.ingestCrossBrokerTerminalBriefProjection(request({ handoffBrokerId: "brokergamma" }))),
    "routing_mismatch",
  );
  // A legacy packet (no handoffBrokerId) reads originBrokerId as the producer.
  const legacy = broker.ingestCrossBrokerTerminalBriefProjection(request({ handoffBrokerId: undefined, originBrokerId: CHILD }));
  assert.equal(legacy.accepted, true);
});

test("PR-1c foreign-handoff entries never make this broker the parent", () => {
  const broker = parentBroker();
  broker.mintParentRound(mint({
    kind: "foreign-handoff",
    originBrokerId: CHILD,
    parentBrokerId: CHILD,
    initiatingBrokerId: CHILD,
    handoffBrokerId: PARENT,
    anchors: ["brokerbeta-child-1"],
  }));

  assert.equal(rejectCode(broker.ingestCrossBrokerTerminalBriefProjection(request())), "missing_parent");
});

test("PR-1c unregistered rounds keep the legacy task-id fallback, and a self-referencing child is still missing_parent", () => {
  const broker = parentBroker();
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["t"], environments: ["research"] },
  });
  broker.createTask({
    id: "legacy-round",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "legacy parent round",
    payload: { parentRoundTotal: 2 },
  });

  const legacy = broker.ingestCrossBrokerTerminalBriefProjection(request({ parentRoundId: "legacy-round", childTaskId: "anything" }));
  assert.equal(legacy.accepted, true, "no anchors are required for an unregistered round");
  assert.equal(broker.getCrossBrokerTerminalBriefDiagnostics().parentResolvedViaLegacyTask, 1);

  // #2331 (f): the child's own round id never resolves on the parent.
  assert.equal(
    rejectCode(broker.ingestCrossBrokerTerminalBriefProjection(request({ parentRoundId: "legacy-round-t2" }))),
    "missing_parent",
  );
});

test("PR-1c a task payload cannot mint a registry entry", () => {
  const broker = parentBroker();
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["t"], environments: ["research"] },
  });
  broker.createTask({
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "child claiming a parent",
    payload: {
      parentRoundId: "claimed-round",
      parentRoundTotal: 2,
      crossBrokerHandoff: { parentRoundId: "claimed-round", originBrokerId: CHILD, handoffBrokerId: PARENT, originTaskId: "x" },
    },
  });

  assert.deepEqual(broker.listParentRounds(), []);
  assert.equal(rejectCode(broker.ingestCrossBrokerTerminalBriefProjection(request({ parentRoundId: "claimed-round" }))), "missing_parent");
});

test("PR-1c judgment survives a restart through the persisted registry", () => {
  const broker = parentBroker();
  broker.mintParentRound(mint({ anchors: ["brokerbeta-child-1"] }));

  const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot(), { brokerId: PARENT, knownBrokerIds: [CHILD] });
  assert.equal(restarted.ingestCrossBrokerTerminalBriefProjection(request()).accepted, true);
  assert.equal(rejectCode(restarted.ingestCrossBrokerTerminalBriefProjection(request({ childTaskId: "other" }))), "missing_anchor");
});

test("PR-1c HTTP: mint, missing_anchor 404, anchor, then 202 through the projection route", async () => {
  const server = await startTestServer({ brokerId: PARENT, knownBrokerIds: [CHILD] });
  try {
    const hub = jsonHeaders({ "x-a2a-requester-id": "hub-alpha", "x-a2a-requester-role": "hub" });
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${server.baseUrl}${path}`, { method: "POST", headers: hub, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { ack?: { code?: string } } };
    };

    assert.equal((await post("/a2a/parent-rounds", { parentRoundId: ROUND, handoffBrokerId: CHILD, parentRoundTotal: 2 })).status, 201);
    const refused = await post("/a2a/cross-broker/terminal-briefs", request());
    assert.equal(refused.status, 404);
    assert.equal(refused.body.ack?.code, "missing_anchor");

    assert.equal((await post(`/a2a/parent-rounds/${ROUND}/anchors`, { anchor: "brokerbeta-child-1" })).status, 201);
    const accepted = await post("/a2a/cross-broker/terminal-briefs", request());
    assert.equal(accepted.status, 202);
  } finally {
    await server.close();
  }
});
