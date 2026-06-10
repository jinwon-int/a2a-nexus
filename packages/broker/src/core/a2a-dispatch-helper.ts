import { createHash } from "node:crypto";
import {
  buildRoundManifest as buildCoreRoundManifest,
  projectRoundManifest,
  type RoundManifest,
  type RoundManifestOptions,
  type RoundManifestProjection,
  type WorkerEvidencePolicy,
  type WorkerRoundAssignment,
} from "./round-manifest.js";
import type { A2AWorkModeDecisionEvidence } from "./work-mode-pre-dispatch-decision.js";

export type A2ADispatchTeamId = "team1" | "team2" | "common";

export interface A2ADispatchSpec {
  teamId: A2ADispatchTeamId;
  lane: number;
  worker: string;
  runId: string;
  parentIssueUrl: string;
  childIssueUrl: string;
  childIssue?: string;
  parentRoundId?: string;
  parentRoundTotal?: number;
  parentRoundOrder?: number;
  assignmentCount?: number;
  /** Actual workers that will receive tasks in this dispatch round. */
  dispatchWorkers?: string[];
  brokerOfRecordId?: string;
  originBrokerId?: string;
  operatorFacingOwner?: "parent" | "child" | "local";
  readOnlyAudit?: boolean;
  readOnlyValidation?: boolean;
  allowNoChanges?: boolean;
  crossBrokerHandoff?: {
    parentRoundId?: string;
    originBrokerId?: string;
    handoffBrokerId?: string;
    originTaskId?: string;
    childWorkerId?: string;
  };
  workModeDecision?: A2AWorkModeDecisionEvidence;
}

export interface A2ADispatchConfig {
  dryRun: boolean;
  execute: boolean;
  now?: string;
}

export interface A2AParentRoundDispatchMetadata {
  parentRoundId: string;
  parentRoundTotal: number;
  parentRoundOrder: number;
  parentRoundTotalSource: "explicit" | "assignment-count" | "team-default" | "dispatch-workers";
  parentRoundOrderSource: "explicit" | "lane" | "dispatch-workers";
}

export interface A2ADispatchTaskPayload {
  taskId: string;
  teamId: A2ADispatchTeamId;
  lane: number;
  worker: string;
  runId: string;
  parentRoundId: string;
  parentRoundTotal: number;
  parentRoundOrder: number;
  dispatchedWorkers?: string[];
  parentIssueUrl: string;
  childIssueUrl: string;
  childIssue?: string;
  brokerOfRecordId?: string;
  originBrokerId?: string;
  operatorFacingOwner?: "parent" | "child" | "local";
  readOnlyAudit?: true;
  allowNoChanges?: true;
  readOnlyValidation?: true;
  crossBrokerHandoff?: {
    parentRoundId: string;
    originBrokerId?: string;
    handoffBrokerId?: string;
    originTaskId?: string;
    childWorkerId?: string;
  };
  workModeDecision?: A2AWorkModeDecisionEvidence;
}

export interface A2ADispatchPlan {
  kind: "a2a-broker.a2a-dispatch-plan.v1";
  version: 1;
  generatedAt: string;
  config: A2ADispatchConfig;
  roundSpec: A2ADispatchSpec;
  deterministicTaskId: {
    taskId: string;
    shortId: string;
    preImage: string;
    idempotent: true;
  };
  decision: {
    value: "go" | "blocked" | "warn_go";
    blockers: string[];
    warnings: string[];
  };
  dispatchActions: string[];
  taskPayload: A2ADispatchTaskPayload | null;
  metadata: {
    parentRoundId: string;
    parentRoundTotal: number;
    parentRoundOrder: number;
    parentRoundTotalSource?: string;
    parentRoundOrderSource?: string;
    readOnlyAudit: boolean;
    allowNoChanges: boolean;
    readOnlyValidation: boolean;
    workModeDecision?: A2AWorkModeDecisionEvidence;
    noLiveImpact: true;
    sourceOnly: true;
  };
  roundManifest: RoundManifest | null;
  roundManifestProjection: RoundManifestProjection | null;
}

const DEFAULT_CONFIG: A2ADispatchConfig = {
  dryRun: true,
  execute: false,
};

const DEFAULT_TEAM_TOTALS: Partial<Record<A2ADispatchTeamId, number>> = {
  team1: 4,
  team2: 4,
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function generatedAtFromRunId(runId: string): string {
  const match = runId.match(/(20\d{2})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  if (!match) return "1970-01-01T00:00:00.000Z";
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

function parseGithubIssueUrl(url: string): { owner: string; repo: string; issueNumber: number } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], issueNumber: Number.parseInt(match[3], 10) };
  } catch {
    return null;
  }
}

function sanitizeText(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/\b(BROKER_EDGE_SECRET|EDGE_SECRET|TOKEN|SECRET)=\S+/gi, (match) => match.split("=")[0] + "=[redacted]")
    .replace(/\/root\/\.openclaw\/[^\s]+/g, "[openclaw-path]");
}

export function resolveA2AParentRoundMetadata(roundSpec: A2ADispatchSpec): {
  metadata?: A2AParentRoundDispatchMetadata;
  issues: string[];
} {
  const issues: string[] = [];
  const parentRoundId = (roundSpec.parentRoundId ?? roundSpec.runId).trim();
  const dispatchWorkers = normalizeWorkerList(roundSpec.dispatchWorkers);
  const teamDefault = DEFAULT_TEAM_TOTALS[roundSpec.teamId];
  const dispatchOrder = dispatchWorkers.indexOf(roundSpec.worker) + 1;
  const parentRoundTotal = dispatchWorkers.length > 0
    ? dispatchWorkers.length
    : roundSpec.parentRoundTotal ?? roundSpec.assignmentCount ?? teamDefault;
  const parentRoundOrder = dispatchOrder > 0
    ? dispatchOrder
    : roundSpec.parentRoundOrder ?? roundSpec.lane;

  if (parentRoundId.length === 0) {
    issues.push("parentRoundId is required; provide --run-id or --parent-round-id");
  }
  if (!isPositiveInteger(parentRoundTotal)) {
    issues.push(
      roundSpec.teamId === "common" && roundSpec.parentRoundTotal === undefined && roundSpec.assignmentCount === undefined
        ? "parentRoundTotal is required for common/ad-hoc dispatch; provide --parent-round-total or --assignment-count"
        : `parentRoundTotal must be a positive integer, got ${String(parentRoundTotal)}`,
    );
  }
  if (!isPositiveInteger(parentRoundOrder)) {
    issues.push(`parentRoundOrder must be a positive integer, got ${String(parentRoundOrder)}`);
  }
  if (isPositiveInteger(parentRoundTotal) && isPositiveInteger(parentRoundOrder) && parentRoundOrder > parentRoundTotal) {
    issues.push(`parentRoundOrder must be <= parentRoundTotal, got ${parentRoundOrder}/${parentRoundTotal}`);
  }
  if (dispatchWorkers.length > 0 && dispatchOrder <= 0) {
    issues.push(`worker must be present in dispatchWorkers, got worker=${roundSpec.worker}`);
  }

  if (issues.length > 0) return { issues };
  if (!isPositiveInteger(parentRoundTotal) || !isPositiveInteger(parentRoundOrder)) return { issues };

  return {
    metadata: {
      parentRoundId,
      parentRoundTotal,
      parentRoundOrder,
      parentRoundTotalSource: dispatchWorkers.length > 0
        ? "dispatch-workers"
        : roundSpec.parentRoundTotal !== undefined
          ? "explicit"
          : roundSpec.assignmentCount !== undefined
            ? "assignment-count"
            : "team-default",
      parentRoundOrderSource: dispatchWorkers.length > 0
        ? "dispatch-workers"
        : roundSpec.parentRoundOrder === undefined ? "lane" : "explicit",
    },
    issues,
  };
}

function normalizeWorkerList(workers: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const worker of workers ?? []) {
    const value = worker.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function buildA2ADispatchTaskId(roundSpec: A2ADispatchSpec, config: A2ADispatchConfig) {
  const parentRound = resolveA2AParentRoundMetadata(roundSpec).metadata;
  const preImage = [
    "a2a-dispatch-helper/v1",
    `teamId=${roundSpec.teamId}`,
    `lane=${String(roundSpec.lane)}`,
    `worker=${roundSpec.worker}`,
    `runId=${roundSpec.runId}`,
    `parentRoundId=${parentRound?.parentRoundId ?? roundSpec.parentRoundId ?? roundSpec.runId}`,
    `parentRoundTotal=${String(parentRound?.parentRoundTotal ?? roundSpec.parentRoundTotal ?? roundSpec.assignmentCount ?? "")}`,
    `parentRoundOrder=${String(parentRound?.parentRoundOrder ?? roundSpec.parentRoundOrder ?? roundSpec.lane)}`,
    `dispatchWorkers=${normalizeWorkerList(roundSpec.dispatchWorkers).join(",")}`,
    `parentIssue=${roundSpec.parentIssueUrl}`,
    `childIssue=${roundSpec.childIssueUrl}`,
    `dryRun=${String(config.dryRun)}`,
    `execute=${String(config.execute)}`,
  ].join("|");
  const hash = createHash("sha256").update(preImage).digest("hex");
  return {
    taskId: `${roundSpec.teamId}-${hash.slice(0, 32)}`,
    shortId: hash.slice(0, 12),
    preImage,
    idempotent: true as const,
  };
}

function buildRoundManifest(roundSpec: A2ADispatchSpec, config: A2ADispatchConfig, taskId: string): {
  manifest: RoundManifest;
  projection: RoundManifestProjection;
} | null {
  const parsed = parseGithubIssueUrl(roundSpec.parentIssueUrl);
  if (!parsed) return null;

  const parentRound = resolveA2AParentRoundMetadata(roundSpec).metadata;
  if (!parentRound) return null;

  const readOnly = roundSpec.readOnlyAudit === true || roundSpec.readOnlyValidation === true || roundSpec.allowNoChanges === true;
  const defaultEvidencePolicy: WorkerEvidencePolicy = readOnly
    ? { requiredTypes: ["done", "block"], minimumRequired: 1 }
    : { requiredTypes: ["pr", "done", "block"], minimumRequired: 1 };
  const worker: WorkerRoundAssignment = {
    workerId: roundSpec.worker,
    lane: roundSpec.lane,
    taskId,
    metadata: {
      parentRoundId: parentRound.parentRoundId,
      parentRoundTotal: String(parentRound.parentRoundTotal),
      parentRoundOrder: String(parentRound.parentRoundOrder),
      ...(roundSpec.brokerOfRecordId ? { brokerOfRecordId: roundSpec.brokerOfRecordId } : {}),
      ...(roundSpec.originBrokerId ? { originBrokerId: roundSpec.originBrokerId } : {}),
      ...(roundSpec.operatorFacingOwner ? { operatorFacingOwner: roundSpec.operatorFacingOwner } : {}),
      ...(readOnly ? { allowNoChanges: "true", readOnlyValidation: "true" } : {}),
      ...(roundSpec.workModeDecision
        ? {
            workModeDecisionMode: roundSpec.workModeDecision.mode,
            workModeDecisionIdempotencyKey: roundSpec.workModeDecision.idempotencyKey,
            workModeDecisionFinalizer: roundSpec.workModeDecision.finalizerOwner,
            workModeDecisionGeneratedAt: roundSpec.workModeDecision.generatedAt,
            workModeDecisionCapacityState: roundSpec.workModeDecision.capacityState,
            workModeDecisionCapacitySnapshotSource: roundSpec.workModeDecision.capacitySnapshotSource,
            workModeDecisionCapacitySnapshotAt: roundSpec.workModeDecision.capacitySnapshotAt,
          }
        : {}),
    },
  };

  const options: RoundManifestOptions = {
    parentRepo: `${parsed.owner}/${parsed.repo}`,
    parentIssueNumber: parsed.issueNumber,
    teamId: roundSpec.teamId,
    runId: roundSpec.runId,
    generatedAt: config.now ?? generatedAtFromRunId(roundSpec.runId),
    expectedWorkers: [worker],
    closeoutPolicy: {
      automaticCloseout: false,
      automaticFinalizer: false,
      requireAllWorkersComplete: true,
      timeoutOnDeadlineExceeded: false,
    },
    defaultEvidencePolicy,
    metadata: {
      childIssueUrl: sanitizeText(roundSpec.childIssueUrl),
      childIssue: roundSpec.childIssue ?? "",
      parentRoundId: parentRound.parentRoundId,
      parentRoundTotal: String(parentRound.parentRoundTotal),
      parentRoundOrder: String(parentRound.parentRoundOrder),
      ...(readOnly ? { allowNoChanges: "true", readOnlyValidation: "true" } : {}),
      ...(roundSpec.workModeDecision
        ? {
            workModeDecisionMode: roundSpec.workModeDecision.mode,
            workModeDecisionIdempotencyKey: roundSpec.workModeDecision.idempotencyKey,
            workModeDecisionFinalizer: roundSpec.workModeDecision.finalizerOwner,
            workModeDecisionGeneratedAt: roundSpec.workModeDecision.generatedAt,
            workModeDecisionCapacityState: roundSpec.workModeDecision.capacityState,
            workModeDecisionCapacitySnapshotSource: roundSpec.workModeDecision.capacitySnapshotSource,
            workModeDecisionCapacitySnapshotAt: roundSpec.workModeDecision.capacitySnapshotAt,
          }
        : {}),
    },
  };
  const manifest = buildCoreRoundManifest(options);
  return { manifest, projection: projectRoundManifest(manifest) };
}

export function buildA2ADispatchPlan(roundSpec: A2ADispatchSpec, config?: Partial<A2ADispatchConfig>): A2ADispatchPlan {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const generatedAt = mergedConfig.now ?? generatedAtFromRunId(roundSpec.runId);
  const parentRound = resolveA2AParentRoundMetadata(roundSpec);
  const deterministicTaskId = buildA2ADispatchTaskId(roundSpec, mergedConfig);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const dispatchActions: string[] = [];

  if (!roundSpec.parentIssueUrl.startsWith("https://github.com/")) {
    blockers.push("[parent_issue_reachable] Parent issue URL must be a GitHub issue URL");
  }
  if (!roundSpec.childIssueUrl.startsWith("https://github.com/")) {
    blockers.push("[child_issue_reachable] Child issue URL must be a GitHub issue URL");
  }
  if (roundSpec.runId.trim().length === 0) {
    blockers.push("[run_id_deterministic] Run ID is empty");
  }
  for (const issue of parentRound.issues) {
    blockers.push(`[parent_round_metadata_populated] ${issue}`);
  }
  if (!mergedConfig.dryRun && mergedConfig.execute) {
    warnings.push("[approval_boundary_respected] Execute mode active; write operations are permitted");
    if ((roundSpec.teamId === "team1" || roundSpec.teamId === "common") && !roundSpec.workModeDecision) {
      blockers.push("[work_mode_decision_evidence] Execute-mode Team1/common dispatch requires --work-mode-decision");
    }
    if (roundSpec.teamId === "team2") {
      const isGwakgaLocal = roundSpec.originBrokerId === "gwakga" && roundSpec.brokerOfRecordId === "gwakga";
      const isGwakgaHandoff = roundSpec.brokerOfRecordId === "gwakga"
        && roundSpec.crossBrokerHandoff?.handoffBrokerId === "gwakga";
      if (!isGwakgaLocal && !isGwakgaHandoff) {
        blockers.push("[team2_broker_of_record_handoff] Execute-mode Team2 dispatch must target Gwakga broker-of-record via explicit crossBrokerHandoff, not local Seoseo /tasks");
      }
    }
  }
  if (roundSpec.workModeDecision) {
    dispatchActions.push(
      `[work-mode] decision: mode=${roundSpec.workModeDecision.mode} finalizer=${sanitizeText(roundSpec.workModeDecision.finalizerOwner)} idempotencyKey=${roundSpec.workModeDecision.idempotencyKey}`,
    );
    dispatchActions.push(
      `[work-mode] capacity: state=${roundSpec.workModeDecision.capacityState} source=${sanitizeText(roundSpec.workModeDecision.capacitySnapshotSource)} at=${roundSpec.workModeDecision.capacitySnapshotAt}`,
    );
  } else {
    dispatchActions.push("[work-mode] decision: not supplied; dry-run planning only");
  }

  dispatchActions.push(`[dispatch] broker /tasks: plan for ${deterministicTaskId.shortId}`);
  if (blockers.length > 0) {
    dispatchActions.push("[dispatch] createTask: blocked by preflight failures");
  } else if (mergedConfig.dryRun || !mergedConfig.execute) {
    dispatchActions.push("[dispatch] dry-run: no task writes performed");
  } else {
    dispatchActions.push(
      `[dispatch] createTask(${deterministicTaskId.taskId}, worker=${roundSpec.worker}, team=${roundSpec.teamId}, lane=${roundSpec.lane}, parentRound=${parentRound.metadata?.parentRoundOrder}/${parentRound.metadata?.parentRoundTotal})`,
    );
  }

  const readOnly = roundSpec.readOnlyAudit === true || roundSpec.readOnlyValidation === true || roundSpec.allowNoChanges === true;
  if (readOnly) {
    dispatchActions.push("[evidence] read-only/evidence lane: allowNoChanges=true readOnlyValidation=true");
  }
  if (parentRound.metadata) {
    dispatchActions.push(
      `[metadata] parent round: id=${sanitizeText(parentRound.metadata.parentRoundId)} order=${parentRound.metadata.parentRoundOrder}/${parentRound.metadata.parentRoundTotal}`,
    );
  }

  const taskPayload: A2ADispatchTaskPayload | null = parentRound.metadata && blockers.length === 0
    ? {
        taskId: deterministicTaskId.taskId,
        teamId: roundSpec.teamId,
        lane: roundSpec.lane,
        worker: roundSpec.worker,
        runId: roundSpec.runId,
        parentRoundId: parentRound.metadata.parentRoundId,
        parentRoundTotal: parentRound.metadata.parentRoundTotal,
        parentRoundOrder: parentRound.metadata.parentRoundOrder,
        ...(roundSpec.dispatchWorkers && roundSpec.dispatchWorkers.length > 0
          ? { dispatchedWorkers: normalizeWorkerList(roundSpec.dispatchWorkers) }
          : {}),
        parentIssueUrl: sanitizeText(roundSpec.parentIssueUrl),
        childIssueUrl: sanitizeText(roundSpec.childIssueUrl),
        childIssue: roundSpec.childIssue,
        brokerOfRecordId: roundSpec.brokerOfRecordId,
        originBrokerId: roundSpec.originBrokerId,
        operatorFacingOwner: roundSpec.operatorFacingOwner,
        workModeDecision: roundSpec.workModeDecision,
        ...(readOnly ? { readOnlyAudit: true as const, allowNoChanges: true as const, readOnlyValidation: true as const } : {}),
        ...(roundSpec.crossBrokerHandoff
          ? {
              crossBrokerHandoff: {
                parentRoundId: roundSpec.crossBrokerHandoff.parentRoundId ?? parentRound.metadata.parentRoundId,
                originBrokerId: roundSpec.crossBrokerHandoff.originBrokerId,
                handoffBrokerId: roundSpec.crossBrokerHandoff.handoffBrokerId,
                originTaskId: roundSpec.crossBrokerHandoff.originTaskId,
                childWorkerId: roundSpec.crossBrokerHandoff.childWorkerId ?? roundSpec.worker,
              },
            }
          : {}),
      }
    : null;

  const manifestResult = buildRoundManifest(roundSpec, mergedConfig, deterministicTaskId.taskId);
  const decision = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warn_go" : "go";

  return {
    kind: "a2a-broker.a2a-dispatch-plan.v1",
    version: 1,
    generatedAt,
    config: mergedConfig,
    roundSpec,
    deterministicTaskId,
    decision: {
      value: decision,
      blockers,
      warnings,
    },
    dispatchActions,
    taskPayload,
    metadata: {
      parentRoundId: parentRound.metadata?.parentRoundId ?? "",
      parentRoundTotal: parentRound.metadata?.parentRoundTotal ?? 0,
      parentRoundOrder: parentRound.metadata?.parentRoundOrder ?? 0,
      parentRoundTotalSource: parentRound.metadata?.parentRoundTotalSource,
      parentRoundOrderSource: parentRound.metadata?.parentRoundOrderSource,
      readOnlyAudit: roundSpec.readOnlyAudit === true,
      allowNoChanges: readOnly,
      readOnlyValidation: readOnly,
      workModeDecision: roundSpec.workModeDecision,
      noLiveImpact: true,
      sourceOnly: true,
    },
    roundManifest: manifestResult?.manifest ?? null,
    roundManifestProjection: manifestResult?.projection ?? null,
  };
}

export function renderA2ADispatchPlanMarkdown(plan: A2ADispatchPlan): string {
  const lines: string[] = [];
  lines.push(`# A2A Dispatch Plan: ${plan.decision.value}`);
  lines.push("");
  lines.push(`- **Kind:** ${plan.kind}`);
  lines.push(`- **Generated at:** ${plan.generatedAt}`);
  lines.push(`- **Team:** ${plan.roundSpec.teamId}`);
  lines.push(`- **Worker:** ${plan.roundSpec.worker}`);
  lines.push(`- **Lane:** ${plan.roundSpec.lane}/${plan.metadata.parentRoundTotal || "unknown"}`);
  lines.push(`- **Parent round:** ${plan.metadata.parentRoundId || "blocked"} (${plan.metadata.parentRoundOrder}/${plan.metadata.parentRoundTotal})`);
  lines.push(`- **Dry-run:** ${plan.config.dryRun}`);
  lines.push(`- **Execute mode:** ${plan.config.execute}`);
  lines.push("");
  lines.push("## Dispatch actions");
  for (const action of plan.dispatchActions) lines.push(`- ${action}`);
  if (plan.decision.blockers.length > 0) {
    lines.push("");
    lines.push("## Blockers");
    for (const blocker of plan.decision.blockers) lines.push(`- ${blocker}`);
  }
  if (plan.decision.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const warning of plan.decision.warnings) lines.push(`- ${warning}`);
  }
  lines.push("");
  lines.push("## Safety boundaries");
  lines.push("- Source/tooling plan only.");
  lines.push("- No deploy, restart, DB mutation, Terminal ACK/replay, provider send, release, or credential change.");
  return lines.join("\n");
}
