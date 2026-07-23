// Task admission gates extracted from broker.ts (#1289 R4 L-broker-9).
// The create/claim-time checks that decide whether a task request is allowed
// in: payload/metadata validation, Definition-of-Ready lint, the #1355 G1
// worker-class policy evaluation, A2A round worker availability, proposal
// linkage, and lifecycle worker-identity gates. Pure move — state effects are
// callback-injected via TaskAdmissionContext (the broker-exchange.ts pattern);
// InMemoryA2ABroker keeps thin private delegators so call sites are unchanged.
import { BrokerError } from "./broker-error.js";
import { isoNow } from "./broker-helpers.js";
import {
  assertA2ARoundTaskPolicy,
  assertWorkModeDecisionEvidence,
  assertTerminalBriefMetadata,
} from "./broker-payload-validators.js";
import {
  deriveTaskWorkerClass,
  evaluateTaskPolicy,
  type BrokerPolicyDecision,
  type BrokerPolicyDocument,
} from "a2a-policy-referee";
import { assertTransition, assertTaskOwnership } from "./broker-transition-guards.js";
import { evaluateTaskReadiness, type TaskReadinessMode } from "../task-readiness.js";
import type {
  AuditAction,
  AuditEvent,
  ChangeProposal,
  CreateTaskRequest,
  TaskRecord,
  WorkerRecord,
  WorkerView,
} from "./types.js";

const DEFAULT_A2A_ROUND_WORKER_OFFLINE_AFTER_MS = 90_000;

export interface TaskAdmissionContext {
  brokerId?: string;
  teamId?: string;
  taskReadinessMode: TaskReadinessMode;
  policyDocument?: BrokerPolicyDocument;
  tasks: ReadonlyMap<string, TaskRecord>;
  getWorker(nodeId: string): WorkerRecord | null;
  getWorkerView(nodeId: string, offlineAfterMs: number): WorkerView | null;
  requireWorker(nodeId: string): WorkerRecord;
  requireProposal(id: string): ChangeProposal;
  appendAuditEvent(input: {
    actorId: string;
    action: AuditAction;
    targetType: AuditEvent["targetType"];
    targetId: string;
    proposalId?: string;
    note?: string;
  }): AuditEvent;
  persistState(): void;
}

export function assertTaskPayload(request: CreateTaskRequest, context: TaskAdmissionContext): void {
  if (!request.requester?.id || !request.target?.id) {
    throw new BrokerError("bad_request", "requester.id and target.id are required");
  }
  if (!request.intent) {
    throw new BrokerError("bad_request", "intent is required");
  }
  if (request.workspace) {
    const workspace = request.workspace as { nodeId?: unknown; workspaceId?: unknown };
    if (
      typeof workspace.nodeId !== "string" ||
      !workspace.nodeId.trim() ||
      typeof workspace.workspaceId !== "string" ||
      !workspace.workspaceId.trim()
    ) {
      throw new BrokerError(
        "bad_request",
        "workspace.nodeId and workspace.workspaceId are required",
      );
    }
    if (workspace.nodeId !== request.target.id) {
      throw new BrokerError(
        "policy_denied",
        "task workspace.nodeId must match the target worker node",
      );
    }
  }
  if (request.assignedWorkerId && !request.assignedWorkerId.trim()) {
    throw new BrokerError("bad_request", "assignedWorkerId must not be empty");
  }

  // Fail-closed Terminal Brief metadata validation (R15).
  // When the task payload carries parentRoundId (or a recognised alias), the
  // canonical dispatch metadata must be present and internally consistent.
  // This prevents silently creating tasks that would later fail at projection
  // ingestion due to missing/inconsistent round metadata.
  assertA2ARoundTaskPolicy(request, context.brokerId);
  assertWorkModeDecisionEvidence(request);
  assertTerminalBriefMetadata(request.payload, context.brokerId);
}

export function assertTaskReadiness(request: CreateTaskRequest, context: TaskAdmissionContext): void {
  const result = evaluateTaskReadiness(request.payload, {
    intent: request.intent,
    mode: context.taskReadinessMode,
  });
  if (result.ok || !result.applies) {
    return;
  }

  const details = {
    missing: result.missing,
    mode: result.mode,
    taskId: request.id,
    intent: request.intent,
    ...(result.details ?? {}),
  };
  const code = result.code ?? "spec_underspecified";
  if (result.mode === "warn") {
    console.warn(`[a2a-broker] task readiness ${code}`, details);
    return;
  }

  const message = code === "source_projection_empty"
    ? "source-only analysis task has no source files; refusing zero_files projection at dispatch"
    : `task readiness specification is underspecified: missing ${result.missing.join(", ")}`;
  throw new BrokerError(code, message, details);
}

/**
 * Anonymous worker class for policy matching (#1355). Mirrors the
 * /stats/tasks derivation via the shared deriveTaskWorkerClass so budgets
 * and stats count the same classes.
 */
export function workerClassForPolicy(
  payload: TaskRecord["payload"] | undefined,
  workerId: string | undefined,
  context: TaskAdmissionContext,
): string {
  const worker = workerId ? context.getWorker(workerId) : null;
  return deriveTaskWorkerClass({
    sourceOnly: payload?.sourceOnly === true,
    payloadMode: typeof payload?.mode === "string" ? payload.mode : undefined,
    workerFound: Boolean(worker),
    workerMode: worker?.workerMode,
  });
}

export function countTasksCreatedTodayInClass(workerClass: string, context: TaskAdmissionContext): number {
  const utcDay = isoNow().slice(0, 10);
  let count = 0;
  for (const task of context.tasks.values()) {
    if (!task.createdAt?.startsWith(utcDay)) continue;
    if (workerClassForPolicy(task.payload, task.assignedWorkerId ?? task.targetNodeId, context) === workerClass) {
      count += 1;
    }
  }
  return count;
}

/**
 * Create-time policy evaluation (#1355 G1-b). Returns the decision for the
 * caller to fold into task creation, or undefined when no policy document is
 * configured (legacy behavior — everything allowed). An enforce-mode deny
 * throws policy_denied after recording audit evidence.
 */
export function evaluateCreateTaskPolicy(
  request: CreateTaskRequest,
  context: TaskAdmissionContext,
): BrokerPolicyDecision | undefined {
  const doc = context.policyDocument;
  if (!doc) return undefined;
  const workerClass = workerClassForPolicy(request.payload, request.assignedWorkerId ?? request.target.id, context);
  const decision = evaluateTaskPolicy({
    intent: request.intent,
    mode: typeof request.payload?.mode === "string" ? request.payload.mode : undefined,
    workerClass,
    countTasksToday: () => countTasksCreatedTodayInClass(workerClass, context),
  }, doc);
  if (decision.action === "deny") {
    if (doc.mode === "enforce") {
      context.appendAuditEvent({
        actorId: request.requester.id,
        action: "task.policy_denied",
        targetType: "task",
        targetId: request.id ?? "unassigned",
        note: `rule ${decision.ruleId}: ${decision.reason}`,
      });
      context.persistState();
      throw new BrokerError("policy_denied", decision.reason, { ruleId: decision.ruleId, workerClass });
    }
    console.warn(`[a2a-broker] task policy deny (warn mode, rule ${decision.ruleId})`, {
      reason: decision.reason,
      intent: request.intent,
      workerClass,
    });
  }
  return decision;
}

/**
 * Claim-time policy re-evaluation (#1355 G1-b): the CLAIMING worker's class
 * may differ from the create-time target's, so class-match rules are checked
 * again. Budgets are create-time only, and an operator approval already on
 * the task satisfies a require_approval rule.
 */
export function assertClaimTaskPolicy(task: TaskRecord, workerId: string, context: TaskAdmissionContext): void {
  const doc = context.policyDocument;
  if (!doc) return;
  const workerClass = workerClassForPolicy(task.payload, workerId, context);
  const decision = evaluateTaskPolicy({
    intent: task.intent,
    mode: typeof task.payload?.mode === "string" ? task.payload.mode : undefined,
    workerClass,
  }, doc);
  if (decision.action === "allow") return;
  if (decision.action === "require_approval" && task.approval) return;
  const note = `rule ${decision.ruleId}: ${decision.reason}`;
  if (doc.mode === "enforce") {
    context.appendAuditEvent({
      actorId: workerId,
      action: "task.policy_denied",
      targetType: "task",
      targetId: task.id,
      note,
    });
    context.persistState();
    throw new BrokerError("policy_denied", decision.reason, { ruleId: decision.ruleId, workerClass });
  }
  console.warn(`[a2a-broker] task policy claim violation (warn mode)`, { note, taskId: task.id, workerClass });
  context.appendAuditEvent({
    actorId: workerId,
    action: "task.policy_warned",
    targetType: "task",
    targetId: task.id,
    note,
  });
}

export function assertA2ARoundWorkerAvailability(request: CreateTaskRequest, context: TaskAdmissionContext): void {
  if (!request.payload || request.payload["parentRoundResolution"] === undefined) {
    return;
  }
  const workerIds = [request.target?.id, request.assignedWorkerId].filter(
    (value, index, values): value is string => typeof value === "string" && value.trim().length > 0 && values.indexOf(value) === index,
  );
  for (const workerId of workerIds) {
    const view = context.getWorkerView(workerId, DEFAULT_A2A_ROUND_WORKER_OFFLINE_AFTER_MS);
    if (!view) {
      throw new BrokerError("not_found", "worker not found");
    }
    if (view.status === "stale") {
      throw new BrokerError(
        "bad_request",
        `A2A round worker availability validation failed: stale worker ${workerId}`,
      );
    }
  }
}

export function assertTaskProposalLink(request: CreateTaskRequest, context: TaskAdmissionContext): void {
  if (!request.proposalId) {
    return;
  }

  const proposal = context.requireProposal(request.proposalId);
  if (request.target.id !== proposal.targetNodeId) {
    throw new BrokerError(
      "policy_denied",
      "task target must match the proposal target node",
    );
  }

  if (request.intent === "validate_change") {
    assertTransition(proposal.status, ["submitted", "validated"], "queue validation task for");
    return;
  }

  if (request.intent === "apply_local_change") {
    assertTransition(proposal.status, ["approved"], "queue apply task for");
    if (!request.workspace?.workspaceId || request.workspace.nodeId !== proposal.targetNodeId) {
      throw new BrokerError(
        "bad_request",
        "apply tasks require a target-owned workspace",
      );
    }
  }
}

export function assertTaskWorker(task: TaskRecord, workerId: string, action: string, context: TaskAdmissionContext): void {
  assertTaskOwnership(task, action, context.brokerId, context.teamId);
  context.requireWorker(workerId);
  const expectedWorkerId = task.assignedWorkerId ?? task.targetNodeId;
  if (workerId !== expectedWorkerId) {
    throw new BrokerError(
      "policy_denied",
      `${action} requires the assigned worker`,
    );
  }

  if (task.claimedBy && task.claimedBy !== workerId) {
    throw new BrokerError(
      "policy_denied",
      `${action} requires the worker that claimed the task`,
    );
  }
}
