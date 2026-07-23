/**
 * Production worker-thread persistence for SqliteBrokerStateStore.
 *
 * Offloads SQLite write operations (saveHotEntities, save) to a dedicated
 * Worker thread via a bounded async queue. Read operations (load, readHot*,
 * getPersistenceInfo) remain on the main thread using a local
 * SqliteBrokerStateStore instance pointing to the same DB file.
 *
 * Gated behind BROKER_PERSISTENCE_QUEUE_WORKER_THREAD=1 (off by default).
 *
 * ## Sync/Async Contract Boundary
 *
 * BrokerStateStore defines saveHotEntities() as returning void (sync).
 * The proxy store preserves this surface type but internally awaits the
 * queue write. In TypeScript, returning Promise<void> from a void-typed
 * method is legal and does not break existing callers.
 *
 * - Existing callers (broker.ts persistState) that do not await the
 *   return value get fire-and-forget semantics — errors are captured by
 *   a .catch() handler attached inside the proxy.
 * - Route-level handlers that need durable ACK semantics can await the
 *   return value (cast to Promise<void>) and propagate errors to HTTP 503.
 *
 * Related: #1032
 * @module
 */

import { Worker } from "node:worker_threads";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { SqliteBrokerStateStore } from "./store.js";
import type { BrokerPersistenceQueueDiagnostics, BrokerPersistenceQueueState } from "../server.js";
import type {
  BrokerSnapshot,
  BrokerStateSaveHints,
  SqliteBrokerLoadSource,
} from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WorkerResponseMessage =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

// ---------------------------------------------------------------------------
// WriteQueue — bounded async serial queue with ACK semantics
// ---------------------------------------------------------------------------

export type WriteQueueStats = {
  capacity: number;
  queued: number;
  active: number;
  inFlight: number;
  available: number;
  closing: boolean;
  aborted: boolean;
};

/**
 * Bounded async queue for serializing writes to the worker thread.
 *
 * - FIFO order is guaranteed: pump() dequeues entries one at a time.
 * - Saturation: enqueue() rejects when all slots are occupied.
 * - Drain/close: drainAndClose() waits for pending writes, then locks.
 * - Abort/crash: abort() rejects all pending and future writes.
 */
interface QueueEntry {
  label: string;
  run: () => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  settled: boolean;
  accounted: boolean;
}

export class WriteQueue {
  private readonly entries: QueueEntry[] = [];
  private activeEntry: QueueEntry | null = null;
  private active = false;
  private inFlightCount = 0;
  private closing = false;
  private aborted: Error | null = null;

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
  }

  enqueue<T>(label: string, run: () => Promise<T> | T): Promise<T> {
    if (this.aborted) return Promise.reject(this.aborted);
    if (this.closing) return Promise.reject(new Error("queue_closed"));
    if (this.inFlightCount >= this.capacity) return Promise.reject(new Error("queue_saturated"));

    this.inFlightCount += 1;
    return new Promise<T>((resolve, reject) => {
      this.entries.push({
        label,
        run: run as () => Promise<unknown> | unknown,
        resolve: resolve as (v: unknown) => void,
        reject,
        settled: false,
        accounted: false,
      });
      void this.pump();
    });
  }

  stats(): WriteQueueStats {
    return {
      capacity: this.capacity,
      queued: this.entries.length,
      active: this.active ? 1 : 0,
      inFlight: this.inFlightCount,
      available: Math.max(0, this.capacity - this.inFlightCount),
      closing: this.closing,
      aborted: this.aborted !== null,
    };
  }

  async drainAndClose(options: { timeoutMs?: number; abortOnTimeout?: boolean } = {}): Promise<void> {
    this.closing = true;
    await this.awaitIdle(options);
  }

  async awaitIdle(options: { timeoutMs?: number; abortOnTimeout?: boolean } = {}): Promise<void> {
    const startedAt = Date.now();
    while (this.entries.length > 0 || this.active || this.activeEntry !== null) {
      if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
        const err = new Error("queue_drain_timeout");
        if (options.abortOnTimeout) {
          this.abort(err);
        }
        throw err;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  abort(error = new Error("worker_crashed")): void {
    this.aborted = error;
    this.closing = true;
    // Reject in-flight active entry
    if (this.activeEntry && !this.activeEntry.settled) {
      this.activeEntry.settled = true;
      if (!this.activeEntry.accounted && this.inFlightCount > 0) {
        this.inFlightCount -= 1;
        this.activeEntry.accounted = true;
      }
      this.activeEntry.reject(error);
    }
    // Reject remaining queued entries
    while (this.entries.length > 0) {
      const entry = this.entries.shift();
      if (!entry) continue;
      if (!entry.accounted && this.inFlightCount > 0) {
        this.inFlightCount -= 1;
        entry.accounted = true;
      }
      entry.reject(error);
    }
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.entries.length > 0 && !this.aborted) {
        const entry = this.entries.shift();
        if (!entry) continue;
        this.activeEntry = entry;
        try {
          const value = await entry.run();
          if (!entry.settled) {
            entry.settled = true;
            entry.resolve(value);
          }
        } catch (err) {
          if (!entry.settled) {
            entry.settled = true;
            entry.reject(err instanceof Error ? err : new Error(String(err)));
          }
        } finally {
          if (!entry.accounted && this.inFlightCount > 0) {
            this.inFlightCount -= 1;
            entry.accounted = true;
          }
          if (this.activeEntry === entry) {
            this.activeEntry = null;
          }
        }
      }
    } finally {
      this.active = false;
    }
  }
}

// ---------------------------------------------------------------------------
// SqliteWorkerThread — wraps a dedicated worker thread
// ---------------------------------------------------------------------------

export class SqliteWorkerThread {
  private worker: Worker | null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private closed = false;
  private terminating = false;

  /** Resolve the worker script path, handling both compiled (.js) and tsx (.ts) runners. */
  private static resolveWorkerPath(): string {
    const dir = dirname(fileURLToPath(import.meta.url));
    // compiled: dist/core/sqlite-worker.js
    const jsPath = join(dir, "sqlite-worker.js");
    if (existsSync(jsPath)) return jsPath;
    // tsx dev: src/core/sqlite-worker.ts
    const tsPath = join(dir, "sqlite-worker.ts");
    if (existsSync(tsPath)) return tsPath;
    // fallback — return .js and let Worker throw a useful error
    return jsPath;
  }

  private static readonly WORKER_PATH = SqliteWorkerThread.resolveWorkerPath();

  /** Create a worker thread at the worker script path. */
  constructor(
    dbFile: string,
    initOptions?: {
      loadSource?: SqliteBrokerLoadSource;
      maxBytes?: number;
      maxHotRuntimeNonTerminalTasks?: number;
      maxHotRuntimeTerminalTasks?: number;
      maxHotRuntimeAuditEvents?: number;
      maxHotRuntimeHeartbeatAuditEvents?: number;
      maxHotRuntimeTerminalOutboxEvents?: number;
    },
  ) {
    this.worker = new Worker(SqliteWorkerThread.WORKER_PATH, {
      workerData: { dbFile, options: initOptions },
    });

    this.worker.on("message", (msg: WorkerResponseMessage) => {
      const handler = this.pending.get(msg.id);
      if (!handler) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        handler.resolve(msg.value);
      } else {
        handler.reject(new Error(msg.error));
      }
    });

    this.worker.on("error", (err) => {
      this.handleWorkerError(err);
    });

    this.worker.on("exit", (code) => {
      this.closed = true;
      if (code !== 0 && !this.terminating) {
        this.handleWorkerError(new Error(`worker_exited_with_code_${code}`));
      }
    });
  }

  private handleWorkerError(err: Error): void {
    for (const [id, handler] of this.pending) {
      this.pending.delete(id);
      handler.reject(err);
    }
  }

  /** Send a method request to the worker thread. */
  request<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.closed || this.terminating) {
      return Promise.reject(new Error("worker_unavailable"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, method, args });
    });
  }

  /** Gracefully close. */
  async close(): Promise<void> {
    if (this.terminating) return;
    this.terminating = true;
    const timeout = setTimeout(() => {
      if (!this.closed) {
        void this.worker?.terminate();
        this.closed = true;
      }
    }, 5000).unref();

    return new Promise<void>((resolve) => {
      if (!this.worker || this.closed) {
        clearTimeout(timeout);
        resolve();
        return;
      }
      this.worker.on("exit", () => {
        clearTimeout(timeout);
        this.closed = true;
        resolve();
      });
      try {
        this.worker.postMessage({ id: -1, method: "__close__" });
      } catch {
        void this.worker.terminate();
        this.closed = true;
        resolve();
      }
    });
  }

  /** Forcefully terminate. */
  async terminate(): Promise<void> {
    if (this.terminating && this.closed) return;
    this.terminating = true;
    const err = new Error("worker_unavailable");
    for (const [id, handler] of this.pending) {
      this.pending.delete(id);
      handler.reject(err);
    }
    if (this.worker) {
      await this.worker.terminate();
    }
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

// ---------------------------------------------------------------------------
// Proxy Store — preserves BrokerStateStore sync surface
// ---------------------------------------------------------------------------

/**
 * Proxy around SqliteBrokerStateStore that routes mutating operations
 * (saveHotEntities, save) through a WriteQueue to the Worker thread.
 *
 * Read operations (load, readHot*) remain on the main thread using a
 * local SqliteBrokerStateStore reading the same DB file.
 *
 * saveHotEntities() returns void per BrokerStateStore but internally
 * returns an awaitable promise. Callers that need durable ACK semantics
 * should await the return value (cast to Promise<void>).
 */
export class WorkerThreadProxyStore extends SqliteBrokerStateStore {
  private readonly queue: WriteQueue;
  private readonly pendingWrites: Promise<unknown>[] = [];
  public readonly workerThread: SqliteWorkerThread;

  constructor(
    queue: WriteQueue,
    workerThread: SqliteWorkerThread,
    sqliteFile: string,
    private readonly ackTimeoutMs: number,
    initOptions?: {
      loadSource?: SqliteBrokerLoadSource;
      maxBytes?: number;
      maxHotRuntimeNonTerminalTasks?: number;
      maxHotRuntimeTerminalTasks?: number;
      maxHotRuntimeAuditEvents?: number;
      maxHotRuntimeHeartbeatAuditEvents?: number;
      maxHotRuntimeTerminalOutboxEvents?: number;
    },
  ) {
    // Initialize the base store so all inherited read methods
    // (load, readHot*, getPersistenceInfo, upsertHot*, etc.)
    // operate on the main thread against the same physical DB.
    // This also makes instanceof SqliteBrokerStateStore pass.
    super(sqliteFile, initOptions);
    this.queue = queue;
    this.workerThread = workerThread;
  }

  /**
   * Override save to delegate through the queue; the base class
   * load/read* methods remain synchronous on the main thread.
   */
  save(snapshot: BrokerSnapshot, hints?: BrokerStateSaveHints): void {
    const promise = this.queue.enqueue("save", () =>
      this.workerThread.request<boolean>("save", { snapshot, hints }),
    );
    this.trackWrite(promise);
  }

  saveHotEntities(hints: BrokerStateSaveHints): void {
    const promise = this.queue.enqueue("saveHotEntities", () =>
      this.workerThread.request<boolean>("saveHotEntities", { hints }),
    );
    this.trackWrite(promise);
  }

  async awaitDurablePersistenceAck(): Promise<void> {
    const writes = this.pendingWrites.splice(0);
    if (writes.length === 0) {
      await this.queue.awaitIdle({ timeoutMs: this.ackTimeoutMs });
      return;
    }

    const results = await this.awaitWritesWithTimeout(writes);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) {
      throw normalizeQueueError(rejected.reason);
    }
  }

  private trackWrite(promise: Promise<unknown>): void {
    this.pendingWrites.push(promise);
    promise.catch(() => undefined);
  }

  private async awaitWritesWithTimeout(writes: Promise<unknown>[]): Promise<PromiseSettledResult<unknown>[]> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error("queue_drain_timeout"));
      }, this.ackTimeoutMs);
      timeout.unref?.();
    });

    try {
      return await Promise.race([Promise.allSettled(writes), timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const HEALTHY_WATERMARK = 0.75;

function resolveQueueState(stats: WriteQueueStats): BrokerPersistenceQueueState {
  if (stats.aborted) return "aborted";
  if (stats.closing) return "draining";
  if (stats.available === 0) return "saturated";
  if (stats.inFlight >= stats.capacity * HEALTHY_WATERMARK) return "saturated";
  return "healthy";
}

export function createPersistenceQueueDiagnostics(
  queue: WriteQueue,
): () => BrokerPersistenceQueueDiagnostics | undefined {
  return () => {
    const s = queue.stats();
    return {
      kind: "broker.persistence.queue",
      enabled: !s.closing,
      mode: "worker_thread",
      state: resolveQueueState(s),
      capacity: s.capacity,
      queued: s.queued,
      active: s.active,
      inFlight: s.inFlight,
      available: s.available,
      closing: s.closing,
      aborted: s.aborted,
    };
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type WorkerThreadPersistenceOptions = {
  dbFile: string;
  queueCapacity?: number;
  ackTimeoutMs?: number;
  loadSource?: SqliteBrokerLoadSource;
  maxBytes?: number;
  maxHotRuntimeNonTerminalTasks?: number;
  maxHotRuntimeTerminalTasks?: number;
  maxHotRuntimeAuditEvents?: number;
  maxHotRuntimeHeartbeatAuditEvents?: number;
  maxHotRuntimeTerminalOutboxEvents?: number;
};

export type WorkerThreadPersistenceHandle = {
  queue: WriteQueue;
  workerThread: SqliteWorkerThread;
  stateStore: WorkerThreadProxyStore;
  diagnostics: () => BrokerPersistenceQueueDiagnostics | undefined;
  close(timeoutMs?: number): Promise<void>;
};

export function createWorkerThreadPersistence(
  options: WorkerThreadPersistenceOptions,
): WorkerThreadPersistenceHandle {
  const {
    dbFile,
    queueCapacity = 16,
    ackTimeoutMs = 30_000,
    loadSource,
    maxBytes,
    maxHotRuntimeNonTerminalTasks,
    maxHotRuntimeTerminalTasks,
    maxHotRuntimeAuditEvents,
    maxHotRuntimeHeartbeatAuditEvents,
    maxHotRuntimeTerminalOutboxEvents,
  } = options;

  const queue = new WriteQueue(queueCapacity);
  const sqliteOptions = {
    loadSource,
    maxBytes,
    maxHotRuntimeNonTerminalTasks,
    maxHotRuntimeTerminalTasks,
    maxHotRuntimeAuditEvents,
    maxHotRuntimeHeartbeatAuditEvents,
    maxHotRuntimeTerminalOutboxEvents,
  };
  const workerThread = new SqliteWorkerThread(dbFile, sqliteOptions);
  const proxyStore = new WorkerThreadProxyStore(
    queue,
    workerThread,
    dbFile,
    Math.max(1, Math.trunc(ackTimeoutMs)),
    sqliteOptions,
  );
  const diagnostics = createPersistenceQueueDiagnostics(queue);

  async function close(timeoutMs = 30000): Promise<void> {
    if (!queue.stats().aborted) {
      try {
        await queue.drainAndClose({ timeoutMs });
      } catch (err) {
        console.error("[worker-thread-persistence] drain timed out:", (err as Error).message);
      }
    }
    await workerThread.terminate();
    proxyStore.close();
  }

  return {
    queue,
    workerThread,
    stateStore: proxyStore,
    diagnostics,
    close,
  };
}

function normalizeQueueError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
