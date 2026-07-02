#!/usr/bin/env node
// Comprehensive read-only operator measurement script that samples external
// /livez wall time, /livez internal timing, /schedz scheduling timing,
// docker/container CPU, load, and available pressure/run-queue signals in one
// bounded report.
//
// Intended for loopback/broker-local use only — never deploys, restarts
// Gateway, sends Telegram, mutates broker state, or ACKs terminal-outbox
// records.
//
// Issue: https://github.com/jinwon-int/a2a-broker/issues/1032
// Lane issue: https://github.com/jinwon-int/a2a-broker/issues/1053
// Run: broker-1032-allhands-scheduling-20260531T121928Z

import process from "node:process";
import fs from "node:fs";

import {
  collectHostDiagnostics,
  readLoadAverage,
  readProcPressure,
  readCpuTicks,
} from "./broker-livez-stall-attribution.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_COUNT = 20;
const DEFAULT_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LIVEZ_CONNECTION_MODE = "default";
const LIVEZ_CONNECTION_MODE_LIST = ["default", "fresh", "keep-alive"];
const LIVEZ_CONNECTION_MODES = new Set(LIVEZ_CONNECTION_MODE_LIST);
const MAX_COMPARISON_COUNT_PER_MODE = 100;
const REQUESTER_ID = "broker-comprehensive-diagnostics";
const ISSUE = "#1032";
const LANE_ISSUE = "#1053";
const RUN_ID = "broker-1032-allhands-scheduling-20260531T121928Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(check, detail, extra = {}) {
  return { ok: true, check, detail, ...extra };
}

function fail(check, detail, extra = {}) {
  return { ok: false, check, detail, ...extra };
}

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    baseUrl: readOption("--base-url") ?? process.env.BROKER_URL ?? DEFAULT_BASE_URL,
    count: parsePositiveIntegerOption(readOption("--count") ?? process.env.DIAGNOSTICS_COUNT ?? DEFAULT_COUNT, "--count"),
    intervalMs: parseNumericOption(readOption("--interval") ?? process.env.DIAGNOSTICS_INTERVAL_MS ?? DEFAULT_INTERVAL_MS, "--interval"),
    timeoutMs: parseNumericOption(readOption("--timeout") ?? process.env.DIAGNOSTICS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS, "--timeout"),
    requesterId: optionalString(readOption("--requester-id") ?? process.env.DIAGNOSTICS_REQUESTER_ID) ?? REQUESTER_ID,
    livezConnectionMode: parseLivezConnectionMode(
      readOption("--livez-connection-mode") ?? process.env.LIVEZ_CONNECTION_MODE ?? DEFAULT_LIVEZ_CONNECTION_MODE,
    ),
    compareLivezConnectionModes: argv.includes("--compare-livez-connection-modes")
      || process.env.COMPARE_LIVEZ_CONNECTION_MODES === "1",
    includeLivezOnlyGate: argv.includes("--include-livez-only-gate")
      || process.env.INCLUDE_LIVEZ_ONLY_GATE === "1",
    allowNonLoopbackEdgeSecret: argv.includes("--allow-non-loopback-edge-secret")
      || process.env.ALLOW_NON_LOOPBACK_EDGE_SECRET === "1",
    edgeSecret: optionalString(
      process.env.BROKER_EDGE_SECRET
      ?? process.env.A2A_BROKER_EDGE_SECRET
      ?? process.env.EDGE_SECRET
      ?? process.env.A2A_EDGE_SECRET,
    ),
    noLive: argv.includes("--no-live") || argv.includes("--dry-run"),
    markdown: argv.includes("--markdown") || argv.includes("--format=markdown"),
    json: argv.includes("--json") || argv.includes("--format=json"),
    simulateStall: argv.includes("--simulate-stall"),
    simulateResidualStall: argv.includes("--simulate-residual-stall"),
    collectHostMetrics: !argv.includes("--no-host-metrics"),
  };
}

function optionalString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRequesterId(value) {
  return optionalString(value) ?? REQUESTER_ID;
}

function requesterIdForConnectionMode(baseRequesterId, mode) {
  return `${normalizeRequesterId(baseRequesterId)}:${mode}`;
}

function parseNumericOption(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function parsePositiveIntegerOption(value, name) {
  const parsed = parseNumericOption(value, name);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseLivezConnectionMode(value) {
  const mode = String(value ?? DEFAULT_LIVEZ_CONNECTION_MODE).trim().toLowerCase();
  if (!LIVEZ_CONNECTION_MODES.has(mode)) {
    throw new Error(`--livez-connection-mode must be one of: ${[...LIVEZ_CONNECTION_MODES].join(", ")}`);
  }
  return mode;
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    throw new Error(`expected finite number, got ${value}`);
  }
  return Math.min(Math.max(value, min), max);
}

function normalizeProbeCount(value, max = 200) {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("--count must be a positive integer");
  }
  return clamp(value, 1, max);
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function assertSafeEdgeSecretDestination(baseUrl, edgeSecret, allowNonLoopbackEdgeSecret = false) {
  if (!edgeSecret || allowNonLoopbackEdgeSecret) return;
  if (!isLoopbackUrl(baseUrl)) {
    throw new Error("--base-url must be loopback when sending edge secret; use --allow-non-loopback-edge-secret only for an explicitly approved broker-local URL");
  }
}

// ---------------------------------------------------------------------------
// Percentile computation
// ---------------------------------------------------------------------------

function percentile(sorted, pct) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[clamp(idx, 0, sorted.length - 1)];
}

function maxNumber(...values) {
  return values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0);
}

function summarizeNumberList(values) {
  const numbers = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: roundProbeMs(sorted[0]),
    max: roundProbeMs(sorted[sorted.length - 1]),
    avg: roundProbeMs(sum / sorted.length),
    p95: roundProbeMs(percentile(sorted, 95)),
    p99: roundProbeMs(percentile(sorted, 99)),
    samples: sorted.length,
  };
}

function summaryMax(summary) {
  return typeof summary?.max === "number" && Number.isFinite(summary.max) ? summary.max : 0;
}

function maxRouteTiming(requestRouteSummary = []) {
  if (!Array.isArray(requestRouteSummary)) return 0;
  return requestRouteSummary.reduce((max, route) => {
    return maxNumber(max, route.maxTimingMs, route.maxFirstRequestLatencyMs);
  }, 0);
}

function maxHeartbeatPhaseTiming(workerHeartbeatPhaseSummary = []) {
  if (!Array.isArray(workerHeartbeatPhaseSummary)) return 0;
  return workerHeartbeatPhaseSummary.reduce((max, phase) => maxNumber(max, phase.maxMs), 0);
}

function topRouteSignal(requestRoutes) {
  if (!requestRoutes || typeof requestRoutes !== "object") return null;
  return Object.entries(requestRoutes)
    .map(([route, metrics]) => ({
      route,
      maxTimingMs: maxNumber(metrics?.timing?.maxMs),
      maxFirstRequestLatencyMs: maxNumber(metrics?.firstRequestLatencyMs?.maxMs),
      active: typeof metrics?.active === "number" ? metrics.active : null,
    }))
    .filter((entry) => entry.maxTimingMs > 0 || entry.maxFirstRequestLatencyMs > 0 || entry.active > 0)
    .sort((a, b) => {
      const aMax = Math.max(a.maxTimingMs, a.maxFirstRequestLatencyMs);
      const bMax = Math.max(b.maxTimingMs, b.maxFirstRequestLatencyMs);
      return bMax - aMax;
    })[0] ?? null;
}

function topHeartbeatPhaseSignal(workerHeartbeatPhases) {
  if (!workerHeartbeatPhases || typeof workerHeartbeatPhases !== "object") return null;
  return Object.entries(workerHeartbeatPhases)
    .map(([phase, timing]) => ({
      phase,
      maxMs: maxNumber(timing?.maxMs),
      p99Ms: maxNumber(timing?.p99Ms),
      p95Ms: maxNumber(timing?.p95Ms),
      count: typeof timing?.count === "number" ? timing.count : null,
    }))
    .filter((entry) => entry.maxMs > 0 || entry.p99Ms > 0 || entry.p95Ms > 0)
    .sort((a, b) => b.maxMs - a.maxMs)[0] ?? null;
}

function topPerWorkerHeartbeatSignal(perWorkerHeartbeatPhases) {
  if (!perWorkerHeartbeatPhases || typeof perWorkerHeartbeatPhases !== "object") return null;
  const entries = [];
  for (const [workerId, phases] of Object.entries(perWorkerHeartbeatPhases)) {
    if (!phases || typeof phases !== "object") continue;
    for (const [phase, timing] of Object.entries(phases)) {
      entries.push({
        workerId,
        phase,
        maxMs: maxNumber(timing?.maxMs),
        p99Ms: maxNumber(timing?.p99Ms),
        p95Ms: maxNumber(timing?.p95Ms),
        count: typeof timing?.count === "number" ? timing.count : null,
      });
    }
  }
  return entries
    .filter((entry) => entry.maxMs > 0 || entry.p99Ms > 0 || entry.p95Ms > 0)
    .sort((a, b) => b.maxMs - a.maxMs)[0] ?? null;
}

function topWorkerRegisterPhaseSignal(workerRegisterPhases) {
  if (!workerRegisterPhases || typeof workerRegisterPhases !== "object") return null;
  return Object.entries(workerRegisterPhases)
    .map(([phase, timing]) => ({
      phase,
      maxMs: maxNumber(timing?.maxMs),
      p99Ms: maxNumber(timing?.p99Ms),
      p95Ms: maxNumber(timing?.p95Ms),
      count: typeof timing?.count === "number" ? timing.count : null,
    }))
    .filter((entry) => entry.maxMs > 0 || entry.p99Ms > 0 || entry.p95Ms > 0)
    .sort((a, b) => b.maxMs - a.maxMs)[0] ?? null;
}

function firstCounterEntry(entries) {
  return Array.isArray(entries) && entries[0] && typeof entries[0] === "object" ? entries[0] : null;
}

function terminalOutboxSignal(terminalOutbox) {
  if (!terminalOutbox || typeof terminalOutbox !== "object") return null;
  const pendingWorker = firstCounterEntry(terminalOutbox.topPendingAckWorkers);
  const worker = pendingWorker ?? firstCounterEntry(terminalOutbox.topWorkers);
  const status = firstCounterEntry(terminalOutbox.topStatuses);
  const receiptStatus = firstCounterEntry(terminalOutbox.topReceiptStatuses);
  const pendingStatus = firstCounterEntry(terminalOutbox.topPendingAckStatuses);
  const pendingReceiptStatus = firstCounterEntry(terminalOutbox.topPendingAckReceiptStatuses);
  const pendingBroker = firstCounterEntry(terminalOutbox.topPendingAckBrokersOfRecord);
  return {
    sampledCount: typeof terminalOutbox.sampledCount === "number" ? terminalOutbox.sampledCount : null,
    retainedCount: typeof terminalOutbox.retainedCount === "number" ? terminalOutbox.retainedCount : null,
    pendingAckCount: typeof terminalOutbox.pendingAckCount === "number" ? terminalOutbox.pendingAckCount : null,
    oldestPendingAckAgeMs: typeof terminalOutbox.oldestPendingAckAgeMs === "number" ? terminalOutbox.oldestPendingAckAgeMs : null,
    oldestPendingAckWorkerId: typeof terminalOutbox.oldestPendingAckWorker === "string" ? terminalOutbox.oldestPendingAckWorker : null,
    oldestPendingAckStatus: typeof terminalOutbox.oldestPendingAckStatus === "string" ? terminalOutbox.oldestPendingAckStatus : null,
    oldestPendingAckReceiptStatus: typeof terminalOutbox.oldestPendingAckReceiptStatus === "string" ? terminalOutbox.oldestPendingAckReceiptStatus : null,
    oldestPendingAckBrokerOfRecord: typeof terminalOutbox.oldestPendingAckBrokerOfRecord === "string" ? terminalOutbox.oldestPendingAckBrokerOfRecord : null,
    topWorkerId: typeof worker?.key === "string" ? worker.key : null,
    topWorkerCount: typeof worker?.count === "number" ? worker.count : null,
    topStatus: typeof status?.key === "string" ? status.key : null,
    topStatusCount: typeof status?.count === "number" ? status.count : null,
    topReceiptStatus: typeof receiptStatus?.key === "string" ? receiptStatus.key : null,
    topReceiptStatusCount: typeof receiptStatus?.count === "number" ? receiptStatus.count : null,
    topPendingAckStatus: typeof pendingStatus?.key === "string" ? pendingStatus.key : null,
    topPendingAckStatusCount: typeof pendingStatus?.count === "number" ? pendingStatus.count : null,
    topPendingAckReceiptStatus: typeof pendingReceiptStatus?.key === "string" ? pendingReceiptStatus.key : null,
    topPendingAckReceiptStatusCount: typeof pendingReceiptStatus?.count === "number" ? pendingReceiptStatus.count : null,
    topPendingAckBrokerOfRecord: typeof pendingBroker?.key === "string" ? pendingBroker.key : null,
    topPendingAckBrokerOfRecordCount: typeof pendingBroker?.count === "number" ? pendingBroker.count : null,
  };
}

function buildSlowProbeSchedzSignals(probe) {
  const scheduling = probe?.schedzTimingSnapshot;
  const route = topRouteSignal(probe?.schedzRequestRoutes);
  const heartbeat = topHeartbeatPhaseSignal(probe?.workerHeartbeatPhases);
  const perWorkerHeartbeat = topPerWorkerHeartbeatSignal(probe?.perWorkerHeartbeatPhases);
  const workerRegister = topWorkerRegisterPhaseSignal(probe?.workerRegisterPhases);
  const perWorkerRegister = topPerWorkerHeartbeatSignal(probe?.perWorkerRegisterPhases);
  const terminalOutbox = terminalOutboxSignal(probe?.terminalOutbox);
  const container = probe?.schedzContainer;
  const cpuDelta = container?.cgroup?.cpuDelta;
  const psiCpu = container?.psi?.cpu;
  const hostLoad = probe?.host?.loadAverage;
  const hostPressure = probe?.host?.procPressure;

  return {
    schedzSchedulingMaxMs: typeof scheduling?.maxMs === "number" ? scheduling.maxMs : null,
    schedzSchedulingP99Ms: typeof scheduling?.p99Ms === "number" ? scheduling.p99Ms : null,
    schedzSchedulingP95Ms: typeof scheduling?.p95Ms === "number" ? scheduling.p95Ms : null,
    schedzSchedulingP50Ms: typeof scheduling?.p50Ms === "number" ? scheduling.p50Ms : null,
    schedzTopRoute: route?.route ?? null,
    schedzTopRouteMaxMs: route ? Math.max(route.maxTimingMs, route.maxFirstRequestLatencyMs) : null,
    schedzTopRouteTimingMaxMs: route?.maxTimingMs ?? null,
    schedzTopRouteFirstRequestMaxMs: route?.maxFirstRequestLatencyMs ?? null,
    workerHeartbeatTopPhase: heartbeat?.phase ?? null,
    workerHeartbeatTopPhaseMaxMs: heartbeat?.maxMs ?? null,
    workerHeartbeatTopPhaseP99Ms: heartbeat?.p99Ms ?? null,
    workerHeartbeatTopWorkerId: perWorkerHeartbeat?.workerId ?? null,
    workerHeartbeatTopWorkerPhase: perWorkerHeartbeat?.phase ?? null,
    workerHeartbeatTopWorkerPhaseMaxMs: perWorkerHeartbeat?.maxMs ?? null,
    workerHeartbeatTopWorkerPhaseP99Ms: perWorkerHeartbeat?.p99Ms ?? null,
    workerRegisterTopPhase: workerRegister?.phase ?? null,
    workerRegisterTopPhaseMaxMs: workerRegister?.maxMs ?? null,
    workerRegisterTopPhaseP99Ms: workerRegister?.p99Ms ?? null,
    workerRegisterTopWorkerId: perWorkerRegister?.workerId ?? null,
    workerRegisterTopWorkerPhase: perWorkerRegister?.phase ?? null,
    workerRegisterTopWorkerPhaseMaxMs: perWorkerRegister?.maxMs ?? null,
    workerRegisterTopWorkerPhaseP99Ms: perWorkerRegister?.p99Ms ?? null,
    terminalOutboxSampledCount: terminalOutbox?.sampledCount ?? null,
    terminalOutboxRetainedCount: terminalOutbox?.retainedCount ?? null,
    terminalOutboxPendingAckCount: terminalOutbox?.pendingAckCount ?? null,
    terminalOutboxOldestPendingAckAgeMs: terminalOutbox?.oldestPendingAckAgeMs ?? null,
    terminalOutboxOldestPendingAckWorkerId: terminalOutbox?.oldestPendingAckWorkerId ?? null,
    terminalOutboxOldestPendingAckStatus: terminalOutbox?.oldestPendingAckStatus ?? null,
    terminalOutboxOldestPendingAckReceiptStatus: terminalOutbox?.oldestPendingAckReceiptStatus ?? null,
    terminalOutboxOldestPendingAckBrokerOfRecord: terminalOutbox?.oldestPendingAckBrokerOfRecord ?? null,
    terminalOutboxTopWorkerId: terminalOutbox?.topWorkerId ?? null,
    terminalOutboxTopWorkerCount: terminalOutbox?.topWorkerCount ?? null,
    terminalOutboxTopStatus: terminalOutbox?.topStatus ?? null,
    terminalOutboxTopStatusCount: terminalOutbox?.topStatusCount ?? null,
    terminalOutboxTopReceiptStatus: terminalOutbox?.topReceiptStatus ?? null,
    terminalOutboxTopReceiptStatusCount: terminalOutbox?.topReceiptStatusCount ?? null,
    terminalOutboxTopPendingAckStatus: terminalOutbox?.topPendingAckStatus ?? null,
    terminalOutboxTopPendingAckStatusCount: terminalOutbox?.topPendingAckStatusCount ?? null,
    terminalOutboxTopPendingAckReceiptStatus: terminalOutbox?.topPendingAckReceiptStatus ?? null,
    terminalOutboxTopPendingAckReceiptStatusCount: terminalOutbox?.topPendingAckReceiptStatusCount ?? null,
    terminalOutboxTopPendingAckBrokerOfRecord: terminalOutbox?.topPendingAckBrokerOfRecord ?? null,
    terminalOutboxTopPendingAckBrokerOfRecordCount: terminalOutbox?.topPendingAckBrokerOfRecordCount ?? null,
    containerCpuDeltaNrThrottled: typeof cpuDelta?.deltaNrThrottled === "number" ? cpuDelta.deltaNrThrottled : null,
    containerCpuDeltaThrottledMs: typeof cpuDelta?.deltaThrottledUsec === "number"
      ? roundProbeMs(cpuDelta.deltaThrottledUsec / 1000)
      : null,
    containerPsiCpuSomeAvg10: typeof psiCpu?.some?.avg10 === "number" ? psiCpu.some.avg10 : null,
    containerPsiCpuFullAvg10: typeof psiCpu?.full?.avg10 === "number" ? psiCpu.full.avg10 : null,
    hostLoad1: typeof hostLoad?.load1 === "number" ? hostLoad.load1 : null,
    hostRunQueue: typeof hostLoad?.running === "number" ? hostLoad.running : null,
    hostCpuPsiAvg10: typeof hostPressure?.cpu?.avg10 === "number" ? hostPressure.cpu.avg10 : null,
  };
}

function incrementSpikeBucket(bucket, probe) {
  bucket.count++;
  bucket.maxWallMs = maxNumber(bucket.maxWallMs, probe.livezWallMs);
  bucket.maxSocketAgeBeforeHandlerMs = maxNumber(
    bucket.maxSocketAgeBeforeHandlerMs,
    probe.livezClientTiming?.socketAgeBeforeHandlerMs,
  );
  bucket.maxSocketIdleBeforeRequestMs = maxNumber(
    bucket.maxSocketIdleBeforeRequestMs,
    probe.livezClientTiming?.socketIdleBeforeRequestMs,
  );
  bucket.maxClientToServerStartLagMs = maxNumber(
    bucket.maxClientToServerStartLagMs,
    probe.livezClientTiming?.clientToServerStartLagMs,
  );
  bucket.maxClientToSocketConnectedLagMs = maxNumber(
    bucket.maxClientToSocketConnectedLagMs,
    probe.livezClientTiming?.clientToSocketConnectedLagMs,
  );
}

function emptySpikeBucket() {
  return {
    count: 0,
    maxWallMs: 0,
    maxSocketAgeBeforeHandlerMs: 0,
    maxSocketIdleBeforeRequestMs: 0,
    maxClientToServerStartLagMs: 0,
    maxClientToSocketConnectedLagMs: 0,
  };
}

function summarizeLivezSpikeCorrelation(correlatedProbes, thresholdMs = 1000) {
  const probes = Array.isArray(correlatedProbes) ? correlatedProbes : [];
  const slowProbes = probes
    .filter((probe) => typeof probe?.livezWallMs === "number" && probe.livezWallMs > thresholdMs)
    .sort((a, b) => b.livezWallMs - a.livezWallMs);

  const byConnectionReuse = {
    firstRequest: emptySpikeBucket(),
    reusedSocket: emptySpikeBucket(),
    unknown: emptySpikeBucket(),
  };
  const byRequestIndex = {
    first: emptySpikeBucket(),
    reused: emptySpikeBucket(),
    unknown: emptySpikeBucket(),
  };

  for (const probe of slowProbes) {
    const hadServed = probe.livezClientTiming?.socketHadServedRequest;
    if (hadServed === true) {
      incrementSpikeBucket(byConnectionReuse.reusedSocket, probe);
    } else if (hadServed === false) {
      incrementSpikeBucket(byConnectionReuse.firstRequest, probe);
    } else {
      incrementSpikeBucket(byConnectionReuse.unknown, probe);
    }

    const requestIndex = probe.livezClientTiming?.socketRequestIndex;
    if (requestIndex === 1) {
      incrementSpikeBucket(byRequestIndex.first, probe);
    } else if (typeof requestIndex === "number" && requestIndex > 1) {
      incrementSpikeBucket(byRequestIndex.reused, probe);
    } else {
      incrementSpikeBucket(byRequestIndex.unknown, probe);
    }
  }

  const topSlowSamples = slowProbes.slice(0, 8).map((probe) => ({
    index: typeof probe.index === "number" ? probe.index : null,
    timestamp: typeof probe.timestamp === "string" ? probe.timestamp : null,
    livezWallMs: probe.livezWallMs,
    schedzWallMs: typeof probe.schedzWallMs === "number" ? probe.schedzWallMs : null,
    socketRequestIndex: typeof probe.livezClientTiming?.socketRequestIndex === "number"
      ? probe.livezClientTiming.socketRequestIndex
      : null,
    socketHadServedRequest: typeof probe.livezClientTiming?.socketHadServedRequest === "boolean"
      ? probe.livezClientTiming.socketHadServedRequest
      : null,
    socketAgeBeforeHandlerMs: typeof probe.livezClientTiming?.socketAgeBeforeHandlerMs === "number"
      ? probe.livezClientTiming.socketAgeBeforeHandlerMs
      : null,
    socketIdleBeforeRequestMs: typeof probe.livezClientTiming?.socketIdleBeforeRequestMs === "number"
      ? probe.livezClientTiming.socketIdleBeforeRequestMs
      : null,
    socketIdleBeforeHttpRequestEventMs: typeof probe.livezClientTiming?.socketIdleBeforeHttpRequestEventMs === "number"
      ? probe.livezClientTiming.socketIdleBeforeHttpRequestEventMs
      : null,
    reuseIdleBeforeDataMs: typeof probe.livezClientTiming?.reuseIdleBeforeDataMs === "number"
      ? probe.livezClientTiming.reuseIdleBeforeDataMs
      : null,
    reuseDataToHttpRequestEventMs: typeof probe.livezClientTiming?.reuseDataToHttpRequestEventMs === "number"
      ? probe.livezClientTiming.reuseDataToHttpRequestEventMs
      : null,
    clientToServerStartLagMs: typeof probe.livezClientTiming?.clientToServerStartLagMs === "number"
      ? probe.livezClientTiming.clientToServerStartLagMs
      : null,
    clientToSocketConnectedLagMs: typeof probe.livezClientTiming?.clientToSocketConnectedLagMs === "number"
      ? probe.livezClientTiming.clientToSocketConnectedLagMs
      : null,
    serverPreparedToClientHeadersMs: typeof probe.livezClientTiming?.serverPreparedToClientHeadersMs === "number"
      ? probe.livezClientTiming.serverPreparedToClientHeadersMs
      : null,
    socketAcceptedToHttpRequestEventMs: typeof probe.livezClientTiming?.socketAcceptedToHttpRequestEventMs === "number"
      ? probe.livezClientTiming.socketAcceptedToHttpRequestEventMs
      : null,
    httpRequestEventToHandlerStartMs: typeof probe.livezClientTiming?.httpRequestEventToHandlerStartMs === "number"
      ? probe.livezClientTiming.httpRequestEventToHandlerStartMs
      : null,
    ...buildSlowProbeSchedzSignals(probe),
  }));

  return {
    thresholdMs,
    totalSamples: probes.length,
    slowSamples: slowProbes.length,
    slowSharePct: probes.length > 0 ? Math.round((slowProbes.length / probes.length) * 10000) / 100 : 0,
    byConnectionReuse,
    byRequestIndex,
    topSlowSamples,
  };
}

/**
 * Classify the likely lane for residual /livez wall-time stalls using the
 * correlated timing fields collected by this diagnostic report. The output is
 * intentionally a hint for the operator, not an automatic root-cause verdict.
 *
 * @param {object} report
 * @returns {{ bucket: string, confidence: "none"|"low"|"medium"|"high", reasons: string[], signals: object }}
 */
export function classifyLivezAttribution(report) {
  const livezMaxMs = typeof report?.livezMaxMs === "number" ? report.livezMaxMs : 0;
  const samplesAbove1s = typeof report?.livezWallSamplesAbove1s === "number" ? report.livezWallSamplesAbove1s : 0;
  const samplesAbove3s = typeof report?.livezWallSamplesAbove3s === "number" ? report.livezWallSamplesAbove3s : 0;
  const handlerMaxMs = summaryMax(report?.livezTimingSummary?.handlerRequestDurationMs);
  const eventLoopMaxMs = summaryMax(report?.livezTimingSummary?.eventLoopDelayMs);
  const fetchHeadersMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.fetchHeaders);
  const clientToServerStartLagMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.clientToServerStartLag);
  const clientToSocketConnectedLagMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.clientToSocketConnectedLag);
  const clientToHttpRequestEventLagMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.clientToHttpRequestEventLag);
  const socketConnectedToHandlerStartMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.socketConnectedToHandlerStart);
  const socketIdleBeforeRequestMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.socketIdleBeforeRequest);
  const socketAcceptedToHttpRequestEventMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.socketAcceptedToHttpRequestEvent);
  const httpRequestEventToHandlerStartMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.httpRequestEventToHandlerStart);
  const socketIdleBeforeHttpRequestEventMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.socketIdleBeforeHttpRequestEvent);
  const reuseIdleBeforeDataMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.reuseIdleBeforeData);
  const reuseDataToHttpRequestEventMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.reuseDataToHttpRequestEvent);
  const serverPreparedToClientHeadersMaxMs = summaryMax(report?.livezTimingSummary?.clientWallBreakdownMs?.serverPreparedToClientHeaders);
  const schedzSchedulingMaxMs = typeof report?.schedzSchedulingMaxMs === "number" ? report.schedzSchedulingMaxMs : 0;
  const requestRouteMaxMs = maxRouteTiming(report?.requestRouteSummary);
  const heartbeatPhaseMaxMs = maxHeartbeatPhaseTiming(report?.workerHeartbeatPhaseSummary);

  const signals = {
    livezMaxMs,
    samplesAbove1s,
    samplesAbove3s,
    handlerMaxMs,
    eventLoopMaxMs,
    fetchHeadersMaxMs,
    clientToServerStartLagMaxMs,
    clientToSocketConnectedLagMaxMs,
    clientToHttpRequestEventLagMaxMs,
    socketConnectedToHandlerStartMaxMs,
    socketIdleBeforeRequestMaxMs,
    socketAcceptedToHttpRequestEventMaxMs,
    httpRequestEventToHandlerStartMaxMs,
    socketIdleBeforeHttpRequestEventMaxMs,
    reuseIdleBeforeDataMaxMs,
    reuseDataToHttpRequestEventMaxMs,
    serverPreparedToClientHeadersMaxMs,
    schedzSchedulingMaxMs,
    requestRouteMaxMs,
    heartbeatPhaseMaxMs,
  };

  if (livezMaxMs <= 1000 && samplesAbove1s === 0) {
    return {
      bucket: "no-significant-stall",
      confidence: "high",
      reasons: ["No /livez sample exceeded the 1s residual-stall threshold."],
      signals,
    };
  }

  if (handlerMaxMs > 1000 || eventLoopMaxMs > 1000) {
    return {
      bucket: "broker-handler-or-event-loop",
      confidence: handlerMaxMs > 3000 || eventLoopMaxMs > 3000 ? "high" : "medium",
      reasons: [
        `In-broker /livez handler/event-loop timing reached ${Math.max(handlerMaxMs, eventLoopMaxMs)}ms.`,
        "Prioritize request handler, event-loop, CPU, GC, or synchronous broker work.",
      ],
      signals,
    };
  }

  if (
    socketIdleBeforeHttpRequestEventMaxMs > 1000
    && socketAcceptedToHttpRequestEventMaxMs > 1000
    && httpRequestEventToHandlerStartMaxMs < 1000
  ) {
    if (
      reuseDataToHttpRequestEventMaxMs > 500
      && reuseDataToHttpRequestEventMaxMs > reuseIdleBeforeDataMaxMs * 0.5
    ) {
      return {
        bucket: "reused-socket-data-received-blocked",
        confidence: reuseDataToHttpRequestEventMaxMs > 3000 ? "high" : "medium",
        reasons: [
          `Reused socket data to HTTP request event reached ${reuseDataToHttpRequestEventMaxMs}ms.`,
          `Reused socket idle before first data was ${reuseIdleBeforeDataMaxMs}ms.`,
          "The socket received request bytes, but Node did not emit the HTTP request event until later.",
        ],
        signals,
      };
    }
    return {
      bucket: "reused-socket-idle-before-request-event",
      confidence: socketIdleBeforeHttpRequestEventMaxMs > 3000 ? "high" : "medium",
      reasons: [
        `Reused socket idle before the HTTP request event reached ${socketIdleBeforeHttpRequestEventMaxMs}ms.`,
        `Reused socket idle before first data was ${reuseIdleBeforeDataMaxMs}ms; data to HTTP request event was ${reuseDataToHttpRequestEventMaxMs}ms.`,
        `HTTP request event to handler start stayed low at ${httpRequestEventToHandlerStartMaxMs}ms.`,
        "The broker socket existed, but Node did not emit the HTTP request event until later on a reused connection.",
      ],
      signals,
    };
  }

  if (
    socketIdleBeforeHttpRequestEventMaxMs > 1000
    && socketAcceptedToHttpRequestEventMaxMs > 1000
    && httpRequestEventToHandlerStartMaxMs > 1000
  ) {
    const combinedMax = Math.max(socketIdleBeforeHttpRequestEventMaxMs, httpRequestEventToHandlerStartMaxMs);
    return {
      bucket: "reused-socket-waiting-before-handler",
      confidence: combinedMax > 3000 ? "high" : "medium",
      reasons: [
        `Reused socket idle before request event reached ${socketIdleBeforeHttpRequestEventMaxMs}ms, and `
        + `HTTP request event to handler start reached ${httpRequestEventToHandlerStartMaxMs}ms.`,
        "The broker socket existed but was idle, and the request handler was delayed after the HTTP request event (event-loop scheduling on a reused socket).",
      ],
      signals,
    };
  }

  if (clientToServerStartLagMaxMs > 1000 && socketConnectedToHandlerStartMaxMs > 1000) {
    return {
      bucket: "accepted-socket-waiting-before-handler",
      confidence: socketConnectedToHandlerStartMaxMs > 3000 ? "high" : "medium",
      reasons: [
        `Socket accepted to handler start reached ${socketConnectedToHandlerStartMaxMs}ms.`,
        "The connection reached the broker process before the request handler began (fresh connection event-loop scheduling).",
      ],
      signals,
    };
  }

  if (clientToServerStartLagMaxMs > 1000 && clientToSocketConnectedLagMaxMs > 1000) {
    return {
      bucket: "tcp-connect-or-accept-before-handler",
      confidence: clientToSocketConnectedLagMaxMs > 3000 ? "high" : "medium",
      reasons: [
        `Client start to broker socket acceptance reached ${clientToSocketConnectedLagMaxMs}ms.`,
        "Prioritize TCP accept backlog, container scheduling before connection handling, or host pressure before the broker accepts the socket.",
      ],
      signals,
    };
  }

  if (serverPreparedToClientHeadersMaxMs > 1000) {
    return {
      bucket: "response-egress-or-client-read",
      confidence: serverPreparedToClientHeadersMaxMs > 3000 ? "high" : "medium",
      reasons: [
        `Server response prepared to client headers reached ${serverPreparedToClientHeadersMaxMs}ms.`,
        "The broker prepared the response before the client observed headers.",
      ],
      signals,
    };
  }

  if (schedzSchedulingMaxMs > 1000 || requestRouteMaxMs > 1000 || heartbeatPhaseMaxMs > 1000) {
    return {
      bucket: "broker-scheduling-or-competing-route",
      confidence: Math.max(schedzSchedulingMaxMs, requestRouteMaxMs, heartbeatPhaseMaxMs) > 3000 ? "high" : "medium",
      reasons: [
        `Scheduling/route/heartbeat timing reached ${Math.max(schedzSchedulingMaxMs, requestRouteMaxMs, heartbeatPhaseMaxMs)}ms.`,
        "Correlate the slow /livez samples with /schedz route and heartbeat-phase summaries.",
      ],
      signals,
    };
  }

  if (fetchHeadersMaxMs > 1000) {
    return {
      bucket: "external-client-wall-before-headers",
      confidence: "low",
      reasons: [
        `Client fetch-to-headers reached ${fetchHeadersMaxMs}ms, but deeper server-side buckets did not cross threshold.`,
        "Additional live evidence is needed to separate client timing, socket timing, and broker timing.",
      ],
      signals,
    };
  }

  return {
    bucket: "unattributed-external-wall",
    confidence: "low",
    reasons: [
      "External /livez wall time crossed threshold, but collected attribution fields did not identify a dominant bucket.",
    ],
    signals,
  };
}

function summarizeRequestRoutes(correlatedProbes) {
  const byRoute = new Map();
  for (const probe of correlatedProbes) {
    const routes = probe.schedzRequestRoutes;
    if (!routes || typeof routes !== "object") continue;
    for (const [route, metrics] of Object.entries(routes)) {
      if (!metrics || typeof metrics !== "object") continue;
      const current = byRoute.get(route) ?? {
        route,
        samples: 0,
        maxTimingMs: 0,
        p99TimingMs: 0,
        maxFirstRequestLatencyMs: 0,
        p99FirstRequestLatencyMs: 0,
        maxActive: 0,
        onNewConnection: 0,
        onReusedConnection: 0,
      };
      current.samples++;
      current.maxTimingMs = maxNumber(current.maxTimingMs, metrics.timing?.maxMs);
      current.p99TimingMs = maxNumber(current.p99TimingMs, metrics.timing?.p99Ms);
      current.maxFirstRequestLatencyMs = maxNumber(current.maxFirstRequestLatencyMs, metrics.firstRequestLatencyMs?.maxMs);
      current.p99FirstRequestLatencyMs = maxNumber(current.p99FirstRequestLatencyMs, metrics.firstRequestLatencyMs?.p99Ms);
      current.maxActive = maxNumber(current.maxActive, metrics.active);
      current.onNewConnection = maxNumber(current.onNewConnection, metrics.onNewConnection);
      current.onReusedConnection = maxNumber(current.onReusedConnection, metrics.onReusedConnection);
      byRoute.set(route, current);
    }
  }
  return [...byRoute.values()]
    .filter((entry) => entry.maxTimingMs > 0 || entry.maxFirstRequestLatencyMs > 0 || entry.maxActive > 0)
    .sort((a, b) => {
      const aMax = Math.max(a.maxTimingMs, a.maxFirstRequestLatencyMs);
      const bMax = Math.max(b.maxTimingMs, b.maxFirstRequestLatencyMs);
      return bMax - aMax;
    });
}

function summarizeWorkerHeartbeatPhases(correlatedProbes) {
  const byPhase = new Map();
  for (const probe of correlatedProbes) {
    const phases = probe.workerHeartbeatPhases;
    if (!phases || typeof phases !== "object") continue;
    for (const [phase, timing] of Object.entries(phases)) {
      if (!timing || typeof timing !== "object") continue;
      const current = byPhase.get(phase) ?? {
        phase,
        samples: 0,
        maxMs: 0,
        p99Ms: 0,
        p95Ms: 0,
        count: 0,
      };
      current.samples++;
      current.maxMs = maxNumber(current.maxMs, timing.maxMs);
      current.p99Ms = maxNumber(current.p99Ms, timing.p99Ms);
      current.p95Ms = maxNumber(current.p95Ms, timing.p95Ms);
      current.count = maxNumber(current.count, timing.count);
      byPhase.set(phase, current);
    }
  }
  return [...byPhase.values()]
    .filter((entry) => entry.maxMs > 0 || entry.p99Ms > 0 || entry.count > 0)
    .sort((a, b) => b.maxMs - a.maxMs);
}

// ---------------------------------------------------------------------------
// Docker container stats (async)
// ---------------------------------------------------------------------------

async function readDockerContainerStats(containerName = "a2a-broker") {
  try {
    const { execSync } = await import("node:child_process");
    const stdout = execSync(
      `docker stats --no-stream --format '{{json .}}' "${containerName}" 2>/dev/null || true`,
      { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (!stdout || !stdout.trim()) return null;

    const lines = stdout.trim().split("\n");
    if (lines.length === 0) return null;

    const raw = JSON.parse(lines[0].replace(/'/g, '"'));
    const parsePercent = (v) => {
      if (typeof v === "string") return parseFloat(v.replace("%", ""));
      if (typeof v === "number") return v;
      return null;
    };
    const parseBytes = (v) => {
      if (typeof v === "string") {
        const num = parseFloat(v);
        if (v.includes("KiB")) return num * 1024;
        if (v.includes("MiB")) return num * 1024 * 1024;
        if (v.includes("GiB")) return num * 1024 * 1024 * 1024;
        return num;
      }
      if (typeof v === "number") return v;
      return null;
    };

    return {
      cpuPercent: parsePercent(raw.CPUPerc),
      memBytes: parseBytes(raw.MemUsage?.split("/")[0]?.trim()),
      memLimitBytes: parseBytes(raw.MemUsage?.split("/")[1]?.trim()),
      memPercent: parsePercent(raw.MemPerc),
      netRx: null,
      netTx: null,
      blockR: null,
      blockW: null,
      pids: raw.PIDs ? parseInt(raw.PIDs, 10) : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Run-queue / scheduling pressure from /proc
// ---------------------------------------------------------------------------

/**
 * Read /proc/stat for procs_running (run-queue length) and procs_blocked.
 * Returns null when /proc is unavailable.
 *
 * @returns {{ procsRunning: number|null, procsBlocked: number|null }|null}
 */
export function readProcRunQueue() {
  try {
    const raw = fs.readFileSync("/proc/stat", "utf8", { flag: "r" }).trim();
    if (!raw) return null;
    let procsRunning = null;
    let procsBlocked = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("procs_running ")) {
        procsRunning = parseInt(line.split(/\s+/)[1], 10);
      } else if (line.startsWith("procs_blocked ")) {
        procsBlocked = parseInt(line.split(/\s+/)[1], 10);
      }
    }
    return { procsRunning, procsBlocked };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// /livez response extraction
// ---------------------------------------------------------------------------

/**
 * Extract external /livez wall time measurement and in-broker timing from the
 * response body.
 *
 * @param {object|null} body - Parsed JSON /livez response
 * @returns {{ ok: boolean, status: number, wallTimeMs: number, handlerTiming: object|null, eventLoop: object|null, cpu: object|null, gc: object|null, diagMs: number|null, requestDurationMs: number|null, probeTiming: object|null, uptimeSec: number|null }|null}
 */
export function extractLivezMeasurement(body, wallTimeMs, status) {
  if (!body || typeof body !== "object") return null;
  return {
    ok: status === 200,
    status,
    wallTimeMs,
    handlerTiming: body.timing ?? null,
    eventLoop: body.eventLoop ?? null,
    cpu: body.cpu ?? null,
    gc: body.gc ?? null,
    diagMs: typeof body.diagMs === "number" ? body.diagMs : null,
    requestDurationMs: typeof body.requestDurationMs === "number" ? body.requestDurationMs : null,
    probeTiming: body.probeTiming ?? null,
    uptimeSec: typeof body.uptimeSec === "number" ? body.uptimeSec : null,
    activeRequests: typeof body.activeRequests === "number" ? body.activeRequests : null,
  };
}

function roundProbeMs(value) {
  return Math.round(value * 1000) / 1000;
}

function buildLivezClientTiming({
  clientStartUnixMs,
  responseHeadersUnixMs,
  bodyParsedUnixMs,
  fetchHeaderMs,
  bodyParseMs,
  totalMs,
  serverProbeTiming,
}) {
  const handlerStartUnixMs = typeof serverProbeTiming?.handlerStartUnixMs === "number"
    ? serverProbeTiming.handlerStartUnixMs
    : null;
  const responsePreparedUnixMs = typeof serverProbeTiming?.responsePreparedUnixMs === "number"
    ? serverProbeTiming.responsePreparedUnixMs
    : null;
  const socketConnectedUnixMs = typeof serverProbeTiming?.socketConnectedUnixMs === "number"
    ? serverProbeTiming.socketConnectedUnixMs
    : null;
  const socketAgeBeforeHandlerMs = typeof serverProbeTiming?.socketAgeBeforeHandlerMs === "number"
    ? serverProbeTiming.socketAgeBeforeHandlerMs
    : null;
  const socketIdleBeforeRequestMs = typeof serverProbeTiming?.socketIdleBeforeRequestMs === "number"
    ? serverProbeTiming.socketIdleBeforeRequestMs
    : null;
  const httpRequestEventUnixMs = typeof serverProbeTiming?.httpRequestEventUnixMs === "number"
    ? serverProbeTiming.httpRequestEventUnixMs
    : null;
  const socketAcceptedToHttpRequestEventMs = typeof serverProbeTiming?.socketAcceptedToHttpRequestEventMs === "number"
    ? serverProbeTiming.socketAcceptedToHttpRequestEventMs
    : null;
  const httpRequestEventToHandlerStartMs = typeof serverProbeTiming?.httpRequestEventToHandlerStartMs === "number"
    ? serverProbeTiming.httpRequestEventToHandlerStartMs
    : null;
  const socketIdleBeforeHttpRequestEventMs = typeof serverProbeTiming?.socketIdleBeforeHttpRequestEventMs === "number"
    ? serverProbeTiming.socketIdleBeforeHttpRequestEventMs
    : null;
  const reuseIdleBeforeDataMs = typeof serverProbeTiming?.reuseIdleBeforeDataMs === "number"
    ? serverProbeTiming.reuseIdleBeforeDataMs
    : null;
  const reuseDataToHttpRequestEventMs = typeof serverProbeTiming?.reuseDataToHttpRequestEventMs === "number"
    ? serverProbeTiming.reuseDataToHttpRequestEventMs
    : null;
  const socketRequestIndex = typeof serverProbeTiming?.socketRequestIndex === "number"
    ? serverProbeTiming.socketRequestIndex
    : null;
  const socketHadServedRequest = typeof serverProbeTiming?.socketHadServedRequest === "boolean"
    ? serverProbeTiming.socketHadServedRequest
    : null;
  const serverClientProbeStartToHandlerStartMs = typeof serverProbeTiming?.clientProbeStartToHandlerStartMs === "number"
    ? serverProbeTiming.clientProbeStartToHandlerStartMs
    : null;
  const clientProbeStartToSocketConnectedMs = typeof serverProbeTiming?.clientProbeStartToSocketConnectedMs === "number"
    ? serverProbeTiming.clientProbeStartToSocketConnectedMs
    : null;
  return {
    clientStartUnixMs,
    responseHeadersUnixMs,
    bodyParsedUnixMs,
    fetchHeaderMs,
    bodyParseMs,
    totalMs,
    serverHandlerStartUnixMs: handlerStartUnixMs,
    serverResponsePreparedUnixMs: responsePreparedUnixMs,
    clientToServerStartLagMs: handlerStartUnixMs !== null
      ? handlerStartUnixMs - clientStartUnixMs
      : null,
    clientToSocketConnectedLagMs: socketConnectedUnixMs !== null
      ? socketConnectedUnixMs - clientStartUnixMs
      : null,
    clientToHttpRequestEventLagMs: httpRequestEventUnixMs !== null
      ? httpRequestEventUnixMs - clientStartUnixMs
      : null,
    socketConnectedUnixMs,
    httpRequestEventUnixMs,
    socketAgeBeforeHandlerMs,
    socketIdleBeforeRequestMs,
    socketAcceptedToHttpRequestEventMs,
    httpRequestEventToHandlerStartMs,
    socketIdleBeforeHttpRequestEventMs,
    reuseIdleBeforeDataMs,
    reuseDataToHttpRequestEventMs,
    socketRequestIndex,
    socketHadServedRequest,
    serverClientProbeStartToHandlerStartMs,
    clientProbeStartToSocketConnectedMs,
    serverPreparedToClientHeadersMs: responsePreparedUnixMs !== null
      ? responseHeadersUnixMs - responsePreparedUnixMs
      : null,
    serverPreparedToClientBodyParsedMs: responsePreparedUnixMs !== null
      ? bodyParsedUnixMs - responsePreparedUnixMs
      : null,
  };
}

/**
 * Extract scheduling timing from /schedz response body.
 *
 * @param {object|null} body - Parsed JSON /schedz response
 * @returns {{ ok: boolean, status: number, totalAccepted: number|null, activeRequests: number|null, host: object|null, schedulingTiming: object|null, endpointTiming: object|null, endpointActive: object|null, requestRoutes: object|null, routeHandlerBodyTiming: object|null, terminalOutbox: object|null, workerHeartbeatPhases: object|null, workerRegisterPhases: object|null, perWorkerHeartbeatPhases: object|null, perWorkerRegisterPhases: object|null, connections: object|null, perRequest: object|null, flushing: object|null }|null}
 */
export function extractSchedzMeasurement(body, status) {
  if (!body || typeof body !== "object") return null;
  return {
    ok: status === 200,
    status,
    totalAccepted: typeof body.totalAccepted === "number" ? body.totalAccepted : null,
    activeRequests: typeof body.activeRequests === "number" ? body.activeRequests : null,
    host: body.host ?? null,
    schedulingTiming: body.schedulingTiming ?? null,
    endpointTiming: body.endpointTiming ?? null,
    endpointActive: body.endpointActive ?? null,
    requestRoutes: body.requestRoutes ?? null,
    routeHandlerBodyTiming: body.routeHandlerBodyTiming ?? null,
    terminalOutbox: body.terminalOutbox ?? null,
    workerHeartbeatPhases: body.workerHeartbeatPhases ?? null,
    workerRegisterPhases: body.workerRegisterPhases ?? null,
    perWorkerHeartbeatPhases: body.perWorkerHeartbeatPhases ?? null,
    perWorkerRegisterPhases: body.perWorkerRegisterPhases ?? null,
    connections: body.connections ?? null,
    perRequest: body.perRequest ?? null,
    flushing: body.flushing ?? null,
    container: body.container ?? null,
  };
}

function summarizeSchedzContainer(correlatedProbes = []) {
  const snapshots = correlatedProbes
    .map((probe) => probe.schedzContainer)
    .filter((c) => c && typeof c === "object");
  if (snapshots.length === 0) return null;
  const latest = snapshots[snapshots.length - 1];
  const cpu = latest.cgroup?.cpu ?? null;
  const psi = latest.psi ?? null;
  const cpuLimit = latest.cgroup?.cpuLimit ?? null;
  return {
    samples: snapshots.length,
    cgroupCpu: cpu,
    cpuLimit,
    psi,
  };
}

function summarizeSchedzConnections(correlatedProbes = []) {
  const snapshots = correlatedProbes
    .map((probe) => probe.schedzConnections)
    .filter((connections) => connections && typeof connections === "object");
  if (snapshots.length === 0) return null;
  const latest = snapshots[snapshots.length - 1];
  const httpServer = latest.httpServer && typeof latest.httpServer === "object"
    ? latest.httpServer
    : null;
  return {
    samples: snapshots.length,
    totalConnections: typeof latest.totalConnections === "number" ? latest.totalConnections : null,
    activeConnections: typeof latest.activeConnections === "number" ? latest.activeConnections : null,
    peakConnections: typeof latest.peakConnections === "number" ? latest.peakConnections : null,
    connectionDurationMs: latest.connectionDurationMs ?? null,
    httpServer,
  };
}

// ---------------------------------------------------------------------------
// Synthetic no-live samples
// ---------------------------------------------------------------------------

function sampleLivezBody(index, total) {
  const baseMs = 0.02 + (index % 7) * 0.01;
  const stallMs = (index === total - 1 && total >= 5) ? 4.2 : 0;
  const handlerMs = baseMs + stallMs;
  const handlerStartUnixMs = 1_700_000_000_000 + index * 1000;
  return {
    ok: true,
    service: "a2a-broker",
    brokerId: "test-broker",
    uptimeSec: 3600 + index * 10,
    eventLoop: { delayMs: 0.05 + (index % 20) * 0.01 },
    cpu: { percentSinceLastCheck: 2 + (index % 10), deltaIntervalMs: 500 },
    gc: index % 3 === 0 ? { totalMs: 1.0, count: 1, lastMs: 0.5, recentMax60sMs: 0.8 } : undefined,
    timing: {
      count: 200,
      minMs: 0.01,
      maxMs: 0.5,
      avgMs: 0.08,
      p50Ms: 0.02,
      p95Ms: 0.3,
      p99Ms: 0.45,
      p999Ms: 0.5,
    },
    activeRequests: 1 + (index % 3),
    requestDurationMs: handlerMs,
    diagMs: 0.02,
    probeTiming: {
      handlerStartUnixMs,
      responsePreparedUnixMs: handlerStartUnixMs + Math.ceil(handlerMs),
      responsePreparationDurationMs: handlerMs,
      socketConnectedUnixMs: handlerStartUnixMs - 2,
      socketAgeBeforeHandlerMs: 2,
      socketIdleBeforeRequestMs: index === 0 ? null : 500,
      socketRequestIndex: index + 1,
      socketHadServedRequest: index > 0,
      clientProbeStartUnixMs: handlerStartUnixMs - 3,
      clientProbeStartToHandlerStartMs: 3,
      clientProbeStartToSocketConnectedMs: 1,
      httpRequestEventUnixMs: handlerStartUnixMs,
      socketAcceptedToHttpRequestEventMs: 2,
      httpRequestEventToHandlerStartMs: 0,
      socketIdleBeforeHttpRequestEventMs: index === 0 ? null : 500,
      reuseIdleBeforeDataMs: index === 0 ? null : 450,
      reuseDataToHttpRequestEventMs: index === 0 ? null : 50,
    },
  };
}

function sampleSchedzBody(index, total) {
  // Simulate scheduling spikes: p50 stays below 1ms, p99 and max climb
  // Baseline: stay under 3000ms threshold. simulateStall will push over.
  const p50 = 0.3 + (index % 5) * 0.1;
  const p95 = 800 + (index * 80) % 600;
  const p99 = 1200 + (index * 30) % 400;
  const max = Math.max(p99 + 50, 2949);
  // Cap baseline to avoid false gates at 3000ms threshold
  const cappedMax = Math.min(max, 2995);
  const avg = p50 + (p95 - p50) * 0.3;

  return {
    ok: true,
    service: "a2a-broker",
    brokerId: "test-broker",
    totalAccepted: 15000 + index * 50,
    activeRequests: 1 + (index % 5),
    host: {
      loadavg1: 0.5 + (index % 10) * 0.2,
      loadavg5: 0.4 + (index % 10) * 0.1,
      loadavg15: 0.3 + (index % 10) * 0.05,
      cpuCount: 4,
      loadPerCpu: 0.2 + (index % 10) * 0.05,
      snapshotAtMs: Date.now(),
    },
    schedulingTiming: {
      count: 200,
      minMs: 0.01,
      maxMs: Math.round(cappedMax * 1000) / 1000,
      avgMs: Math.round(avg * 1000) / 1000,
      p50Ms: Math.round(p50 * 1000) / 1000,
      p95Ms: Math.round(p95 * 1000) / 1000,
      p99Ms: Math.round(p99 * 1000) / 1000,
      p999Ms: Math.round(Math.min(cappedMax + 500, 5000) * 1000) / 1000,
    },
    requestRoutes: {
      livez: {
        active: 0,
        timing: { count: 200, minMs: 0.01, maxMs: 0.5, avgMs: 0.08, p50Ms: 0.02, p95Ms: 0.3, p99Ms: 0.45, p999Ms: 0.5 },
        firstRequestLatencyMs: { count: 20, minMs: 0.1, maxMs: 2, avgMs: 0.4, p50Ms: 0.2, p95Ms: 1.2, p99Ms: 2, p999Ms: 2 },
        onNewConnection: 20,
        onReusedConnection: 180,
      },
      "workers.register": {
        active: index % 2,
        timing: { count: 20, minMs: 0.2, maxMs: 2800 + (index % 3) * 10, avgMs: 120, p50Ms: 0.6, p95Ms: 2600, p99Ms: 2800, p999Ms: 2800 },
        firstRequestLatencyMs: { count: 5, minMs: 0.2, maxMs: 2700 + (index % 3) * 10, avgMs: 600, p50Ms: 0.6, p95Ms: 2500, p99Ms: 2700, p999Ms: 2700 },
        onNewConnection: 5,
        onReusedConnection: 15,
      },
    },
    workerHeartbeatPhases: {
      readJson: { count: 20, minMs: 0.02, maxMs: 1.2, avgMs: 0.1, p50Ms: 0.04, p95Ms: 0.8, p99Ms: 1.2, p999Ms: 1.2 },
      authLookup: { count: 20, minMs: 0.01, maxMs: 2.1, avgMs: 0.2, p50Ms: 0.04, p95Ms: 1.2, p99Ms: 2.1, p999Ms: 2.1 },
      authAssert: { count: 20, minMs: 0.01, maxMs: 0.2, avgMs: 0.03, p50Ms: 0.02, p95Ms: 0.1, p99Ms: 0.2, p999Ms: 0.2 },
      brokerHeartbeat: { count: 20, minMs: 0.2, maxMs: 2800 + (index % 3) * 10, avgMs: 120, p50Ms: 0.6, p95Ms: 2600, p99Ms: 2800, p999Ms: 2800 },
      toWorkerView: { count: 20, minMs: 0.01, maxMs: 0.8, avgMs: 0.08, p50Ms: 0.04, p95Ms: 0.6, p99Ms: 0.8, p999Ms: 0.8 },
    },
    workerRegisterPhases: {
      readJson: { count: 5, minMs: 0.02, maxMs: 1.2, avgMs: 0.1, p50Ms: 0.04, p95Ms: 0.8, p99Ms: 1.2, p999Ms: 1.2 },
      authAssert: { count: 5, minMs: 0.01, maxMs: 0.2, avgMs: 0.03, p50Ms: 0.02, p95Ms: 0.1, p99Ms: 0.2, p999Ms: 0.2 },
      brokerRegister: { count: 5, minMs: 0.2, maxMs: 2200 + (index % 3) * 10, avgMs: 90, p50Ms: 0.6, p95Ms: 2100, p99Ms: 2200, p999Ms: 2200 },
      toWorkerView: { count: 5, minMs: 0.01, maxMs: 0.8, avgMs: 0.08, p50Ms: 0.04, p95Ms: 0.6, p99Ms: 0.8, p999Ms: 0.8 },
    },
    perWorkerHeartbeatPhases: {
      "worker-slow": {
        readJson: { count: 5, minMs: 0.02, maxMs: 1.2, avgMs: 0.1, p50Ms: 0.04, p95Ms: 0.8, p99Ms: 1.2, p999Ms: 1.2 },
        authLookup: { count: 5, minMs: 0.01, maxMs: 2.1, avgMs: 0.2, p50Ms: 0.04, p95Ms: 1.2, p99Ms: 2.1, p999Ms: 2.1 },
        authAssert: { count: 5, minMs: 0.01, maxMs: 0.2, avgMs: 0.03, p50Ms: 0.02, p95Ms: 0.1, p99Ms: 0.2, p999Ms: 0.2 },
        brokerHeartbeat: { count: 5, minMs: 0.2, maxMs: 2800 + (index % 3) * 10, avgMs: 120, p50Ms: 0.6, p95Ms: 2600, p99Ms: 2800, p999Ms: 2800 },
        toWorkerView: { count: 5, minMs: 0.01, maxMs: 0.8, avgMs: 0.08, p50Ms: 0.04, p95Ms: 0.6, p99Ms: 0.8, p999Ms: 0.8 },
      },
    },
    perWorkerRegisterPhases: {
      "worker-slow": {
        readJson: null,
        authAssert: { count: 5, minMs: 0.01, maxMs: 0.2, avgMs: 0.03, p50Ms: 0.02, p95Ms: 0.1, p99Ms: 0.2, p999Ms: 0.2 },
        brokerRegister: { count: 5, minMs: 0.2, maxMs: 2200 + (index % 3) * 10, avgMs: 90, p50Ms: 0.6, p95Ms: 2100, p99Ms: 2200, p999Ms: 2200 },
        toWorkerView: { count: 5, minMs: 0.01, maxMs: 0.8, avgMs: 0.08, p50Ms: 0.04, p95Ms: 0.6, p99Ms: 0.8, p999Ms: 0.8 },
      },
    },
    terminalOutbox: {
      retainedCount: 42,
      sampledCount: 42,
      sampleLimit: 200,
      pendingAckCount: 7,
      oldestPendingAckAgeMs: 12_000 + index,
      topWorkers: [{ key: "worker-slow", count: 8 }],
      topStatuses: [{ key: "succeeded", count: 24 }],
      topReceiptStatuses: [{ key: "accepted", count: 7 }],
      topBrokersOfRecord: [{ key: "brokeralpha", count: 42 }],
      topPendingAckWorkers: [{ key: "worker-slow", count: 7 }],
      topPendingAckStatuses: [{ key: "succeeded", count: 7 }],
      topPendingAckReceiptStatuses: [{ key: "accepted", count: 7 }],
      topPendingAckBrokersOfRecord: [{ key: "brokeralpha", count: 7 }],
      oldestPendingAckWorker: "worker-slow",
      oldestPendingAckStatus: "succeeded",
      oldestPendingAckReceiptStatus: "accepted",
      oldestPendingAckBrokerOfRecord: "brokeralpha",
    },
    container: {
      cgroup: {
        cpu: {
          usageUsec: 4_200_000_000 + index * 100_000,
          userUsec: 3_100_000_000 + index * 80_000,
          systemUsec: 1_100_000_000 + index * 20_000,
          nrPeriods: 420_000 + index * 10,
          nrThrottled: index === total - 1 ? 15 : 0,
          throttledUsec: index === total - 1 ? 3_200_000 : 0,
          snapshotAtMs: Date.now(),
        },
        cpuLimit: {
          quotaUsec: 400_000,
          periodUsec: 100_000,
          cpus: 4.0,
        },
        cpuDelta: index > 0 ? {
          deltaUsageUsec: 4_200_000 + index * 1000,
          deltaUserUsec: 3_100_000 + index * 800,
          deltaSystemUsec: 1_100_000 + index * 200,
          deltaNrPeriods: 100 + index,
          deltaNrThrottled: index === total - 1 ? 1 : 0,
          deltaThrottledUsec: index === total - 1 ? 210_000 : 0,
          wallMs: 1000,
        } : null,
      },
      psi: {
        cpu: {
          some: { avg10: 0.14, avg60: 0.08, avg300: 0.04, total: 490_000_000 + index * 1000 },
          full: { avg10: 0.02, avg60: 0.01, avg300: 0.005, total: 80_000_000 + index * 500 },
        },
        memory: {
          some: { avg10: 0.0, avg60: 0.0, avg300: 0.0, total: 0 },
          full: { avg10: 0.0, avg60: 0.0, avg300: 0.0, total: 0 },
        },
        io: {
          some: { avg10: 0.0, avg60: 0.0, avg300: 0.0, total: 0 },
          full: { avg10: 0.0, avg60: 0.0, avg300: 0.0, total: 0 },
        },
        snapshotAtMs: Date.now(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Probe type helpers
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ComprehensiveDiagnosticsReport
 * @property {string} kind
 * @property {string} issue
 * @property {string} laneIssue
 * @property {string} runId
 * @property {string} mode - "no-live" | "live"
 * @property {string} baseUrl
 * @property {number} probeCount
 * @property {number} livezFailureCount
 * @property {number} schedzFailureCount
 * @property {number} livezMaxMs - Max /livez wall time
 * @property {number} livezP50Ms
 * @property {number} livezP95Ms
 * @property {number} livezP99Ms
 * @property {number} schedzMaxMs - Max /schedz wall time
 * @property {number} schedzP50Ms
 * @property {number} schedzP95Ms
 * @property {number} schedzP99Ms
 * @property {number} schedzSchedulingMaxMs - In-broker scheduling max ms
 * @property {number} schedzSchedulingP95Ms
 * @property {number} schedzSchedulingP99Ms
 * @property {number} schedzSchedulingP50Ms
 * @property {number} livezWallSamplesAbove1s
 * @property {number} livezWallSamplesAbove3s
 * @property {object|null} hostMetricsSummary
 * @property {object|null} livezTimingSummary
 * @property {object|null} schedzSchedulingSummary
 * @property {Array} requestRouteSummary
 * @property {Array} workerHeartbeatPhaseSummary
 * @property {Array} correlatedProbes
 * @property {object[]} checks
 * @property {boolean} ok
 */

// ---------------------------------------------------------------------------
// No-live synthetic report
// ---------------------------------------------------------------------------

/**
 * Produce a no-live synthetic report for tests / --dry-run.
 *
 * @param {object} [options]
 * @param {number} [options.count]
 * @param {boolean} [options.simulateStall]
 * @param {boolean} [options.simulateResidualStall]
 * @param {boolean} [options.collectHostMetrics]
 * @returns {ComprehensiveDiagnosticsReport}
 */
export function runNoLiveDiagnostics(options = {}) {
  const count = normalizeProbeCount(options.count ?? DEFAULT_COUNT);
  const simulateStall = options.simulateStall === true;
  const simulateResidualStall = options.simulateResidualStall === true;
  const collectHostMetrics = options.collectHostMetrics !== false;
  const livezConnectionMode = parseLivezConnectionMode(options.livezConnectionMode ?? DEFAULT_LIVEZ_CONNECTION_MODE);

  const livezDurations = [];
  const schedzDurations = [];
  const schedulingMaxList = [];
  const schedulingP95List = [];
  const schedulingP99List = [];
  const schedulingP50List = [];
  const correlatedProbes = [];

  for (let i = 0; i < count; i++) {
    const livezWallMs = 8 + (i % 13);
    const schedzWallMs = 5 + (i % 7);
    const schedzBody = sampleSchedzBody(i, count);

    // Apply simulated stall
    const lWall = (simulateStall && i === count - 1)
      ? 4200
      : ((simulateResidualStall && i === count - 1) ? 1200 : livezWallMs);
    const sWall = (simulateStall && i === count - 2) ? 3500 : schedzWallMs;

    livezDurations.push(lWall);
    schedzDurations.push(sWall);
    if (schedzBody.schedulingTiming) {
      schedulingMaxList.push(schedzBody.schedulingTiming.maxMs);
      schedulingP95List.push(schedzBody.schedulingTiming.p95Ms);
      schedulingP99List.push(schedzBody.schedulingTiming.p99Ms);
      schedulingP50List.push(schedzBody.schedulingTiming.p50Ms);
    }

    const livezBody = sampleLivezBody(i, count);
    const clientStartUnixMs = livezBody.probeTiming.handlerStartUnixMs - 1;
    const responseHeadersUnixMs = livezBody.probeTiming.responsePreparedUnixMs + Math.max(1, lWall - Math.ceil(livezBody.requestDurationMs));
    const bodyParsedUnixMs = responseHeadersUnixMs + 1;
    correlatedProbes.push({
      index: i,
      livezWallMs: lWall,
      schedzWallMs: sWall,
      livezInternal: livezBody,
      livezClientTiming: buildLivezClientTiming({
        clientStartUnixMs,
        responseHeadersUnixMs,
        bodyParsedUnixMs,
        fetchHeaderMs: Math.max(0, lWall - 1),
        bodyParseMs: 1,
        totalMs: lWall,
        serverProbeTiming: livezBody.probeTiming,
      }),
      livezHandling: {
        requestDurationMs: livezBody.requestDurationMs ?? null,
        diagMs: livezBody.diagMs ?? null,
        eventLoopDelayMs: livezBody.eventLoop?.delayMs ?? null,
        cpuPercent: livezBody.cpu?.percentSinceLastCheck ?? null,
      },
      schedzTimingSnapshot: schedzBody.schedulingTiming ?? null,
      schedzRequestRoutes: schedzBody.requestRoutes ?? null,
      schedzRouteHandlerBodyTiming: schedzBody.routeHandlerBodyTiming ?? null,
      terminalOutbox: schedzBody.terminalOutbox ?? null,
      workerHeartbeatPhases: schedzBody.workerHeartbeatPhases ?? null,
      workerRegisterPhases: schedzBody.workerRegisterPhases ?? null,
      perWorkerHeartbeatPhases: schedzBody.perWorkerHeartbeatPhases ?? null,
      perWorkerRegisterPhases: schedzBody.perWorkerRegisterPhases ?? null,
      schedzContainer: schedzBody.container ?? null,
      host: collectHostMetrics ? collectHostDiagnostics() : null,
    });
  }

  // Summaries
  const livezSorted = [...livezDurations].sort((a, b) => a - b);
  const schedzSorted = [...schedzDurations].sort((a, b) => a - b);
  const schedSchedMaxSorted = [...schedulingMaxList].sort((a, b) => a - b);
  const schedSchedP50Sorted = [...schedulingP50List].sort((a, b) => a - b);
  const schedSchedP95Sorted = [...schedulingP95List].sort((a, b) => a - b);
  const schedSchedP99Sorted = [...schedulingP99List].sort((a, b) => a - b);

  const livezMax = livezSorted.length > 0 ? livezSorted[livezSorted.length - 1] : 0;
  const schedzMax = schedzSorted.length > 0 ? schedzSorted[schedzSorted.length - 1] : 0;

  const livezFailures = livezDurations.filter((d) => d > 3000).length;
  const schedzFailures = schedzDurations.filter((d) => d > 3000).length;

  const livezSamplesAbove1s = livezDurations.filter((d) => d > 1000).length;
  const livezSamplesAbove3s = livezDurations.filter((d) => d > 3000).length;

  const hostMetricsSummary = collectHostMetrics ? collectHostDiagnostics() : null;

  const livezTimingSummary = {
    handlerRequestDurationMs: {
      min: 0.02,
      max: (simulateStall ? 4.2 : 0.1),
      avg: 0.03 + (simulateStall ? (4.2 - 0.02) / count : 0),
      samples: count,
    },
    diagMs: { min: 0.02, max: 0.02, avg: 0.02, samples: count },
    eventLoopDelayMs: {
      min: 0.05,
      max: 0.05 + ((count - 1) % 20) * 0.01,
      samples: count,
    },
  };

  const schedzSchedulingSummary = {
    maxMs: schedulingMaxList.length > 0 ? schedSchedMaxSorted[schedSchedMaxSorted.length - 1] : 0,
    p99Ms: schedulingP99List.length > 0 ? percentile(schedSchedP99Sorted, 99) : 0,
    p95Ms: schedulingP95List.length > 0 ? percentile(schedSchedP95Sorted, 95) : 0,
    p50Ms: schedulingP50List.length > 0 ? percentile(schedSchedP50Sorted, 50) : 0,
    sampleCount: schedulingMaxList.length,
  };
  const requestRouteSummary = summarizeRequestRoutes(correlatedProbes);
  const workerHeartbeatPhaseSummary = summarizeWorkerHeartbeatPhases(correlatedProbes);
  const livezSpikeCorrelation = summarizeLivezSpikeCorrelation(correlatedProbes);
  const schedzConnectionSummary = summarizeSchedzConnections(correlatedProbes);
  const schedzContainerSummary = summarizeSchedzContainer(correlatedProbes);

  const checks = [
    ok("probe count", `${count} probes sent`),
    livezMax > 3000
      ? fail("livez max latency gate", `max ${livezMax}ms exceeds 3000ms threshold`, { livezMax, thresholdMs: 3000 })
      : ok("livez max latency gate", `${livezMax}ms within threshold`),
    schedzMax > 3000
      ? fail("schedz response latency gate", `max /schedz response time ${schedzMax}ms exceeds 3000ms`, { schedzMax, thresholdMs: 3000 })
      : ok("schedz response latency gate", `/schedz response time ${schedzMax}ms within threshold`),
    schedzFailures > 0
      ? fail("schedz success gate", `${schedzFailures}/${count} /schedz probe(s) failed`, { schedzFailures, totalProbes: count })
      : ok("schedz success gate", `${schedzFailures}/${count} /schedz probe failures`),
    schedzSchedulingSummary.maxMs > 3000
      ? fail("in-broker scheduling max gate", `in-broker scheduling max ${schedzSchedulingSummary.maxMs}ms exceeds 3000ms`, { schedulingMaxMs: schedzSchedulingSummary.maxMs, thresholdMs: 3000 })
      : ok("in-broker scheduling max gate", `scheduling max ${schedzSchedulingSummary.maxMs}ms within threshold`),
    livezSamplesAbove3s > 0
      ? fail("livez samples above 3s gate", `${livezSamplesAbove3s} sample(s) exceeded 3s`, { livezSamplesAbove3s })
      : ok("livez samples above 3s gate", `${livezSamplesAbove3s} sample(s) above 3s`),
    livezFailures / count >= 0.1
      ? fail("livez failure rate gate", `${livezFailures}/${count} (${Math.round((livezFailures / count) * 100)}%) livez failures >= 10%`, { livezFailures, totalProbes: count })
      : ok("livez failure rate gate", `${livezFailures}/${count} livez failures OK`),
    ok("safety gate", "read-only loopback measurement; no deploy, Gateway restart, Telegram send, DB mutation, or terminal-outbox ACK"),
  ];

  const report = {
    kind: "a2a-broker.comprehensive-diagnostics.v1",
    issue: ISSUE,
    laneIssue: LANE_ISSUE,
    runId: RUN_ID,
    mode: simulateStall
      ? "no-live-simulated-stall"
      : (simulateResidualStall ? "no-live-simulated-residual-stall" : "no-live"),
    baseUrl: "http://no-live.synthetic",
    livezConnectionMode,
    probeCount: count,
    livezFailureCount: livezFailures,
    schedzFailureCount: schedzFailures,
    livezMaxMs: livezMax,
    livezP50Ms: percentile(livezSorted, 50),
    livezP95Ms: percentile(livezSorted, 95),
    livezP99Ms: percentile(livezSorted, 99),
    schedzMaxMs: schedzMax,
    schedzP50Ms: percentile(schedzSorted, 50),
    schedzP95Ms: percentile(schedzSorted, 95),
    schedzP99Ms: percentile(schedzSorted, 99),
    schedzSchedulingMaxMs: schedzSchedulingSummary.maxMs,
    schedzSchedulingP95Ms: schedzSchedulingSummary.p95Ms,
    schedzSchedulingP99Ms: schedzSchedulingSummary.p99Ms,
    schedzSchedulingP50Ms: schedzSchedulingSummary.p50Ms,
    livezWallSamplesAbove1s: livezSamplesAbove1s,
    livezWallSamplesAbove3s: livezSamplesAbove3s,
    hostMetricsSummary,
    livezTimingSummary,
    schedzSchedulingSummary,
    schedzConnectionSummary,
    schedzContainerSummary,
    requestRouteSummary,
    workerHeartbeatPhaseSummary,
    livezSpikeCorrelation,
    correlatedProbes: correlatedProbes.slice(0, 40),
    checks,
    ok: checks.every((c) => c.ok),
  };
  report.livezAttribution = classifyLivezAttribution(report);
  return report;
}

// ---------------------------------------------------------------------------
// Live measurement
// ---------------------------------------------------------------------------

/**
 * Run bounded /livez and /schedz probes against a live broker, collecting
 * host-level metrics alongside each probe.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {number} [options.count]
 * @param {number} [options.intervalMs]
 * @param {number} [options.timeoutMs]
 * @param {typeof globalThis.fetch} [options.fetchImpl]
 * @param {boolean} [options.collectHostMetrics]
 * @param {string} [options.edgeSecret]
 * @returns {Promise<ComprehensiveDiagnosticsReport>}
 */
export async function runLiveDiagnostics(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime");
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const count = normalizeProbeCount(options.count ?? DEFAULT_COUNT);
  const intervalMs = clamp(options.intervalMs ?? DEFAULT_INTERVAL_MS, 0, 10_000);
  const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100, 30_000);
  const collectHostMetrics = options.collectHostMetrics !== false;
  const edgeSecret = optionalString(options.edgeSecret);
  assertSafeEdgeSecretDestination(baseUrl, edgeSecret, options.allowNonLoopbackEdgeSecret === true);
  const livezConnectionMode = parseLivezConnectionMode(options.livezConnectionMode ?? DEFAULT_LIVEZ_CONNECTION_MODE);

  /** @type {number[]} */
  const livezDurations = [];
  /** @type {number[]} */
  const schedzDurations = [];
  /** @type {number[]} */
  const schedulingMaxMs = [];
  /** @type {number[]} */
  const schedulingP95Ms = [];
  /** @type {number[]} */
  const schedulingP99Ms = [];
  /** @type {number[]} */
  const schedulingP50Ms = [];
  /** @type {object[]} */
  const correlatedProbes = [];
  /** @type {boolean[]} */
  const livezErrors = [];
  /** @type {boolean[]} */
  const schedzErrors = [];

  // Host baseline
  let hostBaseline = null;
  if (collectHostMetrics) {
    hostBaseline = collectHostDiagnostics();
  }

  const requesterId = normalizeRequesterId(options.requesterId);
  const commonHeaders = {
    accept: "application/json",
    "x-a2a-requester-id": requesterId,
    "x-a2a-requester-role": "operator",
  };
  const authHeaders = edgeSecret
    ? { ...commonHeaders, "x-a2a-edge-secret": edgeSecret }
    : commonHeaders;

  for (let i = 0; i < count; i++) {
    const timestamp = new Date().toISOString();

    // --- Probe /livez ---
    const livezClientStartUnixMs = Date.now();
    const livezT0 = performance.now();
    let livezResult = null;
    let livezClientTiming = null;
    try {
      const abort = AbortSignal.timeout(timeoutMs);
      const url = new URL("/livez", ensureTrailingSlash(baseUrl));
      const livezHeaders = {
        ...commonHeaders,
        "x-a2a-probe-start-unix-ms": String(livezClientStartUnixMs),
      };
      if (livezConnectionMode === "fresh") {
        livezHeaders.connection = "close";
      } else if (livezConnectionMode === "keep-alive") {
        livezHeaders.connection = "keep-alive";
      }
      const response = await fetchImpl(url, {
        method: "GET",
        headers: livezHeaders,
        signal: abort,
      });
      const livezFetchHeaderMs = roundProbeMs(performance.now() - livezT0);
      const livezResponseHeadersUnixMs = Date.now();

      let livezBody = null;
      if (response.ok) {
        const parseT0 = performance.now();
        try { livezBody = await response.clone().json(); } catch { /* ignore */ }
        const livezBodyParsedUnixMs = Date.now();
        const livezBodyParseMs = roundProbeMs(performance.now() - parseT0);
        const livezWallMs = Math.round(performance.now() - livezT0);
        const livezOk = response.ok && livezBody?.ok === true;
        livezResult = extractLivezMeasurement(livezBody, livezWallMs, response.status);
        livezClientTiming = buildLivezClientTiming({
          clientStartUnixMs: livezClientStartUnixMs,
          responseHeadersUnixMs: livezResponseHeadersUnixMs,
          bodyParsedUnixMs: livezBodyParsedUnixMs,
          fetchHeaderMs: livezFetchHeaderMs,
          bodyParseMs: livezBodyParseMs,
          totalMs: livezWallMs,
          serverProbeTiming: livezResult?.probeTiming ?? null,
        });
        livezDurations.push(livezWallMs);
        livezErrors.push(!livezOk);
      } else {
        const livezBodyParsedUnixMs = Date.now();
        const livezWallMs = Math.round(performance.now() - livezT0);
        livezResult = extractLivezMeasurement(livezBody, livezWallMs, response.status);
        livezClientTiming = buildLivezClientTiming({
          clientStartUnixMs: livezClientStartUnixMs,
          responseHeadersUnixMs: livezResponseHeadersUnixMs,
          bodyParsedUnixMs: livezBodyParsedUnixMs,
          fetchHeaderMs: livezFetchHeaderMs,
          bodyParseMs: 0,
          totalMs: livezWallMs,
          serverProbeTiming: null,
        });
        livezDurations.push(livezWallMs);
        livezErrors.push(true);
      }
    } catch (error) {
      const livezWallMs = Math.round(performance.now() - livezT0);
      const livezErrorUnixMs = Date.now();
      livezResult = {
        ok: false,
        status: 0,
        wallTimeMs: livezWallMs,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      };
      livezClientTiming = {
        clientStartUnixMs: livezClientStartUnixMs,
        errorUnixMs: livezErrorUnixMs,
        totalMs: livezWallMs,
      };
      livezDurations.push(livezWallMs);
      livezErrors.push(true);
    }

    // --- Probe /schedz ---
    const schedzT0 = performance.now();
    let schedzResult = null;
    try {
      const abort = AbortSignal.timeout(timeoutMs);
      const url = new URL("/schedz", ensureTrailingSlash(baseUrl));
      const response = await fetchImpl(url, {
        method: "GET",
        headers: authHeaders,
        signal: abort,
      });
      const schedzWallMs = Math.round(performance.now() - schedzT0);

      let schedzBody = null;
      if (response.ok) {
        try { schedzBody = await response.clone().json(); } catch { /* ignore */ }
      }
      const schedzOk = response.ok && schedzBody?.ok === true;
      schedzResult = extractSchedzMeasurement(schedzBody, response.status);
      schedzDurations.push(schedzWallMs);
      schedzErrors.push(!schedzOk);

      // Extract in-broker scheduling timing
      if (schedzBody?.schedulingTiming?.maxMs !== undefined) {
        schedulingMaxMs.push(schedzBody.schedulingTiming.maxMs);
        schedulingP95Ms.push(schedzBody.schedulingTiming.p95Ms);
        schedulingP99Ms.push(schedzBody.schedulingTiming.p99Ms);
        schedulingP50Ms.push(schedzBody.schedulingTiming.p50Ms);
      }
    } catch (error) {
      const schedzWallMs = Math.round(performance.now() - schedzT0);
      schedzResult = {
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      };
      schedzDurations.push(schedzWallMs);
      schedzErrors.push(true);
    }

    // Collect host diagnostics for this probe cycle
    const hostAtProbe = collectHostMetrics ? collectHostDiagnostics() : null;
    correlatedProbes.push({
      index: i,
      timestamp,
      livezWallMs: livezResult?.wallTimeMs ?? livezDurations[livezDurations.length - 1],
      schedzWallMs: schedzResult ? (schedzResult.wallTimeMs ?? schedzDurations[schedzDurations.length - 1]) : schedzDurations[schedzDurations.length - 1],
      livezClientTiming,
      livezHandling: livezResult?.ok ? {
        requestDurationMs: livezResult.requestDurationMs,
        diagMs: livezResult.diagMs,
        eventLoopDelayMs: livezResult.eventLoop?.delayMs ?? null,
        cpuPercent: livezResult.cpu?.percentSinceLastCheck ?? null,
      } : null,
      schedzTimingSnapshot: schedzResult?.schedulingTiming ?? null,
      schedzRequestRoutes: schedzResult?.requestRoutes ?? null,
      schedzRouteHandlerBodyTiming: schedzResult?.routeHandlerBodyTiming ?? null,
      terminalOutbox: schedzResult?.terminalOutbox ?? null,
      workerHeartbeatPhases: schedzResult?.workerHeartbeatPhases ?? null,
      workerRegisterPhases: schedzResult?.workerRegisterPhases ?? null,
      perWorkerHeartbeatPhases: schedzResult?.perWorkerHeartbeatPhases ?? null,
      perWorkerRegisterPhases: schedzResult?.perWorkerRegisterPhases ?? null,
      schedzConnections: schedzResult?.connections ?? null,
      schedzContainer: schedzResult?.container ?? null,
      host: hostAtProbe,
    });

    // Pace between probe cycles (not after last)
    if (i < count - 1 && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  // One-shot docker stats at end
  let dockerStats = null;
  if (collectHostMetrics) {
    dockerStats = await readDockerContainerStats();
  }

  return buildComprehensiveReport(livezDurations, schedzDurations, {
    schedulingMaxMs,
    schedulingP95Ms,
    schedulingP99Ms,
    schedulingP50Ms,
    baseUrl,
    requesterId,
    count,
    mode: "live",
    livezConnectionMode,
    correlatedProbes,
    dockerStats,
    hostBaseline,
    livezErrors,
    schedzErrors,
  });
}

export async function runStandaloneLivezOnlyGate(options = {}) {
  if (options.noLive === true) {
    const synthetic = runNoLiveDiagnostics({
      ...options,
      livezConnectionMode: DEFAULT_LIVEZ_CONNECTION_MODE,
    });
    return {
      ...summarizeConnectionModeReport({
        ...synthetic,
        livezConnectionMode: "livez-only",
      }),
      mode: synthetic.mode,
    };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime");
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const count = normalizeProbeCount(options.count ?? DEFAULT_COUNT);
  const intervalMs = clamp(options.intervalMs ?? DEFAULT_INTERVAL_MS, 0, 10_000);
  const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100, 30_000);
  const collectHostMetrics = options.collectHostMetrics !== false;
  const requesterId = `${normalizeRequesterId(options.requesterId)}:livez-only`;
  const commonHeaders = {
    accept: "application/json",
    "x-a2a-requester-id": requesterId,
    "x-a2a-requester-role": "operator",
  };

  const livezDurations = [];
  const livezErrors = [];
  const correlatedProbes = [];
  const hostBaseline = collectHostMetrics ? collectHostDiagnostics() : null;

  for (let i = 0; i < count; i++) {
    const timestamp = new Date().toISOString();
    const livezClientStartUnixMs = Date.now();
    const livezT0 = performance.now();
    let livezResult = null;
    let livezClientTiming = null;
    try {
      const abort = AbortSignal.timeout(timeoutMs);
      const url = new URL("/livez", ensureTrailingSlash(baseUrl));
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          ...commonHeaders,
          "x-a2a-probe-start-unix-ms": String(livezClientStartUnixMs),
        },
        signal: abort,
      });
      const livezFetchHeaderMs = roundProbeMs(performance.now() - livezT0);
      const livezResponseHeadersUnixMs = Date.now();
      let livezBody = null;
      if (response.ok) {
        const parseT0 = performance.now();
        try { livezBody = await response.clone().json(); } catch { /* ignore */ }
        const livezBodyParsedUnixMs = Date.now();
        const livezBodyParseMs = roundProbeMs(performance.now() - parseT0);
        const livezWallMs = Math.round(performance.now() - livezT0);
        const livezOk = response.ok && livezBody?.ok === true;
        livezResult = extractLivezMeasurement(livezBody, livezWallMs, response.status);
        livezClientTiming = buildLivezClientTiming({
          clientStartUnixMs: livezClientStartUnixMs,
          responseHeadersUnixMs: livezResponseHeadersUnixMs,
          bodyParsedUnixMs: livezBodyParsedUnixMs,
          fetchHeaderMs: livezFetchHeaderMs,
          bodyParseMs: livezBodyParseMs,
          totalMs: livezWallMs,
          serverProbeTiming: livezResult?.probeTiming ?? null,
        });
        livezDurations.push(livezWallMs);
        livezErrors.push(!livezOk);
      } else {
        const livezBodyParsedUnixMs = Date.now();
        const livezWallMs = Math.round(performance.now() - livezT0);
        livezResult = extractLivezMeasurement(livezBody, livezWallMs, response.status);
        livezClientTiming = buildLivezClientTiming({
          clientStartUnixMs: livezClientStartUnixMs,
          responseHeadersUnixMs: livezResponseHeadersUnixMs,
          bodyParsedUnixMs: livezBodyParsedUnixMs,
          fetchHeaderMs: livezFetchHeaderMs,
          bodyParseMs: 0,
          totalMs: livezWallMs,
          serverProbeTiming: null,
        });
        livezDurations.push(livezWallMs);
        livezErrors.push(true);
      }
    } catch (error) {
      const livezWallMs = Math.round(performance.now() - livezT0);
      livezResult = {
        ok: false,
        status: 0,
        wallTimeMs: livezWallMs,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      };
      livezClientTiming = {
        clientStartUnixMs: livezClientStartUnixMs,
        errorUnixMs: Date.now(),
        totalMs: livezWallMs,
      };
      livezDurations.push(livezWallMs);
      livezErrors.push(true);
    }

    const hostAtProbe = collectHostMetrics ? collectHostDiagnostics() : null;
    correlatedProbes.push({
      index: i,
      timestamp,
      livezWallMs: livezResult?.wallTimeMs ?? livezDurations[livezDurations.length - 1],
      schedzWallMs: null,
      livezClientTiming,
      livezHandling: livezResult?.ok ? {
        requestDurationMs: livezResult.requestDurationMs,
        diagMs: livezResult.diagMs,
        eventLoopDelayMs: livezResult.eventLoop?.delayMs ?? null,
        cpuPercent: livezResult.cpu?.percentSinceLastCheck ?? null,
      } : null,
      host: hostAtProbe,
    });

    if (i < count - 1 && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const dockerStats = collectHostMetrics ? await readDockerContainerStats() : null;
  const report = buildComprehensiveReport(livezDurations, [], {
    baseUrl,
    requesterId,
    count,
    mode: "livez-only",
    livezConnectionMode: "livez-only",
    correlatedProbes,
    dockerStats,
    hostBaseline,
    livezErrors,
    schedzErrors: [],
  });
  return summarizeConnectionModeReport(report);
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

function buildComprehensiveReport(livezDurations, schedzDurations, meta) {
  const {
    schedulingMaxMs = [],
    schedulingP95Ms = [],
    schedulingP99Ms = [],
    schedulingP50Ms = [],
    baseUrl,
    requesterId = REQUESTER_ID,
    count,
    mode,
    livezConnectionMode = DEFAULT_LIVEZ_CONNECTION_MODE,
    correlatedProbes = [],
    dockerStats = null,
    hostBaseline = null,
    livezErrors = [],
    schedzErrors = [],
  } = meta;

  const livezSorted = [...livezDurations].sort((a, b) => a - b);
  const schedzSorted = [...schedzDurations].sort((a, b) => a - b);
  const schedSchedMaxSorted = [...schedulingMaxMs].sort((a, b) => a - b);
  const schedSchedP50Sorted = [...schedulingP50Ms].sort((a, b) => a - b);
  const schedSchedP95Sorted = [...schedulingP95Ms].sort((a, b) => a - b);
  const schedSchedP99Sorted = [...schedulingP99Ms].sort((a, b) => a - b);

  const livezMax = livezSorted.length > 0 ? livezSorted[livezSorted.length - 1] : 0;
  const schedzMax = schedzSorted.length > 0 ? schedzSorted[schedzSorted.length - 1] : 0;

  const livezWallSamplesAbove1s = livezDurations.filter((d) => d > 1000).length;
  const livezWallSamplesAbove3s = livezDurations.filter((d) => d > 3000).length;

  // /livez internal handler timing summary
  const requestDurations = correlatedProbes
    .map((cp) => cp.livezHandling?.requestDurationMs)
    .filter((d) => d !== null && d !== undefined);
  const diagMs = correlatedProbes
    .map((cp) => cp.livezHandling?.diagMs)
    .filter((d) => d !== null && d !== undefined);
  const eventLoopDelays = correlatedProbes
    .map((cp) => cp.livezHandling?.eventLoopDelayMs)
    .filter((d) => d !== null && d !== undefined);
  const cpuPcts = correlatedProbes
    .map((cp) => cp.livezHandling?.cpuPercent)
    .filter((d) => d !== null && d !== undefined);
  const livezFetchHeaderMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.fetchHeaderMs)
    .filter((d) => d !== null && d !== undefined);
  const livezBodyParseMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.bodyParseMs)
    .filter((d) => d !== null && d !== undefined);
  const clientToServerStartLagMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.clientToServerStartLagMs)
    .filter((d) => d !== null && d !== undefined);
  const clientToSocketConnectedLagMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.clientToSocketConnectedLagMs)
    .filter((d) => d !== null && d !== undefined);
  const clientToHttpRequestEventLagMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.clientToHttpRequestEventLagMs)
    .filter((d) => d !== null && d !== undefined);
  const socketAgeBeforeHandlerMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.socketAgeBeforeHandlerMs)
    .filter((d) => d !== null && d !== undefined);
  const socketIdleBeforeRequestMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.socketIdleBeforeRequestMs)
    .filter((d) => d !== null && d !== undefined);
  const socketAcceptedToHttpRequestEventMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.socketAcceptedToHttpRequestEventMs)
    .filter((d) => d !== null && d !== undefined);
  const httpRequestEventToHandlerStartMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.httpRequestEventToHandlerStartMs)
    .filter((d) => d !== null && d !== undefined);
  const socketIdleBeforeHttpRequestEventMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.socketIdleBeforeHttpRequestEventMs)
    .filter((d) => d !== null && d !== undefined);
  const reuseIdleBeforeDataMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.reuseIdleBeforeDataMs)
    .filter((d) => d !== null && d !== undefined);
  const reuseDataToHttpRequestEventMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.reuseDataToHttpRequestEventMs)
    .filter((d) => d !== null && d !== undefined);
  const serverClientProbeStartToHandlerStartMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.serverClientProbeStartToHandlerStartMs)
    .filter((d) => d !== null && d !== undefined);
  const clientProbeStartToSocketConnectedMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.clientProbeStartToSocketConnectedMs)
    .filter((d) => d !== null && d !== undefined);
  const serverPreparedToClientHeadersMs = correlatedProbes
    .map((cp) => cp.livezClientTiming?.serverPreparedToClientHeadersMs)
    .filter((d) => d !== null && d !== undefined);

  const livezTimingSummary = {
    handlerRequestDurationMs: requestDurations.length > 0
      ? {
          min: Math.round(Math.min(...requestDurations) * 1000) / 1000,
          max: Math.round(Math.max(...requestDurations) * 1000) / 1000,
          avg: Math.round(requestDurations.reduce((a, b) => a + b, 0) / requestDurations.length * 1000) / 1000,
          samples: requestDurations.length,
        }
      : null,
    diagMs: diagMs.length > 0
      ? {
          min: Math.round(Math.min(...diagMs) * 1000) / 1000,
          max: Math.round(Math.max(...diagMs) * 1000) / 1000,
          avg: Math.round(diagMs.reduce((a, b) => a + b, 0) / diagMs.length * 1000) / 1000,
          samples: diagMs.length,
        }
      : null,
    eventLoopDelayMs: eventLoopDelays.length > 0
      ? {
          min: Math.round(Math.min(...eventLoopDelays) * 1000) / 1000,
          max: Math.round(Math.max(...eventLoopDelays) * 1000) / 1000,
          samples: eventLoopDelays.length,
        }
      : null,
    cpuPercent: cpuPcts.length > 0
      ? {
          min: Math.round(Math.min(...cpuPcts) * 100) / 100,
          max: Math.round(Math.max(...cpuPcts) * 100) / 100,
          avg: Math.round(cpuPcts.reduce((a, b) => a + b, 0) / cpuPcts.length * 100) / 100,
          samples: cpuPcts.length,
        }
      : null,
    clientWallBreakdownMs: {
      fetchHeaders: summarizeNumberList(livezFetchHeaderMs),
      bodyParse: summarizeNumberList(livezBodyParseMs),
      clientToServerStartLag: summarizeNumberList(clientToServerStartLagMs),
      clientToSocketConnectedLag: summarizeNumberList(clientToSocketConnectedLagMs),
      clientToHttpRequestEventLag: summarizeNumberList(clientToHttpRequestEventLagMs),
      socketConnectedToHandlerStart: summarizeNumberList(socketAgeBeforeHandlerMs),
      socketIdleBeforeRequest: summarizeNumberList(socketIdleBeforeRequestMs),
      socketAcceptedToHttpRequestEvent: summarizeNumberList(socketAcceptedToHttpRequestEventMs),
      httpRequestEventToHandlerStart: summarizeNumberList(httpRequestEventToHandlerStartMs),
      socketIdleBeforeHttpRequestEvent: summarizeNumberList(socketIdleBeforeHttpRequestEventMs),
      reuseIdleBeforeData: summarizeNumberList(reuseIdleBeforeDataMs),
      reuseDataToHttpRequestEvent: summarizeNumberList(reuseDataToHttpRequestEventMs),
      serverEchoClientProbeStartToHandlerStart: summarizeNumberList(serverClientProbeStartToHandlerStartMs),
      clientProbeStartToSocketConnected: summarizeNumberList(clientProbeStartToSocketConnectedMs),
      serverPreparedToClientHeaders: summarizeNumberList(serverPreparedToClientHeadersMs),
    },
  };

  // /schedz in-broker scheduling summary
  const schedzSchedulingSummary = {
    maxMs: schedSchedMaxSorted.length > 0 ? schedSchedMaxSorted[schedSchedMaxSorted.length - 1] : 0,
    p99Ms: schedSchedP99Sorted.length > 0 ? percentile(schedSchedP99Sorted, 99) : 0,
    p95Ms: schedSchedP95Sorted.length > 0 ? percentile(schedSchedP95Sorted, 95) : 0,
    p50Ms: schedSchedP50Sorted.length > 0 ? percentile(schedSchedP50Sorted, 50) : 0,
    sampleCount: schedulingMaxMs.length,
  };
  const requestRouteSummary = summarizeRequestRoutes(correlatedProbes);
  const workerHeartbeatPhaseSummary = summarizeWorkerHeartbeatPhases(correlatedProbes);
  const livezSpikeCorrelation = summarizeLivezSpikeCorrelation(correlatedProbes);
  const schedzConnectionSummary = summarizeSchedzConnections(correlatedProbes);
  const schedzContainerSummary = summarizeSchedzContainer(correlatedProbes);

  // Host metrics summary
  const hostMetricsSummary = hostBaseline
    ? { ...hostBaseline, dockerStats: dockerStats ?? null }
    : null;

  // Probe level counts: track errors from error arrays when available, fall back to duration-based
  const livezFailures = livezErrors.length > 0
    ? livezErrors.filter(Boolean).length
    : livezDurations.filter((d) => d > 3000).length;
  const schedzFailures = schedzErrors.length > 0
    ? schedzErrors.filter(Boolean).length
    : schedzDurations.filter((d) => d > 3000).length;

  const checks = [
    ok("probe count", `${count} probes sent`),
    livezMax > 3000
      ? fail("livez max latency gate", `max /livez wall ${livezMax}ms exceeds 3000ms threshold`, { livezMax, thresholdMs: 3000 })
      : ok("livez max latency gate", `/livez max ${livezMax}ms within threshold`),
    schedzMax > 3000
      ? fail("schedz response latency gate", `max /schedz response ${schedzMax}ms exceeds 3000ms`, { schedzMax, thresholdMs: 3000 })
      : ok("schedz response latency gate", `/schedz response ${schedzMax}ms within threshold`),
    schedzFailures > 0
      ? fail("schedz success gate", `${schedzFailures}/${count} /schedz probe(s) failed`, { schedzFailures, totalProbes: count })
      : ok("schedz success gate", `${schedzFailures}/${count} /schedz probe failures`),
    schedzSchedulingSummary.maxMs > 3000
      ? fail("in-broker scheduling max gate", `in-broker scheduling max ${schedzSchedulingSummary.maxMs}ms exceeds 3000ms`, { schedulingMaxMs: schedzSchedulingSummary.maxMs, thresholdMs: 3000 })
      : ok("in-broker scheduling max gate", `scheduling max ${schedzSchedulingSummary.maxMs}ms within threshold`),
    livezWallSamplesAbove3s > 0
      ? fail("livez samples above 3s gate", `${livezWallSamplesAbove3s} /livez sample(s) exceeded 3s`, { livezWallSamplesAbove3s })
      : ok("livez samples above 3s gate", `${livezWallSamplesAbove3s} sample(s) above 3s`),
    livezFailures > 0
      ? fail("livez success gate", `${livezFailures}/${count} /livez probe(s) failed`, { livezFailures, totalProbes: count })
      : ok("livez success gate", `${livezFailures}/${count} /livez probe failures`),
    livezFailures / count >= 0.1
      ? fail("livez failure rate gate", `${livezFailures}/${count} (${Math.round((livezFailures / count) * 100)}%) livez failures >= 10%`, { livezFailures, totalProbes: count })
      : ok("livez failure rate gate", `${livezFailures}/${count} livez failures OK`),
    mode === "live" && schedzSchedulingSummary.sampleCount === 0
      ? fail("scheduling data received", `0/${count} /schedz responses included scheduling timing`)
      : schedzSchedulingSummary.maxMs > 0
      ? ok("scheduling data received", `${schedzSchedulingSummary.sampleCount}/${count} /schedz responses included scheduling timing`)
      : ok("scheduling data received", "no scheduling timing data in /schedz responses (expected in no-live mode)"),
    ok("safety gate", "read-only loopback measurement; no deploy, Gateway restart, Telegram send, DB mutation, or terminal-outbox ACK"),
  ];

  const report = {
    kind: "a2a-broker.comprehensive-diagnostics.v1",
    issue: ISSUE,
    laneIssue: LANE_ISSUE,
    runId: RUN_ID,
    mode,
    baseUrl,
    requesterId,
    livezConnectionMode,
    probeCount: count,
    livezFailureCount: livezFailures,
    schedzFailureCount: schedzFailures,
    livezMaxMs: livezMax,
    livezP50Ms: percentile(livezSorted, 50),
    livezP95Ms: percentile(livezSorted, 95),
    livezP99Ms: percentile(livezSorted, 99),
    schedzMaxMs: schedzMax,
    schedzP50Ms: percentile(schedzSorted, 50),
    schedzP95Ms: percentile(schedzSorted, 95),
    schedzP99Ms: percentile(schedzSorted, 99),
    schedzSchedulingMaxMs: schedzSchedulingSummary.maxMs,
    schedzSchedulingP95Ms: schedzSchedulingSummary.p95Ms,
    schedzSchedulingP99Ms: schedzSchedulingSummary.p99Ms,
    schedzSchedulingP50Ms: schedzSchedulingSummary.p50Ms,
    livezWallSamplesAbove1s,
    livezWallSamplesAbove3s,
    hostMetricsSummary,
    livezTimingSummary,
    schedzSchedulingSummary,
    schedzConnectionSummary,
    schedzContainerSummary,
    requestRouteSummary,
    workerHeartbeatPhaseSummary,
    livezSpikeCorrelation,
    correlatedProbes: correlatedProbes.slice(0, 40),
    checks,
    ok: checks.every((c) => c.ok),
  };
  report.livezAttribution = classifyLivezAttribution(report);
  return report;
}

// ---------------------------------------------------------------------------
// Connection-mode comparison report
// ---------------------------------------------------------------------------

function summarizeConnectionModeReport(report) {
  const slowSampleAttributionRows = buildSlowSampleAttributionRows(report);
  return {
    livezConnectionMode: report.livezConnectionMode,
    ok: report.ok,
    probeCount: report.probeCount,
    livezFailureCount: report.livezFailureCount,
    schedzFailureCount: report.schedzFailureCount,
    livezMaxMs: report.livezMaxMs,
    livezP99Ms: report.livezP99Ms,
    livezWallSamplesAbove1s: report.livezWallSamplesAbove1s,
    livezWallSamplesAbove3s: report.livezWallSamplesAbove3s,
    schedzMaxMs: report.schedzMaxMs,
    schedzSchedulingMaxMs: report.schedzSchedulingMaxMs,
    schedzConnectionSummary: report.schedzConnectionSummary,
    schedzContainerSummary: report.schedzContainerSummary,
    livezAttribution: report.livezAttribution,
    livezSpikeCorrelation: report.livezSpikeCorrelation,
    slowSampleAttributionRows,
    heartbeatCorrelationAssessment: buildHeartbeatCorrelationAssessment(slowSampleAttributionRows),
    checks: report.checks,
  };
}

function buildSlowSampleAttributionRows(report, limit = 8) {
  const samples = report?.livezSpikeCorrelation?.topSlowSamples;
  if (!Array.isArray(samples) || samples.length === 0) return [];
  return samples.slice(0, limit).map((sample) => {
    const attribution = classifyLivezSlowSampleAttribution(sample, report?.livezAttribution);
    return {
      mode: report.livezConnectionMode,
      index: sample.index ?? null,
      timestamp: sample.timestamp ?? null,
      livezWallMs: sample.livezWallMs ?? null,
      schedzWallMs: sample.schedzWallMs ?? null,
      socketRequestIndex: sample.socketRequestIndex ?? null,
      socketHadServedRequest: sample.socketHadServedRequest ?? null,
      socketAcceptedToHttpRequestEventMs: sample.socketAcceptedToHttpRequestEventMs ?? null,
      httpRequestEventToHandlerStartMs: sample.httpRequestEventToHandlerStartMs ?? null,
      socketIdleBeforeHttpRequestEventMs: sample.socketIdleBeforeHttpRequestEventMs ?? null,
      reuseIdleBeforeDataMs: sample.reuseIdleBeforeDataMs ?? null,
      reuseDataToHttpRequestEventMs: sample.reuseDataToHttpRequestEventMs ?? null,
      socketAgeBeforeHandlerMs: sample.socketAgeBeforeHandlerMs ?? null,
      clientToServerStartLagMs: sample.clientToServerStartLagMs ?? null,
      serverPreparedToClientHeadersMs: sample.serverPreparedToClientHeadersMs ?? null,
      schedzSchedulingMaxMs: sample.schedzSchedulingMaxMs ?? null,
      schedzSchedulingP99Ms: sample.schedzSchedulingP99Ms ?? null,
      schedzSchedulingP95Ms: sample.schedzSchedulingP95Ms ?? null,
      schedzSchedulingP50Ms: sample.schedzSchedulingP50Ms ?? null,
      schedzTopRoute: sample.schedzTopRoute ?? null,
      schedzTopRouteMaxMs: sample.schedzTopRouteMaxMs ?? null,
      schedzTopRouteTimingMaxMs: sample.schedzTopRouteTimingMaxMs ?? null,
      schedzTopRouteFirstRequestMaxMs: sample.schedzTopRouteFirstRequestMaxMs ?? null,
      workerHeartbeatTopPhase: sample.workerHeartbeatTopPhase ?? null,
      workerHeartbeatTopPhaseMaxMs: sample.workerHeartbeatTopPhaseMaxMs ?? null,
      workerHeartbeatTopPhaseP99Ms: sample.workerHeartbeatTopPhaseP99Ms ?? null,
      workerHeartbeatTopWorkerId: sample.workerHeartbeatTopWorkerId ?? null,
      workerHeartbeatTopWorkerPhase: sample.workerHeartbeatTopWorkerPhase ?? null,
      workerHeartbeatTopWorkerPhaseMaxMs: sample.workerHeartbeatTopWorkerPhaseMaxMs ?? null,
      workerHeartbeatTopWorkerPhaseP99Ms: sample.workerHeartbeatTopWorkerPhaseP99Ms ?? null,
      workerRegisterTopPhase: sample.workerRegisterTopPhase ?? null,
      workerRegisterTopPhaseMaxMs: sample.workerRegisterTopPhaseMaxMs ?? null,
      workerRegisterTopPhaseP99Ms: sample.workerRegisterTopPhaseP99Ms ?? null,
      workerRegisterTopWorkerId: sample.workerRegisterTopWorkerId ?? null,
      workerRegisterTopWorkerPhase: sample.workerRegisterTopWorkerPhase ?? null,
      workerRegisterTopWorkerPhaseMaxMs: sample.workerRegisterTopWorkerPhaseMaxMs ?? null,
      workerRegisterTopWorkerPhaseP99Ms: sample.workerRegisterTopWorkerPhaseP99Ms ?? null,
      terminalOutboxSampledCount: sample.terminalOutboxSampledCount ?? null,
      terminalOutboxRetainedCount: sample.terminalOutboxRetainedCount ?? null,
      terminalOutboxPendingAckCount: sample.terminalOutboxPendingAckCount ?? null,
      terminalOutboxOldestPendingAckAgeMs: sample.terminalOutboxOldestPendingAckAgeMs ?? null,
      terminalOutboxOldestPendingAckWorkerId: sample.terminalOutboxOldestPendingAckWorkerId ?? null,
      terminalOutboxOldestPendingAckStatus: sample.terminalOutboxOldestPendingAckStatus ?? null,
      terminalOutboxOldestPendingAckReceiptStatus: sample.terminalOutboxOldestPendingAckReceiptStatus ?? null,
      terminalOutboxOldestPendingAckBrokerOfRecord: sample.terminalOutboxOldestPendingAckBrokerOfRecord ?? null,
      terminalOutboxTopWorkerId: sample.terminalOutboxTopWorkerId ?? null,
      terminalOutboxTopWorkerCount: sample.terminalOutboxTopWorkerCount ?? null,
      terminalOutboxTopStatus: sample.terminalOutboxTopStatus ?? null,
      terminalOutboxTopStatusCount: sample.terminalOutboxTopStatusCount ?? null,
      terminalOutboxTopReceiptStatus: sample.terminalOutboxTopReceiptStatus ?? null,
      terminalOutboxTopReceiptStatusCount: sample.terminalOutboxTopReceiptStatusCount ?? null,
      terminalOutboxTopPendingAckStatus: sample.terminalOutboxTopPendingAckStatus ?? null,
      terminalOutboxTopPendingAckStatusCount: sample.terminalOutboxTopPendingAckStatusCount ?? null,
      terminalOutboxTopPendingAckReceiptStatus: sample.terminalOutboxTopPendingAckReceiptStatus ?? null,
      terminalOutboxTopPendingAckReceiptStatusCount: sample.terminalOutboxTopPendingAckReceiptStatusCount ?? null,
      terminalOutboxTopPendingAckBrokerOfRecord: sample.terminalOutboxTopPendingAckBrokerOfRecord ?? null,
      terminalOutboxTopPendingAckBrokerOfRecordCount: sample.terminalOutboxTopPendingAckBrokerOfRecordCount ?? null,
      containerCpuDeltaNrThrottled: sample.containerCpuDeltaNrThrottled ?? null,
      containerCpuDeltaThrottledMs: sample.containerCpuDeltaThrottledMs ?? null,
      containerPsiCpuSomeAvg10: sample.containerPsiCpuSomeAvg10 ?? null,
      containerPsiCpuFullAvg10: sample.containerPsiCpuFullAvg10 ?? null,
      hostLoad1: sample.hostLoad1 ?? null,
      hostRunQueue: sample.hostRunQueue ?? null,
      hostCpuPsiAvg10: sample.hostCpuPsiAvg10 ?? null,
      attributionBucket: attribution.bucket ?? null,
      attributionConfidence: attribution.confidence ?? null,
    };
  });
}

function buildHeartbeatCorrelationAssessment(slowSampleAttributionRows = []) {
  const rows = Array.isArray(slowSampleAttributionRows) ? slowSampleAttributionRows : [];
  const heartbeatRows = rows.filter((row) => (
    row?.schedzTopRoute === "workers.heartbeat"
    || typeof row?.workerHeartbeatTopPhase === "string"
    || typeof row?.workerHeartbeatTopWorkerPhase === "string"
  ));
  const brokerHeartbeatRows = heartbeatRows.filter((row) => (
    row.workerHeartbeatTopPhase === "brokerHeartbeat"
    || row.workerHeartbeatTopWorkerPhase === "brokerHeartbeat"
  ));
  const workerIds = [...new Set(
    heartbeatRows
      .map((row) => row.workerHeartbeatTopWorkerId)
      .filter((workerId) => typeof workerId === "string" && workerId.length > 0),
  )].slice(0, 8);
  const maxNumberFromRows = (keys) => heartbeatRows.reduce((max, row) => {
    const values = keys
      .map((key) => row?.[key])
      .filter((value) => typeof value === "number");
    return Math.max(max, ...values, 0);
  }, 0);

  if (heartbeatRows.length === 0) {
    return {
      verdict: "no-heartbeat-correlation",
      confidence: "medium",
      dbPersistProof: false,
      evidenceRows: 0,
      brokerHeartbeatRows: 0,
      topWorkerIds: [],
      reason: "No slow-sample attribution row pointed at workers.heartbeat or a worker heartbeat phase.",
      recommendation: "Keep using the existing strict gate fields; do not infer a heartbeat DB bottleneck from this report.",
    };
  }

  return {
    verdict: "correlation-only-no-persist-proof",
    confidence: brokerHeartbeatRows.length > 0 ? "medium" : "low",
    dbPersistProof: false,
    evidenceRows: heartbeatRows.length,
    brokerHeartbeatRows: brokerHeartbeatRows.length,
    topWorkerIds: workerIds,
    maxLivezWallMs: maxNumberFromRows(["livezWallMs"]),
    maxHeartbeatPhaseMs: maxNumberFromRows([
      "workerHeartbeatTopPhaseMaxMs",
      "workerHeartbeatTopWorkerPhaseMaxMs",
    ]),
    reason: "Existing /schedz route and phase fields show heartbeat correlation only; they do not prove the slow sample performed SQLite persistence.",
    recommendation: "Treat workers.heartbeat/brokerHeartbeat as an attribution hint, not a DB-persist verdict. Avoid runtime per-heartbeat hot-path counters; use lower-overhead report-only evidence or a bounded spike before worker-thread/SQLite work.",
  };
}

function numericSampleField(sample, key) {
  return typeof sample?.[key] === "number" ? sample[key] : 0;
}

export function classifyLivezSlowSampleAttribution(sample, reportAttribution = {}) {
  const livezWallMs = numericSampleField(sample, "livezWallMs");
  const socketHadServedRequest = sample?.socketHadServedRequest;
  const socketAcceptedToHttpRequestEventMs = numericSampleField(sample, "socketAcceptedToHttpRequestEventMs");
  const httpRequestEventToHandlerStartMs = numericSampleField(sample, "httpRequestEventToHandlerStartMs");
  const socketIdleBeforeHttpRequestEventMs = numericSampleField(sample, "socketIdleBeforeHttpRequestEventMs");
  const reuseIdleBeforeDataMs = numericSampleField(sample, "reuseIdleBeforeDataMs");
  const reuseDataToHttpRequestEventMs = numericSampleField(sample, "reuseDataToHttpRequestEventMs");
  const socketAgeBeforeHandlerMs = numericSampleField(sample, "socketAgeBeforeHandlerMs");
  const clientToServerStartLagMs = numericSampleField(sample, "clientToServerStartLagMs");
  const serverPreparedToClientHeadersMs = numericSampleField(sample, "serverPreparedToClientHeadersMs");

  if (livezWallMs <= 1000) {
    return { bucket: "no-significant-stall", confidence: "high" };
  }

  if (
    socketHadServedRequest === true
    && socketIdleBeforeHttpRequestEventMs > 1000
    && httpRequestEventToHandlerStartMs < 1000
  ) {
    if (
      reuseDataToHttpRequestEventMs > 500
      && reuseDataToHttpRequestEventMs > reuseIdleBeforeDataMs * 0.5
    ) {
      return {
        bucket: "reused-socket-data-received-blocked",
        confidence: reuseDataToHttpRequestEventMs > 3000 ? "high" : "medium",
      };
    }
    return {
      bucket: "reused-socket-idle-before-request-event",
      confidence: socketIdleBeforeHttpRequestEventMs > 3000 ? "high" : "medium",
    };
  }

  if (
    socketHadServedRequest === false
    && socketAcceptedToHttpRequestEventMs > 1000
    && httpRequestEventToHandlerStartMs < 1000
  ) {
    return {
      bucket: "accepted-socket-waiting-before-request-event",
      confidence: socketAcceptedToHttpRequestEventMs > 3000 ? "high" : "medium",
    };
  }

  if (httpRequestEventToHandlerStartMs > 1000) {
    return {
      bucket: "request-event-waiting-before-handler",
      confidence: httpRequestEventToHandlerStartMs > 3000 ? "high" : "medium",
    };
  }

  if (serverPreparedToClientHeadersMs > 1000) {
    return {
      bucket: "response-egress-or-client-read",
      confidence: serverPreparedToClientHeadersMs > 3000 ? "high" : "medium",
    };
  }

  if (
    clientToServerStartLagMs > 1000
    && socketAcceptedToHttpRequestEventMs < 1000
    && httpRequestEventToHandlerStartMs < 1000
    && serverPreparedToClientHeadersMs < 1000
  ) {
    return {
      bucket: "client-or-network-before-server-request",
      confidence: clientToServerStartLagMs > 3000 ? "medium" : "low",
    };
  }

  if (socketAgeBeforeHandlerMs > 1000) {
    return {
      bucket: "accepted-socket-waiting-before-handler",
      confidence: socketAgeBeforeHandlerMs > 3000 ? "high" : "medium",
    };
  }

  if (reportAttribution?.bucket) {
    return {
      bucket: `report:${reportAttribution.bucket}`,
      confidence: reportAttribution.confidence ?? "low",
    };
  }

  return { bucket: "unattributed-external-wall", confidence: "low" };
}

function comparisonDelta(left, right) {
  return {
    livezMaxMs: roundProbeMs((left?.livezMaxMs ?? 0) - (right?.livezMaxMs ?? 0)),
    livezP99Ms: roundProbeMs((left?.livezP99Ms ?? 0) - (right?.livezP99Ms ?? 0)),
    slowSampleDelta: (left?.livezWallSamplesAbove1s ?? 0) - (right?.livezWallSamplesAbove1s ?? 0),
    schedzFailureDelta: (left?.schedzFailureCount ?? 0) - (right?.schedzFailureCount ?? 0),
    schedzMaxDelta: roundProbeMs((left?.schedzMaxMs ?? 0) - (right?.schedzMaxMs ?? 0)),
  };
}

function buildComparisonConclusion(perMode) {
  const summaries = Object.values(perMode);
  if (summaries.some((summary) => !summary.ok)) {
    const failedModes = summaries.filter((s) => !s.ok).map((s) => s.livezConnectionMode);
    const schedzFailed = summaries.filter((s) => (s.schedzFailureCount ?? 0) > 0).map((s) => s.livezConnectionMode);
    const livezFailed = summaries.filter((s) => (s.livezFailureCount ?? 0) > 0).map((s) => s.livezConnectionMode);
    const reasons = [`At least one connection mode failed its gate: ${failedModes.join(", ")}.`];
    if (schedzFailed.length > 0 && livezFailed.length === 0) {
      reasons.push("All /livez probes passed; failures are from the /schedz data gate (schedzFailureCount > 0), not from connection-mode behavior.");
      reasons.push("The /schedz endpoint does not use connection-mode headers, so this reflects server-wide scheduling pressure, not a keep-alive regression.");
    } else if (livezFailed.length > 0 && schedzFailed.length === 0) {
      reasons.push("Failures are from the /livez probe gate (livezFailureCount > 0) with /schedz passing.");
    } else if (livezFailed.length > 0 && schedzFailed.length > 0) {
      reasons.push("Both /livez and /schedz gates have failures; server may be under host-level scheduling pressure.");
    }
    reasons.push("Compare the per-mode check details before drawing timing conclusions.");
    return {
      bucket: "inconclusive",
      confidence: "low",
      reasons,
    };
  }
  const slowCounts = summaries.map((summary) => summary.livezWallSamplesAbove1s ?? 0);
  const maxSlow = Math.max(...slowCounts);
  const minSlow = Math.min(...slowCounts);
  if (maxSlow === 0) {
    return {
      bucket: "no-mode-difference",
      confidence: "high",
      reasons: ["No mode produced /livez samples above the 1s residual-stall threshold."],
    };
  }
  if (maxSlow === minSlow) {
    return {
      bucket: "no-mode-difference",
      confidence: "medium",
      reasons: ["All modes produced the same count of /livez samples above 1s."],
    };
  }
  const worst = summaries.slice().sort((a, b) => (
    (b.livezWallSamplesAbove1s ?? 0) - (a.livezWallSamplesAbove1s ?? 0)
    || (b.livezP99Ms ?? 0) - (a.livezP99Ms ?? 0)
  ))[0];
  const bucketByMode = {
    default: "default-worse",
    fresh: "fresh-worse",
    "keep-alive": "keep-alive-worse",
  };
  return {
    bucket: bucketByMode[worst.livezConnectionMode] ?? "inconclusive",
    confidence: maxSlow - minSlow >= 2 ? "medium" : "low",
    reasons: [
      `${worst.livezConnectionMode} produced the highest count of /livez samples above 1s (${worst.livezWallSamplesAbove1s}).`,
      "Connection headers are requests to the runtime; observed socket reuse fields remain the source of truth.",
    ],
  };
}

export function buildLivezSocketReusePolicy(perMode, standaloneLivezOnlyGate = null) {
  const defaultSummary = perMode?.default ?? null;
  const freshSummary = perMode?.fresh ?? null;
  const keepAliveSummary = perMode?.["keep-alive"] ?? null;
  const summaries = [defaultSummary, freshSummary, keepAliveSummary].filter(Boolean);
  const failures = summaries.reduce((sum, summary) => (
    sum + (summary.livezFailureCount ?? 0) + (summary.schedzFailureCount ?? 0)
  ), 0) + (standaloneLivezOnlyGate?.livezFailureCount ?? 0);
  const above3s = summaries.reduce((sum, summary) => sum + (summary.livezWallSamplesAbove3s ?? 0), 0)
    + (standaloneLivezOnlyGate?.livezWallSamplesAbove3s ?? 0);
  const freshAbove1s = freshSummary?.livezWallSamplesAbove1s ?? 0;
  const livezOnlyAbove1s = standaloneLivezOnlyGate?.livezWallSamplesAbove1s ?? 0;
  const reusedAbove1s = (defaultSummary?.livezWallSamplesAbove1s ?? 0)
    + (keepAliveSummary?.livezWallSamplesAbove1s ?? 0);
  const reusedBuckets = [defaultSummary, keepAliveSummary]
    .map((summary) => summary?.livezAttribution?.bucket)
    .filter(Boolean);
  const reusedIdleBucketSeen = reusedBuckets.some((bucket) => bucket === "reused-socket-idle-before-request-event");

  if (failures > 0 || above3s > 0) {
    return {
      operatorAction: "investigate",
      strictWallClockGateMode: "connection-mode-comparison",
      reusedSocketResidualPolicy: "not_applicable",
      reason: "HTTP failures, /schedz failures, or /livez >3s samples are not socket-reuse residuals.",
      approvalRequiredFor: ["deploy", "restart", "live canary", "DB mutation", "terminal ACK/replay"],
    };
  }

  if (freshAbove1s > 0 || livezOnlyAbove1s > 0) {
    return {
      operatorAction: "investigate",
      strictWallClockGateMode: "fresh-and-livez-only",
      reusedSocketResidualPolicy: "not_applicable",
      reason: "Fresh-socket or standalone /livez-only probes still crossed 1s, so the residual is not isolated to reused sockets.",
      approvalRequiredFor: ["deploy", "restart", "live canary", "DB mutation", "terminal ACK/replay"],
    };
  }

  if (reusedAbove1s > 0 && reusedIdleBucketSeen) {
    return {
      operatorAction: "observe",
      strictWallClockGateMode: "fresh-and-livez-only",
      reusedSocketResidualPolicy: "acceptable_residual_client_probe_latency",
      reason: "Only reused-socket modes crossed 1s and attribution points to idle-before-request-event, not broker handler, SQLite, heartbeat, or request-event delivery after bytes arrived.",
      approvalRequiredFor: ["deploy", "restart", "live canary", "DB mutation", "terminal ACK/replay"],
    };
  }

  if (reusedAbove1s > 0) {
    return {
      operatorAction: "investigate",
      strictWallClockGateMode: "fresh-and-livez-only",
      reusedSocketResidualPolicy: "needs_attribution",
      reason: "Reused-socket modes crossed 1s, but attribution did not identify the idle-before-request-event residual bucket.",
      approvalRequiredFor: ["deploy", "restart", "live canary", "DB mutation", "terminal ACK/replay"],
    };
  }

  return {
    operatorAction: "observe",
    strictWallClockGateMode: "connection-mode-comparison",
    reusedSocketResidualPolicy: "no_residual_observed",
    reason: "No connection mode produced /livez >1s samples.",
    approvalRequiredFor: ["deploy", "restart", "live canary", "DB mutation", "terminal ACK/replay"],
  };
}

export function buildStrictLivezCloseGate(perMode, extraReports = {}) {
  const failures = [];
  const addFailure = (scope, summary) => {
    if (!summary || typeof summary !== "object") {
      failures.push({ scope, reason: "missing-report" });
      return;
    }
    const livezFailureCount = summary.livezFailureCount ?? 0;
    const schedzFailureCount = summary.schedzFailureCount ?? 0;
    const livezWallSamplesAbove1s = summary.livezWallSamplesAbove1s ?? 0;
    const livezWallSamplesAbove3s = summary.livezWallSamplesAbove3s ?? 0;
    if (livezFailureCount > 0) {
      failures.push({ scope, reason: "livez-failures", count: livezFailureCount });
    }
    if (schedzFailureCount > 0) {
      failures.push({ scope, reason: "schedz-failures", count: schedzFailureCount });
    }
    if (livezWallSamplesAbove3s > 0) {
      failures.push({ scope, reason: "livez-samples-above-3s", count: livezWallSamplesAbove3s });
    }
    if (livezWallSamplesAbove1s > 0) {
      failures.push({ scope, reason: "livez-samples-above-1s", count: livezWallSamplesAbove1s });
    }
  };

  for (const [mode, summary] of Object.entries(perMode ?? {})) {
    addFailure(`connection-mode:${mode}`, summary);
  }
  for (const [name, summary] of Object.entries(extraReports ?? {})) {
    addFailure(name, summary);
  }

  const ok = failures.length === 0;
  return {
    ok,
    check: "strict #1032 livez close gate",
    detail: ok
      ? "all connection-mode and standalone /livez gates have 0 failures, 0 >1s samples, and 0 >3s samples"
      : `${failures.length} strict #1032 close violation(s); #1032 must remain open`,
    criteria: {
      livezFailures: 0,
      schedzFailures: 0,
      livezWallSamplesAbove1s: 0,
      livezWallSamplesAbove3s: 0,
      note: ">3s=0 is a minimum gate; strict close also requires >1s=0 across connection-mode and standalone /livez-only reports.",
    },
    failures,
  };
}

async function runSingleConnectionModeDiagnostics(options, livezConnectionMode) {
  const nextOptions = {
    ...options,
    compareLivezConnectionModes: false,
    livezConnectionMode,
  };
  return nextOptions.noLive
    ? runNoLiveDiagnostics(nextOptions)
    : runLiveDiagnostics(nextOptions);
}

export async function runLivezConnectionModeComparison(options = {}) {
  const explicitMode = parseLivezConnectionMode(options.livezConnectionMode ?? DEFAULT_LIVEZ_CONNECTION_MODE);
  if (explicitMode !== DEFAULT_LIVEZ_CONNECTION_MODE) {
    throw new Error("--compare-livez-connection-modes cannot be combined with --livez-connection-mode");
  }
  const countPerMode = normalizeProbeCount(options.count ?? DEFAULT_COUNT, MAX_COMPARISON_COUNT_PER_MODE);
  if ((options.count ?? DEFAULT_COUNT) > MAX_COMPARISON_COUNT_PER_MODE) {
    throw new Error(`--compare-livez-connection-modes limits --count to ${MAX_COMPARISON_COUNT_PER_MODE} per mode`);
  }
  const baseRequesterId = normalizeRequesterId(options.requesterId);
  const requesterIds = Object.fromEntries(
    LIVEZ_CONNECTION_MODE_LIST.map((mode) => [mode, requesterIdForConnectionMode(baseRequesterId, mode)]),
  );

  const modeReports = [];
  for (const mode of LIVEZ_CONNECTION_MODE_LIST) {
    modeReports.push(await runSingleConnectionModeDiagnostics({
      ...options,
      count: countPerMode,
      requesterId: requesterIds[mode],
    }, mode));
  }

  const perMode = Object.fromEntries(
    modeReports.map((report) => [report.livezConnectionMode, summarizeConnectionModeReport(report)]),
  );
  const standaloneLivezOnlyGate = options.includeLivezOnlyGate === true
    ? await runStandaloneLivezOnlyGate({
        ...options,
        count: countPerMode,
        requesterId: baseRequesterId,
      })
    : null;
  const deltas = {
    freshMinusDefault: comparisonDelta(perMode.fresh, perMode.default),
    keepAliveMinusDefault: comparisonDelta(perMode["keep-alive"], perMode.default),
    keepAliveMinusFresh: comparisonDelta(perMode["keep-alive"], perMode.fresh),
  };
  const strictCloseGate = buildStrictLivezCloseGate(
    perMode,
    standaloneLivezOnlyGate ? { "standalone-livez-only": standaloneLivezOnlyGate } : {},
  );
  const livezSocketReusePolicy = buildLivezSocketReusePolicy(perMode, standaloneLivezOnlyGate);
  const heartbeatCorrelationAssessment = buildHeartbeatCorrelationAssessment(
    Object.values(perMode ?? {}).flatMap((summary) => summary.slowSampleAttributionRows ?? []),
  );
  const checks = [
    ok("comparison probe budget", `${countPerMode} probes per mode; ${countPerMode * LIVEZ_CONNECTION_MODE_LIST.length + (standaloneLivezOnlyGate ? countPerMode : 0)} total /livez probes`, {
      countPerMode,
      totalLivezProbes: countPerMode * LIVEZ_CONNECTION_MODE_LIST.length,
      standaloneLivezOnlyProbes: standaloneLivezOnlyGate ? countPerMode : 0,
    }),
    ...modeReports.map((report) => (
      report.ok
        ? ok(`mode ${report.livezConnectionMode} gate`, `${report.livezConnectionMode} report passed`)
        : fail(`mode ${report.livezConnectionMode} gate`, `${report.livezConnectionMode} report failed`, {
            failedChecks: report.checks.filter((check) => !check.ok).map((check) => check.check),
          })
    )),
    strictCloseGate.ok
      ? ok(strictCloseGate.check, strictCloseGate.detail, {
          criteria: strictCloseGate.criteria,
        })
      : fail(strictCloseGate.check, strictCloseGate.detail, {
          criteria: strictCloseGate.criteria,
          failures: strictCloseGate.failures,
        }),
    ok("safety gate", "read-only diagnostics comparison; no deploy, Gateway restart, Telegram send, DB mutation, or terminal-outbox ACK"),
    ok(
      "socket reuse policy",
      `${livezSocketReusePolicy.operatorAction}; strict wall-clock gate mode: ${livezSocketReusePolicy.strictWallClockGateMode}`,
      { policy: livezSocketReusePolicy },
    ),
  ];

  return {
    kind: "a2a-broker.comprehensive-diagnostics.connection-mode-comparison.v1",
    issue: ISSUE,
    laneIssue: LANE_ISSUE,
    runId: RUN_ID,
    mode: options.noLive ? "no-live-connection-mode-comparison" : "live-connection-mode-comparison",
    baseUrl: options.noLive ? "http://no-live.synthetic" : (options.baseUrl ?? DEFAULT_BASE_URL),
    comparison: {
      modes: LIVEZ_CONNECTION_MODE_LIST,
      orderStrategy: "sequential-by-mode",
      countPerMode,
      totalLivezProbes: countPerMode * LIVEZ_CONNECTION_MODE_LIST.length + (standaloneLivezOnlyGate ? countPerMode : 0),
      totalSchedzProbes: countPerMode * LIVEZ_CONNECTION_MODE_LIST.length,
      schedzRequesterStrategy: "per-mode-requester-id",
      requesterIds,
      thresholdMs: 1000,
      standaloneLivezOnlyGateIncluded: Boolean(standaloneLivezOnlyGate),
    },
    perMode,
    standaloneLivezOnlyGate,
    deltas,
    comparisonConclusion: buildComparisonConclusion(perMode),
    livezSocketReusePolicy,
    heartbeatCorrelationAssessment,
    strictCloseGate,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run comprehensive diagnostics (live or no-live).
 *
 * @param {object} [options]
 * @returns {Promise<ComprehensiveDiagnosticsReport>}
 */
export async function runDiagnostics(options = {}) {
  if (options.compareLivezConnectionModes === true) {
    return runLivezConnectionModeComparison(options);
  }
  return options.noLive ? runNoLiveDiagnostics(options) : runLiveDiagnostics(options);
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderConnectionModeComparisonMarkdown(report) {
  const title = report.ok ? "Done" : "Block";
  const rows = Object.values(report.perMode ?? {}).map((summary) => {
    const corr = summary.livezSpikeCorrelation ?? {};
    const schedzFail = summary.schedzFailureCount ?? 0;
    const schedzMax = summary.schedzMaxMs ?? 0;
    return `| ${summary.livezConnectionMode} | ${summary.probeCount} | ${summary.livezMaxMs}ms | ${summary.livezP99Ms}ms | ${summary.livezWallSamplesAbove1s} | ${summary.livezWallSamplesAbove3s} | ${schedzFail} | ${schedzMax}ms | ${corr.byConnectionReuse?.firstRequest?.count ?? 0} | ${corr.byConnectionReuse?.reusedSocket?.count ?? 0} | ${summary.livezAttribution?.bucket ?? "N/A"} |`;
  });
  const slowSampleRows = Object.values(report.perMode ?? {}).flatMap((summary) => (
    Array.isArray(summary.slowSampleAttributionRows) ? summary.slowSampleAttributionRows : []
  ));
  const slowSampleColumns = [
    "Mode", "Index", "Timestamp", "/livez", "/schedz", "Sched max", "Top route", "Route max",
    "HB phase", "HB max", "HB worker", "Worker HB max",
    "Register phase", "Register max", "Register worker", "Worker register max",
    "TO worker", "TO pending", "TO oldest pending", "TO oldest worker", "TO status", "TO pending status",
    "CPU throttle delta", "PSI cpu some10", "Host load1", "Socket index", "Reused?",
    "Socket to request event", "Request event to handler", "Reused idle to request event",
    "Reused idle to data", "Reused data to request event", "Socket to handler", "Client to handler",
    "Server prepared to headers", "Attribution",
  ];
  const slowSampleMarkdownRows = slowSampleRows.map((sample) => [
    sample.mode ?? "N/A",
    sample.index ?? "N/A",
    sample.timestamp ?? "N/A",
    `${sample.livezWallMs ?? "N/A"}ms`,
    `${sample.schedzWallMs ?? "N/A"}ms`,
    `${sample.schedzSchedulingMaxMs ?? "N/A"}ms`,
    sample.schedzTopRoute ?? "N/A",
    `${sample.schedzTopRouteMaxMs ?? "N/A"}ms`,
    sample.workerHeartbeatTopPhase ?? "N/A",
    `${sample.workerHeartbeatTopPhaseMaxMs ?? "N/A"}ms`,
    `${sample.workerHeartbeatTopWorkerId ?? "N/A"}:${sample.workerHeartbeatTopWorkerPhase ?? "N/A"}`,
    `${sample.workerHeartbeatTopWorkerPhaseMaxMs ?? "N/A"}ms`,
    sample.workerRegisterTopPhase ?? "N/A",
    `${sample.workerRegisterTopPhaseMaxMs ?? "N/A"}ms`,
    `${sample.workerRegisterTopWorkerId ?? "N/A"}:${sample.workerRegisterTopWorkerPhase ?? "N/A"}`,
    `${sample.workerRegisterTopWorkerPhaseMaxMs ?? "N/A"}ms`,
    `${sample.terminalOutboxTopWorkerId ?? "N/A"}:${sample.terminalOutboxTopWorkerCount ?? "N/A"}`,
    sample.terminalOutboxPendingAckCount ?? "N/A",
    `${sample.terminalOutboxOldestPendingAckAgeMs ?? "N/A"}ms`,
    sample.terminalOutboxOldestPendingAckWorkerId ?? "N/A",
    `${sample.terminalOutboxTopStatus ?? "N/A"}:${sample.terminalOutboxTopStatusCount ?? "N/A"}`,
    `${sample.terminalOutboxTopPendingAckStatus ?? "N/A"}:${sample.terminalOutboxTopPendingAckStatusCount ?? "N/A"}`,
    `${sample.containerCpuDeltaThrottledMs ?? "N/A"}ms`,
    sample.containerPsiCpuSomeAvg10 ?? "N/A",
    sample.hostLoad1 ?? "N/A",
    sample.socketRequestIndex ?? "N/A",
    sample.socketHadServedRequest ?? "N/A",
    `${sample.socketAcceptedToHttpRequestEventMs ?? "N/A"}ms`,
    `${sample.httpRequestEventToHandlerStartMs ?? "N/A"}ms`,
    `${sample.socketIdleBeforeHttpRequestEventMs ?? "N/A"}ms`,
    `${sample.reuseIdleBeforeDataMs ?? "N/A"}ms`,
    `${sample.reuseDataToHttpRequestEventMs ?? "N/A"}ms`,
    `${sample.socketAgeBeforeHandlerMs ?? "N/A"}ms`,
    `${sample.clientToServerStartLagMs ?? "N/A"}ms`,
    `${sample.serverPreparedToClientHeadersMs ?? "N/A"}ms`,
    `${sample.attributionBucket ?? "N/A"} / ${sample.attributionConfidence ?? "N/A"}`,
  ]);
  return [
    `${title}: ${ISSUE} /livez connection-mode comparison diagnostics`,
    "",
    `Parent: ${ISSUE}`,
    `Lane: ${LANE_ISSUE}`,
    `Run: ${report.runId}`,
    `Mode: ${report.mode}`,
    `Base URL: ${report.baseUrl}`,
    `Order strategy: ${report.comparison?.orderStrategy ?? "N/A"}`,
    `Schedz requester strategy: ${report.comparison?.schedzRequesterStrategy ?? "N/A"}`,
    `Count per mode: ${report.comparison?.countPerMode ?? "N/A"}`,
    "",
    "## Connection Mode Comparison",
    "",
    "| Mode | Probes | Max | p99 | >1s | >3s | /schedz fails | /schedz max | First-request slow | Reused-socket slow | Attribution |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...rows,
    "",
    "## Standalone /livez-only Gate",
    "",
    report.standaloneLivezOnlyGate
      ? [
          "| Probes | Max | p99 | >1s | >3s | Failures | Attribution |",
          "|---:|---:|---:|---:|---:|---:|---|",
          `| ${report.standaloneLivezOnlyGate.probeCount ?? "N/A"} | ${report.standaloneLivezOnlyGate.livezMaxMs ?? "N/A"}ms | ${report.standaloneLivezOnlyGate.livezP99Ms ?? "N/A"}ms | ${report.standaloneLivezOnlyGate.livezWallSamplesAbove1s ?? "N/A"} | ${report.standaloneLivezOnlyGate.livezWallSamplesAbove3s ?? "N/A"} | ${report.standaloneLivezOnlyGate.livezFailureCount ?? "N/A"} | ${report.standaloneLivezOnlyGate.livezAttribution?.bucket ?? "N/A"} |`,
        ].join("\n")
      : "Not included. Re-run with --include-livez-only-gate for #1032 close-candidate evidence.",
    "",
    "## Strict #1032 Close Gate",
    "",
    `Result: ${report.strictCloseGate?.ok ? "PASS" : "FAIL"}`,
    `Criteria: /livez failures 0, /schedz failures 0, /livez >1s 0, /livez >3s 0 across every connection mode and standalone /livez-only report.`,
    Array.isArray(report.strictCloseGate?.failures) && report.strictCloseGate.failures.length > 0
      ? [
          "| Scope | Reason | Count |",
          "|---|---|---:|",
          ...report.strictCloseGate.failures.map((failure) => (
            `| ${failure.scope ?? "N/A"} | ${failure.reason ?? "N/A"} | ${failure.count ?? "N/A"} |`
          )),
        ].join("\n")
      : "No strict close violations.",
    "",
    "## HTTP Server Connection Settings",
    "",
    "| Mode | keepAliveTimeout | headersTimeout | requestTimeout | timeout | maxRequestsPerSocket | maxConnections |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...Object.values(report.perMode ?? {}).map((summary) => {
      const http = summary.schedzConnectionSummary?.httpServer ?? {};
      return `| ${summary.livezConnectionMode} | ${http.keepAliveTimeoutMs ?? "N/A"}ms | ${http.headersTimeoutMs ?? "N/A"}ms | ${http.requestTimeoutMs ?? "N/A"}ms | ${http.timeoutMs ?? "N/A"}ms | ${http.maxRequestsPerSocket ?? "N/A"} | ${http.maxConnections ?? "N/A"} |`;
    }),
    "",
    "## Slow Sample Attribution Rows",
    "",
    slowSampleRows.length > 0
      ? [
          `| ${slowSampleColumns.join(" | ")} |`,
          `| ${slowSampleColumns.map(() => "---").join(" | ")} |`,
          ...slowSampleMarkdownRows.map((row) => `| ${row.join(" | ")} |`),
        ].join("\n")
      : "No /livez samples crossed the comparison slow-sample threshold.",
    "",
    "## Deltas",
    "",
    "| Delta | Max | p99 | >1s delta | /schedz fails delta | /schedz max delta |",
    "|---|---:|---:|---:|---:|---:|",
    `| fresh - default | ${report.deltas?.freshMinusDefault?.livezMaxMs ?? "N/A"}ms | ${report.deltas?.freshMinusDefault?.livezP99Ms ?? "N/A"}ms | ${report.deltas?.freshMinusDefault?.slowSampleDelta ?? "N/A"} | ${report.deltas?.freshMinusDefault?.schedzFailureDelta ?? "N/A"} | ${report.deltas?.freshMinusDefault?.schedzMaxDelta ?? "N/A"}ms |`,
    `| keep-alive - default | ${report.deltas?.keepAliveMinusDefault?.livezMaxMs ?? "N/A"}ms | ${report.deltas?.keepAliveMinusDefault?.livezP99Ms ?? "N/A"}ms | ${report.deltas?.keepAliveMinusDefault?.slowSampleDelta ?? "N/A"} | ${report.deltas?.keepAliveMinusDefault?.schedzFailureDelta ?? "N/A"} | ${report.deltas?.keepAliveMinusDefault?.schedzMaxDelta ?? "N/A"}ms |`,
    `| keep-alive - fresh | ${report.deltas?.keepAliveMinusFresh?.livezMaxMs ?? "N/A"}ms | ${report.deltas?.keepAliveMinusFresh?.livezP99Ms ?? "N/A"}ms | ${report.deltas?.keepAliveMinusFresh?.slowSampleDelta ?? "N/A"} | ${report.deltas?.keepAliveMinusFresh?.schedzFailureDelta ?? "N/A"} | ${report.deltas?.keepAliveMinusFresh?.schedzMaxDelta ?? "N/A"}ms |`,
    "",
    "## Comparison Conclusion",
    "",
    `Bucket: ${report.comparisonConclusion?.bucket ?? "N/A"}`,
    `Confidence: ${report.comparisonConclusion?.confidence ?? "N/A"}`,
    `Reasons: ${(report.comparisonConclusion?.reasons ?? []).join("; ")}`,
    "",
    "## Socket Reuse Policy",
    "",
    `Operator action: ${report.livezSocketReusePolicy?.operatorAction ?? "N/A"}`,
    `Strict wall-clock gate mode: ${report.livezSocketReusePolicy?.strictWallClockGateMode ?? "N/A"}`,
    `Reused-socket residual policy: ${report.livezSocketReusePolicy?.reusedSocketResidualPolicy ?? "N/A"}`,
    `Reason: ${report.livezSocketReusePolicy?.reason ?? "N/A"}`,
    `Approval required for: ${(report.livezSocketReusePolicy?.approvalRequiredFor ?? []).join(", ") || "N/A"}`,
    "",
    "## Heartbeat Correlation Guardrail",
    "",
    `Verdict: ${report.heartbeatCorrelationAssessment?.verdict ?? "N/A"}`,
    `DB persist proof: ${report.heartbeatCorrelationAssessment?.dbPersistProof === true ? "yes" : "no"}`,
    `Evidence rows: ${report.heartbeatCorrelationAssessment?.evidenceRows ?? "N/A"}`,
    `Broker heartbeat rows: ${report.heartbeatCorrelationAssessment?.brokerHeartbeatRows ?? "N/A"}`,
    `Top worker IDs: ${(report.heartbeatCorrelationAssessment?.topWorkerIds ?? []).join(", ") || "N/A"}`,
    `Reason: ${report.heartbeatCorrelationAssessment?.reason ?? "N/A"}`,
    `Recommendation: ${report.heartbeatCorrelationAssessment?.recommendation ?? "N/A"}`,
    "",
    "## Gate Checks",
    "",
    ...report.checks.map((check) => `- ${check.ok ? "✅ PASS" : "❌ FAIL"} **${check.check}**: ${check.detail}`),
    "",
    "## Safety",
    "",
    "- Broker HTTP requested: GET only (/livez, /schedz)",
    "- Provider/live Telegram called: no",
    "- DB mutation attempted: no",
    "- Terminal-outbox ACK attempted: no",
    "- Gateway restart/deploy: no",
  ].filter(Boolean).join("\n").trim();
}

function renderMarkdown(report) {
  if (report.kind === "a2a-broker.comprehensive-diagnostics.connection-mode-comparison.v1") {
    return renderConnectionModeComparisonMarkdown(report);
  }
  const title = report.ok ? "Done" : "Block";
  const sections = [
    `${title}: ${ISSUE} comprehensive /livez + /schedz diagnostics with host/container/pressure correlation`,
    "",
    `Parent: ${ISSUE}`,
    `Lane: ${LANE_ISSUE}`,
    `Run: ${report.runId}`,
    `Mode: ${report.mode}`,
    `Livez connection mode: ${report.livezConnectionMode ?? DEFAULT_LIVEZ_CONNECTION_MODE}`,
    `Base URL: ${report.baseUrl}`,
    "",
    "---",
    "",
    "## External Wall-Time Summary",
    "",
    "### /livez (external GET wall time)",
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Probes | ${report.probeCount} |`,
    `| Failures | ${report.livezFailureCount} |`,
    `| Max | ${report.livezMaxMs}ms |`,
    `| p50 | ${report.livezP50Ms}ms |`,
    `| p95 | ${report.livezP95Ms}ms |`,
    `| p99 | ${report.livezP99Ms}ms |`,
    `| Samples > 1s | ${report.livezWallSamplesAbove1s} |`,
    `| Samples > 3s | ${report.livezWallSamplesAbove3s} |`,
    "",
    "### /schedz (external GET wall time)",
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Probes | ${report.probeCount} |`,
    `| Failures | ${report.schedzFailureCount} |`,
    `| Max | ${report.schedzMaxMs}ms |`,
    `| p50 | ${report.schedzP50Ms}ms |`,
    `| p95 | ${report.schedzP95Ms}ms |`,
    `| p99 | ${report.schedzP99Ms}ms |`,
    "",
  ];

  const clientWallBreakdown = report.livezTimingSummary?.clientWallBreakdownMs;
  if (clientWallBreakdown) {
    const formatSummary = (summary) => summary
      ? `max ${summary.max}ms / p99 ${summary.p99}ms / avg ${summary.avg}ms (${summary.samples})`
      : "N/A";
    sections.push(
      "### /livez Client/Server Wall Split",
      "",
      `| Metric | Value |`,
      `|---|---|`,
      `| Fetch to headers | ${formatSummary(clientWallBreakdown.fetchHeaders)} |`,
      `| Body parse | ${formatSummary(clientWallBreakdown.bodyParse)} |`,
      `| Client start to server handler start | ${formatSummary(clientWallBreakdown.clientToServerStartLag)} |`,
      `| Client start to TCP connection accepted | ${formatSummary(clientWallBreakdown.clientToSocketConnectedLag)} |`,
      `| Client start to HTTP request event | ${formatSummary(clientWallBreakdown.clientToHttpRequestEventLag)} |`,
      `| Socket accepted to handler start | ${formatSummary(clientWallBreakdown.socketConnectedToHandlerStart)} |`,
      `| Socket accepted to HTTP request event | ${formatSummary(clientWallBreakdown.socketAcceptedToHttpRequestEvent)} |`,
      `| HTTP request event to handler start | ${formatSummary(clientWallBreakdown.httpRequestEventToHandlerStart)} |`,
      `| Reused socket idle before request | ${formatSummary(clientWallBreakdown.socketIdleBeforeRequest)} |`,
      `| Reused socket idle before HTTP request event | ${formatSummary(clientWallBreakdown.socketIdleBeforeHttpRequestEvent)} |`,
      `| Reused socket idle before first data | ${formatSummary(clientWallBreakdown.reuseIdleBeforeData)} |`,
      `| Reused socket data to HTTP request event | ${formatSummary(clientWallBreakdown.reuseDataToHttpRequestEvent)} |`,
      `| Server response prepared to client headers | ${formatSummary(clientWallBreakdown.serverPreparedToClientHeaders)} |`,
      "",
    );
  }

  // In-broker scheduling summary
  if (report.schedzSchedulingSummary) {
    sections.push(
      "## In-Broker /schedz Scheduling Timing",
      "",
      `| Metric | Value |`,
      `|---|---|`,
      `| Samples | ${report.schedzSchedulingSummary.sampleCount} |`,
      `| Max | ${report.schedzSchedulingSummary.maxMs}ms |`,
      `| p99 | ${report.schedzSchedulingSummary.p99Ms}ms |`,
      `| p95 | ${report.schedzSchedulingSummary.p95Ms}ms |`,
      `| p50 | ${report.schedzSchedulingSummary.p50Ms}ms |`,
      "",
    );
  }

  if (Array.isArray(report.requestRouteSummary) && report.requestRouteSummary.length > 0) {
    const rows = report.requestRouteSummary.slice(0, 8).map((entry) => (
      `| ${entry.route} | ${entry.maxTimingMs}ms | ${entry.p99TimingMs}ms | ${entry.maxFirstRequestLatencyMs}ms | ${entry.p99FirstRequestLatencyMs}ms | ${entry.maxActive} | ${entry.onNewConnection}/${entry.onReusedConnection} |`
    ));
    sections.push(
      "## Request Route Attribution",
      "",
      `| Route | Timing max | Timing p99 | First-request max | First-request p99 | Max active | New/reused |`,
      `|---|---:|---:|---:|---:|---:|---:|`,
      rows.join("\n"),
      "",
    );
  }

  if (Array.isArray(report.workerHeartbeatPhaseSummary) && report.workerHeartbeatPhaseSummary.length > 0) {
    const rows = report.workerHeartbeatPhaseSummary.slice(0, 8).map((entry) => (
      `| ${entry.phase} | ${entry.maxMs}ms | ${entry.p99Ms}ms | ${entry.p95Ms}ms | ${entry.count} | ${entry.samples} |`
    ));
    sections.push(
      "## Worker Heartbeat Phase Timing",
      "",
      `| Phase | Max | p99 | p95 | Count | Schedz samples |`,
      `|---|---:|---:|---:|---:|---:|`,
      rows.join("\n"),
      "",
    );
  }

  if (report.stalled === true || report.livezMaxMs > 3000 || report.schedzSchedulingMaxMs > 3000) {
    sections.push("**Scheduling spike detected.** See /schedz scheduling timing values above.\n");
  } else {
    sections.push("**No significant scheduling anomaly detected.**\n");
  }

  if (report.schedzConnectionSummary?.httpServer) {
    const http = report.schedzConnectionSummary.httpServer;
    sections.push(
      "## HTTP Server Connection Settings",
      "",
      "| Setting | Value |",
      "|---|---:|",
      `| keepAliveTimeout | ${http.keepAliveTimeoutMs ?? "N/A"}ms |`,
      `| headersTimeout | ${http.headersTimeoutMs ?? "N/A"}ms |`,
      `| requestTimeout | ${http.requestTimeoutMs ?? "N/A"}ms |`,
      `| timeout | ${http.timeoutMs ?? "N/A"}ms |`,
      `| maxRequestsPerSocket | ${http.maxRequestsPerSocket ?? "N/A"} |`,
      `| maxConnections | ${http.maxConnections ?? "N/A"} |`,
      `| connectionsCheckingInterval | ${http.connectionsCheckingIntervalMs ?? "N/A"}ms |`,
      "",
    );
  }

  if (report.livezAttribution) {
    sections.push(
      "## Likely /livez Attribution",
      "",
      `| Field | Value |`,
      `|---|---|`,
      `| Bucket | ${report.livezAttribution.bucket} |`,
      `| Confidence | ${report.livezAttribution.confidence} |`,
      `| Reasons | ${report.livezAttribution.reasons.join("; ")} |`,
      "",
    );
  }

  if (report.livezSpikeCorrelation) {
    const corr = report.livezSpikeCorrelation;
    const bucketLine = (name, bucket) => (
      `| ${name} | ${bucket.count} | ${bucket.maxWallMs}ms | ${bucket.maxSocketAgeBeforeHandlerMs}ms | ${bucket.maxSocketIdleBeforeRequestMs}ms | ${bucket.maxClientToServerStartLagMs}ms | ${bucket.maxClientToSocketConnectedLagMs}ms |`
    );
    sections.push(
      "## /livez Spike Correlation",
      "",
      `Threshold: >${corr.thresholdMs}ms; slow samples: ${corr.slowSamples}/${corr.totalSamples} (${corr.slowSharePct}%).`,
      "",
      `| Connection class | Slow samples | Max wall | Max socket→handler | Max socket idle | Max client→handler | Max client→socket |`,
      `|---|---:|---:|---:|---:|---:|---:|`,
      bucketLine("first request on socket", corr.byConnectionReuse.firstRequest),
      bucketLine("reused socket", corr.byConnectionReuse.reusedSocket),
      bucketLine("unknown", corr.byConnectionReuse.unknown),
      "",
    );

    if (Array.isArray(corr.topSlowSamples) && corr.topSlowSamples.length > 0) {
      sections.push(
        "| Index | Timestamp | /livez | Socket index | Reused? | Socket→request event | Request event→handler | Reused idle→request event | Reused idle→data | Reused data→request event | Socket→handler | Client→handler | Server prepared→headers |",
        "|---:|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
        ...corr.topSlowSamples.map((sample) => (
          `| ${sample.index ?? "N/A"} | ${sample.timestamp ?? "N/A"} | ${sample.livezWallMs} | ${sample.socketRequestIndex ?? "N/A"} | ${sample.socketHadServedRequest ?? "N/A"} | ${sample.socketAcceptedToHttpRequestEventMs ?? "N/A"} | ${sample.httpRequestEventToHandlerStartMs ?? "N/A"} | ${sample.socketIdleBeforeHttpRequestEventMs ?? "N/A"} | ${sample.reuseIdleBeforeDataMs ?? "N/A"} | ${sample.reuseDataToHttpRequestEventMs ?? "N/A"} | ${sample.socketAgeBeforeHandlerMs ?? "N/A"} | ${sample.clientToServerStartLagMs ?? "N/A"} | ${sample.serverPreparedToClientHeadersMs ?? "N/A"} |`
        )),
        "",
      );
    }
  }

  // /livez internal handler timing
  if (report.livezTimingSummary) {
    sections.push("## /livez Internal Handler Timing");
    sections.push("");

    const lt = report.livezTimingSummary;
    if (lt.handlerRequestDurationMs) {
      sections.push(
        "### Handler requestDurationMs",
        "",
        `| Metric | Value |`,
        `|---|---|`,
        `| Min | ${lt.handlerRequestDurationMs.min}ms |`,
        `| Max | ${lt.handlerRequestDurationMs.max}ms |`,
        `| Avg | ${lt.handlerRequestDurationMs.avg}ms |`,
        `| Samples | ${lt.handlerRequestDurationMs.samples} |`,
        "",
      );
    }
    if (lt.diagMs) {
      sections.push(
        "### Handler diagMs (diagnostic overhead)",
        "",
        `| Metric | Value |`,
        `|---|---|`,
        `| Min | ${lt.diagMs.min}ms |`,
        `| Max | ${lt.diagMs.max}ms |`,
        `| Avg | ${lt.diagMs.avg}ms |`,
        `| Samples | ${lt.diagMs.samples} |`,
        "",
      );
    }
    if (lt.eventLoopDelayMs) {
      sections.push(
        "### Event Loop Delay",
        "",
        `| Metric | Value |`,
        `|---|---|`,
        `| Min | ${lt.eventLoopDelayMs.min}ms |`,
        `| Max | ${lt.eventLoopDelayMs.max}ms |`,
        `| Samples | ${lt.eventLoopDelayMs.samples} |`,
        "",
      );
    }
    if (lt.cpuPercent) {
      sections.push(
        "### Broker CPU % (delta since last /livez check)",
        "",
        `| Metric | Value |`,
        `|---|---|`,
        `| Min | ${lt.cpuPercent.min}% |`,
        `| Max | ${lt.cpuPercent.max}% |`,
        `| Avg | ${lt.cpuPercent.avg}% |`,
        `| Samples | ${lt.cpuPercent.samples} |`,
        "",
      );
    }
  }

  // Host metrics
  if (report.hostMetricsSummary) {
    sections.push("## Host-Level Diagnostics");
    sections.push("");
    const h = report.hostMetricsSummary;

    if (h.loadAverage) {
      sections.push(
        "### Load Average",
        "",
        `| Metric | Value |`,
        `|---|---|`,
        `| Load 1m | ${h.loadAverage.load1} |`,
        `| Load 5m | ${h.loadAverage.load5} |`,
        `| Load 15m | ${h.loadAverage.load15} |`,
        `| Running processes | ${h.loadAverage.running} |`,
        `| Total processes | ${h.loadAverage.total} |`,
        "",
      );
    }

    if (h.procPressure) {
      const pres = h.procPressure;
      sections.push("### /proc/pressure");
      sections.push("");
      for (const resource of ["cpu", "memory", "io"]) {
        if (pres[resource]) {
          const lines = [];
          for (const [k, v] of Object.entries(pres[resource])) {
            lines.push(`| ${resource}.${k} | ${v} |`);
          }
          if (lines.length > 0) {
            sections.push(`| Resource | Value |`);
            sections.push(`|---|---|`);
            sections.push(lines.join("\n"));
            sections.push("");
          }
        }
      }
    }

    if (h.processUptimeSec !== undefined) {
      sections.push(`Probe process uptime: ${h.processUptimeSec}s`);
      sections.push("");
    }

    if (h.dockerStats) {
      const d = h.dockerStats;
      sections.push(
        "### Docker Container Stats",
        "",
        `| Metric | Value |`,
        `|---|---|`,
        `| CPU % | ${d.cpuPercent !== null ? d.cpuPercent : "N/A"} |`,
        `| Memory bytes | ${d.memBytes !== null ? d.memBytes : "N/A"} |`,
        `| Memory limit | ${d.memLimitBytes !== null ? d.memLimitBytes : "N/A"} |`,
        `| Memory % | ${d.memPercent !== null ? d.memPercent : "N/A"} |`,
        `| PIDs | ${d.pids !== null ? d.pids : "N/A"} |`,
        "",
      );
    }
  }

  // Notable correlated probes
  const notableProbes = report.correlatedProbes.filter(
    (cp) => cp.livezWallMs > 1000 || cp.schedzWallMs > 1000 || (cp.host?.loadAverage?.load1 ?? 0) > 2,
  );
  if (notableProbes.length > 0) {
    sections.push(
      "## Notable Correlated Probes",
      "",
      "| Timestamp | /livez (ms) | /schedz (ms) | Handler (ms) | Client→server start (ms) | Socket→handler (ms) | Server prepared→headers (ms) | Sched p50/p95/p99 (ms) | Host Load 1m |",
      "|---|---|---|---|---|---|---|---|---|",
      ...notableProbes.slice(0, 10).map((cp) => {
        const schedTiming = cp.schedzTimingSnapshot
          ? `${cp.schedzTimingSnapshot.p50Ms}/${cp.schedzTimingSnapshot.p95Ms}/${cp.schedzTimingSnapshot.p99Ms}`
          : "N/A";
        const handlerMs = cp.livezHandling?.requestDurationMs ?? "N/A";
        const clientToServer = cp.livezClientTiming?.clientToServerStartLagMs ?? "N/A";
        const socketToHandler = cp.livezClientTiming?.socketAgeBeforeHandlerMs ?? "N/A";
        const serverToHeaders = cp.livezClientTiming?.serverPreparedToClientHeadersMs ?? "N/A";
        const load1 = cp.host?.loadAverage?.load1 ?? "N/A";
        return `| ${cp.timestamp} | ${cp.livezWallMs} | ${cp.schedzWallMs} | ${handlerMs} | ${clientToServer} | ${socketToHandler} | ${serverToHeaders} | ${schedTiming} | ${load1} |`;
      }),
      "",
    );
  }

    // Container diagnostics from /schedz (cgroup CPU throttling + PSI)
  const containerSummary = report.schedzContainerSummary;
  if (containerSummary && containerSummary.cgroupCpu) {
    const cpu = containerSummary.cgroupCpu;
    const limit = containerSummary.cpuLimit;
    const psi = containerSummary.psi;
    const rows = [
      "| Metric | Value |",
      "|---|---|",
    ];
    if (typeof cpu.nrThrottled === "number") {
      rows.push(`| cgroup nr_throttled / nr_periods | ${cpu.nrThrottled} / ${cpu.nrPeriods} (${cpu.nrPeriods > 0 ? (cpu.nrThrottled / cpu.nrPeriods * 100).toFixed(1) : "N/A"}%) |`);
    }
    if (typeof cpu.throttledUsec === "number" && cpu.throttledUsec > 0) {
      rows.push(`| cgroup throttled_usec | ${(cpu.throttledUsec / 1_000).toFixed(0)}ms |`);
    }
    if (typeof cpu.usageUsec === "number") {
      rows.push(`| cgroup usage_usec | ${(cpu.usageUsec / 1_000_000).toFixed(0)}s |`);
    }
    if (limit) {
      rows.push(`| cgroup cpu.max | ${limit.cpus > 0 ? `${limit.cpus.toFixed(1)} CPUs` : "unlimited"} (quota=${limit.quotaUsec}/${limit.periodUsec}) |`);
    }
    if (psi?.cpu) {
      rows.push(`| PSI cpu some avg10/60/300 | ${psi.cpu.some.avg10}% / ${psi.cpu.some.avg60}% / ${psi.cpu.some.avg300}% |`);
      rows.push(`| PSI cpu full avg10/60/300 | ${psi.cpu.full.avg10}% / ${psi.cpu.full.avg60}% / ${psi.cpu.full.avg300}% |`);
    }
    sections.push(
      "## Container / Cgroup Diagnostics",
      "",
      ...rows,
      "",
    );
  }

  sections.push(
    "## Gate Checks",
    "",
    ...report.checks.map((check) => `- ${check.ok ? "✅ PASS" : "❌ FAIL"} **${check.check}**: ${check.detail}`),
    "",
    "## Safety",
    "",
    "- Broker HTTP requested: GET only (/livez, /schedz)",
    "- Host metrics: read-only /proc files and optional docker stats (one-shot)",
    "- Provider/live Telegram called: no",
    "- DB mutation attempted: no",
    "- Terminal-outbox ACK attempted: no",
    "- Gateway restart/deploy: no",
    "",
  );

  return sections.filter(Boolean).join("\n").trim();
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runDiagnostics(options);

  if (options.markdown && !options.json) {
    console.log(renderMarkdown(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`broker-comprehensive-diagnostics: ${error.message}`);
    process.exit(2);
  });
}
