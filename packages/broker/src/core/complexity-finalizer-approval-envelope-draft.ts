// ── Finalizer approval envelope draft (source-only, no-live) ─────────────
//
// Consumes a ComplexityOrchestrationRecommendationPacket (#971) and produces
// a deterministic approval-request envelope draft that separates the
// recommendation from the approval request phase and from actual approval
// grant. The envelope classifies each orchestration action into one of four
// approval categories:
//
//   direct_execution    → approval_not_required  (no operator involvement)
//   sequential_subagent → operator_approval_required
//   parallel_subagents  → operator_approval_required
//   operator_review     → operator_review_required (MUST NOT become approved
//                                                    autonomous execution)
//
// Safety boundaries (all statically enforced):
//   - No broker/Gateway/worker service access
//   - No DB mutation or live provider send
//   - No subagent spawn or executor invocation
//   - No terminal ACK/replay or release operation
//   - No secret or credential exposure
//   - No grant of approval — envelope draft only
//   - operator_review NEVER maps to an approved-autonomous envelope
//
// Reference: #978 Team2 — finalizer approval envelope draft from complexity
//            recommendation packet.
// Parent:    #971  Team2 — complexity orchestration recommendation packet.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import type { ComplexityOrchestrationRecommendationPacket } from "./complexity-orchestration-recommendation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Approval envelope category derived from the orchestration recommendation.
 *
 * - `approval_not_required`: safe to proceed without operator involvement.
 * - `operator_notify`: retained for backward-compatible display only; this
 *   draft never uses it to grant autonomous approval.
 * - `operator_approval_required`: explicit operator approval is required
 *   before any execution.
 * - `operator_review_required`: operator MUST review and approval CANNOT
 *   be granted autonomously. This envelope NEVER becomes "approved" by
 *   any autonomous mechanism.
 */
export type FinalizerApprovalEnvelopeCategory =
  | "approval_not_required"
  | "operator_notify"
  | "operator_approval_required"
  | "operator_review_required";

/**
 * Overall decision for the approval envelope draft.
 */
export type FinalizerApprovalEnvelopeDraftDecision =
  | "envelope_draft_ready"
  | "no_approval_needed"
  | "envelope_safety_blocked";

/**
 * A single approval-request item within the envelope.
 */
export interface FinalizerApprovalEnvelopeRequestedItem {
  /** The orchestration action being requested. */
  orchestrationAction: string;
  /** Complexity level. */
  complexity: string;
  /** Whether operator approval is required. */
  operatorApprovalRequired: boolean;
  /** Whether operator review blocks autonomous execution. */
  autonomousExecutionBlocked: true | false;
  /** Whether a later, separate approval grant could permit a subagent. */
  subagentPermitted: boolean;
  /** Human-readable reason for this envelope decision. */
  reason: string;
}

/**
 * Deterministic finalizer approval envelope draft.
 *
 * This packet is an *approval request draft* — it does NOT grant approval,
   does NOT dispatch anything, and does NOT mutate state. Its sole purpose is
   to separate the complexity recommendation (#971) from the concrete approval
   request, keeping the approval grant in a future action path.
 */
export interface FinalizerApprovalEnvelopeDraftPacket {
  kind: "a2a-broker.finalizer-approval-envelope-draft.packet";
  version: 1;
  generatedAt: string;
  /**
   * Idempotency key derived from the recommendation idempotency key and
   * the derived envelope category — deterministic for identical inputs.
   */
  idempotencyKey: string;
  /** The recommendation idempotency key this envelope was derived from. */
  sourceRecommendationIdempotencyKey: string;
  /** The recommendation action this envelope covers. */
  sourceOrchestrationAction: string;
  /** Envelope category. */
  envelopeCategory: FinalizerApprovalEnvelopeCategory;
  /** Overall draft decision. */
  decision: FinalizerApprovalEnvelopeDraftDecision;
  /**
   * Approval mode:
   * - "autonomous": no operator approval needed
   * - "operator_notify": operator awareness only; not an approval grant
   * - "operator_approval_gated": operator approval required before execution
   * - "operator_review_gated": operator review required; approval cannot
   *     become autonomous
   */
  approvalMode: string;
  /** Whether this draft can be consumed without a separate approval grant. */
  autonomousApprovalPossible: boolean;
  /** Whether this draft itself permits subagent spawn. Always false. */
  subagentSpawnPermitted: boolean;
  /** Whether this envelope permits direct execution. */
  directExecutionPermitted: boolean;
  /** Whether this envelope permits live deployment. */
  liveDeploymentPermitted: boolean;
  /**
   * Detailed items describing what is being requested. Each item carries
   * its own reason and blocks so consumers can display per-action status.
   */
  requestedItems: FinalizerApprovalEnvelopeRequestedItem[];
  /** The original recommendation action. */
  action: string;
  /** Recommended parallelism hint from source. */
  parallelismHint: number;
  /** Safety gate description carried through from the recommendation. */
  safetyGate: string;
  /** Blocker list — non-empty only when decision is "envelope_safety_blocked". */
  blockers: string[];
  /** Next actions for the consumer of this envelope. */
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
  };
  /** Static safety semantics. */
  semantics: {
    envelopeDraftOnly: true;
    approvalNotGranted: true;
    autonomousExecutionBlockedForOperatorReview: boolean;
    sourceOnlyNoLive: true;
    recommendationSeparated: true;
    approvalRequestDraftSeparated: true;
    approvalGrantSeparated: true;
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
// Static mapping table: orchestration action → approval envelope category
// ---------------------------------------------------------------------------

const ACTION_TO_ENVELOPE: Record<string, FinalizerApprovalEnvelopeCategory> = {
  direct_execution: "approval_not_required",
  sequential_subagent: "operator_approval_required",
  parallel_subagents: "operator_approval_required",
  operator_review: "operator_review_required",
};

// ---------------------------------------------------------------------------
// Envelope category properties
// ---------------------------------------------------------------------------

interface EnvelopeProperties {
  approvalMode: string;
  autonomousApprovalPossible: boolean;
  subagentSpawnPermitted: boolean;
  directExecutionPermitted: boolean;
  liveDeploymentPermitted: boolean;
  operatorApprovalRequired: boolean;
  autonomousExecutionBlocked: boolean;
  subagentPermitted: boolean;
}

const ENVELOPE_PROPERTIES: Record<FinalizerApprovalEnvelopeCategory, EnvelopeProperties> = {
  approval_not_required: {
    approvalMode: "autonomous",
    autonomousApprovalPossible: true,
    subagentSpawnPermitted: false,
    directExecutionPermitted: true,
    liveDeploymentPermitted: false,
    operatorApprovalRequired: false,
    autonomousExecutionBlocked: false,
    subagentPermitted: false,
  },
  operator_notify: {
    approvalMode: "operator_notify",
    autonomousApprovalPossible: false,
    subagentSpawnPermitted: false,
    directExecutionPermitted: false,
    liveDeploymentPermitted: false,
    operatorApprovalRequired: false,
    autonomousExecutionBlocked: false,
    subagentPermitted: true,
  },
  operator_approval_required: {
    approvalMode: "operator_approval_gated",
    autonomousApprovalPossible: false,
    subagentSpawnPermitted: false,
    directExecutionPermitted: false,
    liveDeploymentPermitted: false,
    operatorApprovalRequired: true,
    autonomousExecutionBlocked: false,
    subagentPermitted: true,
  },
  operator_review_required: {
    approvalMode: "operator_review_gated",
    autonomousApprovalPossible: false,
    subagentSpawnPermitted: false,
    directExecutionPermitted: false,
    liveDeploymentPermitted: false,
    operatorApprovalRequired: true,
    autonomousExecutionBlocked: true,
    subagentPermitted: false,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a deterministic finalizer approval envelope draft from a complexity
 * orchestration recommendation packet (#971).
 *
 * The envelope maps the recommendation's action to an approval category that
 * separates recommendation (#971) from approval request draft (this module)
 * from actual approval grant (future module).
 *
 * CRITICAL SAFETY INVARIANT:
 *   - `operator_review` (critical complexity) ALWAYS produces an
 *     `operator_review_required` envelope where `autonomousApprovalPossible`
 *     is false and `autonomousExecutionBlockedForOperatorReview` is true.
 *   - No envelope grants approval. All boundaries enforce source-only/no-live.
 *
 * @param recommendation  A ComplexityOrchestrationRecommendationPacket (#971).
 * @param options         Optional overrides (generatedAt timestamp).
 */
export function buildFinalizerApprovalEnvelopeDraft(
  recommendation: ComplexityOrchestrationRecommendationPacket,
  options: { now?: string } = {},
): FinalizerApprovalEnvelopeDraftPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const action = recommendation.recommendation.action;
  const complexity = recommendation.recommendation.complexity;

  // Derive envelope category from action — this is the core mapping.
  const envelopeCategory = ACTION_TO_ENVELOPE[action] ?? "operator_review_required";

  // Safety: operator_review / critical MUST NOT become approved autonomous.
  // If we somehow got an operator_review action mapped to anything other
  // than operator_review_required, fail closed.
  const isOperatorReview = action === "operator_review" || complexity === "critical";
  const safetyBlocked =
    isOperatorReview && envelopeCategory !== "operator_review_required";

  // Build the envelope properties.
  const props = ENVELOPE_PROPERTIES[envelopeCategory];

  // Deterministic idempotency key.
  const idempotencyKey = buildEnvelopeIdempotencyKey(recommendation, envelopeCategory, safetyBlocked);

  // Blockers: none unless safety blocked.
  const blockers: string[] = [];
  if (safetyBlocked) {
    blockers.push(
      `SAFETY BLOCK: operator_review action mapped to unexpected envelope "${envelopeCategory}". ` +
      "operator_review MUST always produce operator_review_required. " +
      "This indicates a logic error in the envelope draft module.",
    );
  }

  // Decision.
  const decision: FinalizerApprovalEnvelopeDraftDecision =
    safetyBlocked ? "envelope_safety_blocked"
    : (envelopeCategory === "approval_not_required" ? "no_approval_needed"
       : "envelope_draft_ready");

  // Build requested items.
  const requestedItems = buildRequestedItems(recommendation, envelopeCategory, props);

  // Next actions.
  const nextActions = buildNextActions(decision, envelopeCategory, action);

  return {
    kind: "a2a-broker.finalizer-approval-envelope-draft.packet",
    version: 1,
    generatedAt,
    idempotencyKey,
    sourceRecommendationIdempotencyKey: recommendation.idempotencyKey,
    sourceOrchestrationAction: action,
    envelopeCategory,
    decision,
    approvalMode: props.approvalMode,
    autonomousApprovalPossible: props.autonomousApprovalPossible,
    subagentSpawnPermitted: props.subagentSpawnPermitted,
    directExecutionPermitted: props.directExecutionPermitted,
    liveDeploymentPermitted: props.liveDeploymentPermitted,
    requestedItems,
    action,
    parallelismHint: recommendation.recommendation.parallelismHint,
    safetyGate: recommendation.recommendation.safetyGate,
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
    },
    semantics: {
      envelopeDraftOnly: true,
      approvalNotGranted: true,
      autonomousExecutionBlockedForOperatorReview:
        envelopeCategory === "operator_review_required",
      sourceOnlyNoLive: true,
      recommendationSeparated: true,
      approvalRequestDraftSeparated: true,
      approvalGrantSeparated: true,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the requested items array from the recommendation.
 * Each item represents one role or action being requested for approval.
 */
function buildRequestedItems(
  recommendation: ComplexityOrchestrationRecommendationPacket,
  envelopeCategory: FinalizerApprovalEnvelopeCategory,
  props: EnvelopeProperties,
): FinalizerApprovalEnvelopeRequestedItem[] {
  const roleItems: FinalizerApprovalEnvelopeRequestedItem[] = [];
  const roles = recommendation.recommendation.recommendedRoles;

  if (roles.length === 0) {
    // No subagent roles — either direct execution or operator review.
    const reason = envelopeCategory === "operator_review_required"
      ? "Operator review required for critical complexity. No autonomous subagents permitted."
      : "No subagent roles needed. Direct execution is safe.";
    roleItems.push({
      orchestrationAction: recommendation.recommendation.action,
      complexity: recommendation.recommendation.complexity,
      operatorApprovalRequired: props.operatorApprovalRequired,
      autonomousExecutionBlocked:
        envelopeCategory === "operator_review_required" ? true : false,
      subagentPermitted: props.subagentPermitted,
      reason,
    });
  } else {
    for (const role of roles) {
      roleItems.push({
        orchestrationAction: recommendation.recommendation.action,
        complexity: recommendation.recommendation.complexity,
        operatorApprovalRequired: props.operatorApprovalRequired,
        autonomousExecutionBlocked:
          envelopeCategory === "operator_review_required" ? true : false,
        subagentPermitted: true,
        reason: `Role "${role.role}": ${role.purpose}`,
      });
    }
  }

  return roleItems;
}

/**
 * Build next actions based on the envelope decision and category.
 */
function buildNextActions(
  decision: FinalizerApprovalEnvelopeDraftDecision,
  envelopeCategory: FinalizerApprovalEnvelopeCategory,
  action: string,
): string[] {
  if (decision === "envelope_safety_blocked") {
    return [
      `Safety block detected for action "${action}". The orchestration recommendation ` +
      "maps to operator_review but the envelope category is not operator_review_required. " +
      "This is a logic error. Do NOT proceed.",
      "Inspect the ACTION_TO_ENVELOPE mapping and ENVELOPE_PROPERTIES for operator_review.",
    ];
  }

  if (decision === "no_approval_needed") {
    return [
      `Action "${action}" does not require operator approval. Direct execution is safe.`,
      "Consume this envelope as evidence that no approval gate is needed.",
      "Do NOT use this envelope to bypass safety gates on other actions.",
    ];
  }

  // decision === "envelope_draft_ready"
  if (envelopeCategory === "operator_notify") {
    return [
      `Action "${action}" requires operator notification before proceeding.`,
      "Route this envelope to an operator notification channel (source-only, no-live).",
      "Do NOT interpret operator notification as approval grant.",
    ];
  }

  if (envelopeCategory === "operator_approval_required") {
    return [
      `Action "${action}" requires explicit operator approval before any execution.`,
      `Recommended parallelism: ${/* will be filled from recommendation */""}.`,
      "Route this envelope through a separate approval grant path.",
      "Do NOT use this envelope to autonomously spawn subagents or execute actions.",
    ];
  }

  // operator_review_required
  return [
    `Action "${action}" (critical) requires operator review. Autonomous execution is BLOCKED.`,
    "Route this envelope to the operator review channel. No subagent spawn, no execution.",
    "Operator review must complete and explicitly grant approval before any action.",
    "This envelope does NOT and CANNOT grant approval autonomously.",
  ];
}

/**
 * Build a deterministic idempotency key from the recommendation and
 * the derived envelope category.
 */
function buildEnvelopeIdempotencyKey(
  recommendation: ComplexityOrchestrationRecommendationPacket,
  envelopeCategory: FinalizerApprovalEnvelopeCategory,
  safetyBlocked: boolean,
): string {
  const seed = stableStringify({
    label: "finalizer-approval-envelope-draft",
    sourceIdempotencyKey: recommendation.idempotencyKey,
    envelopeCategory,
    safetyBlocked,
    action: recommendation.recommendation.action,
    complexity: recommendation.recommendation.complexity,
  });
  return "complexity-finalizer-approval-envelope:" +
    createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Render a finalizer approval envelope draft packet to human-readable
 * markdown. Pure function — no IO, no side effects.
 */
export function renderFinalizerApprovalEnvelopeDraftMarkdown(
  packet: FinalizerApprovalEnvelopeDraftPacket,
): string {
  return [
    titleForEnvelope(packet),
    `- **generatedAt**: ${packet.generatedAt}`,
    `- **idempotencyKey**: ${packet.idempotencyKey}`,
    `- **sourceRecommendationIdempotencyKey**: ${packet.sourceRecommendationIdempotencyKey}`,
    `- **envelopeCategory**: ${packet.envelopeCategory}`,
    `- **decision**: ${packet.decision}`,
    `- **approvalMode**: ${packet.approvalMode}`,
    `- **action**: ${packet.action}`,
    `- **parallelismHint**: ${packet.parallelismHint}`,
    `- **complexity**: ${packet.requestedItems[0]?.complexity ?? "unknown"}`,
    "",
    "## Envelope properties",
    "",
    `- **autonomousApprovalPossible**: ${packet.autonomousApprovalPossible}`,
    `- **subagentSpawnPermitted**: ${packet.subagentSpawnPermitted}`,
    `- **directExecutionPermitted**: ${packet.directExecutionPermitted}`,
    `- **liveDeploymentPermitted**: ${packet.liveDeploymentPermitted}`,
    "",
    "## Safety gate",
    "",
    packet.safetyGate,
    "",
    "## Requested items",
    "",
    ...(packet.requestedItems.length === 0
      ? ["*(none)*"]
      : packet.requestedItems.map((item) => {
          const lines = [
            `- **orchestrationAction**: ${item.orchestrationAction}`,
            `  - **complexity**: ${item.complexity}`,
            `  - **operatorApprovalRequired**: ${item.operatorApprovalRequired}`,
            `  - **autonomousExecutionBlocked**: ${item.autonomousExecutionBlocked}`,
            `  - **subagentPermitted**: ${item.subagentPermitted}`,
            `  - **reason**: ${item.reason}`,
          ];
          return lines.join("\n");
        })),
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
    "No envelope action grants approval, dispatches execution, mutates DB, " +
    "deploys/restarts services, moves secrets, sends provider messages, " +
    "or performs ACK/replay. This is a draft-only approval request envelope.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * Extract a ComplexityOrchestrationRecommendationPacket from an envelope.
 * Accepts the packet itself or an object containing it under a known key.
 */
export function extractOrchestrationRecommendationFromEnvelope(
  input: unknown,
): ComplexityOrchestrationRecommendationPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.recommendation,
    envelope.recommendationPacket,
    envelope.complexityOrchestrationRecommendation,
    envelope.orchestrationRecommendation,
    envelope.packet,
  ];
  const packet = candidates.find(isComplexityOrchestrationRecommendationPacket);
  if (!packet) {
    throw new Error(
      "expected a ComplexityOrchestrationRecommendationPacket (#971) inside the envelope",
    );
  }
  return packet;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function titleForEnvelope(packet: FinalizerApprovalEnvelopeDraftPacket): string {
  if (packet.decision === "envelope_safety_blocked") {
    return `# SAFETY BLOCKED: Finalizer approval envelope for ${packet.action}`;
  }
  if (packet.decision === "no_approval_needed") {
    return `# No approval needed: Finalizer approval envelope for ${packet.action}`;
  }
  return `# Approval request draft: Finalizer approval envelope for ${packet.action}`;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isComplexityOrchestrationRecommendationPacket(
  value: unknown,
): value is ComplexityOrchestrationRecommendationPacket {
  return (
    isRecord(value) &&
    value.kind === "a2a-broker.complexity-orchestration-recommendation-packet"
  );
}
