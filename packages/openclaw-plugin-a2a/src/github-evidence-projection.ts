/**
 * Terminal Brief GitHub evidence projection helpers.
 *
 * Issue:  jinwon-int/openclaw-plugin-a2a#259
 * Parent: jinwon-int/a2a-plane#204
 * Run:    a2a-terminal-brief-github-evidence-20260511T000448Z
 *
 * The plugin renders GitHub issue/PR comment evidence as operator-facing
 * Terminal Brief context. GitHub comments/checks are a durable ledger only:
 * they are not Terminal Brief ACK, read receipt, visibility proof, or operator
 * approval. This module performs no network writes.
 */

export const GITHUB_EVIDENCE_PROJECTION_SCHEMA = "a2a.terminal-brief.github-evidence.projection.v1" as const;

export type GitHubEvidenceMarker = "Start" | "Done" | "PR" | "Block" | "Unknown";

export type GitHubEvidenceBoundary = {
  githubComment: "evidence_ledger_only";
  terminalAck: false;
  readReceipt: false;
  visibilityProof: false;
  operatorApproval: false;
  liveProviderSend: false;
};

export type GitHubEvidenceInput = {
  runId: string;
  repo: string;
  issueNumber: number;
  taskId: string;
  worker?: string;
  marker?: GitHubEvidenceMarker;
  commentUrl?: string;
  prUrl?: string;
  checkUrl?: string;
  summary?: string;
  updatedAt?: string;
};

export type GitHubEvidenceProjection = {
  schema: typeof GITHUB_EVIDENCE_PROJECTION_SCHEMA;
  runId: string;
  repo: string;
  issueNumber: number;
  taskId: string;
  worker?: string;
  marker: GitHubEvidenceMarker;
  evidenceUrls: {
    comment?: string;
    pullRequest?: string;
    check?: string;
  };
  summary: string;
  terminalBriefLine: string;
  status: "observed" | "pr_opened" | "blocked" | "done" | "started";
  dedupeKey: string;
  boundary: GitHubEvidenceBoundary;
};

export type GitHubEvidenceLedgerProjection = {
  schema: typeof GITHUB_EVIDENCE_PROJECTION_SCHEMA;
  runId: string;
  items: GitHubEvidenceProjection[];
  counts: Record<GitHubEvidenceMarker, number>;
  terminalBriefLines: string[];
  boundary: GitHubEvidenceBoundary;
};

const BOUNDARY: GitHubEvidenceBoundary = Object.freeze({
  githubComment: "evidence_ledger_only",
  terminalAck: false,
  readReceipt: false,
  visibilityProof: false,
  operatorApproval: false,
  liveProviderSend: false,
});

export function projectGitHubEvidenceForTerminalBrief(input: GitHubEvidenceInput): GitHubEvidenceProjection {
  validateInput(input);
  const marker = input.marker ?? inferMarker(input);
  const status = markerToStatus(marker);
  const summary = redactGitHubEvidenceText(input.summary ?? defaultSummary(input, marker));
  const evidenceUrls = {
    comment: validateOptionalGitHubUrl(input.commentUrl, "commentUrl"),
    pullRequest: validateOptionalGitHubUrl(input.prUrl, "prUrl"),
    check: validateOptionalGitHubUrl(input.checkUrl, "checkUrl"),
  };
  const dedupeKey = [
    "github-evidence",
    input.runId,
    input.repo,
    input.issueNumber,
    input.taskId,
    marker,
    evidenceUrls.comment ?? evidenceUrls.pullRequest ?? evidenceUrls.check ?? "no-url",
  ].join(":");
  const urlBits = [evidenceUrls.pullRequest, evidenceUrls.comment, evidenceUrls.check].filter(Boolean).join(" | ");
  const worker = input.worker ? ` ${input.worker}` : "";
  const terminalBriefLine = [
    `[GitHub evidence:${marker}]${worker}`,
    `${input.repo}#${input.issueNumber}`,
    summary,
    urlBits || "no evidence URL",
    "non-ACK/non-approval",
  ].join(" — ");

  return {
    schema: GITHUB_EVIDENCE_PROJECTION_SCHEMA,
    runId: input.runId,
    repo: input.repo,
    issueNumber: input.issueNumber,
    taskId: input.taskId,
    worker: input.worker,
    marker,
    evidenceUrls,
    summary,
    terminalBriefLine,
    status,
    dedupeKey,
    boundary: { ...BOUNDARY },
  };
}

export function projectGitHubEvidenceLedgerForTerminalBrief(inputs: GitHubEvidenceInput[]): GitHubEvidenceLedgerProjection {
  const items = inputs.map(projectGitHubEvidenceForTerminalBrief);
  const counts: Record<GitHubEvidenceMarker, number> = { Start: 0, Done: 0, PR: 0, Block: 0, Unknown: 0 };
  for (const item of items) counts[item.marker] += 1;
  return {
    schema: GITHUB_EVIDENCE_PROJECTION_SCHEMA,
    runId: assertOneRun(items),
    items,
    counts,
    terminalBriefLines: items.map((item) => item.terminalBriefLine),
    boundary: { ...BOUNDARY },
  };
}

export function redactGitHubEvidenceText(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED:github-token]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github-token]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/Authorization:\s*[^\n]+/gi, "Authorization: [REDACTED]")
    .replace(/\/(?:tmp\/openclaw-agent-workspace|work|root|home\/runner)\/[^\s)]+/g, "[REDACTED:path]")
    .replace(/\b(?:AGENTS|SOUL|USER|TOOLS|HEARTBEAT|IDENTITY|MEMORY)\.md\b/g, "[REDACTED:context-file]")
    .slice(0, 1200);
}

function validateInput(input: GitHubEvidenceInput): void {
  if (!input.runId.trim()) throw new Error("runId is required");
  if (!/^[-\w]+\/[-._\w]+$/.test(input.repo)) throw new Error("repo must be owner/name");
  if (!Number.isInteger(input.issueNumber) || input.issueNumber < 1) throw new Error("issueNumber must be a positive integer");
  if (!input.taskId.trim()) throw new Error("taskId is required");
}

function validateOptionalGitHubUrl(url: string | undefined, field: string): string | undefined {
  if (!url) return undefined;
  if (!/^https:\/\/github\.com\/[-\w]+\/[-._\w]+\/(?:issues|pull)\/\d+(?:#[-\w]+)?(?:\?.*)?$/.test(url)) {
    throw new Error(`${field} must be a GitHub issue or pull request URL`);
  }
  return url;
}

function inferMarker(input: GitHubEvidenceInput): GitHubEvidenceMarker {
  if (input.prUrl) return "PR";
  const text = input.summary ?? "";
  if (/\[a2a:Block\]|\bBlock\b|🚫/i.test(text)) return "Block";
  if (/\[a2a:Done\]|\bDone\b/i.test(text)) return "Done";
  if (/\[a2a:Start\]|\bStart\b/i.test(text)) return "Start";
  return "Unknown";
}

function markerToStatus(marker: GitHubEvidenceMarker): GitHubEvidenceProjection["status"] {
  if (marker === "PR") return "pr_opened";
  if (marker === "Block") return "blocked";
  if (marker === "Done") return "done";
  if (marker === "Start") return "started";
  return "observed";
}

function defaultSummary(input: GitHubEvidenceInput, marker: GitHubEvidenceMarker): string {
  return `${marker} evidence for ${input.taskId}`;
}

function assertOneRun(items: GitHubEvidenceProjection[]): string {
  const runIds = new Set(items.map((item) => item.runId));
  if (runIds.size > 1) throw new Error("ledger inputs must share one runId");
  return items[0]?.runId ?? "";
}
