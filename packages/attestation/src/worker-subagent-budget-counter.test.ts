import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildA2AWorkerSubagentBudgetCounter,
  extractA2AWorkerSubagentBudgetCounterInput,
  renderA2AWorkerSubagentBudgetCounterMarkdown,
} from "./worker-subagent-budget-counter.js";

const NOW = "2026-05-19T01:55:00.000Z";

test("within-budget counter derives remaining and adds no constraint", () => {
  const fixture = JSON.parse(readFileSync("fixtures/worker-subagent-orchestration/budget-counter-within.json", "utf8"));
  const packet = buildA2AWorkerSubagentBudgetCounter({ ...fixture, now: NOW });

  assert.equal(packet.kind, "a2a-broker.worker-subagent-budget-counter.packet");
  assert.equal(packet.generatedAt, NOW);
  assert.equal(packet.sourceOnly, true);
  assert.equal(packet.state, "within-budget");
  assert.equal(packet.readiness.counterReady, true);
  assert.equal(packet.counter.budgetExhausted, false);
  assert.equal(packet.counter.spawnBudgetCeiling, null);
  assert.equal(packet.counter.taskRemaining, 6000);
  assert.equal(packet.counter.brokerRemaining, 40000);
  assert.deepEqual(packet.counter.reducedReasons, []);
  assert.equal(packet.usage.currencyRecorded, false);
  assert.equal(packet.usage.normalizedUnits, "token-units");
  assert.equal(packet.source.enforcesBudget, false);
  assert.equal(packet.boundaries.runtimeBehaviorChanged, false);
  assert.equal(packet.boundaries.actualSubagentSpawn, false);
  assert.equal(packet.boundaries.dbMutation, false);
});

test("task ceiling reached exhausts budget and caps spawns to 0 (shrink-only)", () => {
  const fixture = JSON.parse(readFileSync("fixtures/worker-subagent-orchestration/budget-counter-exhausted.json", "utf8"));
  const packet = buildA2AWorkerSubagentBudgetCounter({ ...fixture, now: NOW });

  assert.equal(packet.state, "budget-exhausted");
  assert.equal(packet.counter.taskCeilingReached, true);
  assert.equal(packet.counter.budgetExhausted, true);
  assert.equal(packet.counter.spawnBudgetCeiling, 0);
  assert.deepEqual(packet.counter.reducedReasons, ["task_token_ceiling_reached"]);
  assert.equal(packet.counter.taskRemaining, 0);
});

test("broker aggregate ceiling reached exhausts budget independently", () => {
  const packet = buildA2AWorkerSubagentBudgetCounter({
    now: NOW,
    workerId: "workergamma",
    usage: {
      taskId: "task-x",
      taskTokensSpent: 1000,
      taskTokenCeiling: 20000,
      brokerTokensSpent: 500000,
      brokerTokenCeiling: 500000,
    },
  });

  assert.equal(packet.state, "budget-exhausted");
  assert.equal(packet.counter.taskCeilingReached, false);
  assert.equal(packet.counter.brokerCeilingReached, true);
  assert.equal(packet.counter.spawnBudgetCeiling, 0);
  assert.deepEqual(packet.counter.reducedReasons, ["broker_token_ceiling_reached"]);
});

test("insufficient input yields no ceiling and does not fabricate a budget", () => {
  const packet = buildA2AWorkerSubagentBudgetCounter({
    now: NOW,
    workerId: "worker-partial",
    usage: { taskTokensSpent: 100 },
  });

  assert.equal(packet.state, "insufficient-input");
  assert.equal(packet.readiness.counterReady, false);
  assert.equal(packet.counter.budgetExhausted, false);
  assert.equal(packet.counter.spawnBudgetCeiling, null);
  assert.equal(packet.counter.taskRemaining, undefined);
  assert.equal(packet.readiness.missing.length, 1);
});

test("extractor accepts envelopes and snake_case usage fields", () => {
  const input = extractA2AWorkerSubagentBudgetCounterInput({
    workerSubagentBudgetCounter: {
      now: NOW,
      worker_id: "worker-snake",
      usage: {
        task_id: "task-snake",
        task_tokens_spent: 12000,
        task_token_ceiling: 20000,
        broker_tokens_spent: 100000,
        broker_token_ceiling: 500000,
      },
      source: { collector: "worker-runtime", observed_at: NOW },
    },
  });
  const packet = buildA2AWorkerSubagentBudgetCounter(input);

  assert.equal(packet.workerId, "worker-snake");
  assert.equal(packet.taskId, "task-snake");
  assert.equal(packet.usage.taskTokensSpent, 12000);
  assert.equal(packet.counter.taskRemaining, 8000);
  assert.equal(packet.source.collector, "worker-runtime");
  assert.equal(packet.state, "within-budget");
});

test("markdown states source-only no-runtime-enforcement boundary", () => {
  const packet = buildA2AWorkerSubagentBudgetCounter({
    now: NOW,
    workerId: "worker-a",
    usage: { taskTokensSpent: 10, taskTokenCeiling: 100 },
  });
  const markdown = renderA2AWorkerSubagentBudgetCounterMarkdown(packet);

  assert.equal(markdown.includes("source-only supplied counter"), true);
  assert.equal(markdown.includes("no runtime enforcement"), true);
  assert.equal(markdown.includes("no currency recorded"), true);
});
