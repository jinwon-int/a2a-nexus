// ccc-node#2858 item 3: worker-side `kind=a2a` spans (claim / dispatch /
// receipt) written to the node span ledger — off by default, body-free
// (lengths + hashes only), and never able to change task handling.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  A2A_SPAN_KEYS,
  A2ASpanWriter,
  UNCLASSIFIED_ERROR,
  a2aTaskRef,
  buildA2ASpan,
  createA2ASpanWriterFromEnv,
} from "./a2a-span-writer.js";
import { A2ABrokerWorker } from "./broker-worker-client.js";
import type { BrokerWorkerConfig } from "../worker.js";
import type { WorkerTaskHandler } from "./task-handler-factories.js";

/** Must never reach the span file, whatever field it rides in. */
const BODY = "SECRET-BODY-MARKER prompt text with spaces and a path /home/owner/notes.md";
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

function tempDir(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "a2a-spans-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function readSpans(dir: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const name of readdirSync(dir).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

function rawFiles(dir: string): string {
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("");
}

function sha16(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").slice(0, 16);
}

test("spans are off unless A2A_WORKER_SPANS_DIR is set", () => {
  assert.equal(createA2ASpanWriterFromEnv({}), undefined);
  assert.equal(createA2ASpanWriterFromEnv({ A2A_WORKER_SPANS_DIR: "   " }), undefined);
  assert.ok(createA2ASpanWriterFromEnv({ A2A_WORKER_SPANS_DIR: "/tmp/x" }, "jingun") instanceof A2ASpanWriter);
});

test("one owner-only UTC day file, one allow-listed line per span", (t) => {
  const dir = join(tempDir(t), "spans");
  const writer = new A2ASpanWriter({ dir, node: "jingun", now: () => T0 });
  const payload = { prompt: BODY };
  assert.equal(writer.record({
    operation: "a2a.claim", status: "ok", outcome: "claimed",
    startedAtMs: T0 - 250, endedAtMs: T0, taskId: "task-1", payload,
  }), true);
  assert.deepEqual(readdirSync(dir), ["2026-11-23.jsonl"]);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "2026-11-23.jsonl")).mode & 0o777, 0o600);
  const [span] = readSpans(dir);
  const payloadText = JSON.stringify(payload);
  assert.deepEqual(span, {
    kind: "a2a",
    status: "ok",
    "gen_ai.operation.name": "a2a.claim",
    start_ts: (T0 - 250) / 1000,
    duration_ms: 250,
    "ccc.node": "jingun",
    "ccc.outcome": "claimed",
    "ccc.a2a.task_ref": a2aTaskRef("task-1"),
    "ccc.a2a.payload_bytes": Buffer.byteLength(payloadText, "utf8"),
    "ccc.a2a.payload_sha256": sha16(payloadText),
  });
  assert.notEqual(span!["ccc.a2a.task_ref"], "task-1");
  assert.ok(!rawFiles(dir).includes("SECRET-BODY-MARKER"));
});

test("error.type is code-shaped only; messages and token-like codes collapse", () => {
  const base = { operation: "a2a.dispatch" as const, startedAtMs: T0, endedAtMs: T0 + 1 };
  assert.equal(buildA2ASpan({ ...base, status: "error", errorType: "handler_exit_nonzero" })?.["error.type"], "handler_exit_nonzero");
  assert.equal(buildA2ASpan({ ...base, status: "error", errorType: BODY })?.["error.type"], UNCLASSIFIED_ERROR);
  assert.equal(buildA2ASpan({ ...base, status: "error", errorType: "Bearer_ABC" })?.["error.type"], UNCLASSIFIED_ERROR);
  assert.equal(buildA2ASpan({ ...base, status: "error" })?.["error.type"], UNCLASSIFIED_ERROR);
  assert.equal(buildA2ASpan({ ...base, status: "ok", errorType: "ignored" })?.["error.type"], undefined);
  assert.equal(buildA2ASpan({ ...base, status: "ok", outcome: BODY })?.["ccc.outcome"], undefined);
});

test("a symlinked spans directory or an unwritable path is refused without throwing", (t) => {
  const root = tempDir(t);
  const real = join(root, "real");
  mkdirSync(real, { mode: 0o700 });
  const link = join(root, "link");
  symlinkSync(real, link);
  const span = { operation: "a2a.claim" as const, status: "ok" as const, startedAtMs: T0, endedAtMs: T0 };
  assert.equal(new A2ASpanWriter({ dir: link, now: () => T0 }).record(span), false);
  assert.deepEqual(readdirSync(real), []);
  const file = join(root, "file");
  writeFileSync(file, "x");
  assert.equal(new A2ASpanWriter({ dir: file, now: () => T0 }).record(span), false);
});

// --- worker integration --------------------------------------------------------

interface FakeBroker {
  calls: string[];
  /** path suffix → status code to return instead of 200 (first match wins). */
  failures: Map<string, number>;
}

function makeWorker(dir: string, broker: FakeBroker, handler: WorkerTaskHandler, payload: Record<string, unknown>): A2ABrokerWorker {
  const record = (id: string, status: string) => ({
    id, intent: "propose_patch", status, payload, targetNodeId: "default",
    requester: { id: "b", kind: "service" }, target: { id: "default", kind: "node" },
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const config: BrokerWorkerConfig = {
    brokerUrl: "http://broker.test",
    requesterKind: "node",
    pollIntervalMs: 5_000,
    heartbeatIntervalMs: 30_000,
    handlerTimeoutMs: 60_000,
    worker: {
      nodeId: "jingun", role: "analyst",
      capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: true, canPromoteLive: false, workspaceIds: ["test"], environments: ["research" as const] },
    },
    userAgent: "test-agent",
    handler,
    a2aSpanWriter: new A2ASpanWriter({ dir, node: "jingun" }),
  };
  const fetchImpl = async (url: URL, init?: RequestInit): Promise<Response> => {
    const call = `${init?.method ?? "GET"} ${url.pathname}`;
    broker.calls.push(call);
    for (const [suffix, status] of broker.failures) {
      if (url.pathname.endsWith(suffix)) {
        broker.failures.delete(suffix);
        return new Response(JSON.stringify({ error: { code: "boom", message: BODY } }), { status });
      }
    }
    if (url.pathname === "/tasks") {
      return new Response(JSON.stringify({ items: [record("task-1", "queued")] }), { status: 200 });
    }
    const id = url.pathname.split("/")[2] ?? "task-1";
    return new Response(JSON.stringify(record(id, "running")), { status: 200 });
  };
  return new A2ABrokerWorker(config, { fetchImpl: fetchImpl as never });
}

function byOperation(spans: Array<Record<string, unknown>>): Array<[unknown, unknown, unknown, unknown]> {
  return spans.map((s) => [s["gen_ai.operation.name"], s.status, s["error.type"], s["ccc.outcome"]]);
}

function assertContract(dir: string): void {
  const allowed = new Set<string>(A2A_SPAN_KEYS);
  for (const span of readSpans(dir)) {
    assert.equal(span.kind, "a2a");
    for (const key of Object.keys(span)) assert.ok(allowed.has(key), `unexpected key ${key}`);
  }
  assert.ok(!rawFiles(dir).includes("SECRET-BODY-MARKER"), "no body text in the span file");
  assert.ok(!rawFiles(dir).includes("task-1"), "no raw task id in the span file");
}

test("a completed task writes claim → dispatch → receipt, all ok, body-free", async (t) => {
  const dir = tempDir(t);
  const broker: FakeBroker = { calls: [], failures: new Map() };
  const result = { summary: BODY, note: BODY };
  const worker = makeWorker(dir, broker, async () => ({ result }), { prompt: BODY });
  assert.equal(await worker.runOnce(), 1);
  const spans = readSpans(dir);
  assert.deepEqual(byOperation(spans), [
    ["a2a.claim", "ok", undefined, "claimed"],
    ["a2a.dispatch", "ok", undefined, "completed"],
    ["a2a.receipt", "ok", undefined, "complete"],
  ]);
  assert.equal(spans[0]!["ccc.a2a.payload_sha256"], sha16(JSON.stringify({ prompt: BODY })));
  assert.equal(spans[1]!["ccc.a2a.result_bytes"], Buffer.byteLength(JSON.stringify(result), "utf8"));
  assert.ok(broker.calls.some((c) => c.endsWith("/complete")));
  assertContract(dir);
});

test("a handler failure spans its code, never its message; a timeout spans as timeout", async (t) => {
  const dir = tempDir(t);
  const broker: FakeBroker = { calls: [], failures: new Map() };
  const failing = makeWorker(dir, broker, async () => ({ error: { code: "handler_exit_nonzero", message: BODY } }), {});
  await failing.runOnce();
  const timingOut = makeWorker(dir, broker, async () => ({ error: { code: "handler_timeout", message: BODY } }), {});
  await timingOut.runOnce();
  assert.deepEqual(byOperation(readSpans(dir)), [
    ["a2a.claim", "ok", undefined, "claimed"],
    ["a2a.dispatch", "error", "handler_exit_nonzero", "failed"],
    ["a2a.receipt", "ok", undefined, "fail"],
    ["a2a.claim", "ok", undefined, "claimed"],
    ["a2a.dispatch", "timeout", "handler_timeout", "failed"],
    ["a2a.receipt", "ok", undefined, "fail"],
  ]);
  assertContract(dir);
});

test("a lost claim race spans claim_skipped; a broker claim error spans its HTTP status", async (t) => {
  const dir = tempDir(t);
  const skipped: FakeBroker = { calls: [], failures: new Map([["/claim", 409]]) };
  assert.equal(await makeWorker(dir, skipped, async () => ({}), {}).runOnce(), 0);
  const broken: FakeBroker = { calls: [], failures: new Map([["/claim", 500]]) };
  await assert.rejects(makeWorker(dir, broken, async () => ({}), {}).runOnce());
  assert.deepEqual(byOperation(readSpans(dir)), [
    ["a2a.claim", "ok", undefined, "claim_skipped"],
    ["a2a.claim", "error", "claim_http_500", undefined],
  ]);
  assertContract(dir);
});

test("a rejected completion spans the receipt failure, then the fail report — dispatch only once", async (t) => {
  const dir = tempDir(t);
  const broker: FakeBroker = { calls: [], failures: new Map([["/complete", 500]]) };
  const worker = makeWorker(dir, broker, async () => ({ result: { summary: "done" } }), {});
  assert.equal(await worker.runOnce(), 1);
  assert.deepEqual(byOperation(readSpans(dir)), [
    ["a2a.claim", "ok", undefined, "claimed"],
    ["a2a.dispatch", "ok", undefined, "completed"],
    ["a2a.receipt", "error", "receipt_http_500", "complete"],
    ["a2a.receipt", "ok", undefined, "fail"],
  ]);
  assertContract(dir);
});

test("a span writer that throws never changes task handling", async (t) => {
  const dir = tempDir(t);
  const broker: FakeBroker = { calls: [], failures: new Map() };
  const worker = makeWorker(dir, broker, async () => ({ result: { summary: "done" } }), {});
  (worker as unknown as { config: BrokerWorkerConfig }).config.a2aSpanWriter = {
    record: () => { throw new Error("disk exploded"); },
  } as unknown as A2ASpanWriter;
  assert.equal(await worker.runOnce(), 1);
  assert.ok(broker.calls.some((c) => c.endsWith("/complete")));
});
