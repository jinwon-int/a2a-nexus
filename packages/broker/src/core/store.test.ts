import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";

import {
  CURRENT_BROKER_STATE_VERSION,
  JsonFileBrokerStateStore,
  SqliteArtifactRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteExchangeMessageRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
  buildHotEntityHintCoverage,
  emptySnapshot,
  serializeBrokerSnapshot,
  writeBrokerSnapshotFile,
  type BrokerSnapshot,
} from "./store.js";
import {
  withTempFile, readSqliteCount, makeWorker, makeExchange, makeExchangeMessage,
  makeProposal, makeArtifact, makeValidation, makeTask, makeTombstone,
  makeAuditEvent, makeTerminalOutboxEvent,
} from "./store-test-helpers.js";

test("JsonFileBrokerStateStore loads backward-compatible empty objects", () => {
  const temp = withTempFile("state.json");
  try {
    writeFileSync(temp.filePath, "{}", "utf8");

    const store = new JsonFileBrokerStateStore(temp.filePath);
    assert.deepEqual(store.load(), emptySnapshot());
  } finally {
    temp.cleanup();
  }
});

test("JsonFileBrokerStateStore loads snapshots with legacy and object via metadata", () => {
  const temp = withTempFile("legacy-via-state.json");
  try {
    const task = makeTask("task-legacy-via", "queued", "worker-a");
    const message = makeExchangeMessage("message-legacy-via", "exchange-1", "root");
    writeFileSync(
      temp.filePath,
      JSON.stringify({
        ...emptySnapshot(),
        tasks: [
          {
            ...task,
            via: { transport: "openclaw", channel: "telegram", sessionId: "session-a", traceId: "trace-a" },
          },
          {
            ...makeTask("task-string-via", "queued", "worker-a"),
            via: "openclaw",
          },
        ],
        exchangeMessages: [
          {
            ...message,
            via: { transport: "openclaw", channel: "telegram", traceId: "message-trace" },
          },
          {
            ...makeExchangeMessage("message-string-via", "exchange-1", "thread"),
            via: "openclaw",
          },
        ],
      }),
      "utf8",
    );

    const loaded = new JsonFileBrokerStateStore(temp.filePath).load();
    assert.deepEqual(loaded.tasks[0]?.via, {
      transport: "openclaw",
      channel: "telegram",
      sessionId: "session-a",
      traceId: "trace-a",
    });
    assert.deepEqual(loaded.tasks[1]?.via, { transport: "openclaw" });
    assert.deepEqual(loaded.exchangeMessages[0]?.via, {
      transport: "openclaw",
      channel: "telegram",
      traceId: "message-trace",
    });
    assert.deepEqual(loaded.exchangeMessages[1]?.via, { transport: "openclaw" });
  } finally {
    temp.cleanup();
  }
});

test("JsonFileBrokerStateStore rejects oversized snapshots", () => {
  const temp = withTempFile("large-state.json");
  try {
    writeFileSync(
      temp.filePath,
      JSON.stringify({
        version: CURRENT_BROKER_STATE_VERSION,
        exchanges: [],
        exchangeMessages: [],
        proposals: [],
        artifacts: [],
        validations: [],
        auditEvents: [],
        workers: [],
        tasks: [],
        padding: "x".repeat(1_024),
      }),
      "utf8",
    );

    const store = new JsonFileBrokerStateStore(temp.filePath, { maxBytes: 128 });
    assert.throws(() => store.load(), /broker snapshot exceeds max size/);
  } finally {
    temp.cleanup();
  }
});

test("JsonFileBrokerStateStore rejects malformed snapshot entries", () => {
  const temp = withTempFile("invalid-state.json");
  try {
    writeFileSync(
      temp.filePath,
      JSON.stringify({
        version: CURRENT_BROKER_STATE_VERSION,
        exchanges: [{ id: 123 }],
      }),
      "utf8",
    );

    const store = new JsonFileBrokerStateStore(temp.filePath);
    assert.throws(() => store.load(), /invalid broker snapshot/);
  } finally {
    temp.cleanup();
  }
});

test("broker snapshot export helpers write canonical versioned JSON atomically", () => {
  const temp = withTempFile("export/state.json");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      version: 1,
      tasks: [makeTask("task-export", "queued", "worker-a")],
    };

    const serialized = serializeBrokerSnapshot(snapshot);
    assert.equal(JSON.parse(serialized).version, CURRENT_BROKER_STATE_VERSION);

    writeBrokerSnapshotFile(temp.filePath, snapshot);
    const exported = JSON.parse(readFileSync(temp.filePath, "utf8"));
    assert.equal(exported.version, CURRENT_BROKER_STATE_VERSION);
    assert.deepEqual(exported.tasks.map((task: BrokerSnapshot["tasks"][number]) => task.id), ["task-export"]);
  } finally {
    temp.cleanup();
  }
});

test("JsonFileBrokerStateStore recovers from corrupt primary snapshot using one-generation backup", () => {
  const temp = withTempFile("recover/state.json");
  try {
    const first: BrokerSnapshot = { ...emptySnapshot(), tasks: [makeTask("task-before-crash", "queued", "worker-a")] };
    const second: BrokerSnapshot = { ...emptySnapshot(), tasks: [makeTask("task-after-crash", "queued", "worker-a")] };
    const store = new JsonFileBrokerStateStore(temp.filePath);

    store.save(first);
    store.save(second);
    assert.ok(existsSync(`${temp.filePath}.bak`), "second save should retain a one-generation backup");

    writeFileSync(temp.filePath, "{not-json", "utf8");
    const recovered = new JsonFileBrokerStateStore(temp.filePath).load();
    assert.deepEqual(recovered.tasks.map((task) => task.id), ["task-before-crash"]);
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore atomically consumes a live approval key once across restarts", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const first = new SqliteBrokerStateStore(temp.filePath);
    assert.equal(first.consumeLiveApprovalKey("live-approval:scope-1", "2026-07-10T19:50:00.000Z"), true);
    assert.equal(first.consumeLiveApprovalKey("live-approval:scope-1", "2026-07-10T19:50:01.000Z"), false);
    assert.throws(() => first.consumeLiveApprovalKey(" ", "2026-07-10T19:50:01.000Z"), /1\.\.512/);
    assert.throws(() => first.consumeLiveApprovalKey("live-approval:scope-3", "2026-07-10"), /canonical ISO/);
    first.close();

    const restarted = new SqliteBrokerStateStore(temp.filePath);
    assert.equal(restarted.consumeLiveApprovalKey("live-approval:scope-1", "2026-07-10T19:50:02.000Z"), false);
    assert.equal(restarted.consumeLiveApprovalKey("live-approval:scope-2", "2026-07-10T19:50:03.000Z"), true);
    restarted.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore saves and reloads snapshots with WAL metadata", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      exchanges: [makeExchange("exchange-1", "worker-a")],
      exchangeMessages: [makeExchangeMessage("message-1", "exchange-1", "root")],
      proposals: [makeProposal("proposal-1", "submitted", "worker-a")],
      artifacts: [makeArtifact("artifact-1", "proposal-1")],
      validations: [makeValidation("validation-1", "proposal-1")],
      workers: [
        {
          nodeId: "worker-a",
          role: "analyst",
          capabilities: {
            canAnalyze: true,
            canBackfill: false,
            canPatchWorkspace: false,
            canPromoteLive: false,
            workspaceIds: ["smoke"],
            environments: ["research"],
          },
          createdAt: "2026-04-27T00:00:00.000Z",
          updatedAt: "2026-04-27T00:00:00.000Z",
          lastSeenAt: "2026-04-27T00:00:00.000Z",
        },
      ],
      auditEvents: [
        {
          id: "audit-1",
          actorId: "operator-a",
          action: "task.created",
          targetType: "task",
          targetId: "task-1",
          createdAt: "2026-04-27T00:00:00.000Z",
        },
      ],
      tasks: [
        {
          id: "task-1",
          intent: "chat",
          requester: { id: "requester", kind: "session", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          message: "inspect me",
          targetNodeId: "worker-a",
          assignedWorkerId: "worker-a",
          payload: { correlationId: "corr-1" },
          status: "queued",
          createdAt: "2026-04-27T00:00:00.000Z",
          updatedAt: "2026-04-27T00:00:00.000Z",
          taskOrigin: "api",
        },
      ],
      tombstones: [makeTombstone("task-1", "failed")],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);
    store.close();

    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    assert.deepEqual(reloaded.load(), snapshot);
    const persistenceInfo = reloaded.getPersistenceInfo();
    assert.ok(persistenceInfo.lastPersistAt, "lastPersistAt should be reported after saving");
    assert.equal(persistenceInfo.lastPersistSkippedFullSnapshot, false);
    delete persistenceInfo.lastPersistAt;
    delete persistenceInfo.lastPersistSkippedFullSnapshot;
    assert.deepEqual(persistenceInfo, {
      kind: "sqlite",
      dbFile: temp.filePath,
      stateVersion: CURRENT_BROKER_STATE_VERSION,
      loadSource: "snapshot",
      schemaVersion: 13,
      journalMode: "wal",
      hotEntityTables: [
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
      ],
      hotEntityHintTables: [
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
      ],
      hotEntityHintCoverage: {
        ok: true,
        supportedTables: [
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
        ],
        missingTables: [],
        supportedCount: 10,
        totalCount: 10,
      },
      hotEntityMirror: {
        ok: true,
        tableCounts: {
          broker_exchanges: 1,
          broker_exchange_messages: 1,
          broker_proposals: 1,
          broker_artifacts: 1,
          broker_validations: 1,
          broker_tasks: 1,
          broker_tombstones: 1,
          broker_workers: 1,
          broker_audit_events: 1,
          broker_terminal_outbox: 0,
        },
        snapshotCounts: {
          exchanges: 1,
          exchangeMessages: 1,
          proposals: 1,
          artifacts: 1,
          validations: 1,
          tasks: 1,
          tombstones: 1,
          workers: 1,
          auditEvents: 1,
          terminalOutbox: 0,
        },
        mismatches: [],
      },
      hotEntityDiagnostics: {
        invalidRows: [],
      },
      hotTableLoadMetrics: {
        tables: {
          broker_exchanges: { count: 1, maxPayloadBytes: 506, totalPayloadBytes: 506 },
          broker_exchange_messages: { count: 1, maxPayloadBytes: 215, totalPayloadBytes: 215 },
          broker_proposals: { count: 1, maxPayloadBytes: 397, totalPayloadBytes: 397 },
          broker_artifacts: { count: 1, maxPayloadBytes: 128, totalPayloadBytes: 128 },
          broker_validations: { count: 1, maxPayloadBytes: 171, totalPayloadBytes: 171 },
          broker_tasks: {
            count: 1,
            maxPayloadBytes: 381,
            totalPayloadBytes: 381,
            runtimeLoad: { limit: 2000, loadedCount: 1, skippedCount: 0, activeCount: 1, terminalCount: 0 },
          },
          broker_tombstones: { count: 1, maxPayloadBytes: 203, totalPayloadBytes: 203 },
          broker_workers: { count: 1, maxPayloadBytes: 313, totalPayloadBytes: 313 },
          broker_audit_events: {
            count: 1,
            maxPayloadBytes: 142,
            totalPayloadBytes: 142,
            runtimeLoad: { limit: 5000, loadedCount: 1, skippedCount: 0 },
          },
          broker_terminal_outbox: {
            count: 0,
            maxPayloadBytes: 0,
            totalPayloadBytes: 0,
            unackedCount: 0,
            runtimeLoad: { limit: 1000, loadedCount: 0, skippedCount: 0 },
          },
        },
      },
      hotTableRuntimeLoadLimits: {
        terminalTasks: 2000,
        auditEvents: 5000,
        terminalOutboxEvents: 1000,
      },
      importedFromJsonFile: undefined,
      lastImportAt: undefined,
    });
    reloaded.close();

    const db = new DatabaseSync(temp.filePath, { readOnly: true });
    try {
      assert.equal(readSqliteCount(db, "broker_exchanges"), 1);
      assert.equal(readSqliteCount(db, "broker_exchange_messages"), 1);
      assert.equal(readSqliteCount(db, "broker_proposals"), 1);
      assert.equal(readSqliteCount(db, "broker_artifacts"), 1);
      assert.equal(readSqliteCount(db, "broker_validations"), 1);
      assert.equal(readSqliteCount(db, "broker_tasks"), 1);
      assert.equal(readSqliteCount(db, "broker_tombstones"), 1);
      assert.equal(readSqliteCount(db, "broker_workers"), 1);
      assert.equal(readSqliteCount(db, "broker_audit_events"), 1);
      assert.equal(readSqliteCount(db, "broker_terminal_outbox"), 0);
      const taskRow = db.prepare("SELECT id, status, intent, assigned_worker_id, task_origin FROM broker_tasks").get() as {
        id: string;
        status: string;
        intent: string;
        assigned_worker_id: string;
        task_origin: string;
      };
      assert.equal(taskRow.id, "task-1");
      assert.equal(taskRow.status, "queued");
      assert.equal(taskRow.intent, "chat");
      assert.equal(taskRow.assigned_worker_id, "worker-a");
      assert.equal(taskRow.task_origin, "api");
      const exchangeRow = db.prepare("SELECT id, status, intent, target_node_id FROM broker_exchanges").get() as {
        id: string;
        status: string;
        intent: string;
        target_node_id: string;
      };
      assert.equal(exchangeRow.id, "exchange-1");
      assert.equal(exchangeRow.status, "running");
      assert.equal(exchangeRow.intent, "chat");
      assert.equal(exchangeRow.target_node_id, "worker-a");
      const exchangeMessageRow = db.prepare("SELECT id, exchange_id, kind FROM broker_exchange_messages").get() as {
        id: string;
        exchange_id: string;
        kind: string;
      };
      assert.equal(exchangeMessageRow.id, "message-1");
      assert.equal(exchangeMessageRow.exchange_id, "exchange-1");
      assert.equal(exchangeMessageRow.kind, "root");
      const proposalRow = db.prepare("SELECT id, status, kind, target_node_id FROM broker_proposals").get() as {
        id: string;
        status: string;
        kind: string;
        target_node_id: string;
      };
      assert.equal(proposalRow.id, "proposal-1");
      assert.equal(proposalRow.status, "submitted");
      assert.equal(proposalRow.kind, "patch");
      assert.equal(proposalRow.target_node_id, "worker-a");
      const artifactRow = db.prepare("SELECT id, proposal_id, kind FROM broker_artifacts").get() as {
        id: string;
        proposal_id: string;
        kind: string;
      };
      assert.equal(artifactRow.id, "artifact-1");
      assert.equal(artifactRow.proposal_id, "proposal-1");
      assert.equal(artifactRow.kind, "report");
      const validationRow = db.prepare("SELECT id, proposal_id, node_id, verdict FROM broker_validations").get() as {
        id: string;
        proposal_id: string;
        node_id: string;
        verdict: string;
      };
      assert.equal(validationRow.id, "validation-1");
      assert.equal(validationRow.proposal_id, "proposal-1");
      assert.equal(validationRow.node_id, "validator-a");
      assert.equal(validationRow.verdict, "pass");
      const tombstoneRow = db.prepare("SELECT task_id, terminal_status, tombstone_reason FROM broker_tombstones").get() as {
        task_id: string;
        terminal_status: string;
        tombstone_reason: string;
      };
      assert.equal(tombstoneRow.task_id, "task-1");
      assert.equal(tombstoneRow.terminal_status, "failed");
      assert.equal(tombstoneRow.tombstone_reason, "failed");
    } finally {
      db.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("buildHotEntityHintCoverage reports missing hinted-write support for mirrored table drift", () => {
  assert.deepEqual(
    buildHotEntityHintCoverage(
      ["broker_tasks", "broker_workers", "broker_future_hot_table"],
      ["broker_tasks", "broker_workers"],
    ),
    {
      ok: false,
      supportedTables: ["broker_tasks", "broker_workers"],
      missingTables: ["broker_future_hot_table"],
      supportedCount: 2,
      totalCount: 3,
    },
  );
});

test("SQLite export script writes canonical JSON snapshots", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const exportFile = join(temp.dir, "exported-state.json");
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-sqlite-export", "succeeded", "worker-a")],
      auditEvents: [makeAuditEvent("audit-export", "task.succeeded", "task-sqlite-export")],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);
    store.close();

    execFileSync("node", [
      "scripts/export-sqlite-state.mjs",
      "--db",
      temp.filePath,
      "--out",
      exportFile,
    ], {
      cwd: join(import.meta.dirname, "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const exported = JSON.parse(readFileSync(exportFile, "utf8"));
    assert.equal(exported.version, CURRENT_BROKER_STATE_VERSION);
    assert.deepEqual(exported.tasks, snapshot.tasks);
    assert.deepEqual(exported.auditEvents, snapshot.auditEvents);
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore imports an existing JSON snapshot atomically on first load", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const jsonFile = join(temp.dir, "state.json");
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [
        {
          id: "task-imported",
          intent: "chat",
          requester: { id: "requester", kind: "session", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          message: "import me",
          targetNodeId: "worker-a",
          assignedWorkerId: "worker-a",
          payload: { correlationId: "corr-1" },
          status: "queued",
          createdAt: "2026-04-27T00:00:00.000Z",
          updatedAt: "2026-04-27T00:00:00.000Z",
          taskOrigin: "api",
        },
      ],
    };
    writeFileSync(jsonFile, JSON.stringify(snapshot), "utf8");

    const store = new SqliteBrokerStateStore(temp.filePath, { importJsonFile: jsonFile });
    assert.deepEqual(store.load(), snapshot);
    const info = store.getPersistenceInfo();
    assert.equal(info.importedFromJsonFile, jsonFile);
    assert.match(info.lastImportAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    store.close();

    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    assert.deepEqual(reloaded.load(), snapshot);
    reloaded.close();

    const db = new DatabaseSync(temp.filePath, { readOnly: true });
    try {
      assert.equal(readSqliteCount(db, "broker_tasks"), 1);
      const importedTaskRow = db.prepare("SELECT id, status, target_node_id FROM broker_tasks").get() as {
        id: string;
        status: string;
        target_node_id: string;
      };
      assert.equal(importedTaskRow.id, "task-imported");
      assert.equal(importedTaskRow.status, "queued");
      assert.equal(importedTaskRow.target_node_id, "worker-a");
    } finally {
      db.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore reads hot entities from mirrored tables with filters", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      workers: [
        makeWorker("worker-a"),
        makeWorker("worker-b"),
      ],
      exchanges: [
        makeExchange("exchange-a", "worker-a", "2026-04-27T00:01:00.000Z"),
        makeExchange("exchange-b", "worker-b", "2026-04-27T00:02:00.000Z"),
      ],
      exchangeMessages: [
        makeExchangeMessage("message-root", "exchange-a", "root", undefined, "2026-04-27T00:00:00.000Z"),
        makeExchangeMessage("message-child", "exchange-a", "thread", "message-root", "2026-04-27T00:01:00.000Z"),
        makeExchangeMessage("message-other", "exchange-b", "root", undefined, "2026-04-27T00:02:00.000Z"),
      ],
      proposals: [
        makeProposal("proposal-submitted", "submitted", "worker-a", "2026-04-27T00:01:00.000Z"),
        makeProposal("proposal-approved", "approved", "worker-b", "2026-04-27T00:02:00.000Z"),
      ],
      artifacts: [
        makeArtifact("artifact-old", "proposal-submitted", "2026-04-27T00:01:00.000Z"),
        makeArtifact("artifact-new", "proposal-submitted", "2026-04-27T00:02:00.000Z"),
        makeArtifact("artifact-other", "proposal-approved", "2026-04-27T00:03:00.000Z"),
      ],
      validations: [
        makeValidation("validation-old", "proposal-submitted", "2026-04-27T00:01:00.000Z"),
        makeValidation("validation-new", "proposal-submitted", "2026-04-27T00:02:00.000Z"),
        makeValidation("validation-other", "proposal-approved", "2026-04-27T00:03:00.000Z"),
      ],
      tasks: [
        makeTask("task-queued", "queued", "worker-a"),
        makeTask("task-running", "running", "worker-a"),
        makeTask("task-done", "succeeded", "worker-b"),
      ],
      auditEvents: [
        makeAuditEvent("audit-1", "task.created", "task-queued"),
        makeAuditEvent("audit-2", "task.started", "task-running"),
        makeAuditEvent("audit-3", "task.succeeded", "task-done"),
      ],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);

    assert.deepEqual(
      store.readHotTasks({ assignedWorkerId: "worker-a" }).map((task) => task.id),
      ["task-running", "task-queued"],
    );
    assert.deepEqual(
      store.readHotTasks({ status: "succeeded" }).map((task) => task.id),
      ["task-done"],
    );
    assert.deepEqual(
      store.readHotTasks({ id: "task-queued" }).map((task) => task.payload),
      [{ correlationId: "corr-task-queued" }],
    );
    assert.deepEqual(
      store.readHotTasks({ targetNodeId: "worker-a", intent: "chat", taskOrigin: "api" }).map((task) => task.id),
      ["task-running", "task-queued"],
    );
    assert.deepEqual(
      store.readHotTaskListItems({ targetNodeId: "worker-a", intent: "chat", taskOrigin: "api", limit: 1 }),
      [{
        id: "task-running",
        intent: "chat",
        status: "running",
        targetNodeId: "worker-a",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        taskOrigin: "api",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:02:00.000Z",
      }],
    );
    assert.deepEqual(
      store.readHotExchanges().map((exchange) => exchange.id),
      ["exchange-b", "exchange-a"],
    );
    assert.deepEqual(
      store.readHotExchanges({ id: "exchange-a" }).map((exchange) => exchange.targetNodeId),
      ["worker-a"],
    );
    assert.deepEqual(
      store.readHotExchangeMessages({ exchangeId: "exchange-a" }).map((message) => message.id),
      ["message-root", "message-child"],
    );
    assert.deepEqual(
      store.readHotProposals().map((proposal) => proposal.id),
      ["proposal-approved", "proposal-submitted"],
    );
    assert.deepEqual(
      store.readHotProposals({ status: "submitted", targetNodeId: "worker-a", kind: "patch" }).map((proposal) => proposal.id),
      ["proposal-submitted"],
    );
    assert.deepEqual(
      store.readHotArtifacts({ proposalId: "proposal-submitted" }).map((artifact) => artifact.id),
      ["artifact-new", "artifact-old"],
    );
    assert.deepEqual(
      store.readHotValidations({ proposalId: "proposal-submitted" }).map((validation) => validation.id),
      ["validation-new", "validation-old"],
    );
    assert.deepEqual(
      store.readHotWorkers().map((worker) => worker.nodeId),
      ["worker-a", "worker-b"],
    );
    assert.deepEqual(
      store.readHotWorkers({ nodeId: "worker-b" }).map((worker) => worker.nodeId),
      ["worker-b"],
    );
    assert.deepEqual(
      store.readHotWorkers({ role: "analyst" }).map((worker) => worker.nodeId),
      ["worker-a", "worker-b"],
    );
    assert.deepEqual(
      store.readHotAuditEvents({ targetId: "task-running" }).map((event) => event.id),
      ["audit-2"],
    );
    assert.deepEqual(
      store.readHotAuditEvents({ action: "task.created" }).map((event) => event.targetId),
      ["task-queued"],
    );
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore projects empty hot tables as an empty runtime snapshot", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);

    assert.deepEqual(store.readHotRuntimeSnapshot(), emptySnapshot());
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotTasks respects maxRows cap", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [],
      exchangeMessages: [],
      proposals: [],
      artifacts: [],
      validations: [],
      workers: [],
      tasks: [
        makeTask("task-a", "queued", "worker-a"),
        makeTask("task-b", "running", "worker-a"),
        makeTask("task-c", "running", "worker-b"),
        makeTask("task-d", "succeeded", "worker-b"),
        makeTask("task-e", "succeeded", "worker-b"),
      ],
      auditEvents: [],
      tombstones: [],
      terminalOutbox: [],
      crossBrokerTerminalBriefs: [],
    });

    assert.equal(store.readHotTasks().length, 5, "bounded: no maxRows returns all 5 tasks");
    assert.equal(store.readHotTasks({ maxRows: 1 }).length, 1, "maxRows=1 must return at most 1 task");
    assert.equal(store.readHotTasks({ maxRows: 3 }).length, 3, "maxRows=3 must return at most 3 tasks");
    assert.equal(store.readHotTasks({ maxRows: 100 }).length, 5, "maxRows larger than dataset returns all rows");
    assert.equal(store.readHotTasks({ maxRows: 0 }).length, 5, "maxRows=0 (disabled) returns all rows");
    // With AND filter + maxRows
    assert.equal(store.readHotTasks({ status: "succeeded", maxRows: 1 }).length, 1, "filtered + maxRows=1 returns 1");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotAuditEvents respects maxRows cap", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [],
      exchangeMessages: [],
      proposals: [],
      artifacts: [],
      validations: [],
      workers: [],
      tasks: [],
      auditEvents: [
        makeAuditEvent("audit-1", "task.created", "task-a"),
        makeAuditEvent("audit-2", "task.started", "task-b"),
        makeAuditEvent("audit-3", "task.succeeded", "task-b"),
        makeAuditEvent("audit-4", "task.created", "task-b"),
      ],
      tombstones: [],
      terminalOutbox: [],
      crossBrokerTerminalBriefs: [],
    });

    assert.equal(store.readHotAuditEvents().length, 4, "no maxRows returns all 4 audit events");
    assert.equal(store.readHotAuditEvents({ maxRows: 1 }).length, 1, "maxRows=1 must return at most 1");
    assert.equal(store.readHotAuditEvents({ maxRows: 2 }).length, 2, "maxRows=2 must return at most 2");
    assert.equal(store.readHotAuditEvents({ maxRows: 100 }).length, 4, "maxRows > dataset returns all");
    assert.equal(store.readHotAuditEvents({ maxRows: 0 }).length, 4, "maxRows=0 returns all");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotWorkers respects maxRows cap", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [],
      exchangeMessages: [],
      proposals: [],
      artifacts: [],
      validations: [],
      workers: [
        makeWorker("worker-a"),
        makeWorker("worker-b"),
        makeWorker("worker-c"),
      ],
      tasks: [],
      auditEvents: [],
      tombstones: [],
      terminalOutbox: [],
      crossBrokerTerminalBriefs: [],
    });

    assert.equal(store.readHotWorkers().length, 3, "no maxRows returns all 3 workers");
    assert.equal(store.readHotWorkers({ maxRows: 1 }).length, 1, "maxRows=1 must return at most 1");
    assert.equal(store.readHotWorkers({ maxRows: 100 }).length, 3, "maxRows > dataset returns all");
    assert.equal(store.readHotWorkers({ maxRows: 0 }).length, 3, "maxRows=0 returns all");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotTombstones respects maxRows cap", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [],
      exchangeMessages: [],
      proposals: [],
      artifacts: [],
      validations: [],
      workers: [],
      tasks: [],
      auditEvents: [],
      tombstones: [
        makeTombstone("t1", "failed", "2026-04-27T01:00:00.000Z"),
        makeTombstone("t2", "dead_lettered", "2026-04-26T01:00:00.000Z"),
        makeTombstone("t3", "canceled", "2026-04-25T01:00:00.000Z"),
      ],
      terminalOutbox: [],
      crossBrokerTerminalBriefs: [],
    });

    assert.equal(store.readHotTombstones().length, 3, "no maxRows returns all 3 tombstones");
    assert.equal(store.readHotTombstones({ maxRows: 1 }).length, 1, "maxRows=1 must return at most 1");
    assert.equal(store.readHotTombstones({ maxRows: 2 }).length, 2, "maxRows=2 must return at most 2");
    assert.equal(store.readHotTombstones({ maxRows: 100 }).length, 3, "maxRows > dataset returns all");
    assert.equal(store.readHotTombstones({ maxRows: 0 }).length, 3, "maxRows=0 returns all");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore skips invalid worker hot rows and reports diagnostics", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const validWorker = makeWorker("worker-valid");
    const invalidWorker = {
      nodeId: "worker-invalid",
      role: "analyst",
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
      lastSeenAt: "2026-04-27T00:00:00.000Z",
    };
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    store.upsertHotWorkers([validWorker]);

    const db = new DatabaseSync(temp.filePath);
    try {
      db.prepare(
        `INSERT INTO broker_workers (node_id, role, last_seen_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        invalidWorker.nodeId,
        invalidWorker.role,
        invalidWorker.lastSeenAt,
        invalidWorker.updatedAt,
        JSON.stringify(invalidWorker),
      );
    } finally {
      db.close();
    }

    assert.deepEqual(store.load().workers.map((worker) => worker.nodeId), ["worker-valid"]);
    assert.deepEqual(store.readHotWorkers().map((worker) => worker.nodeId), ["worker-valid"]);
    assert.deepEqual(store.getPersistenceInfo().hotEntityDiagnostics?.invalidRows, [{
      table: "broker_workers",
      primaryKey: "worker-invalid",
      schemaError: "Invalid input: expected object, received undefined",
      count: 1,
    }]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore skips invalid task hot rows and reports diagnostics", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    const validTask = makeTask("task-valid", "queued", "worker-valid");
    store.upsertHotTasks([validTask]);

    const invalidTask = {
      ...makeTask("task-invalid", "queued", "workerepsilon"),
      workspace: { id: "openclaw-ops", kind: "filesystem", nodeId: "workerepsilon" },
    };
    const db = new DatabaseSync(temp.filePath);
    try {
      db.prepare(
        `INSERT INTO broker_tasks
          (id, status, intent, target_node_id, assigned_worker_id, task_origin, updated_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        invalidTask.id,
        invalidTask.status,
        invalidTask.intent,
        invalidTask.targetNodeId,
        invalidTask.assignedWorkerId ?? null,
        invalidTask.taskOrigin ?? "unknown",
        invalidTask.updatedAt,
        JSON.stringify(invalidTask),
      );
    } finally {
      db.close();
    }

    assert.deepEqual(store.load().tasks.map((task) => task.id), ["task-valid"]);
    assert.deepEqual(store.readHotTasks().map((task) => task.id), ["task-valid"]);
    assert.deepEqual(store.getPersistenceInfo().hotEntityDiagnostics?.invalidRows, [{
      table: "broker_tasks",
      primaryKey: "task-invalid",
      schemaError: "Invalid input: expected string, received undefined",
      count: 1,
    }]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore projects a runtime snapshot from hot tables without a canonical snapshot", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const exchange = makeExchange("exchange-hot", "worker-hot");
    const exchangeMessage = makeExchangeMessage("message-hot", "exchange-hot", "root");
    const proposal = makeProposal("proposal-hot", "submitted", "worker-hot");
    const artifact = makeArtifact("artifact-hot", "proposal-hot");
    const validation = makeValidation("validation-hot", "proposal-hot");
    const auditEvent = makeAuditEvent("audit-hot", "task.created", "task-hot");
    const worker = makeWorker("worker-hot");
    const task = makeTask("task-hot", "queued", "worker-hot");
    const tombstone = makeTombstone("task-hot-terminal", "failed");
    const expected: BrokerSnapshot = {
      ...emptySnapshot(),
      exchanges: [exchange],
      exchangeMessages: [exchangeMessage],
      proposals: [proposal],
      artifacts: [artifact],
      validations: [validation],
      auditEvents: [auditEvent],
      workers: [worker],
      tasks: [task],
      tombstones: [tombstone],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.upsertHotExchanges([exchange]);
    store.upsertHotExchangeMessages([exchangeMessage]);
    store.upsertHotProposals([proposal]);
    store.upsertHotArtifacts([artifact]);
    store.upsertHotValidations([validation]);
    store.upsertHotAuditEvents([auditEvent]);
    store.upsertHotWorkers([worker]);
    store.upsertHotTasks([task]);
    store.upsertHotTombstones([tombstone]);

    assert.deepEqual(store.load(), emptySnapshot());
    assert.deepEqual(store.readHotRuntimeSnapshot(), expected);
    store.close();

    const db = new DatabaseSync(temp.filePath, { readOnly: true });
    try {
      assert.equal(readSqliteCount(db, "broker_snapshots"), 0);
    } finally {
      db.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore hot-table load skips corrupt canonical push sidecar", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const task = makeTask("task-hot-corrupt-sidecar", "queued", "worker-hot");
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    store.upsertHotTasks([task]);
    store.close();

    const db = new DatabaseSync(temp.filePath);
    try {
      db.prepare("INSERT INTO broker_snapshots (id, version, payload, updated_at) VALUES (1, ?, ?, ?)")
        .run(CURRENT_BROKER_STATE_VERSION, "{not-json", "2026-04-27T00:00:00.000Z");
    } finally {
      db.close();
    }

    const reloaded = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    const snapshot = reloaded.load();
    assert.deepEqual(snapshot.tasks.map((loadedTask) => loadedTask.id), [task.id]);
    assert.equal(snapshot.pushNotificationConfigs, undefined);
    reloaded.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore bounds hot runtime hydration without hiding table-native reads", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const activeTask = makeTask("task-running", "running", "worker-a");
    const oldTerminalTask = {
      ...makeTask("task-terminal-old", "succeeded", "worker-a"),
      completedAt: "2026-04-27T00:01:00.000Z",
      updatedAt: "2026-04-27T00:01:00.000Z",
    };
    const newestTerminalTask = {
      ...makeTask("task-terminal-new", "failed", "worker-a"),
      completedAt: "2026-04-27T00:03:00.000Z",
      updatedAt: "2026-04-27T00:03:00.000Z",
    };
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [oldTerminalTask, newestTerminalTask, activeTask],
      auditEvents: [
        makeAuditEvent("audit-old", "task.created", "task-terminal-old", "2026-04-27T00:01:00.000Z"),
        makeAuditEvent("audit-mid", "task.failed", "task-terminal-new", "2026-04-27T00:02:00.000Z"),
        makeAuditEvent("audit-new", "task.started", "task-running", "2026-04-27T00:03:00.000Z"),
      ],
      terminalOutbox: [
        makeTerminalOutboxEvent("outbox-old", "task-terminal-old", "2026-04-27T00:01:00.000Z"),
        makeTerminalOutboxEvent("outbox-mid", "task-terminal-new", "2026-04-27T00:02:00.000Z"),
        makeTerminalOutboxEvent("outbox-new", "task-running", "2026-04-27T00:03:00.000Z"),
      ],
    };

    const store = new SqliteBrokerStateStore(temp.filePath, {
      maxHotRuntimeTerminalTasks: 1,
      maxHotRuntimeAuditEvents: 2,
      maxHotRuntimeTerminalOutboxEvents: 2,
    });
    store.save(snapshot);

    const hotRuntime = store.readHotRuntimeSnapshot();
    assert.deepEqual(new Set(hotRuntime.tasks.map((task) => task.id)), new Set(["task-running", "task-terminal-new"]));
    assert.deepEqual(hotRuntime.auditEvents.map((event) => event.id), ["audit-new", "audit-mid"]);
    assert.deepEqual(hotRuntime.terminalOutbox?.map((event) => event.id), ["outbox-mid", "outbox-new"]);

    assert.equal(store.readHotTasks().length, 3);
    assert.equal(store.readHotAuditEvents().length, 3);
    assert.equal(store.readHotTerminalOutbox().length, 3);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore hot runtime projection can diverge from stale canonical load", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const staleTask = makeTask("task-stale", "queued", "worker-a");
    const hotTask = {
      ...staleTask,
      status: "claimed" as const,
      claimedBy: "worker-a",
      claimedAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    };
    const staleSnapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [staleTask],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(staleSnapshot);
    store.upsertHotTasks([hotTask]);

    assert.deepEqual(store.load(), staleSnapshot);
    assert.deepEqual(store.readHotRuntimeSnapshot().tasks, [hotTask]);
    assert.notDeepEqual(store.readHotRuntimeSnapshot(), store.load());
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore can opt into hot-table runtime load source", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const staleTask = makeTask("task-stale", "queued", "worker-a");
    const hotTask = {
      ...staleTask,
      status: "claimed" as const,
      claimedBy: "worker-a",
      claimedAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    };
    const staleSnapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [staleTask],
    };
    const hotSnapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [hotTask],
    };

    const canonicalStore = new SqliteBrokerStateStore(temp.filePath);
    canonicalStore.save(staleSnapshot);
    canonicalStore.upsertHotTasks([hotTask]);
    canonicalStore.close();

    const hotLoadStore = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    assert.deepEqual(hotLoadStore.load(), hotSnapshot);
    assert.equal(hotLoadStore.getPersistenceInfo().loadSource, "hot-tables");
    hotLoadStore.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore hot-table load source preserves first-load JSON import", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const importedSnapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-imported-hot-load", "queued", "worker-a")],
    };
    const jsonFile = join(temp.dir, "state.json");
    writeBrokerSnapshotFile(jsonFile, importedSnapshot);

    const store = new SqliteBrokerStateStore(temp.filePath, {
      importJsonFile: jsonFile,
      loadSource: "hot-tables",
    });

    assert.deepEqual(store.load(), importedSnapshot);
    assert.deepEqual(store.readHotRuntimeSnapshot(), importedSnapshot);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteTaskRuntimeRepository writes task state directly to broker_tasks", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteTaskRuntimeRepository(store);

    repository.upsertTask(makeTask("task-runtime", "queued", "worker-a"));
    repository.upsertTask({
      ...makeTask("task-runtime", "claimed", "worker-a"),
      claimedBy: "worker-a",
      claimedAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    });

    const task = repository.getTask("task-runtime");
    assert.equal(task?.status, "claimed");
    assert.equal(task?.claimedBy, "worker-a");
    assert.deepEqual(
      repository.listTasks({ status: "claimed", claimedBy: "worker-a", assignedWorkerId: "worker-a", taskOrigin: "api" }).map((item) => item.id),
      ["task-runtime"],
    );
    assert.deepEqual(store.load().tasks, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("Sqlite exchange runtime repositories write directly to exchange hot tables", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const exchangeRepository = new SqliteExchangeRuntimeRepository(store);
    const messageRepository = new SqliteExchangeMessageRuntimeRepository(store);

    exchangeRepository.upsertExchange(makeExchange("exchange-runtime", "worker-a"));
    messageRepository.upsertExchangeMessage(makeExchangeMessage("exchange-runtime-root", "exchange-runtime", "root"));
    messageRepository.upsertExchangeMessage(makeExchangeMessage(
      "exchange-runtime-thread",
      "exchange-runtime",
      "thread",
      "exchange-runtime-root",
      "2026-04-27T00:01:00.000Z",
    ));
    exchangeRepository.upsertExchange({
      ...makeExchange("exchange-runtime", "worker-a"),
      latestMessageId: "exchange-runtime-thread",
      messageCount: 2,
      lastMessageAt: "2026-04-27T00:01:00.000Z",
      updatedAt: "2026-04-27T00:01:00.000Z",
    });

    const exchange = exchangeRepository.getExchange("exchange-runtime");
    assert.equal(exchange?.latestMessageId, "exchange-runtime-thread");
    assert.equal(exchange?.messageCount, 2);
    assert.deepEqual(exchangeRepository.listExchanges().map((item) => item.id), ["exchange-runtime"]);
    assert.equal(messageRepository.getExchangeMessage("exchange-runtime-thread")?.parentMessageId, "exchange-runtime-root");
    assert.deepEqual(
      messageRepository.listExchangeMessages("exchange-runtime").map((item) => item.id),
      ["exchange-runtime-root", "exchange-runtime-thread"],
    );
    assert.deepEqual(store.load().exchanges, []);
    assert.deepEqual(store.load().exchangeMessages, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteProposalRuntimeRepository writes proposal state directly to broker_proposals", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteProposalRuntimeRepository(store);

    repository.upsertProposal(makeProposal("proposal-runtime", "submitted", "worker-a"));
    repository.upsertProposal({
      ...makeProposal("proposal-runtime", "approved", "worker-a"),
      summary: "runtime proposal updated",
      updatedAt: "2026-04-27T00:02:00.000Z",
    });
    repository.upsertProposal({
      ...makeProposal("proposal-runtime-other", "validated", "worker-b", "2026-04-27T00:01:00.000Z"),
      kind: "params",
      parameterPayload: { threshold: 3 },
    });

    const proposal = repository.getProposal("proposal-runtime");
    assert.equal(proposal?.status, "approved");
    assert.equal(proposal?.summary, "runtime proposal updated");
    assert.deepEqual(
      repository.listProposals({ status: "approved", sourceNodeId: "source-a", targetNodeId: "worker-a", kind: "patch" }).map((item) => item.id),
      ["proposal-runtime"],
    );
    assert.deepEqual(
      repository.listProposals({ kind: "params" }).map((item) => item.parameterPayload),
      [{ threshold: 3 }],
    );
    assert.deepEqual(store.load().proposals, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteArtifactRuntimeRepository writes artifact metadata directly to broker_artifacts", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteArtifactRuntimeRepository(store);

    repository.upsertArtifact(makeArtifact("artifact-runtime", "proposal-runtime"));
    repository.upsertArtifact({
      ...makeArtifact("artifact-runtime", "proposal-runtime"),
      summary: "runtime artifact updated",
      uri: "memory://runtime-artifact-updated",
      createdAt: "2026-04-27T00:02:00.000Z",
    });
    repository.upsertArtifact({
      ...makeArtifact("artifact-runtime-other", "proposal-runtime", "2026-04-27T00:01:00.000Z"),
      kind: "bundle",
      contentType: "application/json",
      sizeBytes: 123,
    });
    repository.upsertArtifact(makeArtifact("artifact-runtime-foreign", "proposal-foreign", "2026-04-27T00:03:00.000Z"));

    const artifact = repository.getArtifact("artifact-runtime");
    assert.equal(artifact?.summary, "runtime artifact updated");
    assert.equal(artifact?.uri, "memory://runtime-artifact-updated");
    assert.deepEqual(
      repository.listArtifactsForProposal("proposal-runtime").map((item) => [item.id, item.kind]),
      [["artifact-runtime", "report"], ["artifact-runtime-other", "bundle"]],
    );
    assert.deepEqual(store.load().artifacts, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteValidationRuntimeRepository writes validation results directly to broker_validations", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteValidationRuntimeRepository(store);

    repository.upsertValidation(makeValidation("validation-runtime", "proposal-runtime"));
    repository.upsertValidation({
      ...makeValidation("validation-runtime", "proposal-runtime"),
      verdict: "fail",
      note: "runtime validation updated",
      metrics: { confidence: "low" },
      createdAt: "2026-04-27T00:02:00.000Z",
    });
    repository.upsertValidation({
      ...makeValidation("validation-runtime-other", "proposal-runtime", "2026-04-27T00:01:00.000Z"),
      kind: "paper",
      nodeId: "worker-b",
    });
    repository.upsertValidation(makeValidation("validation-runtime-foreign", "proposal-foreign", "2026-04-27T00:03:00.000Z"));

    const validation = repository.getValidation("validation-runtime");
    assert.equal(validation?.verdict, "fail");
    assert.equal(validation?.note, "runtime validation updated");
    assert.deepEqual(validation?.metrics, { confidence: "low" });
    assert.deepEqual(
      repository.listValidationsForProposal("proposal-runtime").map((item) => [item.id, item.kind]),
      [["validation-runtime", "smoke"], ["validation-runtime-other", "paper"]],
    );
    assert.deepEqual(store.load().validations, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteWorkerRuntimeRepository writes worker state directly to broker_workers", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteWorkerRuntimeRepository(store);

    repository.upsertWorker(makeWorker("worker-runtime"));
    repository.upsertWorker({
      ...makeWorker("worker-runtime"),
      displayName: "runtime worker",
      updatedAt: "2026-04-27T00:01:00.000Z",
      lastSeenAt: "2026-04-27T00:01:00.000Z",
      metadata: { heartbeat: "direct" },
    });

    const worker = repository.getWorker("worker-runtime");
    assert.equal(worker?.displayName, "runtime worker");
    assert.deepEqual(worker?.metadata, { heartbeat: "direct" });
    assert.deepEqual(
      repository.listWorkers({ role: "analyst", environment: "research", workspaceId: "smoke" }).map((item) => item.nodeId),
      ["worker-runtime"],
    );
    assert.deepEqual(store.load().workers, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteAuditRuntimeRepository writes audit events directly to broker_audit_events", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteAuditRuntimeRepository(store);

    repository.appendAuditEvent(makeAuditEvent("audit-runtime-created", "task.created", "task-runtime"));
    repository.appendAuditEvent({
      ...makeAuditEvent("audit-runtime-started", "task.started", "task-runtime", "2026-04-27T00:01:00.000Z"),
      actorId: "worker-runtime",
      proposalId: "proposal-runtime",
    });

    assert.deepEqual(
      repository.listAuditEvents({ targetId: "task-runtime" }).map((event) => event.id),
      ["audit-runtime-started", "audit-runtime-created"],
    );
    assert.deepEqual(
      repository.listAuditEvents({ proposalId: "proposal-runtime", actorId: "worker-runtime", action: "task.started" }).map((event) => event.id),
      ["audit-runtime-started"],
    );
    assert.deepEqual(store.load().auditEvents, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteAuditRuntimeRepository coalesces worker heartbeats and enforces hot-table max", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteAuditRuntimeRepository(store, { maxHotAuditEvents: 3 });

    repository.appendAuditEvent({
      ...makeAuditEvent("heartbeat-1", "worker.heartbeat", "worker-runtime", "2026-04-27T00:00:00.000Z"),
      actorId: "worker-runtime",
      targetType: "worker",
    });
    repository.appendAuditEvent({
      ...makeAuditEvent("heartbeat-2", "worker.heartbeat", "worker-runtime", "2026-04-27T00:01:00.000Z"),
      actorId: "worker-runtime",
      targetType: "worker",
    });
    assert.deepEqual(
      repository.listAuditEvents({ action: "worker.heartbeat" }).map((event) => [event.id, event.createdAt]),
      [["worker-heartbeat:worker-runtime", "2026-04-27T00:01:00.000Z"]],
    );
    repository.appendAuditEvent({
      ...makeAuditEvent("task-heartbeat-1", "task.heartbeat", "task-runtime", "2026-04-27T00:01:30.000Z"),
      actorId: "worker-runtime",
    });
    repository.appendAuditEvent({
      ...makeAuditEvent("task-heartbeat-2", "task.heartbeat", "task-runtime", "2026-04-27T00:01:45.000Z"),
      actorId: "worker-runtime",
    });
    assert.deepEqual(
      repository.listAuditEvents({ action: "task.heartbeat" }).map((event) => [event.id, event.createdAt]),
      [["task-heartbeat:task-runtime", "2026-04-27T00:01:45.000Z"]],
    );

    repository.appendAuditEvent(makeAuditEvent("audit-runtime-created", "task.created", "task-runtime", "2026-04-27T00:02:00.000Z"));
    repository.appendAuditEvent(makeAuditEvent("audit-runtime-started", "task.started", "task-runtime", "2026-04-27T00:03:00.000Z"));
    repository.appendAuditEvent(makeAuditEvent("audit-runtime-succeeded", "task.succeeded", "task-runtime", "2026-04-27T00:04:00.000Z"));

    assert.deepEqual(
      repository.listAuditEvents().map((event) => event.id),
      ["audit-runtime-succeeded", "audit-runtime-started", "audit-runtime-created"],
    );
    assert.deepEqual(
      repository.listAuditEvents({ action: "worker.heartbeat" }).map((event) => [event.id, event.createdAt]),
      [],
    );
    assert.deepEqual(store.readHotAuditDiagnostics(), {
      total: 3,
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
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteAuditRuntimeRepository caps heartbeat audit rows separately from meaningful audit rows", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteAuditRuntimeRepository(store, {
      maxHotAuditEvents: 20,
      maxHotHeartbeatAuditEvents: 3,
    });

    for (let i = 0; i < 8; i += 1) {
      repository.appendAuditEvent({
        ...makeAuditEvent(`task-heartbeat-${i}`, "task.heartbeat", `task-${i}`, `2026-04-27T00:0${i}:00.000Z`),
        actorId: `worker-${i}`,
      });
    }
    for (let i = 0; i < 4; i += 1) {
      repository.appendAuditEvent(makeAuditEvent(`audit-meaningful-${i}`, "task.created", `meaningful-${i}`, `2026-04-27T00:1${i}:00.000Z`));
    }

    assert.deepEqual(
      repository.listAuditEvents({ action: "task.heartbeat" }).map((event) => event.id),
      ["task-heartbeat:task-7", "task-heartbeat:task-6", "task-heartbeat:task-5"],
    );
    assert.deepEqual(
      repository.listAuditEvents({ action: "task.created" }).map((event) => event.id),
      ["audit-meaningful-3", "audit-meaningful-2", "audit-meaningful-1", "audit-meaningful-0"],
    );
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("hot audit diagnostics separate historical heartbeat residue from recent churn", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const oldHeartbeatEvents = Array.from({ length: 24 }, (_, index) => ({
      ...makeAuditEvent(`old-heartbeat-${index}`, "worker.heartbeat", "worker-runtime", `2026-04-27T00:${String(index).padStart(2, "0")}:00.000Z`),
      actorId: "worker-runtime",
      targetType: "worker" as const,
    }));
    store.save({
      ...emptySnapshot(),
      auditEvents: [
        ...oldHeartbeatEvents,
        makeAuditEvent("old-task-created", "task.created", "task-runtime", "2026-04-27T00:30:00.000Z"),
      ],
    });

    const historical = store.readHotAuditDiagnostics();
    assert.equal(historical.total, 25);
    assert.equal(historical.heartbeat, 24);
    assert.equal(historical.workerHeartbeat, 24);
    assert.equal(historical.taskHeartbeat, 0);
    assert.equal(historical.recentHeartbeat, 0);
    assert.equal(historical.recentWorkerHeartbeat, 0);
    assert.deepEqual(historical.warnings, [], "historical heartbeat-heavy residue should not look like active churn");

    const now = Date.now();
    const recentHeartbeatEvents = Array.from({ length: 20 }, (_, index) => ({
      ...makeAuditEvent(`recent-heartbeat-${index}`, "worker.heartbeat", "worker-runtime", new Date(now - index * 1000).toISOString()),
      actorId: "worker-runtime",
      targetType: "worker" as const,
    }));
    store.save({
      ...emptySnapshot(),
      auditEvents: [
        ...oldHeartbeatEvents,
        ...recentHeartbeatEvents,
        makeAuditEvent("recent-task-created", "task.created", "task-runtime", new Date(now).toISOString()),
      ],
    });

    const active = store.readHotAuditDiagnostics();
    assert.equal(active.recentHeartbeat, 20);
    assert.equal(active.recentWorkerHeartbeat, 20);
    assert.ok(active.recentHeartbeatRatio > 0.8);
    assert.ok(active.recentWorkerHeartbeatRatio > 0.8);
    assert.match(active.warnings.join("\n"), /heartbeat audit events are \d+% of broker_audit_events in the last 10 minutes/);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteTombstoneRuntimeRepository writes tombstones directly to broker_tombstones", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteTombstoneRuntimeRepository(store);

    repository.upsertTombstone(makeTombstone("task-runtime-old", "failed", "2026-04-27T00:01:00.000Z"));
    repository.upsertTombstone({
      ...makeTombstone("task-runtime-new", "dead_lettered", "2026-04-27T00:02:00.000Z"),
      requeueCount: 3,
      error: { code: "exceeded_requeue_limit", message: "dead lettered" },
    });

    assert.equal(repository.getTombstone("task-runtime-new")?.requeueCount, 3);
    assert.deepEqual(
      repository.listTombstones({ tombstoneReason: "dead_lettered", since: "2026-04-27T00:01:30.000Z" }).map((tombstone) => tombstone.taskId),
      ["task-runtime-new"],
    );
    assert.deepEqual(store.load().tombstones, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore hot-table load preserves canonical wave plans (#1357 G3-d canary fix)", () => {
  const temp = withTempFile("state.sqlite");
  try {
    // A running wave with a consumed retry budget — exactly the G3-d canary
    // shape that was lost across a hot-tables restart.
    const wavePlan = {
      plan: {
        wavePlanId: "wave-hot-restart",
        stages: [{ id: "design", gate: { type: "quorum" as const, minSubstantive: 2 }, onGateFail: "retry-once" as const }],
        state: "running" as const,
        currentStage: 0,
        retriedStages: [0],
      },
      updatedAt: "2026-07-07T15:00:00.000Z",
    };
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    store.save({
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [],
      exchangeMessages: [],
      proposals: [],
      artifacts: [],
      validations: [],
      workers: [],
      tasks: [],
      auditEvents: [],
      tombstones: [],
      terminalOutbox: [],
      crossBrokerTerminalBriefs: [],
      wavePlans: [wavePlan],
    });
    store.close();

    // Broker restart on the sqlite hot-tables backend.
    const reloaded = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    const snapshot = reloaded.load();
    assert.deepEqual(snapshot.wavePlans, [wavePlan], "hot-tables load must carry canonical wave plans across a restart");
    reloaded.close();
  } finally {
    temp.cleanup();
  }
});

function crossBrokerBriefFixture() {
  return {
    id: "projection-hot-restart",
    parentRoundId: "round-parent",
    originBrokerId: "child-broker-a",
    brokerOfRecordId: "parent-broker",
    childTaskId: "child-task-1",
    status: "succeeded" as const,
    summary: "child completed safely",
    completedAt: "2026-07-07T15:00:00.000Z",
    emittedAt: "2026-07-07T15:00:01.000Z",
    receivedAt: "2026-07-07T15:00:02.000Z",
    sourceDigest: "digest-1",
    replayCount: 0,
    ack: {
      decision: "accepted" as const,
      terminalAck: false as const,
      reason: "accepted cross-broker projection",
      updatedAt: "2026-07-07T15:00:02.000Z",
    },
  };
}

test("SqliteBrokerStateStore hot-table load preserves canonical cross-broker Terminal Brief projections (#1446)", () => {
  const temp = withTempFile("state.sqlite");
  try {
    // Same class of gap as the wave-plan G3-d canary fix: projections are a
    // snapshot-only sidecar (no hot table), so a hot-tables restart must carry
    // them from the canonical blob or the collected evidence vanishes.
    const brief = crossBrokerBriefFixture();
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    store.save({
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [],
      exchangeMessages: [],
      proposals: [],
      artifacts: [],
      validations: [],
      workers: [],
      tasks: [],
      auditEvents: [],
      tombstones: [],
      terminalOutbox: [],
      crossBrokerTerminalBriefs: [brief],
      wavePlans: [],
    });
    store.close();

    // Broker restart on the sqlite hot-tables backend.
    const reloaded = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    const snapshot = reloaded.load();
    assert.deepEqual(
      snapshot.crossBrokerTerminalBriefs,
      [brief],
      "hot-tables load must carry canonical cross-broker Terminal Brief projections across a restart",
    );
    reloaded.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore hint-carrying full save still writes snapshot-only sidecar state to the canonical blob (#1446)", () => {
  const temp = withTempFile("state.sqlite");
  try {
    // A full save that arrives with hot-entity hints skips rewriting the
    // canonical blob as an optimization. That skip must not apply while the
    // snapshot carries sidecar state with no hot table (wave plans,
    // cross-broker projections) — otherwise the mutation is ACKed but the
    // blob keeps the stale pre-mutation sidecar rows.
    const baseSnapshot = {
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [],
      exchangeMessages: [],
      proposals: [],
      artifacts: [],
      validations: [],
      workers: [],
      tasks: [],
      auditEvents: [],
      tombstones: [],
      terminalOutbox: [],
      crossBrokerTerminalBriefs: [],
      wavePlans: [],
    };
    const brief = crossBrokerBriefFixture();
    const wavePlan = {
      plan: {
        wavePlanId: "wave-hint-save",
        stages: [{ id: "design", gate: { type: "quorum" as const, minSubstantive: 2 }, onGateFail: "halt" as const }],
        state: "running" as const,
        currentStage: 0,
        retriedStages: [],
      },
      updatedAt: "2026-07-07T15:00:00.000Z",
    };
    const auditEvent = {
      id: "audit-hint-1",
      actorId: "worker-child",
      action: "worker.heartbeat" as const,
      targetType: "worker" as const,
      targetId: "worker-child",
      createdAt: "2026-07-07T15:00:03.000Z",
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(baseSnapshot);
    store.save(
      {
        ...baseSnapshot,
        auditEvents: [auditEvent],
        crossBrokerTerminalBriefs: [brief],
        wavePlans: [wavePlan],
      },
      { hotAuditEvents: [auditEvent] },
    );
    store.close();

    // Canonical reload: the second save carried sidecar state, so the blob
    // must have been rewritten despite the hot hints.
    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    const snapshot = reloaded.load();
    assert.deepEqual(snapshot.crossBrokerTerminalBriefs, [brief], "hint-carrying save must persist cross-broker projections to the canonical blob");
    assert.deepEqual(snapshot.wavePlans, [wavePlan], "hint-carrying save must persist wave plans to the canonical blob");
    reloaded.close();
  } finally {
    temp.cleanup();
  }
});

const WAVE_PLAN_FIXTURE = {
  plan: {
    wavePlanId: "wave-persist-overflow",
    stages: [{ id: "design", gate: { type: "quorum" as const, minSubstantive: 2 }, onGateFail: "retry-once" as const }],
    state: "running" as const,
    currentStage: 0,
    retriedStages: [0],
  },
  updatedAt: "2026-07-07T15:00:00.000Z",
};

test("save persists hot hint rows and records fail-visible diagnostics when the canonical snapshot overflows (#1578)", () => {
  const temp = withTempFile("state.sqlite");
  const errorSpy = mock.method(console, "error", () => {});
  const logSpy = mock.method(console, "log", () => {});
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, { maxBytes: 4 * 1024 });
    const hugeActiveTask = {
      ...makeTask("task-active", "queued", "worker-a"),
      payload: { blob: "x".repeat(16 * 1024) },
    };
    // Sidecar state vetoes the canonical-write skip, so the hinted save must
    // attempt the canonical write; with nothing sheddable it overflows — and
    // the hot hint rows must still persist.
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [hugeActiveTask],
      wavePlans: [WAVE_PLAN_FIXTURE as unknown as NonNullable<BrokerSnapshot["wavePlans"]>[number]],
    };
    store.save(snapshot, { hotTasks: [hugeActiveTask] });

    const diag = store.readLastPersistDiagnostics();
    assert.equal(diag.lastPersistError?.kind, "full_snapshot_overflow");
    assert.equal(diag.lastPersistSkippedFullSnapshot, false);
    assert.equal(errorSpy.mock.calls.length, 1);
    assert.match(String(errorSpy.mock.calls[0].arguments[0]), /overflow degraded/);

    // The hot hint row survived even though the canonical row did not.
    const reloaded = new SqliteBrokerStateStore(temp.filePath, { maxBytes: 4 * 1024, loadSource: "hot-tables" });
    const loaded = reloaded.load();
    assert.deepEqual(loaded.tasks.map((task) => task.id), ["task-active"]);
    assert.equal(reloaded.readHotEntityMirrorStatus().ok, true);

    // A later clean full save clears the marker and logs recovery.
    reloaded.save({ ...emptySnapshot(), tasks: [makeTask("task-small", "queued", "worker-a")] });
    const cleared = reloaded.readLastPersistDiagnostics();
    assert.equal(cleared.lastPersistError, undefined);
    assert.ok(logSpy.mock.calls.some((call) => /recovered/.test(String(call.arguments[0]))));
    reloaded.close();
  } finally {
    errorSpy.mock.restore();
    logSpy.mock.restore();
    temp.cleanup();
  }
});

test("save sheds oldest terminal tasks into the canonical mirror within budget and keeps hot hint rows (#1579)", () => {
  const temp = withTempFile("state.sqlite");
  const errorSpy = mock.method(console, "error", () => {});
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, { maxBytes: 24 * 1024 });
    const activeTask = makeTask("task-active", "queued", "worker-a");
    const terminal = Array.from({ length: 10 }, (_, index) => ({
      ...makeTask(`term-${index}`, "succeeded" as const, "worker-a"),
      payload: { blob: "x".repeat(2 * 1024) },
      completedAt: `2026-07-0${Math.floor(index / 10) + 1}T0${index % 10}:00:00.000Z`,
    }));
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [activeTask, ...terminal],
      wavePlans: [WAVE_PLAN_FIXTURE as unknown as NonNullable<BrokerSnapshot["wavePlans"]>[number]],
    };
    store.save(snapshot, { hotTasks: [activeTask] });

    const diag = store.readLastPersistDiagnostics();
    assert.ok((diag.lastFullSnapshotShedTerminal ?? 0) > 0, "shed count recorded");
    assert.equal(diag.lastPersistError, undefined);
    assert.equal(errorSpy.mock.calls.length, 1);
    assert.match(String(errorSpy.mock.calls[0].arguments[0]), /shed/);

    // Canonical mirror fits the budget, keeps non-terminal state and sidecars.
    const db = new DatabaseSync(temp.filePath, { readOnly: true });
    const row = db.prepare("SELECT payload FROM broker_snapshots WHERE id = 1").get() as { payload: string };
    db.close();
    assert.ok(Buffer.byteLength(row.payload, "utf8") <= 24 * 1024);
    const canonical = JSON.parse(row.payload) as BrokerSnapshot;
    const canonicalIds = canonical.tasks.map((task) => task.id);
    assert.ok(canonicalIds.includes("task-active"), "non-terminal tasks are never shed");
    assert.ok(canonicalIds.length < 11, "oldest terminal tasks were shed from the mirror");
    assert.equal(canonical.wavePlans?.length, 1, "sidecars are never shed");

    // Hot hint rows remain readable after reload; mirror stays healthy.
    const reloaded = new SqliteBrokerStateStore(temp.filePath, { maxBytes: 24 * 1024, loadSource: "hot-tables" });
    assert.deepEqual(reloaded.load().tasks.map((task) => task.id), ["task-active"]);
    assert.equal(reloaded.readHotEntityMirrorStatus().ok, true);

    // A later clean save clears the shed marker.
    reloaded.save({ ...emptySnapshot(), tasks: [makeTask("task-small", "queued", "worker-a")] });
    assert.equal(reloaded.readLastPersistDiagnostics().lastFullSnapshotShedTerminal, undefined);
    reloaded.close();
  } finally {
    errorSpy.mock.restore();
    temp.cleanup();
  }
});
