import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrokerPersistenceQueueDiagnostics } from "./server.js";
import { BrokerError, InMemoryA2ABroker } from "./core/broker.js";
import { emptySnapshot, SqliteBrokerStateStore, type BrokerStateStore } from "./core/store.js";
import { WorkerThreadProxyStore, WriteQueue, type SqliteWorkerThread } from "./core/sqlite-worker-thread-persistence.js";
import { WorkerRegistrationResponse } from "./core/types.js";
import { createInMemoryStateStore, createDeferred, waitFor, startTestServer, createTaskRequest, jsonHeaders, withEnv, registerTestWorker } from "./server-test-helpers.js";

test("mutating task routes wait for durable persistence ACK before success", async () => {
  const ack = createDeferred();
  let snapshot = emptySnapshot();
  let ackCalls = 0;
  const stateStore: BrokerStateStore = {
    load: () => snapshot,
    save: (nextSnapshot) => {
      snapshot = structuredClone(nextSnapshot);
    },
    awaitDurablePersistenceAck: () => {
      ackCalls += 1;
      return ack.promise;
    },
  };
  const server = await startTestServer({ stateStore, enforceRequesterIdentity: true });
  let responseSettled = false;
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
    const responsePromise = fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "test-hub",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify(createTaskRequest("task-awaits-durable-ack")),
    }).then((response) => {
      responseSettled = true;
      return response;
    });

    await waitFor(() => ackCalls === 1);
    assert.equal(responseSettled, false, "response should wait until durable ACK resolves");

    ack.resolve(undefined);
    const response = await responsePromise;
    assert.equal(response.status, 201);
    const task = await response.json() as { id: string };
    assert.equal(task.id, "task-awaits-durable-ack");
  } finally {
    await server.close();
  }
});

test("task create disambiguates durable-ack failure as 202 accepted-unconfirmed; other mutations keep 503 (a2a-nexus#636/#638)", async () => {
  const stateStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: () => {},
    awaitDurablePersistenceAck: async () => {
      throw new Error("queue_drain_timeout");
    },
  };
  const server = await startTestServer({ stateStore, enforceRequesterIdentity: true });
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
    // The task exists in the broker once createTask returns; an ack timeout
    // must not masquerade as a rejection with no task id. The 202 carries
    // the created task plus the ack error so dispatch tooling can classify
    // accepted-unconfirmed and verify via GET /tasks/:id.
    const response = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "test-hub",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify(createTaskRequest("task-durable-ack-202")),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as {
      task: { id: string };
      durable: boolean;
      ackError: { code: string };
      hint: string;
    };
    assert.equal(body.task.id, "task-durable-ack-202");
    assert.equal(body.durable, false);
    assert.equal(body.ackError.code, "queue_drain_timeout");
    assert.match(body.hint, /GET \/tasks\/task-durable-ack-202/);
    assert.ok(server.runtime.broker.getTask("task-durable-ack-202"), "task really exists despite ack failure");

    // Other mutating routes keep the retryable 503: the caller can simply
    // retry them, unlike create where the retry answer is "it exists".
    const claim = await fetch(`${server.baseUrl}/tasks/task-durable-ack-202/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(claim.status, 503);
    const claimBody = await claim.json() as { error: { code: string } };
    assert.equal(claimBody.error.code, "queue_drain_timeout");
  } finally {
    await server.close();
  }
});

test("worker-thread persistence ACK timeout does not permanently abort the write queue (#1038)", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-ack-timeout-"));
  const sqliteFile = join(tmpDir, "state.sqlite");
  const queue = new WriteQueue(4);
  const first = createDeferred<boolean>();
  const second = createDeferred<boolean>();
  const requests: string[] = [];
  const fakeWorkerThread = {
    request(method: string) {
      requests.push(method);
      return requests.length === 1 ? first.promise : second.promise;
    },
  } as unknown as SqliteWorkerThread;
  const store = new WorkerThreadProxyStore(queue, fakeWorkerThread, sqliteFile, 20);
  const keepAlive = setInterval(() => undefined, 5);
  try {
    store.saveHotEntities({ hotTasks: [] });
    await assert.rejects(store.awaitDurablePersistenceAck(), /queue_drain_timeout/);
    assert.equal(queue.stats().aborted, false, "ACK timeout must not poison future writes");
    assert.equal(queue.stats().closing, false, "ACK timeout must not close the queue");

    first.resolve(true);
    await queue.awaitIdle({ timeoutMs: 1000 });
    assert.equal(queue.stats().inFlight, 0);

    store.saveHotEntities({ hotTasks: [] });
    second.resolve(true);
    await store.awaitDurablePersistenceAck();
    assert.equal(queue.stats().aborted, false);
    assert.deepEqual(requests, ["saveHotEntities", "saveHotEntities"]);
  } finally {
    clearInterval(keepAlive);
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("repeated unchanged worker registration is idempotent and heartbeat-like without durable heartbeat writes", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: true });
  const nodeId = "worker-a";
  const registration = {
    nodeId,
    role: "analyst",
    displayName: "Worker A",
    brokerUrl: "http://127.0.0.1:8787",
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

    const second = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(registration),
    });
    assert.equal(second.status, 201);

    assert.equal(
      server.runtime.broker.listAuditEvents({ action: "worker.registered" }).length,
      1,
    );
    assert.equal(
      server.runtime.broker.listAuditEvents({ action: "worker.heartbeat" }).length,
      0,
    );
  } finally {
    await server.close();
  }
});

test("server exposes lightweight liveness without persistence diagnostics", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
  });
  try {
    const res = await fetch(`${server.baseUrl}/livez`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, "a2a-broker");
    assert.equal(typeof body.uptimeSec, "number");
    assert.equal(body.persistence, undefined);
    assert.equal(body.persistenceQueue, undefined);
    assert.equal(body.auditDiagnostics, undefined);
    assert.equal(body.terminalOutboxDiagnostics, undefined);

    // Lightweight attribution diagnostics present on /livez.
    assert.ok(body.eventLoop, "/livez should include eventLoop field");
    assert.ok(body.eventLoop.delayMs === null || typeof body.eventLoop.delayMs === "number");
    // gc may be undefined when the GC observer isn't available (no --experimental-perf-gc)
    if (body.gc !== undefined) {
      assert.equal(typeof body.gc.totalMs, "number");
      assert.equal(typeof body.gc.count, "number");
      assert.equal(typeof body.gc.lastMs, "number");
    }
    // cpu should always be computable.
    assert.ok(body.cpu, "/livez should include cpu field");
    assert.equal(typeof body.cpu.percentSinceLastCheck, "number");
    assert.equal(typeof body.cpu.deltaUserMicrosec, "number");
    assert.equal(typeof body.cpu.deltaSystemMicrosec, "number");
    assert.equal(typeof body.cpu.deltaIntervalMs, "number");
    // timing should have a snapshot or be null on first ever request.
    if (body.timing !== null) {
      assert.equal(typeof body.timing.count, "number");
      assert.equal(typeof body.timing.maxMs, "number");
      assert.equal(typeof body.timing.p99Ms, "number");
    }
    assert.equal(typeof body.diagMs, "number");
    // activeRequests is an O(1) scheduling gauge (issue #1032)
    assert.equal(typeof body.activeRequests, "number");
    assert.ok(body.activeRequests >= 0);
    // requestDurationMs should be a finite number indicating the elapsed
    // handler processing time for this /livez request.
    assert.equal(typeof body.requestDurationMs, "number");
    assert.ok(body.requestDurationMs >= 0, "requestDurationMs should be >= 0");
    assert.ok(body.probeTiming, "/livez should include probeTiming field");
    assert.equal(typeof body.probeTiming.handlerStartUnixMs, "number");
    assert.equal(typeof body.probeTiming.responsePreparedUnixMs, "number");
    assert.equal(typeof body.probeTiming.responsePreparationDurationMs, "number");
    assert.equal(typeof body.probeTiming.socketConnectedUnixMs, "number");
    assert.equal(typeof body.probeTiming.socketAgeBeforeHandlerMs, "number");
    assert.equal(typeof body.probeTiming.httpRequestEventUnixMs, "number");
    assert.equal(typeof body.probeTiming.socketAcceptedToHttpRequestEventMs, "number");
    assert.equal(typeof body.probeTiming.httpRequestEventToHandlerStartMs, "number");
    assert.equal(typeof body.probeTiming.socketRequestIndex, "number");
    assert.equal(typeof body.probeTiming.socketHadServedRequest, "boolean");
    // clientProbeStartToHttpRequestEventMs distinguishes client pool artifact
    // from server-side idle; will be null when no probe-start header is sent.
    assert.ok("clientProbeStartToHttpRequestEventMs" in body.probeTiming);
    // socketConnectedToFirstDataMs and firstDataToHttpRequestEventMs separate
    // accept/scheduling wait from HTTP parser/read delay (#1107).
    assert.ok("socketConnectedToFirstDataMs" in body.probeTiming,
      "/livez probeTiming must include socketConnectedToFirstDataMs");
    assert.ok("firstDataToHttpRequestEventMs" in body.probeTiming,
      "/livez probeTiming must include firstDataToHttpRequestEventMs");
    assert.ok(
      body.probeTiming.responsePreparedUnixMs >= body.probeTiming.handlerStartUnixMs,
      "responsePreparedUnixMs should be at or after handlerStartUnixMs",
    );
  } finally {
    await server.close();
  }
});

test("server surfaces persistence queue diagnostics on health, schedz, and dashboard", async () => {
  const persistenceQueue: BrokerPersistenceQueueDiagnostics = {
    kind: "broker.persistence.queue",
    enabled: true,
    mode: "worker_thread",
    state: "saturated",
    capacity: 4,
    queued: 3,
    active: 1,
    inFlight: 4,
    available: 0,
    closing: false,
    aborted: false,
    lastErrorCode: "queue_saturated",
    lastErrorAt: "2026-06-04T00:00:00.000Z",
    lastErrorMessage: "broker persistence queue is saturated",
  };
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    persistenceQueueDiagnostics: () => persistenceQueue,
  });
  try {
    const headers = { "x-a2a-edge-secret": "test-edge-secret" };

    const health = await (await fetch(`${server.baseUrl}/health`, { headers })).json();
    assert.deepEqual(health.persistenceQueue, persistenceQueue);

    const schedz = await (await fetch(`${server.baseUrl}/schedz`, { headers })).json();
    assert.deepEqual(schedz.persistenceQueue, persistenceQueue);

    const dashboard = await (await fetch(`${server.baseUrl}/dashboard`, { headers })).json();
    assert.deepEqual(dashboard.persistenceQueue, persistenceQueue);
    assert.equal(dashboard.attention.highestSeverity, "warn");
    assert.ok(
      dashboard.attention.items.some((item: { code: string; count: number }) =>
        item.code === "persistence-queue-saturated" && item.count === 4),
      "dashboard attention should flag persistence queue saturation",
    );

    const livez = await (await fetch(`${server.baseUrl}/livez`)).json();
    assert.equal(livez.persistenceQueue, undefined);
  } finally {
    await server.close();
  }
});

test("server wires worker-thread persistence queue through HTTP ACK and diagnostics", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "server-worker-persist-"));
  const sqliteFile = join(tmpDir, "state.sqlite");
  await withEnv({ BROKER_PERSISTENCE_QUEUE_WORKER_THREAD: "1" }, async () => {
    const server = await startTestServer({
      stateStore: undefined,
      persistenceBackend: "sqlite",
      sqliteFile,
      sqliteLoadSource: "hot-tables",
      edgeSecret: "test-edge-secret",
      enforceRequesterIdentity: false,
    });
    try {
      await registerTestWorker(server.baseUrl, "worker-thread-http", "operator", "test-edge-secret");

      const health = await (await fetch(`${server.baseUrl}/health`, { headers: { "x-a2a-edge-secret": "test-edge-secret" } })).json() as {
        persistenceQueue: BrokerPersistenceQueueDiagnostics;
      };
      assert.equal(health.persistenceQueue.enabled, true);
      assert.equal(health.persistenceQueue.mode, "worker_thread");
      assert.equal(health.persistenceQueue.state, "healthy");
      assert.equal(health.persistenceQueue.closing, false);

      const reader = new SqliteBrokerStateStore(sqliteFile, { loadSource: "hot-tables" });
      try {
        assert.equal(reader.load().workers[0]?.nodeId, "worker-thread-http");
      } finally {
        reader.close();
      }
    } finally {
      await server.close();
    }
  });
  rmSync(tmpDir, { recursive: true, force: true });
});

test("server exposes durable broker identity on health and worker registration", async () => {
  await withEnv({ A2A_BROKER_ID: "broker-env-1", BROKER_ID: undefined }, async () => {
    const envServer = await startTestServer();
    try {
      assert.equal(envServer.runtime.config.brokerId, "broker-env-1");

      const healthRes = await fetch(`${envServer.baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const health = await healthRes.json();
      assert.equal(health.brokerId, "broker-env-1");
    } finally {
      await envServer.close();
    }
  });

  await withEnv({ A2A_BROKER_ID: "broker-env-ignored", BROKER_ID: undefined }, async () => {
    const server = await startTestServer({ brokerId: "broker-option-1" });
    try {
      assert.equal(server.runtime.config.brokerId, "broker-option-1");

      const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
        method: "POST",
        headers: jsonHeaders({
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
      const registration = await registerRes.json() as WorkerRegistrationResponse;
      assert.equal(registration.status, "online");
      assert.equal(registration.brokerId, "broker-option-1");
    } finally {
      await server.close();
    }
  });
});

test("server maps retryable persistence queue BrokerErrors to 503", async () => {
  class QueueSaturatedBroker extends InMemoryA2ABroker {
    override heartbeatWorker(): never {
      throw new BrokerError("queue_saturated", "broker persistence queue is saturated");
    }
  }

  const server = await startTestServer({
    broker: new QueueSaturatedBroker(createInMemoryStateStore(), emptySnapshot()),
    enforceRequesterIdentity: false,
  });
  try {
    const res = await fetch(`${server.baseUrl}/workers/worker-queue/heartbeat`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ lastSeenAt: "2026-06-04T00:00:00.000Z" }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body.error, {
      code: "queue_saturated",
      message: "broker persistence queue is saturated",
    });
  } finally {
    await server.close();
  }
});
