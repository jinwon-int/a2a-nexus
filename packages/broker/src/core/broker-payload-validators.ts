// Create-time request payload validators for InMemoryA2ABroker, extracted from
// the broker god-class into pure free functions. Each validates an inbound
// request payload and throws BrokerError on rejection; none touches broker
// state (the two task validators that consult the broker's own id take it as an
// explicit `brokerId` argument), so they are unit-testable in isolation.
import { BrokerError } from "./broker-error.js";
import type {
  AttachArtifactRequest,
  CreateProposalRequest,
  CreateTaskRequest,
  RegisterWorkerRequest,
  SubmitValidationRequest,
} from "./types.js";
import {
  assertRequestPayload,
  attachArtifactRequestSchema,
  createProposalRequestSchema,
  submitValidationRequestSchema,
} from "./broker-request-schemas.js";
import { isPlainRecord } from "./broker-task-record-normalizers.js";
import { readString, normalizeOwnershipString } from "./broker-task-request-normalizers.js";
import { validateA2ARoundTaskPolicy } from "./a2a-round-policy.js";
import {
  extractDispatchMetadata,
  hasTerminalBriefMetadata,
  validateTerminalBriefMetadata,
} from "./terminal-brief-metadata.js";

/** Reject a worker registration that is missing required identity/capability fields. */
export function assertWorkerRegistrationPayload(request: RegisterWorkerRequest): void {
  if (!request.nodeId) {
    throw new BrokerError("bad_request", "nodeId is required");
  }
  if (!request.role) {
    throw new BrokerError("bad_request", "role is required");
  }
  if (!request.capabilities) {
    throw new BrokerError("bad_request", "capabilities are required");
  }
}

/**
 * Reject a change proposal that is missing required fields or kind-specific payload.
 *
 * Two layers, in this order:
 *  1. the historical field checks, which own the stable operator-facing error
 *     messages (`summary is required`, ...);
 *  2. {@link createProposalRequestSchema}, derived from the persisted
 *     `proposalSchema`, which closes the drift that let a request-accepted but
 *     store-rejected record (empty/non-string `kind`, non-string `summary`,
 *     wrong-typed `parameterPayload`) be persisted and then break snapshot load.
 */
export function assertProposalPayload(request: CreateProposalRequest): void {
  if (!request.source?.id || !request.target?.id) {
    throw new BrokerError("bad_request", "source.id and target.id are required");
  }
  if (!request.summary) {
    throw new BrokerError("bad_request", "summary is required");
  }
  if (!request.workspace?.nodeId || !request.workspace?.workspaceId) {
    throw new BrokerError(
      "bad_request",
      "workspace.nodeId and workspace.workspaceId are required",
    );
  }
  if (request.kind === "patch" && !request.patchText) {
    throw new BrokerError("bad_request", "patch proposals require patchText");
  }
  if (request.kind === "params" && !request.parameterPayload) {
    throw new BrokerError("bad_request", "params proposals require parameterPayload");
  }
  if (request.kind === "hybrid" && !request.patchText && !request.parameterPayload) {
    throw new BrokerError(
      "bad_request",
      "hybrid proposals require patchText, parameterPayload, or both",
    );
  }
  assertRequestPayload(createProposalRequestSchema, request, "proposal payload");
}

/**
 * Reject an artifact attachment whose shape the snapshot schema would refuse
 * (non-string `kind`/`uri`, non-numeric `sizeBytes`, ...). Derived from
 * `artifactSchema`.
 */
export function assertAttachArtifactPayload(request: AttachArtifactRequest): void {
  if (!request?.kind || !request.uri) {
    throw new BrokerError("bad_request", "kind and uri are required");
  }
  assertRequestPayload(attachArtifactRequestSchema, request, "artifact payload");
}

/**
 * Reject a validation submission whose shape the snapshot schema would refuse
 * (non-scalar `metrics` values, non-string `verdict`, ...). Derived from
 * `validationSchema`.
 */
export function assertSubmitValidationPayload(request: SubmitValidationRequest): void {
  if (!request?.kind || !request.verdict || !request.nodeId) {
    throw new BrokerError("bad_request", "nodeId, kind, and verdict are required");
  }
  assertRequestPayload(submitValidationRequestSchema, request, "validation payload");
}

/** Enforce the A2A round task policy for a task creation request. */
export function assertA2ARoundTaskPolicy(request: CreateTaskRequest, brokerId: string | undefined): void {
  const result = validateA2ARoundTaskPolicy(request, brokerId);
  if (!result.applies || result.valid) {
    return;
  }

  const errors = result.issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
  throw new BrokerError("bad_request", `A2A round task policy validation failed: ${errors}`);
}

/** Require valid work-mode decision evidence for Team1/hybrid task creation. */
export function assertWorkModeDecisionEvidence(request: CreateTaskRequest): void {
  const result = validateWorkModeDecisionEvidenceForTask(request);
  if (!result.applies || result.valid) {
    return;
  }
  throw new BrokerError("bad_request", `work-mode decision evidence validation failed: ${result.issues.join("; ")}`);
}

/**
 * Fail-closed guard: validate Terminal Brief metadata in the task payload
 * at creation time. Rejects with BrokerError when parentRoundId is present
 * but dispatch metadata fields (parentRoundTotal, parentRoundOrder, etc.)
 * are missing or inconsistent.
 *
 * Tasks without Terminal Brief metadata pass through without validation.
 */
export function assertTerminalBriefMetadata(
  payload: Record<string, unknown> | undefined,
  brokerId: string | undefined,
): void {
  if (!payload || !hasTerminalBriefMetadata(payload)) {
    return;
  }

  const dispatch = extractDispatchMetadata(payload);
  // Creation-time validation allows local origin — this is the common case
  // for Team2-local parent rounds where originBrokerId === this broker's id.
  // Cross-broker origin-receiver distinction is enforced at projection
  // ingestion time in CrossBrokerTerminalBriefProjectionStore.ingest().
  const result = validateTerminalBriefMetadata(dispatch, brokerId, { allowLocalOrigin: true });
  if (!result.valid) {
    const errors = result.issues
      .filter((i) => i.severity === "error")
      .map((i) => i.message)
      .join("; ");
    throw new BrokerError("bad_request", `Terminal Brief metadata validation failed: ${errors}`);
  }
}

function validateWorkModeDecisionEvidenceForTask(request: CreateTaskRequest): {
  applies: boolean;
  valid: boolean;
  issues: string[];
} {
  const payload = request.payload ?? {};
  const explicitWorkMode = readString(payload["workMode"]) ?? readString(payload["a2aWorkMode"]);
  const payloadTeamId = readString(payload["teamId"]) ?? normalizeOwnershipString(request.teamId);
  const hasParentRoundSignal = Boolean(
    readString(payload["parentRoundId"]) ||
    payload["parentRoundTotal"] !== undefined ||
    payload["parentRoundOrder"] !== undefined ||
    payload["lane"] !== undefined ||
    isPlainRecord(payload["crossBrokerHandoff"]),
  );
  const requiresEvidence =
    explicitWorkMode === "team1" ||
    explicitWorkMode === "hybrid" ||
    payload["workModeDecisionRequired"] === true ||
    (payloadTeamId === "team1" && hasParentRoundSignal);

  if (!requiresEvidence) {
    return { applies: false, valid: true, issues: [] };
  }

  const evidence = isPlainRecord(payload["workModeDecision"]) ?? isPlainRecord(payload["workModeDecisionEvidence"]);
  const issues: string[] = [];
  if (!evidence) {
    return {
      applies: true,
      valid: false,
      issues: ["payload.workModeDecision is required for Team1/hybrid task creation"],
    };
  }

  const mode = readString(evidence["mode"]);
  if (mode !== "team1" && mode !== "hybrid") {
    issues.push("workModeDecision.mode must be team1 or hybrid");
  }
  if (explicitWorkMode === "team1" || explicitWorkMode === "hybrid") {
    if (mode !== explicitWorkMode) {
      issues.push(`workModeDecision.mode must match payload.workMode=${explicitWorkMode}`);
    }
  }
  if (evidence["sourceOnlyDecision"] !== true) {
    issues.push("workModeDecision.sourceOnlyDecision must be true");
  }
  if (evidence["workerDispatchAllowedByThisPacket"] !== false) {
    issues.push("workModeDecision.workerDispatchAllowedByThisPacket must be false");
  }
  if (!readString(evidence["idempotencyKey"])) {
    issues.push("workModeDecision.idempotencyKey is required");
  }
  if (!readString(evidence["finalizerOwner"])) {
    issues.push("workModeDecision.finalizerOwner is required");
  }
  if (!readString(evidence["generatedAt"])) {
    issues.push("workModeDecision.generatedAt is required");
  }
  if (!readString(evidence["capacitySnapshotSource"])) {
    issues.push("workModeDecision.capacitySnapshotSource is required");
  }
  if (!readString(evidence["capacitySnapshotAt"])) {
    issues.push("workModeDecision.capacitySnapshotAt is required");
  }

  return { applies: true, valid: issues.length === 0, issues };
}
