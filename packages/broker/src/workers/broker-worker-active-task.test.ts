// #2082 C worker-side wiring: heartbeat() names the active task (and its
// cached progress timestamp), the dedicated per-task heartbeat timer is gone,
// and the progress scan cache spans one heartbeat cycle.
import assert from "node:assert/strict";
import test from "node:test";

import { A2ABrokerWorker } from "./broker-worker-client.js";
import type { BrokerWorkerConfig } from "../worker.js";

const WORKER_CAPABILITIES = {
  canAnalyze: true,
  canBackfill: false,
  canPatchWorkspace: false,
  canPromoteLive: false,
  workspaceIds: ["test"],
  environments: ["research" as const],
};

function makeWorker(fetchImpl: (url: URL, init?: RequestInit) => Promise<Response>): A2ABrokerWorker {
  const config: BrokerWorkerConfig = {
    brokerUrl: "http://broker.test",
    requesterKind: "node",
    pollIntervalMs: 5_000,
    heartbeatIntervalMs: 30_000,
    handlerTimeoutMs: 60_000,
    worker: {
      nodeId: "workerbeta",
      role: "analyst",
      capabilities: { ...WORKER_CAPABILITIES },
    },
    userAgent: "test-agent",
    handler: async () => ({}),
  };
  return new A2ABrokerWorker(config, { fetchImpl: fetchImpl as never });
}

test("heartbeat() carries activeTaskId and lastProgressAt when a task is active", async () => {
  const bodies: unknown[] = [];
  const worker = makeWorker(async (url, init) => {
    if (url.pathname.endsWith("/heartbeat")) {
      bodies.push(JSON.parse(String(init?.body)));
    }
    return new Response(JSON.stringify({ nodeId: "workerbeta" }), { status: 200 });
  });
  (worker as unknown as { activeTaskId: string | null }).activeTaskId = "hb-task-1";

  await worker.heartbeat();

  assert.equal(bodies.length, 1);
  const body = bodies[0] as { activeTaskId?: string; activeTaskLastProgressAt?: string };
  assert.equal(body.activeTaskId, "hb-task-1");
  // No real progress surface in the test env → the scan resolves undefined but
  // the field stays absent rather than null/garbage.
  assert.equal(body.activeTaskLastProgressAt, undefined);
});

test("heartbeat() omits activeTaskId when idle", async () => {
  const bodies: unknown[] = [];
  const worker = makeWorker(async (url, init) => {
    if (url.pathname.endsWith("/heartbeat")) {
      bodies.push(JSON.parse(String(init?.body)));
    }
    return new Response(JSON.stringify({ nodeId: "workerbeta" }), { status: 200 });
  });

  await worker.heartbeat();
  const body = bodies[0] as { activeTaskId?: string };
  assert.equal(body.activeTaskId, undefined);
});

test("the progress scan is cached across calls within one heartbeat cycle", async () => {
  let scanCount = 0;
  const worker = makeWorker(async () => new Response(JSON.stringify({ nodeId: "workerbeta" }), { status: 200 }));
  const inner = worker as unknown as {
    scanTaskProgressAt(taskId: string): Promise<string | undefined>;
    resolveTaskProgressAt(taskId: string): Promise<string | undefined>;
    progressAtCache: Map<string, { scannedAtMs: number; value: string | undefined }>;
  };
  const original = inner.scanTaskProgressAt.bind(worker);
  inner.scanTaskProgressAt = (taskId: string) => {
    scanCount += 1;
    return original(taskId);
  };

  await inner.resolveTaskProgressAt("hb-cache-1");
  await inner.resolveTaskProgressAt("hb-cache-1");
  await inner.resolveTaskProgressAt("hb-cache-1");

  assert.equal(scanCount, 1, "repeat resolves within the heartbeat cycle must hit the cache");
  assert.ok(inner.progressAtCache.has("hb-cache-1"));
});
