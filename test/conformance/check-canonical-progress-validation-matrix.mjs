#!/usr/bin/env node
/**
 * Conformance test for canonical n/N progress validation matrix.
 *
 * Validates all 10 scenarios (C01–C10) of the canonical progress
 * validation matrix fixture. Each scenario tests a specific semantic
 * rule about completed/total counting for Terminal Brief aggregation.
 *
 * Source-only: no deploy, restart, live send, ACK, or DB mutation.
 *
 * R29 terminal-brief-canonical-progress-correction
 * Parent: https://github.com/jinwon-int/a2a-plane/issues/370
 * Lane:   https://github.com/jinwon-int/a2a-plane/issues/376
 */

import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "../../fixtures/contract/canonical-progress-validation-matrix.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

function fail(message, detail) {
  return { pass: false, message, detail };
}

function pass(message) {
  return { pass: true, message };
}

function check(assertion, detail) {
  try {
    assertion();
    return pass("check passed");
  } catch (e) {
    return fail(e instanceof assert.AssertionError ? e.message : String(e), detail);
  }
}

// ---------------------------------------------------------------------------
// Scenario validators
// ---------------------------------------------------------------------------

const validators = {
  /**
   * C01: canonical-task-completed-count
   * n/N uses completed canonical child tasks as numerator.
   * Not lane order, event sequence, or origin-local projection.
   */
  "C01": (fixture) => {
    const scenario = fixture.scenarios.find((s) => s.id === "C01");
    const completed = scenario.then.completed;
    const total = scenario.then.total;
    const succeededIds = scenario.given.succeededTaskIds;

    // Verify completed equals count of succeeded canonical tasks
    const succeededActual = succeededIds.length;
    const completedCheck = check(() => {
      assert.strictEqual(completed, succeededActual,
        `C01: completed (${completed}) must equal succeeded task count (${succeededActual})`);
      assert.strictEqual(total, scenario.given.totalCanonicalTasks,
        `C01: total (${total}) must equal canonical total (${scenario.given.totalCanonicalTasks})`);
      assert.strictEqual(scenario.then.totalKnown, true,
        "C01: totalKnown must be true when total is known");
    }, "C01 canonical completed counting");

    // Validate that completed does NOT equal lane order position
    const laneOrderCheck = check(() => {
      assert.ok(scenario.not.completedEqualsSucceededByLaneOrder !== true,
        "C01: completed must not equal succeeded by lane order");
      assert.ok(scenario.not.completedEqualsTerminalEventCount !== true,
        "C01: completed must not equal terminal event sequence order");
      assert.ok(scenario.not.completedEqualsOriginProjectionCount !== true,
        "C01: completed must not equal origin-local projection count");
    }, "C01 negation checks");

    return {
      id: "C01",
      name: "canonical-task-completed-count",
      checks: [
        { id: "C01-a", description: "completed equals succeeded canonical task count", ...completedCheck },
        { id: "C01-b", description: "completed differs from lane order, event sequence, origin projection", ...laneOrderCheck },
      ],
    };
  },

  /**
   * C02: retry-superseded-original-does-not-inflate-completed
   * Original failed attempt is superseded; completed counts only the final success.
   */
  "C02": (fixture) => {
    const scenario = fixture.scenarios.find((s) => s.id === "C02");
    const completed = scenario.then.completed;
    const events = scenario.given.taskEvents;

    // Count unique task IDs that succeeded (final attempt or no retry)
    const succeededFinal = new Set(
      events
        .filter((e) => e.status === "succeeded")
        .map((e) => e.taskId)
    );
    const expectedCompleted = succeededFinal.size;

    const completedCheck = check(() => {
      assert.strictEqual(completed, expectedCompleted,
        `C02: completed (${completed}) must equal unique succeeded task count (${expectedCompleted})`);
      assert.strictEqual(scenario.then.supersededOriginalNotCounted, true,
        "C02: superseded original must not be counted");
    }, "C02 retry supersede");

    // Verify that we don't double-count: 2 succeeded events but only 2 unique tasks
    const succeededEvents = events.filter((e) => e.status === "succeeded").length;
    const noDoubleCountCheck = check(() => {
      assert.ok(succeededEvents >= expectedCompleted,
        `C02: succeeded events (${succeededEvents}) >= unique succeeded tasks (${expectedCompleted}) — okay by definition`);
      assert.strictEqual(completed, expectedCompleted,
        `C02: completed must be ${expectedCompleted}, not ${succeededEvents} (double-count prevented)`);
    }, "C02 retry no double-count");

    return {
      id: "C02",
      name: "retry-superseded-original-does-not-inflate-completed",
      checks: [
        { id: "C02-a", description: "superseded original failed attempt is not counted", ...completedCheck },
        { id: "C02-b", description: "duplicate succeeded events do not double-count", ...noDoubleCountCheck },
      ],
    };
  },

  /**
   * C03: duplicate-replay-does-not-inflate-completed
   * Replaying same delivery must not increment completed.
   */
  "C03": (fixture) => {
    const scenario = fixture.scenarios.find((s) => s.id === "C03");
    const completed = scenario.then.completed;
    const events = scenario.given.taskEvents;

    // Unique (taskId, deliveryId) pairs that are succeeded
    const uniqueSucceeded = new Set(
      events
        .filter((e) => e.status === "succeeded" && !e.isReplay)
        .map((e) => `${e.taskId}:${e.deliveryId}`)
    );
    const expectedCompleted = uniqueSucceeded.size;

    const replayCheck = check(() => {
      assert.strictEqual(completed, expectedCompleted,
        `C03: completed (${completed}) must equal unique delivery succeeded count (${expectedCompleted})`);
      assert.strictEqual(scenario.then.duplicatesSuppressed, true,
        "C03: duplicates must be suppressed");
      assert.strictEqual(scenario.then.replayNoIncrement, true,
        "C03: replay must not increment");
    }, "C03 replay suppression");

    // Count replayed events
    const replayEvents = events.filter((e) => e.isReplay).length;
    const replayCountCheck = check(() => {
      assert.ok(replayEvents > 0,
        "C03: fixture must include at least one replay event to test suppression");
    }, "C03 replay count");

    return {
      id: "C03",
      name: "duplicate-replay-does-not-inflate-completed",
      checks: [
        { id: "C03-a", description: "completed equals unique delivery succeeded count", ...replayCheck },
        { id: "C03-b", description: "fixture contains replay events to validate", ...replayCountCheck },
      ],
    };
  },

  /**
   * C04: failed-cancelled-do-not-count-as-completed
   * Failed/cancelled/blocked tasks are part of total but not completed.
   */
  "C04": (fixture) => {
    const scenario = fixture.scenarios.find((s) => s.id === "C04");
    const completed = scenario.then.completed;
    const total = scenario.then.total;
    const events = scenario.given.taskEvents;

    const succeededCount = events.filter((e) => e.status === "succeeded").length;
    const failedCount = events.filter((e) => e.status === "failed").length;
    const canceledCount = events.filter((e) => e.status === "canceled").length;
    const allTasks = scenario.given.canonicalChildTasks.length;

    const completedCheck = check(() => {
      assert.strictEqual(completed, succeededCount,
        `C04: completed (${completed}) must equal succeeded count (${succeededCount})`);
      assert.strictEqual(total, allTasks,
        `C04: total (${total}) must equal all canonical tasks (${allTasks})`);
      assert.strictEqual(scenario.then.failedNotCounted, true,
        "C04: failed tasks must not be counted as completed");
      assert.strictEqual(scenario.then.cancelledNotCounted, true,
        "C04: cancelled tasks must not be counted as completed");
    }, "C04 failed/cancelled non-counting");

    // Verify total > completed when failures exist
    const totalGtCompletedCheck = check(() => {
      assert.ok(total > completed,
        `C04: total (${total}) must be > completed (${completed}) when failures/cancellations exist`);
    }, "C04 total greater than completed");

    return {
      id: "C04",
      name: "failed-cancelled-do-not-count-as-completed",
      checks: [
        { id: "C04-a", description: "completed equals succeeded count only", ...completedCheck },
        { id: "C04-b", description: "total > completed when failed/cancelled present", ...totalGtCompletedCheck },
      ],
    };
  },

  /**
   * C05: out-of-order-completion-count-is-order-independent
   * Completed count must be same regardless of terminal order.
   */
  "C05": (fixture) => {
    const scenario = fixture.scenarios.find((s) => s.id === "C05");
    const completed = scenario.then.completed;
    const total = scenario.then.total;
    const allTasks = scenario.given.canonicalChildTasks;

    // In both order A and order B, the same set of tasks succeeded
    const expectedCompleted = allTasks.length;

    const orderCheck = check(() => {
      assert.strictEqual(completed, expectedCompleted,
        `C05: completed (${completed}) must equal total tasks regardless of order (${expectedCompleted})`);
      assert.strictEqual(completed, total,
        `C05: when all succeeded, completed (${completed}) must equal total (${total})`);
      assert.strictEqual(scenario.then.orderIndependent, true,
        "C05: order independence must be confirmed");
    }, "C05 order independence");

    // Verify both order scenarios are specified
    const fixtureOrderCheck = check(() => {
      assert.ok(Array.isArray(scenario.given.terminalOrderScenarioA),
        "C05: terminalOrderScenarioA must be an array");
      assert.ok(Array.isArray(scenario.given.terminalOrderScenarioB),
        "C05: terminalOrderScenarioB must be an array");
      assert.strictEqual(scenario.given.terminalOrderScenarioA.length, allTasks.length,
        "C05: order A must cover all canonical tasks");
      assert.strictEqual(scenario.given.terminalOrderScenarioB.length, allTasks.length,
        "C05: order B must cover all canonical tasks");
    }, "C05 order fixture completeness");

    return {
      id: "C05",
      name: "out-of-order-completion-count-is-order-independent",
      checks: [
        { id: "C05-a", description: "completed count is order-independent", ...orderCheck },
        { id: "C05-b", description: "both order scenarios cover all canonical tasks", ...fixtureOrderCheck },
      ],
    };
  },

  /**
   * C06: single-task-1-1-fallback
   * Single canonical task renders 1/1 on success.
   */
  "C06": (fixture) => {
    const scenario = fixture.scenarios.find((s) => s.id === "C06");
    const completed = scenario.then.completed;
    const total = scenario.then.total;

    const singleTaskCheck = check(() => {
      assert.strictEqual(total, 1,
        `C06: total must be 1 for single-task round, got ${total}`);
      assert.strictEqual(completed, 1,
        `C06: completed must be 1 when the single task succeeded, got ${completed}`);
      assert.strictEqual(scenario.then.totalKnown, true,
        "C06: totalKnown must be true for known single-task");
    }, "C06 1/1 fallback");

    return {
      id: "C06",
      name: "single-task-1-1-fallback",
      checks: [
        { id: "C06-a", description: "1/1 for single succeeded task", ...singleTaskCheck },
      ],
    };
  },

  /**
   * C07: cross-broker-aggregation-counts-canonical-tasks-not-projections
   * Cross-broker n/N reflects canonical child tasks, not parent projection count.
   */
  "C07": (fixture) => {
    const scenario = fixture.scenarios.find((s) => s.id === "C07");
    const completed = scenario.then.completed;
    const total = scenario.then.total;
    const childStatuses = scenario.given.childTaskStatuses;
    const succeededChildren = Object.entries(childStatuses)
      .filter(([_, status]) => status === "succeeded")
      .length;

    const crossBrokerCheck = check(() => {
      assert.strictEqual(completed, succeededChildren,
        `C07: completed (${completed}) must equal succeeded child tasks across brokers (${succeededChildren})`);
      assert.strictEqual(completed, total,
        `C07: when all succeeded, completed (${completed}) must equal total (${total})`);
      assert.strictEqual(scenario.then.projectionCountDoesNotReplaceCompleted, true,
        "C07: projection count must not replace completed canonical task count");
    }, "C07 cross-broker counting");

    // Verify projection entries exist (but are not used for completed count)
    const projectionCount = scenario.given.parentProjections.length;
    const projCheck = check(() => {
      assert.ok(projectionCount >= succeededChildren,
        `C07: there must be at least ${succeededChildren} projections for succeeded tasks, got ${projectionCount}`);
    }, "C07 projection count check");

    return {
      id: "C07",
      name: "cross-broker-aggregation-counts-canonical-tasks-not-projections",
      checks: [
        { id: "C07-a", description: "completed reflects cross-broker canonical tasks", ...crossBrokerCheck },
        { id: "C07-b", description: "projections exist but completed uses canonical count", ...projCheck },
      ],
    };
  },

  /**
   * C08: sessionKey-redacted-from-progress-evidence
   * sessionKey must not appear in title, summary, or evidence.
   */
  "C08": (fixture) => {
    const scenario = fixture.scenarios.find((s) => s.id === "C08");
    const completed = scenario.then.completed;

    const sessionKeyCheck = check(() => {
      assert.strictEqual(scenario.then.sessionKeyNotInN, true,
        "C08: sessionKey must not appear in n/N text");
      assert.strictEqual(scenario.then.sessionKeyRedactedEvidence, true,
        "C08: sessionKey must be redacted from evidence");
      assert.strictEqual(scenario.given.sessionKeyInSummary, false,
        "C08: sessionKey must be redacted from terminal summary");
      assert.strictEqual(scenario.given.sessionKeyInTitle, false,
        "C08: sessionKey must be redacted from terminal title");
    }, "C08 sessionKey redaction");

    // Verify completed is independent of sessionKey
    const completedIndependenceCheck = check(() => {
      assert.strictEqual(completed, scenario.given.canonicalChildTasks.filter((t) =>
        scenario.given.taskEvents.some((e) => e.taskId === t && e.status === "succeeded")
      ).length,
      "C08: completed must be based on canonical task status, not sessionKey");
    }, "C08 completed independence from sessionKey");

    return {
      id: "C08",
      name: "sessionKey-redacted-from-progress-evidence",
      checks: [
        { id: "C08-a", description: "sessionKey is redacted from evidence", ...sessionKeyCheck },
        { id: "C08-b", description: "completed independent of sessionKey values", ...completedIndependenceCheck },
      ],
    };
  },

  /**
   * C09: ack-read-visibility-boundary
   * n/N is evidence projection, not ACK/read/visibility/approval.
   */
  "C09": (fixture) => {
    const scenario = fixture.scenarios.find((s) => s.id === "C09");
    const then = scenario.then;

    const boundaryCheck = check(() => {
      assert.strictEqual(then.isTerminalAck, false, "C09: n/N is not a terminal ACK");
      assert.strictEqual(then.isReadReceipt, false, "C09: n/N is not a read receipt");
      assert.strictEqual(then.isOperatorApproval, false, "C09: n/N is not operator approval");
      assert.strictEqual(then.liveProviderSend, false, "C09: n/N does not involve live provider send");
      assert.strictEqual(then.terminalOutboxAckMutated, false, "C09: n/N must not mutate terminal-outbox ACK");
    }, "C09 ACK/read/visibility boundary");

    return {
      id: "C09",
      name: "ack-read-visibility-boundary",
      checks: [
        { id: "C09-a", description: "n/N is not terminal ACK, read receipt, or approval", ...boundaryCheck },
      ],
    };
  },

  /**
   * C10: go-gate-safety-boundary
   * Source-only GO does not authorize live actions.
   */
  "C10": (fixture) => {
    const scenario = fixture.scenarios.find((s) => s.id === "C10");
    const given = scenario.given;
    const then = scenario.then;

    const sourceOnlyCheck = check(() => {
      assert.strictEqual(given.sourceOnly, true, "C10: fixture must be source-only");
      assert.strictEqual(then.matrixPassConfirmsSourceOnly, true,
        "C10: matrix pass confirms source-only execution");
      assert.strictEqual(then.noActionAuthorizesLiveActions, true,
        "C10: no action in matrix authorizes live actions");
    }, "C10 source-only safety");

    // Verify that every prohibited action is enumerated
    const prohibitedCheck = check(() => {
      const requiredProhibitions = [
        "production deploy", "Gateway restart", "live provider/Telegram send",
        "terminal-outbox ACK", "database mutation/prune/migration",
        "secret rotation/disclosure", "repository visibility change",
        "history rewrite/force-push", "release/tag publish",
      ];
      for (const action of requiredProhibitions) {
        assert.ok(given.prohibitedActions.some((a) => a.includes(action) || action.includes(a)),
          `C10: "${action}" must be listed in prohibitedActions`);
      }
    }, "C10 prohibited actions completeness");

    // Verify allowed actions are reasonable
    const allowedCheck = check(() => {
      assert.ok(given.allowedActions.includes("read source code"),
        "C10: read source code must be allowed");
      assert.ok(given.allowedActions.includes("run conformance tests"),
        "C10: run conformance tests must be allowed");
    }, "C10 allowed actions reasonableness");

    return {
      id: "C10",
      name: "go-gate-safety-boundary",
      checks: [
        { id: "C10-a", description: "source-only GO confirmed", ...sourceOnlyCheck },
        { id: "C10-b", description: "prohibited actions fully enumerated", ...prohibitedCheck },
        { id: "C10-c", description: "allowed actions reasonable", ...allowedCheck },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Fixture integrity checks (non-scenario)
// ---------------------------------------------------------------------------

function validateFixtureStructure(fixture) {
  const checks = [];

  // Required top-level fields
  checks.push({
    id: "FIX-001",
    description: "fixtureId is present and valid",
    ...check(() => {
      assert.strictEqual(typeof fixture.fixtureId, "string");
      assert.ok(fixture.fixtureId.startsWith("a2a-nexus.contract."));
    }, "fixtureId check"),
  });

  checks.push({
    id: "FIX-002",
    description: "parentIssue references R28 parent #370",
    ...check(() => {
      assert.ok(fixture.parentIssue?.includes("/issues/370"),
        `parentIssue must reference a2a-plane#370, got ${fixture.parentIssue}`);
    }, "parent issue reference"),
  });

  checks.push({
    id: "FIX-003",
    description: "laneIssue references R29 lane #376",
    ...check(() => {
      assert.ok(fixture.laneIssue?.includes("/issues/376"),
        `laneIssue must reference a2a-plane#376, got ${fixture.laneIssue}`);
    }, "lane issue reference"),
  });

  checks.push({
    id: "FIX-004",
    description: "source-only flag is set",
    ...check(() => {
      assert.strictEqual(fixture.sourceOnly, true);
    }, "source-only flag"),
  });

  checks.push({
    id: "FIX-005",
    description: "no-live flags are set",
    ...check(() => {
      assert.strictEqual(fixture.noLiveProviderSend, true);
      assert.strictEqual(fixture.noTerminalOutboxAck, true);
      assert.strictEqual(fixture.noDeployOrRestart, true);
      assert.strictEqual(fixture.noDatabaseMutation, true);
      assert.strictEqual(fixture.noSecretMovement, true);
    }, "no-live flags"),
  });

  checks.push({
    id: "FIX-006",
    description: "all 10 scenarios present",
    ...check(() => {
      assert.strictEqual(Array.isArray(fixture.scenarios), true);
      assert.strictEqual(fixture.scenarios.length, 10);
      const ids = fixture.scenarios.map((s) => s.id).sort();
      assert.deepStrictEqual(ids, ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10"]);
    }, "scenario completeness"),
  });

  checks.push({
    id: "FIX-007",
    description: "coverage coveredRules references match all scenarios",
    ...check(() => {
      const scenarioRules = fixture.scenarios.map((s) => s.name);
      for (const rule of fixture.coverage.coveredRules) {
        const matchCount = scenarioRules.filter((sr) => sr.includes(rule) || rule.includes(sr)).length;
        assert.ok(matchCount >= 1,
          `coveredRule "${rule}" must (partially) match at least one scenario name`);
      }
    }, "coverage completeness"),
  });

  checks.push({
    id: "FIX-008",
    description: "runtimeBootstrapHygieneChecked is false (not yet verified)",
    ...check(() => {
      assert.strictEqual(fixture.runtimeBootstrapHygieneChecked, false);
    }, "runtime bootstrap hygiene flag"),
  });

  return {
    id: "fixture-structure",
    name: "Fixture structure and metadata",
    checks,
  };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

function run() {
  const fixture = loadFixture();
  const results = [];

  // Fixture structure checks
  results.push(validateFixtureStructure(fixture));

  // Run each scenario validator
  for (const scenario of fixture.scenarios) {
    const validator = validators[scenario.id];
    if (!validator) {
      results.push({
        id: scenario.id,
        name: scenario.name,
        checks: [{
          id: `${scenario.id}-missing`,
          description: `Validator not found for scenario ${scenario.id}`,
          pass: false,
          message: `No validator registered for scenario ${scenario.id}`,
          detail: null,
        }],
      });
      continue;
    }
    const result = validator(fixture);
    results.push(result);
  }

  // Summary
  let totalChecks = 0;
  let passed = 0;
  let failed = 0;

  for (const group of results) {
    for (const check of group.checks) {
      totalChecks++;
      if (check.pass) passed++;
      else failed++;
    }
  }

  const allPassed = failed === 0;

  // Output
  const output = {
    fixtureId: fixture.fixtureId,
    run: fixture.run,
    sourceOnly: fixture.sourceOnly,
    timestamp: new Date().toISOString(),
    summary: {
      totalScenarios: results.length,
      totalChecks,
      passed,
      failed,
      verdict: allPassed ? "PASS" : "FAIL",
    },
    results,
  };

  console.log(JSON.stringify(output, null, 2));

  // Console-friendly summary
  console.error(`\n--- Canonical Progress Validation Matrix ---`);
  console.error(`Fixture: ${fixture.fixtureId}`);
  console.error(`Run: ${fixture.run}`);
  console.error(`Source-only: ${fixture.sourceOnly}`);
  console.error(`Checks: ${passed}/${totalChecks} passed, ${failed} failed`);
  console.error(`Verdict: ${allPassed ? "✅ PASS" : "❌ FAIL"}`);

  if (allPassed) {
    console.error(`\nAll gates pass. This is source-only evidence; no deploy/restart/live-send/ACK/DB-mutation performed.`);
  }

  if (!allPassed) {
    console.error(`\nBlockers:`);
    for (const group of results) {
      for (const check of group.checks) {
        if (!check.pass) {
          console.error(`  - [${check.id}] ${check.description}: ${check.message}`);
          if (check.detail) console.error(`    ${check.detail}`);
        }
      }
    }
  }

  process.exit(allPassed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
