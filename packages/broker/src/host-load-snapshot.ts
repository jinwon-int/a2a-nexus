// Host-level scheduling snapshot, extracted from server.ts. Reads the OS load
// averages and CPU count, derives a per-CPU load figure, and caches the result
// for up to one second so repeated /schedz diagnostics reads don't re-query the
// OS on every request. Self-contained: the cache lives in module-private state
// touched only by readHostLoadSnapshot().
import { loadavg, cpus } from "node:os";

export interface HostLoadSnapshot {
  loadavg1: number;
  loadavg5: number;
  loadavg15: number;
  cpuCount: number;
  loadPerCpu: number;
  snapshotAtMs: number;
}

let _cachedHostLoad: HostLoadSnapshot | null = null;
let _cachedHostLoadAt = 0;

/** Lazily-cached host-level scheduling snapshot (refreshed at most once per second). */
export function readHostLoadSnapshot(): HostLoadSnapshot {
  const now = Date.now();
  if (_cachedHostLoad && now - _cachedHostLoadAt < 1000) {
    return _cachedHostLoad;
  }
  const avg = loadavg();
  const cpuInfo = cpus();
  const cpuCount = cpuInfo.length;
  _cachedHostLoad = {
    loadavg1: avg[0],
    loadavg5: avg[1],
    loadavg15: avg[2],
    cpuCount,
    loadPerCpu: cpuCount > 0 ? Math.round((avg[0] / cpuCount) * 1000) / 1000 : 0,
    snapshotAtMs: now,
  };
  _cachedHostLoadAt = now;
  return _cachedHostLoad;
}
