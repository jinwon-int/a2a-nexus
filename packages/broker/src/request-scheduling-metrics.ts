// Request scheduling / timing instrumentation, extracted from server.ts.
// Owns the O(1) accept/connection counters and the rolling RequestTimingWindow
// ring buffers used to attribute request latency by endpoint, route, and socket
// lifecycle phase (fresh vs reused), plus the client-probe burst counter. Never
// touches DB / hot-table / cache. initSchedulingHook() is the per-request hub
// that records into these windows; trackServerConnection() instruments sockets;
// the *Snapshot()/read* readers plus the exported counters/windows feed /schedz,
// /livez, and /healthz diagnostics. All entry points are top-level functions, so
// nothing here captures server.ts closure state.
import type { IncomingMessage, ServerResponse } from "node:http";
import { RequestTimingWindow, type RequestTimingSnapshot } from "./diagnostics/request-timing-window.js";
import {
  ENDPOINT_GROUPS,
  REQUEST_ROUTE_GROUPS,
  type EndpointGroup,
  type RequestRouteGroup,
} from "./http/route-classification.js";

/**
 * Small rolling window of request durations for a single endpoint.
 * Records the last N completion times and exposes p50/p95/p99/p999.
 */

// Per-endpoint request windows for attribution.
export const _livezTiming = new RequestTimingWindow();
export const _healthTiming = new RequestTimingWindow();

// ---------------------------------------------------------------------------
// Request accept/scheduling attribution (issue #1032)
// O(1) counters and rolling windows. Never touches DB, hot-table, or cache.
// ---------------------------------------------------------------------------

/** Total number of accepted HTTP requests since process start. */
export let _totalAcceptedRequests = 0;

/** Currently in-flight requests (active handler executions). */
export let _activeRequests = 0;

/**
 * Global scheduling window: records handler-completion duration for EVERY
 * request, not just /livez.  Exposes p50/p95/p99 across all endpoints.
 */
export const _schedulingTimingWindow = new RequestTimingWindow(200);

/** Per-endpoint timing windows and active request gauges. */
const _perEndpointTiming = new Map<EndpointGroup, RequestTimingWindow>();
const _perEndpointActive = new Map<EndpointGroup, number>();

/** Per-endpoint handler body timing windows (handler start to res.end(), excludes response flush). */
const _perEndpointHandlerBody = new Map<EndpointGroup, RequestTimingWindow>();

export interface RequestRouteMetrics {
  timing: RequestTimingWindow;
  active: number;
  firstRequestLatency: RequestTimingWindow;
  requestsOnNewConnection: number;
  requestsOnReusedConnection: number;
}

const _perRouteMetrics = new Map<RequestRouteGroup, RequestRouteMetrics>();

/** Per-route handler body timing windows (handler start to res.end(), excludes response flush). */
const _perRouteHandlerBody = new Map<RequestRouteGroup, RequestTimingWindow>();

function routeHandlerBodyWindow(group: RequestRouteGroup): RequestTimingWindow {
  let window = _perRouteHandlerBody.get(group);
  if (!window) {
    window = new RequestTimingWindow(200);
    _perRouteHandlerBody.set(group, window);
  }
  return window;
}

export function routeHandlerBodySnapshot(): Record<RequestRouteGroup, RequestTimingSnapshot> {
  const snapshot = {} as Record<RequestRouteGroup, RequestTimingSnapshot>;
  for (const group of REQUEST_ROUTE_GROUPS) {
    snapshot[group] = _perRouteHandlerBody.get(group)?.snapshot() ?? null;
  }
  return snapshot;
}

function endpointTimingWindow(group: EndpointGroup): RequestTimingWindow {
  let window = _perEndpointTiming.get(group);
  if (!window) {
    window = new RequestTimingWindow(200);
    _perEndpointTiming.set(group, window);
  }
  return window;
}

export function endpointTimingSnapshot(): Record<EndpointGroup, RequestTimingSnapshot> {
  const snapshot = {} as Record<EndpointGroup, RequestTimingSnapshot>;
  for (const group of ENDPOINT_GROUPS) {
    snapshot[group] = _perEndpointTiming.get(group)?.snapshot() ?? null;
  }
  return snapshot;
}

export function endpointActiveSnapshot(): Record<EndpointGroup, number> {
  const snapshot = {} as Record<EndpointGroup, number>;
  for (const group of ENDPOINT_GROUPS) {
    snapshot[group] = _perEndpointActive.get(group) ?? 0;
  }
  return snapshot;
}

function endpointHandlerBodyWindow(group: EndpointGroup): RequestTimingWindow {
  let window = _perEndpointHandlerBody.get(group);
  if (!window) {
    window = new RequestTimingWindow(200);
    _perEndpointHandlerBody.set(group, window);
  }
  return window;
}

export function endpointHandlerBodySnapshot(): Record<EndpointGroup, RequestTimingSnapshot> {
  const snapshot = {} as Record<EndpointGroup, RequestTimingSnapshot>;
  for (const group of ENDPOINT_GROUPS) {
    snapshot[group] = _perEndpointHandlerBody.get(group)?.snapshot() ?? null;
  }
  return snapshot;
}

function routeMetrics(group: RequestRouteGroup): RequestRouteMetrics {
  let metrics = _perRouteMetrics.get(group);
  if (!metrics) {
    metrics = {
      timing: new RequestTimingWindow(200),
      active: 0,
      firstRequestLatency: new RequestTimingWindow(200),
      requestsOnNewConnection: 0,
      requestsOnReusedConnection: 0,
    };
    _perRouteMetrics.set(group, metrics);
  }
  return metrics;
}

export function requestRouteSnapshot(): Record<RequestRouteGroup, {
  active: number;
  timing: RequestTimingSnapshot;
  firstRequestLatencyMs: RequestTimingSnapshot;
  onNewConnection: number;
  onReusedConnection: number;
}> {
  const snapshot = {} as Record<RequestRouteGroup, {
    active: number;
    timing: RequestTimingSnapshot;
    firstRequestLatencyMs: RequestTimingSnapshot;
    onNewConnection: number;
    onReusedConnection: number;
  }>;
  for (const group of REQUEST_ROUTE_GROUPS) {
    const metrics = _perRouteMetrics.get(group);
    snapshot[group] = {
      active: metrics?.active ?? 0,
      timing: metrics?.timing.snapshot() ?? null,
      firstRequestLatencyMs: metrics?.firstRequestLatency.snapshot() ?? null,
      onNewConnection: metrics?.requestsOnNewConnection ?? 0,
      onReusedConnection: metrics?.requestsOnReusedConnection ?? 0,
    };
  }
  return snapshot;
}

/**
 * Hook called at the top of the request handler to track accept timing.
 * Listens on `res.on("finish")` to decrement the active count and record
 * the handler duration in the global scheduling window.
 */
export function initSchedulingHook(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  endpointGroup: EndpointGroup,
  routeGroup: RequestRouteGroup,
): void {
  const handlerStartPerfMs = performance.now();
  const handlerStartUnixMs = Date.now();
  _totalAcceptedRequests++;
  _activeRequests++;
  _perEndpointActive.set(endpointGroup, (_perEndpointActive.get(endpointGroup) ?? 0) + 1);
  const route = routeMetrics(routeGroup);
  route.active++;

  // Connection reuse classification: first request on socket vs keep-alive reused.
  const sock = req.socket as any;
  const requestsServedBefore = Number.isFinite(sock?.__a2aRequestsServed)
    ? Number(sock.__a2aRequestsServed)
    : (sock?.__a2aHasServedRequest ? 1 : 0);
  const socketConnectedAtPerfMs = typeof sock?.__a2aConnectedAt === "number"
    ? sock.__a2aConnectedAt
    : null;
  const socketConnectedUnixMs = typeof sock?.__a2aConnectedAtUnixMs === "number"
    ? sock.__a2aConnectedAtUnixMs
    : null;
  const lastResponseFinishedAtPerfMs = typeof sock?.__a2aLastResponseFinishedAt === "number"
    ? sock.__a2aLastResponseFinishedAt
    : null;
  const httpRequestEventAtPerfMs = typeof (req as any).__a2aHttpRequestEventAt === "number"
    ? (req as any).__a2aHttpRequestEventAt
    : null;
  const httpRequestEventUnixMs = typeof (req as any).__a2aHttpRequestEventAtUnixMs === "number"
    ? (req as any).__a2aHttpRequestEventAtUnixMs
    : null;
  const clientProbeStartUnixMs = parseProbeStartHeader(req, handlerStartUnixMs);
  const socketAgeBeforeHandlerMs = socketConnectedAtPerfMs !== null
    ? Math.round((handlerStartPerfMs - socketConnectedAtPerfMs) * 1000) / 1000
    : null;
  const socketIdleBeforeRequestMs = requestsServedBefore > 0 && lastResponseFinishedAtPerfMs !== null
    ? Math.round((handlerStartPerfMs - lastResponseFinishedAtPerfMs) * 1000) / 1000
    : null;
  const socketAcceptedToHttpRequestEventMs = socketConnectedAtPerfMs !== null && httpRequestEventAtPerfMs !== null
    ? Math.round((httpRequestEventAtPerfMs - socketConnectedAtPerfMs) * 1000) / 1000
    : null;
  const httpRequestEventToHandlerStartMs = httpRequestEventAtPerfMs !== null
    ? Math.round((handlerStartPerfMs - httpRequestEventAtPerfMs) * 1000) / 1000
    : null;
  const socketIdleBeforeHttpRequestEventMs = requestsServedBefore > 0
    && lastResponseFinishedAtPerfMs !== null
    && httpRequestEventAtPerfMs !== null
    ? Math.round((httpRequestEventAtPerfMs - lastResponseFinishedAtPerfMs) * 1000) / 1000
    : null;
  const clientProbeStartToHandlerStartMs = clientProbeStartUnixMs !== null
    ? handlerStartUnixMs - clientProbeStartUnixMs
    : null;
  const clientProbeStartToSocketConnectedMs = clientProbeStartUnixMs !== null && socketConnectedUnixMs !== null
    ? socketConnectedUnixMs - clientProbeStartUnixMs
    : null;
  const clientProbeStartToHttpRequestEventMs = clientProbeStartUnixMs !== null && httpRequestEventUnixMs !== null
    ? httpRequestEventUnixMs - clientProbeStartUnixMs
    : null;
  const firstDataAtPerfMs = typeof sock?.__a2aFirstDataAt === "number"
    ? sock.__a2aFirstDataAt
    : null;
  const socketConnectedToFirstDataMs = socketConnectedAtPerfMs !== null && firstDataAtPerfMs !== null
    ? Math.round((firstDataAtPerfMs - socketConnectedAtPerfMs) * 1000) / 1000
    : null;
  const firstDataToHttpRequestEventMs = firstDataAtPerfMs !== null && httpRequestEventAtPerfMs !== null
    ? Math.round((httpRequestEventAtPerfMs - firstDataAtPerfMs) * 1000) / 1000
    : null;
  const reuseFirstDataAtPerfMs = typeof sock?.__a2aReuseFirstDataAt === "number"
    ? sock.__a2aReuseFirstDataAt
    : null;
  const reuseIdleBeforeDataMs = requestsServedBefore > 0
    && lastResponseFinishedAtPerfMs !== null
    && reuseFirstDataAtPerfMs !== null
    ? Math.round((reuseFirstDataAtPerfMs - lastResponseFinishedAtPerfMs) * 1000) / 1000
    : null;
  const reuseDataToHttpRequestEventMs = requestsServedBefore > 0
    && reuseFirstDataAtPerfMs !== null
    && httpRequestEventAtPerfMs !== null
    ? Math.round((httpRequestEventAtPerfMs - reuseFirstDataAtPerfMs) * 1000) / 1000
    : null;
  const lifecycle: RequestLifecycleTiming = {
    handlerStartUnixMs,
    socketConnectedUnixMs,
    socketAgeBeforeHandlerMs,
    socketIdleBeforeRequestMs,
    httpRequestEventUnixMs,
    socketAcceptedToHttpRequestEventMs,
    httpRequestEventToHandlerStartMs,
    socketIdleBeforeHttpRequestEventMs,
    socketRequestIndex: requestsServedBefore + 1,
    socketHadServedRequest: requestsServedBefore > 0,
    clientProbeStartUnixMs,
    clientProbeStartToHandlerStartMs,
    clientProbeStartToSocketConnectedMs,
    clientProbeStartToHttpRequestEventMs,
    socketConnectedToFirstDataMs,
    firstDataToHttpRequestEventMs,
    reuseIdleBeforeDataMs,
    reuseDataToHttpRequestEventMs,
  };
  (req as any).__a2aRequestLifecycle = lifecycle;
  if (socketAgeBeforeHandlerMs !== null && socketAgeBeforeHandlerMs >= 0) {
    _socketAgeBeforeHandlerWindow.record(socketAgeBeforeHandlerMs);
  }
  if (socketIdleBeforeRequestMs !== null && socketIdleBeforeRequestMs >= 0) {
    _socketIdleBeforeRequestWindow.record(socketIdleBeforeRequestMs);
  }
  if (socketAcceptedToHttpRequestEventMs !== null && socketAcceptedToHttpRequestEventMs >= 0) {
    _socketAcceptedToHttpRequestEventWindow.record(socketAcceptedToHttpRequestEventMs);
  }
  if (httpRequestEventToHandlerStartMs !== null && httpRequestEventToHandlerStartMs >= 0) {
    _httpRequestEventToHandlerStartWindow.record(httpRequestEventToHandlerStartMs);
  }
  if (socketIdleBeforeHttpRequestEventMs !== null && socketIdleBeforeHttpRequestEventMs >= 0) {
    _socketIdleBeforeHttpRequestEventWindow.record(socketIdleBeforeHttpRequestEventMs);
  }
  if (clientProbeStartToHandlerStartMs !== null && clientProbeStartToHandlerStartMs >= 0) {
    _clientProbeStartToHandlerStartWindow.record(clientProbeStartToHandlerStartMs);
  }
  if (clientProbeStartToSocketConnectedMs !== null && clientProbeStartToSocketConnectedMs >= 0) {
    _clientProbeStartToSocketConnectedWindow.record(clientProbeStartToSocketConnectedMs);
  }
  if (clientProbeStartToHttpRequestEventMs !== null && clientProbeStartToHttpRequestEventMs >= 0) {
    _clientProbeStartToHttpRequestEventWindow.record(clientProbeStartToHttpRequestEventMs);
  }
  if (socketConnectedToFirstDataMs !== null && socketConnectedToFirstDataMs >= 0) {
    _socketConnectedToFirstDataWindow.record(socketConnectedToFirstDataMs);
  }
  if (firstDataToHttpRequestEventMs !== null && firstDataToHttpRequestEventMs >= 0) {
    _firstDataToHttpRequestEventWindow.record(firstDataToHttpRequestEventMs);
  }
  if (sock?.__a2aConnectedAt !== undefined) {
    if (!sock.__a2aHasServedRequest) {
      // Fresh connection: record per-reuse breakdown windows
      if (socketAgeBeforeHandlerMs !== null && socketAgeBeforeHandlerMs >= 0) {
        _freshSocketAgeBeforeHandlerWindow.record(socketAgeBeforeHandlerMs);
      }
      if (socketAcceptedToHttpRequestEventMs !== null && socketAcceptedToHttpRequestEventMs >= 0) {
        _freshSocketAcceptedToHttpRequestEventWindow.record(socketAcceptedToHttpRequestEventMs);
      }
      if (socketConnectedToFirstDataMs !== null && socketConnectedToFirstDataMs >= 0) {
        _freshSocketConnectedToFirstDataWindow.record(socketConnectedToFirstDataMs);
      }
      if (firstDataToHttpRequestEventMs !== null && firstDataToHttpRequestEventMs >= 0) {
        _freshSocketFirstDataToHttpRequestEventWindow.record(firstDataToHttpRequestEventMs);
      }
      if (httpRequestEventToHandlerStartMs !== null && httpRequestEventToHandlerStartMs >= 0) {
        _freshSocketHttpRequestEventToHandlerStartWindow.record(httpRequestEventToHandlerStartMs);
      }
    } else {
      // Reused socket: record per-reuse breakdown windows
      if (socketAgeBeforeHandlerMs !== null && socketAgeBeforeHandlerMs >= 0) {
        _reusedSocketAgeBeforeHandlerWindow.record(socketAgeBeforeHandlerMs);
      }
      if (socketIdleBeforeHttpRequestEventMs !== null && socketIdleBeforeHttpRequestEventMs >= 0) {
        _reusedSocketIdleBeforeHttpRequestEventWindow.record(socketIdleBeforeHttpRequestEventMs);
      }
      if (httpRequestEventToHandlerStartMs !== null && httpRequestEventToHandlerStartMs >= 0) {
        _reusedSocketHttpRequestEventToHandlerStartWindow.record(httpRequestEventToHandlerStartMs);
      }
      // Per-reused-request first-data-byte breakdown: separates wire idle
      // from event-loop blocked after data arrives (#1032 antithesis-runtime).
      if (reuseIdleBeforeDataMs !== null && reuseIdleBeforeDataMs >= 0) {
        _reusedSocketIdleBeforeDataWindow.record(reuseIdleBeforeDataMs);
      }
      if (reuseDataToHttpRequestEventMs !== null && reuseDataToHttpRequestEventMs >= 0) {
        _reusedSocketFirstDataToHttpRequestEventWindow.record(reuseDataToHttpRequestEventMs);
      }
    }
    if (!sock.__a2aHasServedRequest) {
      sock.__a2aHasServedRequest = true;
      _requestsOnNewConnection++;
      const firstReqLat = socketAgeBeforeHandlerMs ?? Math.round((handlerStartPerfMs - sock.__a2aConnectedAt) * 1000) / 1000;
      _firstRequestLatencyWindow.record(firstReqLat);
      route.requestsOnNewConnection++;
      route.firstRequestLatency.record(firstReqLat);
    } else {
      _requestsOnReusedConnection++;
      route.requestsOnReusedConnection++;
    }
  }
  sock.__a2aRequestsServed = requestsServedBefore + 1;

  // Probe burst detection: track /livez probes per /24 peer prefix.
  if (req.url === "/livez") {
    const peer = req.socket?.remoteAddress ?? "unknown";
    const prefix = peer.includes(".") ? peer.split(".").slice(0, 3).join(".") : peer;
    const now = Date.now();
    let entry = _probeCounter.get(prefix);
    if (!entry || now - entry.windowStartMs > PROBE_WINDOW_MS) {
      entry = { count: 0, windowStartMs: now };
      _probeCounter.set(prefix, entry);
    }
    entry.count++;
    // /livez is public and unauthenticated, so a distinct peer /24 per request
    // would grow this map without bound. Prune only when it gets large so the
    // hot path stays cheap.
    if (_probeCounter.size > PROBE_COUNTER_MAX_ENTRIES) {
      pruneProbeCounter(now);
    }
  }

  let flushCalledAt = 0;
  let completed = false;

  // Wrap res.end() to capture when the handler calls flush so we can measure
  // the gap between handler-side flush and OS-level finish.
  const originalEnd = res.end.bind(res);
  res.end = function endWrap(...args: any[]) {
    flushCalledAt = performance.now();
    return originalEnd(...args);
  } as typeof res.end;

  const completeHandler = () => {
    if (completed) return;
    completed = true;
    _activeRequests = Math.max(0, _activeRequests - 1);
    const now = performance.now();
    const elapsedMs = Math.round((now - handlerStartPerfMs) * 1000) / 1000;
    _schedulingTimingWindow.record(elapsedMs);
    endpointTimingWindow(endpointGroup).record(elapsedMs);
    route.timing.record(elapsedMs);
    _perEndpointActive.set(endpointGroup, Math.max(0, (_perEndpointActive.get(endpointGroup) ?? 0) - 1));
    route.active = Math.max(0, route.active - 1);

    // Record handler body execution time (start → res.end()) and flush-finish gap.
    if (flushCalledAt > 0) {
      const handlerBodyMs = Math.round((flushCalledAt - handlerStartPerfMs) * 1000) / 1000;
      _handlerBodyWindow.record(handlerBodyMs);
      endpointHandlerBodyWindow(endpointGroup).record(handlerBodyMs);
      routeHandlerBodyWindow(routeGroup).record(handlerBodyMs);
      const gapMs = Math.round((now - flushCalledAt) * 1000) / 1000;
      _flushFinishGapWindow.record(gapMs);
    }
    sock.__a2aLastResponseFinishedAt = now;
    sock.__a2aLastResponseFinishedUnixMs = Date.now();

    // Re-arm one-shot data listener for next keep-alive request (#1032
    // antithesis-runtime).  Records when the next request's first data byte
    // arrives, enabling separation of wire idle (client didn't send yet)
    // from event-loop blocked (data received but not processed).
    //
    // prependOnceListener ensures this fires BEFORE the HTTP parser's
    // internal data handler (registered first), so __a2aReuseFirstDataAt
    // is stamped before the HTTP parser emits the 'request' event even
    // when the full request fits in a single TCP segment.
    if (!sock.destroyed && sock.writable) {
      sock.__a2aReuseFirstDataAt = null;
      sock.prependOnceListener("data", () => {
        sock.__a2aReuseFirstDataAt = performance.now();
      });
    }

    res.off("finish", completeHandler);
    res.off("close", completeHandler);
  };
  res.on("finish", completeHandler);
  res.on("close", completeHandler);
}

// ---------------------------------------------------------------------------
// Cgroup (container-level) CPU throttling and PSI diagnostics (#1054)
// Graceful fallback: returns null when cgroupv2 files are unavailable
// (non-Linux, non-container, or restricted permissions).
// These are O(1) reads — single-file /sys/fs/cgroup reads — and are
// exposed only on /schedz, never on the /livez hot path.
// ---------------------------------------------------------------------------


// Connection tracking diagnostics (issue #1032)
// O(1), bounded in-memory, off /livez hot path (exposed on /schedz).
// ---------------------------------------------------------------------------

/** Total TCP connections accepted since process start (server "connection" events). */
export let _totalConnections = 0;

/** Currently open TCP connections. */
export let _activeConnections = 0;

/** Peak concurrent TCP connections since process start. */
export let _peakConnections = 0;

/** Timing window for per-connection duration (socket open to close). */
export const _connectionDurationWindow = new RequestTimingWindow(200);

/** Timing window for first-request latency on new TCP connections. */
export const _firstRequestLatencyWindow = new RequestTimingWindow(200);

/** Timing window for socket age when a request handler starts. */
export const _socketAgeBeforeHandlerWindow = new RequestTimingWindow(200);

/** Timing window for keep-alive socket idle time before a reused request starts. */
export const _socketIdleBeforeRequestWindow = new RequestTimingWindow(200);

/** Timing window for socket acceptance to Node HTTP request event. */
export const _socketAcceptedToHttpRequestEventWindow = new RequestTimingWindow(200);

/** Timing window for Node HTTP request event to main handler start. */
export const _httpRequestEventToHandlerStartWindow = new RequestTimingWindow(200);

/** Timing window for keep-alive socket idle before Node HTTP request event. */
export const _socketIdleBeforeHttpRequestEventWindow = new RequestTimingWindow(200);

/** Timing window for client probe start header to server handler start. */
export const _clientProbeStartToHandlerStartWindow = new RequestTimingWindow(200);

/** Timing window for client probe start header to TCP socket connection event. */
export const _clientProbeStartToSocketConnectedWindow = new RequestTimingWindow(200);

/** Timing window for flush-finish gap: handler res.end() to res "finish" event. */
export const _flushFinishGapWindow = new RequestTimingWindow(200);

/** Timing window for handler body execution: handler start to res.end() call, excluding response flushing. */
export const _handlerBodyWindow = new RequestTimingWindow(200);

/** Timing window for client probe start to Node HTTP request event (client pool artifact detection). */
export const _clientProbeStartToHttpRequestEventWindow = new RequestTimingWindow(200);

/** Timing window for TCP accept/scheduling delay before first data byte on socket (connected → first data). */
export const _socketConnectedToFirstDataWindow = new RequestTimingWindow(200);

/** Timing window for HTTP parser/read delay from first data byte to 'request' event. */
export const _firstDataToHttpRequestEventWindow = new RequestTimingWindow(200);

/** Timing windows broken down by connection reuse for socket idle classification. */
export const _freshSocketAgeBeforeHandlerWindow = new RequestTimingWindow(200);
export const _freshSocketAcceptedToHttpRequestEventWindow = new RequestTimingWindow(200);
export const _freshSocketConnectedToFirstDataWindow = new RequestTimingWindow(200);
export const _freshSocketFirstDataToHttpRequestEventWindow = new RequestTimingWindow(200);
/** Timing window for fresh-socket HTTP request event → handler start (event-loop descheduling). */
export const _freshSocketHttpRequestEventToHandlerStartWindow = new RequestTimingWindow(200);
export const _reusedSocketIdleBeforeHttpRequestEventWindow = new RequestTimingWindow(200);
export const _reusedSocketAgeBeforeHandlerWindow = new RequestTimingWindow(200);
export const _reusedSocketHttpRequestEventToHandlerStartWindow = new RequestTimingWindow(200);
/**
 * Per-reused-request idle before first data byte arrives on socket.
 * This separates "wire idle" (client hadn't sent next request yet) from
 * "data-received-but-not-processed" (event-loop blocked after data arrived).
 * Re-armed after each response finishes on a keep-alive socket.
 */
export const _reusedSocketIdleBeforeDataWindow = new RequestTimingWindow(200);
/**
 * Per-reused-request first data byte → HTTP request event gap.
 * When this is large, data arrived on a keep-alive socket but Node's event
 * loop was blocked (GC, cgroup CPU throttle, other callbacks) before the
 * HTTP parser could fire the request event.  High values here while
 * idleBeforeData is low point to event-loop descheduling, not wire idle.
 */
export const _reusedSocketFirstDataToHttpRequestEventWindow = new RequestTimingWindow(200);

/** Counters for request-vs-connection reuse classification. */
export let _requestsOnNewConnection = 0;
export let _requestsOnReusedConnection = 0;

/** Per-peer rolling probe counter (keyed by peer IP /24 prefix). Only active for /livez probes. */
const _probeCounter: Map<string, { count: number; windowStartMs: number }> = new Map();
const PROBE_WINDOW_MS = 10_000;
const PROBE_BURST_THRESHOLD = 5;
const PROBE_START_HEADER_MAX_LAG_MS = 5 * 60_000;
const PROBE_START_HEADER_MAX_FUTURE_MS = 1_000;

export interface RequestLifecycleTiming {
  handlerStartUnixMs: number;
  socketConnectedUnixMs: number | null;
  socketAgeBeforeHandlerMs: number | null;
  socketIdleBeforeRequestMs: number | null;
  httpRequestEventUnixMs: number | null;
  socketAcceptedToHttpRequestEventMs: number | null;
  httpRequestEventToHandlerStartMs: number | null;
  socketIdleBeforeHttpRequestEventMs: number | null;
  socketRequestIndex: number;
  socketHadServedRequest: boolean;
  clientProbeStartUnixMs: number | null;
  clientProbeStartToHandlerStartMs: number | null;
  clientProbeStartToSocketConnectedMs: number | null;
  /** Client probe start to Node HTTP request event (ms). Distinguishes client pool artifact from server-side idle. */
  clientProbeStartToHttpRequestEventMs: number | null;
  /** Socket connected (TCP accept) to first data byte on socket (ms). Pure accept/scheduling wait, excluding HTTP parser. */
  socketConnectedToFirstDataMs: number | null;
  /** First data byte on socket to HTTP 'request' event (ms). Pure HTTP parser/read delay. */
  firstDataToHttpRequestEventMs: number | null;
  /** Last response finish to next request first data byte on reused socket (ms). Wire idle only, excludes event-loop dispatch. */
  reuseIdleBeforeDataMs: number | null;
  /** Next request first data byte to HTTP request event on reused socket (ms). Data arrived but event-loop blocked before HTTP parser. */
  reuseDataToHttpRequestEventMs: number | null;
}

/** Tags a socket with metadata on accept. Called once per TCP connection. */
export function trackServerConnection(socket: import("node:net").Socket): void {
  _totalConnections++;
  _activeConnections++;
  if (_activeConnections > _peakConnections) {
    _peakConnections = _activeConnections;
  }
  (socket as any).__a2aConnectedAt = performance.now();
  (socket as any).__a2aConnectedAtUnixMs = Date.now();
  (socket as any).__a2aHasServedRequest = false;
  (socket as any).__a2aRequestsServed = 0;
  // Record the first data byte arrival on the socket to separate pure
  // accept/scheduling wait (connected → first data) from HTTP parser/read
  // delay (first data → 'request' event).  once() self-removes after first
  // fire; the listener does NOT consume data — all 'data' listeners on the
  // same socket receive the same chunk in flowing mode.
  (socket as any).__a2aFirstDataAt = null;
  socket.once("data", () => {
    (socket as any).__a2aFirstDataAt = performance.now();
  });
  socket.on("close", () => {
    _activeConnections = Math.max(0, _activeConnections - 1);
    const dur = Math.round((performance.now() - (socket as any).__a2aConnectedAt) * 1000) / 1000;
    _connectionDurationWindow.record(dur);
  });
}

/** Stamp the Node HTTP "request" event before the main handler runs. */
export function markHttpRequestEvent(req: IncomingMessage): void {
  (req as any).__a2aHttpRequestEventAt = performance.now();
  (req as any).__a2aHttpRequestEventAtUnixMs = Date.now();
}

function parseProbeStartHeader(req: IncomingMessage, handlerStartUnixMs: number): number | null {
  const raw = req.headers["x-a2a-probe-start-unix-ms"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < handlerStartUnixMs - PROBE_START_HEADER_MAX_LAG_MS) return null;
  if (parsed > handlerStartUnixMs + PROBE_START_HEADER_MAX_FUTURE_MS) return null;
  return parsed;
}

export function readRequestLifecycleTiming(req: IncomingMessage): RequestLifecycleTiming | null {
  return ((req as any).__a2aRequestLifecycle ?? null) as RequestLifecycleTiming | null;
}

/** Returns a snapshot of probe burst peers for diagnostic display. Lightweight scan of active entries. */
// Bound on distinct peer /24 prefixes tracked for /livez probe-burst detection.
const PROBE_COUNTER_MAX_ENTRIES = 4096;

function pruneProbeCounter(now: number): void {
  // Drop entries whose window has expired (the readers already ignore these).
  for (const [prefix, entry] of _probeCounter) {
    if (now - entry.windowStartMs > PROBE_WINDOW_MS) {
      _probeCounter.delete(prefix);
    }
  }
  // If still over the cap (many active prefixes), evict the oldest by window
  // start so the map cannot grow without bound.
  if (_probeCounter.size > PROBE_COUNTER_MAX_ENTRIES) {
    const oldestFirst = [..._probeCounter.entries()].sort(
      (a, b) => a[1].windowStartMs - b[1].windowStartMs,
    );
    const toRemove = _probeCounter.size - PROBE_COUNTER_MAX_ENTRIES;
    for (let i = 0; i < toRemove; i++) {
      _probeCounter.delete(oldestFirst[i]![0]);
    }
  }
}

export function readProbeBursts(): Array<{ peerPrefix: string; count: number; ageMs: number }> {
  const now = Date.now();
  const bursts: Array<{ peerPrefix: string; count: number; ageMs: number }> = [];
  for (const [prefix, entry] of _probeCounter) {
    if (now - entry.windowStartMs > PROBE_WINDOW_MS) continue;
    if (entry.count >= PROBE_BURST_THRESHOLD) {
      bursts.push({ peerPrefix: prefix, count: entry.count, ageMs: now - entry.windowStartMs });
    }
  }
  return bursts;
}
