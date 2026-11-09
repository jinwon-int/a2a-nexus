import assert from "node:assert/strict";
import test from "node:test";

import { extractExecutionTelemetryLine, normalizeRunnerExecutionTelemetry } from "./execution-telemetry.js";

const valid = {
  schemaVersion: "a2a.analysis-execution-telemetry.v1",
  source: "claude_cli_envelope",
  elapsedMs: 1200.9,
  modelRequests: 3,
  inputTokens: 120,
  outputTokens: 450,
  cacheReadInputTokens: 90_000,
  cacheCreationInputTokens: 3_000,
  costUsd: 0.4321,
  truncated: true,
};

test("#2518 normalizeRunnerExecutionTelemetry projects onto the closed numeric field set", () => {
  assert.deepEqual(normalizeRunnerExecutionTelemetry({ ...valid, prompt: "secret text", toolCalls: 2 }), {
    ...valid,
    elapsedMs: 1200,
    toolCalls: 2,
  });
  // Cost is optional: absent means unknown, never zero.
  const { costUsd: _omit, ...withoutCost } = valid;
  assert.equal(normalizeRunnerExecutionTelemetry(withoutCost)?.costUsd, undefined);
});

test("#2518 normalizeRunnerExecutionTelemetry rejects wrong schema, source shape and any invalid number", () => {
  assert.equal(normalizeRunnerExecutionTelemetry(null), undefined);
  assert.equal(normalizeRunnerExecutionTelemetry([valid]), undefined);
  assert.equal(normalizeRunnerExecutionTelemetry({ ...valid, schemaVersion: "v0" }), undefined);
  assert.equal(normalizeRunnerExecutionTelemetry({ ...valid, source: "Claude CLI" }), undefined);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "12"]) {
    assert.equal(normalizeRunnerExecutionTelemetry({ ...valid, inputTokens: bad }), undefined, String(bad));
    assert.equal(normalizeRunnerExecutionTelemetry({ ...valid, costUsd: bad }), undefined, String(bad));
  }
});

test("#2518 extractExecutionTelemetryLine takes the last well-formed line and ignores lookalikes", () => {
  const older = { ...valid, inputTokens: 1 };
  const stderr = [
    `a2a_execution_telemetry=${JSON.stringify(older)}`,
    `a2a_execution_telemetry=${JSON.stringify(valid)}`,
    "a2a_execution_telemetry={not json",
    `  a2a_execution_telemetry=${JSON.stringify({ ...valid, inputTokens: 999 })}`,
  ].join("\n");
  assert.equal(extractExecutionTelemetryLine(stderr)?.inputTokens, 120);
  assert.equal(extractExecutionTelemetryLine("nothing here"), undefined);
});
