/**
 * Drift guard for #2517: the Goal Mode design schema links a planner run to a
 * broker goal through `brokerGoal`, whose `status` must use the broker's
 * closed `GoalStatus` vocabulary (contracts/a2a/goal-mode-lifecycle.md §2.5).
 * The schema and fixture are JSON documents outside the TypeScript build, so
 * nothing else keeps them in step with `GOAL_STATUS_VALUES`.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GOAL_STATUS_VALUES } from "./core/store-schemas.js";
import type { GoalStatus } from "./core/types.js";

// Compile-time: GOAL_STATUS_VALUES lists every GoalStatus (its `satisfies`
// clause only proves the converse), so comparing against it is exhaustive.
type MissingGoalStatus = Exclude<GoalStatus, (typeof GOAL_STATUS_VALUES)[number]>;
const goalStatusValuesAreExhaustive: [MissingGoalStatus] extends [never] ? true : false = true;

const SCHEMA_PATH = join("docs", "specs", "a2a-goal-mode", "schema.json");
const FIXTURE_PATH = join("fixtures", "contract", "a2a-goal-mode.json");

/** Walk up from the test file (src/ or the compiled dist/) to the repo root. */
function resolveRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, SCHEMA_PATH))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error(`could not locate ${SCHEMA_PATH} from the test file location`);
}

const repoRoot = resolveRepoRoot();

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as Record<string, any>;
}

test("GOAL_STATUS_VALUES covers every GoalStatus", () => {
  assert.equal(goalStatusValuesAreExhaustive, true);
});

test("goal-mode schema brokerGoal.status enum equals the broker GoalStatus values (#2517)", () => {
  const schema = readJson(SCHEMA_PATH);
  const brokerGoal = schema.properties?.brokerGoal;
  assert.ok(brokerGoal, "schema.json declares properties.brokerGoal");
  assert.deepEqual(brokerGoal.properties?.status?.enum, [...GOAL_STATUS_VALUES]);
  assert.deepEqual(brokerGoal.required, ["goalId", "status"]);
  // Optional link: existing goal-mode objects without it stay valid.
  assert.equal(schema.required.includes("brokerGoal"), false);
});

test("goal-mode fixture lists the broker statuses and links its example run consistently (#2517)", () => {
  const schema = readJson(SCHEMA_PATH);
  const fixture = readJson(FIXTURE_PATH);
  assert.deepEqual(fixture.brokerGoalStatuses, [...GOAL_STATUS_VALUES]);

  const example = fixture.exampleGoalObject;
  const link = example.brokerGoal;
  assert.ok(link, "the example goal run is linked to a broker goal");
  assert.match(link.goalId, new RegExp(schema.properties.brokerGoal.properties.goalId.pattern));
  assert.ok((GOAL_STATUS_VALUES as readonly string[]).includes(link.status));
  // §2.5 consistent pair: a completed planner run goes with an achieved goal.
  assert.equal(example.state, "completed");
  assert.equal(link.status, "achieved");
  assert.deepEqual(Object.keys(link).filter((key) => !["goalId", "status", "observedAt"].includes(key)), []);
});
