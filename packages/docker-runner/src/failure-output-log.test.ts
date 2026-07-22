import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_FAILURE_LOG_MAX_BYTES,
  FAILURE_OUTPUT_LOG_FILENAME,
  pruneFailureOutputLogs,
  writeFailureOutputLog,
} from "./failure-output-log.js";

test("writes combined redacted output for failed runs", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "a2a-failure-log-"));
  const path = await writeFailureOutputLog(workDir, {
    stdout: `run output with token=ghp_${"a".repeat(36)}`,
    stderr: "final error line",
  });

  assert.ok(path);
  const content = await readFile(path!, "utf8");
  assert.match(content, /final error line/);
  assert.match(content, /token=<redacted-github-token>/);
  assert.doesNotMatch(content, /ghp_a{36}/);
});

test("skips empty output", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "a2a-failure-log-"));
  const path = await writeFailureOutputLog(workDir, { stdout: "  \n ", stderr: "" });
  assert.equal(path, undefined);
});

test("bounds to the TAIL of long output without splitting code points", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "a2a-failure-log-"));
  const tail_marker = "TAIL-한글-마커-final-error";
  const path = await writeFailureOutputLog(workDir, {
    stdout: `${"head-".repeat(20000)}${"한".repeat(20000)}${tail_marker}`,
    stderr: "",
    maxBytes: 8_000,
  });

  const content = await readFile(path!, "utf8");
  assert.match(content, /<truncated to last 8000 bytes>/);
  assert.ok(content.trimEnd().endsWith(tail_marker));
  assert.ok(Buffer.byteLength(content, "utf8") <= 8_000 + 1);
  assert.doesNotMatch(content, /head-head-head-head-head-/);
});

test("prune keeps newest K failure logs across task/run dirs", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-failure-prune-"));
  const now = Date.now() / 1000;
  for (let i = 0; i < 5; i += 1) {
    const runDir = join(root, `task-${i}`, `run-${i}`);
    await mkdir(runDir, { recursive: true });
    const logPath = join(runDir, FAILURE_OUTPUT_LOG_FILENAME);
    await writeFile(logPath, `log-${i}`);
    await utimes(logPath, now - i * 100, now - i * 100);
    // non-matching file must be ignored
    await writeFile(join(runDir, "other.log"), "x");
  }

  const pruned = await pruneFailureOutputLogs(root, 3);
  assert.equal(pruned, 2);

  const remaining: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    try {
      await readFile(join(root, `task-${i}`, `run-${i}`, FAILURE_OUTPUT_LOG_FILENAME), "utf8");
      remaining.push(`log-${i}`);
    } catch { /* pruned */ }
  }
  assert.deepEqual(remaining, ["log-0", "log-1", "log-2"]);
});

test("default byte cap is 256KiB", () => {
  assert.equal(DEFAULT_FAILURE_LOG_MAX_BYTES, 262144);
});
