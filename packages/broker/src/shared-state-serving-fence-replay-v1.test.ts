/**
 * Tests for the Slice S fence-mediated replay primitive (#1504 §4).
 *
 * The serving fence's `consumeReplayNonce` is a fail-closed passthrough of
 * exactly one V1 primitive through the fence's own single-writer adapter.
 * These tests exercise the outcome mapping (accepted / replayed /
 * unavailable), fail-closed behavior after release, and durable continuity of
 * consumed nonces across a clean fence restart — the property the
 * process-local cache cannot provide.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SHARED_STATE_SERVING_FENCE_V1,
  openSharedStateServingFenceV1,
  type SharedStateServingFenceV1,
} from "./shared-state-serving-fence-v1.js";

function withTempDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "a2a-fence-replay-test-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function consume(
  fence: SharedStateServingFenceV1,
  nonce: string,
  nowMs: number,
  ttlMs = 60_000,
) {
  return fence.consumeReplayNonce(
    { keyid: "worker:workerbeta:v1", nonce, ttlMs },
    nowMs,
  );
}

test("fence replay consume accepts once, replays the duplicate, and accepts a fresh nonce", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    const handle = fence.value;
    try {
      const t0 = 1_700_000_000_000;
      const first = consume(handle, "nonce-one", t0);
      assert.deepEqual(first, { outcome: "accepted" });
      const duplicate = consume(handle, "nonce-one", t0 + 1);
      assert.deepEqual(duplicate, { outcome: "replayed" });
      const fresh = consume(handle, "nonce-two", t0 + 2);
      assert.deepEqual(fresh, { outcome: "accepted" });
    } finally {
      handle.release();
    }
  });
});

test("fence replay consume is fail-closed: released fence and invalid ttl are unavailable, never accepted", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const fence = openSharedStateServingFenceV1({ filePath });
    assert.ok(fence.ok);
    const handle = fence.value;
    handle.release();
    const afterRelease = consume(handle, "nonce-after-release", 1_700_000_000_000);
    assert.equal(afterRelease.outcome, "unavailable");
    if (afterRelease.outcome === "unavailable") {
      assert.equal(afterRelease.reasonCode, "adapter_unavailable");
    }

    const reopened = openSharedStateServingFenceV1({ filePath });
    assert.ok(reopened.ok);
    try {
      const invalidTtl = consume(reopened.value, "nonce-invalid-ttl", 1_700_000_000_000, 0);
      assert.equal(invalidTtl.outcome, "unavailable");
    } finally {
      reopened.value.release();
    }
  });
});

test("fence replay consume keeps unexpired nonces rejecting across a clean restart", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const t0 = 1_700_000_000_000;
    const first = openSharedStateServingFenceV1({ filePath });
    assert.ok(first.ok);
    const firstOutcome = consume(first.value, "nonce-durable", t0);
    assert.deepEqual(firstOutcome, { outcome: "accepted" });
    first.value.release();

    const second = openSharedStateServingFenceV1({ filePath });
    assert.ok(second.ok);
    try {
      const replayed = consume(second.value, "nonce-durable", t0 + 1_000);
      assert.deepEqual(replayed, { outcome: "replayed" });
      const fresh = consume(second.value, "nonce-post-restart", t0 + 2_000);
      assert.deepEqual(fresh, { outcome: "accepted" });
    } finally {
      second.value.release();
    }
  });
});

test("fence replay consume treats an expired nonce as logically absent again", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const t0 = 1_700_000_000_000;
      assert.deepEqual(consume(fence.value, "nonce-expiring", t0, 1_000), { outcome: "accepted" });
      // Still inside the TTL: replaying must reject.
      assert.deepEqual(consume(fence.value, "nonce-expiring", t0 + 500, 1_000), { outcome: "replayed" });
      // Past expiry the record is logically absent, so the tuple is
      // consumable again (§5.1: absent at now >= expiresAt).
      assert.deepEqual(consume(fence.value, "nonce-expiring", t0 + 1_001, 1_000), { outcome: "accepted" });
    } finally {
      fence.value.release();
    }
  });
});

test("fence replay namespace is a fixed keyspace-valid constant", () => {
  assert.equal(
    SHARED_STATE_SERVING_FENCE_V1.replayNamespace,
    "security.replay.broker-worker-signature",
  );
});
