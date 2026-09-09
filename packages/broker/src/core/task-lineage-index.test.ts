import assert from "node:assert/strict";
import test from "node:test";

import { BrokerError } from "./broker-error.js";
import { TaskLineageIndex } from "./task-lineage-index.js";
import {
  buildTaskLineageReadProjection,
  parseTaskLineageChildrenRequestV1,
  parseTaskLineageLeavesRequestV1,
  parseTaskLineageLineageRequestV1,
  TaskLineageCycleError,
} from "./task-lineage-read.js";
import type { TaskRecord } from "./types.js";

const T0 = Date.parse("2026-07-28T00:00:00.000Z");

/** Deterministic PRNG (mulberry32) so fixtures are reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    intent: "analyze",
    status: "queued",
    requester: { id: "requester-a", kind: "service", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: { secretPayload: `payload-${id}` },
    message: `message-${id}`,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

function createdAtMs(index: number): string {
  return new Date(T0 + index * 1_000).toISOString();
}

/**
 * Deterministic lineage fixture: a forest with canonical chains, cross
 * references (present/absent/duplicate), round stamps with and without
 * totals, records whose parents arrive late, an invalid reference entry,
 * and one canonical cycle.
 */
function fixture(seed: number): TaskRecord[] {
  const random = rng(seed);
  const records: TaskRecord[] = [];
  const intents = ["analyze", "verify", "chat"] as const;
  const statuses = ["queued", "running", "succeeded", "failed"] as const;
  let index = 0;
  const next = (overrides: Partial<TaskRecord> = {}): TaskRecord => {
    const record = task(`t-${index}`, {
      createdAt: createdAtMs(index),
      intent: intents[Math.floor(random() * intents.length)]!,
      status: statuses[Math.floor(random() * statuses.length)]!,
      parentRoundId: undefined,
      ...overrides,
    });
    index += 1;
    records.push(record);
    return record;
  };

  // Three chains of canonical parents.
  for (const prefix of ["a", "b", "c"]) {
    let parent: TaskRecord | undefined;
    for (let depth = 0; depth < 6; depth += 1) {
      parent = next({ id: `${prefix}-${depth}`, parentTaskId: parent?.id });
    }
  }

  // Round-stamped siblings, some with totals, some referencing each other.
  for (let round = 0; round < 3; round += 1) {
    const roundId = `round-${round}`;
    const withTotal = round !== 1;
    const siblings: TaskRecord[] = [];
    for (let child = 0; child < 4; child += 1) {
      siblings.push(next({
        parentTaskId: child === 0 ? "a-0" : siblings[child - 1]!.id,
        parentRoundId: roundId,
        ...(withTotal ? { parentRoundTotal: 4, parentRoundOrder: child + 1 } : {}),
      }));
    }
    siblings[1]!.referenceTaskIds = [siblings[0]!.id, "missing-ref"];
    siblings[2]!.referenceTaskIds = [siblings[0]!.id, siblings[0]!.id];
  }

  // Late-arrival cases: children pushed before their parents exist.
  const lateChild = next({ parentTaskId: "late-parent", referenceTaskIds: ["late-ref"] });
  next({ parentTaskId: "late-parent", parentRoundId: "late-round" });
  records.push(task("late-parent", { createdAt: createdAtMs(900) }));
  records.push(task("late-ref", {
    createdAt: createdAtMs(901),
    parentTaskId: lateChild.id,
  }));

  // One canonical cycle (cyc-a → cyc-b → cyc-c → cyc-a) plus a descendant.
  next({ id: "cyc-a", parentTaskId: "cyc-c" });
  next({ id: "cyc-b", parentTaskId: "cyc-a" });
  next({ id: "cyc-c", parentTaskId: "cyc-b" });
  next({ id: "cyc-d", parentTaskId: "cyc-b" });

  // Invalid references and a missing-parent-with-invalid-id case.
  next({ referenceTaskIds: ["no-such-task", "a-0"] });
  next({ parentTaskId: "bad id with spaces" });
  return records;
}

function shallow(window: unknown): string {
  return JSON.stringify(window);
}

/** Run the full query battery against a projection and hash the outcomes. */
function queryBattery(
  projection: ReturnType<typeof buildTaskLineageReadProjection>,
  records: TaskRecord[],
): string {
  const lines: string[] = [];
  const ids = records.map((record) => record.id);
  const capture = (action: () => unknown): void => {
    try {
      lines.push(shallow(action()));
    } catch (error) {
      if (error instanceof BrokerError || error instanceof TaskLineageCycleError) {
        lines.push(`${error.name}:${("code" in error ? error.code : "")}`);
      } else {
        throw error;
      }
    }
  };

  for (const id of ids) {
    capture(() => projection.children(parseTaskLineageChildrenRequestV1({ taskId: id, limit: 200 })));
    capture(() => projection.children(parseTaskLineageChildrenRequestV1({ taskId: id, limit: 2 })));
    capture(() => projection.lineage(parseTaskLineageLineageRequestV1({ taskId: id, maxDepth: 3 })));
    capture(() => projection.lineage(parseTaskLineageLineageRequestV1({ taskId: id, maxDepth: 128 })));
  }
  for (const round of ["round-0", "round-1", "round-2", "late-round", "absent-round"]) {
    capture(() => projection.children(parseTaskLineageChildrenRequestV1({ parentRoundId: round, limit: 200 })));
  }
  const leafFilters: Array<Record<string, unknown>> = [
    {},
    { parentRoundId: "round-0" },
    { parentRoundId: "round-2" },
    { intent: "verify" },
    { status: ["succeeded"] },
    { since: createdAtMs(3), until: createdAtMs(9) },
    { parentRoundId: "round-1", limit: 3 },
  ];
  for (const filters of leafFilters) {
    capture(() => projection.leaves(parseTaskLineageLeavesRequestV1(filters)));
  }
  return lines.join("\n");
}

test("incremental index matches the batch builder across insertion orders", () => {
  for (const seed of [1, 42, 1337]) {
    const records = fixture(seed);

    const batch = queryBattery(buildTaskLineageReadProjection(records), records);

    const index = new TaskLineageIndex();
    for (const record of records) index.upsert(record);
    const incremental = queryBattery(index.projection(), records);
    assert.equal(incremental, batch, `insertion order mismatch (seed ${seed})`);

    // Reverse order: parents arrive after children, references resolve late.
    const reversed = new TaskLineageIndex();
    for (const record of [...records].reverse()) reversed.upsert(record);
    const reversedBattery = queryBattery(reversed.projection(), records);
    assert.equal(reversedBattery, batch, `reverse order mismatch (seed ${seed})`);

    // Shuffled order (deterministic).
    const random = rng(seed + 7);
    const shuffled = [...records];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const shuffledIndex = new TaskLineageIndex();
    for (const record of shuffled) shuffledIndex.upsert(record);
    assert.equal(queryBattery(shuffledIndex.projection(), records), batch, `shuffled mismatch (seed ${seed})`);
  }
});

test("compaction keeps every response byte-identical", () => {
  const records = fixture(42);
  const batch = queryBattery(buildTaskLineageReadProjection(records), records);
  const index = new TaskLineageIndex();
  for (const record of records) index.upsert(record);
  for (const record of records) index.compact(record.id);
  assert.equal(queryBattery(index.projection(), records), batch);
});

test("late parent arrival clears parent_missing and materializes edges", () => {
  const parent = task("parent", { createdAt: createdAtMs(2) });
  const child = task("child", {
    createdAt: createdAtMs(1),
    parentTaskId: "parent",
  });

  const incremental = new TaskLineageIndex();
  incremental.upsert(child);
  const before = incremental.projection().lineage(parseTaskLineageLineageRequestV1({ taskId: "child", maxDepth: 8 }));
  assert.equal(before.lineage[0]?.parentMissing, true);
  assert.equal(before.diagnostics.anomalies.some((a) => a.code === "task_lineage.parent_missing"), true);

  incremental.upsert(parent);
  const after = incremental.projection();
  const resolved = after.lineage(parseTaskLineageLineageRequestV1({ taskId: "child", maxDepth: 8 }));
  assert.equal(resolved.lineage[0]?.parentMissing, false);
  assert.equal(resolved.lineage[1]?.taskId, "parent");
  assert.equal(resolved.diagnostics.anomalies.some((a) => a.code === "task_lineage.parent_missing"), false);

  const batch = buildTaskLineageReadProjection([child, parent]);
  assert.equal(
    shallow(after.children(parseTaskLineageChildrenRequestV1({ taskId: "parent", limit: 200 }))),
    shallow(batch.children(parseTaskLineageChildrenRequestV1({ taskId: "parent", limit: 200 }))),
  );
  assert.equal(
    shallow(after.leaves(parseTaskLineageLeavesRequestV1({}))),
    shallow(batch.leaves(parseTaskLineageLeavesRequestV1({}))),
  );
});

test("canonical cycle detection at index time matches the batch builder", () => {
  const a = task("cyc-a", { createdAt: createdAtMs(1), parentTaskId: "cyc-c" });
  const b = task("cyc-b", { createdAt: createdAtMs(2), parentTaskId: "cyc-a" });
  const c = task("cyc-c", { createdAt: createdAtMs(3), parentTaskId: "cyc-b" });
  const descendant = task("cyc-d", { createdAt: createdAtMs(4), parentTaskId: "cyc-b" });

  for (const order of [[a, b, c, descendant], [c, b, a, descendant], [descendant, a, b, c]]) {
    const index = new TaskLineageIndex();
    for (const record of order) index.upsert(record);
    const projection = index.projection();
    for (const id of ["cyc-a", "cyc-b", "cyc-c", "cyc-d"]) {
      assert.throws(
        () => projection.lineage(parseTaskLineageLineageRequestV1({ taskId: id, maxDepth: 32 })),
        TaskLineageCycleError,
        `expected cycle error for ${id}`,
      );
    }
    assert.equal(
      shallow(projection.children(parseTaskLineageChildrenRequestV1({ taskId: "cyc-b", limit: 200 }))),
      shallow(buildTaskLineageReadProjection([a, b, c, descendant]).children(parseTaskLineageChildrenRequestV1({ taskId: "cyc-b", limit: 200 }))),
    );
  }
});

test("structural change on an existing record marks the index dirty", () => {
  const index = new TaskLineageIndex();
  const record = task("t-1", { parentTaskId: "t-0" });
  index.upsert(record);
  assert.equal(index.dirty, false);

  index.upsert(record);
  assert.equal(index.dirty, false, "same-structure rewrite must stay clean");

  index.upsert(task("t-1", { createdAt: createdAtMs(1), parentTaskId: "t-9" }));
  assert.equal(index.dirty, true, "changed parent must mark dirty");
});

test("duplicate raw references count once toward duplicate_edge but fully toward truncation", () => {
  const target = task("dup-target", { createdAt: createdAtMs(1) });
  const references = Array.from({ length: 102 }, (_, i) => (i < 2 ? "dup-target" : `ghost-${i}`));
  const record = task("dup-heavy", { createdAt: createdAtMs(2), referenceTaskIds: references });

  const batch = buildTaskLineageReadProjection([target, record]);
  const index = new TaskLineageIndex();
  index.upsert(target);
  index.upsert(record);
  assert.equal(
    shallow(index.projection().leaves(parseTaskLineageLeavesRequestV1({}))),
    shallow(batch.leaves(parseTaskLineageLeavesRequestV1({}))),
  );
  assert.equal(
    shallow(index.projection().children(parseTaskLineageChildrenRequestV1({ taskId: "dup-target", limit: 200 }))),
    shallow(batch.children(parseTaskLineageChildrenRequestV1({ taskId: "dup-target", limit: 200 }))),
  );
});
