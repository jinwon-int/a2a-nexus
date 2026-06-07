import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildComplexityExecutionPlanPreflightSeal,
  extractExecutionPlanDraftForPreflightSeal,
  renderComplexityExecutionPlanPreflightSealMarkdown,
  type ComplexityExecutionPlanPreflightSealPacket,
} from "./complexity-execution-plan-preflight-seal.js";
import type { ComplexityExecutionPlanDraftPacket } from "./complexity-execution-plan-draft.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(__dirname, "../../fixtures/complexity-execution-plan-preflight-seal");

const NOW = "2026-06-01T12:00:00.000Z";

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

function assertNoLiveBoundaries(packet: ComplexityExecutionPlanPreflightSealPacket): void {
  for (const [key, value] of Object.entries(packet.boundaries)) {
    assert.equal(value, false, `boundary ${key} must remain false`);
  }
  for (const [key, value] of Object.entries(packet.semantics)) {
    if (typeof value === "boolean" && key.startsWith("performs")) {
      assert.equal(value, false, `semantic ${key} must remain false`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture-based tests
// ---------------------------------------------------------------------------

test("complexity execution plan preflight seal loads every fixture and produces a source-only packet", () => {
  const files = readdirSync(FIXTURE_DIR).filter(
    (name) => name.endsWith(".json") && !name.endsWith(".plan.json"),
  );
  assert.ok(files.length >= 4, "expected preflight seal fixture coverage");

  for (const file of files) {
    const input = loadFixture(file);
    const plan = extractExecutionPlanDraftForPreflightSeal(input);
    const packet = buildComplexityExecutionPlanPreflightSeal(plan, { now: NOW });

    assert.equal(
      packet.kind,
      "a2a-broker.complexity-execution-plan-preflight-seal.packet",
    );
    assert.equal(
      packet.version,
      1,
    );
    assert.match(
      packet.idempotencyKey,
      /^complexity-execution-plan-preflight-seal:[a-f0-9]{24}$/,
    );
    assert.equal(packet.sourcePlanIdempotencyKey, plan.idempotencyKey);
    assert.equal(packet.semantics.sealDoesNotGrantApproval, true);
    assert.equal(packet.semantics.sealDoesNotDispatchExecution, true);
    assert.equal(packet.semantics.suppliedPlanOnly, true);
    assert.ok(packet.checks.length >= 5);
    assertNoLiveBoundaries(packet);
  }
});

test("simple autonomous plan produces ready preflight seal", () => {
  const input = loadFixture("simple-autonomous-preflight-input.json");
  const plan = extractExecutionPlanDraftForPreflightSeal(input);
  const packet = buildComplexityExecutionPlanPreflightSeal(plan, { now: NOW });

  assert.equal(packet.state, "preflight_seal_ready");
  assert.equal(packet.sealReady, true);
  assert.equal(packet.planDecision, "plan_approval_not_needed");
  assert.equal(packet.executionMode, "autonomous");
  assert.equal(packet.envelopeCategory, "approval_not_required");

  // All checks should pass or warn, no fails
  assert.equal(
    packet.checks.some((c) => c.status === "fail"),
    false,
    "autonomous plan should have no failing checks",
  );

  // Lineage is valid
  assert.equal(packet.verification.lineage.valid, true);
  assert.equal(packet.verification.lineage.sourceEnvelopeIdempotencyKeyPresent, true);
  assert.equal(packet.verification.lineage.sourceRecommendationIdempotencyKeyPresent, true);
  assert.equal(packet.verification.lineage.envelopeCategoryValid, true);

  // Boundaries all false
  assert.equal(packet.verification.boundaries.allFalse, true);

  // Worker eligibility
  assert.equal(packet.workerEligibility.rolesRequested.length, 0);
  assert.equal(packet.workerEligibility.subagentStepsPlanned, 0);
  assert.equal(packet.workerEligibility.approvalGatePresent, false);

  // Rollback: no steps executed
  assert.equal(packet.rollbackStatus.rollbackRequired, false);
  assert.equal(packet.rollbackStatus.stepsExecuted, 0);

  // Blockers empty
  assert.equal(packet.blockers.length, 0);
});

test("operator approval plan produces ready preflight seal with gate detected", () => {
  const input = loadFixture("moderate-sequential-preflight-input.json");
  const plan = extractExecutionPlanDraftForPreflightSeal(input);
  const packet = buildComplexityExecutionPlanPreflightSeal(plan, { now: NOW });

  assert.equal(packet.state, "preflight_seal_ready");
  assert.equal(packet.planDecision, "plan_ready");
  assert.equal(packet.executionMode, "operator_approval_gated");
  assert.equal(packet.envelopeCategory, "operator_approval_required");

  // Worker eligibility detects gate
  assert.equal(packet.workerEligibility.approvalGatePresent, true);
  assert.equal(packet.workerEligibility.approvalStepsPlanned, 1);
  assert.equal(packet.workerEligibility.sequentialStepsPlanned, true);
  assert.ok(packet.workerEligibility.rolesRequested.length >= 1);

  // Lineage and boundaries
  assert.equal(packet.verification.lineage.valid, true);
  assert.equal(packet.verification.boundaries.allFalse, true);

  // Next actions mention routing to approval channel
  const nextText = packet.nextActions.join(" ");
  assert.ok(nextText.includes("operator review"));
});

test("complex parallel plan produces ready preflight seal with parallel detection", () => {
  const input = loadFixture("complex-parallel-preflight-input.json");
  const plan = extractExecutionPlanDraftForPreflightSeal(input);
  const packet = buildComplexityExecutionPlanPreflightSeal(plan, { now: NOW });

  assert.equal(packet.state, "preflight_seal_ready");
  assert.equal(packet.executionMode, "operator_approval_gated");
  assert.equal(packet.workerEligibility.approvalGatePresent, true);
  assert.equal(packet.workerEligibility.parallelStepsPlanned, true);
  assert.ok(packet.workerEligibility.rolesRequested.length >= 2);

  // No failing checks
  assert.equal(packet.checks.some((c) => c.status === "fail"), false);
  assert.equal(packet.verification.boundaries.allFalse, true);
  assert.equal(packet.blockers.length, 0);
});

// ---------------------------------------------------------------------------
// Fail-closed tests
// ---------------------------------------------------------------------------

test("preflight seal fails closed on safety-blocked plan", () => {
  const input = loadFixture("critical-blocked-preflight-input.json");
  const plan = extractExecutionPlanDraftForPreflightSeal(input);
  const packet = buildComplexityExecutionPlanPreflightSeal(plan, { now: NOW });

  assert.equal(packet.state, "plan_safety_blocked");
  assert.equal(packet.sealReady, false);
  assert.equal(packet.planDecision, "plan_safety_blocked");

  // Should have blocker about safety block
  assert.ok(packet.blockers.length >= 1);
  assert.ok(
    packet.blockers.some((b) => b.toLowerCase().includes("safety")),
    "blockers should mention safety block",
  );

  // Next actions direct to resolution
  const nextText = packet.nextActions.join(" ");
  assert.ok(nextText.includes("safety") || nextText.includes("resolve"));
});

test("preflight seal fails closed on boundary violation", () => {
  // Create a corrupted plan with a boundary violation
  const input = loadFixture("simple-autonomous-preflight-input.json");
  const cleanPlan = extractExecutionPlanDraftForPreflightSeal(input);
  const corruptedPlan: ComplexityExecutionPlanDraftPacket = {
    ...cleanPlan,
    boundaries: {
      ...cleanPlan.boundaries,
      approvalGranted: true as false, // override the type for testing
    },
  };

  const packet = buildComplexityExecutionPlanPreflightSeal(corruptedPlan, { now: NOW });

  assert.equal(packet.state, "boundary_violation");
  assert.equal(packet.sealReady, false);
  assert.ok(packet.blockers.length >= 1);
  assert.ok(
    packet.blockers.some((b) => b.includes("approvalGranted")),
    "blockers should mention approvalGranted violation",
  );
  assert.equal(packet.verification.boundaries.allFalse, false);
  assert.ok(
    packet.verification.boundaries.violatedBoundaries.includes("approval"),
  );
});

test("preflight seal fails closed on semantic violation", () => {
  const input = loadFixture("simple-autonomous-preflight-input.json");
  const cleanPlan = extractExecutionPlanDraftForPreflightSeal(input);
  const corruptedPlan: ComplexityExecutionPlanDraftPacket = {
    ...cleanPlan,
    semantics: {
      ...cleanPlan.semantics,
      approvalNotGranted: false as true, // override the type for testing
    },
  };

  const packet = buildComplexityExecutionPlanPreflightSeal(corruptedPlan, { now: NOW });

  assert.equal(packet.state, "semantic_violation");
  assert.equal(packet.sealReady, false);
  assert.ok(packet.blockers.length >= 1);
  assert.ok(
    packet.blockers.some((b) => b.includes("approvalNotGranted")),
    "blockers should mention approvalNotGranted violation",
  );
});

test("preflight seal fails closed on lineage invalidity", () => {
  const input = loadFixture("simple-autonomous-preflight-input.json");
  const cleanPlan = extractExecutionPlanDraftForPreflightSeal(input);
  const corruptedPlan: ComplexityExecutionPlanDraftPacket = {
    ...cleanPlan,
    sourceEnvelopeIdempotencyKey: "",
  };

  const packet = buildComplexityExecutionPlanPreflightSeal(corruptedPlan, { now: NOW });

  // When only lineage fails, state should be lineage_invalid
  assert.equal(packet.state, "lineage_invalid");
  assert.equal(packet.sealReady, false);
  assert.ok(packet.verification.lineage.sourceEnvelopeIdempotencyKeyPresent === false);
  assert.equal(packet.verification.lineage.valid, false);
});

test("preflight seal fails closed when decision is not recognized", () => {
  const input = loadFixture("simple-autonomous-preflight-input.json");
  const cleanPlan = extractExecutionPlanDraftForPreflightSeal(input);
  const corruptedPlan = {
    ...cleanPlan,
    decision: "unknown_decision",
  } as unknown as ComplexityExecutionPlanDraftPacket;

  const packet = buildComplexityExecutionPlanPreflightSeal(corruptedPlan, { now: NOW });

  // Unknown decision should result in a warn check but still pass lineage/boundary checks
  assert.equal(packet.planDecision, "unknown_decision");
  assert.equal(packet.state, "preflight_seal_ready", "unknown decision alone is a warn, not a fail");
  const decisionCheck = packet.checks.find((c) => c.code === "plan_decision");
  assert.ok(decisionCheck);
  assert.equal(decisionCheck?.status, "warn");
});

// ---------------------------------------------------------------------------
// Extraction tests
// ---------------------------------------------------------------------------

test("extractExecutionPlanDraftForPreflightSeal extracts from wrapped and direct inputs", () => {
  const input = loadFixture("simple-autonomous-preflight-input.json");

  // Direct
  const plan1 = extractExecutionPlanDraftForPreflightSeal(input);
  assert.equal(plan1.kind, "a2a-broker.complexity-execution-plan-draft.packet");

  // Wrapped
  const plan2 = extractExecutionPlanDraftForPreflightSeal({
    executionPlanDraft: input,
  });
  assert.equal(plan2.idempotencyKey, plan1.idempotencyKey);

  // Rejects non-plan input
  assert.throws(
    () => extractExecutionPlanDraftForPreflightSeal({ foo: "bar" }),
    /ComplexityExecutionPlanDraftPacket/,
  );
});

// ---------------------------------------------------------------------------
// Markdown rendering tests
// ---------------------------------------------------------------------------

test("renderComplexityExecutionPlanPreflightSealMarkdown renders no-live boundaries", () => {
  const input = loadFixture("moderate-sequential-preflight-input.json");
  const plan = extractExecutionPlanDraftForPreflightSeal(input);
  const packet = buildComplexityExecutionPlanPreflightSeal(plan, { now: NOW });
  const markdown = renderComplexityExecutionPlanPreflightSealMarkdown(packet);

  assert.match(markdown, /Preflight seal/i);
  assert.match(markdown, /preflight_seal_ready/);
  assert.match(markdown, /no-live enforcement/);
  assert.match(markdown, /does not grant approval/i);
  assert.match(markdown, /source-only/i);
  assert.ok(!markdown.includes("UNDEFINED"));
});

test("renderComplexityExecutionPlanPreflightSealMarkdown handles blocked state", () => {
  const input = loadFixture("critical-blocked-preflight-input.json");
  const plan = extractExecutionPlanDraftForPreflightSeal(input);
  const packet = buildComplexityExecutionPlanPreflightSeal(plan, { now: NOW });
  const markdown = renderComplexityExecutionPlanPreflightSealMarkdown(packet);

  assert.match(markdown, /SAFETY BLOCKED/i);
  assert.match(markdown, /Blockers/i);
  assert.match(markdown, /plan_safety_blocked/);
});

// ---------------------------------------------------------------------------
// Idempotency tests
// ---------------------------------------------------------------------------

test("preflight seal idempotencyKey is deterministic for identical inputs", () => {
  const input = loadFixture("simple-autonomous-preflight-input.json");
  const plan = extractExecutionPlanDraftForPreflightSeal(input);

  const packet1 = buildComplexityExecutionPlanPreflightSeal(plan, { now: NOW });
  const packet2 = buildComplexityExecutionPlanPreflightSeal(plan, { now: NOW });
  const packet3 = buildComplexityExecutionPlanPreflightSeal(plan, { now: "2026-06-02T12:00:00.000Z" });

  assert.equal(packet1.idempotencyKey, packet2.idempotencyKey);
  // Different timestamps produce different generatedAt but same idempotencyKey
  assert.equal(packet1.idempotencyKey, packet3.idempotencyKey);
  assert.equal(packet1.sourcePlanIdempotencyKey, packet3.sourcePlanIdempotencyKey);
});
