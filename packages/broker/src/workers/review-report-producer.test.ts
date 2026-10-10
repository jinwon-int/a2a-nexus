import assert from "node:assert/strict";
import test from "node:test";

import { SqliteBrokerStateStore } from "../core/store.js";
import type { TaskRecord, TaskResult } from "../core/types.js";
import { findingSignature, intentHash } from "../review-lifecycle/canonical-json.js";
import { authorizeReviewerReviewLineageReport } from "../review-lifecycle/review-report-source.js";
import { A2A_WORKER_ROUTE_SCOPES } from "../core/request-security.js";
import { jsonHeaders, startTestServer } from "../server-test-helpers.js";
import { A2ABrokerWorker } from "../worker.js";
import { deriveFindingId, planReviewReport } from "./review-report-producer.js";

const WORKER = "reviewerbeta";
const AUTHOR = "authoralpha";
// Lineage wall-clock budget (BUDGET.maxWallClockSeconds = 6h) is checked
// against the broker's real clock, so the contract must start relative to
// "now" — a fixed 2026-10-09T12:00Z start blocked every run after 18:00Z
// that day (budget_wall_clock → blocked_needs_operator).
const START = new Date(Date.now() - 60 * 60 * 1000);
const START_ISO = START.toISOString().replace(/\.\d{3}Z$/, "Z");
const NOW = () => new Date(START.getTime() + 60 * 60 * 1000);
const DIFF = `sha256:${"c".repeat(64)}`;

function contract(lineageId: string) {
  const partial = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: "Report reviewer verdicts to the lineage.",
    nonGoals: ["Do not infer findings from prose."],
    invariants: ["Task completion is unchanged."],
    acceptanceCriteria: [{ id: "AC-1", text: "Signed reports reach the lineage." }],
    declaredPaths: { allowed: ["packages/broker/src/**"] },
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    createdAt: START_ISO,
  };
  return { ...partial, intentHash: intentHash(partial as unknown as Record<string, unknown>) };
}

function binding(lineageId: string) {
  const c = contract(lineageId);
  return { lineageId, intentHash: c.intentHash, headSha: c.headSha, diffHash: DIFF };
}

function task(payload: Record<string, unknown>, id = "task-2351"): TaskRecord {
  return { id, payload } as unknown as TaskRecord;
}

function reviewResult(verdict: "pass" | "fail", output: Record<string, unknown> = {}, nodeId = WORKER): TaskResult {
  return {
    summary: `review ${verdict}`,
    output: { findings: ["free text finding"], ...output },
    validations: [{ kind: "review", nodeId, verdict, note: `Reviewer verdict ${verdict} with evidence.` }],
  } as TaskResult;
}

const blockingFinding = {
  criterionRef: "AC-1",
  evidenceRefs: ["packages/broker/src/workers/broker-worker-client.ts:552"],
  severity: "major",
  category: "correctness",
  blocking: true,
};

// ─── plan ───────────────────────────────────────────────────────────────────

test("no reviewLineage binding means no report and no log", () => {
  assert.deepEqual(planReviewReport({ task: task({}), result: reviewResult("pass"), workerId: WORKER }), { kind: "none" });
});

test("a malformed binding is a visible skip", () => {
  const plan = planReviewReport({
    task: task({ reviewLineage: { ...binding("l1"), extra: 1 } }), result: reviewResult("pass"), workerId: WORKER,
  });
  assert.equal(plan.kind, "skip");
  assert.equal(plan.kind === "skip" && plan.reason, "binding_invalid");
});

test("pass without a structured block is a complete report bound to the worker identity", () => {
  const plan = planReviewReport({
    task: task({ reviewLineage: binding("l1"), review: { required: true, authorWorkerId: AUTHOR } }),
    result: reviewResult("pass"), workerId: WORKER, now: NOW,
  });
  assert.equal(plan.kind, "report");
  if (plan.kind !== "report") return;
  const { request } = plan;
  assert.equal(request.reportRef, "task:task-2351");
  assert.equal(request.receipt.reviewerNodeId, WORKER);
  assert.equal(request.receipt.authorWorkerId, AUTHOR);
  assert.equal(request.receipt.findingLedgerRef, "ledger-l1");
  assert.equal(request.receipt.submittedAt, NOW().toISOString());
  assert.deepEqual(request.newFindings, []);
  // The canonical broker parser accepts it with the worker as trusted issuer.
  assert.doesNotThrow(() => authorizeReviewerReviewLineageReport("l1", request, WORKER));
  assert.throws(() => authorizeReviewerReviewLineageReport("l1", request, "someoneelse"));
});

test("fail without a structured block is not reported (no invented findings)", () => {
  const plan = planReviewReport({ task: task({ reviewLineage: binding("l1") }), result: reviewResult("fail"), workerId: WORKER });
  assert.equal(plan.kind === "skip" && plan.reason, "structured_findings_missing");
});

test("fail with structured findings maps to canonical FindingV1 with deterministic ids", () => {
  const structured = {
    newFindings: [blockingFinding, { ...blockingFinding, category: "style", blocking: true, severity: "minor" }],
    resolvedFindingIds: [],
    reopenedFindingIds: [],
  };
  const plan = planReviewReport({
    task: task({ reviewLineage: binding("l1") }), result: reviewResult("fail", { reviewLineage: structured }),
    workerId: WORKER, now: NOW,
  });
  assert.equal(plan.kind, "report");
  if (plan.kind !== "report") return;
  const [first, second] = plan.request.newFindings;
  assert.equal(first.findingId, deriveFindingId("task:task-2351", 0));
  assert.match(first.findingId, /^F-[0-9]+$/);
  assert.notEqual(first.findingId, second.findingId);
  assert.equal(first.signature, findingSignature(blockingFinding));
  assert.equal(first.introducedAtHead, "b".repeat(40));
  assert.equal(first.disposition, "open");
  assert.equal(second.blocking, false, "style findings never block");
  assert.doesNotThrow(() => authorizeReviewerReviewLineageReport("l1", plan.request, WORKER));
});

test("skips: identity mismatch, self-review, invalid structured block, missing verdict", () => {
  const cases: Array<[Parameters<typeof planReviewReport>[0], string]> = [
    [{ task: task({ reviewLineage: binding("l1") }), result: reviewResult("pass", {}, "otherworker"), workerId: WORKER }, "reviewer_identity_mismatch"],
    [{ task: task({ reviewLineage: binding("l1"), review: { authorWorkerId: WORKER } }), result: reviewResult("pass"), workerId: WORKER }, "author_is_reviewer"],
    [{ task: task({ reviewLineage: binding("l1") }), result: reviewResult("fail", { reviewLineage: { newFindings: [{ ...blockingFinding, evidenceRefs: [] }], resolvedFindingIds: [], reopenedFindingIds: [] } }), workerId: WORKER }, "structured_findings_invalid"],
    [{ task: task({ reviewLineage: binding("l1") }), result: { summary: "x" } as TaskResult, workerId: WORKER }, "review_validation_missing"],
  ];
  for (const [input, reason] of cases) {
    const plan = planReviewReport(input);
    assert.equal(plan.kind === "skip" && plan.reason, reason, reason);
  }
});

// ─── real broker + signed worker ────────────────────────────────────────────

const privateJwk = {
  crv: "Ed25519",
  d: "AaTuhLv-jaClRWi80aTnBCH7OaqKDTRI1-BhVY6n8hw",
  x: "5WS0NM-6IqCFjg6O1otAWtJV2H-1kdybf7nFp4PEzdY",
  kty: "OKP",
};
const publicJwk = { crv: "Ed25519", x: privateJwk.x, kty: "OKP" };
const BUDGET = {
  kind: "ReviewLineageBudgetV1",
  maxWallClockSeconds: 21_600,
  maxCorrectionGenerations: 1,
  maxReviewerRuns: 2,
  maxReviewerReplacements: 1,
  repeatedFindingThreshold: 2,
  onExhaustion: "blocked_needs_operator",
};

async function harness(options: { mode?: "record" | "off"; scopes?: readonly string[] } = {}) {
  const scopes = options.scopes ?? A2A_WORKER_ROUTE_SCOPES;
  const server = await startTestServer({
    brokerId: "brokeralpha",
    stateStore: new SqliteBrokerStateStore(":memory:"),
    reviewLineageMode: options.mode ?? "record",
    a2aHttpSignatureWorkerAuth: "strict",
    a2aHttpSignatureKeyRegistry: {
      [`worker:${WORKER}:v1`]: { keyid: `worker:${WORKER}:v1`, workerId: WORKER, publicKeyJwk: publicJwk, scopes },
    } as never,
  });
  const operator = jsonHeaders({ "x-a2a-requester-id": "operatoralpha", "x-a2a-requester-role": "operator" });
  const hub = jsonHeaders({ "x-a2a-requester-id": "hubalpha", "x-a2a-requester-role": "hub" });

  async function createLineage(lineageId: string) {
    const c = contract(lineageId);
    const response = await fetch(`${server.baseUrl}/review-lineages`, {
      method: "POST",
      headers: operator,
      body: JSON.stringify({
        dispatchRef: `dispatch:${lineageId}`,
        observedAt: c.createdAt,
        binding: { intentHash: c.intentHash, headSha: c.headSha, diffHash: DIFF },
        contract: c,
        budget: BUDGET,
      }),
    });
    return response.status;
  }

  async function createTask(lineageId: string) {
    const response = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hub,
      body: JSON.stringify({
        intent: "analyze",
        message: "review the lineage head",
        requester: { id: "hubalpha", kind: "node", role: "hub" },
        target: { id: WORKER, kind: "node", role: "analyst" },
        assignedWorkerId: WORKER,
        payload: { review: { required: true, authorWorkerId: AUTHOR }, reviewLineage: binding(lineageId) },
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    return (JSON.parse(body) as TaskRecord).id;
  }

  async function lineage(lineageId: string) {
    const response = await fetch(`${server.baseUrl}/review-lineages/${lineageId}`, { headers: operator });
    return response.status === 200 ? ((await response.json()) as { lineage: { state: string; counters?: unknown } }).lineage : null;
  }

  async function taskStatus(id: string) {
    const response = await fetch(`${server.baseUrl}/tasks/${id}`, { headers: hub });
    return ((await response.json()) as TaskRecord).status;
  }

  function worker(result: TaskResult) {
    return new A2ABrokerWorker({
      brokerUrl: server.baseUrl,
      worker: {
        nodeId: WORKER,
        role: "analyst",
        displayName: "Reviewer Beta",
        capabilities: {
          canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false,
          workspaceIds: ["test"], environments: ["research"],
        },
      },
      requesterKind: "node",
      pollIntervalMs: 25,
      heartbeatIntervalMs: 1000,
      handlerTimeoutMs: 10_000,
      pollReadinessProbe: false,
      userAgent: "review-report-producer-test",
      httpSignature: { keyid: `worker:${WORKER}:v1`, privateKeyJwk: privateJwk, brokerId: "brokeralpha" },
      handler: async () => result,
    });
  }

  return { server, createLineage, createTask, lineage, taskStatus, worker };
}

async function captureLogs<T>(run: () => Promise<T>): Promise<{ value: T; events: Array<Record<string, unknown>> }> {
  const events: Array<Record<string, unknown>> = [];
  const original = { log: console.log, warn: console.warn };
  const capture = (line: unknown) => {
    if (typeof line === "string" && line.includes("\"review_lineage_report\"")) events.push(JSON.parse(line));
  };
  console.log = capture;
  console.warn = capture;
  try {
    return { value: await run(), events };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
  }
}

test("signed worker: a pass verdict reports and the lineage passes; the task still succeeds", async () => {
  const h = await harness();
  const w = h.worker(reviewResult("pass"));
  try {
    await w.register();
    assert.equal(await h.createLineage("lineage-pass"), 201);
    const taskId = await h.createTask("lineage-pass");
    const { value, events } = await captureLogs(() => w.runOnce());
    assert.equal(value, 1);
    assert.equal(await h.taskStatus(taskId), "succeeded");
    assert.equal((await h.lineage("lineage-pass"))?.state, "passed");
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "reported");
    assert.equal(events[0].status, "applied");
  } finally {
    await w.stop().catch(() => {});
    await h.server.close();
  }
});

test("signed worker: a fail verdict with structured findings opens correction; the task fails on its verdict as before", async () => {
  const h = await harness();
  const structured = { newFindings: [blockingFinding], resolvedFindingIds: [], reopenedFindingIds: [] };
  const w = h.worker(reviewResult("fail", { reviewLineage: structured }));
  try {
    await w.register();
    assert.equal(await h.createLineage("lineage-fail"), 201);
    const taskId = await h.createTask("lineage-fail");
    const { events } = await captureLogs(() => w.runOnce());
    assert.equal(await h.taskStatus(taskId), "failed");
    assert.equal((await h.lineage("lineage-fail"))?.state, "correction_pending");
    assert.equal(events[0]?.outcome, "reported");
    assert.equal(events[0]?.newFindings, 1);
  } finally {
    await w.stop().catch(() => {});
    await h.server.close();
  }
});

test("signed worker: a key without the review-lineage.report scope is rejected and the task is unaffected", async () => {
  const h = await harness({ scopes: A2A_WORKER_ROUTE_SCOPES.filter((scope) => scope !== "review-lineage.report") });
  const w = h.worker(reviewResult("pass"));
  try {
    await w.register();
    assert.equal(await h.createLineage("lineage-noscope"), 201);
    const taskId = await h.createTask("lineage-noscope");
    const { events } = await captureLogs(() => w.runOnce());
    assert.equal(await h.taskStatus(taskId), "succeeded");
    assert.equal((await h.lineage("lineage-noscope"))?.state, "reviewing_initial");
    assert.equal(events[0]?.outcome, "rejected");
  } finally {
    await w.stop().catch(() => {});
    await h.server.close();
  }
});

test("signed worker: an off-mode broker refuses the report and the task is unaffected", async () => {
  const h = await harness({ mode: "off" });
  const w = h.worker(reviewResult("pass"));
  try {
    await w.register();
    const taskId = await h.createTask("lineage-off");
    const { events } = await captureLogs(() => w.runOnce());
    assert.equal(await h.taskStatus(taskId), "succeeded");
    assert.equal(events[0]?.outcome, "rejected");
  } finally {
    await w.stop().catch(() => {});
    await h.server.close();
  }
});
