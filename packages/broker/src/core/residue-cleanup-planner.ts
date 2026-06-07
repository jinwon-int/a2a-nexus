// Fail-closed residue cleanup candidate planner.
//
// Takes cleanup candidates discovered by the broker (e.g. stale workers,
// queued residue, orphaned claims, terminal outbox backlog, historical
// terminal tasks) and produces a deterministic, policy-gated plan.
//
// Policy modes:
//   off               – blocks all cleanup planning (safe default)
//   draft             – produces a candidate plan; all actions have
//                       executePermitted=false
//   advisory_only     – surfaces advisory cleanup candidates without
//                       authorising any prune/delete action
//   advisory_and_prune – like advisory_only but marks low-risk items
//                       as executable-eligible (still requires separate
//                       operator approval gate)
//
// This module is source-only. It never performs live GitHub actions,
// provider sends, terminal ACK/replay, DB mutation, or any other
// irreversible operation.

import { createHash } from "node:crypto";

import type {
  CleanupCandidate,
  CleanupCandidateActionability,
  CleanupCandidateClass,
  CleanupRiskClass,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResidueCleanupPolicyMode =
  | "off"
  | "draft"
  | "advisory_only"
  | "advisory_and_prune";

export type ResidueCleanupPlanDecision =
  | "approved"       // plan is actionable under current policy
  | "blocked"        // evidence or gate prevents planning
  | "policy_denied"; // policy mode explicitly forbids planning

export type ResidueCleanupActionKind =
  | "noop"
  | "operator_review"
  | "advisory_note"
  | "safe_prune"
  | "escalate";

export interface ResidueCleanupAction {
  kind: ResidueCleanupActionKind;
  label: string;
  /** Canonical candidate class this action targets. */
  targetClass?: CleanupCandidateClass;
  /** Number of candidates in this action group. */
  count: number;
  requiresApproval: boolean;
  executePermitted: boolean;
  detail: string;
}

export interface ResidueCleanupPlannerInput {
  /** Cleanup candidates discovered by the broker (e.g. via discoverCleanupCandidates). */
  candidates: CleanupCandidate[];
  /** Policy mode. */
  policyMode: ResidueCleanupPolicyMode;
  /** Parent round or issue identifier for traceability. */
  parentRef?: string;
  /** Evidence digest/revisions for idempotency. */
  evidenceDigest?: string;
  /** Operator override – non-empty = manual unblock for blocked items. */
  operatorOverride?: string;
}

export interface ResidueCleanupCandidateGroup {
  class: CleanupCandidateClass;
  count: number;
  candidates: CleanupCandidate[];
  /** Aggregated risk across the group. */
  aggregateRisk: CleanupRiskClass;
  /** Whether full-blocked items exist in this group. */
  hasBlockedItems: boolean;
}

export interface ResidueCleanupPlan {
  kind: "a2a-broker.residue-cleanup-plan";
  version: 1;
  generatedAt: string;
  policyMode: ResidueCleanupPolicyMode;
  decision: ResidueCleanupPlanDecision;
  parentRef?: string;
  idempotencyKey: string;
  /** Grouped by candidate class for structured planning. */
  groups: ResidueCleanupCandidateGroup[];
  actions: ResidueCleanupAction[];
  blockers: string[];
  warnings: string[];
  summary: {
    totalCandidates: number;
    actionableCount: number;
    blockedCount: number;
    highestRisk: CleanupRiskClass;
  };
  failClosedBoundary: {
    policyPreventsPlanning: boolean;
    highRiskItemsExist: boolean;
    blockedItemsExist: boolean;
    operatorOverridePresent: boolean;
    noEventDrivenExecution: true;
    noDbMutationWithoutOperatorGate: true;
    noTerminalAckOrReplay: true;
  };
}

export interface ResidueCleanupPlannerOptions {
  now?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORBIDDEN_LIVE_ACTIONS = [
  "GitHub PR merge or issue close",
  "live provider/Telegram/Hermes/OpenClaw send",
  "terminal ACK/replay",
  "Gateway/broker/worker/sidecar restart or deploy",
  "broker DB mutation/prune/migration",
  "historical replay",
  "release/tag/npm publish",
  "secret or credential movement",
] as const;

const POLICY_MODE_ACTION_KINDS: Record<ResidueCleanupPolicyMode, ResidueCleanupActionKind[]> = {
  off: ["noop"],
  draft: ["noop", "operator_review"],
  advisory_only: ["operator_review", "advisory_note"],
  advisory_and_prune: ["operator_review", "advisory_note", "safe_prune"],
};

/**
 * Risk ordering: highest index = highest risk.
 */
const RISK_ORDER: CleanupRiskClass[] = ["safe", "caution", "high_risk"];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildResidueCleanupPlan(
  input: ResidueCleanupPlannerInput,
  options: ResidueCleanupPlannerOptions = {},
): ResidueCleanupPlan {
  const now = options.now ?? new Date().toISOString();
  const { candidates, policyMode, parentRef, evidenceDigest, operatorOverride } = input;

  // 1. Group candidates by class
  const groups = groupCandidatesByClass(candidates);

  // 2. Evaluate blockers
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Policy gate
  let policyPreventsPlanning = false;
  if (policyMode === "off") {
    blockers.push("residue cleanup policy is off; planning blocked");
    policyPreventsPlanning = true;
  }

  // Empty candidate check
  if (candidates.length === 0) {
    warnings.push("no cleanup candidates provided; plan is a no-op");
  }

  // High-risk item check
  const highRiskItemsExist = candidates.some((c) => c.risk === "high_risk");
  if (highRiskItemsExist && policyMode !== "draft") {
    warnings.push(
      "high-risk cleanup candidates present: " +
      candidates.filter((c) => c.risk === "high_risk").length +
      " item(s). Verify each before any action.",
    );
  }

  // Blocked actionability check
  const blockedItemsExist = candidates.some((c) => c.actionability === "blocked");
  if (blockedItemsExist) {
    const blockedCount = candidates.filter((c) => c.actionability === "blocked").length;
    warnings.push(
      "blocked cleanup candidates present (" + blockedCount +
      " item(s)): these require review before any operator action.",
    );
  }

  // Operator override
  const operatorOverridePresent = Boolean(operatorOverride && operatorOverride.trim().length > 0);
  if (operatorOverridePresent) {
    warnings.push("operator override present: " + (operatorOverride ?? "").slice(0, 120));
  }

  // 3. Determine overall decision
  const decision = determinePlanDecision(policyMode, candidates, blockers, operatorOverridePresent);

  // 4. Build actions
  const actions = buildPlanActions(
    decision,
    policyMode,
    groups,
    operatorOverridePresent,
  );

  // 5. Compute summary
  const actionableCount = candidates.filter(
    (c) => c.actionability === "advisory" || c.actionability === "executable" || c.actionability === "retention_not_due",
  ).length;
  const highestRisk = candidates.reduce<CleanupRiskClass>(
    (highest, c) => RISK_ORDER.indexOf(c.risk) > RISK_ORDER.indexOf(highest) ? c.risk : highest,
    "safe",
  );

  // 6. Build idempotency key
  const idempotencyKey = buildResidueCleanupIdempotencyKey(candidates, policyMode, parentRef, evidenceDigest);

  // 7. Assemble plan
  return {
    kind: "a2a-broker.residue-cleanup-plan",
    version: 1,
    generatedAt: now,
    policyMode,
    decision,
    parentRef,
    idempotencyKey,
    groups,
    actions,
    blockers,
    warnings,
    summary: {
      totalCandidates: candidates.length,
      actionableCount,
      blockedCount: candidates.filter((c) => c.actionability === "blocked").length,
      highestRisk,
    },
    failClosedBoundary: {
      policyPreventsPlanning,
      highRiskItemsExist,
      blockedItemsExist,
      operatorOverridePresent,
      noEventDrivenExecution: true,
      noDbMutationWithoutOperatorGate: true,
      noTerminalAckOrReplay: true,
    },
  };
}

export function renderResidueCleanupPlanMarkdown(plan: ResidueCleanupPlan): string {
  const titleLine = plan.decision === "approved"
    ? "## Residue cleanup plan — approved"
    : plan.decision === "blocked"
      ? "## Residue cleanup plan — blocked"
      : "## Residue cleanup plan — policy denied";

  const lines: string[] = [
    titleLine,
    "",
    "**Policy mode:** " + plan.policyMode,
    "**Parent ref:** " + (plan.parentRef ?? "none"),
    "**Idempotency key:** `" + plan.idempotencyKey + "`",
    "**Total candidates:** " + plan.summary.totalCandidates,
    "**Highest risk:** " + plan.summary.highestRisk,
    "",
  ];

  // Group summary
  lines.push("### Candidate groups");
  for (const group of plan.groups) {
    lines.push("- **" + group.class + "**: " + group.count + " candidate(s), risk=" + group.aggregateRisk +
      (group.hasBlockedItems ? " (blocked items)" : ""));
  }
  lines.push("");

  // Actions
  lines.push("### Actions (" + plan.actions.length + ")");
  for (const action of plan.actions) {
    const targetInfo = action.targetClass ? " [" + action.targetClass + " x" + action.count + "]" : "";
    const approvalLabel = action.requiresApproval ? " 🔒 requiresApproval" : "";
    const execLabel = action.executePermitted ? " ✅ executePermitted" : " ❌ executePermitted=false";
    lines.push("- " + action.label + targetInfo + approvalLabel + execLabel);
    if (action.detail) {
      lines.push("  " + action.detail);
    }
  }
  lines.push("");

  // Blockers
  if (plan.blockers.length > 0) {
    lines.push("### Blockers");
    for (const blocker of plan.blockers) lines.push("- " + blocker);
    lines.push("");
  }

  // Warnings
  if (plan.warnings.length > 0) {
    lines.push("### Warnings");
    for (const warning of plan.warnings) lines.push("- " + warning);
    lines.push("");
  }

  // Fail-closed boundary
  lines.push("### Fail-closed boundary");
  const b = plan.failClosedBoundary;
  lines.push("- policyPreventsPlanning=" + String(b.policyPreventsPlanning));
  lines.push("- highRiskItemsExist=" + String(b.highRiskItemsExist));
  lines.push("- blockedItemsExist=" + String(b.blockedItemsExist));
  lines.push("- operatorOverridePresent=" + String(b.operatorOverridePresent));
  lines.push("- noEventDrivenExecution=" + String(b.noEventDrivenExecution));
  lines.push("- noDbMutationWithoutOperatorGate=" + String(b.noDbMutationWithoutOperatorGate));
  lines.push("- noTerminalAckOrReplay=" + String(b.noTerminalAckOrReplay));
  lines.push("");

  // Safety
  lines.push("### Safety");
  lines.push("Source-only slice. No PR merge, issue close, provider send, terminal");
  lines.push("ACK/replay, restart, DB mutation, release, or secret movement.");
  if (plan.policyMode === "off" || plan.policyMode === "draft") {
    lines.push("This plan is read-only under policy mode '" + plan.policyMode + "'.");
  }
  if (!plan.actions.some((a) => a.executePermitted)) {
    lines.push("All actions have `executePermitted=false` — draft planning only.");
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function groupCandidatesByClass(
  candidates: CleanupCandidate[],
): ResidueCleanupCandidateGroup[] {
  const classOrder: CleanupCandidateClass[] = [
    "stale_worker",
    "orphaned_claim",
    "queued_residue",
    "terminal_outbox_backlog",
    "historical_terminal_task",
    "malformed_task",
  ];

  const grouped = new Map<CleanupCandidateClass, CleanupCandidate[]>();
  for (const candidate of candidates) {
    const existing = grouped.get(candidate.class) ?? [];
    existing.push(candidate);
    grouped.set(candidate.class, existing);
  }

  // Return in canonical order, omitting empty groups.
  return classOrder
    .filter((cls) => grouped.has(cls))
    .map((cls) => {
      const items = grouped.get(cls)!;
      return {
        class: cls,
        count: items.length,
        candidates: items,
        aggregateRisk: items.reduce<CleanupRiskClass>(
          (highest, c) => RISK_ORDER.indexOf(c.risk) > RISK_ORDER.indexOf(highest) ? c.risk : highest,
          "safe",
        ),
        hasBlockedItems: items.some((c) => c.actionability === "blocked"),
      };
    });
}

function determinePlanDecision(
  policyMode: ResidueCleanupPolicyMode,
  candidates: CleanupCandidate[],
  blockers: string[],
  operatorOverridePresent: boolean,
): ResidueCleanupPlanDecision {
  // Policy off => always denied
  if (policyMode === "off") {
    return blockers.length > 1 ? "blocked" : "policy_denied";
  }

  // Empty candidate set is not a blocker — it's a clean state
  if (candidates.length === 0) {
    return "approved";
  }

  // Blockers block unless overridden
  if (blockers.length > 0 && !operatorOverridePresent) {
    return "blocked";
  }

  // draft/advisory_only/advisory_and_prune => approved
  return "approved";
}

function buildPlanActions(
  decision: ResidueCleanupPlanDecision,
  policyMode: ResidueCleanupPolicyMode,
  groups: ResidueCleanupCandidateGroup[],
  operatorOverridePresent: boolean,
): ResidueCleanupAction[] {
  const actions: ResidueCleanupAction[] = [];

  if (decision === "blocked" || decision === "policy_denied") {
    actions.push({
      kind: "noop",
      label: "plan is blocked or denied by policy; no actionable cleanup",
      count: 0,
      requiresApproval: false,
      executePermitted: false,
      detail: "resolve blockers or change policy mode to continue",
    });
    actions.push({
      kind: "operator_review",
      label: "operator review recommended before retry",
      count: groups.reduce((sum, g) => sum + g.count, 0),
      requiresApproval: true,
      executePermitted: false,
      detail: "candidate groups present but policy or evidence blocks action",
    });
    return actions;
  }

  const allowedKinds = POLICY_MODE_ACTION_KINDS[policyMode] ?? ["noop"];

  // draft mode: produce noop + operator review only
  if (policyMode === "draft") {
    actions.push({
      kind: "noop",
      label: "draft mode: residue cleanup candidates reviewed but no actions authorized",
      count: groups.reduce((sum, g) => sum + g.count, 0),
      requiresApproval: false,
      executePermitted: false,
      detail: "draft: candidate plan produced; set policy to advisory_only or advisory_and_prune to proceed",
    });
    actions.push({
      kind: "operator_review",
      label: "operator review of draft candidates recommended",
      count: groups.reduce((sum, g) => sum + g.count, 0),
      requiresApproval: true,
      executePermitted: false,
      detail: "review candidate groups and risk classification before changing policy mode",
    });
    return actions;
  }

  // advisory_only: surface advisory notes per class
  if (allowedKinds.includes("advisory_note")) {
    for (const group of groups) {
      const blocked = group.candidates.filter((c) => c.actionability === "blocked");
      const advisory = group.candidates.filter(
        (c) => c.actionability === "advisory" || c.actionability === "retention_not_due",
      );

      if (blocked.length > 0) {
        actions.push({
          kind: "advisory_note",
          label: blocked.length + " blocked " + group.class + " candidate(s) need operator review",
          targetClass: group.class,
          count: blocked.length,
          requiresApproval: true,
          executePermitted: false,
          detail: "blocked candidates: " + blocked.map((c) => c.entityId).join(", "),
        });
      }

      if (advisory.length > 0) {
        actions.push({
          kind: "advisory_note",
          label: advisory.length + " advisory " + group.class + " candidate(s) surfaced",
          targetClass: group.class,
          count: advisory.length,
          requiresApproval: false,
          executePermitted: false,
          detail: "advisory: " + advisory.map((c) => c.entityId).join(", "),
        });
      }
    }
  }

  // advisory_and_prune: mark safe/low-risk items as prune-eligible
  if (allowedKinds.includes("safe_prune") && policyMode === "advisory_and_prune") {
    for (const group of groups) {
      const safeItems = group.candidates.filter(
        (c) => c.risk === "safe" && (c.actionability === "advisory" || c.actionability === "retention_not_due"),
      );
      if (safeItems.length > 0) {
        actions.push({
          kind: "safe_prune",
          label: safeItems.length + " safe " + group.class + " candidate(s) eligible for operator-approved prune",
          targetClass: group.class,
          count: safeItems.length,
          requiresApproval: true,
          executePermitted: false, // source-only slice; requires separate operator approval gate
          detail: "safe prune candidates: " + safeItems.map((c) => c.entityId).join(", ") +
            ". These require explicit approval through an execution gate.",
        });
      }
    }
  }

  // Add operator review when there are caution/high-risk items
  const cautionItems = groups.flatMap((g) =>
    g.candidates.filter((c) => c.risk === "caution" || c.risk === "high_risk"),
  );
  if (cautionItems.length > 0 && allowedKinds.includes("operator_review")) {
    actions.push({
      kind: "operator_review",
      label: cautionItems.length + " caution/high-risk candidate(s) require operator review",
      count: cautionItems.length,
      requiresApproval: true,
      executePermitted: false,
      detail: "operator must verify each caution/high-risk item before any action: " +
        cautionItems.map((c) => c.entityId).join(", "),
    });
  }

  // If no actions were produced, add a fallback noop
  if (actions.length === 0) {
    actions.push({
      kind: "noop",
      label: "no actionable cleanup candidates under policy " + policyMode,
      count: 0,
      requiresApproval: false,
      executePermitted: false,
      detail: "policy mode " + policyMode + " does not map to any candidates or actions",
    });
  }

  return actions;
}

function buildResidueCleanupIdempotencyKey(
  candidates: CleanupCandidate[],
  policyMode: ResidueCleanupPolicyMode,
  parentRef?: string,
  evidenceDigest?: string,
): string {
  const stable = JSON.stringify({
    parentRef,
    policyMode,
    evidenceDigest,
    candidates: candidates.map((c) => ({
      id: c.id,
      class: c.class,
      risk: c.risk,
      actionability: c.actionability,
      entityId: c.entityId,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  });

  return "residue-cleanup:" + createHash("sha256").update(stable).digest("hex").slice(0, 24);
}
