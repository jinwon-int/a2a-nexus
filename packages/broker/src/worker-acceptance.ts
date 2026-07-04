/**
 * Task acceptance contract (#1218).
 *
 * A dispatcher can attach a machine-checkable acceptance command to a task via
 * `task.payload.acceptance`. The worker must run it after the handler succeeds
 * and submit the outcome as `result.validation` or `result.validations[]`;
 * completion evidence is
 * rejected fail-closed when an acceptance-bearing task arrives without a
 * passing validation payload. This turns "what must pass for this task to be
 * done" from prose in an issue into part of the task contract itself.
 *
 * Payload shape:
 *   acceptance: {
 *     command: string[],        // argv, executed without a shell
 *     expectExitCode?: number,  // default 0
 *     timeoutMs?: number,       // default 120_000, bounds a hung command
 *   }
 *
 * The command runs in the worker process's working directory with the same
 * trust boundary as the task handler itself — no extra privileges.
 */
import { spawnSync } from "node:child_process";

import type { TaskError, TaskRecord, TaskResult, TaskValidationPayload } from "./core/types.js";

export interface TaskAcceptanceSpec {
  command: string[];
  expectExitCode: number;
  timeoutMs: number;
}

export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 120_000;
const MAX_NOTE_COMMAND_LENGTH = 200;

export type ParsedTaskAcceptance =
  | { spec: TaskAcceptanceSpec; error?: undefined }
  | { spec?: undefined; error: TaskError }
  | null;

/**
 * Read `task.payload.acceptance`. Returns null when absent; a TaskError when
 * present but malformed (fail-closed: a dispatcher that tried to specify
 * acceptance must not silently lose it to a typo).
 */
export function parseTaskAcceptance(task: TaskRecord): ParsedTaskAcceptance {
  const raw = (task.payload as Record<string, unknown> | undefined)?.acceptance;
  if (raw === undefined || raw === null) return null;

  const malformed = (detail: string): { error: TaskError } => ({
    error: {
      code: "acceptance_malformed",
      message: `task.payload.acceptance is malformed: ${detail}`,
    },
  });

  if (typeof raw !== "object" || Array.isArray(raw)) return malformed("expected an object");
  const record = raw as Record<string, unknown>;
  const command = record.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string" && part.length > 0)) {
    return malformed("command must be a non-empty string array");
  }
  let expectExitCode = 0;
  if (record.expectExitCode !== undefined) {
    if (typeof record.expectExitCode !== "number" || !Number.isInteger(record.expectExitCode)) {
      return malformed("expectExitCode must be an integer");
    }
    expectExitCode = record.expectExitCode;
  }
  let timeoutMs = DEFAULT_ACCEPTANCE_TIMEOUT_MS;
  if (record.timeoutMs !== undefined) {
    if (typeof record.timeoutMs !== "number" || !Number.isFinite(record.timeoutMs) || record.timeoutMs <= 0) {
      return malformed("timeoutMs must be a positive number");
    }
    timeoutMs = record.timeoutMs;
  }
  return { spec: { command: command as string[], expectExitCode, timeoutMs } };
}

/** Run the acceptance command and report it as a validation payload. */
export function runTaskAcceptance(spec: TaskAcceptanceSpec): TaskValidationPayload {
  const startedAt = Date.now();
  const [executable, ...args] = spec.command;
  const run = spawnSync(executable, args, { timeout: spec.timeoutMs, encoding: "utf8" });
  const durationMs = Date.now() - startedAt;
  const timedOut = run.error !== undefined && (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const exitCode = typeof run.status === "number" ? run.status : -1;
  const pass = !run.error && exitCode === spec.expectExitCode;
  const commandNote = spec.command.join(" ").slice(0, MAX_NOTE_COMMAND_LENGTH);
  return {
    kind: "smoke",
    verdict: pass ? "pass" : "fail",
    metrics: {
      acceptance: true,
      exitCode,
      expectedExitCode: spec.expectExitCode,
      durationMs,
      timedOut,
    },
    note: pass
      ? `acceptance passed: ${commandNote}`
      : `acceptance failed (${timedOut ? "timeout" : `exit ${exitCode}, expected ${spec.expectExitCode}`}): ${commandNote}`,
  };
}

/**
 * Fail-closed completion-evidence rule: a task that declares acceptance may
 * only complete with a passing smoke validation payload. This holds even for custom
 * handlers that never ran the acceptance step — absence of evidence is a
 * failure, not a pass (#1194 RC-B).
 */
export const LEGACY_SINGLETON_ACCEPTANCE_CUTOFF_ISO = "2026-07-04T02:30:00.000Z";
const LEGACY_SINGLETON_ACCEPTANCE_CUTOFF_MS = Date.parse(LEGACY_SINGLETON_ACCEPTANCE_CUTOFF_ISO);

function isAtOrAfterLegacySingletonCutoff(task: TaskRecord): boolean {
  const createdAtMs = Date.parse(task.createdAt);
  return Number.isFinite(createdAtMs) && createdAtMs >= LEGACY_SINGLETON_ACCEPTANCE_CUTOFF_MS;
}

function validationByKind(result: TaskResult | undefined, kind: TaskValidationPayload["kind"]): TaskValidationPayload | undefined {
  if (!result) return undefined;
  if (Array.isArray(result.validations)) {
    return result.validations.find((validation) => validation?.kind === kind);
  }
  return result.validation;
}

function warnLegacyAcceptanceValidation(validation: TaskValidationPayload | undefined): void {
  if (!validation || validation.kind === "smoke") return;
  console.warn(JSON.stringify({
    level: "warn",
    code: "legacy_acceptance_validation_kind_mismatch",
    message: "result.validation satisfied payload.acceptance without kind=smoke; submit result.validations[] with a smoke validation for combined acceptance/review tasks",
    validationKind: validation.kind,
  }));
}

export function validateAcceptanceEvidence(task: TaskRecord, result?: TaskResult): TaskError | null {
  const parsed = parseTaskAcceptance(task);
  if (parsed === null) return null;
  if (parsed.error) return parsed.error;
  const validation = validationByKind(result, "smoke");
  const verdict = validation?.verdict;
  if (verdict === "pass") {
    if (!Array.isArray(result?.validations) && validation?.kind !== "smoke") {
      if (isAtOrAfterLegacySingletonCutoff(task)) {
        return {
          code: "acceptance_evidence_missing",
          message:
            `task declares payload.acceptance but legacy result.validation.kind is "${validation?.kind ?? "unknown"}"; ` +
            "cutoff requires result.validation.kind=smoke or result.validations[] with a passing smoke validation",
        };
      }
      warnLegacyAcceptanceValidation(validation);
    }
    return null;
  }
  return {
    code: "acceptance_evidence_missing",
    message:
      verdict === undefined
        ? Array.isArray(result?.validations)
          ? "task declares payload.acceptance but result.validations has no smoke validation payload; run the acceptance command and submit its verdict"
          : "task declares payload.acceptance but the result has no validation payload; run the acceptance command and submit its verdict"
        : `task declares payload.acceptance but ${Array.isArray(result?.validations) ? "result.validations[kind=smoke]" : "result.validation"}.verdict is "${verdict}" (requires "pass")`,
  };
}
