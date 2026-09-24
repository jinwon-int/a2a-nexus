import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "../core/broker.js";
import { executeA2AJsonRpc, type ExecuteJsonRpcOptions, type JsonRpcSuccess, type JsonRpcFailure } from "./json-rpc.js";
import {
  PEER_STATUS_VERBOSE_SCOPE,
  PeerStatusService,
  type PeerStatusResponse,
  type PeerStatusError,
} from "./peer-status.js";
import { createBrokerAgentCard } from "./agent-card.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createBroker(): InMemoryA2ABroker {
  return new InMemoryA2ABroker();
}

function registerWorker(broker: InMemoryA2ABroker, nodeId: string): void {
  broker.registerWorker({
    nodeId,
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
}

const defaultAgentCard = createBrokerAgentCard({
  serviceName: "test-broker",
  publicBaseUrl: "https://broker.test/",
});

function createJsonRpcOptions(
  broker: InMemoryA2ABroker,
  overrides?: Partial<ExecuteJsonRpcOptions>,
): ExecuteJsonRpcOptions {
  const peerStatusService = new PeerStatusService(broker);
  return {
    broker,
    agentCard: defaultAgentCard,
    requesterIdentity: { id: "caller-node", kind: "node", role: "hub" },
    enforceRequesterIdentity: true,
    peerStatusService,
    ...overrides,
  };
}

function peerStatusRpc(
  options: ExecuteJsonRpcOptions,
  target: string,
  maxCacheAgeMs?: number,
): JsonRpcSuccess | JsonRpcFailure {
  return executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "a2a.peer.status",
      params: { target, maxCacheAgeMs },
    },
    options,
  );
}

function isPeerStatusResponse(v: unknown): v is PeerStatusResponse {
  return typeof v === "object" && v !== null && "health" in v && "target" in v;
}

function isPeerStatusError(v: unknown): v is PeerStatusError {
  return typeof v === "object" && v !== null && "errorCode" in v;
}

// ---------------------------------------------------------------------------
// Tests: Basic status computation
// ---------------------------------------------------------------------------

test("PeerStatus returns ok for a registered worker", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options = createJsonRpcOptions(broker);

  const result = peerStatusRpc(options, "worker-a");
  assert.ok("result" in result, "should be a success response");
  if (!("result" in result)) return;

  const data = result.result as PeerStatusResponse;
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.target, "worker-a");
  assert.equal(data.health, "ok");
  assert.equal(data.gateway.reachable, true);
  assert.equal(data.worker.registered, true);
});

test("legacy PeerStatus alias remains available only as a deprecated compatibility path", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options = createJsonRpcOptions(broker);

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "PeerStatus",
      params: { target: "worker-a" },
    },
    options,
  );

  assert.ok("result" in result, "legacy alias should still work during deprecation window");
  if (!("result" in result)) return;
  const data = result.result as PeerStatusResponse;
  assert.equal(data.target, "worker-a");
  assert.equal(data.health, "ok");
});

test("PeerStatus returns target_unknown for unregistered worker", () => {
  const broker = createBroker();
  const options = createJsonRpcOptions(broker);

  const result = peerStatusRpc(options, "ghost-node");
  assert.ok("error" in result, "should be an error response");
  if (!("error" in result)) return;
  assert.equal((result.error?.data as Record<string, unknown>)?.brokerCode, "target_unknown");
});

test("PeerStatus returns unauthenticated without caller identity", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options = createJsonRpcOptions(broker, {
    requesterIdentity: null,
    enforceRequesterIdentity: true,
  });

  const result = peerStatusRpc(options, "worker-a");
  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.equal((result.error?.data as Record<string, unknown>)?.brokerCode, "unauthenticated");
});

test("PeerStatus denies verbose queries without explicit scope", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options = createJsonRpcOptions(broker);

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "a2a.peer.status",
      params: { target: "worker-a", verbose: true },
    },
    options,
  );
  assert.ok("error" in result, "should be an error response");
  if (!("error" in result)) return;

  assert.equal(result.error.code, -32003);
  assert.equal((result.error?.data as Record<string, unknown>)?.brokerCode, "scope_denied");
  assert.equal((result.error?.data as Record<string, unknown>)?.requiredScope, PEER_STATUS_VERBOSE_SCOPE);
});

test("PeerStatus accepts verbose queries with explicit scope", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options = createJsonRpcOptions(broker, {
    requesterIdentity: {
      id: "caller-node",
      kind: "node",
      role: "hub",
      scopes: [PEER_STATUS_VERBOSE_SCOPE],
    },
  });

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "a2a.peer.status",
      params: { target: "worker-a", verbose: true },
    },
    options,
  );
  assert.ok("result" in result, "should be a success response");
  if (!("result" in result)) return;

  const data = result.result as PeerStatusResponse;
  assert.equal(data.target, "worker-a");
  assert.equal(data.health, "ok");
});

test("PeerStatus returns method not found without peerStatusService", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options: ExecuteJsonRpcOptions = {
    broker,
    agentCard: defaultAgentCard,
    requesterIdentity: { id: "caller", kind: "node", role: "hub" },
    enforceRequesterIdentity: true,
    // No peerStatusService
  };

  const result = peerStatusRpc(options, "worker-a");
  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.equal(result.error?.code, -32601);
});

// ---------------------------------------------------------------------------
// Tests: Health states
// ---------------------------------------------------------------------------

test("health is unreachable when worker is not registered", () => {
  const broker = createBroker();
  const service = new PeerStatusService(broker);

  // The service can compute status for any target, even unregistered ones.
  // In JSON-RPC this would be caught by the target_unknown check,
  // but the service itself can handle it.
  const result = service.query({ target: "unknown" }, "caller");
  assert.ok(isPeerStatusResponse(result));
  assert.equal((result as PeerStatusResponse).health, "unreachable");
});

test("health is ok for a fresh registered worker with no tasks", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker);

  const result = service.query({ target: "worker-a" }, "caller");
  assert.ok(isPeerStatusResponse(result));
  assert.equal((result as PeerStatusResponse).health, "ok");
});

// ---------------------------------------------------------------------------
// Tests: Cache behavior
// ---------------------------------------------------------------------------

test("cache serves result within TTL", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  // Fake clock (#2257 B5): the old assertion `cacheAgeMs <= 10` raced the wall
  // clock and evicted a merge-queue group on a slow runner. It also could not
  // tell a cache hit from a recompute, because a fresh compute reports 0 too.
  // Advancing an injected clock makes the age exact and proves the hit.
  let clock = 1_000_000;
  const service = new PeerStatusService(broker, { cacheTtlMs: 5000, now: () => clock });

  // First query: fresh compute
  const first = service.query({ target: "worker-a" }, "caller");
  assert.ok(isPeerStatusResponse(first));
  assert.equal((first as PeerStatusResponse).cacheAgeMs, 0);

  // Second query 100 ms later (still inside the 5 s TTL): served from cache,
  // and the reported age is exactly the elapsed fake time.
  clock += 100;
  const second = service.query({ target: "worker-a" }, "caller");
  assert.ok(isPeerStatusResponse(second));
  assert.equal((second as PeerStatusResponse).cacheAgeMs, 100, "cache hit must report the exact elapsed age");

  // Past the TTL: recomputed, age resets to 0.
  clock += 5_000;
  const third = service.query({ target: "worker-a" }, "caller");
  assert.ok(isPeerStatusResponse(third));
  assert.equal((third as PeerStatusResponse).cacheAgeMs, 0, "expired entry must be recomputed");
});

test("a configured cacheTtlMs is honored when no per-request override is given (a2a-nexus#573 item 17)", async () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  // cacheTtlMs: 0 means "never serve from cache". Previously the constructor
  // option was ignored and the default 5s TTL was always used, so this entry
  // would have been served stale.
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  service.query({ target: "worker-a" }, "caller"); // populate cache
  await new Promise((resolve) => setTimeout(resolve, 8));
  const result = service.query({ target: "worker-a" }, "caller");
  assert.ok(isPeerStatusResponse(result));
  assert.equal(
    (result as PeerStatusResponse).cacheAgeMs,
    0,
    "cacheTtlMs=0 must recompute rather than serve an 8ms-old cache entry",
  );
});

test("maxCacheAgeMs=0 forces fresh computation", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 5000 });

  // First query to populate cache
  service.query({ target: "worker-a" }, "caller");

  // Force recompute with maxCacheAgeMs=0
  const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(result));
  assert.equal((result as PeerStatusResponse).cacheAgeMs, 0);
});

// ---------------------------------------------------------------------------
// Tests: Rate limiting
// ---------------------------------------------------------------------------

test("rate limiting blocks after exceeding limit", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 }); // Force recomputes

  const limit = 25; // RATE_LIMIT(20) + RATE_BURST(5)
  let rateLimited = false;

  for (let i = 0; i < limit + 5; i++) {
    const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller");
    if (isPeerStatusError(result) && result.errorCode === "rate_limited") {
      rateLimited = true;
      assert.ok(result.retryAfterMs !== undefined);
      assert.ok(result.retryAfterMs! > 0);
      break;
    }
  }

  assert.ok(rateLimited, "should eventually be rate limited");
});

test("rate limiting is per (caller, target) pair", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  // Saturate caller→worker-a
  for (let i = 0; i < 30; i++) {
    service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller-1");
  }

  // caller-1 → worker-a should be rate limited
  const blocked = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller-1");
  assert.ok(isPeerStatusError(blocked), "caller-1→worker-a should be rate limited");

  // But caller-2 → worker-a should still work
  const allowed = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller-2");
  assert.ok(isPeerStatusResponse(allowed), "caller-2→worker-a should not be rate limited");

  // And caller-1 → worker-b should still work
  const allowed2 = service.query({ target: "worker-b", maxCacheAgeMs: 0 }, "caller-1");
  assert.ok(isPeerStatusResponse(allowed2), "caller-1→worker-b should not be rate limited");
});

// ---------------------------------------------------------------------------
// Tests: Privacy
// ---------------------------------------------------------------------------

test("default summary response stays allow-listed and contains no sensitive fields", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker);

  const result = service.query({ target: "worker-a" }, "caller");
  assert.ok(isPeerStatusResponse(result));

  const response = result as PeerStatusResponse;
  assert.deepEqual(
    Object.keys(response).sort(),
    ["cacheAgeMs", "gateway", "health", "observedAt", "rateLimit", "schemaVersion", "target", "tasks", "worker"],
  );
  assert.ok(
    Object.keys(response.gateway).every((key) => ["reachable", "version", "mode"].includes(key)),
    "gateway shape should stay within the read-only summary contract",
  );
  assert.ok(
    Object.keys(response.worker).every((key) => ["registered", "lastHeartbeatAt", "capacity"].includes(key)),
    "worker shape should stay within the read-only summary contract",
  );
  assert.deepEqual(Object.keys(response.tasks).sort(), ["active", "queued", "stale"]);

  const responseStr = JSON.stringify(result);

  // These should never appear
  const forbidden = [
    "message", "promptTokens", "completionTokens", "costUsd", "exchangeId", "taskId", "contextId",
    "sessionId", "sessionLabel", "transcript",
    "toolCall", "toolResult", "prompt", "systemPrompt",
    "memory", "telegram", "password", "token", "secret",
    "userId", "username",
  ];

  for (const field of forbidden) {
    assert.ok(
      !responseStr.includes(field),
      `response should not contain "${field}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Tests: Task counts
// ---------------------------------------------------------------------------

test("task counts reflect broker state", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "hub-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  // Create some tasks
  broker.createTask({
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "test task 1",
  });

  broker.createTask({
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "test task 2",
  });

  const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(result));

  const response = result as PeerStatusResponse;
  assert.equal(response.tasks.queued, 2);
  assert.equal(response.tasks.active, 0);
  assert.equal(response.tasks.stale, 0);
});

// ---------------------------------------------------------------------------
// Tests: Global recompute cap (light)
// ---------------------------------------------------------------------------

test("service handles multiple queries without errors", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  for (let i = 0; i < 10; i++) {
    const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, `caller-${i}`);
    assert.ok(
      isPeerStatusResponse(result) || isPeerStatusError(result),
      "should return valid result",
    );
  }
});

// ---------------------------------------------------------------------------
// Tests: Busy state
// ---------------------------------------------------------------------------

test("health is busy when all capacity slots are occupied", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "hub-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  // Create 10 tasks (default slot count for persistent worker)
  for (let i = 0; i < 10; i++) {
    broker.createTask({
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: `test task ${i}`,
    });
  }

  const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(result));
  const response = result as PeerStatusResponse;
  assert.equal(response.health, "busy");
  assert.equal(response.worker.capacity?.slotsTotal, 10);
  assert.equal(response.worker.capacity?.slotsBusy, 10);
});

test("health is ok when some capacity remains", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "hub-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  // Create only 5 tasks (half capacity)
  for (let i = 0; i < 5; i++) {
    broker.createTask({
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: `test task ${i}`,
    });
  }

  const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(result));
  const response = result as PeerStatusResponse;
  assert.equal(response.health, "ok");
  assert.equal(response.worker.capacity?.slotsTotal, 10);
  assert.equal(response.worker.capacity?.slotsBusy, 5);
});

// ---------------------------------------------------------------------------
// Tests: Worker modes (unified read-only retirement, a2a-nexus#2065)
// ---------------------------------------------------------------------------

/** Register a worker for common-window boundary coverage (mode distinction retired, #2065). */
function registerWindowWorker(
  broker: InMemoryA2ABroker,
  nodeId: string,
): void {
  broker.registerWorker({
    nodeId,
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
}

/** Overwrite a worker's heartbeat timestamp (ISO string) directly. */
function setLastSeenAt(broker: InMemoryA2ABroker, nodeId: string, value: string): void {
  const worker = broker.getWorker(nodeId);
  assert.ok(worker !== null, `worker ${nodeId} must be registered`);
  (worker as unknown as Record<string, unknown>).lastSeenAt = value;
}

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

function createWindowBroker(): InMemoryA2ABroker {
  const broker = createBroker();
  registerWindowWorker(broker, "worker-persistent");
  registerWindowWorker(broker, "worker-mobile");
  registerWindowWorker(broker, "worker-absent");
  return broker;
}

test("offline boundary is 90000ms online / 90001ms stale for every registered worker (#2065)", (t) => {
  const broker = createWindowBroker();
  for (const nodeId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    setLastSeenAt(broker, nodeId, new Date(BASE_MS).toISOString());
  }
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  // One frozen clock read feeds both observedAt and the worker-view staleness
  // computation, so boundary ages are exact.
  let now = BASE_MS;
  t.mock.method(Date, "now", () => now);

  // Exactly DEFAULT_WORKER_OFFLINE_AFTER_MS (90_000) old: still online.
  now = BASE_MS + 90_000;
  for (const nodeId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    const atBoundary = service.query({ target: nodeId, maxCacheAgeMs: 0 }, "caller");
    assert.ok(isPeerStatusResponse(atBoundary), `${nodeId}: response expected at age 90000ms`);
    assert.equal((atBoundary as PeerStatusResponse).health, "ok", `${nodeId}: age 90000ms remains online`);
    assert.equal(
      (atBoundary as PeerStatusResponse).observedAt,
      BASE_MS + 90_000,
      `${nodeId}: observedAt uses the frozen clock`,
    );
  }

  // One ms past the window: stale for every mode.
  now = BASE_MS + 90_001;
  for (const nodeId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    const pastBoundary = service.query({ target: nodeId, maxCacheAgeMs: 0 }, "caller");
    assert.ok(isPeerStatusResponse(pastBoundary), `${nodeId}: response expected at age 90001ms`);
    assert.equal((pastBoundary as PeerStatusResponse).health, "stale", `${nodeId}: age 90001ms is stale`);
  }
});

test("with the common workerOfflineAfterMs present, every worker uses it (#2065)", (t) => {
  const broker = createWindowBroker();
  for (const nodeId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    setLastSeenAt(broker, nodeId, new Date(BASE_MS).toISOString());
  }
  const service = new PeerStatusService(broker, { cacheTtlMs: 0, workerOfflineAfterMs: 45_000 });

  let now = BASE_MS;
  t.mock.method(Date, "now", () => now);

  now = BASE_MS + 45_000;
  for (const nodeId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    const atBoundary = service.query({ target: nodeId, maxCacheAgeMs: 0 }, "caller");
    assert.equal((atBoundary as PeerStatusResponse).health, "ok", `${nodeId}: age 45000ms remains online`);
  }

  now = BASE_MS + 45_001;
  for (const nodeId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    const pastBoundary = service.query({ target: nodeId, maxCacheAgeMs: 0 }, "caller");
    assert.equal((pastBoundary as PeerStatusResponse).health, "stale", `${nodeId}: age 45001ms is stale`);
  }
});

test("with no options, every worker uses the common 90000ms default — no synthesized 30000ms mobile window (#2065)", (t) => {
  const broker = createWindowBroker();
  for (const nodeId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    setLastSeenAt(broker, nodeId, new Date(BASE_MS).toISOString());
  }
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  let now = BASE_MS;
  t.mock.method(Date, "now", () => now);

  // Previously a mobile worker would be stale at this age (30s default).
  now = BASE_MS + 30_001;
  for (const nodeId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    const result = service.query({ target: nodeId, maxCacheAgeMs: 0 }, "caller");
    assert.equal((result as PeerStatusResponse).health, "ok", `${nodeId}: age 30001ms remains online without any option`);
  }

  now = BASE_MS + 90_000;
  for (const nodeId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    const atBoundary = service.query({ target: nodeId, maxCacheAgeMs: 0 }, "caller");
    assert.equal((atBoundary as PeerStatusResponse).health, "ok", `${nodeId}: age 90000ms remains online`);
  }

  now = BASE_MS + 90_001;
  for (const nodeId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    const pastBoundary = service.query({ target: nodeId, maxCacheAgeMs: 0 }, "caller");
    assert.equal((pastBoundary as PeerStatusResponse).health, "stale", `${nodeId}: age 90001ms is stale`);
  }
});

test("workerOfflineAfterMs: 0 classifies every worker stale regardless of age (#2065)", (t) => {
  const broker = createWindowBroker();
  for (const id of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    setLastSeenAt(broker, id, new Date(BASE_MS).toISOString());
  }
  let now = BASE_MS + 1;
  t.mock.method(Date, "now", () => now);
  const service = new PeerStatusService(broker, { cacheTtlMs: 0, workerOfflineAfterMs: 0 });
  for (const id of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    const result = service.query({ target: id }, "caller") as PeerStatusResponse;
    assert.equal(result.health, "stale", `${id}: zero offline window is immediately stale`);
  }
});

test("dashboard and capacity projections share the common window with peer and raw worker views (#2065)", (t) => {
  const broker = createWindowBroker();
  setLastSeenAt(broker, "worker-mobile", new Date(BASE_MS).toISOString());
  t.mock.method(Date, "now", () => BASE_MS + 45_000);
  const peer = new PeerStatusService(broker).query({ target: "worker-mobile" }, "caller") as PeerStatusResponse;
  assert.equal(peer.health, "ok");
  assert.equal(broker.getWorkerView("worker-mobile", 90_000)?.status, "online");
  const dashboard = broker.getDashboard().workers.byNode.find((row) => row.nodeId === "worker-mobile");
  const capacity = broker.getWorkerCapacitySummary().items.find((row) => row.nodeId === "worker-mobile");
  // The retired mode-aware ladder classified this row stale at 45s (30s
  // mobile window) and synthesized mobileHealth: "stale". Every read-only
  // surface now agrees on the common 90s window and no mobileHealth field.
  assert.equal(dashboard?.status, "online", "dashboard projection uses the common 90s window at 45s");
  assert.equal(capacity?.status, "online", "capacity projection uses the common 90s window at 45s");
  assert.ok(dashboard && !("mobileHealth" in dashboard), "dashboard rows no longer synthesize mobileHealth");
  assert.ok(capacity && !("mobileHealth" in capacity), "capacity rows no longer synthesize mobileHealth");
});

test("invalid heartbeat timestamps still classify as stale on this peer view (preserved behavior)", (t) => {
  const broker = createWindowBroker();
  setLastSeenAt(broker, "worker-mobile", "not-a-timestamp");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  let now = BASE_MS;
  t.mock.method(Date, "now", () => now);

  const result = service.query({ target: "worker-mobile", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(result));
  assert.equal(
    (result as PeerStatusResponse).health,
    "stale",
    "an unparseable heartbeat stays stale on the actual peer view (isWorkerStale semantics elsewhere are unchanged)",
  );
});

test("worker reports the unified advisory slot total (10) instead of 3 (#2065)", () => {
  const broker = createBroker();
  registerWindowWorker(broker, "mobile-node");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  const result = service.query({ target: "mobile-node", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(result));
  const response = result as PeerStatusResponse;
  assert.equal(response.worker.capacity?.slotsTotal, 10);
  assert.equal(response.worker.capacity?.slotsBusy, 0);
});

test("workers are not busy at 3 tasks and busy at the unified 10-slot advisory threshold (#2065)", (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const broker = createWindowBroker();
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  // 3 tasks each: the old mobile-3 advisory budget would report busy; the
  // unified advisory telemetry reports ok with 3 of 10 advisory slots used.
  for (const targetId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    for (let i = 0; i < 3; i++) {
      broker.createTask({
        intent: "chat",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: targetId, kind: "node", role: "analyst" },
        assignedWorkerId: targetId,
        message: `queued task ${i} for ${targetId}`,
      });
    }
  }

  for (const targetId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    const notBusy = service.query({ target: targetId, maxCacheAgeMs: 0 }, "caller");
    assert.ok(isPeerStatusResponse(notBusy), `${targetId}: response expected`);
    const notBusyView = notBusy as PeerStatusResponse;
    assert.equal(notBusyView.health, "ok", `${targetId}: 3 queued tasks are not busy under the unified advisory budget`);
    assert.equal(notBusyView.worker.capacity?.slotsTotal, 10);
    assert.equal(notBusyView.worker.capacity?.slotsBusy, 3);
  }

  // 10 queued tasks each: queued-only work occupies the advisory budget, so
  // every mode reports busy identically.
  now += 1; // A zero-TTL cached view is still valid within the same millisecond.
  for (const targetId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    for (let i = 3; i < 10; i++) {
      broker.createTask({
        intent: "chat",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: targetId, kind: "node", role: "analyst" },
        assignedWorkerId: targetId,
        message: `queued task ${i} for ${targetId}`,
      });
    }
  }

  for (const targetId of ["worker-persistent", "worker-mobile", "worker-absent"]) {
    const busy = service.query({ target: targetId, maxCacheAgeMs: 0 }, "caller");
    assert.ok(isPeerStatusResponse(busy), `${targetId}: response expected`);
    const busyView = busy as PeerStatusResponse;
    assert.equal(busyView.health, "busy", `${targetId}: 10 queued tasks fill the advisory budget`);
    assert.equal(busyView.worker.capacity?.slotsBusy, 10);
  }
});

test("worker with default registration has standard capacity", () => {
  const broker = createBroker();
  broker.registerWorker({
    nodeId: "server-node",
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
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  const result = service.query({ target: "server-node" }, "caller");
  assert.ok(isPeerStatusResponse(result));
  const response = result as PeerStatusResponse;
  assert.equal(response.worker.capacity?.slotsTotal, 10);
});

test("health priority: stale beats busy when worker heartbeat is old", () => {
  const broker = createBroker();
  broker.registerWorker({
    nodeId: "busy-node",
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
  broker.registerWorker({
    nodeId: "hub-a",
    role: "hub",
    capabilities: {
      canAnalyze: false,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });

  // Fill all slots
  for (let i = 0; i < 10; i++) {
    broker.createTask({
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "busy-node", kind: "node", role: "analyst" },
      assignedWorkerId: "busy-node",
      message: `test task ${i}`,
    });
  }

  // Without stale worker, it's busy
  const serviceFresh = new PeerStatusService(broker, { cacheTtlMs: 0, workerOfflineAfterMs: 90_000 });
  const freshResult = serviceFresh.query({ target: "busy-node", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(freshResult));
  assert.equal((freshResult as PeerStatusResponse).health, "busy");

  // Set the worker's lastSeenAt far in the past to simulate stale heartbeat
  const busyWorker = broker.getWorker("busy-node");
  assert.ok(busyWorker !== null);
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  (busyWorker as any).lastSeenAt = oneHourAgo;

  // Now stale beats busy
  const serviceStale = new PeerStatusService(broker, { cacheTtlMs: 0, workerOfflineAfterMs: 90_000 });
  const staleResult = serviceStale.query({ target: "busy-node", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(staleResult));
  assert.equal((staleResult as PeerStatusResponse).health, "stale");
});

// ---------------------------------------------------------------------------
// Tests: JSON-RPC integration
// ---------------------------------------------------------------------------

test("PeerStatus via JSON-RPC returns proper structure", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options = createJsonRpcOptions(broker);

  const result = peerStatusRpc(options, "worker-a");
  assert.ok("result" in result);
  if (!("result" in result)) return;

  const data = result.result as PeerStatusResponse;
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.target, "worker-a");
  assert.equal(typeof data.observedAt, "number");
  assert.equal(typeof data.cacheAgeMs, "number");
  assert.ok(data.gateway);
  assert.ok(data.worker);
  assert.ok(data.tasks);
  assert.ok(data.health);
  assert.ok(data.rateLimit);
});

test("PeerStatus via JSON-RPC with missing target returns error", () => {
  const broker = createBroker();
  const options = createJsonRpcOptions(broker);

  const result = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "a2a.peer.status", params: {} },
    options,
  );
  assert.ok("error" in result);
  if (!("error" in result)) return;
});

// ---------------------------------------------------------------------------
// Tests: bounded cache / rate-bucket maps (a2a-nexus#573 item 14)
// ---------------------------------------------------------------------------

test("peer-status cache stays bounded under many distinct targets", () => {
  const broker = createBroker();
  const service = new PeerStatusService(broker);
  const cache = (service as unknown as { cache: Map<string, unknown> }).cache;

  for (let i = 0; i < 1_100; i++) {
    const result = service.query({ target: `target-${i}` }, "caller");
    assert.ok(isPeerStatusResponse(result), `query ${i} should compute a response`);
  }

  assert.ok(cache.size <= 1_000, `cache must stay at/below the cap, got ${cache.size}`);
  // The most recent target survives eviction.
  assert.ok(cache.has("target-1099"), "newest entry must be retained");
});

test("peer-status rate buckets stay bounded under many distinct callers", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker);
  const rateBuckets = (service as unknown as { rateBuckets: Map<string, unknown> }).rateBuckets;

  for (let i = 0; i < 5_100; i++) {
    service.query({ target: "worker-a" }, `caller-${i}`);
  }

  assert.ok(
    rateBuckets.size <= 5_000,
    `rate buckets must stay at/below the cap, got ${rateBuckets.size}`,
  );
});
