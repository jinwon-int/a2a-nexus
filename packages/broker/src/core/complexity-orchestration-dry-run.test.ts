import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildComplexityOrchestrationDryRun,
  normalizeComplexityOrchestrationDryRunInput,
  renderComplexityOrchestrationDryRunMarkdown,
  type ComplexityOrchestrationDryRunFixture,
  type ComplexityOrchestrationDryRunResult,
} from "./complexity-orchestration-dry-run.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(__dirname, "../../fixtures/complexity-orchestration-recommendation");

function loadFixture(name: string): ComplexityOrchestrationDryRunFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

function assertNoLiveBoundaries(result: ComplexityOrchestrationDryRunResult): void {
  for (const [key, value] of Object.entries(result.boundaries)) {
    assert.equal(value, false, `${key} must remain false`);
  }
  for (const [key, value] of Object.entries(result.packet.boundaries)) {
    assert.equal(value, false, `${key} must remain false`);
  }
}

describe("complexity orchestration dry-run fixtures", () => {
  it("loads every fixture and builds a no-live recommendation packet", () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 2, "expected at least two fixtures");

    for (const file of files) {
      const fixture = loadFixture(file);
      const result = buildComplexityOrchestrationDryRun(fixture);
      assert.equal(
        result.kind,
        "a2a-broker.complexity-orchestration-recommendation-dry-run",
      );
      assert.equal(
        result.packet.kind,
        "a2a-broker.complexity-orchestration-recommendation-packet",
      );
      assert.match(result.packet.idempotencyKey, /^complexity-orch-recommendation:[a-f0-9]{24}$/);
      assertNoLiveBoundaries(result);
    }
  });

  it("turns the complex source-only fixture into parallel subagent recommendation", () => {
    const result = buildComplexityOrchestrationDryRun(
      loadFixture("complex-source-only.json"),
    );
    assert.equal(result.packet.classification.level, "complex");
    assert.equal(result.packet.recommendation.action, "parallel_subagents");
    assert.equal(result.packet.recommendation.parallelismHint, 2);
    assert.match(result.packet.recommendation.safetyGate, /No live execution/i);
  });

  it("turns the critical approval-gated fixture into operator review wording", () => {
    const result = buildComplexityOrchestrationDryRun(
      loadFixture("critical-approval-gated.json"),
    );
    assert.equal(result.packet.classification.level, "critical");
    assert.equal(result.packet.recommendation.action, "operator_review");
    assert.equal(result.packet.recommendation.parallelismHint, 0);
    assert.match(result.packet.recommendation.safetyGate, /no autonomous orchestration/i);
    assert.match(result.packet.recommendation.safetyGate, /explicit approval/i);
  });
});

describe("normalizeComplexityOrchestrationDryRunInput", () => {
  it("accepts raw TaskComplexityInput as the top-level JSON object", () => {
    const normalized = normalizeComplexityOrchestrationDryRunInput({
      intent: "analyze",
      targetEnvironment: "research",
    });
    assert.equal(normalized.input.intent, "analyze");
    assert.equal(normalized.format, "markdown");
  });

  it("accepts taskComplexityInput alias and json format", () => {
    const normalized = normalizeComplexityOrchestrationDryRunInput({
      taskComplexityInput: {
        intent: "verify",
        targetEnvironment: "staging",
      },
      format: "json",
    });
    assert.equal(normalized.input.intent, "verify");
    assert.equal(normalized.format, "json");
  });

  it("rejects missing task complexity input", () => {
    assert.throws(
      () => normalizeComplexityOrchestrationDryRunInput({ description: "missing intent" }),
      /intent/i,
    );
  });

  it("rejects invalid bounds", () => {
    assert.throws(
      () => normalizeComplexityOrchestrationDryRunInput({
        input: { intent: "verify" },
        bounds: { min: "simple", max: "impossible" },
      }),
      /bounds\.min and bounds\.max/i,
    );
  });
});

describe("renderComplexityOrchestrationDryRunMarkdown", () => {
  it("renders dry-run and packet fields for operator review", () => {
    const result = buildComplexityOrchestrationDryRun(
      loadFixture("critical-approval-gated.json"),
    );
    const markdown = renderComplexityOrchestrationDryRunMarkdown(result);
    assert.match(markdown, /complexity-orchestration-recommendation-dry-run/);
    assert.match(markdown, /complexity-orchestration-recommendation-packet/);
    assert.match(markdown, /operator_review/);
    assert.match(markdown, /idempotencyKey/);
    assert.match(markdown, /No orchestration action/i);
  });
});
