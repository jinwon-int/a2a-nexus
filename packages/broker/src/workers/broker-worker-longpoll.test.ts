// Worker-side long-poll wiring (#2082 B): the idle poll requests waitMs (6×
// the poll interval, capped at the broker's 30s bound) with per-request
// timeout headroom, while the startup readiness probe stays instant.
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

test("idle polls carry waitMs (6x poll interval) and extend the request timeout beyond the hold", async () => {
  const paths: string[] = [];
  const timeoutCalls: number[] = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = ((ms: number) => {
    timeoutCalls.push(ms);
    return realTimeout(ms);
  }) as typeof AbortSignal.timeout;
  try {
    const worker = makeWorker(async (url) => {
      paths.push(`${url.pathname}?${url.searchParams.toString()}`);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });

    await (worker as unknown as {
      pollQueuedTasks(waitMs?: number): Promise<unknown[]>;
    }).pollQueuedTasks(30_000);

    assert.deepEqual(paths, ["/tasks?assignedWorkerId=workerbeta&status=queued&waitMs=30000"]);
    // Request timeout must exceed the 30s hold so the long-poll is never
    // aborted client-side (waitMs + 5s headroom).
    assert.deepEqual(timeoutCalls, [35_000]);
  } finally {
    AbortSignal.timeout = realTimeout;
  }
});

test("the readiness probe polls without waitMs", async () => {
  const paths: string[] = [];
  const worker = makeWorker(async (url) => {
    paths.push(`${url.pathname}?${url.searchParams.toString()}`);
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  });

  await worker.verifyPollReadiness();
  assert.equal(paths.length, 1);
  assert.equal(paths[0], "/tasks?assignedWorkerId=workerbeta&status=queued");
});

test("taskLongPollWaitMs derives from pollIntervalMs and clamps at the broker cap", () => {
  const fetchNever = async (): Promise<Response> => {
    throw new Error("must not be called");
  };
  const base = makeWorker(fetchNever);
  const wait = (worker: A2ABrokerWorker) =>
    (worker as unknown as { taskLongPollWaitMs(): number }).taskLongPollWaitMs();
  assert.equal(wait(base), 30_000); // 5_000 * 6

  const config: BrokerWorkerConfig = {
    brokerUrl: "http://broker.test",
    requesterKind: "node",
    pollIntervalMs: 1_000,
    heartbeatIntervalMs: 30_000,
    handlerTimeoutMs: 60_000,
    worker: { nodeId: "workerbeta", role: "analyst", capabilities: { ...WORKER_CAPABILITIES } },
    userAgent: "test-agent",
    handler: async () => ({}),
  };
  const fast = new A2ABrokerWorker(config, { fetchImpl: fetchNever as never });
  assert.equal(wait(fast), 6_000);
});
