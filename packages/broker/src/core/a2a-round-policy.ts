import { extractDispatchMetadata, validateTerminalBriefMetadata } from "./terminal-brief-metadata.js";
import type { CreateTaskRequest } from "./types.js";

export const A2A_ROUND_TEAM1_WORKERS = ["sogyo", "nosuk", "yukson"] as const;
export const A2A_ROUND_TEAM2_WORKERS = ["dungae", "jingun", "soonwook", "daegyo"] as const;
export const A2A_ROUND_MODES = ["ordinary_a2a_lite", "explicit_strong_a2ad"] as const;

export type A2ARoundTeamScope = "team1" | "team2" | "cross-team";

export interface A2ARoundPolicyIssue {
  path: string;
  message: string;
}

export interface A2ARoundPolicyValidationResult {
  applies: boolean;
  valid: boolean;
  teamScope?: A2ARoundTeamScope;
  issues: A2ARoundPolicyIssue[];
}

export function validateA2ARoundTaskPolicy(
  request: CreateTaskRequest,
  receiverBrokerId?: string,
): A2ARoundPolicyValidationResult {
  const payload = request.payload ?? {};
  const applies = isA2ARoundTask(request, payload);
  const issues: A2ARoundPolicyIssue[] = [];
  if (!applies) return { applies: false, valid: true, issues };

  const teamScope = normalizeTeamScope(
    payload["teamScope"] ?? payload["requestedTeamScope"] ?? payload["team"],
  );
  if (!teamScope) {
    issues.push({
      path: "payload.teamScope",
      message: "A2A rounds must declare teamScope as team1, team2, or cross-team",
    });
  }

  const assignedWorkerId = cleanToken(request.assignedWorkerId);
  if (!assignedWorkerId) {
    issues.push({
      path: "assignedWorkerId",
      message: "A2A rounds must dispatch through an explicit team worker",
    });
  } else if (request.target?.id !== assignedWorkerId) {
    issues.push({
      path: "assignedWorkerId",
      message: "A2A round assignedWorkerId must match target.id",
    });
  } else if (teamScope && !workerAllowedForTeam(assignedWorkerId, teamScope)) {
    issues.push({
      path: "assignedWorkerId",
      message: `worker ${assignedWorkerId} is not in the ${teamScope} worker set`,
    });
  }

  const dispatchMetadata = extractDispatchMetadata(payload);
  const terminalBrief = validateTerminalBriefMetadata(dispatchMetadata, receiverBrokerId, {
    allowLocalOrigin: true,
  });
  for (const issue of terminalBrief.issues.filter((issue) => issue.severity === "error")) {
    issues.push({
      path: `payload.${issue.path}`,
      message: issue.message,
    });
  }

  return {
    applies,
    valid: issues.length === 0,
    teamScope,
    issues,
  };
}

function isA2ARoundTask(request: CreateTaskRequest, payload: Record<string, unknown>): boolean {
  const intent = cleanToken(request.intent);
  if (intent?.startsWith("a2a.")) return true;
  const mode = cleanToken(payload["mode"] ?? payload["roundMode"]);
  if (mode && A2A_ROUND_MODES.includes(mode as (typeof A2A_ROUND_MODES)[number])) return true;
  return payload["a2aRound"] === true;
}

function normalizeTeamScope(value: unknown): A2ARoundTeamScope | undefined {
  const token = cleanToken(value)?.toLowerCase().replace(/\s+/g, "");
  if (!token) return undefined;
  if (token === "team1" || token === "1팀" || token === "1") return "team1";
  if (token === "team2" || token === "2팀" || token === "2") return "team2";
  if (
    token === "cross-team" ||
    token === "crossteam" ||
    token === "team1+team2" ||
    token === "1,2팀" ||
    token === "1팀+2팀"
  ) {
    return "cross-team";
  }
  return undefined;
}

function workerAllowedForTeam(workerId: string, teamScope: A2ARoundTeamScope): boolean {
  if (teamScope === "team1") return (A2A_ROUND_TEAM1_WORKERS as readonly string[]).includes(workerId);
  if (teamScope === "team2") return (A2A_ROUND_TEAM2_WORKERS as readonly string[]).includes(workerId);
  return (
    (A2A_ROUND_TEAM1_WORKERS as readonly string[]).includes(workerId) ||
    (A2A_ROUND_TEAM2_WORKERS as readonly string[]).includes(workerId)
  );
}

function cleanToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
