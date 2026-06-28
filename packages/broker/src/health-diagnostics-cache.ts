// Health diagnostics cache, extracted from server.ts. Wraps the persistence /
// hot-audit / hot-table-growth diagnostics read behind a short TTL so repeated
// /healthz probes do not re-query the state store every time. Holds the prior
// hot-table metrics snapshot to compute growth rate across refreshes.
import { projectHotTableGrowth, type HotTableGrowthProjection } from "./core/hot-table-growth.js";
import {
  CURRENT_BROKER_STATE_VERSION,
  SqliteBrokerStateStore,
  type BrokerHotAuditDiagnostics,
  type BrokerHotTableLoadMetrics,
  type BrokerPersistenceInfo,
  type BrokerStateStore,
} from "./core/store.js";

const DEFAULT_HEALTH_DIAGNOSTICS_TTL_MS = 5_000;

type CachedHealthDiagnostics = {
  persistence: BrokerPersistenceInfo;
  auditDiagnostics: BrokerHotAuditDiagnostics | undefined;
  hotTableGrowth: HotTableGrowthProjection | undefined;
};

export class HealthDiagnosticsCache {
  private cached: CachedHealthDiagnostics | null = null;
  private cachedAt = 0;
  private readonly ttlMs: number;
  /** Prior snapshot of hot-table load metrics, used to compute growth rate across cache refreshes. */
  private priorMetrics: BrokerHotTableLoadMetrics | undefined;
  /** Timestamp of the prior snapshot. */
  private priorGeneratedAt: string | undefined;

  constructor(ttlMs: number = DEFAULT_HEALTH_DIAGNOSTICS_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(
    stateStore: BrokerStateStore,
    extra?: {
      processMemory?: {
        rssBytes: number;
        heapTotalBytes: number;
        heapUsedBytes: number;
        heapLimitBytes: number;
      };
      snapshotMetrics?: {
        lastSnapshotBytes?: number | null;
        lastPersistDurationMs?: number | null;
        lastSnapshotAt?: string | null;
      };
    },
  ): { persistence: BrokerPersistenceInfo; auditDiagnostics: BrokerHotAuditDiagnostics | undefined; hotTableGrowth: HotTableGrowthProjection | undefined; fromCache: boolean } {
    const now = Date.now();
    if (this.cached !== null && now - this.cachedAt < this.ttlMs) {
      return { ...this.cached, fromCache: true };
    }
    const persistence = stateStore.getPersistenceInfo?.() ?? {
      kind: "custom",
      stateVersion: CURRENT_BROKER_STATE_VERSION,
    };
    const auditDiagnostics = stateStore instanceof SqliteBrokerStateStore
      ? stateStore.readHotAuditDiagnostics()
      : undefined;

    // Compute hot-table growth projection from current load metrics.
    let hotTableGrowth: HotTableGrowthProjection | undefined;
    if (persistence.hotTableLoadMetrics) {
      hotTableGrowth = projectHotTableGrowth({
        current: persistence.hotTableLoadMetrics,
        prior: this.priorMetrics,
        priorGeneratedAt: this.priorGeneratedAt,
        runtimeLoadLimits: persistence.hotTableRuntimeLoadLimits,
        maxWarnings: 10,
        ...(extra?.processMemory ? { processMemory: extra.processMemory } : {}),
        ...(extra?.snapshotMetrics ? { snapshotMetrics: extra.snapshotMetrics } : {}),
      });
    }

    // Rotate prior snapshot for the next cache refresh.
    if (persistence.hotTableLoadMetrics) {
      this.priorMetrics = persistence.hotTableLoadMetrics;
      this.priorGeneratedAt = hotTableGrowth?.generatedAt;
    }

    this.cached = { persistence, auditDiagnostics, hotTableGrowth };
    this.cachedAt = now;
    return { persistence, auditDiagnostics, hotTableGrowth, fromCache: false };
  }
}
