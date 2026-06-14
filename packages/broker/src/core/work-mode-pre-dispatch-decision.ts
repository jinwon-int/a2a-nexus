import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";
import { optionalString } from "./value-text.js";

export type A2AWorkMode = "solo" | "team1" | "hybrid";
export type A2AWorkModeConfidence = "high" | "medium" | "low";
export type A2AWorkModeAmbiguity = "low" | "medium" | "high";
export type A2AWorkModeUrgency = "normal" | "urgent";
export type A2AWorkModeOptimization = "latency" | "confidence" | "active_effort";
export type A2AWorkerCapacityState = "healthy" | "unknown" | "busy" | "stale" | "degraded";

export type A2AWorkProfile =
  | "narrow_source_fix"
  | "predictable_docs_runbook"
  | "known_path_bug"
  | "ambiguous_rca"
  | "candidate_review"
  | "approval_closeout"
  | "late_supplemental_review"
  | "live_or_sensitive_boundary";

export interface A2AWorkModeTaskProfile {
  taskId?: string;
  repo?: string;
  issueNumber?: number;
  title?: string;
  workProfile: A2AWorkProfile;
  ambiguity?: A2AWorkModeAmbiguity;
  urgency?: A2AWorkModeUrgency;
  desiredOptimization?: A2AWorkModeOptimization;
  hasIndependentEvidenceLanes?: boolean;
  hasMultipleCandidates?: boolean;
  hasConflictingRecommendations?: boolean;
  tightlyCoupledWriteSet?: boolean;
  seoseoOwnsImplementation?: boolean;
  boundedHelperScope?: string[];
}

export interface A2AWorkModeBoundaryProfile {
  liveDeployOrRestart?: boolean;
  dbMutation?: boolean;
  terminalAckOrReplay?: boolean;
  providerSend?: boolean;
  releaseOrVisibilityChange?: boolean;
  credentialOrSecretChange?: boolean;
  approvalSensitiveCloseout?: boolean;
}

export interface A2AWorkModeWorkerSnapshot {
  capacityState?: A2AWorkerCapacityState;
  staleTasks?: number;
  activeRounds?: number;
  snapshotSource?: string;
  snapshotAt?: string;
}

export interface A2AWorkModePreDispatchDecisionInput {
  now?: string;
  task: A2AWorkModeTaskProfile;
  boundaries?: A2AWorkModeBoundaryProfile;
  workers?: A2AWorkModeWorkerSnapshot;
  finalizerOwner?: string;
}

export interface A2AWorkModePreDispatchDecisionPacket {
  kind: "a2a-broker.work-mode-pre-dispatch-decision.packet";
  version: 1;
  generatedAt: string;
  sourceOnlyDecision: true;
  idempotencyKey: string;
  task: A2AWorkModeTaskProfile;
  boundariesInput: Required<A2AWorkModeBoundaryProfile>;
  workers: Required<A2AWorkModeWorkerSnapshot>;
  recommendation: {
    mode: A2AWorkMode;
    confidence: A2AWorkModeConfidence;
    finalizerOwner: string;
    finalizerRequired: true;
    evidenceOnlyHelpers: boolean;
    workerDispatchAllowedByThisPacket: false;
    reasons: string[];
    blockers: string[];
    requiredDispatchFlags: string[];
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
  nextAction: string;
}

export interface A2AWorkModeDecisionEvidence {
  mode: A2AWorkMode;
  idempotencyKey: string;
  finalizerOwner: string;
  generatedAt: string;
  capacityState: A2AWorkerCapacityState;
  capacitySnapshotSource: string;
  capacitySnapshotAt: string;
  sourceOnlyDecision: true;
  workerDispatchAllowedByThisPacket: false;
}

export function extractA2AWorkModePreDispatchDecisionInput(input: unknown): A2AWorkModePreDispatchDecisionInput {
  const envelope = isRecord(input) ? input : {};
  const candidate = isRecord(envelope.workModePreDispatchDecision)
    ? envelope.workModePreDispatchDecision
    : isRecord(envelope.work_mode_pre_dispatch_decision)
      ? envelope.work_mode_pre_dispatch_decision
      : envelope;
  if (!isRecord(candidate)) {
    throw new Error("work-mode pre-dispatch decision input must be an object");
  }
  return {
    now: optionalString(candidate.now),
    task: extractTask(candidate.task),
    boundaries: extractBoundaries(candidate.boundaries),
    workers: extractWorkers(candidate.workers),
    finalizerOwner: optionalString(candidate.finalizerOwner ?? candidate.finalizer_owner),
  };
}

export function buildA2AWorkModePreDispatchDecision(
  input: A2AWorkModePreDispatchDecisionInput,
): A2AWorkModePreDispatchDecisionPacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const task = input.task;
  const boundariesInput = normalizeBoundaries(input.boundaries);
  const workers = normalizeWorkers(input.workers);
  if (workers.snapshotAt === "unknown") workers.snapshotAt = generatedAt;
  const finalizerOwner = input.finalizerOwner ?? "seoseo";
  const context = buildDecisionContext(task, boundariesInput, workers);
  const recommendation = recommendMode(context);

  return {
    kind: "a2a-broker.work-mode-pre-dispatch-decision.packet",
    version: 1,
    generatedAt,
    sourceOnlyDecision: true,
    idempotencyKey: buildIdempotencyKey(input, generatedAt, recommendation.mode),
    task,
    boundariesInput,
    workers,
    recommendation: {
      mode: recommendation.mode,
      confidence: recommendation.confidence,
      finalizerOwner,
      finalizerRequired: true,
      evidenceOnlyHelpers: recommendation.mode !== "solo",
      workerDispatchAllowedByThisPacket: false,
      reasons: recommendation.reasons,
      blockers: recommendation.blockers,
      requiredDispatchFlags: requiredDispatchFlags(recommendation.mode),
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
    nextAction: nextActionFor(recommendation.mode, recommendation.blockers),
  };
}

export function renderA2AWorkModePreDispatchDecisionMarkdown(packet: A2AWorkModePreDispatchDecisionPacket): string {
  return [
    "# A2A work-mode pre-dispatch decision",
    "",
    `- **packet**: ${packet.kind}`,
    `- **generatedAt**: ${packet.generatedAt}`,
    `- **task**: ${formatTask(packet.task)}`,
    `- **recommendedMode**: ${packet.recommendation.mode}`,
    `- **confidence**: ${packet.recommendation.confidence}`,
    `- **finalizer**: ${packet.recommendation.finalizerOwner}`,
    `- **workerDispatchAllowedByThisPacket**: ${packet.recommendation.workerDispatchAllowedByThisPacket}`,
    "",
    "## Reasons",
    "",
    ...packet.recommendation.reasons.map((reason) => `- ${reason}`),
    "",
    "## Blockers",
    "",
    ...(packet.recommendation.blockers.length
      ? packet.recommendation.blockers.map((blocker) => `- ${blocker}`)
      : ["- none"]),
    "",
    "## Required Dispatch Flags",
    "",
    ...(packet.recommendation.requiredDispatchFlags.length
      ? packet.recommendation.requiredDispatchFlags.map((flag) => `- ${flag}`)
      : ["- none"]),
    "",
    "## Safety",
    "",
    "- Source-only decision packet.",
    "- No worker dispatch, service restart, DB mutation, Terminal Brief ACK/replay, provider send, release/visibility change, or credential/secret change was performed.",
    "",
    "## Next Action",
    "",
    packet.nextAction,
  ].join("\n");
}

export function buildA2AWorkModeDecisionEvidence(
  packet: A2AWorkModePreDispatchDecisionPacket,
): A2AWorkModeDecisionEvidence {
  assertA2AWorkModeDecisionPacketForHelpers(packet);
  return {
    mode: packet.recommendation.mode,
    idempotencyKey: packet.idempotencyKey,
    finalizerOwner: packet.recommendation.finalizerOwner,
    generatedAt: packet.generatedAt,
    capacityState: packet.workers.capacityState,
    capacitySnapshotSource: packet.workers.snapshotSource,
    capacitySnapshotAt: packet.workers.snapshotAt,
    sourceOnlyDecision: true,
    workerDispatchAllowedByThisPacket: false,
  };
}

export function assertA2AWorkModeDecisionPacketForHelpers(
  packet: A2AWorkModePreDispatchDecisionPacket,
): void {
  if (packet.kind !== "a2a-broker.work-mode-pre-dispatch-decision.packet") {
    throw new Error("work-mode decision must be a pre-dispatch decision packet");
  }
  if (packet.sourceOnlyDecision !== true) {
    throw new Error("work-mode decision must be source-only");
  }
  if (packet.recommendation.mode === "solo") {
    throw new Error("work-mode decision recommends solo; Team1/hybrid dispatch is blocked");
  }
  if (packet.recommendation.mode !== "team1" && packet.recommendation.mode !== "hybrid") {
    throw new Error("work-mode decision recommendation.mode must be team1 or hybrid");
  }
  if (packet.recommendation.workerDispatchAllowedByThisPacket !== false) {
    throw new Error("work-mode decision must carry workerDispatchAllowedByThisPacket=false");
  }
  if (packet.recommendation.finalizerRequired !== true || !packet.recommendation.finalizerOwner) {
    throw new Error("work-mode decision must name a required finalizer");
  }
}

interface DecisionContext {
  task: A2AWorkModeTaskProfile;
  boundaries: Required<A2AWorkModeBoundaryProfile>;
  workers: Required<A2AWorkModeWorkerSnapshot>;
  hardBoundary: boolean;
  workerHealthy: boolean;
  broadEvidenceUseful: boolean;
  soloDefault: boolean;
  hybridUseful: boolean;
}

interface Recommendation {
  mode: A2AWorkMode;
  confidence: A2AWorkModeConfidence;
  reasons: string[];
  blockers: string[];
}

function buildDecisionContext(
  task: A2AWorkModeTaskProfile,
  boundaries: Required<A2AWorkModeBoundaryProfile>,
  workers: Required<A2AWorkModeWorkerSnapshot>,
): DecisionContext {
  const hardBoundary = boundaries.liveDeployOrRestart
    || boundaries.dbMutation
    || boundaries.terminalAckOrReplay
    || boundaries.providerSend
    || boundaries.releaseOrVisibilityChange
    || boundaries.credentialOrSecretChange
    || task.workProfile === "live_or_sensitive_boundary";
  const workerHealthy = workers.capacityState === "healthy" && workers.staleTasks === 0;
  const broadEvidenceUseful = task.hasIndependentEvidenceLanes === true
    && (task.ambiguity === "high"
      || task.hasMultipleCandidates === true
      || task.hasConflictingRecommendations === true
      || task.workProfile === "candidate_review"
      || task.workProfile === "ambiguous_rca");
  const soloDefault = task.workProfile === "narrow_source_fix"
    || task.workProfile === "predictable_docs_runbook"
    || task.workProfile === "known_path_bug"
    || task.urgency === "urgent"
    || task.tightlyCoupledWriteSet === true;
  const hybridUseful = task.workProfile === "late_supplemental_review"
    || task.workProfile === "approval_closeout"
    || (task.seoseoOwnsImplementation === true && (task.boundedHelperScope?.length ?? 0) > 0);

  return { task, boundaries, workers, hardBoundary, workerHealthy, broadEvidenceUseful, soloDefault, hybridUseful };
}

function recommendMode(context: DecisionContext): Recommendation {
  const blockers = buildBlockers(context);
  if (context.hardBoundary) {
    return {
      mode: "solo",
      confidence: "high",
      reasons: [
        "hard live/secret/release/DB/provider/Terminal boundary requires one approval-aware finalizer",
        "helpers may provide evidence only after explicit approval and scoped instructions",
      ],
      blockers,
    };
  }
  if (!context.workerHealthy) {
    return {
      mode: "solo",
      confidence: context.soloDefault ? "high" : "medium",
      reasons: [
        "worker capacity is not healthy enough for a reliable Team1 or hybrid pre-dispatch",
        "solo avoids stale-lane residue and late evidence cleanup",
      ],
      blockers,
    };
  }
  if (context.hybridUseful) {
    return {
      mode: "hybrid",
      confidence: "medium",
      reasons: [
        "Seoseo should own implementation/finalizer path",
        "bounded helper evidence can reduce risk without handing off closeout authority",
      ],
      blockers,
    };
  }
  if (context.broadEvidenceUseful) {
    return {
      mode: "team1",
      confidence: context.task.workProfile === "candidate_review" ? "high" : "medium",
      reasons: [
        "work can split into independent evidence lanes",
        "ambiguity, multiple candidates, or conflicting recommendations justify broad Team1 evidence",
      ],
      blockers,
    };
  }
  return {
    mode: "solo",
    confidence: context.soloDefault ? "high" : "medium",
    reasons: [
      "task shape does not justify Team1 startup and finalizer cleanup overhead",
      "solo is the benchmark default for narrow, predictable, urgent, or tightly coupled work",
    ],
    blockers,
  };
}

function buildBlockers(context: DecisionContext): string[] {
  const blockers: string[] = [];
  if (context.task.tightlyCoupledWriteSet) blockers.push("tightly_coupled_write_set");
  if (context.task.urgency === "urgent") blockers.push("urgent_known_path_or_operator_facing_work");
  if (!context.workerHealthy) blockers.push(`worker_capacity_${context.workers.capacityState}`);
  if (context.workers.staleTasks > 0) blockers.push("worker_stale_tasks_present");
  if (context.hardBoundary) blockers.push("approval_sensitive_runtime_or_external_boundary");
  return blockers;
}

function requiredDispatchFlags(mode: A2AWorkMode): string[] {
  if (mode === "solo") return [];
  return [
    "one-finalizer-required",
    "evidence-only-helpers",
    "safe-parent-wording",
    "read-only-validation-for-no-change-lanes",
    "allow-no-changes-for-evidence-only-lanes",
  ];
}

function nextActionFor(mode: A2AWorkMode, blockers: string[]): string {
  if (mode === "solo") {
    return blockers.length
      ? "run solo with finalizer ownership; do not dispatch helpers unless blockers are cleared or explicitly scoped"
      : "run solo and record the decision packet in the issue or round notes";
  }
  if (mode === "team1") {
    return "prepare a Team1 dispatch plan with independent evidence lanes, safe parent wording, and Seoseo as finalizer";
  }
  return "prepare a bounded hybrid helper request; Seoseo keeps implementation, merge, and closeout authority";
}

function extractTask(value: unknown): A2AWorkModeTaskProfile {
  if (!isRecord(value)) throw new Error("work-mode pre-dispatch input requires task");
  const workProfile = enumValue(value.workProfile ?? value.work_profile, [
    "narrow_source_fix",
    "predictable_docs_runbook",
    "known_path_bug",
    "ambiguous_rca",
    "candidate_review",
    "approval_closeout",
    "late_supplemental_review",
    "live_or_sensitive_boundary",
  ]);
  if (!workProfile) throw new Error("task.workProfile must be a known work-mode profile");
  return {
    taskId: optionalString(value.taskId ?? value.task_id),
    repo: optionalString(value.repo),
    issueNumber: numberValue(value.issueNumber ?? value.issue_number),
    title: optionalString(value.title),
    workProfile,
    ambiguity: enumValue(value.ambiguity, ["low", "medium", "high"]),
    urgency: enumValue(value.urgency, ["normal", "urgent"]),
    desiredOptimization: enumValue(value.desiredOptimization ?? value.desired_optimization, ["latency", "confidence", "active_effort"]),
    hasIndependentEvidenceLanes: optionalBoolean(value.hasIndependentEvidenceLanes ?? value.has_independent_evidence_lanes),
    hasMultipleCandidates: optionalBoolean(value.hasMultipleCandidates ?? value.has_multiple_candidates),
    hasConflictingRecommendations: optionalBoolean(value.hasConflictingRecommendations ?? value.has_conflicting_recommendations),
    tightlyCoupledWriteSet: optionalBoolean(value.tightlyCoupledWriteSet ?? value.tightly_coupled_write_set),
    seoseoOwnsImplementation: optionalBoolean(value.seoseoOwnsImplementation ?? value.seoseo_owns_implementation),
    boundedHelperScope: stringList(value.boundedHelperScope ?? value.bounded_helper_scope),
  };
}

function extractBoundaries(value: unknown): A2AWorkModeBoundaryProfile | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("boundaries must be an object");
  return {
    liveDeployOrRestart: optionalBoolean(value.liveDeployOrRestart ?? value.live_deploy_or_restart),
    dbMutation: optionalBoolean(value.dbMutation ?? value.db_mutation),
    terminalAckOrReplay: optionalBoolean(value.terminalAckOrReplay ?? value.terminal_ack_or_replay),
    providerSend: optionalBoolean(value.providerSend ?? value.provider_send),
    releaseOrVisibilityChange: optionalBoolean(value.releaseOrVisibilityChange ?? value.release_or_visibility_change),
    credentialOrSecretChange: optionalBoolean(value.credentialOrSecretChange ?? value.credential_or_secret_change),
    approvalSensitiveCloseout: optionalBoolean(value.approvalSensitiveCloseout ?? value.approval_sensitive_closeout),
  };
}

function extractWorkers(value: unknown): A2AWorkModeWorkerSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("workers must be an object");
  return {
    capacityState: enumValue(value.capacityState ?? value.capacity_state, ["healthy", "unknown", "busy", "stale", "degraded"]),
    staleTasks: numberValue(value.staleTasks ?? value.stale_tasks),
    activeRounds: numberValue(value.activeRounds ?? value.active_rounds),
    snapshotSource: optionalString(value.snapshotSource ?? value.snapshot_source),
    snapshotAt: optionalString(value.snapshotAt ?? value.snapshot_at),
  };
}

function normalizeBoundaries(boundaries?: A2AWorkModeBoundaryProfile): Required<A2AWorkModeBoundaryProfile> {
  return {
    liveDeployOrRestart: boundaries?.liveDeployOrRestart ?? false,
    dbMutation: boundaries?.dbMutation ?? false,
    terminalAckOrReplay: boundaries?.terminalAckOrReplay ?? false,
    providerSend: boundaries?.providerSend ?? false,
    releaseOrVisibilityChange: boundaries?.releaseOrVisibilityChange ?? false,
    credentialOrSecretChange: boundaries?.credentialOrSecretChange ?? false,
    approvalSensitiveCloseout: boundaries?.approvalSensitiveCloseout ?? false,
  };
}

function normalizeWorkers(workers?: A2AWorkModeWorkerSnapshot): Required<A2AWorkModeWorkerSnapshot> {
  return {
    capacityState: workers?.capacityState ?? "unknown",
    staleTasks: workers?.staleTasks ?? 0,
    activeRounds: workers?.activeRounds ?? 0,
    snapshotSource: workers?.snapshotSource ?? "manual-input",
    snapshotAt: workers?.snapshotAt ?? "unknown",
  };
}

function buildIdempotencyKey(input: A2AWorkModePreDispatchDecisionInput, generatedAt: string, mode: A2AWorkMode): string {
  const base = JSON.stringify({ input, generatedAt, mode });
  return "a2a-work-mode-pre-dispatch:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function formatTask(task: A2AWorkModeTaskProfile): string {
  const issue = task.repo && task.issueNumber !== undefined ? `${task.repo}#${task.issueNumber}` : task.taskId ?? "untracked";
  return `${issue} (${task.workProfile})`;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

