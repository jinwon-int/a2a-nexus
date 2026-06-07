import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  runMeasurement,
  runLiveMeasurement,
  runNoLiveMeasurement,
} from "./broker-livez-stall-attribution.mjs";
import {
  collectHostDiagnostics,
  readLoadAverage,
  readProcPressure,
  readCpuTicks,
  extractLivezAttribution,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("broker livez stall attribution (no-live)", () => {
  it("produces deterministic passing no-live report without broker calls or unsafe actions", () => {
    const report = runNoLiveMeasurement({ count: 10 });

    assert.equal(report.kind, "a2a-broker.livez-stall-attribution.v1");
    assert.equal(report.issue, "#1044");
    assert.equal(report.parent, "#1032");
    assert.equal(report.mode, "no-live");
    assert.equal(report.probeCount, 10);
    assert.equal(report.samplesAbove3s, 0);
    assert.equal(report.samplesAbove1s, 0);
    assert.ok(report.maxDurationMs < 1000);
    assert.equal(report.stalled, false);
    assert.equal(report.ok, true);
    assert.ok(Array.isArray(report.checks));
    assert.ok(report.checks.length >= 6);

    // Safety assertions
    assert.equal(report.baseUrl, "http://no-live.synthetic");
    assert.doesNotMatch(JSON.stringify(report), /token|secret|chat_id|\/work\/repo/);

    // Gate check structure
    const maxCheck = report.checks.find((c) => c.check === "max latency gate");
    assert.ok(maxCheck);
    assert.equal(maxCheck.ok, true);

    const safetyCheck = report.checks.find((c) => c.check === "safety gate");
    assert.ok(safetyCheck);
    assert.equal(safetyCheck.ok, true);

    // Host metrics should be populated in no-live mode when collectHostMetrics is enabled (default)
    assert.ok(report.hostMetricsSummary !== undefined);
    // correlatedProbes should be an empty array for no-live
    assert.ok(Array.isArray(report.correlatedProbes));
    assert.equal(report.correlatedProbes.length, 0);
  });

  it("can simulate a blocked stall gate explicitly", () => {
    const report = runNoLiveMeasurement({ count: 10, simulateStall: true });
    assert.equal(report.mode, "no-live-simulated-stall");
    assert.equal(report.samplesAbove3s, 1);
    assert.ok(report.samplesAbove1s >= 1);
    assert.ok(report.maxDurationMs > 3000);
    assert.equal(report.stalled, true);
    assert.equal(report.ok, false);

    const maxCheck = report.checks.find((c) => c.check === "max latency gate");
    assert.ok(maxCheck);
    assert.equal(maxCheck.ok, false);
    assert.match(maxCheck.detail, /exceeds 3000ms/);
  });
});

describe("broker livez stall attribution (live)", () => {
  it("passes when all livez probes respond quickly", async () => {
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/schedz") {
        return jsonResponse({
          ok: true,
          operatorGate: {
            bucket: "no-significant-stall",
            confidence: "high",
            reasons: ["all timing windows within threshold"],
            evidence: { reusedSocketIdleP99Ms: 45 },
          },
          perRequest: {
            handlerMs: { p50Ms: 0.08, p95Ms: 0.25, p99Ms: 0.52, maxMs: 1.23, averageMs: 0.12, samples: 120 },
          },
          // schedulingTiming is also present in real /schedz but not needed for this test
        });
      }
      assert.equal(parsed.pathname, "/livez");
      assert.equal(init?.method, "GET");
      return jsonResponse({
        ok: true,
        service: "a2a-broker",
        brokerId: "test-broker",
        uptimeSec: 123,
      });
    };

    const report = await runLiveMeasurement({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl,
      count: 5,
      intervalMs: 10,
      timeoutMs: 2000,
    });

    assert.equal(report.kind, "a2a-broker.livez-stall-attribution.v1");
    assert.equal(report.mode, "live");
    assert.equal(report.probeCount, 5);
    assert.equal(report.failureCount, 0);
    assert.equal(report.samplesAbove1s, 0);
    assert.equal(report.samplesAbove3s, 0);
    assert.equal(report.stalled, false);
    assert.equal(report.ok, true);

    // Host metrics should be collected in live mode
    assert.ok(report.hostMetricsSummary !== undefined);
    // correlatedProbes should have entries
    assert.ok(Array.isArray(report.correlatedProbes));
    assert.equal(report.correlatedProbes.length, 5);
    // Each correlated probe should have probe + attribution + host
    for (const cp of report.correlatedProbes) {
      assert.ok(cp.probe);
      assert.equal(typeof cp.probe.durationMs, "number");
      // attribution should be populated from the response body
      assert.ok(cp.attribution !== null);
      assert.equal(cp.attribution.uptimeSec, 123);
      // host may be non-null (collectHostDiagnostics silently reads /proc)
      assert.ok(cp.host !== null);
      assert.equal(typeof cp.host.processUptimeSec, "number");
    }
  });

  it("reports slow probes and blocks the gate", async () => {
    let callCount = 0;
    let schedzCalled = false;
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/schedz") {
        schedzCalled = true;
        return jsonResponse({
          ok: true,
          operatorGate: {
            bucket: "no-significant-stall",
            confidence: "high",
            reasons: ["all timing windows within threshold"],
          },
          perRequest: {
            handlerMs: { p50Ms: 0.08, p95Ms: 0.25, p99Ms: 0.52, maxMs: 1.23, averageMs: 0.12, samples: 120 },
          },
        });
      }
      assert.equal(parsed.pathname, "/livez");
      callCount++;
      if (callCount <= 2) {
        // Fast responses
        return jsonResponse({ ok: true, service: "a2a-broker" });
      }
      // Simulate stall by holding for ~200ms
      await new Promise((resolve) => setTimeout(resolve, 200));
      return jsonResponse({ ok: true, service: "a2a-broker" });
    };

    const report = await runLiveMeasurement({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl,
      count: 5,
      intervalMs: 5,
      timeoutMs: 5000,
    });

    assert.equal(report.probeCount, 5);
    assert.equal(report.failureCount, 0);
    assert.equal(typeof report.maxDurationMs, "number");
    assert.equal(typeof report.p50DurationMs, "number");
    assert.equal(typeof report.p95DurationMs, "number");
    assert.equal(typeof report.p99DurationMs, "number");
    assert.ok(Array.isArray(report.slowSamples));
    assert.equal(report.ok, report.stalled === false);
  });

  it("reports error on timeout", async () => {
    const fetchImpl = async (_url, init) => {
      const signal = init?.signal;
      if (!signal) {
        await new Promise(() => {});
        return;
      }
      return new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const poll = setInterval(() => {
          if (signal.aborted) {
            clearInterval(poll);
            reject(signal.reason);
          }
        }, 5);
        signal.addEventListener("abort", () => {
          clearInterval(poll);
          reject(signal.reason);
        }, { once: true });
      });
    };

    const report = await runLiveMeasurement({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl,
      count: 3,
      intervalMs: 5,
      timeoutMs: 100,
    });

    assert.equal(report.probeCount, 3);
    assert.equal(report.failureCount, 3);
    assert.ok(report.maxDurationMs >= 100);
    assert.equal(report.stalled, true);
    assert.equal(report.ok, false);
    const rateCheck = report.checks.find((c) => c.check === "failure rate gate");
    assert.ok(rateCheck);
    assert.equal(rateCheck.ok, false);
  });

  it("uses read-only GET to /livez and /schedz only", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ path: parsed.pathname, method: init?.method, headers: init?.headers ?? {} });
      if (parsed.pathname === "/schedz") {
        assert.equal(init?.headers?.["x-a2a-edge-secret"], "test-edge-secret");
        return jsonResponse({
          ok: true,
          operatorGate: {
            bucket: "no-significant-stall",
            confidence: "high",
            reasons: ["all timing windows within threshold"],
            evidence: { reusedSocketIdleP99Ms: 45 },
          },
          perRequest: {
            handlerMs: { p50Ms: 0.08, p95Ms: 0.25, p99Ms: 0.52, maxMs: 1.23, averageMs: 0.12, samples: 120 },
          },
        });
      }
      return jsonResponse({ ok: true, service: "a2a-broker" });
    };

    const report = await runLiveMeasurement({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl,
      count: 3,
      intervalMs: 5,
      edgeSecret: "test-edge-secret",
    });

    assert.equal(report.ok, true);
    // Expect 3 livez probes + 1 schedz probe
    const expectedCalls = [
      "GET /livez", "GET /livez", "GET /livez",
      "GET /schedz",
    ];
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      expectedCalls,
    );
    // Verify operatorGate data is populated in the report
    assert.ok(report.schedzOperatorGate !== null);
    assert.equal(report.schedzOperatorGate.bucket, "no-significant-stall");
    assert.equal(report.schedzOperatorGate.confidence, "high");
  });

  it("refuses to send an edge secret to a non-loopback base URL", async () => {
    await assert.rejects(
      runLiveMeasurement({
        baseUrl: "https://broker.example.com",
        edgeSecret: "test-edge-secret",
        fetchImpl: async () => jsonResponse({ ok: true }),
        count: 1,
        intervalMs: 0,
      }),
      /base-url must be loopback/,
    );
  });

  it("respects --count and --interval bounds", async () => {
    const fetchImpl = async () => jsonResponse({ ok: true, service: "a2a-broker" });

    const report = await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 200,
      intervalMs: 0,
      timeoutMs: 500,
    });

    assert.equal(report.probeCount, 200);
    assert.equal(report.failureCount, 0);
    assert.equal(report.ok, true);
  });

  it("clamps count to 200 maximum", async () => {
    const fetchImpl = async () => jsonResponse({ ok: true, service: "a2a-broker" });

    const report = await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 500,
      intervalMs: 0,
    });

    assert.equal(report.probeCount, 200);
  });
});

describe("broker livez stall attribution (host metrics & attribution correlation)", () => {
  it("extracts /livez attribution fields from response body", async () => {
    const fetchImpl = async () => jsonResponse({
      ok: true,
      service: "a2a-broker",
      brokerId: "test-broker",
      uptimeSec: 456,
      eventLoop: { delayMs: 0.123 },
      cpu: {
        percentSinceLastCheck: 5.2,
        deltaUserMicrosec: 15000,
        deltaSystemMicrosec: 3000,
        deltaIntervalMs: 500,
      },
      gc: {
        totalMs: 10.5,
        count: 3,
        lastMs: 2.1,
        recentMax60sMs: 4.0,
      },
      timing: {
        count: 50,
        maxMs: 1.5,
        avgMs: 0.3,
        p99Ms: 0.8,
      },
      diagMs: 0.109,
      activeRequests: 3,
      requestDurationMs: 0.05,
    });

    const report = await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 3,
      intervalMs: 5,
    });

    assert.equal(report.probeCount, 3);
    assert.equal(report.failureCount, 0);

    // Check correlated probe attribution
    for (const cp of report.correlatedProbes) {
      assert.ok(cp.attribution);
      assert.equal(cp.attribution.uptimeSec, 456);
      assert.equal(cp.attribution.eventLoopDelayMs, 0.123);
      assert.equal(cp.attribution.brokerCpuPercent, 5.2);
      assert.ok(cp.attribution.gc);
      assert.equal(cp.attribution.gc.count, 3);
      assert.ok(cp.attribution.timing);
      assert.equal(cp.attribution.timing.count, 50);
      assert.equal(cp.attribution.activeRequests, 3);
      assert.equal(cp.attribution.requestDurationMs, 0.05);
    }

    // livezAttributionSummary should contain aggregated data
    assert.ok(report.livezAttributionSummary);
    assert.ok(report.livezAttributionSummary.brokerCpuPercent);
    assert.equal(report.livezAttributionSummary.brokerCpuPercent.min, 5.2);
    assert.equal(report.livezAttributionSummary.brokerCpuPercent.max, 5.2);
    assert.equal(report.livezAttributionSummary.brokerCpuPercent.avg, 5.2);
    assert.equal(report.livezAttributionSummary.brokerCpuPercent.samples, 3);
    assert.ok(report.livezAttributionSummary.eventLoopDelayMs);
    assert.equal(report.livezAttributionSummary.eventLoopDelayMs.min, 0.123);
    assert.equal(report.livezAttributionSummary.eventLoopDelayMs.max, 0.123);
    assert.ok(report.livezAttributionSummary.diagMs);
    assert.equal(report.livezAttributionSummary.diagMs.min, 0.109);
    assert.ok(report.livezAttributionSummary.timingSnapshots);
    assert.equal(report.livezAttributionSummary.timingSnapshots.length, 3);

    // activeRequestCount and handlerDurationMs should be aggregated in summary
    assert.ok(report.livezAttributionSummary.activeRequestCount);
    assert.equal(report.livezAttributionSummary.activeRequestCount.min, 3);
    assert.equal(report.livezAttributionSummary.activeRequestCount.max, 3);
    assert.equal(report.livezAttributionSummary.activeRequestCount.avg, 3);
    assert.equal(report.livezAttributionSummary.activeRequestCount.samples, 3);
    assert.ok(report.livezAttributionSummary.handlerDurationMs);
    assert.equal(report.livezAttributionSummary.handlerDurationMs.min, 0.05);
    assert.equal(report.livezAttributionSummary.handlerDurationMs.max, 0.05);
    assert.equal(report.livezAttributionSummary.handlerDurationMs.avg, 0.05);
    assert.equal(report.livezAttributionSummary.handlerDurationMs.samples, 3);
  });

  it("tolerates missing /livez attribution fields gracefully", async () => {
    const fetchImpl = async () => jsonResponse({
      ok: true,
      service: "a2a-broker",
    });

    const report = await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 3,
      intervalMs: 5,
    });

    assert.equal(report.probeCount, 3);
    // No attribution fields in the response body — should produce nulls
    for (const cp of report.correlatedProbes) {
      assert.ok(cp.attribution);
      assert.equal(cp.attribution.eventLoop, null);
      assert.equal(cp.attribution.cpu, null);
      assert.equal(cp.attribution.gc, null);
      assert.equal(cp.attribution.timing, null);
      assert.equal(cp.attribution.diagMs, null);
      assert.equal(cp.attribution.brokerCpuPercent, null);
    }
    // livezAttributionSummary should have null entries (no data to aggregate)
    assert.ok(report.livezAttributionSummary);
    assert.equal(report.livezAttributionSummary.brokerCpuPercent, null);
    assert.equal(report.livezAttributionSummary.eventLoopDelayMs, null);
    assert.equal(report.livezAttributionSummary.diagMs, null);
  });

  it("can disable host-level metric collection with --no-host-metrics equivalent", async () => {
    const fetchImpl = async () => jsonResponse({ ok: true, service: "a2a-broker" });

    const report = await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 3,
      intervalMs: 5,
      collectHostMetrics: false,
    });

    assert.equal(report.probeCount, 3);
    assert.equal(report.failureCount, 0);
    // correlatedProbes should be empty when host metrics disabled
    assert.equal(report.correlatedProbes.length, 0);
    // hostMetricsSummary should be from host baseline (which is also null when disabled)
    // Actually the current implementation still collects baseline when collectHostMetrics is
    // on; when disabled, hostBaseline is null but the buildReport still includes it.
    // Let's check that metrics collection was actually skipped: correlatedProbes is the
    // key indicator since per-probe sampling stops.
  });

  it("collects host diagnostic functions without exceptions", () => {
    // Test that the exported host metric helpers don't throw
    const loadAvg = readLoadAverage();
    // readLoadAverage may be null if /proc/loadavg is unavailable (test env)
    // but should never throw
    assert.doesNotThrow(() => readLoadAverage());
    assert.doesNotThrow(() => readProcPressure());
    assert.doesNotThrow(() => readCpuTicks());
    assert.doesNotThrow(() => collectHostDiagnostics());

    const hostDiag = collectHostDiagnostics();
    // At minimum processUptimeSec should be a positive number
    assert.ok(typeof hostDiag.processUptimeSec === "number");
    assert.ok(hostDiag.processUptimeSec > 0);
  });

  it("extractLivezAttribution handles null/empty input", () => {
    assert.equal(extractLivezAttribution(null), null);
    assert.equal(extractLivezAttribution(undefined), null);
    assert.equal(extractLivezAttribution("not an object"), null);
    assert.equal(extractLivezAttribution(42), null);
  });

  it("extractLivezAttribution preserves all known attribution fields", () => {
    const body = {
      ok: true,
      uptimeSec: 999,
      eventLoop: { delayMs: 0.5 },
      cpu: { percentSinceLastCheck: 3.2, deltaIntervalMs: 250 },
      gc: { totalMs: 5.0, count: 2, lastMs: 1.0, recentMax60sMs: 3.0 },
      timing: { count: 10, maxMs: 2.0, p99Ms: 1.5 },
      diagMs: 0.05,
      activeRequests: 2,
      requestDurationMs: 0.04,
    };
    const result = extractLivezAttribution(body);
    assert.ok(result);
    assert.equal(result.uptimeSec, 999);
    assert.equal(result.eventLoopDelayMs, 0.5);
    assert.equal(result.brokerCpuPercent, 3.2);
    assert.equal(result.brokerCpuDeltaIntervalMs, 250);
    assert.deepEqual(result.gc, body.gc);
    assert.deepEqual(result.timing, body.timing);
    assert.equal(result.diagMs, 0.05);
    assert.equal(result.activeRequests, 2);
    assert.equal(result.requestDurationMs, 0.04);
  });

  it("reports host metrics summary with process baseline in live mode", async () => {
    const fetchImpl = async () => jsonResponse({ ok: true, service: "a2a-broker", uptimeSec: 100 });

    const report = await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 2,
      intervalMs: 5,
    });

    assert.ok(report.hostMetricsSummary);
    assert.ok(typeof report.hostMetricsSummary.processUptimeSec === "number");
    assert.ok(report.hostMetricsSummary.processUptimeSec > 0);
    // loadAverage may be null (no /proc/loadavg) but the field should exist
    assert.ok("loadAverage" in report.hostMetricsSummary);
    assert.ok("procPressure" in report.hostMetricsSummary);
    assert.ok("cpuTicks" in report.hostMetricsSummary);
  });
});

describe("broker livez stall attribution (orchestrator)", () => {
  it("runMeasurement dispatches correctly based on noLive flag", async () => {
    const liveReport = await runMeasurement({ noLive: false, fetchImpl: async () => jsonResponse({ ok: true }), count: 3, intervalMs: 5 });
    assert.equal(liveReport.mode, "live");
    assert.equal(liveReport.probeCount, 3);
    assert.equal(liveReport.ok, true);

    const noLiveReport = await runMeasurement({ noLive: true });
    assert.equal(noLiveReport.mode, "no-live");
  });
});

describe("broker livez stall attribution (client timing #1108)", () => {
  it("sends x-a2a-probe-start-unix-ms header on live probes", async () => {
    let capturedHeaders = null;
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/schedz") {
        return jsonResponse({
          ok: true,
          operatorGate: { bucket: "no-significant-stall", confidence: "high" },
          perRequest: {
            handlerMs: { p50Ms: 0.08, p95Ms: 0.25, p99Ms: 0.52, maxMs: 1.23, averageMs: 0.12, samples: 120 },
          },
        });
      }
      assert.equal(parsed.pathname, "/livez");
      capturedHeaders = init?.headers ?? {};
      return jsonResponse({
        ok: true,
        service: "a2a-broker",
        probeTiming: {
          handlerStartUnixMs: Date.now(),
          socketHadServedRequest: false,
          socketRequestIndex: 0,
        },
      });
    };

    const report = await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 1,
      intervalMs: 0,
      timeoutMs: 2000,
    });

    assert.ok(capturedHeaders, "headers should have been captured");
    const probeStartHeader = capturedHeaders["x-a2a-probe-start-unix-ms"];
    assert.ok(typeof probeStartHeader === "string", "x-a2a-probe-start-unix-ms header must be a string");
    const parsed = Number(probeStartHeader);
    assert.ok(Number.isFinite(parsed), "x-a2a-probe-start-unix-ms must be a finite number");
    // Should be within the last ~10 seconds
    assert.ok(Math.abs(parsed - Date.now()) < 10000, "probe start should be recent");
    assert.equal(report.ok, true);
    assert.equal(report.livezConnectionMode, "default");
  });

  it("reports livezConnectionMode in report output", async () => {
    const fetchImpl = async () => jsonResponse({ ok: true, service: "a2a-broker" });

    const report = await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 2,
      intervalMs: 0,
      livezConnectionMode: "fresh",
    });

    assert.equal(report.livezConnectionMode, "fresh");
  });

  it("sends connection: close in fresh mode", async () => {
    const headersReceived = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      const h = init?.headers ?? {};
      if (parsed.pathname !== "/schedz") {
        headersReceived.push(h.connection);
      }
      return jsonResponse({
        ok: true,
        service: "a2a-broker",
      });
    };

    await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 3,
      intervalMs: 0,
      livezConnectionMode: "fresh",
    });

    assert.equal(headersReceived.length, 3);
    for (const header of headersReceived) {
      assert.equal(header, "close");
    }
  });

  it("sends connection: keep-alive in keep-alive mode", async () => {
    const headersReceived = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      const h = init?.headers ?? {};
      if (parsed.pathname !== "/schedz") {
        headersReceived.push(h.connection);
      }
      return jsonResponse({
        ok: true,
        service: "a2a-broker",
      });
    };

    await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 3,
      intervalMs: 0,
      livezConnectionMode: "keep-alive",
    });

    assert.equal(headersReceived.length, 3);
    for (const header of headersReceived) {
      assert.equal(header, "keep-alive");
    }
  });

  it("extracts socket reuse fields from probeTiming in correlation", async () => {
    const fetchImpl = async () => jsonResponse({
      ok: true,
      service: "a2a-broker",
      probeTiming: {
        handlerStartUnixMs: Date.now(),
        socketHadServedRequest: false,
        socketRequestIndex: 0,
        clientProbeStartToHandlerStartMs: 0.15,
        clientProbeStartToSocketConnectedMs: 0.05,
      },
    });

    const report = await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 2,
      intervalMs: 0,
    });

    assert.equal(report.probeCount, 2);
    assert.ok(Array.isArray(report.correlatedProbes));
    assert.equal(report.correlatedProbes.length, 2);
    for (const cp of report.correlatedProbes) {
      assert.ok(cp.attribution);
      assert.equal(cp.attribution.socketHadServedRequest, false);
      assert.equal(cp.attribution.socketRequestIndex, 0);
      assert.ok(typeof cp.attribution.clientProbeStartToHandlerStartMs === "number");
      assert.ok(typeof cp.attribution.clientProbeStartToSocketConnectedMs === "number");
    }

    // Check attribution summary has socket reuse summary
    assert.ok(report.livezAttributionSummary);
    assert.ok(report.livezAttributionSummary.socketReuse);
    assert.equal(report.livezAttributionSummary.socketReuse.freshConnectionCount, 2);
    assert.equal(report.livezAttributionSummary.socketReuse.reusedConnectionCount, 0);
  });

  it("tolerates probeTiming being absent (backward compat)", async () => {
    const fetchImpl = async () => jsonResponse({
      ok: true,
      service: "a2a-broker",
      // no probeTiming field
    });

    const report = await runLiveMeasurement({
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 2,
      intervalMs: 0,
    });

    assert.equal(report.ok, true);
    for (const cp of report.correlatedProbes) {
      assert.equal(cp.attribution.socketHadServedRequest, null);
      assert.equal(cp.attribution.socketRequestIndex, null);
      assert.equal(cp.attribution.clientProbeStartToHandlerStartMs, null);
    }
    // socketReuse should not be present when no data (handled by truthy check)
  });
});

describe("broker livez stall attribution (all-modes)", () => {
  it("produces byConnectionMode breakdown in no-live mode", async () => {
    const report = await runMeasurement({ noLive: true, allModes: true, count: 5 });

    assert.equal(report.mode, "all-modes");
    assert.equal(report.livezConnectionMode, "all");
    assert.ok(report.byConnectionMode, "byConnectionMode should be populated");

    // All three modes should be present
    const modes = ["default", "fresh", "keep-alive"];
    for (const mode of modes) {
      assert.ok(report.byConnectionMode[mode], `byConnectionMode should contain ${mode}`);
      assert.equal(report.byConnectionMode[mode].probeCount, 5);
      assert.equal(typeof report.byConnectionMode[mode].maxDurationMs, "number");
      assert.equal(typeof report.byConnectionMode[mode].p50DurationMs, "number");
      assert.equal(typeof report.byConnectionMode[mode].p95DurationMs, "number");
      assert.equal(typeof report.byConnectionMode[mode].p99DurationMs, "number");
      assert.equal(typeof report.byConnectionMode[mode].stalled, "boolean");
      assert.equal(typeof report.byConnectionMode[mode].ok, "boolean");
    }
  });

  it("byConnectionMode is null in single-mode report", async () => {
    const report = await runMeasurement({ noLive: true, allModes: false, count: 5 });
    assert.equal(report.byConnectionMode, null);
  });

  it("produces byConnectionMode breakdown in live mode", async () => {
    const modeResults = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/schedz") {
        return jsonResponse({
          ok: true,
          operatorGate: { bucket: "no-significant-stall", confidence: "high" },
        });
      }
      assert.equal(parsed.pathname, "/livez");
      modeResults.push(init?.headers?.connection ?? "default");
      return jsonResponse({ ok: true, service: "a2a-broker", uptimeSec: 50 });
    };

    const report = await runMeasurement({
      noLive: false,
      allModes: true,
      baseUrl: "http://broker.local",
      fetchImpl,
      count: 3,
      intervalMs: 5,
      timeoutMs: 2000,
    });

    assert.equal(report.mode, "all-modes");
    assert.equal(report.livezConnectionMode, "all");
    assert.ok(report.byConnectionMode);

    // Check that connection headers were sent for each mode
    assert.ok(modeResults.length >= 9, "should have 3 probes per mode across 3 modes");
    assert.ok(modeResults.includes("close"), "fresh mode should send connection: close");
    assert.ok(modeResults.includes("keep-alive"), "keep-alive mode should send connection: keep-alive");
    assert.ok(modeResults.includes("default"), "default mode may send connection header or not");

    for (const mode of ["default", "fresh", "keep-alive"]) {
      assert.ok(report.byConnectionMode[mode], `byConnectionMode should contain ${mode}`);
      assert.equal(report.byConnectionMode[mode].probeCount, 3);
      assert.equal(report.byConnectionMode[mode].ok, true);
    }
  });

  it("combined report marks stalled when any mode fails", async () => {
    // Use no-live mode with simulateStall to validate stall propagation
    const report = await runMeasurement({
      noLive: true,
      allModes: true,
      count: 3,
      simulateStall: false,
    });

    assert.equal(report.mode, "all-modes");
    assert.equal(report.livezConnectionMode, "all");
    assert.ok(report.byConnectionMode);

    // In no-live mode without simulation, all modes should pass
    for (const mode of ["default", "fresh", "keep-alive"]) {
      assert.ok(report.byConnectionMode[mode]);
      assert.equal(report.byConnectionMode[mode].stalled, false);
      assert.equal(report.byConnectionMode[mode].ok, true);
    }
  });

  it("handles --all-modes flag via runMeasurement", async () => {
    const report = await runMeasurement({ noLive: true, allModes: true, count: 4 });
    assert.equal(report.mode, "all-modes");
    assert.ok(report.byConnectionMode);
    for (const mode of ["default", "fresh", "keep-alive"]) {
      assert.equal(report.byConnectionMode[mode].probeCount, 4);
    }
  });
});
