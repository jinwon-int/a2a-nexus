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

/**
 * #2556: one row of the broker-team registry the brokers run with
 * (`A2A_TERMINAL_BRIEF_BROKER_TEAMS`). Declared here structurally — the
 * dispatch domain does not import the completion domain's routing module; the
 * CLI parses the env value and passes the rows in.
 */
export interface A2ADispatchBrokerTeam {
  brokerId: string;
  teamId: "team1" | "team2";
}

/** Team2's broker when no registry is given: the placeholder topology's id. */
const PLACEHOLDER_TEAM2_BROKER_ID = "brokerbeta";

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
  /**
   * #2556: the broker-team registry the brokers run with
   * (`A2A_TERMINAL_BRIEF_BROKER_TEAMS`, for example
   * `brokeralpha=team1,brokerbeta=team2`). The execute-mode Team2 gate reads
   * the broker that owns Team2 from it. Unset keeps the placeholder default,
   * which only matches a deployment whose brokers carry those placeholder ids.
   */
  brokerTeams?: readonly A2ADispatchBrokerTeam[];
  /**
   * #2556: the minting broker's own record of the handoff's parent round, read
   * after the `[registry]` pre-steps ran — the body of
   * `GET /a2a/parent-rounds/:id` (`{ entry }`, or the bare entry). An
   * execute-mode cross-broker handoff plan is blocked without one that matches
   * the plan. It is input evidence, so the returned plan does not echo it.
   */
  parentRoundRegistrationReceipt?: unknown;
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
  /**
   * #2339 PR-1c (spec item 2): routing scope of the registered parent round,
   * copied from the plan's mint request. The parent checks routing against
   * its registry entry, so these are attribution, not authority.
   */
  teamScope?: string;
  initiatingBrokerId?: string;
  workModeDecision?: A2AWorkModeDecisionEvidence;
}

/**
 * #2339 PR-1b: registry requests the operator (or the executing dispatcher)
 * must run against the minting broker before the child task is created. The
 * helper stays source-only: it prints these requests and performs none of them.
 */
export interface A2AParentRoundRegistrationPlan {
  /** Broker that mints the parent round (the handoff's origin broker). */
  mintingBrokerId: string;
  mint: {
    method: "POST";
    path: "/a2a/parent-rounds";
    body: {
      parentRoundId: string;
      initiatingBrokerId: string;
      teamScope?: string;
      handoffBrokerId?: string;
      parentRoundTotal: number;
    };
  };
  anchors: Array<{ method: "POST"; path: string; body: { anchor: string } }>;
  expect: string;
}

/**
 * #2556: result of comparing the registration receipt with this plan's
 * `[registry]` pre-steps. The receipt enforces the procedure — a dispatch whose
 * parent round was never registered cannot reach execute mode. It is not an
 * authority: the parent broker still judges every projection against its own
 * registry entry and anchors.
 */
export interface A2AParentRoundRegistrationReceiptCheck {
  status: "verified" | "missing" | "invalid";
  /** Why the receipt does not prove the pre-steps ran; empty unless `invalid`. */
  issues: string[];
  /** `mintedAt` of the registry entry, when the receipt carries a valid one. */
  mintedAt?: string;
  /** Plan anchors found in the entry, out of the anchors the plan registers. */
  anchorsRegistered: number;
  anchorsRequired: number;
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
  /**
   * Present for a cross-broker handoff plan that passed the earlier preflight
   * checks (#2339 PR-1b). It stays present when only the registration receipt
   * blocks the plan, so the pre-steps to run are still printed.
   */
  parentRoundRegistration: A2AParentRoundRegistrationPlan | null;
  /** Present whenever `parentRoundRegistration` is (#2556). */
  parentRoundRegistrationReceipt: A2AParentRoundRegistrationReceiptCheck | null;
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

/**
 * A cross-broker handoff must name the origin broker's parent round and task.
 * Falling back to (or reusing) the local parent round makes the child round
 * its own parent, which the parent broker fails closed as `missing_parent`
 * and leaves the Terminal Brief orphaned (#2331).
 */
function crossBrokerHandoffIssues(roundSpec: A2ADispatchSpec, localParentRoundId: string | undefined): string[] {
  const handoff = roundSpec.crossBrokerHandoff;
  if (!handoff) return [];
  const issues: string[] = [];
  const handoffParentRoundId = handoff.parentRoundId?.trim();
  if (!handoffParentRoundId) {
    issues.push("crossBrokerHandoff.parentRoundId is required; provide --handoff-parent-round-id with the origin broker's parent round id");
  } else {
    const localIds = [localParentRoundId, roundSpec.parentRoundId, roundSpec.runId]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    if (localIds.includes(handoffParentRoundId)) {
      issues.push("crossBrokerHandoff.parentRoundId must name the origin broker's parent round, not the local parentRoundId/runId (self-reference)");
    }
  }
  if (!handoff.originTaskId?.trim()) {
    issues.push("crossBrokerHandoff.originTaskId is required; provide --handoff-origin-task-id with the origin broker's parent task id");
  }
  return issues;
}

/** The broker that must mint the handoff's parent round before dispatch (#2339 PR-1b). */
function parentRoundMintingBroker(roundSpec: A2ADispatchSpec): string | undefined {
  return roundSpec.crossBrokerHandoff?.originBrokerId?.trim() || roundSpec.originBrokerId?.trim() || undefined;
}

/**
 * #2556: the team scope the minting broker is asked to register. A broker that
 * runs with a broker-team registry routes the scope from the *initiating*
 * broker: it refuses another team's `teamN-only` scope and accepts
 * `team1+team2` for a round whose child goes to the other team's broker. So
 * with a registry, a handoff to a different team is minted as `team1+team2`.
 * Without one the helper keeps sending the round's team (and omits `common`).
 */
function mintTeamScope(
  roundSpec: A2ADispatchSpec,
  mintingBrokerId: string,
  brokerTeams: readonly A2ADispatchBrokerTeam[] | undefined,
): string | undefined {
  if (roundSpec.teamId === "common") return undefined;
  const mintingTeam = brokerTeams?.find((broker) => sameBrokerId(broker.brokerId, mintingBrokerId))?.teamId;
  return mintingTeam && mintingTeam !== roundSpec.teamId ? "team1+team2" : roundSpec.teamId;
}

function buildParentRoundRegistrationPlan(
  roundSpec: A2ADispatchSpec,
  parentRound: A2AParentRoundDispatchMetadata,
  childTaskId: string,
  brokerTeams?: readonly A2ADispatchBrokerTeam[],
): A2AParentRoundRegistrationPlan | null {
  const handoff = roundSpec.crossBrokerHandoff;
  const parentRoundId = handoff?.parentRoundId?.trim();
  const mintingBrokerId = parentRoundMintingBroker(roundSpec);
  if (!handoff || !parentRoundId || !mintingBrokerId) return null;
  const handoffBrokerId = handoff.handoffBrokerId?.trim();
  const teamScope = mintTeamScope(roundSpec, mintingBrokerId, brokerTeams);
  const anchorPath = `/a2a/parent-rounds/${encodeURIComponent(parentRoundId)}/anchors`;
  const anchors = [handoff.originTaskId?.trim(), childTaskId]
    .filter((anchor): anchor is string => Boolean(anchor))
    .map((anchor) => ({ method: "POST" as const, path: anchorPath, body: { anchor } }));
  return {
    mintingBrokerId,
    mint: {
      method: "POST",
      path: "/a2a/parent-rounds",
      body: {
        parentRoundId,
        initiatingBrokerId: mintingBrokerId,
        // `common` is the helper default, not a team scope (spec item 2).
        ...(teamScope ? { teamScope } : {}),
        ...(handoffBrokerId ? { handoffBrokerId } : {}),
        parentRoundTotal: parentRound.parentRoundTotal,
      },
    },
    anchors,
    expect: "mint 201 minted or 200 replayed, anchors 201 added or 200 present; a 409 conflict blocks the dispatch",
  };
}

function isReceiptRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiptText(entry: Record<string, unknown>, key: string): string {
  const value = entry[key];
  return typeof value === "string" ? value.trim() : "";
}

function sameBrokerId(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * #2556: does the minting broker's registry entry prove this plan's
 * `[registry]` pre-steps ran? Only what the parent broker later judges is
 * compared: the round id, that the round is `local-origin` on the minting
 * broker, the handoff broker when both sides name one, and every anchor the
 * plan registers. `teamScope`, `initiatingBrokerId` and `parentRoundTotal` are
 * left out because the mint route normalizes them; a real difference there
 * already surfaced as a 409 conflict on the mint pre-step.
 */
function checkParentRoundRegistrationReceipt(
  registration: A2AParentRoundRegistrationPlan,
  receipt: unknown,
): A2AParentRoundRegistrationReceiptCheck {
  const requiredAnchors = registration.anchors.map((anchor) => anchor.body.anchor);
  const counts = { anchorsRegistered: 0, anchorsRequired: requiredAnchors.length };
  if (receipt === undefined || receipt === null) {
    return { status: "missing", issues: [], ...counts };
  }
  const wrapped = isReceiptRecord(receipt) && isReceiptRecord(receipt["entry"]) ? receipt["entry"] : receipt;
  if (!isReceiptRecord(wrapped) || !receiptText(wrapped, "parentRoundId")) {
    return {
      status: "invalid",
      issues: ["the receipt is not a parent-round registry entry; pass the body of GET /a2a/parent-rounds/:id from the minting broker"],
      ...counts,
    };
  }
  const entry = wrapped;
  const issues: string[] = [];
  const parentRoundId = registration.mint.body.parentRoundId;
  if (receiptText(entry, "parentRoundId") !== parentRoundId) {
    issues.push(`the receipt is for parent round "${sanitizeText(receiptText(entry, "parentRoundId"))}", not "${sanitizeText(parentRoundId)}"`);
  }
  if (receiptText(entry, "kind") !== "local-origin") {
    issues.push(`the registered round is "${sanitizeText(receiptText(entry, "kind")) || "(no kind)"}", not local-origin; only the minting broker's own round receives projections`);
  }
  const parentBrokerId = receiptText(entry, "parentBrokerId");
  if (!sameBrokerId(parentBrokerId, registration.mintingBrokerId)) {
    issues.push(`the registered parent broker is "${sanitizeText(parentBrokerId) || "(absent)"}", not the minting broker "${sanitizeText(registration.mintingBrokerId)}"`);
  }
  const plannedHandoff = registration.mint.body.handoffBrokerId;
  const registeredHandoff = receiptText(entry, "handoffBrokerId");
  if (plannedHandoff && registeredHandoff && !sameBrokerId(plannedHandoff, registeredHandoff)) {
    issues.push(`the registered handoff broker is "${sanitizeText(registeredHandoff)}", not "${sanitizeText(plannedHandoff)}"; the parent would reject the projection as routing_mismatch`);
  }
  const mintedAt = receiptText(entry, "mintedAt");
  if (!mintedAt || !Number.isFinite(Date.parse(mintedAt))) {
    issues.push("the receipt has no valid mintedAt; it does not look like a stored registry entry");
  }
  const registeredAnchors = new Set(
    Array.isArray(entry["anchors"]) ? entry["anchors"].filter((anchor): anchor is string => typeof anchor === "string") : [],
  );
  const missingAnchors = requiredAnchors.filter((anchor) => !registeredAnchors.has(anchor));
  for (const anchor of missingAnchors) {
    issues.push(`anchor "${sanitizeText(anchor)}" is not registered on the parent round; run its [registry] pre-step`);
  }
  const anchorsRegistered = requiredAnchors.length - missingAnchors.length;
  return {
    status: issues.length === 0 ? "verified" : "invalid",
    issues,
    ...(mintedAt && Number.isFinite(Date.parse(mintedAt)) ? { mintedAt } : {}),
    anchorsRegistered,
    anchorsRequired: requiredAnchors.length,
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
  for (const issue of crossBrokerHandoffIssues(roundSpec, parentRound.metadata?.parentRoundId)) {
    blockers.push(`[cross_broker_handoff_parent] ${issue}`);
  }
  const mintingBrokerForHandoff = roundSpec.crossBrokerHandoff ? parentRoundMintingBroker(roundSpec) : undefined;
  if (roundSpec.crossBrokerHandoff && !mintingBrokerForHandoff) {
    blockers.push("[parent_round_registry] the minting (origin) broker id is required; provide --handoff-origin-broker-id or --origin-broker-id");
  }
  if (
    mintingBrokerForHandoff && mergedConfig.brokerTeams
    && !mergedConfig.brokerTeams.some((broker) => sameBrokerId(broker.brokerId, mintingBrokerForHandoff))
  ) {
    // #2556: the mint route would answer 400 unknown_initiating_broker.
    blockers.push(`[parent_round_registry] the minting broker "${sanitizeText(mintingBrokerForHandoff)}" is not in the broker-team registry (--broker-teams)`);
  }
  if (!mergedConfig.dryRun && mergedConfig.execute) {
    warnings.push("[approval_boundary_respected] Execute mode active; write operations are permitted");
    if ((roundSpec.teamId === "team1" || roundSpec.teamId === "common") && !roundSpec.workModeDecision) {
      blockers.push("[work_mode_decision_evidence] Execute-mode Team1/common dispatch requires --work-mode-decision");
    }
    if (roundSpec.teamId === "team2") {
      // #2556: the broker that owns Team2 comes from the broker-team registry,
      // not from a literal id — a deployment's brokers carry their own ids.
      const team2BrokerId = mergedConfig.brokerTeams
        ? mergedConfig.brokerTeams.find((broker) => broker.teamId === "team2")?.brokerId
        : PLACEHOLDER_TEAM2_BROKER_ID;
      if (!team2BrokerId) {
        blockers.push("[team2_broker_of_record_handoff] no broker is registered for team2; pass --broker-teams with the brokers' A2A_TERMINAL_BRIEF_BROKER_TEAMS value");
      } else {
        const isTeam2Broker = (brokerId: string | undefined): boolean => brokerId !== undefined && sameBrokerId(brokerId, team2BrokerId);
        const isTeam2Local = isTeam2Broker(roundSpec.originBrokerId) && isTeam2Broker(roundSpec.brokerOfRecordId);
        const isTeam2Handoff = isTeam2Broker(roundSpec.brokerOfRecordId)
          && isTeam2Broker(roundSpec.crossBrokerHandoff?.handoffBrokerId);
        if (!isTeam2Local && !isTeam2Handoff) {
          blockers.push(
            `[team2_broker_of_record_handoff] Execute-mode Team2 dispatch must target ${sanitizeText(team2BrokerId)} (the broker registered for team2) as broker-of-record, locally or via explicit crossBrokerHandoff, not another broker's local /tasks`,
          );
        }
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

  const parentRoundRegistration = blockers.length === 0 && parentRound.metadata
    ? buildParentRoundRegistrationPlan(roundSpec, parentRound.metadata, deterministicTaskId.taskId, mergedConfig.brokerTeams)
    : null;
  if (parentRoundRegistration) {
    dispatchActions.push(
      `[registry] pre-step (not performed by this helper): POST ${sanitizeText(parentRoundRegistration.mintingBrokerId)} ${parentRoundRegistration.mint.path} parentRoundId=${sanitizeText(parentRoundRegistration.mint.body.parentRoundId)}`,
    );
    for (const anchor of parentRoundRegistration.anchors) {
      dispatchActions.push(`[registry] pre-step: POST ${sanitizeText(anchor.path)} anchor=${sanitizeText(anchor.body.anchor)}`);
    }
    dispatchActions.push(`[registry] ${parentRoundRegistration.expect}`);
  }
  // #2556: the pre-steps above are printed, not performed. Execute mode
  // therefore needs the minting broker's registry entry as proof that they
  // ran; without it the child would be dispatched under an unregistered
  // parent round and its projection would fall to the legacy task-id check.
  const parentRoundRegistrationReceipt = parentRoundRegistration
    ? checkParentRoundRegistrationReceipt(parentRoundRegistration, mergedConfig.parentRoundRegistrationReceipt)
    : null;
  if (parentRoundRegistration && parentRoundRegistrationReceipt) {
    const receiptRoundId = sanitizeText(parentRoundRegistration.mint.body.parentRoundId);
    if (parentRoundRegistrationReceipt.status === "invalid") {
      for (const issue of parentRoundRegistrationReceipt.issues) {
        blockers.push(`[parent_round_registry_receipt] ${issue}`);
      }
      dispatchActions.push(`[registry-receipt] rejected: ${parentRoundRegistrationReceipt.issues.length} issue(s) for parentRoundId=${receiptRoundId}`);
    } else if (parentRoundRegistrationReceipt.status === "verified") {
      dispatchActions.push(
        `[registry-receipt] verified: parentRoundId=${receiptRoundId} mintedAt=${sanitizeText(parentRoundRegistrationReceipt.mintedAt ?? "")} anchors=${parentRoundRegistrationReceipt.anchorsRegistered}/${parentRoundRegistrationReceipt.anchorsRequired}`,
      );
    } else if (!mergedConfig.dryRun && mergedConfig.execute) {
      blockers.push(
        `[parent_round_registry_receipt] execute-mode cross-broker handoff requires the minting broker's registry entry for parent round ${receiptRoundId}; run the [registry] pre-steps, then pass --parent-round-registration-receipt with the body of GET ${parentRoundRegistration.mint.path}/${encodeURIComponent(parentRoundRegistration.mint.body.parentRoundId)}`,
      );
      dispatchActions.push("[registry-receipt] missing: execute mode is blocked until the pre-steps are proven");
    } else {
      dispatchActions.push("[registry-receipt] not supplied: required before --execute");
    }
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

  const handoffParentRoundId = roundSpec.crossBrokerHandoff?.parentRoundId?.trim();
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
        ...(roundSpec.crossBrokerHandoff && handoffParentRoundId
          ? {
              crossBrokerHandoff: {
                parentRoundId: handoffParentRoundId,
                originBrokerId: roundSpec.crossBrokerHandoff.originBrokerId,
                handoffBrokerId: roundSpec.crossBrokerHandoff.handoffBrokerId,
                originTaskId: roundSpec.crossBrokerHandoff.originTaskId,
                childWorkerId: roundSpec.crossBrokerHandoff.childWorkerId ?? roundSpec.worker,
              },
            }
          : {}),
        ...(parentRoundRegistration
          ? {
              initiatingBrokerId: parentRoundRegistration.mint.body.initiatingBrokerId,
              ...(parentRoundRegistration.mint.body.teamScope ? { teamScope: parentRoundRegistration.mint.body.teamScope } : {}),
            }
          : {}),
      }
    : null;

  const manifestResult = buildRoundManifest(roundSpec, mergedConfig, deterministicTaskId.taskId);
  const { parentRoundRegistrationReceipt: _receiptInput, ...echoConfig } = mergedConfig;
  const decision = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warn_go" : "go";

  return {
    kind: "a2a-broker.a2a-dispatch-plan.v1",
    version: 1,
    generatedAt,
    config: echoConfig,
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
    parentRoundRegistration,
    parentRoundRegistrationReceipt,
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
