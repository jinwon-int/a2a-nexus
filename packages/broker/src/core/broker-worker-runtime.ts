import { normalizeCapabilities } from "./broker-capability-normalizers.js";
import { workerMetadataMateriallyEqual } from "./broker-worker-identity.js";
import type {
  RegisterWorkerRequest,
  WorkerCapabilities,
  WorkerHeartbeatRequest,
  WorkerRecord,
} from "./types.js";

// Pure worker registration/heartbeat runtime helpers for InMemoryA2ABroker.
// They intentionally hold no broker state and perform no persistence/audit work.
export function normalizeWorkerRegistrationCapabilities(
  request: RegisterWorkerRequest,
): WorkerCapabilities {
  return normalizeCapabilities(request.capabilities);
}

export function workerRegistrationMateriallyChanges(
  existing: WorkerRecord | null,
  request: RegisterWorkerRequest,
  capabilities: WorkerCapabilities,
): boolean {
  return !existing ||
    existing.role !== request.role ||
    existing.displayName !== request.displayName ||
    existing.brokerUrl !== request.brokerUrl ||
    existing.workerMode !== request.workerMode ||
    existing.managementPlane !== request.managementPlane ||
    JSON.stringify(existing.capabilities) !== JSON.stringify(capabilities) ||
    !workerMetadataMateriallyEqual(existing.metadata, request.metadata);
}

export function buildRegisteredWorkerRecord(
  request: RegisterWorkerRequest,
  capabilities: WorkerCapabilities,
  existing: WorkerRecord | null,
  now: string,
): WorkerRecord {
  return {
    nodeId: request.nodeId,
    role: request.role,
    displayName: request.displayName,
    brokerUrl: request.brokerUrl,
    capabilities,
    workerMode: request.workerMode,
    metadata: request.metadata,
    managementPlane: request.managementPlane,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastSeenAt: now,
  };
}

export function workerHeartbeatRequestFromRegistration(
  request: RegisterWorkerRequest,
  capabilities: WorkerCapabilities,
): WorkerHeartbeatRequest {
  return {
    displayName: request.displayName,
    brokerUrl: request.brokerUrl,
    capabilities,
    workerMode: request.workerMode,
    metadata: request.metadata,
    managementPlane: request.managementPlane,
  };
}

export interface WorkerHeartbeatRuntimeUpdate {
  worker: WorkerRecord;
  materialChange: boolean;
}

export function applyWorkerHeartbeatRuntimeUpdate(
  worker: WorkerRecord,
  request: WorkerHeartbeatRequest | undefined,
  now: string,
): WorkerHeartbeatRuntimeUpdate {
  const nextCapabilities = request?.capabilities
    ? normalizeCapabilities(request.capabilities)
    : worker.capabilities;
  const nextDisplayName = request?.displayName ?? worker.displayName;
  const nextBrokerUrl = request?.brokerUrl ?? worker.brokerUrl;
  const nextWorkerMode = request?.workerMode ?? worker.workerMode;
  const nextMetadata = request?.metadata ?? worker.metadata;
  const nextManagementPlane = request?.managementPlane ?? worker.managementPlane;
  const capabilitiesChanged =
    request?.capabilities !== undefined &&
    JSON.stringify(nextCapabilities) !== JSON.stringify(worker.capabilities);
  const metadataChanged =
    request?.metadata !== undefined &&
    !workerMetadataMateriallyEqual(worker.metadata, nextMetadata);
  const materialChange =
    nextDisplayName !== worker.displayName ||
    nextBrokerUrl !== worker.brokerUrl ||
    nextWorkerMode !== worker.workerMode ||
    nextManagementPlane !== worker.managementPlane ||
    capabilitiesChanged ||
    metadataChanged;

  worker.displayName = nextDisplayName;
  worker.brokerUrl = nextBrokerUrl;
  worker.capabilities = nextCapabilities;
  worker.workerMode = nextWorkerMode;
  worker.metadata = nextMetadata;
  worker.managementPlane = nextManagementPlane;
  worker.updatedAt = now;
  worker.lastSeenAt = now;

  return { worker, materialChange };
}
