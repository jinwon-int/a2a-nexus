// Fail-closed automatic parent-round closeout planner.
//
// Wraps the Terminal Brief completion watcher and final-count closeout
// candidate with policy-mode gating and a deterministic closeout plan.
//
// Policy modes:
//   off              – blocks all closeout actions (safe default)
//   draft            – produces a candidate plan but no actions
//   comment_only     – allows a closeout comment (wired later)
//   comment_and_close – allows a closeout comment plus GitHub issue close (wired later)
//
// This module is source-only. It never performs live GitHub actions,
// provider sends, terminal ACK/replay, DB mutation, or any other
// irreversible operation.

import { createHash } from "node:crypto";

import {
  buildTerminalBriefFinalCountCloseoutCandidate,
  renderTerminalBriefFinalCountCloseoutMarkdown,
  type TerminalBriefFinalCountCloseoutCandidate,
  type TerminalBriefFinalCountCloseoutInput,
  type TerminalBriefFinalCountDecision,
} from "./terminal-brief-final-count-closeout.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoCloseoutPolicyMode = "off" | "draft" | "comment_only" | "comment_and_close";

export type AutoCloseoutPlanDecision =
  | "approved"       // plan is actionable under current policy
  | "blocked"        // evidence or gate prevents closeout
  | "waiting"        // not all evidence collected yet
  | "policy_denied"; // policy mode explicitly forbids any action

export type AutoCloseoutActionKind =
  | "noop"
  | "comment"
  | "comment_and_close"
  | "operator_review"
  | "recover_evidence";

export interface AutoCloseoutAction {
  kind: AutoCloseoutActionKind;
  label: string;
  requiresApproval: boolean;
  executePermitted: boolean;
  detail: string;
}

export interface TerminalBriefAutoCloseoutPlannerInput {
  /** pass through or build from scratch */
  candidate?: TerminalBriefFinalCountCloseoutCandidate;
  finalCountInput?: TerminalBriefFinalCountCloseoutInput;
  /** policy mode */
  policyMode: AutoCloseoutPolicyMode;
  /** parent round identifiers */
  parentRoundId?: string;
  parentRoundTotal?: number;
  parentRoundOrder?: number;
  /** evidence revisions for idempotency */
  evidenceRevisions?: Record<string, string>;
  /** GitHub token presence (simulated) */
  hasGitHubToken?: boolean;
  /** CI status evidence (simulated) – urls to passing CI */
  ciPassUrls?: string[];
  /** PR merge status (simulated) */
  prMergeCommitShas?: Record<string, string>;
  /** operator override – non-empty = manual unblock */
  operatorOverride?: string;
}

export interface TerminalBriefAutoCloseoutPlan {
  kind: "a2a-broker.terminal-brief-auto-closeout-plan";
  version: 1;
  generatedAt: string;
  policyMode: AutoCloseoutPolicyMode;
  decision: AutoCloseoutPlanDecision;
  closeoutDecision: TerminalBriefFinalCountDecision;
  parentRoundId?: string;
  idempotencyKey: string;
  actions: AutoCloseoutAction[];
  blockers: string[];
  warnings: string[];
  closeoutCandidate: TerminalBriefFinalCountCloseoutCandidate;
  failClosedBoundary: {
    policyPreventsAction: boolean;
    tokenMissing: boolean;
    conflictingEvidence: boolean;
    missingEvidence: boolean;
    missingCiEvidence: boolean;
    prNotMergeable: boolean;
    operatorOverridePresent: boolean;
  };
}

export interface TerminalBriefAutoCloseoutPlannerOptions {
  now?: string;
}

const POLICY_MODE_ACTION_MAP: Record<AutoCloseoutPolicyMode, AutoCloseoutActionKind[]> = {
  off: ["operator_review"],
  draft: ["noop"],
  comment_only: ["comment"],
  comment_and_close: ["comment", "comment_and_close"],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildAutoCloseoutPlan(
  input: TerminalBriefAutoCloseoutPlannerInput,
  options: TerminalBriefAutoCloseoutPlannerOptions = {},
): TerminalBriefAutoCloseoutPlan {
  const now = options.now ?? new Date().toISOString();

  // 1. Build or use existing closeout candidate
  const candidate = input.candidate ?? (
    input.finalCountInput
      ? buildTerminalBriefFinalCountCloseoutCandidate(input.finalCountInput, { now })
      : buildTerminalBriefFinalCountCloseoutCandidate({ events: [] }, { now })
  );

  const policyMode = input.policyMode;
  const parentRoundId = input.parentRoundId ?? candidate.parentRoundId;
  const hasToken = input.hasGitHubToken ?? false;
  const ciPassUrls = input.ciPassUrls ?? [];
  const prMergeShas = input.prMergeCommitShas ?? {};
  const operatorOverride = input.operatorOverride ?? "";
  const evidenceRevisions = input.evidenceRevisions ?? {};

  // 2. Evaluate policy gate
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Policy mode check
  let policyPreventsAction = false;
  if (policyMode === "off") {
    blockers.push("auto-closeout policy is off");
    policyPreventsAction = true;
  }

  // Closeout candidate status
  if (candidate.decision === "blocked") {
    blockers.push(...candidate.blockers);
  }
  if (candidate.decision === "waiting") {
    if (!blockers.some((b) => b.includes("wait"))) {
      blockers.push("final-count closeout still waiting for signals");
    }
  }

  // Token / permission check
  let tokenMissing = false;
  if (!hasToken) {
    warnings.push("GitHub token not provided; permission checks simulated as unavailable");
    tokenMissing = true;
  }

  // CI evidence check — only when policy would allow action
  if ((policyMode === "comment_only" || policyMode === "comment_and_close") && candidate.decision === "candidate") {
    if (ciPassUrls.length === 0) {
      warnings.push("no CI pass evidence provided; closeout plan still valid but CI status unknown");
    }
  }

  // PR mergeability check — only for comment_and_close
  if (policyMode === "comment_and_close" && candidate.decision === "candidate") {
    const prWorkers = candidate.completion.lanes.filter((lane) => lane.evidenceUrl?.includes("/pull/"));
    for (const lane of prWorkers) {
      const sha = prMergeShas[lane.worker];
      if (!sha) {
        warnings.push(lane.worker + ": PR evidence does not include merge commit SHA; "
          + "merge status cannot be verified from this slice alone");
      }
    }
  }

  // Conflicting totals from candidate
  let conflictingEvidence = false;
  if (candidate.blockers.some((b) => b.includes("conflicting") || b.includes("conflict"))) {
    conflictingEvidence = true;
  }

  // Missing worker evidence
  let missingEvidence = candidate.missingWorkers.length > 0;

  let missingCiEvidence = (policyMode === "comment_only" || policyMode === "comment_and_close")
    && ciPassUrls.length === 0 && candidate.decision === "candidate";

  let prNotMergeable = false;
  // In this source-only slice we only warn; actual mergeability checks require GitHub API

  // Operator override
  let operatorOverridePresent = operatorOverride.length > 0;
  if (operatorOverridePresent) {
    warnings.push("operator override present: " + operatorOverride.slice(0, 120));
  }

  // 3. Determine overall decision
  const decision = determinePlanDecision(policyMode, candidate.decision, blockers, operatorOverridePresent);

  // 4. Build actions
  const actions = buildPlanActions(decision, policyMode, candidate, hasToken, operatorOverridePresent);

  // 5. Build idempotency key
  const idempotencyKey = buildAutoCloseoutIdempotencyKey(
    parentRoundId ?? "",
    candidate,
    policyMode,
    evidenceRevisions,
  );

  // 6. Assemble plan
  return {
    kind: "a2a-broker.terminal-brief-auto-closeout-plan",
    version: 1,
    generatedAt: now,
    policyMode,
    decision,
    closeoutDecision: candidate.decision,
    parentRoundId,
    idempotencyKey,
    actions,
    blockers,
    warnings,
    closeoutCandidate: candidate,
    failClosedBoundary: {
      policyPreventsAction,
      tokenMissing,
      conflictingEvidence,
      missingEvidence,
      missingCiEvidence,
      prNotMergeable,
      operatorOverridePresent,
    },
  };
}

export function renderAutoCloseoutPlanMarkdown(plan: TerminalBriefAutoCloseoutPlan): string {
  const titleLine = decisionTitle(plan.decision);
  const lines: string[] = [
    titleLine,
    "Policy mode: " + plan.policyMode,
    "Parent round: " + (plan.parentRoundId ?? "unknown"),
    "Closeout candidate status: " + plan.closeoutDecision,
    "Idempotency key: " + plan.idempotencyKey,
    "",
  ];

  // Actions
  lines.push("Planned actions (" + plan.actions.length + "):");
  for (const action of plan.actions) {
    lines.push("- " + action.label + " | requiresApproval=" + action.requiresApproval
      + " executePermitted=" + action.executePermitted);
    if (action.detail) lines.push("  " + action.detail);
  }
  lines.push("");

  // Blockers
  if (plan.blockers.length > 0) {
    lines.push("Blockers:");
    for (const blocker of plan.blockers) lines.push("- " + blocker);
    lines.push("");
  }

  // Warnings
  if (plan.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of plan.warnings) lines.push("- " + warning);
    lines.push("");
  }

  // Fail-closed boundary summary
  lines.push("Fail-closed boundary:");
  const boundary = plan.failClosedBoundary;
  lines.push("- policyPreventsAction=" + boundary.policyPreventsAction);
  lines.push("- tokenMissing=" + boundary.tokenMissing);
  lines.push("- conflictingEvidence=" + boundary.conflictingEvidence);
  lines.push("- missingEvidence=" + boundary.missingEvidence);
  lines.push("- missingCiEvidence=" + boundary.missingCiEvidence);
  lines.push("- prNotMergeable=" + boundary.prNotMergeable);
  lines.push("- operatorOverridePresent=" + boundary.operatorOverridePresent);
  lines.push("");

  // Embedded closeout candidate
  lines.push("Underlying closeout candidate:");
  lines.push(renderTerminalBriefFinalCountCloseoutMarkdown(plan.closeoutCandidate)
    .split("\n").map((l) => "  " + l).join("\n"));
  lines.push("");

  // Safety boundary
  lines.push("Safety: source-only slice. No PR merge, issue close, provider send, terminal"
    + " ACK/replay, restart, DB mutation, release, or secret movement.");
  if (plan.policyMode === "off" || plan.policyMode === "draft") {
    lines.push("This plan is read-only under policy mode '" + plan.policyMode
      + "'. No automated GitHub actions will execute from this slice.");
  }
  if (!plan.actions.some((a) => a.executePermitted)) {
    lines.push("All planned actions have executePermitted=false — this is a draft plan only.");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function determinePlanDecision(
  policyMode: AutoCloseoutPolicyMode,
  closeoutDecision: TerminalBriefFinalCountDecision,
  blockers: string[],
  operatorOverridePresent: boolean,
): AutoCloseoutPlanDecision {
  if (policyMode === "off") {
    return blockers.length > 1 ? "blocked" : "policy_denied";
  }
  if (blockers.length > 0 && !operatorOverridePresent) {
    return blockers.some((b) => b.includes("wait") || b.includes("no final-count"))
      ? "waiting"
      : "blocked";
  }
  if (closeoutDecision !== "candidate" && !operatorOverridePresent) {
    return closeoutDecision === "waiting" ? "waiting" : "blocked";
  }
  if (policyMode === "draft") {
    // draft produces approved plan but all actions have executePermitted=false
    return "approved";
  }
  if (policyMode === "comment_only" || policyMode === "comment_and_close") {
    return "approved";
  }
  // For off mode without blockers (unusual), still policy_denied
  return "policy_denied";
}

function buildPlanActions(
  decision: AutoCloseoutPlanDecision,
  policyMode: AutoCloseoutPolicyMode,
  candidate: TerminalBriefFinalCountCloseoutCandidate,
  hasToken: boolean,
  operatorOverridePresent: boolean,
): AutoCloseoutAction[] {
  const actions: AutoCloseoutAction[] = [];

  if (decision === "waiting" || decision === "blocked") {
    actions.push({
      kind: "recover_evidence",
      label: "recover evidence or resolve blockers",
      requiresApproval: false,
      executePermitted: false,
      detail: "closeout cannot proceed; resolve " + (candidate.blockers.length + candidate.missingWorkers.length) + " issue(s)",
    });
    actions.push({
      kind: "operator_review",
      label: "operator review recommended before retry",
      requiresApproval: true,
      executePermitted: false,
      detail: "evidence gaps require manual operator inspection",
    });
    return actions;
  }

  // decision is approved or policy_denied
  const allowedKinds = POLICY_MODE_ACTION_MAP[policyMode] ?? ["operator_review"];

  if (allowedKinds.includes("noop") || policyMode === "draft") {
    actions.push({
      kind: "noop",
      label: "review closeout candidate (draft mode)",
      requiresApproval: true,
      executePermitted: false,
      detail: "draft: candidate produced but not authorized for any GitHub action",
    });
  }

  if (policyMode === "comment_only" || policyMode === "comment_and_close") {
    actions.push({
      kind: "comment",
      label: "post closeout summary comment on parent issue",
      requiresApproval: true,
      executePermitted: false, // not wired yet — source-only slice
      detail: "future wiring needed; executePermitted remains false in this slice",
    });
  }

  if (policyMode === "comment_and_close") {
    actions.push({
      kind: "comment_and_close",
      label: "post closeout comment and close parent issue",
      requiresApproval: true,
      executePermitted: false, // not wired yet — source-only slice
      detail: "future wiring needed; executePermitted remains false in this slice",
    });
  }

  // If no allowed actions match, add operator review
  if (actions.length === 0) {
    actions.push({
      kind: "operator_review",
      label: "operator review — no actionable plan under policy " + policyMode,
      requiresApproval: true,
      executePermitted: false,
      detail: "policy mode " + policyMode + " does not map to any automated action",
    });
  }

  return actions;
}

function buildAutoCloseoutIdempotencyKey(
  parentRoundId: string,
  candidate: TerminalBriefFinalCountCloseoutCandidate,
  policyMode: AutoCloseoutPolicyMode,
  evidenceRevisions: Record<string, string>,
): string {
  const laneStable = candidate.completion.lanes
    .map((lane) => ({
      worker: lane.worker,
      state: lane.state,
      evidenceUrl: lane.evidenceUrl ?? "",
      parentRoundProgress: lane.parentRoundProgress,
      parentRoundTotal: lane.parentRoundTotal,
    }))
    .sort((a, b) => a.worker.localeCompare(b.worker));

  const revisionStable = Object.entries(evidenceRevisions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => k + "=" + v)
    .join(",");

  // Count unique final (N/N) signal groups ignoring timestamps
  const seenFinal = new Set<string>();
  for (const s of candidate.normalizedSignals) {
    if (s.progress === s.total) {
      seenFinal.add(s.progress + "/" + s.total + "|" + (s.source ?? "") + "|" + (s.worker ?? ""));
    }
  }

  const stable = JSON.stringify({
    parentRoundId,
    lanes: laneStable,
    policyMode,
    uniqueFinalSignalGroups: seenFinal.size,
    evidenceRevisions: revisionStable || undefined,
  });

  return "auto-closeout:" + createHash("sha256").update(stable).digest("hex").slice(0, 24);
}

function decisionTitle(decision: AutoCloseoutPlanDecision): string {
  switch (decision) {
    case "approved":
      return "Plan: fail-closed automatic closeout — approved";
    case "blocked":
      return "Plan: fail-closed automatic closeout — blocked";
    case "waiting":
      return "Plan: fail-closed automatic closeout — waiting";
    case "policy_denied":
      return "Plan: fail-closed automatic closeout — policy denied";
  }
}
