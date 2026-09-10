/**
 * Tests for the Slice T fence-mediated rate primitive (#1504 §4).
 *
 * The serving fence's `reserveRateLimitCost` is a fail-closed passthrough of
 * exactly one V1 primitive through the fence's own single-writer adapter.
 * These tests exercise the outcome mapping (allowed / rate_limited /
 * unavailable), fail-closed behavior after release, general-vs-worker bucket
 * separation, and durable in-window cost continuity across a clean fence
 * restart — the property the process-local limiter cannot provide (§5.2).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SHARED_STATE_SERVING_FENCE_V1,
  openSharedStateServingFenceV1,
  type SharedStateFenceRateOutcomeV1,
  type SharedStateServingFenceV1,
} from "./shared-state-serving-fence-v1.js";

function withTempDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "a2a-fence-rate-test-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function reserve(
  fence: SharedStateServingFenceV1,
  principal: string,
  nowMs: number,
  overrides: Partial<Parameters<SharedStateServingFenceV1["reserveRateLimitCost"]>[0]> = {},
): SharedStateFenceRateOutcomeV1 {
  return fence.reserveRateLimitCost(
    {
      bucketClass: "general",
      principal,
      cost: 1,
      limit: 2,
      windowMs: 60_000,
      ...overrides,
    },
    nowMs,
  );
}

test("fence rate reserve allows under the limit, then rate-limits at exhaustion", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const t0 = 1_700_000_000_000;
      const first = reserve(fence.value, "requester:r1", t0);
      assert.deepEqual(first, { outcome: "allowed", remaining: 1, resetInMs: 60_000 });
      const second = reserve(fence.value, "requester:r1", t0 + 1);
      assert.deepEqual(second, { outcome: "allowed", remaining: 0, resetInMs: 59_999 });
      const third = reserve(fence.value, "requester:r1", t0 + 2);
      assert.equal(third.outcome, "rate_limited");
      if (third.outcome === "rate_limited") {
        assert.ok(third.resetInMs > 0 && third.resetInMs <= 60_000);
      }
    } finally {
      fence.value.release();
    }
  });
});

test("fence rate buckets are independent per principal and per bucket class", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const t0 = 1_700_000_000_000;
      assert.equal(reserve(fence.value, "requester:r1", t0).outcome, "allowed");
      assert.equal(reserve(fence.value, "requester:r1", t0).outcome, "allowed");
      // Same principal, other bucket class: independent limit configuration.
      assert.equal(
        reserve(fence.value, "requester:r1", t0, { bucketClass: "worker" }).outcome,
        "allowed",
      );
      // Other principal, same class: unaffected.
      assert.equal(reserve(fence.value, "ip:10.0.0.1", t0).outcome, "allowed");
    } finally {
      fence.value.release();
    }
  });
});

test("fence rate cost stops counting exactly at the window boundary", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const t0 = 1_700_000_000_000;
      assert.equal(reserve(fence.value, "requester:r1", t0).outcome, "allowed");
      assert.equal(reserve(fence.value, "requester:r1", t0).outcome, "allowed");
      assert.equal(reserve(fence.value, "requester:r1", t0 + 1).outcome, "rate_limited");
      // Past the window the earlier cost is logically absent, so the bucket
      // admits again (§5.2: an accepted cost counts while ts > now - window).
      const afterWindow = reserve(fence.value, "requester:r1", t0 + 60_001);
      assert.deepEqual(afterWindow, { outcome: "allowed", remaining: 1, resetInMs: 60_000 });
    } finally {
      fence.value.release();
    }
  });
});

test("fence rate reserve is fail-closed: released fence and invalid policy are unavailable", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const fence = openSharedStateServingFenceV1({ filePath });
    assert.ok(fence.ok);
    const handle = fence.value;
    handle.release();
    const afterRelease = reserve(handle, "requester:r1", 1_700_000_000_000);
    assert.equal(afterRelease.outcome, "unavailable");
    if (afterRelease.outcome === "unavailable") {
      assert.equal(afterRelease.reasonCode, "adapter_unavailable");
    }

    const reopened = openSharedStateServingFenceV1({ filePath });
    assert.ok(reopened.ok);
    try {
      // Non-positive limit violates the V1 command schema: unavailable, not a
      // fabricated decision and not a throw.
      const invalidLimit = reserve(reopened.value, "requester:r1", 1_700_000_000_000, { limit: 0 });
      assert.equal(invalidLimit.outcome, "unavailable");
      // Beyond-cap limit is equally rejected by the schema.
      const overCap = reserve(reopened.value, "requester:r1", 1_700_000_000_000, {
        limit: 1_000_000_001,
      });
      assert.equal(overCap.outcome, "unavailable");
    } finally {
      reopened.value.release();
    }
  });
});

test("fence rate reserve keeps in-window cost denying across a clean restart", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const t0 = 1_700_000_000_000;
    const first = openSharedStateServingFenceV1({ filePath });
    assert.ok(first.ok);
    assert.equal(reserve(first.value, "requester:r1", t0).outcome, "allowed");
    assert.equal(reserve(first.value, "requester:r1", t0).outcome, "allowed");
    first.value.release();

    const second = openSharedStateServingFenceV1({ filePath });
    assert.ok(second.ok);
    try {
      // In-window cost survived the restart: still exhausted (§5.2 decision
      // continuity through restart).
      assert.equal(reserve(second.value, "requester:r1", t0 + 1_000).outcome, "rate_limited");
      // A fresh principal is unaffected.
      assert.equal(reserve(second.value, "requester:r2", t0 + 1_000).outcome, "allowed");
    } finally {
      second.value.release();
    }
  });
});

test("fence rate namespace is a fixed keyspace-valid constant", () => {
  assert.equal(SHARED_STATE_SERVING_FENCE_V1.rateNamespace, "security.rate.broker-edge");
});
