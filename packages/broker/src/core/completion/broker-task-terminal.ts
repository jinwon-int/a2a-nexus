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
import { BrokerError } from "../broker-error.js";
import { isoNow, uniqueIds } from "../broker-helpers.js";
import {
  normalizeTaskError,
  normalizeTaskRecord,
  normalizeTaskResult,
} from "../broker-task-record-normalizers.js";
import { planClassAwareTaskRetry } from "../execution/task-retry-policy.js";
import { validateGithubTaskCompletionEvidence } from "./github-task-completion.js";
import { extractReviewVerdict, validateReviewEvidence } from "../../worker-review.js";
import {
  evaluateFinalizerVerdictAdmission,
  type FinalizerVerdictAdmissionResult,
  type FinalizerVerdictEnforcement,
} from "./finalizer-verdict-admission.js";
import { isRecord } from "../value-guards.js";
import { budgetPeriodKey, SPEND_MAX_COST_USD, SPEND_MAX_TOKENS } from "../store-schemas.js";
import type { FinalizerKeyring } from "a2a-attestation";
import type { TaskUpdateReason } from "../broker-contracts.js";
import type {
  A2AExchangeState,
  ApplyProposalRequest,
  AuditAction,
  AuditEvent,
  ChangeProposal,
  SpendEventRecord,
  SubmitValidationRequest,
  TaskError,
  TaskRecord,
  TaskResult,
  TombstoneReason,
  ValidationResult,
} from "../types.js";

export interface TaskTerminalContext {
  tasks: ReadonlyMap<string, TaskRecord>;
  maxRequeueAttempts: number;
  /** Accept-path finalizer-verdict posture (#1383 V-c). Default "off". */
  finalizerVerdictEnforcement: FinalizerVerdictEnforcement;
  /** Registered finalizer keyring (#1383 V-c). When set, the accept-path verifies static-key verdict signatures in-broker. */
  finalizerKeyring?: FinalizerKeyring;
  /**
   * #1601/#2208 Q1 (A2A_FAST_LANE_SKIP_REVIEW_ROUND): opt-in fast-lane
   * review-round skip. Default false — absent on hand-built test contexts,
   * so every legacy path stays byte-identical.
   */
  fastLaneSkipReviewRound?: boolean;
  /**
   * #1601/#2208 Q2 (A2A_FAST_LANE_SINGLE_WORKER_FINALIZE): opt-in
   * single-worker finalize. Default false; a present finalizerVerdict
   * always runs the full legacy admission regardless of this flag.
   */
  fastLaneSingleWorkerFinalize?: boolean;
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
  /**
   * Optional (#2077 step 1): run the record writes, exchange sync, audit
   * appends, tombstone, and persist as a single store transaction (one fsync
   * instead of 4–7). Absent on hand-built test contexts, in which case the
   * callback runs inline with no batching. Nested commitMutation calls (e.g.
   * proposal side-effects) join the open transaction via the store's depth
   * join, so only the outermost batch commits.
   */
  commitMutation?<T>(fn: () => T): T;
  /**
   * #2499 slice 2: stage the task's spend-ledger row. Every terminal
   * transition calls it inside its commitMutation, after the terminal task
   * row is set and before persistState, so the row rides the same save.
   * Absent on hand-built test contexts (no ledger).
   */
  stageTerminalSpend?(task: TaskRecord, attribution?: { claimant?: string }): void;
}

function commitMutation<T>(context: TaskTerminalContext, fn: () => T): T {
  return context.commitMutation ? context.commitMutation(fn) : fn();
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
  // Do not pass workerId as the explicit author here: assertTaskWorker already
  // guarantees claimedBy === workerId, so the fallback inside
  // validateReviewEvidence reproduces the legacy comparison, and a
  // dispatcher-declared payload.review.authorWorkerId (#1518/#1548) must win
  // for self-contained review tasks.
  const completionEvidenceError =
    validateReviewEvidence(task, normalizedResult) ?? validateGithubTaskCompletionEvidence(task, normalizedResult);
  if (completionEvidenceError) {
    // #1815 item 5: a failed review verdict used to discard the submitted
    // result entirely, forcing a same-source diagnostic re-dispatch just to
    // recover the findings. Preserve it on the task record — the gate below
    // still fails the task; only the evidence survives.
    if (completionEvidenceError.code === "review_verdict_failed") {
      const verdict = extractReviewVerdict(normalizedResult);
      if (verdict) {
        task.negativeVerdictEvidence = {
          reviewerNodeId: verdict.reviewerNodeId,
          verdict: verdict.verdict,
          result: normalizedResult,
          recordedAt: isoNow(),
        };
        task.updatedAt = task.negativeVerdictEvidence.recordedAt;
        // The evidence preservation must survive the throw below, so the
        // batch commits before the BrokerError propagates (#2077 step 1).
        commitMutation(context, () => {
          context.appendAuditEvent({
            actorId: workerId,
            action: "task.negative_verdict_preserved",
            targetType: "task",
            targetId: task.id,
            note: `negative-verdict-preserved reviewer=${verdict.reviewerNodeId} verdict=${verdict.verdict}`,
          });
          context.setTaskRecord(task);
          context.persistState();
        });
      }
    }
    const brokerErrorCode =
      completionEvidenceError.code === "review_evidence_missing" ||
      completionEvidenceError.code === "review_not_independent" ||
      completionEvidenceError.code === "review_verdict_failed" ||
      completionEvidenceError.code === "github_completion_receipt_invalid"
        ? completionEvidenceError.code
        : "github_completion_evidence_missing";
    // #1601/#2208 Q1: opt-in fast-lane review-round skip. ONLY the three
    // review_* gate codes are skippable, and only when the broker itself
    // classified the task as `fast` at create (classifyTaskLane — never an
    // operator or worker assertion). GitHub receipt failures and every
    // other evidence error still throw. The #1815 preservation block above
    // already ran unconditionally, so negative-verdict evidence survives on
    // the record whether or not the gate skips. Flag-off is byte-identical.
    if (
      context.fastLaneSkipReviewRound === true &&
      task.laneAssignment?.decision === "fast" &&
      (brokerErrorCode === "review_evidence_missing" ||
        brokerErrorCode === "review_not_independent" ||
        brokerErrorCode === "review_verdict_failed")
    ) {
      context.appendAuditEvent({
        actorId: workerId,
        action: "task.review_gate_skipped",
        targetType: "task",
        targetId: task.id,
        note: `fast-lane review round skipped: ${brokerErrorCode} (#1601/#2208)`,
      });
    } else {
      throw new BrokerError(
        brokerErrorCode,
        completionEvidenceError.message,
        completionEvidenceError.details,
      );
    }
  }

  // Accept-path finalizer-verdict admission (#1383 V-c). Runs BEFORE any
  // completion side-effect. Default-inert: no-op unless the posture is
  // warn|enforce AND the task opted in via payload.requireFinalizerVerdict.
  // enforce blocks (fail-closed) with finalizer_verdict_invalid; warn records
  // an audit event and proceeds. Signature authenticity stays with the repo
  // merge gate (documented v0 boundary in contracts/a2a/finalizer-verdict.md).
  // #1601/#2208 Q2: opt-in single-worker finalize admission bypass.
  // Applies only when the broker classified the task `fast` at create AND
  // the flag is on AND the result carries NO finalizerVerdict at all (the
  // same isRecord presence check the admission itself uses). A present
  // verdict — any shape, valid or not — runs the full legacy admission
  // including keyring signature verification. Flag-off is byte-identical
  // to the pre-#2208 accept path (#1383 V-c).
  const skipFinalizerAdmission =
    context.fastLaneSingleWorkerFinalize === true &&
    task.laneAssignment?.decision === "fast" &&
    !isRecord(normalizedResult.finalizerVerdict);
  if (skipFinalizerAdmission) {
    context.appendAuditEvent({
      actorId: workerId,
      action: "task.finalizer_admission_skipped",
      targetType: "task",
      targetId: task.id,
      note: "fast-lane single-worker finalize: verdict admission skipped (#1601/#2208)",
    });
  }
  const verdictAdmission: FinalizerVerdictAdmissionResult = skipFinalizerAdmission
    ? { applies: false, ok: true, violations: [] }
    : evaluateFinalizerVerdictAdmission({
        task,
        result: normalizedResult,
        enforcement: context.finalizerVerdictEnforcement,
        finalizerKeyring: context.finalizerKeyring,
      });
  if (verdictAdmission.applies && !verdictAdmission.ok) {
    const detail = verdictAdmission.violations.join("; ");
    if (context.finalizerVerdictEnforcement === "enforce") {
      throw new BrokerError("finalizer_verdict_invalid", detail, {
        violations: verdictAdmission.violations,
      });
    }
    context.appendAuditEvent({
      actorId: workerId,
      action: "task.finalizer_verdict_warned",
      targetType: "task",
      targetId: task.id,
      note: `finalizer verdict admission (warn): ${detail}`,
    });
  }

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
  // #2077 step 1: this was the heaviest terminal transition — record write,
  // exchange sync, audit append, proposal side-effects, and persist each
  // opened their own BEGIN IMMEDIATE (4–7 fsyncs). One batch, one commit.
  // applyTaskCompletion's proposal writes join this batch through the nested
  // context commitMutation. Event emission stays outside: a throwing
  // subscriber must not roll back the completed mutation.
  commitMutation(context, () => {
    applyTaskCompletion(task, workerId, normalizedResult, context);
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
    context.stageTerminalSpend?.(task);
    context.persistState();
  });
  context.emitTaskEvent(task, "succeeded");
  // Succeeded tasks don't get a tombstone — they completed normally.
  return task;
}

export function failTask(
  taskId: string,
  workerId: string,
  error: TaskError | undefined,
  context: TaskTerminalContext,
  options: { negativeVerdictResult?: TaskResult } = {},
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
  // #1815 item 5: the worker client validates review evidence locally and
  // never reaches completeTask, so its fail submission carries the result it
  // was holding. Preserve it ONLY when the failure is actually the verdict
  // gate (a re-used error code with unrelated evidence must not attach).
  if (normalizedError.code === "review_verdict_failed" && options.negativeVerdictResult) {
    const normalizedEvidence = normalizeTaskResult(options.negativeVerdictResult);
    const verdict = extractReviewVerdict(normalizedEvidence);
    if (verdict) {
      task.negativeVerdictEvidence = {
        reviewerNodeId: verdict.reviewerNodeId,
        verdict: verdict.verdict,
        result: normalizedEvidence,
        recordedAt: now,
      };
    }
  }

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
    // #2499: the retry inherits `goalId` through the spread on purpose. It is
    // a re-attempt of an already-admitted task (same `retryOfTaskId` lineage),
    // not a new admission, so the value is the one `createTask` validated for
    // the root; dropping it would let retry spend escape the goal. Retries
    // are not re-gated on goal status here (slice 1 has no goal transition).
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

  // #2077 step 1: record write, retry-task materialization, exchange sync,
  // audit appends, tombstone, and persist as one store commit. Event
  // emission stays outside the batch.
  commitMutation(context, () => {
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
    // The failed attempt's own row; a scheduled retry is a new task id that
    // gets its row when it reaches a terminal status.
    context.stageTerminalSpend?.(task);
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
  });
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
  commitMutation(context, () => {
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
  });
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

// --- Spend ledger row (#2499 slice 2) ----------------------------------------
// Built by the broker at every terminal transition (succeeded, failed,
// canceled) and written once per task (`broker_spend_events`, primary key
// task_id, INSERT ... ON CONFLICT DO NOTHING). Record only: nothing here
// refuses, limits or alerts.

const SPEND_TELEMETRY_SCHEMA_VERSION = "a2a.analysis-execution-telemetry.v1";

export interface TaskSpendEventBuild {
  event: SpendEventRecord;
  /**
   * Set when telemetry was present but unusable; the row is then recorded
   * unmetered. A short, content-free reason code for the broker's one log line.
   */
  malformed?: string;
}

/**
 * Where `executionTelemetry` travels (spec "Usage and cost in terminal
 * results"): `result.output` on success; on a bridge failure
 * `error.details.bridgeFailure`, or the same nested under
 * `error.details.nestedError.details` when the worker wraps a nonzero handler
 * exit; a failed review verdict keeps its result on `negativeVerdictEvidence`.
 *
 * Returns every present `executionTelemetry`, in precedence order. A failed
 * task prefers the failure carriers (the receipt precedence used by task
 * stats): bridgeFailure, nested bridgeFailure, result.output, negative
 * verdict output. Every other status prefers the result: result.output,
 * negative verdict output, bridgeFailure, nested bridgeFailure.
 */
function spendTelemetryCandidates(task: TaskRecord): unknown[] {
  const details = isRecord(task.error?.details) ? task.error.details : undefined;
  const nestedDetails = isRecord(details?.nestedError) && isRecord(details.nestedError.details)
    ? details.nestedError.details
    : undefined;
  const carriers: unknown[] = [
    details?.bridgeFailure,
    nestedDetails?.bridgeFailure,
    task.result?.output,
    task.negativeVerdictEvidence?.result?.output,
  ];
  const ordered = task.status === "failed" ? carriers : [carriers[2], carriers[3], carriers[0], carriers[1]];
  return ordered.flatMap((carrier) =>
    isRecord(carrier) && carrier.executionTelemetry !== undefined ? [carrier.executionTelemetry] : []);
}

type SpendNumber = { ok: true; value: number | undefined } | { ok: false; reason: string };

/** Absent (undefined/null) is fine; anything else must be a finite number in [0, max]. */
function readSpendNumber(telemetry: Record<string, unknown>, field: string, max: number): SpendNumber {
  const value = telemetry[field];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, reason: `${field}_invalid` };
  }
  if (value > max) return { ok: false, reason: `${field}_exceeds_cap` };
  return { ok: true, value };
}

type ParsedSpendTelemetry =
  | { ok: true; costUsd: number | undefined; inputTokens: number; outputTokens: number }
  | { ok: false; reason: string };

/**
 * Validate one telemetry object. Token semantics (documented in the spec):
 * `inputTokens` is the runtime's uncached input; cache-creation tokens are
 * added to it (billed at or above the input rate), cache-read tokens are not
 * counted (billed at a fraction of it, and they dominate raw counts on cached
 * runs). Tokens are floored to integers. Any present-but-invalid field, or a
 * value above SPEND_MAX_*, makes the whole object malformed.
 */
function parseSpendTelemetry(raw: unknown): ParsedSpendTelemetry {
  if (!isRecord(raw)) return { ok: false, reason: "not_object" };
  if (raw.schemaVersion !== SPEND_TELEMETRY_SCHEMA_VERSION) return { ok: false, reason: "schema_version" };
  const cost = readSpendNumber(raw, "costUsd", SPEND_MAX_COST_USD);
  const input = readSpendNumber(raw, "inputTokens", SPEND_MAX_TOKENS);
  const cacheCreation = readSpendNumber(raw, "cacheCreationInputTokens", SPEND_MAX_TOKENS);
  const output = readSpendNumber(raw, "outputTokens", SPEND_MAX_TOKENS);
  for (const parsed of [cost, input, cacheCreation, output]) {
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
  }
  const value = (parsed: SpendNumber): number => (parsed.ok && parsed.value !== undefined ? Math.floor(parsed.value) : 0);
  const inputTokens = value(input) + value(cacheCreation);
  if (inputTokens > SPEND_MAX_TOKENS) return { ok: false, reason: "inputTokens_exceeds_cap" };
  return {
    ok: true,
    costUsd: cost.ok ? cost.value : undefined,
    inputTokens,
    outputTokens: value(output),
  };
}

/**
 * Project a terminal task onto its spend-ledger row. Never throws on
 * worker-reported data: missing telemetry is an unmetered row, malformed
 * telemetry is an unmetered row plus `malformed`.
 *
 * - Usage: the first carrier (see spendTelemetryCandidates) whose telemetry
 *   parses. A malformed higher-precedence carrier falls through to the next
 *   one; only when no present carrier parses is the row unmetered and
 *   `malformed` set (the reason of the highest-precedence carrier).
 * - `agentId`: `claimedBy` (the worker that completed or failed the task;
 *   completeTask/failTask stamp it), else `claimant` (the worker that held
 *   the claim when a cancel cleared `claimedBy`), else `assignedWorkerId`,
 *   else no agent.
 * - `lane`: the task `intent`, the closed lane vocabulary the broker already
 *   indexes (`broker_tasks.intent`) and that is known before claim.
 * - `recordedAt`: the terminal transition time; `periodKey` derives from it.
 */
export function buildTaskSpendEvent(
  task: TaskRecord,
  options: { timeZone: string; now?: () => string; claimant?: string },
): TaskSpendEventBuild {
  const candidate = task.completedAt ?? task.updatedAt;
  const recordedAt = typeof candidate === "string" && !Number.isNaN(Date.parse(candidate))
    ? candidate
    : (options.now ?? isoNow)();
  let usage: Extract<ParsedSpendTelemetry, { ok: true }> | undefined;
  let malformed: string | undefined;
  for (const raw of spendTelemetryCandidates(task)) {
    const parsed = parseSpendTelemetry(raw);
    if (parsed.ok) {
      usage = parsed;
      break;
    }
    malformed ??= parsed.reason;
  }
  const costKnown = usage?.costUsd !== undefined;
  const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  return {
    event: {
      taskId: task.id,
      recordedAt,
      periodKey: budgetPeriodKey(recordedAt, options.timeZone),
      agentId: nonEmpty(task.claimedBy) ?? nonEmpty(options.claimant) ?? nonEmpty(task.assignedWorkerId),
      lane: nonEmpty(task.intent),
      goalId: nonEmpty(task.goalId),
      costUsd: costKnown ? usage!.costUsd! : 0,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      costKnown,
    },
    ...(!usage && malformed ? { malformed } : {}),
  };
}
