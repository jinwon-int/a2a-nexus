import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildA2AWorkerSubagentContextBrief,
  extractA2AWorkerSubagentContextBriefInput,
  redactAndBound,
  renderA2AWorkerSubagentContextBriefMarkdown,
} from "./worker-subagent-context-brief.js";

const NOW = "2026-05-19T02:55:00.000Z";

test("redacts secrets in every free-text field", () => {
  const packet = buildA2AWorkerSubagentContextBrief({
    now: NOW,
    workerId: "workergamma",
    summary: "deploy uses TOKEN=abcd1234secretvalue in the pipeline",
    assignments: [{ role: "implementer", objective: "call Authorization: Bearer sk-livesecrettoken", writeSet: ["src/a.ts"] }],
    pointers: [{ path: "src/config.ts", lines: "1-20", note: "api_key=supersecretkeyvalue lives here" }],
    acceptanceCriteria: ["no ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leaks"],
  });

  assert.equal(packet.summary?.includes("abcd1234secretvalue"), false);
  assert.ok(packet.summary?.includes("[redacted]"));
  assert.equal(packet.assignments[0].objective?.includes("sk-livesecrettoken"), false);
  assert.equal(packet.pointers[0].note?.includes("supersecretkeyvalue"), false);
  assert.equal(packet.acceptanceCriteria[0].includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), false);
  assert.equal(packet.redaction.redactionApplied, true);
});

test("byte-bounds long fields to maxFieldChars", () => {
  const long = "word ".repeat(1000); // short tokens (not secret-shaped), 5000 chars
  const packet = buildA2AWorkerSubagentContextBrief({ now: NOW, workerId: "w", summary: long, maxFieldChars: 100 });
  assert.equal(packet.summary?.length, 100);
  assert.equal(packet.redaction.maxFieldChars, 100);
  assert.equal(packet.redaction.byteBounded, true);
});

test("a long secret-shaped blob is redacted (not just bounded)", () => {
  const packet = buildA2AWorkerSubagentContextBrief({ now: NOW, workerId: "w", summary: "x".repeat(5000), maxFieldChars: 100 });
  assert.equal(packet.summary, "[redacted]");
});

test("injects default invariants incl. read-live-file-before-editing", () => {
  const packet = buildA2AWorkerSubagentContextBrief({ now: NOW, workerId: "w" });
  assert.ok(packet.invariants.some((i) => i.toLowerCase().includes("read the live file")));
  assert.ok(packet.invariants.some((i) => i.toLowerCase().includes("single-finalizer")));
  assert.ok(packet.invariants.some((i) => i.toLowerCase().includes("disjoint")));
  assert.equal(packet.usage.readLiveFileBeforeEditing, true);
  assert.equal(packet.usage.notAWriteTimeSourceOfTruth, true);
  assert.equal(packet.usage.readInsteadOfReExploring, true);
});

test("content-addressed: digest/key stable across generatedAt", () => {
  const base = { workerId: "w", taskId: "t", summary: "map the module", pointers: [{ path: "src/x.ts", lines: "10-20" }] };
  const a = buildA2AWorkerSubagentContextBrief({ ...base, now: NOW });
  const b = buildA2AWorkerSubagentContextBrief({ ...base, now: "2027-01-01T00:00:00.000Z" });
  assert.equal(a.determinism.contentDigest, b.determinism.contentDigest);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(a.generatedAt, b.generatedAt);
  assert.match(a.determinism.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.boundaries.actualSubagentSpawn, false);
});

test("redactAndBound is exported and masks a bearer header", () => {
  const out = redactAndBound("Authorization: Bearer sk-abc.def.ghi and rest", 1000);
  assert.equal(out.includes("sk-abc.def.ghi"), false);
  assert.ok(out.includes("[redacted]"));
});

test("extractor accepts envelopes, snake_case, assignments and pointers", () => {
  const input = extractA2AWorkerSubagentContextBriefInput({
    workerSubagentContextBrief: {
      now: NOW,
      worker_id: "worker-snake",
      task_id: "task-snake",
      summary: "s",
      assignments: [{ role: "implementer", objective: "o", write_set: ["src/a.ts"], pointers: [{ path: "src/a.ts", lines: "1-5" }] }],
      acceptance_criteria: ["ac1"],
      max_field_chars: 500,
    },
  });
  const packet = buildA2AWorkerSubagentContextBrief(input);
  assert.equal(packet.workerId, "worker-snake");
  assert.equal(packet.taskId, "task-snake");
  assert.equal(packet.assignments[0].writeSet?.[0], "src/a.ts");
  assert.equal(packet.assignments[0].pointers?.[0].path, "src/a.ts");
  assert.equal(packet.redaction.maxFieldChars, 500);
});

test("fixture round-trips through extract and renders an agent-readable brief", () => {
  const raw = JSON.parse(readFileSync("fixtures/worker-subagent-orchestration/context-brief-basic.json", "utf8"));
  const packet = buildA2AWorkerSubagentContextBrief({ ...extractA2AWorkerSubagentContextBriefInput(raw), now: NOW });
  const md = renderA2AWorkerSubagentContextBriefMarkdown(packet);
  assert.ok(md.includes("# A2A sub-agent context brief"));
  assert.ok(md.includes("## Role assignments"));
  assert.ok(md.includes("read the live file before editing"));
  assert.ok(md.includes("source-only shared context brief"));
});
