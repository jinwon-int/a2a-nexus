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
  // #2079 C: key-wise comparison instead of serializing both records — same
  // semantics (string→string record equality) without the per-heartbeat JSON
  // string allocations.
  const materialA = materialWorkerMetadata(a);
  const materialB = materialWorkerMetadata(b);
  const keysA = Object.keys(materialA ?? {});
  const keysB = Object.keys(materialB ?? {});
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => (materialA ?? {})[key] === (materialB ?? {})[key]);
}

function stringArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * #2079 C: field comparison for the per-heartbeat capability equality checks
 * (register/heartbeat paths serialized both capability records to JSON two to
 * four times per heartbeat). Every WorkerCapabilities field is compared;
 * arrays element-wise in order (both inputs come from the same normalizer, so
 * insertion order is canonical), provider-capability entries per field, and
 * absent optionals normalize to undefined on both sides.
 */
export function workerCapabilitiesEqual(a: WorkerCapabilities, b: WorkerCapabilities): boolean {
  if (
    a.canAnalyze !== b.canAnalyze ||
    a.canBackfill !== b.canBackfill ||
    a.canPatchWorkspace !== b.canPatchWorkspace ||
    a.canPromoteLive !== b.canPromoteLive
  ) {
    return false;
  }
  if (!stringArrayEqual(a.workspaceIds, b.workspaceIds)) return false;
  if (!stringArrayEqual(a.environments, b.environments)) return false;

  const providersA = a.providerCapabilities ?? [];
  const providersB = b.providerCapabilities ?? [];
  if (providersA.length !== providersB.length) return false;
  for (let index = 0; index < providersA.length; index += 1) {
    const left = providersA[index]!;
    const right = providersB[index]!;
    if (
      left.providerId !== right.providerId ||
      (left.modelFamily ?? null) !== (right.modelFamily ?? null) ||
      (left.modelId ?? null) !== (right.modelId ?? null) ||
      left.routeKind !== right.routeKind ||
      left.availability !== right.availability ||
      (left.lastVerifiedAt ?? null) !== (right.lastVerifiedAt ?? null)
    ) {
      return false;
    }
  }

  const implA = a.implementationCapability;
  const implB = b.implementationCapability;
  if (
    (implA?.capable ?? false) !== (implB?.capable ?? false) ||
    (implA?.runtime ?? null) !== (implB?.runtime ?? null) ||
    (implA?.providerId ?? null) !== (implB?.providerId ?? null) ||
    (implA?.modelTier ?? null) !== (implB?.modelTier ?? null) ||
    (implA?.availability ?? null) !== (implB?.availability ?? null) ||
    (implA?.lastVerifiedAt ?? null) !== (implB?.lastVerifiedAt ?? null) ||
    (implA?.evidenceId ?? null) !== (implB?.evidenceId ?? null)
  ) {
    return false;
  }

  return (
    (a.runtimeFlavor ?? null) === (b.runtimeFlavor ?? null) &&
    (a.gatewayRequired ?? null) === (b.gatewayRequired ?? null)
  );
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
  if (!workerCapabilitiesEqual(existing.capabilities, capabilities)) fields.push("capabilities");
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
  // #2078 B: freshness is a timestamp comparison; the old JSON.stringify
  // pre-check on the tie branch serialized both records' metadata on every
  // read. The material comparison alone decides the tie-break.
  if (
    cachedFreshnessMs === persistedFreshnessMs &&
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
