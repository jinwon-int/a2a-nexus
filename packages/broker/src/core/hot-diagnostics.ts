export interface BrokerHotHintCounts {
  hotExchanges: number;
  hotExchangeMessages: number;
  hotProposals: number;
  hotArtifacts: number;
  hotValidations: number;
  hotTasks: number;
  hotTombstones: number;
  hotAuditEvents: number;
  hotWorkers: number;
  hotTerminalOutboxEvents: number;
}

export interface BrokerHotEntityDiagnostics {
  invalidRows: BrokerInvalidHotEntityRow[];
}

export interface BrokerInvalidHotEntityRow {
  table: string;
  primaryKey: string;
  schemaError: string;
  count: number;
}

export interface BrokerHotEntityHintCoverage {
  ok: boolean;
  supportedTables: string[];
  missingTables: string[];
  supportedCount: number;
  totalCount: number;
}

export interface BrokerHotEntityMirrorStatus {
  ok: boolean;
  tableCounts: Record<string, number>;
  snapshotCounts?: Record<string, number>;
  mismatches: BrokerHotEntityMirrorMismatch[];
  retentionWindows?: BrokerHotEntityMirrorRetentionWindow[];
}

export interface BrokerHotEntityMirrorMismatch {
  table: string;
  snapshotKey: string;
  tableCount: number;
  snapshotCount: number;
  reason?: "count_drift" | "id_drift" | "audit_hot_retention";
}

export interface BrokerHotEntityMirrorRetentionWindow extends BrokerHotEntityMirrorMismatch {
  reason: "audit_hot_retention";
  prunedCount: number;
}

export interface BrokerHotAuditDiagnostics {
  total: number;
  heartbeat: number;
  heartbeatRatio: number;
  workerHeartbeat: number;
  workerHeartbeatRatio: number;
  taskHeartbeat: number;
  taskHeartbeatRatio: number;
  recentWindowMs: number;
  recentTotal: number;
  recentHeartbeat: number;
  recentHeartbeatRatio: number;
  recentWorkerHeartbeat: number;
  recentWorkerHeartbeatRatio: number;
  recentTaskHeartbeat: number;
  recentTaskHeartbeatRatio: number;
  warnings: string[];
}

export interface BrokerHotTerminalOutboxDiagnostics {
  total: number;
  acked: number;
  rawUnacked: number;
  unacked: number;
  ackEligibleUnacked: number;
  ackIneligibleUnacked: number;
  unackedRatio: number;
  oldestUnackedCreatedAt: string | null;
  oldestUnackedAgeMs: number | null;
  classification: "clean" | "recent_unacked_watch" | "ack_ineligible_historical_residue" | "actionable_review_required";
  actionableBacklog: boolean;
  ageBuckets: Record<"lt1d" | "1to7d" | "7to14d" | "gte14d" | "unknown", number>;
  byTerminalStatus: Record<string, number>;
  byReceiptStatus: Record<string, number>;
  byBrokerOfRecord: Record<string, number>;
  byWorker: Record<string, number>;
  warnings: string[];
}
