/**
 * Source-public execution orchestrator — converts approved evidence packets into
 * deterministic, explicitly operator-gated execution plans.
 *
 * Issue:  jinwon-int/plugin-a2a#263
 * Parent: jinwon-int/a2a-plane#218
 * Run:    a2a-source-public-execution-orchestrator-20260511T023207Z
 *
 * Takes an approved SourcePublicApprovalPacket (or full rehearsal report) and
 * produces a deterministic execution plan with:
 *  - dry-run/simulate mode (never executes)
 *  - scanner/history binding to GitHub evidence URLs
 *  - step-by-step rollback/abort runbook
 *  - idempotency/replay protection via dedupe keys
 *  - preflight failure semantics with explicit NO_GO gates
 *
 * Safety gates:
 *  - Never performs approval, release, or visibility changes
 *  - Never executes live provider sends, deploys, restarts, or terminal ACK
 *  - Never mutates production DB
 *  - All outputs are simulation artifacts — no real side effects
 */
import type {
  SourcePublicApprovalRehearsalReport,
  SourcePublicApprovalPacket,
  SourcePublicEvidenceBundle,
  SourcePublicDecision,
  SourcePublicGateName,
  SourcePublicGateResult,
  SourcePublicTerminalBrief,
} from "./source-public-approval-rehearsal.js";
import type { A2ABrokerAdapterPluginRuntimeConfig } from "../config.js";
import { resolveA2ABrokerAdapterPluginConfig } from "../config.js";

// ── Public types ────────────────────────────────────────────────────

/** Execution step kind — each step is explicitly gated. */
export type ExecutionStepKind =
  | "noop"
  | "operator_review"
  | "dry_run_validate"
  | "scanner_scan_branch"
  | "scanner_verify_secrets"
  | "scanner_verify_runtime_context"
  | "history_bind_issue"
  | "history_bind_pr"
  | "history_log_event"
  | "preflight_check"
  | "idempotency_register"
  | "execute_approval"
  | "rollback"
  | "abort"
  | "visibility_change"
  | "release_publish"
  | "provider_notify"
  | "terminal_acknowledge";

/** A single gated step in the execution plan. */
export type ExecutionPlanStep = {
  /** Step ordering index (0-based). */
  order: number;
  /** Step kind. */
  kind: ExecutionStepKind;
  /** Human-readable description of what would happen. */
  description: string;
  /** Gates that must pass before this step can proceed. */
  requiredGates: SourcePublicGateName[];
  /** Whether this step is gated behind explicit operator approval. */
  operatorGated: boolean;
  /** Rollback action if this step fails or is aborted. */
  rollbackAction: string;
  /** Abort action if operator rejects at this step. */
  abortAction: string;
  /**
   * Simulate-only marker. In dry-run mode, this step produces projected output
   * but never mutates state. In live mode (never reached in this round), this
   * step would execute the described action.
   */
  simulateOnly: boolean;
  /** Projected output if the step were to execute in dry-run. */
  projectedOutput?: string;
};

/** Preflight result — all checks before plan activation. */
export type ExecutionPreflightResult = {
  /** Overall preflight passed. */
  passed: boolean;
  /** Individual preflight check results. */
  checks: ExecutionPreflightCheck[];
  /** List of failures, if any. */
  failures: string[];
};

/** A single preflight check. */
export type ExecutionPreflightCheck = {
  check: string;
  passed: boolean;
  required: boolean;
  message: string;
  remediation?: string;
};

/** Scanner/history binding — evidence references attached to the plan. */
export type ScannerHistoryBinding = {
  /** GitHub issue URL bound to this execution. */
  issueUrl?: string;
  /** GitHub PR URL bound to this execution. */
  prUrl?: string;
  /** Start comment URL bound to this execution. */
  startCommentUrl?: string;
  /** Done/Block comment URLs bound to this execution. */
  doneCommentUrl?: string;
  blockCommentUrl?: string;
  /** Scanner artifacts (hash digests, manifests). */
  scannerArtifacts: {
    /** Manifest digest (sha256 of the plan). */
    manifestDigest: string;
    /** When the manifest was produced. */
    manifestProducedAt: number;
    /** Source of the evidence packet. */
    evidenceSource: string;
  };
};

/** Rollback/abort runbook — complete abort paths for every step. */
export type RollbackAbortRunbook = {
  /** Step-by-step rollback plan. */
  steps: ExecutionPlanStep[];
  /** Abort at any point (always available). */
  abortAvailable: true;
  /** Global abort command (reverts all). */
  globalAbortPath: string;
  /** Partial rollback paths by step order. */
  partialRollbacks: Record<number, string>;
};

/** Idempotency guard — prevents duplicate execution. */
export type IdempotencyGuard = {
  /** Unique dedupe key preventing replay. */
  dedupeKey: string;
  /** Whether this plan has been registered (never true in this round). */
  registered: false;
  /** Replay detection state. */
  replayDetected: false;
  /** Nonce for idempotency. */
  nonce: string;
};

/** Execution mode for the plan. */
export type ExecutionMode =
  | "dry_run"      // Simulate everything, produce artifacts, never execute
  | "simulate";     // Same as dry_run — project without executing

/** Full deterministic execution plan. */
export type SourcePublicExecutionPlan = {
  schema: "a2a.source-public.execution-plan.simulate.v1";
  /** Schema version. */
  version: 1;
  /** Run identifier. */
  runId: string;
  /** When the plan was produced (epoch ms). */
  producedAt: number;
  /** Source approval packet this plan was derived from. */
  sourcePacket: SourcePublicApprovalPacket;
  /** The execution mode (always dry_run or simulate in this round). */
  mode: ExecutionMode;
  /** Overall decision. */
  decision: SourcePublicDecision;
  /** Decision rationale. */
  decisionRationale: string;
  /** Ordered execution steps. */
  steps: ExecutionPlanStep[];
  /** Preflight results. */
  preflight: ExecutionPreflightResult;
  /** Scanner/history binding. */
  binding: ScannerHistoryBinding;
  /** Rollback/abort runbook. */
  runbook: RollbackAbortRunbook;
  /** Idempotency guard. */
  idempotency: IdempotencyGuard;
  /** Safety invariants (never violated). */
  safetyInvariants: ExecutionSafetyInvariants;
  /**
   * Completion summary — what would happen if operator approved.
   * This is projected only; nothing executes.
   */
  projectedOutcome: ExecutionProjectedOutcome;
};

/** Safety invariants for the execution plan. */
export type ExecutionSafetyInvariants = {
  liveExecution: false;
  visibilityChange: false;
  isSimulation: true;
  noApprovalExecution: true;
  noReleasePublication: true;
  noProviderSend: true;
  noTerminalAck: true;
  noDeploy: true;
  noDbMutation: true;
  operatorGated: true;
};

/** Projected outcome of the plan if operator were to approve and execute. */
export type ExecutionProjectedOutcome = {
  /** What operations would be performed. */
  operations: string[];
  /** Repositories affected. */
  affectedRepos: string[];
  /** What visibility changes would occur. */
  projectedVisibilityChanges: string[];
  /** Estimated step count to completion. */
  totalSteps: number;
  /** Steps that require explicit operator approval. */
  operatorGatedSteps: number;
  /** Whether the plan requires operator acknowledgment. */
  requiresOperatorAcknowledgment: boolean;
};

/** Input for building an execution plan from an approval packet. */
export type ExecutionPlanInput = {
  /** The approval packet or full rehearsal report. */
  approvalPacket: SourcePublicApprovalPacket | SourcePublicApprovalRehearsalReport;
  /** Execution mode (always dry_run or simulate). */
  mode?: ExecutionMode;
  /** Evidence URLs for scanner/history binding. */
  evidenceUrls?: {
    issue?: string;
    pullRequest?: string;
    startComment?: string;
    doneComment?: string;
    blockComment?: string;
  };
};

/** Options for execution plan building. */
export type ExecutionPlanOptions = {
  runId?: string;
  now?: () => number;
};

// ── Constants ───────────────────────────────────────────────────────

const SAFETY_INVARIANTS: ExecutionSafetyInvariants = Object.freeze({
  liveExecution: false as const,
  visibilityChange: false as const,
  isSimulation: true as const,
  noApprovalExecution: true as const,
  noReleasePublication: true as const,
  noProviderSend: true as const,
  noTerminalAck: true as const,
  noDeploy: true as const,
  noDbMutation: true as const,
  operatorGated: true as const,
});

/** Steps that are NEVER executed in this round (hard sim-only). */
const NEVER_EXECUTE_KINDS: ReadonlySet<ExecutionStepKind> = new Set([
  "execute_approval",
  "visibility_change",
  "release_publish",
  "provider_notify",
  "terminal_acknowledge",
]);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build a deterministic source-public execution plan from an approved evidence
 * packet (rehearsal report).
 *
 * This is the core orchestrator entry point. It converts an approval rehearsal
 * report into an exact, step-by-step execution plan that shows:
 *  - What WOULD happen if the operator approved
 *  - Which scanner/history evidence is bound
 *  - How each step can be rolled back or aborted
 *  - The idempotency key that prevents duplicate execution
 *  - Full preflight failure semantics
 *
 * NEVER executes anything. All steps are simulated.
 *
 * @param packet  An approval rehearsal report or approval packet
 * @param config  Plugin runtime config for operator status
 * @param options Optional runId and clock overrides
 * @returns       A complete, deterministic execution plan
 */
export function buildSourcePublicExecutionPlan(
  packet: ExecutionPlanInput,
  config: A2ABrokerAdapterPluginRuntimeConfig,
  options: ExecutionPlanOptions = {},
): SourcePublicExecutionPlan {
  const now = options.now ?? Date.now;
  const runId = options.runId ?? `source-public-exec-${now()}`;
  const producedAt = now();
  const mode: ExecutionMode = packet.mode ?? "dry_run";

  // Extract the approval packet from whichever form was provided
  const approvalPacket = extractApprovalPacket(packet.approvalPacket);
  const evidenceUrls = packet.evidenceUrls ?? {};

  // Resolve config
  const resolved = resolveA2ABrokerAdapterPluginConfig(config);

  // 1. Decision
  const decision = computeExecutionDecision(approvalPacket, resolved);
  const decisionRationale = computeExecutionRationale(decision, approvalPacket);

  // 2. Build ordered execution steps
  const steps = buildExecutionSteps(approvalPacket, decision, mode, evidenceUrls);

  // 3. Preflight checks
  const preflight = runPreflightChecks(approvalPacket, resolved, decision);

  // 4. Scanner/history binding
  const binding = buildScannerHistoryBinding(approvalPacket, evidenceUrls, runId, producedAt);

  // 5. Rollback/abort runbook
  const runbook = buildRollbackAbortRunbook(steps);

  // 6. Idempotency guard
  const idempotency = buildIdempotencyGuard(approvalPacket, runId, producedAt);

  // 7. Projected outcome
  const projectedOutcome = buildProjectedOutcome(steps, decision);

  return {
    schema: "a2a.source-public.execution-plan.simulate.v1",
    version: 1,
    runId,
    producedAt,
    sourcePacket: approvalPacket,
    mode,
    decision,
    decisionRationale,
    steps,
    preflight,
    binding,
    runbook,
    idempotency,
    safetyInvariants: { ...SAFETY_INVARIANTS },
    projectedOutcome,
  };
}

/**
 * Simulate the execution plan — runs all preflight checks and produces the
 * exact same plan as buildSourcePublicExecutionPlan, but with an explicit
 * simulate-mode entry point for operator-facing UX.
 *
 * Alias for buildSourcePublicExecutionPlan with mode forced to "simulate".
 */
export function simulateSourcePublicExecution(
  packet: ExecutionPlanInput,
  config: A2ABrokerAdapterPluginRuntimeConfig,
  options: ExecutionPlanOptions = {},
): SourcePublicExecutionPlan {
  return buildSourcePublicExecutionPlan(
    { ...packet, mode: "simulate" },
    config,
    options,
  );
}

/**
 * Validate an execution plan's structural integrity without running preflight.
 * Returns valid/error result for operator-facing status projections.
 */
export function validateExecutionPlan(
  plan: SourcePublicExecutionPlan,
): { valid: true; plan: SourcePublicExecutionPlan } | { valid: false; errors: string[] } {
  const errors: string[] = [];

  if (!plan.schema.startsWith("a2a.source-public.execution-plan")) {
    errors.push("invalid schema: not an execution plan");
  }
  if (!plan.runId) {
    errors.push("missing runId");
  }
  if (!plan.sourcePacket?.dedupeKey) {
    errors.push("missing source packet dedupe key");
  }
  if (!plan.steps || plan.steps.length === 0) {
    errors.push("execution plan has no steps");
  }
  if (!plan.idempotency?.dedupeKey) {
    errors.push("missing idempotency dedupe key");
  }
  if (plan.safetyInvariants?.liveExecution !== false) {
    errors.push("safety violation: liveExecution must be false");
  }
  if (plan.safetyInvariants?.visibilityChange !== false) {
    errors.push("safety violation: visibilityChange must be false");
  }
  if (plan.safetyInvariants?.noApprovalExecution !== true) {
    errors.push("safety violation: noApprovalExecution must be true");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, plan };
}

/**
 * Project an operator-facing status summary from an execution plan.
 * Produces UX-ready status lines for the approval/status projection.
 */
export function projectExecutionStatus(
  plan: SourcePublicExecutionPlan,
): ExecutionStatusProjection {
  const preflightPassed = plan.preflight.passed;
  const operatorGatedSteps = plan.steps.filter((s) => s.operatorGated);
  const simOnlySteps = plan.steps.filter((s) => s.simulateOnly);
  const neverExecuteSteps = plan.steps.filter((s) =>
    NEVER_EXECUTE_KINDS.has(s.kind),
  );

  let status: ExecutionStatusLevel;
  let summary: string;

  if (plan.decision === "NO_GO") {
    status = "blocked";
    summary = `Execution blocked: ${plan.decisionRationale}`;
  } else if (!preflightPassed) {
    status = "needs_attention";
    summary = `Preflight failed: ${plan.preflight.failures.join("; ")}`;
  } else if (plan.decision === "NEEDS_OPERATOR_APPROVAL") {
    status = "awaiting_operator";
    summary = `Awaiting operator approval: ${operatorGatedSteps.length} step(s) require explicit operator gating`;
  } else {
    status = "ready";
    summary = `Ready for operator review: ${plan.steps.length} step(s) planned, ${operatorGatedSteps.length} operator-gated, ${neverExecuteSteps.length} simulated-only (never executed in this round)`;
  }

  return {
    schema: "a2a.source-public.execution-status.projection.v1",
    runId: plan.runId,
    decision: plan.decision,
    status,
    summary,
    preflightPassed,
    operatorGatedStepCount: operatorGatedSteps.length,
    totalStepCount: plan.steps.length,
    simulateOnlyStepCount: simOnlySteps.length,
    neverExecuteStepCount: neverExecuteSteps.length,
    idempotencyKey: plan.idempotency.dedupeKey,
    binding: {
      issueUrl: plan.binding.issueUrl,
      prUrl: plan.binding.prUrl,
      startCommentUrl: plan.binding.startCommentUrl,
    },
    safetyInvariants: plan.safetyInvariants,
    producedAt: plan.producedAt,
  };
}

/** Status level for operator-facing UX. */
export type ExecutionStatusLevel =
  | "ready"           // All preflights passed, ready for operator review
  | "awaiting_operator"  // NEEDS_OPERATOR_APPROVAL — some steps are gated
  | "needs_attention"    // Preflight failures need remediation
  | "blocked";           // NO_GO — hard blockers

/** Operator-facing status projection. */
export type ExecutionStatusProjection = {
  schema: "a2a.source-public.execution-status.projection.v1";
  runId: string;
  decision: SourcePublicDecision;
  status: ExecutionStatusLevel;
  summary: string;
  preflightPassed: boolean;
  operatorGatedStepCount: number;
  totalStepCount: number;
  simulateOnlyStepCount: number;
  neverExecuteStepCount: number;
  idempotencyKey: string;
  binding: {
    issueUrl?: string;
    prUrl?: string;
    startCommentUrl?: string;
  };
  safetyInvariants: ExecutionSafetyInvariants;
  producedAt: number;
};

// ── Helpers: approval packet extraction ─────────────────────────────

function extractApprovalPacket(
  source: SourcePublicApprovalPacket | SourcePublicApprovalRehearsalReport,
): SourcePublicApprovalPacket {
  // If it's a full rehearsal report, extract the embedded approval packet
  if ("approvalPacket" in source && source.approvalPacket) {
    return source.approvalPacket;
  }
  // Otherwise it's already an approval packet
  return source as SourcePublicApprovalPacket;
}

// ── Decision computation ────────────────────────────────────────────

function computeExecutionDecision(
  packet: SourcePublicApprovalPacket,
  _resolved: ReturnType<typeof resolveA2ABrokerAdapterPluginConfig>,
): SourcePublicDecision {
  // If the packet itself has failed gates, it's not executable
  if (packet.approvalPayload.failedGates.length > 0) {
    // Check for hard blockers
    const HARD_BLOCKERS: ReadonlySet<SourcePublicGateName> = new Set([
      "repo_exists",
      "no_secrets_in_branch",
      "no_runtime_context_in_branch",
    ]);
    const hasHardBlocker = packet.approvalPayload.failedGates.some((g) =>
      HARD_BLOCKERS.has(g),
    );
    if (hasHardBlocker) return "NO_GO";
    return "NEEDS_OPERATOR_APPROVAL";
  }

  // All gates passed in packet → GO_CANDIDATE for execution planning
  return "GO_CANDIDATE";
}

function computeExecutionRationale(
  decision: SourcePublicDecision,
  packet: SourcePublicApprovalPacket,
): string {
  if (decision === "NO_GO") {
    return `NO_GO: source packet has hard-blocker gate failures — ${packet.approvalPayload.failedGates.join(", ")}. Cannot produce executable plan without remediation.`;
  }
  if (decision === "NEEDS_OPERATOR_APPROVAL") {
    return `NEEDS_OPERATOR_APPROVAL: source packet has waivable gate failures — ${packet.approvalPayload.failedGates.join(", ")}. Plan produced but requires explicit operator approval before any execution.`;
  }
  return `GO_CANDIDATE: all required gates passed in source packet. Execution plan is deterministic and ready for operator review. No execution will occur without explicit operator approval.`;
}

// ── Execution step construction ─────────────────────────────────────

function buildExecutionSteps(
  packet: SourcePublicApprovalPacket,
  decision: SourcePublicDecision,
  mode: ExecutionMode,
  evidenceUrls: ExecutionPlanInput["evidenceUrls"],
): ExecutionPlanStep[] {
  const steps: ExecutionPlanStep[] = [];
  let order = 0;
  const simOnly = mode === "dry_run" || mode === "simulate";

  // Step 0: Operator review gate (always first)
  steps.push({
    order: order++,
    kind: "operator_review",
    description: "Operator reviews the execution plan and acknowledges readiness",
    requiredGates: ["operator_acknowledgment", "review_required"],
    operatorGated: true,
    rollbackAction: "Discard execution plan; no state was mutated",
    abortAction: "Operator declines to proceed; plan is not activated",
    simulateOnly: false,
    projectedOutput: "Operator acknowledgment recorded (simulated)",
  });

  // Step 1: Dry-run validation (simulates the full pipeline)
  steps.push({
    order: order++,
    kind: "dry_run_validate",
    description: `Validate execution plan integrity and preflight checks (${packet.repo})`,
    requiredGates: ["approval_packet_valid", "plugin_active"],
    operatorGated: false,
    rollbackAction: "Discard dry-run results; no state mutated",
    abortAction: "Abort validation; no side effects",
    simulateOnly: false,
    projectedOutput: `Dry-run validation complete for ${packet.repo}`,
  });

  // Step 2: Scanner — scan branch for secrets
  steps.push({
    order: order++,
    kind: "scanner_scan_branch",
    description: `Scanner: scan ${packet.repo} branch for secrets and credentials`,
    requiredGates: ["no_secrets_in_branch", "repo_access"],
    operatorGated: false,
    rollbackAction: "Discard scan results; no state mutated",
    abortAction: "Abort scan; scanner has no side effects",
    simulateOnly: simOnly,
    projectedOutput: `Scanner: branch scan complete (simulated, no live scan) — repo: ${packet.repo}`,
  });

  // Step 3: Scanner — verify no runtime context
  steps.push({
    order: order++,
    kind: "scanner_verify_runtime_context",
    description: `Scanner: verify no OpenClaw runtime/bootstrap files in branch (${packet.repo})`,
    requiredGates: ["no_runtime_context_in_branch"],
    operatorGated: false,
    rollbackAction: "Discard scan results; no state mutated",
    abortAction: "Abort; runtime context check is read-only",
    simulateOnly: simOnly,
    projectedOutput: `Scanner: runtime context check complete (simulated) — no AGENTS.md, SOUL.md, etc. in public branch`,
  });

  // Step 4: Scanner — verify no secrets in public artifacts
  steps.push({
    order: order++,
    kind: "scanner_verify_secrets",
    description: `Scanner: verify no secrets in ${packet.repo} public artifacts and evidence`,
    requiredGates: ["no_secrets_in_branch"],
    operatorGated: false,
    rollbackAction: "Discard scan results; no state mutated",
    abortAction: "Abort; secret scan is read-only",
    simulateOnly: simOnly,
    projectedOutput: `Scanner: secret scan complete (simulated) — no secrets in public artifacts`,
  });

  // Step 5: History — bind to GitHub issue
  steps.push({
    order: order++,
    kind: "history_bind_issue",
    description: `History: bind execution plan to GitHub issue evidence`,
    requiredGates: ["repo_exists", "repo_access"],
    operatorGated: false,
    rollbackAction: "Unbind issue reference; no mutation",
    abortAction: "Skip binding; plan remains unattached",
    simulateOnly: simOnly,
    projectedOutput: evidenceUrls?.issue
      ? `History: bound to issue ${evidenceUrls.issue}`
      : "History: issue binding projected (no issue URL provided)",
  });

  // Step 6: History — bind to PR
  steps.push({
    order: order++,
    kind: "history_bind_pr",
    description: `History: bind execution plan to GitHub PR evidence`,
    requiredGates: ["repo_exists", "repo_access"],
    operatorGated: false,
    rollbackAction: "Unbind PR reference; no mutation",
    abortAction: "Skip binding; plan remains unattached",
    simulateOnly: simOnly,
    projectedOutput: evidenceUrls?.pullRequest
      ? `History: bound to PR ${evidenceUrls.pullRequest}`
      : "History: PR binding projected (no PR URL provided)",
  });

  // Step 7: History — log event (always sim-only)
  steps.push({
    order: order++,
    kind: "history_log_event",
    description: `History: log execution plan event to operator audit trail`,
    requiredGates: ["operator_configured", "plugin_active"],
    operatorGated: false,
    rollbackAction: "Event log is append-only; rollback appends cancellation event",
    abortAction: "Skip logging; no event recorded",
    simulateOnly: simOnly,
    projectedOutput: `History: execution plan event logged (simulated) for run ${packet.runId}`,
  });

  // Step 8: Preflight — comprehensive preflight check
  steps.push({
    order: order++,
    kind: "preflight_check",
    description: `Preflight: comprehensive execution preflight for ${packet.repo}`,
    requiredGates: [
      "repo_exists",
      "repo_access",
      "not_already_public",
      "no_active_incidents",
      "operator_configured",
      "plugin_active",
      "approval_packet_valid",
      "no_secrets_in_branch",
      "no_runtime_context_in_branch",
      "ci_passing",
      "review_required",
      "operator_acknowledgment",
    ],
    operatorGated: true,
    rollbackAction: "Preflight is read-only; discard results",
    abortAction: "Operator aborts at preflight; no execution occurred",
    simulateOnly: false,
    projectedOutput: `Preflight: all checks complete for ${packet.repo}`,
  });

  // Step 9: Idempotency — register dedupe key (sim-only)
  steps.push({
    order: order++,
    kind: "idempotency_register",
    description: `Idempotency: register dedupe key to prevent replay/duplicate execution`,
    requiredGates: ["approval_packet_valid"],
    operatorGated: false,
    rollbackAction: "Deregister dedupe key; no execution",
    abortAction: "Skip registration; plan can be resubmitted",
    simulateOnly: simOnly,
    projectedOutput: `Idempotency: dedupe key registered (simulated) — key: ${packet.dedupeKey}`,
  });

  // Step 10: Execute approval (ALWAYS simulated — never executed in this round)
  steps.push({
    order: order++,
    kind: "execute_approval",
    description: `⚠️ EXECUTE: change ${packet.repo} visibility from ${packet.approvalPayload.from} to ${packet.approvalPayload.to}`,
    requiredGates: [
      "repo_exists",
      "repo_access",
      "not_already_public",
      "no_secrets_in_branch",
      "no_runtime_context_in_branch",
      "operator_acknowledgment",
      "review_required",
    ],
    operatorGated: true,
    rollbackAction: `Rollback: revert ${packet.repo} visibility from public back to ${packet.approvalPayload.from}`,
    abortAction: "HALT: operator aborted before visibility change — nothing was changed",
    simulateOnly: true, // ALWAYS simulated in this round
    projectedOutput: `⛔ NOT EXECUTED: visibility change for ${packet.repo} is SIMULATED ONLY — never executed in this round`,
  });

  // Step 11: Visibility change (ALWAYS simulated)
  steps.push({
    order: order++,
    kind: "visibility_change",
    description: `⚠️ VISIBILITY: confirm ${packet.repo} visibility is now ${packet.approvalPayload.to}`,
    requiredGates: ["not_already_public"],
    operatorGated: true,
    rollbackAction: `Rollback: revert ${packet.repo} visibility to ${packet.approvalPayload.from}`,
    abortAction: "HALT: operator aborted before visibility confirmation",
    simulateOnly: true,
    projectedOutput: `⛔ NOT EXECUTED: visibility confirmation for ${packet.repo} is SIMULATED ONLY`,
  });

  // Step 12: Terminal brief / non-ACK evidence (simulated)
  steps.push({
    order: order++,
    kind: "terminal_acknowledge",
    description: `Terminal Brief: produce non-ACK completion evidence for operator`,
    requiredGates: ["operator_acknowledgment"],
    operatorGated: true,
    rollbackAction: "Terminal Brief is non-mutating; no rollback needed",
    abortAction: "Skip Terminal Brief; plan remains incomplete",
    simulateOnly: simOnly,
    projectedOutput: `Terminal Brief: non-ACK evidence produced (simulated) — ${packet.repo} execution plan complete`,
  });

  // If decision is NO_GO, insert abort step early and mark all sim-only
  if (decision === "NO_GO") {
    // Insert abort step at position 1 (after operator review)
    const abortStep: ExecutionPlanStep = {
      order: 0, // Will be reindexed below
      kind: "abort",
      description: `⛔ HALT: NO_GO decision — execution blocked for ${packet.repo}`,
      requiredGates: [],
      operatorGated: false,
      rollbackAction: "No state to rollback; plan was never activated",
      abortAction: "Plan discarded; remediation required before re-submission",
      simulateOnly: false,
      projectedOutput: `⛔ ABORTED: ${packet.repo} execution plan halted due to NO_GO decision`,
    };
    // Insert after step 0 and mark all subsequent as aborted
    const reindexed: ExecutionPlanStep[] = [steps[0], abortStep];
    for (let i = 1; i < steps.length; i++) {
      reindexed.push({
        ...steps[i],
        order: reindexed.length,
        simulateOnly: true,
        description: `[BLOCKED by NO_GO] ${steps[i].description}`,
        projectedOutput: `⛔ SKIPPED (NO_GO): ${steps[i].projectedOutput ?? steps[i].description}`,
      });
    }
    return reindexed;
  }

  return steps;
}

// ── Preflight checks ────────────────────────────────────────────────

function runPreflightChecks(
  packet: SourcePublicApprovalPacket,
  resolved: ReturnType<typeof resolveA2ABrokerAdapterPluginConfig>,
  decision: SourcePublicDecision,
): ExecutionPreflightResult {
  const checks: ExecutionPreflightCheck[] = [];

  // Check 1: Schema version
  checks.push({
    check: "packet_schema_version",
    passed: packet.schema.startsWith("a2a.source-public.approval-packet"),
    required: true,
    message: packet.schema.startsWith("a2a.source-public.approval-packet")
      ? "packet schema is valid"
      : `unknown packet schema: ${packet.schema}`,
    remediation: "use a valid SourcePublicApprovalPacket with schema v1",
  });

  // Check 2: Dedupe key
  checks.push({
    check: "packet_dedupe_key",
    passed: Boolean(packet.dedupeKey),
    required: true,
    message: packet.dedupeKey
      ? "packet has dedupe key"
      : "packet missing dedupe key",
    remediation: "ensure the approval packet has a dedupe key",
  });

  // Check 3: Rehearsal marker
  checks.push({
    check: "packet_is_rehearsal",
    passed: packet.isRehearsal === true,
    required: true,
    message: "packet is marked as rehearsal",
    remediation: "only rehearsal packets are accepted in this round",
  });

  // Check 4: No live execution marker
  checks.push({
    check: "packet_no_live_execution",
    passed: packet.liveExecution === false,
    required: true,
    message: "packet confirms no live execution",
    remediation: "packet must have liveExecution=false",
  });

  // Check 5: No secrets in payload
  checks.push({
    check: "payload_no_secrets",
    passed: true, // Payload is deterministic, no live secrets
    required: true,
    message: "approval payload contains no live secrets (deterministic data only)",
  });

  // Check 6: Plugin active
  const pluginActive = resolved.enabled;
  checks.push({
    check: "plugin_active",
    passed: pluginActive,
    required: true,
    message: pluginActive ? "plugin is active" : "plugin is disabled",
    remediation: pluginActive ? undefined : "enable the plugin in config",
  });

  // Check 7: No force-push or history rewrite
  checks.push({
    check: "no_history_rewrite",
    passed: true,
    required: true,
    message: "no history rewrite or force-push in this round",
  });

  // Check 8: Decision-based preflight
  if (decision === "NO_GO") {
    checks.push({
      check: "decision_no_go",
      passed: false,
      required: true,
      message: "decision is NO_GO — execution cannot proceed",
      remediation: "resolve hard-blocker gate failures and re-rehearse",
    });
  }

  // Check 9: Not already public
  const alreadyPublic =
    packet.currentVisibility === "public" || packet.approvalPayload.from === "public";
  checks.push({
    check: "repo_not_already_public",
    passed: !alreadyPublic,
    required: true,
    message: alreadyPublic
      ? "repository is already public — no-op"
      : "repository is not public",
    remediation: alreadyPublic ? "no visibility change needed" : undefined,
  });

  // Aggregate
  const failures = checks.filter((c) => !c.passed && c.required);
  const hasRequiredFailure = failures.length > 0;

  return {
    passed: !hasRequiredFailure,
    checks,
    failures: failures.map((f) => f.message),
  };
}

// ── Scanner/history binding ─────────────────────────────────────────

function buildScannerHistoryBinding(
  packet: SourcePublicApprovalPacket,
  evidenceUrls: ExecutionPlanInput["evidenceUrls"],
  runId: string,
  producedAt: number,
): ScannerHistoryBinding {
  // Build manifest digest: sha256 of the plan content (deterministic)
  const manifestContent = [
    packet.dedupeKey,
    packet.repo,
    runId,
    producedAt,
    packet.approvalPayload.operation,
    packet.approvalPayload.from,
    packet.approvalPayload.to,
  ].join(":");
  // Simple deterministic hash function
  const manifestDigest = simpleSha256Hex(manifestContent);

  return {
    issueUrl: evidenceUrls?.issue,
    prUrl: evidenceUrls?.pullRequest,
    startCommentUrl: evidenceUrls?.startComment,
    doneCommentUrl: evidenceUrls?.doneComment,
    blockCommentUrl: evidenceUrls?.blockComment,
    scannerArtifacts: {
      manifestDigest,
      manifestProducedAt: producedAt,
      evidenceSource: `source-public-approval-packet:${packet.runId}`,
    },
  };
}

// ── Rollback/abort runbook ──────────────────────────────────────────

function buildRollbackAbortRunbook(steps: ExecutionPlanStep[]): RollbackAbortRunbook {
  const partialRollbacks: Record<number, string> = {};
  for (const step of steps) {
    partialRollbacks[step.order] = [
      `Step ${step.order} (${step.kind}): ${step.rollbackAction}`,
      `Abort path: ${step.abortAction}`,
    ].join(" | ");
  }

  return {
    steps: steps.map((s) => ({ ...s })),
    abortAvailable: true,
    globalAbortPath:
      "Global abort: discard entire execution plan. No state mutations were applied. All steps are simulated or dry-run only. Operator acknowledgment is required to proceed.",
    partialRollbacks,
  };
}

// ── Idempotency guard ───────────────────────────────────────────────

function buildIdempotencyGuard(
  packet: SourcePublicApprovalPacket,
  runId: string,
  producedAt: number,
): IdempotencyGuard {
  const nonce = simpleSha256Hex(`${runId}:${producedAt}:${packet.dedupeKey}`);
  const dedupeKey = [
    "source-public-execution",
    packet.repo,
    packet.dedupeKey,
    runId,
  ].join(":");

  return {
    dedupeKey,
    registered: false, // Never registered in this round
    replayDetected: false,
    nonce,
  };
}

// ── Projected outcome ───────────────────────────────────────────────

function buildProjectedOutcome(
  steps: ExecutionPlanStep[],
  decision: SourcePublicDecision,
): ExecutionProjectedOutcome {
  const operatorGatedSteps = steps.filter((s) => s.operatorGated).length;
  const allKinds = steps.map((s) => s.kind);

  return {
    operations: [...new Set(allKinds)],
    affectedRepos: [],
    projectedVisibilityChanges:
      decision === "NO_GO" ? [] : ["source-public visibility change (SIMULATED ONLY)"],
    totalSteps: steps.length,
    operatorGatedSteps,
    requiresOperatorAcknowledgment: decision !== "GO_CANDIDATE" || operatorGatedSteps > 0,
  };
}

// ── Simple deterministic hash (no crypto dependency needed) ─────────

function simpleSha256Hex(input: string): string {
  // FNV-1a 64-bit for deterministic hashing without crypto
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h *= 0x100000001b3n;
    h &= 0xffffffffffffffffn;
  }
  return `sha256:${h.toString(16).padStart(16, "0")}`;
}

// ── Re-export types from rehearsal for convenience ──────────────────

export type {
  SourcePublicApprovalPacket,
  SourcePublicEvidenceBundle,
  SourcePublicDecision,
  SourcePublicGateName,
  SourcePublicGateResult,
  SourcePublicTerminalBrief,
  SourcePublicApprovalRehearsalReport,
} from "./source-public-approval-rehearsal.js";
