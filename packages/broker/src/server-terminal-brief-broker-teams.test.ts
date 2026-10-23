// #2339 spec item 2: a configured Terminal Brief broker-team registry
// (A2A_TERMINAL_BRIEF_BROKER_TEAMS) replaces the resolver's placeholder, so
// routing checks work with real broker ids. Unset keeps today's behaviour.
import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryA2ABroker } from "./core/broker.js";
import { parseTerminalBriefBrokerTeams } from "./core/terminal-brief-routing.js";
import { jsonHeaders, startTestServer } from "./server-test-helpers.js";

const TEAMS = "seoseo=team1,gwakga=team2";
const HUB = jsonHeaders({ "x-a2a-requester-id": "hub-seoseo", "x-a2a-requester-role": "hub" });

test("broker-team registry parsing: valid, unset, and malformed input", () => {
  assert.deepEqual(parseTerminalBriefBrokerTeams(" Seoseo = team1 , gwakga=TEAM2 "), [
    { brokerId: "seoseo", teamId: "team1" },
    { brokerId: "gwakga", teamId: "team2" },
  ]);
  assert.equal(parseTerminalBriefBrokerTeams(undefined), undefined);
  assert.equal(parseTerminalBriefBrokerTeams("  "), undefined);
  for (const bad of ["seoseo", "seoseo=team3", "=team1", "seoseo=team1=x", "seoseo=team1,seoseo=team2", "seoseo=team1,gwakga=team1"]) {
    assert.throws(() => parseTerminalBriefBrokerTeams(bad), /A2A_TERMINAL_BRIEF_BROKER_TEAMS/, bad);
  }
});

function parentWithRoutedRound(teams?: string): InMemoryA2ABroker {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    brokerId: "seoseo",
    knownBrokerIds: ["gwakga"],
    ...(teams ? { terminalBriefBrokerTeams: parseTerminalBriefBrokerTeams(teams) } : {}),
  });
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["t"], environments: ["research"] },
  });
  broker.createTask({
    id: "legacy-routed-round",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "parent round with routing metadata",
    payload: { parentRoundTotal: 2, teamScope: "team1+team2", initiatingBrokerId: "seoseo" },
  });
  return broker;
}

function projection(handoffBrokerId: string, child: string) {
  return {
    parentRoundId: "legacy-routed-round",
    originBrokerId: "seoseo",
    handoffBrokerId,
    brokerOfRecordId: "seoseo",
    childTaskId: child,
    status: "succeeded" as const,
    completedAt: "2026-10-01T05:00:00.000Z",
    parentRoundTotal: 2,
    parentRoundOrder: child === "c1" ? 1 : 2,
  };
}

test("legacy routing uses the configured registry: a wrong handoff broker is routing_mismatch", () => {
  const broker = parentWithRoutedRound(TEAMS);
  const wrong = broker.ingestCrossBrokerTerminalBriefProjection(projection("brokergamma", "c1"));
  assert.equal(wrong.accepted, false);
  assert.equal(wrong.accepted ? undefined : wrong.ack.code, "routing_mismatch");
  assert.equal(broker.ingestCrossBrokerTerminalBriefProjection(projection("gwakga", "c2")).accepted, true);
});

test("without a registry the placeholder never resolves real broker ids, so routing stays unchecked (unchanged)", () => {
  const broker = parentWithRoutedRound();
  assert.equal(broker.ingestCrossBrokerTerminalBriefProjection(projection("brokergamma", "c1")).accepted, true);
  assert.equal(broker.resolveConfiguredParentOriginRoute("seoseo", "team1+team2"), undefined);
});

async function mint(baseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/a2a/parent-rounds`, { method: "POST", headers: HUB, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as { entry?: Record<string, unknown>; error?: unknown } };
}

test("mint with a registry: the resolver fills the handoff broker and refuses inconsistent routes", async () => {
  const server = await startTestServer({ brokerId: "seoseo", knownBrokerIds: ["gwakga"], terminalBriefBrokerTeams: TEAMS });
  try {
    const filled = await mint(server.baseUrl, { parentRoundId: "r-fill", teamScope: "both", parentRoundTotal: 2 });
    assert.equal(filled.status, 201);
    assert.equal(filled.body.entry?.handoffBrokerId, "gwakga", "handoff broker derived from the route");
    assert.equal(filled.body.entry?.teamScope, "team1+team2", "team scope is stored normalized");

    assert.equal((await mint(server.baseUrl, { parentRoundId: "r-ok", teamScope: "team1+team2", handoffBrokerId: "gwakga" })).status, 201);
    for (const body of [
      { parentRoundId: "r-wrong-handoff", teamScope: "team1+team2", handoffBrokerId: "brokergamma" },
      { parentRoundId: "r-not-owned", teamScope: "team2-only" },
      { parentRoundId: "r-local-with-handoff", teamScope: "team1-only", handoffBrokerId: "gwakga" },
      { parentRoundId: "r-bad-scope", teamScope: "everyone" },
      { parentRoundId: "r-foreign-initiator", teamScope: "team1+team2", initiatingBrokerId: "gwakga" },
    ]) {
      assert.equal((await mint(server.baseUrl, body)).status, 400, JSON.stringify(body));
    }
    // A local-only scope mints without a handoff broker.
    const local = await mint(server.baseUrl, { parentRoundId: "r-local", teamScope: "team1-only" });
    assert.equal(local.status, 201);
    assert.equal(local.body.entry?.handoffBrokerId, undefined);

    const health = await (await fetch(`${server.baseUrl}/health`)).json() as { terminalBriefRouting: { brokerTeams: unknown } };
    assert.deepEqual(health.terminalBriefRouting.brokerTeams, [
      { brokerId: "seoseo", teamId: "team1" },
      { brokerId: "gwakga", teamId: "team2" },
    ]);
  } finally {
    await server.close();
  }
});

test("mint without a registry keeps today's behaviour (no route checks) and /health reports null", async () => {
  const server = await startTestServer({ brokerId: "seoseo", knownBrokerIds: ["gwakga"] });
  try {
    const minted = await mint(server.baseUrl, { parentRoundId: "r-any", teamScope: "everyone", handoffBrokerId: "brokergamma" });
    assert.equal(minted.status, 201);
    assert.equal(minted.body.entry?.teamScope, "everyone");
    const health = await (await fetch(`${server.baseUrl}/health`)).json() as { terminalBriefRouting: { brokerTeams: unknown } };
    assert.equal(health.terminalBriefRouting.brokerTeams, null);
  } finally {
    await server.close();
  }
});

test("a malformed registry, or one that omits this broker, refuses to start", async () => {
  await assert.rejects(startTestServer({ brokerId: "seoseo", terminalBriefBrokerTeams: "seoseo=team9" }), /must be <brokerId>=team1\|team2/);
  await assert.rejects(startTestServer({ brokerId: "seoseo", terminalBriefBrokerTeams: "gwakga=team2" }), /does not list this broker/);
});
