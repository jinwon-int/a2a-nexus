// ── Operator-approved execution plan dispatch request (source-only) ──────
//
// Consumes an OperatorApprovalRequestPacket (#990) plus explicit operator
// approval evidence, and produces a deterministic dispatch request for the
// operator-approved execution plan.
//
// This bridges the complexity execution plan draft to the dispatch/adapter
// layer. It renders what steps an operator has approved and what evidence
// references would be needed before a future dispatcher could act.
//
// Safety boundaries (all statically enforced):
//   - No broker/Gateway/worker service access
//   - No DB mutation or live provider send
//   - No subagent spawn or executor invocation
//   - No terminal ACK/replay or release operation
//   - No secret or credential exposure
//   - No grant of approval — the dispatch request is a draft of what the
//     operator approved; it does not grant itself
//   - operator_review steps NEVER become approved — they remain blocked
//
// Reference: #991 Team2 — dispatch request for operator-approved execution
//            plan from complexity execution plan draft.
// Parent:    #982 Team2 — complexity execution plan draft from finalizer
//            approval envelope.
// ─────────────────────────────────────────────────────────────────────────────

import { unique } from "./collections.js";
import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";
import type {
  ComplexityExecutionPlanDraftPacket,
  ExecutionPlanMode,
  ExecutionPlanStep,
} from "./complexity-execution-plan-draft.js";
import type { OperatorApprovalRequestPacket } from "./operator-approval-request.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Operator approval status for a single execution plan step.
 *
 * - `approved`: operator explicitly approved this step.
 * - `denied`: operator explicitly denied this step.
 * - `pending`: operator has not yet decided on this step.
 * - `blocked_permanently`: step can never be approved (e.g., operator_review).
 */
export type StepApprovalStatus =
  | "approved"
  | "denied"
  | "pending"
  | "blocked_permanently";

/**
 * An operator's decision on a single execution plan step.
 */
export interface StepApprovalDecision {
  /** The stepId from the execution plan. */
  stepId: string;
  /** The operator's approval status for this step. */
  status: StepApprovalStatus;
  /** Optional operator comment. */
  comment?: string;
}

/**
 * Overall operator approval decision for the execution plan.
 *
 * - `plan_approved`: operator approved the plan as a whole.
 * - `plan_denied`: operator denied the plan.
 * - `plan_partially_approved`: operator approved some steps, denied others.
 * - `plan_pending`: operator has not yet decided.
 */
export type PlanApprovalDecision =
  | "plan_approved"
  | "plan_denied"
  | "plan_partially_approved"
  | "plan_pending";

/**
 * Input decisions from the operator.
 */
export interface OperatorApprovalInput {
  /** Overall plan decision. */
  planDecision: PlanApprovalDecision;
  /** Per-step decisions. */
  stepDecisions: StepApprovalDecision[];
  /** Operator identity or label. */
  operator: string;
  /** Optional operator comment on the plan as a whole. */
  comment?: string;
  /** Operator approval reference (e.g., a ticket or session id). */
  approvalReference?: string;
}

/**
 * States for the operator-approved execution plan dispatch request.
 */
export type OperatorApprovedExecutionPlanDispatchState =
  | "dispatch_request_ready"
  | "waiting_for_execution_plan"
  | "waiting_for_operator_approval"
  | "plan_denied"
  | "plan_stale"
  | "plan_safety_blocked"
  | "blocked";

/**
 * A single dispatch request item derived from an approved execution step.
 */
export interface DispatchRequestItem {
  /** Source stepId from the execution plan. */
  stepId: string;
  /** Human-readable label from the source step. */
  label: string;
  /** Step kind from the source step. */
  kind: string;
  /** Whether this item is cleared for dispatch. */
  clearedForDispatch: boolean;
  /** Operator approval status for this specific step. */
  approvalStatus: StepApprovalStatus;
  /** Operator comment specific to this step. */
  operatorComment?: string;
  /** Whether execution of this step is blocked. */
  executionBlocked: boolean;
  /** Safety gate forwarded from the source step. */
  safetyGate: string;
}

/**
 * Evidence references required before a dispatcher could act on this
 * dispatch request.
 */
export interface DispatchEvidenceReference {
  /** Evidence id. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Reference string. */
  reference: string;
  /** Whether this evidence is required before dispatch. */
  requiredBeforeDispatch: boolean;
  /** Whether this evidence has been satisfied. */
  satisfied: boolean;
}

/**
 * Options for building the dispatch request.
 */
export interface OperatorApprovedExecutionPlanDispatchOptions {
  now?: string;
  mode?: string;
  dispatchRequestReference?: string;
  dispatch_request_reference?: string;
  operatorIdentity?: string;
  operator_identity?: string;
}

/**
 * Full dispatch request packet.
 */
export interface OperatorApprovedExecutionPlanDispatchPacket {
  kind: "a2a-broker.complexity-operator-approved-execution-plan-dispatch.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: OperatorApprovedExecutionPlanDispatchState;
  sourceOnlyNoLive: true;
  idempotencyKey: string;

  /** Source execution plan references. */
  source: {
    executionPlanState: string;
    executionPlanIdempotencyKey: string;
    executionPlanDecision: string;
    executionPlanMode: string;
    executionBlocked: boolean;
    approvalRequired: boolean;
    planReady: boolean;
  };

  /** Operator approval input. */
  operatorApproval: {
    operatorIdentity: string;
    planDecision: PlanApprovalDecision;
    approvalReference?: string;
    operatorComment?: string;
    stepDecisionsCount: number;
    approvedStepCount: number;
    deniedStepCount: number;
    pendingStepCount: number;
    blockedPermanentlyCount: number;
  };

  /** Dispatch request details. */
  dispatchRequest: {
    dispatchRequestReference: string;
    dispatchRequestOnly: true;
    dispatchDoesNotExecute: true;
    evidenceReferences: DispatchEvidenceReference[];
    approvedItems: DispatchRequestItem[];
    deniedItems: DispatchRequestItem[];
    pendingItems: DispatchRequestItem[];
    blockedPermanentlyItems: DispatchRequestItem[];
  };

  /** Readiness and safety gates. */
  readiness: {
    sourceCriteriaMet: boolean;
    dispatchRequestReady: boolean;
    dispatchPermitted: false;
    executorInvocationPermitted: false;
    processSpawnPermitted: false;
    sidecarStartPermitted: false;
    defaultOnPermitted: false;
    liveActivationPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    executionPermitted: false;
    dbMutationPermitted: false;
    blockers: string[];
    nextAction: string;
  };

  /** Blocker list. */
  blockers: string[];

  /** Next actions. */
  nextActions: string[];

  /** Explicit list of actions excluded by this packet. */
  approvalSensitiveActionsExcluded: string[];

  /** Integration contract. */
  integrationContract: {
    transport: "json";
    dispatchRequestVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesExecutionPlanDraftPacket: true;
    rendersDispatchRequest: true;
    sendsApprovalRequest: false;
    grantsApproval: false;
    executesApprovalGrant: false;
    dispatchesStartExecutor: false;
    invokesExecutor: false;
    spawnsProcess: false;
    startsSidecar: false;
    enablesDefaultOn: false;
    executesAction: false;
  };

  /** Semantics. */
  semantics: {
    dispatchRequestOnly: true;
    sourceOnlyNoLive: true;
    approvalNotGrantedByThisPacket: true;
    operatorReviewStepsRemainBlocked: boolean;
    dispatchDoesNotExecute: true;
    executesAction: false;
    performsGitHubMutation: false;
    performsProviderSend: false;
    performsTerminalAck: false;
    performsRuntimeRestartOrDeploy: false;
    performsDbMutation: false;
    createsTaskFlowRecords: false;
    performsHistoricalReplay: false;
    performsReleaseOrPublish: false;
    movesSecretsOrCredentials: false;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a dispatch request for an operator-approved execution plan.
 *
 * Consumes a `ComplexityExecutionPlanDraftPacket` (#982) and operator
 * approval decisions, and produces a deterministic dispatch request.
 *
 * SAFETY INVARIANT:
 *   - `operator_review` steps are ALWAYS `blocked_permanently` and are
 *     NEVER included in `approvedItems`.
 *   - The dispatch request NEVER permits execution, dispatch, or any live
 *     action.
 *   - All boundaries enforce source-only/no-live.
 *   - The dispatch request itself does not execute anything.
 *
 * @param executionPlan  A ComplexityExecutionPlanDraftPacket (#982).
 * @param approval       Operator approval decisions.
 * @param options        Optional overrides.
 */
export function buildOperatorApprovedExecutionPlanDispatch(
  executionPlan: ComplexityExecutionPlanDraftPacket,
  approval: OperatorApprovalInput,
  options: OperatorApprovedExecutionPlanDispatchOptions = {},
): OperatorApprovedExecutionPlanDispatchPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const dispatchRequestReference =
    options.dispatchRequestReference ??
    options.dispatch_request_reference ??
    buildDispatchReference(executionPlan);

  // Determine state based on plan and approval input
  const blockers = buildBlockers(executionPlan, approval);
  const state = determineState(executionPlan, approval, blockers);

  // Categorize steps by approval status
  const stepApprovalMap = buildStepApprovalMap(approval.stepDecisions);
  const { approvedItems, deniedItems, pendingItems, blockedPermanentlyItems } =
    categorizeSteps(executionPlan.steps, stepApprovalMap);

  const operatorReviewStepsRemainBlocked =
    blockedPermanentlyItems.length > 0;

  // Build evidence references
  const evidenceReferences = buildEvidenceReferences(
    executionPlan,
    approval,
    dispatchRequestReference,
    stepApprovalMap,
  );

  // Count approval stats
  const approvedCount = approvedItems.length;
  const deniedCount = deniedItems.length;
  const pendingCount = pendingItems.length;
  const blockedPermanentlyCount = blockedPermanentlyItems.length;

  return {
    kind: "a2a-broker.complexity-operator-approved-execution-plan-dispatch.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? executionPlan.envelopeCategory,
    parentRoundId: executionPlan.idempotencyKey,
    state,
    sourceOnlyNoLive: true,
    idempotencyKey: buildDispatchIdempotencyKey(
      executionPlan,
      approval,
      dispatchRequestReference,
      generatedAt,
      state,
    ),

    source: {
      executionPlanState: executionPlan.decision,
      executionPlanIdempotencyKey: executionPlan.idempotencyKey,
      executionPlanDecision: executionPlan.decision,
      executionPlanMode: executionPlan.executionMode,
      executionBlocked: executionPlan.executionBlocked,
      approvalRequired: executionPlan.approvalRequired,
      planReady: executionPlan.decision === "plan_ready",
    },

    operatorApproval: {
      operatorIdentity:
        options.operatorIdentity ??
        options.operator_identity ??
        approval.operator,
      planDecision: approval.planDecision,
      approvalReference: approval.approvalReference,
      operatorComment: approval.comment,
      stepDecisionsCount: approval.stepDecisions.length,
      approvedStepCount: approvedCount,
      deniedStepCount: deniedCount,
      pendingStepCount: pendingCount,
      blockedPermanentlyCount,
    },

    dispatchRequest: {
      dispatchRequestReference,
      dispatchRequestOnly: true,
      dispatchDoesNotExecute: true,
      evidenceReferences,
      approvedItems,
      deniedItems,
      pendingItems,
      blockedPermanentlyItems,
    },

    readiness: {
      sourceCriteriaMet: state === "dispatch_request_ready",
      dispatchRequestReady: state === "dispatch_request_ready",
      dispatchPermitted: false,
      executorInvocationPermitted: false,
      processSpawnPermitted: false,
      sidecarStartPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      dbMutationPermitted: false,
      blockers: [
        ...blockers,
        "dispatch request is not executor dispatch",
        "runtime execution requires later separate approved dispatcher path",
      ],
      nextAction: nextActionFor(state),
    },

    blockers,
    nextActions: nextActionsFor(state, approvedCount, deniedCount, operatorReviewStepsRemainBlocked),

    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),

    integrationContract: {
      transport: "json",
      dispatchRequestVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesExecutionPlanDraftPacket: true,
      rendersDispatchRequest: true,
      sendsApprovalRequest: false,
      grantsApproval: false,
      executesApprovalGrant: false,
      dispatchesStartExecutor: false,
      invokesExecutor: false,
      spawnsProcess: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },

    semantics: {
      dispatchRequestOnly: true,
      sourceOnlyNoLive: true,
      approvalNotGrantedByThisPacket: true,
      operatorReviewStepsRemainBlocked,
      dispatchDoesNotExecute: true,
      executesAction: false,
      performsGitHubMutation: false,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
      createsTaskFlowRecords: false,
      performsHistoricalReplay: false,
      performsReleaseOrPublish: false,
      movesSecretsOrCredentials: false,
    },
  };
}

/**
 * Build a dispatch request from the operator approval request packet (#990)
 * plus explicit operator approval evidence.
 *
 * This is the canonical #991 entry point. It keeps the older execution-plan
 * helper for local pipeline tests while ensuring the production-facing chain is
 * #989 seal -> #990 approval request -> #991 dispatch request draft.
 */
export function buildOperatorApprovedExecutionPlanDispatchFromApprovalRequest(
  approvalRequest: OperatorApprovalRequestPacket,
  approval: OperatorApprovalInput,
  options: OperatorApprovedExecutionPlanDispatchOptions = {},
): OperatorApprovedExecutionPlanDispatchPacket {
  const executionPlan = synthesizeExecutionPlanDraftFromApprovalRequest(approvalRequest);
  const packet = buildOperatorApprovedExecutionPlanDispatch(
    executionPlan,
    approval,
    {
      ...options,
      dispatchRequestReference:
        options.dispatchRequestReference ??
        options.dispatch_request_reference ??
        `operator-approved-dispatch:${approvalRequest.idempotencyKey}`,
    },
  );
  return {
    ...packet,
    dispatchRequest: {
      ...packet.dispatchRequest,
      evidenceReferences: [
        {
          id: "operator_approval_request",
          label: "Operator approval request packet",
          reference: approvalRequest.idempotencyKey,
          requiredBeforeDispatch: true,
          satisfied: approvalRequest.state === "approval_request_ready" ||
            approvalRequest.state === "approval_not_needed",
        },
        ...packet.dispatchRequest.evidenceReferences,
      ],
    },
    blockers: [
      ...(approvalRequest.state === "approval_request_blocked"
        ? ["operator approval request is blocked"]
        : []),
      ...approvalRequest.blockers.map((blocker) => `operator approval request: ${blocker}`),
      ...packet.blockers,
    ],
  };
}

/**
 * Extract an OperatorApprovalRequestPacket from direct or wrapped input.
 */
export function extractOperatorApprovalRequestFromInput(
  input: unknown,
): OperatorApprovalRequestPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.operatorApprovalRequest,
    envelope.approvalRequest,
    envelope.request,
    envelope.packet,
  ];
  const packet = candidates.find(isOperatorApprovalRequestPacket);
  if (!packet) {
    throw new Error(
      "expected an OperatorApprovalRequestPacket (#990) under operatorApprovalRequest, approvalRequest, request, or packet",
    );
  }
  return packet;
}

/**
 * Extract a ComplexityExecutionPlanDraftPacket from input.
 */
export function extractExecutionPlanFromInput(
  input: unknown,
): ComplexityExecutionPlanDraftPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.executionPlan,
    envelope.executionPlanDraft,
    envelope.complexityExecutionPlan,
    envelope.plan,
    envelope.packet,
  ];
  const packet = candidates.find(isComplexityExecutionPlanDraftPacket);
  if (!packet) {
    throw new Error(
      "expected a ComplexityExecutionPlanDraftPacket (#982)",
    );
  }
  return packet;
}

/**
 * Extract OperatorApprovalInput from input.
 */
export function extractOperatorApprovalFromInput(
  input: unknown,
): OperatorApprovalInput {
  const envelope = isRecord(input) ? input : {};
  const candidate =
    envelope.operatorApproval ?? envelope.approval ?? envelope.operatorDecisions;
  if (!isRecord(candidate)) {
    throw new Error(
      "expected an OperatorApprovalInput object under operatorApproval, approval, or operatorDecisions",
    );
  }
  const planDecision: PlanApprovalDecision =
    (candidate.planDecision as PlanApprovalDecision) ?? "plan_pending";
  const stepDecisions = Array.isArray(candidate.stepDecisions)
    ? (candidate.stepDecisions as StepApprovalDecision[])
    : [];
  return {
    planDecision,
    stepDecisions,
    operator: String(candidate.operator ?? "unknown"),
    comment: typeof candidate.comment === "string" ? candidate.comment : undefined,
    approvalReference:
      typeof candidate.approvalReference === "string"
        ? candidate.approvalReference
        : undefined,
  };
}

/**
 * Extract options from input.
 */
export function extractDispatchOptionsFromInput(
  input: unknown,
): OperatorApprovedExecutionPlanDispatchOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate =
    envelope.dispatchRequest ??
    envelope.dispatchRequestOptions ??
    envelope.options;
  return isRecord(candidate)
    ? (candidate as OperatorApprovedExecutionPlanDispatchOptions)
    : {};
}

/**
 * Render the dispatch request to human-readable markdown.
 */
export function renderOperatorApprovedExecutionPlanDispatchMarkdown(
  packet: OperatorApprovedExecutionPlanDispatchPacket,
): string {
  const header =
    packet.state === "dispatch_request_ready"
      ? "# Dispatch request: Operator-approved execution plan"
      : packet.state === "plan_denied"
      ? "# PLAN DENIED: Operator-approved execution plan dispatch"
      : packet.state === "plan_safety_blocked"
      ? "# SAFETY BLOCKED: Operator-approved execution plan dispatch"
      : "# Pending: Operator-approved execution plan dispatch";

  const lines: string[] = [
    header,
    "",
    `- **generatedAt**: ${packet.generatedAt}`,
    `- **state**: ${packet.state}`,
    `- **sourceOnlyNoLive**: ${packet.sourceOnlyNoLive}`,
    `- **idempotencyKey**: ${packet.idempotencyKey}`,
    `- **dispatchRequestReference**: ${packet.dispatchRequest.dispatchRequestReference}`,
    "",
    "## Source execution plan",
    "",
    `- **executionPlanIdempotencyKey**: ${packet.source.executionPlanIdempotencyKey}`,
    `- **executionPlanDecision**: ${packet.source.executionPlanDecision}`,
    `- **executionPlanMode**: ${packet.source.executionPlanMode}`,
    `- **executionBlocked**: ${packet.source.executionBlocked}`,
    `- **approvalRequired**: ${packet.source.approvalRequired}`,
    "",
    "## Operator approval",
    "",
    `- **operator**: ${packet.operatorApproval.operatorIdentity}`,
    `- **planDecision**: ${packet.operatorApproval.planDecision}`,
    ...(packet.operatorApproval.approvalReference
      ? [`- **approvalReference**: ${packet.operatorApproval.approvalReference}`]
      : []),
    ...(packet.operatorApproval.operatorComment
      ? [`- **operatorComment**: ${packet.operatorApproval.operatorComment}`]
      : []),
    `- **approvedStepCount**: ${packet.operatorApproval.approvedStepCount}`,
    `- **deniedStepCount**: ${packet.operatorApproval.deniedStepCount}`,
    `- **pendingStepCount**: ${packet.operatorApproval.pendingStepCount}`,
    `- **blockedPermanentlyCount**: ${packet.operatorApproval.blockedPermanentlyCount}`,
  ];

  if (packet.dispatchRequest.approvedItems.length > 0) {
    lines.push(
      "",
      "## Approved items",
      "",
      ...packet.dispatchRequest.approvedItems.map((item) =>
        [
          `- **${item.label}** (id: ${item.stepId}, kind: ${item.kind})`,
          `  - clearedForDispatch: ${item.clearedForDispatch}`,
          `  - executionBlocked: ${item.executionBlocked}`,
          `  - safetyGate: ${item.safetyGate}`,
          ...(item.operatorComment
            ? [`  - operatorComment: ${item.operatorComment}`]
            : []),
        ].join("\n"),
      ),
    );
  }

  if (packet.dispatchRequest.deniedItems.length > 0) {
    lines.push(
      "",
      "## Denied items",
      "",
      ...packet.dispatchRequest.deniedItems.map((item) =>
        [
          `- **${item.label}** (id: ${item.stepId})`,
          ...(item.operatorComment
            ? [`  - operatorComment: ${item.operatorComment}`]
            : []),
        ].join("\n"),
      ),
    );
  }

  if (packet.dispatchRequest.pendingItems.length > 0) {
    lines.push(
      "",
      "## Pending items",
      "",
      ...packet.dispatchRequest.pendingItems.map((item) =>
        [`- **${item.label}** (id: ${item.stepId})`].join("\n"),
      ),
    );
  }

  if (packet.dispatchRequest.blockedPermanentlyItems.length > 0) {
    lines.push(
      "",
      "## Blocked permanently (operator review)",
      "",
      ...packet.dispatchRequest.blockedPermanentlyItems.map((item) =>
        [
          `- **${item.label}** (id: ${item.stepId})`,
          `  - safetyGate: ${item.safetyGate}`,
          `  - CRITICAL: Operator review steps CANNOT become approved by this packet.`,
        ].join("\n"),
      ),
    );
  }

  lines.push(
    "",
    "## Evidence references",
    "",
    ...packet.dispatchRequest.evidenceReferences.map((ev) =>
      `- **${ev.label}** (${ev.id}) — required=${ev.requiredBeforeDispatch}, satisfied=${ev.satisfied}`,
    ),
    "",
    "## Blockers",
    ...(packet.blockers.length === 0
      ? ["*(none)*"]
      : packet.blockers.map((b) => `- ${b}`)),
    "",
    "## Next actions",
    ...packet.nextActions.map((a) => `- ${a}`),
    "",
    "## Readiness",
    `- **dispatchRequestReady**: ${packet.readiness.dispatchRequestReady}`,
    `- **dispatchPermitted**: ${packet.readiness.dispatchPermitted}`,
    `- **executionPermitted**: ${packet.readiness.executionPermitted}`,
    "",
    "This dispatch request does NOT dispatch, invoke, spawn, start, " +
    "enable, send, ACK, mutate, restart, deploy, replay, release, publish, " +
    "or move secrets. It is a source-only dispatch request for an " +
    "operator-approved execution plan.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildBlockers(
  executionPlan: ComplexityExecutionPlanDraftPacket,
  approval: OperatorApprovalInput,
): string[] {
  const blockers: string[] = [];

  // Check execution plan state
  if (executionPlan.decision === "plan_safety_blocked") {
    blockers.push("execution plan draft is safety blocked");
  }
  if (executionPlan.executionBlocked && executionPlan.executionMode === "operator_review_gated") {
    // operator_review_gated means operator review is required.
    // This is expected — it doesn't block the dispatch request from being
    // created, but it does block execution.
    // The dispatch request preserves this invariant.
  }

  // Check approval input
  if (!Array.isArray(approval.stepDecisions)) {
    blockers.push("operator approval has no step decisions");
  }

  // Safety: operator_review steps must never be approved
  // (enforced in categorizeSteps, but also validate input)
  for (const decision of approval.stepDecisions) {
    if (decision.status === "approved" && isReviewStepId(decision.stepId, executionPlan)) {
      blockers.push(
        `SAFETY BLOCK: step "${decision.stepId}" is an operator_review step ` +
        "but was marked approved. Operator review steps CANNOT be approved.",
      );
    }
  }

  return unique(blockers);
}

function determineState(
  executionPlan: ComplexityExecutionPlanDraftPacket,
  approval: OperatorApprovalInput,
  blockers: string[],
): OperatorApprovedExecutionPlanDispatchState {
  // Safety blocked takes precedence
  if (executionPlan.decision === "plan_safety_blocked") {
    return "plan_safety_blocked";
  }

  // Plan denied
  if (approval.planDecision === "plan_denied") {
    return "plan_denied";
  }

  // No execution plan ready
  if (executionPlan.decision !== "plan_ready" && executionPlan.decision !== "plan_approval_not_needed") {
    return "waiting_for_execution_plan";
  }

  // No operator decision yet
  if (approval.planDecision === "plan_pending") {
    return "waiting_for_operator_approval";
  }

  // Blockers exist
  if (blockers.length > 0) {
    return "blocked";
  }

  // Ready
  return "dispatch_request_ready";
}

function buildDispatchReference(
  executionPlan: ComplexityExecutionPlanDraftPacket,
): string {
  return (
    "approved-execution-plan-dispatch:" +
    createHash("sha256")
      .update(executionPlan.idempotencyKey)
      .digest("hex")
      .slice(0, 16)
  );
}

function buildDispatchIdempotencyKey(
  executionPlan: ComplexityExecutionPlanDraftPacket,
  approval: OperatorApprovalInput,
  dispatchRequestReference: string,
  generatedAt: string,
  state: OperatorApprovedExecutionPlanDispatchState,
): string {
  const base = JSON.stringify({
    label: "complexity-operator-approved-execution-plan-dispatch",
    executionPlan: executionPlan.idempotencyKey,
    approvalPlanDecision: approval.planDecision,
    operator: approval.operator,
    dispatchRequestReference,
    generatedAt,
    state,
  });
  return (
    "complexity-approved-exec-plan-dispatch:" +
    createHash("sha256").update(base).digest("hex").slice(0, 24)
  );
}

function buildStepApprovalMap(
  stepDecisions: StepApprovalDecision[],
): Map<string, StepApprovalDecision> {
  const map = new Map<string, StepApprovalDecision>();
  for (const decision of stepDecisions) {
    if (!map.has(decision.stepId)) {
      map.set(decision.stepId, decision);
    }
  }
  return map;
}

function categorizeSteps(
  steps: ExecutionPlanStep[],
  approvalMap: Map<string, StepApprovalDecision>,
): {
  approvedItems: DispatchRequestItem[];
  deniedItems: DispatchRequestItem[];
  pendingItems: DispatchRequestItem[];
  blockedPermanentlyItems: DispatchRequestItem[];
} {
  const approvedItems: DispatchRequestItem[] = [];
  const deniedItems: DispatchRequestItem[] = [];
  const pendingItems: DispatchRequestItem[] = [];
  const blockedPermanentlyItems: DispatchRequestItem[] = [];

  for (const step of steps) {
    const decision = approvalMap.get(step.stepId);
    const status = decision?.status ?? "pending";
    const comment = decision?.comment;

    // SAFETY INVARIANT: operator_review steps can NEVER be approved.
    // They are always blocked_permanently regardless of what the operator
    // approval input says.
    const isReviewStep =
      step.kind === "operator_review";
    const effectiveStatus: StepApprovalStatus =
      isReviewStep ? "blocked_permanently" : status;

    const item: DispatchRequestItem = {
      stepId: step.stepId,
      label: step.label,
      kind: step.kind,
      clearedForDispatch: effectiveStatus === "approved",
      approvalStatus: effectiveStatus,
      operatorComment: isReviewStep ? undefined : comment,
      executionBlocked: step.executionBlocked,
      safetyGate: step.safetyGate,
    };

    switch (effectiveStatus) {
      case "approved":
        approvedItems.push(item);
        break;
      case "denied":
        deniedItems.push(item);
        break;
      case "pending":
        pendingItems.push(item);
        break;
      case "blocked_permanently":
        blockedPermanentlyItems.push(item);
        break;
    }
  }

  return { approvedItems, deniedItems, pendingItems, blockedPermanentlyItems };
}

function buildEvidenceReferences(
  executionPlan: ComplexityExecutionPlanDraftPacket,
  approval: OperatorApprovalInput,
  dispatchRequestReference: string,
  stepApprovalMap: Map<string, StepApprovalDecision>,
): DispatchEvidenceReference[] {
  return [
    {
      id: "execution_plan_draft",
      label: "Complexity execution plan draft",
      reference: executionPlan.idempotencyKey,
      requiredBeforeDispatch: true,
      satisfied: executionPlan.decision === "plan_ready" || executionPlan.decision === "plan_approval_not_needed",
    },
    {
      id: "operator_approval",
      label: "Operator approval decision",
      reference: approval.approvalReference ?? dispatchRequestReference + ":operator-approval",
      requiredBeforeDispatch: true,
      satisfied:
        approval.planDecision === "plan_approved" ||
        approval.planDecision === "plan_partially_approved",
    },
    {
      id: "approval_envelope",
      label: "Source approval envelope (via execution plan)",
      reference: executionPlan.sourceEnvelopeIdempotencyKey,
      requiredBeforeDispatch: true,
      satisfied: true,
    },
    {
      id: "dispatch_request_draft",
      label: "This dispatch request draft",
      reference: dispatchRequestReference,
      requiredBeforeDispatch: true,
      satisfied: true,
    },
    {
      id: "blocked_steps_check",
      label: "Blocked permanently steps check (operator review)",
      reference: dispatchRequestReference + ":blocked-steps",
      requiredBeforeDispatch: true,
      satisfied: true, // Always satisfied — the dispatch request tracks this
    },
  ];
}

function synthesizeExecutionPlanDraftFromApprovalRequest(
  request: OperatorApprovalRequestPacket,
): ComplexityExecutionPlanDraftPacket {
  const executionMode = toExecutionPlanMode(request.executionMode);
  const executionBlocked =
    request.executionBlocked ||
    request.state === "approval_request_blocked" ||
    executionMode === "operator_review_gated";
  const decision = request.state === "approval_request_blocked"
    ? "plan_safety_blocked"
    : request.approvalRequired
    ? "plan_ready"
    : "plan_approval_not_needed";

  return {
    kind: "a2a-broker.complexity-execution-plan-draft.packet",
    version: 1,
    generatedAt: request.generatedAt,
    idempotencyKey: request.sourcePlanIdempotencyKey,
    sourceEnvelopeIdempotencyKey: request.sourceEnvelopeIdempotencyKey,
    sourceRecommendationIdempotencyKey: request.sourceRecommendationIdempotencyKey,
    envelopeCategory: request.envelopeCategory,
    action: request.action,
    complexity: request.complexity,
    steps: synthesizeStepsFromApprovalRequest(request, executionMode),
    executionBlocked,
    approvalRequired: request.approvalRequired,
    executionMode,
    decision,
    blockers: request.blockers,
    description:
      `Dispatch request source synthesized from operator approval request ${request.idempotencyKey}.`,
    nextActions: request.nextActions,
    boundaries: {
      runtimeBehaviorChanged: false,
      mandatoryProductionSpawn: false,
      brokerDispatchSemanticsChanged: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      secretMovement: false,
      approvalGranted: false,
      executionDispatched: false,
      providerMessageSent: false,
      terminalAckPerformed: false,
    },
    semantics: {
      planDraftOnly: true,
      approvalNotGranted: true,
      autonomousExecutionBlocked: executionBlocked,
      sourceOnlyNoLive: true,
      planStepsNotExecuted: true,
      performsGitHubMutation: false,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
      createsTaskFlowRecords: false,
      performsHistoricalReplay: false,
      performsReleaseOrPublish: false,
      movesSecretsOrCredentials: false,
    },
  };
}

function synthesizeStepsFromApprovalRequest(
  request: OperatorApprovalRequestPacket,
  executionMode: ExecutionPlanMode,
): ExecutionPlanStep[] {
  const root: ExecutionPlanStep = {
    stepId: "operator-approval-request-root",
    kind: executionMode === "operator_review_gated"
      ? "operator_review"
      : request.approvalRequired
      ? "approval_gate"
      : "direct_execution",
    label: `Operator approval request for ${request.action}`,
    dependsOn: [],
    executionBlocked:
      request.state === "approval_request_blocked" ||
      executionMode === "operator_review_gated",
    requiresApproval: request.approvalRequired,
    roles: [],
    safetyGate: "Dispatch request consumes explicit operator approval evidence and does not grant approval by itself.",
  };

  const plannedSteps = Math.max(0, request.stepCount - 2);
  const executionSteps = Array.from({ length: plannedSteps }, (_, index): ExecutionPlanStep => ({
    stepId: `operator-approved-step-${index + 1}`,
    kind: request.complexity === "complex"
      ? "subagent_parallel"
      : request.complexity === "moderate"
      ? "subagent_sequential"
      : "direct_execution",
    label: `Planned approved step ${index + 1} for ${request.action}`,
    dependsOn: [root.stepId],
    executionBlocked: false,
    requiresApproval: false,
    roles: [],
    safetyGate: "Planned only; this dispatch request draft does not execute the step.",
  }));

  const completion: ExecutionPlanStep = {
    stepId: "operator-approval-request-completion",
    kind: "completion",
    label: "Operator-approved dispatch request complete",
    dependsOn: [root.stepId, ...executionSteps.map((step) => step.stepId)],
    executionBlocked: false,
    requiresApproval: false,
    roles: [],
    safetyGate: "Completion marker only; not a runtime dispatch.",
  };

  return [root, ...executionSteps, completion];
}

function toExecutionPlanMode(value: string): ExecutionPlanMode {
  return value === "autonomous" ||
    value === "operator_notify" ||
    value === "operator_approval_gated" ||
    value === "operator_review_gated"
    ? value
    : "operator_review_gated";
}

function nextActionFor(
  state: OperatorApprovedExecutionPlanDispatchState,
): string {
  switch (state) {
    case "dispatch_request_ready":
      return "broker finalizer may route this dispatch request to an adapter for further processing; this packet does nothing on its own";
    case "waiting_for_execution_plan":
      return "wait for a ready execution plan draft (#982) before building the dispatch request";
    case "waiting_for_operator_approval":
      return "operator has not yet provided approval decisions for the execution plan steps";
    case "plan_denied":
      return "plan was denied by operator; create a new execution plan if the issue/policy changes";
    case "plan_stale":
      return "execution plan is stale; rebuild from a fresh finalizer approval envelope";
    case "plan_safety_blocked":
      return "resolve safety block in the execution plan draft before building the dispatch request";
    default:
      return "resolve blocked state before proceeding";
  }
}

function nextActionsFor(
  state: OperatorApprovedExecutionPlanDispatchState,
  approvedCount: number,
  deniedCount: number,
  hasBlockedPermanently: boolean,
): string[] {
  const actions: string[] = [nextActionFor(state)];

  if (state === "dispatch_request_ready") {
    if (approvedCount > 0) {
      actions.push(
        `${approvedCount} step(s) are cleared for dispatch. ` +
        "A future dispatcher may use this as evidence of operator approval.",
      );
    }
    if (deniedCount > 0) {
      actions.push(
        `${deniedCount} step(s) were denied by the operator and must not be dispatched.`,
      );
    }
    if (hasBlockedPermanently) {
      actions.push(
        "Operator review steps remain permanently blocked. " +
        "They CANNOT be dispatched or executed through any path.",
      );
    }
  }

  actions.push(
    "do not dispatch executor, invoke executor, spawn process, start sidecar, " +
    "ACK terminal rows, mutate state, or execute any step from this packet",
  );

  return actions;
}

function isReviewStepId(
  stepId: string,
  executionPlan: ComplexityExecutionPlanDraftPacket,
): boolean {
  return executionPlan.steps.some(
    (s) => s.stepId === stepId && s.kind === "operator_review",
  );
}

function approvalSensitiveActionsExcluded(): string[] {
  return [
    "dispatching or invoking a start executor",
    "spawning a process or starting/stopping the sidecar",
    "Terminal Brief default-on enablement",
    "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
    "terminal ACK/replay or terminal receipt DB mutation",
    "GitHub PR merge, issue close, or comment post from the packet/route",
    "TaskFlow record creation or broker DB mutation",
    "production deploy/restart, historical replay, release, publish, or secret movement",
  ];
}

function isComplexityExecutionPlanDraftPacket(
  value: unknown,
): value is ComplexityExecutionPlanDraftPacket {
  return (
    isRecord(value) &&
    value.kind === "a2a-broker.complexity-execution-plan-draft.packet"
  );
}

function isOperatorApprovalRequestPacket(
  value: unknown,
): value is OperatorApprovalRequestPacket {
  return isRecord(value) &&
    value.kind === "a2a-broker.operator-approval-request.packet";
}

