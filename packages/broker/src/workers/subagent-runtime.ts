/**
 * Dynamic sub-agent runtime construction for the worker (#1601 churn-relief slice).
 *
 * Extracted verbatim from worker.ts: buildSubagentDirectiveEnv,
 * buildDynamicSubagentRuntime, the derive/infer helpers, and their constants.
 * Converts source-only Phase-1 packets into shrink-only per-task runner
 * authorization. worker.ts re-exports the public surface unchanged.
 */
import { createHash } from "node:crypto";
import {
  buildA2AWorkerSubagentOrchestrationPolicy,
  type A2AWorkerSubagentTaskProfile,
} from "a2a-attestation";
import {
  buildA2AWorkerSubagentBudgetCounter,
  extractA2AWorkerSubagentBudgetCounterInput,
} from "a2a-attestation";
import {
  buildA2AWorkerSubagentSpawnGateDecision,
  extractA2AWorkerSubagentSpawnGateDecisionInput,
} from "a2a-attestation";
import { redactSecretsText } from "a2a-attestation";
import {
  buildA2AWorkerSubagentContextBrief,
  extractA2AWorkerSubagentContextBriefInput,
  renderA2AWorkerSubagentContextBriefMarkdown,
} from "../core/worker-subagent-context-brief.js";
import type { TaskRecord } from "../core/types.js";

/**
 * Build the per-task subagent conductor directive env for an external
 * handler (the node-instance agent process, including Docker-contained
 * runs that inherit this env).
 *
 * The node instance is the orchestra conductor: simple tasks are executed
 * directly (budget 0), heavy tasks may fan out to at most the worker cap
 * (default 4) evidence-only subagents with disjoint write sets and a single
 * finalizer. The plan comes from the worker-subagent orchestration policy;
 * an explicit task.payload.subagentProfile wins over the conservative
 * intent-based default profile.
 */
export function buildSubagentDirectiveEnv(
  task: TaskRecord,
  options: { workerId: string; subagentCap: number; executionIsolation?: "isolated" | "shared" },
): Record<string, string> {
  const profile = deriveSubagentTaskProfile(task);
  const packet = buildA2AWorkerSubagentOrchestrationPolicy({
    task: profile,
    executionIsolation: options.executionIsolation,
    host: {
      workerId: options.workerId,
      workerSubagentCap: Math.max(0, Math.min(4, options.subagentCap)),
      activeSubagents: 0,
    },
  });
  return {
    A2A_SUBAGENT_CONDUCTOR: "1",
    A2A_SUBAGENT_MAX: String(packet.decision.parallelismHint),
    A2A_SUBAGENT_ROLES: packet.decision.recommendedSubagents.map((agent) => agent.role).join(","),
    A2A_SUBAGENT_PLAN: JSON.stringify({
      taskId: task.id,
      parallelismHint: packet.decision.parallelismHint,
      recommendedSubagents: packet.decision.recommendedSubagents,
      oneFinalizerRequired: packet.decision.oneFinalizerRequired,
      writeSetIsolationRequired: packet.decision.writeSetIsolationRequired,
      directExecutionAllowed: packet.decision.directExecutionAllowed,
      reducedBy: packet.resourceGate.reducedBy,
    }),
  };
}

export interface DynamicSubagentRuntimeOptions {
  workerId: string;
  subagentCap: number;
  executionIsolation?: "isolated" | "shared";
  fanoutEnabled: boolean;
  /** Which lane's fanout flag the authorized/closed env emits (piri reuse WS1). Default: "claude-code". */
  fanoutFlagKey?: FanoutFlagKey;
  staticRunnerMax: number;
  staticRunnerRoles: string[];
}

/** Lanes with a broker-emitted fanout opt-in flag (piri reuse WS1, #1836 WS1). */
export type FanoutFlagKey = "claude-code" | "piri";

export const FANOUT_FLAG_ENV_KEYS: Record<FanoutFlagKey, string> = {
  "claude-code": "A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED",
  piri: "A2A_DOCKER_RUNNER_PIRI_FANOUT_ENABLED",
};

/** Resolve the active lane from the runner env. Deterministic tie-break:
 * claude-code wins if both flags are set (the runner emits exactly one). */
export function resolveActiveFanoutFlagKey(env: NodeJS.ProcessEnv): FanoutFlagKey | undefined {
  if (env[FANOUT_FLAG_ENV_KEYS["claude-code"]] === "1") return "claude-code";
  if (env[FANOUT_FLAG_ENV_KEYS.piri] === "1") return "piri";
  return undefined;
}

export interface DynamicSubagentRuntime {
  env: Record<string, string>;
  subagentContextBrief?: string;
}

const CLOSED_DYNAMIC_SUBAGENT_ENV = {
  A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: "0",
  A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES: "",
  A2A_SUBAGENT_CONDUCTOR: "1",
  A2A_SUBAGENT_MAX: "0",
  A2A_SUBAGENT_ROLES: "",
} as const;

const DYNAMIC_SUBAGENT_ROLES = new Set(["explorer", "implementer", "verifier"]);
const SUBAGENT_CONTEXT_BRIEF_PATH = "/work/artifacts/context-brief.md";

function isSafeAuthorizedWriteSetPath(value: string): boolean {
  const path = value.trim();
  if (!path || Buffer.byteLength(path, "utf8") > 512) return false;
  if (redactSecretsText(path) !== path) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) return false;
  return !path.replace(/\\/g, "/").split("/").includes("..");
}

/** Convert source-only Phase-1 packets into shrink-only per-task runner authorization. */
export function buildDynamicSubagentRuntime(
  task: TaskRecord,
  options: DynamicSubagentRuntimeOptions,
): DynamicSubagentRuntime {
  if (!options.fanoutEnabled) return { env: {} };
  const fanoutFlagEnv = FANOUT_FLAG_ENV_KEYS[options.fanoutFlagKey ?? "claude-code"];
  const closedEnvBase = (): Record<string, string> => ({
    ...CLOSED_DYNAMIC_SUBAGENT_ENV,
    [fanoutFlagEnv]: "0",
  });

  const staticRunnerMax = Number.isInteger(options.staticRunnerMax)
    ? Math.max(0, Math.min(4, options.staticRunnerMax))
    : 0;
  const staticRunnerRoles = [...new Set(options.staticRunnerRoles)]
    .filter((role) => DYNAMIC_SUBAGENT_ROLES.has(role));
  const plan = (fields: Record<string, unknown>) => JSON.stringify({
    version: 1,
    workerId: options.workerId,
    taskId: task.id,
    oneFinalizerRequired: true,
    writeSetIsolationRequired: true,
    staticRunnerMax,
    staticRunnerRoles,
    ...fields,
  });
  const closed = (reason: string, fields: Record<string, unknown> = {}): DynamicSubagentRuntime => ({
    env: {
      ...closedEnvBase(),
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS: reason,
      A2A_SUBAGENT_PLAN: plan({
        state: "refused",
        reason,
        authorizedSubagentCount: 0,
        ...fields,
      }),
    },
  });

  if (staticRunnerMax === 0 || staticRunnerRoles.length === 0) {
    return closed("static_runner_policy_refused");
  }

  const approval = task.approval;
  const approvalRole = approval?.actorRole ?? approval?.requesterRole;
  if (
    !approval
    || typeof approval.approvalId !== "string"
    || approval.approvalId.length === 0
    || typeof approval.approvedAt !== "string"
    || typeof approval.approvedBy !== "string"
    || (approvalRole !== "operator" && approvalRole !== "hub")
  ) {
    return closed("broker_approval_missing_or_untrusted", { approvalState: "missing-or-untrusted" });
  }

  const payload = (task.payload ?? {}) as Record<string, unknown>;
  const budgetInput = payload.workerSubagentBudgetCounter ?? payload.budgetCounter;
  const authorizationInput = payload.spawnAuthorization ?? payload.authorization;
  if (!budgetInput || typeof budgetInput !== "object" || Array.isArray(budgetInput)) {
    return closed("budget_input_missing");
  }
  if (!authorizationInput || typeof authorizationInput !== "object" || Array.isArray(authorizationInput)) {
    return closed("authorization_input_missing");
  }

  try {
    const extractedBudget = extractA2AWorkerSubagentBudgetCounterInput(budgetInput);
    const budget = buildA2AWorkerSubagentBudgetCounter(extractedBudget);
    if (budget.state !== "within-budget") {
      return closed("budget_not_within_ceiling", { budgetState: budget.state });
    }
    if (budget.workerId !== options.workerId) {
      return closed("budget_worker_binding_invalid", { budgetState: budget.state });
    }
    if (extractedBudget.usage.taskId !== task.id) {
      return closed("budget_task_binding_invalid", { budgetState: budget.state });
    }
    const authorizationTaskId = (authorizationInput as Record<string, unknown>).taskId;
    if (authorizationTaskId !== task.id) {
      return closed("authorization_task_binding_invalid", { budgetState: budget.state });
    }

    const profile = deriveSubagentTaskProfile(task);
    const policy = buildA2AWorkerSubagentOrchestrationPolicy({
      task: profile,
      executionIsolation: options.executionIsolation,
      host: {
        workerId: options.workerId,
        workerSubagentCap: Math.max(0, Math.min(4, options.subagentCap)),
        activeSubagents: 0,
      },
    });
    if (policy.decision.parallelismHint === 0) {
      return closed("orchestration_policy_refused", {
        budgetState: budget.state,
        reducedBy: policy.resourceGate.reducedBy,
      });
    }

    const gate = buildA2AWorkerSubagentSpawnGateDecision(extractA2AWorkerSubagentSpawnGateDecisionInput({
      spawnAuthorization: authorizationInput,
      budgetCounter: budget,
      requestedSpawn: {
        subagents: policy.decision.recommendedSubagents.map((agent) => ({
          role: agent.role,
          writeSet: agent.writeSet ? [agent.writeSet] : undefined,
        })),
      },
    }));
    if (gate.state !== "authorized" || gate.authorizedSubagentCount <= 0) {
      return closed("spawn_gate_refused", {
        budgetState: budget.state,
        gateState: gate.state,
        blockers: gate.blockers,
        reviews: gate.reviews,
      });
    }
    if (gate.workerId !== options.workerId) {
      return closed("gate_worker_binding_invalid", { budgetState: budget.state, gateState: gate.state });
    }
    if (gate.taskId !== task.id) {
      return closed("gate_task_binding_invalid", { budgetState: budget.state, gateState: gate.state });
    }

    const authorizedRoles = policy.decision.recommendedSubagents
      .map((agent) => agent.role)
      .filter((role) => staticRunnerRoles.includes(role))
      .slice(0, Math.min(gate.authorizedSubagentCount, staticRunnerMax));
    const authorizedSubagentCount = authorizedRoles.length;
    if (authorizedSubagentCount === 0) {
      return closed("static_runner_role_intersection_empty", {
        budgetState: budget.state,
        gateState: gate.state,
      });
    }
    const authorizedAssignments = policy.decision.recommendedSubagents
      .filter((agent) => authorizedRoles.includes(agent.role))
      .slice(0, authorizedSubagentCount)
      .map((agent) => ({
        role: agent.role,
        objective: agent.purpose,
        writeSet: agent.writeSet ? [agent.writeSet] : undefined,
      }));
    if (authorizedAssignments.some((assignment) =>
      assignment.writeSet?.some((path) => !isSafeAuthorizedWriteSetPath(path)))) {
      return closed("authorized_write_set_invalid", {
        budgetState: budget.state,
        gateState: gate.state,
      });
    }

    const contextInput = payload.workerSubagentContextBrief ?? payload.contextBrief;
    const extractedContext = contextInput && typeof contextInput === "object" && !Array.isArray(contextInput)
      ? extractA2AWorkerSubagentContextBriefInput(contextInput)
      : {
          workerId: options.workerId,
          taskId: task.id,
          summary: task.message,
        };
    const contextPacket = buildA2AWorkerSubagentContextBrief({
      ...extractedContext,
      workerId: options.workerId,
      taskId: task.id,
      assignments: authorizedAssignments,
    });
    const subagentContextBrief = redactSecretsText(
      renderA2AWorkerSubagentContextBriefMarkdown(contextPacket),
    );
    if (Buffer.byteLength(subagentContextBrief, "utf8") > 64 * 1024) {
      return closed("context_brief_too_large", { budgetState: budget.state, gateState: gate.state });
    }

    const reducedBy = [...new Set([
      ...policy.resourceGate.reducedBy,
      ...(authorizedSubagentCount < gate.authorizedSubagentCount ? ["static_runner_policy"] : []),
    ])];
    // The runner validates A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS
    // against its bounded enum (context_heavy / broad_source_inspection /
    // context_overflow_retry / validation_split) at config load, but
    // reducedBy mixes in reduction provenance (shared_workspace,
    // static_runner_policy, host pressure …) that is evidence, not
    // advertising copy. Filter to runner-legal reasons for the env; the
    // unfiltered list stays in the plan evidence. An authorized spawn with
    // nothing legal left advertises context_heavy — the policy only
    // recommends subagents for context/coupling-heavy tasks (field-caught:
    // the pre-fix "authorized"/"shared_workspace" emissions killed every
    // fanout spawn at runner config load, #1836 field canary 2026-08-16).
    const RUNNER_LEGAL_SUBAGENT_REASONS = new Set([
      "context_heavy",
      "broad_source_inspection",
      "context_overflow_retry",
      "validation_split",
    ]);
    const advertisedReasons = reducedBy.filter((reason) => RUNNER_LEGAL_SUBAGENT_REASONS.has(reason));
    const briefDigest = `sha256:${createHash("sha256").update(subagentContextBrief, "utf8").digest("hex")}`;
    const planEvidence = plan({
      state: "authorized",
      approvalRef: approval.approvalId,
      budgetState: budget.state,
      gateState: gate.state,
      requestedSubagentCount: gate.requestedSubagentCount,
      authorizedSubagentCount,
      authorizedRoles,
      authorizedAssignments,
      reducedBy,
      budgetCounterIdempotencyKey: budget.idempotencyKey,
      gateDecisionIdempotencyKey: gate.idempotencyKey,
      briefDigest,
      briefPath: SUBAGENT_CONTEXT_BRIEF_PATH,
    });
    return {
      env: {
        A2A_SUBAGENT_CONDUCTOR: "1",
        A2A_SUBAGENT_MAX: String(authorizedSubagentCount),
        A2A_SUBAGENT_ROLES: authorizedRoles.join(","),
        A2A_SUBAGENT_PLAN: planEvidence,
        [fanoutFlagEnv]: "1",
        A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: String(authorizedSubagentCount),
        A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES: authorizedRoles.join(","),
        // (see advertisedReasons above — never raw reduction provenance)
        A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS: advertisedReasons.join(",") || "context_heavy",
      },
      subagentContextBrief,
    };
  } catch {
    return closed("invalid_runtime_packet");
  }
}

/**
 * Derive a conservative task profile for the orchestration policy.
 * Explicit payload.subagentProfile wins; otherwise patch-shaped intents are
 * treated as conservative independent work with optional write-set inference
 * and everything else as trivial direct work, so a node never fans out for chatter.
 */
function deriveSubagentTaskProfile(task: TaskRecord): A2AWorkerSubagentTaskProfile {
  const payload = (task.payload ?? {}) as Record<string, unknown>;
  const explicit = payload.subagentProfile;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    const candidate = explicit as Record<string, unknown>;
    const size = candidate.size;
    const coupling = candidate.coupling;
    if (
      (size === "trivial" || size === "small" || size === "medium" || size === "large") &&
      (coupling === "low" || coupling === "medium" || coupling === "high")
    ) {
      return {
        taskId: task.id,
        size,
        coupling,
        sensitive: candidate.sensitive === true,
        urgent: candidate.urgent === true,
        hasIndependentSubtasks: candidate.hasIndependentSubtasks === true,
        writeSets: Array.isArray(candidate.writeSets)
          ? candidate.writeSets.filter((entry): entry is string => typeof entry === "string")
          : undefined,
        requiresSingleDesignDecision: candidate.requiresSingleDesignDecision === true,
      };
    }
  }
  const patchShaped =
    task.intent === "propose_patch" ||
    task.intent === "apply_local_change" ||
    task.intent === "validate_change" ||
    task.intent === "backfill";
  if (!patchShaped) return { taskId: task.id, size: "trivial", coupling: "low" };

  const writeSets = inferWriteSets(payload);
  if (writeSets.length >= 2) {
    return { taskId: task.id, size: "large", coupling: "low", hasIndependentSubtasks: true, writeSets };
  }
  if (writeSets.length === 1) {
    return { taskId: task.id, size: "medium", coupling: "low", hasIndependentSubtasks: true, writeSets };
  }
  // Patch-shaped work without enough structural signals stays at the existing
  // conservative two-role explorer/verifier budget. It may investigate in
  // parallel, but it does not infer multiple implementer lanes.
  return { taskId: task.id, size: "medium", coupling: "low", hasIndependentSubtasks: true };
}

function inferWriteSets(payload: Record<string, unknown>): string[] {
  const candidates = [payload.writeSets, payload.write_sets, payload.changedFiles, payload.changed_files, payload.files, payload.filePaths, payload.file_paths];
  const out: string[] = [];
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (!trimmed || trimmed.includes("..")) continue;
      out.push(trimmed);
    }
  }
  return [...new Set(out)].slice(0, 4);
}
