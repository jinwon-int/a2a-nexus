// Process/runtime diagnostics readers (memory, event-loop delay, GC, CPU),
// extracted from server.ts (#645 Phase 2). The event-loop histogram and GC
// observer initialise eagerly on import so early /livez samples are covered.
// Self-contained: process + node:perf_hooks + node:v8 only; no server deps.
import { getHeapStatistics } from "node:v8";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";

export function readRuntimeMemoryUsage(): Record<string, number> {
  const memory = process.memoryUsage();
  const heap = getHeapStatistics();
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    heapLimitBytes: heap.heap_size_limit,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

// Event-loop delay is a starvation metric, not total request latency. A
// loopback probe can observe a long wall-clock delay while this histogram stays
// low if the process was busy with CPU work, descheduled by the host, or
// waiting on async I/O. Correlate this value with process CPU and per-request
// duration before attributing an external /livez stall to the handler itself.
//
// Initialize eagerly so early /livez samples are covered instead of waiting for
// the first diagnostic read to create the histogram.
let _eventLoopDelayHistogram: ReturnType<typeof import("node:perf_hooks").monitorEventLoopDelay> | null = null;

function _initEventLoopHistogram(): void {
  if (_eventLoopDelayHistogram) return;
  try {
    _eventLoopDelayHistogram = monitorEventLoopDelay({ resolution: 20 });
    _eventLoopDelayHistogram.enable();
  } catch {
    // monitorEventLoopDelay unavailable (e.g. insufficient kernel
    // perf_event permissions or old Node version).
    // readEventLoopDelayMs() will return null gracefully.
  }
}
_initEventLoopHistogram();

export function readEventLoopDelayMs(): number | null {
  try {
    if (!_eventLoopDelayHistogram) return null;
    const p99 = _eventLoopDelayHistogram.percentile(99) / 1e6;
    const p50 = _eventLoopDelayHistogram.percentile(50) / 1e6;
    // Return max(p50, p99) as a conservative estimate; reset to avoid stale accumulation.
    _eventLoopDelayHistogram.reset();
    return Math.round(Math.max(p50, p99) * 1000) / 1000;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lightweight /livez attribution helpers (event-loop, GC, CPU, request timing)
// ---------------------------------------------------------------------------

// GC diagnostics via performance observer.
// Falls back to nulls silently when --experimental-performance-gc is absent.
let _gcObserverInitialized = false;
let _gcTotalMs = 0;
let _gcCount = 0;
let _gcLastGcMs = 0;
let _gcRecentMaxMs = 0;
let _gcRecentWindowStart = Date.now();
let _gcObserver: PerformanceObserver | null = null;

function _initGcObserver(): void {
  if (_gcObserverInitialized || _gcObserver) return;
  _gcObserverInitialized = true;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const durMs = entry.duration;
        _gcTotalMs += durMs;
        _gcCount += 1;
        _gcLastGcMs = durMs;
        // Rolling 60s window for recent extremes.
        const now = Date.now();
        if (now - _gcRecentWindowStart > 60_000) {
          _gcRecentMaxMs = durMs;
          _gcRecentWindowStart = now;
        } else {
          _gcRecentMaxMs = Math.max(_gcRecentMaxMs, durMs);
        }
      }
    });
    observer.observe({ entryTypes: ["gc"] });
    _gcObserver = observer;
  } catch {
    // Not available; gc fields will report 0 / null.
  }
}
_initGcObserver();

export function readGcDiagnostics(): { totalMs: number; count: number; lastMs: number; recentMax60sMs: number } {
  return {
    totalMs: Math.round(_gcTotalMs * 100) / 100,
    count: _gcCount,
    lastMs: Math.round(_gcLastGcMs * 100) / 100,
    recentMax60sMs: Math.round(_gcRecentMaxMs * 100) / 100,
  };
}

// CPU usage delta tracking.
let _lastCpuUsage = process.cpuUsage();
let _lastCpuUsageTime = Date.now();

export function readCpuDiagnostics(): {
  userMicrosec: number;
  systemMicrosec: number;
  deltaUserMicrosec: number;
  deltaSystemMicrosec: number;
  deltaIntervalMs: number;
  percentSinceLastCheck: number;
} {
  const now = Date.now();
  const current = process.cpuUsage();
  const elapsedMs = now - _lastCpuUsageTime;
  // Handle microsecond counter wrap by clamping to zero.
  const userDelta = current.user >= _lastCpuUsage.user ? current.user - _lastCpuUsage.user : 0;
  const systemDelta = current.system >= _lastCpuUsage.system ? current.system - _lastCpuUsage.system : 0;
  const totalDelta = userDelta + systemDelta;

  _lastCpuUsage = current;
  _lastCpuUsageTime = now;

  return {
    userMicrosec: current.user,
    systemMicrosec: current.system,
    deltaUserMicrosec: userDelta,
    deltaSystemMicrosec: systemDelta,
    deltaIntervalMs: elapsedMs,
    percentSinceLastCheck:
      elapsedMs > 0 ? Math.round(((totalDelta / 1000) / elapsedMs) * 10000) / 100 : 0,
  };
}
