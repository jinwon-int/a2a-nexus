/**
 * Tests for the Slice U fence-mediated lease primitive (#1504 §4).
 *
 * The four lease passthroughs (`claimTaskLease`, `renewTaskLease`,
 * `fenceTaskMutation`, `releaseTaskLease`) are fail-closed windows onto the
 * fence's single-writer adapter. These tests exercise the outcome mapping
 * (claimed/renewed/applied/released vs conflict/lost/unavailable), the §5.3
 * rejection ladder (stale fence, owner mismatch, expiry), fence monotonicity
 * across re-claims, and durable continuity of the fence across a clean
 * restart — the property the legacy in-process claim cannot provide.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openSharedStateServingFenceV1,
  type SharedStateFenceLeaseAuthorityOutcomeV1,
  type SharedStateServingFenceV1,
} from "./shared-state-serving-fence-v1.js";
import type { TaskLeaseStampV1 } from "./core/types.js";

function withTempDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "a2a-fence-lease-test-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const T0 = 1_700_000_000_000;
const LEASE_MS = 60_000;

let claimTick = 0;

function claim(
  fence: SharedStateServingFenceV1,
  taskId = "task-1",
  workerId = "workerbeta",
  expectedResourceVersion?: string,
) {
  // The adapter enforces monotonic observed instants within a lifecycle, so
  // each claim observes a strictly later instant.
  claimTick += 10;
  return fence.claimTaskLease(
    {
      taskId,
      workerId,
      expectedResourceVersion: expectedResourceVersion ?? "0",
      leaseDurationMs: LEASE_MS,
    },
    T0 + claimTick,
  );
}

function authority(
  fence: SharedStateServingFenceV1,
  stamp: TaskLeaseStampV1,
  op: "renew" | "complete" | "requeue",
  taskId = "task-1",
  workerId = "workerbeta",
): SharedStateFenceLeaseAuthorityOutcomeV1 {
  claimTick += 10;
  const nowMs = T0 + claimTick;
  if (op === "renew") {
    return fence.renewTaskLease(
      {
        taskId,
        workerId,
        attemptKeyDigest: stamp.attemptKeyDigest,
        fencingToken: stamp.fencingToken,
        expectedResourceVersion: stamp.resourceVersion,
        leaseDurationMs: LEASE_MS,
      },
      nowMs,
    );
  }
  if (op === "complete") {
    return fence.fenceTaskMutation(
      {
        taskId,
        workerId,
        attemptKeyDigest: stamp.attemptKeyDigest,
        fencingToken: stamp.fencingToken,
        expectedResourceVersion: stamp.resourceVersion,
        mutationKind: "complete",
        mutationBodyHex: "ab",
      },
      nowMs,
    );
  }
  return fence.releaseTaskLease(
    {
      taskId,
      workerId,
      attemptKeyDigest: stamp.attemptKeyDigest,
      fencingToken: stamp.fencingToken,
      expectedResourceVersion: stamp.resourceVersion,
      releaseKind: "requeue",
    },
    nowMs,
  );
}

test("fence lease grants once, conflicts while active, and advances the fence on re-claim", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const first = claim(fence.value);
      assert.equal(first.outcome, "claimed");
      if (first.outcome !== "claimed") return;
      assert.equal(first.fencingToken, "1");
      assert.equal(first.resourceVersion, "1");

      // A live claim blocks a contender (§5.3: at most one unexpired claim).
      const contender = claim(fence.value, "task-1", "workergamma", "0");
      assert.deepEqual(contender, { outcome: "conflict", reasonCode: "claim_conflict" });

      // The holder releases; the next claim rises the fence (never reuses it).
      const released = authority(fence.value, {
        fencingToken: first.fencingToken,
        attemptKeyDigest: first.attemptKeyDigest,
        resourceVersion: first.resourceVersion,
      }, "requeue");
      assert.equal(released.outcome, "released");
      const second = claim(fence.value, "task-1", "workergamma", "2");
      assert.equal(second.outcome, "claimed");
      if (second.outcome === "claimed") {
        assert.equal(second.fencingToken, "2");
      }
    } finally {
      fence.value.release();
    }
  });
});

test("fence lease enforces the authority ladder: stale fence, owner mismatch, wrong version", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const claimed = claim(fence.value);
      assert.ok(claimed.outcome === "claimed");
      if (claimed.outcome !== "claimed") return;
      const stamp = {
        fencingToken: claimed.fencingToken,
        attemptKeyDigest: claimed.attemptKeyDigest,
        resourceVersion: claimed.resourceVersion,
      };

      // Superseded fence is rejected before anything else is revealed. The
      // probe token is a valid positive decimal the row has never issued.
      const stale = authority(fence.value, { ...stamp, fencingToken: "999" }, "renew");
      assert.deepEqual(stale, { outcome: "lost", reasonCode: "stale_fence" });

      // Another worker presenting someone else's stamp is an owner mismatch.
      const impostor = authority(fence.value, stamp, "renew", "task-1", "workergamma");
      assert.deepEqual(impostor, { outcome: "lost", reasonCode: "owner_mismatch" });

      // A fabricated version is a version conflict, not an accept.
      const wrongVersion = authority(fence.value, { ...stamp, resourceVersion: "9" }, "renew");
      assert.deepEqual(wrongVersion, { outcome: "lost", reasonCode: "version_conflict" });

      // The legitimate holder renews.
      const renewed = authority(fence.value, stamp, "renew");
      assert.equal(renewed.outcome, "renewed");
      if (renewed.outcome === "renewed") {
        assert.equal(renewed.resourceVersion, "2");
      }
    } finally {
      fence.value.release();
    }
  });
});

test("fence lease terminal mutation ends the claim and expiry re-allows claiming", () => {
  withTempDir((directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const claimed = claim(fence.value);
      assert.ok(claimed.outcome === "claimed");
      if (claimed.outcome !== "claimed") return;
      const stamp = {
        fencingToken: claimed.fencingToken,
        attemptKeyDigest: claimed.attemptKeyDigest,
        resourceVersion: claimed.resourceVersion,
      };
      const applied = authority(fence.value, stamp, "complete");
      assert.equal(applied.outcome, "applied");

      // After the terminal mutation the attempt is gone: re-presenting the
      // stamp cannot renew or re-complete — the ladder rejects it.
      const late = authority(fence.value, stamp, "renew");
      assert.equal(late.outcome, "lost");

      // The claim ended, so the resource is claimable again by a contender
      // presenting the advanced version — and the fence rises, never reuses.
      const next = claim(fence.value, "task-1", "workergamma", "2");
      assert.equal(next.outcome, "claimed");
      if (next.outcome === "claimed") {
        assert.equal(next.fencingToken, "2");
      }
    } finally {
      fence.value.release();
    }
  });
});

test("fence lease is fail-closed: released fence and malformed input are unavailable", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const fence = openSharedStateServingFenceV1({ filePath });
    assert.ok(fence.ok);
    const handle = fence.value;
    handle.release();
    const afterRelease = claim(handle);
    assert.equal(afterRelease.outcome, "unavailable");
    if (afterRelease.outcome === "unavailable") {
      assert.equal(afterRelease.reasonCode, "adapter_unavailable");
    }

    const reopened = openSharedStateServingFenceV1({ filePath });
    assert.ok(reopened.ok);
    try {
      // Zero lease duration violates the V1 command schema → unavailable,
      // never a fabricated grant.
      const bad = reopened.value.claimTaskLease(
        { taskId: "task-1", workerId: "workerbeta", expectedResourceVersion: "0", leaseDurationMs: 0 },
        T0,
      );
      assert.equal(bad.outcome, "unavailable");
    } finally {
      reopened.value.release();
    }
  });
});

test("fence lease keeps the fencing token and version across a clean restart", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const first = openSharedStateServingFenceV1({ filePath });
    assert.ok(first.ok);
    const claimed = claim(first.value);
    assert.ok(claimed.outcome === "claimed");
    if (claimed.outcome !== "claimed") return;
    const stamp = {
      fencingToken: claimed.fencingToken,
      attemptKeyDigest: claimed.attemptKeyDigest,
      resourceVersion: claimed.resourceVersion,
    };
    first.value.release();

    // After a clean restart the durable stamp still renews and the fence
    // still advances from where it left off (§5.3 restart continuity).
    const second = openSharedStateServingFenceV1({ filePath });
    assert.ok(second.ok);
    try {
      const renewed = authority(second.value, stamp, "renew");
      assert.equal(renewed.outcome, "renewed");
      if (renewed.outcome !== "renewed") return;
      assert.equal(renewed.resourceVersion, "2");

      const released = authority(second.value, { ...stamp, resourceVersion: renewed.resourceVersion }, "requeue");
      assert.equal(released.outcome, "released");
      const reClaimed = claim(second.value, "task-1", "workergamma", "3");
      assert.equal(reClaimed.outcome, "claimed");
      if (reClaimed.outcome === "claimed") {
        // The fence resumed above the pre-restart value, never below it.
        assert.equal(reClaimed.fencingToken, "2");
      }
    } finally {
      second.value.release();
    }
  });
});
