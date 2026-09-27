// #2271: the initial broker contact (register + first heartbeat) used to exit
// non-zero on the first transient socket error — e.g. the broker tunnel
// restarting ahead of the worker in a scheduled self-update window — leaving
// recovery entirely to systemd's RestartSec. These tests pin the startup
// retry contract: connection-class failures are retried with the #1405
// bounded jittered exponential family, non-connection errors fail fast,
// exhaustion emits exactly one structured log line, and a stop() during the
// retry wait leaves quietly.
import assert from "node:assert/strict";
import test from "node:test";

import {
  A2ABrokerWorker,
  DEFAULT_STARTUP_RETRY_ATTEMPTS,
  DEFAULT_STARTUP_RETRY_BASE_MS,
} from "./broker-worker-client.js";
import type { BrokerWorkerConfig } from "../worker.js";

const WORKER_CAPABILITIES = {
  canAnalyze: true,
  canBackfill: false,
  canPatchWorkspace: false,
  canPromoteLive: false,
  workspaceIds: ["test"],
  environments: ["research" as const],
};

function connectionError(): Error {
  return Object.assign(new Error("connect ECONNRESET 127.0.0.1:18787"), { code: "ECONNRESET" });
}

function makeWorker(
  fetchImpl: (url: URL, init?: RequestInit) => Promise<Response>,
  overrides: Partial<BrokerWorkerConfig> = {},
): A2ABrokerWorker {
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
    ...overrides,
  };
  return new A2ABrokerWorker(config, { fetchImpl: fetchImpl as never });
}

function brokerResponses(fetchImpl: (url: URL, init?: RequestInit) => Promise<Response>) {
  return async (url: URL, init?: RequestInit) => {
    if (url.pathname === "/workers/register" || url.pathname.endsWith("/heartbeat")) {
      return fetchImpl(url, init);
    }
    // Readiness probe and idle poll: always healthy.
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };
}

test("defaults match the issue contract: 5 retries at a 1s exponential base", () => {
  assert.equal(DEFAULT_STARTUP_RETRY_ATTEMPTS, 5);
  assert.equal(DEFAULT_STARTUP_RETRY_BASE_MS, 1_000);
});

test("a transient connection error before the first heartbeat is retried, not fatal", async () => {
  let registerCalls = 0;
  let enteredPollLoop = false;
  const worker = makeWorker(async (url) => {
    if (url.pathname === "/workers/register") {
      registerCalls += 1;
      if (registerCalls === 1) throw connectionError();
      return new Response(JSON.stringify({ workerId: "workerbeta" }), { status: 200 });
    }
    if (url.pathname.endsWith("/heartbeat")) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    // The readiness probe hits /tasks without waitMs; only the poll loop
    // carries waitMs. Distinguish so this asserts loop entry, not the probe.
    if (url.pathname === "/tasks" && url.searchParams.get("waitMs") !== null) {
      enteredPollLoop = true;
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }, { startupRetryBaseMs: 5 });

  const running = worker.run();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await worker.stop();
  await running;

  assert.ok(registerCalls >= 2, `register should have been retried, calls=${registerCalls}`);
  assert.ok(enteredPollLoop, "worker should reach the poll loop after the retry succeeds");
});

test("non-connection startup errors (auth) fail fast without retrying", async () => {
  let registerCalls = 0;
  const worker = makeWorker(brokerResponses(async (url) => {
    if (url.pathname === "/workers/register") {
      registerCalls += 1;
      return new Response(
        JSON.stringify({ error: { code: "unauthorized", message: "bad edge secret" } }),
        { status: 401 },
      );
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }), { startupRetryAttempts: 5, startupRetryBaseMs: 5 });

  await assert.rejects(() => worker.run(), /bad edge secret/);
  assert.equal(registerCalls, 1, "auth errors must not be retried");
});

test("exhausted retries log exactly one structured line and then fail non-zero", async () => {
  const errorLines: string[] = [];
  const originalConsoleError = console.error;
  console.error = (line: unknown) => {
    errorLines.push(String(line));
  };
  let registerCalls = 0;
  try {
    const worker = makeWorker(brokerResponses(async (url) => {
      if (url.pathname === "/workers/register") {
        registerCalls += 1;
        throw connectionError();
      }
      throw connectionError();
    }), { startupRetryAttempts: 3, startupRetryBaseMs: 2 });

    await assert.rejects(() => worker.run(), /ECONNRESET/);
  } finally {
    console.error = originalConsoleError;
  }

  // 1 initial attempt + 3 retries, then give up.
  assert.equal(registerCalls, 4);
  const structured = errorLines.filter((line) => line.includes("startupConnectionRetryExhausted"));
  assert.equal(structured.length, 1);
  const parsed = JSON.parse(structured[0]!) as {
    level: string;
    component: string;
    event: string;
    workerId: string;
    totalAttempts: number;
    retryAttempts: number;
    message: string;
  };
  assert.equal(parsed.level, "error");
  assert.equal(parsed.component, "a2a-worker");
  assert.equal(parsed.event, "startupConnectionRetryExhausted");
  assert.equal(parsed.workerId, "workerbeta");
  assert.equal(parsed.totalAttempts, 4);
  assert.equal(parsed.retryAttempts, 3);
  assert.match(parsed.message, /ECONNRESET/);
});

test("startup retry backoff grows exponentially inside the ±25% jitter band", async () => {
  const stamps: number[] = [];
  const worker = makeWorker(brokerResponses(async (url) => {
    if (url.pathname === "/workers/register") {
      stamps.push(Date.now());
      if (stamps.length < 3) throw connectionError();
      return new Response(JSON.stringify({ workerId: "workerbeta" }), { status: 200 });
    }
    if (url.pathname.endsWith("/heartbeat")) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }), { startupRetryAttempts: 2, startupRetryBaseMs: 100 });

  const running = worker.run();
  await new Promise((resolve) => setTimeout(resolve, 700));
  await worker.stop();
  await running;

  assert.equal(stamps.length, 3);
  const firstGap = stamps[1]! - stamps[0]!;
  const secondGap = stamps[2]! - stamps[1]!;
  // base 100ms → retry 1 sleeps 75–125ms, retry 2 sleeps 150–250ms. The bands
  // do not overlap, so growth is deterministic even with real jitter.
  assert.ok(firstGap >= 70, `first gap ${firstGap}ms below the jitter floor`);
  assert.ok(secondGap >= 145, `second gap ${secondGap}ms below the jitter floor`);
  assert.ok(secondGap > firstGap, `backoff must grow: ${firstGap}ms -> ${secondGap}ms`);
});

test("stop() during the startup retry wait leaves quietly without entering the poll loop", async () => {
  const paths: string[] = [];
  let registerCalls = 0;
  const worker = makeWorker(brokerResponses(async (url) => {
    paths.push(url.pathname);
    if (url.pathname === "/workers/register") {
      registerCalls += 1;
      if (registerCalls === 2) {
        void worker.stop();
      }
      throw connectionError();
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }), { startupRetryAttempts: 5, startupRetryBaseMs: 50 });

  // Resolves instead of throwing: a requested stop is not a failure.
  await worker.run();
  assert.equal(registerCalls, 2);
  assert.ok(!paths.some((path) => path.startsWith("/tasks")), "must not enter the poll loop");
});
