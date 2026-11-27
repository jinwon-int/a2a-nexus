// #2556: the dispatch helper's cross-broker handoff plan, executed end to end
// against two brokers that run with a broker-team registry. Everything the
// brokers receive comes from the helper's plan: the mint and anchor pre-steps,
// the registration receipt, and the child task payload. The relay must then be
// accepted by the parent through its registry entry — the path that failed in
// three places before #2556 (literal broker
// id in the Team2 gate, a team scope the minting broker refuses, and a child
// payload that named the plan's local round).
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildA2ADispatchPlan, type A2ADispatchSpec } from "./core/dispatch/a2a-dispatch-helper.js";
import {
  buildA2AWorkModeDecisionEvidence,
  buildA2AWorkModePreDispatchDecision,
} from "./core/dispatch/work-mode-pre-dispatch-decision.js";
import { pollCrossBrokerTerminalBriefReceiver } from "./core/completion/cross-broker-terminal-brief-receiver.js";
import { parseTerminalBriefBrokerTeams } from "./core/completion/terminal-brief-routing.js";
import { jsonHeaders, startTestServer } from "./server-test-helpers.js";

const TEAM1_BROKER = "northbroker";
const TEAM2_BROKER = "southbroker";
const BROKER_TEAMS = `${TEAM1_BROKER}=team1,${TEAM2_BROKER}=team2`;
const WORKER = "handoff-worker";
const OPERATOR = jsonHeaders({ "x-a2a-requester-id": "handoff-operator", "x-a2a-requester-role": "operator" });
const AS_WORKER = jsonHeaders({ "x-a2a-requester-id": WORKER, "x-a2a-requester-role": "analyst" });
const EXECUTE = { dryRun: false, execute: true };

async function call(baseUrl: string, method: "GET" | "POST", path: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function find(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (key in record) return record[key];
  for (const nested of Object.values(record)) {
    const hit = find(nested, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function workModeDecision(finalizerOwner: string) {
  return buildA2AWorkModeDecisionEvidence(
    buildA2AWorkModePreDispatchDecision({
      now: "2026-11-27T04:00:00.000Z",
      finalizerOwner,
      task: {
        taskId: "handoff-e2e",
        workProfile: "candidate_review",
        ambiguity: "high",
        hasIndependentEvidenceLanes: true,
        hasMultipleCandidates: true,
      },
      workers: { capacityState: "healthy", staleTasks: 0, snapshotSource: "/workers/capacity", snapshotAt: "2026-11-27T03:59:00.000Z" },
    }),
  );
}

const CASES = [
  { name: "team2's broker hands a team1 child to team1's broker", parentBroker: TEAM2_BROKER, childBroker: TEAM1_BROKER, childTeam: "team1" as const, parentTeam: "team2" },
  { name: "team1's broker hands a team2 child to team2's broker", parentBroker: TEAM1_BROKER, childBroker: TEAM2_BROKER, childTeam: "team2" as const, parentTeam: "team1" },
];

for (const scenario of CASES) {
  test(`#2556 helper handoff plan end to end: ${scenario.name}`, async () => {
    const brokerTeams = parseTerminalBriefBrokerTeams(BROKER_TEAMS);
    const parent = await startTestServer({ brokerId: scenario.parentBroker, teamId: scenario.parentTeam, knownBrokerIds: [scenario.childBroker], terminalBriefBrokerTeams: BROKER_TEAMS });
    const child = await startTestServer({ brokerId: scenario.childBroker, teamId: scenario.childTeam, knownBrokerIds: [scenario.parentBroker], terminalBriefBrokerTeams: BROKER_TEAMS });
    try {
      const round = `${scenario.parentBroker}-parent-round`;
      const spec: A2ADispatchSpec = {
        teamId: scenario.childTeam,
        lane: 1,
        worker: WORKER,
        runId: `${scenario.childBroker}-child-run`,
        parentIssueUrl: "https://github.com/acme/platform/issues/290",
        childIssueUrl: "https://github.com/acme/platform/issues/291",
        parentRoundTotal: 1,
        parentRoundOrder: 1,
        brokerOfRecordId: scenario.childBroker,
        originBrokerId: scenario.parentBroker,
        operatorFacingOwner: "parent",
        readOnlyValidation: true,
        allowNoChanges: true,
        crossBrokerHandoff: {
          parentRoundId: round,
          originBrokerId: scenario.parentBroker,
          handoffBrokerId: scenario.childBroker,
          originTaskId: `${round}-origin-task`,
          childWorkerId: WORKER,
        },
        ...(scenario.childTeam === "team1" ? { workModeDecision: workModeDecision(scenario.parentBroker) } : {}),
      };

      // 1. Execute mode without proof of registration is blocked, and prints the pre-steps.
      const unproven = buildA2ADispatchPlan(spec, { ...EXECUTE, brokerTeams });
      assert.equal(unproven.decision.value, "blocked");
      assert.deepEqual(unproven.decision.blockers.map((blocker) => blocker.slice(0, blocker.indexOf("]") + 1)), ["[parent_round_registry_receipt]"]);
      const registration = unproven.parentRoundRegistration;
      assert.ok(registration);
      assert.equal(registration.mintingBrokerId, scenario.parentBroker);

      // 2. The printed pre-steps run as printed on the minting broker.
      const minted = await call(parent.baseUrl, "POST", registration.mint.path, OPERATOR, registration.mint.body);
      assert.equal(minted.status, 201, JSON.stringify(minted.body));
      for (const anchor of registration.anchors) {
        assert.equal((await call(parent.baseUrl, "POST", anchor.path, OPERATOR, anchor.body)).status, 201);
      }

      // 3. The broker's own entry is the receipt.
      const entry = await call(parent.baseUrl, "GET", `${registration.mint.path}/${encodeURIComponent(round)}`, OPERATOR);
      assert.equal(entry.status, 200);
      const proven = buildA2ADispatchPlan(spec, { ...EXECUTE, brokerTeams, parentRoundRegistrationReceipt: entry.body });
      assert.equal(proven.decision.value, "warn_go", JSON.stringify(proven.decision.blockers));
      assert.equal(proven.parentRoundRegistrationReceipt?.status, "verified");
      const payload = proven.taskPayload;
      assert.ok(payload);
      assert.equal(payload.taskId, unproven.deterministicTaskId.taskId);

      // 4. The child task is created from the plan's payload and finished by its worker.
      assert.equal((await call(child.baseUrl, "POST", "/workers/register", AS_WORKER, {
        nodeId: WORKER,
        role: "analyst",
        capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["test"], environments: ["research"] },
      })).status, 201);
      const created = await call(child.baseUrl, "POST", "/tasks", OPERATOR, {
        id: payload.taskId,
        intent: "analyze",
        requester: { id: "handoff-operator", kind: "service", role: "operator" },
        target: { id: WORKER, kind: "node", role: "analyst" },
        assignedWorkerId: WORKER,
        brokerOfRecord: scenario.childBroker,
        teamId: scenario.childTeam,
        message: "handoff child",
        payload,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      for (const action of ["claim", "start"]) {
        assert.equal((await call(child.baseUrl, "POST", `/tasks/${payload.taskId}/${action}`, AS_WORKER, { workerId: WORKER })).status, 200, action);
      }
      const completed = await call(child.baseUrl, "POST", `/tasks/${payload.taskId}/complete`, AS_WORKER, { workerId: WORKER, result: { summary: "child finished" } });
      assert.equal(completed.status, 200, JSON.stringify(completed.body));

      // 5. The child's terminal row is parent-owned and names the registered round.
      const outbox = await call(child.baseUrl, "GET", "/a2a/tasks/terminal-outbox", OPERATOR);
      const events = outbox.body.events as Array<{ payload: Record<string, unknown> }>;
      const event = events.find((candidate) => candidate.payload.taskId === payload.taskId);
      assert.ok(event);
      assert.equal(event.payload.parentRoundId, round);
      assert.deepEqual(
        { scope: (event.payload.notificationOwnership as Record<string, unknown>).scope, owner: (event.payload.notificationOwnership as Record<string, unknown>).ownerBrokerId },
        { scope: "parent-broker-only", owner: scenario.parentBroker },
      );

      // 6. One relay poll: the parent accepts through its registry entry.
      const poll = await pollCrossBrokerTerminalBriefReceiver(
        { sourceBrokerId: scenario.childBroker, sourceBaseUrl: child.baseUrl, destinationBrokerId: scenario.parentBroker, destinationBaseUrl: parent.baseUrl, emitMintedOriginBrokerId: true, requesterId: "handoff-receiver", requesterRole: "hub" },
        (url, init) => fetch(url, init),
      );
      assert.equal(poll.ok, true);
      assert.equal(poll.accepted, 1, JSON.stringify(poll));
      assert.deepEqual(poll.skippedByCode, {});
      assert.equal(poll.relayFallbackLocal, 0);

      const counters = find((await call(parent.baseUrl, "GET", "/health", OPERATOR)).body, "crossBrokerTerminalBriefs") as Record<string, number>;
      assert.equal(counters.parentResolvedViaRegistry, 1);
      assert.equal(counters.missingParent, 0);
      assert.equal(counters.missingAnchor, 0);
      const briefs = await call(parent.baseUrl, "GET", "/a2a/cross-broker/terminal-briefs", OPERATOR);
      const records = briefs.body.records as Array<Record<string, unknown>>;
      assert.equal(records.length, 1);
      assert.equal(records[0]?.parentRoundId, round);
      assert.equal(records[0]?.handoffBrokerId, scenario.childBroker);
      assert.equal(records[0]?.childTaskId, payload.taskId);
    } finally {
      await child.close();
      await parent.close();
    }
  });
}
