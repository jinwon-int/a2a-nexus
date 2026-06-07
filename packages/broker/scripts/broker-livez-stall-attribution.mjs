#!/usr/bin/env node
// Bounded loopback /livez measurement script for residual stall attribution.
//
// Measures bounded HTTP GET probes against the broker /livez endpoint and
// produces a gate report with summary statistics (failures, max, p50, p95,
// p99, samples above 1s/3s, slow-sample timestamps).  Additionally samples
// host-level metrics (process CPU, load average, docker container stats,
// /proc pressure) and correlates them per-probe with the in-broker /livez
// attribution fields (eventLoop delay, CPU delta, GC diagnostics, handler
// timing).  Intended for loopback/broker-local use only — never deploys,
// restarts Gateway, sends Telegram, mutates broker state, or ACKs
// terminal-outbox records.
//
// Issue: https://github.com/jinwon-int/a2a-broker/issues/1044
// Parent: https://github.com/jinwon-int/a2a-broker/issues/1032

import process from "node:process";
import fs from "node:fs";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_COUNT = 20;
const DEFAULT_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LIVEZ_CONNECTION_MODE = "default";
const LIVEZ_CONNECTION_MODE_LIST = ["default", "fresh", "keep-alive"];
const LIVEZ_CONNECTION_MODES = new Set(LIVEZ_CONNECTION_MODE_LIST);
const REQUESTER_ID = "broker-livez-stall-attribution";
const ISSUE = "#1044";
const PARENT_ISSUE = "#1032";

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
    count: Number(readOption("--count") ?? process.env.LIVEZ_MEASURE_COUNT ?? DEFAULT_COUNT),
    intervalMs: Number(readOption("--interval") ?? process.env.LIVEZ_INTERVAL_MS ?? DEFAULT_INTERVAL_MS),
    timeoutMs: Number(readOption("--timeout") ?? process.env.LIVEZ_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    noLive: argv.includes("--no-live") || argv.includes("--dry-run"),
    simulateStall: argv.includes("--simulate-stall"),
    markdown: argv.includes("--markdown") || argv.includes("--format=markdown"),
    json: argv.includes("--json") || argv.includes("--format=json"),
    collectHostMetrics: !argv.includes("--no-host-metrics"),
    allModes: argv.includes("--all-modes"),
    edgeSecret: optionalString(
      readOption("--edge-secret")
        ?? process.env.BROKER_EDGE_SECRET
        ?? process.env.A2A_BROKER_EDGE_SECRET
        ?? process.env.EDGE_SECRET
        ?? process.env.A2A_EDGE_SECRET,
    ),
    livezConnectionMode: parseLivezConnectionMode(
      readOption("--livez-connection-mode") ?? process.env.LIVEZ_CONNECTION_MODE ?? DEFAULT_LIVEZ_CONNECTION_MODE,
    ),
  };
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseLivezConnectionMode(value) {
  if (!LIVEZ_CONNECTION_MODES.has(value)) {
    throw new Error(`--livez-connection-mode must be one of: ${LIVEZ_CONNECTION_MODE_LIST.join(", ")}`);
  }
  return value;
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function isLoopbackHttpUrl(value) {
  if (!isHttpUrl(value)) return false;
  try {
    const { hostname } = new URL(value);
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname === "[::1]";
  } catch {
    return false;
  }
}

function assertSafeEdgeSecretDestination(baseUrl, edgeSecret) {
  if (!edgeSecret || isLoopbackHttpUrl(baseUrl)) return;
  throw new Error("--base-url must be loopback when sending an edge secret");
}

function roundProbeMs(rawMs) {
  return Math.round(rawMs * 100) / 100;
}

// ---------------------------------------------------------------------------
// Percentile computation
// ---------------------------------------------------------------------------

function percentile(sorted, pct) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[clamp(idx, 0, sorted.length - 1)];
}

// ---------------------------------------------------------------------------
// Host-level metric sampling (read-only, fails silently)
// ---------------------------------------------------------------------------

/**
 * Read /proc/loadavg for 1/5/15-minute load averages and running/total
 * process counts.  Returns null when /proc is unavailable.
 *
 * @returns {{ load1: number, load5: number, load15: number, running: number, total: number }|null}
 */
export function readLoadAverage() {
  try {
    const raw = fs.readFileSync("/proc/loadavg", "utf8", { flag: "r" }).trim();
    if (!raw) return null;
    const parts = raw.split(/\s+/);
    if (parts.length < 5) return null;
    return {
      load1: parseFloat(parts[0]),
      load5: parseFloat(parts[1]),
      load15: parseFloat(parts[2]),
      running: parseInt(parts[3].split("/")[0], 10),
      total: parseInt(parts[3].split("/")[1], 10),
    };
  } catch {
    return null;
  }
}

/**
 * Read /proc/pressure/{cpu,memory,io} when CONFIG_PSI is enabled on the
 * host.  Returns null when unavailable.
 *
 * @returns {{ cpu: object|null, memory: object|null, io: object|null }|null}
 */
export function readProcPressure() {
  const result = { cpu: null, memory: null, io: null };
  for (const resource of ["cpu", "memory", "io"]) {
    try {
      const raw = fs.readFileSync(`/proc/pressure/${resource}`, "utf8", { flag: "r" }).trim();
      if (!raw) continue;
      const fields = {};
      for (const token of raw.split(/\s+/)) {
        const kv = token.split("=");
        if (kv.length === 2) fields[kv[0]] = parseFloat(kv[1]);
      }
      if (Object.keys(fields).length > 0) result[resource] = fields;
    } catch {
      // pressure files may not exist
    }
  }
  if (!result.cpu && !result.memory && !result.io) return null;
  return result;
}

/**
 * Read /proc/stat for aggregate CPU ticks.  Returns null when unavailable.
 *
 * @returns {number[]|null} CPU ticks array or null
 */
export function readCpuTicks() {
  try {
    const raw = fs.readFileSync("/proc/stat", "utf8", { flag: "r" }).trim();
    if (!raw) return null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("cpu ")) {
        return line.split(/\s+/).slice(1).map(Number);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Sample docker container stats for the given container name/id.
 * Falls back to `docker stats --no-stream` for the current container.
 * Returns null when docker is unavailable or the container isn't found.
 *
 * @param {string} [containerName] - Container name or id (default "a2a-broker")
 * @returns {Promise<{ cpuPercent: number|null, memBytes: number|null, memPercent: number|null, netRx: number|null, netTx: number|null, blockR: number|null, blockW: number|null }|null>}
 */
async function readDockerContainerStats(containerName = "a2a-broker") {
  try {
    const { execSync } = await import("node:child_process");
    // Try to find the container name from within (default to self or a2a-broker)
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
      memPercent: parsePercent(raw.MemPerc),
      netRx: null, // docker stats --no-stream doesn't give streaming net I/O in one-shot
      netTx: null,
      blockR: null,
      blockW: null,
    };
  } catch {
    return null;
  }
}

/**
 * Collect bounded host diagnostics synchronously.  Safe to call from any
 * probe context -- all reads are read-only and gracefully handle missing
 * files/permission errors.
 *
 * Returns an object with typed host metric fields, or null on total failure.
 */
export function collectHostDiagnostics() {
  return {
    loadAverage: readLoadAverage(),
    procPressure: readProcPressure(),
    cpuTicks: readCpuTicks(),
    // process.uptime and process.cpuUsage are always available
    processUptimeSec: Math.round(process.uptime()),
  };
}

/**
 * Collect host diagnostics including docker stats (async, may try the
 * docker CLI).  Kept separate from the sync collector so the synchronous
 * path remains usable for the no-live / synthetic test path.
 *
 * @param {string} [containerName]
 * @returns {Promise<object>}
 */
async function collectHostDiagnosticsAsync(containerName) {
  const sync = collectHostDiagnostics();
  const dockerStats = await readDockerContainerStats(containerName);
  return { ...sync, dockerStats };
}

// ---------------------------------------------------------------------------
// /livez attribution field extraction
// ---------------------------------------------------------------------------

/**
 * Extract the in-broker attribution fields from a parsed /livez JSON body.
 * All fields returned by the broker's /livez handler are preserved.
 *
 * @param {object|null} body - Parsed JSON /livez response body
 * @returns {{ eventLoop: object|null, cpu: object|null, gc: object|null, timing: object|null, diagMs: number|null, uptimeSec: number|null }|null}
 */
export function extractLivezAttribution(body) {
  if (!body || typeof body !== "object") return null;
  const probeTiming = body.probeTiming ?? null;
  return {
    eventLoop: body.eventLoop ?? null,
    cpu: body.cpu ?? null,
    gc: body.gc ?? null,
    timing: body.timing ?? null,
    diagMs: typeof body.diagMs === "number" ? body.diagMs : null,
    uptimeSec: typeof body.uptimeSec === "number" ? body.uptimeSec : null,
    brokerCpuPercent: body.cpu?.percentSinceLastCheck ?? null,
    brokerCpuDeltaIntervalMs: body.cpu?.deltaIntervalMs ?? null,
    eventLoopDelayMs: body.eventLoop?.delayMs ?? null,
    // Client-side timing fields echoed from x-a2a-probe-start-unix-ms (#1108)
    socketHadServedRequest: probeTiming?.socketHadServedRequest ?? null,
    socketRequestIndex: typeof probeTiming?.socketRequestIndex === "number" ? probeTiming.socketRequestIndex : null,
    socketAgeBeforeHandlerMs: typeof probeTiming?.socketAgeBeforeHandlerMs === "number" ? probeTiming.socketAgeBeforeHandlerMs : null,
    clientProbeStartToHandlerStartMs: typeof probeTiming?.clientProbeStartToHandlerStartMs === "number" ? probeTiming.clientProbeStartToHandlerStartMs : null,
    clientProbeStartToSocketConnectedMs: typeof probeTiming?.clientProbeStartToSocketConnectedMs === "number" ? probeTiming.clientProbeStartToSocketConnectedMs : null,
    clientProbeStartToHttpRequestEventMs: typeof probeTiming?.clientProbeStartToHttpRequestEventMs === "number" ? probeTiming.clientProbeStartToHttpRequestEventMs : null,
    socketIdleBeforeHttpRequestEventMs: typeof probeTiming?.socketIdleBeforeHttpRequestEventMs === "number" ? probeTiming.socketIdleBeforeHttpRequestEventMs : null,
    handlerStartUnixMs: typeof probeTiming?.handlerStartUnixMs === "number" ? probeTiming.handlerStartUnixMs : null,
    responsePreparedUnixMs: typeof probeTiming?.responsePreparedUnixMs === "number" ? probeTiming.responsePreparedUnixMs : null,
    // Concurrent request load at the moment of this probe (#1032 antithesis)
    activeRequests: typeof body.activeRequests === "number" ? body.activeRequests : null,
    requestDurationMs: typeof body.requestDurationMs === "number" ? body.requestDurationMs : null,
  };
}

// ---------------------------------------------------------------------------
// Probe types
// ---------------------------------------------------------------------------

/**
 * @typedef {{ ok: boolean, status: number, durationMs: number, timestamp: string, error?: string }} ProbeResult
 *
 * @typedef {object} LivezAttribution
 * @property {object|null} eventLoop
 * @property {object|null} cpu
 * @property {object|null} gc
 * @property {object|null} timing
 * @property {number|null} diagMs
 * @property {number|null} uptimeSec
 * @property {number|null} brokerCpuPercent
 * @property {number|null} brokerCpuDeltaIntervalMs
 * @property {number|null} eventLoopDelayMs
 * @property {number|null} activeRequests - Concurrent request count at probe time
 * @property {number|null} requestDurationMs - Handler execution duration for this specific request
 *
 * @typedef {object} HostDiagnostics
 * @property {object|null} loadAverage
 * @property {object|null} procPressure
 * @property {number[]|null} cpuTicks
 * @property {number} processUptimeSec
 * @property {object|null} dockerStats
 *
 * @typedef {object} CorrelatedProbe
 * @property {ProbeResult} probe
 * @property {LivezAttribution|null} attribution
 * @property {HostDiagnostics|null} host
 *
 * @typedef {Object} LivezMeasurementReport
 * @property {string} kind - Report discriminator
 * @property {string} issue
 * @property {string} parent
 * @property {string} mode - "no-live" | "live"
 * @property {string} baseUrl
 * @property {number} probeCount - Total probes sent
 * @property {number} failureCount - Probes that failed (non-200 or error)
 * @property {number} maxDurationMs - Slowest probe
 * @property {number} p50DurationMs
 * @property {number} p95DurationMs
 * @property {number} p99DurationMs
 * @property {number} samplesAbove1s - Count of probes > 1000ms
 * @property {number} samplesAbove3s - Count of probes > 3000ms
 * @property {Array<{timestamp: string, durationMs: number, status: number, error?: string}>} slowSamples
 * @property {boolean} stalled - true if max > 3s or failure rate >= 10%
 * @property {boolean} ok - Overall gate verdict
 * @property {object|null} hostMetricsSummary - Aggregate host-level metrics snapshot
 * @property {object[]} correlatedProbes - Per-probe correlation data (first 40 probes max)
 * @property {object|null} livezAttributionSummary - Summary of in-broker attribution fields
 * @property {object|null} schedzOperatorGate - Server-side operatorGate from /schedz (null if unavailable)
 * @property {{p50Ms:number,p95Ms:number,p99Ms:number,maxMs:number,averageMs:number,samples:number}|null} schedzHandlerBodyTiming -
 *   Handler body timing window from /schedz.perRequest.handlerMs (null if unavailable).
 *   This records the handler body duration (handlerStart to flush) across ALL endpoints, not just /livez.
 *   If elevated despite fast /livez diagMs, a different endpoint is the cause.
 * @property {Object<string,{probeCount:number,failureCount:number,maxDurationMs:number,p50DurationMs:number,p95DurationMs:number,p99DurationMs:number,samplesAbove1s:number,samplesAbove3s:number,stalled:boolean,ok:boolean}>|null} byConnectionMode - Per-connection-mode breakdown when --all-modes is used
 */

/**
 * Produce a no-live synthetic report for tests / --dry-run.
 *
 * @param {object} [options]
 * @param {number} [options.count]
 * @param {boolean} [options.simulateStall]
 * @param {boolean} [options.collectHostMetrics]
 * @returns {LivezMeasurementReport}
 */
export function runNoLiveMeasurement(options = {}) {
  const count = clamp(options.count ?? DEFAULT_COUNT, 1, 200);
  const simulateStall = options.simulateStall === true;
  const collectHostMetrics = options.collectHostMetrics !== false;
  const syntheticDurations = Array.from({ length: count }, (_, i) => 8 + (i % 13));
  if (simulateStall && count >= 1) {
    syntheticDurations[count - 1] = 4200; // one timeout-like probe above 3s
  }
  if (simulateStall && count >= 2) {
    syntheticDurations[count - 2] = 1502; // one probe above 1s
  }

  const sorted = [...syntheticDurations].sort((a, b) => a - b);
  const slowSamples = syntheticDurations
    .map((d, i) => ({ durationMs: d, timestamp: new Date(Date.now() - (count - i) * 200).toISOString(), status: d > 3000 ? 0 : 200, error: d > 3000 ? "timeout" : undefined }))
    .filter((s) => s.durationMs > 1000);

  const failureCount = syntheticDurations.filter((d) => d > 3000).length;
  const maxDurationMs = sorted[sorted.length - 1];
  const samplesAbove1s = syntheticDurations.filter((d) => d > 1000).length;
  const samplesAbove3s = syntheticDurations.filter((d) => d > 3000).length;

  // Build host metrics summary (synthetic / no-live test path)
  const hostMetricsSummary = collectHostMetrics ? collectHostDiagnostics() : null;

  // Build gate checks
  const checks = [
    ok("probe count", `${count} probes sent`),
    maxDurationMs > 3000
      ? fail("max latency gate", `max ${maxDurationMs}ms exceeds 3000ms threshold`, { maxDurationMs, thresholdMs: 3000 })
      : ok("max latency gate", `${maxDurationMs}ms within threshold`),
    samplesAbove3s > 0
      ? fail("samples above 3s gate", `${samplesAbove3s} sample(s) exceeded 3s`, { samplesAbove3s })
      : ok("samples above 3s gate", `${samplesAbove3s} sample(s) above 3s`),
    failureCount / count >= 0.1
      ? fail("failure rate gate", `${failureCount}/${count} (${Math.round((failureCount / count) * 100)}%) failures >= 10%`, { failureCount, totalProbes: count })
      : ok("failure rate gate", `${failureCount}/${count} failures OK`),
    ok("safety gate", "read-only loopback measurement; no deploy, Gateway restart, Telegram send, DB mutation, or terminal-outbox ACK"),
    ok("host metrics", collectHostMetrics ? "host-level sampling enabled" : "host-level sampling disabled"),
  ];

  return {
    kind: "a2a-broker.livez-stall-attribution.v1",
    issue: ISSUE,
    parent: PARENT_ISSUE,
    mode: simulateStall ? "no-live-simulated-stall" : "no-live",
    baseUrl: "http://no-live.synthetic",
    probeCount: count,
    failureCount,
    maxDurationMs,
    p50DurationMs: percentile(sorted, 50),
    p95DurationMs: percentile(sorted, 95),
    p99DurationMs: percentile(sorted, 99),
    samplesAbove1s,
    samplesAbove3s,
    slowSamples: slowSamples.slice(0, 20),
    stalled: maxDurationMs > 3000 || failureCount / count >= 0.1,
    hostMetricsSummary,
    correlatedProbes: [],
    livezAttributionSummary: null,
    byConnectionMode: null,
    checks,
    ok: checks.every((c) => c.ok),
  };
}

// ---------------------------------------------------------------------------
// Live measurement (with host-level and attribution correlation)
// ---------------------------------------------------------------------------

/**
 * Run bounded /livez probes against a live broker, collecting host-level
 * metrics and in-broker attribution fields alongside each probe.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {number} [options.count]
 * @param {number} [options.intervalMs]
 * @param {number} [options.timeoutMs]
 * @param {typeof globalThis.fetch} [options.fetchImpl]
 * @param {boolean} [options.collectHostMetrics]
 * @returns {Promise<LivezMeasurementReport>}
 */
export async function runLiveMeasurement(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime");
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const count = clamp(options.count ?? DEFAULT_COUNT, 1, 200);
  const intervalMs = clamp(options.intervalMs ?? DEFAULT_INTERVAL_MS, 0, 10_000);
  const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100, 30_000);
  const collectHostMetrics = options.collectHostMetrics !== false;
  const livezConnectionMode = options.livezConnectionMode ?? DEFAULT_LIVEZ_CONNECTION_MODE;
  const edgeSecret = optionalString(options.edgeSecret);
  assertSafeEdgeSecretDestination(baseUrl, edgeSecret);

  /** @type {number[]} */
  const durations = [];
  /** @type {ProbeResult[]} */
  const probes = [];
  /** @type {CorrelatedProbe[]} */
  const correlatedProbes = [];

  // Capture a host baseline before the measurement loop.
  /** @type {HostDiagnostics|null} */
  let hostBaseline = null;
  if (collectHostMetrics) {
    hostBaseline = collectHostDiagnostics();
  }

  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    const timestamp = new Date().toISOString();
    const livezClientStartUnixMs = Date.now();
    let probeResult;
    /** @type {LivezAttribution|null} */
    let attribution = null;

    try {
      const abort = AbortSignal.timeout(timeoutMs);
      const url = new URL("/livez", ensureTrailingSlash(baseUrl));
      const probeHeaders = {
        accept: "application/json",
        "x-a2a-requester-id": REQUESTER_ID,
        "x-a2a-requester-role": "operator",
        "x-a2a-probe-start-unix-ms": String(livezClientStartUnixMs),
      };
      if (livezConnectionMode === "fresh") {
        probeHeaders.connection = "close";
      } else if (livezConnectionMode === "keep-alive") {
        probeHeaders.connection = "keep-alive";
      }
      const response = await fetchImpl(url, {
        method: "GET",
        headers: probeHeaders,
        signal: abort,
      });
      const t1 = performance.now();
      const durationMs = Math.round(t1 - t0);

      if (response.ok) {
        // Try to parse the response body for attribution fields.
        try {
          const body = await response.clone().json();
          attribution = extractLivezAttribution(body);
        } catch {
          // Non-JSON /livez response; attribution unavailable.
        }
        probeResult = { ok: true, status: response.status, durationMs, timestamp };
      } else {
        probeResult = { ok: false, status: response.status, durationMs, timestamp, error: `HTTP ${response.status}` };
      }
    } catch (error) {
      const t1 = performance.now();
      const durationMs = Math.round(t1 - t0);
      probeResult = {
        ok: false,
        status: 0,
        durationMs,
        timestamp,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      };
    }

    durations.push(probeResult.durationMs);
    probes.push(probeResult);

    // Collect host diagnostics for this probe (async path also tries docker)
    if (collectHostMetrics) {
      const hostAtProbe = collectHostDiagnostics();
      correlatedProbes.push({
        probe: {
          timestamp: probeResult.timestamp,
          durationMs: probeResult.durationMs,
          status: probeResult.status,
          error: probeResult.error,
        },
        attribution,
        host: hostAtProbe,
      });
    }

    // Pace between probes (but not after last)
    if (i < count - 1 && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  // Try docker stats once at the end (safe, non-blocking)
  let dockerStats = null;
  if (collectHostMetrics) {
    try {
      dockerStats = await readDockerContainerStats();
    } catch {
      // docker not available
    }
  }

  // Query /schedz for server-side operatorGate classification (#1032).
  // Cross-correlates observed /livez stalls with the in-broker stall
  // classifier that uses aggregate timing windows broken down by
  // connection reuse (fresh vs reused) and lifecycle phase
  // (accept→request-event→handler).
  let schedzOperatorGate = null;
  /** @type {{p50Ms:number,p95Ms:number,p99Ms:number,maxMs:number,averageMs:number,samples:number}|null} */
  let schedzHandlerBodyTiming = null;
  /** @type {Object<string,{p50Ms:number,p95Ms:number,p99Ms:number,maxMs:number,averageMs:number,samples:number}|null>|null} */
  let endpointHandlerBodyTiming = null;
  /** @type {Object<string,{p50Ms:number,p95Ms:number,p99Ms:number,maxMs:number,averageMs:number,samples:number}|null>|null} */
  let routeHandlerBodyTiming = null;
  try {
    const schedzUrl = new URL("/schedz", ensureTrailingSlash(baseUrl));
    const schedzHeaders = edgeSecret
      ? { accept: "application/json", "x-a2a-edge-secret": edgeSecret }
      : { accept: "application/json" };
    const schedzResponse = await fetchImpl(schedzUrl, {
      method: "GET",
      headers: schedzHeaders,
      // generous timeout; /schedz is O(1) but may be under load
      signal: AbortSignal.timeout(timeoutMs * 2),
    });
    if (schedzResponse.ok) {
      const schedzBody = await schedzResponse.json();
      schedzOperatorGate = schedzBody.operatorGate ?? null;
      // Also extract the handler body timing window (#1032 antithesis).
      // This is the aggregate handler body duration across ALL endpoints.
      // If elevated while /livez diagMs is fast, a different endpoint is
      // causing the apparent handler-body contribution.
      const handlerMs = schedzBody?.perRequest?.handlerMs;
      if (handlerMs && typeof handlerMs.p99Ms === "number") {
        schedzHandlerBodyTiming = {
          p50Ms: handlerMs.p50Ms,
          p95Ms: handlerMs.p95Ms,
          p99Ms: handlerMs.p99Ms,
          maxMs: handlerMs.maxMs,
          averageMs: handlerMs.averageMs,
          samples: handlerMs.samples,
        };
      }
      // Per-endpoint handler body timing (#1032 thesis).  Lets the gate
      // distinguish "global handler body is slow because of another endpoint"
      // from "/livez handler body is slow."
      const endpointBody = schedzBody?.endpointHandlerBodyTiming;
      if (endpointBody && typeof endpointBody === "object") {
        endpointHandlerBodyTiming = {};
        for (const [group, timing] of Object.entries(endpointBody)) {
          if (timing && typeof timing.p99Ms === "number") {
            endpointHandlerBodyTiming[group] = {
              p50Ms: timing.p50Ms,
              p95Ms: timing.p95Ms,
              p99Ms: timing.p99Ms,
              maxMs: timing.maxMs,
              averageMs: timing.averageMs,
              samples: timing.samples,
            };
          } else {
            endpointHandlerBodyTiming[group] = null;
          }
        }
      }
      // Per-route handler body timing (#1032 / #1179). This narrows a
      // broad worker handler-body spike to register/heartbeat/SSE/etc.
      const routeBody = schedzBody?.routeHandlerBodyTiming;
      if (routeBody && typeof routeBody === "object") {
        routeHandlerBodyTiming = {};
        for (const [route, timing] of Object.entries(routeBody)) {
          if (timing && typeof timing.p99Ms === "number") {
            routeHandlerBodyTiming[route] = {
              p50Ms: timing.p50Ms,
              p95Ms: timing.p95Ms,
              p99Ms: timing.p99Ms,
              maxMs: timing.maxMs,
              averageMs: timing.averageMs,
              samples: timing.samples,
            };
          } else {
            routeHandlerBodyTiming[route] = null;
          }
        }
      }
    }
  } catch {
    // /schedz unavailable; correlation gate omitted from report
  }

  return buildReport(durations, probes, {
    baseUrl,
    count,
    mode: "live",
    livezConnectionMode,
    correlatedProbes,
    dockerStats,
    hostBaseline,
    schedzOperatorGate,
    schedzHandlerBodyTiming,
    endpointHandlerBodyTiming,
    routeHandlerBodyTiming,
  });
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

/**
 * Build the gate report from collected probe durations and results.
 *
 * @param {number[]} durations
 * @param {ProbeResult[]} probes
 * @param {{ baseUrl: string, count: number, mode: string, correlatedProbes?: CorrelatedProbe[], dockerStats?: object|null, hostBaseline?: HostDiagnostics|null, livezConnectionMode?: string, byConnectionMode?: Object<string,object>|null, schedzOperatorGate?: object|null, schedzHandlerBodyTiming?: object|null }} meta
 * @returns {LivezMeasurementReport}
 */
function buildReport(durations, probes, meta) {
  const sorted = [...durations].sort((a, b) => a - b);
  const maxDurationMs = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
  const failures = probes.filter((p) => !p.ok || p.status !== 200);
  const failureCount = failures.length;
  const samplesAbove1s = durations.filter((d) => d > 1000).length;
  const samplesAbove3s = durations.filter((d) => d > 3000).length;
  const slowSamples = probes
    .filter((p) => p.durationMs > 1000)
    .slice(0, 20)
    .map((p) => ({ timestamp: p.timestamp, durationMs: p.durationMs, status: p.status, error: p.error }));

  // Summarize host-level metrics from correlated probes
  const correlatedProbes = (meta.correlatedProbes ?? []).slice(0, 40);
  let livezAttributionSummary = null;
  if (correlatedProbes.length > 0) {
    const brokerCpuPct = correlatedProbes
      .map((cp) => cp.attribution?.brokerCpuPercent)
      .filter((v) => v !== null && v !== undefined);
    const eventLoopMs = correlatedProbes
      .map((cp) => cp.attribution?.eventLoopDelayMs)
      .filter((v) => v !== null && v !== undefined);
    const diagMs = correlatedProbes
      .map((cp) => cp.attribution?.diagMs)
      .filter((v) => v !== null && v !== undefined);
    const timings = correlatedProbes
      .map((cp) => cp.attribution?.timing)
      .filter((v) => v !== null && v !== undefined);

    livezAttributionSummary = {
      brokerCpuPercent: brokerCpuPct.length > 0
        ? {
            min: Math.round(Math.min(...brokerCpuPct) * 100) / 100,
            max: Math.round(Math.max(...brokerCpuPct) * 100) / 100,
            avg: Math.round(brokerCpuPct.reduce((a, b) => a + b, 0) / brokerCpuPct.length * 100) / 100,
            samples: brokerCpuPct.length,
          }
        : null,
      eventLoopDelayMs: eventLoopMs.length > 0
        ? {
            min: Math.round(Math.min(...eventLoopMs) * 1000) / 1000,
            max: Math.round(Math.max(...eventLoopMs) * 1000) / 1000,
            samples: eventLoopMs.length,
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
      timingSnapshots: timings.length > 0 ? timings.slice(0, 5) : [],
    };

    // Socket reuse summary from attribution (#1108)
    const socketHadServedRequest = correlatedProbes
      .map((cp) => cp.attribution?.socketHadServedRequest)
      .filter((v) => v !== null && v !== undefined);
    const socketRequestIndex = correlatedProbes
      .map((cp) => cp.attribution?.socketRequestIndex)
      .filter((v) => v !== null && v !== undefined);
    const clientProbeStartToHandlerStartMs = correlatedProbes
      .map((cp) => cp.attribution?.clientProbeStartToHandlerStartMs)
      .filter((v) => v !== null && v !== undefined);
    const clientProbeStartToSocketConnectedMs = correlatedProbes
      .map((cp) => cp.attribution?.clientProbeStartToSocketConnectedMs)
      .filter((v) => v !== null && v !== undefined);

    livezAttributionSummary.socketReuse = {
      freshConnectionCount: socketHadServedRequest.filter((v) => v === false).length,
      reusedConnectionCount: socketHadServedRequest.filter((v) => v === true).length,
      requestIndexRange: socketRequestIndex.length > 0
        ? { min: Math.min(...socketRequestIndex), max: Math.max(...socketRequestIndex) }
        : null,
    };
    livezAttributionSummary.clientProbeStartToHandlerStartMs = clientProbeStartToHandlerStartMs.length > 0
      ? {
          min: roundProbeMs(Math.min(...clientProbeStartToHandlerStartMs)),
          max: roundProbeMs(Math.max(...clientProbeStartToHandlerStartMs)),
          avg: roundProbeMs(clientProbeStartToHandlerStartMs.reduce((a, b) => a + b, 0) / clientProbeStartToHandlerStartMs.length),
          samples: clientProbeStartToHandlerStartMs.length,
        }
      : null;
    livezAttributionSummary.clientProbeStartToSocketConnectedMs = clientProbeStartToSocketConnectedMs.length > 0
      ? {
          min: roundProbeMs(Math.min(...clientProbeStartToSocketConnectedMs)),
          max: roundProbeMs(Math.max(...clientProbeStartToSocketConnectedMs)),
          avg: roundProbeMs(clientProbeStartToSocketConnectedMs.reduce((a, b) => a + b, 0) / clientProbeStartToSocketConnectedMs.length),
          samples: clientProbeStartToSocketConnectedMs.length,
        }
      : null;

    // Concurrent request load and per-request handler duration at probe time
    const activeRequests = correlatedProbes
      .map((cp) => cp.attribution?.activeRequests)
      .filter((v) => v !== null && v !== undefined && typeof v === "number");
    const handlerDurations = correlatedProbes
      .map((cp) => cp.attribution?.requestDurationMs)
      .filter((v) => v !== null && v !== undefined && typeof v === "number");

    livezAttributionSummary.activeRequestCount = activeRequests.length > 0
      ? {
          min: Math.min(...activeRequests),
          max: Math.max(...activeRequests),
          avg: Math.round(activeRequests.reduce((a, b) => a + b, 0) / activeRequests.length * 100) / 100,
          samples: activeRequests.length,
        }
      : null;
    livezAttributionSummary.handlerDurationMs = handlerDurations.length > 0
      ? {
          min: roundProbeMs(Math.min(...handlerDurations)),
          max: roundProbeMs(Math.max(...handlerDurations)),
          p95: roundProbeMs(percentile([...handlerDurations].sort((a, b) => a - b), 95)),
          avg: roundProbeMs(handlerDurations.reduce((a, b) => a + b, 0) / handlerDurations.length),
          samples: handlerDurations.length,
        }
      : null;
  }

  // Host metrics summary: blend baseline + end-of-measurement docker stats
  const hostMetricsSummary = meta.hostBaseline
    ? {
        ...meta.hostBaseline,
        dockerStats: meta.dockerStats ?? null,
      }
    : null;

  const livezConnectionMode = meta.livezConnectionMode ?? "default";
  const schedzOperatorGate = meta.schedzOperatorGate ?? null;
  const schedzHandlerBodyTiming = meta.schedzHandlerBodyTiming ?? null;
  const endpointHandlerBodyTiming = meta.endpointHandlerBodyTiming ?? null;
  const routeHandlerBodyTiming = meta.routeHandlerBodyTiming ?? null;

  // Cross-correlation gate (#1032): if the client observed >1s stalls
  // but the server-side operatorGate says "no-significant-stall", the
  // diagnostic instrumentation has a gap — the stall is invisible to
  // the in-broker timing windows.
  const hasStallButServerSaysNone =
    (samplesAbove1s > 0 || failureCount > 0)
    && schedzOperatorGate !== null
    && schedzOperatorGate.bucket === "no-significant-stall";

  // Handler body timing correlation check (#1032 antithesis).
  // The operatorGate at /schedz classifies stalls based only on
  // socket-level timing windows. It does NOT check handler body timing.
  // If the aggregate handler body window shows p99 > 3s while the
  // operatorGate says "no-significant-stall", the stall may be originating
  // in the handler body of some endpoint (not necessarily /livez).
  // We flag this as a correlation warning.
  const handlerBodyExplainableStall =
    schedzHandlerBodyTiming !== null
    && schedzHandlerBodyTiming.p99Ms > 3000;

  const checks = [
    hasStallButServerSaysNone
      ? fail("operatorGate correlation gate",
          `schedz operatorGate is "no-significant-stall" despite ${samplesAbove1s} sample(s) >1s`,
          { schedzOperatorGate, samplesAbove1s, failureCount })
      : ok("operatorGate correlation gate",
          schedzOperatorGate !== null
            ? `schedz operatorGate bucket: "${schedzOperatorGate.bucket}" (confidence: ${schedzOperatorGate.confidence})`
            : "/schedz operatorGate unavailable; correlation gate skipped"),
    handlerBodyExplainableStall
      // Check if /livez endpoint-specific handler body is also high.
      // If only the global aggregate is high but /livez handler body is
      // tiny, the stall is NOT in the /livez handler body (#1032 thesis).
      ? endpointHandlerBodyTiming?.livez !== null
        && endpointHandlerBodyTiming?.livez?.p99Ms !== null
        && endpointHandlerBodyTiming.livez.p99Ms > 3000
        ? fail("handler body timing gate",
            `schedz handler body p99 ${schedzHandlerBodyTiming.p99Ms}ms (global) ` +
            `AND /livez handler body p99 ${endpointHandlerBodyTiming.livez.p99Ms}ms ` +
            `exceeds 3000ms threshold — cache miss or stall in /livez handler body`,
            { global: { ...schedzHandlerBodyTiming }, livez: { ...endpointHandlerBodyTiming.livez } })
        : ok("handler body timing gate",
            `global handler body p99 ${schedzHandlerBodyTiming.p99Ms}ms ` +
            `but /livez handler body p99 ${endpointHandlerBodyTiming?.livez?.p99Ms ?? "N/A"}ms ` +
            `— stall is in a different endpoint (not /livez). ` +
            `See per-endpoint handler body timing in report for the slow endpoint.`)
      : ok("handler body timing gate",
          schedzHandlerBodyTiming !== null
            ? `handler body p99 ${schedzHandlerBodyTiming.p99Ms}ms within threshold (p50: ${schedzHandlerBodyTiming.p50Ms}ms, max: ${schedzHandlerBodyTiming.maxMs}ms)`
            : "/schedz handler body timing unavailable; gate skipped"),
    ok("probe count", `${meta.count} probes sent`),
    ok("connection mode", `livez connection mode: ${livezConnectionMode}`),
    maxDurationMs > 3000
      ? fail("max latency gate", `max ${maxDurationMs}ms exceeds 3000ms threshold`, { maxDurationMs, thresholdMs: 3000 })
      : ok("max latency gate", `${maxDurationMs}ms within threshold`),
    samplesAbove3s > 0
      ? fail("samples above 3s gate", `${samplesAbove3s} sample(s) exceeded 3s`, { samplesAbove3s })
      : ok("samples above 3s gate", `${samplesAbove3s} sample(s) above 3s`),
    samplesAbove1s > 0
      ? fail("samples above 1s gate", `${samplesAbove1s} sample(s) exceeded 1s`, { samplesAbove1s })
      : ok("samples above 1s gate", `${samplesAbove1s} sample(s) above 1s`),
    failureCount / meta.count >= 0.1
      ? fail("failure rate gate", `${failureCount}/${meta.count} (${Math.round((failureCount / meta.count) * 100)}%) failures >= 10%`, { failureCount, totalProbes: meta.count })
      : ok("failure rate gate", `${failureCount}/${meta.count} failures OK`),
    ok("safety gate", "read-only loopback measurement; no deploy, Gateway restart, Telegram send, DB mutation, or terminal-outbox ACK"),
  ];

  return {
    kind: "a2a-broker.livez-stall-attribution.v1",
    issue: ISSUE,
    parent: PARENT_ISSUE,
    mode: meta.mode,
    baseUrl: meta.baseUrl,
    livezConnectionMode,
    probeCount: meta.count,
    failureCount,
    maxDurationMs,
    p50DurationMs: percentile(sorted, 50),
    p95DurationMs: percentile(sorted, 95),
    p99DurationMs: percentile(sorted, 99),
    samplesAbove1s,
    samplesAbove3s,
    slowSamples,
    stalled: maxDurationMs > 3000 || samplesAbove3s > 0 || failureCount / meta.count >= 0.1,
    hostMetricsSummary,
    correlatedProbes,
    livezAttributionSummary,
    byConnectionMode: meta.byConnectionMode ?? null,
    schedzOperatorGate,
    schedzHandlerBodyTiming,
    endpointHandlerBodyTiming,
    routeHandlerBodyTiming,
    checks,
    ok: checks.every((c) => c.ok),
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run measurement across all three connection modes and produce a
 * unified report with per-mode breakdown.
 *
 * @param {object} [options]
 * @returns {Promise<LivezMeasurementReport>}
 */
async function runAllModesMeasurement(options = {}) {
  const modes = ["default", "fresh", "keep-alive"];
  /** @type {Object<string,object>} */
  const perMode = {};
  let combinedFailed = false;
  let combinedMaxMs = 0;
  let combinedSamplesAbove1s = 0;
  let combinedSamplesAbove3s = 0;

  for (const mode of modes) {
    const modeOpts = { ...options, noLive: options.noLive ?? false, allModes: false, livezConnectionMode: mode };
    // eslint-disable-next-line no-await-in-loop
    const report = await runMeasurement(modeOpts);
    perMode[mode] = {
      probeCount: report.probeCount,
      failureCount: report.failureCount,
      maxDurationMs: report.maxDurationMs,
      p50DurationMs: report.p50DurationMs,
      p95DurationMs: report.p95DurationMs,
      p99DurationMs: report.p99DurationMs,
      samplesAbove1s: report.samplesAbove1s,
      samplesAbove3s: report.samplesAbove3s,
      stalled: report.stalled,
      ok: report.ok,
    };
    if (!report.ok) combinedFailed = true;
    if (report.maxDurationMs > combinedMaxMs) combinedMaxMs = report.maxDurationMs;
    combinedSamplesAbove1s += report.samplesAbove1s;
    combinedSamplesAbove3s += report.samplesAbove3s;
  }

  // Take the first mode's report as the base and decorate with all-modes data
  const firstReport = await runMeasurement({ ...options, noLive: options.noLive ?? false, allModes: false, livezConnectionMode: modes[0] });
  return {
    ...firstReport,
    mode: "all-modes",
    livezConnectionMode: "all",
    stalled: combinedFailed || combinedMaxMs > 3000 || combinedSamplesAbove3s > 0,
    ok: !combinedFailed,
    byConnectionMode: perMode,
  };
}

/**
 * Run measurement (live or no-live, single or all modes).
 *
 * @param {object} [options]
 * @returns {Promise<LivezMeasurementReport>}
 */
export async function runMeasurement(options = {}) {
  if (options.allModes) return runAllModesMeasurement(options);
  return options.noLive ? runNoLiveMeasurement(options) : runLiveMeasurement(options);
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderMarkdown(report) {
  const title = report.ok ? "Done" : "Block";
  const sections = [
    `${title}: ${ISSUE} bounded /livez stall measurement with host/attribution correlation`,
    "",
    `Parent: ${PARENT_ISSUE}`,
    `Mode: ${report.mode}`,
    `Base URL: ${report.baseUrl}`,
    "",
    "---",
    "",
    "## Measurement Summary",
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Probes sent | ${report.probeCount} |`,
    `| Failures | ${report.failureCount} |`,
    `| Max duration | ${report.maxDurationMs}ms |`,
    `| p50 | ${report.p50DurationMs}ms |`,
    `| p95 | ${report.p95DurationMs}ms |`,
    `| p99 | ${report.p99DurationMs}ms |`,
    `| Samples > 1s | ${report.samplesAbove1s} |`,
    `| Samples > 3s | ${report.samplesAbove3s} |`,
    `| Connection mode | ${report.livezConnectionMode ?? "default"} |`,
    `| Stalled | ${report.stalled} |`,
    "",
  ];

  if (report.stalled) {
    sections.push("**Stall detected.** See slow samples below.\n");
  } else {
    sections.push("**No residual stall detected.**\n");
  }

  if (report.slowSamples.length > 0) {
    sections.push(
      "## Slow Samples (>1s)",
      "",
      "| Timestamp | Duration (ms) | Status | Error |",
      "|---|---|---|---|",
      ...report.slowSamples.map(
        (s) => `| ${s.timestamp} | ${s.durationMs} | ${s.status} | ${s.error ?? ""} |`,
      ),
      "",
    );
  }

  // Host metrics section
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
          const fields = Object.entries(pres[resource]).map(
            ([k, v]) => `| ${resource}.${k} | ${v} |`,
          ).join("\n");
          sections.push(`| Resource | Value |`);
          sections.push(`|---|---|`);
          sections.push(fields);
          sections.push("");
        }
      }
    }

    if (h.processUptimeSec !== undefined) {
      sections.push(
        `Probe process uptime: ${h.processUptimeSec}s`,
        "",
      );
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
        `| Memory % | ${d.memPercent !== null ? d.memPercent : "N/A"} |`,
        "",
      );
    }
  }

  // Per-connection-mode comparison (--all-modes)
  if (report.byConnectionMode) {
    const modes = LIVEZ_CONNECTION_MODE_LIST;
    const dm = report.byConnectionMode;
    const cell = (mode, metric) => dm?.[mode]?.[metric] !== undefined ? String(dm[mode][metric]) : "—";
    sections.push(
      "## Per-Connection-Mode Comparison",
      "",
      "| Metric | default | fresh | keep-alive |",
      "|---|---|---|---|",
      `| Probes | ${cell("default", "probeCount")} | ${cell("fresh", "probeCount")} | ${cell("keep-alive", "probeCount")} |`,
      `| Failures | ${cell("default", "failureCount")} | ${cell("fresh", "failureCount")} | ${cell("keep-alive", "failureCount")} |`,
      `| Max (ms) | ${cell("default", "maxDurationMs")} | ${cell("fresh", "maxDurationMs")} | ${cell("keep-alive", "maxDurationMs")} |`,
      `| p50 (ms) | ${cell("default", "p50DurationMs")} | ${cell("fresh", "p50DurationMs")} | ${cell("keep-alive", "p50DurationMs")} |`,
      `| p95 (ms) | ${cell("default", "p95DurationMs")} | ${cell("fresh", "p95DurationMs")} | ${cell("keep-alive", "p95DurationMs")} |`,
      `| p99 (ms) | ${cell("default", "p99DurationMs")} | ${cell("fresh", "p99DurationMs")} | ${cell("keep-alive", "p99DurationMs")} |`,
      `| Samples >1s | ${cell("default", "samplesAbove1s")} | ${cell("fresh", "samplesAbove1s")} | ${cell("keep-alive", "samplesAbove1s")} |`,
      `| Samples >3s | ${cell("default", "samplesAbove3s")} | ${cell("fresh", "samplesAbove3s")} | ${cell("keep-alive", "samplesAbove3s")} |`,
      `| Stalled | ${cell("default", "stalled")} | ${cell("fresh", "stalled")} | ${cell("keep-alive", "stalled")} |`,
      `| OK | ${cell("default", "ok")} | ${cell("fresh", "ok")} | ${cell("keep-alive", "ok")} |`,
      "",
      "**Interpretation:**",
      "",
      "- High latency in **fresh** mode (connection: close) suggests accepted-socket-waiting-before-handler or accept→request-event delay (TCP accept / TLS / read wait).",
      "- High latency in **keep-alive** mode (connection: keep-alive) suggests reused-socket-idle-before-request-event (socket reuse idle on wire).",
      "- High latency in **default** mode can reflect either; compare with fresh/keep-alive to disambiguate.",
      "",
    );
  }

  // In-broker attribution summary
  if (report.livezAttributionSummary) {
    sections.push("## In-Broker /livez Attribution Summary");
    sections.push("");
    const a = report.livezAttributionSummary;

    if (a.brokerCpuPercent) {
      sections.push(
        "### Broker CPU % (delta since last check)",
        "",
        `| Metric | Value |`,
        `|---|---|`,
        `| Min | ${a.brokerCpuPercent.min}% |`,
        `| Max | ${a.brokerCpuPercent.max}% |`,
        `| Avg | ${a.brokerCpuPercent.avg}% |`,
        `| Samples | ${a.brokerCpuPercent.samples} |`,
        "",
      );
    }

    if (a.eventLoopDelayMs) {
      sections.push(
        "### Event Loop Delay",
        "",
        `| Metric | Value |`,
        `|---|---|`,
        `| Min | ${a.eventLoopDelayMs.min}ms |`,
        `| Max | ${a.eventLoopDelayMs.max}ms |`,
        `| Samples | ${a.eventLoopDelayMs.samples} |`,
        "",
      );
    }

    if (a.diagMs) {
      sections.push(
        "### /livez Handler Diagnostics Duration",
        "",
        `| Metric | Value |`,
        `|---|---|`,
        `| Min | ${a.diagMs.min}ms |`,
        `| Max | ${a.diagMs.max}ms |`,
        `| Avg | ${a.diagMs.avg}ms |`,
        `| Samples | ${a.diagMs.samples} |`,
        "",
      );
    }

    if (a.timingSnapshots && a.timingSnapshots.length > 0) {
      sections.push(
        "### /livez Handler Timing Snapshots (rolling window)",
        "",
        "| Sample | count | maxMs | p99Ms |",
        "|---|---|---|---|",
        ...a.timingSnapshots.map((t, i) =>
          `| ${i + 1} | ${t.count} | ${t.maxMs} | ${t.p99Ms} |`,
        ),
        "",
      );
    }

    // Socket reuse and client timing summary (#1108)
    if (a.socketReuse) {
      sections.push(
        "### Socket Reuse Classification",
        "",
        "| Metric | Value |",
        "|---|---|",
        `| Fresh connections (socketHadServedRequest=false) | ${a.socketReuse.freshConnectionCount} |`,
        `| Reused connections (socketHadServedRequest=true) | ${a.socketReuse.reusedConnectionCount} |`,
        `| Request index range | ${a.socketReuse.requestIndexRange ? `${a.socketReuse.requestIndexRange.min} - ${a.socketReuse.requestIndexRange.max}` : "N/A"} |`,
        "",
      );
    }

    if (a.clientProbeStartToHandlerStartMs) {
      const c = a.clientProbeStartToHandlerStartMs;
      sections.push(
        "### Client-side Timing: Probe Start to Handler Start",
        "",
        `| Min | Max | Avg | Samples |`,
        `|---|---|---|---|`,
        `| ${c.min}ms | ${c.max}ms | ${c.avg}ms | ${c.samples} |`,
        "",
      );
    }

    if (a.clientProbeStartToSocketConnectedMs) {
      const c = a.clientProbeStartToSocketConnectedMs;
      sections.push(
        "### Client-side Timing: Probe Start to Socket Connected",
        "",
        `| Min | Max | Avg | Samples |`,
        `|---|---|---|---|`,
        `| ${c.min}ms | ${c.max}ms | ${c.avg}ms | ${c.samples} |`,
        "",
      );
    }
  }

  // Correlated probes summary (show first few where duration > 1s or host load is high)
  if (report.correlatedProbes && report.correlatedProbes.length > 0) {
    const notableProbes = report.correlatedProbes.filter(
      (cp) => cp.probe.durationMs > 1000 || (cp.host?.loadAverage?.load1 ?? 0) > 2,
    );
    if (notableProbes.length > 0) {
      sections.push(
        "## Notable Correlated Probes",
        "",
        "| Timestamp | Duration (ms) | Status | Reused? | Req# | Host Load 1m | Broker CPU% | EventLoop (ms) |",
        "|---|---|---|---|---|---|---|---|",
        ...notableProbes.slice(0, 10).map((cp) =>
          `| ${cp.probe.timestamp} | ${cp.probe.durationMs} | ${cp.probe.status} | ${cp.attribution?.socketHadServedRequest === true ? "yes" : cp.attribution?.socketHadServedRequest === false ? "no" : "?"} | ${cp.attribution?.socketRequestIndex ?? "?"} | ${cp.host?.loadAverage?.load1 ?? "N/A"} | ${cp.attribution?.brokerCpuPercent ?? "N/A"} | ${cp.attribution?.eventLoopDelayMs ?? "N/A"} |`,
        ),
        "",
      );
    }
  }

  // Operator gate cross-correlation from /schedz (#1032)
  if (report.schedzOperatorGate) {
    const og = report.schedzOperatorGate;
    sections.push(
      "## Server-Side Operator Gate (from /schedz)",
      "",
      `| Field | Value |`,
      `|---|---|`,
      `| Bucket | ${og.bucket} |`,
      `| Confidence | ${og.confidence} |`,
      `| Reasons | ${(og.reasons ?? []).join("; ") || "—"} |`,
      "",
    );
    if (og.evidence) {
      sections.push(
        "### Operator Gate Evidence",
        "",
        "| Metric | p99 (ms) |",
        "|---|---|",
        ...Object.entries(og.evidence)
          .filter(([, v]) => v !== null && v !== undefined)
          .map(([k, v]) => `| ${k} | ${v} |`),
        "",
      );
    }

    // Handler body timing from /schedz (#1032 antithesis)
    if (report.schedzHandlerBodyTiming) {
      const ht = report.schedzHandlerBodyTiming;
      sections.push(
        "### Handler Body Timing (All Endpoints)",
        "",
        "| Metric | Value (ms) |",
        "|---|---|",
        `| Samples | ${ht.samples} |`,
        `| Average | ${ht.averageMs} |`,
        `| p50 | ${ht.p50Ms} |`,
        `| p95 | ${ht.p95Ms} |`,
        `| p99 | ${ht.p99Ms} |`,
        `| Max | ${ht.maxMs} |`,
        "",
        "**Note:** This is the aggregate handler body timing across ALL endpoints (not just /livez).",
        `If p99 > 3s, a handler body stall on a different endpoint may be inflating the scheduling window.`,
        `Compare with the per-probe /livez diagMs to isolate.`,
        "",
      );
    }

    // Per-endpoint handler body timing (#1032 thesis)
    if (report.endpointHandlerBodyTiming) {
      const eht = report.endpointHandlerBodyTiming;
      // Sort endpoint groups with samples first; show livez and health prominently.
      const sortedGroups = Object.entries(eht)
        .filter(([, v]) => v !== null && v.samples > 0)
        .sort(([, a], [, b]) => (b?.p99Ms ?? 0) - (a?.p99Ms ?? 0));
      if (sortedGroups.length > 0) {
        const rows = sortedGroups.map(([group, timing]) =>
          `| ${group} | ${timing.samples} | ${timing.p50Ms} | ${timing.p95Ms} | ${timing.p99Ms} | ${timing.maxMs} |`,
        );
        sections.push(
          "### Per-Endpoint Handler Body Timing",
          "",
          "| Endpoint | Samples | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |",
          "|---|---|---|---|---|---|",
          ...rows,
          "",
          "**Note:** Per-endpoint handler body time (handler start to `res.end()`, excludes response flush).",
          "If `/livez` handler body is tiny but another endpoint is high, the global handler body p99 is not a /livez issue.",
          "",
        );
      }
    }

    // Per-route handler body timing (#1032 / #1179 synthesis)
    if (report.routeHandlerBodyTiming) {
      const rht = report.routeHandlerBodyTiming;
      const sortedRoutes = Object.entries(rht)
        .filter(([, v]) => v !== null && v.samples > 0)
        .sort(([, a], [, b]) => (b?.p99Ms ?? 0) - (a?.p99Ms ?? 0));
      if (sortedRoutes.length > 0) {
        const rows = sortedRoutes.map(([route, timing]) =>
          `| ${route} | ${timing.samples} | ${timing.p50Ms} | ${timing.p95Ms} | ${timing.p99Ms} | ${timing.maxMs} |`,
        );
        sections.push(
          "### Per-Route Handler Body Timing",
          "",
          "| Route | Samples | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |",
          "|---|---|---|---|---|---|",
          ...rows,
          "",
          "**Note:** Per-route handler body time narrows broad endpoint buckets such as `worker` to concrete routes like `workers.heartbeat` or `workers.assignment-events`.",
          "",
        );
      }
    }

    sections.push(
      "**Interpretation:**",
      "",
      `- **"reused-socket-idle-before-request-event"**: The socket was reused (keep-alive) but the HTTP request event`,
      "  arrived late on the wire. Suggests the client reused an idle socket that timed out on the broker side,",
      "  or the client held the socket without sending data.",
      `- **"accepted-socket-waiting-before-request-event"**: A fresh TCP connection was accepted but the HTTP request`,
      "  event fired late (no clear data-level decomposition). Suggests accept-queue buildup under TCP accept backpressure.",
      `- **"accepted-socket-waiting-for-data"**: A fresh socket was accepted but the first TCP data byte arrived`,
      "  late (socketConnectedToFirstDataMs dominates). The client/Gwakga may not have sent the request yet,",
      "  the network was slow, or host scheduling delayed the read callback.",
      `- **"accepted-socket-data-received-blocked"**: The first TCP data byte arrived promptly but the HTTP request`,
      "  event fired late (firstDataToHttpRequestEventMs dominates). Node event-loop was blocked (GC, cgroup",
      "  throttle, callback pressure) after data arrived — not a broker-code issue.",
      `- **"accepted-socket-waiting-before-handler"**: The socket was accepted and the HTTP request event fired on`,
      "  time, but the handler dispatch was delayed (event-loop descheduling on a fresh connection).",
      `- **"no-significant-stall"**: All in-broker timing windows are within expected thresholds. If /livez shows`,
      "  >1s stalls here, the delay is outside the broker (client-side, network, or host scheduler).",
      "",
      `**Cross-correlation result:** ${report.checks.find(c => c.check === "operatorGate correlation gate")?.ok ? "✅ Match — server-side classifier agrees with observed stalls" : "❌ Mismatch — stalls observed but server says none"}`,
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
    "- Broker HTTP requested: live probes use GET only",
    "- Host metrics: read-only /proc files and optional docker stats (one-shot, no attach/top)",
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
  const report = await runMeasurement(options);

  if (options.markdown && !options.json) {
    console.log(renderMarkdown(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`broker-livez-stall-attribution: ${error.message}`);
    process.exit(2);
  });
}
