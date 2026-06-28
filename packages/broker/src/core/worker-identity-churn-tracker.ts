// Worker identity churn tracker, extracted from the InMemoryA2ABroker god-class
// (collaborator pattern from #1075/#1076). Owns the per-node churn record map and
// detects when a worker rapidly changes identity fields (a sign of duplicate
// processes sharing a nodeId). Touches only its own map plus the pure worker
// identity helpers, so it is cleanly separable from the broker.
import { workerIdentityChangedFields, workerIdentityFingerprint } from "./broker-worker-identity.js";
import type {
  RegisterWorkerRequest,
  WorkerCapabilities,
  WorkerIdentityWarning,
  WorkerRecord,
} from "./types.js";

interface ChurnRecord {
  fingerprint: string;
  changesAtMs: number[];
  lastChangedFields: string[];
  warning?: WorkerIdentityWarning;
}

export class WorkerIdentityChurnTracker {
  private readonly churn = new Map<string, ChurnRecord>();

  recordFingerprintChange(
    existing: WorkerRecord,
    request: RegisterWorkerRequest,
    capabilities: WorkerCapabilities,
  ): WorkerIdentityWarning | undefined {
    const changedFields = workerIdentityChangedFields(existing, request, capabilities);
    const fingerprint = workerIdentityFingerprint(request, capabilities);
    const nowMs = Date.now();
    const windowMs = 10 * 60 * 1000;
    const previous = this.churn.get(request.nodeId);
    const changesAtMs = (previous?.fingerprint && previous.fingerprint !== fingerprint
      ? [...previous.changesAtMs, nowMs]
      : [nowMs]
    ).filter((timestamp) => nowMs - timestamp <= windowMs);
    let warning = previous?.warning;
    if (changesAtMs.length >= 2) {
      warning = {
        code: "worker_identity_churn",
        severity: "warning",
        message: `worker ${request.nodeId} changed identity fields ${changedFields.join(", ")} ${changesAtMs.length} times within ${Math.round(windowMs / 1000)}s; check for duplicate processes sharing the same nodeId`,
        windowMs,
        changesInWindow: changesAtMs.length,
        lastDetectedAt: new Date(nowMs).toISOString(),
        lastChangedFields: changedFields,
      };
    }
    this.churn.set(request.nodeId, {
      fingerprint,
      changesAtMs,
      lastChangedFields: changedFields,
      warning,
    });
    return warning;
  }

  getWarnings(): Record<string, WorkerIdentityWarning> {
    const warnings: Record<string, WorkerIdentityWarning> = {};
    for (const [nodeId, record] of this.churn) {
      if (record.warning) {
        warnings[nodeId] = record.warning;
      }
    }
    return warnings;
  }

  warning(nodeId: string): WorkerIdentityWarning | undefined {
    return this.churn.get(nodeId)?.warning;
  }
}
