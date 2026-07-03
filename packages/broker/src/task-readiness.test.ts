import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createBrokerServer } from "./server.js";
import { emptySnapshot, type BrokerStateStore } from "./core/store.js";
import {
  evaluateTaskReadiness,
  DEFAULT_TASK_READINESS_MODE,
  type TaskReadinessMode,
} from "./task-readiness.js";

const EDGE_SECRET = "task-readiness-test-edge-secret";

function createInMemoryStateStore(): BrokerStateStore {
  let snapshot = emptySnapshot();
  return {
    load: () => snapshot,
    save: (next) => {
      snapshot = structuredClone(next);
    },
  };
}

async function startTestServer(options: { taskReadinessMode?: TaskReadinessMode } = {}) {
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: createInMemoryStateStore(),
    edgeSecret: EDGE_SECRET,
    staleReaperEnabled: false,
    ...options,
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  runtime.broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
  return {
    runtime,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      runtime.server.close();
      await once(runtime.server, "close");
    },
  };
}

function headers(): HeadersInit {
  return {
    "content-type": "application/json",
    "x-a2a-edge-secret": EDGE_SECRET,
    "x-a2a-requester-id": "hub-a",
    "x-a2a-requester-role": "hub",
  };
}

function githubPatchTask(payload: Record<string, unknown>) {
  return {
    id: `readiness-${Math.random().toString(16).slice(2)}`,
    intent: "propose_patch",
    message: "implement #1234",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    taskOrigin: "github",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-nexus",
      issue: 1234,
      ...payload,
    },
  };
}

test("readiness evaluator reports each missing Definition-of-Ready field", () => {
  const result = evaluateTaskReadiness(githubPatchTask({}).payload, {
    intent: "propose_patch",
    mode: "enforce",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["acceptance", "declaredScope", "evidenceGate"]);
});

test("readiness evaluator accepts a complete patch task and exempts analysis tasks", () => {
  const complete = evaluateTaskReadiness(githubPatchTask({
    acceptance: { command: ["npm", "run", "check"], expectExitCode: 0 },
    declaredScope: { paths: ["packages/broker/"] },
    evidenceGate: "RED: create task missing acceptance fails; GREEN: full broker gate passes",
  }).payload, { intent: "propose_patch", mode: "enforce" });
  assert.equal(complete.ok, true);

  const exempt = evaluateTaskReadiness({}, { intent: "analyze", mode: "enforce" });
  assert.equal(exempt.ok, true);
});

test("warn mode is the default task-readiness rollout mode", () => {
  assert.equal(DEFAULT_TASK_READINESS_MODE, "warn");
});

test("POST /tasks rejects underspecified patch tasks in enforce mode with details.missing", async () => {
  const server = await startTestServer({ taskReadinessMode: "enforce" });
  try {
    const response = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(githubPatchTask({})),
    });
    const body = await response.json() as { error?: { code?: string; message?: string; details?: { missing?: string[] } } };
    assert.equal(response.status, 400);
    assert.equal(body.error?.code, "spec_underspecified");
    assert.deepEqual(body.error?.details?.missing, ["acceptance", "declaredScope", "evidenceGate"]);
  } finally {
    await server.close();
  }
});

test("POST /tasks stays warn-only by default but accepts complete enforce-mode specs", async () => {
  const warnServer = await startTestServer();
  try {
    const warnResponse = await fetch(`${warnServer.baseUrl}/tasks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(githubPatchTask({})),
    });
    assert.equal(warnResponse.status, 201, await warnResponse.text());
  } finally {
    await warnServer.close();
  }

  const enforceServer = await startTestServer({ taskReadinessMode: "enforce" });
  try {
    const response = await fetch(`${enforceServer.baseUrl}/tasks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(githubPatchTask({
        acceptance: { command: ["npm", "run", "check"], expectExitCode: 0 },
        declaredScope: { paths: ["packages/broker/"] },
        evidenceGate: "RED: create task missing acceptance fails; GREEN: npm run check passes",
      })),
    });
    assert.equal(response.status, 201, await response.text());
  } finally {
    await enforceServer.close();
  }
});

test("POST /tasks returns an existing task before applying stricter readiness lint", async () => {
  const server = await startTestServer({ taskReadinessMode: "enforce" });
  const id = "readiness-existing-task";
  try {
    const firstResponse = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        ...githubPatchTask({
          acceptance: { command: ["npm", "run", "check"], expectExitCode: 0 },
          declaredScope: { paths: ["packages/broker/"] },
          evidenceGate: "RED: create task missing acceptance fails; GREEN: npm run check passes",
        }),
        id,
      }),
    });
    assert.equal(firstResponse.status, 201, await firstResponse.text());

    const replayResponse = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ...githubPatchTask({}), id }),
    });
    const replayBody = await replayResponse.json() as { id?: string; payload?: Record<string, unknown> };
    assert.equal(replayResponse.status, 201);
    assert.equal(replayBody.id, id);
    assert.ok(replayBody.payload?.["acceptance"]);
  } finally {
    await server.close();
  }
});
