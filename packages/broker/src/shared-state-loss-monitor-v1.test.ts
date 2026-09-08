/**
 * Slice N, first part: P1 loss monitor latch, no drain.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SHARED_STATE_SQLITE_ADAPTER_V1 } from "./shared-state-sqlite-adapter-v1.js";
import {
  createSharedStateLossMonitorV1,
  SHARED_STATE_LOSS_MONITOR_V1,
} from "./shared-state-loss-monitor-v1.js";
import type { SharedStateServingFenceProbeV1 } from "./shared-state-serving-fence-v1.js";
import { startTestServer } from "./server-test-helpers.js";

function ownershipToken(filePath: string): string {
  const db = new DatabaseSync(filePath, { timeout: 0 });
  const row: unknown = db.prepare(
    `SELECT owner_token FROM shared_state_ownership WHERE id = ?`,
  ).get(SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);
  db.close();
  if (!row || typeof row !== "object" || !("owner_token" in row)) {
    throw new Error("missing ownership token");
  }
  const token = row.owner_token;
  if (typeof token !== "string") throw new Error("ownership token is not a string");
  return token;
}

function writeOwnershipToken(filePath: string, token: string | null): void {
  const db = new DatabaseSync(filePath, { timeout: 0 });
  db.prepare(
    `UPDATE shared_state_ownership SET owner_token = ? WHERE id = ?`,
  ).run(token, SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);
  db.close();
}

test("latches the first lost_fence and ignores a restored row", () => {
  let current: SharedStateServingFenceProbeV1 = { ready: true };
  let lostCalls = 0;
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const monitor = createSharedStateLossMonitorV1({
      probe: () => current,
      onLostFence: () => {
        lostCalls += 1;
      },
    });
    assert.equal(monitor.inspect().ready, true);
    current = { ready: false, reasonCode: "lost_fence" };
    assert.deepEqual(monitor.inspect(), { ready: false, reasonCode: "lost_fence" });
    current = { ready: true };
    assert.deepEqual(monitor.inspect(), { ready: false, reasonCode: "lost_fence" });
    assert.equal(monitor.latched(), true);
    assert.equal(lostCalls, 1);
    assert.deepEqual(lines, [SHARED_STATE_LOSS_MONITOR_V1.logLine]);
    assert.equal(lines[0].includes("owner_token"), false);
    assert.equal(lines[0].includes("/var/lib"), false);
  } finally {
    console.warn = warn;
  }
});

test("does not latch adapter_unavailable", () => {
  let current: SharedStateServingFenceProbeV1 = {
    ready: false,
    reasonCode: "adapter_unavailable",
  };
  let lostCalls = 0;
  const monitor = createSharedStateLossMonitorV1({
    probe: () => current,
    onLostFence: () => {
      lostCalls += 1;
    },
  });
  assert.deepEqual(monitor.inspect(), {
    ready: false,
    reasonCode: "adapter_unavailable",
  });
  current = { ready: true };
  assert.equal(monitor.inspect().ready, true);
  assert.equal(monitor.latched(), false);
  assert.equal(lostCalls, 0);
});

test("timer inspects without an inbound request", async () => {
  let probes = 0;
  const monitor = createSharedStateLossMonitorV1({
    probe: () => {
      probes += 1;
      return { ready: true };
    },
  });
  monitor.start(20);
  try {
    // Wait for the probes rather than sleeping a fixed span. A 70 ms sleep
    // assumes two 20 ms timers get scheduled inside it, which stops holding
    // under manifest-level load — this assertion went flaky as the suite grew
    // worker threads, without the monitor ever being wrong. Polling to a
    // generous deadline keeps the claim ("the timer probes with no inbound
    // request") and still fails if the timer never fires at all.
    const deadline = Date.now() + 5_000;
    while (probes < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    monitor.stop();
  }
  assert.ok(probes >= 2);
});

test("/readyz stays lost_fence after the stolen row is restored", async () => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-loss-monitor-"));
  const sharedStateFile = join(directory, "fence.sqlite");
  const server = await startTestServer({
    edgeSecret: "s",
    sharedStateFile,
  });
  try {
    const held = await fetch(`${server.baseUrl}/readyz`);
    assert.equal(held.status, 200);
    const original = ownershipToken(sharedStateFile);
    writeOwnershipToken(sharedStateFile, "foreign-token");
    const observed = server.runtime.evaluateSharedStateLossMonitor();
    assert.deepEqual(observed, { ready: false, reasonCode: "lost_fence" });
    writeOwnershipToken(sharedStateFile, original);

    const lost = await fetchAfterLostFence(`${server.baseUrl}/readyz`);
    assert.equal(lost.status, 503);
    const body = await lost.json();
    assert.deepEqual(body.reasonCodes, ["lost_fence"]);
    assert.equal(JSON.stringify(body).includes("foreign-token"), false);
    assert.equal(server.runtime.isDraining(), false);

    const workers = await fetchAfterLostFence(`${server.baseUrl}/workers`, {
      headers: { "x-a2a-edge-secret": "s" },
    });
    assert.equal(workers.status, 503);
    const workersBody = await workers.json();
    assert.equal(workersBody.error.code, "lost_fence");
    assert.notEqual(workersBody.error.code, "broker_draining");

    const livez = await fetchAfterLostFence(`${server.baseUrl}/livez`);
    assert.equal(livez.status, 200);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fetchAfterLostFence(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return await fetch(url, init);
  }
}

function connectionCount(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((error, count) => {
      if (error) reject(error);
      else resolve(count);
    });
  });
}

test("lost_fence latch closes every HTTP connection and does not drain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-loss-monitor-d1-"));
  const sharedStateFile = join(directory, "fence.sqlite");
  const server = await startTestServer({
    edgeSecret: "s",
    sharedStateFile,
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    await new Promise<void>((resolve, reject) => {
      http.get(`${server.baseUrl}/livez`, { agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
        res.on("error", reject);
      }).on("error", reject);
    });
    assert.ok(await connectionCount(server.runtime.server) >= 1);
    writeOwnershipToken(sharedStateFile, "foreign-token");
    server.runtime.evaluateSharedStateLossMonitor();
    const startedAt = Date.now();
    while (await connectionCount(server.runtime.server) !== 0) {
      if (Date.now() - startedAt > 500) {
        throw new Error("connections were not closed after lost_fence");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(server.runtime.isDraining(), false);
    const lost = await fetchAfterLostFence(`${server.baseUrl}/readyz`);
    assert.equal(lost.status, 503);
    assert.deepEqual((await lost.json()).reasonCodes, ["lost_fence"]);
  } finally {
    agent.destroy();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lost_fence latch exits after the 503 path and does not drain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-loss-monitor-d3a-"));
  const sharedStateFile = join(directory, "fence.sqlite");
  let exits = 0;
  const server = await startTestServer({
    edgeSecret: "s",
    sharedStateFile,
    lostFenceExit: () => {
      exits += 1;
    },
  });
  try {
    writeOwnershipToken(sharedStateFile, "foreign-token");
    server.runtime.evaluateSharedStateLossMonitor();
    const startedAt = Date.now();
    while (exits === 0) {
      if (Date.now() - startedAt > 500) {
        throw new Error("lost_fence did not exit");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(exits, 1);
    assert.equal(server.runtime.isDraining(), false);
    const lost = await fetchAfterLostFence(`${server.baseUrl}/readyz`);
    assert.equal(lost.status, 503);
    assert.deepEqual((await lost.json()).reasonCodes, ["lost_fence"]);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/readyz recovers from adapter_unavailable because it is not latched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-loss-monitor-ua-"));
  const sharedStateFile = join(directory, "fence.sqlite");
  const server = await startTestServer({
    edgeSecret: "s",
    sharedStateFile,
  });
  try {
    const original = ownershipToken(sharedStateFile);
    writeOwnershipToken(sharedStateFile, null);
    const missing = await fetch(`${server.baseUrl}/readyz`);
    assert.equal(missing.status, 503);
    assert.deepEqual((await missing.json()).reasonCodes, ["adapter_unavailable"]);
    writeOwnershipToken(sharedStateFile, original);
    const recovered = await fetch(`${server.baseUrl}/readyz`);
    assert.equal(recovered.status, 200);
    assert.equal(server.runtime.isDraining(), false);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// #2079 B: the request path (inspectCached) reuses the last probe within the
// serving-authority TTL so one fence SELECT serves a whole tick instead of one
// per request. inspect() itself stays live: its semantics (latch on
// observation, synchronous observation of probe changes) are unchanged.
test("inspectCached reuses the probe within the TTL and re-probes after staleness", () => {
  let calls = 0;
  let current: SharedStateServingFenceProbeV1 = { ready: true };
  const monitor = createSharedStateLossMonitorV1({
    probe: () => {
      calls += 1;
      return current;
    },
    probeMaxAgeMs: 1500,
  });

  // Prime the cache with a live inspect, then reuse it.
  monitor.inspect();
  assert.equal(monitor.inspectCached().ready, true);
  assert.equal(monitor.inspectCached().ready, true);
  assert.equal(calls, 1, "calls within the TTL window must be served from the cache");

  // After the TTL the accessor falls back to a live probe.
  awaitBump(1500);
  monitor.inspectCached();
  assert.equal(calls, 2, "a stale cache must fall back to a live probe");
});

test("inspectCached observes lost_fence on a stale cache and latches", () => {
  let calls = 0;
  let current: SharedStateServingFenceProbeV1 = { ready: true };
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const monitor = createSharedStateLossMonitorV1({
      probe: () => {
        calls += 1;
        return current;
      },
      probeMaxAgeMs: 1500,
    });
    monitor.inspect();
    current = { ready: false, reasonCode: "lost_fence" };
    awaitBump(1500);
    assert.deepEqual(monitor.inspectCached(), { ready: false, reasonCode: "lost_fence" });
    // Latched: further cached reads short-circuit without probing.
    const afterLatchCalls = calls;
    assert.deepEqual(monitor.inspectCached(), { ready: false, reasonCode: "lost_fence" });
    assert.equal(calls, afterLatchCalls);
    assert.ok(lines.some((line) => line.includes("lost_fence")));
  } finally {
    console.warn = warn;
  }
});

function awaitBump(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms) {
    // busy-wait past the cache TTL (tests, not production code)
  }
}
