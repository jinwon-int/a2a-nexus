import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";
import { optionalBoolean, optionalString } from "./value-text.js";

export type A2AAdaptiveWorkMode = "solo" | "a2a_direct" | "a2a_hybrid" | "a2a_team" | "a2ad";
export type A2AAdaptiveEstimateSize = "small" | "medium" | "large";
export type A2AAdaptiveDuration = "short" | "moderate" | "long";
export type A2AAdaptiveRiskLevel = "low" | "medium" | "high";
export type A2AAdaptiveBrokerHealth = "healthy" | "busy" | "degraded" | "unknown";
export type A2AAdaptiveTaskClass =
  | "short_answer"
  | "single_command"
  | "single_repo_patch"
  | "pr_tests_validation"
  | "multi_node_evidence"
  | "decision_debate"
  | "ops_closeout";

export interface A2AAdaptiveSelectorSignals {
  expectedOutputSize?: A2AAdaptiveEstimateSize;
  estimatedDuration?: A2AAdaptiveDuration;
  riskLevel?: A2AAdaptiveRiskLevel;
  fileCount?: number;
  repoCount?: number;
  nodeCount?: number;
  needsEvidence?: boolean;
  needsValidation?: boolean;
  needsDurableState?: boolean;
  needsPrOrArtifact?: boolean;
  needsOpposition?: boolean;
  approvalGatedLiveAction?: boolean;
  roleSeparable?: boolean;
  explicitDebate?: boolean;
  mobileOrTermuxConstraint?: boolean;
  brokerHealth?: A2AAdaptiveBrokerHealth;
  queuePressure?: A2AAdaptiveBrokerHealth;
}

export interface A2AAdaptiveSelectorInput {
  now?: string;
  task: {
    taskId?: string;
    repo?: string;
    issueNumber?: number;
    title?: string;
    taskClass: A2AAdaptiveTaskClass;
  };
  signals?: A2AAdaptiveSelectorSignals;
  finalizerOwner?: string;
}

export interface A2AAdaptiveSelectorRecord {
  kind: "a2a-broker.adaptive-work-mode-selector.record";
  version: 1;
  generatedAt: string;
  sourceOnlyDecision: true;
  dispatchAllowedByThisRecord: false;
  plannedBeforeModeSelection: true;
  idempotencyKey: string;
  task: A2AAdaptiveSelectorInput["task"];
  selectorInputs: Required<A2AAdaptiveSelectorSignals>;
  decision: {
    workMode: A2AAdaptiveWorkMode;
    reason: string;
    estimatedOutputSize: A2AAdaptiveEstimateSize;
    estimatedDuration: A2AAdaptiveDuration;
    riskLevel: A2AAdaptiveRiskLevel;
    needsEvidence: boolean;
    needsValidation: boolean;
    needsDurableState: boolean;
    roleSplit: string[];
    fallbackMode: A2AAdaptiveWorkMode;
    finalizerOwner: string;
    blockers: string[];
  };
  safetyBoundaries: {
    workerDispatchPerformed: false;
    serviceRestart: false;
    dbMutation: false;
    terminalAckOrReplay: false;
    providerSend: false;
    releaseOrVisibilityChange: false;
    credentialOrSecretChange: false;
  };
}

export function extractA2AAdaptiveSelectorInput(input: unknown): A2AAdaptiveSelectorInput {
  const envelope = isRecord(input) ? input : {};
  const candidate = isRecord(envelope.adaptiveWorkModeSelector)
    ? envelope.adaptiveWorkModeSelector
    : isRecord(envelope.adaptive_work_mode_selector)
      ? envelope.adaptive_work_mode_selector
      : envelope;
  if (!isRecord(candidate)) {
    throw new Error("adaptive work-mode selector input must be an object");
  }
  return {
    now: optionalString(candidate.now),
    task: extractTask(candidate.task),
    signals: extractSignals(candidate.signals),
    finalizerOwner: optionalString(candidate.finalizerOwner ?? candidate.finalizer_owner),
  };
}

export function buildA2AAdaptiveSelectorRecord(input: A2AAdaptiveSelectorInput): A2AAdaptiveSelectorRecord {
  const generatedAt = input.now ?? new Date().toISOString();
  const selectorInputs = normalizeSignals(input.signals, input.task.taskClass);
  const decision = decide(input.task.taskClass, selectorInputs);
  const finalizerOwner = input.finalizerOwner ?? "seoseo";

  return {
    kind: "a2a-broker.adaptive-work-mode-selector.record",
    version: 1,
    generatedAt,
    sourceOnlyDecision: true,
    dispatchAllowedByThisRecord: false,
    plannedBeforeModeSelection: true,
    idempotencyKey: buildIdempotencyKey(input, generatedAt, decision.workMode),
    task: input.task,
    selectorInputs,
    decision: {
      ...decision,
      finalizerOwner,
    },
    safetyBoundaries: {
      workerDispatchPerformed: false,
      serviceRestart: false,
      dbMutation: false,
      terminalAckOrReplay: false,
      providerSend: false,
      releaseOrVisibilityChange: false,
      credentialOrSecretChange: false,
    },
  };
}

export function renderA2AAdaptiveSelectorMarkdown(record: A2AAdaptiveSelectorRecord): string {
  return [
    "# Adaptive A2A work-mode selector record",
    "",
    `- **packet**: ${record.kind}`,
    `- **generatedAt**: ${record.generatedAt}`,
    `- **task**: ${formatTask(record.task)}`,
    `- **workMode**: ${record.decision.workMode}`,
    `- **fallbackMode**: ${record.decision.fallbackMode}`,
    `- **finalizer**: ${record.decision.finalizerOwner}`,
    `- **plannedBeforeModeSelection**: ${record.plannedBeforeModeSelection}`,
    `- **dispatchAllowedByThisRecord**: ${record.dispatchAllowedByThisRecord}`,
    "",
    "## Estimate",
    "",
    `- output: ${record.decision.estimatedOutputSize}`,
    `- duration: ${record.decision.estimatedDuration}`,
    `- risk: ${record.decision.riskLevel}`,
    `- needsEvidence: ${record.decision.needsEvidence}`,
    `- needsValidation: ${record.decision.needsValidation}`,
    `- needsDurableState: ${record.decision.needsDurableState}`,
    "",
    "## Role Split",
    "",
    ...(record.decision.roleSplit.length ? record.decision.roleSplit.map((role) => `- ${role}`) : ["- none"]),
    "",
    "## Reason",
    "",
    record.decision.reason,
    "",
    "## Blockers",
    "",
    ...(record.decision.blockers.length ? record.decision.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "",
    "## Safety",
    "",
    "- Source-only selector record.",
    "- No worker dispatch, service restart, DB mutation, Terminal Brief ACK/replay, provider send, release/visibility change, or credential/secret change was performed.",
  ].join("\n");
}

interface DecisionDraft {
  workMode: A2AAdaptiveWorkMode;
  reason: string;
  estimatedOutputSize: A2AAdaptiveEstimateSize;
  estimatedDuration: A2AAdaptiveDuration;
  riskLevel: A2AAdaptiveRiskLevel;
  needsEvidence: boolean;
  needsValidation: boolean;
  needsDurableState: boolean;
  roleSplit: string[];
  fallbackMode: A2AAdaptiveWorkMode;
  blockers: string[];
}

function decide(taskClass: A2AAdaptiveTaskClass, signals: Required<A2AAdaptiveSelectorSignals>): DecisionDraft {
  const blockers = buildBlockers(signals);
  if (signals.approvalGatedLiveAction || signals.brokerHealth === "degraded") {
    return decision("solo", signals, {
      reason: "approval-gated live action or degraded broker health requires one approval-aware finalizer before any heavy A2A lane",
      roles: ["finalizer"],
      fallbackMode: "solo",
      blockers,
    });
  }
  if (signals.explicitDebate || taskClass === "decision_debate") {
    return decision("a2ad", signals, {
      reason: "the task is primarily a decision or tradeoff, so explicit thesis, antithesis, rebuttal, and synthesis roles improve review quality",
      roles: ["thesis", "antithesis", "rebuttal", "synthesis", "finalizer"],
      fallbackMode: "a2a_hybrid",
      blockers,
    });
  }
  if (signals.nodeCount > 1 || signals.repoCount > 1 || taskClass === "multi_node_evidence") {
    return decision("a2a_team", signals, {
      reason: "multiple repos or nodes need independent evidence lanes, so broker-level workers should contribute separate packets",
      roles: ["evidence", "validation", "finalizer"],
      fallbackMode: "a2a_hybrid",
      blockers,
    });
  }
  if (signals.needsValidation && signals.roleSeparable && signals.expectedOutputSize !== "small") {
    return decision("a2a_hybrid", signals, {
      reason: "one worker should own the task while internal implement, validate, and evidence roles reduce rework before one synthesized packet",
      roles: ["implement", "validate", "evidence", "finalizer"],
      fallbackMode: "a2a_direct",
      blockers,
    });
  }
  if (signals.needsEvidence || signals.needsDurableState || signals.needsPrOrArtifact || taskClass === "single_repo_patch") {
    return decision("a2a_direct", signals, {
      reason: "durable broker tracking and one evidence packet are useful, but the task does not justify internal fanout",
      roles: ["execute", "finalizer"],
      fallbackMode: "solo",
      blockers,
    });
  }
  return decision("solo", signals, {
    reason: "the task is short, low-risk, and does not need durable A2A evidence or role separation",
    roles: ["executor"],
    fallbackMode: "solo",
    blockers,
  });
}

function decision(
  workMode: A2AAdaptiveWorkMode,
  signals: Required<A2AAdaptiveSelectorSignals>,
  options: { reason: string; roles: string[]; fallbackMode: A2AAdaptiveWorkMode; blockers: string[] },
): DecisionDraft {
  return {
    workMode,
    reason: options.reason,
    estimatedOutputSize: signals.expectedOutputSize,
    estimatedDuration: signals.estimatedDuration,
    riskLevel: signals.riskLevel,
    needsEvidence: signals.needsEvidence,
    needsValidation: signals.needsValidation,
    needsDurableState: signals.needsDurableState,
    roleSplit: options.roles,
    fallbackMode: options.fallbackMode,
    blockers: options.blockers,
  };
}

function buildBlockers(signals: Required<A2AAdaptiveSelectorSignals>): string[] {
  const blockers: string[] = [];
  if (signals.approvalGatedLiveAction) blockers.push("approval_required_for_live_or_external_action");
  if (signals.brokerHealth === "degraded") blockers.push("broker_health_degraded");
  if (signals.queuePressure === "degraded" || signals.queuePressure === "busy") blockers.push(`queue_pressure_${signals.queuePressure}`);
  if (signals.mobileOrTermuxConstraint) blockers.push("mobile_or_termux_constraint_requires_capacity_check");
  return blockers;
}

function normalizeSignals(
  signals: A2AAdaptiveSelectorSignals | undefined,
  taskClass: A2AAdaptiveTaskClass,
): Required<A2AAdaptiveSelectorSignals> {
  const defaults = defaultsForTaskClass(taskClass);
  return {
    expectedOutputSize: signals?.expectedOutputSize ?? defaults.expectedOutputSize,
    estimatedDuration: signals?.estimatedDuration ?? defaults.estimatedDuration,
    riskLevel: signals?.riskLevel ?? defaults.riskLevel,
    fileCount: signals?.fileCount ?? defaults.fileCount,
    repoCount: signals?.repoCount ?? defaults.repoCount,
    nodeCount: signals?.nodeCount ?? defaults.nodeCount,
    needsEvidence: signals?.needsEvidence ?? defaults.needsEvidence,
    needsValidation: signals?.needsValidation ?? defaults.needsValidation,
    needsDurableState: signals?.needsDurableState ?? defaults.needsDurableState,
    needsPrOrArtifact: signals?.needsPrOrArtifact ?? defaults.needsPrOrArtifact,
    needsOpposition: signals?.needsOpposition ?? defaults.needsOpposition,
    approvalGatedLiveAction: signals?.approvalGatedLiveAction ?? false,
    roleSeparable: signals?.roleSeparable ?? defaults.roleSeparable,
    explicitDebate: signals?.explicitDebate ?? defaults.explicitDebate,
    mobileOrTermuxConstraint: signals?.mobileOrTermuxConstraint ?? false,
    brokerHealth: signals?.brokerHealth ?? "healthy",
    queuePressure: signals?.queuePressure ?? "healthy",
  };
}

function defaultsForTaskClass(taskClass: A2AAdaptiveTaskClass): Required<A2AAdaptiveSelectorSignals> {
  if (taskClass === "single_repo_patch") {
    return base({ expectedOutputSize: "medium", needsEvidence: true, needsDurableState: true, needsPrOrArtifact: true });
  }
  if (taskClass === "pr_tests_validation") {
    return base({
      expectedOutputSize: "medium",
      estimatedDuration: "moderate",
      riskLevel: "medium",
      needsEvidence: true,
      needsValidation: true,
      needsDurableState: true,
      needsPrOrArtifact: true,
      needsOpposition: true,
      roleSeparable: true,
    });
  }
  if (taskClass === "multi_node_evidence") {
    return base({
      expectedOutputSize: "large",
      estimatedDuration: "long",
      riskLevel: "medium",
      repoCount: 2,
      nodeCount: 2,
      needsEvidence: true,
      needsValidation: true,
      needsDurableState: true,
      roleSeparable: true,
    });
  }
  if (taskClass === "decision_debate") {
    return base({
      expectedOutputSize: "medium",
      riskLevel: "medium",
      needsEvidence: true,
      needsValidation: true,
      needsOpposition: true,
      roleSeparable: true,
      explicitDebate: true,
    });
  }
  if (taskClass === "ops_closeout") {
    return base({
      expectedOutputSize: "large",
      estimatedDuration: "long",
      riskLevel: "high",
      needsEvidence: true,
      needsValidation: true,
      needsDurableState: true,
      roleSeparable: true,
    });
  }
  return base({});
}

function base(overrides: Partial<Required<A2AAdaptiveSelectorSignals>>): Required<A2AAdaptiveSelectorSignals> {
  return {
    expectedOutputSize: "small",
    estimatedDuration: "short",
    riskLevel: "low",
    fileCount: 0,
    repoCount: 1,
    nodeCount: 1,
    needsEvidence: false,
    needsValidation: false,
    needsDurableState: false,
    needsPrOrArtifact: false,
    needsOpposition: false,
    approvalGatedLiveAction: false,
    roleSeparable: false,
    explicitDebate: false,
    mobileOrTermuxConstraint: false,
    brokerHealth: "healthy",
    queuePressure: "healthy",
    ...overrides,
  };
}

function extractTask(value: unknown): A2AAdaptiveSelectorInput["task"] {
  if (!isRecord(value)) throw new Error("adaptive selector input requires task");
  const taskClass = enumValue(value.taskClass ?? value.task_class, [
    "short_answer",
    "single_command",
    "single_repo_patch",
    "pr_tests_validation",
    "multi_node_evidence",
    "decision_debate",
    "ops_closeout",
  ]);
  if (!taskClass) throw new Error("task.taskClass must be a known adaptive selector class");
  return {
    taskId: optionalString(value.taskId ?? value.task_id),
    repo: optionalString(value.repo),
    issueNumber: numberValue(value.issueNumber ?? value.issue_number),
    title: optionalString(value.title),
    taskClass,
  };
}

function extractSignals(value: unknown): A2AAdaptiveSelectorSignals | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("signals must be an object");
  return {
    expectedOutputSize: enumValue(value.expectedOutputSize ?? value.expected_output_size, ["small", "medium", "large"]),
    estimatedDuration: enumValue(value.estimatedDuration ?? value.estimated_duration, ["short", "moderate", "long"]),
    riskLevel: enumValue(value.riskLevel ?? value.risk_level, ["low", "medium", "high"]),
    fileCount: numberValue(value.fileCount ?? value.file_count),
    repoCount: numberValue(value.repoCount ?? value.repo_count),
    nodeCount: numberValue(value.nodeCount ?? value.node_count),
    needsEvidence: optionalBoolean(value.needsEvidence ?? value.needs_evidence),
    needsValidation: optionalBoolean(value.needsValidation ?? value.needs_validation),
    needsDurableState: optionalBoolean(value.needsDurableState ?? value.needs_durable_state),
    needsPrOrArtifact: optionalBoolean(value.needsPrOrArtifact ?? value.needs_pr_or_artifact),
    needsOpposition: optionalBoolean(value.needsOpposition ?? value.needs_opposition),
    approvalGatedLiveAction: optionalBoolean(value.approvalGatedLiveAction ?? value.approval_gated_live_action),
    roleSeparable: optionalBoolean(value.roleSeparable ?? value.role_separable),
    explicitDebate: optionalBoolean(value.explicitDebate ?? value.explicit_debate),
    mobileOrTermuxConstraint: optionalBoolean(value.mobileOrTermuxConstraint ?? value.mobile_or_termux_constraint),
    brokerHealth: enumValue(value.brokerHealth ?? value.broker_health, ["healthy", "busy", "degraded", "unknown"]),
    queuePressure: enumValue(value.queuePressure ?? value.queue_pressure, ["healthy", "busy", "degraded", "unknown"]),
  };
}

function buildIdempotencyKey(input: A2AAdaptiveSelectorInput, generatedAt: string, workMode: A2AAdaptiveWorkMode): string {
  const base = JSON.stringify({ input, generatedAt, workMode });
  return "a2a-adaptive-work-mode:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function formatTask(task: A2AAdaptiveSelectorInput["task"]): string {
  const issue = task.repo && task.issueNumber !== undefined ? `${task.repo}#${task.issueNumber}` : task.taskId ?? "untracked";
  return `${issue} (${task.taskClass})`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

