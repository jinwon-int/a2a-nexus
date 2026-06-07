/**
 * Tests for the deterministic source-only task-complexity classifier.
 *
 * Covers intent-derived base levels, environment/policy offsets, safety
 * bounds clamping, aggregate reporting, fixture-loading validation, and
 * edge cases.
 *
 * Reference: #970 Team2 (gwakga/soonwook)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyTaskComplexity,
  classifyTaskComplexities,
  extractTaskComplexitySignals,
  aggregateTaskComplexity,
  compareComplexity,
  COMPLEXITY_LEVELS,
  COMPLEXITY_ORDINAL,
  DEFAULT_COMPLEXITY_BOUNDS,
  HERMES_MOBILE_BOUNDS,
  READONLY_BOUNDS,
  SIMPLE_ANALYSIS_INPUT,
  MODERATE_BACKFILL_INPUT,
  COMPLEX_PATCH_INPUT,
  COMPLEX_APPLY_INPUT,
  CRITICAL_PROMOTE_INPUT,
  CRITICAL_ROLLBACK_INPUT,
  type TaskComplexityInput,
  type TaskComplexityClassification,
  type ComplexityLevel,
  type ComplexityBounds,
  type TaskComplexityOrigin,
} from "./task-complexity-classifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(__dirname, "../../fixtures/task-complexity-classifier");

interface ClassificationFixture {
  kind: string;
  version: number;
  generatedAt: string;
  description: string;
  input: TaskComplexityInput;
  bounds?: ComplexityBounds;
  expectedLevel: ComplexityLevel;
  expectedOrigin: TaskComplexityOrigin;
  boundaries: Record<string, boolean>;
}

function loadFixtures(): ClassificationFixture[] {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const content = readFileSync(join(FIXTURE_DIR, f), "utf-8");
    const fixture = JSON.parse(content) as ClassificationFixture;
    assert.ok(fixture.kind, `${f}: missing kind`);
    assert.ok(fixture.input, `${f}: missing input`);
    assert.ok(fixture.expectedLevel, `${f}: missing expectedLevel`);
    return fixture;
  });
}

// ---------------------------------------------------------------------------
// Constants and level ordering
// ---------------------------------------------------------------------------

describe("COMPLEXITY_LEVELS order", () => {
  it("has exactly four levels in ascending order", () => {
    assert.deepEqual([...COMPLEXITY_LEVELS], ["simple", "moderate", "complex", "critical"]);
    assert.equal(COMPLEXITY_LEVELS.length, 4);
  });

  it("COMPLEXITY_ORDINAL maps each level to its index", () => {
    assert.equal(COMPLEXITY_ORDINAL.get("simple"), 0);
    assert.equal(COMPLEXITY_ORDINAL.get("moderate"), 1);
    assert.equal(COMPLEXITY_ORDINAL.get("complex"), 2);
    assert.equal(COMPLEXITY_ORDINAL.get("critical"), 3);
  });
});

// ---------------------------------------------------------------------------
// compareComplexity
// ---------------------------------------------------------------------------

describe("compareComplexity", () => {
  it("returns -1 when a < b", () => {
    assert.equal(compareComplexity("simple", "critical"), -1);
    assert.equal(compareComplexity("moderate", "complex"), -1);
  });

  it("returns 0 when a === b", () => {
    assert.equal(compareComplexity("simple", "simple"), 0);
    assert.equal(compareComplexity("critical", "critical"), 0);
  });

  it("returns 1 when a > b", () => {
    assert.equal(compareComplexity("critical", "simple"), 1);
    assert.equal(compareComplexity("complex", "moderate"), 1);
  });

  it("returns null for unknown levels", () => {
    assert.equal(compareComplexity("unknown" as ComplexityLevel, "simple"), null);
    assert.equal(compareComplexity("simple", "unknown" as ComplexityLevel), null);
  });
});

// ---------------------------------------------------------------------------
// extractTaskComplexitySignals
// ---------------------------------------------------------------------------

describe("extractTaskComplexitySignals", () => {
  it("recognizes all known intents", () => {
    const intents = [
      "chat", "analyze", "verify",
      "backfill", "propose_params",
      "propose_patch", "validate_change", "apply_local_change",
      "promote_to_live", "rollback_live",
    ] as const;
    for (const intent of intents) {
      const signals = extractTaskComplexitySignals({ intent });
      assert.equal(signals.intentRecognized, true, `intent ${intent} should be recognized`);
      assert.ok(signals.baseLevel !== null, `intent ${intent} should have a base level`);
    }
  });

  it("defaults unknown environment to 0 offset", () => {
    const signals = extractTaskComplexitySignals({ intent: "chat" });
    assert.equal(signals.environmentOffset, 0);
  });

  it("applies live environment offset", () => {
    const signals = extractTaskComplexitySignals({
      intent: "analyze",
      targetEnvironment: "live",
    });
    assert.equal(signals.environmentOffset, 1);
  });

  it("does not apply staging/research offset", () => {
    const staging = extractTaskComplexitySignals({
      intent: "analyze",
      targetEnvironment: "staging",
    });
    const research = extractTaskComplexitySignals({
      intent: "analyze",
      targetEnvironment: "research",
    });
    assert.equal(staging.environmentOffset, 0);
    assert.equal(research.environmentOffset, 0);
  });

  it("counts requiresApproval as offset", () => {
    const signals = extractTaskComplexitySignals({
      intent: "analyze",
      policyContext: { requiresApproval: true },
    });
    assert.equal(signals.requiresApproval, true);
    assert.equal(signals.totalOffset, 1);
  });

  it("counts liveImpact as offset", () => {
    const signals = extractTaskComplexitySignals({
      intent: "analyze",
      policyContext: { liveImpact: true },
    });
    assert.equal(signals.liveImpact, true);
    assert.equal(signals.totalOffset, 1);
  });

  it("cumulates multiple offsets", () => {
    const signals = extractTaskComplexitySignals({
      intent: "analyze",
      targetEnvironment: "live",
      policyContext: { requiresApproval: true, liveImpact: true },
      referenceCount: 3,
      artifactCount: 3,
      turnCount: 5,
    });
    assert.equal(signals.environmentOffset, 1);
    assert.equal(signals.requiresApproval, true);
    assert.equal(signals.liveImpact, true);
    assert.equal(signals.effectiveReferenceCount, 3);
    assert.equal(signals.effectiveArtifactCount, 3);
    assert.equal(signals.effectiveTurnCount, 5);
    // live(1) + approval(1) + liveImpact(1) + refs>=3(1) + artifacts>=3(1) + turns>=5(1) = 6
    assert.equal(signals.totalOffset, 6);
  });

  it("normalizes negative counts to 0", () => {
    const signals = extractTaskComplexitySignals({
      intent: "analyze",
      referenceCount: -1,
      artifactCount: -5,
    });
    assert.equal(signals.effectiveReferenceCount, 0);
    assert.equal(signals.effectiveArtifactCount, 0);
  });

  it("normalizes missing turnCount to 1", () => {
    const signals = extractTaskComplexitySignals({ intent: "analyze" });
    assert.equal(signals.effectiveTurnCount, 1);
  });

  it("does not flag turnCount < 5 as offset", () => {
    const signals = extractTaskComplexitySignals({
      intent: "analyze",
      turnCount: 4,
    });
    assert.equal(signals.totalOffset, 0);
  });
});

// ---------------------------------------------------------------------------
// classifyTaskComplexity — single input
// ---------------------------------------------------------------------------

describe("classifyTaskComplexity (single input)", () => {
  it("classifies simple: chat", () => {
    const result = classifyTaskComplexity(SIMPLE_ANALYSIS_INPUT);
    assert.equal(result.level, "simple");
    assert.equal(result.origin, "intent-derived");
    assert.match(result.reason, /base="simple"/);
  });

  it("classifies moderate: backfill", () => {
    const result = classifyTaskComplexity(MODERATE_BACKFILL_INPUT);
    assert.equal(result.level, "moderate");
    assert.equal(result.origin, "intent-derived");
  });

  it("classifies propose_patch with approval as critical (base=complex + offset)", () => {
    const result = classifyTaskComplexity(COMPLEX_PATCH_INPUT);
    // base=complex(2) + requiresApproval(+1) = 3 = critical
    assert.equal(result.level, "critical");
    assert.equal(result.origin, "offset-adjusted");
  });

  it("classifies apply_local_change with all offsets as critical (clamped)", () => {
    const result = classifyTaskComplexity(COMPLEX_APPLY_INPUT);
    // base=complex(2) + approval(+1) + refs>=3(+1) + artifacts>=3(+1) = raw ordinal 5
    // clamped to max ordinal 3 = critical
    assert.equal(result.level, "critical");
    assert.equal(result.origin, "clamped-to-boundary");
  });

  it("classifies promote_to_live with all offsets as critical (clamped)", () => {
    const result = classifyTaskComplexity(CRITICAL_PROMOTE_INPUT);
    // base=critical(3) + liveEnv(+1) + approval(+1) + liveImpact(+1) = raw ordinal 6
    // clamped to max ordinal 3 = critical
    assert.equal(result.level, "critical");
    assert.equal(result.origin, "clamped-to-boundary");
  });

  it("classifies critical: rollback_live with high turnCount", () => {
    const result = classifyTaskComplexity(CRITICAL_ROLLBACK_INPUT);
    // base=critical(3) + approval(+1) + liveImpact(+1) + turns>=5(+1) = raw 6, clamped to 3
    assert.equal(result.level, "critical");
    assert.equal(result.origin, "clamped-to-boundary");
  });

  it("offsets simple+live to moderate", () => {
    const result = classifyTaskComplexity({
      intent: "analyze",
      targetEnvironment: "live",
    });
    assert.equal(result.level, "moderate");
    assert.equal(result.origin, "offset-adjusted");
    assert.match(result.reason, /env=\+1/);
  });

  it("clamps to Hermes mobile bounds", () => {
    const result = classifyTaskComplexity(
      { intent: "promote_to_live" },
      HERMES_MOBILE_BOUNDS,
    );
    // promote_to_live base=critical(3), no offsets, but max bound is complex(2)
    assert.equal(result.level, "complex");
    assert.equal(result.origin, "clamped-to-boundary");
    assert.match(result.reason, /clamped/);
  });

  it("clamps to readOnly bounds", () => {
    const result = classifyTaskComplexity(
      { intent: "rollback_live" },
      READONLY_BOUNDS,
    );
    assert.equal(result.level, "moderate");
    assert.equal(result.origin, "clamped-to-boundary");
  });

  it("falls back to min bound for unknown intent", () => {
    const result = classifyTaskComplexity({
      intent: "random_garbage" as any,
    });
    assert.equal(result.level, "simple");
    assert.equal(result.origin, "unclassifiable");
    assert.match(result.reason, /Unknown intent/);
  });

  it("uses default bounds when none provided", () => {
    const result = classifyTaskComplexity({ intent: "chat" });
    assert.equal(result.level, "simple");
    assert.ok(result.signals.intentRecognized);
  });
});

// ---------------------------------------------------------------------------
// classifyTaskComplexities — batch
// ---------------------------------------------------------------------------

describe("classifyTaskComplexities (batch)", () => {
  it("returns empty array for empty input", () => {
    const results = classifyTaskComplexities([]);
    assert.equal(results.length, 0);
  });

  it("classifies all preset inputs in one call", () => {
    const results = classifyTaskComplexities([
      SIMPLE_ANALYSIS_INPUT,
      MODERATE_BACKFILL_INPUT,
      COMPLEX_PATCH_INPUT,
      CRITICAL_PROMOTE_INPUT,
    ]);
    assert.equal(results.length, 4);
    assert.equal(results[0]!.level, "simple");
    assert.equal(results[1]!.level, "moderate");
    // COMPLEX_PATCH_INPUT: base=complex + approval(+1) = critical
    assert.equal(results[2]!.level, "critical");
    assert.equal(results[3]!.level, "critical");
  });
});

// ---------------------------------------------------------------------------
// aggregateTaskComplexity
// ---------------------------------------------------------------------------

describe("aggregateTaskComplexity", () => {
  it("aggregates mixed levels", () => {
    const results: TaskComplexityClassification[] = [
      { level: "simple", reason: "a", origin: "intent-derived", signals: null! },
      { level: "simple", reason: "b", origin: "intent-derived", signals: null! },
      { level: "complex", reason: "c", origin: "offset-adjusted", signals: null! },
      { level: "critical", reason: "d", origin: "intent-derived", signals: null! },
    ];
    const report = aggregateTaskComplexity(results);
    assert.equal(report.total, 4);
    assert.equal(report.byLevel.simple, 2);
    assert.equal(report.byLevel.moderate, 0);
    assert.equal(report.byLevel.complex, 1);
    assert.equal(report.byLevel.critical, 1);
  });

  it("counts unclassifiable and clamped", () => {
    const results: TaskComplexityClassification[] = [
      { level: "simple", reason: "unknown", origin: "unclassifiable", signals: null! },
      { level: "complex", reason: "clamped", origin: "clamped-to-boundary", signals: null! },
    ];
    const report = aggregateTaskComplexity(results);
    assert.equal(report.unclassifiable, 1);
    assert.equal(report.clamped, 1);
  });

  it("returns zero counts for empty input", () => {
    const report = aggregateTaskComplexity([]);
    assert.equal(report.total, 0);
    assert.equal(report.byLevel.simple, 0);
    assert.equal(report.byLevel.moderate, 0);
    assert.equal(report.byLevel.complex, 0);
    assert.equal(report.byLevel.critical, 0);
    assert.equal(report.unclassifiable, 0);
    assert.equal(report.clamped, 0);
  });
});

// ---------------------------------------------------------------------------
// Safety bounds
// ---------------------------------------------------------------------------

describe("safety bounds", () => {
  it("DEFAULT_COMPLEXITY_BOUNDS uses full range", () => {
    assert.equal(DEFAULT_COMPLEXITY_BOUNDS.min, "simple");
    assert.equal(DEFAULT_COMPLEXITY_BOUNDS.max, "critical");
  });

  it("HERMES_MOBILE_BOUNDS caps at complex", () => {
    assert.equal(HERMES_MOBILE_BOUNDS.min, "simple");
    assert.equal(HERMES_MOBILE_BOUNDS.max, "complex");
  });

  it("READONLY_BOUNDS caps at moderate", () => {
    assert.equal(READONLY_BOUNDS.min, "simple");
    assert.equal(READONLY_BOUNDS.max, "moderate");
  });
});

// ---------------------------------------------------------------------------
// Fixture validation
// ---------------------------------------------------------------------------

describe("fixture validation", () => {
  const fixtures = loadFixtures();

  it("loads at least one fixture", () => {
    assert.ok(fixtures.length >= 1, "No fixtures loaded");
  });

  for (const fixture of fixtures) {
    it(`validates fixture: ${fixture.description}`, () => {
      const bounds = fixture.bounds ?? undefined;
      const result = classifyTaskComplexity(fixture.input, bounds);

      assert.equal(
        result.level,
        fixture.expectedLevel,
        `Expected level ${fixture.expectedLevel}, got ${result.level}. Reason: ${result.reason}`,
      );

      assert.equal(
        result.origin,
        fixture.expectedOrigin,
        `Expected origin ${fixture.expectedOrigin}, got ${result.origin} for input intent=${fixture.input.intent}`,
      );

      // Verify fixture safety boundaries
      assert.equal(fixture.boundaries.sourceOnly, true, "sourceOnly must be true");
      assert.equal(fixture.boundaries.liveHostProbe, false, "liveHostProbe must be false");
      assert.equal(fixture.boundaries.plannerRouteCall, false, "plannerRouteCall must be false");
      assert.equal(fixture.boundaries.actualSubagentSpawn, false, "actualSubagentSpawn must be false");
      assert.equal(fixture.boundaries.brokerDispatch, false, "brokerDispatch must be false");
      assert.equal(fixture.boundaries.workerClaim, false, "workerClaim must be false");
      assert.equal(fixture.boundaries.executorInvocation, false, "executorInvocation must be false");
      assert.equal(fixture.boundaries.dbMutation, false, "dbMutation must be false");
      assert.equal(fixture.boundaries.deployOrRestart, false, "deployOrRestart must be false");
      assert.equal(fixture.boundaries.providerSend, false, "providerSend must be false");
      assert.equal(fixture.boundaries.terminalAckOrReplay, false, "terminalAckOrReplay must be false");
      assert.equal(fixture.boundaries.releaseOrPublish, false, "releaseOrPublish must be false");
      assert.equal(fixture.boundaries.secretMovement, false, "secretMovement must be false");
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles bare minimum input without throwing", () => {
    assert.doesNotThrow(() => {
      classifyTaskComplexity({ intent: "chat" });
    });
  });

  it("handles missing policyContext without throwing", () => {
    assert.doesNotThrow(() => {
      classifyTaskComplexity({ intent: "analyze", targetEnvironment: "live" });
    });
  });

  it("handles undefined policyContext fields gracefully", () => {
    const result = classifyTaskComplexity({
      intent: "backfill",
      policyContext: {},
    });
    assert.equal(result.level, "moderate");
    assert.equal(result.signals.requiresApproval, false);
    assert.equal(result.signals.liveImpact, false);
  });

  it("does not offset for staging environment", () => {
    const result = classifyTaskComplexity({
      intent: "verify",
      targetEnvironment: "staging",
    });
    assert.equal(result.level, "simple");
    assert.equal(result.origin, "intent-derived");
  });

  it("handles large integer values without overflow", () => {
    const result = classifyTaskComplexity({
      intent: "analyze",
      referenceCount: 9999,
      artifactCount: 9999,
      turnCount: 9999,
    });
    // base=simple(0) + refs>=3(1) + artifacts>=3(1) + turns>=5(1) = 3 = critical
    assert.equal(result.level, "critical");
  });

  it("all intents produce deterministic classification (idempotent)", () => {
    const input: TaskComplexityInput = {
      intent: "backfill",
      targetEnvironment: "live",
      policyContext: { requiresApproval: true },
      referenceCount: 2,
    };
    const r1 = classifyTaskComplexity(input);
    const r2 = classifyTaskComplexity(input);
    assert.deepEqual(r1, r2);
  });
});
