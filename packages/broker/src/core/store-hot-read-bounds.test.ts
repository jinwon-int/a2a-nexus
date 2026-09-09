/**
 * Bounded hot-table reads (#2078 C2, criterion: "모든 호출자가 limit을 넘기고
 * SQL에 항상 LIMIT을 내린다").
 *
 * Pinned here:
 * - every hot-table SELECT carries a LIMIT — omitting the limit falls back to
 *   the bounded default, never to an unbounded scan;
 * - the keyset page cursor reproduces exactly what the old unbounded read
 *   returned (same rows, same order), one bounded query at a time;
 * - the stats/stats-like read paths stay exhaustive while using the cursor.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryA2ABroker } from "./broker.js";
import {
  buildHotTableSelect,
  HOT_READ_DEFAULT_LIMIT,
  HOT_READ_HARD_MAX_LIMIT,
  normalizeBoundedSqliteLimit,
} from "./store-hot-select-projections.js";
import {
  SqliteBrokerStateStore,
  emptySnapshot,
} from "./store.js";
import { listAllTasksForReadPath } from "../task-read-paths.js";
import { makeTask, makeWorker, withTempFile } from "./store-test-helpers.js";
import type { TaskRecord } from "./types.js";

function seededTasks(count: number, prefix = "bounded"): TaskRecord[] {
  const base = Date.parse("2026-08-08T00:00:00.000Z");
  return Array.from({ length: count }, (_, i) => {
    // Two rows per millisecond bucket exercises the id tie-break in the
    // keyset cursor (updated_at DESC, id ASC).
    const at = new Date(base - Math.floor(i / 2) * 1_000).toISOString();
    return {
      ...makeTask(`${prefix}-${String(i).padStart(5, "0")}`, "succeeded", "worker-0"),
      createdAt: at,
      updatedAt: at,
      completedAt: at,
    } as TaskRecord;
  });
}

test("buildHotTableSelect always emits a LIMIT", () => {
  const withNothing = buildHotTableSelect("broker_tasks", [], "updated_at DESC, id ASC");
  assert.match(withNothing.sql, /LIMIT \?$/, "no-limit call must fall back to the bounded default");
  assert.equal(withNothing.params.at(-1), HOT_READ_DEFAULT_LIMIT);

  const withExplicit = buildHotTableSelect("broker_tasks", [], "updated_at DESC, id ASC", 17);
  assert.equal(withExplicit.params.at(-1), 17, "explicit limits pass through");

  const overTheTop = buildHotTableSelect("broker_tasks", [], "updated_at DESC, id ASC", 10_000_000);
  assert.equal(
    overTheTop.params.at(-1),
    HOT_READ_HARD_MAX_LIMIT,
    "runaway limits clamp to the hard max",
  );

  assert.equal(normalizeBoundedSqliteLimit(0), HOT_READ_DEFAULT_LIMIT, "zero means the bounded default, not unbounded");
});

test("readHotTasks without a limit is bounded by the default", () => {
  const temp = withTempFile("hot-read-bounds.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const tasks = seededTasks(HOT_READ_DEFAULT_LIMIT + 25);
    store.save({ ...emptySnapshot(), tasks }, {});

    const unboundedCall = store.readHotTasks();
    assert.equal(
      unboundedCall.length,
      HOT_READ_DEFAULT_LIMIT,
      "omitting the limit must return the bounded default, not the whole table",
    );

    const explicit = store.readHotTasks({ limit: HOT_READ_DEFAULT_LIMIT + 25 });
    assert.equal(explicit.length, HOT_READ_DEFAULT_LIMIT + 25, "explicit limits up to the cap still work");
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("cursor pages reproduce the full read exactly (rows and order)", () => {
  const temp = withTempFile("hot-read-cursor.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const tasks = seededTasks(57);
    store.save({ ...emptySnapshot(), tasks }, {});

    const reference = store.readHotTasks({ limit: HOT_READ_HARD_MAX_LIMIT });
    assert.equal(reference.length, 57);

    const paged: TaskRecord[] = [];
    let cursor: { updatedAt: string; id: string } | undefined;
    let pages = 0;
    for (;;) {
      const page = store.readHotTaskPage(cursor, 10);
      pages += 1;
      paged.push(...page.tasks);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.equal(pages, 6, "57 rows at page size 10 need 6 pages");
    assert.deepEqual(paged.map((task) => task.id), reference.map((task) => task.id));
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("the stats read path stays exhaustive while reading bounded pages", () => {
  const temp = withTempFile("hot-read-stats.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const tasks = seededTasks(40);
    store.save({ ...emptySnapshot(), tasks, workers: [makeWorker("worker-0")] }, {});

    const broker = new InMemoryA2ABroker(store, undefined, {});
    const viaPages = listAllTasksForReadPath(store, broker);
    assert.equal(viaPages.length, 40, "page iteration is exhaustive");
    assert.deepEqual(
      viaPages.map((task) => task.id),
      store.readHotTasks({ limit: HOT_READ_HARD_MAX_LIMIT }).map((task) => task.id),
    );
    store.close();
  } finally {
    temp.cleanup();
  }
});

