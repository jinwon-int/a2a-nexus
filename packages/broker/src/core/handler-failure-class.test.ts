/**
 * Handler failure-class split and its survival through the list read paths.
 *
 * #1597, routed from #1725 finding 2. The 2026-08-03 audit measured 29
 * `handler_exit_nonzero` failures in a clean bimodal distribution — 12 dying in
 * <=10s for 54 seconds total, and 17 burning 87.3 lane-minutes averaging 308s.
 * Same code, opposite causes, three orders of magnitude apart in cost. Neither
 * list read path carried anything that told them apart: the SQLite projection
 * dropped `details` wholesale and the in-memory one kept only stage/excerpt, so
 * identifying a cause meant opening task records one at a time.
 *
 * These tests pin: the classification itself, that unknown failures stay
 * unclassified rather than guessed, that a worker cannot inject free text into
 * the projected field, and that projecting it leaks nothing else.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FAILURE_CLASSES,
  failureReadbackFromError,
  normalizeFailureClass,
  normalizeFailureReadbackDetails,
} from "./task-error-details.js";
import { parseHotTaskListItemProjection } from "./store-hot-select-projections.js";
import { classifyHandlerFailure } from "../worker.js";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("the fast cluster (artifact absent) classifies as handler_missing (#1597/#1725)", () => {
  // Node's own machine codes, which is what a worker with no handler script emits.
  assert.equal(
    classifyHandlerFailure({ diagnosticText: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/root/handlers/a2a-task-handler.mjs'" }),
    "handler_missing",
  );
  assert.equal(classifyHandlerFailure({ diagnosticText: "code: 'MODULE_NOT_FOUND'" }), "handler_missing");
  // The handler's own preflight for a missing bridge artifact.
  assert.equal(classifyHandlerFailure({ nestedCode: "openclaw_analysis_bridge_missing" }), "handler_missing");
});

test("the slow cluster (bridge ran, output unusable) classifies as handler_bridge_error (#1597/#1725)", () => {
  assert.equal(classifyHandlerFailure({ nestedCode: "analysis_bridge_invalid_json" }), "handler_bridge_error");
  assert.equal(classifyHandlerFailure({ nestedCode: "openclaw_analysis_failed" }), "handler_bridge_error");
  assert.equal(classifyHandlerFailure({ nestedCode: "openclaw_bridge_no_final_json" }), "handler_bridge_error");
});

test("unrecognised failures stay unclassified rather than being guessed (#1597/#1725)", () => {
  // A wrong label is worse than no label: a reader trusts this field.
  assert.equal(classifyHandlerFailure({ nestedCode: "some_future_code" }), undefined);
  assert.equal(classifyHandlerFailure({ diagnosticText: "handler exited with code 1" }), undefined);
  assert.equal(classifyHandlerFailure({}), undefined);
});

test("nested code wins over loose text so a bridge error is not mislabelled (#1597/#1725)", () => {
  // A bridge that quotes MODULE_NOT_FOUND inside its own diagnostics must not
  // be reclassified as a missing artifact.
  assert.equal(
    classifyHandlerFailure({
      nestedCode: "analysis_bridge_invalid_json",
      diagnosticText: "model output mentioned MODULE_NOT_FOUND while reasoning",
    }),
    "handler_bridge_error",
  );
});

// ---------------------------------------------------------------------------
// Vocabulary is closed
// ---------------------------------------------------------------------------

test("failure class is a closed vocabulary; worker-supplied values outside it are dropped (#1597/#1725)", () => {
  for (const value of FAILURE_CLASSES) {
    assert.equal(normalizeFailureClass(value), value);
  }
  assert.equal(normalizeFailureClass("HANDLER_MISSING"), "handler_missing", "case-insensitive");
  assert.equal(normalizeFailureClass("made-up; DROP TABLE"), undefined);
  assert.equal(normalizeFailureClass(""), undefined);
  assert.equal(normalizeFailureClass(42), undefined);
  assert.equal(normalizeFailureClass({ failureClass: "handler_missing" }), undefined);
});

test("normalizeFailureReadbackDetails strips an out-of-vocabulary class instead of storing it (#1597/#1725)", () => {
  const stored = normalizeFailureReadbackDetails({ stage: "handler", failureClass: "not-a-real-class" });
  assert.equal(stored?.failureClass, undefined, "the field is projected publicly; it must not be a free-text channel");
  assert.equal(stored?.stage, "handler", "unrelated details survive");

  const kept = normalizeFailureReadbackDetails({ stage: "handler", failureClass: "handler_bridge_error" });
  assert.equal(kept?.failureClass, "handler_bridge_error");
});

// ---------------------------------------------------------------------------
// The read paths — the actual gap #1725 named
// ---------------------------------------------------------------------------

test("in-memory readback carries the class, and carries it even with no stage/excerpt (#1597/#1725)", () => {
  const readback = failureReadbackFromError({
    code: "handler_exit_nonzero",
    message: "handler exited with code 1",
    details: { stage: "handler", excerpt: "ERR_MODULE_NOT_FOUND", failureClass: "handler_missing" },
  });
  assert.equal(readback?.failureClass, "handler_missing");
  assert.equal(readback?.stage, "handler");

  const classOnly = failureReadbackFromError({
    code: "handler_spawn_failed",
    message: "spawn ENOENT",
    details: { failureClass: "handler_missing" },
  });
  assert.equal(classOnly?.failureClass, "handler_missing", "a class alone is enough to be worth reading back");
});

function hotRow(id: string, details: Record<string, unknown>) {
  return {
    id,
    intent: "analyze",
    status: "failed",
    targetNodeId: "w1",
    requester: JSON.stringify({ id: "hub", kind: "node", role: "hub" }),
    target: JSON.stringify({ id: "w1", kind: "node", role: "analyst" }),
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    error: JSON.stringify({ code: "handler_exit_nonzero", message: "handler exited with code 1", details }),
  };
}

test("SQLite list projection distinguishes the two clusters (#1597/#1725)", () => {
  // This is the production topology: before the fix both rows read back as a
  // bare handler_exit_nonzero with no details at all.
  const [fast] = parseHotTaskListItemProjection(
    hotRow("t-fast", { stage: "handler", excerpt: "ERR_MODULE_NOT_FOUND", failureClass: "handler_missing" }),
  );
  const [slow] = parseHotTaskListItemProjection(
    hotRow("t-slow", { stage: "handler", excerpt: "no valid analysis JSON", failureClass: "handler_bridge_error" }),
  );

  assert.equal(fast?.error?.code, "handler_exit_nonzero", "the legacy code is unchanged for existing consumers");
  assert.equal(slow?.error?.code, "handler_exit_nonzero");
  assert.equal((fast?.error?.details as Record<string, unknown>)?.failureClass, "handler_missing");
  assert.equal((slow?.error?.details as Record<string, unknown>)?.failureClass, "handler_bridge_error");
});

test("SQLite list projection leaks nothing beyond the closed-vocabulary class (#1597/#1725)", () => {
  const [projected] = parseHotTaskListItemProjection(
    hotRow("t-secret", {
      stage: "handler",
      failureClass: "handler_missing",
      stdout: "GH_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      nestedError: { code: "openclaw_analysis_bridge_missing", details: { command: "/opt/secret/path" } },
      command: "/opt/secret/path",
    }),
  );

  const details = (projected?.error?.details ?? {}) as Record<string, unknown>;
  assert.deepEqual(Object.keys(details), ["failureClass"], "only the class is projected");
  const blob = JSON.stringify(projected);
  assert.ok(!blob.includes("ghp_"), "no token may reach the list projection");
  assert.ok(!blob.includes("nestedError"), "nestedError stays behind ?detail=full / GET /tasks/:id");
  assert.ok(!blob.includes("/opt/secret/path"), "no host paths in the list projection");
});

test("an out-of-vocabulary class from a stored record is not projected (#1597/#1725)", () => {
  // Defence in depth: records written before normalization, or by a
  // compromised/older worker, must not reach readers as free text.
  const [projected] = parseHotTaskListItemProjection(
    hotRow("t-spoof", { stage: "handler", failureClass: "made-up; DROP TABLE" }),
  );
  assert.equal(projected?.error?.details, undefined);
});

test("failures with no class keep the previous projection shape (#1597/#1725)", () => {
  const [projected] = parseHotTaskListItemProjection(hotRow("t-plain", { stage: "handler", excerpt: "boom" }));
  assert.equal(projected?.error?.code, "handler_exit_nonzero");
  assert.equal(projected?.error?.details, undefined, "no empty details object appears where there was none before");
});
