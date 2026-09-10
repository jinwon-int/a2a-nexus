/**
 * Tests for the #1504 §5 Phase 6 live-shadow runtime.
 *
 * The runtime is evidence-only: it mirrors live replay/rate decisions into a
 * separate shadow store and classifies agreement (match), bounded warm-up
 * disagreement (warmup_mismatch), and everything else (unexplained). It can
 * never throw into the request path and its counters are aggregate-only.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SharedStateShadowRuntimeV1 } from "./shared-state-shadow-runtime-v1.js";

function withTempDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "a2a-shadow-runtime-test-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const T0 = 1_700_000_000_000;

test("shadow runtime mirrors replay decisions and counts matches", () => {
  withTempDir((directory) => {
    const runtime = new SharedStateShadowRuntimeV1({
      shadowFile: join(directory, "shadow.sqlite"),
      startedAtMs: T0 - 10 * 60_000, // warm-up long past
    });
    try {
      runtime.observeReplay(
        { keyid: "worker:w1:v1", nonce: "n1", ttlMs: 60_000, liveWasFirst: true },
        T0,
      );
      // Same nonce: live now sees a duplicate; the shadow replays it too.
      runtime.observeReplay(
        { keyid: "worker:w1:v1", nonce: "n1", ttlMs: 60_000, liveWasFirst: false },
        T0 + 1,
      );
      runtime.observeReplay(
        { keyid: "worker:w1:v1", nonce: "n2", ttlMs: 60_000, liveWasFirst: true },
        T0 + 2,
      );
      const snap = runtime.snapshot();
      assert.equal(snap.replay.compared, 3);
      assert.equal(snap.replay.matches, 3);
      assert.equal(snap.replay.warmupMismatches, 0);
      assert.equal(snap.replay.unexplained, 0);
    } finally {
      runtime.close();
    }
  });
});

test("shadow runtime classifies warm-up disagreement, then unexplained", () => {
  withTempDir((directory) => {
    // startedAtMs in the past → warm-up window over.
    const runtime = new SharedStateShadowRuntimeV1({
      shadowFile: join(directory, "shadow.sqlite"),
      startedAtMs: T0 - 10 * 60_000,
    });
    try {
      // The shadow has never seen n1, so it says "first" while live says
      // duplicate (a pre-shadow nonce) → unexplained.
      runtime.observeReplay(
        { keyid: "worker:w1:v1", nonce: "n1", ttlMs: 60_000, liveWasFirst: false },
        T0,
      );
      let snap = runtime.snapshot();
      assert.equal(snap.replay.unexplained, 1);
    } finally {
      runtime.close();
    }

    // A freshly started runtime is inside the warm-up window: the same
    // disagreement classifies as warmup_mismatch instead.
    const fresh = new SharedStateShadowRuntimeV1({
      shadowFile: join(directory, "shadow-warmup.sqlite"),
      startedAtMs: Date.now(),
    });
    try {
      fresh.observeReplay(
        { keyid: "worker:w1:v1", nonce: "n1", ttlMs: 60_000, liveWasFirst: false },
        Date.now(),
      );
      const snap = fresh.snapshot();
      assert.equal(snap.replay.warmupMismatches, 1);
      assert.equal(snap.replay.unexplained, 0);
    } finally {
      fresh.close();
    }
  });
});

test("shadow runtime mirrors rate decisions and records evaluation failures as unexplained", () => {
  withTempDir((directory) => {
    const runtime = new SharedStateShadowRuntimeV1({
      shadowFile: join(directory, "shadow.sqlite"),
      startedAtMs: T0 - 10 * 60_000,
    });
    try {
      const base = {
        bucketClass: "general" as const,
        principal: "ip:10.0.0.1",
        limit: 2,
        windowMs: 60_000,
      };
      runtime.observeRate({ ...base, liveAllowed: true }, T0);
      runtime.observeRate({ ...base, liveAllowed: true }, T0 + 1);
      // Live denies the third request; the shadow (same empty start, same
      // limit) must deny too.
      runtime.observeRate({ ...base, liveAllowed: false }, T0 + 2);
      // A shadow evaluation failure (limit 0 fails the command schema) is
      // unexplained, never a throw.
      runtime.observeRate({ ...base, limit: 0, liveAllowed: true }, T0 + 3);
      const snap = runtime.snapshot();
      assert.equal(snap.rate.compared, 4);
      assert.equal(snap.rate.matches, 3);
      assert.equal(snap.rate.unexplained, 1);
    } finally {
      runtime.close();
    }
  });
});
