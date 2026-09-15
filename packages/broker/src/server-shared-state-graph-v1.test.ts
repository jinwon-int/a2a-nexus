/**
 * Server-level tests for the #1504 §4 Slice X graph-primitive integration.
 *
 * With `sharedStateGraphV1: true` every terminal task transition appends one
 * source fact through the V1 `appendGraphSource` authority
 * (`broker.claim-graph`), deduped by the fact digest, and the namespace
 * high-water survives a full server restart. The default-off posture
 * allocates nothing in the V1 graph store. The loud startup failure on an
 * invalid env value is asserted as well.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBrokerServer } from "./server.js";
import {
  openSharedStateServingFenceV1,
  type SharedStateServingFenceV1,
} from "./shared-state-serving-fence-v1.js";
import { SharedStateGraphSourceGateV1 } from "./shared-state-graph-gate-v1.js";
import {
  createInMemoryStateStore,
  jsonHeaders,
  startTestServer,
  withEnv,
  workerPayload,
} from "./server-test-helpers.js";

/**
 * Wraps a real fence so every gate→fence `appendTaskRunGraphSource` call is
 * observable: one recorded entry per CAS append attempt against the adapter,
 * capturing the exact `expectedSourceSequence` string the gate sent, plus a
 * counter for the narrow `queryGraphSourceHighWater` resync reads.
 */
function trackedFence(fence: SharedStateServingFenceV1): {
  readonly tracked: SharedStateServingFenceV1;
  readonly expected: string[];
  highWaterQueries(): number;
} {
  const expected: string[] = [];
  let highWaterQueries = 0;
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
      expected.push(input.expectedSourceSequence);
      return fence.appendTaskRunGraphSource(input, nowMs);
    },
    queryGraphSourceHighWater() {
      highWaterQueries += 1;
      return fence.queryGraphSourceHighWater();
    },
  };
  return { tracked, expected, highWaterQueries: () => highWaterQueries };
}

/** A deterministic terminal fact; distinct task ids hash to distinct facts. */
function factOf(taskId: string): {
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

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "a2a-server-graph-v1-test-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function registerWorker(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/workers/register`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
    body: JSON.stringify(workerPayload("workerbeta")),
  });
  assert.ok(res.status === 200 || res.status === 201);
}

async function createAndCompleteTask(baseUrl: string, id: string): Promise<void> {
  const create = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "hub-a", "x-a2a-requester-role": "hub" }),
    body: JSON.stringify({
      id,
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "workerbeta", kind: "node", role: "analyst" },
      targetNodeId: "workerbeta",
      message: "graph test task",
      taskOrigin: "api",
    }),
  });
  assert.equal(create.status, 201);
  const claim = await fetch(`${baseUrl}/tasks/${id}/claim`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
    body: JSON.stringify({ workerId: "workerbeta" }),
  });
  assert.equal(claim.status, 200);
  const complete = await fetch(`${baseUrl}/tasks/${id}/complete`, {
    method: "POST",
    headers: jsonHeaders({ "x-a2a-requester-id": "workerbeta", "x-a2a-requester-role": "analyst" }),
    body: JSON.stringify({ workerId: "workerbeta", result: { summary: "done" } }),
  });
  assert.equal(complete.status, 200);
}

/**
 * Measures the durable namespace high-water by appending a fresh probe fact
 * through the very gate under test — its cold-start resync resolves a stale
 * expectation with one durable high-water read plus a bounded CAS retry, so
 * the probe works regardless of prior facts. Probe facts are part of the
 * ledger; each probe allocates one.
 */
function probeHighWater(
  fence: SharedStateServingFenceV1,
  probeId: string,
): bigint {
  const gate = new SharedStateGraphSourceGateV1(() => fence);
  const { sequence } = gate.appendTerminalTaskFact({
    brokerAuthorityId: "brokeralpha",
    taskId: `graph-probe-${probeId}`,
    status: "succeeded",
    completedAt: "2026-09-10T00:00:00.000Z",
  });
  return BigInt(sequence);
}

test("sharedStateGraphV1 consumes a source sequence per terminal transition", async () => {
  await withTempDir(async (directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    const server = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateGraphV1: true,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server.baseUrl);
      await createAndCompleteTask(server.baseUrl, "graph-task-1");
      await createAndCompleteTask(server.baseUrl, "graph-task-2");
    } finally {
      // The fence is a singleton CAS: probe only after the server releases it.
      await server.close();
    }

    // Two terminal transitions in a fresh namespace consumed sequences 1 and
    // 2; this probe itself allocated 3 (high-water + 1).
    const probe = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe.ok);
    try {
      const probeSequence = probeHighWater(probe.value, "one");
      assert.equal(probeSequence, 3n);
    } finally {
      probe.value.release();
    }
  });
});

test("sharedStateGraphV1 dedupes repeated terminal facts and keeps the high-water across a restart", async () => {
  await withTempDir(async (directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    const server1 = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateGraphV1: true,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server1.baseUrl);
      await createAndCompleteTask(server1.baseUrl, "graph-restart-1");
    } finally {
      await server1.close();
    }

    const probe1 = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe1.ok);
    const highWater1 = probeHighWater(probe1.value, "pre-restart");
    probe1.value.release();

    // Restart on the same durable store: the second server's terminal
    // transitions continue ABOVE the pre-restart high-water (the gate's
    // cold-start resync reads the durable mark and retries the CAS once).
    const server2 = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateGraphV1: true,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server2.baseUrl);
      await createAndCompleteTask(server2.baseUrl, "graph-restart-2");
    } finally {
      await server2.close();
    }

    const probe2 = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe2.ok);
    try {
      const highWater2 = probeHighWater(probe2.value, "post-restart");
      // One completion pre-restart + the probe + one completion post-restart.
      assert.ok(
        highWater2 >= highWater1 + 2n,
        `expected post-restart high-water (${highWater2}) >= pre (${highWater1}) + 2`,
      );
    } finally {
      probe2.value.release();
    }
  });
});

test("default-off allocates nothing in the V1 graph store", async () => {
  await withTempDir(async (directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    const server = await startTestServer({
      brokerId: "brokeralpha",
      sharedStateGraphV1: false,
      sharedStateFile,
      enforceRequesterIdentity: false,
    });
    try {
      await registerWorker(server.baseUrl);
      await createAndCompleteTask(server.baseUrl, "legacy-graph");
    } finally {
      await server.close();
    }

    // The legacy path never touched the V1 store: the first allocation in
    // the fresh namespace is this probe at sequence 1.
    const probe = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(probe.ok);
    try {
      const highWater = probeHighWater(probe.value, "legacy");
      assert.equal(highWater, 1n);
    } finally {
      probe.value.release();
    }
  });
});

test("invalid BROKER_SHARED_STATE_V1_GRAPH value fails startup loudly", async () => {
  await withEnv({ BROKER_SHARED_STATE_V1_GRAPH: "definitely-not-a-mode" }, async () => {
    assert.throws(
      () =>
        createBrokerServer({
          host: "127.0.0.1",
          port: 0,
          publicBaseUrl: "https://broker.test/",
          brokerId: "brokeralpha",
          stateStore: createInMemoryStateStore(),
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("BROKER_SHARED_STATE_V1_GRAPH"),
    );
  });
});

test("#1504 regression: a replayed historical fact does not regress the warm gate cache", async () => {
  await withTempDir(async (directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const { tracked, expected } = trackedFence(fence.value);
      const gate = new SharedStateGraphSourceGateV1(() => tracked);

      // Three fresh appends: sequences 1, 2, 3 — one CAS attempt each.
      assert.deepEqual(
        [
          gate.appendTerminalTaskFact(factOf("warm-a")).sequence,
          gate.appendTerminalTaskFact(factOf("warm-b")).sequence,
          gate.appendTerminalTaskFact(factOf("warm-c")).sequence,
        ],
        ["1", "2", "3"],
      );
      assert.deepEqual(expected, ["0", "1", "2"]);

      // A replayed HISTORICAL fact returns its original sequence…
      expected.length = 0;
      assert.equal(gate.appendTerminalTaskFact(factOf("warm-a")).sequence, "1");
      // …in exactly one CAS attempt, allocating no duplicate.
      assert.deepEqual(expected, ["3"]);

      // The warm cache stayed at 3: the next FRESH append is accepted on its
      // first attempt (a regressed cache would re-probe "1", "2", "3").
      expected.length = 0;
      assert.equal(gate.appendTerminalTaskFact(factOf("warm-d")).sequence, "4");
      assert.deepEqual(expected, ["3"]);
    } finally {
      fence.value.release();
    }
  });
});

test("#1504 regression: interleaved old and new replays keep the tracked sequence at the committed high-water", async () => {
  await withTempDir(async (directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const { tracked, expected } = trackedFence(fence.value);
      const gate = new SharedStateGraphSourceGateV1(() => tracked);

      assert.deepEqual(
        [
          gate.appendTerminalTaskFact(factOf("mix-a")).sequence,
          gate.appendTerminalTaskFact(factOf("mix-b")).sequence,
          gate.appendTerminalTaskFact(factOf("mix-c")).sequence,
        ],
        ["1", "2", "3"],
      );

      // Newest, then oldest, then middle: every replay answers the ORIGINAL
      // sequence in exactly one CAS attempt…
      expected.length = 0;
      assert.equal(gate.appendTerminalTaskFact(factOf("mix-c")).sequence, "3");
      assert.equal(gate.appendTerminalTaskFact(factOf("mix-a")).sequence, "1");
      assert.equal(gate.appendTerminalTaskFact(factOf("mix-b")).sequence, "2");
      assert.deepEqual(expected, ["3", "3", "3"]);

      // …and none of them dragged the tracked sequence below 3.
      expected.length = 0;
      assert.equal(gate.appendTerminalTaskFact(factOf("mix-d")).sequence, "4");
      assert.deepEqual(expected, ["3"]);

      // A replay of the newest fact is equally harmless.
      expected.length = 0;
      assert.equal(gate.appendTerminalTaskFact(factOf("mix-d")).sequence, "4");
      assert.deepEqual(expected, ["4"]);
      expected.length = 0;
      assert.equal(gate.appendTerminalTaskFact(factOf("mix-e")).sequence, "5");
      assert.deepEqual(expected, ["4"]);
    } finally {
      fence.value.release();
    }
  });
});

test("#1504 regression: after a reopen a cold gate resyncs with one bounded read, replays stay original, and warm appends stay one call", async () => {
  await withTempDir(async (directory) => {
    const sharedStateFile = join(directory, "fence.sqlite");
    const first = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(first.ok);
    try {
      const gate1 = new SharedStateGraphSourceGateV1(() => first.value);
      assert.equal(gate1.appendTerminalTaskFact(factOf("reopen-a")).sequence, "1");
      assert.equal(gate1.appendTerminalTaskFact(factOf("reopen-b")).sequence, "2");
      assert.equal(gate1.appendTerminalTaskFact(factOf("reopen-c")).sequence, "3");
    } finally {
      first.value.release();
    }

    const reopened = openSharedStateServingFenceV1({ filePath: sharedStateFile });
    assert.ok(reopened.ok);
    try {
      const { tracked, expected, highWaterQueries } = trackedFence(reopened.value);
      const gate2 = new SharedStateGraphSourceGateV1(() => tracked);

      // The cold gate replays the old fact: the adapter answers the durable
      // fact before any CAS check, so this is one attempt at expectation "0"
      // returning the ORIGINAL sequence (never the current high-water).
      assert.equal(gate2.appendTerminalTaskFact(factOf("reopen-a")).sequence, "1");
      assert.deepEqual(expected, ["0"]);
      assert.equal(highWaterQueries(), 0);

      // Cold-start resync is bounded: the fresh append conflicts once at the
      // stale counter ("1"), reads the durable mark (3) once, and the SAME
      // CAS retries at "3" and is accepted at 4 — three calls, not a probe
      // walk.
      expected.length = 0;
      assert.equal(gate2.appendTerminalTaskFact(factOf("reopen-d")).sequence, "4");
      assert.deepEqual(expected, ["1", "3"]);
      assert.equal(highWaterQueries(), 1);

      // A replayed historical fact does not drag the resynced counter back…
      expected.length = 0;
      assert.equal(gate2.appendTerminalTaskFact(factOf("reopen-b")).sequence, "2");
      assert.deepEqual(expected, ["4"]);
      assert.equal(highWaterQueries(), 1);

      // …so the next fresh append is one CAS attempt again.
      expected.length = 0;
      assert.equal(gate2.appendTerminalTaskFact(factOf("reopen-e")).sequence, "5");
      assert.deepEqual(expected, ["4"]);
      assert.equal(highWaterQueries(), 1);
    } finally {
      reopened.value.release();
    }
  });
});

test("#1504 regression: two gates sharing one fence resync past an external append advance without regressing", async () => {
  await withTempDir(async (directory) => {
    const fence = openSharedStateServingFenceV1({
      filePath: join(directory, "fence.sqlite"),
    });
    assert.ok(fence.ok);
    try {
      const { tracked, expected } = trackedFence(fence.value);
      const gateA = new SharedStateGraphSourceGateV1(() => tracked);
      const gateB = new SharedStateGraphSourceGateV1(() => tracked);

      assert.equal(gateA.appendTerminalTaskFact(factOf("twin-a")).sequence, "1");

      // gateB starts cold and resyncs past gateA's advance ("0" conflicts,
      // "1" accepts at 2).
      expected.length = 0;
      assert.equal(gateB.appendTerminalTaskFact(factOf("twin-b")).sequence, "2");
      assert.deepEqual(expected, ["0", "1"]);

      // gateA's tracked sequence is now behind another append authority;
      // resync remains possible: "1" conflicts, "2" accepts at 3.
      expected.length = 0;
      assert.equal(gateA.appendTerminalTaskFact(factOf("twin-c")).sequence, "3");
      assert.deepEqual(expected, ["1", "2"]);

      // A replay of a historical fact answers the original sequence in one
      // attempt at gateB's own tracked expectation. It must NOT fabricate
      // the current high-water — gateB cannot learn gateA's advance from a
      // replay, so its warm cache stays at 2 (never regressed, never
      // invented)…
      expected.length = 0;
      assert.equal(gateB.appendTerminalTaskFact(factOf("twin-a")).sequence, "1");
      assert.deepEqual(expected, ["2"]);

      // …and gateB's next fresh append resyncs past the external advance:
      // "2" conflicts, "3" accepts at 4.
      expected.length = 0;
      assert.equal(gateB.appendTerminalTaskFact(factOf("twin-d")).sequence, "4");
      assert.deepEqual(expected, ["2", "3"]);
    } finally {
      fence.value.release();
    }
  });
});

test("#1504 regression: sequences beyond MAX_SAFE_INTEGER stay exact strings through replays", () => {
  // Minimal fake fence standing in for the adapter: dedupe precedes the CAS
  // check (like the real SQLite adapter), fresh facts accept only the exact
  // tracked high-water, sequences are canonical strings. The namespace is
  // pre-advanced beyond Number.MAX_SAFE_INTEGER (2^53 + 1, unrepresentable
  // as a Number): one historical fact is already durable at that sequence.
  let highWater = 9007199254740993n;
  const durable = new Map<string, string>([
    ["big-cold", "9007199254740993"],
  ]);
  const expected: string[] = [];
  const fake = {
    appendTaskRunGraphSource(input: {
      readonly taskId: string;
      readonly expectedSourceSequence: string;
    }):
      | { readonly outcome: "appended" | "replayed"; readonly sourceSequence: string }
      | { readonly outcome: "sequence_conflict" } {
      expected.push(input.expectedSourceSequence);
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
  };
  const gate = new SharedStateGraphSourceGateV1(
    () => fake as unknown as SharedStateServingFenceV1,
  );

  // The cold fact replays at its durable sequence — exact string out, one
  // attempt at the cold gate's expectation "0".
  assert.equal(gate.appendTerminalTaskFact(factOf("big-cold")).sequence, "9007199254740993");
  assert.deepEqual(expected, ["0"]);

  // The fresh append sends the tracked expectation as an exact BigInt string
  // (a Number-based cache would round 2^53+1 down to 2^53 and never accept)
  // and is accepted on its first attempt.
  expected.length = 0;
  assert.equal(gate.appendTerminalTaskFact(factOf("big-fresh")).sequence, "9007199254740994");
  assert.deepEqual(expected, ["9007199254740993"]);

  // Replaying the historical cold fact returns the ORIGINAL exact string and
  // leaves the tracked expectation at 2^53+2.
  expected.length = 0;
  assert.equal(gate.appendTerminalTaskFact(factOf("big-cold")).sequence, "9007199254740993");
  assert.deepEqual(expected, ["9007199254740994"]);

  // So the next fresh append is one exact-string CAS attempt.
  expected.length = 0;
  assert.equal(gate.appendTerminalTaskFact(factOf("big-fresh-2")).sequence, "9007199254740995");
  assert.deepEqual(expected, ["9007199254740994"]);
});
