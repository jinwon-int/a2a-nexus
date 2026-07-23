// cgroup v2 CPU-throttling and PSI (pressure-stall) diagnostics readers,
// extracted from server.ts (#645 Phase 2). Self-contained: reads /sys and
// /proc files behind a short TTL cache; exposed on /schedz. No server or
// handler dependencies.
import { readFileSync } from "node:fs";

export interface CgroupCpuSnapshot {
  usageUsec: number;
  userUsec: number;
  systemUsec: number;
  /** Total number of scheduling periods observed by the CPU controller. */
  nrPeriods: number;
  /** Number of periods the group was throttled (descheduled by the container runtime). */
  nrThrottled: number;
  /** Aggregate time (usec) the group spent throttled. */
  throttledUsec: number;
  snapshotAtMs: number;
}

export interface CgroupCpuDelta {
  /** Δ usage_usec since the last /schedz poll. */
  deltaUsageUsec: number;
  /** Δ user_usec since the last /schedz poll. */
  deltaUserUsec: number;
  /** Δ system_usec since the last /schedz poll. */
  deltaSystemUsec: number;
  /** Δ nr_periods since the last /schedz poll. */
  deltaNrPeriods: number;
  /** Δ nr_throttled since the last /schedz poll. */
  deltaNrThrottled: number;
  /** Δ throttled_usec since the last /schedz poll. */
  deltaThrottledUsec: number;
  /** Wall-clock ms between the two snapshots. */
  wallMs: number;
}

export interface CgroupCpuLimit {
  quotaUsec: number;
  periodUsec: number;
  cpus: number;
}

export interface PressureStallSnapshot {
  cpu: { some: PressureStallEntry; full: PressureStallEntry } | null;
  memory: { some: PressureStallEntry; full: PressureStallEntry } | null;
  io: { some: PressureStallEntry; full: PressureStallEntry } | null;
  snapshotAtMs: number;
}

export interface PressureStallEntry {
  /** 10-second sliding-window avg, percentage × 100 (e.g. 1.94 = 1.94%). */
  avg10: number;
  /** 60-second moving avg. */
  avg60: number;
  /** 300-second moving avg. */
  avg300: number;
  /** Total accumulated stalled microseconds. */
  total: number;
}

/**
 * Read cgroup v2 CPU throttling from /sys/fs/cgroup/cpu.stat.
 * Returns null when the file is unavailable or unreadable.
 *
 * Interpreting throttling:
 * - nr_throttled > 0 and throttled_usec large → container was descheduled
 *   by the kernel cgroup CPU controller.  This is the strongest signal for
 *   host/container-level scheduling vs. handler-level latency.
 * - nr_periods = quota refresh cycles (usually 100ms each).
 * - A throttled_usec / nr_throttled ratio ≫ 100ms suggests multi-period
 *   throttling (container starved across boundaries).
 * - Zero nr_throttled with high schedulingTiming p999 → cause is NOT
 *   cgroup throttling (look for host load, NUMA, or event-loop starvation).
 */
function readCgroupCpuStats(): CgroupCpuSnapshot | null {
  try {
    const raw = readFileSysFs("/sys/fs/cgroup/cpu.stat");
    if (!raw) return null;
    const lines = raw.split("\n");
    const kv: Record<string, number> = {};
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) {
        kv[parts[0]] = Number(parts[1]);
      }
    }
    return {
      usageUsec: kv.usage_usec ?? 0,
      userUsec: kv.user_usec ?? 0,
      systemUsec: kv.system_usec ?? 0,
      nrPeriods: kv.nr_periods ?? 0,
      nrThrottled: kv.nr_throttled ?? 0,
      throttledUsec: kv.throttled_usec ?? 0,
      snapshotAtMs: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Read cgroup v2 CPU quota/period from /sys/fs/cgroup/cpu.max.
 * Returns null when unavailable.  A quota of "max" means no limit.
 */
function readCgroupCpuLimit(): CgroupCpuLimit | null {
  try {
    const raw = readFileSysFs("/sys/fs/cgroup/cpu.max");
    if (!raw) return null;
    const parts = raw.trim().split(/\s+/);
    if (parts.length !== 2) return null;
    if (parts[0] === "max") {
      return { quotaUsec: 0, periodUsec: Number(parts[1]) || 100000, cpus: 0 };
    }
    const quota = Number(parts[0]) || 0;
    const period = Number(parts[1]) || 100000;
    return {
      quotaUsec: quota,
      periodUsec: period,
      cpus: period > 0 ? quota / period : 0,
    };
  } catch {
    return null;
  }
}

// Keep /schedz cgroup/PSI reads bounded; live #1032 gates showed that
// very frequent synchronous sysfs/procfs reads can perturb the probe on brokerbeta.
const CGROUP_PSI_CACHE_TTL_MS = 3000;

// Lazily cached cgroup CPU stats refresh.
let _cachedCgroupCpu: CgroupCpuSnapshot | null = null;
let _cachedCgroupCpuAt = 0;
let _cachedCgroupLimit: CgroupCpuLimit | null = null;
let _cachedPsi: PressureStallSnapshot | null = null;
let _cachedPsiAt = 0;

/** Previous cgroup CPU snapshot used to compute per-poll deltas (#1102). */
let _prevCgroupCpu: CgroupCpuSnapshot | null = null;

export function readCgroupCpuSnapshot(): { stats: CgroupCpuSnapshot | null; limit: CgroupCpuLimit | null; delta: CgroupCpuDelta | null } {
  const now = Date.now();
  if (_cachedCgroupCpu && now - _cachedCgroupCpuAt < CGROUP_PSI_CACHE_TTL_MS) {
    // Reuse cached stats but still attempt a delta against the previous poll
    // (the delta computation only happens when a fresh read occurs).
    return { stats: _cachedCgroupCpu, limit: _cachedCgroupLimit, delta: null };
  }
  const stats = readCgroupCpuStats();
  const limit = readCgroupCpuLimit();

  // Compute per-poll delta against the last full read (#1102).
  let delta: CgroupCpuDelta | null = null;
  if (stats !== null && _prevCgroupCpu !== null) {
    const wallMs = Math.max(1, stats.snapshotAtMs - _prevCgroupCpu.snapshotAtMs);
    delta = {
      deltaUsageUsec: stats.usageUsec - _prevCgroupCpu.usageUsec,
      deltaUserUsec: stats.userUsec - _prevCgroupCpu.userUsec,
      deltaSystemUsec: stats.systemUsec - _prevCgroupCpu.systemUsec,
      deltaNrPeriods: stats.nrPeriods - _prevCgroupCpu.nrPeriods,
      deltaNrThrottled: stats.nrThrottled - _prevCgroupCpu.nrThrottled,
      deltaThrottledUsec: stats.throttledUsec - _prevCgroupCpu.throttledUsec,
      wallMs,
    };
  }

  _prevCgroupCpu = stats;
  _cachedCgroupCpu = stats;
  _cachedCgroupCpuAt = now;
  _cachedCgroupLimit = limit;
  return { stats, limit, delta };
}

/**
 * Parse a /proc/pressure/<resource> file into a structured entry.
 */
function parsePressureLine(line: string): PressureStallEntry | null {
  // Format: "some avg10=0.14 avg60=1.94 avg300=0.96 total=5958939009"
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;
  return {
    avg10: parseFloat(parts[1]?.split("=")[1] ?? "0"),
    avg60: parseFloat(parts[2]?.split("=")[1] ?? "0"),
    avg300: parseFloat(parts[3]?.split("=")[1] ?? "0"),
    total: parseInt(parts[4]?.split("=")[1] ?? "0", 10),
  };
}

/**
 * Read Pressure Stall Information from /proc/pressure/{cpu,memory,io}.
 * Returns null when /proc/pressure is unavailable (non-Linux, no kernel
 * support, restricted container).
 *
 * PSI metrics directly indicate resource contention:
 * - cpu.some.avg10 > 1 → tasks are waiting for CPU (run queue contention).
 * - cpu.full.avg10 > 0 → at least one task is stalled waiting for CPU
 *   while the CPU is idle (wake-up / migration delay).
 * - memory.some / memory.full → swapping or reclaim pressure.
 * - io.some / io.full → storage I/O is a bottleneck.
 */
function readPressureStall(): PressureStallSnapshot | null {
  try {
    const cpuRaw = readFileSysFs("/proc/pressure/cpu");
    const memRaw = readFileSysFs("/proc/pressure/memory");
    const ioRaw = readFileSysFs("/proc/pressure/io");
    if (!cpuRaw || !memRaw || !ioRaw) return null;

    const cpuLines = cpuRaw.trim().split("\n");
    const memLines = memRaw.trim().split("\n");
    const ioLines = ioRaw.trim().split("\n");

    return {
      cpu: {
        some: parsePressureLine(cpuLines.find((l) => l.startsWith("some")) ?? "") ?? { avg10: 0, avg60: 0, avg300: 0, total: 0 },
        full: parsePressureLine(cpuLines.find((l) => l.startsWith("full")) ?? "") ?? { avg10: 0, avg60: 0, avg300: 0, total: 0 },
      },
      memory: {
        some: parsePressureLine(memLines.find((l) => l.startsWith("some")) ?? "") ?? { avg10: 0, avg60: 0, avg300: 0, total: 0 },
        full: parsePressureLine(memLines.find((l) => l.startsWith("full")) ?? "") ?? { avg10: 0, avg60: 0, avg300: 0, total: 0 },
      },
      io: {
        some: parsePressureLine(ioLines.find((l) => l.startsWith("some")) ?? "") ?? { avg10: 0, avg60: 0, avg300: 0, total: 0 },
        full: parsePressureLine(ioLines.find((l) => l.startsWith("full")) ?? "") ?? { avg10: 0, avg60: 0, avg300: 0, total: 0 },
      },
      snapshotAtMs: Date.now(),
    };
  } catch {
    return null;
  }
}

export function readCgroupPsiSnapshot(): PressureStallSnapshot | null {
  const now = Date.now();
  if (_cachedPsi && now - _cachedPsiAt < CGROUP_PSI_CACHE_TTL_MS) {
    return _cachedPsi;
  }
  const psi = readPressureStall();
  _cachedPsi = psi;
  _cachedPsiAt = now;
  return psi;
}

/**
 * Read a /sys or /proc file with fallback to null.
 * Prefers in-memory cached reads over direct I/O.
 */
function readFileSysFs(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
