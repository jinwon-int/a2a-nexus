/**
 * Plugin final go/no-go operator-facing status projection.
 *
 * Issue:  jinwon-int/openclaw-plugin-a2a#265
 * Parent: jinwon-int/openclaw-plugin-a2a#263
 * Run:    a2a-plugin-final-go-no-go-projection-20260511T053000Z
 *
 * Takes an execution plan (or status projection) together with plugin config
 * and health state and produces a definitive, operator-facing GO/NO_GO answer.
 *
 * This is the final projection an operator sees before deciding whether to
 * proceed with source-public execution. It synthesises:
 *  - Execution plan status (from the orchestrator)
 *  - Plugin health (enabled, activated, operator events)
 *  - Preflight results
 *  - Safety invariant confirmation
 *
 * Safety gates:
 *  - Never performs approval, release, or visibility changes
 *  - Never executes live provider sends, deploys, restarts, or terminal ACK
 *  - Never mutates production DB
 *  - All outputs are projection artifacts — no real side effects
 */
import type { A2ABrokerAdapterPluginRuntimeConfig } from "../config.js";
import { resolveA2ABrokerAdapterPluginConfig } from "../config.js";
import type {
  SourcePublicExecutionPlan,
  ExecutionStatusProjection,
} from "./source-public-execution-orchestrator.js";

// ── Public types ────────────────────────────────────────────────────

/** The definitive go/no-go answer. */
export type PluginGoNoGo = "GO" | "NO_GO" | "CONDITIONAL_GO";

/** Operator-facing reason category for the go/no-go decision. */
export type PluginGoNoGoReasonCategory =
  | "execution_plan_ready"
  | "execution_plan_blocked"
  | "preflight_failed"
  | "plugin_disabled"
  | "plugin_not_activated"
  | "operator_gates_pending"
  | "safety_invariant_violation"
  | "hard_blocker_detected";

/** A single required operator action before GO can be reached. */
export type RequiredOperatorAction = {
  /** What the operator must do. */
  action: string;
  /** Why this action is needed. */
  reason: string;
  /** Whether this action is blocking (true) or advisory (false). */
  blocking: boolean;
};

/** The final plugin-level go/no-go projection for the operator. */
export type PluginGoNoGoProjection = {
  schema: "a2a.plugin.go-no-go.projection.v1";
  /** Run identifier. */
  runId: string;
  /** When the projection was produced (epoch ms). */
  producedAt: number;
  /** The definitive answer. */
  goNoGo: PluginGoNoGo;
  /** Human-readable title for the operator. */
  title: string;
  /** Short status line — one sentence for the operator. */
  summary: string;
  /** Why this decision was reached. */
  rationale: string;
  /** Category of the reason for the decision. */
  reasonCategory: PluginGoNoGoReasonCategory;
  /** Plugin health summary. */
  pluginHealth: PluginHealthSummary;
  /** Execution status from the orchestrator, if available. */
  executionStatus?: ExecutionStatusProjection;
  /** Safety invariants confirmation. */
  safetyConfirmation: SafetyConfirmation;
  /** Required operator actions before GO. */
  requiredActions: RequiredOperatorAction[];
  /** Warnings the operator should be aware of. */
  warnings: string[];
  /** Arbitrary metadata for operator context. */
  metadata: Record<string, unknown>;
};

/** Summary of plugin health for the operator. */
export type PluginHealthSummary = {
  /** Whether the plugin is enabled. */
  enabled: boolean;
  /** Whether the plugin is explicitly activated (allowlisted or enabled: true). */
  explicitlyActivated: boolean;
  /** Whether operator events are enabled. */
  operatorEventsEnabled: boolean;
  /** Whether a broker baseUrl is configured. */
  brokerConfigured: boolean;
  /** Summary string for the operator. */
  summary: string;
};

/** Safety invariants confirmation. */
export type SafetyConfirmation = {
  /** All safety invariants hold. */
  confirmed: boolean;
  /** List of invariant labels that are confirmed. */
  invariants: string[];
  /** Whether the projection itself is safe (no live execution). */
  projectionIsSafe: true;
};

/** Input for the plugin go/no-go projection. */
export type PluginGoNoGoProjectionInput = {
  /** Execution plan from the orchestrator. */
  executionPlan?: SourcePublicExecutionPlan;
  /** Execution status projection from the orchestrator. */
  executionStatus?: ExecutionStatusProjection;
  /** Arbitrary metadata for operator context. */
  metadata?: Record<string, unknown>;
};

/** Options for go/no-go projection. */
export type PluginGoNoGoProjectionOptions = {
  runId?: string;
  now?: () => number;
};

// ── Constants ───────────────────────────────────────────────────────

const SAFETY_INVARIANTS_LABELS: string[] = [
  "No live execution",
  "No visibility change",
  "No approval execution",
  "No release publication",
  "No provider send",
  "No terminal ACK",
  "No deploy",
  "No DB mutation",
  "Operator-gated",
];

// ── Public API ──────────────────────────────────────────────────────

/**
 * Project the final plugin go/no-go status for the operator.
 *
 * This synthesises the execution plan (or status projection) with plugin
 * config/health state and produces a definitive operator-facing answer.
 *
 * The function answers the question: "Can the operator safely proceed with
 * source-public execution?" with one of:
 *  - GO:            All gates passed, ready for operator action
 *  - NO_GO:         Hard blockers prevent execution; remediation required
 *  - CONDITIONAL_GO: Execution possible but operator must resolve pending gates
 *
 * This is a pure projection — it never executes, sends, deploys, or mutates.
 *
 * @param input   Execution plan or status projection + optional metadata
 * @param config  Plugin runtime config
 * @param options Optional runId and clock overrides
 * @returns       The definitive go/no-go projection for the operator
 */
export function projectPluginGoNoGo(
  input: PluginGoNoGoProjectionInput,
  config: A2ABrokerAdapterPluginRuntimeConfig,
  options: PluginGoNoGoProjectionOptions = {},
): PluginGoNoGoProjection {
  const now = options.now ?? Date.now;
  const runId = options.runId ?? `plugin-go-nogo-${now()}`;
  const producedAt = now();

  const resolved = resolveA2ABrokerAdapterPluginConfig(config);
  const plan = input.executionPlan;
  const status = input.executionStatus ?? (plan ? undefined : undefined);
  const metadata = input.metadata ?? {};

  // 1. Plugin health summary
  const pluginHealth = buildPluginHealthSummary(resolved);

  // 2. Safety confirmation
  const safetyConfirmation = buildSafetyConfirmation(plan);

  // 3. Compute the go/no-go decision
  const { goNoGo, reasonCategory, rationale, requiredActions, warnings } =
    computeGoNoGo(pluginHealth, safetyConfirmation, plan, status);

  // 4. Build title and summary
  const { title, summary } = buildTitleAndSummary(goNoGo, reasonCategory, plan, pluginHealth);

  return {
    schema: "a2a.plugin.go-no-go.projection.v1",
    runId,
    producedAt,
    goNoGo,
    title,
    summary,
    rationale,
    reasonCategory,
    pluginHealth,
    executionStatus: status,
    safetyConfirmation,
    requiredActions,
    warnings,
    metadata,
  };
}

// ── Plugin health ───────────────────────────────────────────────────

function buildPluginHealthSummary(
  resolved: ReturnType<typeof resolveA2ABrokerAdapterPluginConfig>,
): PluginHealthSummary {
  const brokerConfigured = Boolean(resolved.baseUrl);

  let healthSummary: string;
  if (!resolved.enabled) {
    healthSummary = "plugin is disabled — no operations possible";
  } else if (!resolved.explicitlyActivated) {
    healthSummary = "plugin is enabled but not explicitly activated (not allowlisted and enabled:true)";
  } else if (!brokerConfigured) {
    healthSummary = "plugin is active but no broker baseUrl configured";
  } else if (!resolved.operatorEventsEnabled) {
    healthSummary = "plugin is active, broker reachable, but operator events are off";
  } else {
    healthSummary = "plugin fully active with operator events enabled";
  }

  return {
    enabled: resolved.enabled,
    explicitlyActivated: resolved.explicitlyActivated,
    operatorEventsEnabled: resolved.operatorEventsEnabled,
    brokerConfigured,
    summary: healthSummary,
  };
}

// ── Safety confirmation ─────────────────────────────────────────────

function buildSafetyConfirmation(
  plan?: SourcePublicExecutionPlan,
): SafetyConfirmation {
  // Without an execution plan, invariants are still confirmed for projection
  if (!plan) {
    return {
      confirmed: true,
      invariants: SAFETY_INVARIANTS_LABELS,
      projectionIsSafe: true,
    };
  }

  const si = plan.safetyInvariants;
  const invariants: string[] = [];
  let allConfirmed = true;

  const check = (label: string, passes: boolean) => {
    if (passes) {
      invariants.push(`✅ ${label}`);
    } else {
      invariants.push(`❌ ${label}`);
      allConfirmed = false;
    }
  };

  check("No live execution", si.liveExecution === false);
  check("No visibility change", si.visibilityChange === false);
  check("No approval execution", si.noApprovalExecution === true);
  check("No release publication", si.noReleasePublication === true);
  check("No provider send", si.noProviderSend === true);
  check("No terminal ACK", si.noTerminalAck === true);
  check("No deploy", si.noDeploy === true);
  check("No DB mutation", si.noDbMutation === true);
  check("Operator-gated", si.operatorGated === true);

  return {
    confirmed: allConfirmed,
    invariants,
    projectionIsSafe: true,
  };
}

// ── Go/No-Go computation ────────────────────────────────────────────

function computeGoNoGo(
  health: PluginHealthSummary,
  safety: SafetyConfirmation,
  plan?: SourcePublicExecutionPlan,
  status?: ExecutionStatusProjection,
): {
  goNoGo: PluginGoNoGo;
  reasonCategory: PluginGoNoGoReasonCategory;
  rationale: string;
  requiredActions: RequiredOperatorAction[];
  warnings: string[];
} {
  const requiredActions: RequiredOperatorAction[] = [];
  const warnings: string[] = [];

  // ── Phase 0: Plugin disabled or not activated → NO_GO ──────────
  //
  // Evidence notes:
  //  - These failure messages are projection-only evidence. They do not
  //    represent terminal ACK, operator receipt, or live execution.
  //  - Provider send / message-id evidence is handled by the notification
  //    adapter layer, never by the go/no-go projection.
  //  - All `projectionIsSafe: true` is set by the safetyConfirmation.
  //
  if (!health.enabled) {
    return {
      goNoGo: "NO_GO",
      reasonCategory: "plugin_disabled",
      rationale: "Plugin is disabled. Enable the plugin and add it to plugins.allow before any execution. This is projection-only evidence — no provider send, no terminal ACK, no live execution.",
      requiredActions: [
        {
          action: "Enable the A2A Broker Adapter plugin in config",
          reason: "Plugin is currently disabled — enable and allowlist to continue",
          blocking: true,
        },
      ],
      warnings: [],
    };
  }

  if (!health.explicitlyActivated) {
    return {
      goNoGo: "NO_GO",
      reasonCategory: "plugin_not_activated",
      rationale: "Plugin is not explicitly activated. Set enabled:true and add to plugins.allow. This is projection-only evidence — no provider send, no terminal ACK, no live execution.",
      requiredActions: [
        {
          action: "Explicitly activate the plugin (plugins.allow or enabled:true)",
          reason: "Plugin must be allowlisted and enabled for execution — currently not activated",
          blocking: true,
        },
      ],
      warnings: [],
    };
  }

  if (!health.brokerConfigured) {
    warnings.push("No broker baseUrl configured — broker operations will fail until configured");
  }

  // ── Phase 1: No execution plan → conditional ───────────────────
  if (!plan) {
    if (!status) {
      return {
        goNoGo: "CONDITIONAL_GO",
        reasonCategory: "operator_gates_pending",
        rationale: "No execution plan provided. Run the source-public execution orchestrator first to produce a plan. This is projection-only evidence — no provider send, no terminal ACK, no live execution.",
        requiredActions: [
          {
            action: "Run source-public approval rehearsal and execution orchestrator",
            reason: "An execution plan is required before GO can be determined — no plan available",
            blocking: true,
          },
        ],
        warnings,
      };
    }

    // Have status projection but no plan — derive from status
    return computeFromStatus(status, health, safety, warnings);
  }

  // ── Phase 2: Execute plan evaluation ───────────────────────────
  return computeFromPlan(plan, health, safety, warnings, requiredActions);
}

function computeFromPlan(
  plan: SourcePublicExecutionPlan,
  health: PluginHealthSummary,
  safety: SafetyConfirmation,
  warnings: string[],
  requiredActions: RequiredOperatorAction[],
): {
  goNoGo: PluginGoNoGo;
  reasonCategory: PluginGoNoGoReasonCategory;
  rationale: string;
  requiredActions: RequiredOperatorAction[];
  warnings: string[];
} {
  // Safety invariant check
  //
  // Evidence note: safety invariant failure never implies provider send or
  // terminal ACK. The rationale explicitly states this is a projection.
  if (!safety.confirmed) {
    const violatedInvariants = safety.invariants.filter((i) => i.startsWith("❌"));
    return {
      goNoGo: "NO_GO",
      reasonCategory: "safety_invariant_violation",
      rationale: `One or more safety invariants are violated: ${violatedInvariants.length} failed. Execution is blocked until all invariants are confirmed. This is projection-only evidence — no provider send, no terminal ACK, no live execution.`,
      requiredActions: [
        {
          action: "Verify and restore all safety invariants",
          reason: `Safety invariants have been violated (${violatedInvariants.length} failed) — execution cannot proceed`,
          blocking: true,
        },
      ],
      warnings,
    };
  }

  // NO_GO from execution plan
  //
  // Evidence note: "No provider send" and "No terminal ACK" invariants shown
  // in the safetyConfirmation block. The rationale below is projection-only.
  if (plan.decision === "NO_GO") {
    const preflightFailures = plan.preflight.failures.length > 0
      ? ` Preflight failures: ${plan.preflight.failures.join("; ")}.`
      : "";
    return {
      goNoGo: "NO_GO",
      reasonCategory: "hard_blocker_detected",
      rationale: `Execution plan is NO_GO. ${plan.decisionRationale}${preflightFailures} This is projection-only evidence — no provider send, no terminal ACK, no live execution.`,
      requiredActions: [
        {
          action: "Resolve hard-blocker gate failures and re-run rehearsal",
          reason: `${plan.decisionRationale} — hard blocker prevents execution`,
          blocking: true,
        },
      ],
      warnings,
    };
  }

  // Preflight failures
  //
  // Evidence note: preflight failures are projection checks only.
  // Provider-accepted evidence is never used as terminal ACK here.
  if (!plan.preflight.passed) {
    return {
      goNoGo: "NO_GO",
      reasonCategory: "preflight_failed",
      rationale: `Preflight checks failed: ${plan.preflight.failures.join("; ")}. Remediation required before execution. This is projection-only evidence — no provider send, no terminal ACK, no live execution.`,
      requiredActions: plan.preflight.checks
        .filter((c) => !c.passed && c.required && c.remediation)
        .map((c) => ({
          action: c.remediation!,
          reason: c.message,
          blocking: true,
        })),
      warnings,
    };
  }

  // NEEDS_OPERATOR_APPROVAL
  if (plan.decision === "NEEDS_OPERATOR_APPROVAL") {
    const operatorGatedSteps = plan.steps.filter((s) => s.operatorGated);
    const pendingGates = plan.sourcePacket.approvalPayload.failedGates;

    const actions: RequiredOperatorAction[] = [
      {
        action: `Review and approve ${operatorGatedSteps.length} operator-gated step(s)`,
        reason: `Plan requires operator approval for: ${operatorGatedSteps.map((s) => s.kind).join(", ")}`,
        blocking: true,
      },
    ];

    if (pendingGates.length > 0) {
      actions.push({
        action: `Resolve or waive pending gates: ${pendingGates.join(", ")}`,
        reason: "These gates must be addressed before execution can proceed",
        blocking: true,
      });
    }

    return {
      goNoGo: "CONDITIONAL_GO",
      reasonCategory: "operator_gates_pending",
      rationale: `Execution plan is NEEDS_OPERATOR_APPROVAL. ${plan.decisionRationale}`,
      requiredActions: actions,
      warnings: [
        ...warnings,
        `${operatorGatedSteps.length} step(s) require explicit operator approval`,
      ],
    };
  }

  // GO_CANDIDATE → GO
  //
  // Evidence note: GO status means the projection gates all passed. It does
  // not mean a provider send was performed, a terminal ACK was recorded, or
  // live execution happened. The safetyConfirmation block documents the
  // invariant state (No provider send, No terminal ACK, No live execution).
  const operatorGatedSteps = plan.steps.filter((s) => s.operatorGated);
  const neverExecuteSteps = plan.steps.filter((s) => s.simulateOnly);

  const actions: RequiredOperatorAction[] = [];
  if (operatorGatedSteps.length > 0) {
    actions.push({
      action: `Acknowledge ${operatorGatedSteps.length} operator-gated step(s)`,
      reason: "Operator-gated steps require acknowledgment before execution — this is projection-only evidence",
      blocking: true,
    });
  }

  if (!health.operatorEventsEnabled) {
    warnings.push("Operator events are disabled — terminal receipt monitoring is unavailable");
  }

  return {
    goNoGo: "GO",
    reasonCategory: "execution_plan_ready",
    rationale: `GO: all required gates passed. ${operatorGatedSteps.length} operator-gated step(s) and ${neverExecuteSteps.length} simulated-only step(s) in the execution plan. This is projection-only evidence — no provider send, no terminal ACK, no live execution.`,
    requiredActions: actions,
    warnings: [...warnings, `${neverExecuteSteps.length} step(s) are simulated-only and never executed in this round`],
  };
}

function computeFromStatus(
  status: ExecutionStatusProjection,
  health: PluginHealthSummary,
  safety: SafetyConfirmation,
  warnings: string[],
): {
  goNoGo: PluginGoNoGo;
  reasonCategory: PluginGoNoGoReasonCategory;
  rationale: string;
  requiredActions: RequiredOperatorAction[];
  warnings: string[];
} {
  if (!safety.confirmed) {
    return {
      goNoGo: "NO_GO",
      reasonCategory: "safety_invariant_violation",
      rationale: "Safety invariants are not confirmed from provided status.",
      requiredActions: [
        {
          action: "Provide a full execution plan to verify safety invariants",
          reason: "Safety invariants cannot be confirmed from status projection alone",
          blocking: true,
        },
      ],
      warnings,
    };
  }

  switch (status.status) {
    case "blocked":
      return {
        goNoGo: "NO_GO",
        reasonCategory: "hard_blocker_detected",
        rationale: `Execution is blocked: ${status.summary}`,
        requiredActions: [
          {
            action: "Resolve hard blockers and re-run rehearsal",
            reason: status.summary,
            blocking: true,
          },
        ],
        warnings,
      };
    case "needs_attention":
      return {
        goNoGo: "NO_GO",
        reasonCategory: "preflight_failed",
        rationale: `Execution needs attention: ${status.summary}`,
        requiredActions: [
          {
            action: "Address preflight failures and re-run orchestrator",
            reason: status.summary,
            blocking: true,
          },
        ],
        warnings,
      };
    case "awaiting_operator":
      return {
        goNoGo: "CONDITIONAL_GO",
        reasonCategory: "operator_gates_pending",
        rationale: `Awaiting operator: ${status.summary}`,
        requiredActions: [
          {
            action: `Review and approve ${status.operatorGatedStepCount} operator-gated step(s)`,
            reason: status.summary,
            blocking: true,
          },
        ],
        warnings,
      };
    case "ready":
      return {
        goNoGo: "GO",
        reasonCategory: "execution_plan_ready",
        rationale: `Ready: ${status.summary}`,
        requiredActions: status.operatorGatedStepCount > 0
          ? [
              {
                action: `Acknowledge ${status.operatorGatedStepCount} operator-gated step(s)`,
                reason: "Operator acknowledgment required before execution",
                blocking: true,
              },
            ]
          : [],
        warnings: [...warnings, `${status.simulateOnlyStepCount} step(s) are simulated-only and never executed`],
      };
    default:
      return {
        goNoGo: "NO_GO",
        reasonCategory: "execution_plan_blocked",
        rationale: `Unknown execution status: ${status.status}`,
        requiredActions: [
          {
            action: "Re-run the execution orchestrator to get a valid status",
            reason: `Unknown status level: ${status.status}`,
            blocking: true,
          },
        ],
        warnings,
      };
  }
}

// ── Title and summary ───────────────────────────────────────────────

function buildTitleAndSummary(
  goNoGo: PluginGoNoGo,
  reasonCategory: PluginGoNoGoReasonCategory,
  plan?: SourcePublicExecutionPlan,
  health?: PluginHealthSummary,
): { title: string; summary: string } {
  switch (goNoGo) {
    case "GO": {
      const repo = plan?.sourcePacket?.repo;
      const title = repo
        ? `✅ GO — Source-Public Execution Ready: ${repo}`
        : "✅ GO — Source-Public Execution Ready";
      const stepCount = plan?.steps.length ?? 0;
      const gatedCount = plan?.steps.filter((s) => s.operatorGated).length ?? 0;
      const summary = `All gates passed. ${stepCount} step(s) planned, ${gatedCount} operator-gated. Operator acknowledgment required before execution. No visibility change has occurred — this is a dry-run projection.`;
      return { title, summary };
    }
    case "NO_GO": {
      const title = "⛔ NO_GO — Source-Public Execution Blocked";
      let summary: string;
      switch (reasonCategory) {
        case "plugin_disabled":
          summary = "Plugin is disabled. Enable the A2A Broker Adapter plugin and add it to plugins.allow before proceeding.";
          break;
        case "plugin_not_activated":
          summary = "Plugin is not explicitly activated. Set enabled:true and add to plugins.allow.";
          break;
        case "preflight_failed":
          summary = `Preflight checks failed${plan ? `: ${plan.preflight.failures.join("; ")}` : "."} Remediation required.`;
          break;
        case "hard_blocker_detected":
          summary = plan
            ? `Hard blockers prevent execution: ${plan.decisionRationale}`
            : "Hard blockers prevent execution. Resolve and re-run rehearsal.";
          break;
        case "safety_invariant_violation":
          summary = "One or more safety invariants are violated. Execution cannot proceed.";
          break;
        default:
          summary = "Execution is blocked. Resolve the blocking issues and re-run rehearsal.";
      }
      return { title, summary };
    }
    case "CONDITIONAL_GO": {
      const title = "⚠️ CONDITIONAL GO — Operator Action Required";
      let summary: string;
      switch (reasonCategory) {
        case "operator_gates_pending":
          summary = plan
            ? `Operator approval required for ${plan.steps.filter((s) => s.operatorGated).length} step(s). Review and acknowledge before execution.`
            : "No execution plan available. Run the orchestrator to produce a plan.";
          break;
        default:
          summary = "Execution may proceed once operator action items are resolved.";
      }
      return { title, summary };
    }
  }
}
