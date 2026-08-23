/**
 * Slice N, first part: P1 loss monitor.
 *
 * Decision P1+S1 on #1504: a background inspect of the serving fence
 * latches the first `lost_fence` for the process lifetime, logs one
 * closed reason, and asks the caller to drop idle connections. It does
 * not call `beginDrain`, exit the process, release the token, or add a
 * lease. `adapter_unavailable` is not latched. The ownership-and-loss
 * monitoring item stays unchecked because drain/shutdown is not this
 * slice. 488/489 stay decision C.
 */

import type { SharedStateServingFenceProbeV1 } from "./shared-state-serving-fence-v1.js";

export const SHARED_STATE_LOSS_MONITOR_V1 = Object.freeze({
  intervalMs: 1000,
  logLine: "[a2a-broker] shared-state serving fence lost: lost_fence",
} as const);

export interface SharedStateLossMonitorV1 {
  inspect(): SharedStateServingFenceProbeV1;
  latched(): boolean;
  start(intervalMs?: number): void;
  stop(): void;
}

export function createSharedStateLossMonitorV1(input: {
  readonly probe: () => SharedStateServingFenceProbeV1;
  readonly onLostFence?: () => void;
}): SharedStateLossMonitorV1 {
  let lostFenceLatched = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const inspect = (): SharedStateServingFenceProbeV1 => {
    if (lostFenceLatched) {
      return Object.freeze({ ready: false, reasonCode: "lost_fence" });
    }
    const observed = input.probe();
    if (!observed.ready && observed.reasonCode === "lost_fence") {
      lostFenceLatched = true;
      console.warn(SHARED_STATE_LOSS_MONITOR_V1.logLine);
      input.onLostFence?.();
    }
    return observed;
  };

  return Object.freeze({
    inspect,
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
