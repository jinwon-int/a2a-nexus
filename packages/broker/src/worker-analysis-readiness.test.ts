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
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkerConfigFromEnv, probeAnalysisArtifactReadiness } from "./worker.js";
import { probeAnalysisHarnessPreflight, withAnalysisProbeMetadata } from "./workers/worker-metadata.js";
import { isWorkerSubstantiveAnalysisReady, workerAnalysisAdapterMismatch } from "./core/broker-worker-status.js";
import { buildWorkerCapacitySummary } from "./core/claim/broker-worker-capacity.js";
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

test("adapter/harness metadata contradicting the analysis handler path degrades readiness (#1895)", () => {
  // 2026-08-19 incident shape: the worker advertised claude labels while the
  // resolved analysis bridge was the piri bridge — the broker projection must
  // darken so the label drift is visible instead of silently mis-attributing
  // analysis runs.
  const worker = workerRecord({
    metadata: {
      harness: "claude",
      adapter: "claude_code",
      analysisHandlerPath: "/opt/a2a-broker-worker/scripts/piri-a2a-analysis-bridge.mjs",
    },
  });
  assert.equal(isWorkerSubstantiveAnalysisReady(worker), false);
  assert.match(workerAnalysisAdapterMismatch(worker.metadata) ?? "", /mismatch/);
});

test("consistent adapter metadata keeps readiness (#1895)", () => {
  const worker = workerRecord({
    metadata: {
      harness: "piri",
      adapter: "piri-a2a-analysis-bridge",
      analysisHandlerPath: "/opt/a2a-broker-worker/scripts/piri-a2a-analysis-bridge.mjs",
    },
  });
  assert.equal(isWorkerSubstantiveAnalysisReady(worker), true);
  assert.equal(workerAnalysisAdapterMismatch(worker.metadata), undefined);
});

test("danso-wired workers are checked for stale piri labels and accepted when consistent (#2295)", () => {
  const handlerPath = "/opt/a2a-broker-worker/scripts/danso-a2a-analysis-bridge.mjs";
  const stale = workerRecord({ metadata: { harness: "piri", adapter: "piri-a2a-analysis-bridge", analysisHandlerPath: handlerPath } });
  assert.equal(isWorkerSubstantiveAnalysisReady(stale), false);
  assert.match(workerAnalysisAdapterMismatch(stale.metadata) ?? "", /mismatch/);
  const consistent = workerRecord({ metadata: { harness: "danso", adapter: "danso-a2a-analysis-bridge", analysisHandlerPath: handlerPath } });
  assert.equal(isWorkerSubstantiveAnalysisReady(consistent), true);
  assert.equal(workerAnalysisAdapterMismatch(consistent.metadata), undefined);
});

test("probe resolves A2A_DANSO_ANALYSIS_BIN first and classifies it as danso (#2295)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-danso-probe-"));
  try {
    const danso = join(dir, "danso-a2a-analysis-bridge.mjs");
    const piri = join(dir, "piri-a2a-analysis-bridge.mjs");
    writeFileSync(danso, "// danso bridge\n", "utf8");
    writeFileSync(piri, "// piri bridge\n", "utf8");
    const probe = probeAnalysisArtifactReadiness(
      {
        A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
        A2A_DANSO_ANALYSIS_BIN: danso,
        A2A_PIRI_ANALYSIS_BIN: piri,
        // Legacy claude hints must not outrank the resolved danso bridge.
        A2A_CLAUDE_CODE_BIN: "/usr/bin/claude",
      },
      true,
    );
    assert.equal(probe.ready, true);
    assert.equal(probe.handlerPath, danso);
    assert.equal(probe.adapterClass, "danso");
    const explicit = probeAnalysisArtifactReadiness(
      { A2A_OPENCLAW_ANALYSIS_ENABLED: "1", A2A_DANSO_ANALYSIS_BIN: danso, A2A_WORKER_BRIDGE_ADAPTER: "danso" },
      true,
    );
    assert.equal(explicit.adapterClass, "danso");
    // A piri-wired node whose metadata mentions danso keeps its old class.
    const piriNode = probeAnalysisArtifactReadiness(
      {
        A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
        A2A_PIRI_ANALYSIS_BIN: piri,
        WORKER_METADATA_JSON: JSON.stringify({ note: "main session harness: danso" }),
      },
      true,
    );
    // (The temp dir name itself contains "danso" — the piri bridge inside it
    // must still not be classified as danso.)
    assert.notEqual(piriNode.adapterClass, "danso");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("intent-aware claude patch bridge serving analysis is consistent (#1895)", () => {
  // The claude patch bridge serves analysis in a read-only mode by design, so
  // a worker whose analysis handler IS the claude patch bridge is consistent.
  const worker = workerRecord({
    metadata: {
      harness: "claude",
      adapter: "claude-a2a-patch-bridge",
      analysisHandlerPath: "/opt/a2a-broker-worker/scripts/claude-a2a-patch-bridge.mjs",
    },
  });
  assert.equal(isWorkerSubstantiveAnalysisReady(worker), true);
  assert.equal(workerAnalysisAdapterMismatch(worker.metadata), undefined);
});

test("absent handler-path metadata never darkens legacy workers (#1895)", () => {
  const worker = workerRecord({ metadata: { harness: "claude" } });
  assert.equal(isWorkerSubstantiveAnalysisReady(worker), true);
  assert.equal(workerAnalysisAdapterMismatch({ harness: "claude" }), undefined);
});

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

test("probe mirrors the handler: a declared adapter selects the matching bridge, a contradiction is not ready (#2370)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-adapter-probe-"));
  try {
    const piri = join(dir, "piri-a2a-analysis-bridge.mjs");
    const codex = join(dir, "codex-a2a-analysis-bridge.mjs");
    writeFileSync(piri, "// piri bridge\n", "utf8");
    writeFileSync(codex, "// codex bridge\n", "utf8");
    // gongmyoung-like: declared codex, stale piri slot, codex bridge in the hermes slot.
    const selected = probeAnalysisArtifactReadiness(
      {
        A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
        A2A_ANALYSIS_BRIDGE_ADAPTER: "codex",
        A2A_PIRI_ANALYSIS_BIN: piri,
        A2A_HERMES_ANALYSIS_BIN: codex,
      },
      true,
    );
    assert.equal(selected.ready, true);
    assert.equal(selected.handlerPath, codex);
    assert.equal(selected.adapterClass, "codex");
    // soonwook-like: declared claude-code, only a piri slot — the handler preflight refuses, so does the probe.
    const contradiction = probeAnalysisArtifactReadiness(
      { A2A_OPENCLAW_ANALYSIS_ENABLED: "1", A2A_ANALYSIS_BRIDGE_ADAPTER: "claude-code", A2A_PIRI_ANALYSIS_BIN: piri },
      true,
    );
    assert.equal(contradiction.ready, false);
    assert.equal(contradiction.reason, "handler_adapter_mismatch");
    assert.equal(contradiction.handlerPath, piri);
    const metadata = withAnalysisProbeMetadata({}, contradiction, {});
    assert.equal(metadata?.analysisReady, "false");
    assert.equal(metadata?.analysisReadyReason, "handler_adapter_mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2401: a bridge pin mismatch withdraws canAnalyze with reason harness_preflight_failed and bounded metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-preflight-probe-"));
  try {
    const bridge = join(dir, "claude-a2a-analysis-bridge.mjs");
    writeFileSync(bridge, "// bridge v1\n", "utf8");
    const actual = createHash("sha256").update(readFileSync(bridge)).digest("hex");
    const mismatch = probeAnalysisArtifactReadiness(
      { A2A_OPENCLAW_ANALYSIS_ENABLED: "1", A2A_HERMES_ANALYSIS_BIN: bridge, A2A_BRIDGE_PIN_SHA256: "0".repeat(64) },
      true,
    );
    assert.equal(mismatch.ready, false);
    assert.equal(mismatch.reason, "harness_preflight_failed");
    assert.equal(mismatch.harnessPreflight?.failures[0]?.check, "bridge_pin");
    assert.equal(mismatch.harnessPreflight?.failures[0]?.actual, actual);
    const metadata = withAnalysisProbeMetadata({}, mismatch, {});
    assert.equal(metadata?.analysisReady, "false");
    assert.equal(metadata?.analysisReadyReason, "harness_preflight_failed");
    const preflight = JSON.parse(metadata?.analysisHarnessPreflight ?? "{}") as { ok: boolean; failures: Array<{ check: string; remedy: string }> };
    assert.equal(preflight.ok, false);
    assert.match(preflight.failures[0]?.remedy ?? "", /pinned sha256/);

    const match = probeAnalysisArtifactReadiness(
      { A2A_OPENCLAW_ANALYSIS_ENABLED: "1", A2A_HERMES_ANALYSIS_BIN: bridge, A2A_BRIDGE_PIN_SHA256: actual },
      true,
    );
    assert.equal(match.ready, true);
    assert.equal(match.harnessPreflight?.ok, true);
    assert.equal(withAnalysisProbeMetadata({}, match, {})?.analysisHarnessPreflight, undefined);

    // Unset pins are skipped (same as the handler).
    const unpinned = probeAnalysisArtifactReadiness({ A2A_OPENCLAW_ANALYSIS_ENABLED: "1", A2A_HERMES_ANALYSIS_BIN: bridge }, true);
    assert.equal(unpinned.ready, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2401: the worker-side preflight port agrees with the handler's analysisHarnessPreflight (parity)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-preflight-parity-"));
  try {
    const bridge = join(dir, "codex-a2a-analysis-bridge.mjs");
    writeFileSync(bridge, "// bridge\n", "utf8");
    const registry = join(dir, "registry.json");
    writeFileSync(registry, JSON.stringify({ skills: [
      { name: "b-skill", tree_sha256: "b".repeat(64) },
      { name: "a-skill", tree_sha256: "a".repeat(64) },
      { name: "broken", tree_sha256: "not-a-digest" },
    ] }), "utf8");
    const mjsUrl = new URL("../scripts/lib/analysis-harness-fingerprint.mjs", import.meta.url).href;
    const handlerSide = await import(mjsUrl) as {
      analysisHarnessPreflight: (input: { bridgeFile: string; env: NodeJS.ProcessEnv }) => { ok: boolean; failures: Array<{ check: string; expected?: string; actual?: string; remedy: string }> };
    };
    for (const env of [
      { A2A_BRIDGE_PIN_SHA256: "1".repeat(64), A2A_SKILLS_TREE_SHA256_PIN: "2".repeat(64), A2A_SKILLS_REGISTRY_PATH: registry },
      { A2A_BRIDGE_PIN_SHA256: "xyz", A2A_SKILLS_TREE_SHA256_PIN: "2".repeat(64) },
      { A2A_SKILLS_TREE_SHA256_PIN: "2".repeat(64), A2A_SKILLS_REGISTRY_PATH: join(dir, "missing.json") },
      {},
    ]) {
      const theirs = handlerSide.analysisHarnessPreflight({ bridgeFile: bridge, env });
      const ours = probeAnalysisHarnessPreflight(env, bridge);
      assert.equal(ours.ok, theirs.ok);
      assert.deepEqual(
        ours.failures.map((f) => [f.check, f.expected ?? null, f.actual ?? null, f.remedy]),
        theirs.failures.map((f) => [f.check, f.expected ?? null, f.actual ?? null, f.remedy]),
        `env=${JSON.stringify(Object.keys(env))}`,
      );
    }
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

test("#2493: analysisBridgeSha256 tracks the loaded bridge whether or not the pin passes, independent of analysisBuildSha", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-bridge-sha-"));
  try {
    const bridge = join(dir, "claude-a2a-analysis-bridge.mjs");
    const env = { A2A_OPENCLAW_ANALYSIS_ENABLED: "1", A2A_HERMES_ANALYSIS_BIN: bridge, A2A_WORKER_BUILD_SHA: "39ec40ca" };
    writeFileSync(bridge, "// bridge v1\n", "utf8");
    const v1 = createHash("sha256").update(readFileSync(bridge)).digest("hex");
    const first = withAnalysisProbeMetadata({}, probeAnalysisArtifactReadiness(env, true), env);
    assert.equal(first?.analysisReady, "true");
    assert.equal(first?.analysisBridgeSha256, v1);
    assert.equal(first?.analysisBuildSha, "39ec40ca");

    // A script-only bridge sync: the bridge digest moves, the dist build revision does not.
    writeFileSync(bridge, "// bridge v2\n", "utf8");
    const v2 = createHash("sha256").update(readFileSync(bridge)).digest("hex");
    const second = withAnalysisProbeMetadata({}, probeAnalysisArtifactReadiness(env, true), env);
    assert.notEqual(v2, v1);
    assert.equal(second?.analysisBridgeSha256, v2);
    assert.equal(second?.analysisBuildSha, "39ec40ca");

    // A failing pin still publishes the digest of the bridge that failed it.
    const pinned = { ...env, A2A_BRIDGE_PIN_SHA256: v1 };
    const failed = withAnalysisProbeMetadata({}, probeAnalysisArtifactReadiness(pinned, true), pinned);
    assert.equal(failed?.analysisReadyReason, "harness_preflight_failed");
    assert.equal(failed?.analysisBridgeSha256, v2);

    // No bridge file: no digest is invented.
    rmSync(bridge);
    const missing = withAnalysisProbeMetadata({}, probeAnalysisArtifactReadiness(env, true), env);
    assert.equal(missing?.analysisReadyReason, "handler_artifact_missing");
    assert.equal(missing?.analysisBridgeSha256, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
