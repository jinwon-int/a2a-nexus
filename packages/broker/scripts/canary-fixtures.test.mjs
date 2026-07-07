// #1291 R6 unit 2: repo-versioned rollout canary fixtures.
// The rollout canary payloads (empty sourceBundle / normal / sourceFiles-only /
// large 2-carrier×8-item manifest — the last one was promoted to a release
// blocker) used to live only in the operator skill; committing them under
// fixtures/canary/ makes the canary DEFINITIONS code-review subjects. Each
// fixture declares its intended gate verdict and this test reproduces it
// locally through the round-replay harness (#1302) — readiness, carrier
// projection, and the deterministic source-only bridge.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { replayRound } from "./replay-round.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANARY_DIR = join(HERE, "..", "..", "..", "fixtures", "canary");

// Closed set: adding or renaming a rollout canary is a reviewed change here,
// not a drive-by file drop.
const CANARY_FILES = [
  "empty-source-bundle.json",
  "normal-source-bundle.json",
  "source-files-only.json",
  "large-manifest-two-carriers.json",
];

function loadCanary(name) {
  return JSON.parse(fs.readFileSync(join(CANARY_DIR, name), "utf8"));
}

function stageOf(report, stage) {
  return report.stages.find((entry) => entry.stage === stage);
}

test("fixtures/canary holds exactly the reviewed rollout canary set (+README)", () => {
  const listed = fs.readdirSync(CANARY_DIR).sort();
  assert.deepEqual(listed, [...CANARY_FILES, "README.md"].sort());
});

test("every canary is synthetic, self-describing, and declares its intended verdict", () => {
  for (const name of CANARY_FILES) {
    const fixture = loadCanary(name);
    assert.ok(typeof fixture.$comment === "string" && fixture.$comment.length > 0, `${name}: $comment required`);
    assert.ok(fixture.expectedVerdict && typeof fixture.expectedVerdict === "object", `${name}: expectedVerdict required`);
    assert.ok(fixture.payload && typeof fixture.payload === "object", `${name}: payload required`);
    const text = JSON.stringify(fixture);
    assert.match(text, /synthetic/, `${name}: content must be marked synthetic`);
    assert.doesNotMatch(text, /worker-[a-z]+\d|node-\d/, `${name}: no worker/node identifiers in canary fixtures`);
  }
});

test("empty sourceBundle canary reproduces the rejection verdict", () => {
  const fixture = loadCanary("empty-source-bundle.json");
  assert.equal(fixture.expectedVerdict.readiness, "fail");
  const report = replayRound({ task: fixture.task, payload: fixture.payload });
  const readiness = stageOf(report, "readiness");
  assert.equal(readiness.status, "fail");
  assert.equal(readiness.code, fixture.expectedVerdict.readinessCode);
  assert.equal(stageOf(report, "bridge").code, "projection_zero_files");
});

test("normal sourceBundle canary passes end-to-end", () => {
  const fixture = loadCanary("normal-source-bundle.json");
  const report = replayRound({ task: fixture.task, payload: fixture.payload });
  assert.equal(stageOf(report, "readiness").status, "pass");
  assert.equal(stageOf(report, "projection").detail.stats.totalFiles, fixture.expectedVerdict.projectedFiles);
  assert.equal(stageOf(report, "bridge").detail.sourceProjection.quality, fixture.expectedVerdict.bridgeQuality);
});

test("sourceFiles-only canary projects the sourceFiles carrier (the #1271 drift class)", () => {
  const fixture = loadCanary("source-files-only.json");
  assert.equal(fixture.payload.sourceBundle, undefined, "this canary must carry files ONLY via sourceFiles[]");
  const report = replayRound({ task: fixture.task, payload: fixture.payload });
  const stats = stageOf(report, "projection").detail.stats;
  assert.equal(stats.sourceFiles, fixture.expectedVerdict.projectedFiles, "every file must ride the sourceFiles carrier");
  assert.equal(stats.totalFiles, fixture.expectedVerdict.projectedFiles);
  assert.equal(stageOf(report, "bridge").detail.sourceProjection.projectedFileCount, fixture.expectedVerdict.projectedFiles);
  assert.equal(stageOf(report, "bridge").detail.sourceProjection.quality, fixture.expectedVerdict.bridgeQuality);
});

test("large 2-carrier×8-item manifest canary projects all 16 files (release-blocker case)", () => {
  const fixture = loadCanary("large-manifest-two-carriers.json");
  const stats = { bundle: fixture.payload.sourceBundle.files.length, files: fixture.payload.sourceFiles.length };
  assert.deepEqual(stats, { bundle: 8, files: 8 }, "the canary is defined as two carriers with eight items each");
  const report = replayRound({ task: fixture.task, payload: fixture.payload });
  const projection = stageOf(report, "projection");
  assert.equal(projection.detail.stats.totalFiles, 16);
  assert.equal(projection.detail.projectedFiles, 16, "no item may be dropped in normalization");
  const bridge = stageOf(report, "bridge");
  assert.equal(bridge.detail.sourceProjection.projectedFileCount, 16);
  assert.equal(bridge.detail.sourceProjection.quality, fixture.expectedVerdict.bridgeQuality);
});
