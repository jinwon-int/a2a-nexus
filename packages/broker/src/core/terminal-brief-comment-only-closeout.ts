import {
  renderAutoCloseoutPlanMarkdown,
  type TerminalBriefAutoCloseoutPlan,
} from "./terminal-brief-auto-closeout-planner.js";

export type CommentOnlyCloseoutMode = "dry_run" | "comment_only";
export type GitHubCommentPermission = "unknown" | "granted" | "denied";

export interface ExistingGitHubComment {
  id: string | number;
  body: string;
  url?: string;
  author?: string;
}

export interface TerminalBriefCommentOnlyCloseoutInput {
  plan: TerminalBriefAutoCloseoutPlan;
  targetIssueUrl: string;
  mode: CommentOnlyCloseoutMode;
  existingComments?: ExistingGitHubComment[];
  githubPermission?: GitHubCommentPermission;
  operatorApproved?: boolean;
}

export type CommentOnlyCloseoutPlannedAction =
  | "dry_run"
  | "post_comment"
  | "skip_duplicate"
  | "blocked";

export interface TerminalBriefCommentOnlyCloseoutDraft {
  kind: "a2a-broker.terminal-brief-comment-only-closeout.draft";
  version: 1;
  mode: CommentOnlyCloseoutMode;
  generatedAt: string;
  targetIssueUrl: string;
  parentRoundId?: string;
  idempotencyKey: string;
  marker: string;
  title: string;
  body: string;
  bodyWithMarker: string;
  plannedAction: CommentOnlyCloseoutPlannedAction;
  postPermitted: boolean;
  duplicateComment?: ExistingGitHubComment;
  blockers: string[];
  warnings: string[];
  safety: {
    commentOnly: boolean;
    idempotencyGuarded: boolean;
    exactDraftAvailableBeforePost: boolean;
    executesIssueClose: false;
    executesPrMerge: false;
    executesTerminalAckReplay: false;
    executesDbMutation: false;
    executesRestartDeploy: false;
    executesProviderSend: false;
    executesReleasePublish: false;
    executesSecretMovement: false;
  };
}

export interface TerminalBriefCommentOnlyCloseoutOptions {
  now?: string;
}

export function buildCommentOnlyCloseoutDraft(
  input: TerminalBriefCommentOnlyCloseoutInput,
  options: TerminalBriefCommentOnlyCloseoutOptions = {},
): TerminalBriefCommentOnlyCloseoutDraft {
  const now = options.now ?? new Date().toISOString();
  const blockers: string[] = [];
  const warnings: string[] = [];
  const plan = input.plan;
  const mode = input.mode;
  const marker = buildCommentOnlyMarker(plan.idempotencyKey);
  const duplicateComment = input.existingComments?.find((comment) => comment.body.includes(marker));
  const permission = input.githubPermission ?? "unknown";
  const operatorApproved = input.operatorApproved ?? false;

  if (plan.policyMode !== "comment_only") {
    blockers.push("comment_only closeout requires planner policyMode=comment_only");
  }
  if (plan.decision !== "approved") {
    blockers.push("closeout plan is not approved: " + plan.decision);
  }
  if (duplicateComment) {
    warnings.push("idempotency duplicate found; comment post will be suppressed");
  }
  if (permission === "denied") {
    blockers.push("GitHub comment permission denied for target issue");
  }
  if (permission === "unknown") {
    warnings.push("GitHub comment permission is unknown; dry-run remains safe");
  }
  if (mode === "comment_only" && !operatorApproved) {
    blockers.push("operator approval is required before comment_only posting");
  }

  if (plan.closeoutCandidate.missingWorkers.length > 0) {
    blockers.push(
      "closeout candidate has missing workers: " +
      plan.closeoutCandidate.missingWorkers.join(", "),
    );
  }

  const title = "A2A Team1 closeout comment draft"
    + (plan.parentRoundId ? " - " + plan.parentRoundId : "");
  const body = renderCommentOnlyBody(plan, input.targetIssueUrl);
  const bodyWithMarker = marker + "\n" + body;

  let plannedAction: CommentOnlyCloseoutPlannedAction = "dry_run";
  if (duplicateComment) {
    plannedAction = "skip_duplicate";
  } else if (blockers.length > 0) {
    plannedAction = "blocked";
  } else if (mode === "comment_only" && permission === "granted" && operatorApproved) {
    plannedAction = "post_comment";
  }

  const postPermitted = plannedAction === "post_comment";

  return {
    kind: "a2a-broker.terminal-brief-comment-only-closeout.draft",
    version: 1,
    mode,
    generatedAt: now,
    targetIssueUrl: input.targetIssueUrl,
    parentRoundId: plan.parentRoundId,
    idempotencyKey: plan.idempotencyKey,
    marker,
    title,
    body,
    bodyWithMarker,
    plannedAction,
    postPermitted,
    duplicateComment,
    blockers,
    warnings,
    safety: {
      commentOnly: true,
      idempotencyGuarded: true,
      exactDraftAvailableBeforePost: true,
      executesIssueClose: false,
      executesPrMerge: false,
      executesTerminalAckReplay: false,
      executesDbMutation: false,
      executesRestartDeploy: false,
      executesProviderSend: false,
      executesReleasePublish: false,
      executesSecretMovement: false,
    },
  };
}

export function renderCommentOnlyCloseoutDraftMarkdown(
  draft: TerminalBriefCommentOnlyCloseoutDraft,
): string {
  const lines = [
    draft.title,
    "Target: " + draft.targetIssueUrl,
    "Mode: " + draft.mode,
    "Planned action: " + draft.plannedAction,
    "Post permitted: " + draft.postPermitted,
    "Idempotency: " + draft.idempotencyKey,
    "",
  ];

  if (draft.blockers.length > 0) {
    lines.push("Blockers:");
    for (const blocker of draft.blockers) lines.push("- " + blocker);
    lines.push("");
  }
  if (draft.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of draft.warnings) lines.push("- " + warning);
    lines.push("");
  }

  lines.push("Safety:");
  lines.push("- commentOnly=" + draft.safety.commentOnly);
  lines.push("- idempotencyGuarded=" + draft.safety.idempotencyGuarded);
  lines.push("- executesIssueClose=" + draft.safety.executesIssueClose);
  lines.push("- executesPrMerge=" + draft.safety.executesPrMerge);
  lines.push("- executesTerminalAckReplay=" + draft.safety.executesTerminalAckReplay);
  lines.push("- executesDbMutation=" + draft.safety.executesDbMutation);
  lines.push("- executesRestartDeploy=" + draft.safety.executesRestartDeploy);
  lines.push("- executesProviderSend=" + draft.safety.executesProviderSend);
  lines.push("");
  lines.push("Draft body:");
  lines.push(draft.bodyWithMarker);

  return lines.join("\n");
}

export function buildCommentOnlyMarker(idempotencyKey: string): string {
  return "<!-- a2a:comment-only-closeout v=1 key=" + idempotencyKey + " -->";
}

function renderCommentOnlyBody(
  plan: TerminalBriefAutoCloseoutPlan,
  targetIssueUrl: string,
): string {
  return [
    "## A2A Team1 Closeout",
    "",
    "- Target: " + targetIssueUrl,
    "- Parent round: " + (plan.parentRoundId ?? "unknown"),
    "- Policy mode: " + plan.policyMode,
    "- Decision: " + plan.decision,
    "- Closeout candidate: " + plan.closeoutDecision,
    "- Idempotency: " + plan.idempotencyKey,
    "",
    "This is `comment_only` closeout. It does not merge PRs, close issues, ACK or replay Terminal Brief rows, mutate the broker DB, restart/deploy services, send providers, publish releases, or move secrets.",
    "",
    renderAutoCloseoutPlanMarkdown(plan),
  ].join("\n");
}
