import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  emptySnapshot,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteTaskRuntimeRepository,
  SqliteWorkerRuntimeRepository,
} from "./store.js";
import type { AuditEvent, TaskRecord, TaskStatus, WorkerRecord } from "./types.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";

type QueuedWrite = {
  label: string;
  run: () => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  settled: boolean;
  accounted: boolean;
};

type TestOnlyWriteQueueStats = {
  capacity: number;
  queued: number;
  active: number;
  inFlight: number;
  available: number;
  closing: boolean;
  aborted: boolean;
};

/**
 * ACK persistence result — a queue write committed successfully and
 * ACK-relevant diagnostics are available for operator or automated
 * receipt confirmation.
 */
type TestOnlyRouteAckSuccess = {
  status: number;
  body: {
    ok: true;
    ack: {
      committed: true;
      committedAt: string;
      queue: TestOnlyWriteQueueStats;
    };
  };
};

/**
 * Error persistence result — a queue write failed, producing
 * error-relevant diagnostics for operator intervention or automated
 * retry. This is the separate error persistence path: errors are
 * persisted and surfaced as distinct from ACK state.
 */
type TestOnlyRouteErrorFail = {
  status: number;
  headers: Record<string, string>;
  body: {
    error: {
      code: string;
      message: string;
    };
    errorPersistence: {
      committed: false;
      retryable: boolean;
      queue: TestOnlyWriteQueueStats;
    };
  };
};

/**
 * Route boundary result that explicitly separates the ACK persistence
 * concern from the error persistence concern at the type level.
 */
type TestOnlyRouteBoundaryResult = TestOnlyRouteAckSuccess | TestOnlyRouteErrorFail;

type SqliteWorkerThreadResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

class TestOnlyWriteQueue {
  private readonly queue: QueuedWrite[] = [];
  private activeWrite: QueuedWrite | null = null;
  private active = false;
  private inFlightCount = 0;
  private closing = false;
  private aborted: Error | null = null;

  constructor(private readonly capacity: number) {}

  enqueue<T>(label: string, run: () => Promise<T> | T): Promise<T> {
    if (this.aborted) {
      return Promise.reject(this.aborted);
    }
    if (this.closing) {
      return Promise.reject(new Error("queue_closed"));
    }
    if (this.inFlightCount >= this.capacity) {
      return Promise.reject(new Error("queue_saturated"));
    }

    this.inFlightCount += 1;
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        label,
        run,
        resolve: (value) => resolve(value as T),
        reject,
        settled: false,
        accounted: false,
      });
      void this.pump();
    });
  }

  stats(): TestOnlyWriteQueueStats {
    return {
      capacity: this.capacity,
      queued: this.queue.length,
      active: this.activeWrite ? 1 : 0,
      inFlight: this.inFlightCount,
      available: Math.max(0, this.capacity - this.inFlightCount),
      closing: this.closing,
      aborted: this.aborted !== null,
    };
  }

  async drainAndClose(options: { timeoutMs?: number } = {}): Promise<void> {
    this.closing = true;
    const startedAt = Date.now();
    while (this.active || this.queue.length > 0) {
      if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
        const error = new Error("queue_drain_timeout");
        this.abort(error);
        throw error;
      }
      await nextTick();
    }
  }

  abort(error = new Error("worker_crashed")): void {
    this.aborted = error;
    this.closing = true;
    if (this.activeWrite && !this.activeWrite.settled) {
      this.activeWrite.settled = true;
      if (!this.activeWrite.accounted) {
        this.inFlightCount -= 1;
        this.activeWrite.accounted = true;
      }
      this.activeWrite.reject(error);
    }
    while (this.queue.length > 0) {
      const write = this.queue.shift();
      if (!write) {
        continue;
      }
      if (!write.accounted) {
        this.inFlightCount -= 1;
        write.accounted = true;
      }
      write.settled = true;
      write.reject(error);
    }
  }

  private async pump(): Promise<void> {
    if (this.active) {
      return;
    }

    this.active = true;
    try {
      while (this.queue.length > 0 && !this.aborted) {
        const write = this.queue.shift();
        if (!write) {
          continue;
        }
        this.activeWrite = write;
        try {
          const value = await write.run();
          if (!write.settled) {
            write.settled = true;
            write.resolve(value);
          }
        } catch (error) {
          if (!write.settled) {
            write.settled = true;
            write.reject(error instanceof Error ? error : new Error(String(error)));
          }
        } finally {
          if (this.activeWrite === write) {
            this.activeWrite = null;
          }
          if (!write.accounted && this.inFlightCount > 0) {
            this.inFlightCount -= 1;
            write.accounted = true;
          }
        }
      }
    } finally {
      this.active = false;
    }
  }
}

class TestOnlySqliteWorkerThread {
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly worker: Worker;

  constructor(dbFile: string) {
    this.worker = new Worker(buildSqliteWorkerThreadUrl(), {
      workerData: {
        dbFile,
        storeModuleUrl: new URL("./store.js", import.meta.url).href,
      },
    });
    this.worker.on("message", (response: SqliteWorkerThreadResponse) => {
      const waiter = this.pending.get(response.id);
      if (!waiter) {
        return;
      }
      this.pending.delete(response.id);
      if (response.ok) {
        waiter.resolve(response.value);
      } else {
        waiter.reject(new Error(response.error));
      }
    });
    this.worker.on("error", (error) => {
      this.rejectPending(error);
    });
    this.worker.on("exit", (code) => {
      if (this.closed || code === 0) {
        return;
      }
      this.rejectPending(new Error(`worker_exited_${code}`));
    });
  }

  request<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("worker_unavailable"));
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({ id, op, payload });
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.request("close");
    this.closed = true;
  }

  async terminate(): Promise<void> {
    this.closed = true;
    this.rejectPending(new Error("worker_unavailable"));
    await this.worker.terminate();
  }

  private rejectPending(error: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

function buildSqliteWorkerThreadUrl(): URL {
  const source = `
    import { parentPort, workerData } from "node:worker_threads";

    const { emptySnapshot, SqliteAuditRuntimeRepository, SqliteBrokerStateStore, SqliteTaskRuntimeRepository, SqliteWorkerRuntimeRepository } =
      await import(workerData.storeModuleUrl);
    const store = new SqliteBrokerStateStore(workerData.dbFile);
    const taskRepository = new SqliteTaskRuntimeRepository(store);
    const workerRepository = new SqliteWorkerRuntimeRepository(store);
    const auditRepository = new SqliteAuditRuntimeRepository(store, {
      maxHotAuditEvents: 3,
      maxHotHeartbeatAuditEvents: 1,
    });

    function makeTask(input) {
      return {
        id: input.id,
        intent: "chat",
        requester: { id: "operator", kind: "session", role: "operator" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "test-only sqlite worker-thread spike task",
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        payload: { spike: "sqlite-worker-thread" },
        status: input.status,
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: input.updatedAt,
        taskOrigin: "operator",
        ...(input.claimedBy ? { claimedBy: input.claimedBy, claimedAt: input.claimedAt } : {}),
        ...(input.lastHeartbeatAt ? { lastHeartbeatAt: input.lastHeartbeatAt } : {}),
      };
    }

    function makeWorker(input) {
      return {
        nodeId: input.nodeId,
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["openclaw-ops"],
          environments: ["research"],
        },
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: input.lastSeenAt,
        lastSeenAt: input.lastSeenAt,
      };
    }

    function makeAudit(input) {
      return {
        id: input.id,
        actorId: input.actorId ?? "worker-a",
        action: input.action,
        targetType: input.targetType ?? "task",
        targetId: input.targetId,
        note: input.note,
        createdAt: input.createdAt,
      };
    }

    function makeTerminalOutboxEvent(input) {
      const event = {
        id: input.id,
        kind: "task.terminal",
        taskEventId: input.taskEventId,
        payload: {
          taskId: input.taskId,
          status: "succeeded",
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
        receipt: {
          status: "produced",
          updatedAt: input.createdAt,
        },
        attempts: input.attempts ?? 0,
      };
      if (input.acknowledgedAt) {
        event.ack = {
          status: "receipt_confirmed",
          evidence: "operator_visible",
          acknowledgedAt: input.acknowledgedAt,
        };
      }
      return event;
    }

    parentPort.on("message", (message) => {
      try {
        let value;
        if (message.op === "upsertTask") {
          taskRepository.upsertTask(makeTask(message.payload));
          value = taskRepository.getTask(message.payload.id)?.status ?? null;
        } else if (message.op === "getTaskStatus") {
          value = taskRepository.getTask(message.payload.id)?.status ?? null;
        } else if (message.op === "listRunningTaskIds") {
          value = taskRepository
            .listTasks({ status: "running", assignedWorkerId: "worker-a", taskOrigin: "operator" })
            .map((task) => task.id);
        } else if (message.op === "upsertWorker") {
          workerRepository.upsertWorker(makeWorker(message.payload));
          value = workerRepository.getWorker(message.payload.nodeId)?.lastSeenAt ?? null;
        } else if (message.op === "getWorkerLastSeen") {
          value = workerRepository.getWorker(message.payload.nodeId)?.lastSeenAt ?? null;
        } else if (message.op === "appendAudit") {
          auditRepository.appendAuditEvent(makeAudit(message.payload));
          value = auditRepository.listAuditEvents({ targetId: message.payload.targetId }).map((event) => event.id);
        } else if (message.op === "listAuditIds") {
          value = auditRepository
            .listAuditEvents({ action: message.payload.action, targetId: message.payload.targetId })
            .map((event) => event.id);
        } else if (message.op === "saveTerminalOutbox") {
          store.save({
            ...emptySnapshot(),
            terminalOutbox: message.payload.events.map(makeTerminalOutboxEvent),
          });
          value = store.readHotTerminalOutbox().map((event) => ({
            id: event.id,
            acknowledgedAt: event.ack?.acknowledgedAt ?? null,
          }));
        } else if (message.op === "listTerminalOutbox") {
          value = store.readHotTerminalOutbox().map((event) => ({
            id: event.id,
            acknowledgedAt: event.ack?.acknowledgedAt ?? null,
          }));
        } else if (message.op === "close") {
          store.close();
          parentPort.postMessage({ id: message.id, ok: true, value: true });
          parentPort.close();
          return;
        } else {
          throw new Error("unknown_op");
        }
        parentPort.postMessage({ id: message.id, ok: true, value });
      } catch (error) {
        parentPort.postMessage({
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  `;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveDeferred: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  if (!resolveDeferred) {
    throw new Error("deferred resolver was not initialized");
  }
  return { promise, resolve: resolveDeferred };
}

/**
 * Route adapter that explicitly separates the ACK persistence boundary
 * from the error persistence boundary.
 *
 * On success, returns ACK-specific metadata (committedAt timestamp)
 * under the `ack` key — this is the ACK persistence path.
 *
 * On failure, returns error-specific diagnostics under the
 * `errorPersistence` key — this is the error persistence path.
 */
async function runTestOnlyPersistingRoute(
  queue: TestOnlyWriteQueue,
  params: {
    label: string;
    successStatus: number;
    write: () => Promise<unknown> | unknown;
  },
): Promise<TestOnlyRouteBoundaryResult> {
  try {
    const startedAt = new Date().toISOString();
    await queue.enqueue(params.label, params.write);
    return {
      status: params.successStatus,
      body: {
        ok: true,
        ack: {
          committed: true,
          committedAt: startedAt,
          queue: queue.stats(),
        },
      },
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    return {
      status: testOnlyPersistenceHttpStatus(code),
      headers: testOnlyPersistenceRetryHeaders(code),
      body: {
        error: {
          code,
          message: testOnlyPersistenceHttpMessage(code),
        },
        errorPersistence: {
          committed: false,
          retryable: testOnlyPersistenceRetryable(code),
          queue: queue.stats(),
        },
      },
    };
  }
}

function testOnlyPersistenceHttpStatus(code: string): number {
  switch (code) {
    case "queue_saturated":
    case "queue_drain_timeout":
    case "queue_closed":
    case "worker_crashed":
    case "worker_unavailable":
      return 503;
    default:
      return 500;
  }
}

function testOnlyPersistenceRetryHeaders(code: string): Record<string, string> {
  return testOnlyPersistenceRetryable(code) ? { "retry-after": "1" } : {};
}

function testOnlyPersistenceRetryable(code: string): boolean {
  switch (code) {
    case "queue_saturated":
    case "queue_drain_timeout":
    case "queue_closed":
    case "worker_crashed":
    case "worker_unavailable":
      return true;
    default:
      return false;
  }
}

function testOnlyPersistenceHttpMessage(code: string): string {
  switch (code) {
    case "queue_saturated":
      return "broker persistence queue is saturated";
    case "queue_drain_timeout":
      return "broker persistence queue did not drain before timeout";
    case "queue_closed":
      return "broker persistence queue is closing";
    case "worker_crashed":
      return "broker persistence worker crashed before acknowledgement";
    case "worker_unavailable":
      return "broker persistence worker is unavailable";
    default:
      return "broker persistence failed";
  }
}

function withTempSqlite(name: string): {
  filePath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "a2a-sqlite-worker-spike-"));
  return {
    filePath: join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeSpikeTask(
  id: string,
  status: TaskStatus,
  updatedAt = "2026-06-04T00:00:00.000Z",
): TaskRecord {
  return {
    id,
    intent: "chat",
    requester: { id: "operator", kind: "session", role: "operator" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "test-only sqlite worker-thread spike task",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: { spike: "sqlite-worker-thread" },
    status,
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt,
    taskOrigin: "operator",
  };
}

function makeSpikeWorker(nodeId: string, lastSeenAt: string): WorkerRecord {
  return {
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["openclaw-ops"],
      environments: ["research"],
    },
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: lastSeenAt,
    lastSeenAt,
  };
}

function makeSpikeAudit(
  id: string,
  action: AuditEvent["action"],
  targetId: string,
  createdAt: string,
): AuditEvent {
  return {
    id,
    actorId: "worker-a",
    action,
    targetType: action === "worker.heartbeat" ? "worker" : "task",
    targetId,
    createdAt,
  };
}

function makeSpikeTerminalOutboxEvent(
  id: string,
  taskId: string,
  taskEventId: number,
  createdAt: string,
  acknowledgedAt?: string,
): TerminalTaskOutboxEvent {
  return {
    id,
    kind: "task.terminal",
    taskEventId,
    payload: {
      taskId,
      status: "succeeded",
      createdAt,
      updatedAt: createdAt,
    },
    createdAt,
    ...(acknowledgedAt
      ? {
          ack: {
            status: "receipt_confirmed" as const,
            evidence: "operator_visible" as const,
            acknowledgedAt,
          },
        }
      : {}),
    receipt: {
      status: "produced",
      updatedAt: createdAt,
    },
    attempts: 0,
  };
}

test("spike: queued SQLite writes preserve acceptance order when callers await commit", async () => {
  const queue = new TestOnlyWriteQueue(8);
  const committed: string[] = [];

  const writes = [
    queue.enqueue("worker-a heartbeat 1", async () => {
      await nextTick();
      committed.push("worker-a:1");
      return committed.at(-1);
    }),
    queue.enqueue("worker-a heartbeat 2", () => {
      committed.push("worker-a:2");
      return committed.at(-1);
    }),
    queue.enqueue("task-a status", () => {
      committed.push("task-a:running");
      return committed.at(-1);
    }),
  ];

  assert.deepEqual(await Promise.all(writes), ["worker-a:1", "worker-a:2", "task-a:running"]);
  assert.deepEqual(committed, ["worker-a:1", "worker-a:2", "task-a:running"]);
});

test("spike: acknowledged writes provide read-after-write visibility", async () => {
  const queue = new TestOnlyWriteQueue(4);
  const workerLastSeen = new Map<string, string>();

  const firstAck = await queue.enqueue("worker-a heartbeat", () => {
    workerLastSeen.set("worker-a", "2026-06-04T00:00:00.000Z");
    return true;
  });
  assert.equal(firstAck, true);
  assert.equal(workerLastSeen.get("worker-a"), "2026-06-04T00:00:00.000Z");

  const secondAck = await queue.enqueue("worker-a heartbeat", () => {
    workerLastSeen.set("worker-a", "2026-06-04T00:00:30.000Z");
    return true;
  });
  assert.equal(secondAck, true);
  assert.equal(workerLastSeen.get("worker-a"), "2026-06-04T00:00:30.000Z");
});

test("spike: bounded queue fails closed on saturation instead of hiding lost writes", async () => {
  const queue = new TestOnlyWriteQueue(2);
  const blockedWrite = deferred();

  const first = queue.enqueue("slow write", () => blockedWrite.promise);
  const second = queue.enqueue("queued write", () => "ok");

  assert.deepEqual(queue.stats(), {
    capacity: 2,
    queued: 1,
    active: 1,
    inFlight: 2,
    available: 0,
    closing: false,
    aborted: false,
  });
  await assert.rejects(
    queue.enqueue("overflow write", () => "lost"),
    /queue_saturated/,
  );

  blockedWrite.resolve();
  await first;
  assert.equal(await second, "ok");
  assert.deepEqual(queue.stats(), {
    capacity: 2,
    queued: 0,
    active: 0,
    inFlight: 0,
    available: 2,
    closing: false,
    aborted: false,
  });
});

test("spike: write errors reject the mutating caller and later writes can continue", async () => {
  const queue = new TestOnlyWriteQueue(4);
  const committed: string[] = [];

  await assert.rejects(
    queue.enqueue("bad sqlite write", () => {
      throw new Error("sqlite_constraint");
    }),
    /sqlite_constraint/,
  );

  const ok = await queue.enqueue("next write", () => {
    committed.push("after-error");
    return "committed";
  });

  assert.equal(ok, "committed");
  assert.deepEqual(committed, ["after-error"]);
});

test("spike: shutdown drain commits queued writes and rejects new writes", async () => {
  const queue = new TestOnlyWriteQueue(4);
  const committed: string[] = [];

  const first = queue.enqueue("write 1", async () => {
    await nextTick();
    committed.push("one");
  });
  const second = queue.enqueue("write 2", () => {
    committed.push("two");
  });

  await queue.drainAndClose();
  await Promise.all([first, second]);
  assert.deepEqual(committed, ["one", "two"]);
  await assert.rejects(queue.enqueue("after close", () => "late"), /queue_closed/);
});

test("spike: shutdown drain timeout rejects pending writes deterministically", async () => {
  const queue = new TestOnlyWriteQueue(3);
  const blockedWrite = deferred();

  const first = queue.enqueue("slow write", () => blockedWrite.promise);
  const second = queue.enqueue("queued write", () => "should-not-commit");

  await assert.rejects(queue.drainAndClose({ timeoutMs: 0 }), /queue_drain_timeout/);
  assert.deepEqual(queue.stats(), {
    capacity: 3,
    queued: 0,
    active: 1,
    inFlight: 0,
    available: 3,
    closing: true,
    aborted: true,
  });
  await assert.rejects(first, /queue_drain_timeout/);
  await assert.rejects(second, /queue_drain_timeout/);
  await assert.rejects(queue.enqueue("after timeout", () => "late"), /queue_drain_timeout/);

  blockedWrite.resolve();
  await nextTick();
  assert.deepEqual(queue.stats(), {
    capacity: 3,
    queued: 0,
    active: 0,
    inFlight: 0,
    available: 3,
    closing: true,
    aborted: true,
  });
});

test("spike: worker crash rejects in-flight, queued, and future writes", async () => {
  const queue = new TestOnlyWriteQueue(3);
  const blockedWrite = deferred();

  const first = queue.enqueue("in-flight write", () => blockedWrite.promise);
  const queued = queue.enqueue("queued write", () => "should-not-commit");

  const crash = new Error("worker_crashed");
  queue.abort(crash);

  await assert.rejects(queued, /worker_crashed/);
  await assert.rejects(first, /worker_crashed/);
  await assert.rejects(queue.enqueue("future write", () => "nope"), /worker_crashed/);

  blockedWrite.resolve();
  await nextTick();
  assert.deepEqual(queue.stats(), {
    capacity: 3,
    queued: 0,
    active: 0,
    inFlight: 0,
    available: 3,
    closing: true,
    aborted: true,
  });
});

test("spike: broker route adapter waits for durable queue acknowledgement before success", async () => {
  const queue = new TestOnlyWriteQueue(2);
  const blockedWrite = deferred();
  const committed = new Map<string, string>();
  let routeSettled = false;

  const route = runTestOnlyPersistingRoute(queue, {
    label: "worker heartbeat route",
    successStatus: 200,
    write: async () => {
      await blockedWrite.promise;
      committed.set("worker-a", "2026-06-04T00:10:00.000Z");
    },
  }).finally(() => {
    routeSettled = true;
  });

  await nextTick();
  assert.equal(routeSettled, false, "route must not report success before SQLite acknowledgement");
  assert.equal(committed.get("worker-a"), undefined);

  blockedWrite.resolve();
  const routeResult = await route as TestOnlyRouteAckSuccess;
  assert.equal(routeResult.status, 200);
  assert.equal(routeResult.body.ok, true);
  assert.equal(routeResult.body.ack.committed, true);
  assert.ok(routeResult.body.ack.committedAt, "ack must report committedAt timestamp");
  assert.deepEqual(routeResult.body.ack.queue, {
    capacity: 2,
    queued: 0,
    active: 0,
    inFlight: 0,
    available: 2,
    closing: false,
    aborted: false,
  });
  assert.equal(committed.get("worker-a"), "2026-06-04T00:10:00.000Z");
});

test("spike: broker route adapter maps queue backpressure and crash to retryable HTTP failures", async () => {
  const saturatedQueue = new TestOnlyWriteQueue(1);
  const blockedSaturatedWrite = deferred();
  const inFlight = runTestOnlyPersistingRoute(saturatedQueue, {
    label: "slow heartbeat route",
    successStatus: 200,
    write: () => blockedSaturatedWrite.promise,
  });
  await nextTick();

  assert.deepEqual(
    await runTestOnlyPersistingRoute(saturatedQueue, {
      label: "overflow heartbeat route",
      successStatus: 200,
      write: () => "hidden-loss",
    }),
    {
      status: 503,
      headers: { "retry-after": "1" },
      body: {
        error: {
          code: "queue_saturated",
          message: "broker persistence queue is saturated",
        },
        errorPersistence: {
          committed: false,
          retryable: true,
          queue: {
            capacity: 1,
            queued: 0,
            active: 1,
            inFlight: 1,
            available: 0,
            closing: false,
            aborted: false,
          },
        },
      },
    },
  );
  blockedSaturatedWrite.resolve();
  await inFlight;

  const drainQueue = new TestOnlyWriteQueue(1);
  const blockedDrainWrite = deferred();
  const drainingRoute = runTestOnlyPersistingRoute(drainQueue, {
    label: "shutdown heartbeat route",
    successStatus: 200,
    write: () => blockedDrainWrite.promise,
  });
  await nextTick();
  await assert.rejects(drainQueue.drainAndClose({ timeoutMs: 0 }), /queue_drain_timeout/);
  assert.deepEqual(await drainingRoute, {
    status: 503,
    headers: { "retry-after": "1" },
    body: {
      error: {
        code: "queue_drain_timeout",
        message: "broker persistence queue did not drain before timeout",
      },
      errorPersistence: {
        committed: false,
        retryable: true,
        queue: {
          capacity: 1,
          queued: 0,
          active: 1,
          inFlight: 0,
          available: 1,
          closing: true,
          aborted: true,
        },
      },
    },
  });
  blockedDrainWrite.resolve();

  const crashedQueue = new TestOnlyWriteQueue(1);
  crashedQueue.abort(new Error("worker_crashed"));
  assert.deepEqual(
    await runTestOnlyPersistingRoute(crashedQueue, {
      label: "crashed worker route",
      successStatus: 200,
      write: () => "never-committed",
    }),
    {
      status: 503,
      headers: { "retry-after": "1" },
      body: {
        error: {
          code: "worker_crashed",
          message: "broker persistence worker crashed before acknowledgement",
        },
        errorPersistence: {
          committed: false,
          retryable: true,
          queue: {
            capacity: 1,
            queued: 0,
            active: 0,
            inFlight: 0,
            available: 1,
            closing: true,
            aborted: true,
          },
        },
      },
    },
  );
});

test("spike: queued writes against SQLite task repository preserve read-after-write status order", async () => {
  const temp = withTempSqlite("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteTaskRuntimeRepository(store);
    const queue = new TestOnlyWriteQueue(8);

    const queued = await queue.enqueue("task queued", () => {
      repository.upsertTask(makeSpikeTask("task-repository-queue", "queued", "2026-06-04T00:00:00.000Z"));
      return repository.getTask("task-repository-queue")?.status;
    });
    assert.equal(queued, "queued");
    assert.equal(repository.getTask("task-repository-queue")?.status, "queued");

    const claimed = await queue.enqueue("task claimed", () => {
      repository.upsertTask({
        ...makeSpikeTask("task-repository-queue", "claimed", "2026-06-04T00:01:00.000Z"),
        claimedBy: "worker-a",
        claimedAt: "2026-06-04T00:01:00.000Z",
      });
      return repository.getTask("task-repository-queue")?.status;
    });
    assert.equal(claimed, "claimed");
    assert.equal(repository.getTask("task-repository-queue")?.claimedBy, "worker-a");

    const running = await queue.enqueue("task running", () => {
      repository.upsertTask({
        ...makeSpikeTask("task-repository-queue", "running", "2026-06-04T00:02:00.000Z"),
        claimedBy: "worker-a",
        claimedAt: "2026-06-04T00:01:00.000Z",
        lastHeartbeatAt: "2026-06-04T00:02:00.000Z",
      });
      return repository.getTask("task-repository-queue")?.status;
    });

    assert.equal(running, "running");
    assert.deepEqual(
      repository.listTasks({ status: "running", assignedWorkerId: "worker-a", taskOrigin: "operator" }).map((task) => task.id),
      ["task-repository-queue"],
    );
    assert.deepEqual(store.readHotRuntimeSnapshot().tasks.map((task) => [task.id, task.status]), [
      ["task-repository-queue", "running"],
    ]);
    assert.deepEqual(store.load().tasks, [], "test-only queued repository writes stay hot-table native");
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("spike: queued writes against SQLite worker repository fail closed before hidden heartbeat loss", async () => {
  const temp = withTempSqlite("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteWorkerRuntimeRepository(store);
    const queue = new TestOnlyWriteQueue(2);
    const blockedWrite = deferred();

    const first = queue.enqueue("slow worker heartbeat", async () => {
      await blockedWrite.promise;
      repository.upsertWorker(makeSpikeWorker("worker-a", "2026-06-04T00:00:00.000Z"));
      return repository.getWorker("worker-a")?.lastSeenAt;
    });
    const second = queue.enqueue("queued worker heartbeat", () => {
      repository.upsertWorker(makeSpikeWorker("worker-a", "2026-06-04T00:01:00.000Z"));
      return repository.getWorker("worker-a")?.lastSeenAt;
    });

    await assert.rejects(
      queue.enqueue("overflow worker heartbeat", () => {
        repository.upsertWorker(makeSpikeWorker("worker-overflow", "2026-06-04T00:02:00.000Z"));
      }),
      /queue_saturated/,
    );
    assert.equal(repository.getWorker("worker-overflow"), null);

    blockedWrite.resolve();
    assert.equal(await first, "2026-06-04T00:00:00.000Z");
    assert.equal(await second, "2026-06-04T00:01:00.000Z");
    assert.equal(repository.getWorker("worker-a")?.lastSeenAt, "2026-06-04T00:01:00.000Z");
    assert.deepEqual(repository.listWorkers({ workspaceId: "openclaw-ops" }).map((worker) => worker.nodeId), ["worker-a"]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("spike: queued SQLite audit writes preserve heartbeat retention semantics", async () => {
  const temp = withTempSqlite("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteAuditRuntimeRepository(store, {
      maxHotAuditEvents: 4,
      maxHotHeartbeatAuditEvents: 2,
    });
    const queue = new TestOnlyWriteQueue(8);

    for (const [index, createdAt] of [
      "2026-06-04T00:00:00.000Z",
      "2026-06-04T00:01:00.000Z",
      "2026-06-04T00:02:00.000Z",
    ].entries()) {
      await queue.enqueue(`heartbeat audit ${index}`, () => {
        repository.appendAuditEvent(makeSpikeAudit(
          `audit-heartbeat-${index}`,
          "worker.heartbeat",
          "worker-a",
          createdAt,
        ));
      });
    }

    await queue.enqueue("meaningful audit", () => {
      repository.appendAuditEvent(makeSpikeAudit(
        "audit-task-started",
        "task.started",
        "task-a",
        "2026-06-04T00:03:00.000Z",
      ));
    });

    assert.deepEqual(
      repository.listAuditEvents({ action: "worker.heartbeat" }).map((event) => event.id),
      ["worker-heartbeat:worker-a"],
    );
    assert.deepEqual(
      repository.listAuditEvents({ action: "task.started" }).map((event) => event.id),
      ["audit-task-started"],
    );
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("spike: queued terminal-outbox snapshot writes preserve ack state and runtime load cap", async () => {
  const temp = withTempSqlite("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, {
      maxHotRuntimeTerminalOutboxEvents: 2,
    });
    const queue = new TestOnlyWriteQueue(4);

    await queue.enqueue("terminal outbox snapshot", () => {
      store.save({
        ...emptySnapshot(),
        terminalOutbox: [
          makeSpikeTerminalOutboxEvent("outbox-old", "task-old", 1, "2026-06-04T00:00:00.000Z"),
          makeSpikeTerminalOutboxEvent(
            "outbox-acked",
            "task-acked",
            2,
            "2026-06-04T00:01:00.000Z",
            "2026-06-04T00:05:00.000Z",
          ),
          makeSpikeTerminalOutboxEvent("outbox-new", "task-new", 3, "2026-06-04T00:02:00.000Z"),
        ],
      });
    });

    assert.deepEqual(
      store.readHotTerminalOutbox().map((event) => [event.id, event.ack?.acknowledgedAt ?? null]),
      [
        ["outbox-old", null],
        ["outbox-acked", "2026-06-04T00:05:00.000Z"],
        ["outbox-new", null],
      ],
    );
    assert.deepEqual(
      store.readHotRuntimeSnapshot().terminalOutbox?.map((event) => event.id),
      ["outbox-acked", "outbox-new"],
    );
    assert.equal(store.readHotTerminalOutboxDiagnostics().unacked, 2);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("spike: Node worker thread owns disposable SQLite repository and preserves cross-thread read-after-write", async () => {
  const temp = withTempSqlite("state.sqlite");
  const worker = new TestOnlySqliteWorkerThread(temp.filePath);
  try {
    assert.equal(
      await worker.request("upsertTask", {
        id: "task-worker-thread",
        status: "queued",
        updatedAt: "2026-06-04T00:00:00.000Z",
      }),
      "queued",
    );
    assert.equal(await worker.request("getTaskStatus", { id: "task-worker-thread" }), "queued");

    assert.equal(
      await worker.request("upsertTask", {
        id: "task-worker-thread",
        status: "claimed",
        updatedAt: "2026-06-04T00:01:00.000Z",
        claimedBy: "worker-a",
        claimedAt: "2026-06-04T00:01:00.000Z",
      }),
      "claimed",
    );
    assert.equal(
      await worker.request("upsertTask", {
        id: "task-worker-thread",
        status: "running",
        updatedAt: "2026-06-04T00:02:00.000Z",
        claimedBy: "worker-a",
        claimedAt: "2026-06-04T00:01:00.000Z",
        lastHeartbeatAt: "2026-06-04T00:02:00.000Z",
      }),
      "running",
    );

    assert.deepEqual(await worker.request("listRunningTaskIds"), ["task-worker-thread"]);
    assert.equal(
      await worker.request("upsertWorker", {
        nodeId: "worker-thread-a",
        lastSeenAt: "2026-06-04T00:03:00.000Z",
      }),
      "2026-06-04T00:03:00.000Z",
    );
    assert.equal(
      await worker.request("getWorkerLastSeen", { nodeId: "worker-thread-a" }),
      "2026-06-04T00:03:00.000Z",
    );
  } finally {
    await worker.close();
    temp.cleanup();
  }
});

test("spike: acknowledged worker-thread SQLite writes survive worker restart", async () => {
  const temp = withTempSqlite("state.sqlite");
  let worker = new TestOnlySqliteWorkerThread(temp.filePath);
  try {
    assert.equal(
      await worker.request("upsertTask", {
        id: "task-worker-restart",
        status: "running",
        updatedAt: "2026-06-04T00:04:00.000Z",
        claimedBy: "worker-a",
        claimedAt: "2026-06-04T00:01:00.000Z",
        lastHeartbeatAt: "2026-06-04T00:04:00.000Z",
      }),
      "running",
    );

    await worker.terminate();
    await assert.rejects(
      worker.request("getTaskStatus", { id: "task-worker-restart" }),
      /worker_unavailable/,
    );

    worker = new TestOnlySqliteWorkerThread(temp.filePath);
    assert.equal(await worker.request("getTaskStatus", { id: "task-worker-restart" }), "running");
  } finally {
    await worker.close();
    temp.cleanup();
  }
});

test("spike: worker-thread SQLite owner preserves audit retention and terminal-outbox ack state across restart", async () => {
  const temp = withTempSqlite("state.sqlite");
  let worker = new TestOnlySqliteWorkerThread(temp.filePath);
  try {
    assert.deepEqual(
      await worker.request("saveTerminalOutbox", {
        events: [
          {
            id: "outbox-worker-1",
            taskId: "task-worker-1",
            taskEventId: 1,
            createdAt: "2026-06-04T00:02:00.000Z",
          },
          {
            id: "outbox-worker-2",
            taskId: "task-worker-2",
            taskEventId: 2,
            createdAt: "2026-06-04T00:03:00.000Z",
            acknowledgedAt: "2026-06-04T00:04:00.000Z",
          },
        ],
      }),
      [
        { id: "outbox-worker-1", acknowledgedAt: null },
        { id: "outbox-worker-2", acknowledgedAt: "2026-06-04T00:04:00.000Z" },
      ],
    );
    assert.deepEqual(
      await worker.request("appendAudit", {
        id: "audit-worker-heartbeat-1",
        action: "worker.heartbeat",
        targetType: "worker",
        targetId: "worker-thread-a",
        createdAt: "2026-06-04T00:00:00.000Z",
      }),
      ["worker-heartbeat:worker-thread-a"],
    );
    assert.deepEqual(
      await worker.request("appendAudit", {
        id: "audit-worker-heartbeat-2",
        action: "worker.heartbeat",
        targetType: "worker",
        targetId: "worker-thread-a",
        createdAt: "2026-06-04T00:01:00.000Z",
      }),
      ["worker-heartbeat:worker-thread-a"],
    );

    await worker.terminate();
    worker = new TestOnlySqliteWorkerThread(temp.filePath);

    assert.deepEqual(
      await worker.request("listAuditIds", {
        action: "worker.heartbeat",
        targetId: "worker-thread-a",
      }),
      ["worker-heartbeat:worker-thread-a"],
    );
    assert.deepEqual(
      await worker.request("listTerminalOutbox"),
      [
        { id: "outbox-worker-1", acknowledgedAt: null },
        { id: "outbox-worker-2", acknowledgedAt: "2026-06-04T00:04:00.000Z" },
      ],
    );
  } finally {
    await worker.close();
    temp.cleanup();
  }
});
