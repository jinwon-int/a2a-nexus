// Worker terminal transitions extracted from broker.ts (#1289 R4 L-broker-15
// — final lifecycle lane 4/4). completeTask validates completion evidence and
// applies proposal-linked side-effects before the succeeded transition;
// failTask plans class-aware retries and materializes the retry task, with
// the tombstone-before-persist crash-safety ordering preserved verbatim;
// late complete/fail evidence after cancel is recorded instead of dropped
// (issue #954). Pure move: state effects are callback-injected via
// TaskTerminalContext (the broker-exchange.ts pattern), with proposal
// side-effects routed through the already-extracted proposal-write
// delegators as bound callbacks; InMemoryA2ABroker keeps both public
// methods as delegators.
import { BrokerError } from "./broker-error.js";
import { isoNow, uniqueIds } from "./broker-helpers.js";
import {
  normalizeTaskError,
  normalizeTaskRecord,
  normalizeTaskResult,
} from "./broker-task-record-normalizers.js";
import { planClassAwareTaskRetry } from "./task-retry-policy.js";
import { validateGithubTaskCompletionEvidence } from "./github-task-completion.js";
import { validateReviewEvidence } from "../worker-review.js";
import type { TaskUpdateReason } from "./broker-contracts.js";
import type {
  A2AExchangeState,
  ApplyProposalRequest,
  AuditAction,
  AuditEvent,
  ChangeProposal,
  SubmitValidationRequest,
  TaskError,
  TaskRecord,
  TaskResult,
  TombstoneReason,
  ValidationResult,
} from "./types.js";

export interface TaskTerminalContext {
  tasks: ReadonlyMap<string, TaskRecord>;
  maxRequeueAttempts: number;
  requireTask(id: string): TaskRecord;
  assertTaskWorker(task: TaskRecord, workerId: string, action: string): void;
  setTaskRecord(task: TaskRecord): void;
  setProposalRecord(proposal: ChangeProposal): void;
  syncExchangeStateFromTask(task: TaskRecord, nextStatus: A2AExchangeState["status"]): void;
  appendAuditEvent(input: {
    actorId: string;
    action: AuditAction;
    targetType: AuditEvent["targetType"];
    targetId: string;
    proposalId?: string;
    note?: string;
  }): AuditEvent;
  writeTombstone(task: TaskRecord, reason: TombstoneReason, context?: { actorId?: string; reason?: string }): void;
  persistState(): void;
  emitTaskEvent(task: TaskRecord, reason: TaskUpdateReason): void;
  submitValidationResult(proposalId: string, request: SubmitValidationRequest): ValidationResult;
  applyProposalLocally(proposalId: string, request: ApplyProposalRequest): ChangeProposal;
}

function uniqueTaskErrorHistory(history: TaskError[] | undefined, error: TaskError): TaskError[] {
  const values = [...(history ?? []), error];
  return values.slice(-5).map((item) => normalizeTaskError(item));
}

export function completeTask(
  taskId: string,
  workerId: string,
  result: TaskResult | undefined,
  context: TaskTerminalContext,
): TaskRecord {
  const task = context.requireTask(taskId);
  context.assertTaskWorker(task, workerId, "complete");

  // If already canceled, record late completion evidence instead of silently dropping.
  if (task.status === "canceled") {
    return recordLateEvidenceAfterCancel(task, workerId, "complete", { result }, context);
  }
  // Idempotent: if already succeeded/failed, return as-is without mutation
  if (task.status === "succeeded" || task.status === "failed") {
    return task;
  }
  if (task.status !== "claimed" && task.status !== "running") {
    throw new BrokerError("invalid_transition", "cannot complete task while status is " + task.status);
  }
  // Contract §1.3: a checkpointed task is a real lifecycle gate. The worker
  // must not land terminal mutations while paused/awaiting_operator —
  // resume (operator/requester input) or cancel first.
  if (task.checkpoint) {
    throw new BrokerError(
      "invalid_transition",
      `cannot complete task while a ${task.checkpoint.state} checkpoint is active; resume or cancel first`,
    );
  }

  const normalizedResult = normalizeTaskResult(result);
  const completionEvidenceError =
    validateReviewEvidence(task, normalizedResult, workerId) ?? validateGithubTaskCompletionEvidence(task, normalizedResult);
  if (completionEvidenceError) {
    const brokerErrorCode =
      completionEvidenceError.code === "review_evidence_missing" ||
      completionEvidenceError.code === "review_not_independent" ||
      completionEvidenceError.code === "review_verdict_failed" ||
      completionEvidenceError.code === "github_completion_receipt_invalid"
        ? completionEvidenceError.code
        : "github_completion_evidence_missing";
    throw new BrokerError(
      brokerErrorCode,
      completionEvidenceError.message,
      completionEvidenceError.details,
    );
  }
  applyTaskCompletion(task, workerId, normalizedResult, context);

  const now = isoNow();
  task.status = "succeeded";
  task.claimedBy = workerId;
  task.updatedAt = now;
  task.completedAt = now;
  task.result = normalizedResult;
  task.error = undefined;
  task.artifactIds = uniqueIds([
    ...(task.artifactIds ?? []),
    ...(normalizedResult.artifactIds ?? []),
    ...(normalizedResult.validation?.artifactIds ?? []),
    ...(normalizedResult.apply?.artifactIds ?? []),
  ]);
  context.setTaskRecord(task);
  context.syncExchangeStateFromTask(task, "completed");
  context.appendAuditEvent({
    actorId: workerId,
    action: "task.succeeded",
    targetType: "task",
    targetId: task.id,
    proposalId: task.proposalId,
    note: normalizedResult.note ?? normalizedResult.summary ?? task.intent,
  });
  context.persistState();
  context.emitTaskEvent(task, "succeeded");
  // Succeeded tasks don't get a tombstone — they completed normally.
  return task;
}

export function failTask(
  taskId: string,
  workerId: string,
  error: TaskError | undefined,
  context: TaskTerminalContext,
): TaskRecord {
  const task = context.requireTask(taskId);
  context.assertTaskWorker(task, workerId, "fail");

  // If already canceled, record late failure evidence instead of silently dropping.
  if (task.status === "canceled") {
    return recordLateEvidenceAfterCancel(task, workerId, "fail", { error }, context);
  }
  // Idempotent: if already succeeded/failed, return as-is without mutation
  if (task.status === "succeeded" || task.status === "failed") {
    return task;
  }
  if (task.status !== "claimed" && task.status !== "running") {
    throw new BrokerError("invalid_transition", "cannot fail task while status is " + task.status);
  }
  // Contract §1.3: terminal mutations are gated while a checkpoint is
  // active (see completeTask).
  if (task.checkpoint) {
    throw new BrokerError(
      "invalid_transition",
      `cannot fail task while a ${task.checkpoint.state} checkpoint is active; resume or cancel first`,
    );
  }

  const now = isoNow();
  const normalizedError = normalizeTaskError(error);
  task.status = "failed";
  task.claimedBy = workerId;
  task.updatedAt = now;
  task.completedAt = now;
  task.error = normalizedError;

  const retryPlan = planClassAwareTaskRetry(task, normalizedError, {
    maxRequeueAttempts: context.maxRequeueAttempts,
    nowMs: Date.parse(now),
    taskIdExists: (id) => context.tasks.has(id),
  });
  let retryTask: TaskRecord | undefined;
  if (retryPlan.shouldRetry && retryPlan.retryTaskId && retryPlan.nextAttempt !== undefined) {
    task.retriedBy = retryPlan.retryTaskId;
    const retryPayload = {
      ...task.payload,
      retryClass: retryPlan.retryClass,
      retryAttempt: retryPlan.nextAttempt,
      retryOfTaskId: task.retryOfTaskId ?? task.id,
      retriedFromTaskId: task.id,
      ...(retryPlan.retryNotBeforeAt ? { retryNotBeforeAt: retryPlan.retryNotBeforeAt } : {}),
    };
    retryTask = normalizeTaskRecord({
      ...task,
      id: retryPlan.retryTaskId,
      parentTaskId: task.parentTaskId ?? task.id,
      referenceTaskIds: uniqueIds([...(task.referenceTaskIds ?? []), task.id]),
      status: "queued",
      payload: retryPayload,
      retryOfTaskId: task.retryOfTaskId ?? task.id,
      attempt: retryPlan.nextAttempt,
      retriedBy: undefined,
      requeueCount: retryPlan.nextRequeueCount,
      claimedAt: undefined,
      claimedBy: undefined,
      completedAt: undefined,
      result: undefined,
      error: undefined,
      errorHistory: uniqueTaskErrorHistory(task.errorHistory, normalizedError),
      checkpoint: undefined,
      attemptId: undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  context.setTaskRecord(task);
  if (retryTask) {
    context.setTaskRecord(retryTask);
  }
  context.syncExchangeStateFromTask(task, "failed");
  context.appendAuditEvent({
    actorId: workerId,
    action: "task.failed",
    targetType: "task",
    targetId: task.id,
    proposalId: task.proposalId,
    note: normalizedError.message,
  });
  if (retryTask) {
    context.appendAuditEvent({
      actorId: "broker",
      action: "task.retry_scheduled",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: `scheduled retry ${retryTask.id} attempt ${retryTask.attempt} class ${retryPlan.retryClass}`,
    });
  }
  // writeTombstone mutates state (tombstone + audit event) without persisting,
  // so it must run before persistState() — otherwise a crash between the two
  // loses the tombstone until the next unrelated persist.
  context.writeTombstone(task, "failed");
  context.persistState();
  context.emitTaskEvent(task, "failed");
  return task;
}

/**
 * Record evidence that a worker posted after the task was already canceled.
 * The task stays canceled; late evidence is preserved for diagnostics.
 */
function recordLateEvidenceAfterCancel(
  task: TaskRecord,
  workerId: string,
  kind: "complete" | "fail",
  data: { result?: TaskResult; error?: TaskError },
  context: TaskTerminalContext,
): TaskRecord {
  // Idempotent: if late evidence already recorded, return without mutation
  if (task.lateEvidenceAfterCancel) {
    return task;
  }
  const now = isoNow();
  task.lateEvidenceAfterCancel = {
    kind,
    result: data.result ? structuredClone(data.result) : undefined,
    error: data.error ? structuredClone(data.error) : undefined,
    submittedAt: now,
    submittedBy: workerId,
  };
  task.updatedAt = now;
  context.setTaskRecord(task);
  context.appendAuditEvent({
    actorId: workerId,
    action: "task.updated",
    targetType: "task",
    targetId: task.id,
    proposalId: task.proposalId,
    note: `late ${kind} evidence after cancel (issue #954)`,
  });
  context.writeTombstone(task, "canceled_with_late_completion", {
    actorId: workerId,
    reason: `worker posted ${kind} evidence after cancel`,
  });
  context.persistState();
  return task;
}

function applyTaskCompletion(task: TaskRecord, workerId: string, result: TaskResult, context: TaskTerminalContext): void {
  if (!task.proposalId) {
    return;
  }

  if (task.intent === "validate_change") {
    if (!result.validation) {
      throw new BrokerError(
        "bad_request",
        "validate_change completion requires result.validation",
      );
    }
    context.submitValidationResult(task.proposalId, {
      nodeId: result.validation.nodeId ?? workerId,
      kind: result.validation.kind,
      verdict: result.validation.verdict,
      metrics: result.validation.metrics,
      artifactIds: uniqueIds([
        ...(result.artifactIds ?? []),
        ...(result.validation.artifactIds ?? []),
      ]),
      note: result.validation.note ?? result.note ?? result.summary,
    });
    return;
  }

  if (task.intent === "apply_local_change") {
    const workspace = result.apply?.workspace ?? task.workspace;
    if (!workspace) {
      throw new BrokerError(
        "bad_request",
        "apply_local_change completion requires a workspace",
      );
    }
    const proposal = context.applyProposalLocally(task.proposalId, {
      actor: {
        id: workerId,
        role: task.target.role,
        kind: task.target.kind,
      },
      workspace,
      note: result.apply?.note ?? result.note ?? result.summary,
    });
    const artifactIds = uniqueIds([
      ...(result.artifactIds ?? []),
      ...(result.apply?.artifactIds ?? []),
    ]);
    if (artifactIds.length > 0) {
      proposal.artifactIds = uniqueIds([...proposal.artifactIds, ...artifactIds]);
      proposal.updatedAt = isoNow();
      context.setProposalRecord(proposal);
    }
  }
}
