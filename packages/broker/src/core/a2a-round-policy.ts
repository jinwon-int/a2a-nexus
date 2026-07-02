import { extractDispatchMetadata, validateTerminalBriefMetadata } from "./terminal-brief-metadata.js";
import type { CreateTaskRequest } from "./types.js";

export const A2A_ROUND_TEAM1_WORKERS = ["workerbeta", "workeralpha", "workergamma", "mobilealpha", "workerdelta"] as const;
export const A2A_ROUND_TEAM2_WORKERS = ["workerepsilon", "workerzeta", "workereta", "mobilebeta"] as const;
export const A2A_NO_LIVE_MOBILE_WORKERS = ["mobilealpha", "mobilebeta"] as const;
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

export interface A2AParentRoundResolution {
  kind: "a2a.parent-round-resolution.v1";
  required: true;
  teamScope?: A2ARoundTeamScope;
  parentRoundId?: string;
  parentRoundTotal?: number;
  parentRoundOrder?: number;
  sources: {
    teamScope?: string;
    parentRoundId?: string;
    parentRoundTotal?: string;
    parentRoundOrder?: string;
    dispatchedWorkers?: string;
    participantWorkers?: string;
    originBrokerId?: string;
    brokerOfRecordId?: string;
  };
}

export interface A2ASourceEvidenceResolution {
  kind: "a2a.source-evidence-resolution.v1";
  required: boolean;
  status: "not-required" | "embedded" | "missing";
  sources: string[];
}

export function normalizeA2ARoundTaskRequest(
  request: CreateTaskRequest,
  receiverBrokerId?: string,
): CreateTaskRequest {
  const payload = { ...(request.payload ?? {}) };
  if (!isA2ARoundTask(request, payload)) {
    return request;
  }

  const hadTeamScope = cleanToken(payload["teamScope"]);
  const hadOriginBrokerId = cleanToken(payload["originBrokerId"]);
  const hadBrokerOfRecordId = cleanToken(payload["brokerOfRecordId"]);

  const teamScope = normalizeTeamScope(
    payload["teamScope"] ?? payload["requestedTeamScope"] ?? payload["team"] ?? request.teamId,
  );
  if (teamScope && !hadTeamScope) {
    payload["teamScope"] = teamScope;
  }

  const parentRoundIdSource = firstTokenSource(payload, [
    "parentRoundId",
    "run",
    "runId",
    "round",
    "roundId",
    "discussionRunId",
  ]);
  const parentRoundId = parentRoundIdSource?.value;
  if (parentRoundId) {
    if (!cleanToken(payload["parentRoundId"])) payload["parentRoundId"] = parentRoundId;
    if (!cleanToken(payload["run"])) payload["run"] = parentRoundId;
  }

  const originBrokerId = cleanToken(
    payload["originBrokerId"] ??
    payload["parentBrokerId"] ??
    payload["requestedByBroker"] ??
    request.brokerOfRecord ??
    receiverBrokerId,
  );
  if (originBrokerId && !hadOriginBrokerId) {
    payload["originBrokerId"] = originBrokerId;
  }

  const brokerOfRecordId = cleanToken(payload["brokerOfRecordId"] ?? request.brokerOfRecord ?? receiverBrokerId);
  if (brokerOfRecordId && !hadBrokerOfRecordId) {
    payload["brokerOfRecordId"] = brokerOfRecordId;
  }

  const dispatchWorkers = extractDispatchWorkers(payload);
  const participantWorkers = extractParticipantWorkers(payload);
  const parentRoundTotal = resolveParentRoundTotal(payload, dispatchWorkers.workers, participantWorkers);
  if (parentRoundTotal.value && !isPositiveIntegerLike(payload["parentRoundTotal"])) {
    payload["parentRoundTotal"] = parentRoundTotal.value;
  }

  const parentRoundOrder = resolveParentRoundOrder(request, payload, dispatchWorkers.workers, participantWorkers);
  if (parentRoundOrder.value && !isPositiveIntegerLike(payload["parentRoundOrder"])) {
    payload["parentRoundOrder"] = parentRoundOrder.value;
  }

  payload["parentRoundResolution"] = {
    kind: "a2a.parent-round-resolution.v1",
    required: true,
    teamScope,
    parentRoundId,
    parentRoundTotal: parentRoundTotal.value,
    parentRoundOrder: parentRoundOrder.value,
    sources: {
      ...(teamScope ? { teamScope: hadTeamScope ? "payload.teamScope" : "request.teamId" } : {}),
      ...(parentRoundIdSource ? { parentRoundId: `payload.${parentRoundIdSource.key}` } : {}),
      ...(parentRoundTotal.source ? { parentRoundTotal: parentRoundTotal.source } : {}),
      ...(parentRoundOrder.source ? { parentRoundOrder: parentRoundOrder.source } : {}),
      ...(dispatchWorkers.workers.length > 0 ? { dispatchedWorkers: `payload.${dispatchWorkers.sourceKey}` } : {}),
      ...(participantWorkers.length > 0 ? { participantWorkers: "payload participant worker list" } : {}),
      ...(originBrokerId ? { originBrokerId: hadOriginBrokerId ? "payload.originBrokerId" : "request/broker" } : {}),
      ...(brokerOfRecordId ? { brokerOfRecordId: hadBrokerOfRecordId ? "payload.brokerOfRecordId" : "request/broker" } : {}),
    },
  } satisfies A2AParentRoundResolution;

  const sourceEvidenceResolution = resolveSourceEvidence(payload);
  if (sourceEvidenceResolution.status !== "not-required") {
    payload["sourceEvidenceResolution"] = sourceEvidenceResolution;
  }

  return {
    ...request,
    ...(parentRoundId ? { parentRoundId } : {}),
    ...(parentRoundTotal.value ? { parentRoundTotal: parentRoundTotal.value } : {}),
    ...(parentRoundOrder.value ? { parentRoundOrder: parentRoundOrder.value } : {}),
    payload,
  };
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
  } else if (isDefaultNoLiveMobileWorker(assignedWorkerId) && !allowNoLiveMobileBrokerClaim(payload)) {
    issues.push({
      path: "assignedWorkerId",
      message: `worker ${assignedWorkerId} is a no-live mobile worker and is excluded from broker-claimed A2A rounds by default; set payload.allowNoLiveMobileBrokerClaim=true to opt in explicitly`,
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

  const sourceEvidenceResolution = resolveSourceEvidence(payload);
  if (sourceEvidenceResolution.status === "missing") {
    issues.push({
      path: "payload.sourceEvidence",
      message: "source-only A2A analysis with source hints must attach source evidence via embeddedSourceEvidence, sourceBundle.files, or sourceEvidence",
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
  if (cleanToken(payload["discussionRunId"])) return true;
  if (
    cleanToken(request.teamId) &&
    request.taskOrigin === "operator" &&
    !isDecisionDialecticParentTask(payload)
  ) {
    return true;
  }
  return payload["a2aRound"] === true;
}

function isDecisionDialecticParentTask(payload: Record<string, unknown>): boolean {
  const contract = payload["contract"];
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return false;
  }
  return cleanToken((contract as Record<string, unknown>)["kind"]) === "decision.dialectic";
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

export function isDefaultNoLiveMobileWorker(workerId: string): boolean {
  return (A2A_NO_LIVE_MOBILE_WORKERS as readonly string[]).includes(workerId);
}

function allowNoLiveMobileBrokerClaim(payload: Record<string, unknown>): boolean {
  return payload["allowNoLiveMobileBrokerClaim"] === true;
}

function firstTokenSource(payload: Record<string, unknown>, keys: string[]): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = cleanToken(payload[key]);
    if (value) return { key, value };
  }
  return undefined;
}

function resolveSourceEvidence(payload: Record<string, unknown>): A2ASourceEvidenceResolution {
  const sourceOnly = payload["sourceOnly"] === true || payload["readOnlyValidation"] === true;
  const hintSources = sourceHintSources(payload);
  if (!sourceOnly || hintSources.length === 0) {
    return {
      kind: "a2a.source-evidence-resolution.v1",
      required: false,
      status: "not-required",
      sources: hintSources,
    };
  }

  const evidenceSources = sourceEvidenceSources(payload);
  return {
    kind: "a2a.source-evidence-resolution.v1",
    required: true,
    status: evidenceSources.length > 0 ? "embedded" : "missing",
    sources: evidenceSources.length > 0 ? evidenceSources : hintSources,
  };
}

function sourceHintSources(payload: Record<string, unknown>): string[] {
  const sources: string[] = [];
  for (const key of ["sourceHints", "sourcePaths", "evidencePaths", "evidenceRefs"]) {
    if (Array.isArray(payload[key]) && payload[key].length > 0) sources.push(`payload.${key}`);
  }
  return sources;
}

function sourceEvidenceSources(payload: Record<string, unknown>): string[] {
  const sources: string[] = [];
  if (nonEmptyArray(payload["embeddedSourceEvidence"])) sources.push("payload.embeddedSourceEvidence");
  if (nonEmptyArray(payload["sourceEvidence"])) sources.push("payload.sourceEvidence");
  const sourceBundle = payload["sourceBundle"];
  if (sourceBundle && typeof sourceBundle === "object" && !Array.isArray(sourceBundle)) {
    if (nonEmptyArray((sourceBundle as Record<string, unknown>)["files"])) sources.push("payload.sourceBundle.files");
  }
  return sources;
}

function nonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function resolveParentRoundTotal(
  payload: Record<string, unknown>,
  dispatchWorkers: string[],
  participantWorkers: string[],
): { value?: number; source?: string } {
  for (const key of ["parentRoundTotal", "roundTotal", "expectedWorkers", "taskCount", "assignmentCount"]) {
    const value = positiveIntegerValue(payload[key]);
    if (value) return { value, source: `payload.${key}` };
  }
  if (dispatchWorkers.length > 0) {
    return { value: dispatchWorkers.length, source: "payload.dispatchedWorkers.length" };
  }
  if (participantWorkers.length > 0) {
    return { value: participantWorkers.length, source: "payload.participantWorkers.length" };
  }
  return {};
}

function resolveParentRoundOrder(
  request: CreateTaskRequest,
  payload: Record<string, unknown>,
  dispatchWorkers: string[],
  participantWorkers: string[],
): { value?: number; source?: string } {
  for (const key of ["parentRoundOrder", "parentRoundNum", "parentRoundIndex", "roundNum", "lane"]) {
    const value = positiveIntegerValue(payload[key]);
    if (value) return { value, source: `payload.${key}` };
  }
  const assignedWorkerId = cleanToken(request.assignedWorkerId ?? request.target?.id);
  if (assignedWorkerId && dispatchWorkers.length > 0) {
    const order = dispatchWorkers.indexOf(assignedWorkerId) + 1;
    if (order > 0) return { value: order, source: "payload.dispatchedWorkers.index" };
  }
  if (assignedWorkerId && participantWorkers.length > 0) {
    const order = participantWorkers.indexOf(assignedWorkerId) + 1;
    if (order > 0) return { value: order, source: "payload.participantWorkers.index" };
  }
  return {};
}

function extractDispatchWorkers(payload: Record<string, unknown>): { workers: string[]; sourceKey?: string } {
  for (const key of ["dispatchedWorkers", "dispatchWorkers", "dispatchTargets", "taskWorkers", "taskTargets", "actualWorkers"]) {
    const workers = stringList(payload[key]);
    if (workers.length > 0) return { workers, sourceKey: key };
  }
  return { workers: [] };
}

function extractParticipantWorkers(payload: Record<string, unknown>): string[] {
  for (const key of ["participantWorkers", "roundWorkers", "assignedWorkers", "discussionWorkers", "workers"]) {
    const workers = stringList(payload[key]);
    if (workers.length > 0) return workers;
  }
  return [];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const token = cleanToken(item);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

function isPositiveIntegerLike(value: unknown): boolean {
  return positiveIntegerValue(value) !== undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function cleanToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
