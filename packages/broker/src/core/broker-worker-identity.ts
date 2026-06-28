// Worker identity, metadata-equality, and record freshness helpers extracted
// from broker.ts. Pure functions that fingerprint/compare worker identity and
// metadata and choose the fresher of two worker records. normalizeWorkerRecord
// canonicalizes a record's capabilities via the capability normalizer module.
import { normalizeCapabilities } from "./broker-capability-normalizers.js";
import type { RegisterWorkerRequest, WorkerCapabilities, WorkerRecord } from "./types.js";

const EPHEMERAL_WORKER_HEARTBEAT_METADATA_KEYS = new Set([
  "heartbeatAt",
  "heartbeatAtEpochMs",
  "lastHeartbeatAt",
]);

export function workerMetadataMateriallyEqual(
  a?: Record<string, string>,
  b?: Record<string, string>,
): boolean {
  return JSON.stringify(materialWorkerMetadata(a)) === JSON.stringify(materialWorkerMetadata(b));
}

export function workerIdentityFingerprint(
  request: RegisterWorkerRequest,
  capabilities: WorkerCapabilities,
): string {
  return JSON.stringify({
    role: request.role,
    displayName: request.displayName ?? null,
    brokerUrl: request.brokerUrl ?? null,
    workerMode: request.workerMode ?? null,
    managementPlane: request.managementPlane ?? null,
    capabilities,
    metadata: materialWorkerMetadata(request.metadata),
  });
}

export function workerIdentityChangedFields(
  existing: WorkerRecord,
  request: RegisterWorkerRequest,
  capabilities: WorkerCapabilities,
): string[] {
  const fields: string[] = [];
  if (existing.role !== request.role) fields.push("role");
  if (existing.displayName !== request.displayName) fields.push("displayName");
  if (existing.brokerUrl !== request.brokerUrl) fields.push("brokerUrl");
  if (existing.workerMode !== request.workerMode) fields.push("workerMode");
  if (existing.managementPlane !== request.managementPlane) fields.push("managementPlane");
  if (JSON.stringify(existing.capabilities) !== JSON.stringify(capabilities)) fields.push("capabilities");
  if (!workerMetadataMateriallyEqual(existing.metadata, request.metadata)) fields.push("metadata");
  return fields.length > 0 ? fields : ["unknown"];
}

export function materialWorkerMetadata(metadata?: Record<string, string>): Record<string, string> | null {
  if (!metadata) return null;
  const entries = Object.entries(metadata)
    .filter(([key]) => !EPHEMERAL_WORKER_HEARTBEAT_METADATA_KEYS.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

export function normalizeWorkerRecord(worker: WorkerRecord): WorkerRecord {
  return {
    ...worker,
    capabilities: normalizeCapabilities(worker.capabilities),
  };
}

export function chooseFresherWorkerRecord(cachedWorker: WorkerRecord | null, persistedWorker: WorkerRecord): WorkerRecord {
  if (!cachedWorker) {
    return persistedWorker;
  }
  const cachedFreshnessMs = workerFreshnessMs(cachedWorker);
  const persistedFreshnessMs = workerFreshnessMs(persistedWorker);
  if (cachedFreshnessMs > persistedFreshnessMs) {
    return cachedWorker;
  }
  if (
    cachedFreshnessMs === persistedFreshnessMs &&
    JSON.stringify(cachedWorker.metadata ?? null) !== JSON.stringify(persistedWorker.metadata ?? null) &&
    workerMetadataMateriallyEqual(cachedWorker.metadata, persistedWorker.metadata)
  ) {
    return cachedWorker;
  }
  return persistedWorker;
}

export function workerFreshnessMs(worker: WorkerRecord): number {
  return Math.max(
    safeTimestampMs(worker.updatedAt),
    safeTimestampMs(worker.lastSeenAt),
    safeTimestampMs(worker.createdAt),
  );
}

export function safeTimestampMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
