// Worker register/heartbeat phase timing, extracted from server.ts. Owns the
// per-phase and per-worker RequestTimingWindow ring buffers (module-level
// singletons, bounded and stale-evicted) used to attribute worker register and
// heartbeat latency by phase for the /schedz diagnostics. Only the record* and
// *Snapshot entry points are exported; the window-accessor helpers are private.
import { RequestTimingWindow, type RequestTimingSnapshot } from "./diagnostics/request-timing-window.js";

const WORKER_HEARTBEAT_PHASES = [
  "readJson",
  "authLookup",
  "authAssert",
  "brokerHeartbeat",
  "toWorkerView",
] as const;

type WorkerHeartbeatPhase = (typeof WORKER_HEARTBEAT_PHASES)[number];

const WORKER_REGISTER_PHASES = [
  "readJson",
  "authAssert",
  "brokerRegister",
  "toWorkerView",
] as const;

type WorkerRegisterPhase = (typeof WORKER_REGISTER_PHASES)[number];

const _workerRegisterPhaseTiming = new Map<WorkerRegisterPhase, RequestTimingWindow>();

function workerRegisterPhaseTimingWindow(phase: WorkerRegisterPhase): RequestTimingWindow {
  let window = _workerRegisterPhaseTiming.get(phase);
  if (!window) {
    window = new RequestTimingWindow(200);
    _workerRegisterPhaseTiming.set(phase, window);
  }
  return window;
}

export function recordWorkerRegisterPhase(phase: WorkerRegisterPhase, startedAt: number, workerId?: string): void {
  const elapsed = Math.round((performance.now() - startedAt) * 1000) / 1000;
  workerRegisterPhaseTimingWindow(phase).record(elapsed);
  if (workerId) {
    perWorkerRegisterPhaseTimingWindow(workerId, phase).record(elapsed);
    _perWorkerRegisterLastSeen.set(workerId, Date.now());
  }
}

export function workerRegisterPhaseTimingSnapshot(): Record<WorkerRegisterPhase, RequestTimingSnapshot> {
  const snapshot = {} as Record<WorkerRegisterPhase, RequestTimingSnapshot>;
  for (const phase of WORKER_REGISTER_PHASES) {
    snapshot[phase] = _workerRegisterPhaseTiming.get(phase)?.snapshot() ?? null;
  }
  return snapshot;
}

// Per-worker register phase timing (#1032 / Team2 jingun attribution).
const MAX_PER_WORKER_REGISTER_WORKERS = 500;
const PER_WORKER_REGISTER_STALE_AFTER_MS = 30 * 60 * 1000;
const _perWorkerRegisterPhaseTiming = new Map<string, Map<WorkerRegisterPhase, RequestTimingWindow>>();
const _perWorkerRegisterLastSeen = new Map<string, number>();

function perWorkerRegisterPhaseTimingWindow(workerId: string, phase: WorkerRegisterPhase): RequestTimingWindow {
  let perWorker = _perWorkerRegisterPhaseTiming.get(workerId);
  if (!perWorker) {
    if (_perWorkerRegisterPhaseTiming.size >= MAX_PER_WORKER_REGISTER_WORKERS) {
      const oldest = _perWorkerRegisterPhaseTiming.keys().next().value;
      if (oldest !== undefined) {
        _perWorkerRegisterPhaseTiming.delete(oldest);
        _perWorkerRegisterLastSeen.delete(oldest);
      }
    }
    perWorker = new Map();
    _perWorkerRegisterPhaseTiming.set(workerId, perWorker);
  }
  let window = perWorker.get(phase);
  if (!window) {
    window = new RequestTimingWindow(200);
    perWorker.set(phase, window);
  }
  return window;
}

export function workerRegisterPhasePerWorkerSnapshot(): Record<string, Record<string, RequestTimingSnapshot | null>> | null {
  if (_perWorkerRegisterPhaseTiming.size === 0) return null;
  const snapshot: Record<string, Record<string, RequestTimingSnapshot | null>> = {};
  const now = Date.now();
  for (const [workerId, phaseMap] of _perWorkerRegisterPhaseTiming) {
    const lastSeen = _perWorkerRegisterLastSeen.get(workerId);
    if (lastSeen !== undefined && now - lastSeen > PER_WORKER_REGISTER_STALE_AFTER_MS) {
      _perWorkerRegisterPhaseTiming.delete(workerId);
      _perWorkerRegisterLastSeen.delete(workerId);
      continue;
    }
    const phaseSnap: Record<string, RequestTimingSnapshot | null> = {};
    for (const phase of WORKER_REGISTER_PHASES) {
      phaseSnap[phase] = phaseMap.get(phase)?.snapshot() ?? null;
    }
    snapshot[workerId] = phaseSnap;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

const _workerHeartbeatPhaseTiming = new Map<WorkerHeartbeatPhase, RequestTimingWindow>();

function workerHeartbeatPhaseTimingWindow(phase: WorkerHeartbeatPhase): RequestTimingWindow {
  let window = _workerHeartbeatPhaseTiming.get(phase);
  if (!window) {
    window = new RequestTimingWindow(200);
    _workerHeartbeatPhaseTiming.set(phase, window);
  }
  return window;
}

export function recordWorkerHeartbeatPhase(phase: WorkerHeartbeatPhase, startedAt: number, workerId?: string): void {
  const elapsed = Math.round((performance.now() - startedAt) * 1000) / 1000;
  workerHeartbeatPhaseTimingWindow(phase).record(elapsed);
  if (workerId) {
    perWorkerHeartbeatPhaseTimingWindow(workerId, phase).record(elapsed);
    _perWorkerHeartbeatLastSeen.set(workerId, Date.now());
  }
}

export function workerHeartbeatPhaseTimingSnapshot(): Record<WorkerHeartbeatPhase, RequestTimingSnapshot> {
  const snapshot = {} as Record<WorkerHeartbeatPhase, RequestTimingSnapshot>;
  for (const phase of WORKER_HEARTBEAT_PHASES) {
    snapshot[phase] = _workerHeartbeatPhaseTiming.get(phase)?.snapshot() ?? null;
  }
  return snapshot;
}

// Per-worker heartbeat phase timing (#1032 / Team1 sogyo attribution)
// Distinguishes individual worker timing from the aggregate above.
const MAX_PER_WORKER_HEARTBEAT_WORKERS = 500;
const PER_WORKER_HEARTBEAT_STALE_AFTER_MS = 30 * 60 * 1000;
const _perWorkerHeartbeatPhaseTiming = new Map<string, Map<WorkerHeartbeatPhase, RequestTimingWindow>>();
const _perWorkerHeartbeatLastSeen = new Map<string, number>();

function perWorkerHeartbeatPhaseTimingWindow(workerId: string, phase: WorkerHeartbeatPhase): RequestTimingWindow {
  let perWorker = _perWorkerHeartbeatPhaseTiming.get(workerId);
  if (!perWorker) {
    if (_perWorkerHeartbeatPhaseTiming.size >= MAX_PER_WORKER_HEARTBEAT_WORKERS) {
      const oldest = _perWorkerHeartbeatPhaseTiming.keys().next().value;
      if (oldest !== undefined) {
        _perWorkerHeartbeatPhaseTiming.delete(oldest);
        _perWorkerHeartbeatLastSeen.delete(oldest);
      }
    }
    perWorker = new Map();
    _perWorkerHeartbeatPhaseTiming.set(workerId, perWorker);
  }
  let window = perWorker.get(phase);
  if (!window) {
    window = new RequestTimingWindow(200);
    perWorker.set(phase, window);
  }
  return window;
}

export function workerHeartbeatPhasePerWorkerSnapshot(): Record<string, Record<string, RequestTimingSnapshot | null>> | null {
  if (_perWorkerHeartbeatPhaseTiming.size === 0) return null;
  const snapshot: Record<string, Record<string, RequestTimingSnapshot | null>> = {};
  const now = Date.now();
  for (const [workerId, phaseMap] of _perWorkerHeartbeatPhaseTiming) {
    const lastSeen = _perWorkerHeartbeatLastSeen.get(workerId);
    if (lastSeen !== undefined && now - lastSeen > PER_WORKER_HEARTBEAT_STALE_AFTER_MS) {
      _perWorkerHeartbeatPhaseTiming.delete(workerId);
      _perWorkerHeartbeatLastSeen.delete(workerId);
      continue;
    }
    const phaseSnap: Record<string, RequestTimingSnapshot | null> = {};
    for (const phase of WORKER_HEARTBEAT_PHASES) {
      phaseSnap[phase] = phaseMap.get(phase)?.snapshot() ?? null;
    }
    snapshot[workerId] = phaseSnap;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}
