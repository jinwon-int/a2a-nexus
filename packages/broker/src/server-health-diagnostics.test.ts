import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, jsonHeaders, withEnv, registerTestWorker } from "./server-test-helpers.js";

test("server exposes empty worker capacity preflight as compact response", async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/workers/capacity`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, []);
    assert.equal(body.totals.workers, 0);
    assert.equal(body.totals.active, 0);
  } finally {
    await server.close();
  }
});

test("server surfaces env-injected broker version/build revision on health and dashboard status", async () => {
  await withEnv({
    A2A_BROKER_REVISION: "78b2b42fca6e",
    A2A_BROKER_VERSION: "0.2.3",
    A2A_BROKER_SOURCE: undefined,
    A2A_BROKER_BUILT_AT: undefined,
    A2A_BROKER_RUNTIME: undefined,
    A2A_BROKER_IMAGE_TAG: undefined,
    A2A_BROKER_IMAGE_DIGEST: undefined,
  }, async () => {
    const server = await startTestServer({ buildInfoFile: "/dev/null" });
    try {
      assert.equal(server.runtime.config.version, "0.2.3");
      assert.equal(server.runtime.config.build.revision, "78b2b42fca6e");

      const healthRes = await fetch(`${server.baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.headers.get("cache-control"), "no-store");
      const health = await healthRes.json();
      assert.equal(health.version, "0.2.3");
      assert.deepEqual(health.build, {
        component: "a2a-broker",
        revision: "78b2b42fca6e",
        source: "github.com/jinwon-int/a2a-nexus",
      });

      const dashboardRes = await fetch(`${server.baseUrl}/dashboard`, {
        headers: {
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        },
      });
      assert.equal(dashboardRes.status, 200);
      const dashboard = await dashboardRes.json();
      assert.equal(dashboard.version, health.version);
      assert.deepEqual(dashboard.build, health.build);
    } finally {
      await server.close();
    }
  });
});

test("server ignores implausible probe start headers on /livez", async () => {
  const server = await startTestServer();
  try {
    const future = Date.now() + 60_000;
    const res = await fetch(`${server.baseUrl}/livez`, {
      headers: {
        "x-a2a-probe-start-unix-ms": String(future),
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(body.probeTiming, "/livez should include probeTiming field");
    assert.equal(body.probeTiming.clientProbeStartUnixMs, null);
    assert.equal(body.probeTiming.clientProbeStartToHandlerStartMs, null);
    assert.equal(body.probeTiming.clientProbeStartToSocketConnectedMs, null);
    assert.equal(body.probeTiming.clientProbeStartToHttpRequestEventMs, null);
  } finally {
    await server.close();
  }
});

test("server exposes lightweight scheduling diagnostics on /schedz", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
  });
  try {
    const authHeaders = { "x-a2a-edge-secret": "test-edge-secret" };
    // First request to warm up counters.
    await fetch(`${server.baseUrl}/livez`);
    await fetch(`${server.baseUrl}/health`, { headers: authHeaders });
    await registerTestWorker(server.baseUrl, "worker-schedz", "analyst", "test-edge-secret");
    const heartbeatRes = await fetch(`${server.baseUrl}/workers/worker-schedz/heartbeat`, {
      method: "POST",
      headers: jsonHeaders({
        ...authHeaders,
        "x-a2a-requester-id": "worker-schedz",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(heartbeatRes.status, 200);
    const a2aJsonRpcRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        ...authHeaders,
        "x-a2a-requester-id": "schedz-route-probe",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "schedz-route-probe",
        method: "a2a.peer.status",
        params: { target: "worker-schedz" },
      }),
    });
    assert.ok(a2aJsonRpcRes.status >= 200);

    const res = await fetch(`${server.baseUrl}/schedz`, { headers: authHeaders });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, "a2a-broker");
    assert.equal(typeof body.totalAccepted, "number");
    assert.ok(body.totalAccepted >= 1);
    assert.equal(typeof body.activeRequests, "number");
    assert.ok(body.activeRequests >= 0);

    // host scheduling snapshot
    assert.ok(body.host, "/schedz should include host field");
    assert.equal(typeof body.host.loadavg1, "number");
    assert.equal(typeof body.host.loadavg5, "number");
    assert.equal(typeof body.host.loadavg15, "number");
    assert.equal(typeof body.host.cpuCount, "number");
    assert.ok(body.host.cpuCount >= 1);
    assert.equal(typeof body.host.loadPerCpu, "number");
    assert.equal(typeof body.host.snapshotAtMs, "number");

    // scheduling timing aggregate
    if (body.schedulingTiming !== null) {
      assert.equal(typeof body.schedulingTiming.count, "number");
      assert.equal(typeof body.schedulingTiming.maxMs, "number");
      assert.equal(typeof body.schedulingTiming.p99Ms, "number");
    }
    assert.ok(body.endpointTiming, "/schedz should include endpointTiming field");
    assert.ok(body.endpointActive, "/schedz should include endpointActive field");
    const expectedEndpointGroups = ["livez", "health", "schedz", "workers.list", "workers.capacity", "workers.register", "workers.detail", "workers.heartbeat", "workers.assignment-events", "workers.subagent-orchestration.plan", "worker", "a2a", "well-known", "dashboard", "terminal-brief", "complexity", "sidecar", "other"] as const;
    for (const group of expectedEndpointGroups) {
      assert.ok(group in body.endpointTiming, `endpointTiming.${group} should be present`);
      assert.equal(typeof body.endpointActive[group], "number");
      assert.ok(body.endpointActive[group] >= 0);
    }
    assert.ok(body.endpointTiming.livez, "endpointTiming.livez should have a sample");
    assert.equal(typeof body.endpointTiming.livez.count, "number");
    assert.ok(body.endpointTiming.livez.count >= 1);
    assert.ok(body.endpointTiming.health, "endpointTiming.health should have a sample");
    // The in-flight /schedz request records its duration after this response
    // finishes, so its first request may appear only in endpointActive here.
    assert.ok(body.endpointActive.schedz >= 1);

    // Per-endpoint handler body timing (#1032 thesis: separate handler body
    // from total handler time so gates can tell which endpoint has slow body).
    assert.ok(body.endpointHandlerBodyTiming, "/schedz should include endpointHandlerBodyTiming field");
    for (const group of expectedEndpointGroups) {
      assert.ok(group in body.endpointHandlerBodyTiming, `endpointHandlerBodyTiming.${group} should be present`);
    }
    // /livez and /health should have handler body samples from the requests above.
    if (body.endpointHandlerBodyTiming.livez !== null) {
      assert.equal(typeof body.endpointHandlerBodyTiming.livez.count, "number");
      assert.ok(body.endpointHandlerBodyTiming.livez.count >= 1);
    }
    if (body.endpointHandlerBodyTiming.health !== null) {
      assert.equal(typeof body.endpointHandlerBodyTiming.health.count, "number");
      assert.ok(body.endpointHandlerBodyTiming.health.count >= 1);
    }

    // Route-level request attribution splits the broad worker endpoint into
    // concrete routes so #1032 live gates can tell register/list/heartbeat
    // pressure apart from /livez itself.
    assert.ok(body.requestRoutes, "/schedz should include requestRoutes field");
    for (const route of ["livez", "health", "workers.register", "workers.heartbeat", "workers.list", "workers.capacity", "a2a.jsonrpc", "a2a.tasks.terminal-outbox", "a2a.cross-broker.terminal-briefs", "tasks.list", "operator.task-report", "operator.cleanup.plan", "operator.alerts", "operator.control-tower", "operator.release-evidence", "exchanges.list", "proposals.list", "audit", "terminal-brief.inbox", "terminal-brief.closeout"] as const) {
      assert.ok(route in body.requestRoutes, `requestRoutes.${route} should be present`);
      assert.equal(typeof body.requestRoutes[route].active, "number");
      assert.equal(typeof body.requestRoutes[route].onNewConnection, "number");
      assert.equal(typeof body.requestRoutes[route].onReusedConnection, "number");
    }
    assert.ok(body.requestRoutes.livez.timing, "requestRoutes.livez should have a timing sample");
    assert.ok(body.requestRoutes["workers.register"].timing, "requestRoutes.workers.register should have a timing sample");
    assert.equal(typeof body.requestRoutes["workers.register"].timing.count, "number");
    assert.ok(body.requestRoutes["workers.register"].timing.count >= 1);
    assert.ok(body.requestRoutes["workers.heartbeat"].timing, "requestRoutes.workers.heartbeat should have a timing sample");
    assert.equal(typeof body.requestRoutes["workers.heartbeat"].timing.count, "number");
    assert.ok(body.requestRoutes["workers.heartbeat"].timing.count >= 1);
    assert.ok(body.requestRoutes["a2a.jsonrpc"].timing, "requestRoutes.a2a.jsonrpc should have a timing sample");
    assert.equal(typeof body.requestRoutes["a2a.jsonrpc"].timing.count, "number");
    assert.ok(body.requestRoutes["a2a.jsonrpc"].timing.count >= 1);

    // Per-route handler body timing (#1032 / #1179: split worker handler
    // body time into actionable worker sub-routes).
    assert.ok(body.routeHandlerBodyTiming, "/schedz should include routeHandlerBodyTiming field");
    for (const route of ["livez", "health", "workers.register", "workers.heartbeat", "workers.list", "workers.capacity", "workers.assignment-events", "a2a.jsonrpc", "a2a.tasks.terminal-outbox", "a2a.cross-broker.terminal-briefs", "tasks.list", "operator.task-report", "operator.cleanup.plan", "operator.alerts", "operator.control-tower", "operator.release-evidence", "exchanges.list", "proposals.list", "audit", "terminal-brief.inbox", "terminal-brief.closeout"] as const) {
      assert.ok(route in body.routeHandlerBodyTiming, `routeHandlerBodyTiming.${route} should be present`);
    }
    if (body.routeHandlerBodyTiming.livez !== null) {
      assert.equal(typeof body.routeHandlerBodyTiming.livez.count, "number");
      assert.ok(body.routeHandlerBodyTiming.livez.count >= 1);
    }
    if (body.routeHandlerBodyTiming.health !== null) {
      assert.equal(typeof body.routeHandlerBodyTiming.health.count, "number");
      assert.ok(body.routeHandlerBodyTiming.health.count >= 1);
    }
    if (body.routeHandlerBodyTiming["workers.register"] !== null) {
      assert.equal(typeof body.routeHandlerBodyTiming["workers.register"].count, "number");
      assert.ok(body.routeHandlerBodyTiming["workers.register"].count >= 1);
    }
    if (body.routeHandlerBodyTiming["workers.heartbeat"] !== null) {
      assert.equal(typeof body.routeHandlerBodyTiming["workers.heartbeat"].count, "number");
      assert.ok(body.routeHandlerBodyTiming["workers.heartbeat"].count >= 1);
    }
    if (body.routeHandlerBodyTiming["a2a.jsonrpc"] !== null) {
      assert.equal(typeof body.routeHandlerBodyTiming["a2a.jsonrpc"].count, "number");
      assert.ok(body.routeHandlerBodyTiming["a2a.jsonrpc"].count >= 1);
    }

    assert.ok(body.terminalOutbox, "/schedz should include terminalOutbox summary");
    assert.equal(typeof body.terminalOutbox.retainedCount, "number");
    assert.equal(typeof body.terminalOutbox.sampledCount, "number");
    assert.equal(typeof body.terminalOutbox.sampleLimit, "number");
    assert.equal(typeof body.terminalOutbox.pendingAckCount, "number");
    assert.ok(Array.isArray(body.terminalOutbox.topWorkers));
    assert.ok(Array.isArray(body.terminalOutbox.topPendingAckWorkers));
    assert.ok(Array.isArray(body.terminalOutbox.topPendingAckStatuses));
    assert.ok(Array.isArray(body.terminalOutbox.topPendingAckReceiptStatuses));
    assert.ok(Array.isArray(body.terminalOutbox.topPendingAckBrokersOfRecord));
    assert.ok(Array.isArray(body.terminalOutbox.topStatuses));
    assert.ok(Array.isArray(body.terminalOutbox.topReceiptStatuses));
    assert.deepEqual(body.persistenceQueue, {
      kind: "broker.persistence.queue",
      enabled: false,
      mode: "inline",
      state: "disabled",
      capacity: null,
      queued: 0,
      active: 0,
      inFlight: 0,
      available: null,
      closing: false,
      aborted: false,
    });

    assert.ok(body.workerHeartbeatPhases, "/schedz should include workerHeartbeatPhases field");
    for (const phase of ["readJson", "authLookup", "authAssert", "brokerHeartbeat", "toWorkerView"] as const) {
      assert.ok(phase in body.workerHeartbeatPhases, `workerHeartbeatPhases.${phase} should be present`);
      assert.ok(body.workerHeartbeatPhases[phase], `workerHeartbeatPhases.${phase} should have a timing sample`);
      assert.equal(typeof body.workerHeartbeatPhases[phase].count, "number");
      assert.ok(body.workerHeartbeatPhases[phase].count >= 1);
    }

    // Per-worker heartbeat phase timing: sogyo attribution (#1032 / Team1 first pass)
    assert.ok(body.perWorkerHeartbeatPhases, "/schedz should include perWorkerHeartbeatPhases field");
    assert.ok("worker-schedz" in body.perWorkerHeartbeatPhases,
      `perWorkerHeartbeatPhases should have entry for worker-schedz`);
    for (const phase of ["readJson", "authLookup", "authAssert", "brokerHeartbeat", "toWorkerView"] as const) {
      assert.ok(phase in body.perWorkerHeartbeatPhases["worker-schedz"],
        `perWorkerHeartbeatPhases.worker-schedz.${phase} should be present`);
      assert.ok(body.perWorkerHeartbeatPhases["worker-schedz"][phase],
        `perWorkerHeartbeatPhases.worker-schedz.${phase} should have a timing sample`);
      assert.equal(typeof body.perWorkerHeartbeatPhases["worker-schedz"][phase].count, "number");
      assert.ok(body.perWorkerHeartbeatPhases["worker-schedz"][phase].count >= 1);
    }

    assert.ok(body.workerRegisterPhases, "/schedz should include workerRegisterPhases field");
    for (const phase of ["readJson", "authAssert", "brokerRegister", "toWorkerView"] as const) {
      assert.ok(phase in body.workerRegisterPhases, `workerRegisterPhases.${phase} should be present`);
      assert.ok(body.workerRegisterPhases[phase], `workerRegisterPhases.${phase} should have a timing sample`);
      assert.equal(typeof body.workerRegisterPhases[phase].count, "number");
      assert.ok(body.workerRegisterPhases[phase].count >= 1);
    }

    assert.ok(body.perWorkerRegisterPhases, "/schedz should include perWorkerRegisterPhases field");
    assert.ok("worker-schedz" in body.perWorkerRegisterPhases,
      "perWorkerRegisterPhases should have entry for worker-schedz");
    for (const phase of ["authAssert", "brokerRegister", "toWorkerView"] as const) {
      assert.ok(phase in body.perWorkerRegisterPhases["worker-schedz"],
        `perWorkerRegisterPhases.worker-schedz.${phase} should be present`);
      assert.ok(body.perWorkerRegisterPhases["worker-schedz"][phase],
        `perWorkerRegisterPhases.worker-schedz.${phase} should have a timing sample`);
      assert.equal(typeof body.perWorkerRegisterPhases["worker-schedz"][phase].count, "number");
      assert.ok(body.perWorkerRegisterPhases["worker-schedz"][phase].count >= 1);
    }

    // Container/cgroup scheduling diagnostics (issue #1054)
    assert.ok(body.container, "/schedz should include container field");
    assert.ok(typeof body.container.runtime === "string" || body.container.runtime === null, "container.runtime should be a string or null");
    // cgroup stats may be null when running outside a Linux container
    // or when /sys/fs/cgroup is unavailable.
    if (body.container.cgroup !== null) {
      assert.ok(body.container.cgroup.cpu, "container.cgroup.cpu should be present");
      assert.equal(typeof body.container.cgroup.cpu.usageUsec, "number");
      assert.equal(typeof body.container.cgroup.cpu.nrPeriods, "number");
      assert.equal(typeof body.container.cgroup.cpu.nrThrottled, "number");
      assert.equal(typeof body.container.cgroup.cpu.throttledUsec, "number");
      assert.equal(typeof body.container.cgroup.cpu.snapshotAtMs, "number");
      // cpuLimit may be null when cpu.max is "max" (no limit)
      if (body.container.cgroup.cpuLimit !== null) {
        assert.equal(typeof body.container.cgroup.cpuLimit.quotaUsec, "number");
        assert.equal(typeof body.container.cgroup.cpuLimit.periodUsec, "number");
        assert.equal(typeof body.container.cgroup.cpuLimit.cpus, "number");
      }
      // Per-poll cgroup cpu.stat delta (#1102).  Null on first poll or
      // when the previous snapshot is stale/garbage-collected.
      assert.ok("cpuDelta" in body.container.cgroup, "container.cgroup should include cpuDelta");
      if (body.container.cgroup.cpuDelta !== null) {
        assert.equal(typeof body.container.cgroup.cpuDelta.deltaUsageUsec, "number");
        assert.equal(typeof body.container.cgroup.cpuDelta.deltaUserUsec, "number");
        assert.equal(typeof body.container.cgroup.cpuDelta.deltaSystemUsec, "number");
        assert.equal(typeof body.container.cgroup.cpuDelta.deltaNrPeriods, "number");
        assert.equal(typeof body.container.cgroup.cpuDelta.deltaNrThrottled, "number");
        assert.equal(typeof body.container.cgroup.cpuDelta.deltaThrottledUsec, "number");
        assert.equal(typeof body.container.cgroup.cpuDelta.wallMs, "number");
        assert.ok(body.container.cgroup.cpuDelta.wallMs >= 1, "cpuDelta.wallMs should be >= 1");
      }
    }
    // PSI may be null when /proc/pressure is unavailable.
    if (body.container.psi !== null) {
      for (const resource of ["cpu", "memory", "io"] as const) {
        assert.ok(body.container.psi[resource], `psi.${resource} should be present`);
        assert.equal(typeof body.container.psi[resource].some.avg10, "number");
        assert.equal(typeof body.container.psi[resource].some.avg60, "number");
        assert.equal(typeof body.container.psi[resource].some.avg300, "number");
        assert.equal(typeof body.container.psi[resource].some.total, "number");
        assert.equal(typeof body.container.psi[resource].full.avg10, "number");
        assert.equal(typeof body.container.psi[resource].full.avg60, "number");
        assert.equal(typeof body.container.psi[resource].full.avg300, "number");
        assert.equal(typeof body.container.psi[resource].full.total, "number");
      }
      assert.equal(typeof body.container.psi.snapshotAtMs, "number");
    }

    // connection tracking diagnostics (#1032)
    assert.ok(body.connections, "/schedz should include connections field");
    assert.equal(typeof body.connections.totalConnections, "number");
    assert.ok(body.connections.totalConnections >= 1, "at least one connection tracked");
    assert.equal(typeof body.connections.activeConnections, "number");
    assert.equal(typeof body.connections.peakConnections, "number");
    assert.ok(body.connections.peakConnections >= 1);
    assert.ok(body.connections.httpServer, "/schedz connections should include HTTP server settings");
    assert.equal(typeof body.connections.httpServer.keepAliveTimeoutMs, "number");
    assert.equal(typeof body.connections.httpServer.headersTimeoutMs, "number");
    assert.equal(typeof body.connections.httpServer.requestTimeoutMs, "number");
    assert.equal(typeof body.connections.httpServer.timeoutMs, "number");
    assert.equal(typeof body.connections.httpServer.maxRequestsPerSocket, "number");
    assert.ok(
      typeof body.connections.httpServer.maxConnections === "number" || body.connections.httpServer.maxConnections === null,
    );
    assert.equal(typeof body.connections.httpServer.socketReusePolicy, "string");
    assert.ok(
      body.connections.httpServer.socketReusePolicy.startsWith("keep-alive"),
      `socketReusePolicy should indicate keep-alive (got "${body.connections.httpServer.socketReusePolicy}")`,
    );
    if (body.connections.connectionDurationMs !== null) {
      assert.equal(typeof body.connections.connectionDurationMs.count, "number");
      assert.equal(typeof body.connections.connectionDurationMs.maxMs, "number");
    }

    // per-request connection reuse tracking
    assert.ok(body.perRequest, "/schedz should include perRequest field");
    assert.equal(typeof body.perRequest.onNewConnection, "number");
    assert.equal(typeof body.perRequest.onReusedConnection, "number");
    assert.equal(typeof body.perRequest.totalSamples, "number");
    assert.ok(body.perRequest.totalSamples >= 1);
    assert.ok(body.perRequest.socketAgeBeforeHandlerMs, "perRequest should include socket age timing");
    assert.equal(typeof body.perRequest.socketAgeBeforeHandlerMs.count, "number");
    assert.ok(body.perRequest.socketAgeBeforeHandlerMs.count >= 1);
    assert.ok("socketIdleBeforeRequestMs" in body.perRequest);
    assert.ok("socketAcceptedToHttpRequestEventMs" in body.perRequest);
    assert.ok("httpRequestEventToHandlerStartMs" in body.perRequest);
    assert.ok("socketIdleBeforeHttpRequestEventMs" in body.perRequest);
    assert.ok("clientProbeStartToHandlerStartMs" in body.perRequest);
    assert.ok("clientProbeStartToSocketConnectedMs" in body.perRequest);
    assert.ok("clientProbeStartToHttpRequestEventMs" in body.perRequest);

    // connection-reuse breakdown
    assert.ok(body.perRequest.byConnectionReuse, "/schedz should include byConnectionReuse breakdown");
    assert.ok(body.perRequest.byConnectionReuse.fresh, "byConnectionReuse should include fresh");
    assert.ok(body.perRequest.byConnectionReuse.reused, "byConnectionReuse should include reused");
    assert.ok("socketAgeBeforeHandlerMs" in body.perRequest.byConnectionReuse.fresh);
    assert.ok("socketAcceptedToHttpRequestEventMs" in body.perRequest.byConnectionReuse.fresh);
    assert.ok("socketConnectedToFirstDataMs" in body.perRequest.byConnectionReuse.fresh,
      "fresh perRequest should include socketConnectedToFirstDataMs");
    assert.ok("firstDataToHttpRequestEventMs" in body.perRequest.byConnectionReuse.fresh,
      "fresh perRequest should include firstDataToHttpRequestEventMs");
    assert.ok("httpRequestEventToHandlerStartMs" in body.perRequest.byConnectionReuse.fresh,
      "fresh perRequest should include httpRequestEventToHandlerStartMs (#1125)");
    assert.ok("socketAgeBeforeHandlerMs" in body.perRequest.byConnectionReuse.reused);
    assert.ok("socketIdleBeforeHttpRequestEventMs" in body.perRequest.byConnectionReuse.reused);
    assert.ok("httpRequestEventToHandlerStartMs" in body.perRequest.byConnectionReuse.reused,
      "reused perRequest should include httpRequestEventToHandlerStartMs");

    // new aggregate per-request fields (#1107)
    assert.ok("socketConnectedToFirstDataMs" in body.perRequest,
      "/schedz perRequest should include socketConnectedToFirstDataMs");
    assert.ok("firstDataToHttpRequestEventMs" in body.perRequest,
      "/schedz perRequest should include firstDataToHttpRequestEventMs");

    // operator gate
    assert.ok(body.operatorGate, "/schedz should include operatorGate");
    assert.equal(typeof body.operatorGate.bucket, "string");
    assert.ok(["no-significant-stall", "reused-socket-idle-before-request-event", "reused-socket-waiting-before-handler", "client-pool-artifact", "node-request-event-delivery", "accepted-socket-waiting-before-handler", "accepted-socket-waiting-before-request-event", "accepted-socket-waiting-for-data", "accepted-socket-data-received-blocked"].includes(body.operatorGate.bucket));
    assert.ok(["low", "medium", "high"].includes(body.operatorGate.confidence));
    assert.ok(Array.isArray(body.operatorGate.reasons));
    assert.ok(body.operatorGate.reasons.length >= 1);
    assert.ok(body.operatorGate.evidence, "operatorGate should include evidence field");
    assert.equal(typeof body.operatorGate.evidence.reusedSocketIdleP99Ms, "number");
    assert.ok("freshSocketAcceptToReqP99Ms" in body.operatorGate.evidence, "operatorGate evidence should include freshSocketAcceptToReqP99Ms");
    assert.ok("reusedSocketReqToHandlerP99Ms" in body.operatorGate.evidence, "operatorGate evidence should include reusedSocketReqToHandlerP99Ms");
    assert.ok("freshHttpReqEventToHandlerP99Ms" in body.operatorGate.evidence,
      "operatorGate evidence should include freshHttpReqEventToHandlerP99Ms (#1125)");

    // flush-finish gap diagnostics
    assert.ok(body.flushing, "/schedz should include flushing field");

    // probe bursts (array, may be empty)
    assert.ok(Array.isArray(body.probeBursts));
  } finally {
    await server.close();
  }
});

test("GET /schedz returns 401 without x-a2a-edge-secret", async () => {
  const server = await startTestServer({
    edgeSecret: "test-secret",
  });
  try {
    // /schedz should require edge secret (it is not a public route).
    const noSecretRes = await fetch(`${server.baseUrl}/schedz`);
    assert.equal(noSecretRes.status, 401);
  } finally {
    await server.close();
  }
});

test("per-worker heartbeat phase telemetry stays bounded under worker churn", async () => {
  const server = await startTestServer({
    enforceRequesterIdentity: false,
    rateLimitMaxRequests: 10_000,
    workerRateLimitMaxRequests: 10_000,
  });
  try {
    for (let i = 0; i < 501; i++) {
      const workerId = `churn-worker-${String(i).padStart(4, "0")}`;
      const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          nodeId: workerId,
          role: "analyst",
          capabilities: { canAnalyze: true },
        }),
      });
      assert.equal(registerRes.status, 201);
      const heartbeatRes = await fetch(`${server.baseUrl}/workers/${workerId}/heartbeat`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({}),
      });
      assert.equal(heartbeatRes.status, 200);
    }

    const res = await fetch(`${server.baseUrl}/schedz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.perWorkerHeartbeatPhases, "/schedz should include perWorkerHeartbeatPhases");
    assert.ok(Object.keys(body.perWorkerHeartbeatPhases).length <= 500);
    assert.ok(body.workerHeartbeatPhases, "/schedz should retain aggregate workerHeartbeatPhases");
  } finally {
    await server.close();
  }
});

test("server tracks connection reuse and flush-finish gap on /schedz", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
  });
  try {
    const edgeHeaders = { "x-a2a-edge-secret": "test-edge-secret" };

    // Issue requests on separate connections (force new sockets).
    const separateConnections = [
      `${server.baseUrl}/livez`,
      `${server.baseUrl}/livez`,
    ];
    for (const url of separateConnections) {
      const res = await fetch(url);
      assert.equal(res.status, 200);
    }

    // Reuse the same agent for a few requests to exercise keep-alive.
    // Use node:http directly to pass a keepAlive agent (undici fetch types
    // don't accept agent in RequestInit).
    const http = await import("node:http");
    const reusedAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 5000,
    });
    const baseUrlObj = new URL(server.baseUrl);
    const reusedPort = Number(baseUrlObj.port);
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port: reusedPort,
          path: "/livez",
          agent: reusedAgent,
          method: "GET",
          headers: edgeHeaders,
        }, (resp) => {
          let data = "";
          resp.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          resp.on("end", () => { resolve(); });
        });
        req.on("error", reject);
        req.end();
      });
    }
    reusedAgent.destroy();

    // Immediate /livez to warm up the /schedz counters before snapshot.
    await fetch(`${server.baseUrl}/livez`);

    const res = await fetch(`${server.baseUrl}/schedz`, { headers: edgeHeaders });
    assert.equal(res.status, 200);
    const body = await res.json();

    // Connection tracking counters should be populated.
    assert.equal(typeof body.connections.totalConnections, "number");
    assert.ok(body.connections.totalConnections >= 1);
    assert.equal(typeof body.connections.activeConnections, "number");
    assert.equal(typeof body.connections.peakConnections, "number");
    assert.ok(body.connections.peakConnections >= 1);
    assert.ok(body.connections.httpServer, "HTTP server connection settings should be present");
    assert.equal(typeof body.connections.httpServer.keepAliveTimeoutMs, "number");
    // The default keepAliveTimeout should be well above the Node default (5s) to
    // support worker heartbeat connection reuse across the 30s heartbeat interval.
    assert.ok(
      body.connections.httpServer.keepAliveTimeoutMs >= 60000,
      `keepAliveTimeout (${body.connections.httpServer.keepAliveTimeoutMs}ms) should exceed heartbeat interval`,
    );

    // Per-request: at minimum new connections tracked.
    assert.equal(typeof body.perRequest.onNewConnection, "number");
    assert.ok(body.perRequest.onNewConnection >= 3, "at least 3 requests on new connections");
    // The reused-agent requests should show at least one reused connection.
    assert.ok(body.perRequest.onReusedConnection >= 1, "at least 1 request on reused connection");

    // Flush-finish gap: present in schema.
    assert.ok(body.flushing, "flushing field present");

    // First-request latency timing window should have some samples.
    if (body.perRequest.firstRequestLatencyMs !== null) {
      assert.equal(typeof body.perRequest.firstRequestLatencyMs.count, "number");
      assert.ok(body.perRequest.firstRequestLatencyMs.count >= 1);
    }
    // handlerMs should be present (C7: handler body execution time, excludes response flushing).
    assert.ok(body.perRequest.handlerMs, "handlerMs should be present in perRequest");
    assert.equal(typeof body.perRequest.handlerMs.count, "number");
    assert.ok(body.perRequest.handlerMs.count >= 1);
    assert.ok(body.perRequest.socketAgeBeforeHandlerMs, "socket age timing should be present");
    assert.equal(typeof body.perRequest.socketAgeBeforeHandlerMs.count, "number");
    assert.ok(body.perRequest.socketAgeBeforeHandlerMs.count >= 1);
    assert.ok(body.perRequest.socketIdleBeforeRequestMs, "keep-alive idle timing should be present");
    assert.equal(typeof body.perRequest.socketIdleBeforeRequestMs.count, "number");

    // Connection-reuse breakdown windows should be populated
    assert.ok(body.perRequest.byConnectionReuse, "connection reuse breakdown should be present");
    assert.ok(body.perRequest.byConnectionReuse.fresh.socketAgeBeforeHandlerMs, "fresh socket age window present");
    assert.ok(body.perRequest.byConnectionReuse.reused.socketIdleBeforeHttpRequestEventMs !== undefined,
      "reused socket idle window present");

    // Operator gate should classify as no-significant-stall under light local load
    assert.ok(body.operatorGate, "operatorGate should be present");
    assert.match(body.operatorGate.bucket, /^no-significant-stall|accepted-socket-waiting-before-handler|accepted-socket-waiting-before-request-event|accepted-socket-waiting-for-data|accepted-socket-data-received-blocked|reused-socket-waiting-before-handler$/,
      "light load should not trigger stall bucket");
    assert.ok(body.operatorGate.reasons.length >= 1);
    assert.ok(body.operatorGate.evidence.reusedSocketIdleP99Ms !== undefined);
    assert.ok("freshSocketAcceptToReqP99Ms" in body.operatorGate.evidence);
    assert.ok("reusedSocketReqToHandlerP99Ms" in body.operatorGate.evidence);
    assert.ok("freshHttpReqEventToHandlerP99Ms" in body.operatorGate.evidence);
  } finally {
    await server.close();
  }
});

test("server keepAliveTimeout is configurable via options and env", async () => {
  // Option override
  const optServer = await startTestServer({ keepAliveTimeoutMs: 30000 });
  try {
    const res = await fetch(`${optServer.baseUrl}/schedz`, {
      headers: { "x-a2a-edge-secret": "test-edge-secret" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.connections.httpServer.keepAliveTimeoutMs, 30000);
    assert.equal(body.connections.httpServer.socketReusePolicy, "keep-alive (reuse enabled)");

    const address = optServer.runtime.server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    // Verify keepAliveTimeout takes effect: reuse connection with keep-alive agent.
    const http = await import("node:http");
    const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000 });
    for (let i = 0; i < 2; i++) {
      await new Promise<void>((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port,
          path: "/livez",
          agent,
          method: "GET",
        }, (resp) => {
          let data = "";
          resp.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          resp.on("end", () => resolve());
        });
        req.on("error", reject);
        req.end();
      });
    }
    agent.destroy();

    const res2 = await fetch(`${optServer.baseUrl}/schedz`, {
      headers: { "x-a2a-edge-secret": "test-edge-secret" },
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    // The second request on the same agent connection should register as reused.
    assert.ok(body2.perRequest.onReusedConnection >= 1);
  } finally {
    await optServer.close();
  }
});

test("server uses unknown build revision fallback instead of null", async () => {
  await withEnv({ A2A_BROKER_REVISION: undefined, BROKER_RELEASE_REVISION: undefined, RELEASE_REVISION: undefined }, async () => {
    const server = await startTestServer({ buildInfoFile: "/dev/null" });
    try {
      const healthRes = await fetch(`${server.baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const health = await healthRes.json();
      assert.equal(typeof health.version, "string");
      assert.notEqual(health.version, "");
      assert.equal(health.build.revision, "unknown");
      assert.notEqual(health.build.revision, null);
    } finally {
      await server.close();
    }
  });
});

test("server redacts unsafe build metadata from health", async () => {
  await withEnv({
    A2A_BROKER_REVISION: "https://credential.example.invalid/unsafe-revision",
    A2A_BROKER_SOURCE: "https://credential.example.invalid/private/repo.git",
    A2A_BROKER_IMAGE_TAG: "private.registry.local/team/image:tag with secret",
    A2A_BROKER_IMAGE_DIGEST: "not-a-valid-digest-with-secret-path",
  }, async () => {
    const server = await startTestServer();
    try {
      const healthRes = await fetch(`${server.baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const healthText = await healthRes.text();
      assert.doesNotMatch(healthText, /credential\.example\.invalid|unsafe-revision|secret-path|private\.registry/);
      const health = JSON.parse(healthText);
      assert.equal(health.build.revision, "redacted");
      assert.equal(health.build.source, "github.com/jinwon-int/a2a-nexus");
      assert.equal(health.build.image, undefined);
    } finally {
      await server.close();
    }
  });
});

test("server normalizes legacy a2a-broker provenance to canonical a2a-nexus source", async () => {
  await withEnv({
    A2A_BROKER_SOURCE: "github.com/jinwon-int/a2a-broker",
  }, async () => {
    const server = await startTestServer();
    try {
      const healthRes = await fetch(`${server.baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const health = await healthRes.json();
      assert.equal(health.build.source, "github.com/jinwon-int/a2a-nexus");
    } finally {
      await server.close();
    }
  });
});

test("server requires x-a2a-edge-secret on non-health routes when configured", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    rateLimitMaxRequests: 1,
    workerRateLimitMaxRequests: 1,
  });

  try {
    const healthRes = await fetch(`${server.baseUrl}/health`);
    assert.equal(healthRes.status, 200);

    const livezRes = await fetch(`${server.baseUrl}/livez`);
    assert.equal(livezRes.status, 200);

    const agentCardRes = await fetch(`${server.baseUrl}/.well-known/agent-card.json`);
    assert.equal(agentCardRes.status, 200);

    const missingSecretRes = await fetch(`${server.baseUrl}/workers/register`, {
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
    assert.equal(missingSecretRes.status, 401);

    const wrongSecretRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "wrong-secret",
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
    assert.equal(wrongSecretRes.status, 401);

    const allowedRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
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
    assert.equal(allowedRes.status, 201);

    const health = await healthRes.json();
    assert.equal(health.requestSecurity.edgeSecretRequired, true);
  } finally {
    await server.close();
  }
});

test("GET /dashboard returns aggregated summary without authentication", async () => {
  const server = await startTestServer({
    edgeSecret: "test-secret",
    enforceRequesterIdentity: true,
  });
  try {
    // Dashboard should require edge secret (it's not /health)
    const noSecretRes = await fetch(`${server.baseUrl}/dashboard`);
    assert.equal(noSecretRes.status, 401);

    const res = await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "test-secret" },
    });
    assert.equal(res.status, 200);
    const dashboard = await res.json();

    assert.ok(dashboard.generatedAt);
    assert.ok(typeof dashboard.queue === "object");
    assert.ok(typeof dashboard.queue.total === "number");
    assert.ok(typeof dashboard.queue.byStatus === "object");
    assert.ok(typeof dashboard.queue.oldestPending === "object");
    assert.ok(typeof dashboard.history === "object");
    assert.ok(typeof dashboard.history.totalCompleted === "number");
    assert.ok(typeof dashboard.history.totalFailed === "number");
    assert.ok(typeof dashboard.history.recent === "object");
    assert.ok(typeof dashboard.proposals === "object");
    assert.ok(typeof dashboard.proposals.total === "number");
    assert.ok(typeof dashboard.proposals.pendingAction === "object");
    assert.ok(typeof dashboard.workers === "object");
    assert.ok(typeof dashboard.workers.total === "number");
    assert.ok(typeof dashboard.workers.online === "number");
    assert.ok(typeof dashboard.workers.stale === "number");
    assert.ok(typeof dashboard.workers.byNode === "object");
    assert.ok(typeof dashboard.observability === "object");
    assert.ok(typeof dashboard.observability.queuePressure === "object");
    assert.ok(typeof dashboard.observability.recovery === "object");
    assert.ok(typeof dashboard.observability.workerHealth === "object");
    assert.ok(typeof dashboard.staleReaper === "object");
    assert.ok(typeof dashboard.staleReaper.enabled === "boolean");
    assert.ok(typeof dashboard.staleReaper.runCount === "number");
    assert.ok(typeof dashboard.attention === "object");
    assert.ok(typeof dashboard.attention.highestSeverity === "string");
    assert.ok(Array.isArray(dashboard.attention.items));
    assert.ok(typeof dashboard.requestPressure === "object");
    assert.ok(typeof dashboard.requestPressure.general === "object");
    assert.ok(typeof dashboard.requestPressure.worker === "object");
    assert.deepEqual(dashboard.persistenceQueue, {
      kind: "broker.persistence.queue",
      enabled: false,
      mode: "inline",
      state: "disabled",
      capacity: null,
      queued: 0,
      active: 0,
      inFlight: 0,
      available: null,
      closing: false,
      aborted: false,
    });

    // Empty state defaults
    assert.equal(dashboard.queue.total, 0);
    assert.equal(dashboard.history.totalCompleted, 0);
    assert.equal(dashboard.workers.total, 0);
    assert.equal(dashboard.observability.queuePressure.queued, 0);
    assert.equal(dashboard.observability.recovery.totalDeadLettered, 0);
    assert.equal(dashboard.staleReaper.runCount, 0);
    assert.equal(dashboard.attention.highestSeverity, "none");
    assert.equal(dashboard.attention.items.length, 0);
  } finally {
    await server.close();
  }
});

test("GET /dashboard reflects task lifecycle after create/claim/complete", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    // Register worker
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    // Check empty dashboard
    const emptyDash = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(emptyDash.queue.total, 0);
    assert.equal(emptyDash.workers.total, 1);

    // Create a task
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "test-task",
      }),
    });
    const task = await taskRes.json();

    // Dashboard should show 1 pending task
    const queuedDash = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(queuedDash.queue.total, 1);
    assert.equal(queuedDash.queue.byStatus["queued"], 1);
    assert.ok(typeof queuedDash.queue.oldestPending[0].statusSinceAt === "string");
    assert.ok(typeof queuedDash.queue.oldestPending[0].statusAgeSec === "number");

    // Claim and complete
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });

    const runningDash = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.ok(typeof runningDash.observability.queuePressure.oldestRunning.statusSinceAt === "string");
    assert.ok(typeof runningDash.observability.queuePressure.oldestRunning.statusAgeSec === "number");
    assert.ok(typeof runningDash.workers.byNode[0].lastSeenAgeSec === "number");

    await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1", result: { summary: "done" } }),
    });

    // Dashboard should show completed
    const doneDash = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(doneDash.queue.total, 0);
    assert.equal(doneDash.history.totalCompleted, 1);
    assert.equal(doneDash.history.completedLastHour, 1);
    assert.equal(doneDash.history.recent.length, 1);
    assert.equal(doneDash.history.recent[0].status, "succeeded");
    assert.equal(doneDash.observability.queuePressure.queued, 0);
    assert.equal(doneDash.observability.queuePressure.claimed, 0);
    assert.equal(doneDash.observability.queuePressure.running, 0);
  } finally {
    await server.close();
  }
});

test("GET /operator/task-report summarizes watched task progress and results", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const create = async (pullRequest: string, payloadExtra: Record<string, unknown> = {}) => {
      const res = await fetch(`${server.baseUrl}/tasks`, {
        method: "POST",
        headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
        body: JSON.stringify({
          intent: "propose_patch",
          requester: { id: "hub-1", kind: "node", role: "hub" },
          target: { id: "w1", kind: "node", role: "analyst" },
          assignedWorkerId: "w1",
          message: `fix ${pullRequest}`,
          taskOrigin: "github",
          payload: { pullRequest, lane: "operator-report", ...payloadExtra },
        }),
      });
      const text = await res.text();
      assert.equal(res.status, 201, text);
      return JSON.parse(text);
    };

    const runningTask = await create("#10", { parentIssue: "jinwon-int/a2a-broker#364" });
    const doneTask = await create("#11", { parentIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/364" });
    await create("#12", { parentIssue: "jinwon-int/a2a-broker#360" });

    await fetch(`${server.baseUrl}/tasks/${runningTask.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await fetch(`${server.baseUrl}/tasks/${runningTask.id}/start`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await fetch(`${server.baseUrl}/tasks/${doneTask.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await fetch(`${server.baseUrl}/tasks/${doneTask.id}/complete`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        workerId: "w1",
        result: { output: { github: { prUrl: "https://github.com/o/r/pull/11" } } },
      }),
    });

    const reportRes = await fetch(
      `${server.baseUrl}/operator/task-report?task_id=${runningTask.id}&task_id=${doneTask.id}&stale_after_ms=1`,
      { headers: { "x-a2a-edge-secret": "s", "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" } },
    );
    const reportText = await reportRes.text();
    assert.equal(reportRes.status, 200, reportText);
    const report = JSON.parse(reportText);

    assert.equal(report.total, 2);
    assert.equal(report.terminal, 1);
    assert.equal(report.active, 1);
    assert.equal(report.allTerminal, false);
    const running = report.items.find((item: { taskId: string }) => item.taskId === runningTask.id);
    const done = report.items.find((item: { taskId: string }) => item.taskId === doneTask.id);
    assert.equal(running.kind, "stale");
    assert.match(running.reportLine, /중간보고 필요/);
    assert.equal(done.kind, "result");
    assert.equal(done.github.prUrl, "https://github.com/o/r/pull/11");
    assert.match(done.reportLine, /완료/);

    const parentReportRes = await fetch(
      `${server.baseUrl}/operator/task-report?parent_issue=jinwon-int/a2a-broker%23364`,
      { headers: { "x-a2a-edge-secret": "s", "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" } },
    );
    const parentReportText = await parentReportRes.text();
    assert.equal(parentReportRes.status, 200, parentReportText);
    const parentReport = JSON.parse(parentReportText);
    assert.deepEqual(parentReport.items.map((item: { taskId: string }) => item.taskId).sort(), [doneTask.id, runningTask.id].sort());
  } finally {
    await server.close();
  }
});

test("GET /dashboard respects query parameters for limits", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    // Create multiple tasks
    for (let i = 0; i < 5; i++) {
      await fetch(`${server.baseUrl}/tasks`, {
        method: "POST",
        headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
        body: JSON.stringify({
          intent: "analyze",
          requester: { id: "hub-1", kind: "node", role: "hub" },
          target: { id: "w1", kind: "node", role: "analyst" },
          assignedWorkerId: "w1",
          message: `task-${i}`,
        }),
      });
    }

    // Default limit (5)
    const defaultDash = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(defaultDash.queue.oldestPending.length, 5);

    // Custom limit (2)
    const limitedDash = await (await fetch(`${server.baseUrl}/dashboard?oldest_pending_limit=2`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(limitedDash.queue.oldestPending.length, 2);
  } finally {
    await server.close();
  }
});

test("stale reaper surfaces config and last-run status via /health", async () => {
  const server = await startTestServer({
    staleReaperEnabled: true,
    staleReaperIntervalSec: 120,
    staleReaperOlderThanSec: 240,
  });
  try {
    const health = await (await fetch(`${server.baseUrl}/health`)).json();
    assert.ok(health.staleReaper);
    assert.equal(health.staleReaper.enabled, true);
    assert.equal(health.staleReaper.intervalSec, 120);
    assert.equal(health.staleReaper.olderThanSec, 240);
    assert.equal(health.staleReaper.runCount, 0);
    assert.ok(health.requestPressure);
    assert.ok(health.requestPressure.general);
    assert.ok(health.requestPressure.worker);

    assert.equal(server.runtime.config.staleReaperEnabled, true);
    assert.equal(server.runtime.config.staleReaperIntervalSec, 120);
    assert.equal(server.runtime.config.staleReaperOlderThanSec, 240);
  } finally {
    await server.close();
  }
});

test("stale reaper dead-letters tasks exceeding maxRequeueAttempts and exposes the cap on /health", async () => {
  const server = await startTestServer({
    edgeSecret: "s",
    staleReaperEnabled: false,
    staleReaperOlderThanSec: 0,
    workerOfflineAfterSec: 1,
    maxRequeueAttempts: 1,
  });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    const health = await (await fetch(`${server.baseUrl}/health`)).json();
    assert.equal(health.staleReaper.maxRequeueAttempts, 1);
    assert.equal(health.staleReaper.totalDeadLettered, 0);

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "analyze payload",
      }),
    });
    const task = await taskRes.json();

    // First cycle: claim then reap — should requeue (attempt 1).
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    assert.equal(server.runtime.runStaleReaperSweep(), 1);

    // Second cycle: claim then reap — should dead-letter because the cap was reached.
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    assert.equal(server.runtime.runStaleReaperSweep(), 0);

    const finalTask = await (await fetch(`${server.baseUrl}/tasks/${task.id}`, {
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
    })).json();
    assert.equal(finalTask.status, "failed");
    assert.equal(finalTask.error.code, "exceeded_requeue_limit");
    assert.equal(finalTask.requeueCount, 1);

    const status = server.runtime.getStaleReaperStatus();
    assert.equal(status.runCount, 2);
    assert.equal(status.lastRequeued, 0);
    assert.equal(status.lastDeadLettered, 1);
    assert.equal(status.totalDeadLettered, 1);

    const healthAfter = await (await fetch(`${server.baseUrl}/health`)).json();
    assert.equal(healthAfter.staleReaper.totalDeadLettered, 1);
    assert.equal(healthAfter.staleReaper.lastDeadLettered, 1);

    const dashboardAfter = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(dashboardAfter.observability.recovery.totalRequeued, 1);
    assert.equal(dashboardAfter.observability.recovery.totalDeadLettered, 1);
    assert.equal(dashboardAfter.observability.recovery.recentDeadLetters.length, 1);
    assert.equal(dashboardAfter.staleReaper.runCount, 2);
    assert.equal(dashboardAfter.staleReaper.totalDeadLettered, 1);
    assert.equal(dashboardAfter.staleReaper.lastDeadLettered, 1);
    assert.equal(dashboardAfter.attention.highestSeverity, "warn");
    assert.ok(dashboardAfter.attention.items.some((item: { code: string }) => item.code === "dead-lettered-tasks"));
  } finally {
    await server.close();
  }
});

test("GET /dashboard attention flags aged claimed and running tasks", async () => {
  const server = await startTestServer({
    edgeSecret: "s",
    staleReaperEnabled: false,
    staleReaperOlderThanSec: 1,
    workerOfflineAfterSec: 120,
  });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "attention task",
      }),
    });
    const task = await taskRes.json();

    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    let dashboard = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.ok(dashboard.attention.items.some((item: { code: string }) => item.code === "aged-claimed-task"));

    await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    dashboard = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.ok(dashboard.attention.items.some((item: { code: string }) => item.code === "aged-running-task"));
  } finally {
    await server.close();
  }
});
