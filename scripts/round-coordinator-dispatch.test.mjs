import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildRoundManifests, runExecute, classifyChildResult } from "./round-coordinator-dispatch.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const coordinator = path.join(scriptDir, "round-coordinator-dispatch.mjs");
const dispatcher = path.join(scriptDir, "a2a-dispatch-round.mjs");

const baseTeams = [
  { teamId: "team1", homeBrokerId: "seoseo", brokerUrl: "https://seoseo.invalid", workers: ["sogyo", "nosuk"] },
  { teamId: "team2", homeBrokerId: "gwakga", brokerUrl: "https://gwakga.invalid", workers: ["dungae"] },
];

test("buildRoundManifests expands PRs × workers per team with a global parent-round total/order", () => {
  const { manifests, total, summary } = buildRoundManifests({
    roundId: "pr-review-001",
    prs: ["615", "617"],
    repo: "jinwon-int/a2a-nexus",
    teams: baseTeams,
  });

  // team1: 2 PRs × 2 workers = 4; team2: 2 PRs × 1 worker = 2; total 6.
  assert.equal(total, 6);
  assert.deepEqual(summary, [
    { teamId: "team1", homeBrokerId: "seoseo", lanes: 4 },
    { teamId: "team2", homeBrokerId: "gwakga", lanes: 2 },
  ]);
  assert.equal(manifests.length, 2);

  // Every lane carries the GLOBAL total and a unique 1..total order.
  const allLanes = manifests.flatMap((m) => m.lanes);
  assert.equal(allLanes.length, 6);
  for (const lane of allLanes) {
    assert.equal(lane.payload.parentRoundId, "pr-review-001");
    assert.equal(lane.payload.parentRoundTotal, 6);
  }
  const orders = allLanes.map((l) => l.payload.parentRoundOrder).sort((a, b) => a - b);
  assert.deepEqual(orders, [1, 2, 3, 4, 5, 6]);
});

test("buildRoundManifests routes each team to its own broker and stamps lane provenance", () => {
  const { manifests } = buildRoundManifests({ roundId: "r1", prs: ["620"], teams: baseTeams });

  const team1 = manifests.find((m) => m.teamId === "team1");
  const team2 = manifests.find((m) => m.teamId === "team2");
  assert.equal(team1.brokerUrl, "https://seoseo.invalid");
  assert.equal(team2.brokerUrl, "https://gwakga.invalid");

  const lane = team1.lanes[0];
  assert.equal(lane.id, "r1:pr620:sogyo");
  assert.equal(lane.intent, "analyze");
  assert.equal(lane.assignedWorkerId, "sogyo");
  assert.equal(lane.target.id, "sogyo");
  assert.equal(lane.payload.prUrl, "https://github.com/jinwon-int/a2a-nexus/pull/620");
  assert.equal(lane.payload.teamId, "team1");
  assert.equal(lane.payload.homeBrokerId, "seoseo");
  assert.match(lane.message, /review round r1/);
});

test("buildRoundManifests rejects incomplete input (fail-closed)", () => {
  assert.throws(() => buildRoundManifests({ prs: ["1"], teams: baseTeams }), /roundId is required/);
  assert.throws(() => buildRoundManifests({ roundId: "r", prs: [], teams: baseTeams }), /at least one PR/);
  assert.throws(() => buildRoundManifests({ roundId: "r", prs: ["1"], teams: [] }), /at least one team/);
  assert.throws(
    () => buildRoundManifests({ roundId: "r", prs: ["1"], teams: [{ teamId: "team1", homeBrokerId: "seoseo", workers: ["a"] }] }),
    /needs a brokerUrl/,
  );
});

test("CLI dry-run writes per-team manifests that the existing dispatcher accepts", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-coord-"));
  try {
    const run = spawnSync(process.execPath, [
      coordinator,
      "--round-id", "pr-review-it",
      "--prs", "615,617",
      "--workers-team1", "sogyo,nosuk",
      "--workers-team2", "dungae",
      "--repo", "jinwon-int/a2a-nexus",
      "--team1-broker-url", "https://seoseo.invalid",
      "--team2-broker-url", "https://gwakga.invalid",
      "--out-dir", outDir,
      "--dry-run",
    ], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);

    const team1File = path.join(outDir, "pr-review-it.team1.manifest.json");
    const team2File = path.join(outDir, "pr-review-it.team2.manifest.json");
    assert.ok(fs.existsSync(team1File));
    assert.ok(fs.existsSync(team2File));

    // The generated manifest must be consumable by a2a-dispatch-round.mjs.
    const dispatch = spawnSync(process.execPath, [dispatcher, "--manifest", team1File, "--dry-run", "--json"], { encoding: "utf8" });
    assert.equal(dispatch.status, 0, dispatch.stderr);
    const report = JSON.parse(dispatch.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.plannedLanes.length, 4);
    // Global parent-round total is preserved (6 across both teams), not the
    // single team's lane count.
    assert.equal(report.plannedLanes[0].payload.parentRoundTotal, 6);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

// ─── #681: --execute hardening (timeout, idempotency, structured report) ──────

const writtenFixture = [
  { teamId: "team1", file: "/tmp/r.team1.manifest.json", brokerUrl: "https://seoseo.invalid" },
  { teamId: "team2", file: "/tmp/r.team2.manifest.json", brokerUrl: "https://gwakga.invalid" },
];

test("runExecute reports dispatched with parsed task ids and lane classifications (#681)", () => {
  const spawnImpl = () => ({
    status: 0,
    stdout: JSON.stringify({ ok: true, results: [
      { id: "r:pr615:sogyo", classification: "created", taskId: "task-1" },
      { id: "r:pr615:nosuk", classification: "already-exists", taskId: "task-2" },
    ] }),
    stderr: "",
  });
  const report = runExecute([writtenFixture[0]], { dispatcherPath: "d.mjs", spawnImpl, timeoutMs: 1000 });
  assert.equal(report.ok, true);
  assert.equal(report.results[0].status, "dispatched");
  assert.deepEqual(report.results[0].taskIds, ["task-1", "task-2"]);
  // Idempotency is explicit: the already-exists lane is surfaced.
  assert.equal(report.results[0].classifications["already-exists"], 1);
  assert.equal(report.results[0].classifications["created"], 1);
});

test("runExecute classifies a per-child timeout as timeout and fails closed (#681)", () => {
  const spawnImpl = () => ({ status: null, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) });
  const report = runExecute([writtenFixture[0]], { dispatcherPath: "d.mjs", spawnImpl, timeoutMs: 5 });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, "timeout");
});

test("runExecute classifies a non-zero child exit as failed with bounded stderr (#681)", () => {
  const spawnImpl = () => ({ status: 1, stdout: "{\"ok\":false,\"results\":[]}", stderr: "boom: unauthorized" });
  const report = runExecute([writtenFixture[0]], { dispatcherPath: "d.mjs", spawnImpl, timeoutMs: 1000 });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, "failed");
  assert.equal(report.results[0].exitCode, 1);
  assert.match(report.results[0].error, /boom/);
});

test("runExecute aggregates a multi-team summary and fails if any team fails (#681)", () => {
  const byFile = {
    "/tmp/r.team1.manifest.json": { status: 0, stdout: JSON.stringify({ results: [{ taskId: "a", classification: "created" }] }), stderr: "" },
    "/tmp/r.team2.manifest.json": { status: 1, stdout: "{}", stderr: "nope" },
  };
  const spawnImpl = (_node, args) => byFile[args[args.indexOf("--manifest") + 1]];
  const report = runExecute(writtenFixture, { dispatcherPath: "d.mjs", spawnImpl, timeoutMs: 1000 });
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].status, "dispatched");
  assert.equal(report.results[1].status, "failed");
  assert.equal(report.ok, false);
});

test("classifyChildResult tolerates non-JSON child stdout", () => {
  const r = classifyChildResult(writtenFixture[0], { status: 0, stdout: "not json", stderr: "" });
  assert.equal(r.status, "dispatched");
  assert.deepEqual(r.taskIds, []);
});
