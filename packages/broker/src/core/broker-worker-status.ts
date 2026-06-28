// Worker status, staleness, and mobile-health derivation extracted from
// broker.ts. These are pure functions over worker records plus the mobile
// offline/disconnect thresholds they classify against; they hold no broker
// state. The MOBILE_* thresholds live here with the logic that uses them and
// are re-exported from broker.ts to preserve the existing public surface.
import type {
  WorkerRecord,
  WorkerView,
  WorkerMobileHealth,
  WorkerPlaneStatus,
  ManagementPlaneStatus,
} from "./types.js";

/**
 * Shorter stale window for mobile workers (Termux/Hermes, battery-powered).
 * Mobile nodes may briefly sleep (Doze, lid close, network suspend), so this
 * threshold reflects expected brief offline windows — 30 seconds.
 */
export const MOBILE_OFFLINE_AFTER_MS = 30_000;

/**
 * Extended gap after which a mobile worker is considered fully disconnected
 * rather than merely stale. Workers exceeding this threshold without any
 * heartbeat are classified as `"disconnected"`.
 */
export const MOBILE_DISCONNECTED_AFTER_MS = 90_000;

export function computeWorkerStatus(
  lastSeenAt: string,
  offlineAfterMs: number,
): WorkerView["status"] {
  return Date.now() - Date.parse(lastSeenAt) <= offlineAfterMs ? "online" : "stale";
}

export function toWorkerViewRecord(worker: WorkerRecord, offlineAfterMs: number): WorkerView {
  const status = computeWorkerStatus(worker.lastSeenAt, offlineAfterMs);
  const workerPlane: WorkerPlaneStatus = status === "online" ? "online" : "unknown";
  const managementPlane: ManagementPlaneStatus = worker.managementPlane ?? "unknown";
  const updateEligible = workerPlane === "online" && managementPlane !== "disconnected";

  return {
    ...worker,
    status,
    workerPlane,
    managementPlane,
    updateEligible,
  };
}

export function isWorkerStale(lastSeenAt: string, offlineAfterMs: number, nowMs: number): boolean {
  const lastSeenMs = Date.parse(lastSeenAt);
  if (!Number.isFinite(lastSeenMs)) {
    return false;
  }

  return nowMs - lastSeenMs > offlineAfterMs;
}

/**
 * Compute the effective offline-after threshold for a worker based on its
 * declared `workerMode`. Mobile workers get a shorter window (30s default)
 * so the broker correctly classifies brief Doze/sleep gaps as "online" and
 * longer absences as "stale" or "disconnected".
 */
export function effectiveOfflineAfterMs(workerMode: string | undefined, defaultMs: number): number {
  return workerMode === "mobile" ? MOBILE_OFFLINE_AFTER_MS : defaultMs;
}

/**
 * Compute an enriched health status for a mobile worker.
 *
 * Returns `undefined` for persistent workers so callers that want compact
 * output (dashboard consumers, operator event lanes) can omit the field.
 *
 * Classification:
 * - `health_ok`:        heartbeat within mobile stale window (≤ 30s)
 * - `stale`:            heartbeat within extended window (30s < age ≤ 90s)
 * - `disconnected`:     heartbeat well beyond extended window (> 90s)
 */
export function computeWorkerMobileHealth(
  workerMode: string | undefined,
  lastSeenAt: string | undefined,
  nowMs: number,
): WorkerMobileHealth | undefined {
  if (workerMode !== "mobile") return undefined;

  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (!Number.isFinite(lastSeenMs)) return "disconnected";

  const ageMs = nowMs - lastSeenMs;
  if (ageMs <= MOBILE_OFFLINE_AFTER_MS) return "health_ok";
  if (ageMs <= MOBILE_DISCONNECTED_AFTER_MS) return "stale";
  return "disconnected";
}
