/**
 * Server-level tests for the #1504 §4 Slice V idempotency-primitive
 * integration on the task-create authority (`broker.task.create`).
 *
 * With `sharedStateIdempotencyV1: true` the same-id create replay is decided
 * by the V1 `executeIdempotent` authority: a same-payload replay returns the
 * original task, a same-id create with a changed payload is rejected with
 * 409 `idempotency_conflict` (the §5.4.1 upgrade the legacy check never had),
 * and the authority's keys/outcomes survive a durable server restart. The
 * default-off posture and the loud startup failure on an invalid env value
 * are asserted as well.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { createBrokerServer } from "./server.js";
import {
  createInMemoryStateStore,
  jsonHeaders,
  startTestServer,
  withEnv,
  workerPayload,
} from "./server-test-helpers.js";

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "a2a-server-idem-v1-test-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createBody(id: string, message: string): string {
  return JSON.stringify({
    id,
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "workerbeta", kind: "node", role: "analyst" },
    targetNodeId: "workerbeta",
    message,
    taskOrigin: "api",
  });
}

async function registerWorker(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/workers/register`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
    body: JSON.stringify(workerPayload("workerbeta")),
  });
  assert.ok(res.status === 200 || res.status === 201);
}

async function createTask(
  baseUrl: string,
  id: string,
  message: string,
): Promise<Response> {
  return fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" }),
    body: createBody(id, message),
  });
}

test("sharedStateIdempotencyV1 replays same-payload creates and conflicts on changed payloads", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    sharedStateIdempotencyV1: true,
  });
  try {
    await registerWorker(server.baseUrl);
    const first = await createTask(server.baseUrl, "idem-task-1", "hello");
    assert.equal(first.status, 201);
    const created = await first.json() as { id: string; createdAt: string };

    // Same id + same payload: the authority replays the original outcome.
    const replay = await createTask(server.baseUrl, "idem-task-1", "hello");
    assert.equal(replay.status, 200);
    const replayed = await replay.json() as { task: { id: string; createdAt: string }; idempotentReturn: boolean };
    assert.equal(replayed.idempotentReturn, true);
    assert.equal(replayed.task.id, created.id);
    assert.equal(replayed.task.createdAt, created.createdAt);

    // Same id + different payload: idempotency_conflict — the §5.4.1
    // fingerprint upgrade the legacy same-id check never had.
    const conflict = await createTask(server.baseUrl, "idem-task-1", "goodbye");
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json() as { error?: { code?: string } };
    assert.equal(conflictBody.error?.code, "idempotency_conflict");

    // A different id is an independent decision and creates normally.
    const other = await createTask(server.baseUrl, "idem-task-2", "hello");
    assert.equal(other.status, 201);
  } finally {
    await server.close();
  }
});

test("sharedStateIdempotencyV1 keeps keys and outcomes across a durable restart", async () => {
  await withTempDir(async (directory) => {
    const options = {
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: "https://broker.test/",
      brokerId: "brokeralpha",
      sharedStateIdempotencyV1: true,
      persistenceBackend: "sqlite" as const,
      sqliteFile: join(directory, "state.sqlite"),
      stateFile: join(directory, "snap.json"),
      sharedStateFile: join(directory, "fence.sqlite"),
      enforceRequesterIdentity: false,
      // Tests must not inherit the production process.exit(1) fence-loss posture.
      lostFenceExit: () => {},
    };
    const boot = async () => {
      const runtime = createBrokerServer({ ...options });
      runtime.server.listen(0, "127.0.0.1");
      await once(runtime.server, "listening");
      const address = runtime.server.address();
      if (!address || typeof address === "string") throw new Error("failed to bind");
      return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: async () => {
          runtime.server.close();
          runtime.server.closeAllConnections?.();
          await once(runtime.server, "close");
          await runtime.closeWorkerPersistence();
        },
      };
    };

    const server1 = await boot();
    try {
      await registerWorker(server1.baseUrl);
      const first = await createTask(server1.baseUrl, "idem-restart", "durable");
      assert.equal(first.status, 201);
    } finally {
      await server1.close();
    }

    // After the restart the authority still holds the key + outcome: the
    // same-payload create replays (200, original task) and the
    // different-payload create still conflicts.
    const server2 = await boot();
    try {
      const replay = await createTask(server2.baseUrl, "idem-restart", "durable");
      assert.equal(replay.status, 200);
      const conflict = await createTask(server2.baseUrl, "idem-restart", "changed");
      assert.equal(conflict.status, 409);
    } finally {
      await server2.close();
    }
  });
});

test("default-off keeps the legacy same-id replay behavior unchanged", async () => {
  const server = await startTestServer({
    brokerId: "brokeralpha",
    sharedStateIdempotencyV1: false,
  });
  try {
    await registerWorker(server.baseUrl);
    const first = await createTask(server.baseUrl, "legacy-idem", "hello");
    assert.equal(first.status, 201);
    // The legacy path returns the existing task regardless of the payload —
    // no fingerprint comparison (§5.4.1 notes exactly this partiality).
    const replay = await createTask(server.baseUrl, "legacy-idem", "changed");
    assert.equal(replay.status, 200);
    const replayed = await replay.json() as { task: { id: string } };
    assert.equal(replayed.task.id, "legacy-idem");
  } finally {
    await server.close();
  }
});

test("invalid BROKER_SHARED_STATE_V1_IDEMPOTENCY value fails startup loudly", async () => {
  await withEnv({ BROKER_SHARED_STATE_V1_IDEMPOTENCY: "definitely-not-a-mode" }, async () => {
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
        error.message.includes("BROKER_SHARED_STATE_V1_IDEMPOTENCY"),
    );
  });
});
