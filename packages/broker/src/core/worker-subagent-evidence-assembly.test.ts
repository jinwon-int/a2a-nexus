import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildA2AWorkerSubagentEvidenceAssembly,
  extractA2AWorkerSubagentEvidenceAssemblyInput,
  renderA2AWorkerSubagentEvidenceAssemblyMarkdown,
  type A2AWorkerSubagentEvidenceEntryInput,
} from "./worker-subagent-evidence-assembly.js";

const NOW = "2026-05-19T02:40:00.000Z";

const ENTRIES: A2AWorkerSubagentEvidenceEntryInput[] = [
  { role: "verifier", id: "ev-verify", status: "complete", summary: "tests pass" },
  { role: "implementer", id: "ev-impl-a", writeSet: ["src/b.ts", "src/a.ts"], status: "complete", summary: "edited a,b" },
  { role: "explorer", id: "ev-explore", status: "complete", summary: "mapped module" },
];

test("source carrier contains no raw NUL bytes", () => {
  const source = readFileSync("src/core/worker-subagent-evidence-assembly.ts", "utf8");
  assert.equal(source.includes("\u0000"), false);
  assert.match(source, /join\("\\u0000"\)/);
});

test("stable ordering: different input order yields identical digest and order", () => {
  const forward = buildA2AWorkerSubagentEvidenceAssembly({ now: NOW, workerId: "workergamma", taskId: "task-1", entries: ENTRIES });
  const reversed = buildA2AWorkerSubagentEvidenceAssembly({ now: NOW, workerId: "workergamma", taskId: "task-1", entries: [...ENTRIES].reverse() });

  assert.equal(forward.determinism.contentDigest, reversed.determinism.contentDigest);
  assert.equal(forward.idempotencyKey, reversed.idempotencyKey);
  assert.deepEqual(
    forward.assembledEvidence.map((e) => e.id),
    reversed.assembledEvidence.map((e) => e.id),
  );
  // deterministic content order is by role: explorer < implementer < verifier
  assert.deepEqual(forward.assembledEvidence.map((e) => e.role), ["explorer", "implementer", "verifier"]);
});

test("digest is stable across generatedAt (time excluded from the anchor)", () => {
  const t1 = buildA2AWorkerSubagentEvidenceAssembly({ now: NOW, workerId: "w", entries: ENTRIES });
  const t2 = buildA2AWorkerSubagentEvidenceAssembly({ now: "2027-01-01T00:00:00.000Z", workerId: "w", entries: ENTRIES });
  assert.equal(t1.determinism.contentDigest, t2.determinism.contentDigest);
  assert.equal(t1.idempotencyKey, t2.idempotencyKey);
  assert.notEqual(t1.generatedAt, t2.generatedAt);
  assert.match(t1.determinism.contentDigest, /^sha256:[0-9a-f]{64}$/);
});

test("write sets are normalized (sorted) so member order does not change the digest", () => {
  const a = buildA2AWorkerSubagentEvidenceAssembly({ now: NOW, workerId: "w", entries: [{ role: "implementer", id: "i", writeSet: ["src/a.ts", "src/b.ts"] }] });
  const b = buildA2AWorkerSubagentEvidenceAssembly({ now: NOW, workerId: "w", entries: [{ role: "implementer", id: "i", writeSet: ["src/b.ts", "src/a.ts"] }] });
  assert.equal(a.determinism.contentDigest, b.determinism.contentDigest);
  assert.deepEqual(a.assembledEvidence[0].writeSet, ["src/a.ts", "src/b.ts"]);
});

test("execution graph records finalizer + one node per sub-agent with spawn/evidence edges", () => {
  const packet = buildA2AWorkerSubagentEvidenceAssembly({
    now: NOW,
    workerId: "workergamma",
    entries: ENTRIES,
    execution: { gateDecisionIdempotencyKey: "a2a-worker-subagent-spawn-gate-decision:abc", authorizedSubagentCount: 3, parallelismUsed: 3 },
  });

  assert.equal(packet.executionGraph.nodes.length, ENTRIES.length + 1);
  assert.equal(packet.executionGraph.nodes[0].id, "finalizer");
  assert.equal(packet.executionGraph.edges.length, ENTRIES.length * 2);
  assert.ok(packet.executionGraph.edges.some((e) => e.kind === "spawn"));
  assert.ok(packet.executionGraph.edges.some((e) => e.kind === "evidence"));
  assert.equal(packet.execution.authorizedSubagentCount, 3);
  assert.equal(packet.determinism.signsEvidence, false);
  assert.equal(packet.boundaries.actualSubagentSpawn, false);
  assert.equal(packet.boundaries.terminalAckOrReplay, false);
});

test("empty evidence assembles to a stable finalizer-only graph", () => {
  const packet = buildA2AWorkerSubagentEvidenceAssembly({ now: NOW, workerId: "w", entries: [] });
  assert.deepEqual(packet.assembledEvidence, []);
  assert.equal(packet.executionGraph.nodes.length, 1);
  assert.equal(packet.executionGraph.edges.length, 0);
  assert.match(packet.determinism.contentDigest, /^sha256:/);
});

test("extractor accepts envelopes, idempotencyKey-as-id, and snake_case", () => {
  const input = extractA2AWorkerSubagentEvidenceAssemblyInput({
    workerSubagentEvidenceAssembly: {
      now: NOW,
      worker_id: "worker-snake",
      task_id: "task-snake",
      entries: [{ role: "implementer", idempotencyKey: "ev-1", write_set: ["src/x.ts"], status: "complete" }],
      execution: { authorizedSubagentCount: 1 },
    },
  });
  const packet = buildA2AWorkerSubagentEvidenceAssembly(input);
  assert.equal(packet.workerId, "worker-snake");
  assert.equal(packet.taskId, "task-snake");
  assert.equal(packet.assembledEvidence[0].id, "ev-1");
  assert.deepEqual(packet.assembledEvidence[0].writeSet, ["src/x.ts"]);
});

test("fixture round-trips through the CLI extract path", () => {
  const raw = JSON.parse(readFileSync("fixtures/worker-subagent-orchestration/evidence-assembly-basic.json", "utf8"));
  const packet = buildA2AWorkerSubagentEvidenceAssembly({ ...extractA2AWorkerSubagentEvidenceAssemblyInput(raw), now: NOW });
  assert.equal(packet.assembledEvidence.length, 3);
  assert.match(packet.determinism.contentDigest, /^sha256:[0-9a-f]{64}$/);
});

test("markdown states source-only no-sign boundary", () => {
  const packet = buildA2AWorkerSubagentEvidenceAssembly({ now: NOW, workerId: "w", entries: ENTRIES });
  const markdown = renderA2AWorkerSubagentEvidenceAssemblyMarkdown(packet);
  assert.equal(markdown.includes("source-only deterministic assembly"), true);
  assert.equal(markdown.includes("does not sign"), true);
  assert.equal(markdown.includes("rfc8785-jcs-v1"), true);
});
