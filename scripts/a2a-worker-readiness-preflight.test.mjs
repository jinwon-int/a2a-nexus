import test from "node:test";
import assert from "node:assert/strict";

import { evaluateWorkerReadiness, evaluateFleetReadiness } from "./a2a-worker-readiness-preflight.mjs";

// A healthy team1 worker on the canonical layout.
function healthy(overrides = {}) {
  return {
    node: "sogyo",
    teamId: "team1",
    homeBrokerId: "seoseo",
    secretLength: 64,
    service: "a2a-hermes-worker",
    envPath: "/etc/default/a2a-hermes-worker",
    root: "/opt/a2a-broker-worker",
    handlers: [
      { path: "/opt/a2a-broker-worker/dist/worker.js", present: true, executable: true },
      { path: "/opt/a2a-broker-worker/scripts/a2a-task-handler.mjs", present: true, executable: true },
      { path: "/opt/a2a-broker-worker/scripts/hermes-a2a-analysis-bridge.mjs", present: true, executable: true },
    ],
    active: true,
    ...overrides,
  };
}

function codes(result) {
  return result.violations.map((v) => v.code).sort();
}

test("a healthy worker on the canonical layout passes", () => {
  const r = evaluateWorkerReadiness(healthy());
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test("nosuk-style truncated secret is classified secret_invalid", () => {
  const r = evaluateWorkerReadiness(healthy({ node: "nosuk", secretLength: 13 }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("secret_invalid"));
});

test("a missing secret is secret_invalid", () => {
  const r = evaluateWorkerReadiness(healthy({ secretLength: undefined, secretPresent: false }));
  assert.ok(codes(r).includes("secret_invalid"));
});

test("yukson-style legacy root + non-executable bridge fails worker_root_missing and handler_missing", () => {
  const r = evaluateWorkerReadiness(healthy({
    node: "yukson",
    root: "/opt/openclaw-a2a-worker",
    handlers: [
      { path: "/opt/openclaw-a2a-worker/dist/worker.js", present: true, executable: true },
      { path: "/opt/openclaw-a2a-worker/scripts/a2a-task-handler.mjs", present: true, executable: true },
      { path: "/opt/openclaw-a2a-worker/scripts/hermes-a2a-analysis-bridge.mjs", present: true, executable: false },
    ],
  }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("worker_root_missing"));
  assert.ok(codes(r).includes("handler_missing"));
});

test("a team↔broker routing mismatch is broker_route_mismatch (ref #633)", () => {
  const r = evaluateWorkerReadiness(healthy({ node: "soonwook", teamId: "team2", homeBrokerId: "seoseo" }));
  assert.ok(codes(r).includes("broker_route_mismatch"));
});

test("service / env-path drift is service_path_drift", () => {
  const r = evaluateWorkerReadiness(healthy({ service: "openclaw-a2a-worker" }));
  assert.ok(codes(r).includes("service_path_drift"));
});

test("a missing required handler is handler_missing", () => {
  const r = evaluateWorkerReadiness(healthy({
    handlers: [
      { path: "/opt/a2a-broker-worker/dist/worker.js", present: true, executable: true },
      { path: "/opt/a2a-broker-worker/scripts/a2a-task-handler.mjs", present: true, executable: true },
      // hermes bridge omitted
    ],
  }));
  assert.ok(codes(r).includes("handler_missing"));
});

test("evaluateFleetReadiness aggregates per-node violations and a clean fleet", () => {
  const clean = evaluateFleetReadiness([healthy(), healthy({ node: "dungae", teamId: "team2", homeBrokerId: "gwakga" })]);
  assert.equal(clean.ok, true);

  const dirty = evaluateFleetReadiness([healthy({ node: "nosuk", secretLength: 13 })]);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.violations[0].node, "nosuk");
  assert.equal(dirty.violations[0].code, "secret_invalid");
});

test("custom expectations override the canonical defaults", () => {
  const r = evaluateWorkerReadiness(
    { node: "alt", teamId: "team1", homeBrokerId: "seoseo", secretLength: 20, service: "svc", root: "/srv/w", handlers: [] },
    { service: "svc", root: "/srv/w", minSecretLength: 16, requiredHandlers: [] },
  );
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test("task-poll readiness is fail-closed when required but the probe is missing", () => {
  const r = evaluateWorkerReadiness(healthy(), { requireTaskPollProbe: true });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("task_poll_unauthorized"));
  assert.match(r.violations.find((v) => v.code === "task_poll_unauthorized")?.reason ?? "", /missing/i);
});

test("task-poll readiness passes with a matching authorized probe", () => {
  const r = evaluateWorkerReadiness(
    healthy({
      taskPollProbe: {
        ok: true,
        httpStatus: 200,
        assignedWorkerId: "sogyo",
        brokerId: "seoseo",
      },
    }),
    { requireTaskPollProbe: true },
  );
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test("task-poll readiness rejects unauthorized or forbidden probe status", () => {
  const r = evaluateWorkerReadiness(
    healthy({
      taskPollProbe: {
        ok: false,
        httpStatus: 403,
        assignedWorkerId: "sogyo",
        brokerId: "seoseo",
      },
    }),
    { requireTaskPollProbe: true },
  );
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("task_poll_unauthorized"));
  assert.match(r.violations.find((v) => v.code === "task_poll_unauthorized")?.reason ?? "", /403/);
});

test("task-poll readiness rejects probes collected for a different assigned worker", () => {
  const r = evaluateWorkerReadiness(
    healthy({
      taskPollProbe: {
        ok: true,
        httpStatus: 200,
        assignedWorkerId: "bangtong",
        brokerId: "seoseo",
      },
    }),
    { requireTaskPollProbe: true },
  );
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("task_poll_unauthorized"));
  assert.match(r.violations.find((v) => v.code === "task_poll_unauthorized")?.reason ?? "", /bangtong.*sogyo|sogyo.*bangtong/);
});

test("task-poll readiness rejects raw credential material in collected probe metadata", () => {
  const r = evaluateWorkerReadiness(
    healthy({
      taskPollProbe: {
        ok: true,
        httpStatus: 200,
        assignedWorkerId: "sogyo",
        brokerId: "seoseo",
        authorization: "Bearer should-not-be-accepted",
      },
    }),
    { requireTaskPollProbe: true },
  );
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("task_poll_unauthorized"));
  assert.match(r.violations.find((v) => v.code === "task_poll_unauthorized")?.reason ?? "", /credential/i);
});

test("local WORKER_ROLE that disagrees with the broker-expected role is worker_role_mismatch (#739)", () => {
  const r = evaluateWorkerReadiness(healthy({ node: "nosuk", role: "live-trader", expectedRole: "analyst" }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("worker_role_mismatch"));
  assert.match(
    r.violations.find((v) => v.code === "worker_role_mismatch")?.reason ?? "",
    /WORKER_ROLE=analyst/,
  );
});

test("matching local/expected roles do not raise role drift (#739)", () => {
  const r = evaluateWorkerReadiness(healthy({ role: "analyst", expectedRole: "analyst" }));
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test("a broker heartbeat role-rejection is classified heartbeat_requester_role_mismatch (#739)", () => {
  const r = evaluateWorkerReadiness(healthy({
    node: "nosuk",
    role: "live-trader",
    heartbeatProbe: {
      ok: false,
      httpStatus: 401,
      reason: "worker.heartbeat requester role must match analyst",
    },
  }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("heartbeat_requester_role_mismatch"));
  assert.match(
    r.violations.find((v) => v.code === "heartbeat_requester_role_mismatch")?.reason ?? "",
    /must match broker-expected role 'analyst'/,
  );
});

test("privileged heartbeat role-rejection extracts the concrete expected role (#739)", () => {
  const r = evaluateWorkerReadiness(healthy({
    node: "nosuk",
    role: "analyst",
    heartbeatProbe: {
      ok: false,
      httpStatus: 401,
      reason: "worker.heartbeat requester role must match privileged actor role hub",
    },
  }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("heartbeat_requester_role_mismatch"));
  const reason = r.violations.find((v) => v.code === "heartbeat_requester_role_mismatch")?.reason ?? "";
  assert.match(reason, /must match broker-expected role 'hub'/);
  assert.match(reason, /WORKER_ROLE=hub/);
  assert.doesNotMatch(reason, /WORKER_ROLE=privileged/);
});

test("a heartbeat probe carrying raw credentials is rejected without leaking them (#739)", () => {
  const r = evaluateWorkerReadiness(healthy({
    heartbeatProbe: { ok: false, httpStatus: 401, reason: "role mismatch", authorization: "Bearer leak" },
  }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("heartbeat_requester_role_mismatch"));
  // The raw credential value must never appear in any emitted reason.
  assert.ok(!JSON.stringify(r.violations).includes("Bearer leak"));
});

test("service active but broker reports the worker stale is broker_worker_stale (#739)", () => {
  const r = evaluateWorkerReadiness(healthy({ node: "nosuk", brokerWorkerStatus: "stale" }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("broker_worker_stale"));
});

test("serviceActive alias also marks an active service for broker stale checks (#739)", () => {
  const r = evaluateWorkerReadiness(healthy({ node: "nosuk", active: false, serviceActive: true, brokerWorkerStatus: "stale" }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("broker_worker_stale"));
});

test("service active with broker online is healthy (#739)", () => {
  const r = evaluateWorkerReadiness(healthy({ serviceActive: true, brokerWorkerStatus: "online" }));
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test("Hermes patch profile with unsupported default model is classified before dispatch (#810)", () => {
  const r = evaluateWorkerReadiness(healthy({
    node: "yukson",
    patchProfile: "hermes",
    workerModel: "deepseek/deepseek-v4-flash",
  }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("worker_model_profile_mismatch"));
  const reason = r.violations.find((v) => v.code === "worker_model_profile_mismatch")?.reason ?? "";
  assert.match(reason, /Hermes/i);
  assert.match(reason, /openai-codex\/gpt-5\.5/);
});

test("Hermes patch profile accepts supported default model in readiness preflight (#810)", () => {
  const r = evaluateWorkerReadiness(healthy({
    patchProfile: "hermes",
    workerModel: "openai-codex/gpt-5.5",
  }));
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test("runtime repair readiness requires explicit no-live verification when requested (#832)", () => {
  const r = evaluateWorkerReadiness(healthy(), { requireNoLiveVerification: true });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("no_live_verification_missing"));
  assert.match(r.violations.find((v) => v.code === "no_live_verification_missing")?.reason ?? "", /no-live/i);
});

test("runtime repair readiness accepts explicit no-live verification evidence (#832)", () => {
  const r = evaluateWorkerReadiness(
    healthy({
      noLiveVerification: {
        ok: true,
        mode: "no-live",
        liveActionsAllowed: false,
        providerSend: false,
        telegramCanary: false,
        workerRestart: false,
      },
    }),
    { requireNoLiveVerification: true },
  );
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test("runtime repair readiness rejects no-live evidence that includes live actions (#832)", () => {
  const r = evaluateWorkerReadiness(
    healthy({
      noLiveVerification: {
        ok: true,
        mode: "no-live",
        liveActionsAllowed: true,
        providerSend: false,
        telegramCanary: false,
      },
    }),
    { requireNoLiveVerification: true },
  );
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("no_live_verification_missing"));
  assert.match(r.violations.find((v) => v.code === "no_live_verification_missing")?.reason ?? "", /live action/i);
});

test("runtime repair readiness classifies missing hermes profile mount before dispatch (#832)", () => {
  const r = evaluateWorkerReadiness(healthy({
    patchProfile: "hermes",
    workerModel: "openai-codex/gpt-5.5",
    hermesConfigDir: "/root/.hermes",
    dockerRunnerExtraMounts: [
      { source: "/tmp/a2a-scratch", target: "/workspace", readOnly: false },
    ],
  }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("docker_runner_mount_invalid"));
  assert.match(r.violations.find((v) => v.code === "docker_runner_mount_invalid")?.reason ?? "", /hermes.*\/run\/secrets\/hermes-dir/i);
});

test("runtime repair readiness rejects writable protected docker runner mounts (#832)", () => {
  const r = evaluateWorkerReadiness(healthy({
    patchProfile: "hermes",
    workerModel: "openai-codex/gpt-5.5",
    hermesConfigDir: "/root/.hermes",
    dockerRunnerExtraMounts: [
      { source: "/root/.hermes", target: "/run/secrets/hermes-dir", readOnly: false },
    ],
  }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("docker_runner_mount_invalid"));
  assert.match(r.violations.find((v) => v.code === "docker_runner_mount_invalid")?.reason ?? "", /writable agent runtime\/session paths/i);
});
