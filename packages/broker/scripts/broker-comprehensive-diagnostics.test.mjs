import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runDiagnostics,
  runLiveDiagnostics,
  runLivezConnectionModeComparison,
  runNoLiveDiagnostics,
  classifyLivezAttribution,
  classifyLivezSlowSampleAttribution,
  buildStrictLivezCloseGate,
  buildLivezSocketReusePolicy,
  extractLivezMeasurement,
  extractSchedzMeasurement,
  readProcRunQueue,
} from "./broker-comprehensive-diagnostics.mjs";
import {
  collectHostDiagnostics,
} from "./broker-livez-stall-attribution.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function simpleLivezBody() {
  const handlerStartUnixMs = Date.now();
  return {
    ok: true,
    service: "a2a-broker",
    brokerId: "test-broker",
    uptimeSec: 3600,
    eventLoop: { delayMs: 0.05 },
    cpu: { percentSinceLastCheck: 2.5, deltaIntervalMs: 500 },
    timing: {
      count: 200, minMs: 0.01, maxMs: 0.5, avgMs: 0.08,
      p50Ms: 0.02, p95Ms: 0.3, p99Ms: 0.45, p999Ms: 0.5,
    },
    activeRequests: 2,
    requestDurationMs: 0.03,
    diagMs: 0.02,
    probeTiming: {
      handlerStartUnixMs,
      responsePreparedUnixMs: handlerStartUnixMs + 1,
      responsePreparationDurationMs: 0.03,
      socketConnectedUnixMs: handlerStartUnixMs - 2,
      socketAgeBeforeHandlerMs: 2,
      socketIdleBeforeRequestMs: null,
      socketRequestIndex: 1,
      socketHadServedRequest: false,
      clientProbeStartUnixMs: handlerStartUnixMs - 3,
      clientProbeStartToHandlerStartMs: 3,
      clientProbeStartToSocketConnectedMs: 1,
      httpRequestEventUnixMs: handlerStartUnixMs,
      socketAcceptedToHttpRequestEventMs: 2,
      httpRequestEventToHandlerStartMs: 0,
      socketIdleBeforeHttpRequestEventMs: null,
      reuseIdleBeforeDataMs: null,
      reuseDataToHttpRequestEventMs: null,
    },
  };
}

function simpleSchedzBody() {
  return {
    ok: true,
    service: "a2a-broker",
    brokerId: "test-broker",
    totalAccepted: 15000,
    activeRequests: 2,
    host: {
      loadavg1: 0.5, loadavg5: 0.4, loadavg15: 0.3,
      cpuCount: 4, loadPerCpu: 0.125, snapshotAtMs: Date.now(),
    },
    schedulingTiming: {
      count: 200, minMs: 0.01, maxMs: 2949, avgMs: 120,
      p50Ms: 0.3, p95Ms: 2695, p99Ms: 2936, p999Ms: 3200,
    },
    requestRoutes: {
      livez: {
        active: 0,
        timing: { count: 20, minMs: 0.01, maxMs: 0.5, avgMs: 0.08, p50Ms: 0.02, p95Ms: 0.3, p99Ms: 0.45, p999Ms: 0.5 },
        firstRequestLatencyMs: { count: 5, minMs: 0.1, maxMs: 1.2, avgMs: 0.4, p50Ms: 0.2, p95Ms: 1.1, p99Ms: 1.2, p999Ms: 1.2 },
        onNewConnection: 5,
        onReusedConnection: 15,
      },
      "workers.register": {
        active: 1,
        timing: { count: 8, minMs: 0.2, maxMs: 2810, avgMs: 120, p50Ms: 0.6, p95Ms: 2600, p99Ms: 2810, p999Ms: 2810 },
        firstRequestLatencyMs: { count: 3, minMs: 0.2, maxMs: 2700, avgMs: 900, p50Ms: 0.6, p95Ms: 2600, p99Ms: 2700, p999Ms: 2700 },
        onNewConnection: 3,
        onReusedConnection: 5,
      },
    },
    routeHandlerBodyTiming: {
      livez: { count: 20, minMs: 0.01, maxMs: 0.08, avgMs: 0.03, p50Ms: 0.02, p95Ms: 0.06, p99Ms: 0.08, p999Ms: 0.08 },
      "workers.register": { count: 8, minMs: 0.2, maxMs: 2810, avgMs: 120, p50Ms: 0.6, p95Ms: 2600, p99Ms: 2810, p999Ms: 2810 },
    },
    connections: {
      totalConnections: 20,
      activeConnections: 2,
      peakConnections: 4,
      connectionDurationMs: { count: 3, minMs: 10, maxMs: 5000, avgMs: 1200, p95Ms: 5000, p99Ms: 5000 },
      httpServer: {
        keepAliveTimeoutMs: 5000,
        headersTimeoutMs: 60000,
        requestTimeoutMs: 300000,
        timeoutMs: 0,
        maxRequestsPerSocket: 0,
        maxConnections: null,
        connectionsCheckingIntervalMs: 30000,
      },
    },
    workerHeartbeatPhases: {
      readJson: {
        count: 12, minMs: 0.02, maxMs: 1.2, avgMs: 0.1,
        p50Ms: 0.04, p95Ms: 0.8, p99Ms: 1.2, p999Ms: 1.2,
      },
      brokerHeartbeat: {
        count: 12, minMs: 0.2, maxMs: 2825, avgMs: 120,
        p50Ms: 0.6, p95Ms: 2600, p99Ms: 2825, p999Ms: 2825,
      },
    },
    workerRegisterPhases: {
      readJson: {
        count: 4, minMs: 0.02, maxMs: 0.8, avgMs: 0.1,
        p50Ms: 0.04, p95Ms: 0.8, p99Ms: 0.8, p999Ms: 0.8,
      },
      brokerRegister: {
        count: 4, minMs: 0.2, maxMs: 2175, avgMs: 120,
        p50Ms: 0.6, p95Ms: 2175, p99Ms: 2175, p999Ms: 2175,
      },
    },
    perWorkerHeartbeatPhases: {
      "worker-slow": {
        readJson: {
          count: 4, minMs: 0.02, maxMs: 0.8, avgMs: 0.1,
          p50Ms: 0.04, p95Ms: 0.8, p99Ms: 0.8, p999Ms: 0.8,
        },
        brokerHeartbeat: {
          count: 4, minMs: 0.2, maxMs: 2825, avgMs: 120,
          p50Ms: 0.6, p95Ms: 2600, p99Ms: 2825, p999Ms: 2825,
        },
      },
    },
    perWorkerRegisterPhases: {
      "worker-slow": {
        readJson: null,
        authAssert: {
          count: 4, minMs: 0.01, maxMs: 0.2, avgMs: 0.03,
          p50Ms: 0.02, p95Ms: 0.1, p99Ms: 0.2, p999Ms: 0.2,
        },
        brokerRegister: {
          count: 4, minMs: 0.2, maxMs: 2175, avgMs: 120,
          p50Ms: 0.6, p95Ms: 2175, p99Ms: 2175, p999Ms: 2175,
        },
        toWorkerView: {
          count: 4, minMs: 0.01, maxMs: 0.8, avgMs: 0.08,
          p50Ms: 0.04, p95Ms: 0.6, p99Ms: 0.8, p999Ms: 0.8,
        },
      },
    },
    terminalOutbox: {
      retainedCount: 42,
      sampledCount: 42,
      sampleLimit: 200,
      pendingAckCount: 7,
      oldestPendingAckAgeMs: 12_345,
      topWorkers: [{ key: "worker-slow", count: 8 }],
      topStatuses: [{ key: "succeeded", count: 24 }],
      topReceiptStatuses: [{ key: "accepted", count: 7 }],
      topBrokersOfRecord: [{ key: "seoseo", count: 42 }],
      topPendingAckWorkers: [{ key: "worker-slow", count: 7 }],
      topPendingAckStatuses: [{ key: "succeeded", count: 7 }],
      topPendingAckReceiptStatuses: [{ key: "accepted", count: 7 }],
      topPendingAckBrokersOfRecord: [{ key: "seoseo", count: 7 }],
      oldestPendingAckWorker: "worker-slow",
      oldestPendingAckStatus: "succeeded",
      oldestPendingAckReceiptStatus: "accepted",
      oldestPendingAckBrokerOfRecord: "seoseo",
    },
    container: {
      cgroup: {
        cpu: {
          usageUsec: 4_200_000_000,
          userUsec: 3_100_000_000,
          systemUsec: 1_100_000_000,
          nrPeriods: 420_000,
          nrThrottled: 0,
          throttledUsec: 0,
          snapshotAtMs: Date.now(),
        },
        cpuLimit: { quotaUsec: 400_000, periodUsec: 100_000, cpus: 4.0 },
        cpuDelta: null,
      },
      psi: {
        cpu: {
          some: { avg10: 0.14, avg60: 0.08, avg300: 0.04, total: 490_000_000 },
          full: { avg10: 0.02, avg60: 0.01, avg300: 0.005, total: 80_000_000 },
        },
        memory: { some: { avg10: 0.0, avg60: 0.0, avg300: 0.0, total: 0 }, full: { avg10: 0.0, avg60: 0.0, avg300: 0.0, total: 0 } },
        io: { some: { avg10: 0.0, avg60: 0.0, avg300: 0.0, total: 0 }, full: { avg10: 0.0, avg60: 0.0, avg300: 0.0, total: 0 } },
        snapshotAtMs: Date.now(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("broker comprehensive diagnostics (no-live)", () => {
  it("produces deterministic passing no-live report", () => {
    const report = runNoLiveDiagnostics({ count: 10 });

    assert.equal(report.kind, "a2a-broker.comprehensive-diagnostics.v1");
    assert.equal(report.issue, "#1032");
    assert.equal(report.laneIssue, "#1053");
    assert.equal(report.runId, "broker-1032-allhands-scheduling-20260531T121928Z");
    assert.equal(report.mode, "no-live");
    assert.equal(report.probeCount, 10);
    assert.equal(report.livezWallSamplesAbove3s, 0);
    assert.equal(report.livezWallSamplesAbove1s, 0);
    assert.ok(report.livezMaxMs < 1000);
    assert.ok(report.schedzMaxMs < 1000);
    assert.equal(report.ok, true);
    assert.ok(Array.isArray(report.checks));
    assert.ok(report.checks.length >= 7);

    // Safety: no secrets, paths
    assert.equal(report.baseUrl, "http://no-live.synthetic");
    assert.doesNotMatch(JSON.stringify(report), /token|secret|chat_id|\/work\/repo/);

    // Gate check structure
    const safetyCheck = report.checks.find((c) => c.check === "safety gate");
    assert.ok(safetyCheck);
    assert.equal(safetyCheck.ok, true);

    // Host metrics should be populated
    assert.ok(report.hostMetricsSummary !== undefined);
    assert.ok(Array.isArray(report.correlatedProbes));

    // Scheduling data should be present in no-live synthetic mode
    assert.ok(report.schedzSchedulingSummary);
    assert.ok(report.schedzSchedulingSummary.sampleCount > 0);
    assert.ok(report.schedzSchedulingSummary.maxMs > 0);
    assert.ok(report.schedzSchedulingSummary.p99Ms > 0);

    // livezTimingSummary should be populated
    assert.ok(report.livezTimingSummary);
    assert.ok(report.livezTimingSummary.handlerRequestDurationMs);
    assert.ok(report.livezTimingSummary.diagMs);
    assert.ok(report.livezAttribution);
    assert.equal(report.livezAttribution.bucket, "no-significant-stall");
    assert.equal(report.livezAttribution.confidence, "high");
    assert.equal(report.livezConnectionMode, "default");
    assert.ok(report.livezSpikeCorrelation);
    assert.equal(report.livezSpikeCorrelation.slowSamples, 0);
  });

  it("detects scheduling spike in simulateStall mode", () => {
    const report = runNoLiveDiagnostics({ count: 10, simulateStall: true });
    assert.equal(report.mode, "no-live-simulated-stall");
    assert.ok(report.livezMaxMs > 3000);
    assert.equal(report.livezWallSamplesAbove3s, 1);
    assert.equal(report.ok, false);

    const livezCheck = report.checks.find((c) => c.check === "livez max latency gate");
    assert.ok(livezCheck);
    assert.equal(livezCheck.ok, false);
    assert.match(livezCheck.detail, /exceeds 3000ms/);
    assert.ok(report.livezAttribution);
    assert.equal(report.livezAttribution.bucket, "broker-scheduling-or-competing-route");
    assert.ok(report.livezSpikeCorrelation);
    assert.equal(report.livezSpikeCorrelation.slowSamples, 1);
    assert.equal(report.livezSpikeCorrelation.byConnectionReuse.reusedSocket.count, 1);
    assert.equal(report.livezSpikeCorrelation.topSlowSamples[0].socketHadServedRequest, true);
    // Per-request timing breakdown fields (C6 attributable stall evidence).
    // Exact-value assertions from the deterministic fixture (sampleLivezBody index 9).
    assert.equal(report.livezSpikeCorrelation.topSlowSamples[0].socketAgeBeforeHandlerMs, 2,
      "topSlowSamples should carry socketAgeBeforeHandlerMs");
    assert.equal(report.livezSpikeCorrelation.topSlowSamples[0].socketAcceptedToHttpRequestEventMs, 2,
      "topSlowSamples should carry socketAcceptedToHttpRequestEventMs");
    assert.equal(report.livezSpikeCorrelation.topSlowSamples[0].httpRequestEventToHandlerStartMs, 0,
      "topSlowSamples should carry httpRequestEventToHandlerStartMs");
    assert.equal(report.livezSpikeCorrelation.topSlowSamples[0].socketIdleBeforeHttpRequestEventMs, 500,
      "topSlowSamples should carry socketIdleBeforeHttpRequestEventMs");
    assert.equal(report.livezSpikeCorrelation.topSlowSamples[0].reuseIdleBeforeDataMs, 450,
      "topSlowSamples should carry reuseIdleBeforeDataMs");
    assert.equal(report.livezSpikeCorrelation.topSlowSamples[0].reuseDataToHttpRequestEventMs, 50,
      "topSlowSamples should carry reuseDataToHttpRequestEventMs");
  });

  it("produces /schedz timing data in no-live mode", () => {
    const report = runNoLiveDiagnostics({ count: 10 });
    assert.ok(report.schedzSchedulingMaxMs > 0);
    assert.ok(report.schedzSchedulingP99Ms > 0);
    assert.ok(report.schedzSchedulingP95Ms > 0);
    assert.ok(report.schedzSchedulingP50Ms > 0);
    assert.ok(report.schedzSchedulingP50Ms <= report.schedzSchedulingP95Ms);
    assert.ok(report.schedzSchedulingP95Ms <= report.schedzSchedulingP99Ms);
    assert.ok(Array.isArray(report.requestRouteSummary));
    assert.ok(report.requestRouteSummary.some((entry) => entry.route === "workers.register"));
    assert.ok(Array.isArray(report.workerHeartbeatPhaseSummary));
    assert.ok(report.workerHeartbeatPhaseSummary.some((entry) => entry.phase === "brokerHeartbeat"));
  });

  it("produces a bounded no-live connection-mode comparison report", async () => {
    const report = await runLivezConnectionModeComparison({ noLive: true, count: 5 });

    assert.equal(report.kind, "a2a-broker.comprehensive-diagnostics.connection-mode-comparison.v1");
    assert.equal(report.mode, "no-live-connection-mode-comparison");
    assert.deepEqual(report.comparison.modes, ["default", "fresh", "keep-alive"]);
    assert.equal(report.comparison.countPerMode, 5);
    assert.equal(report.comparison.totalLivezProbes, 15);
    assert.ok(report.perMode.default);
    assert.ok(report.perMode.fresh);
    assert.ok(report.perMode["keep-alive"]);
    assert.equal(report.perMode.default.probeCount, 5);
    assert.ok(report.perMode.default.livezSpikeCorrelation);
    assert.ok(Array.isArray(report.perMode.default.slowSampleAttributionRows));
    assert.equal(report.livezSocketReusePolicy.operatorAction, "observe");
    assert.equal(report.livezSocketReusePolicy.reusedSocketResidualPolicy, "no_residual_observed");
    assert.equal(report.ok, true);
    assert.doesNotMatch(JSON.stringify(report), /x-a2a-edge-secret|edge-secret-placeholder/);
  });

  it("classifies reused-socket idle residuals as observable probe latency", () => {
    const policy = buildLivezSocketReusePolicy({
      default: {
        livezFailureCount: 0,
        schedzFailureCount: 0,
        livezWallSamplesAbove1s: 2,
        livezWallSamplesAbove3s: 0,
        livezAttribution: { bucket: "reused-socket-idle-before-request-event" },
      },
      fresh: {
        livezFailureCount: 0,
        schedzFailureCount: 0,
        livezWallSamplesAbove1s: 0,
        livezWallSamplesAbove3s: 0,
        livezAttribution: { bucket: "no-significant-stall" },
      },
      "keep-alive": {
        livezFailureCount: 0,
        schedzFailureCount: 0,
        livezWallSamplesAbove1s: 1,
        livezWallSamplesAbove3s: 0,
        livezAttribution: { bucket: "reused-socket-idle-before-request-event" },
      },
    }, {
      livezFailureCount: 0,
      livezWallSamplesAbove1s: 0,
      livezWallSamplesAbove3s: 0,
    });

    assert.equal(policy.operatorAction, "observe");
    assert.equal(policy.strictWallClockGateMode, "fresh-and-livez-only");
    assert.equal(policy.reusedSocketResidualPolicy, "acceptable_residual_client_probe_latency");
  });

  it("does not classify fresh-socket >1s samples as socket-reuse residuals", () => {
    const policy = buildLivezSocketReusePolicy({
      default: {
        livezFailureCount: 0,
        schedzFailureCount: 0,
        livezWallSamplesAbove1s: 0,
        livezWallSamplesAbove3s: 0,
      },
      fresh: {
        livezFailureCount: 0,
        schedzFailureCount: 0,
        livezWallSamplesAbove1s: 1,
        livezWallSamplesAbove3s: 0,
      },
      "keep-alive": {
        livezFailureCount: 0,
        schedzFailureCount: 0,
        livezWallSamplesAbove1s: 0,
        livezWallSamplesAbove3s: 0,
      },
    });

    assert.equal(policy.operatorAction, "investigate");
    assert.equal(policy.reusedSocketResidualPolicy, "not_applicable");
  });

  it("preserves slow-sample attribution rows in connection-mode comparison reports", async () => {
    const report = await runLivezConnectionModeComparison({ noLive: true, count: 5, simulateStall: true });

    assert.equal(report.ok, false);
    for (const mode of ["default", "fresh", "keep-alive"]) {
      const summary = report.perMode[mode];
      assert.ok(summary);
      assert.equal(summary.livezSpikeCorrelation.slowSamples, 1);
      assert.equal(summary.slowSampleAttributionRows.length, 1);
      assert.equal(summary.slowSampleAttributionRows[0].mode, mode);
      assert.equal(summary.slowSampleAttributionRows[0].index, 4);
      assert.equal(summary.slowSampleAttributionRows[0].livezWallMs, 4200);
      assert.equal(summary.slowSampleAttributionRows[0].socketHadServedRequest, true);
      // Per-request timing breakdown fields (C6 attributable stall evidence).
      // Exact-value assertions from the deterministic fixture (sampleLivezBody index 4).
      assert.equal(summary.slowSampleAttributionRows[0].socketAgeBeforeHandlerMs, 2,
        `slowSampleAttributionRows[${mode}] should carry socketAgeBeforeHandlerMs`);
      assert.equal(summary.slowSampleAttributionRows[0].socketAcceptedToHttpRequestEventMs, 2,
        `slowSampleAttributionRows[${mode}] should carry socketAcceptedToHttpRequestEventMs`);
      assert.equal(summary.slowSampleAttributionRows[0].httpRequestEventToHandlerStartMs, 0,
        `slowSampleAttributionRows[${mode}] should carry httpRequestEventToHandlerStartMs`);
      assert.equal(summary.slowSampleAttributionRows[0].socketIdleBeforeHttpRequestEventMs, 500,
        `slowSampleAttributionRows[${mode}] should carry socketIdleBeforeHttpRequestEventMs`);
      assert.equal(summary.slowSampleAttributionRows[0].reuseIdleBeforeDataMs, 450,
        `slowSampleAttributionRows[${mode}] should carry reuseIdleBeforeDataMs`);
      assert.equal(summary.slowSampleAttributionRows[0].reuseDataToHttpRequestEventMs, 50,
        `slowSampleAttributionRows[${mode}] should carry reuseDataToHttpRequestEventMs`);
      assert.equal(summary.slowSampleAttributionRows[0].schedzSchedulingMaxMs, 2949,
        `slowSampleAttributionRows[${mode}] should carry schedzSchedulingMaxMs`);
      assert.equal(summary.slowSampleAttributionRows[0].schedzTopRoute, "workers.register",
        `slowSampleAttributionRows[${mode}] should carry schedzTopRoute`);
      assert.equal(summary.slowSampleAttributionRows[0].schedzTopRouteMaxMs, 2810,
        `slowSampleAttributionRows[${mode}] should carry schedzTopRouteMaxMs`);
      assert.equal(summary.slowSampleAttributionRows[0].workerHeartbeatTopPhase, "brokerHeartbeat",
        `slowSampleAttributionRows[${mode}] should carry workerHeartbeatTopPhase`);
      assert.equal(summary.slowSampleAttributionRows[0].workerHeartbeatTopPhaseMaxMs, 2810,
        `slowSampleAttributionRows[${mode}] should carry workerHeartbeatTopPhaseMaxMs`);
      assert.equal(summary.slowSampleAttributionRows[0].workerHeartbeatTopWorkerId, "worker-slow",
        `slowSampleAttributionRows[${mode}] should carry workerHeartbeatTopWorkerId`);
      assert.equal(summary.slowSampleAttributionRows[0].workerHeartbeatTopWorkerPhase, "brokerHeartbeat",
        `slowSampleAttributionRows[${mode}] should carry workerHeartbeatTopWorkerPhase`);
      assert.equal(summary.slowSampleAttributionRows[0].workerHeartbeatTopWorkerPhaseMaxMs, 2810,
        `slowSampleAttributionRows[${mode}] should carry workerHeartbeatTopWorkerPhaseMaxMs`);
      assert.equal(summary.slowSampleAttributionRows[0].workerRegisterTopPhase, "brokerRegister",
        `slowSampleAttributionRows[${mode}] should carry workerRegisterTopPhase`);
      assert.equal(summary.slowSampleAttributionRows[0].workerRegisterTopPhaseMaxMs, 2210,
        `slowSampleAttributionRows[${mode}] should carry workerRegisterTopPhaseMaxMs`);
      assert.equal(summary.slowSampleAttributionRows[0].workerRegisterTopWorkerId, "worker-slow",
        `slowSampleAttributionRows[${mode}] should carry workerRegisterTopWorkerId`);
      assert.equal(summary.slowSampleAttributionRows[0].workerRegisterTopWorkerPhase, "brokerRegister",
        `slowSampleAttributionRows[${mode}] should carry workerRegisterTopWorkerPhase`);
      assert.equal(summary.slowSampleAttributionRows[0].workerRegisterTopWorkerPhaseMaxMs, 2210,
        `slowSampleAttributionRows[${mode}] should carry workerRegisterTopWorkerPhaseMaxMs`);
      assert.equal(summary.slowSampleAttributionRows[0].terminalOutboxTopWorkerId, "worker-slow",
        `slowSampleAttributionRows[${mode}] should carry terminalOutboxTopWorkerId`);
      assert.equal(summary.slowSampleAttributionRows[0].terminalOutboxPendingAckCount, 7,
        `slowSampleAttributionRows[${mode}] should carry terminalOutboxPendingAckCount`);
      assert.equal(summary.slowSampleAttributionRows[0].terminalOutboxTopStatus, "succeeded",
        `slowSampleAttributionRows[${mode}] should carry terminalOutboxTopStatus`);
      assert.equal(summary.slowSampleAttributionRows[0].terminalOutboxOldestPendingAckAgeMs, 12004,
        `slowSampleAttributionRows[${mode}] should carry terminalOutboxOldestPendingAckAgeMs`);
      assert.equal(summary.slowSampleAttributionRows[0].terminalOutboxOldestPendingAckWorkerId, "worker-slow",
        `slowSampleAttributionRows[${mode}] should carry terminalOutboxOldestPendingAckWorkerId`);
      assert.equal(summary.slowSampleAttributionRows[0].terminalOutboxTopPendingAckStatus, "succeeded",
        `slowSampleAttributionRows[${mode}] should carry terminalOutboxTopPendingAckStatus`);
      assert.equal(summary.slowSampleAttributionRows[0].terminalOutboxTopPendingAckReceiptStatus, "accepted",
        `slowSampleAttributionRows[${mode}] should carry terminalOutboxTopPendingAckReceiptStatus`);
      assert.equal(summary.slowSampleAttributionRows[0].terminalOutboxTopPendingAckBrokerOfRecord, "seoseo",
        `slowSampleAttributionRows[${mode}] should carry terminalOutboxTopPendingAckBrokerOfRecord`);
      assert.equal(summary.slowSampleAttributionRows[0].containerCpuDeltaNrThrottled, 1,
        `slowSampleAttributionRows[${mode}] should carry containerCpuDeltaNrThrottled`);
      assert.equal(summary.slowSampleAttributionRows[0].containerCpuDeltaThrottledMs, 210,
        `slowSampleAttributionRows[${mode}] should carry containerCpuDeltaThrottledMs`);
      assert.equal(summary.slowSampleAttributionRows[0].containerPsiCpuSomeAvg10, 0.14,
        `slowSampleAttributionRows[${mode}] should carry containerPsiCpuSomeAvg10`);
      assert.equal(typeof summary.slowSampleAttributionRows[0].hostLoad1, "number",
        `slowSampleAttributionRows[${mode}] should carry hostLoad1`);
      assert.equal(typeof summary.slowSampleAttributionRows[0].attributionBucket, "string");
      assert.notEqual(summary.slowSampleAttributionRows[0].attributionBucket.length, 0);
      assert.equal(summary.heartbeatCorrelationAssessment.verdict, "correlation-only-no-persist-proof");
      assert.equal(summary.heartbeatCorrelationAssessment.dbPersistProof, false);
      assert.equal(summary.heartbeatCorrelationAssessment.evidenceRows, 1);
      assert.equal(summary.heartbeatCorrelationAssessment.brokerHeartbeatRows, 1);
      assert.deepEqual(summary.heartbeatCorrelationAssessment.topWorkerIds, ["worker-slow"]);
      assert.match(
        summary.heartbeatCorrelationAssessment.recommendation,
        /Avoid runtime per-heartbeat hot-path counters/,
      );
    }
    assert.equal(report.heartbeatCorrelationAssessment.verdict, "correlation-only-no-persist-proof");
    assert.equal(report.heartbeatCorrelationAssessment.dbPersistProof, false);
    assert.equal(report.heartbeatCorrelationAssessment.evidenceRows, 3);
    assert.equal(report.heartbeatCorrelationAssessment.brokerHeartbeatRows, 3);
    assert.deepEqual(report.heartbeatCorrelationAssessment.topWorkerIds, ["worker-slow"]);
    assert.doesNotMatch(JSON.stringify(report), /x-a2a-edge-secret|edge-secret-placeholder/);
  });

  it("fails strict #1032 close gate when connection-mode reports still have >1s /livez samples", async () => {
    const report = await runLivezConnectionModeComparison({
      noLive: true,
      count: 5,
      simulateResidualStall: true,
    });

    assert.equal(report.ok, false);
    assert.equal(report.strictCloseGate.ok, false);
    assert.equal(report.perMode.default.ok, true);
    assert.equal(report.perMode.default.livezWallSamplesAbove1s, 1);
    assert.equal(report.perMode.default.livezWallSamplesAbove3s, 0);
    const strictCheck = report.checks.find((check) => check.check === "strict #1032 livez close gate");
    assert.ok(strictCheck);
    assert.equal(strictCheck.ok, false);
    assert.ok(strictCheck.failures.some((failure) => (
      failure.scope === "connection-mode:default"
      && failure.reason === "livez-samples-above-1s"
      && failure.count === 1
    )));
  });

  it("includes standalone /livez-only summaries in strict close gate evaluation", () => {
    const gate = buildStrictLivezCloseGate({
      default: {
        livezFailureCount: 0,
        schedzFailureCount: 0,
        livezWallSamplesAbove1s: 0,
        livezWallSamplesAbove3s: 0,
      },
    }, {
      "standalone-livez-only": {
        livezFailureCount: 1,
        livezWallSamplesAbove1s: 2,
        livezWallSamplesAbove3s: 1,
      },
    });

    assert.equal(gate.ok, false);
    assert.ok(gate.failures.some((failure) => (
      failure.scope === "standalone-livez-only"
      && failure.reason === "livez-failures"
      && failure.count === 1
    )));
    assert.ok(gate.failures.some((failure) => (
      failure.scope === "standalone-livez-only"
      && failure.reason === "livez-samples-above-1s"
      && failure.count === 2
    )));
  });

  it("can include a standalone /livez-only gate in connection-mode comparison reports", async () => {
    const report = await runLivezConnectionModeComparison({
      noLive: true,
      count: 5,
      includeLivezOnlyGate: true,
      simulateResidualStall: true,
    });

    assert.equal(report.comparison.standaloneLivezOnlyGateIncluded, true);
    assert.equal(report.comparison.totalLivezProbes, 20);
    assert.equal(report.comparison.totalSchedzProbes, 15);
    assert.equal(report.standaloneLivezOnlyGate.probeCount, 5);
    assert.equal(report.standaloneLivezOnlyGate.livezWallSamplesAbove1s, 1);
    assert.equal(report.strictCloseGate.ok, false);
    assert.ok(report.strictCloseGate.failures.some((failure) => (
      failure.scope === "standalone-livez-only"
      && failure.reason === "livez-samples-above-1s"
      && failure.count === 1
    )));
  });

  it("collects host metrics in no-live mode", () => {
    const report = runNoLiveDiagnostics({ count: 5, collectHostMetrics: true });
    assert.ok(report.hostMetricsSummary);
    assert.ok("processUptimeSec" in report.hostMetricsSummary);
    assert.ok("loadAverage" in report.hostMetricsSummary);
  });

  it("can disable host metrics", () => {
    const report = runNoLiveDiagnostics({ count: 5, collectHostMetrics: false });
    assert.equal(report.correlatedProbes.length, 5);
    // Each probe host entry should be null when disabled
    for (const cp of report.correlatedProbes) {
      assert.equal(cp.host, null);
    }
  });

  it("includes container/cgroup diagnostics in no-live schedz data", () => {
    const report = runNoLiveDiagnostics({ count: 5 });
    assert.ok(report.schedzContainerSummary, "schedzContainerSummary should be present");
    assert.ok(report.schedzContainerSummary.cgroupCpu, "cgroupCpu should be present");
    assert.equal(report.schedzContainerSummary.samples, 5);
    assert.equal(typeof report.schedzContainerSummary.cgroupCpu.usageUsec, "number");
    assert.equal(typeof report.schedzContainerSummary.cgroupCpu.nrPeriods, "number");
    assert.equal(typeof report.schedzContainerSummary.cgroupCpu.nrThrottled, "number");
    assert.equal(typeof report.schedzContainerSummary.cgroupCpu.throttledUsec, "number");
    // All probes include the container field in the correlated probes
    for (const cp of report.correlatedProbes) {
      assert.ok(cp.schedzContainer, `probe ${cp.index} should have schedzContainer`);
      assert.ok(cp.schedzContainer.cgroup, `probe ${cp.index} should have cgroup`);
    }
  });

  it("detects cgroup throttling in the last probe of simulateStall mode", () => {
    const report = runNoLiveDiagnostics({ count: 10, simulateStall: true });
    assert.ok(report.schedzContainerSummary, "schedzContainerSummary should be present");
    const cpu = report.schedzContainerSummary.cgroupCpu;
    assert.ok(cpu.nrThrottled > 0, "nrThrottled should be > 0 in the last probe");
  });
});

describe("broker comprehensive diagnostics (live)", () => {
  it("passes when /livez and /schedz respond quickly", async () => {
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      assert.equal(init?.method, "GET");
      if (parsed.pathname === "/livez") {
        return jsonResponse(simpleLivezBody());
      }
      if (parsed.pathname === "/schedz") {
        return jsonResponse(simpleSchedzBody());
      }
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const report = await runLiveDiagnostics({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 5,
      intervalMs: 10,
      timeoutMs: 2000,
    });

    assert.equal(report.kind, "a2a-broker.comprehensive-diagnostics.v1");
    assert.equal(report.mode, "live");
    assert.equal(report.probeCount, 5);
    assert.equal(report.livezFailureCount, 0);
    assert.equal(report.schedzFailureCount, 0);
    assert.equal(report.ok, true);

    // Should have scheduling data from /schedz
    assert.ok(report.schedzSchedulingSummary);
    assert.ok(report.schedzSchedulingSummary.sampleCount > 0);
    assert.equal(report.schedzSchedulingMaxMs, 2949);
    assert.equal(report.schedzSchedulingP99Ms, 2936);
    assert.equal(report.schedzSchedulingP95Ms, 2695);
    assert.equal(report.schedzSchedulingP50Ms, 0.3);
    assert.ok(report.schedzConnectionSummary);
    assert.equal(report.schedzConnectionSummary.httpServer.keepAliveTimeoutMs, 5000);
    assert.equal(report.schedzConnectionSummary.httpServer.headersTimeoutMs, 60000);
    assert.ok(report.requestRouteSummary.some((entry) => (
      entry.route === "workers.register" &&
      entry.maxTimingMs === 2810 &&
      entry.maxFirstRequestLatencyMs === 2700
    )));
    assert.ok(report.workerHeartbeatPhaseSummary.some((entry) => (
      entry.phase === "brokerHeartbeat" &&
      entry.maxMs === 2825 &&
      entry.p99Ms === 2825
    )));

    // /livez timing summary from response body
    assert.ok(report.livezTimingSummary);
    assert.ok(report.livezTimingSummary.handlerRequestDurationMs);
    assert.equal(report.livezTimingSummary.handlerRequestDurationMs.min, 0.03);
    assert.equal(report.livezTimingSummary.eventLoopDelayMs.min, 0.05);
    assert.ok(report.livezAttribution);
    assert.equal(report.livezAttribution.bucket, "no-significant-stall");

    // Correlated probes
    assert.equal(report.correlatedProbes.length, 5);
    for (const cp of report.correlatedProbes) {
      assert.ok(cp.livezWallMs >= 0);
      assert.ok(cp.schedzWallMs >= 0);
      assert.ok(cp.livezHandling);
      assert.equal(cp.livezHandling.requestDurationMs, 0.03);
      assert.equal(cp.livezHandling.eventLoopDelayMs, 0.05);
      assert.ok(cp.livezClientTiming);
      assert.equal(typeof cp.livezClientTiming.fetchHeaderMs, "number");
      assert.equal(typeof cp.livezClientTiming.bodyParseMs, "number");
      assert.equal(typeof cp.livezClientTiming.serverPreparedToClientHeadersMs, "number");
      assert.ok(cp.schedzTimingSnapshot);
      assert.equal(cp.schedzTimingSnapshot.maxMs, 2949);
      assert.ok(cp.schedzRequestRoutes);
      assert.ok(cp.schedzRouteHandlerBodyTiming);
      assert.ok(cp.workerHeartbeatPhases);
      assert.ok(cp.schedzConnections);
      assert.equal(cp.schedzConnections.httpServer.keepAliveTimeoutMs, 5000);
    }
  });

  it("blocks gate on elevated /schedz scheduling timing", async () => {
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/livez") {
        return jsonResponse(simpleLivezBody());
      }
      if (parsed.pathname === "/schedz") {
        return jsonResponse({
          ...simpleSchedzBody(),
          schedulingTiming: {
            count: 200, minMs: 0.01, maxMs: 4500, avgMs: 200,
            p50Ms: 0.5, p95Ms: 3800, p99Ms: 4200, p999Ms: 4500,
          },
        });
      }
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const report = await runLiveDiagnostics({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 5,
      intervalMs: 5,
    });

    assert.equal(report.schedzSchedulingMaxMs, 4500);
    assert.equal(report.schedzSchedulingP99Ms, 4200);
    assert.equal(report.ok, false);

    const schedCheck = report.checks.find((c) => c.check === "in-broker scheduling max gate");
    assert.ok(schedCheck);
    assert.equal(schedCheck.ok, false);
    assert.match(schedCheck.detail, /exceeds 3000ms/);
  });

  it("uses read-only GET to /livez and /schedz only", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ path: parsed.pathname, method: init?.method });
      if (parsed.pathname === "/livez") return jsonResponse(simpleLivezBody());
      if (parsed.pathname === "/schedz") return jsonResponse(simpleSchedzBody());
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const report = await runLiveDiagnostics({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 3,
      intervalMs: 5,
    });

    assert.equal(report.ok, true);
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      ["GET /livez", "GET /schedz", "GET /livez", "GET /schedz", "GET /livez", "GET /schedz"],
    );
  });

  it("respects count bounds (max 200)", async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/livez") return jsonResponse(simpleLivezBody());
      if (parsed.pathname === "/schedz") return jsonResponse(simpleSchedzBody());
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const report = await runLiveDiagnostics({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 300,
      intervalMs: 0,
    });

    assert.equal(report.probeCount, 200);
  });

  it("reports /schedz errors gracefully", async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/livez") return jsonResponse(simpleLivezBody());
      if (parsed.pathname === "/schedz") {
        return new Response("not found", { status: 404 });
      }
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const report = await runLiveDiagnostics({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 3,
      intervalMs: 5,
    });

    assert.equal(report.probeCount, 3);
    assert.equal(report.schedzFailureCount, 3);
    assert.equal(report.ok, false);
    // /livez should still pass
    assert.equal(report.livezFailureCount, 0);
    const schedzSuccess = report.checks.find((c) => c.check === "schedz success gate");
    assert.ok(schedzSuccess);
    assert.equal(schedzSuccess.ok, false);
    const schedulingData = report.checks.find((c) => c.check === "scheduling data received");
    assert.ok(schedulingData);
    assert.equal(schedulingData.ok, false);
  });

  it("sends edge secret to authenticated /schedz without adding it to the report", async () => {
    const seenHeaders = [];
    const secret = "<edge-secret-placeholder>";
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      seenHeaders.push({ path: parsed.pathname, headers: init?.headers });
      if (parsed.pathname === "/livez") return jsonResponse(simpleLivezBody());
      if (parsed.pathname === "/schedz") {
        assert.equal(init?.headers?.["x-a2a-edge-secret"], secret);
        return jsonResponse(simpleSchedzBody());
      }
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const report = await runLiveDiagnostics({
      baseUrl: "http://broker.local",
      edgeSecret: secret,
      allowNonLoopbackEdgeSecret: true,
      fetchImpl,
      count: 2,
      intervalMs: 0,
    });

    assert.equal(report.ok, true);
    assert.equal(seenHeaders.find((entry) => entry.path === "/livez").headers["x-a2a-edge-secret"], undefined);
    assert.doesNotMatch(JSON.stringify(report), /edge-secret-placeholder|x-a2a-edge-secret/);
  });

  it("rejects edge secret delivery to non-loopback URLs unless explicitly allowed", async () => {
    await assert.rejects(
      runLiveDiagnostics({
        baseUrl: "http://broker.local",
        edgeSecret: "<edge-secret-placeholder>",
        fetchImpl: async () => jsonResponse(simpleLivezBody()),
        count: 1,
        intervalMs: 0,
      }),
      /base-url must be loopback/,
    );
  });

  it("can force fresh or keep-alive /livez connection headers for approved comparison gates", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ path: parsed.pathname, headers: init?.headers });
      if (parsed.pathname === "/livez") return jsonResponse(simpleLivezBody());
      if (parsed.pathname === "/schedz") return jsonResponse(simpleSchedzBody());
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const fresh = await runLiveDiagnostics({
      baseUrl: "http://broker.local",
      livezConnectionMode: "fresh",
      fetchImpl,
      count: 1,
      intervalMs: 0,
    });
    const keepAlive = await runLiveDiagnostics({
      baseUrl: "http://broker.local",
      livezConnectionMode: "keep-alive",
      fetchImpl,
      count: 1,
      intervalMs: 0,
    });

    assert.equal(fresh.livezConnectionMode, "fresh");
    assert.equal(keepAlive.livezConnectionMode, "keep-alive");
    assert.equal(calls.find((entry) => entry.path === "/livez").headers.connection, "close");
    assert.equal(calls.filter((entry) => entry.path === "/livez")[1].headers.connection, "keep-alive");
    assert.equal(calls.find((entry) => entry.path === "/schedz").headers.connection, undefined);
  });

  it("reports /livez errors gracefully", async () => {
    let callCount = 0;
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      callCount++;
      if (parsed.pathname === "/livez") {
        throw new Error("connection refused");
      }
      if (parsed.pathname === "/schedz") {
        return jsonResponse(simpleSchedzBody());
      }
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const report = await runLiveDiagnostics({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 3,
      intervalMs: 5,
    });

    assert.equal(report.probeCount, 3);
    assert.equal(report.livezFailureCount, 3);
    assert.equal(report.ok, false);
  });

  it("fails closed on a single /livez HTTP failure", async () => {
    let livezCount = 0;
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/livez") {
        livezCount++;
        return livezCount === 1
          ? jsonResponse({ ok: false }, 500)
          : jsonResponse(simpleLivezBody());
      }
      if (parsed.pathname === "/schedz") return jsonResponse(simpleSchedzBody());
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const report = await runLiveDiagnostics({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl,
      count: 5,
      intervalMs: 0,
    });

    assert.equal(report.livezFailureCount, 1);
    assert.equal(report.ok, false);
    const livezSuccess = report.checks.find((c) => c.check === "livez success gate");
    assert.ok(livezSuccess);
    assert.equal(livezSuccess.ok, false);
  });

  it("produces a connection-mode comparison report", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ path: parsed.pathname, headers: init?.headers });
      if (parsed.pathname === "/livez") return jsonResponse(simpleLivezBody());
      if (parsed.pathname === "/schedz") return jsonResponse(simpleSchedzBody());
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const report = await runLivezConnectionModeComparison({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl,
      count: 2,
      intervalMs: 0,
    });

    assert.equal(report.kind, "a2a-broker.comprehensive-diagnostics.connection-mode-comparison.v1");
    assert.equal(report.mode, "live-connection-mode-comparison");
    assert.equal(report.comparison.totalLivezProbes, 6);
    assert.equal(report.comparison.schedzRequesterStrategy, "per-mode-requester-id");
    assert.deepEqual(report.comparison.requesterIds, {
      default: "broker-comprehensive-diagnostics:default",
      fresh: "broker-comprehensive-diagnostics:fresh",
      "keep-alive": "broker-comprehensive-diagnostics:keep-alive",
    });
    assert.equal(report.perMode.default.ok, true);
    assert.equal(report.perMode.fresh.ok, true);
    assert.equal(report.perMode["keep-alive"].ok, true);
    const livezCalls = calls.filter((entry) => entry.path === "/livez");
    assert.equal(livezCalls[0].headers.connection, undefined);
    assert.equal(livezCalls[2].headers.connection, "close");
    assert.equal(livezCalls[4].headers.connection, "keep-alive");
    for (const schedzCall of calls.filter((entry) => entry.path === "/schedz")) {
      assert.equal(schedzCall.headers.connection, undefined);
    }
    const schedzRequesterIds = calls
      .filter((entry) => entry.path === "/schedz")
      .map((entry) => entry.headers["x-a2a-requester-id"]);
    assert.deepEqual(schedzRequesterIds, [
      "broker-comprehensive-diagnostics:default",
      "broker-comprehensive-diagnostics:default",
      "broker-comprehensive-diagnostics:fresh",
      "broker-comprehensive-diagnostics:fresh",
      "broker-comprehensive-diagnostics:keep-alive",
      "broker-comprehensive-diagnostics:keep-alive",
    ]);
  });

  it("isolates /schedz rate-limit buckets by connection-mode requester id", async () => {
    const schedzCountsByRequester = new Map();
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/livez") return jsonResponse(simpleLivezBody());
      if (parsed.pathname === "/schedz") {
        const requesterId = init?.headers?.["x-a2a-requester-id"];
        const count = (schedzCountsByRequester.get(requesterId) ?? 0) + 1;
        schedzCountsByRequester.set(requesterId, count);
        return count > 2
          ? jsonResponse({ ok: false }, 429)
          : jsonResponse(simpleSchedzBody());
      }
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const report = await runLivezConnectionModeComparison({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl,
      count: 2,
      intervalMs: 0,
    });

    assert.equal(report.ok, true);
    assert.deepEqual([...schedzCountsByRequester.values()], [2, 2, 2]);
  });
});

describe("broker comprehensive diagnostics attribution classifier", () => {
  function baseReport(overrides = {}) {
    return {
      livezMaxMs: 2500,
      livezWallSamplesAbove1s: 1,
      livezWallSamplesAbove3s: 0,
      schedzSchedulingMaxMs: 0,
      requestRouteSummary: [],
      workerHeartbeatPhaseSummary: [],
      livezTimingSummary: {
        handlerRequestDurationMs: { max: 0.4 },
        eventLoopDelayMs: { max: 0.2 },
        clientWallBreakdownMs: {
          fetchHeaders: { max: 2500 },
          clientToServerStartLag: { max: 2500 },
          clientToSocketConnectedLag: { max: 0.5 },
          clientToHttpRequestEventLag: { max: 0.6 },
          socketConnectedToHandlerStart: { max: 0.4 },
          socketIdleBeforeRequest: null,
          socketAcceptedToHttpRequestEvent: { max: 0.3 },
          httpRequestEventToHandlerStart: { max: 0.1 },
          socketIdleBeforeHttpRequestEvent: null,
          serverPreparedToClientHeaders: { max: 0.3 },
        },
      },
      ...overrides,
    };
  }

  it("classifies slow samples from their own timing fields", () => {
    assert.equal(
      classifyLivezSlowSampleAttribution({
        livezWallMs: 2800,
        socketHadServedRequest: true,
        socketIdleBeforeHttpRequestEventMs: 2500,
        socketAgeBeforeHandlerMs: 3000,
        socketAcceptedToHttpRequestEventMs: 3000,
        httpRequestEventToHandlerStartMs: 0.1,
        serverPreparedToClientHeadersMs: 1,
      }).bucket,
      "reused-socket-idle-before-request-event",
    );

    assert.equal(
      classifyLivezSlowSampleAttribution({
        livezWallMs: 2800,
        socketHadServedRequest: true,
        socketIdleBeforeHttpRequestEventMs: 2500,
        reuseIdleBeforeDataMs: 100,
        reuseDataToHttpRequestEventMs: 1700,
        socketAcceptedToHttpRequestEventMs: 2500,
        httpRequestEventToHandlerStartMs: 0.1,
        serverPreparedToClientHeadersMs: 1,
      }).bucket,
      "reused-socket-data-received-blocked",
    );

    assert.equal(
      classifyLivezSlowSampleAttribution({
        livezWallMs: 2800,
        socketHadServedRequest: false,
        clientToServerStartLagMs: 2800,
        socketAcceptedToHttpRequestEventMs: 0.5,
        httpRequestEventToHandlerStartMs: 0.1,
        serverPreparedToClientHeadersMs: 2,
      }, { bucket: "reused-socket-idle-before-request-event", confidence: "high" }).bucket,
      "client-or-network-before-server-request",
    );

    assert.equal(
      classifyLivezSlowSampleAttribution({
        livezWallMs: 2800,
        socketHadServedRequest: true,
        socketIdleBeforeHttpRequestEventMs: 0.2,
        socketAcceptedToHttpRequestEventMs: 0.3,
        httpRequestEventToHandlerStartMs: 2200,
        socketAgeBeforeHandlerMs: 2201,
        serverPreparedToClientHeadersMs: 2,
      }).bucket,
      "request-event-waiting-before-handler",
    );
  });

  it("classifies accepted socket waiting before handler", () => {
    const result = classifyLivezAttribution(baseReport({
      livezTimingSummary: {
        handlerRequestDurationMs: { max: 0.4 },
        eventLoopDelayMs: { max: 0.2 },
        clientWallBreakdownMs: {
          fetchHeaders: { max: 2500 },
          clientToServerStartLag: { max: 2500 },
          clientToSocketConnectedLag: { max: 1 },
          socketConnectedToHandlerStart: { max: 2200 },
          socketIdleBeforeRequest: null,
          socketAcceptedToHttpRequestEvent: { max: 0.4 },
          httpRequestEventToHandlerStart: { max: 0.2 },
          socketIdleBeforeHttpRequestEvent: null,
          serverPreparedToClientHeaders: { max: 0.3 },
        },
      },
    }));
    assert.equal(result.bucket, "accepted-socket-waiting-before-handler");
    assert.equal(result.confidence, "medium");
  });

  it("classifies reused socket idle before the HTTP request event", () => {
    const result = classifyLivezAttribution(baseReport({
      livezTimingSummary: {
        handlerRequestDurationMs: { max: 0.4 },
        eventLoopDelayMs: { max: 0.2 },
        clientWallBreakdownMs: {
          fetchHeaders: { max: 2686 },
          clientToServerStartLag: { max: 2684 },
          clientToSocketConnectedLag: { max: 2 },
          clientToHttpRequestEventLag: { max: 2683 },
          socketConnectedToHandlerStart: { max: 15356.189 },
          socketIdleBeforeRequest: { max: 3189.802 },
          socketAcceptedToHttpRequestEvent: { max: 15356.144 },
          httpRequestEventToHandlerStart: { max: 0.045 },
          socketIdleBeforeHttpRequestEvent: { max: 3189.802 },
          reuseIdleBeforeData: { max: 3100 },
          reuseDataToHttpRequestEvent: { max: 90 },
          serverPreparedToClientHeaders: { max: 2 },
        },
      },
    }));
    assert.equal(result.bucket, "reused-socket-idle-before-request-event");
    assert.equal(result.confidence, "high");
    assert.equal(result.signals.socketIdleBeforeHttpRequestEventMaxMs, 3189.802);
    assert.equal(result.signals.reuseIdleBeforeDataMaxMs, 3100);
    assert.equal(result.signals.reuseDataToHttpRequestEventMaxMs, 90);
  });

  it("classifies reused socket data received but request event blocked", () => {
    const result = classifyLivezAttribution(baseReport({
      livezTimingSummary: {
        handlerRequestDurationMs: { max: 0.4 },
        eventLoopDelayMs: { max: 0.2 },
        clientWallBreakdownMs: {
          fetchHeaders: { max: 2100 },
          clientToServerStartLag: { max: 2100 },
          clientToSocketConnectedLag: { max: 2 },
          clientToHttpRequestEventLag: { max: 2090 },
          socketConnectedToHandlerStart: { max: 6400 },
          socketIdleBeforeRequest: { max: 2100 },
          socketAcceptedToHttpRequestEvent: { max: 6400 },
          httpRequestEventToHandlerStart: { max: 0.04 },
          socketIdleBeforeHttpRequestEvent: { max: 2100 },
          reuseIdleBeforeData: { max: 160 },
          reuseDataToHttpRequestEvent: { max: 1850 },
          serverPreparedToClientHeaders: { max: 2 },
        },
      },
    }));
    assert.equal(result.bucket, "reused-socket-data-received-blocked");
    assert.equal(result.confidence, "medium");
    assert.equal(result.signals.reuseIdleBeforeDataMaxMs, 160);
    assert.equal(result.signals.reuseDataToHttpRequestEventMaxMs, 1850);
  });

  it("classifies reused socket waiting before handler", () => {
    const result = classifyLivezAttribution(baseReport({
      livezTimingSummary: {
        handlerRequestDurationMs: { max: 0.4 },
        eventLoopDelayMs: { max: 0.2 },
        clientWallBreakdownMs: {
          fetchHeaders: { max: 2686 },
          clientToServerStartLag: { max: 2684 },
          clientToSocketConnectedLag: { max: 2 },
          clientToHttpRequestEventLag: { max: 2683 },
          socketConnectedToHandlerStart: { max: 15356.189 },
          socketIdleBeforeRequest: { max: 3189.802 },
          socketAcceptedToHttpRequestEvent: { max: 15356.144 },
          httpRequestEventToHandlerStart: { max: 1200.5 },
          socketIdleBeforeHttpRequestEvent: { max: 3189.802 },
          serverPreparedToClientHeaders: { max: 2 },
        },
      },
    }));
    assert.equal(result.bucket, "reused-socket-waiting-before-handler");
    assert.equal(result.confidence, "high");
    assert.equal(result.signals.socketIdleBeforeHttpRequestEventMaxMs, 3189.802);
    assert.equal(result.signals.httpRequestEventToHandlerStartMaxMs, 1200.5);
  });

  it("classifies TCP connect or accept before handler", () => {
    const result = classifyLivezAttribution(baseReport({
      livezTimingSummary: {
        handlerRequestDurationMs: { max: 0.4 },
        eventLoopDelayMs: { max: 0.2 },
        clientWallBreakdownMs: {
          fetchHeaders: { max: 2500 },
          clientToServerStartLag: { max: 2500 },
          clientToSocketConnectedLag: { max: 2200 },
          socketConnectedToHandlerStart: { max: 0.4 },
          socketIdleBeforeRequest: null,
          socketAcceptedToHttpRequestEvent: { max: 0.3 },
          httpRequestEventToHandlerStart: { max: 0.2 },
          socketIdleBeforeHttpRequestEvent: null,
          serverPreparedToClientHeaders: { max: 0.3 },
        },
      },
    }));
    assert.equal(result.bucket, "tcp-connect-or-accept-before-handler");
    assert.equal(result.confidence, "medium");
  });

  it("classifies unresolved external client wall before headers", () => {
    const result = classifyLivezAttribution(baseReport());
    assert.equal(result.bucket, "external-client-wall-before-headers");
    assert.equal(result.confidence, "low");
  });

  it("classifies response egress or client read", () => {
    const result = classifyLivezAttribution(baseReport({
      livezTimingSummary: {
        handlerRequestDurationMs: { max: 0.4 },
        eventLoopDelayMs: { max: 0.2 },
        clientWallBreakdownMs: {
          fetchHeaders: { max: 2500 },
          clientToServerStartLag: { max: 0.6 },
          clientToSocketConnectedLag: { max: 0.4 },
          socketConnectedToHandlerStart: { max: 0.2 },
          socketIdleBeforeRequest: null,
          serverPreparedToClientHeaders: { max: 2100 },
        },
      },
    }));
    assert.equal(result.bucket, "response-egress-or-client-read");
  });

  it("classifies broker scheduling or competing route", () => {
    const result = classifyLivezAttribution(baseReport({
      schedzSchedulingMaxMs: 2400,
      livezTimingSummary: {
        handlerRequestDurationMs: { max: 0.4 },
        eventLoopDelayMs: { max: 0.2 },
        clientWallBreakdownMs: {
          fetchHeaders: { max: 2500 },
          clientToServerStartLag: { max: 0.6 },
          clientToSocketConnectedLag: { max: 0.4 },
          socketConnectedToHandlerStart: { max: 0.2 },
          socketIdleBeforeRequest: null,
          serverPreparedToClientHeaders: { max: 0.3 },
        },
      },
    }));
    assert.equal(result.bucket, "broker-scheduling-or-competing-route");
  });
});

describe("broker comprehensive diagnostics input validation", () => {
  it("rejects non-finite count instead of producing a zero-probe report", () => {
    assert.throws(
      () => runNoLiveDiagnostics({ count: Number.NaN }),
      /--count must be a positive integer/,
    );
  });

  it("rejects invalid livez connection mode", () => {
    assert.throws(
      () => runNoLiveDiagnostics({ livezConnectionMode: "sticky" }),
      /--livez-connection-mode must be one of/,
    );
  });
});

describe("broker comprehensive diagnostics (extract helpers)", () => {
  it("extractLivezMeasurement handles null/empty input", () => {
    assert.equal(extractLivezMeasurement(null, 10, 200), null);
    assert.equal(extractLivezMeasurement(undefined, 10, 200), null);
    assert.equal(extractLivezMeasurement("not an object", 10, 200), null);
  });

  it("extractLivezMeasurement extracts known fields", () => {
    const body = simpleLivezBody();
    const result = extractLivezMeasurement(body, 15, 200);

    assert.ok(result);
    assert.equal(result.ok, true);
    assert.equal(result.wallTimeMs, 15);
    assert.equal(result.status, 200);
    assert.equal(result.handlerTiming.count, 200);
    assert.equal(result.requestDurationMs, 0.03);
    assert.equal(result.diagMs, 0.02);
    assert.equal(result.eventLoop.delayMs, 0.05);
    assert.equal(result.cpu.percentSinceLastCheck, 2.5);
    assert.equal(result.uptimeSec, 3600);
    assert.equal(result.activeRequests, 2);
    assert.equal(typeof result.probeTiming.handlerStartUnixMs, "number");
    assert.equal(typeof result.probeTiming.responsePreparedUnixMs, "number");
    assert.equal(result.probeTiming.responsePreparationDurationMs, 0.03);
    assert.equal(result.probeTiming.socketAgeBeforeHandlerMs, 2);
    assert.equal(result.probeTiming.socketRequestIndex, 1);
    assert.equal(result.probeTiming.clientProbeStartToHandlerStartMs, 3);
  });

  it("extractSchedzMeasurement handles null/empty input", () => {
    assert.equal(extractSchedzMeasurement(null, 200), null);
    assert.equal(extractSchedzMeasurement(undefined, 200), null);
  });

  it("extractSchedzMeasurement extracts known fields", () => {
    const body = simpleSchedzBody();
    const result = extractSchedzMeasurement(body, 200);

    assert.ok(result);
    assert.equal(result.ok, true);
    assert.equal(result.totalAccepted, 15000);
    assert.equal(result.activeRequests, 2);
    assert.ok(result.host);
    assert.equal(result.host.loadavg1, 0.5);
    assert.ok(result.schedulingTiming);
    assert.equal(result.schedulingTiming.maxMs, 2949);
    assert.equal(result.schedulingTiming.p99Ms, 2936);
    assert.equal(result.schedulingTiming.p95Ms, 2695);
    assert.equal(result.schedulingTiming.p50Ms, 0.3);
    assert.ok(result.workerHeartbeatPhases);
    assert.equal(result.workerHeartbeatPhases.brokerHeartbeat.maxMs, 2825);
    assert.ok(result.perWorkerRegisterPhases);
    assert.equal(result.perWorkerRegisterPhases["worker-slow"].brokerRegister.maxMs, 2175);
    assert.ok(result.routeHandlerBodyTiming);
    assert.equal(result.routeHandlerBodyTiming["workers.register"].p99Ms, 2810);
    assert.ok(result.terminalOutbox);
    assert.equal(result.terminalOutbox.pendingAckCount, 7);
    assert.equal(result.terminalOutbox.topPendingAckWorkers[0].key, "worker-slow");
    assert.equal(result.terminalOutbox.oldestPendingAckWorker, "worker-slow");
    assert.equal(result.terminalOutbox.topPendingAckStatuses[0].key, "succeeded");
  });
});

describe("broker comprehensive diagnostics (orchestrator)", () => {
  it("runDiagnostics dispatches correctly based on noLive flag", async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/livez") return jsonResponse(simpleLivezBody());
      if (parsed.pathname === "/schedz") return jsonResponse(simpleSchedzBody());
      throw new Error(`unexpected path: ${parsed.pathname}`);
    };

    const liveReport = await runDiagnostics({
      noLive: false,
      fetchImpl,
      count: 3,
      intervalMs: 5,
    });
    assert.equal(liveReport.mode, "live");
    assert.equal(liveReport.probeCount, 3);
    assert.equal(liveReport.ok, true);

    const noLiveReport = await runDiagnostics({ noLive: true, count: 3 });
    assert.equal(noLiveReport.mode, "no-live");
    assert.equal(noLiveReport.probeCount, 3);
  });
});

describe("broker comprehensive diagnostics (host helpers)", () => {
  it("readProcRunQueue returns null or valid data", () => {
    const rq = readProcRunQueue();
    // May be null if /proc/stat is unavailable, but should never throw
    assert.doesNotThrow(() => readProcRunQueue());
    if (rq !== null) {
      assert.ok("procsRunning" in rq);
      assert.ok("procsBlocked" in rq);
      // procsRunning should be a positive integer in typical environments
      assert.ok(rq.procsRunning === null || (typeof rq.procsRunning === "number" && rq.procsRunning >= 0));
    }
  });

  it("collectHostDiagnostics returns consistent structure", () => {
    const diag = collectHostDiagnostics();
    assert.ok(diag);
    assert.ok(typeof diag.processUptimeSec === "number");
    assert.ok(diag.processUptimeSec > 0);
    assert.ok("loadAverage" in diag);
    assert.ok("procPressure" in diag);
    assert.ok("cpuTicks" in diag);
  });

  it("no-live report does not contain secrets or paths", () => {
    const report = runNoLiveDiagnostics({ count: 5 });
    const json = JSON.stringify(report);
    // The report should not contain any secrets-like patterns
    assert.doesNotMatch(json, /sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|edge_secret|edgeSecret/);
    // Ensure no workspace path leakage
    assert.doesNotMatch(json, /\/work\/repo|\.openclaw|AGENTS\.md|SOUL\.md|USER\.md|TOOLS\.md/);
  });
});
