import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBrokerServer } from "./server.js";
import { emptySnapshot, SqliteBrokerStateStore, type BrokerSnapshot } from "./core/store.js";
import { WorkerRegistrationResponse } from "./core/types.js";
import { startTestServer, jsonHeaders, registerTestWorker } from "./server-test-helpers.js";

test("server surfaces invalid worker hot row diagnostics on dashboard while health keeps safe persistence metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-invalid-worker-"));
  const sqliteFile = join(dir, "state.sqlite");
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateFile: join(dir, "state.json"),
    sqliteFile,
    persistenceBackend: "sqlite",
    staleReaperEnabled: false,
    edgeSecret: "test-edge-secret",
    rateLimitMaxRequests: 1000,
    workerRateLimitMaxRequests: 1000,
  });
  try {
    const db = new DatabaseSync(sqliteFile);
    try {
      db.prepare(
        `INSERT INTO broker_workers (node_id, role, last_seen_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "worker-invalid",
        "analyst",
        "2026-04-27T00:00:00.000Z",
        "2026-04-27T00:00:00.000Z",
        JSON.stringify({
          nodeId: "worker-invalid",
          role: "analyst",
          createdAt: "2026-04-27T00:00:00.000Z",
          updatedAt: "2026-04-27T00:00:00.000Z",
          lastSeenAt: "2026-04-27T00:00:00.000Z",
        }),
      );
      db.prepare(
        `INSERT INTO broker_tasks
          (id, status, intent, target_node_id, assigned_worker_id, task_origin, updated_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "task-invalid",
        "queued",
        "verify",
        "workerepsilon",
        "workerepsilon",
        "operator",
        "2026-04-27T00:00:00.000Z",
        JSON.stringify({
          id: "task-invalid",
          intent: "verify",
          requester: { id: "brokeralpha", kind: "node", role: "operator" },
          target: { id: "workerepsilon", kind: "node", role: "analyst" },
          workspace: { id: "openclaw-ops", kind: "filesystem", nodeId: "workerepsilon" },
          status: "queued",
          targetNodeId: "workerepsilon",
          assignedWorkerId: "workerepsilon",
          payload: {},
          createdAt: "2026-04-27T00:00:00.000Z",
          updatedAt: "2026-04-27T00:00:00.000Z",
          taskOrigin: "operator",
        }),
      );
    } finally {
      db.close();
    }

    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const expectedInvalidRows = [
      {
        table: "broker_tasks",
        primaryKey: "task-invalid",
        schemaError: "Invalid input: expected string, received undefined",
        count: 1,
      },
      {
        table: "broker_workers",
        primaryKey: "worker-invalid",
        schemaError: "Invalid input: expected object, received undefined",
        count: 1,
      },
    ];
    const health = await (await fetch(`http://127.0.0.1:${address.port}/health`, { headers: { "x-a2a-edge-secret": "test-edge-secret" } })).json();
    assert.deepEqual(health.persistence.hotEntityDiagnostics.invalidRows, expectedInvalidRows);

    const dashboard = await (await fetch(`http://127.0.0.1:${address.port}/dashboard`, { headers: { "x-a2a-edge-secret": "test-edge-secret" } })).json();
    assert.deepEqual(dashboard.hotEntityDiagnostics.invalidRows, expectedInvalidRows);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reports SQLite persistence metadata when SQLite backend is enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-server-"));
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateFile: join(dir, "state.json"),
    sqliteFile: join(dir, "state.sqlite"),
    persistenceBackend: "sqlite",
    staleReaperEnabled: false,
  });
  try {
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/health`, { headers: { "x-a2a-edge-secret": "test-edge-secret" } });
    assert.equal(res.status, 200);
    const health = await res.json();
    assert.equal(health.persistence.kind, "sqlite");
    assert.equal(health.persistence.dbFile, join(dir, "state.sqlite"));
    assert.equal(health.persistence.stateVersion, 8);
    assert.equal(health.persistence.schemaVersion, 13);
    assert.equal(health.persistence.journalMode, "wal");
    assert.deepEqual(health.persistence.hotEntityTables, [
      "broker_exchanges",
      "broker_exchange_messages",
      "broker_proposals",
      "broker_artifacts",
      "broker_validations",
      "broker_tasks",
      "broker_tombstones",
      "broker_workers",
      "broker_audit_events",
      "broker_terminal_outbox",
    ]);
    assert.deepEqual(health.persistence.hotEntityHintTables, health.persistence.hotEntityTables);
    assert.deepEqual(health.persistence.hotEntityHintCoverage, {
      ok: true,
      supportedTables: health.persistence.hotEntityTables,
      missingTables: [],
      supportedCount: 10,
      totalCount: 10,
    });
    assert.deepEqual(health.persistence.hotTableRuntimeLoadLimits, {
      terminalTasks: 2000,
      auditEvents: 5000,
      terminalOutboxEvents: 1000,
    });
    assert.deepEqual(health.persistence.hotTableLoadMetrics.tables["broker_tasks"].runtimeLoad, {
      limit: 2000,
      loadedCount: 0,
      skippedCount: 0,
      activeCount: 0,
      terminalCount: 0,
    });
    assert.deepEqual(health.auditDiagnostics, {
      total: 0,
      heartbeat: 0,
      heartbeatRatio: 0,
      workerHeartbeat: 0,
      workerHeartbeatRatio: 0,
      taskHeartbeat: 0,
      taskHeartbeatRatio: 0,
      recentWindowMs: 600_000,
      recentTotal: 0,
      recentHeartbeat: 0,
      recentHeartbeatRatio: 0,
      recentWorkerHeartbeat: 0,
      recentWorkerHeartbeatRatio: 0,
      recentTaskHeartbeat: 0,
      recentTaskHeartbeatRatio: 0,
      warnings: [],
    });
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health p99 stays under 500ms with SQLite cache over 50 requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-health-p99-"));
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateFile: join(dir, "state.json"),
    sqliteFile: join(dir, "state.sqlite"),
    persistenceBackend: "sqlite",
    staleReaperEnabled: false,
    edgeSecret: "test-edge-secret",
    rateLimitMaxRequests: 1000,
    workerRateLimitMaxRequests: 1000,
  });
  try {
    // Pre-seed a small realistic workload so COUNT / mirror status paths are exercised.
    for (let i = 0; i < 20; i++) {
      runtime.broker.registerWorker({
        nodeId: `worker-p99-${i}`,
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: [],
          environments: [],
        },
      });
      runtime.broker.createTask({
        intent: "analyze",
        requester: { id: `req-${i}`, kind: "node", role: "hub" },
        target: { id: `worker-p99-${i}`, kind: "node", role: "analyst" },
      });
    }

    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const latencies: number[] = [];
    let cachedResponses = 0;
    let uncachedResponses = 0;

    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      const res = await fetch(`${baseUrl}/health`, { headers: { "x-a2a-edge-secret": "test-edge-secret" } });
      const elapsed = performance.now() - start;
      assert.equal(res.status, 200);
      const body = await res.json();
      latencies.push(elapsed);
      assert.equal(body.ok, true);
      assert.notEqual(body.service, undefined);
      if (body.timing && body.timing.fromCache) {
        cachedResponses++;
      } else {
        uncachedResponses++;
      }
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    // The first request is always uncached (cold); verify cache kicks in.
    assert.ok(cachedResponses > 0, `expected some cached responses, got cached=${cachedResponses} uncached=${uncachedResponses}`);

    // Diagnostics cache should keep p99 comfortably under 500ms.
    assert.ok(
      p99 < 500,
      `p99 latency ${p99.toFixed(1)}ms exceeds 500ms threshold (p50=${p50.toFixed(1)}ms, p95=${p95.toFixed(1)}ms)`,
    );
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /audit from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-audit-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    auditEvents: [
      {
        id: "audit-from-sqlite",
        actorId: "operator-a",
        action: "task.started",
        targetType: "task",
        targetId: "task-a",
        proposalId: "proposal-a",
        createdAt: "2026-04-27T00:00:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listAuditEvents = (() => {
      throw new Error("/audit should use SQLite hot read path");
    }) as typeof runtime.broker.listAuditEvents;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(
      `http://127.0.0.1:${address.port}/audit?action=task.started&targetId=task-a&proposalId=proposal-a&actorId=operator-a`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, snapshot.auditEvents);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /tasks from SQLite hot tables for supported filters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-tasks-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    tasks: [
      {
        id: "task-from-sqlite",
        intent: "chat",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        payload: { source: "sqlite-hot-table" },
        status: "queued",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        taskOrigin: "api",
      },
      {
        id: "task-from-sqlite-2",
        intent: "chat",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        payload: { source: "sqlite-hot-table" },
        status: "queued",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-26T00:00:00.000Z",
        taskOrigin: "api",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listTasks = (() => {
      throw new Error("/tasks should use SQLite hot read path for supported filters");
    }) as typeof runtime.broker.listTasks;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(
      `http://127.0.0.1:${address.port}/tasks?detail=full&status=queued&assignedWorkerId=worker-a&targetNodeId=worker-a&intent=chat&taskOrigin=api&limit=1`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.limit, 1);
    assert.deepEqual(body.items, [snapshot.tasks[0]]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server hides SQLite active task rows that are absent from the live broker mutation map by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-stale-active-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    tasks: [
      {
        id: "stale-queued-row",
        intent: "chat",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        payload: { source: "sqlite-hot-table-stale" },
        status: "queued",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        taskOrigin: "api",
      },
      {
        id: "live-queued-row",
        intent: "chat",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        payload: { source: "sqlite-hot-table-live" },
        status: "queued",
        createdAt: "2026-04-27T00:01:00.000Z",
        updatedAt: "2026-04-27T00:01:00.000Z",
        taskOrigin: "api",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  const originalGetTask = runtime.broker.getTask.bind(runtime.broker);
  try {
    runtime.broker.getTask = ((taskId: string) => taskId === "stale-queued-row" ? null : originalGetTask(taskId)) as typeof runtime.broker.getTask;
    runtime.broker.listTasks = (() => {
      throw new Error("/tasks should keep using SQLite hot read path");
    }) as typeof runtime.broker.listTasks;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind test server");

    const base = `http://127.0.0.1:${address.port}`;
    const defaultRes = await fetch(`${base}/tasks?detail=full&status=queued&assignedWorkerId=worker-a`);
    assert.equal(defaultRes.status, 200);
    const defaultBody = await defaultRes.json();
    assert.deepEqual(defaultBody.items.map((task: { id: string }) => task.id), ["live-queued-row"]);

    const summaryRes = await fetch(`${base}/tasks?status=queued&assignedWorkerId=worker-a`);
    assert.equal(summaryRes.status, 200);
    const summaryBody = await summaryRes.json();
    assert.deepEqual(summaryBody.items.map((task: { id: string }) => task.id), ["live-queued-row"]);

    const diagnosticRes = await fetch(`${base}/tasks?detail=full&status=queued&assignedWorkerId=worker-a&include=stale_read_path`);
    assert.equal(diagnosticRes.status, 200);
    const diagnosticBody = await diagnosticRes.json();
    assert.deepEqual(diagnosticBody.items.map((task: { id: string }) => task.id), ["live-queued-row", "stale-queued-row"]);

    assert.equal((await fetch(`${base}/tasks/stale-queued-row`)).status, 404);
    const staleDetailRes = await fetch(`${base}/tasks/stale-queued-row?include=stale_read_path`);
    assert.equal(staleDetailRes.status, 200);
    const staleDetail = await staleDetailRes.json();
    assert.equal(staleDetail.id, "stale-queued-row");
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server projects default /tasks summaries from SQLite without loading full task payloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-task-items-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    tasks: [
      {
        id: "task-summary-from-sqlite",
        intent: "chat",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        payload: { rawLog: "x".repeat(20_000) },
        result: { summary: "short summary", artifactIds: ["artifact-1"] },
        status: "succeeded",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:02:00.000Z",
        completedAt: "2026-04-27T00:02:00.000Z",
        taskOrigin: "api",
      },
      {
        id: "task-summary-from-sqlite-2",
        intent: "chat",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        payload: { rawLog: "y".repeat(20_000) },
        status: "succeeded",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-26T00:00:00.000Z",
        taskOrigin: "api",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listTasks = (() => {
      throw new Error("/tasks summaries should use SQLite list-item projection");
    }) as typeof runtime.broker.listTasks;
    store.readHotTasks = (() => {
      throw new Error("/tasks summaries should not read full SQLite task payloads");
    }) as typeof store.readHotTasks;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(
      `http://127.0.0.1:${address.port}/tasks?status=succeeded&assignedWorkerId=worker-a&targetNodeId=worker-a&intent=chat&taskOrigin=api&limit=1`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.limit, 1);
    assert.equal(body.count, 1);
    assert.deepEqual(body.items, [{
      id: "task-summary-from-sqlite",
      intent: "chat",
      status: "succeeded",
      targetNodeId: "worker-a",
      requester: { id: "requester", kind: "session", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      taskOrigin: "api",
      artifactIds: ["artifact-1"],
      resultSummary: "short summary",
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
      completedAt: "2026-04-27T00:02:00.000Z",
    }]);
    assert.equal("payload" in body.items[0], false);
    assert.equal("result" in body.items[0], false);
    assert.ok(JSON.stringify(body).length < 2_000);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server can hydrate broker runtime from SQLite hot-table load source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-hot-load-"));
  const sqliteFile = join(dir, "state.sqlite");
  const hotTask: BrokerSnapshot["tasks"][number] = {
    id: "task-hot-load-source",
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: { source: "sqlite-hot-load-source" },
    status: "queued",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    taskOrigin: "api",
  };
  const seedStore = new SqliteBrokerStateStore(sqliteFile);
  seedStore.upsertHotTasks([hotTask]);
  seedStore.close();

  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    persistenceBackend: "sqlite",
    sqliteFile,
    sqliteLoadSource: "hot-tables",
    stateStore: undefined,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    const loadedTask = runtime.broker.getTask("task-hot-load-source");
    assert.equal(runtime.config.sqliteLoadSource, "hot-tables");
    assert.equal(loadedTask?.id, hotTask.id);
    assert.equal(loadedTask?.status, "queued");
    assert.equal(loadedTask?.payload.source, "sqlite-hot-load-source");
  } finally {
    runtime.stopStaleReaper();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server exposes broker cleanup dry-run plan for SQLite hot tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-cleanup-plan-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const oldTask: BrokerSnapshot["tasks"][number] = {
    id: "cleanup-api-old-task",
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: "worker-cleanup", kind: "node", role: "analyst" },
    targetNodeId: "worker-cleanup",
    assignedWorkerId: "worker-cleanup",
    payload: {},
    status: "failed",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    completedAt: "2026-04-27T00:00:00.000Z",
    taskOrigin: "api",
  };
  store.save({ ...emptySnapshot(), tasks: [oldTask] });
  const server = await startTestServer({ stateStore: store });
  try {
    const res = await fetch(
      `${server.baseUrl}/operator/cleanup/plan?now_ms=${Date.parse("2026-04-27T01:00:00.000Z")}&task_retention_ms=1800000&max_terminal_tasks=0`,
      { headers: { "x-a2a-requester-id": "operator-a", "x-a2a-requester-role": "operator" } },
    );
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.equal(plan.kind, "broker.cleanup.plan");
    assert.equal(plan.mode, "dry-run");
    assert.deepEqual(plan.tables.find((table: { table: string }) => table.table === "broker_tasks").pruneIds, [oldTask.id]);
    assert.equal(store.readHotTasks().length, 1, "dry-run API must not prune rows");
  } finally {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server cleanup execute keeps snapshot-mode SQLite cleanup durable across reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-cleanup-snapshot-mode-"));
  const dbFile = join(dir, "state.sqlite");
  const store = new SqliteBrokerStateStore(dbFile);
  const oldTask: BrokerSnapshot["tasks"][number] = {
    id: "cleanup-snapshot-old-task",
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: "worker-cleanup", kind: "node", role: "analyst" },
    targetNodeId: "worker-cleanup",
    assignedWorkerId: "worker-cleanup",
    payload: { large: "old" },
    status: "failed",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    completedAt: "2026-04-27T00:00:00.000Z",
    taskOrigin: "api",
  };
  const retainedTask: BrokerSnapshot["tasks"][number] = {
    ...oldTask,
    id: "cleanup-snapshot-retained-task",
    payload: { keep: true },
    updatedAt: "2026-04-27T01:00:00.000Z",
    completedAt: "2026-04-27T01:00:00.000Z",
  };
  store.save({ ...emptySnapshot(), tasks: [oldTask, retainedTask] });
  const server = await startTestServer({ stateStore: store });
  try {
    const planRes = await fetch(
      `${server.baseUrl}/operator/cleanup/plan?now_ms=${Date.parse("2026-04-27T02:00:00.000Z")}&task_retention_ms=1800000&max_terminal_tasks=1`,
      { headers: { "x-a2a-requester-id": "operator-a", "x-a2a-requester-role": "operator" } },
    );
    assert.equal(planRes.status, 200);
    const plan = await planRes.json();
    assert.deepEqual(plan.tables.find((table: { table: string }) => table.table === "broker_tasks").pruneIds, [oldTask.id]);

    const executeRes = await fetch(`${server.baseUrl}/operator/cleanup/execute`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "operator-a", "x-a2a-requester-role": "operator" }),
      body: JSON.stringify({
        nowMs: Date.parse("2026-04-27T02:00:00.000Z"),
        taskRetentionMs: 1_800_000,
        maxTerminalTasks: 1,
        approvalToken: plan.planId,
        confirmation: "APPLY_BROKER_CLEANUP_PLAN",
        backupProof: "test-backup-proof",
      }),
    });
    assert.equal(executeRes.status, 200);
    const executed = await executeRes.json();
    assert.equal(executed.ok, true);
    assert.equal(executed.result.results.find((row: { table: string }) => row.table === "broker_tasks").prunedCount, 1);
    assert.deepEqual(store.readHotTasks().map((task) => task.id), [retainedTask.id]);
  } finally {
    await server.close();
    store.close();
  }

  const reloaded = new SqliteBrokerStateStore(dbFile);
  try {
    const snapshot = reloaded.load();
    assert.deepEqual(snapshot.tasks.map((task) => task.id), [retainedTask.id]);
    assert.equal(
      snapshot.auditEvents.filter((event) => event.action === "broker.cleanup.applied").length,
      1,
      "cleanup audit event must survive snapshot-mode reload",
    );
  } finally {
    reloaded.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server falls back to broker task reads for unsupported SQLite task filters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-tasks-fallback-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save(emptySnapshot());
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listTasks = ((filters) => [
      {
        id: `fallback-${filters?.exchangeId ?? "unknown"}`,
        intent: "chat",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-fallback", kind: "node", role: "analyst" },
        targetNodeId: "worker-fallback",
        payload: {},
        status: "queued",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
    ]) as typeof runtime.broker.listTasks;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/tasks?exchangeId=exchange-fallback`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items[0].id, "fallback-exchange-fallback");
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /tasks/:id from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-task-detail-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    tasks: [
      {
        id: "task-detail-from-sqlite",
        intent: "chat",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        payload: { source: "sqlite-task-detail" },
        status: "running",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getTask = (() => {
      throw new Error("/tasks/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getTask;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/tasks/task-detail-from-sqlite`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, snapshot.tasks[0]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server returns 404 for missing /tasks/:id from SQLite hot tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-task-detail-missing-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save(emptySnapshot());
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getTask = (() => {
      throw new Error("missing /tasks/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getTask;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/tasks/missing-task`);
    assert.equal(res.status, 404);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads task diagnostics tombstones from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-task-diagnostics-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const task: BrokerSnapshot["tasks"][number] = {
    id: "task-diagnostics-from-sqlite",
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    payload: {},
    status: "failed",
    error: { code: "handler_error", message: "old broker tombstone" },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:02:00.000Z",
    completedAt: "2026-04-27T00:02:00.000Z",
  };
  store.save({
    ...emptySnapshot(),
    tasks: [task],
    tombstones: [
      {
        taskId: task.id,
        terminalStatus: "failed",
        tombstoneReason: "failed",
        durationMs: 120_000,
        requeueCount: 0,
        error: { code: "handler_error", message: "old broker tombstone" },
        tombstonedAt: "2026-04-27T00:02:00.000Z",
      },
    ],
  });
  store.upsertHotTombstones([
    {
      taskId: task.id,
      terminalStatus: "failed",
      tombstoneReason: "dead_lettered",
      durationMs: 130_000,
      requeueCount: 5,
      error: { code: "exceeded_requeue_limit", message: "hot tombstone from sqlite" },
      tombstonedAt: "2026-04-27T00:03:00.000Z",
    },
  ]);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getTaskDiagnostics = (() => {
      throw new Error("task diagnostics should use SQLite hot read path");
    }) as typeof runtime.broker.getTaskDiagnostics;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const detailRes = await fetch(`http://127.0.0.1:${address.port}/tasks/${task.id}/diagnostics`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.tombstone.tombstoneReason, "dead_lettered");
    assert.equal(detail.tombstone.error.message, "hot tombstone from sqlite");
    assert.equal(detail.brokerHints.tombstoneReason, "dead_lettered");
    assert.equal(detail.interruption.kind, "dead_lettered");

    const listRes = await fetch(`http://127.0.0.1:${address.port}/tasks/diagnostics`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.items[0].taskId, task.id);
    assert.equal(list.items[0].tombstone.tombstoneReason, "dead_lettered");
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads task diagnostics worker and requeue context from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-task-diagnostics-context-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const now = new Date().toISOString();
  const task: BrokerSnapshot["tasks"][number] = {
    id: "task-diagnostics-context-from-sqlite",
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: {},
    status: "running",
    requeueCount: 1,
    createdAt: now,
    updatedAt: now,
    claimedAt: now,
    lastHeartbeatAt: now,
  };
  const snapshotWorker: BrokerSnapshot["workers"][number] = {
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
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
  store.save({
    ...emptySnapshot(),
    tasks: [task],
    workers: [snapshotWorker],
    auditEvents: [
      {
        id: "audit-snapshot-requeue",
        actorId: "broker",
        action: "task.requeued",
        targetType: "task",
        targetId: task.id,
        note: "snapshot requeue context",
        createdAt: "2026-04-27T00:01:00.000Z",
      },
    ],
  });
  store.upsertHotWorkers([
    {
      ...snapshotWorker,
      updatedAt: "2000-01-01T00:00:00.000Z",
      lastSeenAt: "2000-01-01T00:00:00.000Z",
    },
  ]);
  store.upsertHotAuditEvents([
    {
      id: "audit-hot-requeue",
      actorId: "broker",
      action: "task.requeued",
      targetType: "task",
      targetId: task.id,
      note: "hot sqlite requeue context",
      createdAt: "2026-04-27T00:02:00.000Z",
    },
  ]);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getTaskDiagnostics = (() => {
      throw new Error("task diagnostics should use SQLite hot read path");
    }) as typeof runtime.broker.getTaskDiagnostics;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const detailRes = await fetch(`http://127.0.0.1:${address.port}/tasks/${task.id}/diagnostics`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.brokerHints.staleWorker, true);
    assert.equal(detail.brokerHints.workerLastSeenAt, "2000-01-01T00:00:00.000Z");
    assert.equal(detail.brokerHints.lastRequeueReason, "hot sqlite requeue context");
    assert.equal(detail.interruption.kind, "stale_worker");

    const listRes = await fetch(`http://127.0.0.1:${address.port}/tasks/diagnostics`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.items[0].brokerHints.staleWorker, true);
    assert.equal(list.items[0].brokerHints.workerLastSeenAt, "2000-01-01T00:00:00.000Z");
    assert.equal(list.items[0].brokerHints.lastRequeueReason, "hot sqlite requeue context");
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /workers from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-workers-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const lastSeenAt = new Date().toISOString();
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    workers: [
      {
        nodeId: "worker-from-sqlite",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
          providerCapabilities: [
            {
              providerId: "xai",
              modelFamily: "grok",
              modelId: "grok-4.2",
              routeKind: "subscription",
              availability: "canary_passed",
              evidenceId: "non-secret-evidence-id",
            },
          ],
        },
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        lastSeenAt,
      },
      {
        nodeId: "worker-filtered-out",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["other"],
          environments: ["research"],
        },
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        lastSeenAt,
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listWorkerViews = (() => {
      throw new Error("/workers should use SQLite hot read path");
    }) as typeof runtime.broker.listWorkerViews;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/workers?role=analyst&environment=research&workspaceId=test&providerId=openai&modelId=gpt-4`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const { providerCapabilities: _providerCapabilities, ...publicCapabilities } = snapshot.workers[0]!.capabilities;
    assert.equal(JSON.stringify(body).includes("xai"), false);
    assert.equal(JSON.stringify(body).includes("grok"), false);
    assert.deepEqual(body.items, [{
      ...snapshot.workers[0],
      capabilities: publicCapabilities,
      status: "online",
      workerPlane: "online",
      managementPlane: "unknown",
      updateEligible: true,
    }]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /workers/:id from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-worker-detail-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const lastSeenAt = new Date().toISOString();
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    workers: [
      {
        nodeId: "worker-detail-from-sqlite",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        lastSeenAt,
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getWorkerView = (() => {
      throw new Error("/workers/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getWorkerView;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/workers/worker-detail-from-sqlite`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      ...snapshot.workers[0],
      status: "online",
      workerPlane: "online",
      managementPlane: "unknown",
      updateEligible: true,
    });
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite worker heartbeat defaults unchanged liveness persistence off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-worker-heartbeat-default-off-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const server = await startTestServer({
    stateStore: store,
    persistenceBackend: "sqlite",
    edgeSecret: "test-edge-secret",
  });
  const nodeId = "worker-heartbeat-default-off";

  try {
    assert.equal(Number.isFinite(server.runtime.config.workerHeartbeatPersistIntervalMs), false);
    await registerTestWorker(server.baseUrl, nodeId, "analyst", "test-edge-secret");

    const beforeRes = await fetch(`${server.baseUrl}/workers/${nodeId}`, {
      headers: { "x-a2a-edge-secret": "test-edge-secret" },
    });
    assert.equal(beforeRes.status, 200);
    const before = await beforeRes.json() as WorkerRegistrationResponse;

    await new Promise((resolve) => setTimeout(resolve, 10));
    const heartbeatRes = await fetch(`${server.baseUrl}/workers/${nodeId}/heartbeat`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": nodeId,
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(heartbeatRes.status, 200);
    const heartbeat = await heartbeatRes.json() as WorkerRegistrationResponse;
    assert.notEqual(heartbeat.lastSeenAt, before.lastSeenAt);

    const detailRes = await fetch(`${server.baseUrl}/workers/${nodeId}`, {
      headers: { "x-a2a-edge-secret": "test-edge-secret" },
    });
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json() as WorkerRegistrationResponse;
    assert.equal(detail.status, "online");
    assert.equal(
      detail.lastSeenAt,
      before.lastSeenAt,
      "unchanged heartbeat should not synchronously rewrite SQLite read-path liveness by default",
    );
  } finally {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite worker heartbeat can explicitly persist into worker read paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-worker-heartbeat-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const server = await startTestServer({
    stateStore: store,
    persistenceBackend: "sqlite",
    edgeSecret: "test-edge-secret",
    workerHeartbeatPersistIntervalMs: 0,
  });
  const nodeId = "worker-heartbeat-read-path";

  try {
    assert.equal(server.runtime.config.workerHeartbeatPersistIntervalMs, 0);
    await registerTestWorker(server.baseUrl, nodeId, "analyst", "test-edge-secret");

    const beforeRes = await fetch(`${server.baseUrl}/workers/${nodeId}`, {
      headers: { "x-a2a-edge-secret": "test-edge-secret" },
    });
    assert.equal(beforeRes.status, 200);
    const before = await beforeRes.json() as WorkerRegistrationResponse;

    await new Promise((resolve) => setTimeout(resolve, 10));
    const heartbeatRes = await fetch(`${server.baseUrl}/workers/${nodeId}/heartbeat`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": nodeId,
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(heartbeatRes.status, 200);
    const heartbeat = await heartbeatRes.json() as WorkerRegistrationResponse;
    assert.notEqual(heartbeat.lastSeenAt, before.lastSeenAt);

    const detailRes = await fetch(`${server.baseUrl}/workers/${nodeId}`, {
      headers: { "x-a2a-edge-secret": "test-edge-secret" },
    });
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json() as WorkerRegistrationResponse;
    assert.equal(detail.status, "online");
    assert.equal(detail.lastSeenAt, heartbeat.lastSeenAt);

    const listRes = await fetch(`${server.baseUrl}/workers`, {
      headers: { "x-a2a-edge-secret": "test-edge-secret" },
    });
    assert.equal(listRes.status, 200);
    const list = await listRes.json() as { items: WorkerRegistrationResponse[] };
    const listed = list.items.find((worker) => worker.nodeId === nodeId);
    assert.equal(listed?.status, "online");
    assert.equal(listed?.lastSeenAt, heartbeat.lastSeenAt);
  } finally {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server worker heartbeat auth path uses cached workers before hot-table reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-worker-heartbeat-auth-cache-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const server = await startTestServer({
    stateStore: store,
    persistenceBackend: "sqlite",
    edgeSecret: "test-edge-secret",
  });
  const nodeId = "worker-heartbeat-auth-cache";

  try {
    await registerTestWorker(server.baseUrl, nodeId, "analyst", "test-edge-secret");
    server.runtime.broker.getWorker = (() => {
      throw new Error("cached heartbeat auth path should not call repository-backed getWorker");
    }) as typeof server.runtime.broker.getWorker;

    const heartbeatRes = await fetch(`${server.baseUrl}/workers/${nodeId}/heartbeat`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": nodeId,
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({}),
    });

    assert.equal(heartbeatRes.status, 200);
  } finally {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server returns 404 for missing /workers/:id from SQLite hot tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-worker-detail-missing-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save(emptySnapshot());
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getWorkerView = (() => {
      throw new Error("missing /workers/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getWorkerView;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/workers/missing-worker`);
    assert.equal(res.status, 404);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /exchanges from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-exchanges-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    exchanges: [
      {
        id: "exchange-old",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        message: "old exchange",
        maxTurns: 4,
        intent: "chat",
        status: "running",
        rootMessageId: "message-old-root",
        latestMessageId: "message-old-root",
        messageCount: 1,
        lastMessageAt: "2026-04-27T00:00:00.000Z",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
      {
        id: "exchange-new",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-b", kind: "node", role: "analyst" },
        targetNodeId: "worker-b",
        assignedWorkerId: "worker-b",
        message: "new exchange",
        maxTurns: 4,
        intent: "analyze",
        status: "queued",
        rootMessageId: "message-new-root",
        latestMessageId: "message-new-root",
        messageCount: 1,
        lastMessageAt: "2026-04-27T00:01:00.000Z",
        createdAt: "2026-04-27T00:01:00.000Z",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listExchanges = (() => {
      throw new Error("/exchanges should use SQLite hot read path");
    }) as typeof runtime.broker.listExchanges;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/exchanges`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, [snapshot.exchanges[1], snapshot.exchanges[0]]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /exchanges/:id from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-exchange-detail-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    exchanges: [
      {
        id: "exchange-detail-from-sqlite",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        message: "detail exchange",
        maxTurns: 4,
        intent: "chat",
        status: "running",
        rootMessageId: "message-root",
        latestMessageId: "message-root",
        messageCount: 1,
        lastMessageAt: "2026-04-27T00:00:00.000Z",
        activeTaskId: "task-a",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getExchange = (() => {
      throw new Error("/exchanges/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getExchange;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/exchanges/exchange-detail-from-sqlite`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, snapshot.exchanges[0]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server returns 404 for missing /exchanges/:id from SQLite hot tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-exchange-detail-missing-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save(emptySnapshot());
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getExchange = (() => {
      throw new Error("missing /exchanges/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getExchange;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/exchanges/missing-exchange`);
    assert.equal(res.status, 404);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /exchanges/:id/messages from SQLite hot tables with thread filters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-exchange-messages-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    exchanges: [
      {
        id: "exchange-messages-from-sqlite",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        message: "root",
        maxTurns: 4,
        intent: "chat",
        status: "running",
        rootMessageId: "message-root",
        latestMessageId: "message-grandchild",
        messageCount: 4,
        lastMessageAt: "2026-04-27T00:03:00.000Z",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:03:00.000Z",
      },
    ],
    exchangeMessages: [
      {
        id: "message-root",
        exchangeId: "exchange-messages-from-sqlite",
        kind: "root",
        message: "root",
        requester: { id: "requester", kind: "session", role: "hub" },
        targetNodeId: "worker-a",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
      {
        id: "message-child",
        exchangeId: "exchange-messages-from-sqlite",
        kind: "thread",
        message: "child",
        actor: { id: "worker-a", kind: "node", role: "analyst" },
        parentMessageId: "message-root",
        createdAt: "2026-04-27T00:01:00.000Z",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
      {
        id: "message-sibling",
        exchangeId: "exchange-messages-from-sqlite",
        kind: "thread",
        message: "sibling",
        actor: { id: "requester", kind: "session", role: "hub" },
        parentMessageId: "message-root",
        createdAt: "2026-04-27T00:02:00.000Z",
        updatedAt: "2026-04-27T00:02:00.000Z",
      },
      {
        id: "message-grandchild",
        exchangeId: "exchange-messages-from-sqlite",
        kind: "thread",
        message: "grandchild",
        actor: { id: "worker-a", kind: "node", role: "analyst" },
        parentMessageId: "message-child",
        createdAt: "2026-04-27T00:03:00.000Z",
        updatedAt: "2026-04-27T00:03:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listExchangeMessages = (() => {
      throw new Error("/exchanges/:id/messages should use SQLite hot read path");
    }) as typeof runtime.broker.listExchangeMessages;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const baseUrl = `http://127.0.0.1:${address.port}/exchanges/exchange-messages-from-sqlite/messages`;
    const allRes = await fetch(baseUrl);
    assert.equal(allRes.status, 200);
    const allBody = await allRes.json();
    assert.deepEqual(allBody.items.map((message: { id: string }) => message.id), [
      "message-root",
      "message-child",
      "message-sibling",
      "message-grandchild",
    ]);
    assert.deepEqual(allBody.threads[0].replies.map((message: { id: string }) => message.id), [
      "message-child",
      "message-sibling",
    ]);
    assert.deepEqual(allBody.threads[0].replies[0].replies.map((message: { id: string }) => message.id), [
      "message-grandchild",
    ]);

    const childRes = await fetch(`${baseUrl}?parentMessageId=message-root`);
    assert.equal(childRes.status, 200);
    const childBody = await childRes.json();
    assert.deepEqual(childBody.items.map((message: { id: string }) => message.id), [
      "message-child",
      "message-sibling",
    ]);
    assert.equal(childBody.parentMessageId, "message-root");

    const descendantRes = await fetch(`${baseUrl}?parentMessageId=message-child&includeDescendants=true`);
    assert.equal(descendantRes.status, 200);
    const descendantBody = await descendantRes.json();
    assert.deepEqual(descendantBody.items.map((message: { id: string }) => message.id), [
      "message-child",
      "message-grandchild",
    ]);
    assert.deepEqual(descendantBody.threads[0].replies.map((message: { id: string }) => message.id), [
      "message-grandchild",
    ]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server preserves missing exchange message 404s on SQLite hot read path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-exchange-messages-missing-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save({
    ...emptySnapshot(),
    exchanges: [
      {
        id: "exchange-without-parent",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        message: "root",
        maxTurns: 4,
        intent: "chat",
        status: "running",
        rootMessageId: "message-root",
        latestMessageId: "message-root",
        messageCount: 0,
        lastMessageAt: "2026-04-27T00:00:00.000Z",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
    ],
  });
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listExchangeMessages = (() => {
      throw new Error("missing parent lookup should use SQLite hot read path");
    }) as typeof runtime.broker.listExchangeMessages;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(
      `http://127.0.0.1:${address.port}/exchanges/exchange-without-parent/messages?parentMessageId=missing-message`,
    );
    assert.equal(res.status, 404);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /proposals from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-proposals-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    proposals: [
      {
        id: "proposal-old-filtered-out",
        source: { id: "source-a", kind: "node", role: "analyst" },
        target: { id: "worker-a", kind: "node", role: "operator" },
        sourceNodeId: "source-a",
        targetNodeId: "worker-a",
        kind: "patch",
        summary: "old",
        workspace: { nodeId: "worker-a", workspaceId: "test" },
        artifactIds: [],
        status: "rejected",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
      {
        id: "proposal-from-sqlite",
        source: { id: "source-a", kind: "node", role: "analyst" },
        target: { id: "worker-b", kind: "node", role: "operator" },
        sourceNodeId: "source-a",
        targetNodeId: "worker-b",
        kind: "patch",
        summary: "sqlite proposal",
        workspace: { nodeId: "worker-b", workspaceId: "test" },
        artifactIds: [],
        status: "submitted",
        createdAt: "2026-04-27T00:01:00.000Z",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listProposals = (() => {
      throw new Error("/proposals should use SQLite hot read path");
    }) as typeof runtime.broker.listProposals;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(
      `http://127.0.0.1:${address.port}/proposals?status=submitted&sourceNodeId=source-a&targetNodeId=worker-b&kind=patch`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, [
      {
        id: "proposal-from-sqlite",
        sourceNodeId: "source-a",
        targetNodeId: "worker-b",
        kind: "patch",
        summary: "sqlite proposal",
        status: "submitted",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
    ]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /proposals/:id details from SQLite hot paths and artifact/validation repository seams", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-proposal-detail-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    proposals: [
      {
        id: "proposal-detail-from-sqlite",
        source: { id: "source-a", kind: "node", role: "analyst" },
        target: { id: "worker-a", kind: "node", role: "operator" },
        sourceNodeId: "source-a",
        targetNodeId: "worker-a",
        kind: "params",
        summary: "detail proposal",
        workspace: { nodeId: "worker-a", workspaceId: "test" },
        parameterPayload: { leverage: 1 },
        artifactIds: ["artifact-a"],
        status: "validated",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
    ],
    artifacts: [
      {
        id: "artifact-a",
        proposalId: "proposal-detail-from-sqlite",
        kind: "report",
        uri: "memory://artifact-a",
        createdAt: "2026-04-27T00:02:00.000Z",
      },
    ],
    validations: [
      {
        id: "validation-a",
        proposalId: "proposal-detail-from-sqlite",
        nodeId: "validator-a",
        kind: "smoke",
        verdict: "pass",
        metrics: {},
        artifactIds: [],
        createdAt: "2026-04-27T00:03:00.000Z",
      },
    ],
    auditEvents: [
      {
        id: "audit-a",
        actorId: "source-a",
        action: "proposal.created",
        targetType: "proposal",
        targetId: "proposal-detail-from-sqlite",
        proposalId: "proposal-detail-from-sqlite",
        createdAt: "2026-04-27T00:04:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getProposalDetails = (() => {
      throw new Error("/proposals/:id should use SQLite hot read path for proposal details");
    }) as typeof runtime.broker.getProposalDetails;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/proposals/proposal-detail-from-sqlite`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.proposal, snapshot.proposals[0]);
    assert.deepEqual(body.artifacts, snapshot.artifacts);
    assert.deepEqual(body.validations, snapshot.validations);
    assert.deepEqual(body.audit, snapshot.auditEvents);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server returns 404 for missing /proposals/:id from SQLite hot tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-proposal-detail-missing-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save(emptySnapshot());
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getProposalDetails = (() => {
      throw new Error("missing /proposals/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getProposalDetails;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/proposals/missing-proposal`);
    assert.equal(res.status, 404);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
