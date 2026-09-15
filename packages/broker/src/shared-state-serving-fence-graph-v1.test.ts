/**
 * Tests for the Slice X fence-mediated graph source append (#1504 §4).
 *
 * The `appendTaskRunGraphSource` passthrough is a fail-closed window onto the
 * fence's single-writer adapter for the §5.6 source-fact authority
 * (`broker.claim-graph`). These tests exercise the outcome mapping
 * (appended / replayed / sequence_conflict / unavailable), fact-digest
 * dedupe, the expected-sequence CAS, and durable high-water continuity
 * across a clean fence restart.
 *
 * #1504 cold-start resync (Q4-successor source design): the fence also
 * exposes the narrow fail-closed `queryGraphSourceHighWater` window onto the
 * closed additive query. These tests pin: an empty namespace observes 0; a
 * directly seeded durable namespace of 1000 rows is observed in one read;
 * a cold gate resyncs with ONE conflict + ONE read + ONE retry (not 1000
 * probes); replays stay original without consulting the read; concurrent
 * external appends are bounded by the explicit retry budget; a high-water
 * below the tracked expectation fails closed; and a synthetic high-water of
 * 1,000,001 stays bounded instead of the old million-probe walk.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SharedStateGraphSourceGateV1 } from "./shared-state-graph-gate-v1.js";
import {
  SHARED_STATE_SERVING_FENCE_V1,
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

// --- #1504 cold-start resync: narrow high-water read + bounded gate ---

interface GateFenceProbe {
  readonly tracked: SharedStateServingFenceV1;
  readonly casAttempts: string[];
  highWaterQueries(): number;
}

/** Wraps a real fence, recording CAS expectations and high-water reads. */
function probeFence(fence: SharedStateServingFenceV1): GateFenceProbe {
  let queries = 0;
  const casAttempts: string[] = [];
  const tracked: SharedStateServingFenceV1 = {
    ...fence,
    appendTaskRunGraphSource(
      input: {
        readonly brokerAuthorityId: string;
        readonly taskId: string;
        readonly status: string;
        readonly completedAt: string;
        readonly expectedSourceSequence: string;
      },
      nowMs: number,
    ) {
      casAttempts.push(input.expectedSourceSequence);
      return fence.appendTaskRunGraphSource(input, nowMs);
    },
    queryGraphSourceHighWater() {
      queries += 1;
      return fence.queryGraphSourceHighWater();
    },
  };
  return { tracked, casAttempts, highWaterQueries: () => queries };
}

/** Seeds `count` canonical rows directly into the durable namespace. */
function seedNamespaceLedger(filePath: string, count: number): void {
  const seeder = new DatabaseSync(filePath);
  try {
    seeder.exec("BEGIN IMMEDIATE");
    const insert = seeder.prepare(
      `INSERT INTO shared_state_graph_source
         (namespace, source_fact_digest, source_stream_key_digest,
          node_type, source_sequence)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (let index = 1; index <= count; index += 1) {
      insert.run(
        SHARED_STATE_SERVING_FENCE_V1.graphNamespace,
        `seed-fact-${index}`,
        "seed-stream",
        "AgentRun",
        String(index),
      );
    }
    seeder.exec("COMMIT");
  } finally {
    seeder.close();
  }
}

test("fence high-water read: empty namespace observes zero, seeded ledger observes the durable maximum, released fence is unavailable", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const fence = openSharedStateServingFenceV1({ filePath });
    assert.ok(fence.ok);
    try {
      assert.deepEqual(fence.value.queryGraphSourceHighWater(), {
        outcome: "observed",
        sourceSequenceHighWater: "0",
      });

      seedNamespaceLedger(filePath, 1000);
      assert.deepEqual(fence.value.queryGraphSourceHighWater(), {
        outcome: "observed",
        sourceSequenceHighWater: "1000",
      });
    } finally {
      fence.value.release();
    }
    assert.deepEqual(fence.value.queryGraphSourceHighWater(), {
      outcome: "unavailable",
      reasonCode: "adapter_unavailable",
    });
  });
});

test("gate cold start at durable high-water 1000: one conflict, one read, one retry — and replays stay original", () => {
  withTempDir((directory) => {
    const filePath = join(directory, "fence.sqlite");
    const fence = openSharedStateServingFenceV1({ filePath });
    assert.ok(fence.ok);
    try {
      seedNamespaceLedger(filePath, 1000);
      const probe = probeFence(fence.value);
      const gate = new SharedStateGraphSourceGateV1(() => probe.tracked);

      const appended = gate.appendTerminalTaskFact({
        brokerAuthorityId: "brokeralpha",
        taskId: "cold-thousand",
        status: "succeeded",
        completedAt: "2026-09-10T00:00:00.000Z",
      });
      assert.equal(appended.sequence, "1001");
      assert.deepEqual(probe.casAttempts, ["0", "1000"]);
      assert.equal(probe.highWaterQueries(), 1);

      // A replayed historical fact answers the ORIGINAL sequence in exactly
      // one CAS attempt and never consults the high-water read.
      const replayed = gate.appendTerminalTaskFact({
        brokerAuthorityId: "brokeralpha",
        taskId: "cold-thousand",
        status: "succeeded",
        completedAt: "2026-09-10T00:00:00.000Z",
      });
      assert.equal(replayed.sequence, "1001");
      assert.deepEqual(probe.casAttempts, ["0", "1000", "1001"]);
      assert.equal(probe.highWaterQueries(), 1);
    } finally {
      fence.value.release();
    }
  });
});

test("synthetic cold start at high-water 1000001 stays bounded (no million-probe walk)", () => {
  // The namespace is pre-advanced to 1,000,001 by a historical authority; the
  // gate appends a FRESH fact cold.
  let highWater = 1_000_001n;
  const durable = new Map<string, string>([
    ["historical-million", "1000001"],
  ]);
  const casAttempts: string[] = [];
  let queries = 0;
  const fake = {
    appendTaskRunGraphSource(input: {
      readonly taskId: string;
      readonly expectedSourceSequence: string;
    }):
      | { readonly outcome: "appended" | "replayed"; readonly sourceSequence: string }
      | { readonly outcome: "sequence_conflict" } {
      casAttempts.push(input.expectedSourceSequence);
      const existing = durable.get(input.taskId);
      if (existing !== undefined) {
        return { outcome: "replayed", sourceSequence: existing };
      }
      if (BigInt(input.expectedSourceSequence) !== highWater) {
        return { outcome: "sequence_conflict" };
      }
      const sourceSequence = (highWater + 1n).toString();
      durable.set(input.taskId, sourceSequence);
      highWater += 1n;
      return { outcome: "appended", sourceSequence };
    },
    queryGraphSourceHighWater():
      | { readonly outcome: "observed"; readonly sourceSequenceHighWater: string }
      | { readonly outcome: "unavailable"; readonly reasonCode: string } {
      queries += 1;
      return { outcome: "observed", sourceSequenceHighWater: highWater.toString() };
    },
  };
  const gate = new SharedStateGraphSourceGateV1(
    () => fake as unknown as SharedStateServingFenceV1,
  );

  assert.equal(
    gate.appendTerminalTaskFact({
      brokerAuthorityId: "brokeralpha",
      taskId: "fresh-after-million",
      status: "succeeded",
      completedAt: "2026-09-10T00:00:00.000Z",
    }).sequence,
    "1000002",
  );
  assert.deepEqual(casAttempts, ["0", "1000001"]);
  assert.equal(queries, 1);
});

test("a concurrent append between the read and the CAS retry is bounded and never regresses", () => {
  // The external authority pre-advanced the ledger to 5, and appends AGAIN
  // during each gate CAS retry — i.e. between the fresh high-water read and
  // the retrying compare-and-set — three times, then stops.
  let highWater = 5n;
  let externalAppends = 0;
  const casAttempts: string[] = [];
  let queries = 0;
  const fake = {
    appendTaskRunGraphSource(input: {
      readonly expectedSourceSequence: string;
    }):
      | { readonly outcome: "appended"; readonly sourceSequence: string }
      | { readonly outcome: "sequence_conflict" } {
      casAttempts.push(input.expectedSourceSequence);
      if (externalAppends < 3) {
        externalAppends += 1;
        highWater += 1n;
      }
      if (BigInt(input.expectedSourceSequence) !== highWater) {
        return { outcome: "sequence_conflict" };
      }
      highWater += 1n;
      return { outcome: "appended", sourceSequence: highWater.toString() };
    },
    queryGraphSourceHighWater():
      | { readonly outcome: "observed"; readonly sourceSequenceHighWater: string }
      | { readonly outcome: "unavailable"; readonly reasonCode: string } {
      queries += 1;
      return { outcome: "observed", sourceSequenceHighWater: highWater.toString() };
    },
  };
  const gate = new SharedStateGraphSourceGateV1(
    () => fake as unknown as SharedStateServingFenceV1,
  );

  // 0 conflicts (contender moves 5→6), read observes 6, retry 6 conflicts
  // (6→7), read 7, retry 7 conflicts (7→8), read 8, retry 8 appends at 9.
  // Bounded: 4 CAS calls, 3 reads — each retry re-uses the SAME CAS.
  assert.equal(
    gate.appendTerminalTaskFact({
      brokerAuthorityId: "brokeralpha",
      taskId: "racer",
      status: "succeeded",
      completedAt: "2026-09-10T00:00:00.000Z",
    }).sequence,
    "9",
  );
  assert.deepEqual(casAttempts, ["0", "6", "7", "8"]);
  assert.equal(queries, 3);
});

test("an always-advancing contender exhausts the explicit conflict budget and fails closed", () => {
  let highWater = 1n;
  const casAttempts: string[] = [];
  let queries = 0;
  const fake = {
    appendTaskRunGraphSource(input: {
      readonly expectedSourceSequence: string;
    }): { readonly outcome: "sequence_conflict" } {
      casAttempts.push(input.expectedSourceSequence);
      return { outcome: "sequence_conflict" };
    },
    queryGraphSourceHighWater():
      | { readonly outcome: "observed"; readonly sourceSequenceHighWater: string }
      | { readonly outcome: "unavailable"; readonly reasonCode: string } {
      queries += 1;
      highWater += 1n;
      return { outcome: "observed", sourceSequenceHighWater: highWater.toString() };
    },
  };
  const gate = new SharedStateGraphSourceGateV1(
    () => fake as unknown as SharedStateServingFenceV1,
  );

  assert.throws(
    () =>
      gate.appendTerminalTaskFact({
        brokerAuthorityId: "brokeralpha",
        taskId: "forever-racer",
        status: "succeeded",
        completedAt: "2026-09-10T00:00:00.000Z",
      }),
    (error: unknown) =>
      error instanceof Error
        && error.message.includes("sequence_resync_conflict_retry_budget_exceeded"),
  );
  // Eight conflict rounds (read + retry each), then the ninth conflict
  // exhausts the budget: 9 CAS attempts, 8 reads — never a million probes.
  assert.equal(casAttempts.length, 9);
  assert.equal(queries, 8);
});

test("a high-water below the tracked expectation fails closed without resetting the cache", () => {
  let highWater = 0n;
  const durable = new Map<string, string>();
  const casAttempts: string[] = [];
  const fake = {
    appendTaskRunGraphSource(input: {
      readonly taskId: string;
      readonly expectedSourceSequence: string;
    }):
      | { readonly outcome: "appended"; readonly sourceSequence: string }
      | { readonly outcome: "sequence_conflict" } {
      casAttempts.push(input.expectedSourceSequence);
      const existing = durable.get(input.taskId);
      if (existing !== undefined) {
        return { outcome: "appended", sourceSequence: existing };
      }
      if (BigInt(input.expectedSourceSequence) !== highWater) {
        return { outcome: "sequence_conflict" };
      }
      highWater += 1n;
      durable.set(input.taskId, highWater.toString());
      return { outcome: "appended", sourceSequence: highWater.toString() };
    },
    queryGraphSourceHighWater():
      | { readonly outcome: "observed"; readonly sourceSequenceHighWater: string }
      | { readonly outcome: "unavailable"; readonly reasonCode: string } {
      return { outcome: "observed", sourceSequenceHighWater: highWater.toString() };
    },
  };
  const gate = new SharedStateGraphSourceGateV1(
    () => fake as unknown as SharedStateServingFenceV1,
  );
  assert.equal(gate.appendTerminalTaskFact(fact("warm-a")).sequence, "1");
  assert.equal(gate.appendTerminalTaskFact(fact("warm-b")).sequence, "2");

  // The source ledger ROLLED BACK under the gate: the durable high-water is
  // now below what the gate already observed.
  highWater = 1n;
  casAttempts.length = 0;
  assert.throws(
    () => gate.appendTerminalTaskFact(fact("warm-c")),
    (error: unknown) =>
      error instanceof Error
        && error.message.includes(
          "source_high_water_below_tracked_expectation",
        ),
  );
  assert.deepEqual(casAttempts, ["2"]);

  // The cache was NOT reset to the regressed observation: once the store
  // recovers to the tracked level, the next append is accepted on the FIRST
  // attempt at the unchanged expectation (a reset cache would send "1").
  highWater = 2n;
  casAttempts.length = 0;
  assert.equal(gate.appendTerminalTaskFact(fact("warm-c")).sequence, "3");
  assert.deepEqual(casAttempts, ["2"]);
});

test("an unavailable high-water read fails closed and never guesses a sequence", () => {
  let highWater = 4n;
  let readsFail = false;
  const fake = {
    appendTaskRunGraphSource(input: {
      readonly expectedSourceSequence: string;
    }):
      | { readonly outcome: "appended"; readonly sourceSequence: string }
      | { readonly outcome: "sequence_conflict" } {
      if (BigInt(input.expectedSourceSequence) !== highWater) {
        return { outcome: "sequence_conflict" };
      }
      highWater += 1n;
      return { outcome: "appended", sourceSequence: highWater.toString() };
    },
    queryGraphSourceHighWater():
      | { readonly outcome: "observed"; readonly sourceSequenceHighWater: string }
      | { readonly outcome: "unavailable"; readonly reasonCode: string } {
      return readsFail
        ? { outcome: "unavailable", reasonCode: "lock_timeout" }
        : { outcome: "observed", sourceSequenceHighWater: highWater.toString() };
    },
  };
  const gate = new SharedStateGraphSourceGateV1(
    () => fake as unknown as SharedStateServingFenceV1,
  );
  readsFail = true;
  assert.throws(
    () =>
      gate.appendTerminalTaskFact(fact("unreachable-append")),
    (error: unknown) =>
      error instanceof Error && error.message.includes("lock_timeout"),
  );
  readsFail = false;
  assert.equal(
    gate.appendTerminalTaskFact(fact("unreachable-append")).sequence,
    "5",
  );
});

function fact(taskId: string): {
  readonly brokerAuthorityId: string;
  readonly taskId: string;
  readonly status: string;
  readonly completedAt: string;
} {
  return {
    brokerAuthorityId: "brokeralpha",
    taskId,
    status: "succeeded",
    completedAt: "2026-09-10T00:00:00.000Z",
  };
}
