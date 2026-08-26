/**
 * External handler execution + error normalization (#1601 churn relief,
 * extracted from worker.ts slice 6).
 *
 * Everything between "spawn the operator's task-handler command" and "a
 * normalized WorkerHandlerOutcome / TaskError the broker worker class can
 * trust": the bounded child-process runner with its SIGTERM/SIGKILL ladder,
 * the handler stdout nested-error parser, the #1725 failure classification
 * (handler_missing vs handler_bridge_error), the handler-spawn error type,
 * home-broker-lease file assertions, and the outcome/error normalizers
 * (including toTaskError, the single boundary every task-processing error
 * crosses).
 *
 * Depends on broker-worker-client.ts only for the shared BrokerApiError class; everything
 * else is self-contained pure logic over the core types.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskError, TaskResult } from "../core/types.js";
import type { FailureClass } from "../core/task-error-details.js";
import { BrokerApiError } from "./broker-worker-client.js";

export interface WorkerHandlerOutcome {
  result?: TaskResult;
  error?: TaskError;
}

export interface HomeBrokerLease {
  brokerId: string;
  brokerUrl: string;
  workerId: string;
  createdAt: string;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
// UTF-16 unit ceiling per captured stream (~8MB of ASCII), matching the
// Claude bridge's maxBuffer so a runaway handler cannot OOM the worker.
const MAX_HANDLER_STREAM_CHARS = 8 * 1024 * 1024;

export async function runExternalHandler(options: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  input: string;
}): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const hardKillTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGKILL");
    }, options.timeoutMs + DEFAULT_SHUTDOWN_GRACE_MS);

    const timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Cap accumulation so a runaway handler cannot OOM the worker (the
    // Claude bridge applies the same 8MB ceiling). Excess output is
    // discarded; a response truncated here fails handler-output parsing
    // with the existing invalid-output error path.
    let stdoutLength = 0;
    let stderrLength = 0;
    child.stdout.on("data", (chunk: string) => {
      if (stdoutLength >= MAX_HANDLER_STREAM_CHARS) return;
      stdoutLength += chunk.length;
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderrLength >= MAX_HANDLER_STREAM_CHARS) return;
      stderrLength += chunk.length;
      stderr += chunk;
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(hardKillTimer);
      // Wrap at the boundary: a spawn failure here is unambiguously the handler
      // command. Previously this rejected the bare Error, which toTaskError
      // turned into a TaskError with NO `code` at all — the 2026-08-03 audit
      // counted 10 such code-less failures (16%) with no traceable cause.
      reject(new HandlerSpawnError(error as NodeJS.ErrnoException, options.command));
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(hardKillTimer);
      resolve({ stdout, stderr, code, signal, timedOut });
    });

    child.stdin.end(options.input);
  });
}

function boundedDiagnosticExcerpt(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  // Head + tail (#1610): the actionable error is almost always at the end of
  // the output, not the beginning.
  const headLength = Math.floor(maxLength / 3);
  const tailLength = maxLength - headLength - 1;
  return `${normalized.slice(0, headLength)}…${normalized.slice(normalized.length - tailLength)}`;
}

function parseHandlerStdoutError(stdout: string): TaskError | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const error = (parsed as Record<string, unknown>).error;
    if (!error) return undefined;
    return normalizeExternalTaskError(error);
  } catch {
    return undefined;
  }
}

/**
 * Nested handler/bridge codes that mean the artifact was not there, so nothing
 * ran. Kept as an explicit list rather than a prefix match: a new code should
 * have to be classified deliberately.
 */
const HANDLER_MISSING_NESTED_CODES = new Set([
  "openclaw_analysis_bridge_missing",
  "openclaw_analysis_spawn_failed",
]);

/** Nested codes that mean the bridge ran and produced output we could not use. */
const HANDLER_BRIDGE_ERROR_NESTED_CODES = new Set([
  "analysis_bridge_invalid_json",
  "openclaw_analysis_failed",
  "openclaw_analysis_no_final_json",
  "openclaw_bridge_failed",
  "openclaw_bridge_no_final_json",
  "openclaw_bridge_invalid_response",
  "decision_dialectic_bridge_no_final_json",
]);

/**
 * Node's own module-resolution failures. These are stable machine codes, not
 * prose, so matching them is not brittle: a worker whose handler script is
 * absent exits with MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND in seconds. This is
 * the exact shape the 2026-08-03 audit saw twice at 3s and 5s.
 */
const MODULE_NOT_FOUND_PATTERN = /\b(?:ERR_)?MODULE_NOT_FOUND\b/;

export function classifyHandlerFailure(input: {
  nestedCode?: string;
  diagnosticText?: string;
}): FailureClass | undefined {
  const nestedCode = input.nestedCode?.trim();
  if (nestedCode) {
    if (HANDLER_MISSING_NESTED_CODES.has(nestedCode)) return "handler_missing";
    if (HANDLER_BRIDGE_ERROR_NESTED_CODES.has(nestedCode)) return "handler_bridge_error";
  }
  if (input.diagnosticText && MODULE_NOT_FOUND_PATTERN.test(input.diagnosticText)) {
    return "handler_missing";
  }
  // Deliberately unclassified: an unrecognised failure keeps the legacy
  // handler_exit_nonzero code with no class, rather than being guessed into a
  // bucket a reader would then trust.
  return undefined;
}

/**
 * A handler process that could not be started at all (ENOENT/EACCES on spawn).
 * Raised at the spawn boundary so the classification is only applied where we
 * know the failure is the handler command itself — `toTaskError` sees every
 * error in task processing and must not classify by errno alone.
 */
export class HandlerSpawnError extends Error {
  constructor(readonly cause: NodeJS.ErrnoException, readonly command: string) {
    super(cause.message);
    this.name = "HandlerSpawnError";
  }

  get missingArtifact(): boolean {
    return this.cause.code === "ENOENT" || this.cause.code === "EACCES";
  }
}

export function handlerExitNonzeroError(options: {
  command: string;
  args: string[];
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}): TaskError {
  const nested = parseHandlerStdoutError(options.stdout);
  const nestedDetails = nested?.details;
  const nestedStage = typeof nestedDetails?.stage === "string" ? nestedDetails.stage : undefined;
  const nestedExcerpt = typeof nestedDetails?.excerpt === "string" ? nestedDetails.excerpt : undefined;
  const stderrExcerpt = boundedDiagnosticExcerpt(options.stderr);
  const stdoutExcerpt = boundedDiagnosticExcerpt(options.stdout);
  // Prefer the nested runner/handler error message over the raw JSON wrapper:
  // the wrapper's head is preamble noise while the message carries the
  // runner's own head+tail of the failing output (#1610).
  const fallbackExcerpt =
    boundedDiagnosticExcerpt(nested?.message)
    ?? stderrExcerpt
    ?? stdoutExcerpt
    ?? `handler exited with code ${options.code}${options.signal ? ` (${options.signal})` : ""}`;

  // Classify from the nested code first, then from the raw streams — a worker
  // whose handler module is absent never produces a nested error at all, it
  // just gets MODULE_NOT_FOUND on stderr.
  const failureClass = classifyHandlerFailure({
    nestedCode: nested?.code,
    diagnosticText: `${options.stderr}\n${options.stdout}`,
  });

  return {
    // The legacy code is preserved: every existing consumer (retry policy,
    // evidence classifier, historical task records) still matches it. The split
    // #1725 asked for is carried by failureClass, which is additive and, unlike
    // nestedError, survives the list projections.
    code: "handler_exit_nonzero",
    message: options.stderr.trim() || `handler exited with code ${options.code}${options.signal ? ` (${options.signal})` : ""}`,
    details: {
      stage: nestedStage ?? "handler",
      excerpt: nestedExcerpt ?? fallbackExcerpt,
      ...(failureClass ? { failureClass } : {}),
      command: options.command,
      args: options.args,
      code: options.code,
      signal: options.signal,
      stdout: options.stdout.trim() || undefined,
      nestedError: nested
        ? {
            code: nested.code,
            message: nested.message,
            details: nested.details,
          }
        : undefined,
    },
  };
}

export function normalizeExternalTaskError(value: unknown): TaskError {
  if (typeof value === "string") {
    return { message: value };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { message: "external handler reported an unknown error" };
  }

  const record = value as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : "external handler failed",
    details:
      record.details && typeof record.details === "object" && !Array.isArray(record.details)
        ? (record.details as Record<string, unknown>)
        : undefined,
  };
}

export function normalizeWorkerHandlerOutcome(
  value: WorkerHandlerOutcome | TaskResult | void,
): WorkerHandlerOutcome {
  if (!value) {
    return { result: {} };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("worker handler must return an object");
  }

  if (isWorkerHandlerOutcome(value)) {
    return value;
  }

  return { result: value };
}

function isWorkerHandlerOutcome(value: TaskResult | WorkerHandlerOutcome): value is WorkerHandlerOutcome {
  return "result" in value || "error" in value;
}

export function isSkippableClaimError(error: unknown): boolean {
  return error instanceof BrokerApiError && [401, 403, 404, 409].includes(error.status);
}

export function parseJsonText(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  return JSON.parse(text);
}

export function toTaskError(error: unknown): TaskError {
  if (error instanceof BrokerApiError) {
    return {
      code: error.code,
      message: error.message,
      details: { status: error.status },
    };
  }

  if (error instanceof HandlerSpawnError) {
    return {
      code: "handler_spawn_failed",
      message: error.message,
      details: {
        // `stage` is deliberately NOT set to "handler" here. classifyTaskErrorForRetry
        // treats stage==="handler" as the retryable "environment" class, so setting it
        // would silently make spawn failures auto-retryable — they are not today, and
        // flipping that is a retry-behaviour decision, not a diagnostics one. The
        // failureClass below carries the diagnosis without touching retry.
        excerpt: boundedDiagnosticExcerpt(error.message) ?? error.message,
        ...(error.missingArtifact ? { failureClass: "handler_missing" as const } : {}),
        errno: error.cause.code,
      },
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      details: { name: error.name },
    };
  }

  return { message: typeof error === "string" ? error : "task failed" };
}

export async function assertHomeBrokerLease(path: string, expected: HomeBrokerLease): Promise<void> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as Partial<HomeBrokerLease>;
    if (parsed.brokerId !== expected.brokerId) {
      throw new Error(
        `home broker lease mismatch at ${path}: expected ${expected.brokerId}, found ${parsed.brokerId ?? "<missing>"}`,
      );
    }
    return;
  } catch (error: unknown) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(expected, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if (!isFileAlreadyExistsError(error)) {
      throw error;
    }
    await assertHomeBrokerLease(path, expected);
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
