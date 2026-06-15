import { createHash } from "node:crypto";
import {
  buildRoundManifest as buildCoreRoundManifest,
  projectRoundManifest,
  renderRoundManifestMarkdown,
  ROUND_MANIFEST_KIND,
  ROUND_MANIFEST_VERSION,
  DEFAULT_ROUND_STALE_AFTER_MS,
  DEFAULT_ROUND_TIMEOUT_AFTER_MS,
  type RoundManifest,
  type RoundManifestProjection,
  type RoundManifestOptions,
  type WorkerRoundAssignment,
  type WorkerEvidencePolicy,
  type RoundDeadlineConfig,
  type RoundCloseoutPolicy,
} from "./round-manifest.js";
import type { A2AWorkModeDecisionEvidence } from "./work-mode-pre-dispatch-decision.js";

// ── Round spec ──────────────────────────────────────────────────────────────

export type Team1Lane = 1 | 2 | 3 | 4;

export const TEAM1_DEFAULT_PARENT_ROUND_TOTAL = 4;

export interface Team1RoundSpec {
  /** Team identifier, always "team1" for this lane. */
  teamId: "team1";
  /** Lane number (1-4). */
  lane: Team1Lane;
  /** Short worker handle. */
  worker: string;
  /** A2A run identifier from the broker. */
  runId: string;
  /** Parent tracker issue URL. */
  parentIssueUrl: string;
  /** Current lane issue URL. */
  childIssueUrl: string;
  /** Broker issue number (short form like "#848"). */
  childIssue?: string;
  /** Optional structured metadata tags. */
  tags?: Record<string, string>;
  /** Per-task model escalation hints for Docker-runner embedded OpenClaw. */
  modelEscalation?: Team1ModelEscalationInput;
  /** Optional round label for operator reports. */
  roundLabel?: string;
  /** Canonical Terminal Brief parent round id. Defaults to runId. */
  parentRoundId?: string;
  /** Total lane/task count for the parent round. Defaults to the Team1 lane count. */
  parentRoundTotal?: number;
  /** 1-based lane/task order inside the parent round. Defaults to lane. */
  parentRoundOrder?: number;
  /** Actual Team1 workers that will receive tasks in this dispatch round. */
  dispatchWorkers?: string[];
  /** Explicit allowlisted model override for this round's tasks. */
  workerModel?: string;
  /** Explicit thinking level override for this round's tasks. */
  workerThinking?: string;
  /**
   * When true, this lane is a read-only audit/libero lane that does not
   * require a PR or repository diff. The evidence policy accepts Done
   * and Block evidence only. The dispatch contract carries explicit
   * allowNoChanges and readOnlyValidation flags so the Docker Runner
   * does not fail-closed on a missing diff.
   *
   * @see a2a-broker#953 — prevent read-only A2A audit dispatch from
   *      omitting no-change evidence flags
   */
  readOnlyAudit?: boolean;
  /** Durable work-mode evidence required for execute-mode Team1 dispatch. */
  workModeDecision?: A2AWorkModeDecisionEvidence;
}

// ── Worker model policy ────────────────────────────────────────────────────

export const TEAM1_DEFAULT_WORKER_MODEL = "openai-codex/gpt-5.5";
export const TEAM1_PRO_ESCALATION_MODEL = "deepseek/deepseek-v4-pro";

export type Team1ModelEscalationReason =
  | "context_heavy"
  | "broad_source_inspection"
  | "context_overflow_retry"
  | "no_change_evidence_salvage";

export interface Team1ModelEscalationInput {
  /** Force the approved per-task Pro path even when no specific reason flag is set. */
  forcePro?: boolean;
  /** Structured reason list for auditability and deterministic run records. */
  reasons?: Team1ModelEscalationReason[];
}

// ── Allowlisted worker models ──────────────────────────────────────────────

export const TEAM1_ALLOWED_WORKER_MODELS: ReadonlySet<string> = new Set([
  TEAM1_DEFAULT_WORKER_MODEL,
  TEAM1_PRO_ESCALATION_MODEL,
  "deepseek/deepseek-v4-flash",
  "deepseek-v4-pro",
  "gpt-5.5",
  "grok-4.20",
  "minimax-m3",
]);

/** Default thinking level when not overridden per-task. */
export const TEAM1_DEFAULT_WORKER_THINKING = "low";

/**
 * Valid OpenClaw --thinking values.
 * Based on `openclaw agent --help`: off, minimal, low, medium, high, xhigh, adaptive, max.
 */
export const TEAM1_ALLOWED_WORKER_THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max",
]);

/** Runtime per-task model payload fields carried to the handler/runner. */
export interface Team1WorkerModelPayloadOverrides {
  /** Explicit allowlisted model override for this task. */
  workerModel?: string;
  /** Explicit thinking level override for this task. */
  workerThinking?: string;
  /** Escalation reasons for the model decision. */
  workerModelEscalationReasons?: string;
}

export interface Team1WorkerModelPolicy {
  defaultModel: typeof TEAM1_DEFAULT_WORKER_MODEL;
  proModel: typeof TEAM1_PRO_ESCALATION_MODEL;
  selectedModel: string;
  selectedThinking: string;
  escalatedToPro: boolean;
  escalationApproved: true;
  approvalRef: "Seo Jin On 2026-05-21 per-task approval";
  reasons: Team1ModelEscalationReason[];
  env: {
    A2A_OPENCLAW_MODEL: string;
  };
  boundary: "per-task model override only; no default change, restart, deploy, or credential change";
  /** Payload override fields for the broker task payload. */
  payloadOverrides: Team1WorkerModelPayloadOverrides;
}

export interface Team1ParentRoundDispatchMetadata {
  parentRoundId: string;
  parentRoundTotal: number;
  parentRoundOrder: number;
  parentRoundTotalSource: "explicit" | "team1-default" | "dispatch-workers";
  parentRoundOrderSource: "explicit" | "lane" | "dispatch-workers";
}

const TAG_REASON_MAP: Record<string, Team1ModelEscalationReason> = {
  contextHeavy: "context_heavy",
  "model:contextHeavy": "context_heavy",
  broadSourceInspection: "broad_source_inspection",
  "model:broadSourceInspection": "broad_source_inspection",
  contextOverflowRetry: "context_overflow_retry",
  "model:contextOverflowRetry": "context_overflow_retry",
  noChangeEvidenceSalvage: "no_change_evidence_salvage",
  "model:noChangeEvidenceSalvage": "no_change_evidence_salvage",
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function resolveTeam1ParentRoundMetadata(roundSpec: Team1RoundSpec): {
  metadata?: Team1ParentRoundDispatchMetadata;
  issues: string[];
} {
  const issues: string[] = [];
  const parentRoundId = (roundSpec.parentRoundId ?? roundSpec.runId).trim();
  const dispatchWorkers = normalizeWorkerList(roundSpec.dispatchWorkers);
  const dispatchOrder = dispatchWorkers.indexOf(roundSpec.worker) + 1;
  const parentRoundTotal = dispatchWorkers.length > 0
    ? dispatchWorkers.length
    : roundSpec.parentRoundTotal ?? TEAM1_DEFAULT_PARENT_ROUND_TOTAL;
  const parentRoundOrder = dispatchOrder > 0
    ? dispatchOrder
    : roundSpec.parentRoundOrder ?? roundSpec.lane;

  if (parentRoundId.length === 0) {
    issues.push("parentRoundId is required; provide --run-id or --parent-round-id");
  }
  if (!isPositiveInteger(parentRoundTotal)) {
    issues.push(`parentRoundTotal must be a positive integer, got ${String(parentRoundTotal)}`);
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

  if (issues.length > 0) {
    return { issues };
  }

  return {
    metadata: {
      parentRoundId,
      parentRoundTotal,
      parentRoundOrder,
      parentRoundTotalSource: dispatchWorkers.length > 0
        ? "dispatch-workers"
        : roundSpec.parentRoundTotal === undefined ? "team1-default" : "explicit",
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

/**
 * Parse a GitHub issue URL into owner, repo, and issue number.
 * Returns null for non-GitHub, non-issue URLs.
 */
function parseGithubIssueUrl(url: string): { owner: string; repo: string; issueNumber: number } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], issueNumber: parseInt(m[3], 10) };
  } catch {
    return null;
  }
}

/**
 * Build a canonical RoundManifest from the Team1 round spec.
 *
 * The manifest includes the parent issue, the current lane assignment,
 * deterministic IDs, evidence policy, safety gates, and fail-closed
 * closeout policy. All fields are deterministic for identical inputs.
 *
 * This is the "wiring" point where the new round-manifest primitives
 * (issue #928) enter the Team1 dispatch pipeline.
 */
export function buildTeam1RoundManifest(
  roundSpec: Team1RoundSpec,
  config: Team1DispatchConfig,
  closeoutPolicy?: Partial<RoundCloseoutPolicy>,
  deadlineConfig?: RoundDeadlineConfig,
): { manifest: RoundManifest; projection: RoundManifestProjection } | null {
  const parsed = parseGithubIssueUrl(roundSpec.parentIssueUrl);
  if (!parsed) return null;

  const parentRepo = `${parsed.owner}/${parsed.repo}`;

  // Build the worker assignment for this lane with deterministic task ID
  const deterministicTaskId = buildDeterministicTaskId(roundSpec, config);
  const now = config.now ?? generatedAtFromRunId(roundSpec.runId);
  const parentRoundMetadata = resolveTeam1ParentRoundMetadata(roundSpec).metadata;

  const worker: WorkerRoundAssignment = {
    workerId: roundSpec.worker,
    lane: roundSpec.lane,
    taskDescription: roundSpec.roundLabel ?? undefined,
    taskId: deterministicTaskId.taskId,
    deadlineAt: deadlineConfig?.roundDeadlineAt ?? undefined,
    evidencePolicy: undefined, // rely on defaultEvidencePolicy
    modelEscalationHints: roundSpec.modelEscalation
      ? {
          forcePro: roundSpec.modelEscalation.forcePro,
          reasons: roundSpec.modelEscalation.reasons,
          workerModel: roundSpec.workerModel,
          workerThinking: roundSpec.workerThinking,
        }
      : undefined,
    metadata: parentRoundMetadata
      ? {
          parentRoundId: parentRoundMetadata.parentRoundId,
          parentRoundTotal: String(parentRoundMetadata.parentRoundTotal),
          parentRoundOrder: String(parentRoundMetadata.parentRoundOrder),
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
        }
      : undefined,
  };

  // Merge closeout policy with fail-closed defaults
  const mergedCloseoutPolicy: RoundCloseoutPolicy = {
    automaticCloseout: false,
    automaticFinalizer: false,
    requireAllWorkersComplete: true,
    timeoutOnDeadlineExceeded: false,
    ...closeoutPolicy,
  };

  const isReadOnlyAudit = roundSpec.readOnlyAudit === true;
  const defaultEvidencePolicy: WorkerEvidencePolicy = isReadOnlyAudit
    ? { requiredTypes: ["done", "block"], minimumRequired: 1 }
    : { requiredTypes: ["pr", "done", "block"], minimumRequired: 1 };

  const manifestOptions: RoundManifestOptions = {
    parentRepo,
    parentIssueNumber: parsed.issueNumber,
    teamId: roundSpec.teamId,
    runId: roundSpec.runId,
    roundLabel: roundSpec.roundLabel ?? undefined,
    generatedAt: now,
    expectedWorkers: [worker],
    closeoutPolicy: mergedCloseoutPolicy,
    deadlineConfig,
    defaultEvidencePolicy,
    metadata: {
      childIssueUrl: roundSpec.childIssueUrl,
      childIssue: roundSpec.childIssue ?? "",
      workerModel: roundSpec.workerModel ?? "",
      ...(parentRoundMetadata
        ? {
            parentRoundId: parentRoundMetadata.parentRoundId,
            parentRoundTotal: String(parentRoundMetadata.parentRoundTotal),
            parentRoundOrder: String(parentRoundMetadata.parentRoundOrder),
          }
        : {}),
      ...(isReadOnlyAudit ? { readOnlyAudit: "true", allowNoChanges: "true", readOnlyValidation: "true" } : {}),
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

  const manifest = buildCoreRoundManifest(manifestOptions);
  const projection = projectRoundManifest(manifest);
  return { manifest, projection };
}

// ── Dispatch config ─────────────────────────────────────────────────────────

export interface Team1DispatchConfig {
  /** When true, all mutating operations are blocked. Default true. */
  dryRun: boolean;
  /** Explicit opt-in to write operations (ignored when dryRun=true). */
  execute: boolean;
  /** Worker preflight checks enabled. */
  preflightEnabled: boolean;
  /** Now timestamp for deterministic generation tracking. */
  now?: string;
}

const DEFAULT_DISPATCH_CONFIG: Team1DispatchConfig = {
  dryRun: true,
  execute: false,
  preflightEnabled: true,
};

// ── Preflight checks ────────────────────────────────────────────────────────

export type PreflightCheckId =
  | "worker_online"
  | "worker_capability_card_present"
  | "worker_supports_propose_patch"
  | "worker_github_patch_runtime_ready"
  | "parent_issue_reachable"
  | "child_issue_reachable"
  | "run_id_deterministic"
  | "parent_round_metadata_populated"
  | "work_mode_decision_evidence"
  | "approval_boundary_respected";

export type PreflightStatus = "pass" | "warn" | "fail" | "skipped";

export interface PreflightResult {
  checkId: PreflightCheckId;
  label: string;
  status: PreflightStatus;
  detail?: string;
}

// ── Deterministic task ID ───────────────────────────────────────────────────

export interface DeterministicTaskId {
  /** SHA-256 hex digest used as deterministic identifier. */
  taskId: string;
  /** Human-readable short form for logs. */
  shortId: string;
  /** Pre-image inputs used to generate this id. */
  preImage: string;
  /** Idempotency guard: same inputs → same taskId. */
  idempotent: true;
}

export function buildDeterministicTaskId(
  roundSpec: Team1RoundSpec,
  config: Team1DispatchConfig,
  kind: string = "dispatch-plan",
): DeterministicTaskId {
  const parentRound = resolveTeam1ParentRoundMetadata(roundSpec).metadata;
  const preImage = [
    "team1-dispatch-wrapper/v1",
    `teamId=${roundSpec.teamId}`,
    `lane=${roundSpec.lane}`,
    `worker=${roundSpec.worker}`,
    `runId=${roundSpec.runId}`,
    `parentRoundId=${parentRound?.parentRoundId ?? roundSpec.parentRoundId ?? roundSpec.runId}`,
    `parentRoundTotal=${String(parentRound?.parentRoundTotal ?? roundSpec.parentRoundTotal ?? TEAM1_DEFAULT_PARENT_ROUND_TOTAL)}`,
    `parentRoundOrder=${String(parentRound?.parentRoundOrder ?? roundSpec.parentRoundOrder ?? roundSpec.lane)}`,
    `dispatchWorkers=${normalizeWorkerList(roundSpec.dispatchWorkers).join(",")}`,
    `parentIssue=${roundSpec.parentIssueUrl}`,
    `childIssue=${roundSpec.childIssueUrl}`,
    `dryRun=${String(config.dryRun)}`,
    `execute=${String(config.execute)}`,
    `kind=${kind}`,
  ].join("|");

  const hash = createHash("sha256").update(preImage).digest("hex");
  return {
    taskId: `team1-${hash.slice(0, 32)}`,
    shortId: hash.slice(0, 12),
    preImage,
    idempotent: true,
  };
}

// ── Sanitized run record ────────────────────────────────────────────────────

export interface Team1SanitizedRunRecord {
  runId: string;
  teamId: "team1";
  lane: Team1Lane;
  worker: string;
  taskId: string;
  shortId: string;
  dryRun: boolean;
  executeMode: boolean;
  parentIssue: string;
  childIssue: string;
  metadata: Record<string, string>;
  modelPolicy: Team1WorkerModelPolicy;
  preflightResults: PreflightResult[];
  dispatchActions: string[];
  generatedAt: string;
  /** Deterministic checksum of this record for replay detection. */
  recordChecksum: string;
}

export interface Team1DispatchTaskPayload {
  taskId: string;
  teamId: "team1";
  lane: Team1Lane;
  worker: string;
  runId: string;
  parentRoundId: string;
  parentRoundTotal: number;
  parentRoundOrder: number;
  dispatchedWorkers?: string[];
  parentIssueUrl: string;
  childIssueUrl: string;
  childIssue?: string;
  workerModel: string;
  workerThinking: string;
  workerModelEscalationReasons?: string;
  readOnlyAudit?: true;
  allowNoChanges?: true;
  readOnlyValidation?: true;
  workModeDecision?: A2AWorkModeDecisionEvidence;
}

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /\b(BROKER_EDGE_SECRET|EDGE_SECRET|TOKEN|SECRET)=\S+/gi,
  /\/root\/\.openclaw\/[^\s]+/g,
];

function sanitizeText(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (/gh[pousr]/.test(match)) return "[redacted-token]";
      if (/SECRET|TOKEN/.test(match)) return match.split("=")[0] + "=[redacted]";
      return "[openclaw-path]";
    });
  }
  return result;
}

function buildRecordChecksum(record: Omit<Team1SanitizedRunRecord, "recordChecksum">): string {
  const normalized = JSON.stringify(record, Object.keys(record).sort());
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function generatedAtFromRunId(runId: string): string {
  const match = runId.match(/(20\d{2})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  if (!match) {
    return "1970-01-01T00:00:00.000Z";
  }
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

function isTruthyTagValue(value: string | undefined): boolean {
  return /^(1|true|yes|y|on)$/i.test(value ?? "");
}

/**
 * Resolve the effective worker model policy for a round spec.
 *
 * Priority:
 * 1. Explicit `workerModel` override in roundSpec (must be allowlisted).
 * 2. Escalation to Pro if reasons or tags demand it.
 * 3. Current native Hermes fleet baseline model.
 *
 * The `workerThinking` override is passed through if valid (must be in ALLOWED_THINKING_LEVELS).
 */
export function resolveTeam1WorkerModelPolicy(roundSpec: Team1RoundSpec): Team1WorkerModelPolicy {
  const reasons = new Set<Team1ModelEscalationReason>(roundSpec.modelEscalation?.reasons ?? []);
  for (const [tag, reason] of Object.entries(TAG_REASON_MAP)) {
    if (isTruthyTagValue(roundSpec.tags?.[tag])) reasons.add(reason);
  }

  const forcePro = roundSpec.modelEscalation?.forcePro === true
    || isTruthyTagValue(roundSpec.tags?.forceProModel)
    || isTruthyTagValue(roundSpec.tags?.["model:forcePro"]);
  const escalatedToPro = forcePro || reasons.size > 0;

  // Explicit override takes priority over escalation-based selection
  const explicitModel: string | undefined =
    roundSpec.workerModel && TEAM1_ALLOWED_WORKER_MODELS.has(roundSpec.workerModel)
      ? roundSpec.workerModel
      : undefined;
  const selectedModel = explicitModel ?? (escalatedToPro ? TEAM1_PRO_ESCALATION_MODEL : TEAM1_DEFAULT_WORKER_MODEL);

  // Determine escalation reasons for explicit model override
  const isProExplicitlyRequested = explicitModel === TEAM1_PRO_ESCALATION_MODEL;
  const isProByEscalation = !explicitModel && escalatedToPro;
  const finalEscalatedToPro = explicitModel === TEAM1_PRO_ESCALATION_MODEL || (!explicitModel && escalatedToPro);
  const finalReasons = isProExplicitlyRequested && reasons.size === 0
    ? []
    : [...reasons].sort();

  // Thinking level: explicit override or default
  const selectedThinking = roundSpec.workerThinking && TEAM1_ALLOWED_WORKER_THINKING_LEVELS.has(roundSpec.workerThinking)
    ? roundSpec.workerThinking
    : TEAM1_DEFAULT_WORKER_THINKING;

  // Build the payload override fields that the handler/runner will read
  const payloadOverrides: Team1WorkerModelPayloadOverrides = {
    workerModel: selectedModel,
    workerThinking: selectedThinking !== TEAM1_DEFAULT_WORKER_THINKING ? selectedThinking : undefined,
    workerModelEscalationReasons: finalReasons.length > 0 ? finalReasons.join(",") : undefined,
  };

  return {
    defaultModel: TEAM1_DEFAULT_WORKER_MODEL,
    proModel: TEAM1_PRO_ESCALATION_MODEL,
    selectedModel,
    selectedThinking,
    escalatedToPro: finalEscalatedToPro,
    escalationApproved: true,
    approvalRef: "Seo Jin On 2026-05-21 per-task approval",
    reasons: finalReasons,
    env: {
      A2A_OPENCLAW_MODEL: selectedModel,
    },
    boundary: "per-task model override only; no default change, restart, deploy, or credential change",
    payloadOverrides,
  };
}

// ── Worker preflight ────────────────────────────────────────────────────────

export function runTeam1PreflightChecks(
  roundSpec: Team1RoundSpec,
  config: Team1DispatchConfig,
  workerCapabilityPresent?: boolean,
  workerGithubPatchRuntimeReady?: boolean,
): PreflightResult[] {
  const results: PreflightResult[] = [];

  // Worker online check
  if (config.preflightEnabled) {
    if (workerCapabilityPresent === true) {
      results.push({ checkId: "worker_online", label: "Worker online", status: "pass" });
    } else if (workerCapabilityPresent === false) {
      results.push({ checkId: "worker_online", label: "Worker online", status: "fail", detail: `Worker ${roundSpec.worker} capability card not found` });
    } else {
      results.push({ checkId: "worker_online", label: "Worker online", status: "skipped", detail: "No capability data provided for validation" });
    }
  } else {
    results.push({ checkId: "worker_online", label: "Worker online", status: "skipped", detail: "Preflight checks disabled" });
  }

  // Worker capability card present
  if (config.preflightEnabled) {
    results.push({
      checkId: "worker_capability_card_present",
      label: "Worker capability card present",
      status: workerCapabilityPresent === true ? "pass" : workerCapabilityPresent === false ? "fail" : "skipped",
      detail: workerCapabilityPresent === false ? `No capability card for ${roundSpec.worker}` : undefined,
    });
  } else {
    results.push({ checkId: "worker_capability_card_present", label: "Worker capability card present", status: "skipped", detail: "Preflight checks disabled" });
  }

  // Worker supports propose_patch
  if (config.preflightEnabled) {
    results.push({
      checkId: "worker_supports_propose_patch",
      label: "Worker supports propose_patch",
      status: workerCapabilityPresent === true ? "pass" : "skipped",
      detail: workerCapabilityPresent !== true ? "Cannot verify without capability data" : undefined,
    });
  } else {
    results.push({ checkId: "worker_supports_propose_patch", label: "Worker supports propose_patch", status: "skipped", detail: "Preflight checks disabled" });
  }

  // Worker github-propose-patch runtime readiness.
  // Worker online/capability is not enough: Docker-runner may still fail before
  // implementation when the OpenClaw/Codex patch command is not provisioned.
  if (config.preflightEnabled) {
    results.push({
      checkId: "worker_github_patch_runtime_ready",
      label: "Worker github-propose-patch runtime ready",
      status: workerGithubPatchRuntimeReady === true ? "pass" : workerGithubPatchRuntimeReady === false ? "fail" : "skipped",
      detail: workerGithubPatchRuntimeReady === false
        ? `Worker ${roundSpec.worker} patch runtime is not ready; require a2a-docker-runner doctor githubPatch.status=ok before fan-out`
        : workerGithubPatchRuntimeReady === undefined
          ? "No githubPatch runtime readiness data provided"
          : undefined,
    });
  } else {
    results.push({
      checkId: "worker_github_patch_runtime_ready",
      label: "Worker github-propose-patch runtime ready",
      status: "skipped",
      detail: "Preflight checks disabled",
    });
  }

  // Parent issue reachable
  results.push({
    checkId: "parent_issue_reachable",
    label: "Parent issue reachable",
    status: roundSpec.parentIssueUrl.startsWith("https://github.com/") ? "pass" : "fail",
    detail: roundSpec.parentIssueUrl.startsWith("https://github.com/") ? undefined : `Non-GitHub parent URL: ${sanitizeText(roundSpec.parentIssueUrl)}`,
  });

  // Child issue reachable
  results.push({
    checkId: "child_issue_reachable",
    label: "Child issue reachable",
    status: roundSpec.childIssueUrl.startsWith("https://github.com/") ? "pass" : "fail",
    detail: roundSpec.childIssueUrl.startsWith("https://github.com/") ? undefined : `Non-GitHub child URL: ${sanitizeText(roundSpec.childIssueUrl)}`,
  });

  // Deterministic run id
  results.push({
    checkId: "run_id_deterministic",
    label: "Run ID deterministic",
    status: roundSpec.runId.length > 0 ? "pass" : "fail",
    detail: roundSpec.runId.length > 0 ? undefined : "Run ID is empty; cannot produce deterministic task ids",
  });

  const parentRoundMetadata = resolveTeam1ParentRoundMetadata(roundSpec);
  results.push({
    checkId: "parent_round_metadata_populated",
    label: "Parent round metadata populated",
    status: parentRoundMetadata.issues.length === 0 ? "pass" : "fail",
    detail: parentRoundMetadata.issues.length === 0
      ? `parentRoundTotal=${parentRoundMetadata.metadata?.parentRoundTotal} parentRoundOrder=${parentRoundMetadata.metadata?.parentRoundOrder}`
      : parentRoundMetadata.issues.join("; "),
  });

  if (!config.dryRun && config.execute) {
    if (roundSpec.workModeDecision) {
      results.push({
        checkId: "work_mode_decision_evidence",
        label: "Work-mode decision evidence",
        status: "pass",
        detail: `mode=${roundSpec.workModeDecision.mode} finalizer=${sanitizeText(roundSpec.workModeDecision.finalizerOwner)}`,
      });
    } else {
      results.push({
        checkId: "work_mode_decision_evidence",
        label: "Work-mode decision evidence",
        status: "fail",
        detail: "Execute-mode Team1 dispatch requires --work-mode-decision evidence",
      });
    }
  } else {
    results.push({
      checkId: "work_mode_decision_evidence",
      label: "Work-mode decision evidence",
      status: roundSpec.workModeDecision ? "pass" : "skipped",
      detail: roundSpec.workModeDecision
        ? `mode=${roundSpec.workModeDecision.mode} finalizer=${sanitizeText(roundSpec.workModeDecision.finalizerOwner)}`
        : "Dry-run planning; work-mode decision is required before execute-mode dispatch",
    });
  }

  // Approval boundary respected (fail-closed on dry-run with execute=false)
  if (config.dryRun || !config.execute) {
    results.push({
      checkId: "approval_boundary_respected",
      label: "Approval boundary respected",
      status: "pass",
      detail: "Dry-run or read-only mode; no write operations permitted",
    });
  } else {
    results.push({
      checkId: "approval_boundary_respected",
      label: "Approval boundary respected",
      status: "warn",
      detail: "Execute mode active; write operations are permitted",
    });
  }

  return results;
}

// ── Fail-closed decision ────────────────────────────────────────────────────

export type DispatchDecision = "go" | "blocked" | "warn_go";

export function evaluateDispatchDecision(preflights: PreflightResult[]): {
  decision: DispatchDecision;
  blockers: string[];
  warnings: string[];
} {
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const check of preflights) {
    if (check.status === "fail") {
      blockers.push(`[${check.checkId}] ${check.label}: ${check.detail ?? "check failed"}`);
    } else if (check.status === "warn") {
      warnings.push(`[${check.checkId}] ${check.label}: ${check.detail ?? "warning"}`);
    }
  }

  return {
    decision: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warn_go" : "go",
    blockers,
    warnings,
  };
}

// ── Build dispatch plan ─────────────────────────────────────────────────────

export interface Team1DispatchPlan {
  kind: "a2a-broker.team1-dispatch-plan.v1";
  version: 1;
  generatedAt: string;
  config: Team1DispatchConfig;
  roundSpec: Team1RoundSpec;
  deterministicTaskId: DeterministicTaskId;
  preflightResults: PreflightResult[];
  decision: {
    value: DispatchDecision;
    blockers: string[];
    warnings: string[];
  };
  dispatchActions: string[];
  runRecord: Team1SanitizedRunRecord;
  taskPayload: Team1DispatchTaskPayload | null;
  modelPolicy: Team1WorkerModelPolicy;
  metadata: {
    parentIssueUrl: string;
    childIssueUrl: string;
    parentChildChain: string;
    parentChildReversed: string;
    parentRoundId: string;
    parentRoundTotal: number;
    parentRoundOrder: number;
    dryRunDefault: true;
    executeExplicit: boolean;
    workerModel: string;
    workerThinking: string;
    workerModelEscalatedToPro: boolean;
    noLiveImpact: true;
    sourceOnly: true;
    /** True when this lane is a read-only audit/libero lane (no PR/diff required). */
    readOnlyAudit: boolean;
    /** True when no-change is an acceptable outcome (evidence-only Done/Block). */
    allowNoChanges: boolean;
    /** True when read-only validation is the lane's purpose. */
    readOnlyValidation: boolean;
    /** Durable work-mode evidence carried into task payload and manifests. */
    workModeDecision?: A2AWorkModeDecisionEvidence;
  };
  /**
   * Canonical RoundManifest (from round-manifest.ts) for this lane.
   * Present when the parent issue URL is parseable; null otherwise.
   *
   * This is the wiring point where round-manifest primitives enter the
   * Team1 dispatch pipeline (issue #928 -> #935).
   */
  roundManifest: RoundManifest | null;
  /** Lightweight projection of the round manifest for coordinator use. */
  roundManifestProjection: RoundManifestProjection | null;
}

export function buildTeam1DispatchPlan(
  roundSpec: Team1RoundSpec,
  config?: Partial<Team1DispatchConfig>,
  workerCapabilityPresent?: boolean,
  workerGithubPatchRuntimeReady?: boolean,
): Team1DispatchPlan {
  const mergedConfig: Team1DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG, ...config };
  const now = mergedConfig.now ?? generatedAtFromRunId(roundSpec.runId);
  const deterministicTaskId = buildDeterministicTaskId(roundSpec, mergedConfig);
  const preflightResults = runTeam1PreflightChecks(
    roundSpec,
    mergedConfig,
    workerCapabilityPresent,
    workerGithubPatchRuntimeReady,
  );
  const evalResult = evaluateDispatchDecision(preflightResults);
  const modelPolicy = resolveTeam1WorkerModelPolicy(roundSpec);
  const parentRoundMetadata = resolveTeam1ParentRoundMetadata(roundSpec).metadata;

  // Build dispatch actions
  const dispatchActions: string[] = [];
  dispatchActions.push(`[dispatch] broker /tasks: plan for ${deterministicTaskId.shortId}`);

  if (!mergedConfig.dryRun && mergedConfig.execute) {
    dispatchActions.push("[dispatch] execute writes: task creation enabled");
    if (preflightResults.every((p) => p.status !== "fail")) {
      dispatchActions.push(
        `[dispatch] createTask(${deterministicTaskId.taskId}, worker=${roundSpec.worker}, lane=${roundSpec.lane}, parentRound=${parentRoundMetadata?.parentRoundOrder}/${parentRoundMetadata?.parentRoundTotal})`,
      );
    } else {
      dispatchActions.push("[dispatch] createTask: blocked by preflight failures");
    }
  } else {
    dispatchActions.push("[dispatch] dry-run: no task writes performed");
  }

  // Parent/child metadata comments
  dispatchActions.push(`[metadata] parent: ${sanitizeText(roundSpec.parentIssueUrl)}`);
  dispatchActions.push(`[metadata] child: ${sanitizeText(roundSpec.childIssueUrl)}`);
  dispatchActions.push("[metadata] parent-child chain: resolved");
  if (parentRoundMetadata) {
    dispatchActions.push(
      `[metadata] parent round: id=${sanitizeText(parentRoundMetadata.parentRoundId)} order=${parentRoundMetadata.parentRoundOrder}/${parentRoundMetadata.parentRoundTotal}`,
    );
  }

  // Read-only audit lane evidence policy
  if (roundSpec.readOnlyAudit) {
    dispatchActions.push("[evidence] read-only audit lane: allowNoChanges=true readOnlyValidation=true");
    dispatchActions.push("[evidence] evidence policy: done, block only (no PR/diff required)");
  }
  if (roundSpec.workModeDecision) {
    dispatchActions.push(
      `[work-mode] decision: mode=${roundSpec.workModeDecision.mode} finalizer=${sanitizeText(roundSpec.workModeDecision.finalizerOwner)} idempotency=${roundSpec.workModeDecision.idempotencyKey}`,
    );
    dispatchActions.push(
      `[work-mode] capacity: state=${roundSpec.workModeDecision.capacityState} source=${sanitizeText(roundSpec.workModeDecision.capacitySnapshotSource)} at=${roundSpec.workModeDecision.capacitySnapshotAt}`,
    );
  } else {
    dispatchActions.push("[work-mode] decision: not supplied; dry-run planning only");
  }

  dispatchActions.push(`[model] A2A_OPENCLAW_MODEL=${modelPolicy.selectedModel}`);
  dispatchActions.push(`[model] thinking=${modelPolicy.selectedThinking}`);
  if (roundSpec.workerModel && TEAM1_ALLOWED_WORKER_MODELS.has(roundSpec.workerModel)) {
    dispatchActions.push(`[model] explicit override: workerModel=${roundSpec.workerModel}`);
  }
  if (roundSpec.workerThinking && TEAM1_ALLOWED_WORKER_THINKING_LEVELS.has(roundSpec.workerThinking)) {
    dispatchActions.push(`[model] explicit override: workerThinking=${roundSpec.workerThinking}`);
  }

  // Build sanitized run record
  const metadata: Record<string, string> = {};
  metadata["team"] = roundSpec.teamId;
  metadata["lane"] = String(roundSpec.lane);
  metadata["worker"] = roundSpec.worker;
  metadata["runId"] = roundSpec.runId;
  if (parentRoundMetadata) {
    metadata["parentRoundId"] = parentRoundMetadata.parentRoundId;
    metadata["parentRoundTotal"] = String(parentRoundMetadata.parentRoundTotal);
    metadata["parentRoundOrder"] = String(parentRoundMetadata.parentRoundOrder);
    metadata["parentRoundTotalSource"] = parentRoundMetadata.parentRoundTotalSource;
    metadata["parentRoundOrderSource"] = parentRoundMetadata.parentRoundOrderSource;
  }
  metadata["dryRun"] = String(mergedConfig.dryRun);
  metadata["execute"] = String(mergedConfig.execute);
  metadata["deterministicTaskId"] = deterministicTaskId.taskId;
  metadata["workerModel"] = modelPolicy.selectedModel;
  metadata["workerModelEscalatedToPro"] = String(modelPolicy.escalatedToPro);
  metadata["workerModelBoundary"] = modelPolicy.boundary;
  metadata["workerThinking"] = modelPolicy.selectedThinking;
  if (workerGithubPatchRuntimeReady !== undefined) {
    metadata["githubPatchRuntimeReady"] = String(workerGithubPatchRuntimeReady);
  }
  if (roundSpec.workerModel && TEAM1_ALLOWED_WORKER_MODELS.has(roundSpec.workerModel)) {
    metadata["workerModelExplicitOverride"] = roundSpec.workerModel;
  }
  if (roundSpec.workerThinking && TEAM1_ALLOWED_WORKER_THINKING_LEVELS.has(roundSpec.workerThinking)) {
    metadata["workerThinkingExplicitOverride"] = roundSpec.workerThinking;
  }
  if (modelPolicy.payloadOverrides.workerModel) {
    metadata["payloadWorkerModel"] = modelPolicy.payloadOverrides.workerModel;
  }
  if (modelPolicy.payloadOverrides.workerThinking) {
    metadata["payloadWorkerThinking"] = modelPolicy.payloadOverrides.workerThinking;
  }
  if (modelPolicy.payloadOverrides.workerModelEscalationReasons) {
    metadata["payloadWorkerModelEscalationReasons"] = modelPolicy.payloadOverrides.workerModelEscalationReasons;
  }
  if (modelPolicy.reasons.length > 0) {
    metadata["workerModelEscalationReasons"] = modelPolicy.reasons.join(",");
  }
  if (roundSpec.tags) {
    for (const [k, v] of Object.entries(roundSpec.tags)) {
      metadata[`tag:${k}`] = sanitizeText(v);
    }
  }
  if (roundSpec.readOnlyAudit) {
    metadata["readOnlyAudit"] = "true";
    metadata["allowNoChanges"] = "true";
    metadata["readOnlyValidation"] = "true";
  }
  if (roundSpec.workModeDecision) {
    metadata["workModeDecisionMode"] = roundSpec.workModeDecision.mode;
    metadata["workModeDecisionIdempotencyKey"] = roundSpec.workModeDecision.idempotencyKey;
    metadata["workModeDecisionFinalizer"] = sanitizeText(roundSpec.workModeDecision.finalizerOwner);
    metadata["workModeDecisionGeneratedAt"] = roundSpec.workModeDecision.generatedAt;
    metadata["workModeDecisionCapacityState"] = roundSpec.workModeDecision.capacityState;
    metadata["workModeDecisionCapacitySnapshotSource"] = sanitizeText(roundSpec.workModeDecision.capacitySnapshotSource);
    metadata["workModeDecisionCapacitySnapshotAt"] = roundSpec.workModeDecision.capacitySnapshotAt;
  }

  const taskPayload: Team1DispatchTaskPayload | null = parentRoundMetadata
    ? {
        taskId: deterministicTaskId.taskId,
        teamId: roundSpec.teamId,
        lane: roundSpec.lane,
        worker: roundSpec.worker,
        runId: roundSpec.runId,
        parentRoundId: parentRoundMetadata.parentRoundId,
        parentRoundTotal: parentRoundMetadata.parentRoundTotal,
        parentRoundOrder: parentRoundMetadata.parentRoundOrder,
        ...(roundSpec.dispatchWorkers && roundSpec.dispatchWorkers.length > 0
          ? { dispatchedWorkers: normalizeWorkerList(roundSpec.dispatchWorkers) }
          : {}),
        parentIssueUrl: sanitizeText(roundSpec.parentIssueUrl),
        childIssueUrl: sanitizeText(roundSpec.childIssueUrl),
        childIssue: roundSpec.childIssue,
        workerModel: modelPolicy.selectedModel,
        workerThinking: modelPolicy.selectedThinking,
        workerModelEscalationReasons: modelPolicy.payloadOverrides.workerModelEscalationReasons,
        ...(roundSpec.readOnlyAudit
          ? { readOnlyAudit: true as const, allowNoChanges: true as const, readOnlyValidation: true as const }
          : {}),
        ...(roundSpec.workModeDecision ? { workModeDecision: roundSpec.workModeDecision } : {}),
      }
    : null;

  const runRecordBase: Omit<Team1SanitizedRunRecord, "recordChecksum"> = {
    runId: roundSpec.runId,
    teamId: roundSpec.teamId,
    lane: roundSpec.lane,
    worker: roundSpec.worker,
    taskId: deterministicTaskId.taskId,
    shortId: deterministicTaskId.shortId,
    dryRun: mergedConfig.dryRun,
    executeMode: mergedConfig.execute,
    parentIssue: sanitizeText(roundSpec.parentIssueUrl),
    childIssue: sanitizeText(roundSpec.childIssueUrl),
    metadata,
    modelPolicy,
    preflightResults: preflightResults.map((p) => ({ ...p, detail: p.detail ? sanitizeText(p.detail) : undefined })),
    dispatchActions,
    generatedAt: now,
  };

  // Build the canonical round manifest (from round-manifest.ts primitives)
  const roundManifestResult = buildTeam1RoundManifest(
    roundSpec,
    mergedConfig,
    undefined, // closeoutPolicy override — use fail-closed defaults
    undefined, // deadlineConfig — omit for source-only planning
  );

  if (roundManifestResult) {
    dispatchActions.push(`[manifest] ${ROUND_MANIFEST_KIND} v${ROUND_MANIFEST_VERSION}: ${roundManifestResult.manifest.manifestId}`);
    dispatchActions.push(`[manifest] workers: ${roundManifestResult.manifest.expectedWorkers.map((w) => w.workerId).join(", ")}`);
    dispatchActions.push(`[manifest] closeout: automaticCloseout=${String(roundManifestResult.manifest.closeoutPolicy.automaticCloseout)}`);
  } else {
    dispatchActions.push("[manifest] skipped: parent issue URL not parseable");
  }

  const plan: Team1DispatchPlan = {
    kind: "a2a-broker.team1-dispatch-plan.v1",
    version: 1,
    generatedAt: now,
    config: mergedConfig,
    roundSpec,
    deterministicTaskId,
    preflightResults,
    decision: {
      value: evalResult.decision,
      blockers: evalResult.blockers,
      warnings: evalResult.warnings,
    },
    dispatchActions,
    modelPolicy,
    runRecord: { ...runRecordBase, recordChecksum: buildRecordChecksum(runRecordBase) },
    taskPayload,
    metadata: {
      parentIssueUrl: sanitizeText(roundSpec.parentIssueUrl),
      childIssueUrl: sanitizeText(roundSpec.childIssueUrl),
      parentChildChain: `${roundSpec.parentIssueUrl} → ${roundSpec.childIssueUrl}`,
      parentChildReversed: `${roundSpec.childIssueUrl} ← ${roundSpec.parentIssueUrl}`,
      parentRoundId: parentRoundMetadata ? sanitizeText(parentRoundMetadata.parentRoundId) : "",
      parentRoundTotal: parentRoundMetadata?.parentRoundTotal ?? 0,
      parentRoundOrder: parentRoundMetadata?.parentRoundOrder ?? 0,
      dryRunDefault: true,
      executeExplicit: mergedConfig.execute,
      workerModel: modelPolicy.selectedModel,
      workerThinking: modelPolicy.selectedThinking,
      workerModelEscalatedToPro: modelPolicy.escalatedToPro,
      noLiveImpact: true,
      sourceOnly: true,
      readOnlyAudit: roundSpec.readOnlyAudit === true,
      allowNoChanges: roundSpec.readOnlyAudit === true,
      readOnlyValidation: roundSpec.readOnlyAudit === true,
      ...(roundSpec.workModeDecision ? { workModeDecision: roundSpec.workModeDecision } : {}),
    },
    roundManifest: roundManifestResult?.manifest ?? null,
    roundManifestProjection: roundManifestResult?.projection ?? null,
  };

  return plan;
}

// ── Markdown renderer ───────────────────────────────────────────────────────

export function renderTeam1DispatchPlanMarkdown(plan: Team1DispatchPlan): string {
  const lines: string[] = [];

  lines.push(`# Team1 Dispatch Plan: ${plan.decision.value}`);
  lines.push("");
  lines.push(`- **Kind:** ${plan.kind}`);
  lines.push(`- **Generated at:** ${plan.generatedAt}`);
  lines.push(`- **Run ID:** ${plan.roundSpec.runId}`);
  lines.push(`- **Worker:** ${plan.roundSpec.worker}`);
  lines.push(`- **Lane:** ${plan.roundSpec.lane}/4`);
  lines.push(`- **Dry-run:** ${plan.config.dryRun}`);
  lines.push(`- **Execute mode:** ${plan.config.execute}`);
  lines.push(`- **Worker model:** ${plan.modelPolicy.selectedModel}`);
  lines.push(`- **Worker thinking:** ${plan.modelPolicy.selectedThinking}`);
  lines.push("");
  lines.push("## Worker model policy");
  lines.push("");
  lines.push(`- **Default:** ${plan.modelPolicy.defaultModel}`);
  lines.push(`- **Selected:** ${plan.modelPolicy.selectedModel}`);
  lines.push(`- **Escalated to Pro:** ${plan.modelPolicy.escalatedToPro}`);
  lines.push(`- **Thinking level:** ${plan.modelPolicy.selectedThinking}`);
  lines.push(`- **Approval:** ${plan.modelPolicy.approvalRef}`);
  lines.push(`- **Reasons:** ${plan.modelPolicy.reasons.length ? plan.modelPolicy.reasons.join(", ") : "none"}`);
  lines.push(`- **Boundary:** ${plan.modelPolicy.boundary}`);
  lines.push("");
  lines.push("## Deterministic task ID");
  lines.push("");
  lines.push(`- **Task ID:** \`${plan.deterministicTaskId.taskId}\``);
  lines.push(`- **Short ID:** \`${plan.deterministicTaskId.shortId}\``);
  lines.push(`- **Idempotent:** ${plan.deterministicTaskId.idempotent}`);
  lines.push("");
  lines.push("## Preflight results");
  lines.push("");
  lines.push("| Check | Status | Detail |");
  lines.push("|---|---|---|");
  for (const check of plan.preflightResults) {
    lines.push(`| ${check.label} | ${check.status} | ${check.detail ?? "—"} |`);
  }
  lines.push("");
  lines.push("## Decision");
  lines.push("");
  lines.push(`- **Value:** ${plan.decision.value}`);
  if (plan.decision.blockers.length > 0) {
    lines.push("- **Blockers:**");
    for (const b of plan.decision.blockers) {
      lines.push(`  - ❌ ${b}`);
    }
  }
  if (plan.decision.warnings.length > 0) {
    lines.push("- **Warnings:**");
    for (const w of plan.decision.warnings) {
      lines.push(`  - ⚠️ ${w}`);
    }
  }
  lines.push("");
  lines.push("## Dispatch actions");
  lines.push("");
  for (const action of plan.dispatchActions) {
    lines.push(`- ${action}`);
  }
  lines.push("");
  lines.push("## Parent/child metadata");
  lines.push("");
  lines.push(`- **Parent:** ${plan.metadata.parentIssueUrl}`);
  lines.push(`- **Child:** ${plan.metadata.childIssueUrl}`);
  lines.push(`- **Chain:** ${plan.metadata.parentChildChain}`);
  lines.push(`- **Parent round:** ${plan.metadata.parentRoundId} (${plan.metadata.parentRoundOrder}/${plan.metadata.parentRoundTotal})`);
  lines.push("");
  lines.push("## Sanitized run record checksum");
  lines.push("");
  lines.push(`- **Record checksum:** \`${plan.runRecord.recordChecksum}\``);
  lines.push(`- **Task ID:** \`${plan.runRecord.taskId}\``);
  lines.push("");
  lines.push("## Safety boundaries");
  lines.push("");
  lines.push("- **Source-only:** Yes");
  lines.push("- **No live impact:** Yes");
  lines.push("- **Dry-run default:** Yes");
  const executeText = plan.config.execute ? "Yes (confirmed)" : "No (blocked)";
  lines.push(`- **Execute explicit:** ${executeText}`);
  const blockedText = plan.decision.blockers.length > 0 ? "Yes" : "No";
  lines.push(`- **Blocked by preflight:** ${blockedText}`);
  lines.push(`- **Payload workerModel:** ${plan.modelPolicy.payloadOverrides.workerModel ?? "—"}`);
  lines.push(`- **Payload workerThinking:** ${plan.modelPolicy.payloadOverrides.workerThinking ?? "—"}`);
  lines.push(`- **Read-only audit:** ${plan.metadata.readOnlyAudit ? "Yes (evidence-only, no PR/diff required)" : "No"}`);
  if (plan.metadata.readOnlyAudit) {
    lines.push(`- **Allow no changes:** ${plan.metadata.allowNoChanges ? "Yes" : "No"}`);
    lines.push(`- **Read-only validation:** ${plan.metadata.readOnlyValidation ? "Yes" : "No"}`);
  }

  // Round manifest section (when present)
  if (plan.roundManifest) {
    lines.push("");
    lines.push("## Round manifest");
    lines.push("");
    lines.push(`- **Manifest ID:** \`${plan.roundManifest.manifestId}\``);
    lines.push(`- **Checksum:** \`${plan.roundManifest.manifestChecksum}\``);
    lines.push(`- **Parent issue:** [#${plan.roundManifest.parentIssue.issueNumber}](${plan.roundManifest.parentIssue.issueUrl})`);
    lines.push(`- **Expected workers:** ${plan.roundManifestProjection?.expectedWorkerIds.join(", ") ?? "—"}`);
    lines.push(`- **Closeout policy:** automaticCloseout=${String(plan.roundManifest.closeoutPolicy.automaticCloseout)}, automaticFinalizer=${String(plan.roundManifest.closeoutPolicy.automaticFinalizer)}`);
    lines.push(`- **Closeout requires all workers:** ${plan.roundManifest.closeoutPolicy.requireAllWorkersComplete === false ? "no" : "yes"}`);

    if (plan.roundManifestProjection) {
      lines.push("");
      lines.push("| Worker | Lane | Task ID | Deadline | Evidence |");
      lines.push("|---|---|---|---|---|");
      for (const wa of plan.roundManifestProjection.workerAssignments) {
        const deadline = wa.deadlineAt ?? "—";
        const evidence = wa.requiredEvidenceTypes.join(", ");
        lines.push(`| ${wa.workerId} | ${wa.lane ?? "—"} | ${wa.taskId ? "`" + wa.taskId + "`" : "—"} | ${deadline} | ${evidence} |`);
      }
    }
  }

  return lines.join("\n");
}
