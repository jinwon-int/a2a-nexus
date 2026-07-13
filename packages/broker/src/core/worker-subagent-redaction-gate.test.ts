import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildA2AWorkerSubagentRedactionGate,
  extractA2AWorkerSubagentRedactionGateInput,
  renderA2AWorkerSubagentRedactionGateMarkdown,
} from "./worker-subagent-redaction-gate.js";

const NOW = "2026-05-19T03:10:00.000Z";

test("redact mode masks a secret and passes the cleaned entry through", () => {
  const packet = buildA2AWorkerSubagentRedactionGate({
    now: NOW,
    workerId: "workergamma",
    entries: [
      { role: "explorer", id: "ev-1", output: "found TOKEN=abcd1234secretvalue in config" },
      { role: "verifier", id: "ev-2", output: "all tests pass" },
    ],
  });

  assert.equal(packet.kind, "a2a-broker.worker-subagent-redaction-gate.packet");
  assert.equal(packet.mode, "redact");
  assert.equal(packet.state, "modified");
  assert.equal(packet.summary.redacted, 1);
  assert.equal(packet.summary.clean, 1);
  assert.equal(packet.summary.included, 2);
  const r0 = packet.results[0];
  assert.equal(r0.verdict, "redacted");
  assert.equal(r0.included, true);
  assert.equal(r0.cleaned?.includes("abcd1234secretvalue"), false);
  assert.ok(r0.cleaned?.includes("[redacted]"));
  assert.equal(packet.cleanedEntries.length, 2);
  assert.equal(packet.boundaries.actualSubagentSpawn, false);
  assert.equal(packet.semantics.promptOnly, false);
});

test("reject mode excludes an entry with a secret finding from the assembled set", () => {
  const packet = buildA2AWorkerSubagentRedactionGate({
    now: NOW,
    workerId: "w",
    mode: "reject",
    entries: [
      { role: "explorer", id: "ev-1", output: "leaked ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" },
      { role: "verifier", id: "ev-2", output: "clean output" },
    ],
  });

  assert.equal(packet.state, "has-rejections");
  assert.equal(packet.summary.rejected, 1);
  assert.equal(packet.results[0].verdict, "rejected");
  assert.equal(packet.results[0].included, false);
  assert.equal(packet.results[0].cleaned, undefined);
  assert.equal(packet.cleanedEntries.length, 1);
  assert.equal(packet.cleanedEntries[0].id, "ev-2");
});

test("truncates over-budget output", () => {
  const packet = buildA2AWorkerSubagentRedactionGate({
    now: NOW,
    workerId: "w",
    maxOutputChars: 50,
    entries: [{ role: "explorer", id: "ev-1", output: "word ".repeat(200) }],
  });
  assert.equal(packet.results[0].verdict, "truncated");
  assert.equal(packet.results[0].truncated, true);
  assert.equal(packet.cleanedEntries[0].output.length, 50);
});

test("redacts private host paths and provider target identifiers", () => {
  const packet = buildA2AWorkerSubagentRedactionGate({
    now: NOW,
    workerId: "w",
    entries: [{
      role: "verifier",
      id: "ev-private",
      output: "read /root/.openclaw/agents/main and /home/alice/private then telegram:123456789 and chat_id=987654321",
    }],
  });

  const cleaned = packet.cleanedEntries[0]?.output ?? "";
  assert.doesNotMatch(cleaned, /\/root\/\.openclaw|\/home\/alice|123456789|987654321/);
  assert.equal(packet.results[0]?.redacted, true);
});

test("removes raw controls, prefixed secrets, and structured provider targets", () => {
  const prefixed = [
    `${["DB", "PASSWORD"].join("_")}=hunter2`,
    `${["A2A", "EDGE", "SECRET"].join("_")}=abc123`,
    `${["OPENAI", "API", "KEY"].join("_")}=\"short value\"`,
    `${["github", "token"].join("_")}: short-token`,
  ].join(" ");
  const packet = buildA2AWorkerSubagentRedactionGate({
    now: NOW,
    workerId: "w",
    entries: [{
      role: "verifier",
      id: "ev-controls",
      output: `${prefixed} \"chat_id\": 123456789 chat_id: 987654321 \"thread_id\": '-123456789' telegram = \" 234567890 \" before\u0000after\u0007`,
    }],
  });

  const cleaned = packet.cleanedEntries[0]?.output ?? "";
  assert.doesNotMatch(cleaned, /hunter2|abc123|short value|short-token|123456789|987654321|234567890|\u0000|\u0007/);
  assert.equal(packet.results[0]?.redacted, true);
});

test("reject mode preserves runner-side finding classification without raw values", () => {
  const packet = buildA2AWorkerSubagentRedactionGate({
    now: NOW,
    workerId: "w",
    mode: "reject",
    entries: [{
      role: "verifier",
      id: "ev-preredacted",
      output: "read <private-dir> and notify telegram:<redacted-target>",
      preRedacted: true,
    }],
  });
  assert.equal(packet.state, "has-rejections");
  assert.equal(packet.summary.rejected, 1);
  assert.equal(packet.summary.included, 0);
  assert.equal(packet.results[0]?.verdict, "rejected");
});

test("invalid non-finite byte limits fall back to the bounded default", () => {
  const packet = buildA2AWorkerSubagentRedactionGate({
    now: NOW,
    workerId: "w",
    maxOutputBytes: Number.POSITIVE_INFINITY,
    entries: [{ role: "verifier", id: "ev-limit", output: "ok" }],
  });
  assert.equal(packet.maxOutputBytes, 4000);
  assert.equal(packet.maxOutputChars, 4000);
});

test("bounds cleaned output by UTF-8 bytes without splitting code points", () => {
  const packet = buildA2AWorkerSubagentRedactionGate({
    now: NOW,
    workerId: "w",
    maxOutputBytes: 5,
    entries: [{ role: "explorer", id: "ev-utf8", output: "😀ab" }],
  } as never);
  const cleaned = packet.cleanedEntries[0].output;
  assert.equal(packet.results[0].truncated, true);
  assert.equal(Buffer.byteLength(cleaned, "utf8"), 5);
  assert.equal(cleaned, "😀a");
  assert.doesNotMatch(cleaned, /�/);
});

test("all-clean when nothing needs redaction or truncation", () => {
  const packet = buildA2AWorkerSubagentRedactionGate({
    now: NOW,
    workerId: "w",
    entries: [{ role: "explorer", id: "e", output: "mapped the module cleanly" }],
  });
  assert.equal(packet.state, "all-clean");
  assert.equal(packet.summary.clean, 1);
  assert.equal(packet.results[0].verdict, "clean");
});

test("content-addressed digest is stable across generatedAt", () => {
  const entries = [{ role: "explorer", id: "e", output: "hi" }];
  const a = buildA2AWorkerSubagentRedactionGate({ now: NOW, workerId: "w", entries });
  const b = buildA2AWorkerSubagentRedactionGate({ now: "2027-01-01T00:00:00.000Z", workerId: "w", entries });
  assert.equal(a.determinism.contentDigest, b.determinism.contentDigest);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.match(a.determinism.contentDigest, /^sha256:[0-9a-f]{64}$/);
});

test("extractor accepts envelopes, snake_case, and idempotencyKey-as-id", () => {
  const input = extractA2AWorkerSubagentRedactionGateInput({
    workerSubagentRedactionGate: {
      now: NOW,
      worker_id: "worker-snake",
      task_id: "task-snake",
      mode: "reject",
      max_output_chars: 100,
      entries: [{ role: "implementer", idempotencyKey: "ev-x", text: "SECRET=zzzzptop" }],
    },
  });
  const packet = buildA2AWorkerSubagentRedactionGate(input);
  assert.equal(packet.workerId, "worker-snake");
  assert.equal(packet.mode, "reject");
  assert.equal(packet.maxOutputChars, 100);
  assert.equal(packet.results[0].id, "ev-x");
  assert.equal(packet.results[0].verdict, "rejected");
});

test("fixture round-trips through extract", () => {
  const raw = JSON.parse(readFileSync("fixtures/worker-subagent-orchestration/redaction-gate-basic.json", "utf8"));
  const packet = buildA2AWorkerSubagentRedactionGate({ ...extractA2AWorkerSubagentRedactionGateInput(raw), now: NOW });
  assert.equal(packet.summary.total, 3);
  assert.ok(packet.summary.redacted >= 1);
});

test("markdown states source-only pre-assembly boundary", () => {
  const packet = buildA2AWorkerSubagentRedactionGate({ now: NOW, workerId: "w", entries: [{ role: "e", output: "x" }] });
  const md = renderA2AWorkerSubagentRedactionGateMarkdown(packet);
  assert.ok(md.includes("source-only redaction gate"));
  assert.ok(md.includes("before evidence assembly"));
});
