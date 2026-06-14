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
