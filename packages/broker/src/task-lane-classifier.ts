import type { BrokerPolicyDecision } from "a2a-policy-referee";

import type {
  CreateTaskRequest,
  TaskLaneAssignment,
  TaskLaneReasonCode,
} from "./core/types.js";

export const FAST_LANE_ASSIGNMENT_VERSION = "fast-lane.v1" as const;
export const FAST_LANE_ASSIGNMENT_MODE = "shadow" as const;

/**
 * Closed v1 reason-code set, listed in the classifier's fixed evaluation
 * order. Runtime contract source for strict consumers (read-model cohort
 * aggregation); must stay in sync with `TaskLaneReasonCode` in
 * `core/types.ts` and the persistence mirror in `core/store-schemas.ts`
 * (`taskLaneAssignmentSchema`).
 */
export const TASK_LANE_REASON_CODES = [
  "all_fast_conditions_met",
  "requester_lane_facts_present",
  "intent_not_analyze",
  "mode_missing",
  "mode_not_read_only_analysis",
  "write_or_implementation_marker_present",
  "worker_assignment_conflict",
  "round_marker_present",
  "fanout_marker_present",
  "multi_worker_marker_present",
  "delegated_workflow_marker_present",
  "policy_decision_missing",
  "policy_decision_unknown",
  "policy_requires_approval",
  "policy_denied",
  "approval_marker_present",
  "sensitive_marker_present",
  "live_marker_present",
  "external_send_marker_present",
  "credential_access_marker_present",
] as const;

export const TASK_LANE_REASON_CODE_SET: ReadonlySet<TaskLaneReasonCode> = new Set(TASK_LANE_REASON_CODES);

/** Fails to compile if the tuple above omits any closed-set reason code. */
export const TASK_LANE_REASON_CODES_COVER_CONTRACT: [TaskLaneReasonCode] extends [
  (typeof TASK_LANE_REASON_CODES)[number]
]
  ? true
  : never = true;

export const FAST_LANE_READ_ONLY_ANALYSIS_MODES = [
  "analysis-only",
  "read-only-analysis",
  "analyze-only",
] as const;

const READ_ONLY_ANALYSIS_MODES = new Set<string>(FAST_LANE_READ_ONLY_ANALYSIS_MODES);

const REQUESTER_LANE_KEYS = [
  "lane",
  "laneAssignment",
  "laneDecision",
  "laneMode",
  "laneReason",
  "laneReasons",
  "laneShadow",
  "shadowLane",
  "fastLane",
  "fastLaneDecision",
  "fastLaneShadow",
] as const;

const ROUND_KEYS = [
  "parentRoundId",
  "parentRoundTotal",
  "parentRoundOrder",
  "parentRoundNum",
  "parentRoundIndex",
  "parentRoundResolution",
  "round",
  "roundId",
  "roundMode",
  "roundOrder",
  "roundNum",
  "roundIndex",
  "roundTotal",
  "run",
  "runId",
  "discussionRunId",
] as const;

const FANOUT_KEYS = [
  "fanout",
  "fanOut",
  "fanoutMode",
  "fanoutBudget",
  "maxFanout",
] as const;

const MULTI_WORKER_KEYS = [
  "workerIds",
  "workers",
  "dispatchedWorkers",
  "participantWorkers",
  "expectedWorkers",
  "assignmentCount",
  "taskCount",
  "lanes",
  "participants",
] as const;

const DELEGATED_WORKFLOW_KEYS = [
  "team",
  "teamId",
  "teamScope",
  "requestedTeamScope",
  "workMode",
  "workModeDecision",
  "workflow",
  "workflowId",
  "delegated",
  "delegation",
  "delegate",
  "subagents",
  "subagentBudget",
  "crossBrokerHandoff",
  "notificationOwnership",
  "terminalBrief",
  "reviewerWorkerId",
  "reviewerWorkerIds",
  "finalizerWorkerId",
  "finalizerWorkerIds",
] as const;

const POSITIVE_WRITE_MARKER_KEYS = [
  "patchIntent",
  "write",
  "writeAccess",
  "allowWrites",
  "allowGitHubWrites",
  "sourceMutation",
  "mutateSource",
  "implementation",
  "implementationMode",
  "applyChanges",
] as const;

const NEGATIVE_WRITE_MARKER_KEYS = [
  "sourceOnly",
  "source_only",
  "readOnlyValidation",
  "noGitHubWrites",
  "noMutation",
] as const;

const SENSITIVE_MARKER_KEYS = [
  "sensitive",
  "containsSensitiveData",
  "sensitiveData",
  "dataSensitivity",
  "sensitivity",
  "dataClassification",
] as const;

const LIVE_MARKER_KEYS = [
  "live",
  "liveImpact",
  "requiresLiveAccess",
  "allowLive",
  "promoteLive",
  "liveOperation",
] as const;

const EXTERNAL_SEND_MARKER_KEYS = [
  "externalSend",
  "requiresExternalSend",
  "providerSend",
  "providerSendPermitted",
  "providerSendAttempted",
  "sendExternal",
] as const;

const CREDENTIAL_ACCESS_MARKER_KEYS = [
  "credentialAccess",
  "requiresCredentialAccess",
  "accessCredentials",
  "credentials",
  "secrets",
  "secretAccess",
  "movesSecretsOrCredentials",
] as const;

export interface TaskLaneClassifierInput {
  request: CreateTaskRequest;
  policyDecision: BrokerPolicyDecision | undefined;
}

/**
 * Pure, deterministic, broker-owned fast-lane classifier.
 *
 * Only the closed structured fields below are evaluated. message and every
 * other free-form/prose field are intentionally ignored.
 */
export function classifyTaskLane(input: TaskLaneClassifierInput): TaskLaneAssignment {
  const { request, policyDecision } = input;
  const payload = ownRecord(request.payload) ?? {};
  const rawRequest = request as CreateTaskRequest & Record<string, unknown>;
  const reasons: TaskLaneReasonCode[] = [];

  addReason(
    reasons,
    hasAnyOwn(rawRequest, REQUESTER_LANE_KEYS) || hasAnyOwn(payload, REQUESTER_LANE_KEYS),
    "requester_lane_facts_present",
  );
  addReason(reasons, request.intent !== "analyze", "intent_not_analyze");

  const mode = payload["mode"];
  if (typeof mode !== "string" || mode.length === 0) {
    reasons.push("mode_missing");
  } else if (!READ_ONLY_ANALYSIS_MODES.has(mode)) {
    reasons.push("mode_not_read_only_analysis");
  }

  addReason(
    reasons,
    hasPositiveRiskMarker(payload, POSITIVE_WRITE_MARKER_KEYS) ||
      hasFalseOrUnknownSafetyMarker(payload, NEGATIVE_WRITE_MARKER_KEYS),
    "write_or_implementation_marker_present",
  );

  const assignedWorkerId = request.assignedWorkerId ?? request.target?.id;
  addReason(
    reasons,
    typeof assignedWorkerId !== "string" ||
      assignedWorkerId.length === 0 ||
      assignedWorkerId !== request.target?.id,
    "worker_assignment_conflict",
  );

  addReason(
    reasons,
    request.parentRoundId !== undefined ||
      request.parentRoundTotal !== undefined ||
      request.parentRoundOrder !== undefined ||
      hasAnyOwn(payload, ROUND_KEYS),
    "round_marker_present",
  );
  addReason(reasons, hasAnyOwn(payload, FANOUT_KEYS), "fanout_marker_present");
  addReason(reasons, hasAnyOwn(payload, MULTI_WORKER_KEYS), "multi_worker_marker_present");
  addReason(
    reasons,
    request.parentTaskId !== undefined ||
      request.teamId !== undefined ||
      hasAnyOwn(payload, DELEGATED_WORKFLOW_KEYS),
    "delegated_workflow_marker_present",
  );

  if (!policyDecision) {
    reasons.push("policy_decision_missing");
  } else if (policyDecision.action === "require_approval") {
    reasons.push("policy_requires_approval");
  } else if (policyDecision.action === "deny") {
    reasons.push("policy_denied");
  } else if (policyDecision.action !== "allow") {
    reasons.push("policy_decision_unknown");
  }

  addReason(
    reasons,
    hasPositiveRiskMarker(request.policyContext ?? {}, ["requiresApproval"]),
    "approval_marker_present",
  );
  addReason(
    reasons,
    hasPositiveRiskMarker(payload, SENSITIVE_MARKER_KEYS),
    "sensitive_marker_present",
  );
  addReason(
    reasons,
    hasLiveMarker(request, payload),
    "live_marker_present",
  );
  addReason(
    reasons,
    hasPositiveRiskMarker(payload, EXTERNAL_SEND_MARKER_KEYS) ||
      nestedPositiveMarker(payload, "boundaries", ["providerSend"]) ||
      nestedPositiveMarker(payload, "readiness", ["providerSendPermitted"]) ||
      nestedPositiveMarker(payload, "notificationOwnership", ["providerSendPermittedByProjection"]),
    "external_send_marker_present",
  );
  addReason(
    reasons,
    hasPositiveRiskMarker(payload, CREDENTIAL_ACCESS_MARKER_KEYS) ||
      nestedPositiveMarker(payload, "semantics", ["movesSecretsOrCredentials"]),
    "credential_access_marker_present",
  );

  return {
    version: FAST_LANE_ASSIGNMENT_VERSION,
    mode: FAST_LANE_ASSIGNMENT_MODE,
    decision: reasons.length === 0 ? "fast" : "full",
    reasonCodes: reasons.length === 0 ? ["all_fast_conditions_met"] : reasons,
  };
}

function hasLiveMarker(request: CreateTaskRequest, payload: Record<string, unknown>): boolean {
  if (request.policyContext?.liveImpact === true || request.policyContext?.targetEnvironment === "live") {
    return true;
  }
  if (
    request.policyContext?.targetEnvironment !== undefined &&
    request.policyContext.targetEnvironment !== "research" &&
    request.policyContext.targetEnvironment !== "staging"
  ) {
    return true;
  }
  if (hasPositiveRiskMarker(payload, LIVE_MARKER_KEYS)) return true;
  if (hasFalseOrUnknownSafetyMarker(payload, ["noLive"])) return true;
  return environmentMarkerIsLiveOrUnknown(payload["targetEnvironment"]) ||
    environmentMarkerIsLiveOrUnknown(payload["environment"]);
}

function environmentMarkerIsLiveOrUnknown(value: unknown): boolean {
  return value !== undefined && value !== "research" && value !== "staging";
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function hasAnyOwn(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.hasOwn(record, key));
}

function hasPositiveRiskMarker(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => {
    if (!Object.hasOwn(record, key)) return false;
    return record[key] !== false;
  });
}

function hasFalseOrUnknownSafetyMarker(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.some((key) => Object.hasOwn(record, key) && record[key] !== true);
}

function nestedPositiveMarker(
  record: Record<string, unknown>,
  parentKey: string,
  keys: readonly string[],
): boolean {
  const nested = ownRecord(record[parentKey]);
  return nested ? hasPositiveRiskMarker(nested, keys) : false;
}

function addReason(
  reasons: TaskLaneReasonCode[],
  condition: boolean,
  reason: TaskLaneReasonCode,
): void {
  if (condition) reasons.push(reason);
}
