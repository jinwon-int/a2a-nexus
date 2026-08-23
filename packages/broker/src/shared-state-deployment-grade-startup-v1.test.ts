/**
 * Startup wiring for the Phase 3 deployment-grade parser.
 *
 * `createBrokerServer` must call the parser and refuse construction on a
 * rejected grade, so listen never happens. This file does not install
 * `/readyz`, open the V1 adapter, publish `stateContract`, or change
 * `/health`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createBrokerServer } from "./server.js";
import {
  createInMemoryStateStore,
  startTestServer,
  withEnv,
} from "./server-test-helpers.js";

function createLoopbackServer() {
  return createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: createInMemoryStateStore(),
  });
}

test("omitted grade env still constructs and can listen", async () => {
  await withEnv({
    BROKER_DEPLOYMENT_GRADE: undefined,
    BROKER_EXPECTED_PROCESS_COUNT: undefined,
  }, async () => {
    const runtime = createLoopbackServer();
    try {
      assert.equal(runtime.server.listening, false);
    } finally {
      runtime.server.close();
    }

    const server = await startTestServer();
    try {
      assert.equal(server.runtime.server.listening, true);
    } finally {
      await server.close();
    }
  });
});

test("explicit servable grade still constructs", async () => {
  await withEnv({
    BROKER_DEPLOYMENT_GRADE: "single-writer-durable",
    BROKER_EXPECTED_PROCESS_COUNT: "1",
  }, async () => {
    const runtime = createLoopbackServer();
    runtime.server.close();
  });
});

test("shared-state-ha fails closed before listen", async () => {
  await withEnv({ BROKER_DEPLOYMENT_GRADE: "shared-state-ha" }, async () => {
    assert.throws(
      () => createLoopbackServer(),
      /shared-state deployment grade rejected: shared_backend_unavailable/,
    );
  });
});

test("expected process count other than 1 fails closed before listen", async () => {
  await withEnv({ BROKER_EXPECTED_PROCESS_COUNT: "2" }, async () => {
    assert.throws(
      () => createLoopbackServer(),
      /shared-state deployment grade rejected: expected_process_count_unsupported/,
    );
  });
});

test("present empty grade string fails closed before listen", async () => {
  await withEnv({ BROKER_DEPLOYMENT_GRADE: "" }, async () => {
    assert.throws(
      () => createLoopbackServer(),
      /shared-state deployment grade rejected: unknown_configured_grade/,
    );
  });
});

test("startup wiring does not add stateContract health", async () => {
  await withEnv({
    BROKER_DEPLOYMENT_GRADE: undefined,
    BROKER_EXPECTED_PROCESS_COUNT: undefined,
  }, async () => {
    const server = await startTestServer({ edgeSecret: "s" });
    try {
      const healthRes = await fetch(`${server.baseUrl}/health`, {
        headers: { "x-a2a-edge-secret": "s" },
      });
      assert.equal(healthRes.status, 200);
      const health = await healthRes.json();
      assert.equal(Object.hasOwn(health, "configuredGrade"), false);
      assert.equal(Object.hasOwn(health, "effectiveGrade"), false);
      assert.equal(Object.hasOwn(health, "gradeDefaulted"), false);
      assert.equal(Object.hasOwn(health, "stateContract"), false);
    } finally {
      await server.close();
    }
  });
});
