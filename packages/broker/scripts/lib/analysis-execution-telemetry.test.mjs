import test from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_EXECUTION_TELEMETRY_VERSION,
  claudeExecutionTelemetry,
  hermesExecutionTelemetry,
  normalizeAnalysisExecutionTelemetry,
  parseExecutionTelemetryLine,
  sumExecutionTelemetry,
} from "./analysis-execution-telemetry.mjs";

const envelope = (cost, usage = { input_tokens: 10, output_tokens: 5 }) => ({
  type: "result",
  duration_ms: 1000,
  num_turns: 1,
  total_cost_usd: cost,
  usage,
});

// #2543: a missing or non-numeric amount is unknown, never a measured 0.
test("claudeExecutionTelemetry leaves non-numeric total_cost_usd unknown", () => {
  for (const cost of [undefined, null, "", "   ", false, true, [], [7], {}, -1, Number.NaN, Number.POSITIVE_INFINITY, "abc"]) {
    assert.equal(claudeExecutionTelemetry(envelope(cost))?.costUsd, undefined, `cost ${JSON.stringify(cost)}`);
  }
});

test("claudeExecutionTelemetry keeps real numbers, including a real zero", () => {
  assert.equal(claudeExecutionTelemetry(envelope(0))?.costUsd, 0);
  assert.equal(claudeExecutionTelemetry(envelope(0.5))?.costUsd, 0.5);
  assert.equal(claudeExecutionTelemetry(envelope("0.25"))?.costUsd, 0.25);
});

test("null token counts are absent, not zero", () => {
  const telemetry = claudeExecutionTelemetry(envelope(0.5, { input_tokens: null, output_tokens: 5, cache_read_input_tokens: "" }));
  assert.equal(telemetry.inputTokens, undefined);
  assert.equal(telemetry.cacheReadInputTokens, undefined);
  assert.equal(telemetry.outputTokens, 5);
});

test("normalizeAnalysisExecutionTelemetry drops null cost and token fields", () => {
  const normalized = normalizeAnalysisExecutionTelemetry({
    schemaVersion: ANALYSIS_EXECUTION_TELEMETRY_VERSION,
    source: "claude_cli_envelope",
    elapsedMs: 1,
    costUsd: null,
    inputTokens: null,
    outputTokens: 3,
  });
  assert.ok(normalized);
  assert.equal(normalized.costUsd, undefined);
  assert.equal(normalized.inputTokens, undefined);
  assert.equal(normalized.outputTokens, 3);
});

test("sumExecutionTelemetry reports no total when one invocation's cost is null", () => {
  const priced = claudeExecutionTelemetry(envelope(0.5));
  assert.equal(sumExecutionTelemetry([priced, claudeExecutionTelemetry(envelope(undefined))], "claude_cli_envelope")?.costUsd, undefined);
  assert.equal(sumExecutionTelemetry([priced, claudeExecutionTelemetry(envelope(null))], "claude_cli_envelope")?.costUsd, undefined);
  assert.equal(sumExecutionTelemetry([priced, claudeExecutionTelemetry(envelope(0.25))], "claude_cli_envelope")?.costUsd, 0.75);
});

test("parseExecutionTelemetryLine keeps a serialized null cost unknown", () => {
  const line = `a2a_execution_telemetry=${JSON.stringify({
    schemaVersion: ANALYSIS_EXECUTION_TELEMETRY_VERSION,
    source: "claude_cli_envelope",
    elapsedMs: 10,
    outputTokens: 4,
    costUsd: null,
  })}`;
  const parsed = parseExecutionTelemetryLine(`noise\n${line}\n`);
  assert.ok(parsed);
  assert.equal(parsed.costUsd, undefined);
  assert.equal(parsed.outputTokens, 4);
});

test("hermesExecutionTelemetry falls back to the estimate when the actual amount is NULL", () => {
  const row = { cost_status: "actual", actual_cost_usd: null, estimated_cost_usd: 0.2, input_tokens: 5, output_tokens: 1 };
  assert.equal(hermesExecutionTelemetry([row], 100).costUsd, 0.2);
  const noEstimate = { cost_status: "estimated", estimated_cost_usd: null, input_tokens: 5, output_tokens: 1 };
  assert.equal(hermesExecutionTelemetry([noEstimate], 100).costUsd, undefined);
});
