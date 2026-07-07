// Broker accept-path finalizer-verdict admission (#1383 V-c, option 2 strengthened).
// The broker does NOT verify the verdict signature (architecturally it cannot
// reuse the offline verifier; signature authenticity stays with the PR merge
// gate — documented v0 boundary). It enforces, fail-closed in enforce mode and
// only for opt-in tasks, the structural properties it CAN check in-process:
// presence, schema, decision=go, subject-binding (recomputed result hash), and
// independence via the disjoint role namespace (#1429) + provenance worker key.
import test from "node:test";
import assert from "node:assert/strict";

import {
  FINALIZER_VERDICT_SCHEMA,
  resolveFinalizerVerdictEnforcement,
  evaluateFinalizerVerdictAdmission,
} from "./finalizer-verdict-admission.js";
import type { TaskRecord, TaskResult } from "./types.js";

const ANCHOR = "sha256:deadbeefanchor";

function task(payload: Record<string, unknown> = {}): TaskRecord {
  return {
    id: "t1", intent: "analyze", status: "running", targetNodeId: "w",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "w", kind: "node", role: "analyst" },
    message: "m", payload, createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z", taskOrigin: "api",
  } as TaskRecord;
}

/**
 * Build a result whose finalizerVerdict subject binds to the provenance anchor
 * hash. Provenance is present by default (a verdict-requiring completion must
 * be provenance-anchored); override `provenance` to test the missing-anchor case.
 */
function resultWithVerdict(overrides: Record<string, unknown> = {}, verdictOverrides: Record<string, unknown> = {}): TaskResult {
  const base: Record<string, unknown> = {
    summary: "done", output: { x: 1 },
    provenance: { workerKeyId: "worker:alpha:g2:v1", resultHash: ANCHOR },
    ...overrides,
  };
  const verdict = {
    schemaVersion: FINALIZER_VERDICT_SCHEMA,
    subject: { kind: "task-result", resultHash: ANCHOR },
    decision: "go",
    finalizerKeyId: "finalizer:panel:v1",
    ...verdictOverrides,
  };
  return { ...base, finalizerVerdict: verdict } as unknown as TaskResult;
}

test("resolveFinalizerVerdictEnforcement defaults to off and validates the ladder", () => {
  assert.equal(resolveFinalizerVerdictEnforcement(undefined), "off");
  assert.equal(resolveFinalizerVerdictEnforcement("warn"), "warn");
  assert.equal(resolveFinalizerVerdictEnforcement("enforce"), "enforce");
  assert.throws(() => resolveFinalizerVerdictEnforcement("block"), /A2A_FINALIZER_VERDICT_ENFORCEMENT/);
});

test("does not apply when posture is off or the task does not opt in", () => {
  const r = resultWithVerdict();
  assert.equal(evaluateFinalizerVerdictAdmission({ task: task({ requireFinalizerVerdict: true }), result: r, enforcement: "off" }).applies, false);
  assert.equal(evaluateFinalizerVerdictAdmission({ task: task({}), result: r, enforcement: "enforce" }).applies, false);
});

test("a well-formed independent GO verdict bound to the result passes", () => {
  const r = resultWithVerdict();
  const out = evaluateFinalizerVerdictAdmission({ task: task({ requireFinalizerVerdict: true }), result: r, enforcement: "enforce" });
  assert.equal(out.applies, true);
  assert.equal(out.ok, true, JSON.stringify(out.violations));
  assert.deepEqual(out.violations, []);
});

test("absent, wrong-schema, and non-go verdicts are violations", () => {
  const t = task({ requireFinalizerVerdict: true });
  assert.ok(evaluateFinalizerVerdictAdmission({ task: t, result: { summary: "x" } as TaskResult, enforcement: "enforce" }).violations.some((v) => /absent/.test(v)));
  assert.ok(evaluateFinalizerVerdictAdmission({ task: t, result: resultWithVerdict({}, { schemaVersion: "a2a.finalizer.verdict.v2" }), enforcement: "enforce" }).violations.some((v) => /schema/.test(v)));
  assert.ok(evaluateFinalizerVerdictAdmission({ task: t, result: resultWithVerdict({}, { decision: "no-go" }), enforcement: "enforce" }).violations.some((v) => /go/.test(v)));
});

test("subject-binding: a verdict bound to a different hash than the provenance anchor is rejected", () => {
  const t = task({ requireFinalizerVerdict: true });
  const r = resultWithVerdict({}, { subject: { kind: "task-result", resultHash: "sha256:someotherresult" } });
  const out = evaluateFinalizerVerdictAdmission({ task: t, result: r, enforcement: "enforce" });
  assert.ok(out.violations.some((v) => /subject/.test(v)), JSON.stringify(out.violations));
});

test("subject-binding: a verdict-requiring completion with no provenance anchor cannot bind (fail-closed)", () => {
  const t = task({ requireFinalizerVerdict: true });
  // no provenance on the result → nothing to bind the verdict against
  const r = resultWithVerdict({ provenance: undefined });
  const out = evaluateFinalizerVerdictAdmission({ task: t, result: r, enforcement: "enforce" });
  assert.ok(out.violations.some((v) => /subject/.test(v) && /provenance/.test(v)), JSON.stringify(out.violations));
});

test("independence: a finalizerKeyId in the worker namespace or equal to the producing key is rejected", () => {
  const t = task({ requireFinalizerVerdict: true });
  // wrong namespace (a worker key masquerading as finalizer)
  const wrongNs = resultWithVerdict({}, { finalizerKeyId: "worker:alpha:g2:v1" });
  assert.ok(evaluateFinalizerVerdictAdmission({ task: t, result: wrongNs, enforcement: "enforce" }).violations.some((v) => /independen/i.test(v)));
  // finalizer key equal to the producing worker key from provenance (dual-role)
  const dual = resultWithVerdict(
    { provenance: { workerKeyId: "finalizer:panel:v1", resultHash: ANCHOR } },
    {},
  );
  assert.ok(evaluateFinalizerVerdictAdmission({ task: t, result: dual, enforcement: "enforce" }).violations.some((v) => /independen/i.test(v)));
});

test("warn posture reports the same violations without marking them blocking (caller decides)", () => {
  const t = task({ requireFinalizerVerdict: true });
  const out = evaluateFinalizerVerdictAdmission({ task: t, result: { summary: "x" } as TaskResult, enforcement: "warn" });
  assert.equal(out.applies, true);
  assert.equal(out.ok, false);
  assert.ok(out.violations.length > 0);
});
