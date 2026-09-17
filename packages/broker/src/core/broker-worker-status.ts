// Worker status and staleness derivation extracted from broker.ts. These are pure functions over worker records plus the heartbeat
// liveness thresholds they classify against; they hold no broker state. The
// thresholds live here with the logic that uses them and are re-exported from
// broker.ts to preserve the existing public surface.
import type {
  WorkerRecord,
  WorkerView,
  WorkerPlaneStatus,
  ManagementPlaneStatus,
} from "./types.js";

/**
 * Neutral names for the pre-existing heartbeat-liveness ladder (#2065
 * retirement prerequisite): <= {@link HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS}
 * online, up to {@link HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS} stale, then
 * offline. These constants describe the EXISTING conversation-recipient
 * liveness ladder (`getConversationDeliverySummary`, every `workerMode`) —
 * they are NOT universal defaults for raw `GET /workers` surfaces,
 * `a2a.peer.status`, or the dashboard/capacity projections, which resolve
 * their own common `workerOfflineAfterMs ?? DEFAULT_WORKER_OFFLINE_AFTER_MS`
 * window, and NOT a new timeout policy. Do not adopt them as defaults for new
 * raw-worker, projection, or peer-status surfaces.
 */
export const HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS = 30_000;

/** See {@link HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS}: stale→offline boundary of
 * the existing conversation/legacy-health ladder, not a universal default. */
export const HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS = 90_000;

/**
 * Shorter stale window for mobile workers (Termux/Hermes, battery-powered).
 * Mobile nodes may briefly sleep (Doze, lid close, network suspend), so this
 * threshold reflects expected brief offline windows — 30 seconds.
 *
 * @deprecated Legacy mobile-only name kept as an EXACT-VALUE alias of the
 * neutral {@link HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS} so existing imports
 * compile and behave identically. New code should prefer the neutral name;
 * neither constant is a universal raw-worker/`a2a.peer.status` default.
 */
export const MOBILE_OFFLINE_AFTER_MS = HEARTBEAT_LIVENESS_ONLINE_WINDOW_MS;

/**
 * Extended gap after which a mobile worker is considered fully disconnected
 * rather than merely stale. Workers exceeding this threshold without any
 * heartbeat are classified as `"disconnected"`.
 *
 * @deprecated Legacy mobile-only name kept as an EXACT-VALUE alias of the
 * neutral {@link HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS} so existing imports
 * compile and behave identically. New code should prefer the neutral name.
 */
export const MOBILE_DISCONNECTED_AFTER_MS = HEARTBEAT_LIVENESS_OFFLINE_AFTER_MS;

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
  const analysisAdapterMismatch = workerAnalysisAdapterMismatch(worker.metadata);

  return {
    ...worker,
    status,
    workerPlane,
    managementPlane,
    updateEligible,
    substantiveAnalysisReady: isWorkerSubstantiveAnalysisReady(worker),
    ...(analysisAdapterMismatch ? { analysisAdapterMismatch } : {}),
  };
}

/**
 * Derived analysis readiness (#1597, routed from #1725 finding 2): a worker is
 * substantively analysis-ready only when it advertises `canAnalyze` AND its
 * registration-time handler-artifact probe did not fail. Workers that never
 * published the probe metadata (`analysisReady` absent) keep their
 * pre-existing readiness, so this projection never darkens an unprobed
 * legacy worker — those are still guarded at execution time by the
 * handler-side bridge-artifact preflight.
 */
export function isWorkerSubstantiveAnalysisReady(worker: WorkerRecord): boolean {
  if (worker.capabilities?.canAnalyze !== true) return false;
  if (worker.metadata?.analysisReady === "false") return false;
  return workerAnalysisAdapterMismatch(worker.metadata) === undefined;
}

/**
 * #1895: adapter/harness metadata claims must not contradict the resolved
 * analysis handler path. Workers labeled claude once executed the piri bridge
 * for every analysis run (2026-08-19), silently mis-attributing the lane.
 * Returns a human-readable mismatch reason, or undefined when the metadata is
 * consistent — or carries no evaluable signal (legacy/unprobed workers stay
 * untouched, matching the analysisReady probe's non-darkening guarantee).
 */
const ADAPTER_KEYWORDS = ["codex", "claude", "hermes", "piri"] as const;

function adapterKeywordOf(value: string | undefined): string {
  const text = (value ?? "").toLowerCase();
  for (const keyword of ADAPTER_KEYWORDS) {
    if (text.includes(keyword)) return keyword;
  }
  return "";
}

export function workerAnalysisAdapterMismatch(metadata: Record<string, string> | undefined): string | undefined {
  const handlerPath = metadata?.analysisHandlerPath;
  const handlerSignal = adapterKeywordOf(handlerPath?.split("/").pop());
  if (!handlerSignal) return undefined;
  for (const field of ["harness", "adapter"] as const) {
    const claimValue = metadata?.[field];
    const claim = adapterKeywordOf(claimValue);
    if (claim && claim !== handlerSignal) {
      return `analysis adapter metadata mismatch: metadata.${field} says ${claimValue}, but analysisHandlerPath is ${handlerPath}`;
    }
  }
  return undefined;
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


