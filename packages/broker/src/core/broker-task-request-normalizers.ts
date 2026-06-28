// Task-request field readers and GitHub patch task-request normalization
// extracted from broker.ts. Pure functions that read/sanitize incoming task
// request fields and canonicalize GitHub read-only and patch-dispatch requests
// (validating parent-round routing). They hold no broker state; validation
// failures throw BrokerError.
import { BrokerError } from "./broker-error.js";
import type { CreateTaskRequest } from "./types.js";

const GITHUB_READ_ONLY_TASK_MODES = new Set([
  "analysis-only",
  "read-only-analysis",
  "analyze-only",
  "github-verify",
  "github-read-only-validation",
  "read-only-validation",
  "github-libero-validation",
  "libero-validation",
  "family-wiki-readonly-audit",
]);

const GITHUB_DISPATCH_TEAM_TOTALS: Record<string, number> = {
  team1: 4,
  team2: 4,
};

export function isGithubReadOnlyTaskRequest(request: CreateTaskRequest, mode: string | undefined): boolean {
  if (!mode || !GITHUB_READ_ONLY_TASK_MODES.has(mode)) {
    return false;
  }
  return request.intent === "analyze" || request.intent === "verify" || request.intent === "validate_change";
}

export function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

export function normalizeGithubPatchParentRoundPayload(
  payload: Record<string, unknown>,
  context: { requesterId?: string },
): { fields: Record<string, unknown>; issues: string[] } {
  const runId = readString(payload["runId"] ?? payload["run"] ?? payload["roundId"] ?? payload["round"]);
  const parentRoundId = readString(payload["parentRoundId"]) ?? runId;
  const originBrokerId = readString(payload["originBrokerId"]) ?? context.requesterId;
  const teamId = readString(payload["teamId"] ?? payload["teamScope"]);
  const teamDefaultTotal = teamId ? GITHUB_DISPATCH_TEAM_TOTALS[teamId] : undefined;
  const parentRoundTotal = readPositiveInteger(
    payload["parentRoundTotal"] ??
    payload["roundTotal"] ??
    payload["assignmentCount"] ??
    payload["expectedWorkers"] ??
    payload["taskCount"],
  ) ?? teamDefaultTotal;
  const parentRoundOrder = readPositiveInteger(
    payload["parentRoundOrder"] ??
    payload["parentRoundNum"] ??
    payload["parentRoundIndex"] ??
    payload["roundOrder"] ??
    payload["roundNum"] ??
    payload["roundIndex"] ??
    payload["lane"],
  );
  const issues: string[] = [];

  if (!parentRoundId) {
    issues.push("parentRoundId is required when GitHub patch dispatch includes parent-round routing; provide parentRoundId or runId");
  }
  if (!originBrokerId) {
    issues.push("originBrokerId is required when GitHub patch dispatch includes parent-round routing; provide originBrokerId or requester.id");
  }
  if (parentRoundTotal === undefined) {
    issues.push("parentRoundTotal is required when GitHub patch dispatch includes parent-round routing; provide parentRoundTotal, assignmentCount, expectedWorkers, taskCount, or teamId=team1/team2");
  }
  if (parentRoundOrder === undefined) {
    issues.push("parentRoundOrder is required when GitHub patch dispatch includes parent-round routing; provide parentRoundOrder or lane");
  }
  if (parentRoundTotal !== undefined && parentRoundOrder !== undefined && parentRoundOrder > parentRoundTotal) {
    issues.push(`parentRoundOrder must be <= parentRoundTotal, got ${parentRoundOrder}/${parentRoundTotal}`);
  }

  if (issues.length > 0) {
    return { fields: {}, issues };
  }

  return {
    fields: {
      parentRoundId,
      parentRoundTotal,
      parentRoundOrder,
      originBrokerId,
      ...(teamId ? { teamId } : {}),
      ...(runId ? { runId } : {}),
    },
    issues,
  };
}

export function normalizeGitHubPatchTaskRequest(request: CreateTaskRequest): CreateTaskRequest {
  const payload = request.payload ?? {};
  const mode = readString(payload["mode"]);
  const repo = readString(payload["repo"]);
  const legacyRepo = readString(payload["githubRepo"]);
  const issueNumber = readIssueNumber(payload["issueNumber"] ?? payload["issue"]);
  const legacyIssueNumber = readIssueNumber(payload["githubIssueNumber"]);
  const issueUrl = readString(payload["issueUrl"]);
  const legacyIssueUrl = readString(payload["githubIssueUrl"]);
  const workMode = readString(payload["workMode"]);
  const githubWorkMode = readString(payload["githubWorkMode"]);

  if (request.intent === "propose_patch" && mode === "github-issue-instruction") {
    return request;
  }

  const messageIssue = readGitHubIssueUrl(request.message);
  const payloadIssue = readGitHubIssueUrl(issueUrl ?? legacyIssueUrl);
  const payloadHasRepoIssuePair =
    (repo !== undefined || legacyRepo !== undefined) &&
    (issueNumber !== undefined || legacyIssueNumber !== undefined || issueUrl !== undefined || legacyIssueUrl !== undefined);
  const hasLegacyGitHubMetadata = legacyRepo !== undefined || legacyIssueNumber !== undefined || legacyIssueUrl !== undefined;
  const legacyCompatibilityAllowed = hasLegacyGitHubMetadata && (workMode === "github" || githubWorkMode === "github");
  const hasExplicitGithubDispatchSignal =
    mode === "github-propose-patch" ||
    (isGithubReadOnlyTaskRequest(request, mode) &&
      (payloadHasRepoIssuePair || messageIssue !== undefined || payloadIssue !== undefined || hasLegacyGitHubMetadata)) ||
    (mode !== undefined && hasLegacyGitHubMetadata) ||
    messageIssue !== undefined ||
    payloadIssue !== undefined ||
    workMode === "github" ||
    githubWorkMode === "github";
  const looksLikeGithubTask =
    hasExplicitGithubDispatchSignal ||
    (request.intent === "propose_patch" && (mode === undefined || mode === "github-propose-patch") && payloadHasRepoIssuePair);

  if (!looksLikeGithubTask) {
    return request;
  }

  if (isGithubReadOnlyTaskRequest(request, mode)) {
    if (request.taskOrigin !== undefined && request.taskOrigin !== "github") {
      throw new BrokerError("bad_request", "GitHub read-only validation tasks require taskOrigin=github");
    }

    const normalizedRepo = repo ?? legacyRepo ?? payloadIssue?.repo ?? messageIssue?.repo;
    if (!normalizedRepo || !/^[^/\s]+\/[^/\s]+$/.test(normalizedRepo)) {
      throw new BrokerError("bad_request", "GitHub read-only validation payload requires repo in owner/name form");
    }

    const normalizedIssueNumber = issueNumber ?? legacyIssueNumber ?? payloadIssue?.issueNumber ?? messageIssue?.issueNumber;
    if (normalizedIssueNumber === undefined) {
      throw new BrokerError("bad_request", "GitHub read-only validation payload requires issueNumber, issue, or issueUrl");
    }

    const normalizedIssueUrl = issueUrl ?? legacyIssueUrl ??
      `https://github.com/${normalizedRepo}/issues/${normalizedIssueNumber}`;
    return {
      ...request,
      taskOrigin: "github",
      payload: {
        ...payload,
        mode,
        repo: normalizedRepo,
        issue: `#${normalizedIssueNumber}`,
        issueNumber: normalizedIssueNumber,
        issueUrl: normalizedIssueUrl,
      },
    };
  }

  if (request.intent !== "propose_patch") {
    if (request.taskOrigin === "github" && readString(payload["githubDeliveryId"]) && readString(payload["githubKind"])) {
      return request;
    }
    throw new BrokerError(
      "bad_request",
      "GitHub-looking tasks require canonical intent=propose_patch, taskOrigin=github, and payload.mode=github-propose-patch",
    );
  }

  if (request.taskOrigin !== undefined && request.taskOrigin !== "github") {
    throw new BrokerError("bad_request", "GitHub patch dispatch tasks require taskOrigin=github");
  }

  if (mode === undefined && !legacyCompatibilityAllowed) {
    throw new BrokerError(
      "bad_request",
      "GitHub-looking dispatch requires payload.mode=github-propose-patch; legacy github* fields must include workMode=github for compatibility normalization",
    );
  }

  const normalizedMode = mode ?? "github-propose-patch";
  if (normalizedMode !== "github-propose-patch") {
    throw new BrokerError("bad_request", "GitHub patch dispatch payload requires mode=github-propose-patch");
  }

  const normalizedRepo = repo ?? legacyRepo ?? payloadIssue?.repo ?? messageIssue?.repo;
  if (!normalizedRepo || !/^[^/\s]+\/[^/\s]+$/.test(normalizedRepo)) {
    throw new BrokerError("bad_request", "GitHub patch dispatch payload requires repo in owner/name form");
  }

  const normalizedIssueNumber = issueNumber ?? legacyIssueNumber ?? payloadIssue?.issueNumber ?? messageIssue?.issueNumber;
  if (normalizedIssueNumber === undefined) {
    throw new BrokerError("bad_request", "GitHub patch dispatch payload requires issueNumber or issue");
  }

  const normalizedIssueUrl = issueUrl ?? legacyIssueUrl ??
    `https://github.com/${normalizedRepo}/issues/${normalizedIssueNumber}`;
  const hasParentRoundRoutingSignal = Boolean(
    readString(payload["parentIssueUrl"]) ||
    readString(payload["parentRoundId"]) ||
    readString(payload["parentRound"]) ||
    readString(payload["operatorFacingOwner"]) ||
    payload["parentRoundTotal"] !== undefined ||
    payload["parentRoundOrder"] !== undefined ||
    payload["parentRoundNum"] !== undefined ||
    payload["parentRoundIndex"] !== undefined ||
    payload["assignmentCount"] !== undefined ||
    payload["expectedWorkers"] !== undefined ||
    payload["taskCount"] !== undefined ||
    payload["lane"] !== undefined ||
    payload["teamId"] !== undefined ||
    payload["teamScope"] !== undefined ||
    payload["crossBrokerHandoff"] !== undefined,
  );
  const parentRoundPayload = hasParentRoundRoutingSignal
    ? normalizeGithubPatchParentRoundPayload(payload, { requesterId: request.requester?.id })
    : { fields: {}, issues: [] };
  if (parentRoundPayload.issues.length > 0) {
    throw new BrokerError("bad_request", `GitHub patch dispatch parent-round metadata invalid: ${parentRoundPayload.issues.join("; ")}`);
  }
  const normalizedPayload: Record<string, unknown> = {
    ...payload,
    mode: normalizedMode,
    repo: normalizedRepo,
    issue: `#${normalizedIssueNumber}`,
    issueNumber: normalizedIssueNumber,
    issueUrl: normalizedIssueUrl,
    ...parentRoundPayload.fields,
  };

  if (mode === undefined || repo === undefined || issueNumber === undefined || issueUrl === undefined) {
    normalizedPayload["githubDispatchCompatibility"] = {
      normalizedFromLegacyPayload: true,
      legacyFields: Object.keys(payload).filter((key) => key.startsWith("github") || key === "workMode" || key === "githubWorkMode"),
    };
  }

  return {
    ...request,
    taskOrigin: "github",
    payload: normalizedPayload,
  };
}

export function readGitHubIssueUrl(value: unknown): { repo: string; issueNumber: number } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/i);
  if (!match) {
    return undefined;
  }
  return { repo: match[1], issueNumber: Number(match[2]) };
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function cleanOptionalTaskCancelField(value: unknown): string | undefined {
  return readString(value);
}

export function normalizeOwnershipString(value: unknown): string | undefined {
  return readString(value);
}

export function readIssueNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const match = value.trim().match(/^#?(\d+)$/);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}
