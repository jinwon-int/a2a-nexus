/**
 * Server-level tests for the #1504 §5 Phase 6 live-shadow runtime.
 *
 * With `sharedStateShadowV1: true` every non-public request mirrors its
 * rate-limit decision (and signed requests their replay decision) into the
 * separate shadow store, and `/health` carries the aggregate-only shadow
 * evidence block. Default-off adds no shadow block. An invalid env value
 * fails startup loudly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBrokerServer } from "./server.js";
import {
  createInMemoryStateStore,
  jsonHeaders,
  startTestServer,
  withEnv,
  workerPayload,
} from "./server-test-helpers.js";

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "a2a-server-shadow-v1-test-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function registerWorker(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/workers/register`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
    body: JSON.stringify(workerPayload("workerbeta")),
  });
  assert.ok(res.status === 200 || res.status === 201);
}

test("sharedStateShadowV1 mirrors live decisions and reports the shadow block on /health", async () => {
  await withTempDir(async (directory) => {
    const shadowStateFile = join(directory, "shadow-v1.sqlite");
    const server = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateShadowV1: true,
      shadowStateFile,
    });
    try {
      await registerWorker(server.baseUrl);
      // The register + a follow-up rate-limited request both mirror into the
      // shadow store; /health (itself a non-public route) then reports the
      // aggregate-only evidence block.
      const health = await fetch(`${server.baseUrl}/health`);
      assert.equal(health.status, 200);
      const body = await health.json() as {
        stateShadow?: {
          rate?: { compared: number; matches: number; unexplained: number };
          replay?: { compared: number };
        };
      };
      assert.ok(body.stateShadow, "expected the shadow evidence block on /health");
      assert.ok((body.stateShadow.rate?.compared ?? 0) >= 2, "expected mirrored rate observations");
      assert.ok((body.stateShadow.rate?.matches ?? 0) >= 2);
      assert.equal(body.stateShadow.rate?.unexplained ?? -1, 0);
    } finally {
      await server.close();
    }
    // The shadow owns its own store file (never the serving store).
    assert.ok(existsSync(shadowStateFile));
  });
});

test("default-off adds no shadow observations or /health block", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    sharedStateShadowV1: false,
  });
  try {
    await registerWorker(server.baseUrl);
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200);
    const body = await health.json() as Record<string, unknown>;
    assert.equal("stateShadow" in body, false);
  } finally {
    await server.close();
  }
});

test("invalid BROKER_SHADOW_STATE_V1 value fails startup loudly", async () => {
  await withEnv({ BROKER_SHADOW_STATE_V1: "definitely-not-a-mode" }, async () => {
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
        error.message.includes("BROKER_SHADOW_STATE_V1"),
    );
  });
});
