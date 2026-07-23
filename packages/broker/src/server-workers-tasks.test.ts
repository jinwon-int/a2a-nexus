import test from "node:test";
import assert from "node:assert/strict";
import { createBrokerServer } from "./server.js";
import { WorkerRegistrationResponse } from "./core/types.js";
import { createInMemoryStateStore, startTestServer, jsonHeaders, registerTestWorker } from "./server-test-helpers.js";

test("GET /rounds/:id/status reports round completion progress (#629)", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const round = "round-http-20260614";
    await registerTestWorker(server.baseUrl, "w1", "analyst");
    await registerTestWorker(server.baseUrl, "w2", "analyst");
    const make = (id: string, target: string) => ({
      id,
      requester: { id: "hub", kind: "node", role: "hub" },
      target: { id: target, kind: "node", role: "analyst" },
      targetNodeId: target,
      intent: "analyze",
      message: "round child",
      payload: { parentRoundId: round },
      taskOrigin: "api",
    });
    for (const [id, target] of [["r1", "w1"], ["r2", "w2"]] as const) {
      const res = await fetch(server.baseUrl + "/tasks", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(make(id, target)),
      });
      assert.equal(res.status, 201);
    }

    const statusRes = await fetch(`${server.baseUrl}/rounds/${encodeURIComponent(round)}/status`, {
      headers: jsonHeaders(),
    });
    assert.equal(statusRes.status, 200);
    const summary = await statusRes.json() as {
      parentRoundId: string; total: number; matched: number; completedCount: number;
      pendingCount: number; completionRate: number; incompleteTaskIds: string[];
    };
    assert.equal(summary.parentRoundId, round);
    assert.equal(summary.total, 2);
    assert.equal(summary.matched, 2);
    assert.equal(summary.completedCount, 0); // both queued
    assert.equal(summary.pendingCount, 2);
    assert.equal(summary.completionRate, 0);
    assert.deepEqual(summary.incompleteTaskIds.sort(), ["r1", "r2"]);
  } finally {
    await server.close();
  }
});

test("POST /tasks fails closed when payload exceeds configured task payload budget (#932)", async () => {
  const server = await startTestServer({
    enforceRequesterIdentity: false,
    maxTaskPayloadBytes: 256,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst");
    const res = await fetch(server.baseUrl + "/tasks", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        id: "task-large-source-bundle-rejected",
        requester: { id: "hub", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        intent: "analyze",
        message: "large source bundle should be externalized before dispatch",
        payload: {
          sourceBundle: {
            files: [{ path: "large.md", content: "x".repeat(600) }],
          },
        },
        taskOrigin: "api",
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } };
    assert.equal(body.error.code, "bad_request");
    assert.match(body.error.message, /task payload exceeds configured limit/i);
    assert.equal(body.error.details?.maxTaskPayloadBytes, 256);
    assert.equal(server.runtime.broker.getTask("task-large-source-bundle-rejected"), null);
  } finally {
    await server.close();
  }
});

test("POST /tasks rejects malformed acceptance at create time without mutating in-flight tasks (#1261 L2)", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst");
    server.runtime.broker.createTask({
      id: "existing-inflight-malformed-acceptance",
      requester: { id: "hub", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      intent: "analyze",
      message: "legacy in-flight task created before POST validation",
      payload: { acceptance: { command: "node scripts/check.js" } },
      taskOrigin: "api",
    });

    const res = await fetch(server.baseUrl + "/tasks", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        id: "task-malformed-acceptance-rejected-at-create",
        requester: { id: "hub", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        intent: "analyze",
        message: "malformed acceptance should be rejected before task creation",
        payload: { acceptance: { command: "node scripts/check.js" } },
        taskOrigin: "api",
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } };
    assert.equal(body.error.code, "acceptance_malformed");
    assert.match(body.error.message, /task\.payload\.acceptance is malformed/);
    assert.equal(body.error.details?.reason, "command must be a non-empty string array");
    assert.equal(server.runtime.broker.getTask("task-malformed-acceptance-rejected-at-create"), null);
    const existing = server.runtime.broker.getTask("existing-inflight-malformed-acceptance");
    assert.equal(existing?.status, "queued");
  } finally {
    await server.close();
  }
});

test("GET /rounds/:id/status rejects a malformed percent-encoded id with 400 (#743)", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const res = await fetch(`${server.baseUrl}/rounds/%E0%A4%A/status`, { headers: jsonHeaders() });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, "bad_request");
  } finally {
    await server.close();
  }
});

test("worker registration still records material metadata changes", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: true });
  const nodeId = "worker-a";
  const registration = {
    nodeId,
    role: "analyst",
    displayName: "Worker A",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  };
  const headers = jsonHeaders({
    "x-a2a-requester-id": nodeId,
    "x-a2a-requester-role": "analyst",
  });

  try {
    const first = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(registration),
    });
    assert.equal(first.status, 201);

    const changed = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...registration, displayName: "Worker A refreshed" }),
    });
    assert.equal(changed.status, 201);

    assert.equal(
      server.runtime.broker.listAuditEvents({ action: "worker.registered" }).length,
      2,
    );
    assert.equal(server.runtime.broker.getWorker(nodeId)?.displayName, "Worker A refreshed");
  } finally {
    await server.close();
  }
});

test("server surfaces duplicate nodeId identity churn warnings on worker capacity", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  const nodeId = "mobilebeta";
  const capabilities = {
    canAnalyze: true,
    canBackfill: false,
    canPatchWorkspace: false,
    canPromoteLive: false,
    workspaceIds: ["team2-brokerbeta"],
    environments: ["research"],
  };
  const baseRegistration = {
    nodeId,
    role: "analyst",
    displayName: "mobilebeta mobile worker",
    brokerUrl: "http://127.0.0.1:18787",
    workerMode: "mobile",
    capabilities,
    metadata: { runtime: "hermes-agent", transport: "http-poll" },
  };
  try {
    for (const registration of [
      baseRegistration,
      {
        ...baseRegistration,
        displayName: "mobilebeta JS-pinned worker",
        brokerUrl: "http://127.0.0.1:18790",
        workerMode: "persistent",
        metadata: { runtime: "claude-code", transport: "node-worker" },
      },
      baseRegistration,
    ]) {
      const res = await fetch(`${server.baseUrl}/workers/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(registration),
      });
      assert.equal(res.status, 201);
    }

    const churnEvents = server.runtime.broker.listAuditEvents({ action: "worker.identity_churn_detected" });
    assert.equal(churnEvents.length, 1);
    assert.match(churnEvents[0].note ?? "", /duplicate processes sharing the same nodeId/);

    const capacityRes = await fetch(`${server.baseUrl}/workers/capacity`);
    assert.equal(capacityRes.status, 200);
    const capacity = await capacityRes.json() as { items: Array<{ nodeId: string; identityWarning?: { code: string; lastChangedFields: string[] } }> };
    const mobilebeta = capacity.items.find((item) => item.nodeId === nodeId);
    assert.equal(mobilebeta?.identityWarning?.code, "worker_identity_churn");
    assert.ok(mobilebeta?.identityWarning?.lastChangedFields.includes("workerMode"));
  } finally {
    await server.close();
  }
});

test("server accepts a broker-agnostic Hermes-style worker poll and evidence flow", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  const workerId = "hermes-agent-reference-worker";
  try {
    const registerRes = await fetch(server.baseUrl + "/workers/register", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        nodeId: workerId,
        role: "analyst",
        displayName: "Hermes Agent Reference Worker",
        brokerUrl: "http://127.0.0.1:8787",
        workerMode: "mobile",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
          workspaceIds: ["public-safe-reference"],
          environments: ["research"],
        },
        metadata: {
          runtime: "hermes-agent",
          openClawRequired: "false",
          transport: "http-poll",
        },
      }),
    });
    assert.equal(registerRes.status, 201);
    const registered = await registerRes.json() as WorkerRegistrationResponse;
    assert.equal(registered.nodeId, workerId);
    assert.equal(registered.workerMode, "mobile");
    assert.deepEqual(registered.metadata, {
      runtime: "hermes-agent",
      openClawRequired: "false",
      transport: "http-poll",
    });

    const heartbeatRes = await fetch(server.baseUrl + "/workers/" + workerId + "/heartbeat", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ metadata: { runtime: "hermes-agent", heartbeat: "ok" } }),
    });
    assert.equal(heartbeatRes.status, 200);
    const heartbeat = await heartbeatRes.json() as WorkerRegistrationResponse;
    assert.deepEqual(heartbeat.metadata, { runtime: "hermes-agent", heartbeat: "ok" });

    const createRes = await fetch(server.baseUrl + "/tasks", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        id: "task-hermes-reference-worker",
        requester: { id: "hermes-requester", kind: "service", role: "hub" },
        target: { id: workerId, kind: "node", role: "analyst" },
        targetNodeId: workerId,
        intent: "analyze",
        message: "Broker-agnostic worker contract smoke task",
        payload: { source: "hermes-worker-integration-test" },
        taskOrigin: "api",
      }),
    });
    assert.equal(createRes.status, 201);

    const pollRes = await fetch(
      server.baseUrl + "/tasks?worker=" + encodeURIComponent(workerId) + "&status=pending&detail=full",
    );
    assert.equal(pollRes.status, 200);
    const polled = await pollRes.json() as { items: Array<{ id: string; status: string; assignedWorkerId?: string }> };
    assert.deepEqual(polled.items.map((task) => [task.id, task.status, task.assignedWorkerId]), [
      ["task-hermes-reference-worker", "queued", workerId],
    ]);

    const claimRes = await fetch(server.baseUrl + "/tasks/task-hermes-reference-worker/claim", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId }),
    });
    assert.equal(claimRes.status, 200);

    const startRes = await fetch(server.baseUrl + "/tasks/task-hermes-reference-worker/start", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId }),
    });
    assert.equal(startRes.status, 200);

    const evidenceRes = await fetch(server.baseUrl + "/tasks/task-hermes-reference-worker/evidence", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        workerId,
        outcome: "done",
        result: {
          summary: "Hermes-style worker produced redacted terminal evidence",
          output: { referenceWorker: "hermes-agent", openClawRequired: false },
        },
      }),
    });
    assert.equal(evidenceRes.status, 200);
    const evidenced = await evidenceRes.json() as {
      status: string;
      result?: { summary?: string; output?: Record<string, unknown> };
    };
    assert.equal(evidenced.status, "succeeded");
    assert.equal(evidenced.result?.summary, "Hermes-style worker produced redacted terminal evidence");
    assert.deepEqual(evidenced.result?.output, { referenceWorker: "hermes-agent", openClawRequired: false });
  } finally {
    await server.close();
  }
});



test("/health requires edge secret while /livez remains public liveness", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const livez = await fetch(`${server.baseUrl}/livez`);
    assert.equal(livez.status, 200);

    const unauthHealth = await fetch(`${server.baseUrl}/health`);
    assert.equal(unauthHealth.status, 401);

    const health = await fetch(`${server.baseUrl}/health`, {
      headers: { "x-a2a-edge-secret": "test-edge-secret" },
    });
    assert.equal(health.status, 200);
    const body = await health.json() as { requestSecurity?: unknown };
    assert.ok(body.requestSecurity, "authenticated /health keeps detailed diagnostics");
  } finally {
    await server.close();
  }
});

test("server requires a real PUBLIC_BASE_URL", () => {
  assert.throws(
    () =>
      createBrokerServer({
        host: "127.0.0.1",
        port: 0,
        publicBaseUrl: "http://<masked-host>:8787",
        stateStore: createInMemoryStateStore(),
      }),
    /PUBLIC_BASE_URL must not use the placeholder/,
  );

  assert.throws(
    () =>
      createBrokerServer({
        host: "127.0.0.1",
        port: 0,
        publicBaseUrl: "",
        stateStore: createInMemoryStateStore(),
      }),
    /PUBLIC_BASE_URL is required/,
  );
});

test("server rejects task creation when brokerOfRecord targets another broker", async () => {
  const server = await startTestServer({ brokerId: "brokerbeta" });
  try {
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "workereta",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "workereta",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
        },
      }),
    });
    assert.equal(registerRes.status, 201);

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "wrong-broker-of-record-task",
        intent: "validate_change",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workereta", kind: "node", role: "analyst" },
        assignedWorkerId: "workereta",
        brokerOfRecord: "brokeralpha",
        teamId: "team2",
        message: "should fail at creation before it can become queued",
      }),
    });
    assert.equal(createRes.status, 403);
    assert.deepEqual(await createRes.json(), {
      error: {
        code: "policy_denied",
        message: "create cannot set brokerOfRecord brokeralpha on broker brokerbeta",
      },
    });

    const listRes = await fetch(`${server.baseUrl}/tasks?detail=full`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json() as { items: Array<{ id: string }> };
    assert.deepEqual(listBody.items.map((task) => task.id), []);
  } finally {
    await server.close();
  }
});

test("server accepts local brokerOfRecord with parent-owned cross-broker Terminal Brief metadata", async () => {
  const server = await startTestServer({ brokerId: "brokerbeta", teamId: "team2" });
  try {
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "workerzeta",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "workerzeta",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
        },
      }),
    });
    assert.equal(registerRes.status, 201);

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "brokeralpha",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "brokeralpha-led-team2-parent-owned-task",
        intent: "verify",
        requester: { id: "brokeralpha", kind: "node", role: "hub" },
        target: { id: "workerzeta", kind: "node", role: "analyst" },
        assignedWorkerId: "workerzeta",
        brokerOfRecord: "brokerbeta",
        teamId: "team2",
        message: "source-only Team2 handoff with brokeralpha parent ownership",
        payload: {
          parentRoundId: "terminal-brief-contract-round",
          parentRoundTotal: 7,
          parentRoundOrder: 6,
          parentBrokerId: "brokeralpha",
          brokerOfRecordId: "brokeralpha",
          crossBrokerHandoff: {
            parentRoundId: "terminal-brief-contract-round",
            originBrokerId: "brokeralpha",
            handoffBrokerId: "brokerbeta",
            childWorkerId: "workerzeta",
          },
          notificationOwnership: {
            owner: "parent",
            ownerBrokerId: "brokeralpha",
            scope: "parent-broker-only",
            providerSendPermittedByProjection: false,
            terminalAckPermittedByProjection: false,
          },
          terminalBrief: {
            parentOwnedTerminalBrief: true,
            notificationOwnership: {
              owner: "parent",
              ownerBrokerId: "brokeralpha",
              scope: "parent-broker-only",
            },
          },
        },
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json() as {
      brokerOfRecord?: string;
      teamId?: string;
      payload?: Record<string, unknown>;
    };
    assert.equal(created.brokerOfRecord, "brokerbeta", "top-level brokerOfRecord is the local accepting broker");
    assert.equal(created.teamId, "team2");
    assert.equal(created.payload?.["brokerOfRecordId"], "brokeralpha", "parent/finalizer owner remains payload metadata");
    assert.deepEqual(created.payload?.["crossBrokerHandoff"], {
      parentRoundId: "terminal-brief-contract-round",
      originBrokerId: "brokeralpha",
      handoffBrokerId: "brokerbeta",
      childWorkerId: "workerzeta",
    });
    assert.deepEqual(created.payload?.["notificationOwnership"], {
      owner: "parent",
      ownerBrokerId: "brokeralpha",
      scope: "parent-broker-only",
      providerSendPermittedByProjection: false,
      terminalAckPermittedByProjection: false,
      reason: "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
    });
  } finally {
    await server.close();
  }
});

test("server rejects parent-owned handoff metadata for a different accepting broker", async () => {
  const server = await startTestServer({ brokerId: "brokerbeta", teamId: "team2" });
  try {
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "workerzeta",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "workerzeta",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
        },
      }),
    });
    assert.equal(registerRes.status, 201);

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "brokeralpha",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "wrong-handoff-broker-parent-owned-task",
        intent: "verify",
        requester: { id: "brokeralpha", kind: "node", role: "hub" },
        target: { id: "workerzeta", kind: "node", role: "analyst" },
        assignedWorkerId: "workerzeta",
        brokerOfRecord: "brokerbeta",
        teamId: "team2",
        message: "contradictory handoff metadata should fail closed",
        payload: {
          parentRoundId: "terminal-brief-contract-round",
          parentRoundTotal: 7,
          parentRoundOrder: 6,
          parentBrokerId: "brokeralpha",
          crossBrokerHandoff: {
            parentRoundId: "terminal-brief-contract-round",
            originBrokerId: "brokeralpha",
            handoffBrokerId: "brokeralpha",
          },
        },
      }),
    });
    assert.equal(createRes.status, 400);
    const body = await createRes.json() as { error?: { code?: string; message?: string } };
    assert.equal(body.error?.code, "bad_request");
    assert.match(body.error?.message ?? "", /handoffBrokerId/);
    assert.match(body.error?.message ?? "", /accepting broker/);
  } finally {
    await server.close();
  }
});

test("POST /tasks rejects missing requester/target fields with 400 instead of 500 (#760)", async () => {
  const server = await startTestServer();
  try {
    server.runtime.broker.registerWorker({
      nodeId: "worker-a",
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

    const missingRequesterRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "test-hub",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "missing-requester-task",
        intent: "analyze",
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "missing requester should be a client error",
      }),
    });
    assert.equal(missingRequesterRes.status, 400);
    const missingRequesterBody = await missingRequesterRes.json() as { error?: { code?: string; message?: string } };
    assert.equal(missingRequesterBody.error?.code, "bad_request");
    assert.match(missingRequesterBody.error?.message ?? "", /requester\.id/);

    const missingTargetRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "test-hub",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "missing-target-task",
        intent: "analyze",
        requester: { id: "test-hub", kind: "node", role: "hub" },
        message: "missing target should be a client error",
      }),
    });
    assert.equal(missingTargetRes.status, 400);
    const missingTargetBody = await missingTargetRes.json() as { error?: { code?: string; message?: string } };
    assert.equal(missingTargetBody.error?.code, "bad_request");
    assert.match(missingTargetBody.error?.message ?? "", /target\.id/);

    const rolelessPartyRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "test-hub",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        id: "roleless-party-task",
        intent: "analyze",
        requester: { id: "test-hub", kind: "node" },
        target: { id: "worker-a", kind: "node" },
        assignedWorkerId: "worker-a",
        message: "roleless parties remain accepted for compatibility",
      }),
    });
    assert.equal(rolelessPartyRes.status, 201);
  } finally {
    await server.close();
  }
});

test("server rejects invalid requester identity headers with 400", async () => {
  const server = await startTestServer();
  try {
    const invalidRoleRes = await fetch(`${server.baseUrl}/dashboard`, {
      headers: {
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "invalid-role",
      },
    });
    assert.equal(invalidRoleRes.status, 400);
    const invalidRoleBody = await invalidRoleRes.json();
    assert.match(invalidRoleBody.error.message, /x-a2a-requester-role must be one of/);

    const missingIdRes = await fetch(`${server.baseUrl}/dashboard`, {
      headers: {
        "x-a2a-requester-kind": "node",
      },
    });
    assert.equal(missingIdRes.status, 400);
    const missingIdBody = await missingIdRes.json();
    assert.match(missingIdBody.error.message, /x-a2a-requester-id is required/);
  } finally {
    await server.close();
  }
});

test("server maps GitHub completion evidence BrokerErrors to client errors", async () => {
  const server = await startTestServer();
  try {
    server.runtime.broker.registerWorker({
      nodeId: "worker-github-http",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["repo"],
        environments: ["research"],
      },
    });
    const task = server.runtime.broker.createTask({
      id: "task-github-http-evidence-missing",
      intent: "propose_patch",
      requester: { id: "operator-a", kind: "user", role: "operator" },
      target: { id: "worker-github-http", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-github-http",
      message: "test GitHub completion evidence mapping",
      taskOrigin: "github",
      payload: {
        mode: "github-propose-patch",
        repo: "jinwon-int/a2a-broker",
        issueNumber: 1032,
        issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/1032",
      },
    });
    server.runtime.broker.claimTask(task.id, "worker-github-http");
    server.runtime.broker.startTask(task.id, "worker-github-http");

    const res = await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-github-http",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-github-http",
        result: {
          summary: "done without public GitHub evidence",
          artifactIds: ["artifact-diagnostic-1"],
          output: {
            startCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/1032#issuecomment-start",
            runner: {
              status: "completed",
              artifacts: ["/work/artifacts/hermes-output.txt"],
            },
            logPath: "/work/artifacts/hermes-output.txt",
          },
        },
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "github_completion_evidence_missing");
    assert.equal(
      body.error.message,
      "github-origin propose_patch tasks must return PR, Done-comment, or Block-comment evidence before they can succeed",
    );
    assert.equal(body.error.details.taskId, "task-github-http-evidence-missing");
    assert.equal(body.error.details.mode, "github-propose-patch");
    assert.equal(
      body.error.details.observedEvidence.startCommentUrl,
      "https://github.com/jinwon-int/a2a-broker/issues/1032#issuecomment-start",
    );
    assert.deepEqual(body.error.details.observedEvidence.artifactIds, ["artifact-diagnostic-1"]);
    assert.deepEqual(body.error.details.observedEvidence.runnerArtifacts, ["/work/artifacts/hermes-output.txt"]);
  } finally {
    await server.close();
  }
});

test("server rejects unauthorized reassign with 401", async () => {
  const server = await startTestServer();
  try {
    const workerPayload = {
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    };

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({ nodeId: "worker-a", ...workerPayload }),
    });
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-b",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({ nodeId: "worker-b", ...workerPayload }),
    });

    const exchangeRes = await fetch(`${server.baseUrl}/exchanges`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "root",
        intent: "analyze",
      }),
    });
    const exchange = await exchangeRes.json();

    await fetch(`${server.baseUrl}/exchanges/${exchange.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        actor: { id: "hub-a", kind: "node", role: "hub" },
        message: "accepted",
        decision: "accepted",
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
      }),
    });

    const exchangeStateRes = await fetch(`${server.baseUrl}/exchanges/${exchange.id}`);
    const exchangeState = await exchangeStateRes.json();
    const reassignRes = await fetch(`${server.baseUrl}/tasks/${exchangeState.activeTaskId}/reassign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({
        actor: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-b",
        assignedWorkerId: "worker-b",
        note: "should fail",
      }),
    });

    assert.equal(reassignRes.status, 401);
    const errorBody = await reassignRes.json();
    assert.equal(errorBody.error.code, "unauthorized");
  } finally {
    await server.close();
  }
});

test("server redacts provider capabilities from non-SQLite worker read paths", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "workereta",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "workereta",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
          workspaceIds: ["team2"],
          environments: ["research"],
          providerCapabilities: [
            {
              providerId: "xai",
              modelFamily: "grok",
              modelId: "grok-4.2",
              routeKind: "subscription",
              availability: "canary_passed",
              evidenceId: "non-secret-evidence-id",
            },
          ],
        },
      }),
    });
    assert.equal(registerRes.status, 201);

    const listRes = await fetch(`${server.baseUrl}/workers?providerId=openai&modelId=gpt-4`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.items.length, 1);
    assert.equal(JSON.stringify(listBody).includes("xai"), false);
    assert.equal(JSON.stringify(listBody).includes("grok"), false);

    const detailRes = await fetch(`${server.baseUrl}/workers/workereta`);
    assert.equal(detailRes.status, 200);
    const detailBody = await detailRes.json();
    assert.equal(detailBody.nodeId, "workereta");
    assert.equal(JSON.stringify(detailBody).includes("xai"), false);
    assert.equal(JSON.stringify(detailBody).includes("grok"), false);
  } finally {
    await server.close();
  }
});

test("server approves blocked live-impact task with operator audit metadata", async () => {
  const server = await startTestServer();
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst");

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "analyst-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        intent: "promote_to_live",
        requester: { id: "analyst-a", kind: "node", role: "analyst" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "promote after review",
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();
    assert.equal(task.status, "blocked");

    const deniedApprove = await fetch(`${server.baseUrl}/tasks/${task.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "analyst-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        actor: { id: "analyst-a", kind: "node", role: "analyst" },
        reason: "not authorized",
      }),
    });
    assert.equal(deniedApprove.status, 401);

    const approveRes = await fetch(`${server.baseUrl}/tasks/${task.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "operator-a",
        "x-a2a-requester-role": "operator",
      }),
      body: JSON.stringify({
        actor: { id: "operator-a", kind: "node", role: "operator" },
        approvalId: "approval-http-1",
        reason: "change ticket reviewed",
      }),
    });
    assert.equal(approveRes.status, 200);
    const approved = await approveRes.json();
    assert.equal(approved.status, "queued");
    assert.equal(approved.approval.approvalId, "approval-http-1");
    assert.equal(approved.approval.approvedBy, "operator-a");
    assert.equal(approved.approval.actorRole, "operator");
    assert.equal(approved.approval.requesterRole, "analyst");
    assert.equal(approved.approval.reason, "change ticket reviewed");

    const auditRes = await fetch(`${server.baseUrl}/audit?action=task.approved&targetId=${task.id}`);
    const audit = await auditRes.json();
    assert.equal(audit.items.length, 1);
    assert.equal(audit.items[0].actorId, "operator-a");
    assert.equal(audit.items[0].note, "change ticket reviewed");
  } finally {
    await server.close();
  }
});

test("GET /tasks returns lightweight task summaries and keeps full detail opt-in", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const largeOutput = "x".repeat(20_000);
    await registerTestWorker(baseUrl, "worker-a", "analyst");
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        id: "task-list-diet",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        intent: "chat",
        payload: {
          rawLog: largeOutput,
          sourceBundle: { files: [{ path: "large.md", content: `sourceBundleSentinel-${largeOutput}` }] },
        },
      }),
    });
    assert.equal(createRes.status, 201);

    const task = await createRes.json();
    await fetch(`${baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        workerId: "worker-a",
        result: {
          summary: "short summary",
          artifactIds: ["artifact-1"],
          output: { rawLog: largeOutput },
        },
      }),
    });

    const listBody = await (await fetch(`${baseUrl}/tasks`)).json();
    assert.equal(listBody.items[0].id, "task-list-diet");
    assert.equal(listBody.items[0].resultSummary, "short summary");
    assert.deepEqual(listBody.items[0].artifactIds, ["artifact-1"]);
    assert.equal("payload" in listBody.items[0], false);
    assert.equal("result" in listBody.items[0], false);
    assert.equal(JSON.stringify(listBody).includes("sourceBundleSentinel"), false);
    assert.ok(JSON.stringify(listBody).length < 2_000);

    const rpcListBody = await (await fetch(`${baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} }),
    })).json();
    assert.equal(rpcListBody.result.tasks[0].metadata.resultSummary, "short summary");
    assert.equal("result" in rpcListBody.result.tasks[0].metadata, false);
    assert.equal(JSON.stringify(rpcListBody).includes("sourceBundleSentinel"), false);
    assert.ok(JSON.stringify(rpcListBody).length < 2_000);

    const detailBody = await (await fetch(`${baseUrl}/tasks/${task.id}`)).json();
    assert.equal(detailBody.payload.rawLog.length, largeOutput.length);
    assert.equal(detailBody.payload.sourceBundle.files[0].content, `sourceBundleSentinel-${largeOutput}`);
    assert.equal(detailBody.result.output.rawLog.length, largeOutput.length);

    const fullListBody = await (await fetch(`${baseUrl}/tasks?detail=full`)).json();
    assert.equal(fullListBody.items[0].payload.rawLog.length, largeOutput.length);
    assert.equal(fullListBody.items[0].result.output.rawLog.length, largeOutput.length);
  } finally {
    await close();
  }
});

test("GET /tasks applies explicit bounded limits", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerTestWorker(baseUrl, "worker-a", "analyst");
    for (let i = 0; i < 3; i += 1) {
      const createRes = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          id: `task-list-bound-${i}`,
          requester: { id: "requester", kind: "session", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          targetNodeId: "worker-a",
          intent: "chat",
          message: `bounded task ${i}`,
        }),
      });
      assert.equal(createRes.status, 201);
    }

    const limitedBody = await (await fetch(`${baseUrl}/tasks?limit=2`)).json();
    assert.equal(limitedBody.count, 2);
    assert.equal(limitedBody.limit, 2);
    assert.equal(limitedBody.items.length, 2);

    const cappedBody = await (await fetch(`${baseUrl}/tasks?limit=9999`)).json();
    assert.equal(cappedBody.count, 3);
    assert.equal(cappedBody.limit, 500);

    const badLimitRes = await fetch(`${baseUrl}/tasks?limit=1.5`);
    assert.equal(badLimitRes.status, 400);
  } finally {
    await close();
  }
});

test("server returns subtree items and thread structure for exchange messages", async () => {
  const server = await startTestServer();
  try {
    const workerPayload = {
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    };

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({ nodeId: "worker-a", ...workerPayload }),
    });

    const exchangeRes = await fetch(`${server.baseUrl}/exchanges`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "root",
        intent: "analyze",
      }),
    });
    const exchange = await exchangeRes.json();

    const acceptedRes = await fetch(`${server.baseUrl}/exchanges/${exchange.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        actor: { id: "hub-a", kind: "node", role: "hub" },
        message: "accepted",
        decision: "accepted",
        parentMessageId: exchange.rootMessageId,
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        via: { transport: "http", traceId: "server-test-accept" },
      }),
    });
    const accepted = await acceptedRes.json();

    await fetch(`${server.baseUrl}/exchanges/${exchange.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({
        actor: { id: "worker-a", kind: "node", role: "analyst" },
        message: "need clarification",
        decision: "needs_clarification",
        parentMessageId: accepted.id,
      }),
    });

    const subtreeRes = await fetch(
      `${server.baseUrl}/exchanges/${exchange.id}/messages?parentMessageId=${accepted.id}&includeDescendants=true`,
    );
    assert.equal(subtreeRes.status, 200);
    const subtree = await subtreeRes.json();

    assert.equal(subtree.items.length, 2);
    assert.equal(subtree.threads.length, 1);
    assert.equal(subtree.threads[0].id, accepted.id);
    assert.equal(subtree.threads[0].via.traceId, "server-test-accept");
    assert.equal(subtree.threads[0].replies.length, 1);
    assert.equal(subtree.threads[0].replies[0].decision, "needs_clarification");
  } finally {
    await server.close();
  }
});

test("server splits worker lifecycle rate limits from general request limits", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    rateLimitMaxRequests: 1,
    rateLimitWindowSec: 60,
    workerRateLimitMaxRequests: 3,
    workerRateLimitWindowSec: 60,
  });

  try {
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });
    assert.equal(registerRes.status, 201);
    assert.equal(registerRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const auditOne = await fetch(`${server.baseUrl}/audit`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
    });
    assert.equal(auditOne.status, 200);
    assert.equal(auditOne.headers.get("x-a2a-ratelimit-bucket"), "general");

    const heartbeatRes = await fetch(`${server.baseUrl}/workers/worker-a/heartbeat`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(heartbeatRes.status, 200);
    assert.equal(heartbeatRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const auditTwo = await fetch(`${server.baseUrl}/audit`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
    });
    assert.equal(auditTwo.status, 429);

  } finally {
    await server.close();
  }
});

test("server rejects requeue_stale unless requester is a hub or operator", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });

  try {
    const unauthorizedRes = await fetch(`${server.baseUrl}/tasks/requeue_stale`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
    });
    assert.equal(unauthorizedRes.status, 401);
    const unauthorizedBody = await unauthorizedRes.json();
    assert.equal(unauthorizedBody.error.code, "unauthorized");

    const allowedRes = await fetch(`${server.baseUrl}/tasks/requeue_stale`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
    });
    assert.equal(allowedRes.status, 200);
    const allowedBody = await allowedRes.json();
    assert.equal(allowedBody.ok, true);
    assert.equal(allowedBody.policy, "requeue_only");
  } finally {
    await server.close();
  }
});

test("server rejects artifact attachment from an unrelated requester", async () => {
  const server = await startTestServer();
  try {
    const proposalRes = await fetch(`${server.baseUrl}/proposals`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        source: { id: "research-a", kind: "node", role: "researcher" },
        target: { id: "live-a", kind: "node", role: "live-trader" },
        kind: "patch",
        summary: "tighten threshold",
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        patchText: "diff --git a/config.ts b/config.ts",
      }),
    });
    assert.equal(proposalRes.status, 201);
    const proposal = await proposalRes.json();

    const artifactRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/artifacts`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "outsider-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        kind: "patch",
        uri: "file:///tmp/proposal.diff",
        summary: "outsider should not attach this",
      }),
    });

    assert.equal(artifactRes.status, 401);
    const errorBody = await artifactRes.json();
    assert.equal(errorBody.error.code, "unauthorized");
  } finally {
    await server.close();
  }
});

test("server rejects validation from a node outside the proposal parties", async () => {
  const server = await startTestServer();
  try {
    const proposalRes = await fetch(`${server.baseUrl}/proposals`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        source: { id: "research-a", kind: "node", role: "researcher" },
        target: { id: "live-a", kind: "node", role: "live-trader" },
        kind: "patch",
        summary: "tighten threshold",
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        patchText: "diff --git a/config.ts b/config.ts",
      }),
    });
    assert.equal(proposalRes.status, 201);
    const proposal = await proposalRes.json();

    const validationRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/validate`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "outsider-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "outsider-a",
        kind: "smoke",
        verdict: "pass",
        note: "should be rejected",
      }),
    });

    assert.equal(validationRes.status, 403);
    const errorBody = await validationRes.json();
    assert.equal(errorBody.error.code, "policy_denied");
  } finally {
    await server.close();
  }
});

test("server rejects apply attempts from the proposal source after approval", async () => {
  const server = await startTestServer();
  try {
    const proposalRes = await fetch(`${server.baseUrl}/proposals`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        source: { id: "research-a", kind: "node", role: "researcher" },
        target: { id: "live-a", kind: "node", role: "live-trader" },
        kind: "patch",
        summary: "tighten threshold",
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        patchText: "diff --git a/config.ts b/config.ts",
      }),
    });
    assert.equal(proposalRes.status, 201);
    const proposal = await proposalRes.json();

    const approveRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "live-a",
        "x-a2a-requester-role": "live-trader",
      }),
      body: JSON.stringify({
        actor: { id: "live-a", kind: "node", role: "live-trader" },
        note: "approved by target",
      }),
    });
    assert.equal(approveRes.status, 200);

    const applyRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/apply`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        actor: { id: "research-a", kind: "node", role: "researcher" },
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        note: "source should not apply target workspace",
      }),
    });

    assert.equal(applyRes.status, 403);
    const errorBody = await applyRes.json();
    assert.equal(errorBody.error.code, "policy_denied");
  } finally {
    await server.close();
  }
});

test("server classifies claim, start, complete, and fail into the worker lifecycle bucket", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    rateLimitMaxRequests: 10,
    workerRateLimitMaxRequests: 10,
  });

  try {
    const workerPayload = {
      nodeId: "worker-a",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    };

    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify(workerPayload),
    });
    assert.equal(registerRes.status, 201);

    const taskCreateRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run task",
      }),
    });
    assert.equal(taskCreateRes.status, 201);
    const task = await taskCreateRes.json();

    const claimRes = await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(claimRes.status, 200);
    assert.equal(claimRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const startRes = await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(startRes.status, 200);
    assert.equal(startRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const completeRes = await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-a",
        result: { summary: "done" },
      }),
    });
    assert.equal(completeRes.status, 200);
    assert.equal(completeRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const failedTaskCreateRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run task 2",
      }),
    });
    assert.equal(failedTaskCreateRes.status, 201);
    const failedTask = await failedTaskCreateRes.json();

    const claimFailedTaskRes = await fetch(`${server.baseUrl}/tasks/${failedTask.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(claimFailedTaskRes.status, 200);
    assert.equal(claimFailedTaskRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const startFailedTaskRes = await fetch(`${server.baseUrl}/tasks/${failedTask.id}/start`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(startFailedTaskRes.status, 200);
    assert.equal(startFailedTaskRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const failRes = await fetch(`${server.baseUrl}/tasks/${failedTask.id}/fail`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-a",
        error: { code: "handler_error", message: "task failed" },
      }),
    });
    assert.equal(failRes.status, 200);
    assert.equal(failRes.headers.get("x-a2a-ratelimit-bucket"), "worker");
  } finally {
    await server.close();
  }
});

test("stale reaper sweep requeues a claimed task with a dead worker without operator action", async () => {
  const server = await startTestServer({
    edgeSecret: "s",
    // Disable the periodic timer so the test drives sweeps deterministically.
    staleReaperEnabled: false,
    staleReaperOlderThanSec: 0,
    workerOfflineAfterSec: 1,
  });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "analyze payload",
      }),
    });
    const task = await taskRes.json();

    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });

    const requeuedCount = server.runtime.runStaleReaperSweep();
    assert.equal(requeuedCount, 1);

    const taskAfter = await (await fetch(`${server.baseUrl}/tasks/${task.id}`, {
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
    })).json();
    assert.equal(taskAfter.status, "queued");
    assert.equal(taskAfter.assignedWorkerId, "w1");

    const status = server.runtime.getStaleReaperStatus();
    assert.equal(status.runCount, 1);
    assert.equal(status.lastRequeued, 1);
    assert.equal(status.lastError, undefined);
    assert.ok(status.lastRunAt);
  } finally {
    await server.close();
  }
});

test("stopStaleReaper is idempotent and safe after server close", async () => {
  const server = await startTestServer({ staleReaperEnabled: true, staleReaperIntervalSec: 3600 });
  const { runtime } = server;
  await server.close();
  // server.close fires the "close" event which already stopped the reaper; extra calls
  // must not throw.
  runtime.stopStaleReaper();
  runtime.stopStaleReaper();
});

test("POST /tasks/requeue_stale reports both requeued and dead-lettered counts", async () => {
  const server = await startTestServer({
    edgeSecret: "s",
    staleReaperEnabled: false,
    workerOfflineAfterSec: 1,
    maxRequeueAttempts: 1,
  });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "analyze payload",
      }),
    });
    const task = await taskRes.json();

    // Burn attempt #1 via the manual endpoint.
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    const firstSweep = await (await fetch(
      `${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`,
      {
        method: "POST",
        headers: h({ "x-a2a-requester-id": "ops", "x-a2a-requester-role": "operator" }),
      },
    )).json();
    assert.equal(firstSweep.requeued, 1);
    assert.equal(firstSweep.deadLettered, 0);
    assert.equal(firstSweep.maxRequeueAttempts, 1);
    assert.equal(firstSweep.items[0].requeueCount, 1);

    // Second sweep: the task is over its cap and must dead-letter.
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    const secondSweep = await (await fetch(
      `${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`,
      {
        method: "POST",
        headers: h({ "x-a2a-requester-id": "ops", "x-a2a-requester-role": "operator" }),
      },
    )).json();
    assert.equal(secondSweep.requeued, 0);
    assert.equal(secondSweep.deadLettered, 1);
    assert.equal(secondSweep.deadLetteredItems[0].id, task.id);
    assert.equal(secondSweep.deadLetteredItems[0].error.code, "exceeded_requeue_limit");
  } finally {
    await server.close();
  }
});

test("server persists task wake plan and decision through HTTP", async () => {
  const server = await startTestServer();
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst");
    const hubHeaders = jsonHeaders({
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: "task-wake-http",
        intent: "chat",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "wake target",
        payload: { waitRunId: "wait-http", correlationId: "corr-http" },
      }),
    });
    assert.equal(createRes.status, 201);

    const planRes = await fetch(`${server.baseUrl}/tasks/task-wake-http/wake/plan`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        targetSessionKey: "agent:worker-a",
        targetNodeId: "worker-a",
        waitRunId: "wait-http",
        correlationId: "corr-http",
      }),
    });
    assert.equal(planRes.status, 201);
    const plan = await planRes.json() as Record<string, unknown>;
    assert.equal(plan.shouldDispatch, true);
    assert.equal((plan.wake as Record<string, unknown>).wakeKey, "corr-http:wait-http");

    const decisionRes = await fetch(`${server.baseUrl}/tasks/task-wake-http/wake/decision`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        status: "skipped",
        code: "wake_disabled",
        message: "default off",
      }),
    });
    assert.equal(decisionRes.status, 200);
    const task = await decisionRes.json() as Record<string, unknown>;
    assert.equal((task.wake as Record<string, unknown>).status, "skipped");
    assert.equal((task.wake as Record<string, unknown>).code, "wake_disabled");

    const replayRes = await fetch(`${server.baseUrl}/tasks/task-wake-http/wake/plan`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        targetSessionKey: "agent:worker-a",
        targetNodeId: "worker-a",
        waitRunId: "wait-http",
        correlationId: "corr-http",
      }),
    });
    assert.equal(replayRes.status, 200);
    const replay = await replayRes.json() as Record<string, unknown>;
    assert.equal(replay.replayed, true);
    assert.equal(replay.shouldDispatch, false);
  } finally {
    await server.close();
  }
});

test("GET /release/evidence returns read-only dry-run release evidence without mutating tasks", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    server.runtime.broker.registerWorker({
      nodeId: "workerepsilon",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["repo"],
        environments: ["research"],
      },
    });
    const created = server.runtime.broker.createTask({
      id: "release-evidence-task-1",
      intent: "propose_patch",
      requester: { id: "operator-a", kind: "user", role: "operator" },
      target: { id: "workerepsilon", kind: "node", role: "analyst" },
      payload: {
        mode: "github-propose-patch",
        issue: 479,
        issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/479",
      },
      taskOrigin: "github",
    });
    server.runtime.broker.claimTask(created.id, "workerepsilon");
    server.runtime.broker.startTask(created.id, "workerepsilon");
    server.runtime.broker.completeTask(created.id, "workerepsilon", {
      output: {
        github: {
          repo: "jinwon-int/a2a-broker",
          issue: "#479",
          doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329",
        },
        receipt: { status: "operator_visible", evidence: "operator_visible" },
      },
    });
    const before = server.runtime.broker.getTask(created.id)?.updatedAt;

    const res = await fetch(
      `${server.baseUrl}/release/evidence?task_id=${created.id}&repo=jinwon-int/a2a-broker&issue=479&parentIssue=a2a-plane (internal tracker, private)%23197&runId=a2a-source-dryrun-orchestrator-20260510T133022Z`,
      {
        headers: {
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        },
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "broker.release-evidence.export");
    assert.equal(body.mode, "dry-run/read-only");
    assert.equal(body.readOnly, true);
    assert.equal(body.gates.liveActionAllowed, false);
    assert.equal(body.gates.mutationAllowed, false);
    assert.equal(body.gates.ok, true);
    assert.equal(body.taskSummary.total, 1);
    assert.equal(body.evidenceSummary.done, 1);
    assert.deepEqual(body.links.doneComments, [
      "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329",
    ]);
    assert.equal(server.runtime.broker.getTask(created.id)?.updatedAt, before);
  } finally {
    await server.close();
  }
});

test("POST bodies over the size cap are rejected with 400 (a2a-nexus#573 item 13)", async () => {
  const server = await startTestServer();
  try {
    // 10 MB + 1 byte of raw payload exceeds MAX_REQUEST_BODY_BYTES.
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    const response = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
        "x-a2a-requester-kind": "node",
      },
      body: oversized,
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error?: { message?: string } };
    assert.match(String(body.error?.message), /request body exceeds/);
  } finally {
    await server.close();
  }
});
