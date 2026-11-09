// #2518: usage telemetry the contained bridge reports for a run (tokens, and
// cost only when the runtime priced it), carried into the artifact manifest,
// the result summary and the runner result so the worker handler can put it
// on the broker terminal result (`executionTelemetry`).
//
// The producer contract lives in
// packages/broker/scripts/lib/analysis-execution-telemetry.mjs; this side only
// projects onto a closed numeric field set and never computes usage itself.
import type { RunnerExecutionTelemetry } from "./types.js";

export const EXECUTION_TELEMETRY_SCHEMA_VERSION = "a2a.analysis-execution-telemetry.v1";
export const EXECUTION_TELEMETRY_ARTIFACT = "execution-telemetry.json";
export const EXECUTION_TELEMETRY_STDERR_PREFIX = "a2a_execution_telemetry=";

const COUNT_FIELDS = [
  "elapsedMs",
  "modelRequests",
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "toolCalls",
] as const;

const SOURCE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Project an untrusted telemetry object onto RunnerExecutionTelemetry. A wrong
 * schema version or source shape, or any present field that is not a finite
 * non-negative number, rejects the whole object (no partial guesses). Counts
 * are floored to integers; unknown keys are dropped.
 */
export function normalizeRunnerExecutionTelemetry(value: unknown): RunnerExecutionTelemetry | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== EXECUTION_TELEMETRY_SCHEMA_VERSION) return undefined;
  if (typeof value.source !== "string" || !SOURCE_PATTERN.test(value.source)) return undefined;
  const telemetry: RunnerExecutionTelemetry = { schemaVersion: EXECUTION_TELEMETRY_SCHEMA_VERSION, source: value.source };
  for (const field of COUNT_FIELDS) {
    const raw = value[field];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined;
    telemetry[field] = Math.floor(raw);
  }
  if (value.costUsd !== undefined) {
    if (typeof value.costUsd !== "number" || !Number.isFinite(value.costUsd) || value.costUsd < 0) return undefined;
    telemetry.costUsd = value.costUsd;
  }
  if (value.truncated === true) telemetry.truncated = true;
  return telemetry;
}

export function isRunnerExecutionTelemetry(value: unknown): value is RunnerExecutionTelemetry {
  return normalizeRunnerExecutionTelemetry(value) !== undefined;
}

/** The last well-formed `a2a_execution_telemetry=` line across the given streams. */
export function extractExecutionTelemetryLine(...streams: string[]): RunnerExecutionTelemetry | undefined {
  for (const stream of [...streams].reverse()) {
    const lines = stream.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.startsWith(EXECUTION_TELEMETRY_STDERR_PREFIX)) continue;
      try {
        const normalized = normalizeRunnerExecutionTelemetry(JSON.parse(line.slice(EXECUTION_TELEMETRY_STDERR_PREFIX.length)));
        if (normalized) return normalized;
      } catch {
        // Ignore malformed lookalikes.
      }
    }
  }
  return undefined;
}
