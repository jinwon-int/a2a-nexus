import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const bridgePath = new URL("./source-only-local-analysis-bridge.mjs", import.meta.url).pathname;
const workerthetaBridgePath = new URL("./workertheta-source-analysis-bridge.mjs", import.meta.url).pathname;

function runBridge(script = bridgePath, payloadOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "source-only-local-bridge-"));
  const taskFile = join(dir, "task.json");
  const payloadFile = join(dir, "payload.json");
  const payload = {
    mode: "analysis-only",
    sourceOnly: true,
    noLive: true,
    runId: "round-1147",
    parentRoundId: "round-1147",
    healthCheckKind: "a2a",
    sourceBundle: {
      files: [
        { repo: "ops-live-check", path: "health-check-request.md", content: "runId: round-1147\nliveActionsAllowed: false\nproviderCanaryAllowed: false" },
        { repo: "ops-live-check", path: "capacity-snapshot.json", content: "{\"onlineWorkers\":[{\"nodeId\":\"workertheta\"}]}" },
      ],
    },
    sourceProjectionPolicy: {
      requiredPaths: ["health-check-request.md", "capacity-snapshot.json"],
      minProjectedBytesPerRequiredFile: 10,
    },
    ...payloadOverrides,
  };
  writeFileSync(taskFile, JSON.stringify({ id: "task-1147", intent: "analyze", assignedWorkerId: "workertheta", message: "no-live health" }), "utf8");
  writeFileSync(payloadFile, JSON.stringify(payload), "utf8");
  try {
    const child = spawnSync(process.execPath, [script, "agent", "--json"], {
      env: { ...process.env, A2A_ANALYSIS_TASK_FILE: taskFile, A2A_ANALYSIS_PAYLOAD_FILE: payloadFile },
      encoding: "utf8",
    });
    return { child, envelope: child.stdout ? JSON.parse(child.stdout) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function analysisFromEnvelope(envelope) {
  const text = envelope?.payloads?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

test("source-only local bridge returns OpenClaw envelope with no-live evidence (#1147)", () => {
  const { child, envelope } = runBridge();
  assert.equal(child.status, 0, child.stderr);
  const analysis = analysisFromEnvelope(envelope);
  assert.equal(analysis.status, "done");
  assert.equal(analysis.bridgeAdapter, "source_only_local");
  assert.match(analysis.summary, /round-1147/);
  assert.ok(analysis.findings.some((finding) => finding.includes("health-check-request.md")));
  assert.ok(analysis.findings.some((finding) => finding.includes("no-live")));
  assert.deepEqual(analysis.evidenceRefs, ["ops-live-check:health-check-request.md", "ops-live-check:capacity-snapshot.json"]);
  assert.equal(analysis.sourceProjection.quality, "complete");
});

test("workertheta bridge alias uses the source-only local bridge (#1147)", () => {
  const { child, envelope } = runBridge(workerthetaBridgePath);
  assert.equal(child.status, 0, child.stderr);
  const analysis = analysisFromEnvelope(envelope);
  assert.equal(analysis.status, "done");
  assert.equal(analysis.bridgeAdapter, "source_only_local");
  assert.ok(analysis.recommendations.some((item) => item.includes("workertheta") || item.includes("source-only")));
});

test("source-only local bridge blocks when required source is missing (#1147)", () => {
  const { child, envelope } = runBridge(bridgePath, {
    sourceProjectionPolicy: { requiredPaths: ["missing-required.md"] },
  });
  assert.equal(child.status, 0, child.stderr);
  const analysis = analysisFromEnvelope(envelope);
  assert.equal(analysis.status, "blocked");
  assert.equal(analysis.sourceProjection.quality, "insufficient");
  assert.deepEqual(analysis.sourceProjection.requiredFilesMissing, ["missing-required.md"]);
});
