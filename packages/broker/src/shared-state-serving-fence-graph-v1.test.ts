/**
 * Tests for the Slice X fence-mediated graph source append (#1504 §4).
 *
 * The `appendTaskRunGraphSource` passthrough is a fail-closed window onto the
 * fence's single-writer adapter for the §5.6 source-fact authority
 * (`broker.claim-graph`). These tests exercise the outcome mapping
 * (appended / replayed / sequence_conflict / unavailable), fact-digest
 * dedupe, the expected-sequence CAS, and durable high-water continuity
 * across a clean fence restart.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openSharedStateServingFenceV1,
  type SharedStateServingFenceV1,
} from "./shared-state-serving-fence-v1.js";

function withTempDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "a2a-fence-graph-test-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const T0 = 1_700_000_000_000;
let tick = 0;

function append(
  fence: SharedStateServingFenceV1,
  expected: string,
  taskId = "task-1",
  status = "succeeded",
) {
  tick += 10;
  return fence.appendTaskRunGraphSource(
    {
      brokerAuthorityId: "brokeralpha",
      taskId,
      status,
      completedAt: "2026-09-10T00:00:00.000Z",
      expectedSourceSequence: expected,
    },
    T0 + tick,
  );
}

test("fence graph appends with the tracked sequence, replays by fact digest, and conflicts on a stale one", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const first = append(fence.value, "0");
      assert.equal(first.outcome, "appended");
      if (first.outcome !== "appended") return;
      assert.equal(first.sourceSequence, "1");

      // The fact digest dedupes: re-presenting the same terminal fact
      // replays the original sequence regardless of the expectation.
      const replay = append(fence.value, "0");
      assert.deepEqual(replay, { outcome: "replayed", sourceSequence: "1" });

      // A fresh fact with a stale expectation is a sequence conflict.
      const stale = append(fence.value, "0", "task-2", "failed");
      assert.deepEqual(stale, { outcome: "sequence_conflict" });

      // The correct next expectation appends.
      const second = append(fence.value, "1", "task-2", "failed");
      assert.equal(second.outcome, "appended");
      if (second.outcome !== "appended") return;
      assert.equal(second.sourceSequence, "2");
    } finally {
      fence.value.release();
    }
  });
});

test("fence graph is fail-closed: released fence is unavailable, never a sequence", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const fence = openSharedStateServingFenceV1({ filePath });
    assert.ok(fence.ok);
    const handle = fence.value;
    handle.release();
    const afterRelease = append(handle, "0");
    assert.equal(afterRelease.outcome, "unavailable");
    if (afterRelease.outcome === "unavailable") {
      assert.equal(afterRelease.reasonCode, "adapter_unavailable");
    }
  });
});

test("fence graph keeps the high-water mark across a clean restart", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const first = openSharedStateServingFenceV1({ filePath });
    assert.ok(first.ok);
    const appended = append(first.value, "0");
    assert.equal(appended.outcome, "appended");
    if (appended.outcome !== "appended") return;
    const original = appended.sourceSequence;
    first.value.release();

    // §5.6 restart behavior: the durable fact replays its original sequence
    // and the high-water continues above it after the restart.
    const second = openSharedStateServingFenceV1({ filePath });
    assert.ok(second.ok);
    try {
      const replay = append(second.value, "0");
      assert.deepEqual(replay, { outcome: "replayed", sourceSequence: original });
      const next = append(second.value, original, "task-2", "failed");
      assert.equal(next.outcome, "appended");
      if (next.outcome !== "appended") return;
      assert.equal(BigInt(next.sourceSequence), BigInt(original) + 1n);
    } finally {
      second.value.release();
    }
  });
});
