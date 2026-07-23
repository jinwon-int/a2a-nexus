import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  evaluateReviewLineageEnforcement,
  type ReviewLineageEnforcementInput,
} from "./enforcement.js";
import { runReviewLineageSimulation } from "./simulation-fixture.js";

const modeSchema = z.enum(["off", "record", "enforce"]);
const stateSchema = z.enum([
  "reviewing_initial",
  "correction_pending",
  "reviewing_resolution",
  "passed",
  "blocked_needs_operator",
  "intent_conflict",
  "canceled",
]);
const terminalReasonSchema = z
  .enum([
    "budget_wall_clock",
    "budget_correction_generations",
    "budget_reviewer_runs",
    "repeated_findings",
    "intent_drift",
    "scope_drift",
    "operator_cancel",
  ])
  .nullable();
const expectedSchema = z
  .object({
    outcome: z.enum([
      "not_enforced",
      "review_pending",
      "completion_allowed",
      "blocked_needs_operator",
      "intent_conflict",
      "canceled",
      "invalid_state",
    ]),
    completionDisposition: z.enum(["unchanged", "pending", "allow", "block"]),
    retryDisposition: z.enum(["unchanged", "not_applicable", "forbidden"]),
    terminal: z.boolean(),
    requiresOperator: z.boolean().nullable(),
    reason: z.union([
      terminalReasonSchema.unwrap(),
      z.enum([
        "mode_not_enforced",
        "lineage_active",
        "lineage_passed",
        "invalid_state",
      ]),
    ]),
  })
  .strict();
const fixtureSchema = z
  .object({
    fixtureId: z.literal("a2a-nexus.review-lineage.enforcement-decisions.v1"),
    description: z.string().min(1),
    cases: z
      .array(
        z
          .object({
            caseId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            input: z
              .object({
                mode: modeSchema,
                state: stateSchema,
                terminalReason: terminalReasonSchema,
              })
              .strict(),
            expected: expectedSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "../../../../fixtures/review-lifecycle/enforcement/decisions.json",
    import.meta.url,
  ),
);
const NON_CONVERGING_PATH = fileURLToPath(
  new URL(
    "../../../../fixtures/review-lifecycle/non-converging.json",
    import.meta.url,
  ),
);

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("Phase 4 enforcement decision fixture is strict and deterministic", () => {
  const fixture = fixtureSchema.parse(loadJson(FIXTURE_PATH));
  const caseIds = new Set<string>();

  for (const item of fixture.cases) {
    assert.equal(caseIds.has(item.caseId), false, `duplicate caseId ${item.caseId}`);
    caseIds.add(item.caseId);
    const decision = evaluateReviewLineageEnforcement(
      item.input as ReviewLineageEnforcementInput,
    );
    assert.deepEqual(
      {
        outcome: decision.outcome,
        completionDisposition: decision.completionDisposition,
        retryDisposition: decision.retryDisposition,
        terminal: decision.terminal,
        requiresOperator: decision.requiresOperator,
        reason: decision.reason,
      },
      item.expected,
      item.caseId,
    );
  }

  assert.deepEqual(
    [...caseIds].sort(),
    [
      "enforce-cancel-stays-terminal",
      "enforce-correction-budget-exhaustion-blocks",
      "enforce-inconsistent-terminal-reason-fails-closed",
      "enforce-intent-drift-conflicts",
      "enforce-pass-allows-completion",
      "enforce-repeated-finding-stops-early",
      "enforce-review-remains-pending",
      "enforce-reviewer-budget-exhaustion-blocks",
      "enforce-wall-clock-exhaustion-blocks",
      "off-keeps-current-behavior",
      "record-keeps-current-behavior",
    ],
  );
});

test("Phase 4 enforcement consumes the existing repeated-finding engine result", () => {
  const simulation = runReviewLineageSimulation(loadJson(NON_CONVERGING_PATH));
  assert.equal(simulation.record.mode, "record");
  assert.equal(simulation.record.state, "blocked_needs_operator");
  assert.equal(simulation.record.terminalReason, "repeated_findings");

  const decision = evaluateReviewLineageEnforcement({
    mode: "enforce",
    state: simulation.record.state,
    terminalReason: simulation.record.terminalReason,
  });
  assert.equal(decision.outcome, "blocked_needs_operator");
  assert.equal(decision.retryDisposition, "forbidden");
  assert.equal(decision.requiresOperator, true);
});

test("Phase 4 fixture parser rejects undeclared fields", () => {
  const fixture = loadJson(FIXTURE_PATH) as Record<string, unknown>;
  assert.throws(
    () => fixtureSchema.parse({ ...fixture, runtimeEnforceEnabled: true }),
    /unrecognized_keys/i,
  );
});
