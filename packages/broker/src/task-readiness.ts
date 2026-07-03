import { parseTaskAcceptance } from "./worker-acceptance.js";
import type { TaskRecord } from "./core/types.js";

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
}

const PATCH_TASK_INTENTS = new Set(["propose_patch", "apply_local_change"]);
const PATCH_TASK_MODES = new Set(["github-propose-patch", "propose-patch", "patch"]);

export function normalizeTaskReadinessMode(value: unknown): TaskReadinessMode {
  return value === "enforce" ? "enforce" : DEFAULT_TASK_READINESS_MODE;
}

export function evaluateTaskReadiness(
  payload: Record<string, unknown> | undefined,
  options: TaskReadinessEvaluationOptions = {},
): TaskReadinessResult {
  const mode = normalizeTaskReadinessMode(options.mode);
  const record = payload ?? {};
  const applies = isReadinessGatedTask(record, options.intent);
  if (!applies) {
    return { ok: true, missing: [], applies, mode };
  }

  const missing: string[] = [];
  if (!hasValidAcceptance(record)) missing.push("acceptance");
  if (!hasValidDeclaredScope(record)) missing.push("declaredScope");
  if (!hasValidEvidenceGate(record)) missing.push("evidenceGate");

  return { ok: missing.length === 0, missing, applies, mode };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
