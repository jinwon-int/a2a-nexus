import type {
  A2AExchangeIntent,
  A2APartyRole,
  A2AWorkerEnvironment,
  WorkerImplementationRuntime,
  WorkerView,
} from "./types.js";
import {
  type WorkerAssignmentRole,
  type WorkerCapabilityCard,
} from "./worker-capability-card.js";

// ── Scheduling intent ───────────────────────────────────────────────────────

/**
 * Describes the task being scheduled, extracted from the broader A2A request
 * context so the dry-run evaluator can reason about constraints without
 * coupling to broker internals.
 */
export interface SchedulerDryRunTaskProfile {
  /** The task type / exchange intent. */
  taskType: A2AExchangeIntent;
  /** Optional workspace/repo hint for workspace-id access checks. */
  workspaceId?: string;
  /** Optional target environment, e.g. "research", "staging", "live". */
  targetEnvironment?: A2AWorkerEnvironment;
  /** Optional worker id that was explicitly assigned by the operator. */
  assignedWorkerId?: string;
  /** When true, the scheduler should prefer validation workers (libero). */
  preferValidationWorker?: boolean;
  /** Optional implementation-lane pin and redundancy policy. */
  implementationPolicy?: {
    requiredRuntime?: WorkerImplementationRuntime;
    requiredProviderId?: string;
    requiredModelTier?: string;
    /** Defaults to one. Set to two to reject a single-worker implementation lane. */
    minimumReadyWorkers?: number;
  };
}

// ── Constraint evaluation ──────────────────────────────────────────────────

export type ConstraintVerdict = "pass" | "fail" | "warn" | "skip";

export interface ConstraintEvaluation {
  /** Machine-readable constraint identifier. */
  constraint: string;
  /** Human-readable label. */
  label: string;
  /** Verdict. */
  verdict: ConstraintVerdict;
  /** Free-form explanation of why this constraint passed or failed. */
  reason: string;
}

// ── Worker evaluation ──────────────────────────────────────────────────────

export interface WorkerEvaluation {
  /** Worker node id. */
  workerId: string;
  /** Worker display name (if available). */
  workerName?: string;
  /** Worker role. */
  role: A2APartyRole;
  /** Overall recommendation for this worker. */
  recommended: boolean;
  /** Ordered list of constraint evaluations. */
  constraints: ConstraintEvaluation[];
  /** Human-readable summary of the recommendation. */
  summary: string;
}

// ── Output ─────────────────────────────────────────────────────────────────

export interface SchedulerDryRunResult {
  kind: "a2a-broker.scheduler-dry-run.v1";
  version: 1;
  /** When the dry-run was generated. */
  generatedAt: string;
  /** The task profile that was evaluated. */
  taskProfile: SchedulerDryRunTaskProfile;
  /** Number of workers evaluated. */
  workerCount: number;
  /** Evaluations for each candidate worker, ranked by recommendation. */
  workerEvaluations: WorkerEvaluation[];
  /** Overall recommendation. */
  recommendation: {
    /** The recommended worker id, or null if no worker passed all constraints. */
    selectedWorkerId: string | null;
    /** Human-readable explanation of the overall recommendation. */
    explanation: string;
    /** When the recommendation is provisional due to warnings. */
    provisional: boolean;
  };
  /** Present for patch/parameter implementation intents only. */
  implementationLaneReadiness?: {
    required: true;
    requiredRuntime?: WorkerImplementationRuntime;
    requiredProviderId?: string;
    requiredModelTier?: string;
    minimumReadyWorkers: number;
    readyWorkerCount: number;
    eligibleWorkerCount: number;
    singlePointOfFailure: boolean;
    meetsMinimum: boolean;
    workers: Array<{
      workerId: string;
      capable: boolean;
      runtime: WorkerImplementationRuntime | "missing";
      providerId?: string;
      modelTier?: string;
      availability: string;
      ready: boolean;
      eligible: boolean;
    }>;
  };
  /** Safety boundaries: this is a read-only dry-run, never mutates state. */
  safety: {
    noMutation: true;
    noDispatch: true;
    noClaim: true;
    noDbMutation: true;
  };
}

// ── Capability card cache ──────────────────────────────────────────────────

export interface SchedulerCapabilityCardLookup {
  getCard(workerId: string): WorkerCapabilityCard | null;
}

/**
 * In-memory card cache wrapping a list of capability cards.
 */
export class InMemorySchedulerCardLookup implements SchedulerCapabilityCardLookup {
  private readonly byId: Map<string, WorkerCapabilityCard>;

  constructor(cards: readonly WorkerCapabilityCard[]) {
    this.byId = new Map(cards.map((c) => [c.worker.id, c]));
  }

  getCard(workerId: string): WorkerCapabilityCard | null {
    return this.byId.get(workerId) ?? null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Map an A2AExchangeIntent to the WorkerAssignmentRole that is expected
 * to handle that type of work. Returns undefined when no direct mapping
 * exists (the worker's capability card supportedTaskTypes serves as the
 * authoritative list).
 */
export function intentToPreferredRole(intent: A2AExchangeIntent): WorkerAssignmentRole | undefined {
  switch (intent) {
    case "propose_patch":
    case "propose_params":
    case "apply_local_change":
      return "implementation";
    case "validate_change":
      return "libero";
    default:
      return undefined;
  }
}

export function isImplementationTaskType(intent: A2AExchangeIntent): boolean {
  return intent === "propose_patch" || intent === "propose_params" || intent === "apply_local_change";
}

function normalizedPolicyId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function minimumImplementationWorkers(taskProfile: SchedulerDryRunTaskProfile): number {
  const configured = taskProfile.implementationPolicy?.minimumReadyWorkers;
  return typeof configured === "number" && Number.isFinite(configured)
    ? Math.max(1, Math.floor(configured))
    : 1;
}

export function evaluateImplementationReadiness(
  worker: WorkerView,
  taskProfile: SchedulerDryRunTaskProfile,
): ConstraintEvaluation {
  const profile = worker.capabilities.implementationCapability;
  const blockers: string[] = [];

  if (worker.workerPlane !== "online") {
    blockers.push(`worker plane is '${worker.workerPlane}', not 'online'`);
  }
  if (!profile) {
    blockers.push("implementation capability is not declared in registration/heartbeat");
  } else {
    if (!profile.capable) blockers.push("worker declares implementation capability disabled");
    if (profile.runtime === "unknown") blockers.push("implementation runtime is unknown");
    if (!profile.providerId) blockers.push("implementation provider is not recorded");
    if (!profile.modelTier) blockers.push("implementation model tier is not recorded");
    if (profile.availability !== "canary_passed") {
      blockers.push(`implementation availability is '${profile.availability}', not 'canary_passed'`);
    }

    const policy = taskProfile.implementationPolicy;
    if (policy?.requiredRuntime && profile.runtime !== policy.requiredRuntime) {
      blockers.push(`runtime '${profile.runtime}' does not match required '${policy.requiredRuntime}'`);
    }
    const requiredProviderId = normalizedPolicyId(policy?.requiredProviderId);
    if (requiredProviderId && profile.providerId !== requiredProviderId) {
      blockers.push(`provider '${profile.providerId ?? "missing"}' does not match required '${requiredProviderId}'`);
    }
    const requiredModelTier = normalizedPolicyId(policy?.requiredModelTier);
    if (requiredModelTier && profile.modelTier !== requiredModelTier) {
      blockers.push(`model tier '${profile.modelTier ?? "missing"}' does not match required '${requiredModelTier}'`);
    }
  }

  return {
    constraint: "implementation_readiness",
    label: "Implementation readiness",
    verdict: blockers.length === 0 ? "pass" : "fail",
    reason: blockers.length === 0
      ? `Verified ${profile!.runtime} implementation route '${profile!.providerId}/${profile!.modelTier}' is canary-passed`
      : blockers.join("; "),
  };
}

/**
 * Map an A2APartyRole to the WorkerAssignmentRole bridge.
 * A party role like "analyst" or "operator" maps to a scheduler role.
 */
export function partyRoleToAssignmentRole(role: A2APartyRole): WorkerAssignmentRole | undefined {
  switch (role) {
    case "hub":
      return "runner-safety";
    case "operator":
      return "runner-safety";
    case "live-trader":
      return "implementation";
    case "researcher":
      return "implementation";
    case "analyst":
      return "implementation";
    default:
      return undefined;
  }
}

/**
 * Determine whether a card supports a given intent by checking
 * `supportedTaskTypes`.
 */
export function cardSupportsTaskType(
  card: WorkerCapabilityCard | null,
  intent: A2AExchangeIntent,
): boolean {
  if (!card) return false;
  return card.assignment.supportedTaskTypes.includes(intent);
}

/**
 * Determine whether a card supports a given intent by checking worker
 * capabilities (the legacy path without a capability card).
 */
export function workerSupportsTaskType(
  worker: WorkerView,
  intent: A2AExchangeIntent,
): boolean {
  switch (intent) {
    case "analyze":
      return worker.capabilities.canAnalyze;
    case "backfill":
      return worker.capabilities.canBackfill;
    case "propose_patch":
    case "apply_local_change":
      return worker.capabilities.canPatchWorkspace;
    case "promote_to_live":
      return worker.capabilities.canPromoteLive;
    default:
      return false;
  }
}

/**
 * Check whether a worker has access to a workspace (repo).
 */
export function workerHasWorkspaceAccess(
  worker: WorkerView,
  workspaceId: string | undefined,
): boolean {
  if (!workspaceId) return true; // no constraint to check
  if (worker.capabilities.workspaceIds.length === 0) return true; // no filter
  return worker.capabilities.workspaceIds.includes(workspaceId);
}

/**
 * Check whether a card has available capacity.
 */
export function cardHasCapacity(
  card: WorkerCapabilityCard | null,
): { ok: boolean; current: number | undefined; max: number | undefined } {
  if (!card || !card.capacity) {
    return { ok: true, current: undefined, max: undefined };
  }
  const current = card.capacity.currentAssignedTasks ?? 0;
  const max = card.capacity.maxConcurrentTasks;
  if (max === undefined) return { ok: true, current, max };
  return { ok: current < max, current, max };
}

// ── Core evaluation ─────────────────────────────────────────────────────────

/**
 * Evaluate a single worker against the task profile.
 *
 * Returns a structured evaluation with per-constraint verdicts and an
 * overall recommendation.
 */
export function evaluateWorkerForTask(
  worker: WorkerView,
  taskProfile: SchedulerDryRunTaskProfile,
  card: WorkerCapabilityCard | null,
): WorkerEvaluation {
  const constraints: ConstraintEvaluation[] = [];
  const cardTeam = card?.team.teamId;

  // 1. Role constraint
  const preferredRole = intentToPreferredRole(taskProfile.taskType);
  if (preferredRole) {
    const cardRoles = card?.assignment.roles ?? [partyRoleToAssignmentRole(worker.role)].filter(Boolean);
    const hasRole = cardRoles.length === 0 || cardRoles.includes(preferredRole);
    constraints.push({
      constraint: "role_match",
      label: "Role match",
      verdict: hasRole ? "pass" : "fail",
      reason: hasRole
        ? `Worker role '${preferredRole}' matches required role for '${taskProfile.taskType}' tasks`
        : `Worker roles [${cardRoles.join(", ")}] do not include required role '${preferredRole}' for '${taskProfile.taskType}' tasks`,
    });
  } else {
    constraints.push({
      constraint: "role_match",
      label: "Role match",
      verdict: "skip",
      reason: `No preferred role mapping for '${taskProfile.taskType}'; role constraint skipped`,
    });
  }

  // 2. Task-type support (via capability card or worker capabilities)
  const supportsCardType = card ? cardSupportsTaskType(card, taskProfile.taskType) : false;
  const supportsWorkerType = workerSupportsTaskType(worker, taskProfile.taskType);
  const supportsTaskType = supportsCardType || supportsWorkerType;
  const taskTypeSource = card && supportsCardType ? "capability card" : "worker capabilities";
  constraints.push({
    constraint: "task_type_support",
    label: "Task-type support",
    verdict: supportsTaskType ? "pass" : "fail",
    reason: supportsTaskType
      ? `Worker supports '${taskProfile.taskType}' (via ${taskTypeSource})`
      : `Worker does not support '${taskProfile.taskType}' in capabilities or capability card`,
  });

  // 3. Implementation runtime/provider/model proof. Filesystem patch access
  // alone must never make a worker eligible for an implementation lane.
  if (isImplementationTaskType(taskProfile.taskType)) {
    constraints.push(evaluateImplementationReadiness(worker, taskProfile));
  }

  // 4. Workspace/repo access
  const hasAccess = workerHasWorkspaceAccess(worker, taskProfile.workspaceId);
  constraints.push({
    constraint: "workspace_access",
    label: "Workspace access",
    verdict: hasAccess ? "pass" : "fail",
    reason: hasAccess
      ? taskProfile.workspaceId
        ? `Worker has access to workspace '${taskProfile.workspaceId}'`
        : "No workspace constraint; access check skipped"
      : `Worker workspace IDs [${worker.capabilities.workspaceIds.join(", ")}] do not include required '${taskProfile.workspaceId}'`,
  });

  // 5. Capacity
  const capacity = cardHasCapacity(card);
  constraints.push({
    constraint: "capacity_available",
    label: "Capacity available",
    verdict: capacity.ok ? "pass" : "fail",
    reason: capacity.ok
      ? capacity.max !== undefined
        ? `Worker has capacity (${capacity.current}/${capacity.max} assigned)`
        : "Worker has no capacity ceiling; capacity check passed"
      : `Worker is at capacity (${capacity.current}/${capacity.max} assigned)`,
  });

  // 6. Target environment
  if (taskProfile.targetEnvironment) {
    const envs = card?.assignment.environments ?? worker.capabilities.environments;
    const hasEnv = envs.length === 0 || envs.includes(taskProfile.targetEnvironment);
    constraints.push({
      constraint: "environment_match",
      label: "Environment match",
      verdict: hasEnv ? "pass" : "fail",
      reason: hasEnv
        ? `Worker supports environment '${taskProfile.targetEnvironment}'`
        : `Worker environments [${envs.join(", ")}] do not include '${taskProfile.targetEnvironment}'`,
    });
  }

  // 7. Validation-worker preference
  if (taskProfile.preferValidationWorker) {
    const isLibero = card?.assignment.roles.includes("libero") ?? false;
    const isLiberoByTeam = cardTeam !== undefined && cardTeam === "team2";
    constraints.push({
      constraint: "validation_worker_preference",
      label: "Validation-worker preference",
      verdict: isLibero ? "pass" : isLiberoByTeam ? "warn" : "fail",
      reason: isLibero
        ? "Worker is a libero (validation-specialist); preferred for validation tasks"
        : isLiberoByTeam
          ? "Worker is a team2 (libero-aligned) worker; conditionally acceptable"
          : "Worker is not a validation-specialist (libero); consider a libero worker for validation tasks",
    });
  }

  // Overall recommendation
  const fails = constraints.filter((c) => c.verdict === "fail");
  const warnings = constraints.filter((c) => c.verdict === "warn");
  const recommended = fails.length === 0;

  // Build summary
  let summary: string;
  if (fails.length > 0) {
    const failReasons = fails.map((c) => c.reason).join("; ");
    summary = `❌ Worker '${worker.nodeId}' skipped: ${failReasons}`;
  } else if (warnings.length > 0) {
    const warnReasons = warnings.map((c) => c.reason).join("; ");
    summary = `⚠️ Worker '${worker.nodeId}' recommended with warnings: ${warnReasons}`;
  } else {
    summary = `✅ Worker '${worker.nodeId}' passes all constraints and is recommended`;
  }

  return {
    workerId: worker.nodeId,
    workerName: worker.displayName,
    role: worker.role,
    recommended,
    constraints,
    summary,
  };
}

// ── Ranked selection ────────────────────────────────────────────────────────

/**
 * Rank workers by suitability for the task.
 *
 * Ranking criteria (highest priority first):
 * 1. Explicitly assigned worker (if passed constraints)
 * 2. Recommended workers with libero preference (validation preference)
 * 3. Other recommended workers
 * 4. Non-recommended workers (last resort with explanations)
 */
export function rankWorkersForTask(
  evaluations: WorkerEvaluation[],
  taskProfile: SchedulerDryRunTaskProfile,
): WorkerEvaluation[] {
  const recommended = evaluations.filter((e) => e.recommended);
  const notRecommended = evaluations.filter((e) => !e.recommended);

  // Sort recommended: assigned worker first, then validation-preference, then others
  const sortRecommended = (a: WorkerEvaluation, b: WorkerEvaluation): number => {
    // Explicitly assigned worker gets top priority
    if (taskProfile.assignedWorkerId) {
      if (a.workerId === taskProfile.assignedWorkerId) return -1;
      if (b.workerId === taskProfile.assignedWorkerId) return 1;
    }
    // Validation-worker preference
    if (taskProfile.preferValidationWorker) {
      const aIsLibero = a.constraints.some(
        (c) => c.constraint === "validation_worker_preference" && c.verdict !== "fail",
      );
      const bIsLibero = b.constraints.some(
        (c) => c.constraint === "validation_worker_preference" && c.verdict !== "fail",
      );
      if (aIsLibero && !bIsLibero) return -1;
      if (!aIsLibero && bIsLibero) return 1;
    }
    return 0; // stable within tiers
  };

  return [...recommended.sort(sortRecommended), ...notRecommended];
}

// ── Top-level dry-run ───────────────────────────────────────────────────────

/**
 * Run the scheduler dry-run for a task profile against a set of candidate
 * workers.
 *
 * This function is **pure** — it does not read or write any broker state.
 * All required inputs are passed explicitly. The output is a structured
 * dry-run result that explains worker selection decisions.
 */
export function runSchedulerDryRun(
  taskProfile: SchedulerDryRunTaskProfile,
  candidates: WorkerView[],
  cardLookup?: SchedulerCapabilityCardLookup,
): SchedulerDryRunResult {
  const generatedAt = new Date().toISOString();

  const evaluations: WorkerEvaluation[] = candidates.map((worker) => {
    const card = cardLookup?.getCard(worker.nodeId) ?? null;
    return evaluateWorkerForTask(worker, taskProfile, card);
  });

  const ranked = rankWorkersForTask(evaluations, taskProfile);
  const recommendedPassing = ranked.filter((e) => e.recommended);
  const implementationTask = isImplementationTaskType(taskProfile.taskType);
  const minimumReadyWorkers = minimumImplementationWorkers(taskProfile);
  const workerById = new Map(candidates.map((worker) => [worker.nodeId, worker]));
  const implementationLaneReadiness = implementationTask
    ? {
        required: true as const,
        ...(taskProfile.implementationPolicy?.requiredRuntime
          ? { requiredRuntime: taskProfile.implementationPolicy.requiredRuntime }
          : {}),
        ...(normalizedPolicyId(taskProfile.implementationPolicy?.requiredProviderId)
          ? { requiredProviderId: normalizedPolicyId(taskProfile.implementationPolicy?.requiredProviderId) }
          : {}),
        ...(normalizedPolicyId(taskProfile.implementationPolicy?.requiredModelTier)
          ? { requiredModelTier: normalizedPolicyId(taskProfile.implementationPolicy?.requiredModelTier) }
          : {}),
        minimumReadyWorkers,
        readyWorkerCount: ranked.filter((evaluation) => evaluation.constraints.some(
          (constraint) => constraint.constraint === "implementation_readiness" && constraint.verdict === "pass",
        )).length,
        eligibleWorkerCount: recommendedPassing.length,
        singlePointOfFailure: recommendedPassing.length === 1,
        meetsMinimum: recommendedPassing.length >= minimumReadyWorkers,
        workers: ranked.map((evaluation) => {
          const profile = workerById.get(evaluation.workerId)?.capabilities.implementationCapability;
          return {
            workerId: evaluation.workerId,
            capable: profile?.capable === true,
            runtime: profile?.runtime ?? "missing" as const,
            ...(profile?.providerId ? { providerId: profile.providerId } : {}),
            ...(profile?.modelTier ? { modelTier: profile.modelTier } : {}),
            availability: profile?.availability ?? "missing",
            ready: evaluation.constraints.some(
              (constraint) => constraint.constraint === "implementation_readiness" && constraint.verdict === "pass",
            ),
            eligible: evaluation.recommended,
          };
        }),
      }
    : undefined;

  let selectedWorkerId: string | null = null;
  let explanation: string;
  let provisional = false;

  if (ranked.length === 0) {
    explanation = "No workers available for scheduling.";
  } else if (implementationLaneReadiness && !implementationLaneReadiness.meetsMinimum) {
    explanation =
      `Implementation dispatch rejected: ${implementationLaneReadiness.eligibleWorkerCount} eligible worker(s), ` +
      `minimum ${implementationLaneReadiness.minimumReadyWorkers} required by lane policy.`;
  } else if (recommendedPassing.length > 0) {
    selectedWorkerId = recommendedPassing[0].workerId;
    const warningCount = recommendedPassing[0].constraints.filter((c) => c.verdict === "warn").length;
    provisional = warningCount > 0;

    if (recommendedPassing.length === 1) {
      explanation = `Single eligible worker '${selectedWorkerId}' passes all constraint checks.`;
    } else {
      explanation = `Selected '${selectedWorkerId}' from ${recommendedPassing.length} eligible workers after ranking.`;
    }

    if (provisional) {
      explanation += " Recommendation is provisional due to constraint warnings.";
    }
  } else if (ranked.length > 0 && !implementationTask) {
    // No recommended workers — pick the best of the non-recommended
    const bestNonRecommended = ranked[0];
    selectedWorkerId = bestNonRecommended.workerId;
    provisional = true;
    explanation =
      `No worker passes all constraints. Best candidate '${selectedWorkerId}' has ${bestNonRecommended.constraints.filter((c) => c.verdict === "fail").length} failure(s). Manual operator review required.`;
  } else {
    explanation = "No verified implementation worker is eligible; dispatch rejected.";
  }

  const result: SchedulerDryRunResult = {
    kind: "a2a-broker.scheduler-dry-run.v1",
    version: 1,
    generatedAt,
    taskProfile,
    workerCount: candidates.length,
    workerEvaluations: ranked,
    recommendation: {
      selectedWorkerId,
      explanation,
      provisional,
    },
    ...(implementationLaneReadiness ? { implementationLaneReadiness } : {}),
    safety: {
      noMutation: true,
      noDispatch: true,
      noClaim: true,
      noDbMutation: true,
    },
  };

  return result;
}

// ── Markdown renderer ───────────────────────────────────────────────────────

/**
 * Render a scheduler dry-run result as human-readable Markdown.
 */
export function renderSchedulerDryRunMarkdown(result: SchedulerDryRunResult): string {
  const lines: string[] = [];

  lines.push("# Scheduler Dry-Run Report");
  lines.push("");
  lines.push(`- **Kind:** ${result.kind}`);
  lines.push(`- **Generated at:** ${result.generatedAt}`);
  lines.push(`- **Task type:** ${result.taskProfile.taskType}`);
  lines.push(`- **Workspace:** ${result.taskProfile.workspaceId ?? "—"}`);
  lines.push(`- **Target environment:** ${result.taskProfile.targetEnvironment ?? "—"}`);
  lines.push(`- **Prefer validation worker:** ${result.taskProfile.preferValidationWorker ?? "—"}`);
  lines.push(`- **Candidates evaluated:** ${result.workerCount}`);
  if (result.implementationLaneReadiness) {
    const readiness = result.implementationLaneReadiness;
    lines.push(`- **Implementation runtime pin:** ${readiness.requiredRuntime ?? "any verified runtime"}`);
    lines.push(`- **Implementation provider pin:** ${readiness.requiredProviderId ?? "any recorded provider"}`);
    lines.push(`- **Implementation model tier pin:** ${readiness.requiredModelTier ?? "any recorded tier"}`);
    lines.push(`- **Implementation redundancy:** ${readiness.eligibleWorkerCount}/${readiness.minimumReadyWorkers} eligible`);
    lines.push(`- **Implementation single point of failure:** ${readiness.singlePointOfFailure}`);
  }
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(`- **Selected worker:** ${result.recommendation.selectedWorkerId ?? "—"}`);
  lines.push(`- **Provisional:** ${result.recommendation.provisional}`);
  lines.push(`- **Explanation:** ${result.recommendation.explanation}`);
  lines.push("");
  lines.push("## Worker Evaluations");
  lines.push("");

  for (const eval_ of result.workerEvaluations) {
    const statusIcon = eval_.recommended ? "✅" : "❌";
    lines.push(`### ${statusIcon} ${eval_.workerId}${eval_.workerName ? ` (${eval_.workerName})` : ""}`);
    lines.push("");
    lines.push(`- **Role:** ${eval_.role}`);
    lines.push(`- **Recommended:** ${eval_.recommended}`);
    lines.push(`- **Summary:** ${eval_.summary}`);
    lines.push("");
    lines.push("| Constraint | Verdict | Reason |");
    lines.push("|---|---|---|");
    for (const con of eval_.constraints) {
      const verdictIcon = con.verdict === "pass" ? "✅" : con.verdict === "fail" ? "❌" : con.verdict === "warn" ? "⚠️" : "⏭️";
      lines.push(`| ${con.label} | ${verdictIcon} ${con.verdict} | ${con.reason} |`);
    }
    lines.push("");
  }

  if (result.implementationLaneReadiness) {
    lines.push("## Implementation Readiness Matrix");
    lines.push("");
    lines.push("| Worker | Capable | Runtime | Provider | Model tier | Availability | Ready | Eligible |");
    lines.push("|---|---:|---|---|---|---|---:|---:|");
    for (const worker of result.implementationLaneReadiness.workers) {
      lines.push(`| ${worker.workerId} | ${worker.capable} | ${worker.runtime} | ${worker.providerId ?? "—"} | ${worker.modelTier ?? "—"} | ${worker.availability} | ${worker.ready} | ${worker.eligible} |`);
    }
    lines.push("");
  }

  lines.push("## Safety");
  lines.push("");
  lines.push("- **No mutation:** true");
  lines.push("- **No dispatch:** true");
  lines.push("- **No claim:** true");
  lines.push("- **No DB mutation:** true");

  return lines.join("\n");
}
