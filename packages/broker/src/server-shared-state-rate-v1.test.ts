/**
 * Server-level tests for the #1504 §4 Slice T rate-primitive integration.
 *
 * With `sharedStateRateV1: true` the broker-edge rate-limit check is reserved
 * through the V1 adapter via the serving fence: requests admit up to the
 * configured limit, the next is rejected as 429 with the same headers as the
 * local path, and in-window cost survives a full server restart (the property
 * the process-local limiter cannot provide — it would reset). The default-off
 * posture and the loud startup failure on an invalid env value are asserted
 * as well.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBrokerServer } from "./server.js";
import {
  createInMemoryStateStore,
  startTestServer,
  withEnv,
} from "./server-test-helpers.js";

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "a2a-server-rate-v1-test-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function getHealth(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/health`);
}

test("sharedStateRateV1 limits the worker bucket through the V1 primitive", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    sharedStateRateV1: true,
    rateLimitMaxRequests: 100,
    workerRateLimitMaxRequests: 2,
  });
  try {
    const headers = { "content-type": "application/json", "x-a2a-requester-id": "rate-worker" };
    const first = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const second = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers,
      body: "{}",
    });
    // Admission is what matters here; the handler may still 4xx the payload.
    assert.notEqual(first.status, 429);
    assert.notEqual(second.status, 429);

    const third = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(third.status, 429);
    assert.equal(third.headers.get("x-a2a-ratelimit-bucket"), "worker");
    assert.equal(third.headers.get("x-ratelimit-remaining"), "0");
    assert.ok(Number(third.headers.get("retry-after")) >= 1);

    // A distinct principal has its own bucket.
    const other = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: { ...headers, "x-a2a-requester-id": "rate-worker-2" },
      body: "{}",
    });
    assert.notEqual(other.status, 429);
  } finally {
    await server.close();
  }
});

test("sharedStateRateV1 keeps in-window cost denying across a server restart", async () => {
  await withTempDir(async (directory) => {
    const sharedStateFile = join(directory, "rate-v1.sqlite");
    const options = {
      brokerId: "brokeralpha",
      sharedStateRateV1: true,
      rateLimitMaxRequests: 2,
      sharedStateFile,
    };

    const server1 = await startTestServer(options);
    try {
      const first = await getHealth(server1.baseUrl);
      assert.equal(first.status, 200);
      const firstBody = await first.json() as {
        stateContractDomains?: { rateLimit?: { availability?: string } };
      };
      assert.equal(firstBody.stateContractDomains?.rateLimit?.availability, "available");
      const second = await getHealth(server1.baseUrl);
      assert.equal(second.status, 200);
      const exhausted = await getHealth(server1.baseUrl);
      assert.equal(exhausted.status, 429);
    } finally {
      await server1.close();
    }

    // The durable bucket survived the restart: the same principal is still
    // exhausted, which the process-local limiter could never do (it resets).
    const server2 = await startTestServer(options);
    try {
      const afterRestart = await getHealth(server2.baseUrl);
      assert.equal(afterRestart.status, 429);
      // A distinct principal is unaffected.
      const other = await fetch(`${server2.baseUrl}/health`, {
        headers: { "x-a2a-requester-id": "rate-fresh" },
      });
      assert.equal(other.status, 200);
    } finally {
      await server2.close();
    }
  });
});

test("default-off keeps the process-local limiter behavior unchanged", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    sharedStateRateV1: false,
    rateLimitMaxRequests: 2,
  });
  try {
    assert.equal((await getHealth(server.baseUrl)).status, 200);
    assert.equal((await getHealth(server.baseUrl)).status, 200);
    assert.equal((await getHealth(server.baseUrl)).status, 429);
  } finally {
    await server.close();
  }
});

test("invalid BROKER_SHARED_STATE_V1_RATE value fails startup loudly", async () => {
  await withEnv({ BROKER_SHARED_STATE_V1_RATE: "definitely-not-a-mode" }, async () => {
    assert.throws(
      () =>
        createBrokerServer({
          host: "127.0.0.1",
          port: 0,
          publicBaseUrl: "https://broker.test/",
          brokerId: "brokeralpha",
          stateStore: createInMemoryStateStore(),
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("BROKER_SHARED_STATE_V1_RATE"),
    );
  });
});
