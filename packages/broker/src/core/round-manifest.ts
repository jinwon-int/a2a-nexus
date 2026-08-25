/**
 * Round Manifest — broker-side typed schema/model for multi-worker A2A rounds.
 *
 * Defines the expected worker roster, task assignments, deadlines, evidence
 * policy, and closeout constraints for a single A2A hardening or development
 * round. The manifest is the source-of-truth document that the round
 * coordinator and result collector read to determine what work was expected
 * and whether each lane completed on time.
 *
 * Design principles
 * -----------------
 * 1. **Deterministic identity** — manifestId and manifestChecksum are SHA-256
 *    hashes of the content. Same inputs always produce the same id/checksum,
 *    enabling idempotent creation and replay detection.
 * 2. **Fail-closed evidence policy** — the manifest declares what evidence
 *    types each worker MUST provide (PR, Done comment, Block comment, or
 *    branch URL). The collector rejects incomplete round bundles.
 * 3. **Finalizer-gated closeout** — closeoutPolicy defaults to
 *    `{ automaticCloseout: false, automaticFinalizer: false }` so that only a
 *    human operator or explicitly approved policy can trigger close/finalize
 *    actions.
 * 4. **Source-only create/read** — this module exports pure functions only.
 *    No broker state mutation, no outbox writes, no GitHub API calls.
 *
 * @see Issue #928 — broker-side round manifest foundation
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical discriminant for round manifest documents. */
export const ROUND_MANIFEST_KIND = "a2a-broker.round-manifest" as const;

/** Current schema version. Increment when making backward-incompatible changes. */
export const ROUND_MANIFEST_VERSION = 1 as const;

/** Minimum number of workers required for a valid round. */
export const ROUND_MANIFEST_MIN_WORKERS = 1;

/** Maximum number of workers allowed per round (practical ceiling). */
export const ROUND_MANIFEST_MAX_WORKERS = 16;

// ---------------------------------------------------------------------------
// Evidence types
// ---------------------------------------------------------------------------

/**
 * Canonical evidence types that a worker lane may produce.
 *
 * - `pr`: A pull request URL containing code/doc changes.
 * - `done`: A Done comment URL with evidence-only summary (no code changes).
 * - `block`: A Block comment URL explaining why the lane could not proceed.
 * - `branch`: A branch/recovered branch URL (partial evidence).
 * - `skip`: Explicit skip — the worker was not dispatched or the lane was
 *   excluded after the manifest was created.
 */
export type RoundEvidenceType = "pr" | "done" | "block" | "branch" | "skip";

/** Human-readable labels for evidence types. */
export const ROUND_EVIDENCE_TYPE_LABELS: Record<RoundEvidenceType, string> = {
  pr: "Pull request (code/doc changes)",
  done: "Done comment (evidence-only)",
  block: "Block comment (cannot proceed)",
  branch: "Branch URL (partial evidence)",
  skip: "Skipped (not dispatched or excluded)",
};

// ---------------------------------------------------------------------------
// Worker assignment
// ---------------------------------------------------------------------------

/**
 * Expected evidence that a worker lane must produce.
 *
 * `requiredTypes` lists evidence types the collector MUST find before marking
 * the lane as complete. `minimumRequired` sets a lower bound (default 1).
 */
export interface WorkerEvidencePolicy {
  /** Evidence types the worker MUST provide (at least one). */
  requiredTypes: RoundEvidenceType[];
  /** Minimum count of distinct evidence items required. Default 1, max 5. */
  minimumRequired?: number;
}

/**
 * Per-worker lane assignment within a round manifest.
 *
 * Each worker is identified by a short handle (`workerId`) and may carry an
 * optional deterministic task id, a role description, an optional deadline,
 * and an evidence policy. The `taskId` field is populated during dispatch and
 * used by the result collector to match terminal outbox events.
 */
export interface WorkerRoundAssignment {
  /** Short worker handle (e.g. "workergamma", "workerepsilon"). */
  workerId: string;

  /** Optional human-readable description of this worker's task. */
  taskDescription?: string;

  /**
   * Deterministic task id assigned when the worker is dispatched. Populated
   * by the dispatch wrapper; may be absent in a draft manifest.
   */
  taskId?: string;

  /**
   * Optional run id linking to the dispatched run. Populated at dispatch time.
   */
  runId?: string;

  /**
   * Optional trace id for cross-reference with terminal outbox events.
   */
  traceId?: string;

  /** Optional lane ordinal (1-based) within the round. */
  lane?: number;

  /** ISO 8601 deadline for this worker's completion. */
  deadlineAt?: string;

  /**
   * Evidence policy for this worker. When absent, the round-level
   * `defaultEvidencePolicy` applies.
   */
  evidencePolicy?: WorkerEvidencePolicy;

  /** Optional model escalation hints (forwarded from dispatch config). */
  modelEscalationHints?: {
    forcePro?: boolean;
    reasons?: string[];
    workerModel?: string;
    workerThinking?: string;
  };

  /**
   * Resource-aware worker policy fields (issue #927).
   *
   * - `maxConcurrency`: maximum concurrent tasks for this worker (default 1).
   * - `allowedTaskTypes`: task intents this worker is allowed to handle.
   * - `noLive`: when true, this worker must not execute live-impact tasks.
   * - `noMutation`: when true, this worker must not mutate broker state.
   * - `mobileStandby`: when true, this worker is a mobile/standby-only node.
   */
  resourcePolicy?: {
    maxConcurrency?: number;
    allowedTaskTypes?: string[];
    noLive?: boolean;
    noMutation?: boolean;
    mobileStandby?: boolean;
  };

  /** Arbitrary operator-safe metadata. */
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Deadline configuration
// ---------------------------------------------------------------------------

/**
 * Round-level deadline configuration.
 *
 * When `laneDeadlineAt` is set, the result collector uses it as the reference
 * timestamp for stale/timeout classification. Individual worker deadlines
 * (`WorkerRoundAssignment.deadlineAt`) override the round-level default.
 */
export interface RoundDeadlineConfig {
  /** Round-level deadline. All workers should complete by this time. */
  roundDeadlineAt?: string;

  /** Grace period (ms) after deadline before a lane is classified as stale. */
  staleAfterMs?: number;

  /** Hard timeout (ms) after deadline; lanes exceeding this are "timed_out". */
  timeoutAfterMs?: number;
}

/** Default stale threshold (30 minutes after deadline). */
export const DEFAULT_ROUND_STALE_AFTER_MS = 30 * 60 * 1000;

/** Default hard timeout (120 minutes after deadline). */
export const DEFAULT_ROUND_TIMEOUT_AFTER_MS = 120 * 60 * 1000;

// ---------------------------------------------------------------------------
// Closeout policy
// ---------------------------------------------------------------------------

/**
 * Closeout policy for the round.
 *
 * By default, automatic closeout and finalizer actions are DISABLED. A human
 * operator or a separately approved policy must explicitly enable them. This
 * ensures that the coordinator never accidentally closes issues, merges PRs,
 * or triggers finalizer workflows without operator oversight.
 *
 * @see Issue #928 — fail-closed closeout policy
 */
export interface RoundCloseoutPolicy {
  /**
   * When true, the round coordinator may automatically post a closeout
   * comment when all expected lanes are complete with evidence.
   * Default: false.
   */
  automaticCloseout?: boolean;

  /**
   * When true, the round coordinator may trigger finalizer workflows
   * (e.g., terminal Brief aggregation, cross-broker handoff).
   * Default: false.
   */
  automaticFinalizer?: boolean;

  /**
   * Optional reference to an approval artifact or issue comment that
   * authorizes automatic actions. Must be populated when either
   * `automaticCloseout` or `automaticFinalizer` is true.
   */
  approvalRef?: string;

  /**
   * When true, the result collector MUST find evidence from ALL expected
   * workers before closeout. Default: true (fail-closed).
   */
  requireAllWorkersComplete?: boolean;

  /**
   * When true, workers that exceeded their deadline are classified as
   * "timeout" rather than "stale". Default: false.
   */
  timeoutOnDeadlineExceeded?: boolean;
}

const DEFAULT_CLOSEOUT_POLICY: RoundCloseoutPolicy = {
  automaticCloseout: false,
  automaticFinalizer: false,
  requireAllWorkersComplete: true,
  timeoutOnDeadlineExceeded: false,
};

// ---------------------------------------------------------------------------
// Round manifest (top-level document)
// ---------------------------------------------------------------------------

/**
 * Round Manifest — typed schema for an A2A multi-worker round.
 *
 * This is the source-of-truth document that the round coordinator uses to
 * dispatch workers and the result collector uses to classify outcomes.
 *
 * @example
 * ```ts
 * const manifest = buildRoundManifest({
 *   parentRepo: "jinwon-int/a2a-broker",
 *   parentIssueNumber: 927,
 *   teamId: "team1",
 *   runId: "a2a-round-20260526T201140KST",
 *   roundLabel: "a2a-hardening-r1",
 *   expectedWorkers: [
 *     { workerId: "workergamma", lane: 1, taskDescription: "Round manifest foundation" },
 *     { workerId: "workerepsilon", lane: 2 },
 *     { workerId: "workerbeta", lane: 3 },
 *     { workerId: "workeralpha", lane: 4 },
 *   ],
 * });
 * ```
 */
export interface RoundManifest {
  /** Document discriminant: always "a2a-broker.round-manifest". */
  kind: typeof ROUND_MANIFEST_KIND;

  /** Schema version. Currently 1. */
  version: typeof ROUND_MANIFEST_VERSION;

  /**
   * Deterministic SHA-256 hex digest of the canonical serialisation.
   * Same inputs → same manifestId. Enables idempotent creation and
   * deduplication.
   */
  manifestId: string;

  /**
   * SHA-256 checksum of the manifest content (excluding manifestId and
   * manifestChecksum themselves). Used for integrity verification.
   */
  manifestChecksum: string;

  /** ISO 8601 timestamp when this manifest was generated. */
  generatedAt: string;

  /** Optional human-readable round label (e.g. "a2a-hardening-r1"). */
  roundLabel?: string;

  /** Parent tracker issue reference. */
  parentIssue: {
    /** GitHub repo slug: "owner/repo". */
    repo: string;
    /** Issue number on the tracker repo. */
    issueNumber: number;
    /** Full GitHub issue URL. */
    issueUrl: string;
  };

  /** Team identifier (e.g. "team1", "team2"). */
  teamId: string;

  /** Broker run identifier. */
  runId: string;

  /** Expected worker assignments, ordered by lane. */
  expectedWorkers: WorkerRoundAssignment[];

  /** Round-level deadline configuration (optional). */
  deadlineConfig?: RoundDeadlineConfig;

  /**
   * Default evidence policy applied to workers that lack an explicit
   * `evidencePolicy`. When absent, the collector requires at least one of
   * `pr`, `done`, or `block`.
   */
  defaultEvidencePolicy?: WorkerEvidencePolicy;

  /** Closeout policy. Defaults to fail-closed (no automatic actions). */
  closeoutPolicy: RoundCloseoutPolicy;

  /** Optional resource policy summary for the entire round. */
  resourcePolicy?: {
    maxConcurrency?: number;
    noLive?: boolean;
    noMutation?: boolean;
  };

  /** Arbitrary operator-safe metadata. */
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Manifest options (input to buildRoundManifest)
// ---------------------------------------------------------------------------

/**
 * Input options for {@link buildRoundManifest}. All timestamps default to
 * the current time when omitted.
 */
export interface RoundManifestOptions {
  /** Parent repo slug. Required. */
  parentRepo: string;

  /** Parent GitHub issue number. Required. */
  parentIssueNumber: number;

  /** Team identifier. Required. */
  teamId: string;

  /** Broker run identifier. Required. */
  runId: string;

  /** Expected worker assignments. Required (1–16 workers). */
  expectedWorkers: WorkerRoundAssignment[];

  /** Optional round label. */
  roundLabel?: string;

  /** Optional override for generatedAt timestamp. */
  generatedAt?: string;

  /** Round-level deadline config. */
  deadlineConfig?: RoundDeadlineConfig;

  /** Default evidence policy. */
  defaultEvidencePolicy?: WorkerEvidencePolicy;

  /** Closeout policy override. Defaults to fail-closed. */
  closeoutPolicy?: RoundCloseoutPolicy;

  /** Resource policy summary. */
  resourcePolicy?: RoundManifest["resourcePolicy"];

  /** Arbitrary operator-safe metadata. */
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic content checksum for the manifest body.
 *
 * The checksum includes all fields except `manifestId` and `manifestChecksum`
 * themselves, serialised with stable key ordering so that identical inputs
 * produce identical checksums.
 *
 * @param body - Partial manifest body (without manifestId/manifestChecksum).
 * @returns SHA-256 hex digest (first 32 hex chars).
 */
export function computeManifestChecksum(
  body: Record<string, unknown>,
): string {
  // Canonical JSON stringify that sorts keys at every level.
  // We use a replacer function (instead of an array) so that nested
  // object fields (e.g. workerId, taskId inside expectedWorkers[]) are
  // included in the hash. The original array-based replacer incorrectly
  // filtered nested keys to only those matching top-level key names.
  const canonical = JSON.stringify(body, (_key: string, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Validate a worker round assignment structure.
 *
 * Returns an array of issue messages. An empty array means the assignment
 * is valid.
 */
export function validateWorkerAssignment(
  worker: WorkerRoundAssignment,
  index: number,
  nowMs?: number,
): string[] {
  const issues: string[] = [];

  if (!worker.workerId || typeof worker.workerId !== "string" || worker.workerId.trim().length === 0) {
    issues.push(`Worker at index ${index}: workerId is required and must be a non-empty string`);
  }

  if (worker.lane !== undefined) {
    if (!Number.isInteger(worker.lane) || worker.lane < 1) {
      issues.push(`Worker at index ${index}: lane must be a positive integer, got ${String(worker.lane)}`);
    }
  }

  if (worker.deadlineAt !== undefined) {
    const parsed = Date.parse(worker.deadlineAt);
    if (Number.isNaN(parsed)) {
      issues.push(`Worker at index ${index}: deadlineAt "${worker.deadlineAt}" is not a valid ISO timestamp`);
    } else if (nowMs !== undefined && parsed < nowMs) {
      issues.push(`Worker at index ${index}: deadlineAt "${worker.deadlineAt}" is in the past`);
    }
  }

  if (worker.evidencePolicy !== undefined) {
    const { requiredTypes, minimumRequired } = worker.evidencePolicy;
    if (!requiredTypes || requiredTypes.length === 0) {
      issues.push(`Worker at index ${index}: evidencePolicy.requiredTypes must have at least one type`);
    } else {
      const validTypes = new Set(Object.keys(ROUND_EVIDENCE_TYPE_LABELS));
      for (const t of requiredTypes) {
        if (!validTypes.has(t)) {
          issues.push(`Worker at index ${index}: evidencePolicy.requiredType "${t}" is not a valid evidence type`);
        }
      }
    }
    if (minimumRequired !== undefined && (minimumRequired < 1 || minimumRequired > 5)) {
      issues.push(`Worker at index ${index}: evidencePolicy.minimumRequired must be between 1 and 5, got ${String(minimumRequired)}`);
    }
  }

  return issues;
}

/**
 * Validate a complete RoundManifestOptions object.
 *
 * Returns an array of issue messages. An empty array means the options
 * are valid and can be passed to {@link buildRoundManifest}.
 */
export function validateRoundManifestOptions(
  options: RoundManifestOptions,
): string[] {
  const issues: string[] = [];

  // -- parentRepo --
  if (!options.parentRepo || typeof options.parentRepo !== "string" || options.parentRepo.trim().length === 0) {
    issues.push("parentRepo is required and must be a non-empty string (e.g. \"owner/repo\")");
  } else if (!/^[\w.-]+\/[\w.-]+$/.test(options.parentRepo.trim())) {
    issues.push(`parentRepo "${options.parentRepo}" does not match "owner/repo" format`);
  }

  // -- parentIssueNumber --
  if (!Number.isInteger(options.parentIssueNumber) || options.parentIssueNumber < 1) {
    issues.push("parentIssueNumber must be a positive integer");
  }

  // -- teamId --
  if (!options.teamId || typeof options.teamId !== "string" || options.teamId.trim().length === 0) {
    issues.push("teamId is required and must be a non-empty string");
  }

  // -- runId --
  if (!options.runId || typeof options.runId !== "string" || options.runId.trim().length === 0) {
    issues.push("runId is required and must be a non-empty string");
  }

  // -- expectedWorkers --
  if (!Array.isArray(options.expectedWorkers) || options.expectedWorkers.length < ROUND_MANIFEST_MIN_WORKERS) {
    issues.push(`expectedWorkers must have at least ${ROUND_MANIFEST_MIN_WORKERS} worker(s)`);
  } else if (options.expectedWorkers.length > ROUND_MANIFEST_MAX_WORKERS) {
    issues.push(`expectedWorkers must have at most ${ROUND_MANIFEST_MAX_WORKERS} workers, got ${options.expectedWorkers.length}`);
  } else {
    for (let i = 0; i < options.expectedWorkers.length; i++) {
      issues.push(...validateWorkerAssignment(options.expectedWorkers[i], i));
    }
  }

  // -- defaultEvidencePolicy --
  if (options.defaultEvidencePolicy !== undefined) {
    const { requiredTypes } = options.defaultEvidencePolicy;
    if (!requiredTypes || requiredTypes.length === 0) {
      issues.push("defaultEvidencePolicy.requiredTypes must have at least one type when present");
    } else {
      const validTypes = new Set(Object.keys(ROUND_EVIDENCE_TYPE_LABELS));
      for (const t of requiredTypes) {
        if (!validTypes.has(t)) {
          issues.push(`defaultEvidencePolicy.requiredType "${t}" is not a valid evidence type`);
        }
      }
    }
  }

  // -- deadlineConfig --
  if (options.deadlineConfig !== undefined) {
    const { roundDeadlineAt, staleAfterMs, timeoutAfterMs } = options.deadlineConfig;
    if (roundDeadlineAt !== undefined) {
      const parsed = Date.parse(roundDeadlineAt);
      if (Number.isNaN(parsed)) {
        issues.push(`deadlineConfig.roundDeadlineAt "${roundDeadlineAt}" is not a valid ISO timestamp`);
      }
    }
    if (staleAfterMs !== undefined && (staleAfterMs < 1000 || staleAfterMs > 24 * 60 * 60 * 1000)) {
      issues.push(`deadlineConfig.staleAfterMs must be between 1000 and 86400000, got ${String(staleAfterMs)}`);
    }
    if (timeoutAfterMs !== undefined && (timeoutAfterMs < 1000 || timeoutAfterMs > 7 * 24 * 60 * 60 * 1000)) {
      issues.push(`deadlineConfig.timeoutAfterMs must be between 1000 and 604800000, got ${String(timeoutAfterMs)}`);
    }
  }

  // -- closeoutPolicy --
  if (options.closeoutPolicy !== undefined) {
    const { automaticCloseout, automaticFinalizer, approvalRef } = options.closeoutPolicy;
    if ((automaticCloseout || automaticFinalizer) && !approvalRef) {
      issues.push("closeoutPolicy.approvalRef is required when automaticCloseout or automaticFinalizer is true");
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Build manifest
// ---------------------------------------------------------------------------

/**
 * Build a deterministic RoundManifest from the given options.
 *
 * Steps:
 * 1. Validate options (throws on validation errors).
 * 2. Compute deterministic manifestId and manifestChecksum.
 * 3. Return the sealed manifest document.
 *
 * @param options - Round manifest input options.
 * @returns A sealed RoundManifest with deterministic identifiers.
 * @throws {Error} When validation fails.
 */
export function buildRoundManifest(options: RoundManifestOptions): RoundManifest {
  const issues = validateRoundManifestOptions(options);
  if (issues.length > 0) {
    throw new Error(`Round manifest validation failed:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const repo = options.parentRepo.trim();
  const issueUrl = `https://github.com/${repo}/issues/${options.parentIssueNumber}`;
  const teamId = options.teamId.trim();
  const runId = options.runId.trim();

  // Sort workers by lane (defaults to insertion order when all lanes unset).
  const sortedWorkers = [...options.expectedWorkers].sort((a, b) => {
    const laneA = a.lane ?? Number.MAX_SAFE_INTEGER;
    const laneB = b.lane ?? Number.MAX_SAFE_INTEGER;
    return laneA - laneB;
  });

  // Build the body for checksum computation (without manifestId/manifestChecksum).
  const body: Record<string, unknown> = {
    kind: ROUND_MANIFEST_KIND,
    version: ROUND_MANIFEST_VERSION,
    generatedAt,
    parentIssue: { repo, issueNumber: options.parentIssueNumber, issueUrl },
    teamId,
    runId,
    expectedWorkers: sortedWorkers,
    closeoutPolicy: options.closeoutPolicy ?? DEFAULT_CLOSEOUT_POLICY,
  };

  if (options.roundLabel !== undefined) body.roundLabel = options.roundLabel;
  if (options.deadlineConfig !== undefined) body.deadlineConfig = options.deadlineConfig;
  if (options.defaultEvidencePolicy !== undefined) body.defaultEvidencePolicy = options.defaultEvidencePolicy;
  if (options.resourcePolicy !== undefined) body.resourcePolicy = options.resourcePolicy;
  if (options.metadata !== undefined) body.metadata = options.metadata;

  const manifestChecksum = computeManifestChecksum(body);

  // manifestId includes the checksum to make it a deterministic function of
  // the content as well as a short "key" for the checksum itself.
  const idPreImage = [
    ROUND_MANIFEST_KIND,
    `v${ROUND_MANIFEST_VERSION}`,
    runId,
    teamId,
    manifestChecksum,
  ].join("|");
  const manifestId = createHash("sha256").update(idPreImage).digest("hex").slice(0, 32);

  return {
    kind: ROUND_MANIFEST_KIND,
    version: ROUND_MANIFEST_VERSION,
    manifestId,
    manifestChecksum,
    generatedAt,
    roundLabel: options.roundLabel,
    parentIssue: { repo, issueNumber: options.parentIssueNumber, issueUrl },
    teamId,
    runId,
    expectedWorkers: sortedWorkers,
    deadlineConfig: options.deadlineConfig,
    defaultEvidencePolicy: options.defaultEvidencePolicy,
    closeoutPolicy: options.closeoutPolicy ?? DEFAULT_CLOSEOUT_POLICY,
    resourcePolicy: options.resourcePolicy,
    metadata: options.metadata,
  };
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/**
 * Render a RoundManifest as a human-readable markdown string.
 *
 * Suitable for posting as a GitHub issue comment or operator dashboard.
 */
export function renderRoundManifestMarkdown(manifest: RoundManifest): string {
  const lines: string[] = [
    `## A2A Round Manifest: ${manifest.roundLabel ?? manifest.runId}`,
    "",
    `- **Kind:** ${manifest.kind}`,
    `- **Version:** ${manifest.version}`,
    `- **Manifest ID:** \`${manifest.manifestId}\``,
    `- **Checksum:** \`${manifest.manifestChecksum}\``,
    `- **Generated:** ${manifest.generatedAt}`,
    `- **Parent Issue:** [#${manifest.parentIssue.issueNumber}](${manifest.parentIssue.issueUrl})`,
    `- **Team:** ${manifest.teamId}`,
    `- **Run:** ${manifest.runId}`,
    "",
    "### Expected Workers",
    "",
    "| Lane | Worker | Task | Deadline | Evidence Required |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const w of manifest.expectedWorkers) {
    const lane = w.lane !== undefined ? String(w.lane) : "—";
    const task = w.taskDescription ?? "—";
    const deadline = w.deadlineAt ?? "—";
    const evidence = w.evidencePolicy?.requiredTypes.join(", ") ?? "pr, done, block (default)";
    lines.push(`| ${lane} | ${w.workerId} | ${task} | ${deadline} | ${evidence} |`);
  }

  lines.push("", "### Closeout Policy", "");

  const cp = manifest.closeoutPolicy;
  lines.push(`- **Automatic closeout:** ${cp.automaticCloseout === true ? "enabled" : "disabled"}`);
  lines.push(`- **Automatic finalizer:** ${cp.automaticFinalizer === true ? "enabled" : "disabled"}`);
  lines.push(`- **Require all workers:** ${cp.requireAllWorkersComplete !== false ? "yes" : "no"}`);
  lines.push(`- **Timeout on deadline exceeded:** ${cp.timeoutOnDeadlineExceeded === true ? "yes" : "no"}`);
  if (cp.approvalRef) {
    lines.push(`- **Approval ref:** ${cp.approvalRef}`);
  }

  if (manifest.deadlineConfig) {
    lines.push("", "### Deadline Config", "");
    const dc = manifest.deadlineConfig;
    if (dc.roundDeadlineAt) lines.push(`- **Round deadline:** ${dc.roundDeadlineAt}`);
    lines.push(`- **Stale after:** ${dc.staleAfterMs ?? DEFAULT_ROUND_STALE_AFTER_MS}ms`);
    lines.push(`- **Timeout after:** ${dc.timeoutAfterMs ?? DEFAULT_ROUND_TIMEOUT_AFTER_MS}ms`);
  }

  if (manifest.resourcePolicy) {
    lines.push("", "### Resource Policy", "");
    const rp = manifest.resourcePolicy;
    if (rp.maxConcurrency) lines.push(`- **Max concurrency:** ${rp.maxConcurrency}`);
    if (rp.noLive !== undefined) lines.push(`- **No live:** ${rp.noLive}`);
    if (rp.noMutation !== undefined) lines.push(`- **No mutation:** ${rp.noMutation}`);
  }

  if (manifest.metadata && Object.keys(manifest.metadata).length > 0) {
    lines.push("", "### Metadata", "");
    for (const [key, value] of Object.entries(manifest.metadata)) {
      lines.push(`- **${key}:** ${value}`);
    }
  }

  lines.push("", "---", `_Manifest id: \`${manifest.manifestId}\` · Checksum: \`${manifest.manifestChecksum}\`_`);

  return lines.join("\n");
}

/**
 * Create a minimal read projection of the manifest for collector/coordinator
 * use. Returns a plain object safe for serialisation or passing to a
 * result collector.
 */
export function projectRoundManifest(
  manifest: RoundManifest,
): RoundManifestProjection {
  return {
    manifestId: manifest.manifestId,
    manifestChecksum: manifest.manifestChecksum,
    generatedAt: manifest.generatedAt,
    roundLabel: manifest.roundLabel,
    parentIssue: manifest.parentIssue,
    teamId: manifest.teamId,
    runId: manifest.runId,
    expectedWorkerIds: manifest.expectedWorkers.map((w) => w.workerId),
    workerAssignments: manifest.expectedWorkers.map((w) => ({
      workerId: w.workerId,
      taskId: w.taskId,
      runId: w.runId,
      traceId: w.traceId,
      lane: w.lane,
      deadlineAt: w.deadlineAt,
      requiredEvidenceTypes: getEffectiveEvidencePolicy(w, manifest.defaultEvidencePolicy).requiredTypes,
      resourcePolicy: w.resourcePolicy,
    })),
    closeoutPolicy: manifest.closeoutPolicy,
    deadlineConfig: manifest.deadlineConfig,
    resourcePolicy: manifest.resourcePolicy,
  };
}

/**
 * Lightweight projection of a RoundManifest for collector/coordinator use.
 *
 * Omits the full document body (kind, version, metadata) and renders worker
 * assignments as a flat list with resolved evidence policies.
 */
export interface RoundManifestProjection {
  manifestId: string;
  manifestChecksum: string;
  generatedAt: string;
  roundLabel?: string;
  parentIssue: RoundManifest["parentIssue"];
  teamId: string;
  runId: string;
  expectedWorkerIds: string[];
  workerAssignments: Array<{
    workerId: string;
    taskId?: string;
    runId?: string;
    traceId?: string;
    lane?: number;
    deadlineAt?: string;
    requiredEvidenceTypes: RoundEvidenceType[];
    resourcePolicy?: WorkerRoundAssignment["resourcePolicy"];
  }>;
  closeoutPolicy: RoundCloseoutPolicy;
  deadlineConfig?: RoundDeadlineConfig;
  resourcePolicy?: RoundManifest["resourcePolicy"];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective evidence policy for a worker, falling back to the
 * round-level default if the worker does not have an explicit policy.
 *
 * The default fallback requires at least one of `pr`, `done`, or `block`.
 */
function getEffectiveEvidencePolicy(
  worker: WorkerRoundAssignment,
  defaultPolicy?: WorkerEvidencePolicy,
): WorkerEvidencePolicy {
  if (worker.evidencePolicy !== undefined) {
    return worker.evidencePolicy;
  }
  return defaultPolicy ?? { requiredTypes: ["pr", "done", "block"], minimumRequired: 1 };
}
