// #2078 A: operator event fan-out. A single SSE subscriber used to force a
// full operator snapshot (full task read + diagnostics pass + hot-table
// growth scans) on EVERY broker state change. The publish is now debounced
// (trailing-edge coalescing), diagnostics are computed once per snapshot and
// shared between the dashboard and the alert scan, and hot-table growth reads
// through a 5s diagnostics cache. These tests pin the call counts with spies.
import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryA2ABroker } from "./core/broker.js";
import {
  jsonHeaders,
  readSseEventsUntil,
  registerTestWorker,
  startTestServer,
} from "./server-test-helpers.js";

class CountingBroker extends InMemoryA2ABroker {
  listTaskDiagnosticsCalls = 0;
  listTasksCalls = 0;

  override listTaskDiagnostics(options?: Parameters<InMemoryA2ABroker["listTaskDiagnostics"]>[0]) {
    this.listTaskDiagnosticsCalls += 1;
    return super.listTaskDiagnostics(options);
  }

  override listTasks(filters?: Parameters<InMemoryA2ABroker["listTasks"]>[0]) {
    this.listTasksCalls += 1;
    return super.listTasks(filters);
  }
}

const edgeHeaders = jsonHeaders({
  "x-a2a-edge-secret": "test-edge-secret",
  "x-a2a-requester-id": "hub-a",
  "x-a2a-requester-role": "hub",
});

test("100 mutations with one SSE subscriber cost O(1) operator snapshots (#2078 A)", async () => {
  const broker = new CountingBroker();
  const server = await startTestServer({
    broker,
    edgeSecret: "test-edge-secret",
    workerOfflineAfterSec: 90,
    rateLimitMaxRequests: 1000,
    workerRateLimitMaxRequests: 1000,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");

    const sseController = new AbortController();
    const sseRes = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      signal: sseController.signal,
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "ops",
        "x-a2a-requester-role": "operator",
        accept: "text/event-stream",
      },
    });
    assert.equal(sseRes.status, 200);
    // The subscribe-time snapshot is computed once on connect; wait for it so
    // the measured window below covers only mutation-driven publishes.
    await readSseEventsUntil(
      sseRes,
      (seen) => seen.some((event) => event.event === "operator-snapshot"),
    );
    // Allow any in-flight debounce flush from registration to land.
    await new Promise((resolve) => setTimeout(resolve, 700));

    const baseline = broker.listTaskDiagnosticsCalls;
    for (let i = 0; i < 100; i += 1) {
      const res = await fetch(`${server.baseUrl}/tasks`, {
        method: "POST",
        headers: edgeHeaders,
        body: JSON.stringify({
          intent: "chat",
          requester: { id: "hub-a", kind: "node", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          assignedWorkerId: "worker-a",
          message: `burst ${i}`,
        }),
      });
      assert.equal(res.status, 201);
    }
    // Wait past the trailing-edge debounce window so the coalesced flush runs.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const delta = broker.listTaskDiagnosticsCalls - baseline;
    assert.ok(
      delta <= 5,
      `100 mutations must coalesce into O(1) snapshot passes, got ${delta} listTaskDiagnostics calls`,
    );
    sseController.abort();
  } finally {
    await server.close();
  }
});

test("one snapshot pass feeds both dashboard and alert scan (#2078 A)", async () => {
  const broker = new CountingBroker();
  const server = await startTestServer({
    broker,
    edgeSecret: "test-edge-secret",
    workerOfflineAfterSec: 90,
    rateLimitMaxRequests: 1000,
    workerRateLimitMaxRequests: 1000,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");
    const sseController = new AbortController();
    const sseRes = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      signal: sseController.signal,
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "ops",
        "x-a2a-requester-role": "operator",
        accept: "text/event-stream",
      },
    });
    assert.equal(sseRes.status, 200);
    // Settle past any pre-subscribe debounce flush, then take the baseline.
    // The route buffers events until its snapshot is written, so subscribing
    // before the mutation is safe.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const baseline = broker.listTaskDiagnosticsCalls;
    const listTasksBaseline = broker.listTasksCalls;

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: edgeHeaders,
      body: JSON.stringify({
        intent: "chat",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "shared-pass probe",
      }),
    });
    assert.equal(createRes.status, 201);
    const events = await readSseEventsUntil(
      sseRes,
      (seen) => seen.some((event) => event.event === "operator-summary-update"),
    );
    const summaryEvent = events.find((event) => event.event === "operator-summary-update");
    assert.ok(summaryEvent, "expected a debounced summary update for the burst");
    const summary = JSON.parse(summaryEvent!.data);
    // The dashboard and the alert projections both rendered.
    assert.ok(summary.summary.workers.total >= 1);
    assert.ok(Array.isArray(summary.alerts.alerts));

    await new Promise((resolve) => setTimeout(resolve, 700));
    const diagnosticsDelta = broker.listTaskDiagnosticsCalls - baseline;
    assert.ok(
      diagnosticsDelta <= 2,
      `one flush must run one shared diagnostics pass, got ${diagnosticsDelta}`,
    );
    assert.equal(
      broker.listTasksCalls - listTasksBaseline,
      diagnosticsDelta,
      "the alert scan must reuse the dashboard pass (equal listTasks fan-out)",
    );
    sseController.abort();
  } finally {
    await server.close();
  }
});
