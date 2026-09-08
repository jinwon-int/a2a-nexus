/**
 * Slice N, first part: P1 loss monitor.
 *
 * Decision P1+S1 on #1504: a background inspect of the serving fence
 * latches the first `lost_fence` for the process lifetime, logs one
 * closed reason, and asks the caller to drop connections. Slice N,
 * second part (D1) closes every HTTP connection, not only idle ones.
 * Slice N, third part (D3a) then exits 1 after that close. It does not
 * call `beginDrain`, release the token, or add a lease.
 * `adapter_unavailable` is not latched. The ownership-and-loss
 * monitoring item stays unchecked because drain is not this slice.
 * 488/489 stay decision C.
 */

import type { SharedStateServingFenceProbeV1 } from "./shared-state-serving-fence-v1.js";

export const SHARED_STATE_LOSS_MONITOR_V1 = Object.freeze({
  intervalMs: 1000,
  logLine: "[a2a-broker] shared-state serving fence lost: lost_fence",
} as const);

// #2079 B: request paths reuse the last probe within this window instead of
// issuing their own SELECT per request. The background tick (1s) keeps the
// cache continuously fresh while the monitor runs, so detection latency for
// the one-way lost_fence transition stays bounded by the tick, not the TTL.
export const SHARED_STATE_SERVING_AUTHORITY_PROBE_MAX_AGE_MS = 1500;

export interface SharedStateLossMonitorV1 {
  /** Live probe (and latch evaluation). Drives the background tick. */
  inspect(): SharedStateServingFenceProbeV1;
  /**
   * #2079 B: request-path accessor. Serves the last probe within the cache
   * TTL; falls back to a live inspect when stale. Latched state short-circuits
   * without probing.
   */
  inspectCached(): SharedStateServingFenceProbeV1;
  latched(): boolean;
  start(intervalMs?: number): void;
  stop(): void;
}

export function createSharedStateLossMonitorV1(input: {
  readonly probe: () => SharedStateServingFenceProbeV1;
  readonly onLostFence?: () => void;
  /** #2079 B: request-path probe cache TTL. Defaults to the 1500ms window. */
  readonly probeMaxAgeMs?: number;
}): SharedStateLossMonitorV1 {
  const probeMaxAgeMs = input.probeMaxAgeMs ?? SHARED_STATE_SERVING_AUTHORITY_PROBE_MAX_AGE_MS;
  let lostFenceLatched = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cached: { probe: SharedStateServingFenceProbeV1; at: number } | undefined;

  const inspect = (): SharedStateServingFenceProbeV1 => {
    if (lostFenceLatched) {
      return Object.freeze({ ready: false, reasonCode: "lost_fence" });
    }
    const observed = input.probe();
    cached = { probe: observed, at: Date.now() };
    if (!observed.ready && observed.reasonCode === "lost_fence") {
      lostFenceLatched = true;
      console.warn(SHARED_STATE_LOSS_MONITOR_V1.logLine);
      input.onLostFence?.();
    }
    return observed;
  };

  // #2079 B: request-path accessor. Reuses the last probe within the TTL
  // window instead of issuing a serving-fence SELECT per request; the
  // background tick keeps the cache continuously fresh while the monitor
  // runs, and a stale cache (monitor off) falls back to a live inspect.
  const inspectCached = (): SharedStateServingFenceProbeV1 => {
    if (lostFenceLatched) {
      return Object.freeze({ ready: false, reasonCode: "lost_fence" });
    }
    const cachedEntry = cached;
    if (cachedEntry && Date.now() - cachedEntry.at < probeMaxAgeMs) {
      return cachedEntry.probe;
    }
    return inspect();
  };

  return Object.freeze({
    inspect,
    inspectCached,
    latched(): boolean {
      return lostFenceLatched;
    },
    start(intervalMs = SHARED_STATE_LOSS_MONITOR_V1.intervalMs): void {
      if (timer !== undefined) return;
      timer = setInterval(inspect, intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  });
}
