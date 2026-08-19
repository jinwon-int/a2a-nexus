import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import {
  parseTaskAcceptance,
  runTaskAcceptance,
  normalizeBridgeAcceptanceReport,
  validateAcceptanceEvidence,
  DEFAULT_ACCEPTANCE_TIMEOUT_MS,
  LEGACY_SINGLETON_ACCEPTANCE_CUTOFF_ISO,
} from "./worker-acceptance.js";
import { A2ABrokerWorker, createBuiltinWorkerHandler, validateTaskCompletionEvidence } from "./worker.js";
import { createBrokerServer } from "./server.js";
import { emptySnapshot, type BrokerStateStore } from "./core/store.js";
import type { TaskRecord, TaskResult } from "./core/types.js";

const EDGE_SECRET = "acceptance-test-edge-secret";

function taskWith(payload: Record<string, unknown>): TaskRecord {
  return {
    id: "task-acceptance-1",
    intent: "analyze",
    status: "running",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    payload,
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
  } as unknown as TaskRecord;
}

const passingAcceptance = { command: [process.execPath, "-e", "process.exit(0)"] };
const failingAcceptance = { command: [process.execPath, "-e", "process.exit(3)"] };

// ---------------------------------------------------------------------------
// parseTaskAcceptance
// ---------------------------------------------------------------------------

test("parse: absent acceptance is null", () => {
  assert.equal(parseTaskAcceptance(taskWith({})), null);
});

test("parse: valid acceptance applies defaults", () => {
  const parsed = parseTaskAcceptance(taskWith({ acceptance: passingAcceptance }));
  assert.ok(parsed && parsed.spec);
  assert.equal(parsed.spec.expectExitCode, 0);
  assert.equal(parsed.spec.timeoutMs, DEFAULT_ACCEPTANCE_TIMEOUT_MS);
});

test("parse: malformed acceptance fails closed instead of being ignored", () => {
  for (const bad of [
    { acceptance: "npm run check" },
    { acceptance: { command: [] } },
    { acceptance: { command: ["ok"], expectExitCode: 1.5 } },
    { acceptance: { command: ["ok"], timeoutMs: -1 } },
  ]) {
    const parsed = parseTaskAcceptance(taskWith(bad));
    assert.ok(parsed && parsed.error, JSON.stringify(bad));
    assert.equal(parsed.error?.code, "acceptance_malformed");
  }
});

// ---------------------------------------------------------------------------
// runTaskAcceptance
// ---------------------------------------------------------------------------

test("run: exit 0 passes and records metrics", () => {
  const validation = runTaskAcceptance({ command: passingAcceptance.command, expectExitCode: 0, timeoutMs: 30_000 });
  assert.equal(validation.verdict, "pass");
  assert.equal(validation.metrics?.exitCode, 0);
  assert.equal(validation.metrics?.acceptance, true);
});

test("run: unexpected exit code fails; explicit expectExitCode passes", () => {
  const fail = runTaskAcceptance({ command: failingAcceptance.command, expectExitCode: 0, timeoutMs: 30_000 });
  assert.equal(fail.verdict, "fail");
  assert.equal(fail.metrics?.exitCode, 3);
  const pass = runTaskAcceptance({ command: failingAcceptance.command, expectExitCode: 3, timeoutMs: 30_000 });
  assert.equal(pass.verdict, "pass");
});

test("run: timeout fails with timedOut metric", () => {
  const validation = runTaskAcceptance({
    command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    expectExitCode: 0,
    timeoutMs: 250,
  });
  assert.equal(validation.verdict, "fail");
  assert.equal(validation.metrics?.timedOut, true);
});

// ---------------------------------------------------------------------------
// completion-evidence rule (fail-closed)
// ---------------------------------------------------------------------------

test("evidence: acceptance task without validation is rejected", () => {
  const error = validateAcceptanceEvidence(taskWith({ acceptance: passingAcceptance }), { summary: "did the work" });
  assert.ok(error);
  assert.equal(error.code, "acceptance_evidence_missing");
});

test("evidence: passing validation satisfies the rule; failing verdict does not", () => {
  const task = taskWith({ acceptance: passingAcceptance });
  assert.equal(validateAcceptanceEvidence(task, { validation: { kind: "smoke", verdict: "pass" } }), null);
  const error = validateAcceptanceEvidence(task, { validation: { kind: "smoke", verdict: "fail" } });
  assert.ok(error);
});

test("evidence: validations array requires a smoke item for acceptance (#1249)", () => {
  const task = taskWith({ acceptance: passingAcceptance });
  assert.equal(
    validateAcceptanceEvidence(task, {
      validations: [
        { nodeId: "reviewer-b", kind: "review", verdict: "pass", note: "diff matches spec" },
        { kind: "smoke", verdict: "pass", metrics: { acceptance: true } },
      ],
    }),
    null,
  );

  const error = validateAcceptanceEvidence(task, {
    validations: [{ nodeId: "reviewer-b", kind: "review", verdict: "pass", note: "review only" }],
  });
  assert.equal(error?.code, "acceptance_evidence_missing");
  assert.match(error?.message ?? "", /result\.validations.*smoke/);
});

test("evidence: legacy singleton non-smoke validation remains compatible but warns before cutoff (#1249 phase 1)", () => {
  const task = taskWith({ acceptance: passingAcceptance });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    assert.equal(
      validateAcceptanceEvidence(task, {
        validation: { nodeId: "reviewer-b", kind: "review", verdict: "pass", note: "legacy review verdict" },
      }),
      null,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /legacy_acceptance_validation_kind_mismatch/);
});

test("evidence: legacy singleton non-smoke validation is rejected after cutoff (#1252)", () => {
  const task = {
    ...taskWith({ acceptance: passingAcceptance }),
    createdAt: LEGACY_SINGLETON_ACCEPTANCE_CUTOFF_ISO,
    updatedAt: LEGACY_SINGLETON_ACCEPTANCE_CUTOFF_ISO,
  } as TaskRecord;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    const error = validateAcceptanceEvidence(task, {
      validation: { nodeId: "reviewer-b", kind: "review", verdict: "pass", note: "legacy review verdict" },
    });
    assert.equal(error?.code, "acceptance_evidence_missing");
    assert.match(error?.message ?? "", /cutoff requires/);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0);
});

test("evidence: singleton smoke validation after cutoff remains valid without requiring metrics", () => {
  const task = {
    ...taskWith({ acceptance: passingAcceptance }),
    createdAt: LEGACY_SINGLETON_ACCEPTANCE_CUTOFF_ISO,
    updatedAt: LEGACY_SINGLETON_ACCEPTANCE_CUTOFF_ISO,
  } as TaskRecord;
  assert.equal(validateAcceptanceEvidence(task, { validation: { kind: "smoke", verdict: "pass" } }), null);
});

test("evidence: worker completion validator enforces acceptance (red before wiring)", () => {
  const error = validateTaskCompletionEvidence(taskWith({ acceptance: passingAcceptance }), { summary: "no validation" });
  assert.ok(error, "acceptance-bearing task must not complete without a passing validation payload");
  assert.equal(error?.code, "acceptance_evidence_missing");
});

// ---------------------------------------------------------------------------
// integration: real broker + worker runOnce
// ---------------------------------------------------------------------------

function createInMemoryStateStore(): BrokerStateStore {
  let snapshot = emptySnapshot();
  return {
    load: () => snapshot,
    save: (next) => {
      snapshot = structuredClone(next);
    },
  };
}

async function startTestServer() {
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: createInMemoryStateStore(),
    edgeSecret: EDGE_SECRET,
    staleReaperEnabled: false,
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      runtime.server.close();
      await once(runtime.server, "close");
    },
  };
}

function createAcceptanceWorker(baseUrl: string) {
  return new A2ABrokerWorker({
    brokerUrl: baseUrl,
    edgeSecret: EDGE_SECRET,
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Acceptance Worker",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    },
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 1000,
    handlerTimeoutMs: 10_000,
    pollReadinessProbe: false,
    userAgent: "acceptance-contract-test",
    handler: createBuiltinWorkerHandler("echo"),
  });
}

async function createTaskOverHttp(baseUrl: string, acceptance: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-a2a-edge-secret": EDGE_SECRET,
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    },
    body: JSON.stringify({
      intent: "analyze",
      message: "acceptance contract round trip",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      payload: { acceptance },
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return JSON.parse(body) as TaskRecord;
}

async function getTaskOverHttp(baseUrl: string, taskId: string): Promise<TaskRecord> {
  const response = await fetch(`${baseUrl}/tasks/${taskId}`, {
    headers: { "x-a2a-edge-secret": EDGE_SECRET, "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" },
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body) as TaskRecord;
}

test("integration: worker runs passing acceptance and completes with validation evidence", async () => {
  const server = await startTestServer();
  const worker = createAcceptanceWorker(server.baseUrl);
  try {
    await worker.register();
    const created = await createTaskOverHttp(server.baseUrl, passingAcceptance);
    const handled = await worker.runOnce();
    assert.equal(handled, 1);
    const finished = await getTaskOverHttp(server.baseUrl, created.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.result?.validation?.verdict, "pass");
    assert.equal(finished.result?.validation?.metrics?.acceptance, true);
  } finally {
    await worker.stop().catch(() => {});
    await server.close();
  }
});

test("integration: failing acceptance fails the task instead of completing it", async () => {
  const server = await startTestServer();
  const worker = createAcceptanceWorker(server.baseUrl);
  try {
    await worker.register();
    const created = await createTaskOverHttp(server.baseUrl, failingAcceptance);
    const handled = await worker.runOnce();
    assert.equal(handled, 1);
    const finished = await getTaskOverHttp(server.baseUrl, created.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.error?.code, "acceptance_failed");
  } finally {
    await worker.stop().catch(() => {});
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// normalizeBridgeAcceptanceReport (#1904)
// ---------------------------------------------------------------------------

test("bridge report: a valid bridge-executed verdict normalizes to a smoke validation", () => {
  const report = normalizeBridgeAcceptanceReport({
    status: "pr_opened",
    acceptance: {
      kind: "smoke",
      verdict: "pass",
      metrics: { acceptance: true, exitCode: 0, expectedExitCode: 0, durationMs: 12, timedOut: false },
      note: "acceptance passed: grep -qi disposable README.md",
      acceptanceContext: "piri-host-patch-clone",
    },
  } as unknown as TaskResult);
  assert.equal(report?.kind, "smoke");
  assert.equal(report?.verdict, "pass");
  assert.equal(report?.metrics?.exitCode, 0);
  assert.match(report?.note ?? "", /acceptance passed/);
});

test("bridge report: fail verdict keeps its note; malformed reports return null", () => {
  const failing = normalizeBridgeAcceptanceReport({
    acceptance: {
      kind: "smoke",
      verdict: "fail",
      metrics: { exitCode: 1, expectedExitCode: 0 },
      note: "acceptance failed (exit 1, expected 0): grep x README.md",
    },
  } as unknown as TaskResult);
  assert.equal(failing?.verdict, "fail");
  assert.match(failing?.note ?? "", /acceptance failed/);

  assert.equal(normalizeBridgeAcceptanceReport(undefined), null);
  assert.equal(normalizeBridgeAcceptanceReport({} as TaskResult), null);
  assert.equal(
    normalizeBridgeAcceptanceReport({ acceptance: { verdict: "maybe" } } as unknown as TaskResult),
    null,
  );
  // A non-record metrics field still normalizes to defaulted metrics, not a null.
  const defaulted = normalizeBridgeAcceptanceReport({
    acceptance: { verdict: "pass", metrics: "nope" },
  } as unknown as TaskResult);
  assert.equal(defaulted?.verdict, "pass");
  assert.equal(defaulted?.metrics?.exitCode, -1);
});

test("bridge report: the nested result.output.acceptance position is also accepted (#1910 follow-up)", () => {
  // a2a-task-handler.mjs runOpenClawBridge maps the bridge response into
  // result.output; the verdict arrives at result.output.acceptance, not at
  // result.acceptance. Both positions must normalize.
  const nested = normalizeBridgeAcceptanceReport({
    output: {
      prUrl: "https://github.com/x/y/pull/1",
      acceptance: {
        kind: "smoke",
        verdict: "pass",
        metrics: { exitCode: 0, expectedExitCode: 0, durationMs: 5, timedOut: false },
        note: "acceptance passed: grep -q fleet operator README.md",
      },
    },
  } as unknown as TaskResult);
  assert.equal(nested?.verdict, "pass");
  assert.equal(nested?.kind, "smoke");
  assert.match(nested?.note ?? "", /acceptance passed/);
});
