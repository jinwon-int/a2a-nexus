// Broker-owned anonymous memory injection (#1373 K1) — unit + integration.
// Opt-in via payload.injectKnowledge; deterministic asOf-pinned snapshot;
// fail-closed structural gate at load; fail-open per task.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INJECTED_KNOWLEDGE_SCHEMA,
  MAX_INJECTED_HINTS,
  resolveInjectedKnowledgeTaskClass,
  selectInjectedKnowledge,
  validateInjectedKnowledgeSnapshot,
  type InjectedKnowledgeSnapshot,
} from "./core/broker-knowledge-injection.js";
import { startTestServer, jsonHeaders, workerPayload } from "./server-test-helpers.js";

function snapshot(overrides: Partial<InjectedKnowledgeSnapshot> & Record<string, unknown> = {}): InjectedKnowledgeSnapshot {
  return validateInjectedKnowledgeSnapshot({
    schemaVersion: INJECTED_KNOWLEDGE_SCHEMA,
    asOf: "2026-07-07",
    source: "reliability-ledger+taxonomy",
    hints: [
      { taskClass: "analyze", text: "adapterClass=hermes-analysis taskClass=analyze: substantive 4/10 last window" },
      { text: "failureClass environment recurred 3 consecutive rounds" },
      { taskClass: "review", text: "adapterClass=hermes-analysis taskClass=review: substantive 7/10" },
    ],
    ...overrides,
  });
}

function snapshotFile(doc: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "k1-knowledge-"));
  const file = join(dir, "injected-knowledge.json");
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

// --- structural gate (K1-b) ---

test("snapshot validation fails closed on unknown fields, bad asOf, and identifier/secret shapes", () => {
  assert.throws(() => snapshot({ extra: 1 } as never), /unknown field 'extra'/);
  assert.throws(() => snapshot({ asOf: "yesterday" }), /asOf must be a YYYY-MM-DD/);
  assert.throws(
    () => snapshot({ hints: [{ text: "see https://internal.example/x" }] }),
    /forbidden pattern/,
  );
  assert.throws(
    () => snapshot({ hints: [{ text: "ssh to worker-alpha and retry" }] }),
    /forbidden pattern/,
  );
  assert.throws(
    () => snapshot({ hints: [{ text: `token ghp_${"a".repeat(24)}` }] }),
    /forbidden pattern/,
  );
  assert.throws(
    () => snapshot({ hints: [{ text: "ok", note: "x" }] } as never),
    /unknown field 'note'/,
  );
});

// --- deterministic selection (K1-a) ---

test("selection is intent-matched, order-preserving, capped, and asOf-pinned", () => {
  const snap = snapshot();
  const selected = selectInjectedKnowledge(snap, "analyze");
  assert.ok(selected);
  assert.equal(selected.asOf, "2026-07-07");
  assert.deepEqual(selected.hints, [
    "adapterClass=hermes-analysis taskClass=analyze: substantive 4/10 last window",
    "failureClass environment recurred 3 consecutive rounds",
  ]);
  // determinism: same snapshot + same intent => same hints
  assert.deepEqual(selectInjectedKnowledge(snap, "analyze"), selected);
  // no matching hints and no classless hints => undefined (no empty blocks)
  const none = selectInjectedKnowledge(
    snapshot({ hints: [{ taskClass: "review", text: "adapterClass=x taskClass=review: substantive 1/2" }] }),
    "analyze",
  );
  assert.equal(none, undefined);
  // cap
  const many = snapshot({
    hints: Array.from({ length: 20 }, (_, i) => ({ text: `hint number ${i} counts-only` })),
  });
  assert.equal(selectInjectedKnowledge(many, "analyze")?.hints.length, MAX_INJECTED_HINTS);
});

// --- matching key: payload.taskClass overrides intent (#1373 K1-d follow-up) ---
// The ledger/snapshot taskClass axis is a lane classification, not the task
// intent: substantive review lanes dispatch as intent "analyze" (the worker
// analysis-bridge routing key) with the lane class declared separately.
// Matching on intent alone made "hints match" and "worker runs analysis"
// mutually exclusive for review lanes.

test("payload.taskClass is the hint matching key when present; intent stays the fallback", () => {
  const snap = snapshot();
  // review lane dispatched the working way: intent analyze + declared class review
  assert.equal(resolveInjectedKnowledgeTaskClass("analyze", { taskClass: "review" }), "review");
  const selected = selectInjectedKnowledge(snap, resolveInjectedKnowledgeTaskClass("analyze", { taskClass: "review" }));
  assert.ok(selected);
  assert.deepEqual(selected.hints, [
    "failureClass environment recurred 3 consecutive rounds",
    "adapterClass=hermes-analysis taskClass=review: substantive 7/10",
  ]);
  // fallback: no payload / no taskClass / non-string or blank taskClass => intent
  assert.equal(resolveInjectedKnowledgeTaskClass("analyze", undefined), "analyze");
  assert.equal(resolveInjectedKnowledgeTaskClass("analyze", {}), "analyze");
  assert.equal(resolveInjectedKnowledgeTaskClass("analyze", { taskClass: 7 }), "analyze");
  assert.equal(resolveInjectedKnowledgeTaskClass("analyze", { taskClass: "   " }), "analyze");
});

// --- broker integration ---

test("opt-in task creation injects hints into policyContext; default stays unchanged (#1373)", async () => {
  const file = snapshotFile({
    schemaVersion: INJECTED_KNOWLEDGE_SCHEMA,
    asOf: "2026-07-07",
    source: "reliability-ledger+taxonomy",
    hints: [{ taskClass: "analyze", text: "adapterClass=hermes-analysis taskClass=analyze: substantive 4/10 last window" }],
  });
  const server = await startTestServer({ enforceRequesterIdentity: false, injectedKnowledgeFile: file });
  try {
    const res = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST", headers: jsonHeaders(), body: JSON.stringify(workerPayload("workerbeta")),
    });
    assert.ok(res.status === 200 || res.status === 201);

    const makeTask = (id: string, payload?: Record<string, unknown>) => fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        id,
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workerbeta", kind: "node", role: "analyst" },
        targetNodeId: "workerbeta",
        message: "injection test",
        taskOrigin: "api",
        ...(payload ? { payload } : {}),
      }),
    });

    const optIn = await makeTask("k1-opt-in", { injectKnowledge: true });
    assert.equal(optIn.status, 201);
    const created = await optIn.json() as {
      policyContext?: { injectedKnowledge?: { source: string; asOf: string; hints: string[] } };
    };
    assert.ok(created.policyContext?.injectedKnowledge, "opt-in must inject");
    assert.equal(created.policyContext.injectedKnowledge.asOf, "2026-07-07");
    assert.equal(created.policyContext.injectedKnowledge.source, "reliability-ledger+taxonomy");
    assert.equal(created.policyContext.injectedKnowledge.hints.length, 1);

    const noOptIn = await makeTask("k1-no-opt-in");
    assert.equal(noOptIn.status, 201);
    const plain = await noOptIn.json() as { policyContext?: { injectedKnowledge?: unknown } };
    assert.equal(plain.policyContext?.injectedKnowledge, undefined, "no opt-in => unchanged");
  } finally {
    await server.close();
  }
});

test("intent analyze + payload.taskClass review matches review-class hints end-to-end", async () => {
  const file = snapshotFile({
    schemaVersion: INJECTED_KNOWLEDGE_SCHEMA,
    asOf: "2026-07-07",
    source: "reliability-ledger+taxonomy",
    hints: [{ taskClass: "review", text: "adapterClass=hermes-analysis taskClass=review: substantive 7/10" }],
  });
  const server = await startTestServer({ enforceRequesterIdentity: false, injectedKnowledgeFile: file });
  try {
    const res = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST", headers: jsonHeaders(), body: JSON.stringify(workerPayload("workerbeta")),
    });
    assert.ok(res.status === 200 || res.status === 201);
    const created = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        id: "k1-task-class-key",
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workerbeta", kind: "node", role: "analyst" },
        targetNodeId: "workerbeta",
        message: "injection test",
        taskOrigin: "api",
        payload: { injectKnowledge: true, taskClass: "review" },
      }),
    });
    assert.equal(created.status, 201);
    const body = await created.json() as {
      policyContext?: { injectedKnowledge?: { asOf: string; hints: string[] } };
    };
    assert.ok(body.policyContext?.injectedKnowledge, "declared lane class must match review hints");
    assert.deepEqual(body.policyContext.injectedKnowledge.hints, [
      "adapterClass=hermes-analysis taskClass=review: substantive 7/10",
    ]);
  } finally {
    await server.close();
  }
});

test("no snapshot configured => opt-in flag is a no-op (fail-open, legacy behavior)", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const res = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST", headers: jsonHeaders(), body: JSON.stringify(workerPayload("workerbeta")),
    });
    assert.ok(res.status === 200 || res.status === 201);
    const created = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({ "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        id: "k1-no-snapshot",
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "workerbeta", kind: "node", role: "analyst" },
        targetNodeId: "workerbeta",
        message: "injection test",
        taskOrigin: "api",
        payload: { injectKnowledge: true },
      }),
    });
    assert.equal(created.status, 201, "task proceeds hint-less");
    const body = await created.json() as { policyContext?: { injectedKnowledge?: unknown } };
    assert.equal(body.policyContext?.injectedKnowledge, undefined);
  } finally {
    await server.close();
  }
});

test("a configured-but-invalid snapshot fails startup loudly (#1373 load gate)", async () => {
  const file = snapshotFile({
    schemaVersion: INJECTED_KNOWLEDGE_SCHEMA,
    asOf: "2026-07-07",
    source: "reliability-ledger+taxonomy",
    hints: [{ text: "escalate via https://internal.example/runbook" }],
  });
  await assert.rejects(
    () => startTestServer({ enforceRequesterIdentity: false, injectedKnowledgeFile: file }),
    /forbidden pattern/,
  );
});
