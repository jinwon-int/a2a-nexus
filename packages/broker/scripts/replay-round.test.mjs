// #1302 M4 round-replay tests: preserved dispatch payloads re-run through the
// deterministic orchestration paths (readiness → projection → bridge-input →
// deterministic bridge → acceptance), so projection/readiness-class incidents
// reproduce and bisect locally without live workers. The zero_files fixture is
// the regression anchor: the incident signature (message-excerpt carrier drift)
// must reproduce, and the current pipeline (payload-file reads, #1278) must pass.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { replayRound, REPLAY_STAGES } from "./replay-round.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "lib", "replay-fixtures");
const INCIDENT_FIXTURE = join(FIXTURES, "zero-files-incident.json");
const ZERO_CARRIERS_FIXTURE = join(FIXTURES, "zero-carriers.json");
const CLI = join(HERE, "replay-round.mjs");

function loadFixture(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function stageOf(report, name) {
  return report.stages.find((entry) => entry.stage === name);
}

test("zero_files incident fixture: signature reproduces, current pipeline passes (#1278 regression anchor)", () => {
  const report = replayRound(loadFixture(INCIDENT_FIXTURE));

  // Current code path is green end-to-end: readiness, projection, bridge-input,
  // the deterministic source-only bridge, and acceptance over the preserved result.
  assert.equal(report.ok, true, JSON.stringify(report.stages, null, 2));
  assert.equal(stageOf(report, "readiness").status, "pass");
  const projection = stageOf(report, "projection");
  assert.equal(projection.status, "pass");
  assert.equal(projection.detail.stats.totalFiles, 2);

  // The incident signature: a pre-#1278 bridge parsed the (intentionally
  // bounded, here truncated) message excerpt and recovered ZERO carriers while
  // the payload file carried them all — succeeded-but-empty analysis.
  const bridgeInput = stageOf(report, "bridge-input");
  assert.equal(bridgeInput.status, "pass");
  assert.equal(bridgeInput.detail.messageExcerpt.present, true);
  assert.equal(bridgeInput.detail.messageExcerpt.stats.totalFiles, 0, "message-excerpt parser must see zero carriers (the incident)");
  assert.equal(bridgeInput.detail.messageExcerpt.drift, true, "carrier drift between message excerpt and payload file is the incident signature");
  assert.equal(bridgeInput.detail.sourceCarrierStats.payloadFile.totalFiles, 2, "the payload file carries the full bundle (#1278 fix path)");

  // The real deterministic bridge (payload-file reads) projects everything.
  const bridge = stageOf(report, "bridge");
  assert.equal(bridge.status, "pass", JSON.stringify(bridge, null, 2));
  assert.equal(bridge.detail.sourceProjection.quality, "complete");
  assert.equal(bridge.detail.sourceProjection.projectedFileCount, 2);

  assert.equal(stageOf(report, "acceptance").status, "pass");
});

test("zero-carrier fixture reproduces the exact live rejection locally", () => {
  const report = replayRound(loadFixture(ZERO_CARRIERS_FIXTURE));
  assert.equal(report.ok, false);

  const readiness = stageOf(report, "readiness");
  assert.equal(readiness.status, "fail");
  assert.equal(readiness.code, "source_projection_empty");
  assert.equal(readiness.detail.details.quality, "zero_files");

  assert.equal(stageOf(report, "projection").status, "fail");
  assert.equal(stageOf(report, "projection").code, "source_projection_empty");

  const bridge = stageOf(report, "bridge");
  assert.equal(bridge.status, "fail");
  assert.equal(bridge.code, "projection_zero_files");
});

test("non-deterministic boundaries are skipped with explicit markers, never silently", () => {
  // Non-source-only payload → provider-backed bridge is out of replay scope.
  const report = replayRound({
    payload: { mode: "analysis-only", sourceBundle: { files: [{ repo: "synthetic/repo", path: "a.js", content: "x" }] } },
  });
  const bridge = stageOf(report, "bridge");
  assert.equal(bridge.status, "skipped");
  assert.match(bridge.detail.reason, /non-deterministic/);

  // No preserved result → acceptance judgment has nothing to judge.
  const acceptance = stageOf(report, "acceptance");
  assert.equal(acceptance.status, "skipped");
  assert.match(acceptance.detail.reason, /--result/);

  assert.deepEqual(report.skippedBoundaries, [
    "provider/model calls",
    "worker dispatch",
    "GitHub side effects",
    "acceptance command execution",
  ]);
});

test("acceptance stage judges preserved validations without running the command", () => {
  const bundle = loadFixture(INCIDENT_FIXTURE);
  const failing = replayRound({
    ...bundle,
    result: { summary: "synthetic", validations: [{ kind: "smoke", verdict: "fail", note: "synthetic failure" }] },
  });
  const acceptance = stageOf(failing, "acceptance");
  assert.equal(acceptance.status, "fail");
  assert.equal(acceptance.code, "acceptance_evidence_missing");
});

test("--stage limits the replay to one stage and unknown stages fail closed", () => {
  const report = replayRound({ ...loadFixture(INCIDENT_FIXTURE), stage: "projection" });
  assert.deepEqual(report.stages.map((entry) => entry.stage), ["projection"]);
  assert.throws(() => replayRound({ payload: {}, stage: "dispatch" }), /unknown stage/);
  assert.deepEqual(REPLAY_STAGES, ["readiness", "projection", "bridge-input", "bridge", "acceptance"]);
});

test("replay is read-only: fixtures untouched, temp dir removed unless kept", () => {
  const before = fs.readFileSync(INCIDENT_FIXTURE, "utf8");
  const kept = replayRound({ ...loadFixture(INCIDENT_FIXTURE), keepDir: true });
  assert.ok(kept.bridgeDir, "keepDir must surface the bridge-input dir");
  assert.ok(fs.existsSync(join(kept.bridgeDir, "payload.json")));
  fs.rmSync(kept.bridgeDir, { recursive: true, force: true });

  const cleaned = replayRound(loadFixture(INCIDENT_FIXTURE));
  assert.equal(cleaned.bridgeDir, undefined, "without keepDir the temp dir must not leak into the report");
  assert.equal(fs.readFileSync(INCIDENT_FIXTURE, "utf8"), before, "replay must never write to its input");
});

test("CLI: exit 0 on the incident fixture, exit 1 on zero carriers, --json parses", () => {
  const ok = spawnSync(process.execPath, [CLI, "--payload", INCIDENT_FIXTURE, "--json"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const report = JSON.parse(ok.stdout);
  assert.equal(report.ok, true);

  const failing = spawnSync(process.execPath, [CLI, "--payload", ZERO_CARRIERS_FIXTURE], { encoding: "utf8" });
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /source_projection_empty/);

  const usage = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(usage.status, 2);
});
