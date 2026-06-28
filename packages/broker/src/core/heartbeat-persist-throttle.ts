// Heartbeat-persist throttle, extracted from the InMemoryA2ABroker god-class
// (collaborator pattern from #1075-#1078). Owns a per-key map of the last time a
// heartbeat was durably persisted and answers whether enough time has elapsed to
// persist again. The broker keeps one instance per throttled stream (worker
// heartbeats, task heartbeat-audit samples) and delegates the decision to it.
//
// Touches only its own map plus the pure pruneMapEntries helper, so it is cleanly
// separable from the broker.
import { pruneMapEntries } from "./broker-retention-selectors.js";

export class HeartbeatPersistThrottle {
  private readonly lastPersistedAtMs = new Map<string, number>();

  /**
   * Whether a heartbeat for `key` should be persisted now. Persists when the
   * interval is disabled (0), when the caller forces it (e.g. a material change),
   * or when at least `intervalMs` has elapsed since the last persist.
   */
  shouldPersist(key: string, nowMs: number, intervalMs: number, force = false): boolean {
    if (force || intervalMs === 0) {
      return true;
    }
    const lastPersistedAtMs = this.lastPersistedAtMs.get(key) ?? 0;
    return nowMs - lastPersistedAtMs >= intervalMs;
  }

  /** Record that a heartbeat for `key` was persisted at `atMs`. */
  markPersisted(key: string, atMs: number): void {
    this.lastPersistedAtMs.set(key, atMs);
  }

  /** Drop throttle entries for keys no longer retained. */
  prune(retainedKeys: Set<string>): void {
    pruneMapEntries(this.lastPersistedAtMs, retainedKeys);
  }
}
