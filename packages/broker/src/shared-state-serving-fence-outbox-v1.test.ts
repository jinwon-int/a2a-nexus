/**
 * Tests for the Slice W fence-mediated outbox append (#1504 §4).
 *
 * The `appendTerminalTaskEvent` passthrough is a fail-closed window onto the
 * fence's single-writer adapter for the §5.5 task-terminal-notification
 * stream (`broker.terminal-outbox`). These tests exercise the outcome mapping
 * (appended / replayed / unavailable), adapter-allocated per-stream sequence
 * monotonicity with the §5.5 replay property (a retry returns the ORIGINAL
 * allocation), and sequence continuity across a clean fence restart.
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
  const directory = mkdtempSync(join(tmpdir(), "a2a-fence-outbox-test-"));
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

function append(
  fence: SharedStateServingFenceV1,
  eventId: string,
  payload: string,
  brokerAuthorityId = "brokeralpha",
) {
  tick += 10;
  return fence.appendTerminalTaskEvent(
    { brokerAuthorityId, eventId, payloadSha256Hex: sha256(payload) },
    T0 + tick,
  );
}

test("fence outbox allocates increasing sequences and replays the original on retry", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const payload = JSON.stringify({ taskId: "task-1", status: "succeeded" });

      const first = append(fence.value, "terminal:task-1:succeeded:t0", payload);
      assert.equal(first.outcome, "appended");
      if (first.outcome !== "appended") return;
      assert.ok(BigInt(first.streamSequence) >= 1n);

      // §5.5: an idempotent retry returns the ORIGINAL event allocation —
      // it does not allocate again.
      const retry = append(fence.value, "terminal:task-1:succeeded:t0", payload);
      assert.deepEqual(retry, {
        outcome: "replayed",
        streamSequence: first.streamSequence,
      });

      // A distinct event gets a strictly increasing sequence (total order
      // within the exact stream key; unique, gaps allowed).
      const second = append(fence.value, "terminal:task-2:failed:t1", payload);
      assert.equal(second.outcome, "appended");
      if (second.outcome !== "appended") return;
      assert.ok(BigInt(second.streamSequence) > BigInt(first.streamSequence));
    } finally {
      fence.value.release();
    }
  });
});

test("fence outbox is per-stream: a different broker id allocates independently", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const payload = "{}";
      const a = append(fence.value, "terminal:task-1:succeeded:t0", payload, "broker-a");
      const b = append(fence.value, "terminal:task-1:succeeded:t0", payload, "broker-b");
      // Same event id on a DIFFERENT stream is a fresh allocation, not a
      // replay — no cross-stream order or dedupe is promised (§5.5).
      assert.equal(a.outcome, "appended");
      assert.equal(b.outcome, "appended");
    } finally {
      fence.value.release();
    }
  });
});

test("fence outbox is fail-closed: released fence is unavailable, never a sequence", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const fence = openSharedStateServingFenceV1({ filePath });
    assert.ok(fence.ok);
    const handle = fence.value;
    handle.release();
    const afterRelease = append(handle, "terminal:task-1:succeeded:t0", "{}");
    assert.equal(afterRelease.outcome, "unavailable");
    if (afterRelease.outcome === "unavailable") {
      assert.equal(afterRelease.reasonCode, "adapter_unavailable");
    }
  });
});

test("fence outbox sequence continues from the durable high-water mark after a restart", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const first = openSharedStateServingFenceV1({ filePath });
    assert.ok(first.ok);
    const before = append(first.value, "terminal:task-1:succeeded:t0", "{}");
    assert.ok(before.outcome === "appended");
    if (before.outcome !== "appended") return;
    const highWater = BigInt(before.streamSequence);
    first.value.release();

    // §5.5 restart behavior: a restart MUST NOT reset the stream sequence —
    // the next allocation resumes above the durable high-water mark.
    const second = openSharedStateServingFenceV1({ filePath });
    assert.ok(second.ok);
    try {
      const after = append(second.value, "terminal:task-2:failed:t1", "{}");
      assert.equal(after.outcome, "appended");
      if (after.outcome !== "appended") return;
      assert.ok(BigInt(after.streamSequence) > highWater);

      // And the pre-restart event still replays its original allocation.
      const replay = append(second.value, "terminal:task-1:succeeded:t0", "{}");
      assert.deepEqual(replay, {
        outcome: "replayed",
        streamSequence: before.streamSequence,
      });
    } finally {
      second.value.release();
    }
  });
});
