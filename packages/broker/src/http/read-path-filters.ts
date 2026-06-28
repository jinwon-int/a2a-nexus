import { BrokerError } from "../core/broker.js";
import { numberQueryParam, boundedLimitQueryParam } from "./request-params.js";
// Re-exported so existing consumers (e.g. workers-read.ts) keep importing it
// from here; the implementation now lives in the shared request-params module.
export { numberQueryParam };
import type {
  A2APartyRole,
  A2AWorkerEnvironment,
  AuditAction,
  ProposalKind,
  ProposalStatus,
  TaskKind,
  TaskListFilters,
  TaskOrigin,
  TaskStatus,
  WorkerListFilters,
} from "../core/types.js";

export const DEFAULT_TASK_LIST_LIMIT = 100;
const MAX_TASK_LIST_LIMIT = 500;

export interface ProposalReadPathFilters {
  status?: ProposalStatus;
  sourceNodeId?: string;
  targetNodeId?: string;
  kind?: ProposalKind;
}

export interface AuditReadPathFilters {
  proposalId?: string;
  actorId?: string;
  targetId?: string;
  action?: AuditAction;
}

export function proposalFiltersFromUrl(url: URL): ProposalReadPathFilters {
  return {
    status: optionalEnum(url.searchParams.get("status"), [
      "draft",
      "submitted",
      "validated",
      "approved",
      "rejected",
      "applied",
      "rolled_back",
    ]),
    sourceNodeId: optionalString(url.searchParams.get("sourceNodeId")),
    targetNodeId: optionalString(url.searchParams.get("targetNodeId")),
    kind: optionalEnum(url.searchParams.get("kind"), ["patch", "params", "hybrid"]),
  };
}

export function workerFiltersFromUrl(url: URL): WorkerListFilters {
  return {
    role: optionalEnum(url.searchParams.get("role"), [
      "hub",
      "live-trader",
      "researcher",
      "analyst",
      "operator",
    ] as A2APartyRole[]),
    environment: optionalEnum(url.searchParams.get("environment"), [
      "research",
      "staging",
      "live",
    ] as A2AWorkerEnvironment[]),
    workspaceId: optionalString(url.searchParams.get("workspaceId")),
  };
}

export function taskFiltersFromUrl(url: URL, options: { defaultLimit?: number } = {}): TaskListFilters {
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus === "pending"
    ? "queued"
    : optionalEnum(rawStatus, [
      "blocked",
      "queued",
      "claimed",
      "running",
      "succeeded",
      "failed",
      "canceled",
    ] as TaskStatus[]);
  return {
    exchangeId: optionalString(url.searchParams.get("exchangeId")),
    status,
    targetNodeId: optionalString(url.searchParams.get("targetNodeId")),
    proposalId: optionalString(url.searchParams.get("proposalId")),
    intent: optionalEnum(url.searchParams.get("intent"), [
      "chat",
      "analyze",
      "verify",
      "backfill",
      "propose_patch",
      "propose_params",
      "validate_change",
      "apply_local_change",
      "promote_to_live",
      "rollback_live",
    ] as TaskKind[]),
    claimedBy: optionalString(url.searchParams.get("claimedBy")),
    assignedWorkerId: optionalString(url.searchParams.get("assignedWorkerId")) ?? optionalString(url.searchParams.get("worker")),
    taskOrigin: optionalEnum(url.searchParams.get("taskOrigin"), ["github", "api", "sessions_send", "operator", "unknown"] as TaskOrigin[]),
    includeStaleReadPath: includeValues(url).includes("stale_read_path"),
    limit: boundedLimitQueryParam(url, "limit", MAX_TASK_LIST_LIMIT, options.defaultLimit),
  };
}

export function auditFiltersFromUrl(url: URL): AuditReadPathFilters {
  return {
    proposalId: optionalString(url.searchParams.get("proposalId")),
    actorId: optionalString(url.searchParams.get("actorId")),
    targetId: optionalString(url.searchParams.get("targetId")),
    action: optionalEnum(url.searchParams.get("action"), [
      "exchange.message.added",
      "proposal.created",
      "artifact.attached",
      "validation.submitted",
      "proposal.approved",
      "proposal.rejected",
      "proposal.applied",
      "task.created",
      "task.approved",
      "task.claimed",
      "task.started",
      "task.reassigned",
      "task.requeued",
      "task.succeeded",
      "task.failed",
      "task.canceled",
      "worker.registered",
      "worker.heartbeat",
    ] as AuditAction[]),
  };
}

export function taskIdsFromUrl(url: URL): string[] {
  const repeated = url.searchParams.getAll("task_id").flatMap((value) => value.split(","));
  const csv = optionalString(url.searchParams.get("task_ids"));
  if (csv) repeated.push(...csv.split(","));
  return [...new Set(repeated.map((value) => value.trim()).filter(Boolean))];
}

function optionalString(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function includeValues(url: URL): string[] {
  return url.searchParams
    .getAll("include")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function optionalEnum<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  if (value === null) return undefined;
  return allowed.includes(value as T) ? (value as T) : undefined;
}
