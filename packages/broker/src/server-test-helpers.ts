/**
 * Shared fixtures/helpers for the per-surface server test files
 * (split from the former monolithic server.test.ts — a2a-nexus#645).
 *
 * Test placement: new server tests go into the per-surface file that owns
 * the route under test — server-a2a-jsonrpc / server-a2a-sse-streams /
 * server-workers-tasks / server-sqlite-readpaths / server-persistence-ack /
 * server-health-diagnostics / server-terminal-brief-gates /
 * server-orchestration-plans / server-dialectic — NOT appended to one big
 * file. Add a new per-surface file when none fits; keep files under ~2,500
 * lines so parallel PRs stop colliding on a shared append point.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createBrokerServer, type BrokerServerOptions } from "./server.js";
import { emptySnapshot, type BrokerStateStore } from "./core/store.js";
import { CreateTaskRequest } from "./core/types.js";

export function createInMemoryStateStore(): BrokerStateStore {
  let snapshot = emptySnapshot();
  return {
    load() {
      return snapshot;
    },
    save(nextSnapshot) {
      snapshot = structuredClone(nextSnapshot);
    },
  };
}

export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolveDeferred: ((value: T) => void) | undefined;
  let rejectDeferred: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  if (!resolveDeferred || !rejectDeferred) {
    throw new Error("deferred promise was not initialized");
  }
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

export async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function startTestServer(options: Partial<BrokerServerOptions> = {}) {
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: createInMemoryStateStore(),
    enforceRequesterIdentity: true,
    // Default tests off unless explicitly enabled so periodic sweeps don't race with
    // assertions about idle broker state.
    staleReaperEnabled: options.staleReaperEnabled ?? false,
    ...options,
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtime,
    close: async () => {
      runtime.server.close();
      runtime.server.closeAllConnections?.();
      await once(runtime.server, "close");
      await runtime.closeWorkerPersistence();
    },
  };
}

export function createTaskRequest(id: string): CreateTaskRequest {
  return {
    id,
    intent: "chat",
    requester: { id: "test-hub", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "test task",
    taskOrigin: "api",
  };
}

export function jsonHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    ...headers,
  };
}

export async function withEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export async function registerTestWorker(
  baseUrl: string,
  nodeId: string,
  role: string,
  edgeSecret?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "x-a2a-requester-id": nodeId,
    "x-a2a-requester-role": role,
  };
  if (edgeSecret) {
    headers["x-a2a-edge-secret"] = edgeSecret;
  }
  const res = await fetch(`${baseUrl}/workers/register`, {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify({
      nodeId,
      role,
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
  if (res.status !== 201) {
    throw new Error(
      `failed to register test worker ${nodeId}: ${res.status} ${await res.text()}`,
    );
  }
}

export interface ParsedSseEvent {
  event: string;
  data: string;
  id?: string;
}

export function parseSseBlock(block: string): ParsedSseEvent | null {
  if (!block.trim()) {
    return null;
  }
  let event = "message";
  let data = "";
  let id: string | undefined;
  let hasEventField = false;
  let hasDataField = false;
  let hasIdField = false;
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      hasEventField = true;
      event = line.slice(line.startsWith("event: ") ? "event: ".length : "event:".length).trim();
    } else if (line.startsWith("data:")) {
      hasDataField = true;
      const fragment = line.slice(line.startsWith("data: ") ? "data: ".length : "data:".length);
      data = data ? `${data}\n${fragment}` : fragment;
    } else if (line.startsWith("id:")) {
      hasIdField = true;
      id = line.slice(line.startsWith("id: ") ? "id: ".length : "id:".length).trim();
    }
  }
  if (!hasEventField && !hasDataField && !hasIdField) {
    return null;
  }
  return { event, data, id };
}

export async function readAllSseEvents(response: Response): Promise<ParsedSseEvent[]> {
  const body = response.body;
  assert.ok(body, "SSE response must have a body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
  }
  buffer += decoder.decode();

  const events: ParsedSseEvent[] = [];
  for (const block of buffer.split(/\n\n/)) {
    const event = parseSseBlock(block);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

export async function readSseEventsUntil(
  response: Response,
  predicate: (events: ParsedSseEvent[]) => boolean,
  timeoutMs = 5_000,
): Promise<ParsedSseEvent[]> {
  const body = response.body;
  assert.ok(body, "SSE response must have a body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: ParsedSseEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() <= deadline) {
      const remainingMs = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for SSE events")), remainingMs);
        }),
      ]);
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block);
        if (event) {
          events.push(event);
          if (predicate(events)) {
            await reader.cancel();
            return events;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error(`timed out waiting for SSE events; received ${events.length}`);
}
