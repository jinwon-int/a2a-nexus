// Source-only dry-run runner around TerminalBriefAutoCloseoutPlanner.
//
// Wraps the fail-closed automatic closeout planner with deterministic
// source-only dry-run semantics. Always runs in "draft" policy mode and
// never permits live action execution, GitHub comment/close, provider
// send, terminal ACK/replay, DB mutation, restart, deploy, release,
// or secret movement.
//
// This module is the safe entrypoint for Team1/Terminal Brief auto-closeout
// dry-run evaluation. It emits typed packets containing the plan, rendered
// markdown, actions, and safety boundary — but never executes live actions.

import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import {
  buildAutoCloseoutPlan,
  renderAutoCloseoutPlanMarkdown,
  type AutoCloseoutPolicyMode,
  type TerminalBriefAutoCloseoutPlan,
  type TerminalBriefAutoCloseoutPlannerInput,
  type TerminalBriefAutoCloseoutPlannerOptions,
} from "./terminal-brief-auto-closeout-planner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalBriefAutoCloseoutDryRunRunnerState =
  | "plan_ready"
  | "plan_blocked"
  | "plan_waiting"
  | "plan_invalid";

export interface TerminalBriefAutoCloseoutDryRunRunnerInput {
  /** Direct planner input. At minimum policyMode + either candidate or finalCountInput. */
  plannerInput: TerminalBriefAutoCloseoutPlannerInput;
  /** Runner-level overrides (not propagated to the planner). */
  runnerOptions?: TerminalBriefAutoCloseoutDryRunRunnerOptions;
}

export interface TerminalBriefAutoCloseoutDryRunRunnerOptions {
  now?: string;
  runId?: string;
  requestedBy?: string;
  lane?: number;
  laneTotal?: number;
  dryRunLabel?: string;
}

export interface TerminalBriefAutoCloseoutDryRunRunnerPacket {
  kind: "a2a-broker.terminal-brief-auto-closeout-dryrun-runner.packet";
  version: 1;
  generatedAt: string;
  runId?: string;
  state: TerminalBriefAutoCloseoutDryRunRunnerState;
  forcedPolicyMode: AutoCloseoutPolicyMode;
  sourceOnlyNoLive: true;
  dryRunOnly: true;
  idempotencyKey: string;
  /** Embedded deterministic plan from the planner. */
  plan: TerminalBriefAutoCloseoutPlan;
  /** Rendered markdown of the plan. */
  markdown: string;
  /** Runner-level metadata. */
  runner: {
    label: string;
    runId?: string;
    requestedBy?: string;
    lane?: number;
    laneTotal?: number;
    dryRunLabel: string;
  };
  /** Safety gates — all forced to safe defaults. */
  safety: {
    policyModeForced: boolean;
    policyModeOverridden: boolean;
    executePermittedForced: boolean;
    gitHubCommentBlocked: boolean;
    gitHubCloseBlocked: boolean;
    providerSendBlocked: boolean;
    terminalAckBlocked: boolean;
    dbMutationBlocked: boolean;
    restartDeployBlocked: boolean;
    releasePublishBlocked: boolean;
    secretMovementBlocked: boolean;
  };
  /** Actions extracted from the planner, with executePermitted flattened to false. */
  actions: TerminalBriefAutoCloseoutDryRunAction[];
  blockers: string[];
  warnings: string[];
  nextActions: string[];
  integrationContract: {
    transport: "json";
    runnerVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    consumesAutoCloseoutPlanner: true;
    executesGitHubComment: false;
    executesGitHubClose: false;
    executesProviderSend: false;
    executesTerminalAck: false;
    executesDbMutation: false;
    executesRestartDeploy: false;
    executesReleasePublish: false;
    executesSecretMovement: false;
  };
  semantics: {
    sourceOnlyNoLive: true;
    dryRunRunnerOnly: true;
    runnerDoesNotExecuteActions: true;
    allActionsHaveExecutePermittedFalse: true;
    performsGitHubMutation: false;
    performsProviderSend: false;
    performsTerminalAck: false;
    performsRuntimeRestartOrDeploy: false;
    performsDbMutation: false;
    createsTaskFlowRecords: false;
    performsHistoricalReplay: false;
    performsReleaseOrPublish: false;
    movesSecretsOrCredentials: false;
  };
}

export interface TerminalBriefAutoCloseoutDryRunAction {
  kind: string;
  label: string;
  requiresApproval: boolean;
  executePermitted: false; // always false in dry-run runner
  detail: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a source-only dry-run runner packet around the fail-closed automatic
 * closeout planner.
 *
 * The runner always:
 * - forces policyMode to "draft" (overriding any input)
 * - sets all executePermitted to false
 * - blocks GitHub comment/close, provider send, terminal ACK/replay, DB
 *   mutation, restart/deploy, release/publish, and secret movement
 *
 * Returns a typed packet containing the embedded deterministic plan, rendered
 * markdown, and safety-enforced actions.
 */
export function buildAutoCloseoutDryRunRunner(
  input: TerminalBriefAutoCloseoutDryRunRunnerInput,
  options: TerminalBriefAutoCloseoutDryRunRunnerOptions = {},
): TerminalBriefAutoCloseoutDryRunRunnerPacket {
  const now = options.now ?? new Date().toISOString();
  const runId = options.runId ?? "dryrun-" + now.replace(/[:.]/g, "-");
  const requestedBy = options.requestedBy ?? input.plannerInput?.parentRoundId ?? "unknown";
  const lane = options.lane ?? input.plannerInput.parentRoundOrder;
  const laneTotal = options.laneTotal ?? input.plannerInput.parentRoundTotal;
  const dryRunLabel = options.dryRunLabel ?? "auto-closeout-dryrun-runner";

  // 1. Force policy mode to "draft" — this is a source-only dry-run runner.
  //    The input may request other modes, but the runner always overrides to
  //    ensure no live action can be generated.
  const rawPolicyMode: AutoCloseoutPolicyMode = "draft";
  const policyModeOverridden = input.plannerInput.policyMode !== "draft"
    && input.plannerInput.policyMode !== undefined;

  const safeInput: TerminalBriefAutoCloseoutPlannerInput = {
    ...input.plannerInput,
    policyMode: rawPolicyMode,
    // Ensure we never have a GitHub token that could be used by future
    // wiring to accidentally execute a live action.
    hasGitHubToken: false,
  };

  // 2. Build the deterministic plan.
  const plannerOptions: TerminalBriefAutoCloseoutPlannerOptions = {};
  if (options.now) plannerOptions.now = options.now;

  let plan: TerminalBriefAutoCloseoutPlan;
  try {
    plan = buildAutoCloseoutPlan(safeInput, plannerOptions);
  } catch (err) {
    // If the planner itself throws, emit a "plan_invalid" packet.
    const errorMsg = err instanceof Error ? err.message : String(err);
    const invalidPlan = buildInvalidPlanPacket(runId, now, rawPolicyMode, errorMsg, safeInput);
    return invalidPlan;
  }

  // 3. Re-render markdown for deterministic output.
  const markdown = renderAutoCloseoutPlanMarkdown(plan);

  // 4. Determine runner state from plan decision.
  const state = runnerStateFor(plan);

  // 5. Flatten actions with enforcements.
  const actions = plan.actions.map((a): TerminalBriefAutoCloseoutDryRunAction => ({
    kind: a.kind,
    label: a.label,
    requiresApproval: a.requiresApproval,
    executePermitted: false as const,
    detail: a.detail + " [dry-run runner: executePermitted forced to false]",
  }));

  // 6. Build safety summary.
  const safety = buildSafetySummary(plan, policyModeOverridden);

  // 7. Build idempotency key.
  const idempotencyKey = buildDryRunRunnerIdempotencyKey(plan, runId, state);

  // 8. Next actions.
  const nextActions = buildNextActions(state);

  return {
    kind: "a2a-broker.terminal-brief-auto-closeout-dryrun-runner.packet",
    version: 1,
    generatedAt: now,
    runId,
    state,
    forcedPolicyMode: rawPolicyMode,
    sourceOnlyNoLive: true,
    dryRunOnly: true,
    idempotencyKey,
    plan,
    markdown,
    runner: {
      label: "Terminal Brief auto-closeout dry-run runner",
      runId,
      requestedBy,
      lane,
      laneTotal,
      dryRunLabel,
    },
    safety,
    actions,
    blockers: plan.blockers,
    warnings: plan.warnings,
    nextActions,
    integrationContract: {
      transport: "json",
      runnerVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      consumesAutoCloseoutPlanner: true,
      executesGitHubComment: false,
      executesGitHubClose: false,
      executesProviderSend: false,
      executesTerminalAck: false,
      executesDbMutation: false,
      executesRestartDeploy: false,
      executesReleasePublish: false,
      executesSecretMovement: false,
    },
    semantics: {
      sourceOnlyNoLive: true,
      dryRunRunnerOnly: true,
      runnerDoesNotExecuteActions: true,
      allActionsHaveExecutePermittedFalse: true,
      performsGitHubMutation: false,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
      createsTaskFlowRecords: false,
      performsHistoricalReplay: false,
      performsReleaseOrPublish: false,
      movesSecretsOrCredentials: false,
    },
  };
}

/**
 * Render a human-readable summary of the dry-run runner packet,
 * including the embedded plan markdown and runner safety boundary.
 */
export function renderAutoCloseoutDryRunRunnerMarkdown(
  packet: TerminalBriefAutoCloseoutDryRunRunnerPacket,
): string {
  const stateTitle = titleForState(packet.state);

  const lines: string[] = [
    stateTitle,
    "Run ID: " + (packet.runId ?? "unknown"),
    "Forced policy: " + packet.forcedPolicyMode + " (source-only dry-run)",
    "Parent round: " + (packet.plan.parentRoundId ?? "unknown"),
    "Runner state: " + packet.state + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive + " dryRunOnly=" + packet.dryRunOnly,
    "Idempotency: " + packet.idempotencyKey,
    "Lane: " + (packet.runner.lane ?? "?") + "/" + (packet.runner.laneTotal ?? "?"),
    "",
  ];

  // Safety boundary
  lines.push("Safety boundary:");
  lines.push("- policyModeForced=" + packet.safety.policyModeForced);
  lines.push("- policyModeOverridden=" + packet.safety.policyModeOverridden);
  lines.push("- executePermittedForced=" + packet.safety.executePermittedForced);
  lines.push("- gitHubCommentBlocked=" + packet.safety.gitHubCommentBlocked);
  lines.push("- gitHubCloseBlocked=" + packet.safety.gitHubCloseBlocked);
  lines.push("- providerSendBlocked=" + packet.safety.providerSendBlocked);
  lines.push("- terminalAckBlocked=" + packet.safety.terminalAckBlocked);
  lines.push("- dbMutationBlocked=" + packet.safety.dbMutationBlocked);
  lines.push("- restartDeployBlocked=" + packet.safety.restartDeployBlocked);
  lines.push("- releasePublishBlocked=" + packet.safety.releasePublishBlocked);
  lines.push("- secretMovementBlocked=" + packet.safety.secretMovementBlocked);
  lines.push("");

  // Actions
  const readableActions = packet.actions.map((a) => {
    const execStatus = a.executePermitted === false
      ? "execute_permitted=false"
      : "execute_permitted=true";
    return "- " + a.label + " (" + a.kind + ") requiresApproval=" + a.requiresApproval + " " + execStatus;
  });

  lines.push("Actions (" + packet.actions.length + "):");
  lines.push(...readableActions);
  lines.push("");

  // Blockers
  if (packet.blockers.length > 0) {
    lines.push("Blockers:");
    for (const blocker of packet.blockers) lines.push("- " + blocker);
    lines.push("");
  }

  // Warnings
  if (packet.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of packet.warnings) lines.push("- " + warning);
    lines.push("");
  }

  // Next actions
  lines.push("Next actions:");
  for (const action of packet.nextActions) lines.push("- " + action);
  lines.push("");

  // Embedded plan markdown
  lines.push("---");
  lines.push("Embedded auto-closeout plan:");
  lines.push(packet.markdown);

  // Final safety footer
  lines.push("");
  lines.push("Safety: source-only dry-run runner. Does not execute GitHub comment/close,"
    + " provider send, terminal ACK/replay, DB mutation, restart/deploy, release/publish,"
    + " or secret movement. All actions have executePermitted=false.");

  return lines.join("\n");
}

/**
 * Extract a TerminalBriefAutoCloseoutPlannerInput from an incoming
 * envelope (fixture file or JSON payload).
 */
export function extractAutoCloseoutDryRunRunnerInput(
  input: unknown,
): TerminalBriefAutoCloseoutDryRunRunnerInput {
  const envelope = isRecord(input) ? input : {};

  // Support multiple envelope shapes
  const plannerInput = extractPlannerInput(envelope);
  const runnerOptions = extractRunnerOptions(envelope);

  return { plannerInput, runnerOptions };
}

/**
 * Extract runner-level options from an envelope.
 */
export function extractAutoCloseoutDryRunRunnerOptions(
  input: unknown,
): TerminalBriefAutoCloseoutDryRunRunnerOptions {
  const envelope = isRecord(input) ? input : {};
  return extractRunnerOptions(envelope);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function runnerStateFor(
  plan: TerminalBriefAutoCloseoutPlan,
): TerminalBriefAutoCloseoutDryRunRunnerState {
  switch (plan.decision) {
    case "approved":
      return "plan_ready";
    case "blocked":
      return "plan_blocked";
    case "waiting":
      return "plan_waiting";
    case "policy_denied":
      return "plan_blocked";
    default:
      return "plan_invalid";
  }
}

function buildSafetySummary(
  plan: TerminalBriefAutoCloseoutPlan,
  policyModeOverridden: boolean,
): TerminalBriefAutoCloseoutDryRunRunnerPacket["safety"] {
  return {
    policyModeForced: true,
    policyModeOverridden,
    executePermittedForced: true,
    gitHubCommentBlocked: true,
    gitHubCloseBlocked: true,
    providerSendBlocked: true,
    terminalAckBlocked: true,
    dbMutationBlocked: true,
    restartDeployBlocked: true,
    releasePublishBlocked: true,
    secretMovementBlocked: true,
  };
}

function buildDryRunRunnerIdempotencyKey(
  plan: TerminalBriefAutoCloseoutPlan,
  runId: string,
  state: TerminalBriefAutoCloseoutDryRunRunnerState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-auto-closeout-dryrun-runner",
    planIdempotencyKey: plan.idempotencyKey,
    runId,
    state,
    policyMode: "draft",
  });
  return "auto-closeout-dryrun-runner:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function buildInvalidPlanPacket(
  runId: string,
  now: string,
  forcedPolicyMode: AutoCloseoutPolicyMode,
  errorMsg: string,
  safeInput: TerminalBriefAutoCloseoutPlannerInput,
): TerminalBriefAutoCloseoutDryRunRunnerPacket {
  return {
    kind: "a2a-broker.terminal-brief-auto-closeout-dryrun-runner.packet",
    version: 1,
    generatedAt: now,
    runId,
    state: "plan_invalid",
    forcedPolicyMode,
    sourceOnlyNoLive: true,
    dryRunOnly: true,
    idempotencyKey: "auto-closeout-dryrun-runner:invalid-" + createHash("sha256").update(runId + errorMsg).digest("hex").slice(0, 24),
    plan: buildAutoCloseoutPlan({ ...safeInput, policyMode: "draft" }),
    markdown: "Error building auto-closeout plan: " + errorMsg,
    runner: {
      label: "Terminal Brief auto-closeout dry-run runner",
      runId,
      requestedBy: "unknown",
      dryRunLabel: "auto-closeout-dryrun-runner",
    },
    safety: {
      policyModeForced: true,
      policyModeOverridden: false,
      executePermittedForced: true,
      gitHubCommentBlocked: true,
      gitHubCloseBlocked: true,
      providerSendBlocked: true,
      terminalAckBlocked: true,
      dbMutationBlocked: true,
      restartDeployBlocked: true,
      releasePublishBlocked: true,
      secretMovementBlocked: true,
    },
    actions: [{
      kind: "operator_review",
      label: "investigate planner error: " + errorMsg.slice(0, 200),
      requiresApproval: true,
      executePermitted: false as const,
      detail: "planner threw an exception; the input may be structurally invalid",
    }],
    blockers: [errorMsg],
    warnings: [],
    nextActions: ["fix the planner input and rerun", "inspect the error for structural or semantic issues"],
    integrationContract: {
      transport: "json",
      runnerVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      consumesAutoCloseoutPlanner: true,
      executesGitHubComment: false,
      executesGitHubClose: false,
      executesProviderSend: false,
      executesTerminalAck: false,
      executesDbMutation: false,
      executesRestartDeploy: false,
      executesReleasePublish: false,
      executesSecretMovement: false,
    },
    semantics: {
      sourceOnlyNoLive: true,
      dryRunRunnerOnly: true,
      runnerDoesNotExecuteActions: true,
      allActionsHaveExecutePermittedFalse: true,
      performsGitHubMutation: false,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
      createsTaskFlowRecords: false,
      performsHistoricalReplay: false,
      performsReleaseOrPublish: false,
      movesSecretsOrCredentials: false,
    },
  };
}

function buildNextActions(state: TerminalBriefAutoCloseoutDryRunRunnerState): string[] {
  switch (state) {
    case "plan_ready":
      return [
        "review the deterministic plan, rendered markdown, and safety-enforced actions",
        "the plan is a source-only draft; no operator approval or execution is required from this runner",
        "if operator action is warranted, route through the broker finalizer with a fresh operator-reviews-gate flow",
      ];
    case "plan_blocked":
      return [
        "the planner identified blockers; resolve evidence issues before expecting a ready plan",
        "check the blockers list for missing or conflicting evidence",
        "rerun the dry-run runner after resolving evidence gaps",
      ];
    case "plan_waiting":
      return [
        "the planner is waiting for more signals (final-count or completion watcher data)",
        "check the parent round for additional terminal events or signals",
        "rerun the dry-run runner when more evidence arrives",
      ];
    default:
      return [
        "the dry-run runner produced an invalid state; check the error message for details",
        "fix the input and rerun",
      ];
  }
}

function titleForState(state: TerminalBriefAutoCloseoutDryRunRunnerState): string {
  switch (state) {
    case "plan_ready":
      return "Ready: Terminal Brief auto-closeout dry-run runner — plan ready";
    case "plan_blocked":
      return "Blocked: Terminal Brief auto-closeout dry-run runner — plan blocked";
    case "plan_waiting":
      return "Waiting: Terminal Brief auto-closeout dry-run runner — plan waiting";
    default:
      return "Invalid: Terminal Brief auto-closeout dry-run runner — error";
  }
}

function extractPlannerInput(
  envelope: Record<string, unknown>,
): TerminalBriefAutoCloseoutPlannerInput {
  // Look for nested plannerInput or flat planner fields
  const plannerInput = envelope.plannerInput ?? envelope.autoCloseoutInput ?? envelope.planner;

  if (isRecord(plannerInput)) {
    return plannerInput as unknown as TerminalBriefAutoCloseoutPlannerInput;
  }

  // Fall back to crafting from the envelope directly
  const parentRoundId = stringValue(envelope.parentRoundId);
  const policyMode = envelope.policyMode as AutoCloseoutPolicyMode ?? "draft";
  const finalCountInput = isRecord(envelope.finalCountInput) ? envelope.finalCountInput : {};

  return {
    policyMode,
    parentRoundId,
    parentRoundTotal: numberValue(envelope.parentRoundTotal),
    parentRoundOrder: numberValue(envelope.parentRoundOrder),
    hasGitHubToken: envelope.hasGitHubToken === true,
    ciPassUrls: stringArrayValue(envelope.ciPassUrls),
    evidenceRevisions: isRecord(envelope.evidenceRevisions)
      ? envelope.evidenceRevisions as Record<string, string>
      : undefined,
    operatorOverride: stringValue(envelope.operatorOverride),
    finalCountInput: {
      parentRoundId: stringValue(finalCountInput.parentRoundId) ?? parentRoundId,
      expectedWorkers: stringArrayValue(finalCountInput.expectedWorkers),
      expectedTotal: numberValue(finalCountInput.expectedTotal),
      finalCountSignals: finalCountInput.finalCountSignals as any,
      events: finalCountInput.events as any,
    },
  };
}

function extractRunnerOptions(
  envelope: Record<string, unknown>,
): TerminalBriefAutoCloseoutDryRunRunnerOptions {
  const runner = isRecord(envelope.runner) ? envelope.runner : {};
  const runnerOptions = isRecord(envelope.runnerOptions) ? envelope.runnerOptions : {};
  const options: TerminalBriefAutoCloseoutDryRunRunnerOptions = {};

  // Check runner envelope
  options.runId = stringValue(runner.runId ?? runnerOptions.runId ?? envelope.runId);
  options.now = stringValue(runner.now ?? runnerOptions.now ?? envelope.now);
  options.requestedBy = stringValue(runner.requestedBy ?? runnerOptions.requestedBy ?? envelope.requestedBy);
  options.lane = numberValue(runner.lane ?? runnerOptions.lane ?? envelope.lane);
  options.laneTotal = numberValue(runner.laneTotal ?? runnerOptions.laneTotal ?? envelope.laneTotal);
  options.dryRunLabel = stringValue(runner.dryRunLabel ?? runnerOptions.dryRunLabel ?? envelope.dryRunLabel);

  return options;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

