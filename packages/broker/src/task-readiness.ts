import { parseTaskAcceptance } from "./worker-acceptance.js";
import { validateTaskRetryPolicy } from "./core/task-retry-policy.js";
import type { TaskRecord } from "./core/types.js";
import { isRecord } from "./core/value-guards.js";

export type TaskReadinessMode = "warn" | "enforce";

export const DEFAULT_TASK_READINESS_MODE: TaskReadinessMode = "warn";

export interface TaskReadinessEvaluationOptions {
  intent?: string;
  mode?: TaskReadinessMode;
}

export interface TaskReadinessResult {
  ok: boolean;
  missing: string[];
  applies: boolean;
  mode: TaskReadinessMode;
  code?: "spec_underspecified" | "source_projection_empty" | "retry_policy_malformed";
  details?: Record<string, unknown>;
}

const PATCH_TASK_INTENTS = new Set(["propose_patch", "apply_local_change"]);
const PATCH_TASK_MODES = new Set(["github-propose-patch", "propose-patch", "patch"]);

export function normalizeTaskReadinessMode(value: unknown): TaskReadinessMode {
  if (value === undefined) return DEFAULT_TASK_READINESS_MODE;
  if (value === "warn" || value === "enforce") return value;
  throw new Error("task readiness mode must be one of: warn, enforce");
}

export function evaluateTaskReadiness(
  payload: Record<string, unknown> | undefined,
  options: TaskReadinessEvaluationOptions = {},
): TaskReadinessResult {
  const mode = normalizeTaskReadinessMode(options.mode);
  const record = payload ?? {};
  const retryPolicy = validateTaskRetryPolicy(record["retryPolicy"]);
  if (!retryPolicy.ok) {
    return {
      ok: false,
      missing: retryPolicy.missing,
      applies: true,
      mode,
      code: "retry_policy_malformed",
      details: { missing: retryPolicy.missing },
    };
  }
  const sourceProjection = evaluateSourceProjectionReadiness(record, options.intent, mode);
  if (sourceProjection.applies) return sourceProjection;

  const applies = isReadinessGatedTask(record, options.intent);
  if (!applies) {
    return { ok: true, missing: [], applies, mode };
  }

  const missing: string[] = [];
  if (!hasValidAcceptance(record)) missing.push("acceptance");
  if (!hasValidDeclaredScope(record)) missing.push("declaredScope");
  if (!hasValidEvidenceGate(record)) missing.push("evidenceGate");

  return { ok: missing.length === 0, missing, applies, mode, code: "spec_underspecified" };
}

export function isReadinessGatedTask(payload: Record<string, unknown>, intent?: string): boolean {
  if (payload["patchIntent"] === true) return true;
  const rawMode = payload["mode"];
  const mode = typeof rawMode === "string" ? rawMode.trim() : undefined;
  if (mode && PATCH_TASK_MODES.has(mode)) return true;
  return typeof intent === "string" && PATCH_TASK_INTENTS.has(intent);
}

function hasValidAcceptance(payload: Record<string, unknown>): boolean {
  const parsed = parseTaskAcceptance({ payload } as unknown as TaskRecord);
  return parsed !== null && !parsed.error;
}

function hasValidDeclaredScope(payload: Record<string, unknown>): boolean {
  const raw = payload["declaredScope"];
  if (!isRecord(raw)) return false;
  const paths = raw["paths"];
  return Array.isArray(paths) && paths.length > 0 && paths.every((value) => typeof value === "string" && value.trim().length > 0);
}

function hasValidEvidenceGate(payload: Record<string, unknown>): boolean {
  return typeof payload["evidenceGate"] === "string" && payload["evidenceGate"].trim().length > 0;
}

function evaluateSourceProjectionReadiness(
  payload: Record<string, unknown>,
  intent: string | undefined,
  mode: TaskReadinessMode,
): TaskReadinessResult {
  const applies = isSourceOnlyAnalysisTask(payload, intent);
  if (!applies) return { ok: true, missing: [], applies: false, mode };
  const stats = sourceCarrierStats(payload);
  if (stats.totalFiles > 0) return { ok: true, missing: [], applies: true, mode };
  return {
    ok: false,
    missing: ["sourceFiles"],
    applies: true,
    mode,
    code: "source_projection_empty",
    details: {
      stage: "dispatch",
      excerpt: `stage=dispatch quality=zero_files budgetReason=no_source_files sourceBundle.files=${stats.sourceBundleFiles} sourceFiles=${stats.sourceFiles} sourceEvidence=${stats.sourceEvidence} canonicalBytes=${stats.totalBytes}`,
      quality: "zero_files",
      budgetReason: "no_source_files",
      sourceBundleFileCount: stats.sourceBundleFiles,
      sourceFilesCount: stats.sourceFiles,
      sourceEvidenceCount: stats.sourceEvidence,
      canonicalBytes: stats.totalBytes,
    },
  };
}

function isSourceOnlyAnalysisTask(payload: Record<string, unknown>, intent?: string): boolean {
  if (intent !== "analyze") return false;
  if (payload["sourceOnly"] !== true && payload["source_only"] !== true) return false;
  const mode = typeof payload["mode"] === "string" ? payload["mode"].trim() : "";
  return mode === "" || mode === "analysis-only" || mode === "read-only-analysis" || mode === "github-read-only-validation" || mode === "github-readonly-validation";
}

function sourceCarrierStats(payload: Record<string, unknown>): {
  sourceBundleFiles: number;
  sourceFiles: number;
  sourceEvidence: number;
  totalFiles: number;
  totalBytes: number;
} {
  const bundle = isRecord(payload["sourceBundle"]) && Array.isArray(payload["sourceBundle"]["files"])
    ? payload["sourceBundle"]["files"]
    : [];
  const sourceFiles = Array.isArray(payload["sourceFiles"]) ? payload["sourceFiles"] : [];
  const sourceEvidence = Array.isArray(payload["sourceEvidence"]) ? payload["sourceEvidence"] : [];
  const all = [...bundle, ...sourceFiles, ...sourceEvidence];
  return {
    sourceBundleFiles: bundle.length,
    sourceFiles: sourceFiles.length,
    sourceEvidence: sourceEvidence.length,
    totalFiles: all.length,
    totalBytes: all.reduce((sum, item) => sum + sourceCarrierBytes(item), 0),
  };
}

function sourceCarrierBytes(value: unknown): number {
  if (!isRecord(value)) return 0;
  for (const key of ["content", "contentText", "text", "summary"]) {
    const raw = value[key];
    if (typeof raw === "string") return Buffer.byteLength(raw, "utf8");
  }
  return 0;
}
