// #1597 (routed from #1725 finding 2): a worker must not advertise
// `canAnalyze=true` before the selected analysis handler artifact is verified
// to exist and be readable/executable. The 2026-08-03 A2AD audit observed two
// workers registered online+canAnalyze whose declared handler path was absent
// — tasks were created and claimed, then died in seconds with
// MODULE_NOT_FOUND. These tests pin the registration-time probe, the
// capability gate, the wiring-derived metadata, and the broker's
// substantiveAnalysisReady projection.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkerConfigFromEnv, probeAnalysisArtifactReadiness } from "./worker.js";
import { isWorkerSubstantiveAnalysisReady } from "./core/broker-worker-status.js";
import { buildWorkerCapacitySummary } from "./core/broker-worker-capacity.js";
import type { WorkerRecord } from "./core/types.js";

const BASE_ENV = {
  BROKER_URL: "http://127.0.0.1:1",
  WORKER_ID: "worker-a",
  WORKER_ROLE: "analyst",
  WORKER_HANDLER_BUILTIN: "noop",
  WORKER_CAN_ANALYZE: "true",
};

function configFrom(env: Record<string, string>) {
  return createWorkerConfigFromEnv({ ...BASE_ENV, ...env });
}

function workerRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    nodeId: "worker-a",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: [],
      environments: ["research"],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

test("missing handler script artifact flips canAnalyze and records a structured reason (#1597)", () => {
  const config = configFrom({
    A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
    A2A_OPENCLAW_ANALYSIS_BIN: "handlers/a2a-task-handler.mjs",
    A2A_HANDLER_CWD: "/definitely/not/a/real/worker/root",
  });

  assert.equal(config.worker.capabilities.canAnalyze, false, "must not advertise canAnalyze on a missing artifact");
  const metadata = config.worker.metadata ?? {};
  assert.equal(metadata.analysisReady, "false");
  assert.equal(metadata.analysisReadyReason, "handler_artifact_missing");
  assert.equal(metadata.analysisDeclaredCanAnalyze, "true");
  assert.equal(metadata.analysisAdapterClass, "openclaw");
  assert.match(metadata.analysisHandlerPath ?? "", /a2a-task-handler\.mjs$/);
});

test("present handler script artifact keeps canAnalyze and records wiring-derived metadata (#1597)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-worker-artifact-"));
  try {
    const handlerPath = join(dir, "a2a-task-handler.mjs");
    writeFileSync(handlerPath, "// artifact present\n", "utf8");
    const config = configFrom({
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: handlerPath,
    });

    assert.equal(config.worker.capabilities.canAnalyze, true);
    const metadata = config.worker.metadata ?? {};
    assert.equal(metadata.analysisReady, "true");
    assert.equal(metadata.analysisHandlerPath, handlerPath);
    assert.equal(metadata.analysisReadyReason, undefined);
    assert.equal(metadata.analysisDeclaredCanAnalyze, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit adapter env wins over the command heuristic and is not static self-report (#1597)", () => {
  const probe = probeAnalysisArtifactReadiness(
    {
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: "openclaw",
      A2A_ANALYSIS_BRIDGE_ADAPTER: "claude-code",
      PATH: process.env.PATH,
    },
    true,
  );
  assert.equal(probe.adapterClass, "claude_code");
});

test("bare bridge command is resolved against PATH; an absent one fails closed (#1597)", () => {
  const present = probeAnalysisArtifactReadiness(
    { A2A_OPENCLAW_ANALYSIS_ENABLED: "1", A2A_OPENCLAW_ANALYSIS_BIN: "node", PATH: process.env.PATH },
    true,
  );
  assert.equal(present.ready, true);

  const missing = probeAnalysisArtifactReadiness(
    {
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: "a2a-definitely-not-a-real-bridge-bin",
      PATH: process.env.PATH,
    },
    true,
  );
  assert.equal(missing.ready, false);
  assert.equal(missing.reason, "handler_artifact_missing");

  const config = configFrom({
    A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
    A2A_OPENCLAW_ANALYSIS_BIN: "a2a-definitely-not-a-real-bridge-bin",
  });
  assert.equal(config.worker.capabilities.canAnalyze, false);
  assert.equal(config.worker.metadata?.analysisReadyReason, "handler_artifact_missing");
});

test("builtin analysis (bridge not enabled) needs no external artifact and publishes no probe metadata (#1597)", () => {
  const config = configFrom({});
  assert.equal(config.worker.capabilities.canAnalyze, true);
  assert.equal(config.worker.metadata?.analysisReady, undefined);
});

test("a worker that never declares canAnalyze is not probed (#1597)", () => {
  const config = createWorkerConfigFromEnv({
    ...BASE_ENV,
    WORKER_CAN_ANALYZE: "false",
  });
  assert.equal(config.worker.capabilities.canAnalyze, false);
  assert.equal(config.worker.metadata?.analysisReady, undefined);
});

test("existing metadata keys survive the probe merge (#1597)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-worker-artifact-merge-"));
  try {
    const handlerPath = join(dir, "bridge.mjs");
    writeFileSync(handlerPath, "// ok\n", "utf8");
    const config = configFrom({
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: handlerPath,
      WORKER_METADATA_JSON: JSON.stringify({ teamId: "team2" }),
    });
    assert.equal(config.worker.metadata?.teamId, "team2");
    assert.equal(config.worker.metadata?.analysisReady, "true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker projection: analysisReady=false darkens an online worker; absent metadata keeps legacy readiness (#1597)", () => {
  const drifted = workerRecord({ metadata: { analysisReady: "false", analysisReadyReason: "handler_artifact_missing" } });
  const legacy = workerRecord({ nodeId: "worker-legacy", metadata: undefined });
  const healthy = workerRecord({ nodeId: "worker-healthy", metadata: { analysisReady: "true" } });

  assert.equal(isWorkerSubstantiveAnalysisReady(drifted), false, "online + canAnalyze but drifted artifact is NOT substantively ready");
  assert.equal(isWorkerSubstantiveAnalysisReady(legacy), true, "unprobed legacy worker keeps pre-existing readiness");
  assert.equal(isWorkerSubstantiveAnalysisReady(healthy), true);
  assert.equal(
    isWorkerSubstantiveAnalysisReady(workerRecord({ capabilities: { ...workerRecord().capabilities, canAnalyze: false } })),
    false,
    "canAnalyze=false is never substantively ready",
  );

  const summary = buildWorkerCapacitySummary(
    { workers: [drifted, legacy, healthy], tasks: [], identityWarnings: {} },
    { nowMs: Date.now() },
  );
  assert.equal(summary.totals.online, 3);
  assert.equal(summary.totals.substantiveAnalysisReadyOnline, 2, "capacity distinguishes online from substantively ready");
  const driftedItem = summary.items.find((item) => item.nodeId === "worker-a");
  assert.equal(driftedItem?.substantiveAnalysisReady, false);
});

// ---------------------------------------------------------------------------
// Probe/handler fallback parity. The probe mirrors the execution handler's
// bridge resolution rather than sharing it, so the two can silently disagree.
// #1788 moved the handler's fallback to the in-repo piri bridge ("not a binary
// nobody has") while the probe kept defaulting to the literal "openclaw" — so
// a worker with the bridge enabled and no explicit *_ANALYSIS_BIN failed a
// PATH lookup for a binary that by definition nobody has, was marked
// handler_artifact_missing, and had canAnalyze flipped to false, even though
// the handler it was about to run would have resolved the piri bridge fine.
// A healthy worker went dark. These tests pin the two defaults together.
// ---------------------------------------------------------------------------

test("probe fallback bridge is byte-identical to the execution handler's default (#1597/#1788)", async () => {
  // Computed specifier: the handler is a plain .mjs script outside the TS
  // program, so a literal import would pull scripts/ into the compilation.
  const handlerUrl = new URL("../scripts/a2a-task-handler.mjs", import.meta.url).href;
  const { DEFAULT_ANALYSIS_BRIDGE } = (await import(handlerUrl)) as { DEFAULT_ANALYSIS_BRIDGE: string };
  const probe = probeAnalysisArtifactReadiness(
    { PATH: process.env.PATH, A2A_OPENCLAW_ANALYSIS_ENABLED: "1" },
    true,
  );

  assert.equal(
    probe.handlerPath,
    DEFAULT_ANALYSIS_BRIDGE,
    "probe and handler must resolve the same bridge when no *_ANALYSIS_BIN is configured — "
      + "otherwise the probe darkens workers the handler would have run",
  );
});

test("bridge enabled with no *_ANALYSIS_BIN keeps a present default bridge ready (#1597/#1788)", () => {
  const probe = probeAnalysisArtifactReadiness(
    { PATH: process.env.PATH, A2A_OPENCLAW_ANALYSIS_ENABLED: "1" },
    true,
  );

  assert.equal(probe.probed, true);
  assert.equal(probe.ready, true, "the in-repo default bridge exists in a checkout, so the worker stays analysis-capable");
  assert.equal(probe.reason, undefined);
});

test("explicit *_ANALYSIS_BIN still overrides the default fallback (#1597/#1788)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-probe-override-"));
  try {
    const explicit = join(dir, "custom-bridge.mjs");
    writeFileSync(explicit, "// custom bridge\n");
    const probe = probeAnalysisArtifactReadiness(
      { PATH: process.env.PATH, A2A_OPENCLAW_ANALYSIS_ENABLED: "1", A2A_OPENCLAW_ANALYSIS_BIN: explicit },
      true,
    );
    assert.equal(probe.ready, true);
    assert.equal(probe.handlerPath, explicit, "explicit configuration must win over the fallback");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing default bridge is still reported, not silently passed (#1597/#1788)", () => {
  // Parity must not become "always ready": where the bridge artifact is absent
  // (the broker image ships only the hermes bridge), the probe must still fail
  // closed — the handler would fail there too.
  const probe = probeAnalysisArtifactReadiness(
    {
      PATH: process.env.PATH,
      A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
      A2A_OPENCLAW_ANALYSIS_BIN: "/definitely/not/a/real/bridge.mjs",
    },
    true,
  );
  assert.equal(probe.ready, false);
  assert.equal(probe.reason, "handler_artifact_missing");
});
