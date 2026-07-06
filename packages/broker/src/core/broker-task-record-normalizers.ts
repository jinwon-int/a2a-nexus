// Task record/result/payload normalizers and parent-round field hoisting
// extracted from broker.ts. Pure functions that fill defaults and canonicalize
// task records, results, errors, payloads, and ownership/parent-round fields.
// They hold no broker state.
import { uniqueIds } from "./broker-helpers.js";
import { normalizeOwnershipString } from "./broker-task-request-normalizers.js";
import { normalizeTaskWakeState } from "./broker-wake-normalizers.js";
import { normalizeFailureReadbackDetails } from "./task-error-details.js";
import type { TaskError, TaskRecord, TaskResult, TaskValidationPayload } from "./types.js";

export function normalizeTaskPayload(
  payload: Record<string, unknown> | undefined,
  context?: { assignedWorkerId?: string; localBrokerId?: string },
): Record<string, unknown> {
  if (!payload) {
    return {};
  }

  const normalized = { ...payload };
  const terminalBrief = isPlainRecord(normalized["terminalBrief"]) ?? {};
  const localBrokerId = normalizeOwnershipString(context?.localBrokerId);
  const parentRoundId = firstOwnershipString(
    normalized["parentRoundId"],
    normalized["run"],
    terminalBrief["parentRoundId"],
  );
  const originBrokerId = firstOwnershipString(
    normalized["originBrokerId"],
    normalized["parentBrokerId"],
    normalized["requestedByBroker"],
    terminalBrief["originBrokerId"],
  );
  const hasParentRoundPosition =
    normalized["parentRoundOrder"] !== undefined ||
    normalized["parentRoundNum"] !== undefined ||
    normalized["roundOrder"] !== undefined ||
    normalized["roundNum"] !== undefined ||
    terminalBrief["parentRoundOrder"] !== undefined ||
    terminalBrief["parentRoundNum"] !== undefined;
  const hasParentOwnedTerminalBrief =
    normalized["parentOwnedTerminalBrief"] === true ||
    terminalBrief["parentOwnedTerminalBrief"] === true;
  const hasExplicitCrossBrokerHandoff = Boolean(isPlainRecord(normalized["crossBrokerHandoff"]));

  if (
    !parentRoundId ||
    !originBrokerId ||
    !localBrokerId ||
    sameOwnershipToken(originBrokerId, localBrokerId) ||
    (!hasExplicitCrossBrokerHandoff && !hasParentRoundPosition && !hasParentOwnedTerminalBrief)
  ) {
    return normalized;
  }

  const existingHandoff = isPlainRecord(normalized["crossBrokerHandoff"]) ?? {};
  const existingOwnership = isPlainRecord(normalized["notificationOwnership"]) ?? {};
  const terminalBriefOwnership = isPlainRecord(terminalBrief["notificationOwnership"]) ?? {};
  const handoffBrokerId = firstOwnershipString(
    existingHandoff["handoffBrokerId"],
    normalized["handoffBrokerId"],
    terminalBrief["handoffBrokerId"],
    localBrokerId,
  );
  const childWorkerId = firstOwnershipString(
    existingHandoff["childWorkerId"],
    normalized["childWorkerId"],
    context?.assignedWorkerId,
  );
  const notificationOwnership = {
    ...existingOwnership,
    owner: existingOwnership["owner"] ?? "parent",
    ownerBrokerId: existingOwnership["ownerBrokerId"] ?? originBrokerId,
    scope: existingOwnership["scope"] ?? "parent-broker-only",
    providerSendPermittedByProjection: existingOwnership["providerSendPermittedByProjection"] ?? false,
    terminalAckPermittedByProjection: existingOwnership["terminalAckPermittedByProjection"] ?? false,
    reason: existingOwnership["reason"] ??
      "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
  };

  return {
    ...normalized,
    originBrokerId,
    operatorFacingOwner: normalized["operatorFacingOwner"] ?? "parent",
    crossBrokerHandoff: {
      ...existingHandoff,
      parentRoundId: existingHandoff["parentRoundId"] ?? parentRoundId,
      originBrokerId: existingHandoff["originBrokerId"] ?? originBrokerId,
      handoffBrokerId,
      ...(childWorkerId ? { childWorkerId } : {}),
    },
    terminalBrief: {
      ...terminalBrief,
      parentOwnedTerminalBrief: terminalBrief["parentOwnedTerminalBrief"] ?? true,
      notificationOwnership: {
        ...terminalBriefOwnership,
        owner: terminalBriefOwnership["owner"] ?? "parent",
        ownerBrokerId: terminalBriefOwnership["ownerBrokerId"] ?? originBrokerId,
        scope: terminalBriefOwnership["scope"] ?? "parent-broker-only",
      },
    },
    notificationOwnership,
  };
}

export function isPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function firstOwnershipString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeOwnershipString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

export function sameOwnershipToken(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());
}

function normalizeValidationPayload(validation: TaskValidationPayload): TaskValidationPayload {
  return {
    nodeId: validation.nodeId,
    kind: validation.kind,
    verdict: validation.verdict,
    metrics: validation.metrics ? { ...validation.metrics } : undefined,
    artifactIds: uniqueIds(validation.artifactIds ?? []),
    note: validation.note,
  };
}

export function normalizeTaskResult(result: TaskResult | undefined): TaskResult {
  if (!result) {
    return {};
  }

  return {
    summary: result.summary,
    note: result.note,
    artifactIds: uniqueIds(result.artifactIds ?? []),
    output: result.output ? { ...result.output } : undefined,
    validation: result.validation ? normalizeValidationPayload(result.validation) : undefined,
    validations: Array.isArray(result.validations)
      ? result.validations.map((validation) => normalizeValidationPayload(validation))
      : undefined,
    provenance: result.provenance === undefined ? undefined : structuredClone(result.provenance),
    apply: result.apply
      ? {
          workspace: result.apply.workspace,
          artifactIds: uniqueIds(result.apply.artifactIds ?? []),
          note: result.apply.note,
        }
      : undefined,
  };
}

export function normalizeTaskError(error: TaskError | undefined): TaskError {
  if (!error) {
    return { message: "task failed" };
  }

  return {
    code: error.code,
    message: error.message || "task failed",
    details: normalizeFailureReadbackDetails(error.details),
  };
}

export function normalizeTaskRecord(task: TaskRecord): TaskRecord {
  const payload = normalizeTaskPayload(task.payload);
  return {
    ...task,
    targetNodeId: task.targetNodeId ?? task.target.id,
    assignedWorkerId: task.assignedWorkerId ?? task.targetNodeId ?? task.target.id,
    artifactIds: uniqueIds(task.artifactIds ?? []),
    payload,
    ...hoistParentRoundFields(task, payload),
    result: task.result ? normalizeTaskResult(task.result) : undefined,
    error: task.error ? normalizeTaskError(task.error) : undefined,
    attemptId: task.attemptId,
    wake: normalizeTaskWakeState(task.wake),
    taskOrigin: task.taskOrigin ?? "unknown",
    ...(normalizeOwnershipString(task.brokerOfRecord)
      ? { brokerOfRecord: normalizeOwnershipString(task.brokerOfRecord) }
      : {}),
    ...(normalizeOwnershipString(task.teamId) ? { teamId: normalizeOwnershipString(task.teamId) } : {}),
  };
}

/**
 * Ensure parentRoundId/parentRoundTotal/parentRoundOrder are available as
 * top-level task fields even when a dispatch path only stamped them into the
 * payload (e.g. the A2A round-policy and GitHub-patch dispatch paths). This makes
 * task.parentRoundId the single reliable key for round-status queries over
 * listTasks(); the payload copy is left untouched for existing consumers.
 */
export function hoistParentRoundFields(
  source: { parentRoundId?: string; parentRoundTotal?: number; parentRoundOrder?: number },
  payload: Record<string, unknown> | undefined,
): Pick<TaskRecord, "parentRoundId" | "parentRoundTotal" | "parentRoundOrder"> {
  const out: Pick<TaskRecord, "parentRoundId" | "parentRoundTotal" | "parentRoundOrder"> = {};
  const id = parentRoundString(source.parentRoundId) ?? parentRoundString(payload?.["parentRoundId"]);
  if (id !== undefined) out.parentRoundId = id;
  const total = parentRoundNumber(source.parentRoundTotal) ?? parentRoundNumber(payload?.["parentRoundTotal"]);
  if (total !== undefined) out.parentRoundTotal = total;
  const order = parentRoundNumber(source.parentRoundOrder) ?? parentRoundNumber(payload?.["parentRoundOrder"]);
  if (order !== undefined) out.parentRoundOrder = order;
  return out;
}

export function parentRoundString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parentRoundNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}
