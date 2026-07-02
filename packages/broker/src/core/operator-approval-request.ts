// ── Operator approval request for sealed execution plan (source-only, no-live) ─
//
// Consumes a ComplexityExecutionPlanPreflightSealPacket (#989) and produces a
// deterministic operator approval request for eventual sealed execution.
// This module sits after the execution plan draft in the pipeline:
//
//   complexity classifier (#970)
//     → orchestration recommendation (#971)
//     → approval envelope draft (#978)
//     → execution plan draft (#982)
//     → preflight seal (#989)
//     → operator approval request (#990) ← THIS MODULE
//
// The operator approval request renders the exact operator-facing fields
// needed before a later, separately-gated execution path:
//
//   - selected plan id       — which execution plan is being approved
//   - risks                  — compiled risk summary
//   - required approvals     — who/what must approve
//   - abort conditions       — conditions that trigger automatic abort
//   - evidence refs          — links to supporting evidence artifacts
//   - idempotency key        — for idempotent submission
//   - approval expiration    — guidance on how long the approval window lasts
//
// Safety boundaries (all statically enforced):
//   - No broker/Gateway/worker service access
//   - No DB mutation or live provider send
//   - No subagent spawn or executor invocation
//   - No terminal ACK/replay or release operation
//   - No secret or credential exposure
//   - No grant of approval — the request is a draft only
//   - No execution dispatch — the request does not execute anything
//   - No sealed plan consumption — the request is a draft preview
//
// Reference: #990 Team2 workerepsilon — operator approval request for sealed
//            execution plan.
// Parent:    #982 Team2 — complexity execution plan draft.
// ─────────────────────────────────────────────────────────────────────────────

import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";
import type {
  ComplexityExecutionPlanDraftPacket,
  ExecutionPlanMode,
  ExecutionPlanStep,
} from "./complexity-execution-plan-draft.js";
import type { ComplexityExecutionPlanPreflightSealPacket } from "./complexity-execution-plan-preflight-seal.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Approval request state.
 *
 * - `approval_request_ready`: the request is ready for operator review.
 * - `approval_not_needed`: no operator approval is needed (autonomous plan).
 * - `approval_request_blocked`: the request is blocked (safety/unknown state).
 */
export type OperatorApprovalRequestState =
  | "approval_request_ready"
  | "approval_not_needed"
  | "approval_request_blocked";

/**
 * Categorized risk severity.
 */
export type RiskSeverity = "critical" | "high" | "medium" | "low" | "none";

/**
 * A single identified risk.
 */
export interface OperatorApprovalRisk {
  /** Unique stable risk identifier. */
  riskId: string;
  /** Severity classification. */
  severity: RiskSeverity;
  /** Short risk label. */
  label: string;
  /** Detailed description of the risk. */
  description: string;
  /** Whether this risk requires explicit operator acknowledgment. */
  requiresAcknowledgment: boolean;
  /** Mitigation guidance. */
  mitigation: string;
}

/**
 * Required approval gate.
 */
export interface OperatorApprovalRequiredGate {
  /** Gate identifier. */
  gateId: string;
  /** Human-readable gate label. */
  label: string;
  /** Description of what this gate checks. */
  description: string;
  /** Who or what is the approver for this gate. */
  approver: string;
  /** Whether this gate is mandatory (cannot be skipped). */
  mandatory: boolean;
}

/**
 * An abort condition — when triggered, execution must stop.
 */
export interface OperatorApprovalAbortCondition {
  /** Abort condition identifier. */
  abortId: string;
  /** Human-readable condition. */
  condition: string;
  /** Description of what triggers this abort. */
  triggerDescription: string;
  /** Severity of the abort. */
  severity: RiskSeverity;
  /** Whether this is a hard abort (unrecoverable) or soft abort (recoverable). */
  hardAbort: boolean;
}

/**
 * An evidence reference — links to supporting artifacts.
 */
export interface OperatorApprovalEvidenceRef {
  /** Evidence reference identifier. */
  refId: string;
  /** Human-readable label. */
  label: string;
  /** Reference URI or path. */
  uri: string;
  /** Whether this evidence is required (mandatory) before approval. */
  required: boolean;
}

/**
 * Approval expiration guidance.
 */
export interface OperatorApprovalExpiration {
  /** Suggested expiry (ISO timestamp) after which approval should be re-requested. */
  expiresAt: string;
  /** Reason for the expiration window. */
  reason: string;
  /** Whether this is a hard expiry (must re-request) or soft (recommended). */
  hardExpiry: boolean;
}

/**
 * Operator approval request for a sealed execution plan.
 *
 * This packet is an *approval request draft* — it does NOT grant approval,
 * does NOT dispatch anything, does NOT seal anything, and does NOT mutate
 * state. Its sole purpose is to present the operator with the information
 * needed to make an informed approval decision before any execution path.
 */
export interface OperatorApprovalRequestPacket {
  kind: "a2a-broker.operator-approval-request.packet";
  version: 1;
  generatedAt: string;
  /** Approval request state. */
  state: OperatorApprovalRequestState;
  /**
   * Idempotency key derived from the source plan idempotency key.
   * Deterministic for identical inputs.
   */
  idempotencyKey: string;
  /** The execution plan idempotency key this request was derived from. */
  sourcePlanIdempotencyKey: string;
  /** The envelope idempotency key carried through from the plan. */
  sourceEnvelopeIdempotencyKey: string;
  /** The recommendation idempotency key carried through from the plan. */
  sourceRecommendationIdempotencyKey: string;

  // ── Operator-facing fields ──────────────────────────────────────────

  /** Selected plan identifier (the execution plan being requested). */
  selectedPlanId: string;
  /** Human-readable title for this approval request. */
  title: string;
  /** Summary of the request. */
  summary: string;

  /** Identified risks. */
  risks: OperatorApprovalRisk[];
  /** Required approval gates. */
  requiredApprovals: OperatorApprovalRequiredGate[];
  /** Abort conditions. */
  abortConditions: OperatorApprovalAbortCondition[];
  /** Evidence references. */
  evidenceRefs: OperatorApprovalEvidenceRef[];
  /** Approval expiration guidance. */
  expiration: OperatorApprovalExpiration;
  /** Detailed notes for the operator. */
  operatorNotes: string[];

  // ── Source plan summary ─────────────────────────────────────────────

  /** The execution mode from the source plan. */
  executionMode: string;
  /** Whether execution is blocked in the source plan. */
  executionBlocked: boolean;
  /** Whether approval is required in the source plan. */
  approvalRequired: boolean;
  /** The envelope category from the source plan. */
  envelopeCategory: string;
  /** The action from the source plan. */
  action: string;
  /** The complexity from the source plan. */
  complexity: string;
  /** Number of steps in the source plan. */
  stepCount: number;

  // ── Blockers ────────────────────────────────────────────────────────

  /** Blocker list — non-empty only when state is "approval_request_blocked". */
  blockers: string[];

  /** Next actions for the consumer of this request. */
  nextActions: string[];

  /** Static boundary enforcement — all false. */
  boundaries: {
    runtimeBehaviorChanged: false;
    mandatoryProductionSpawn: false;
    brokerDispatchSemanticsChanged: false;
    taskFlowMutation: false;
    dbMutation: false;
    deployOrRestart: false;
    secretMovement: false;
    approvalGranted: false;
    executionDispatched: false;
    providerMessageSent: false;
    terminalAckPerformed: false;
    sealedPlanConsumed: false;
    executionWindowOpened: false;
  };

  /** Static safety semantics. */
  semantics: {
    approvalRequestDraftOnly: true;
    approvalNotGranted: true;
    autonomousExecutionBlocked: boolean;
    sourceOnlyNoLive: true;
    planStepsNotExecuted: true;
    performsGitHubMutation: false;
    performsProviderSend: false;
    performsTerminalAck: false;
    performsRuntimeRestartOrDeploy: false;
    performsDbMutation: false;
    createsTaskFlowRecords: false;
    performsHistoricalReplay: false;
    performsReleaseOrPublish: false;
    movesSecretsOrCredentials: false;
    performsApprovalGrant: false;
    performsExecutionDispatch: false;
    performsSeal: false;
    opensExecutionWindow: false;
  };
}

// ---------------------------------------------------------------------------
// Static risk mapping by envelope category
// ---------------------------------------------------------------------------

interface RiskProfile {
  risks: Array<Omit<OperatorApprovalRisk, "riskId">>;
  abortConditions: Array<Omit<OperatorApprovalAbortCondition, "abortId">>;
  requiredApprovals: Array<Omit<OperatorApprovalRequiredGate, "gateId">>;
  evidenceRefs: Array<Omit<OperatorApprovalEvidenceRef, "refId">>;
  expiration: Omit<OperatorApprovalExpiration, "expiresAt">;
  operatorNotes: string[];
}

const RISK_PROFILES: Record<string, RiskProfile> = {
  autonomous: {
    risks: [
      {
        severity: "low",
        label: "Autonomous execution risk",
        description: "Plan executes autonomously without operator oversight. No approval gate exists.",
        requiresAcknowledgment: false,
        mitigation: "Review plan details to ensure autonomous execution is appropriate. Monitor execution logs.",
      },
    ],
    abortConditions: [
      {
        condition: "Execution failure of any step",
        triggerDescription: "Any direct execution step returns a non-success status.",
        severity: "medium",
        hardAbort: false,
      },
    ],
    requiredApprovals: [],
    evidenceRefs: [
      {
        label: "Execution plan draft",
        uri: "source-execution-plan-draft",
        required: true,
      },
    ],
    expiration: {
      reason: "Autonomous plans have no explicit approval window, but execution should begin promptly.",
      hardExpiry: false,
    },
    operatorNotes: [
      "This plan does not require operator approval. Review is informational only.",
      "Execution will not be blocked by waiting for operator input.",
    ],
  },
  operator_notify: {
    risks: [
      {
        severity: "low",
        label: "Operator notification risk",
        description: "Operator will be notified before execution, but no explicit approval is required.",
        requiresAcknowledgment: false,
        mitigation: "Ensure notification channel is monitored. Execution proceeds after notification.",
      },
    ],
    abortConditions: [
      {
        condition: "Notification delivery failure",
        triggerDescription: "Operator notification cannot be delivered within timeout window.",
        severity: "medium",
        hardAbort: false,
      },
    ],
    requiredApprovals: [
      {
        label: "Operator notification acknowledgment",
        description: "Operator must acknowledge receipt of notification before execution proceeds.",
        approver: "on-call operator",
        mandatory: false,
      },
    ],
    evidenceRefs: [
      {
        label: "Execution plan draft",
        uri: "source-execution-plan-draft",
        required: true,
      },
    ],
    expiration: {
      reason: "Notification has no expiry, but the execution window should begin within a reasonable timeframe.",
      hardExpiry: false,
    },
    operatorNotes: [
      "Operator notification is required before execution can proceed.",
      "Operator acknowledgment is recommended but not mandatory.",
      "This is NOT an approval gate — it is an awareness notification only.",
    ],
  },
  operator_approval_gated: {
    risks: [
      {
        severity: "medium",
        label: "Approval-gated subagent execution",
        description: "Plan requires explicit operator approval before any subagent execution steps proceed.",
        requiresAcknowledgment: true,
        mitigation: "Review all subagent roles and safety gates. Only approve after thorough review.",
      },
      {
        severity: "medium",
        label: "Subagent complexity risk",
        description: "Subagent execution involves moderately complex orchestration with sequential or parallel steps.",
        requiresAcknowledgment: true,
        mitigation: "Verify subagent roles are bounded and have disjoint write sets where applicable.",
      },
    ],
    abortConditions: [
      {
        condition: "Operator declines approval",
        triggerDescription: "Operator explicitly declines or rejects the approval request.",
        severity: "high",
        hardAbort: true,
      },
      {
        condition: "Approval window expires",
        triggerDescription: "Approval request reaches its expiration timestamp without a decision.",
        severity: "medium",
        hardAbort: true,
      },
      {
        condition: "Subagent execution failure",
        triggerDescription: "Any subagent execution step returns a non-success or error status.",
        severity: "high",
        hardAbort: false,
      },
    ],
    requiredApprovals: [
      {
        label: "Operator approval gate",
        description: "Explicit operator approval is required before any execution step can proceed.",
        approver: "authorized operator",
        mandatory: true,
      },
    ],
    evidenceRefs: [
      {
        label: "Execution plan draft",
        uri: "source-execution-plan-draft",
        required: true,
      },
      {
        label: "Approval envelope draft",
        uri: "source-approval-envelope-draft",
        required: true,
      },
    ],
    expiration: {
      reason: "Approval requests for subagent execution should be reviewed and decided promptly.",
      hardExpiry: true,
    },
    operatorNotes: [
      "Operator approval is required before any execution step proceeds.",
      "The first step in the execution plan is an approval gate.",
      "All subagent steps depend on passing the approval gate first.",
      "Do NOT approve without reviewing subagent roles, safety gates, and risks.",
    ],
  },
  operator_review_gated: {
    risks: [
      {
        severity: "critical",
        label: "Critical execution — autonomous execution BLOCKED",
        description: "Plan involves critical complexity. Autonomous execution is blocked pending operator review.",
        requiresAcknowledgment: true,
        mitigation: "Manual operator review is mandatory. Do NOT bypass the review gate.",
      },
      {
        severity: "high",
        label: "No autonomous subagent permitted",
        description: "No subagent or execution step may proceed autonomously. All paths are blocked.",
        requiresAcknowledgment: true,
        mitigation: "Operator must manually review and explicitly unblock each step.",
      },
      {
        severity: "high",
        label: "Potential live impact",
        description: "Critical execution plans may affect live systems. Review must be thorough.",
        requiresAcknowledgment: true,
        mitigation: "Check all safety gates, verify rollback paths, and ensure evidence is complete.",
      },
    ],
    abortConditions: [
      {
        condition: "Operator review required — all paths blocked",
        triggerDescription: "All execution steps are blocked until operator completes review.",
        severity: "critical",
        hardAbort: true,
      },
      {
        condition: "Operator declines after review",
        triggerDescription: "Operator completes review and declines or blocks execution.",
        severity: "critical",
        hardAbort: true,
      },
      {
        condition: "Review window expires without decision",
        triggerDescription: "The operator review window expires without a decision from the operator.",
        severity: "high",
        hardAbort: true,
      },
    ],
    requiredApprovals: [
      {
        label: "Operator review gate (mandatory)",
        description: "Operator must complete review before ANY execution can proceed. All paths are blocked.",
        approver: "authorized operator",
        mandatory: true,
      },
    ],
    evidenceRefs: [
      {
        label: "Execution plan draft",
        uri: "source-execution-plan-draft",
        required: true,
      },
      {
        label: "Approval envelope draft",
        uri: "source-approval-envelope-draft",
        required: true,
      },
      {
        label: "Orchestration recommendation",
        uri: "source-orchestration-recommendation",
        required: true,
      },
    ],
    expiration: {
      reason: "Critical execution plans must be reviewed promptly. Expired reviews require re-evaluation.",
      hardExpiry: true,
    },
    operatorNotes: [
      "CRITICAL: All execution is BLOCKED pending operator review.",
      "No autonomous subagent spawn or execution is permitted under any circumstances.",
      "Operator review must complete and explicitly grant approval.",
      "This approval request does NOT and CANNOT grant approval autonomously.",
      "After review, a separate approval grant path is required.",
    ],
  },
};

const DEFAULT_RISK_PROFILE: RiskProfile = {
  risks: [
    {
      severity: "high",
      label: "Unknown execution mode — safety blocked",
      description: "The execution mode is not recognized. All execution is blocked.",
      requiresAcknowledgment: true,
      mitigation: "Inspect the source plan and verify the execution mode is valid.",
    },
  ],
  abortConditions: [
    {
      condition: "Unknown execution mode",
      triggerDescription: "Execution mode from source plan is not in the recognized set.",
      severity: "critical",
      hardAbort: true,
    },
  ],
  requiredApprovals: [
    {
      label: "System review gate",
      description: "Unknown execution mode requires system review before any action.",
      approver: "system (blocked)",
      mandatory: true,
    },
  ],
  evidenceRefs: [
    {
      label: "Execution plan draft",
      uri: "source-execution-plan-draft",
      required: true,
    },
  ],
  expiration: {
    reason: "Blocked requests have no expiration — they remain blocked until resolved.",
    hardExpiry: false,
  },
  operatorNotes: [
    "This request is blocked due to an unknown or unrecognized execution mode.",
    "Inspect the source execution plan draft for errors.",
    "Do NOT attempt to override the safety block manually.",
  ],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a deterministic operator approval request from a complexity execution
 * plan draft packet (#982).
 *
 * The approval request renders operator-facing fields for review before any
 * later, separately-gated execution path. It includes:
 *   - Selected plan ID
 *   - Identified risks with severities
 *   - Required approval gates
 *   - Abort conditions
 *   - Evidence references
 *   - Approval expiration guidance
 *   - Operator notes
 *
 * CRITICAL SAFETY INVARIANT:
 *   - operator_review_gated mode ALWAYS produces an approval_request_blocked
 *     state — the request is presented for review but autonomous execution
 *     is blocked.
 *   - No request grants approval. All boundaries enforce source-only/no-live.
 *   - The request does NOT seal anything or open an execution window.
 *
 * @param plan     A ComplexityExecutionPlanDraftPacket (#982).
 * @param options  Optional overrides (generatedAt timestamp).
 */
export function buildOperatorApprovalRequest(
  plan: ComplexityExecutionPlanDraftPacket,
  options: { now?: string } = {},
): OperatorApprovalRequestPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const executionMode = plan.executionMode;
  const safeBlocked = plan.decision === "plan_safety_blocked";

  // Determine the risk profile key
  // For safety-blocked plans, use the default (unknown) risk profile.
  // Otherwise, use the execution mode from the plan.
  const riskProfileKey = safeBlocked ? "__unknown__" : executionMode;
  const profile = RISK_PROFILES[riskProfileKey] ?? DEFAULT_RISK_PROFILE;

  // Determine the approval request state
  const state = determineState(plan, profile);
  const autonomousBlocked = plan.executionBlocked || state === "approval_request_blocked";

  // Deterministic idempotency key
  const idempotencyKey = buildRequestIdempotencyKey(plan, profile);

  // Blockers
  const blockers = buildBlockers(plan, state);

  // Build operator-facing fields
  const selectedPlanId = plan.idempotencyKey;
  const title = buildTitle(plan, state);
  const summary = buildSummary(plan, profile);

  const risks = buildRisks(plan, profile);
  const abortConditions = buildAbortConditions(plan, profile);
  const requiredApprovals = buildRequiredApprovals(plan, profile);
  const evidenceRefs = buildEvidenceRefs(plan, profile);

  const expiration: OperatorApprovalExpiration = {
    expiresAt: computeExpiresAt(generatedAt, profile, plan),
    ...profile.expiration,
  };

  const nextActions = buildNextActions(plan, state);

  return {
    kind: "a2a-broker.operator-approval-request.packet",
    version: 1,
    generatedAt,
    state,
    idempotencyKey,
    sourcePlanIdempotencyKey: plan.idempotencyKey,
    sourceEnvelopeIdempotencyKey: plan.sourceEnvelopeIdempotencyKey,
    sourceRecommendationIdempotencyKey: plan.sourceRecommendationIdempotencyKey,

    selectedPlanId,
    title,
    summary,

    risks,
    requiredApprovals,
    abortConditions,
    evidenceRefs,
    expiration,
    operatorNotes: profile.operatorNotes,

    executionMode,
    executionBlocked: plan.executionBlocked,
    approvalRequired: plan.approvalRequired,
    envelopeCategory: plan.envelopeCategory,
    action: plan.action,
    complexity: plan.complexity,
    stepCount: plan.steps.length,

    blockers,
    nextActions,

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
      sealedPlanConsumed: false,
      executionWindowOpened: false,
    },
    semantics: {
      approvalRequestDraftOnly: true,
      approvalNotGranted: true,
      autonomousExecutionBlocked: autonomousBlocked,
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
      performsApprovalGrant: false,
      performsExecutionDispatch: false,
      performsSeal: false,
      opensExecutionWindow: false,
    },
  };
}

/**
 * Build an operator approval request from the sealed preflight packet (#989).
 *
 * This is the canonical #990 entry point. The older execution-plan helper is
 * kept for local pipeline tests, but operator-facing approval requests should
 * consume the seal so lineage, no-live boundary checks, and fail-closed status
 * are preserved before the request is rendered.
 */
export function buildOperatorApprovalRequestFromPreflightSeal(
  seal: ComplexityExecutionPlanPreflightSealPacket,
  options: { now?: string } = {},
): OperatorApprovalRequestPacket {
  const plan = synthesizeExecutionPlanDraftFromPreflightSeal(seal);
  const request = buildOperatorApprovalRequest(plan, options);
  return {
    ...request,
    evidenceRefs: [
      {
        refId: buildRefId(plan, 0, "preflight-seal"),
        label: "Complexity execution plan preflight seal",
        uri: `seal:${seal.idempotencyKey}`,
        required: true,
      },
      ...request.evidenceRefs,
    ],
    blockers: [
      ...seal.blockers.map((blocker) => `preflight seal: ${blocker}`),
      ...request.blockers,
    ],
    nextActions: seal.sealReady
      ? request.nextActions
      : [
          "preflight seal is not ready; do not request operator approval",
          ...seal.nextActions,
          ...request.nextActions,
        ],
  };
}

/**
 * Extract a preflight seal packet from direct or wrapped input.
 */
export function extractPreflightSealForOperatorApprovalRequest(
  input: unknown,
): ComplexityExecutionPlanPreflightSealPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.preflightSeal,
    envelope.executionPlanPreflightSeal,
    envelope.seal,
    envelope.packet,
  ];
  const packet = candidates.find(isComplexityExecutionPlanPreflightSealPacket);
  if (!packet) {
    throw new Error(
      "expected a ComplexityExecutionPlanPreflightSealPacket (#989) under preflightSeal, executionPlanPreflightSeal, seal, or packet",
    );
  }
  return packet;
}

/**
 * Render an operator approval request packet to human-readable markdown.
 * Pure function — no IO, no side effects.
 */
export function renderOperatorApprovalRequestMarkdown(
  packet: OperatorApprovalRequestPacket,
): string {
  const stateHeader =
    packet.state === "approval_request_blocked"
      ? "# SAFETY BLOCKED: Operator approval request"
      : packet.state === "approval_not_needed"
      ? "# Approval not needed: Operator approval request"
      : "# Operator approval request";

  const stateLabel =
    packet.state === "approval_request_blocked"
      ? "BLOCKED"
      : packet.state === "approval_not_needed"
      ? "NOT NEEDED"
      : "READY FOR REVIEW";

  return [
    stateHeader,
    "",
    `**State**: ${stateLabel}`,
    "",
    `- **generatedAt**: ${packet.generatedAt}`,
    `- **idempotencyKey**: ${packet.idempotencyKey}`,
    `- **selectedPlanId**: ${packet.selectedPlanId}`,
    "",
    "## Request details",
    "",
    `**${packet.title}**`,
    "",
    packet.summary,
    "",
    "### Source plan",
    "",
    `- **executionMode**: ${packet.executionMode}`,
    `- **executionBlocked**: ${packet.executionBlocked}`,
    `- **approvalRequired**: ${packet.approvalRequired}`,
    `- **envelopeCategory**: ${packet.envelopeCategory}`,
    `- **action**: ${packet.action}`,
    `- **complexity**: ${packet.complexity}`,
    `- **stepCount**: ${packet.stepCount}`,
    "",
    `- **sourcePlanIdempotencyKey**: ${packet.sourcePlanIdempotencyKey}`,
    `- **sourceEnvelopeIdempotencyKey**: ${packet.sourceEnvelopeIdempotencyKey}`,
    `- **sourceRecommendationIdempotencyKey**: ${packet.sourceRecommendationIdempotencyKey}`,
    "",
    "## Risks",
    "",
    ...(packet.risks.length === 0
      ? ["*(no risks identified)*"]
      : packet.risks.map((risk) => {
          return [
            `### [${risk.severity.toUpperCase()}] ${risk.label}`,
            "",
            risk.description,
            "",
            `- **requiresAcknowledgment**: ${risk.requiresAcknowledgment}`,
            `- **mitigation**: ${risk.mitigation}`,
            "",
          ].join("\n");
        })),
    "## Required approvals",
    "",
    ...(packet.requiredApprovals.length === 0
      ? ["*(no approvals required)*"]
      : packet.requiredApprovals.map((gate) => [
          `### ${gate.label}`,
          "",
          gate.description,
          "",
          `- **gateId**: ${gate.gateId}`,
          `- **approver**: ${gate.approver}`,
          `- **mandatory**: ${gate.mandatory}`,
          "",
        ].join("\n"))),
    "## Abort conditions",
    "",
    ...(packet.abortConditions.length === 0
      ? ["*(no abort conditions defined)*"]
      : packet.abortConditions.map((abort) => {
          const abortType = abort.hardAbort ? "🔴 Hard abort" : "🟡 Soft abort";
          return [
            `### ${abort.condition}`,
            "",
            `- **type**: ${abortType}`,
            `- **trigger**: ${abort.triggerDescription}`,
            `- **severity**: ${abort.severity}`,
            "",
          ].join("\n");
        })),
    "## Evidence references",
    "",
    ...(packet.evidenceRefs.length === 0
      ? ["*(no evidence references)*"]
      : packet.evidenceRefs.map((ref) =>
          `- **${ref.label}**: \`${ref.uri}\`${ref.required ? " *(required)*" : " *(optional)*"}`
        )),
    "",
    "## Approval expiration",
    "",
    `- **expiresAt**: ${packet.expiration.expiresAt}`,
    `- **reason**: ${packet.expiration.reason}`,
    `- **hardExpiry**: ${packet.expiration.hardExpiry}`,
    "",
    "## Operator notes",
    "",
    ...packet.operatorNotes.map((note) => `- ${note}`),
    "",
    "## Blockers",
    ...(packet.blockers.length === 0
      ? ["*(none)*"]
      : packet.blockers.map((b) => `- ${b}`)),
    "",
    "## Next actions",
    ...packet.nextActions.map((a) => `- ${a}`),
    "",
    "## Boundaries (no-live enforcement)",
    "",
    ...Object.entries(packet.boundaries).map(
      ([key, val]) => `- **${key}**: ${val}`,
    ),
    "",
    "## Semantics",
    "",
    ...Object.entries(packet.semantics).map(
      ([key, val]) => `- **${key}**: ${val}`,
    ),
    "",
    "This operator approval request is a draft only. It does not grant " +
    "approval, dispatch execution, seal a plan, open an execution window, " +
    "mutate DB, deploy/restart services, move secrets, send provider messages, " +
    "or perform ACK/replay. All execution/dispatch/live mutation booleans " +
    "remain false. A separate, later approval grant path is required before " +
    "any execution.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function determineState(
  plan: ComplexityExecutionPlanDraftPacket,
  profile: RiskProfile,
): OperatorApprovalRequestState {
  if (plan.decision === "plan_safety_blocked") {
    return "approval_request_blocked";
  }

  if (plan.executionBlocked) {
    return "approval_request_ready";
  }

  if (plan.executionMode === "autonomous") {
    return "approval_not_needed";
  }

  if (plan.executionMode === "operator_notify") {
    return "approval_request_ready";
  }

  if (plan.executionMode === "operator_approval_gated") {
    return "approval_request_ready";
  }

  if (plan.executionMode === "operator_review_gated") {
    return "approval_request_ready";
  }

  // Unknown mode — safety block
  return "approval_request_blocked";
}

function buildBlockers(
  plan: ComplexityExecutionPlanDraftPacket,
  state: OperatorApprovalRequestState,
): string[] {
  if (state !== "approval_request_blocked") {
    return [];
  }

  if (plan.decision === "plan_safety_blocked") {
    return [
      `SAFETY BLOCK: Source execution plan has decision "plan_safety_blocked". ` +
      "Operator approval request cannot proceed from a safety-blocked plan. " +
      "Inspect the source execution plan draft for unknown envelope categories " +
      "or invariant failures.",
      ...plan.blockers,
    ];
  }

  return [
    `SAFETY BLOCK: execution mode "${plan.executionMode}" is not recognized. ` +
    "Operator approval request cannot proceed from an unknown execution mode. " +
    "Inspect the source execution plan draft.",
  ];
}

function buildTitle(
  plan: ComplexityExecutionPlanDraftPacket,
  state: OperatorApprovalRequestState,
): string {
  if (state === "approval_request_blocked") {
    return `SAFETY BLOCKED: Approval request for ${plan.action}`;
  }
  if (state === "approval_not_needed") {
    return `Approval not needed: Autonomous execution for ${plan.action}`;
  }
  if (plan.executionMode === "operator_review_gated") {
    return `CRITICAL: Operator review required for ${plan.action}`;
  }
  if (plan.executionMode === "operator_approval_gated") {
    return `Operator approval required for ${plan.action}`;
  }
  if (plan.executionMode === "operator_notify") {
    return `Operator notification: ${plan.action}`;
  }
  return `Operator approval request: ${plan.action}`;
}

function buildSummary(
  plan: ComplexityExecutionPlanDraftPacket,
  profile: RiskProfile,
): string {
  const riskCount = profile.risks.length;
  const gateCount = profile.requiredApprovals.length;
  const abortCount = profile.abortConditions.length;

  const parts: string[] = [];

  if (plan.decision === "plan_safety_blocked") {
    parts.push(
      `The execution plan for "${plan.action}" is safety-blocked. ` +
      "No operator approval request can be generated from a blocked plan. " +
      "Resolve the blockers in the source execution plan draft first.",
    );
    return parts.join(" ");
  }

  if (plan.executionMode === "autonomous") {
    parts.push(
      `The execution plan for "${plan.action}" can execute autonomously ` +
      "without operator approval. " +
      `The plan has ${plan.steps.length} step(s) at ${plan.complexity} complexity. ` +
      `${riskCount} risk(s) identified, ${gateCount} approval gate(s) required, ` +
      `${abortCount} abort condition(s) defined.`,
    );
    return parts.join(" ");
  }

  if (plan.executionMode === "operator_notify") {
    parts.push(
      `The execution plan for "${plan.action}" requires operator notification ` +
      "before execution. " +
      `The plan has ${plan.steps.length} step(s) at ${plan.complexity} complexity. ` +
      `${riskCount} risk(s) identified, ${gateCount} approval gate(s) required, ` +
      `${abortCount} abort condition(s) defined.`,
    );
    return parts.join(" ");
  }

  if (plan.executionMode === "operator_approval_gated") {
    parts.push(
      `The execution plan for "${plan.action}" requires explicit operator approval ` +
      "before any execution steps can proceed. " +
      `The plan has ${plan.steps.length} step(s) at ${plan.complexity} complexity, ` +
      `with the first step being an approval gate. ` +
      `${riskCount} risk(s) identified, ${gateCount} approval gate(s) required, ` +
      `${abortCount} abort condition(s) defined.`,
    );
    return parts.join(" ");
  }

  if (plan.executionMode === "operator_review_gated") {
    parts.push(
      `CRITICAL: The execution plan for "${plan.action}" requires operator review. ` +
      "All execution is BLOCKED pending operator review. " +
      `The plan has ${plan.steps.length} step(s) at ${plan.complexity} complexity. ` +
      `${riskCount} risk(s) identified, ${gateCount} mandatory approval gate(s) required, ` +
      `${abortCount} abort condition(s) defined. ` +
      "Autonomous execution is not permitted under any circumstances.",
    );
    return parts.join(" ");
  }

  parts.push(
    `Operator approval request for "${plan.action}" at ${plan.complexity} complexity. ` +
    `${plan.steps.length} step(s) in the execution plan.`,
  );
  return parts.join(" ");
}

function buildRisks(
  plan: ComplexityExecutionPlanDraftPacket,
  profile: RiskProfile,
): OperatorApprovalRisk[] {
  return profile.risks.map((risk, index) => ({
    riskId: buildRiskId(plan, index, risk.label),
    ...risk,
  }));
}

function buildAbortConditions(
  plan: ComplexityExecutionPlanDraftPacket,
  profile: RiskProfile,
): OperatorApprovalAbortCondition[] {
  return profile.abortConditions.map((abort, index) => ({
    abortId: buildAbortId(plan, index, abort.condition),
    ...abort,
  }));
}

function buildRequiredApprovals(
  plan: ComplexityExecutionPlanDraftPacket,
  profile: RiskProfile,
): OperatorApprovalRequiredGate[] {
  return profile.requiredApprovals.map((gate, index) => ({
    gateId: buildGateId(plan, index, gate.label),
    ...gate,
  }));
}

function buildEvidenceRefs(
  plan: ComplexityExecutionPlanDraftPacket,
  profile: RiskProfile,
): OperatorApprovalEvidenceRef[] {
  // Add the execution plan itself as a required evidence ref
  const refs: OperatorApprovalEvidenceRef[] = [
    {
      refId: buildRefId(plan, 0, "execution-plan-draft"),
      label: "Execution plan draft",
      uri: `plan:${plan.idempotencyKey}`,
      required: true,
    },
  ];

  // Add profile-specific refs (skipping the default execution plan ref)
  for (const ref of profile.evidenceRefs) {
    if (ref.label === "Execution plan draft") continue;
    refs.push({
      refId: buildRefId(plan, refs.length, ref.label),
      ...ref,
    });
  }

  return refs;
}

function computeExpiresAt(
  generatedAt: string,
  profile: RiskProfile,
  plan: ComplexityExecutionPlanDraftPacket,
): string {
  // Hard expiry: operator_approval_gated → 24h, operator_review_gated → 12h
  // Soft/no expiry: others → 7 days
  const baseTime = new Date(generatedAt).getTime();

  let expiryMs: number;
  if (plan.executionMode === "operator_review_gated") {
    expiryMs = 12 * 60 * 60 * 1000; // 12 hours
  } else if (plan.executionMode === "operator_approval_gated") {
    expiryMs = 24 * 60 * 60 * 1000; // 24 hours
  } else if (plan.executionMode === "operator_notify") {
    expiryMs = 48 * 60 * 60 * 1000; // 48 hours
  } else {
    expiryMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  return new Date(baseTime + expiryMs).toISOString();
}

function buildNextActions(
  plan: ComplexityExecutionPlanDraftPacket,
  state: OperatorApprovalRequestState,
): string[] {
  if (state === "approval_request_blocked") {
    return [
      `The source execution plan is blocked. Resolve blockers in the plan before requesting approval.`,
      `Do NOT attempt to override the safety block manually.`,
      `Inspect the blocker list above for details.`,
    ];
  }

  if (state === "approval_not_needed") {
    return [
      `Action "${plan.action}" does not require operator approval. Direct execution is safe.`,
      "Consume this request as evidence that no approval gate is needed.",
      "Do NOT use this request to bypass safety gates on other actions.",
    ];
  }

  if (plan.executionMode === "operator_notify") {
    return [
      `Action "${plan.action}" requires operator notification before proceeding.`,
      "Route this request to an operator notification channel (source-only, no-live).",
      "Do NOT interpret operator notification as an approval grant for execution.",
    ];
  }

  if (plan.executionMode === "operator_approval_gated") {
    return [
      `Action "${plan.action}" requires explicit operator approval before any execution.`,
      "Route this approval request through a separate approval grant path.",
      "The approval grant path must be a separate, source-only step that does NOT",
      "mutate the request itself.",
      `Approval window expires at the expiration timestamp in this request.`,
      "After expiry, a new approval request must be generated.",
    ];
  }

  // operator_review_gated
  return [
    `Action "${plan.action}" (critical) requires operator review. Autonomous execution is BLOCKED.`,
    "Route this request to the operator review channel. No subagent spawn, no execution.",
    "Operator review must complete and explicitly grant approval before any action.",
    "This request does NOT and CANNOT grant approval autonomously.",
    "All execution steps are blocked until review completes.",
  ];
}

function buildRequestIdempotencyKey(
  plan: ComplexityExecutionPlanDraftPacket,
  profile: RiskProfile,
): string {
  const seed = stableStringify({
    label: "operator-approval-request",
    sourcePlanIdempotencyKey: plan.idempotencyKey,
    action: plan.action,
    executionMode: plan.executionMode,
    envelopeCategory: plan.envelopeCategory,
    profileRiskCount: profile.risks.length,
  });
  return "operator-approval-request:" +
    createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function synthesizeExecutionPlanDraftFromPreflightSeal(
  seal: ComplexityExecutionPlanPreflightSealPacket,
): ComplexityExecutionPlanDraftPacket {
  const executionMode = toExecutionPlanMode(seal.executionMode);
  const executionBlocked =
    !seal.sealReady ||
    seal.state === "plan_safety_blocked" ||
    executionMode === "operator_review_gated" ||
    seal.rollbackStatus.stepsBlocked > 0;
  const approvalRequired =
    seal.workerEligibility.approvalGatePresent ||
    executionMode === "operator_approval_gated" ||
    executionMode === "operator_review_gated";
  const decision = seal.sealReady
    ? (approvalRequired ? "plan_ready" : "plan_approval_not_needed")
    : "plan_safety_blocked";

  return {
    kind: "a2a-broker.complexity-execution-plan-draft.packet",
    version: 1,
    generatedAt: seal.generatedAt,
    idempotencyKey: seal.sourcePlanIdempotencyKey,
    sourceEnvelopeIdempotencyKey: seal.sourceEnvelopeIdempotencyKey,
    sourceRecommendationIdempotencyKey: seal.sourceRecommendationIdempotencyKey,
    envelopeCategory: seal.envelopeCategory,
    action: seal.action,
    complexity: seal.complexity,
    steps: synthesizeStepsFromPreflightSeal(seal, executionMode),
    executionBlocked,
    approvalRequired,
    executionMode,
    decision,
    blockers: seal.blockers,
    description:
      `Operator approval request synthesized from preflight seal ${seal.idempotencyKey}.`,
    nextActions: seal.nextActions,
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

function synthesizeStepsFromPreflightSeal(
  seal: ComplexityExecutionPlanPreflightSealPacket,
  executionMode: ExecutionPlanMode,
): ExecutionPlanStep[] {
  const roles = seal.workerEligibility.rolesRequested;
  const root: ExecutionPlanStep = {
    stepId: "seal-preflight-review",
    kind: executionMode === "operator_review_gated"
      ? "operator_review"
      : seal.workerEligibility.approvalGatePresent
      ? "approval_gate"
      : "direct_execution",
    label: `Review sealed plan for ${seal.action}`,
    dependsOn: [],
    executionBlocked: !seal.sealReady || executionMode === "operator_review_gated",
    requiresApproval:
      executionMode === "operator_approval_gated" ||
      executionMode === "operator_review_gated",
    roles,
    safetyGate: "Operator approval request is derived from a sealed preflight packet and does not grant approval.",
  };

  const subagentStepCount = Math.max(0, seal.workerEligibility.subagentStepsPlanned);
  const subagentSteps = Array.from({ length: subagentStepCount }, (_, index): ExecutionPlanStep => ({
    stepId: `seal-subagent-${index + 1}`,
    kind: seal.workerEligibility.parallelStepsPlanned
      ? "subagent_parallel"
      : "subagent_sequential",
    label: `Planned subagent step ${index + 1} for ${seal.action}`,
    dependsOn: [root.stepId],
    executionBlocked: false,
    requiresApproval: false,
    roles: roles.length > 0 ? [roles[index % roles.length]] : [],
    safetyGate: "Subagent step remains planned only; no dispatch is permitted by the approval request draft.",
  }));

  const completion: ExecutionPlanStep = {
    stepId: "seal-completion",
    kind: "completion",
    label: "Sealed plan review complete",
    dependsOn: [root.stepId, ...subagentSteps.map((step) => step.stepId)],
    executionBlocked: false,
    requiresApproval: false,
    roles: [],
    safetyGate: "Completion marker only; not an execution permit.",
  };

  return [root, ...subagentSteps, completion];
}

function toExecutionPlanMode(value: string): ExecutionPlanMode {
  return value === "autonomous" ||
    value === "operator_notify" ||
    value === "operator_approval_gated" ||
    value === "operator_review_gated"
    ? value
    : "operator_review_gated";
}

function buildRiskId(
  plan: ComplexityExecutionPlanDraftPacket,
  index: number,
  label: string,
): string {
  const seed = stableStringify({
    planKey: plan.idempotencyKey,
    index,
    label,
    type: "risk",
  });
  return `risk-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

function buildAbortId(
  plan: ComplexityExecutionPlanDraftPacket,
  index: number,
  condition: string,
): string {
  const seed = stableStringify({
    planKey: plan.idempotencyKey,
    index,
    condition,
    type: "abort",
  });
  return `abort-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

function buildGateId(
  plan: ComplexityExecutionPlanDraftPacket,
  index: number,
  label: string,
): string {
  const seed = stableStringify({
    planKey: plan.idempotencyKey,
    index,
    label,
    type: "gate",
  });
  return `gate-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

function buildRefId(
  plan: ComplexityExecutionPlanDraftPacket,
  index: number,
  label: string,
): string {
  const seed = stableStringify({
    planKey: plan.idempotencyKey,
    index,
    label,
    type: "ref",
  });
  return `ref-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Stable JSON stringify for deterministic keying
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",")}}`;
}

function isComplexityExecutionPlanPreflightSealPacket(
  value: unknown,
): value is ComplexityExecutionPlanPreflightSealPacket {
  return isRecord(value) &&
    value.kind === "a2a-broker.complexity-execution-plan-preflight-seal.packet";
}

