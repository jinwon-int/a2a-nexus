/**
 * Tests for the V1 SQLite adapter lifecycle and ownership slice.
 *
 * Exclusive ownership is the property this whole contract exists to obtain,
 * so it gets the most attention here: a second owner must be refused, a
 * refused owner must not have moved the epoch, and an adapter whose row was
 * taken over must stop being able to write.
 *
 * Every database is a temporary file removed at the end of its test.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1,
  SHARED_STATE_SQLITE_ADAPTER_V1,
  SharedStateSqliteAdapterV1,
  readSharedStateSqliteLifecycleEpochV1,
} from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import { SHARED_STATE_STORAGE_V1_VALUES as V } from "./shared-state-storage-contract-v1.js";

interface Fixture {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly directory: string;
}

function makeFixture(applySchema = true): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "shared-state-adapter-v1-"));
  const path = join(directory, "v1.db");
  const db = new DatabaseSync(path);
  if (applySchema) {
    assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
  }
  return { db, path, directory };
}

function disposeFixture(fixture: Fixture, extra: DatabaseSync[] = []): void {
  for (const handle of extra) handle.close();
  fixture.db.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function adapter(
  db: DatabaseSync,
  ownerToken: string,
): SharedStateSqliteAdapterV1 {
  return new SharedStateSqliteAdapterV1({ db, ownerToken });
}

test("opens to ready and advances the lifecycle epoch", () => {
  const fixture = makeFixture();
  try {
    const epochBefore = readSharedStateSqliteLifecycleEpochV1(fixture.db);
    assert.equal(epochBefore.ok, true);
    if (!epochBefore.ok) return;
    assert.equal(epochBefore.value, "0");

    const owner = adapter(fixture.db, "owner-a");
    const opened = owner.open();
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(opened.value.state, "ready");
    assert.deepEqual([...opened.value.reasonCodes], []);
    assert.equal(owner.lifecycleEpoch, "1");

    const epochAfter = readSharedStateSqliteLifecycleEpochV1(fixture.db);
    assert.equal(epochAfter.ok, true);
    if (!epochAfter.ok) return;
    assert.equal(epochAfter.value, "1");
  } finally {
    disposeFixture(fixture);
  }
});

test("refuses a second owner and leaves the epoch untouched", () => {
  const fixture = makeFixture();
  const second = new DatabaseSync(fixture.path);
  try {
    const first = adapter(fixture.db, "owner-a");
    assert.equal(first.open().ok, true);
    assert.equal(first.lifecycleEpoch, "1");

    // A different session on the same database file.
    const rival = adapter(second, "owner-b");
    const refused = rival.open();
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, "ownership_conflict");
    assert.equal(rival.lifecycleEpoch, null);

    // The refusal must not have consumed an epoch.
    const epoch = readSharedStateSqliteLifecycleEpochV1(fixture.db);
    assert.equal(epoch.ok, true);
    if (!epoch.ok) return;
    assert.equal(epoch.value, "1");

    // The refused adapter cannot write either.
    const write = rival.beginWrite();
    assert.equal(write.ok, false);
    if (write.ok) return;
    assert.equal(write.error.code, "not_ready");

    // The holder still can.
    assert.equal(first.beginWrite().ok, true);
  } finally {
    disposeFixture(fixture, [second]);
  }
});

test("releases ownership only after drain, and reopening lifts the epoch", () => {
  const fixture = makeFixture();
  const second = new DatabaseSync(fixture.path);
  try {
    const first = adapter(fixture.db, "owner-a");
    assert.equal(first.open().ok, true);

    // close before drain is refused.
    const early = first.close();
    assert.equal(early.ok, false);
    if (early.ok) return;
    assert.equal(early.error.code, "drain_required");

    const drained = first.drain();
    assert.equal(drained.ok, true);
    if (!drained.ok) return;
    assert.equal(drained.value.state, "draining");
    assert.deepEqual([...drained.value.reasonCodes], ["drain_requested"]);

    // Draining already stops writes.
    const blocked = first.beginWrite();
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.error.code, "not_ready");

    const closed = first.close();
    assert.equal(closed.ok, true);
    if (!closed.ok) return;
    assert.equal(closed.value.state, "closed");
    assert.deepEqual([...closed.value.reasonCodes], ["close_requested"]);

    // Ownership is free, so a different session may now take it — and the
    // epoch rises rather than resetting.
    const next = adapter(second, "owner-b");
    assert.equal(next.open().ok, true);
    assert.equal(next.lifecycleEpoch, "2");
    const epoch = readSharedStateSqliteLifecycleEpochV1(fixture.db);
    assert.equal(epoch.ok, true);
    if (!epoch.ok) return;
    assert.equal(epoch.value, "2");
  } finally {
    disposeFixture(fixture, [second]);
  }
});

test("the epoch never decreases across repeated close and reopen", () => {
  const fixture = makeFixture();
  try {
    let previous = 0n;
    for (let round = 0; round < 4; round += 1) {
      const owner = adapter(fixture.db, `owner-${round}`);
      assert.equal(owner.open().ok, true);
      const current = BigInt(owner.lifecycleEpoch ?? "-1");
      assert.equal(current > previous, true);
      previous = current;
      assert.equal(owner.drain().ok, true);
      assert.equal(owner.close().ok, true);

      // Released ownership does not lower the epoch.
      const persisted = readSharedStateSqliteLifecycleEpochV1(fixture.db);
      assert.equal(persisted.ok, true);
      if (!persisted.ok) return;
      assert.equal(BigInt(persisted.value), current);
    }
    assert.equal(previous, 4n);
  } finally {
    disposeFixture(fixture);
  }
});

test("stops writing when its ownership row is taken over", () => {
  const fixture = makeFixture();
  try {
    const owner = adapter(fixture.db, "owner-a");
    assert.equal(owner.open().ok, true);
    assert.equal(owner.beginWrite().ok, true);

    // Simulate the row being claimed by another session while this adapter
    // still believes it is ready.
    fixture.db
      .prepare(
        `UPDATE shared_state_ownership SET owner_token = ? WHERE id = ?`,
      )
      .run("owner-b", SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);

    const lost = owner.beginWrite();
    assert.equal(lost.ok, false);
    if (lost.ok) return;
    assert.equal(lost.error.code, "ownership_lost");

    // It stays unable to write; the state moved to failed.
    const again = owner.beginWrite();
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.error.code, "not_ready");
    assert.equal(owner.lifecycle()?.state, "failed");
  } finally {
    disposeFixture(fixture);
  }
});

test("an epoch bump alone also stops the stale session writing", () => {
  const fixture = makeFixture();
  try {
    const owner = adapter(fixture.db, "owner-a");
    assert.equal(owner.open().ok, true);

    // Same token, higher epoch: a newer session of the same owner.
    fixture.db
      .prepare(
        `UPDATE shared_state_ownership SET lifecycle_epoch = ? WHERE id = ?`,
      )
      .run("99", SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);

    const stale = owner.beginWrite();
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.error.code, "ownership_lost");
  } finally {
    disposeFixture(fixture);
  }
});

test("refuses to open without a schema or against a foreign version", () => {
  const bare = makeFixture(false);
  try {
    const owner = adapter(bare.db, "owner-a");
    const refused = owner.open();
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, "schema_not_applied");
    assert.equal(owner.lifecycle()?.state, "failed");
  } finally {
    disposeFixture(bare);
  }

  const foreign = makeFixture();
  try {
    foreign.db
      .prepare(`UPDATE shared_state_meta SET value = ? WHERE key = ?`)
      .run("999", "schema_version");
    const owner = adapter(foreign.db, "owner-a");
    const refused = owner.open();
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, "schema_version_mismatch");
  } finally {
    disposeFixture(foreign);
  }
});

test("rejects reopening an already-open adapter", () => {
  const fixture = makeFixture();
  try {
    const owner = adapter(fixture.db, "owner-a");
    assert.equal(owner.open().ok, true);
    const again = owner.open();
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.error.code, "already_open");
    // The rejected reopen did not consume an epoch.
    assert.equal(owner.lifecycleEpoch, "1");
  } finally {
    disposeFixture(fixture);
  }
});

test("implements lifecycle and ownership only, on closed vocabulary", () => {
  // This slice ships no primitive: the adapter exposes the lifecycle seam and
  // the write guard, and nothing that mutates shared state.
  const surface = Object.getOwnPropertyNames(
    SharedStateSqliteAdapterV1.prototype,
  ).filter((name) => name !== "constructor");
  assert.deepEqual(surface.sort(), [
    "beginWrite",
    "close",
    "drain",
    "lifecycle",
    "lifecycleEpoch",
    "open",
    "ownerToken",
  ]);

  assert.equal(
    SHARED_STATE_SQLITE_ADAPTER_V1.contractVersion,
    V.versions.contract,
  );
  // Backend class and writer model come from the closed vocabulary.
  assert.equal(
    V.backendClasses.includes(SHARED_STATE_SQLITE_ADAPTER_V1.backendClass),
    true,
  );
  assert.equal(
    V.writerModels.includes(SHARED_STATE_SQLITE_ADAPTER_V1.writerModel),
    true,
  );
  // `ownership_conflict` is reused from the closed lifecycle and readiness
  // vocabulary rather than invented for this adapter.
  assert.equal(V.lifecycleReasonCodes.includes("ownership_conflict"), true);
  assert.equal(V.readinessReasonCodes.includes("ownership_conflict"), true);
  assert.equal(
    new Set(SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1).size,
    SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1.length,
  );
});
