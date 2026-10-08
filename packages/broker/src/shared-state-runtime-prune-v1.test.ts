/**
 * Tests for the #2344 in-process V1 runtime prune.
 *
 * - Fence level: `pruneExpiredRows` deletes only rows that can never be live
 *   again (cutoff clamped to the persisted clock floor), keeps live nonces
 *   rejecting replays, honors the rate-cost retention, and refuses to write
 *   without held ownership or after release.
 * - Config: defaults, env/option precedence, loud startup failures.
 * - Runner: stats, log de-duplication, aggregate summary, never throws.
 * - Server: wired only while the replay or rate primitive is on.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SHARED_STATE_SQLITE_ADAPTER_V1 } from "./shared-state-sqlite-adapter-v1.js";
import {
  openSharedStateServingFenceV1,
  type SharedStateFencePruneOutcomeV1,
  type SharedStateServingFenceV1,
} from "./shared-state-serving-fence-v1.js";
import {
  SHARED_STATE_RUNTIME_PRUNE_V1,
  createSharedStateRuntimePruneV1,
  resolveSharedStateRuntimePruneConfigV1,
} from "./shared-state-runtime-prune-v1.js";
import { startTestServer, withEnv } from "./server-test-helpers.js";

const T0 = 1_700_000_000_000;
const DAY_MS = 86_400_000;

function withFence(run: (fence: SharedStateServingFenceV1, filePath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "a2a-runtime-prune-test-"));
  const filePath = join(directory, "fence.sqlite");
  try {
    const opened = openSharedStateServingFenceV1({ filePath });
    assert.ok(opened.ok);
    try {
      run(opened.value, filePath);
    } finally {
      opened.value.release();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function countRows(filePath: string, table: string): number {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function consume(fence: SharedStateServingFenceV1, nonce: string, ttlMs: number, nowMs: number) {
  return fence.consumeReplayNonce({ keyid: "worker:w1:v1", nonce, ttlMs }, nowMs);
}

function reserve(fence: SharedStateServingFenceV1, principal: string, nowMs: number) {
  return fence.reserveRateLimitCost(
    { bucketClass: "general", principal, cost: 1, limit: 100, windowMs: 1_000 },
    nowMs,
  );
}

test("fence prune deletes only nonces expired before the persisted clock floor", () => {
  withFence((fence, filePath) => {
    assert.equal(consume(fence, "short", 1_000, T0).outcome, "accepted");
    // Advances the persisted floor to T0 + 5000; this nonce stays live.
    assert.equal(consume(fence, "long", 60_000, T0 + 5_000).outcome, "accepted");
    assert.equal(countRows(filePath, "shared_state_replay_nonce"), 2);

    const pruned = fence.pruneExpiredRows({ rateCostRetentionMs: DAY_MS }, T0 + 10_000);
    assert.equal(pruned.outcome, "pruned");
    if (pruned.outcome === "pruned") {
      assert.equal(pruned.nonceDeleted, 1);
      // Clamped to the floor (the last decision instant), not the wall clock.
      assert.equal(pruned.nonceCutoffUnixMs, T0 + 5_000);
    }
    assert.equal(countRows(filePath, "shared_state_replay_nonce"), 1);

    // The surviving live nonce still rejects a replay.
    assert.equal(consume(fence, "long", 60_000, T0 + 6_000).outcome, "replayed");
  });
});

test("fence prune never deletes past the floor even when the wall clock is ahead", () => {
  withFence((fence, filePath) => {
    // Floor = T0; the nonce expires at T0 + 1000.
    assert.equal(consume(fence, "n1", 1_000, T0).outcome, "accepted");
    // Wall clock far ahead, but no decision has moved the floor past expiry.
    const pruned = fence.pruneExpiredRows({ rateCostRetentionMs: DAY_MS }, T0 + 3_600_000);
    assert.equal(pruned.outcome, "pruned");
    if (pruned.outcome === "pruned") {
      assert.equal(pruned.nonceDeleted, 0);
      assert.equal(pruned.nonceCutoffUnixMs, T0);
    }
    assert.equal(countRows(filePath, "shared_state_replay_nonce"), 1);
  });
});

test("fence prune with a backward wall clock deletes less, never more", () => {
  withFence((fence, filePath) => {
    assert.equal(consume(fence, "old", 1_000, T0).outcome, "accepted");
    assert.equal(consume(fence, "new", 1_000, T0 + 5_000).outcome, "accepted");
    // Wall clock behind the floor: cutoff = wall clock (T0 + 500) → nothing
    // has expired before it.
    const pruned = fence.pruneExpiredRows({ rateCostRetentionMs: DAY_MS }, T0 + 500);
    assert.equal(pruned.outcome, "pruned");
    if (pruned.outcome === "pruned") {
      assert.equal(pruned.nonceDeleted, 0);
      assert.equal(pruned.nonceCutoffUnixMs, T0 + 500);
    }
    assert.equal(countRows(filePath, "shared_state_replay_nonce"), 2);
  });
});

test("fence prune keeps rate-cost rows for the retention before the floor", () => {
  withFence((fence, filePath) => {
    assert.equal(reserve(fence, "requester:r1", T0).outcome, "allowed");
    assert.equal(reserve(fence, "requester:r1", T0 + 4_000).outcome, "allowed");
    // Floor = T0 + 4000; retention 2000 → cutoff T0 + 2000.
    const pruned = fence.pruneExpiredRows({ rateCostRetentionMs: 2_000 }, T0 + 10_000);
    assert.equal(pruned.outcome, "pruned");
    if (pruned.outcome === "pruned") {
      assert.equal(pruned.rateCostDeleted, 1);
      assert.equal(pruned.rateCostCutoffUnixMs, T0 + 2_000);
    }
    assert.equal(countRows(filePath, "shared_state_rate_cost"), 1);

    // A long retention deletes nothing.
    const kept = fence.pruneExpiredRows({ rateCostRetentionMs: DAY_MS }, T0 + 10_000);
    assert.equal(kept.outcome, "pruned");
    if (kept.outcome === "pruned") assert.equal(kept.rateCostDeleted, 0);
  });
});

test("fence prune is skipped without held ownership, after release, and on invalid input", () => {
  withFence((fence, filePath) => {
    assert.equal(consume(fence, "n1", 1_000, T0).outcome, "accepted");
    assert.deepEqual(
      fence.pruneExpiredRows({ rateCostRetentionMs: 0 }, T0),
      { outcome: "skipped", reasonCode: "invalid_prune_input" },
    );

    const thief = new DatabaseSync(filePath, { timeout: 0 });
    try {
      thief.prepare(`UPDATE shared_state_ownership SET owner_token = ? WHERE id = ?`)
        .run("someone-else", SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);
    } finally {
      thief.close();
    }
    assert.deepEqual(
      fence.pruneExpiredRows({ rateCostRetentionMs: DAY_MS }, T0 + 10_000),
      { outcome: "skipped", reasonCode: "lost_fence" },
    );
    assert.equal(countRows(filePath, "shared_state_replay_nonce"), 1);
  });

  withFence((fence) => {
    fence.release();
    assert.deepEqual(
      fence.pruneExpiredRows({ rateCostRetentionMs: DAY_MS }, T0),
      { outcome: "skipped", reasonCode: "adapter_unavailable" },
    );
  });
});

test("runtime prune config: defaults, precedence, and loud failures", () => {
  const C = SHARED_STATE_RUNTIME_PRUNE_V1;
  assert.deepEqual(resolveSharedStateRuntimePruneConfigV1({}, {}, 60_000), {
    enabled: true,
    intervalMs: C.defaultIntervalMs,
    rateCostRetentionMs: C.defaultRateCostRetentionMs,
  });
  assert.equal(
    resolveSharedStateRuntimePruneConfigV1({}, { [C.modeEnvKey]: "off" }, 60_000).enabled,
    false,
  );
  assert.deepEqual(
    resolveSharedStateRuntimePruneConfigV1(
      { enabled: true, intervalMs: 5_000, rateCostRetentionMs: 120_000 },
      { [C.modeEnvKey]: "off", [C.intervalEnvKey]: "9000" },
      60_000,
    ),
    { enabled: true, intervalMs: 5_000, rateCostRetentionMs: 120_000 },
  );
  assert.equal(
    resolveSharedStateRuntimePruneConfigV1({}, { [C.intervalEnvKey]: "30000" }, 60_000).intervalMs,
    30_000,
  );
  assert.throws(
    () => resolveSharedStateRuntimePruneConfigV1({}, { [C.modeEnvKey]: "maybe" }, 60_000),
    /BROKER_SHARED_STATE_V1_PRUNE/,
  );
  assert.throws(
    () => resolveSharedStateRuntimePruneConfigV1({}, { [C.intervalEnvKey]: "10s" }, 60_000),
    /BROKER_SHARED_STATE_V1_PRUNE_INTERVAL_MS/,
  );
  assert.throws(
    () => resolveSharedStateRuntimePruneConfigV1({ intervalMs: 999 }, {}, 60_000),
    /PRUNE_INTERVAL_MS/,
  );
  assert.throws(
    () => resolveSharedStateRuntimePruneConfigV1({ rateCostRetentionMs: 60_000 }, {}, 60_000),
    /RATE_RETENTION_MS.*largest rate window/,
  );
});

test("runtime prune runner tracks stats, de-duplicates logs, and never throws", () => {
  const logs: string[] = [];
  const outcomes: Array<SharedStateFencePruneOutcomeV1 | undefined | "throw"> = [
    { outcome: "skipped", reasonCode: "no_clock_floor" },
    { outcome: "skipped", reasonCode: "no_clock_floor" },
    undefined,
    "throw",
    { outcome: "pruned", rateCostDeleted: 2, nonceDeleted: 3, nonceCutoffUnixMs: 1, rateCostCutoffUnixMs: 0 },
  ];
  const seen: Array<[number, number]> = [];
  const runner = createSharedStateRuntimePruneV1({
    config: { enabled: true, intervalMs: 60_000, rateCostRetentionMs: 7_000 },
    prune: (retention, nowMs) => {
      seen.push([retention, nowMs]);
      const next = outcomes.shift();
      if (next === "throw") throw new Error("boom");
      return next;
    },
    now: () => 42,
    log: (line) => logs.push(line),
  });

  for (let i = 0; i < 5; i += 1) runner.runOnce();
  assert.deepEqual(seen[0], [7_000, 42]);
  const stats = runner.stats();
  assert.equal(stats.runs, 5);
  assert.equal(stats.skipped, 3);
  assert.equal(stats.failed, 1);
  assert.equal(stats.pruned, 1);
  assert.equal(stats.nonceDeleted, 3);
  assert.equal(stats.rateCostDeleted, 2);
  assert.equal(stats.lastOutcome, "pruned");
  assert.equal(stats.lastReasonCode, null);
  assert.equal(stats.lastRunAtMs, 42);
  // Two identical skips log once; the fence-less skip and the failure each
  // log on change; the successful run logs a recovery.
  assert.deepEqual(logs.map((line) => line.replace(`${SHARED_STATE_RUNTIME_PRUNE_V1.logPrefix}: `, "")), [
    "skipped (no_clock_floor)",
    "skipped (adapter_unavailable)",
    "failed (store_failure)",
    "recovered (was failed:store_failure)",
  ]);
});

test("runtime prune runner emits one aggregate summary per window and start is gated", () => {
  const logs: string[] = [];
  const runner = createSharedStateRuntimePruneV1({
    config: { enabled: false, intervalMs: 1_000, rateCostRetentionMs: 7_000 },
    prune: () => ({
      outcome: "pruned",
      rateCostDeleted: 1,
      nonceDeleted: 2,
      nonceCutoffUnixMs: 0,
      rateCostCutoffUnixMs: 0,
    }),
    now: () => 1,
    log: (line) => logs.push(line),
  });
  for (let i = 0; i < SHARED_STATE_RUNTIME_PRUNE_V1.summaryEveryRuns; i += 1) runner.runOnce();
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /60 runs deleted nonce=120 rateCost=60/);
  // Disabled config: start() is a no-op (no timer keeps the process alive).
  runner.start();
  runner.stop();
});

test("server wires the runtime prune only while replay or rate is on", async () => {
  const off = await startTestServer();
  try {
    assert.equal(off.runtime.sharedStateRuntimePrune, undefined);
  } finally {
    await off.close();
  }

  const on = await startTestServer({
    sharedStateReplayV1: true,
    sharedStateRuntimePruneV1: { intervalMs: 3_600_000 },
  });
  try {
    const prune = on.runtime.sharedStateRuntimePrune;
    assert.ok(prune);
    const outcome = prune.runOnce(Date.now());
    assert.equal(outcome.outcome, "pruned");
    assert.equal(prune.stats().runs, 1);
  } finally {
    await on.close();
  }
});

test("server startup fails loudly on an invalid runtime prune env value", async () => {
  await withEnv({ BROKER_SHARED_STATE_V1_PRUNE: "maybe" }, async () => {
    await assert.rejects(
      async () => startTestServer({ sharedStateRateV1: true }),
      /BROKER_SHARED_STATE_V1_PRUNE/,
    );
  });
});
