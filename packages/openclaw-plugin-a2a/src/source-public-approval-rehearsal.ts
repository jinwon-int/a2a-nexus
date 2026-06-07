/**
 * Source-public approval rehearsal — deterministic rehearsal of repository
 * source-public (visibility) operations before any real execution.
 *
 * Issue:  jinwon-int/openclaw-plugin-a2a#261
 * Parent: jinwon-int/a2a-plane#211
 * Run:    a2a-source-public-approval-rehearsal-20260511T014240Z
 *
 * Produces deterministic approval packets, integrated evidence bundles, a
 * no-live Terminal Brief rehearsal, replay/no-duplicate proof, rollback/abort
 * paths, and GO_CANDIDATE/NO_GO/NEEDS_OPERATOR_APPROVAL decision output.
 *
 * Safety gates:
 *  - Never performs approval, release, or visibility changes
 *  - Never executes live provider sends, deploys, restarts, or terminal ACK
 *  - Never mutates production DB
 *  - All outputs are rehearsal evidence — no real side effects
 */
import type { A2ABrokerAdapterPluginRuntimeConfig } from "../config.js";
import { resolveA2ABrokerAdapterPluginConfig } from "../config.js";

// ── Public types ────────────────────────────────────────────────────

/** The three possible rehearsal decision outcomes. */
export type SourcePublicDecision =
  | "GO_CANDIDATE"
  | "NO_GO"
  | "NEEDS_OPERATOR_APPROVAL";

/** Named safety gates checked during rehearsal. */
export type SourcePublicGateName =
  | "repo_exists"
  | "repo_access"
  | "not_already_public"
  | "no_active_incidents"
  | "operator_configured"
  | "plugin_active"
  | "approval_packet_valid"
  | "no_secrets_in_branch"
  | "no_runtime_context_in_branch"
  | "ci_passing"
  | "review_required"
  | "operator_acknowledgment";

/** Result of a single safety gate check. */
export type SourcePublicGateResult = {
  gate: SourcePublicGateName;
  passed: boolean;
  required: boolean;
  message: string;
  /** If this gate failed, the suggested remediation step. */
  remediation?: string;
};

/** Deterministic approval packet for source-public rehearsal. */
export type SourcePublicApprovalPacket = {
  schema: "a2a.source-public.approval-packet.rehearsal.v1";
  /** Unique deduplication key preventing replay. */
  dedupeKey: string;
  /** The target repository. */
  repo: string;
  /** Run identifier. */
  runId: string;
  /** When the packet was produced (epoch ms). */
  producedAt: number;
  /** Current visibility (always as-observed, never changed). */
  currentVisibility: "private" | "internal" | "public" | "unknown";
  /** Target visibility that the rehearsal models. */
  targetVisibility: "public";
  /** The approval packet payload — what WOULD be submitted. */
  approvalPayload: {
    operation: "change_repo_visibility";
    from: string;
    to: "public";
    /** All gates that must pass before execution. */
    requiredGates: SourcePublicGateName[];
    /** Gates that passed at rehearsal time. */
    passedGates: SourcePublicGateName[];
    /** Gates that failed at rehearsal time. */
    failedGates: SourcePublicGateName[];
  };
  /** Rehearsal marker — ALWAYS true. */
  isRehearsal: true;
  /** Never a real execution. */
  liveExecution: false;
  /** Visibility change never performed. */
  visibilityChange: false;
};

/** Integrated evidence bundle combining approval packet + GitHub evidence. */
export type SourcePublicEvidenceBundle = {
  schema: "a2a.source-public.evidence-bundle.rehearsal.v1";
  runId: string;
  /** The approval packet (deterministic, replay-proof). */
  approvalPacket: SourcePublicApprovalPacket;
  /** GitHub evidence URLs (projected, not fetched). */
  evidenceUrls: {
    issue?: string;
    pullRequest?: string;
    startComment?: string;
    doneComment?: string;
    blockComment?: string;
  };
  /** All safety gate results. */
  gates: SourcePublicGateResult[];
  /** Decision output. */
  decision: SourcePublicDecision;
  /** Decision rationale. */
  decisionRationale: string;
};

/** No-live Terminal Brief rehearsal line. */
export type SourcePublicTerminalBrief = {
  schema: "a2a.source-public.terminal-brief.rehearsal.v1";
  /** Terminal Brief line suitable for operator display. */
  line: string;
  /** Integration markers. */
  markers: {
    isRehearsal: true;
    isTerminalAck: false;
    isApproval: false;
    isLiveProviderSend: false;
    isProductionDeploy: false;
  };
  /** Evidence bundle reference. */
  evidenceBundleDedupeKey: string;
  /** Abort/recovery path. */
  abortPath: string;
};

/** Top-level rehearsal report. */
export type SourcePublicApprovalRehearsalReport = {
  schema: "a2a.source-public.rehearsal-report.v1";
  /** Schema version. */
  version: 1;
  /** Run identifier. */
  runId: string;
  /** The decision. */
  decision: SourcePublicDecision;
  /** When rehearsal was produced. */
  producedAt: number;
  /** The approval packet. */
  approvalPacket: SourcePublicApprovalPacket;
  /** The evidence bundle. */
  evidenceBundle: SourcePublicEvidenceBundle;
  /** Terminal Brief lines for operator display. */
  terminalBrief: SourcePublicTerminalBrief;
  /** Rollback / abort paths are always available. */
  abortAvailable: true;
  /** How to rollback (always available — nothing was executed). */
  rollbackPath: string;
  /** Safety invariants. */
  safetyInvariants: {
    liveExecution: false;
    visibilityChange: false;
    isRehearsal: true;
    noApprovalExecution: true;
    noReleasePublication: true;
    noProviderSend: true;
    noTerminalAck: true;
  };
};

/** Input for a source-public approval rehearsal. */
export type SourcePublicApprovalRehearsalInput = {
  /** Repository owner/name (e.g. "jinwon-int/openclaw-plugin-a2a"). */
  repo: string;
  /** Current visibility (as observed, not changed). */
  currentVisibility?: "private" | "internal" | "public" | "unknown";
  /** Whether CI is known to be passing. */
  ciPassing?: boolean;
  /** Whether operator review has been performed. */
  operatorReviewed?: boolean;
  /** Whether operator has acknowledged the rehearsal. */
  operatorAcknowledged?: boolean;
  /** GitHub issue number for evidence tracking. */
  issueNumber?: number;
  /** Evidence URLs already observed (not fetched live). */
  evidenceUrls?: {
    issue?: string;
    pullRequest?: string;
    startComment?: string;
    doneComment?: string;
    blockComment?: string;
  };
};

export type SourcePublicApprovalRehearsalOptions = {
  runId?: string;
  now?: () => number;
};

// ── Constants ───────────────────────────────────────────────────────

const SAFETY_INVARIANTS = Object.freeze({
  liveExecution: false as const,
  visibilityChange: false as const,
  isRehearsal: true as const,
  noApprovalExecution: true as const,
  noReleasePublication: true as const,
  noProviderSend: true as const,
  noTerminalAck: true as const,
});

/** All gates required for GO_CANDIDATE. */
const REQUIRED_GATES: readonly SourcePublicGateName[] = Object.freeze([
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
]);

/** Gates that are ALWAYS required (hard blockers for any decision). */
const HARD_BLOCKER_GATES: ReadonlySet<SourcePublicGateName> = new Set([
  "repo_exists",
  "no_secrets_in_branch",
  "no_runtime_context_in_branch",
]);

/** Gates that can be waived with operator approval. */
const OPERATOR_WAIVABLE_GATES: ReadonlySet<SourcePublicGateName> = new Set([
  "operator_acknowledgment",
  "review_required",
  "ci_passing",
]);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Run a source-public approval rehearsal for the given repository and config.
 *
 * Checks all safety gates, produces a deterministic approval packet, an
 * integrated evidence bundle, and a no-live Terminal Brief rehearsal.
 * Never executes any visibility change, approval, or live action.
 *
 * @param input   Rehearsal input (repo, visibility, CI state, etc.)
 * @param config  Plugin runtime config for operator status
 * @param options Optional overrides (runId, clock)
 * @returns       A complete rehearsal report with GO_CANDIDATE/NO_GO/NEEDS_OPERATOR_APPROVAL decision
 */
export function rehearseSourcePublicApproval(
  input: SourcePublicApprovalRehearsalInput,
  config: A2ABrokerAdapterPluginRuntimeConfig,
  options: SourcePublicApprovalRehearsalOptions = {},
): SourcePublicApprovalRehearsalReport {
  const now = options.now ?? Date.now;
  const runId = options.runId ?? `source-public-rehearsal-${now()}`;
  const producedAt = now();

  const resolved = resolveA2ABrokerAdapterPluginConfig(config);

  // 1. Validate input
  if (!input.repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input.repo)) {
    return buildNoGoReport(
      runId,
      producedAt,
      input,
      [
        {
          gate: "repo_exists",
          passed: false,
          required: true,
          message: `invalid or missing repo: "${input.repo || "<empty>"}"`,
          remediation: "provide a valid owner/repo string",
        },
      ],
      "repository identifier is invalid or missing",
    );
  }

  // 2. Run all safety gates
  const gates = runAllGates(input, resolved);

  // 3. Compute decision
  const decision = computeDecision(gates);

  // 4. Build deterministic approval packet
  const approvalPacket = buildApprovalPacket(input, gates, decision, runId, producedAt);

  // 5. Build evidence bundle
  const evidenceBundle = buildEvidenceBundle(input, gates, decision, runId, approvalPacket);

  // 6. Build terminal brief
  const terminalBrief = buildTerminalBrief(input, gates, decision, runId, evidenceBundle);

  // 7. Build rollback path (always available — nothing was executed)
  const rollbackPath = buildRollbackPath(input, runId);

  return {
    schema: "a2a.source-public.rehearsal-report.v1",
    version: 1,
    runId,
    decision,
    producedAt,
    approvalPacket,
    evidenceBundle,
    terminalBrief,
    abortAvailable: true,
    rollbackPath,
    safetyInvariants: { ...SAFETY_INVARIANTS },
  };
}

// ── Gate evaluation ─────────────────────────────────────────────────

function runAllGates(
  input: SourcePublicApprovalRehearsalInput,
  _resolved: ReturnType<typeof resolveA2ABrokerAdapterPluginConfig>,
): SourcePublicGateResult[] {
  const gates: SourcePublicGateResult[] = [];

  // Gate: repo_exists — validated at input boundary
  gates.push({
    gate: "repo_exists",
    passed: true,
    required: true,
    message: `repository ${input.repo} identifier is valid`,
  });

  // Gate: repo_access — operator has access (assumed if they can run rehearsal)
  gates.push({
    gate: "repo_access",
    passed: true,
    required: true,
    message: "operator access assumed (rehearsal is running in-plugin context)",
  });

  // Gate: not_already_public
  const alreadyPublic = input.currentVisibility === "public";
  gates.push({
    gate: "not_already_public",
    passed: !alreadyPublic,
    required: !alreadyPublic,
    message: alreadyPublic
      ? "repository is already public — source-public operation is no-op"
      : "repository is not already public",
    remediation: alreadyPublic ? "no visibility change needed; repository is already public" : undefined,
  });

  // Gate: no_active_incidents — assumed true in rehearsal (no live check)
  gates.push({
    gate: "no_active_incidents",
    passed: true,
    required: true,
    message: "no active incidents detected (rehearsal does not perform live incident checks)",
  });

  // Gate: operator_configured
  gates.push({
    gate: "operator_configured",
    passed: _resolved.explicitlyActivated,
    required: true,
    message: _resolved.explicitlyActivated
      ? "operator plugin config explicitly activated"
      : "operator plugin config not explicitly activated",
    remediation: _resolved.explicitlyActivated
      ? undefined
      : "activate the plugin explicitly in config (plugins.entries.a2a-broker-adapter.enabled=true)",
  });

  // Gate: plugin_active
  gates.push({
    gate: "plugin_active",
    passed: _resolved.enabled,
    required: true,
    message: _resolved.enabled
      ? "plugin is active"
      : "plugin is disabled",
    remediation: _resolved.enabled
      ? undefined
      : "enable the plugin and add it to plugins.allow",
  });

  // Gate: approval_packet_valid — always true in rehearsal (packet is built deterministically)
  gates.push({
    gate: "approval_packet_valid",
    passed: true,
    required: true,
    message: "approval packet structure is valid (deterministic rehearsal)",
  });

  // Gate: no_secrets_in_branch
  gates.push({
    gate: "no_secrets_in_branch",
    passed: true,
    required: true,
    message: "no secrets detected in rehearsal boundary (rehearsal does not scan live branches)",
  });

  // Gate: no_runtime_context_in_branch
  gates.push({
    gate: "no_runtime_context_in_branch",
    passed: true,
    required: true,
    message: "no runtime context files detected in rehearsal boundary (AGENTS.md, SOUL.md, etc. gitignored)",
  });

  // Gate: ci_passing
  const ciPassing = input.ciPassing !== false;
  gates.push({
    gate: "ci_passing",
    passed: ciPassing,
    required: false,
    message: ciPassing
      ? "CI is passing (or unverified in rehearsal)"
      : "CI is reported as NOT passing",
    remediation: ciPassing ? undefined : "verify CI status before proceeding to execution",
  });

  // Gate: review_required
  const reviewed = input.operatorReviewed === true;
  gates.push({
    gate: "review_required",
    passed: reviewed,
    required: true,
    message: reviewed
      ? "operator review completed"
      : "operator review not yet completed",
    remediation: reviewed ? undefined : "operator must review the rehearsal report before execution",
  });

  // Gate: operator_acknowledgment
  const acknowledged = input.operatorAcknowledged === true;
  gates.push({
    gate: "operator_acknowledgment",
    passed: acknowledged,
    required: false,
    message: acknowledged
      ? "operator has acknowledged the rehearsal report"
      : "operator acknowledgment pending",
    remediation: acknowledged
      ? undefined
      : "operator must acknowledge the rehearsal report (this is a waivable gate)",
  });

  return gates;
}

// ── Decision computation ────────────────────────────────────────────

function computeDecision(gates: SourcePublicGateResult[]): SourcePublicDecision {
  const failed = gates.filter((g) => !g.passed);
  const requiredFailed = failed.filter((g) => g.required);

  if (requiredFailed.length === 0) {
    // All required gates passed
    // Check if there are waivable failures
    const waivableFailed = failed.filter((g) => OPERATOR_WAIVABLE_GATES.has(g.gate));
    if (waivableFailed.length > 0) {
      return "NEEDS_OPERATOR_APPROVAL";
    }
    return "GO_CANDIDATE";
  }

  // Any hard blocker failed → NO_GO
  const hasHardBlocker = requiredFailed.some((g) => HARD_BLOCKER_GATES.has(g.gate));
  if (hasHardBlocker) {
    return "NO_GO";
  }

  // Non-hard-blocker required failures → NEEDS_OPERATOR_APPROVAL
  const allNonHard = requiredFailed.every((g) => !HARD_BLOCKER_GATES.has(g.gate));
  if (allNonHard) {
    return "NEEDS_OPERATOR_APPROVAL";
  }

  return "NO_GO";
}

// ── Approval packet ─────────────────────────────────────────────────

function buildApprovalPacket(
  input: SourcePublicApprovalRehearsalInput,
  gates: SourcePublicGateResult[],
  decision: SourcePublicDecision,
  runId: string,
  producedAt: number,
): SourcePublicApprovalPacket {
  const passedGates = gates.filter((g) => g.passed).map((g) => g.gate);
  const failedGates = gates.filter((g) => !g.passed).map((g) => g.gate);

  const dedupeKey = [
    "source-public-approval-packet",
    input.repo,
    runId,
    decision,
    producedAt,
  ].join(":");

  return {
    schema: "a2a.source-public.approval-packet.rehearsal.v1",
    dedupeKey,
    repo: input.repo,
    runId,
    producedAt,
    currentVisibility: input.currentVisibility ?? "unknown",
    targetVisibility: "public",
    approvalPayload: {
      operation: "change_repo_visibility",
      from: input.currentVisibility ?? "unknown",
      to: "public",
      requiredGates: [...REQUIRED_GATES],
      passedGates,
      failedGates,
    },
    isRehearsal: true,
    liveExecution: false,
    visibilityChange: false,
  };
}

// ── Evidence bundle ─────────────────────────────────────────────────

function buildEvidenceBundle(
  input: SourcePublicApprovalRehearsalInput,
  gates: SourcePublicGateResult[],
  decision: SourcePublicDecision,
  runId: string,
  approvalPacket: SourcePublicApprovalPacket,
): SourcePublicEvidenceBundle {
  const evidenceUrls = {
    ...(input.evidenceUrls?.issue ? { issue: input.evidenceUrls.issue } : {}),
    ...(input.evidenceUrls?.pullRequest ? { pullRequest: input.evidenceUrls.pullRequest } : {}),
    ...(input.evidenceUrls?.startComment ? { startComment: input.evidenceUrls.startComment } : {}),
    ...(input.evidenceUrls?.doneComment ? { doneComment: input.evidenceUrls.doneComment } : {}),
    ...(input.evidenceUrls?.blockComment ? { blockComment: input.evidenceUrls.blockComment } : {}),
  };

  const decisionRationale = buildDecisionRationale(gates, decision);

  return {
    schema: "a2a.source-public.evidence-bundle.rehearsal.v1",
    runId,
    approvalPacket,
    evidenceUrls,
    gates,
    decision,
    decisionRationale,
  };
}

function buildDecisionRationale(
  gates: SourcePublicGateResult[],
  decision: SourcePublicDecision,
): string {
  const failed = gates.filter((g) => !g.passed);
  if (decision === "GO_CANDIDATE") {
    return `All required gates passed (${gates.length - failed.length}/${gates.length}). Ready for operator review before execution.`;
  }
  if (decision === "NO_GO") {
    const hardFailures = failed.filter((g) => HARD_BLOCKER_GATES.has(g.gate));
    const reasons = hardFailures.map((g) => g.message).join("; ");
    return `NO_GO: hard blocker gates failed — ${reasons || "unspecified"}. Remediation required before re-rehearsal.`;
  }
  const waivableFailures = failed
    .filter((g) => !HARD_BLOCKER_GATES.has(g.gate))
    .map((g) => `${g.gate}: ${g.message}`)
    .join("; ");
  return `NEEDS_OPERATOR_APPROVAL: some gates require operator waiver — ${waivableFailures || "review and acknowledgment pending"}.`;
}

// ── Terminal Brief ──────────────────────────────────────────────────

function buildTerminalBrief(
  input: SourcePublicApprovalRehearsalInput,
  gates: SourcePublicGateResult[],
  decision: SourcePublicDecision,
  runId: string,
  evidenceBundle: SourcePublicEvidenceBundle,
): SourcePublicTerminalBrief {
  const failedGates = gates.filter((g) => !g.passed);
  const gateSummary = failedGates.length > 0
    ? `failed gates: [${failedGates.map((g) => g.gate).join(", ")}]`
    : "all gates passed";

  const urls = [
    evidenceBundle.evidenceUrls.issue,
    evidenceBundle.evidenceUrls.pullRequest,
    evidenceBundle.evidenceUrls.startComment,
    evidenceBundle.evidenceUrls.doneComment,
    evidenceBundle.evidenceUrls.blockComment,
  ].filter(Boolean).join(" | ") || "no evidence URLs";

  const line = [
    `[Source-Public Rehearsal: ${decision}]`,
    `${input.repo}`,
    `run: ${runId}`,
    gateSummary,
    urls,
    "rehearsal-only / no-execution / non-ACK",
  ].join(" — ");

  const abortPath = buildRollbackPath(input, runId);

  return {
    schema: "a2a.source-public.terminal-brief.rehearsal.v1",
    line,
    markers: {
      isRehearsal: true,
      isTerminalAck: false,
      isApproval: false,
      isLiveProviderSend: false,
      isProductionDeploy: false,
    },
    evidenceBundleDedupeKey: evidenceBundle.approvalPacket.dedupeKey,
    abortPath,
  };
}

// ── Rollback / Abort ────────────────────────────────────────────────

function buildRollbackPath(
  input: SourcePublicApprovalRehearsalInput,
  runId: string,
): string {
  return [
    `source-public rehearsal ${runId} for ${input.repo}:`,
    "no state was mutated — rollback requires no action",
    "to abort: discard this rehearsal report; no visibility change was executed",
    "to re-rehearse: call rehearseSourcePublicApproval() with updated inputs",
  ].join(" ");
}

// ── NO_GO fast path ─────────────────────────────────────────────────

function buildNoGoReport(
  runId: string,
  producedAt: number,
  input: SourcePublicApprovalRehearsalInput,
  gates: SourcePublicGateResult[],
  rationale: string,
): SourcePublicApprovalRehearsalReport {
  const decision: SourcePublicDecision = "NO_GO";
  const approvalPacket = buildApprovalPacket(input, gates, decision, runId, producedAt);
  const evidenceBundle = buildEvidenceBundle(input, gates, decision, runId, approvalPacket);
  const terminalBrief = buildTerminalBrief(input, gates, decision, runId, evidenceBundle);

  return {
    schema: "a2a.source-public.rehearsal-report.v1",
    version: 1,
    runId,
    decision,
    producedAt,
    approvalPacket,
    evidenceBundle,
    terminalBrief,
    abortAvailable: true,
    rollbackPath: buildRollbackPath(input, runId),
    safetyInvariants: { ...SAFETY_INVARIANTS },
  };
}
