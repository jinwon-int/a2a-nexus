import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const scriptPath = "scripts/worker-compatibility-audit.mjs";

function run(input, args = ["--json"]) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("worker compatibility audit marks canonical broker-poll handler as removal-safe", () => {
  const report = run([
    {
      nodeId: "dungae",
      env: {
        A2A_WORKER_PROFILE: "broker-poll-only",
        WORKER_HANDLER_ARGS_JSON: JSON.stringify(["/opt/openclaw-a2a-worker/scripts/a2a-task-handler.mjs"]),
      },
    },
    {
      nodeId: "soonwook",
      env: {
        A2A_WORKER_RUNTIME_FLAVOR: "termux-hermes",
        A2A_WORKER_HANDLER_ARGS_JSON: JSON.stringify(["/opt/openclaw-a2a-worker/scripts/a2a-task-handler.mjs"]),
      },
    },
  ]);

  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.canonical, 2);
  assert.equal(report.summary.legacyBlocked, 0);
  assert.equal(report.summary.removalSafe, true);
});

test("worker compatibility audit blocks wrapper removal when legacy profile or handler remains", () => {
  const report = run({ workers: [
    {
      nodeId: "legacy-worker",
      env: {
        A2A_WORKER_PROFILE: "openclaw-poll-only",
        WORKER_HANDLER_ARGS_JSON: JSON.stringify(["/opt/openclaw-a2a-worker/scripts/openclaw-a2a-task-handler.mjs"]),
      },
    },
  ] });

  assert.equal(report.summary.removalSafe, false);
  assert.equal(report.summary.legacyBlocked, 1);
  assert.equal(report.results[0].status, "legacy-blocked");
  assert.match(report.results[0].blockers.join("\n"), /legacy handler path/);
  assert.match(report.results[0].blockers.join("\n"), /legacy profile/);
});

test("worker compatibility audit keeps unknown profiles in needs-review instead of removal-safe", () => {
  const report = run([
    {
      nodeId: "unknown-profile",
      env: {
        A2A_WORKER_PROFILE: "custom-profile",
        WORKER_HANDLER_ARGS_JSON: JSON.stringify(["/opt/openclaw-a2a-worker/scripts/a2a-task-handler.mjs"]),
      },
    },
  ]);

  assert.equal(report.summary.removalSafe, false);
  assert.equal(report.summary.needsReview, 1);
  assert.equal(report.results[0].status, "needs-review");
});
