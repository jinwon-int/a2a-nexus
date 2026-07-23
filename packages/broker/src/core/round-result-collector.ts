/**
 * round-result-collector.ts — result collector projection (issue #929)
 *
 * Accepts a round manifest (lane definitions) and broker task snapshots
 * (TaskRecord[]), classifies each lane's state, gathers evidence URLs,
 * flags missing/stale/timeout lanes, and renders a compact closeout
 * bundle for finalizer review.
 *
 * This is the "first" result collector — it operates on live broker
 * TaskRecord snapshots directly, not terminal-outbox events. Later
 * iterations may add richer outbox-sidecar or cross-broker integration.
 *
 * All decision logic is deterministic (pure reads). No comments, closes,
 * merges, deploys, live sends, ACKs, or DB mutations are performed.
 */

import type { TaskRecord, TaskStatus, BrokerExitCondition } from "./types.js";

// ---------------------------------------------------------------------------
// Round Manifest (lane definitions)
// ---------------------------------------------------------------------------

export type RoundLaneExpectedOutcome = "patch" | "evidence-only" | "analysis" | "review";

export interface RoundManifestLane {
  /** Worker identifier, e.g. "workerbeta", "workergamma", "workeralpha". */
  workerId: string;
  /** Optional human-readable label for the lane. */
  description?: string;
  /** Expected outcome kind. Lanes whose manifest outcome does not match the
   *  task evidence are surfaced as a risk in the closeout bundle. */
  expectedOutcome?: RoundLaneExpectedOutcome;
}

export interface RoundManifest {
  /** Operator label, e.g. "a2a-team1-round-coordinator-20260526T201140KST". */
  roundLabel: string;
  /** Parent tracker issue URL. */
  parentIssueUrl?: string;
  /** Lanes (expected workers) for this round. */
  lanes: RoundManifestLane[];
  /** Workers excluded from round closeout (optional). */
  excludedWorkerIds?: string[];
  /**
   * Staleness threshold in milliseconds. A non-terminal task whose
   * `updatedAt` is older than this threshold (relative to collection time)
   * is classified as "stale". Default: 30 minutes.
   */
  staleAfterMs?: number;
  /**
   * Absolute deadline ISO timestamp. Lanes that are still non-terminal
   * past this time are classified as "timeout". Optional; omitted means
   * no timeout detection.
   */
  timeoutAt?: string;
}

// ---------------------------------------------------------------------------
// Lane state classification
// ---------------------------------------------------------------------------

/**
 * Classified state of a single worker lane.
 *
 * Precedence:
 *   no task records found     → pending
 *   > timeoutAt               → timeout
 *   non-terminal + stale      → stale
 *   non-terminal, not stale   → running
 *   blocked status            → blocked
 *   failed/canceled status    → failed
 *   succeeded status          → succeeded
 */
export type RoundLaneState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "stale"
  | "timeout"
  | "blocked";

export type RoundLaneEvidenceClass =
  | "substantive"
  | "oracle_mismatch"
  | "wrapper_only"
  | "handler_artifact_failure"
  | "source_blocked"
  | "queued_unclaimed"
  | "stale_or_missing_worker"
  | "non_substantive"
  | "superseded_by_supplement";

export type RoundLaneReadinessStatus =
  | "missing"
  | "queued"
  | "claimed_running"
  | "stale"
  | "oracle_mismatch"
  | "wrapper_only"
  | "source_blocked"
  | "handler_artifact_failed"
  | "substantive"
  | "terminal_failed"
  | "non_substantive";

export interface ResultLane {
  workerId: string;
  description?: string;
  laneState: RoundLaneState;
  /** Task record IDs associated with this lane. */
  taskIds: string[];
  latestStatus?: TaskStatus;
  /** PR, Done, or Block evidence URLs extracted from the latest task result. */
  evidenceUrls: string[];
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  /** Short operator-facing outcome summary (e.g. test summary or result note). */
  outcomeSummary?: string;
  testSummary?: string;
  errorSummary?: string;
  /** Time the latest task was last updated, in ISO format. */
  updatedAt?: string;
  /** Time the latest task completed, in ISO format. */
  completedAt?: string;
  /** Milliseconds since the latest task was last updated (at collection time). */
  ageMs?: number;
  expectedOutcome?: RoundLaneExpectedOutcome;
  /** Classified broker exit condition, if terminal and classifiable. */
  outcomeClass?: BrokerExitCondition;
  /** Whether the lane contains substantive worker reasoning or only dispatch/infra evidence. */
  evidenceClass?: RoundLaneEvidenceClass;
  /** Finalizer-facing readiness/status projection for A2A/A2AD evidence lanes (#767). */
  readinessStatus: RoundLaneReadinessStatus;
  /** True when parent-round id/order/total and broker attribution are present. */
  roundMetadataComplete: boolean;
  /** Worker attribution from the broker task snapshot; kept explicit for finalizer evidence lanes. */
  assignedWorkerId?: string;
  claimedBy?: string;
  targetNodeId?: string;
  /** Parent-round projection metadata stamped on A2A/A2AD child tasks. */
  parentRoundId?: string;
  parentRoundTotal?: number;
  parentRoundOrder?: number;
  originBrokerId?: string;
  brokerOfRecordId?: string;
}

// ---------------------------------------------------------------------------
// Collector output
// ---------------------------------------------------------------------------

export interface CloseoutBundle {
  title: string;
  body: string;
}

export interface RoundResultCollectorOutput {
  kind: "a2a-broker.round-result-collector.projection";
  version: 1;
  generatedAt: string;
  roundLabel: string;
  parentIssueUrl?: string;
  summary: {
    totalLanes: number;
    completed: number;
    pending: number;
    running: number;
    stale: number;
    timeout: number;
    blocked: number;
    evidenceUrls: number;
    substantiveEvidence: number;
    oracleMismatches: number;
    wrapperOnly: number;
    handlerArtifactFailures: number;
    queuedUnclaimed: number;
    sourceBlocked: number;
    nonSubstantive: number;
    readiness: {
      missing: number;
      queued: number;
      claimedRunning: number;
      stale: number;
      oracleMismatch: number;
      wrapperOnly: number;
      sourceBlocked: number;
      handlerArtifactFailed: number;
      substantive: number;
      terminalFailed: number;
      nonSubstantive: number;
    };
    roundMetadataComplete: number;
    roundMetadataMissing: number;
  };
  lanes: ResultLane[];
  /** Required lane workerIds for which no task record was found. */
  missingLanes: string[];
  /** Lane workerIds classified as stale. */
  staleLanes: string[];
  /** Lane workerIds classified as timeout. */
  timeoutLanes: string[];
  /** Lane workerIds classified as blocked. */
  blockedLanes: string[];
  /** All unique evidence URLs across all lanes. */
  evidenceUrls: string[];
  /** Compact finalizer-review bundle. */
  closeoutBundle: CloseoutBundle;
  /**
   * Source-only next-action projection for a finalizer/orchestrator. This never
   * mutates broker state by itself; external dispatch/requeue code must consume
   * it explicitly.
   */
  verdictActionPlan: RoundVerdictActionPlan;
  approvalSensitiveActionsExcluded: string[];
  /**
   * Finalizer gate verdict computed from the collector's own lane
   * classification. Mirror of the standalone a2ad-finalizer-gate.mjs logic.
   * Source-only: never posts/comments/merges.
   */
  gateVerdict?: {
    verdict: "FINAL" | "BLOCKED";
    succeeded: number;
    failed: number;
    pending: number;
    expectedTotal: number;
    evidenceIdsCited: string[];
    evidenceIdsCitedCount: number;
    /** Worker ids of non-terminal (pending/running/stale) lanes. */
    missingLanes: string[];
    /** Worker ids of lanes that reached a failed/blocked/timeout terminal state. */
    failedLanes: string[];
    /**
     * Worker ids of terminal lanes that lack any evidence URL — the
     * "succeeded but no substantive evidence" downgrade that drives BLOCKED.
     * Exposed structurally (not just inside `reason`) so downstream
     * reject-feedback requeue / closeout barriers can target lanes without
     * parsing the human-readable reason string. See a2a-nexus#970.
     */
    missingEvidenceLanes: string[];
    /** When BLOCKED, a human-readable explanation. */
    reason?: string;
  };
}

export interface RoundVerdictRequeueLane {
  workerId: string;
  taskId?: string;
  evidenceClass?: RoundLaneEvidenceClass;
  readinessStatus: RoundLaneReadinessStatus;
  laneState: RoundLaneState;
  rejectionReason: string;
  priorAttemptEvidenceRef: string;
}

export type RoundVerdictActionPlan =
  | {
      kind: "finalizer_review";
      sourceOnly: true;
      requiresExternalDispatcher: false;
      reason?: string;
      lanes: [];
    }
  | {
      kind: "reject_feedback_requeue";
      sourceOnly: true;
      requiresExternalDispatcher: true;
      reason: string;
      lanes: RoundVerdictRequeueLane[];
    };

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const TERMINAL_STATUSES = new Set<TaskStatus>(["succeeded", "failed", "canceled", "blocked"]);
const EVIDENCE_KEY_RE = /^(prUrl|doneUrl|doneCommentUrl|blockUrl|blockCommentUrl)$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Project broker task snapshots against a round manifest and produce a
 * result collector output with lane classification, evidence gathering,
 * missing/stale/timeout detection, and a finalizer-review closeout bundle.
 *
 * @param manifest  Round manifest defining lanes and thresholds.
 * @param tasks     Live broker TaskRecord[] snapshots.
 * @param options   Collection time override (defaults to Date.now()).
 */
export function collectRoundResults(
  manifest: RoundManifest,
  tasks: TaskRecord[],
  options: { nowMs?: number } = {},
): RoundResultCollectorOutput {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = Math.max(1, manifest.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const excluded = new Set(manifest.excludedWorkerIds ?? []);
  const timeoutAtMs = manifest.timeoutAt ? Date.parse(manifest.timeoutAt) : NaN;
  const hasTimeout = !Number.isNaN(timeoutAtMs);

  // Group tasks by assigned worker
  const tasksByWorker = groupTasksByWorker(tasks);

  // Classify each lane
  const lanes: ResultLane[] = manifest.lanes
    .filter((lane) => !excluded.has(lane.workerId))
    .map((lane) => classifyLane(lane, tasksByWorker.get(lane.workerId) ?? [], {
      nowMs,
      staleAfterMs,
      hasTimeout,
      timeoutAtMs,
    }));

  // Build aggregated views
  const summary = buildSummary(lanes);
  const missingLanes = lanes
    .filter((l) => l.laneState === "pending")
    .map((l) => l.workerId);
  const staleLanes = lanes
    .filter((l) => l.laneState === "stale")
    .map((l) => l.workerId);
  const timeoutLanes = lanes
    .filter((l) => l.laneState === "timeout")
    .map((l) => l.workerId);
  const blockedLanes = lanes
    .filter((l) => l.laneState === "blocked")
    .map((l) => l.workerId);
  const evidenceUrls = extractAllEvidenceUrls(lanes);
  const gateVerdict = computeGateVerdict(lanes, manifest.lanes.length);
  const verdictActionPlan = buildVerdictActionPlan(lanes, gateVerdict);
  const closeoutBundle = buildCloseoutBundle({
    roundLabel: manifest.roundLabel,
    parentIssueUrl: manifest.parentIssueUrl,
    summary,
    lanes,
    missingLanes,
    staleLanes,
    timeoutLanes,
    blockedLanes,
    evidenceUrls,
    verdictActionPlan,
    generatedAt: new Date(nowMs).toISOString(),
  });

  return {
    kind: "a2a-broker.round-result-collector.projection",
    version: 1,
    generatedAt: new Date(nowMs).toISOString(),
    roundLabel: manifest.roundLabel,
    parentIssueUrl: manifest.parentIssueUrl,
    summary,
    lanes,
    missingLanes,
    staleLanes,
    timeoutLanes,
    blockedLanes,
    evidenceUrls,
    closeoutBundle,
    verdictActionPlan,
    gateVerdict,
    approvalSensitiveActionsExcluded: [
      "GitHub PR merge, issue close, or comment post",
      "live provider/Hermes/Telegram/OpenClaw send",
      "terminal ACK/replay",
      "Gateway/broker/worker/sidecar restart or deploy",
      "broker DB mutation/prune/migration",
      "historical outbox replay",
      "release/tag/npm publish",
      "secret or credential movement",
    ],
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function groupTasksByWorker(tasks: TaskRecord[]): Map<string, TaskRecord[]> {
  const map = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const workerId = task.assignedWorkerId ?? task.claimedBy ?? task.targetNodeId ?? task.target.id ?? "unassigned";
    let list = map.get(workerId);
    if (!list) {
      list = [];
      map.set(workerId, list);
    }
    list.push(task);
  }
  return map;
}

/**
 * Sort tasks by `createdAt` descending; latest first.
 */
function sortTasksDesc(tasks: TaskRecord[]): TaskRecord[] {
  return [...tasks].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

function classifyLane(
  laneDef: RoundManifestLane,
  tasks: TaskRecord[],
  options: {
    nowMs: number;
    staleAfterMs: number;
    hasTimeout: boolean;
    timeoutAtMs: number;
  },
): ResultLane {
  const { nowMs, staleAfterMs, hasTimeout, timeoutAtMs } = options;

  if (tasks.length === 0) {
    return {
      workerId: laneDef.workerId,
      description: laneDef.description,
      laneState: hasTimeout && nowMs >= timeoutAtMs ? "timeout" : "pending",
      taskIds: [],
      evidenceUrls: [],
      expectedOutcome: laneDef.expectedOutcome,
      evidenceClass: "stale_or_missing_worker",
      readinessStatus: hasTimeout && nowMs >= timeoutAtMs ? "stale" : "missing",
      roundMetadataComplete: false,
    };
  }

  const sorted = sortTasksDesc(tasks);
  const taskIds = sorted.map((t) => t.id);
  const latest = sorted[0]!;
  const updatedAt = latest.updatedAt;
  const completedAt = latest.completedAt;
  const updatedAtMs = Date.parse(updatedAt);
  const ageMs = Math.max(0, nowMs - updatedAtMs);
  const status = latest.status;
  const evidence = extractEvidence(latest);
  const resultSummary = extractResultSummary(latest);
  const outcomeClass = classifyExitCondition(status, evidence);
  const evidenceClass = classifyEvidenceClass(laneDef, latest, evidence);

  // 1. Timeout — non-terminal past deadline
  if (hasTimeout && !TERMINAL_STATUSES.has(status) && nowMs >= timeoutAtMs) {
    return buildLaneResult(laneDef, {
      laneState: "timeout",
      taskIds,
      latest: latest,
      status,
      evidence,
      resultSummary,
      ageMs,
      updatedAt,
      completedAt,
      outcomeClass,
      risk: "Worker did not complete before round deadline",
    });
  }

  // 2. Stale — non-terminal, not yet timeout, but stale
  if (!TERMINAL_STATUSES.has(status)) {
    if (ageMs >= staleAfterMs) {
      return buildLaneResult(laneDef, {
        laneState: "stale",
        taskIds,
        latest,
        status,
        evidence,
        resultSummary,
        ageMs,
        updatedAt,
        completedAt,
        outcomeClass,
        risk: `Non-terminal task not updated within ${Math.round(staleAfterMs / 1000)}s stale threshold`,
      });
    }
    return buildLaneResult(laneDef, {
      laneState: "running",
      taskIds,
      latest,
      status,
      evidence,
      resultSummary,
      ageMs,
      updatedAt,
      completedAt,
      outcomeClass,
    });
  }

  // 3. Blocked terminal status
  if (status === "blocked") {
    return buildLaneResult(laneDef, {
      laneState: "blocked",
      taskIds,
      latest,
      status,
      evidence,
      resultSummary,
      ageMs,
      updatedAt,
      completedAt,
      outcomeClass,
      ...(!evidence.prUrl && !evidence.doneUrl && !evidence.blockUrl
        ? { risk: "Blocked task has no Block evidence URL" }
        : {}),
    });
  }

  // 4. Failed/canceled
  if (status === "failed" || status === "canceled") {
    return buildLaneResult(laneDef, {
      laneState: "failed",
      taskIds,
      latest,
      status,
      evidence,
      resultSummary,
      ageMs,
      updatedAt,
      completedAt,
      outcomeClass,
      risk: status === "canceled" ? "Task was canceled before completion" : undefined,
    });
  }

  // 5. Succeeded
  if (status === "succeeded") {
    if (isEvidenceRequired(laneDef) && evidenceClass !== "substantive") {
      return buildLaneResult(laneDef, {
        laneState: "blocked",
        taskIds,
        latest,
        status,
        evidence,
        resultSummary: {
          ...resultSummary,
          errorSummary: evidenceClass === "wrapper_only"
            ? "Wrapper-only task success is not substantive worker analysis"
            : "Succeeded task did not include substantive worker analysis evidence",
        },
        ageMs,
        updatedAt,
        completedAt,
        outcomeClass,
        evidenceClass,
        risk: "Succeeded task did not satisfy required substantive analysis evidence",
      });
    }
    return buildLaneResult(laneDef, {
      laneState: "succeeded",
      taskIds,
      latest,
      status,
      evidence,
      resultSummary,
      ageMs,
      updatedAt,
      completedAt,
      outcomeClass,
      evidenceClass,
    });
  }

  // Fallback (should not happen)
  return buildLaneResult(laneDef, {
    laneState: "running",
    taskIds,
    latest,
    status,
    evidence,
    resultSummary,
    ageMs,
    updatedAt,
    completedAt,
    outcomeClass,
  });
}

function buildLaneResult(
  laneDef: RoundManifestLane,
  state: {
    laneState: RoundLaneState;
    taskIds: string[];
    latest: TaskRecord;
    status: TaskStatus;
    evidence: ExtractedEvidence;
    resultSummary: { outcomeSummary?: string; testSummary?: string; errorSummary?: string };
    ageMs: number;
    updatedAt: string;
    completedAt?: string;
    outcomeClass?: BrokerExitCondition;
    evidenceClass?: RoundLaneEvidenceClass;
    risk?: string;
  },
): ResultLane {
  const metadata = extractLaneProjectionMetadata(state.latest);
  const lane: ResultLane = {
    workerId: laneDef.workerId,
    description: laneDef.description,
    laneState: state.laneState,
    taskIds: state.taskIds,
    latestStatus: state.status,
    evidenceUrls: state.evidence.allUrls,
    prUrl: state.evidence.prUrl,
    doneUrl: state.evidence.doneUrl,
    blockUrl: state.evidence.blockUrl,
    outcomeSummary: state.resultSummary.outcomeSummary,
    testSummary: state.resultSummary.testSummary,
    errorSummary: state.resultSummary.errorSummary,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    ageMs: state.ageMs,
    expectedOutcome: laneDef.expectedOutcome,
    outcomeClass: state.outcomeClass,
    evidenceClass: state.evidenceClass ?? classifyEvidenceClass(laneDef, state.latest, state.evidence),
    readinessStatus: "non_substantive",
    roundMetadataComplete: false,
    assignedWorkerId: state.latest.assignedWorkerId,
    claimedBy: state.latest.claimedBy,
    targetNodeId: state.latest.targetNodeId,
    ...metadata,
  };
  lane.readinessStatus = projectReadinessStatus(lane);
  lane.roundMetadataComplete = isRoundMetadataComplete(lane);
  return lane;
}

// ---------------------------------------------------------------------------
// Evidence extraction from TaskRecord
// ---------------------------------------------------------------------------

interface ExtractedEvidence {
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  allUrls: string[];
}

/**
 * Extract evidence URLs from a TaskRecord.
 *
 * Checks:
 *   1. result.output["prUrl"], result.output["doneUrl"], result.output["blockUrl"]
 *   2. result.output["doneCommentUrl"] as doneUrl
 *   3. result.output["blockCommentUrl"] as blockUrl
 *
 * Only https:// URLs are accepted as evidence.
 */
function extractEvidence(task: TaskRecord): ExtractedEvidence {
  const output = task.result?.output ?? {};
  const allUrls: string[] = [];
  let prUrl: string | undefined;
  let doneUrl: string | undefined;
  let blockUrl: string | undefined;

  for (const [key, value] of Object.entries(output)) {
    if (!EVIDENCE_KEY_RE.test(key)) continue;
    const url = safeHttpUrl(value);
    if (!url) continue;
    allUrls.push(url);
    if (key === "prUrl") prUrl = url;
    else if (key === "doneUrl" || key === "doneCommentUrl") doneUrl = url;
    else if (key === "blockUrl" || key === "blockCommentUrl") blockUrl = url;
  }

  return { prUrl, doneUrl, blockUrl, allUrls };
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("https://")) return undefined;
  try {
    new URL(value);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Extract human-readable outcome/test/error summaries from a TaskRecord.
 */
function extractResultSummary(task: TaskRecord): {
  outcomeSummary?: string;
  testSummary?: string;
  errorSummary?: string;
} {
  const result = task.result;
  const error = task.error;
  const output = result?.output ?? {};

  const outcomeSummary =
    safeString(output["summary"]) ??
    result?.summary ??
    result?.note;

  const testSummary = safeString(output["testSummary"]) ?? safeString(output["test_summary"]);

  const errorSummary = error?.message;
  if (error) {
    const nested = extractNestedErrorText(error);
    if (nested) {
      return {
        outcomeSummary,
        testSummary,
        errorSummary: errorSummary ? `${errorSummary}: ${nested}` : nested,
      };
    }
  }
  if (error?.details && typeof error.details === "object") {
    const detailStr = safeString(error.details["summary"]);
    if (detailStr) {
      return {
        outcomeSummary,
        testSummary,
        errorSummary: errorSummary
          ? `${errorSummary}: ${detailStr}`
          : detailStr,
      };
    }
  }

  return { outcomeSummary, testSummary, errorSummary };
}

function safeString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractLaneProjectionMetadata(task: TaskRecord): Pick<
  ResultLane,
  "parentRoundId" | "parentRoundTotal" | "parentRoundOrder" | "originBrokerId" | "brokerOfRecordId"
> {
  const payload = task.payload ?? {};
  return {
    parentRoundId: safeString(task.parentRoundId) ?? safeString(payload["parentRoundId"]),
    parentRoundTotal: safeNumber(task.parentRoundTotal) ?? safeNumber(payload["parentRoundTotal"]),
    parentRoundOrder: safeNumber(task.parentRoundOrder) ?? safeNumber(payload["parentRoundOrder"]),
    originBrokerId: safeString(payload["originBrokerId"]),
    brokerOfRecordId: safeString(payload["brokerOfRecordId"]) ?? safeString(task.brokerOfRecord),
  };
}

function isEvidenceRequired(laneDef: RoundManifestLane): boolean {
  return laneDef.expectedOutcome === "analysis" || laneDef.expectedOutcome === "review";
}

function isRoundMetadataComplete(lane: ResultLane): boolean {
  return Boolean(
    lane.parentRoundId &&
    lane.parentRoundTotal !== undefined &&
    lane.parentRoundOrder !== undefined &&
    lane.brokerOfRecordId,
  );
}

function projectReadinessStatus(lane: ResultLane): RoundLaneReadinessStatus {
  if (lane.evidenceClass === "substantive") return "substantive";
  if (lane.evidenceClass === "oracle_mismatch") return "oracle_mismatch";
  if (lane.evidenceClass === "wrapper_only") return "wrapper_only";
  if (lane.evidenceClass === "source_blocked") return "source_blocked";
  if (lane.evidenceClass === "handler_artifact_failure") return "handler_artifact_failed";
  if (lane.evidenceClass === "queued_unclaimed") return "queued";
  if (lane.laneState === "pending") return "missing";
  if (lane.laneState === "stale" || lane.laneState === "timeout") return "stale";
  if (lane.laneState === "running") return "claimed_running";
  if (lane.laneState === "failed" || lane.laneState === "blocked") return "terminal_failed";
  return "non_substantive";
}

function classifyEvidenceClass(
  laneDef: RoundManifestLane,
  task: TaskRecord,
  evidence: ExtractedEvidence,
): RoundLaneEvidenceClass {
  if (!task.assignedWorkerId && !task.claimedBy && task.status === "queued") {
    return "queued_unclaimed";
  }

  if (task.status === "failed" || task.status === "canceled") {
    const text = extractNestedErrorText(task.error).toLowerCase();
    if (
      text.includes("source root") ||
      text.includes("repo root") ||
      text.includes("source bundle") ||
      text.includes("0 files") ||
      text.includes("repo mapping")
    ) {
      return "source_blocked";
    }
    if (
      text.includes("openclaw_analysis_spawn_failed") ||
      text.includes("openclaw_analysis_failed") ||
      text.includes("hermes-a2a-analysis-bridge.mjs eacces") ||
      text.includes("analysis bridge") && text.includes("eacces") ||
      text.includes("model") && text.includes("does not exist") ||
      text.includes("model") && text.includes("is not supported") ||
      text.includes("model") && text.includes("does not have access") ||
      text.includes("provider") && text.includes("does not have access")
    ) {
      return "handler_artifact_failure";
    }
    return "non_substantive";
  }

  if (task.status === "succeeded") {
    if (hasOracleMismatchOutput(task)) return "oracle_mismatch";
    if (hasSourceBlockedOutput(task)) return "source_blocked";
    if (hasSubstantiveWorkerOutput(task)) return "substantive";
    if (isWrapperOnlySuccess(task)) return "wrapper_only";
    if (!isEvidenceRequired(laneDef) && evidence.allUrls.length > 0) return "substantive";
    if (!isEvidenceRequired(laneDef)) return "non_substantive";
    return "non_substantive";
  }

  if (task.status === "blocked") return evidence.blockUrl ? "source_blocked" : "non_substantive";
  return "non_substantive";
}

function hasOracleMismatchOutput(task: TaskRecord): boolean {
  const output = task.result?.output ?? {};
  if (containsOracleMismatch(output["oracleVerdict"]) || containsOracleMismatch(output["oracleVerdicts"])) {
    return true;
  }
  const blockFlags = output["blockFlags"];
  if (Array.isArray(blockFlags) && blockFlags.some((flag) => typeof flag === "string" && flag === "factual_error")) {
    return true;
  }
  return false;
}

function containsOracleMismatch(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsOracleMismatch);
  if (!value || typeof value !== "object") return false;
  return (value as { match?: unknown }).match === false;
}

function hasSourceBlockedOutput(task: TaskRecord): boolean {
  const text = collectResultText(task).toLowerCase();
  return (
    text.includes("no source files available") ||
    text.includes("source bundle contained 0 files") ||
    text.includes("source bundle had 0 files") ||
    text.includes("0 files") && text.includes("source") ||
    text.includes("analysis bridge blocked") ||
    text.includes("repo root missing") ||
    text.includes("source root missing") ||
    text.includes("source was unavailable")
  );
}

function collectResultText(task: TaskRecord): string {
  const parts: string[] = [];
  const add = (value: unknown): void => {
    if (value == null) return;
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (/secret|token|authorization|password/i.test(key)) continue;
        add(item);
      }
    }
  };
  add(task.result?.summary);
  add(task.result?.note);
  const output = task.result?.output ?? {};
  add(output["summary"]);
  add(output["analysisSummary"]);
  add(output["analysis_summary"]);
  add(output["findings"]);
  add(output["risks"]);
  add(output["recommendations"]);
  add(output["blockerFindings"]);
  add(output["nonBlockingFindings"]);
  return parts.join("\n");
}

function hasSubstantiveWorkerOutput(task: TaskRecord): boolean {
  const output = task.result?.output ?? {};
  const analysisStatus = safeString(output["analysisStatus"]) ?? safeString(output["analysis_status"]);
  if (analysisStatus === "done") return true;
  if (safeString(output["verdict"])) return true;
  if (Array.isArray(output["blockerFindings"]) && output["blockerFindings"].length > 0) return true;
  if (Array.isArray(output["nonBlockingFindings"]) && output["nonBlockingFindings"].length > 0) return true;
  if (Array.isArray(output["findings"]) && output["findings"].length > 0) return true;
  return false;
}

function isWrapperOnlySuccess(task: TaskRecord): boolean {
  if (task.status !== "succeeded") return false;
  const output = task.result?.output ?? {};
  const note = task.result?.note ?? "";
  const summary = task.result?.summary ?? "";
  const outputMessage = safeString(output["message"]);
  const resultText = collectResultText(task).toLowerCase();
  return (
    note.includes("echo handled task") ||
    resultText.includes("generic analyze task accepted by versioned a2a task handler") ||
    (Boolean(task.message) && summary === task.message) ||
    (Boolean(task.message) && outputMessage === task.message)
  );
}

function extractNestedErrorText(error: TaskRecord["error"]): string {
  if (!error?.details || typeof error.details !== "object") return "";
  const parts: string[] = [];
  const details = error.details;
  for (const key of ["summary", "stdout", "stderr"]) {
    const value = safeString(details[key]);
    if (!value) continue;
    parts.push(value);
    try {
      const parsed = JSON.parse(value) as { error?: { code?: unknown; message?: unknown } };
      if (typeof parsed.error?.code === "string") parts.push(parsed.error.code);
      if (typeof parsed.error?.message === "string") parts.push(parsed.error.message);
    } catch {
      // Keep the raw value above; nested stdout is not always JSON.
    }
  }
  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Exit condition classification
// ---------------------------------------------------------------------------

function classifyExitCondition(
  status: TaskStatus,
  evidence: ExtractedEvidence,
): BrokerExitCondition | undefined {
  if (!TERMINAL_STATUSES.has(status)) return undefined;

  const hasPr = Boolean(evidence.prUrl);
  const hasDone = Boolean(evidence.doneUrl);
  const hasBlock = Boolean(evidence.blockUrl);

  if (status === "succeeded") {
    if (hasPr) return "pr_success";
    if (hasDone) return "no_change_done";
    return undefined;
  }

  // failed / canceled / blocked
  if (hasBlock) return "no_change_block";
  if (hasPr || hasDone) return "no_change_block";
  return "infra_failure";
}

// ---------------------------------------------------------------------------
// Summary aggregation
// ---------------------------------------------------------------------------

function buildSummary(lanes: ResultLane[]): RoundResultCollectorOutput["summary"] {
  const counts = {
    totalLanes: lanes.length,
    completed: 0,
    pending: 0,
    running: 0,
    stale: 0,
    timeout: 0,
    blocked: 0,
    evidenceUrls: 0,
    substantiveEvidence: 0,
    oracleMismatches: 0,
    wrapperOnly: 0,
    handlerArtifactFailures: 0,
    queuedUnclaimed: 0,
    sourceBlocked: 0,
    nonSubstantive: 0,
    readiness: {
      missing: 0,
      queued: 0,
      claimedRunning: 0,
      stale: 0,
      oracleMismatch: 0,
      wrapperOnly: 0,
      sourceBlocked: 0,
      handlerArtifactFailed: 0,
      substantive: 0,
      terminalFailed: 0,
      nonSubstantive: 0,
    },
    roundMetadataComplete: 0,
    roundMetadataMissing: 0,
  };

  const seenUrls = new Set<string>();
  for (const lane of lanes) {
    switch (lane.laneState) {
      case "succeeded":
        counts.completed++;
        break;
      case "pending":
        counts.pending++;
        break;
      case "running":
        counts.running++;
        break;
      case "stale":
        counts.stale++;
        break;
      case "timeout":
        counts.timeout++;
        break;
      case "blocked":
        counts.blocked++;
        break;
      case "failed":
        counts.blocked++; // failed lanes are grouped under blocked for closeout
        break;
    }
    switch (lane.evidenceClass) {
      case "substantive":
        counts.substantiveEvidence++;
        break;
      case "oracle_mismatch":
        counts.oracleMismatches++;
        break;
      case "wrapper_only":
        counts.wrapperOnly++;
        break;
      case "handler_artifact_failure":
        counts.handlerArtifactFailures++;
        break;
      case "queued_unclaimed":
        counts.queuedUnclaimed++;
        break;
      case "source_blocked":
        counts.sourceBlocked++;
        break;
      case "non_substantive":
      case "stale_or_missing_worker":
      case "superseded_by_supplement":
        counts.nonSubstantive++;
        break;
    }
    switch (lane.readinessStatus) {
      case "missing":
        counts.readiness.missing++;
        break;
      case "queued":
        counts.readiness.queued++;
        break;
      case "claimed_running":
        counts.readiness.claimedRunning++;
        break;
      case "stale":
        counts.readiness.stale++;
        break;
      case "oracle_mismatch":
        counts.readiness.oracleMismatch++;
        break;
      case "wrapper_only":
        counts.readiness.wrapperOnly++;
        break;
      case "source_blocked":
        counts.readiness.sourceBlocked++;
        break;
      case "handler_artifact_failed":
        counts.readiness.handlerArtifactFailed++;
        break;
      case "substantive":
        counts.readiness.substantive++;
        break;
      case "terminal_failed":
        counts.readiness.terminalFailed++;
        break;
      case "non_substantive":
        counts.readiness.nonSubstantive++;
        break;
    }
    if (lane.roundMetadataComplete) counts.roundMetadataComplete++;
    else counts.roundMetadataMissing++;
    for (const url of lane.evidenceUrls) seenUrls.add(url);
  }
  counts.evidenceUrls = seenUrls.size;

  return counts;
}

/**
 * Compute a gate verdict mirroring the standalone a2ad-finalizer-gate.mjs
 * logic.  Source-only: never posts/comments/merges.
 *
 * Verdict rules:
 *   FINAL    every expected lane succeeded and every succeeded lane has
 *            evidence URLs. Evidence_ids for the "cited" check are the task
 *            IDs of succeeded lanes.
 *   BLOCKED  any lane is non-terminal, timed out, failed, blocked, or lacks
 *            required evidence. This source-only gate must not auto-finalize a
 *            partially failed A2A/A2AD round.
 */
function computeGateVerdict(
  lanes: ResultLane[],
  expectedTotal: number,
): RoundResultCollectorOutput["gateVerdict"] {
  let succeeded = 0;
  let failed = 0;
  let pending = 0;
  const evidenceIdsCited: string[] = [];
  const missingLanes: string[] = [];
  const failedLanes: string[] = [];
  const missingEvidenceLanes: string[] = [];

  for (const lane of lanes) {
    if (lane.laneState === "succeeded") {
      succeeded++;
      if (lane.taskIds.length > 0) evidenceIdsCited.push(lane.taskIds[0]!);
      if (lane.evidenceUrls.length === 0) missingEvidenceLanes.push(lane.workerId);
    } else if (
      lane.laneState === "failed" ||
      lane.laneState === "blocked" ||
      lane.laneState === "timeout"
    ) {
      failed++;
      failedLanes.push(lane.workerId);
      if (lane.evidenceUrls.length === 0) missingEvidenceLanes.push(lane.workerId);
    } else {
      // pending, running, stale -- all non-terminal
      pending++;
      missingLanes.push(lane.workerId);
    }
  }

  // Collect evidence IDs from succeeded lanes (task IDs that can be cited)
  const evidenceIdsCitedSet = new Set(evidenceIdsCited);
  const uniqueEvidenceIds = [...evidenceIdsCitedSet];

  let verdict: "FINAL" | "BLOCKED" = "BLOCKED";
  let reason: string | undefined;

  if (pending > 0) {
    reason = `${pending} lane(s) still non-terminal (${missingLanes.join(", ")})`;
  } else if (failed > 0) {
    reason = `${failed} lane(s) failed, blocked, or timed out (${failedLanes.join(", ")})`;
  } else if (missingEvidenceLanes.length > 0) {
    reason = `One or more terminal lanes lack evidence URLs (${missingEvidenceLanes.join(", ")})`;
  } else if (succeeded === expectedTotal && succeeded > 0) {
    verdict = "FINAL";
  } else {
    reason = "No lanes have terminal success evidence — no work was finalized";
  }

  return {
    verdict,
    succeeded,
    failed,
    pending,
    expectedTotal,
    evidenceIdsCited: uniqueEvidenceIds,
    evidenceIdsCitedCount: uniqueEvidenceIds.length,
    missingLanes,
    failedLanes,
    missingEvidenceLanes: [...new Set(missingEvidenceLanes)],
    reason,
  };
}

function buildVerdictActionPlan(
  lanes: ResultLane[],
  gateVerdict: RoundResultCollectorOutput["gateVerdict"],
): RoundVerdictActionPlan {
  if (gateVerdict?.verdict === "FINAL") {
    return {
      kind: "finalizer_review",
      sourceOnly: true,
      requiresExternalDispatcher: false,
      lanes: [],
    };
  }

  const requeueLanes = lanes
    .filter(isRejectFeedbackRequeueCandidate)
    .map((lane) => ({
      workerId: lane.workerId,
      taskId: lane.taskIds[0],
      evidenceClass: lane.evidenceClass,
      readinessStatus: lane.readinessStatus,
      laneState: lane.laneState,
      rejectionReason: rejectionReasonForLane(lane),
      priorAttemptEvidenceRef: priorAttemptEvidenceRef(lane),
    }));

  if (requeueLanes.length === 0) {
    return {
      kind: "finalizer_review",
      sourceOnly: true,
      requiresExternalDispatcher: false,
      reason: gateVerdict?.reason,
      lanes: [],
    };
  }

  return {
    kind: "reject_feedback_requeue",
    sourceOnly: true,
    requiresExternalDispatcher: true,
    reason: gateVerdict?.reason ?? "verify verdict BLOCKED; retry eligible lanes with reject feedback",
    lanes: requeueLanes,
  };
}

function isRejectFeedbackRequeueCandidate(lane: ResultLane): boolean {
  if (lane.laneState === "succeeded") return false;
  if (lane.evidenceClass === "substantive") return false;
  if (lane.evidenceClass === "superseded_by_supplement") return false;
  return lane.laneState === "blocked"
    || lane.laneState === "failed"
    || lane.laneState === "timeout"
    || lane.laneState === "stale"
    || lane.laneState === "pending";
}

function rejectionReasonForLane(lane: ResultLane): string {
  const classification = lane.readinessStatus === "terminal_failed"
    ? "terminal_failed"
    : lane.evidenceClass ?? lane.readinessStatus;
  const detail = lane.errorSummary ?? lane.outcomeSummary ?? lane.testSummary ?? "no substantive terminal evidence";
  return `${classification}: ${detail}`;
}

function priorAttemptEvidenceRef(lane: ResultLane): string {
  if (lane.evidenceUrls.length > 0) return lane.evidenceUrls[0]!;
  if (lane.taskIds.length > 0) return `task:${lane.taskIds[0]}`;
  return `lane:${lane.workerId}`;
}

function extractAllEvidenceUrls(lanes: ResultLane[]): string[] {
  const seen = new Set<string>();
  for (const lane of lanes) {
    for (const url of lane.evidenceUrls) seen.add(url);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Closeout bundle rendering
// ---------------------------------------------------------------------------

function buildCloseoutBundle(context: {
  roundLabel: string;
  parentIssueUrl?: string;
  summary: RoundResultCollectorOutput["summary"];
  lanes: ResultLane[];
  missingLanes: string[];
  staleLanes: string[];
  timeoutLanes: string[];
  blockedLanes: string[];
  evidenceUrls: string[];
  verdictActionPlan: RoundVerdictActionPlan;
  generatedAt: string;
}): CloseoutBundle {
  const title = closeoutTitle(context);
  const body = closeoutBody(context);
  return { title, body };
}

function closeoutTitle(context: {
  roundLabel: string;
  summary: RoundResultCollectorOutput["summary"];
}): string {
  const { summary } = context;
  const needsReviewCount = summary.stale + summary.timeout + summary.blocked + summary.queuedUnclaimed;
  const verb = needsReviewCount > 0 ? `needs review (${needsReviewCount} lane(s) require attention)` : "ready for review";
  return `Finalizer review: ${context.roundLabel} — ${verb}`;
}

function closeoutBody(context: {
  roundLabel: string;
  parentIssueUrl?: string;
  summary: RoundResultCollectorOutput["summary"];
  lanes: ResultLane[];
  missingLanes: string[];
  staleLanes: string[];
  timeoutLanes: string[];
  blockedLanes: string[];
  evidenceUrls: string[];
  verdictActionPlan: RoundVerdictActionPlan;
  generatedAt: string;
}): string {
  const { summary, lanes, missingLanes, staleLanes, timeoutLanes, blockedLanes, evidenceUrls, verdictActionPlan, generatedAt, parentIssueUrl } = context;
  const lines: string[] = [];

  // Header
  lines.push(`## Finalizer review: ${context.roundLabel}`);
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  if (parentIssueUrl) lines.push(`Parent: ${parentIssueUrl}`);
  lines.push("");

  // Summary bar
  const total = summary.totalLanes;
  const ok = summary.completed;
  const ko = summary.blocked;
  const waiting = summary.pending + summary.running;
  const stale = summary.stale;
  const timeout = summary.timeout;
  lines.push(`**${ok}/${total} lanes completed.** ${ko} blocked, ${stale} stale, ${timeout} timeout, ${waiting} active.`);
  lines.push(`Evidence classes: ${summary.substantiveEvidence} substantive, ${summary.oracleMismatches} oracle-mismatch, ${summary.wrapperOnly} wrapper-only, ${summary.handlerArtifactFailures} handler artifact failure(s), ${summary.queuedUnclaimed} queued/unclaimed, ${summary.sourceBlocked} source-blocked, ${summary.nonSubstantive} non-substantive.`);
  lines.push(`readiness: missing=${summary.readiness.missing} queued=${summary.readiness.queued} claimed/running=${summary.readiness.claimedRunning} wrapper-only=${summary.readiness.wrapperOnly} source-blocked=${summary.readiness.sourceBlocked} handler-artifact-failed=${summary.readiness.handlerArtifactFailed} substantive=${summary.readiness.substantive} oracle-mismatch=${summary.readiness.oracleMismatch}`);
  lines.push(`round metadata complete: ${summary.roundMetadataComplete}; round metadata missing: ${summary.roundMetadataMissing}`);
  lines.push("");

  // Quick verdict
  if (summary.blocked > 0 || summary.stale > 0 || summary.timeout > 0) {
    lines.push("> ⚠️  Round has lanes requiring attention before final closeout.");
    lines.push("");
  } else if (summary.pending > 0 || summary.running > 0) {
    lines.push("> ⏳  Round still has active lanes; complete all lanes before closeout.");
    lines.push("");
  } else if (summary.totalLanes > 0 && ok === total) {
    lines.push("> ✅  All lanes completed with evidence. Ready for finalizer closeout.");
    lines.push("");
  }

  // Lane-by-lane summary
  lines.push("### Lane status");
  lines.push("");
  lines.push("| Lane | Worker | State | Evidence class | Evidence | Outcome |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const lane of lanes) {
    const workerLabel = lane.description
      ? `${lane.workerId} (${lane.description})`
      : lane.workerId;
    const stateLabel = stateEmoji(lane.laneState);
    const evClass = lane.evidenceClass ? evidenceClassLabel(lane.evidenceClass) : "—";
    const ev = lane.evidenceUrls.length > 0
      ? lane.evidenceUrls.slice(0, 2).map((url) => `[link](${url})`).join(" ")
      : "—";
    const ocs = lane.laneState === "succeeded"
      ? (lane.outcomeClass ?? "succeeded")
      : lane.laneState === "failed"
        ? (lane.outcomeClass ?? "failed")
        : lane.laneState === "blocked"
          ? (lane.outcomeClass ?? "blocked")
          : lane.laneState === "timeout"
            ? "timeout"
            : lane.laneState === "stale"
              ? "stale"
              : lane.laneState;
    const attribution = laneAttribution(lane);
    lines.push(`| ${workerLabel} | ${lane.workerId} | ${stateLabel} | ${evClass} | ${ev} | ${ocs}${attribution} |`);
  }
  lines.push("");

  // Missing lanes
  if (missingLanes.length > 0) {
    lines.push(`### Missing lanes (${missingLanes.length})`);
    lines.push("");
    for (const wid of missingLanes) {
      lines.push(`- ${wid}: No task record found. Verify assignment or dispatch.`);
    }
    lines.push("");
  }

  // Stale lanes
  if (staleLanes.length > 0) {
    lines.push(`### Stale lanes (${staleLanes.length})`);
    lines.push("");
    for (const wid of staleLanes) {
      lines.push(`- ${wid}: Non-terminal task exceeded staleness threshold. Request progress or close.`);
    }
    lines.push("");
  }

  // Timeout lanes
  if (timeoutLanes.length > 0) {
    lines.push(`### Timeout lanes (${timeoutLanes.length})`);
    lines.push("");
    for (const wid of timeoutLanes) {
      lines.push(`- ${wid}: Past round deadline without terminal evidence.`);
    }
    lines.push("");
  }

  // Blocked lanes
  if (blockedLanes.length > 0) {
    lines.push(`### Blocked lanes (${blockedLanes.length})`);
    lines.push("");
    for (const lane of lanes.filter((l) => blockedLanes.includes(l.workerId))) {
      const detail = lane.errorSummary ?? lane.outcomeSummary ?? "No details";
      const ev = lane.evidenceUrls.length > 0
        ? ` Evidence: ${lane.evidenceUrls.join(", ")}.`
        : " No evidence URL found.";
      lines.push(`- ${lane.workerId}: ${detail}${ev}`);
    }
    lines.push("");
  }

  // All evidence URLs
  if (evidenceUrls.length > 0) {
    lines.push("### Evidence URLs");
    lines.push("");
    for (const url of evidenceUrls) {
      lines.push(`- ${url}`);
    }
    lines.push("");
  }

  // Finalizer next actions
  if (verdictActionPlan.kind === "reject_feedback_requeue") {
    lines.push("### Reject-feedback requeue plan");
    lines.push("");
    lines.push("This projection is source-only and does not requeue tasks by itself; an external dispatcher/finalizer must consume the plan explicitly.");
    lines.push("");
    for (const lane of verdictActionPlan.lanes) {
      lines.push(`- ${lane.workerId}: ${lane.rejectionReason}; prior=${lane.priorAttemptEvidenceRef}`);
    }
    lines.push("");
  }

  // Finalizer next actions
  lines.push("### Finalizer next actions");
  lines.push("");
  const actions = buildFinalizerActions(summary, missingLanes.length, staleLanes.length, timeoutLanes.length, blockedLanes.length, summary.queuedUnclaimed);
  for (const action of actions) {
    lines.push(`- ${action}`);
  }
  // Add child issue links from evidence URLs that reference GitHub issues/PRs
  const childRefs = extractChildIssueRefs(evidenceUrls);
  if (childRefs.length > 0) {
    lines.push("");
    lines.push("### Child issue references");
    lines.push("");
    for (const ref of childRefs) {
      lines.push(`- ${ref}`);
    }
    lines.push("");
  }
  // Preserve dissent/missing evidence from failed lanes
  const dissentLanes = lanes.filter((l) => l.errorSummary && (l.errorSummary.includes("Dissent") || l.errorSummary.includes("dissent") || l.errorSummary.includes("Unsafe") || l.errorSummary.includes("unsafe") || l.laneState === "failed"));
  if (dissentLanes.length > 0) {
    lines.push("### Dissent / missing evidence");
    lines.push("");
    for (const lane of dissentLanes) {
      lines.push(`- **${lane.workerId}** (${lane.laneState}): ${lane.errorSummary ?? lane.outcomeSummary ?? "No details"}`);
    }
    lines.push("");
  }
  lines.push("");

  // Safety disclaimer
  lines.push("---");
  lines.push("");
  lines.push("_This is a draft-only closeout bundle. No comments, closes, merges, deploys, live sends, ACKs, or DB mutations have been executed._");

  return lines.join("\n");
}

function stateEmoji(state: RoundLaneState): string {
  switch (state) {
    case "succeeded":
      return "✅";
    case "failed":
      return "❌";
    case "blocked":
      return "🚫";
    case "pending":
      return "⏳";
    case "running":
      return "🔄";
    case "stale":
      return "⚠️";
    case "timeout":
      return "⏰";
  }
}

function laneAttribution(lane: ResultLane): string {
  const parts: string[] = [];
  if (lane.parentRoundId) parts.push(`parent=${lane.parentRoundId}`);
  if (lane.parentRoundOrder !== undefined && lane.parentRoundTotal !== undefined) {
    parts.push(`order=${lane.parentRoundOrder}/${lane.parentRoundTotal}`);
  } else if (lane.parentRoundOrder !== undefined) {
    parts.push(`order=${lane.parentRoundOrder}`);
  }
  if (lane.originBrokerId) parts.push(`origin=${lane.originBrokerId}`);
  if (lane.brokerOfRecordId) parts.push(`broker=${lane.brokerOfRecordId}`);
  if (lane.assignedWorkerId && lane.assignedWorkerId !== lane.workerId) parts.push(`assigned=${lane.assignedWorkerId}`);
  return parts.length > 0 ? `; ${parts.join("; ")}` : "";
}

function buildFinalizerActions(
  summary: RoundResultCollectorOutput["summary"],
  missingCount: number,
  staleCount: number,
  timeoutCount: number,
  blockedCount: number,
  queuedUnclaimedCount: number,
): string[] {
  const actions: string[] = [];

  const needsReview = blockedCount > 0 || staleCount > 0 || timeoutCount > 0 || missingCount > 0 || queuedUnclaimedCount > 0;

  if (needsReview) {
    if (missingCount > 0) actions.push(`Review ${missingCount} missing lane(s): dispatch or mark excluded before closeout.`);
    if (queuedUnclaimedCount > 0) actions.push(`Review ${queuedUnclaimedCount} queued/unclaimed lane(s): verify worker liveness or exclude before final A2AD closeout.`);
    if (staleCount > 0) actions.push(`Inspect ${staleCount} stale lane(s): request progress or reassign.`);
    if (timeoutCount > 0) actions.push(`Review ${timeoutCount} timeout lane(s): decide retry, split, or defer.`);
    if (blockedCount > 0) actions.push(`Inspect ${blockedCount} blocked lane(s): read Block evidence and decide retry/skip.`);
    actions.push("Do not merge or close until all required lanes are resolved.");
  } else if (summary.pending > 0 || summary.running > 0) {
    actions.push("Wait for remaining active lanes to complete before closeout.");
  } else {
    actions.push("All lanes completed. Proceed with finalizer closeout review.");
    actions.push("Post round-complete evidence and prepare next round or release.");
  }

  actions.push("No automatic close, merge, deploy, live send, ACK, or DB mutation by this projection.");

  return actions;
}

// ---------------------------------------------------------------------------
// Evidence class label rendering
// ---------------------------------------------------------------------------

function evidenceClassLabel(cls: RoundLaneEvidenceClass): string {
  switch (cls) {
    case "substantive": return "✅ substantive";
    case "oracle_mismatch": return "🚫 oracle_mismatch";
    case "wrapper_only": return "🔲 wrapper_only";
    case "handler_artifact_failure": return "⚠️ handler_artifact_failure";
    case "source_blocked": return "🚫 source_blocked";
    case "queued_unclaimed": return "⏳ queued_unclaimed";
    case "stale_or_missing_worker": return "🕐 stale_or_missing_worker";
    case "non_substantive": return "❌ non_substantive";
    case "superseded_by_supplement": return "🔁 superseded_by_supplement";
  }
}

// ---------------------------------------------------------------------------
// Child issue reference extraction
// ---------------------------------------------------------------------------

/**
 * Extract child issue references (GitHub issue/PR URLs) from evidence URLs.
 */
function extractChildIssueRefs(urls: string[]): string[] {
  const refs: string[] = [];
  for (const url of urls) {
    if (!url.startsWith("https://")) continue;
    // Match GitHub issue/PR URLs to extract readable references
    const issueMatch = url.match(/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/(\d+)/);
    if (issueMatch) {
      refs.push(`Child: ${url}`);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// #920: Compact evidence summary report (CLI/notification-friendly)
// ---------------------------------------------------------------------------

export interface CompactEvidenceSummaryOptions {
  /** Parent tracker issue URL to surface in the summary. */
  parentIssueUrl?: string;
}

/**
 * Render a compact, one-line-per-lane evidence summary report.
 * Intended for CLI output, GitHub tracker comments, and operator notifications.
 *
 * Each lane shows: workerId, classification, state, evidence URLs, and
 * a brief outcome note. Excludes raw task output/error details, secrets,
 * and full transcripts.
 */
export function renderCompactEvidenceSummary(
  output: RoundResultCollectorOutput,
  options: CompactEvidenceSummaryOptions = {},
): string {
  const lines: string[] = [];
  const { parentIssueUrl } = options;

  lines.push("## A2AD evidence summary");
  lines.push("");
  lines.push(`Round: ${output.roundLabel}`);
  if (parentIssueUrl) lines.push(`Parent: ${parentIssueUrl}`);
  lines.push(`Verdict: ${output.gateVerdict?.verdict ?? "PENDING"}`);
  lines.push(`Generated: ${output.generatedAt}`);
  lines.push("");

  // Summary bar
  const s = output.summary;
  lines.push(`**${s.completed}/${s.totalLanes} lanes completed.** ${s.blocked} blocked, ${s.stale} stale, ${s.timeout} timeout, ${s.pending + s.running} active.`);
  lines.push(`Evidence: ${s.substantiveEvidence} substantive, ${s.wrapperOnly} wrapper-only, ${s.sourceBlocked} source-blocked, ${s.handlerArtifactFailures} handler-artifact-failures, ${s.queuedUnclaimed} queued/unclaimed, ${s.nonSubstantive} non-substantive.`);
  lines.push("");

  // Per-lane summary
  lines.push("### Lanes");
  lines.push("");
  lines.push("| Worker | Classification | State | Evidence refs | Outcome |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const lane of output.lanes) {
    const cls = lane.evidenceClass ?? "unclassified";
    const ev = lane.evidenceUrls.length > 0
      ? lane.evidenceUrls.slice(0, 2).map((url) => `[link](${url})`).join(" ")
      : "—";
    const outcome = lane.outcomeSummary ?? lane.laneState;
    lines.push(`| ${lane.workerId} | ${cls} | ${lane.laneState} | ${ev} | ${outcome} |`);
  }
  lines.push("");

  // Non-actions disclaimer
  if (output.approvalSensitiveActionsExcluded.length > 0) {
    lines.push("### Non-actions");
    lines.push("");
    for (const action of output.approvalSensitiveActionsExcluded) {
      lines.push(`- No ${action.toLowerCase()}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("_Summary is source-only evidence. No deploy, DB mutation, provider send, or secret movement._");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// #920: Round complete notification payload
// ---------------------------------------------------------------------------

/**
 * Compact notification payload for round complete or fail events.
 *
 * Designed for optional delivery to operator surfaces (CLI, GitHub tracker,
 * notification handlers). Excludes raw task transcripts, secrets, and
 * full task output/error details.
 */
export interface RoundCompletePayload {
  roundLabel: string;
  parentIssueUrl?: string;
  verdict: "FINAL" | "BLOCKED" | "PENDING";
  generatedAt: string;
  lanes: Array<{
    workerId: string;
    description?: string;
    state: RoundLaneState;
    evidenceClass?: RoundLaneEvidenceClass;
    evidenceUrls: string[];
    prUrl?: string;
    doneUrl?: string;
    blockUrl?: string;
  }>;
  summary: {
    totalLanes: number;
    completed: number;
    substantive: number;
    blocked: number;
    stale: number;
    timeout: number;
  };
}

/**
 * Build a compact notification payload from a collector output.
 * Strips raw task output, error details, and full transcripts.
 */
export function buildRoundCompletePayload(
  output: RoundResultCollectorOutput,
): RoundCompletePayload {
  return {
    roundLabel: output.roundLabel,
    parentIssueUrl: output.parentIssueUrl,
    verdict: output.gateVerdict?.verdict ?? "PENDING",
    generatedAt: output.generatedAt,
    lanes: output.lanes.map((lane) => ({
      workerId: lane.workerId,
      description: lane.description,
      state: lane.laneState,
      evidenceClass: lane.evidenceClass,
      evidenceUrls: lane.evidenceUrls,
      prUrl: lane.prUrl,
      doneUrl: lane.doneUrl,
      blockUrl: lane.blockUrl,
    })),
    summary: {
      totalLanes: output.summary.totalLanes,
      completed: output.summary.completed,
      substantive: output.summary.substantiveEvidence,
      blocked: output.summary.blocked,
      stale: output.summary.stale,
      timeout: output.summary.timeout,
    },
  };
}

// ---------------------------------------------------------------------------
// Convenience: build a RoundManifest from simple arguments
// ---------------------------------------------------------------------------

/**
 * Build a RoundManifest from simple worker-id and options arguments.
 * Useful for operators composing a round manifest inline.
 */
export function buildRoundManifest(
  roundLabel: string,
  workerIds: string[],
  options: {
    descriptions?: Record<string, string>;
    expectedOutcomes?: Record<string, RoundLaneExpectedOutcome>;
    parentIssueUrl?: string;
    excludedWorkerIds?: string[];
    staleAfterMs?: number;
    timeoutAt?: string;
  } = {},
): RoundManifest {
  const lanes: RoundManifestLane[] = workerIds.map((workerId) => ({
    workerId,
    description: options.descriptions?.[workerId],
    expectedOutcome: options.expectedOutcomes?.[workerId],
  }));

  return {
    roundLabel,
    parentIssueUrl: options.parentIssueUrl,
    lanes,
    excludedWorkerIds: options.excludedWorkerIds,
    staleAfterMs: options.staleAfterMs,
    timeoutAt: options.timeoutAt,
  };
}
