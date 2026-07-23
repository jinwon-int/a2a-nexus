import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { intentHash } from "../review-lifecycle/canonical-json.js";
import type {
  IntentContractV1,
  ReviewLineageEvent,
} from "../review-lifecycle/types.js";
import {
  ReviewLineageStore,
  ReviewLineageStoreError,
  resolveReviewLineageRolloutMode,
} from "./review-lineage-store.js";
import { InMemoryA2ABroker } from "./broker.js";
import type {
  BrokerSnapshot,
  BrokerStateSaveHints,
  BrokerStateStore,
} from "./store.js";
import { SqliteBrokerStateStore } from "./store.js";

const T0 = "2026-07-23T00:00:00.000Z";

function contract(lineageId = "lineage-1"): IntentContractV1 {
  const value: IntentContractV1 = {
    kind: "IntentContractV1",
    lineageId,
    goal: "Preserve frozen intent while recording bounded review state.",
    nonGoals: ["Do not alter task completion."],
    invariants: ["Record mode is observational."],
    acceptanceCriteria: [{ id: "AC-1", text: "Lineage state survives restart." }],
    declaredPaths: {
      allowed: ["packages/broker/src/**"],
      forbidden: ["packages/broker/src/worker.ts"],
    },
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    createdAt: T0,
    intentHash: "",
  };
  value.intentHash = intentHash(value as unknown as Record<string, unknown>);
  return value;
}

function cancelEvent(): ReviewLineageEvent {
  return {
    type: "operator_cancel",
    at: "2026-07-23T00:01:00.000Z",
    detail: "test closeout",
  };
}

test("review lineage store creates record-mode state and isolates caller mutations", () => {
  const store = new ReviewLineageStore();
  const created = store.create({ contract: contract(), at: T0 });
  assert.equal(created.mode, "record");
  assert.equal(created.state, "reviewing_initial");

  created.state = "canceled";
  assert.equal(store.get(created.lineageId)?.state, "reviewing_initial");
});

test("review lineage store rejects duplicate ids and unknown event targets", () => {
  const store = new ReviewLineageStore();
  store.create({ contract: contract(), at: T0 });

  assert.throws(
    () => store.create({ contract: contract(), at: T0 }),
    (error) =>
      error instanceof ReviewLineageStoreError
      && error.code === "duplicate_lineage",
  );
  assert.throws(
    () => store.apply("missing", cancelEvent()),
    (error) =>
      error instanceof ReviewLineageStoreError
      && error.code === "lineage_not_found",
  );
});

test("review lineage store persists applied events across a snapshot round trip", () => {
  const first = new ReviewLineageStore();
  first.create({ contract: contract(), at: T0 });
  const applied = first.apply("lineage-1", cancelEvent());
  assert.equal(applied.record.state, "canceled");
  assert.deepEqual(applied.effects, ["operator_canceled"]);

  const restored = new ReviewLineageStore(first.snapshot());
  assert.deepEqual(restored.snapshot(), first.snapshot());
  assert.equal(restored.get("lineage-1")?.terminalReason, "operator_cancel");
});

class CapturingStore implements BrokerStateStore {
  saves: BrokerSnapshot[] = [];

  load(): BrokerSnapshot {
    throw new Error("not used");
  }

  save(snapshot: BrokerSnapshot, _hints?: BrokerStateSaveHints): void {
    this.saves.push(structuredClone(snapshot));
  }
}

test("broker rollout defaults off and record mode persists the snapshot sidecar", () => {
  const offStore = new CapturingStore();
  const offBroker = new InMemoryA2ABroker(offStore);
  assert.equal(
    offBroker.createReviewLineage({ contract: contract(), at: T0 }),
    undefined,
  );
  assert.equal(offStore.saves.length, 0);
  assert.deepEqual(offBroker.exportSnapshot().reviewLineages, []);

  const recordStore = new CapturingStore();
  const recordBroker = new InMemoryA2ABroker(
    recordStore,
    undefined,
    { reviewLineageMode: "record" },
  );
  const created = recordBroker.createReviewLineage({
    contract: contract(),
    at: T0,
  });
  assert.equal(created?.mode, "record");
  assert.equal(recordStore.saves.length, 1);
  assert.equal(
    recordStore.saves[0].reviewLineages?.[0]?.lineageId,
    "lineage-1",
  );

  recordBroker.recordReviewLineageEvent("lineage-1", cancelEvent());
  assert.equal(recordStore.saves.length, 2);
  assert.equal(
    recordBroker.getReviewLineage("lineage-1", T0)?.state,
    "canceled",
  );

  const restored = new InMemoryA2ABroker(
    undefined,
    recordBroker.exportSnapshot(),
  );
  assert.equal(
    restored.getReviewLineage("lineage-1", T0)?.metrics.terminalReason,
    "operator_cancel",
  );
});

test("review lineage rollout config accepts only off or record", () => {
  assert.equal(resolveReviewLineageRolloutMode(undefined), "off");
  assert.equal(resolveReviewLineageRolloutMode(" RECORD "), "record");
  assert.throws(
    () => resolveReviewLineageRolloutMode("enforce"),
    /expected off \| record/,
  );
});

test("SQLite hot-table restart preserves review lineages from the canonical sidecar", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-review-lineage-"));
  const dbFile = join(dir, "state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(
      dbFile,
      { loadSource: "hot-tables" },
    );
    const broker = new InMemoryA2ABroker(
      store,
      store.load(),
      { reviewLineageMode: "record" },
    );
    broker.createReviewLineage({ contract: contract(), at: T0 });
    broker.recordReviewLineageEvent("lineage-1", cancelEvent());
    store.close();

    const reloadedStore = new SqliteBrokerStateStore(
      dbFile,
      { loadSource: "hot-tables" },
    );
    const restored = new InMemoryA2ABroker(
      undefined,
      reloadedStore.load(),
    );
    assert.equal(
      restored.getReviewLineage("lineage-1", T0)?.state,
      "canceled",
    );
    reloadedStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
