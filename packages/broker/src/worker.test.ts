import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";

import { emptySnapshot, type BrokerStateStore } from "./core/store.js";
import { createBrokerServer, type BrokerServerOptions } from "./server.js";
import { A2ABrokerWorker, createExternalWorkerHandler, createWorkerConfigFromEnv, type BrokerWorkerConfig } from "./worker.js";

function createInMemoryStateStore(): BrokerStateStore {
  let snapshot = emptySnapshot();
  return {
    load() {
      return snapshot;
    },
    save(nextSnapshot) {
      snapshot = structuredClone(nextSnapshot);
    },
  };
}

async function startTestServer(options: Partial<BrokerServerOptions> = {}) {
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: createInMemoryStateStore(),
    enforceRequesterIdentity: true,
    rateLimitMaxRequests: 100,
    ...options,
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      runtime.server.close();
      await once(runtime.server, "close");
    },
  };
}

function createWorker(baseUrl: string, options: { edgeSecret?: string; homeBrokerId?: string; homeBrokerLeaseFile?: string } = {}) {
  return new A2ABrokerWorker({
    brokerUrl: baseUrl,
    edgeSecret: options.edgeSecret,
    homeBrokerId: options.homeBrokerId,
    homeBrokerLeaseFile: options.homeBrokerLeaseFile,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async (task) => ({
      result: {
        summary: `echo ${task.intent}`,
        output: {
          taskId: task.id,
          message: task.message,
          payload: task.payload,
        },
      },
    }),
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Worker A",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
      metadata: { lane: "test" },
    },
  });
}

async function createTask(baseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
      "x-a2a-requester-kind": "node",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test("worker registers, heartbeats, polls queued work, and completes tasks", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    const registered = await worker.register();
    assert.equal(registered.nodeId, "worker-a");
    assert.equal(registered.status, "online");

    const beforeHeartbeat = await worker.getWorker();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const heartbeat = await worker.heartbeat();
    assert.equal(heartbeat.nodeId, "worker-a");

    const afterHeartbeat = await worker.getWorker();
    assert.equal(afterHeartbeat.status, "online");
    assert.ok(Date.parse(afterHeartbeat.lastSeenAt) >= Date.parse(beforeHeartbeat.lastSeenAt));

    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run echo",
      payload: { hello: "world" },
    });

    const queued = await worker.pollQueuedTasks();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].id, task.id);

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    assert.equal(completedTask.status, "succeeded");
    assert.equal(completedTask.claimedBy, "worker-a");
    assert.equal(completedTask.result.summary, "echo analyze");
    assert.equal(completedTask.result.output.message, "run echo");
    assert.deepEqual(completedTask.result.output.payload, { hello: "world" });

    const auditResponse = await fetch(`${server.baseUrl}/audit`);
    const audit = await auditResponse.json();
    const actions = new Set(audit.items.map((item: { action: string }) => item.action));
    assert.ok(actions.has("worker.registered"));
    assert.equal(actions.has("worker.heartbeat"), false);
    assert.ok(actions.has("task.claimed"));
    assert.ok(actions.has("task.started"));
    assert.ok(actions.has("task.succeeded"));
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker sends full heartbeat once and empty heartbeat bodies afterward", async () => {
  const bodies: Array<unknown> = [];
  const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify({
      nodeId: "worker-a",
      role: "analyst",
      status: "online",
      capabilities: { canAnalyze: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const compactWorker = new A2ABrokerWorker({
    brokerUrl: "https://broker.test",
    edgeSecret: "test-edge-secret",
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async (task) => ({ result: { summary: `echo ${task.intent}` } }),
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Worker A",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
      metadata: { lane: "test" },
    },
  }, { fetchImpl });

  await compactWorker.heartbeat();
  await compactWorker.heartbeat();

  assert.equal(bodies.length, 2);
  assert.deepEqual((bodies[0] as { capabilities?: unknown }).capabilities, {
    canAnalyze: true,
    canBackfill: false,
    canPatchWorkspace: false,
    canPromoteLive: false,
    workspaceIds: ["test"],
    environments: ["research"],
  });
  assert.deepEqual(bodies[1], {});
});

test("worker sends task heartbeats while a handler is running", async () => {
  const server = await startTestServer();
  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 20,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return { result: { summary: `slow echo ${task.intent}` } };
    },
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Worker A",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    },
  });

  try {
    await worker.register();
    await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run slow echo",
      payload: {},
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const auditResponse = await fetch(`${server.baseUrl}/audit?action=task.heartbeat`);
    const audit = await auditResponse.json();
    assert.ok(audit.items.length >= 1, "expected at least one task heartbeat audit event");

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${audit.items[0].targetId}`);
    const completedTask = await taskResponse.json();
    assert.equal(completedTask.status, "succeeded");
    assert.equal(typeof completedTask.lastHeartbeatAt, "string");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker includes x-a2a-edge-secret when configured", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  const worker = createWorker(server.baseUrl, { edgeSecret: "test-edge-secret" });

  try {
    const registered = await worker.register();
    assert.equal(registered.nodeId, "worker-a");

    const heartbeat = await worker.heartbeat();
    assert.equal(heartbeat.nodeId, "worker-a");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker queued-task polls do not consume the general rate limit budget", async () => {
  const server = await startTestServer({
    rateLimitMaxRequests: 1,
    workerRateLimitMaxRequests: 5,
  });
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const queued = await worker.pollQueuedTasks();
      assert.deepEqual(queued, []);
    }
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker env config prefers broker-specific edge secrets over generic ones", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-a",
    WORKER_HANDLER_BUILTIN: "echo",
    BROKER_EDGE_SECRET: "broker-secret",
    EDGE_SECRET: "generic-secret",
  });

  assert.equal(config.edgeSecret, "broker-secret");
});

test("worker env config reads A2A home broker id and lease file", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-a",
    WORKER_HANDLER_BUILTIN: "echo",
    A2A_HOME_BROKER_ID: "team2-broker",
    A2A_HOME_BROKER_LEASE_FILE: "/tmp/a2a-home-broker-lease.json",
  });

  assert.equal(config.homeBrokerId, "team2-broker");
  assert.equal(config.homeBrokerLeaseFile, "/tmp/a2a-home-broker-lease.json");
});

test("openclaw-poll-only profile declares broker poll handler metadata and disables bridge for external handlers", async () => {
  const server = await startTestServer();
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-openclaw-poll-only-worker-"));
  const handlerPath = join(tempDir, "handler.mjs");
  await writeFile(handlerPath, `
const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const task = JSON.parse(chunks.join(""));
  console.log(JSON.stringify({
    result: {
      summary: "poll-only handler completed " + task.id,
      output: {
        bridgeDisabled: process.env.A2A_OPENCLAW_BRIDGE_DISABLED,
        openClawBin: process.env.OPENCLAW_BIN || "",
      },
    },
  }));
});
`, "utf8");

  const config = createWorkerConfigFromEnv({
    BROKER_URL: server.baseUrl,
    WORKER_ID: "worker-a",
    WORKER_ROLE: "analyst",
    WORKER_PROFILE: "openclaw-poll-only",
    WORKER_HANDLER_COMMAND: process.execPath,
    WORKER_HANDLER_ARGS_JSON: JSON.stringify([handlerPath]),
    OPENCLAW_BIN: "/path/that/must/not/run",
  });
  const worker = new A2ABrokerWorker(config);

  try {
    assert.equal(config.worker.capabilities.runtimeFlavor, "openclaw-poll-handler");
    assert.equal(config.worker.capabilities.gatewayRequired, false);
    assert.deepEqual(config.worker.metadata, {
      workerProfile: "openclaw-poll-only",
      runtimeFlavor: "openclaw-poll-handler",
      executionPlane: "broker-poll-http-handler",
      handlerContract: "stdin-stdout",
      gatewayHookRequired: "false",
      openclawBridge: "disabled",
    });

    await worker.register();
    const workerViewResponse = await fetch(`${server.baseUrl}/workers/worker-a`);
    assert.equal(workerViewResponse.status, 200);
    const workerView = await workerViewResponse.json();
    assert.equal(workerView.capabilities.runtimeFlavor, "openclaw-poll-handler");
    assert.equal(workerView.capabilities.gatewayRequired, false);
    assert.equal(workerView.metadata.executionPlane, "broker-poll-http-handler");

    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run poll-only handler",
      payload: {},
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();
    assert.equal(completedTask.status, "succeeded");
    assert.equal(completedTask.result.output.bridgeDisabled, "1");
    assert.equal(completedTask.result.output.openClawBin, "/path/that/must/not/run");
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("broker-poll-only profile declares neutral broker poll handler metadata without OpenClaw bridge env", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-neutral",
    WORKER_ROLE: "analyst",
    WORKER_PROFILE: "broker-poll-only",
    WORKER_HANDLER_COMMAND: process.execPath,
    WORKER_HANDLER_ARGS_JSON: JSON.stringify(["/tmp/handler.mjs"]),
    OPENCLAW_BIN: "/path/that/must/not-run",
  });

  assert.equal(config.worker.capabilities.runtimeFlavor, "broker-poll-http-handler");
  assert.equal(config.worker.capabilities.gatewayRequired, false);
  assert.deepEqual(config.worker.metadata, {
    workerProfile: "broker-poll-only",
    runtimeFlavor: "broker-poll-http-handler",
    executionPlane: "broker-poll-http-handler",
    handlerContract: "stdin-stdout",
    gatewayHookRequired: "false",
  });
});

test("legacy openclaw-poll-only profile remains a compatibility alias", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-legacy",
    WORKER_ROLE: "analyst",
    WORKER_PROFILE: "openclaw-poll-only",
    WORKER_HANDLER_COMMAND: process.execPath,
    WORKER_HANDLER_ARGS_JSON: JSON.stringify(["/tmp/handler.mjs"]),
  });

  assert.equal(config.worker.capabilities.runtimeFlavor, "openclaw-poll-handler");
  assert.equal(config.worker.capabilities.gatewayRequired, false);
  assert.equal(config.worker.metadata?.workerProfile, "openclaw-poll-only");
  assert.equal(config.worker.metadata?.openclawBridge, "disabled");
});

test("broker poll aliases normalize to the neutral broker-poll-only profile", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-poll-alias",
    WORKER_ROLE: "analyst",
    WORKER_PROFILE: "poll-only",
    WORKER_HANDLER_COMMAND: process.execPath,
    WORKER_HANDLER_ARGS_JSON: JSON.stringify(["/tmp/handler.mjs"]),
  });

  assert.equal(config.worker.capabilities.runtimeFlavor, "broker-poll-http-handler");
  assert.equal(config.worker.metadata?.workerProfile, "broker-poll-only");
});

test("worker validates matching A2A_HOME_BROKER_ID and writes local lease before registering", async () => {
  const server = await startTestServer({ brokerId: "team2-broker" });
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-lease-test-"));
  const leaseFile = join(tempDir, "home-broker.json");
  const worker = createWorker(server.baseUrl, { homeBrokerId: "team2-broker", homeBrokerLeaseFile: leaseFile });

  try {
    const registered = await worker.register();
    assert.equal(registered.nodeId, "worker-a");

    const lease = JSON.parse(await readFile(leaseFile, "utf8"));
    assert.equal(lease.brokerId, "team2-broker");
    assert.equal(lease.workerId, "worker-a");
    assert.equal(lease.brokerUrl, `${server.baseUrl}/`);
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("worker fails closed when broker identity mismatches A2A_HOME_BROKER_ID", async () => {
  const server = await startTestServer({ brokerId: "other-broker" });
  const worker = createWorker(server.baseUrl, { homeBrokerId: "team2-broker" });

  try {
    await assert.rejects(() => worker.register(), /home broker mismatch: expected A2A_HOME_BROKER_ID=team2-broker, got other-broker/);
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker fails closed when local home-broker lease points at a different broker", async () => {
  const server = await startTestServer({ brokerId: "team2-broker" });
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-lease-test-"));
  const leaseFile = join(tempDir, "home-broker.json");
  await writeFile(leaseFile, JSON.stringify({ brokerId: "old-broker" }), "utf8");
  const worker = createWorker(server.baseUrl, { homeBrokerId: "team2-broker", homeBrokerLeaseFile: leaseFile });

  try {
    await assert.rejects(() => worker.register(), /home broker lease mismatch/);
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("worker fails tasks when an external handler exits non-zero", async () => {
  const server = await startTestServer();
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-test-"));
  const scriptPath = join(tempDir, "handler.mjs");

  await writeFile(
    scriptPath,
    [
      "import { stdin, stderr } from 'node:process';",
      "let input = '';",
      "stdin.setEncoding('utf8');",
      "stdin.on('data', (chunk) => { input += chunk; });",
      "stdin.on('end', () => {",
      "  const task = JSON.parse(input);",
      "  stderr.write(`external handler rejected ${task.id}`);",
      "  process.exitCode = 7;",
      "});",
    ].join("\n"),
    "utf8",
  );

  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: createExternalWorkerHandler({
      command: process.execPath,
      args: [scriptPath],
      timeoutMs: 1_000,
    }),
    worker: {
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
    },
  });

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run external",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.claimedBy, "worker-a");
    assert.equal(failedTask.error.code, "handler_exit_nonzero");
    assert.match(failedTask.error.message, /external handler rejected/);
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("worker fails GitHub propose_patch tasks without PR or block evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "open a GitHub PR",
      payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.error.code, "github_completion_evidence_missing");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker fails GitHub issue-instruction propose_patch tasks without PR or block evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "process a GitHub issue instruction",
      payload: { mode: "github-issue-instruction", repo: "owner/repo", issue: "#1" },
      taskOrigin: "unknown",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.error.code, "github_completion_evidence_missing");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker allows GitHub propose_patch tasks with PR evidence", async () => {
  const server = await startTestServer();
  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async () => ({
      result: {
        summary: "opened PR",
        output: {
          github: {
            prUrl: "https://github.com/owner/repo/pull/2",
          },
        },
      },
    }),
    worker: {
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
    },
  });

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "open a GitHub PR",
      payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    assert.equal(completedTask.status, "succeeded");
    assert.equal(completedTask.result.output.github.prUrl, "https://github.com/owner/repo/pull/2");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker proposal APIs: createProposal, getProposalDetails, submitValidation", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();

    // Create a proposal via worker API
    const proposal = await worker.createProposal({
      source: { id: "worker-a", kind: "node", role: "analyst" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      kind: "patch",
      summary: "test patch",
      workspace: { nodeId: "target-node", workspaceId: "ws1" },
      patchText: "- old\n+ new",
    });

    assert.equal(proposal.kind, "patch");
    assert.equal(proposal.summary, "test patch");
    assert.equal(proposal.status, "submitted");

    // Fetch proposal details
    const details = await worker.getProposalDetails(proposal.id);
    assert.equal(details.proposal.id, proposal.id);
    assert.equal(details.validations.length, 0);

    // Submit validation
    await worker.submitValidation(proposal.id, {
      nodeId: "worker-a",
      kind: "backfill",
      verdict: "pass",
      metrics: { sr_improvement: 0.2 },
      note: "backtest passed",
    });

    // Re-fetch — should now be validated
    const afterValidation = await worker.getProposalDetails(proposal.id);
    assert.equal(afterValidation.proposal.status, "validated");
    assert.equal(afterValidation.validations.length, 1);
    assert.equal(afterValidation.validations[0].verdict, "pass");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker proposal API: approveProposal and applyProposal lifecycle", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  // Need to register both worker-a and target-node on broker
  // target-node is needed for policy checks
  const targetWorker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async () => ({ result: {} }),
    worker: {
      nodeId: "target-node",
      role: "live-trader",
      capabilities: {
        canAnalyze: false,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: true,
        workspaceIds: ["ws1"],
        environments: ["live"],
      },
    },
  });

  try {
    await worker.register();
    await targetWorker.register();

    // Create + validate proposal
    const proposal = await worker.createProposal({
      source: { id: "worker-a", kind: "node", role: "analyst" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      kind: "params",
      summary: "update threshold",
      workspace: { nodeId: "target-node", workspaceId: "ws1" },
      parameterPayload: { THRESHOLD: 2.5 },
    });

    await worker.submitValidation(proposal.id, {
      nodeId: "worker-a",
      kind: "backfill",
      verdict: "pass",
    });

    // Target-node approves (policy: target node or operator only)
    // target-node's requester identity matches, so approve via targetWorker
    await targetWorker.approveProposal(proposal.id, {
      actor: { id: "target-node", kind: "node", role: "live-trader" },
      note: "approved",
    });

    // Apply
    const applied = await targetWorker.applyProposal(proposal.id, {
      actor: { id: "target-node", kind: "node", role: "live-trader" },
      workspace: { nodeId: "target-node", workspaceId: "ws1" },
      note: "applied locally",
    });

    assert.equal((applied as { status: string }).status, "applied");

    // Verify via details
    const details = await worker.getProposalDetails(proposal.id);
    assert.equal(details.proposal.status, "applied");
    assert.ok(details.audit.some((e: any) => e.action === "proposal.applied"));
  } finally {
    await worker.stop();
    await targetWorker.stop();
    await server.close();
  }
});

test("worker returns 404 for non-existent proposal", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();

    await assert.rejects(
      () => worker.getProposalDetails("nonexistent-id"),
      (error: any) => error.code === "not_found",
    );
  } finally {
    await worker.stop();
    await server.close();
  }
});

// ─── analysis-only / read-only task mode regression tests ───

test("worker completes analysis-only tasks without PR evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run market regime analysis",
      payload: {
        mode: "analysis-only",
        summary: "BTC dominance scan",
        findings: ["dominance at 58%"],
        risks: ["volume declining"],
      },
      taskOrigin: "api",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    assert.equal(completedTask.status, "succeeded", "analysis-only task should succeed");
    assert.equal(completedTask.claimedBy, "worker-a");
    assert.match(completedTask.result.summary, /echo analyze/);
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker completes analysis-only tasks with github origin without PR evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "read-only thesis analysis",
      payload: {
        mode: "analysis-only",
        summary: "thesis for BTC/USDT",
        doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-done",
        findings: ["bullish divergence on 4h"],
      },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    // Analysis-only tasks with github origin must succeed without PR evidence
    assert.equal(completedTask.status, "succeeded",
      `analysis-only github-origin task should succeed, got: ${JSON.stringify(completedTask.error)}`);
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker fails github propose_patch tasks without PR evidence (existing contract preserved)", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "open a PR",
      payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    // Existing contract: github propose_patch tasks MUST have PR evidence
    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.error.code, "github_completion_evidence_missing");
  } finally {
    await worker.stop();
    await server.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Worker robustness regressions (a2a-nexus#573 items 6, 7)
// ───────────────────────────────────────────────────────────────────────────

function robustnessConfig(overrides: Partial<BrokerWorkerConfig> = {}): BrokerWorkerConfig {
  return {
    brokerUrl: "http://broker.invalid",
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 10_000,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async (task) => ({
      result: { summary: `echo ${task.intent}`, output: { taskId: task.id } },
    }),
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Worker A",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    },
    ...overrides,
  };
}

const jsonOk = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

test("stop() during startup aborts the run loop and never polls tasks (item 6)", async () => {
  const paths: string[] = [];
  let workerRef: A2ABrokerWorker;
  const fetchImpl = (async (url: URL | string) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === "/workers/register") {
      // Simulate SIGINT/SIGTERM arriving mid-registration.
      await workerRef.stop();
    }
    return jsonOk();
  }) as unknown as typeof fetch;

  workerRef = new A2ABrokerWorker(robustnessConfig(), { fetchImpl });

  const runPromise = workerRef.run();
  await Promise.race([runPromise, new Promise((r) => setTimeout(r, 200))]);

  assert.ok(paths.includes("/workers/register"), "registration should have been attempted");
  assert.ok(
    !paths.some((p) => p.startsWith("/tasks")),
    "a stop() during startup must prevent the worker from entering the poll loop",
  );

  await workerRef.stop();
  await runPromise.catch(() => undefined);
});

test("broker requests abort on the request timeout instead of hanging forever (item 7)", async () => {
  // A fetch that only settles when its abort signal fires; without a timeout
  // signal this would hang the poll loop forever.
  const fetchImpl = ((_url: URL | string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
    })) as unknown as typeof fetch;

  const worker = new A2ABrokerWorker(robustnessConfig({ requestTimeoutMs: 50 }), { fetchImpl });

  await assert.rejects(worker.register(), /aborted by signal/);
});

test("external handler injects the subagent conductor directive per task", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "a2a-subagent-env-"));
  const scriptPath = join(dir, "echo-env.mjs");
  writeFileSync(
    scriptPath,
    [
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      "process.stdout.write(JSON.stringify({ result: { summary: 'env probe', output: {",
      "  conductor: process.env.A2A_SUBAGENT_CONDUCTOR ?? null,",
      "  max: process.env.A2A_SUBAGENT_MAX ?? null,",
      "  roles: process.env.A2A_SUBAGENT_ROLES ?? null,",
      "  plan: process.env.A2A_SUBAGENT_PLAN ?? null,",
      "} } }));",
    ].join("\n"),
  );

  const handler = createExternalWorkerHandler({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 5_000,
    workerId: "conductor-node",
    subagentCap: 4,
  });

  const baseTask = {
    id: "task-conductor-1",
    exchangeId: "exchange-conductor-1",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "conductor-node", kind: "node", role: "analyst" },
    message: "simple chat",
    status: "running",
    targetNodeId: "conductor-node",
    payload: {},
    createdAt: "2026-06-12T00:00:00Z",
    updatedAt: "2026-06-12T00:00:00Z",
  } as never;

  // Simple work: the conductor keeps it for itself (budget reflects size).
  const simple = (await handler(baseTask)) as { result: { output: Record<string, string | null> } };
  assert.equal(simple.result.output.conductor, "1");
  assert.ok(Number(simple.result.output.max) <= 1, "simple chat must not justify fanout");

  // Heavy work with an explicit profile: full four-subagent budget.
  const heavyTask = {
    ...(baseTask as Record<string, unknown>),
    id: "task-conductor-2",
    intent: "propose_patch",
    payload: {
      subagentProfile: {
        size: "large",
        coupling: "low",
        hasIndependentSubtasks: true,
        writeSets: ["src/a.ts", "src/b.ts"],
      },
    },
  } as never;
  const heavy = (await handler(heavyTask)) as { result: { output: Record<string, string | null> } };
  assert.equal(heavy.result.output.max, "4");
  assert.equal(heavy.result.output.roles, "explorer,implementer,implementer,verifier");
  const plan = JSON.parse(heavy.result.output.plan ?? "{}");
  assert.equal(plan.oneFinalizerRequired, true);
  assert.equal(plan.writeSetIsolationRequired, true);

  // Opt-out keeps the env clean.
  const optedOut = createExternalWorkerHandler({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 5_000,
    subagentDirectiveDisabled: true,
  });
  const none = (await optedOut(baseTask)) as { result: { output: Record<string, string | null> } };
  assert.equal(none.result.output.conductor, null);
});

test("conductor budget is a verifiable contract: reports are annotated, overruns fail closed", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "a2a-subagent-budget-"));
  const scriptPath = join(dir, "report.mjs");
  writeFileSync(
    scriptPath,
    [
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      "const task = JSON.parse(Buffer.concat(chunks).toString());",
      "const count = Number(task.payload?.reportCount ?? 0);",
      "process.stdout.write(JSON.stringify({ result: { summary: 'done', output: { subagentReport: { count, roles: ['verifier'] } } } }));",
    ].join("\n"),
  );

  const handler = createExternalWorkerHandler({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 5_000,
    workerId: "conductor-node",
    subagentCap: 4,
  });

  const heavyProfile = {
    subagentProfile: {
      size: "large",
      coupling: "low",
      hasIndependentSubtasks: true,
      writeSets: ["src/a.ts", "src/b.ts"],
    },
  };
  const makeTask = (id: string, payload: Record<string, unknown>) =>
    ({
      id,
      exchangeId: `exchange-${id}`,
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "conductor-node", kind: "node", role: "analyst" },
      message: "budget test",
      status: "running",
      targetNodeId: "conductor-node",
      payload,
      createdAt: "2026-06-12T00:00:00Z",
      updatedAt: "2026-06-12T00:00:00Z",
    }) as never;

  // Within budget (4): annotated with the budget for terminal evidence.
  const ok = (await handler(makeTask("budget-ok", { ...heavyProfile, reportCount: 3 }))) as {
    result: { output: { subagentReport: Record<string, unknown> } };
  };
  assert.equal(ok.result.output.subagentReport.count, 3);
  assert.equal(ok.result.output.subagentReport.budget, 4);
  assert.equal(ok.result.output.subagentReport.withinBudget, true);

  // Over budget: fail closed.
  const over = (await handler(makeTask("budget-over", { ...heavyProfile, reportCount: 5 }))) as {
    error: { code: string; details: Record<string, unknown> };
  };
  assert.equal(over.error.code, "subagent_budget_exceeded");
  assert.equal(over.error.details.budget, 4);
  assert.equal(over.error.details.reported, 5);

  // No report: result passes through untouched.
  const silentScript = join(dir, "silent.mjs");
  writeFileSync(
    silentScript,
    [
      "for await (const chunk of process.stdin) void chunk;",
      "process.stdout.write(JSON.stringify({ result: { summary: 'no report' } }));",
    ].join("\n"),
  );
  const silentHandler = createExternalWorkerHandler({
    command: process.execPath,
    args: [silentScript],
    timeoutMs: 5_000,
    subagentCap: 4,
  });
  const silent = (await silentHandler(makeTask("budget-silent", {}))) as { result: { summary: string } };
  assert.equal(silent.result.summary, "no report");
});
