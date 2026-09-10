/**
 * Tests for the Slice V fence-mediated task-create idempotency (#1504 §4).
 *
 * The `executeTaskCreateIdempotent` passthrough is a fail-closed window onto
 * the fence's single-writer adapter for the §5.4.1 `broker.task.create`
 * authority. These tests exercise the outcome mapping (executed / replayed /
 * conflict / unavailable), the §5.4 fingerprint rule (same key + different
 * payload is a conflict, never an absorbed replay), and durable key/outcome
 * continuity across a clean fence restart.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openSharedStateServingFenceV1,
  type SharedStateServingFenceV1,
} from "./shared-state-serving-fence-v1.js";

function withTempDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "a2a-fence-idem-test-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const T0 = 1_700_000_000_000;
let tick = 0;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function execute(
  fence: SharedStateServingFenceV1,
  taskId: string,
  request: string,
) {
  tick += 10;
  return fence.executeTaskCreateIdempotent(
    { taskId, requestSha256Hex: sha256(request) },
    T0 + tick,
  );
}

test("fence idempotency executes once, replays the same fingerprint, and conflicts on a changed one", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const request = JSON.stringify({ id: "task-1", message: "hello" });
      const changed = JSON.stringify({ id: "task-1", message: "goodbye" });

      const first = execute(fence.value, "task-1", request);
      assert.equal(first.outcome, "executed");
      if (first.outcome !== "executed") return;
      assert.match(first.outcomeDigest, /broker\.idempotency\.outcome/);

      // Same key + same fingerprint returns the original outcome.
      const replay = execute(fence.value, "task-1", request);
      assert.equal(replay.outcome, "replayed");
      if (replay.outcome !== "replayed") return;
      assert.equal(replay.outcomeDigest, first.outcomeDigest);

      // Same key + different fingerprint is the one thing idempotency must
      // never absorb (§5.4).
      const conflict = execute(fence.value, "task-1", changed);
      assert.deepEqual(conflict, { outcome: "conflict" });

      // A different key is an independent authority decision.
      const other = execute(fence.value, "task-2", changed);
      assert.equal(other.outcome, "executed");
    } finally {
      fence.value.release();
    }
  });
});

test("fence idempotency is fail-closed: released fence is unavailable, never a decision", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const fence = openSharedStateServingFenceV1({ filePath });
    assert.ok(fence.ok);
    const handle = fence.value;
    handle.release();
    const afterRelease = execute(handle, "task-1", "{}");
    assert.equal(afterRelease.outcome, "unavailable");
    if (afterRelease.outcome === "unavailable") {
      assert.equal(afterRelease.reasonCode, "adapter_unavailable");
    }
  });
});

test("fence idempotency keeps keys and outcomes across a clean restart", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const request = JSON.stringify({ id: "task-1", message: "durable" });
    const first = openSharedStateServingFenceV1({ filePath });
    assert.ok(first.ok);
    const executed = execute(first.value, "task-1", request);
    assert.equal(executed.outcome, "executed");
    if (executed.outcome !== "executed") return;
    const digest = executed.outcomeDigest;
    first.value.release();

    const second = openSharedStateServingFenceV1({ filePath });
    assert.ok(second.ok);
    try {
      const replay = execute(second.value, "task-1", request);
      assert.equal(replay.outcome, "replayed");
      if (replay.outcome !== "replayed") return;
      // The outcome is stable across the restart (§5.4 restart behavior).
      assert.equal(replay.outcomeDigest, digest);
    } finally {
      second.value.release();
    }
  });
});
