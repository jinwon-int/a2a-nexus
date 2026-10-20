/**
 * #2401 — harness preflight before claim: a worker whose analysis readiness
 * probe fails must not claim analysis-bound tasks, must re-advertise
 * capabilities/metadata on the next heartbeat when readiness changes, and must
 * resume claiming once the probe passes again.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { A2ABrokerWorker } from "./broker-worker-client.js";
import type { AnalysisReadinessSnapshot, BrokerWorkerConfig } from "../worker.js";

const CAPS = {
  canAnalyze: true,
  canBackfill: false,
  canPatchWorkspace: false,
  canPromoteLive: false,
  workspaceIds: ["test"],
  environments: ["research" as const],
};

function snapshot(ready: boolean, reason?: AnalysisReadinessSnapshot["probe"]["reason"]): AnalysisReadinessSnapshot {
  return {
    probe: { probed: true, ready, ...(reason ? { reason } : {}), adapterClass: "claude_code", handlerPath: "/opt/bridge.mjs" },
    capabilities: { ...CAPS, canAnalyze: ready },
    metadata: ready
      ? { analysisReady: "true" }
      : { analysisReady: "false", analysisReadyReason: reason ?? "handler_artifact_missing", analysisHarnessPreflight: '{"ok":false,"failures":[{"check":"bridge_pin","remedy":"redeploy"}]}' },
  };
}

function makeWorker(state: { readiness: AnalysisReadinessSnapshot; calls: string[]; heartbeats: unknown[] }, tasks: Array<{ id: string; intent: string }>): A2ABrokerWorker {
  const config: BrokerWorkerConfig = {
    brokerUrl: "http://broker.test",
    requesterKind: "node",
    pollIntervalMs: 5_000,
    heartbeatIntervalMs: 30_000,
    handlerTimeoutMs: 60_000,
    worker: { nodeId: "workerbeta", role: "analyst", capabilities: { ...CAPS } },
    userAgent: "test-agent",
    handler: async () => ({ output: { analysisStatus: "done", findings: ["f"] } }),
    analysisReadinessRefresh: () => state.readiness,
  };
  const fetchImpl = async (url: URL, init?: RequestInit): Promise<Response> => {
    state.calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/tasks") {
      return new Response(JSON.stringify({ items: tasks.map((t) => ({ ...t, status: "queued", payload: {}, targetNodeId: "default", requester: { id: "b", kind: "service" }, target: { id: "default", kind: "node" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" })) }), { status: 200 });
    }
    if (url.pathname.endsWith("/heartbeat")) {
      state.heartbeats.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ nodeId: "workerbeta" }), { status: 200 });
    }
    if (url.pathname.endsWith("/claim") || url.pathname.endsWith("/start") || url.pathname.endsWith("/complete") || url.pathname.endsWith("/fail")) {
      const id = url.pathname.split("/")[2]!;
      return new Response(JSON.stringify({ id, intent: "analyze", status: "running", payload: {}, targetNodeId: "default", requester: { id: "b", kind: "service" }, target: { id: "default", kind: "node" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  return new A2ABrokerWorker(config, { fetchImpl: fetchImpl as never });
}

test("#2401: a failing harness preflight skips the claim of analysis-bound tasks but not of other intents", async () => {
  const state = { readiness: snapshot(false, "harness_preflight_failed"), calls: [] as string[], heartbeats: [] as unknown[] };
  const worker = makeWorker(state, [{ id: "t-analyze", intent: "analyze" }, { id: "t-patch", intent: "propose_patch" }]);
  await worker.runOnce();
  const claims = state.calls.filter((c) => c.includes("/claim"));
  assert.deepEqual(claims, ["POST /tasks/t-patch/claim"], `analysis task must not be claimed; calls=${state.calls.join(",")}`);
});

test("#2401: readiness changes are re-advertised on the next heartbeat and claims resume when the pin is fixed", async () => {
  const state = { readiness: snapshot(true), calls: [] as string[], heartbeats: [] as unknown[] };
  const worker = makeWorker(state, [{ id: "t-analyze", intent: "analyze" }]);

  await worker.heartbeat(); // initial: always carries capabilities
  assert.equal((state.heartbeats[0] as { capabilities?: { canAnalyze: boolean } }).capabilities?.canAnalyze, true);
  await worker.heartbeat(); // unchanged: steady-state heartbeat omits capabilities
  assert.equal((state.heartbeats[1] as { capabilities?: unknown }).capabilities, undefined);

  state.readiness = snapshot(false, "harness_preflight_failed");
  await worker.heartbeat(); // changed: re-advertise canAnalyze=false + preflight metadata
  const drifted = state.heartbeats[2] as { capabilities?: { canAnalyze: boolean }; metadata?: Record<string, string> };
  assert.equal(drifted.capabilities?.canAnalyze, false);
  assert.equal(drifted.metadata?.analysisReadyReason, "harness_preflight_failed");
  assert.match(drifted.metadata?.analysisHarnessPreflight ?? "", /bridge_pin/);
  await worker.runOnce();
  assert.equal(state.calls.filter((c) => c.includes("/claim")).length, 0, "no claim while the pin mismatches");

  state.readiness = snapshot(true);
  await worker.heartbeat(); // fixed: re-advertise canAnalyze=true
  assert.equal((state.heartbeats[3] as { capabilities?: { canAnalyze: boolean } }).capabilities?.canAnalyze, true);
  await worker.runOnce();
  assert.equal(state.calls.filter((c) => c.includes("/claim")).length, 1, "claim resumes once the probe passes");
});

test("#2401: a probe that throws neither crashes the worker nor lets analysis tasks be claimed", async () => {
  const state = { readiness: snapshot(true), calls: [] as string[], heartbeats: [] as unknown[] };
  const worker = makeWorker(state, [{ id: "t-analyze", intent: "analyze" }]);
  (worker as unknown as { config: BrokerWorkerConfig }).config.analysisReadinessRefresh = () => { throw new Error("probe exploded"); };
  await worker.heartbeat();
  await worker.runOnce();
  assert.equal(state.calls.filter((c) => c.includes("/claim")).length, 0);
});
