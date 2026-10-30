// #2339 PR-1a: parent round registry — idempotent mint, bounded anchors, and
// persistence across JSON snapshots and SQLite hot-table restarts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { InMemoryA2ABroker } from "../broker.js";
import {
  MAX_PARENT_ROUND_ANCHORS,
  ParentRoundRegistry,
  ParentRoundRegistryError,
  type ParentRoundMintInput,
  type ParentRoundRegistryEntry,
} from "./parent-round-registry.js";
import { CURRENT_BROKER_STATE_VERSION, type BrokerSnapshot } from "../store/store-contracts.js";
import { SqliteBrokerStateStore } from "../store/store.js";

const MINTED_AT = "2026-10-23T03:00:00.000Z";

function mintInput(overrides: Partial<ParentRoundMintInput> = {}): ParentRoundMintInput {
  return {
    parentRoundId: "brokeralpha-round-1",
    originBrokerId: "brokeralpha",
    parentBrokerId: "brokeralpha",
    initiatingBrokerId: "brokeralpha",
    teamScope: "T1",
    handoffBrokerId: "brokerbeta",
    parentRoundTotal: 4,
    kind: "local-origin",
    mintedAt: MINTED_AT,
    mintedBy: { requesterId: "hub-alpha", role: "hub" },
    ...overrides,
  };
}

function entryFixture(overrides: Partial<ParentRoundRegistryEntry> = {}): ParentRoundRegistryEntry {
  return {
    parentRoundId: "brokeralpha-round-1",
    originBrokerId: "brokeralpha",
    parentBrokerId: "brokeralpha",
    initiatingBrokerId: "brokeralpha",
    teamScope: "T1",
    handoffBrokerId: "brokerbeta",
    parentRoundTotal: 4,
    kind: "local-origin",
    mintedAt: MINTED_AT,
    mintedBy: { requesterId: "hub-alpha", role: "hub" },
    anchors: ["brokerbeta-child-1"],
    ...overrides,
  };
}

test("PR-1a mint is idempotent on round metadata and refuses a different round under the same id", () => {
  const registry = new ParentRoundRegistry();

  const minted = registry.mint(mintInput());
  assert.equal(minted.status, "minted");
  assert.deepEqual(minted.entry.anchors, []);

  // A retry from another requester at another time is still the same round.
  const replayed = registry.mint(mintInput({ mintedAt: "2026-10-23T04:00:00.000Z", mintedBy: { requesterId: "op", role: "operator" } }));
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.entry.mintedAt, MINTED_AT, "the first mint is kept");
  assert.equal(replayed.entry.mintedBy.requesterId, "hub-alpha");

  for (const change of [
    { originBrokerId: "brokergamma" },
    { parentBrokerId: "brokerbeta" },
    { initiatingBrokerId: "brokerbeta" },
    { teamScope: "T2" },
    { handoffBrokerId: "brokergamma" },
    { parentRoundTotal: 5 },
    { kind: "foreign-handoff" as const },
  ]) {
    const conflict = registry.mint(mintInput(change));
    assert.equal(conflict.status, "conflict", `changed ${Object.keys(change)[0]} must conflict`);
    assert.deepEqual(conflict.entry, minted.entry, "the existing entry is unchanged");
  }
  assert.equal(registry.size, 1);
});

test("PR-1a mint rejects malformed input instead of storing it", () => {
  const registry = new ParentRoundRegistry();
  for (const bad of [
    mintInput({ parentRoundId: " " }),
    mintInput({ originBrokerId: "x".repeat(201) }),
    mintInput({ kind: "implicit" as never }),
    mintInput({ parentRoundTotal: 0 }),
    mintInput({ parentRoundTotal: 1.5 }),
    mintInput({ mintedAt: "not-a-date" }),
    mintInput({ mintedBy: { requesterId: "", role: "hub" } }),
  ]) {
    assert.throws(() => registry.mint(bad), ParentRoundRegistryError);
  }
  assert.equal(registry.size, 0);
});

test("PR-1a anchors are deduplicated, sorted, and bounded", () => {
  const registry = new ParentRoundRegistry();
  registry.mint(mintInput());

  assert.equal(registry.addAnchor("brokeralpha-round-1", "child-b").status, "added");
  assert.equal(registry.addAnchor("brokeralpha-round-1", "child-a").status, "added");
  assert.equal(registry.addAnchor("brokeralpha-round-1", " child-b ").status, "present");
  assert.deepEqual(registry.get("brokeralpha-round-1")?.anchors, ["child-a", "child-b"]);
  assert.deepEqual(registry.addAnchor("unknown-round", "child-a"), { status: "unknown_round" });
  assert.throws(() => registry.addAnchor("brokeralpha-round-1", ""), ParentRoundRegistryError);

  for (let index = 2; index < MAX_PARENT_ROUND_ANCHORS; index += 1) {
    registry.addAnchor("brokeralpha-round-1", `child-${String(index).padStart(5, "0")}`);
  }
  assert.equal(registry.get("brokeralpha-round-1")?.anchors.length, MAX_PARENT_ROUND_ANCHORS);
  assert.equal(registry.addAnchor("brokeralpha-round-1", "one-too-many").status, "anchor_limit");
});

test("PR-1a returned entries are copies; callers cannot mutate registry state", () => {
  const registry = new ParentRoundRegistry();
  registry.mint(mintInput({ anchors: ["child-1"] }));
  const entry = registry.get("brokeralpha-round-1");
  assert.ok(entry);
  entry.anchors.push("injected");
  entry.mintedBy.role = "operator";
  assert.deepEqual(registry.get("brokeralpha-round-1")?.anchors, ["child-1"]);
  assert.equal(registry.get("brokeralpha-round-1")?.mintedBy.role, "hub");
});

test("PR-1a restore keeps valid entries, skips malformed ones, and the first duplicate wins", () => {
  const registry = new ParentRoundRegistry();
  registry.restore([
    entryFixture({ parentRoundId: "round-b" }),
    { not: "an entry" },
    entryFixture({ parentRoundId: "round-a", kind: "foreign-handoff", parentBrokerId: "brokerbeta" }),
    entryFixture({ parentRoundId: "round-b", originBrokerId: "brokergamma" }),
    entryFixture({ parentRoundId: "round-c", anchors: "nope" as never }),
  ]);

  assert.deepEqual(registry.list().map((entry) => entry.parentRoundId), ["round-a", "round-b"]);
  assert.equal(registry.get("round-b")?.originBrokerId, "brokeralpha");
  assert.deepEqual(registry.snapshot(), registry.list());
});

test("PR-1a broker snapshot round-trips the registry", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
  assert.equal(broker.mintParentRound(mintInput()).status, "minted");
  assert.equal(broker.addParentRoundAnchor("brokeralpha-round-1", "brokerbeta-child-1").status, "added");

  const snapshot = broker.exportSnapshot();
  assert.deepEqual(snapshot.parentRounds, [entryFixture()]);

  const restored = new InMemoryA2ABroker(undefined, snapshot, { brokerId: "brokeralpha" });
  assert.deepEqual(restored.getParentRound("brokeralpha-round-1"), entryFixture());
  assert.deepEqual(restored.listParentRounds(), [entryFixture()]);
});

function withTempDb(run: (dbFile: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-parent-round-registry-"));
  try {
    run(join(dir, "state.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function emptyHotSnapshot(): BrokerSnapshot {
  return {
    version: CURRENT_BROKER_STATE_VERSION,
    exchanges: [],
    exchangeMessages: [],
    proposals: [],
    artifacts: [],
    validations: [],
    workers: [],
    tasks: [],
    auditEvents: [],
    tombstones: [],
    terminalOutbox: [],
    crossBrokerTerminalBriefs: [],
    wavePlans: [],
  };
}

test("PR-1a SqliteBrokerStateStore hot-table load carries the canonical parent round registry", () => {
  withTempDb((dbFile) => {
    // Same class as #1446 / #1724: snapshot-only sidecar state must be read
    // back from the canonical blob on a hot-tables restart.
    const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    store.save({ ...emptyHotSnapshot(), parentRounds: [entryFixture()] });
    store.close();

    const reloaded = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    assert.deepEqual(reloaded.load().parentRounds, [entryFixture()], "hot-tables restart keeps the registry");
    reloaded.close();
  });
});

test("PR-1a SqliteBrokerStateStore hint-carrying save still writes the registry to the canonical blob", () => {
  withTempDb((dbFile) => {
    // A hint-carrying save skips the blob rewrite unless snapshot-only sidecar
    // state is present; the registry must veto that skip.
    const auditEvent = {
      id: "audit-parent-round-hint-1",
      actorId: "worker-child",
      action: "worker.heartbeat" as const,
      targetType: "worker" as const,
      targetId: "worker-child",
      createdAt: "2026-10-23T03:00:03.000Z",
    };
    const store = new SqliteBrokerStateStore(dbFile);
    store.save(emptyHotSnapshot());
    store.save(
      { ...emptyHotSnapshot(), auditEvents: [auditEvent], parentRounds: [entryFixture()] },
      { hotAuditEvents: [auditEvent] },
    );
    store.close();

    const canonical = new SqliteBrokerStateStore(dbFile);
    assert.deepEqual(canonical.load().parentRounds, [entryFixture()], "canonical blob carries the registry");
    canonical.close();
    const hot = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    assert.deepEqual(hot.load().parentRounds, [entryFixture()], "hot-tables restart sees it too");
    hot.close();
  });
});

test("PR-1a broker on SQLite hot tables keeps a minted round and its anchors across a restart", () => {
  withTempDb((dbFile) => {
    const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    const broker = new InMemoryA2ABroker(store, store.load(), { brokerId: "brokeralpha" });
    broker.mintParentRound(mintInput());
    broker.addParentRoundAnchor("brokeralpha-round-1", "brokerbeta-child-1");
    store.close();

    const restartedStore = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    const restarted = new InMemoryA2ABroker(restartedStore, restartedStore.load(), { brokerId: "brokeralpha" });
    assert.deepEqual(restarted.getParentRound("brokeralpha-round-1"), entryFixture());
    restartedStore.close();
  });
});
