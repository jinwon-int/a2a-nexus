/**
 * #2581: two connections opening the same fresh database at once made the
 * loser's `PRAGMA journal_mode = WAL` fail with an immediate "database is
 * locked" (busy_timeout does not cover the journal-mode switch).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { isSqliteBusyError, switchToWal, type JournalModeDb } from "./store.js";

function busyError(): Error {
  return Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
}

/** A fake connection: `script` decides what each PRAGMA call does, in order. */
function fakeDb(script: Array<() => unknown>): JournalModeDb & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prepare: (sql) => ({
      get: () => {
        calls.push(sql);
        const step = script.shift();
        if (!step) throw new Error(`unexpected call: ${sql}`);
        return step();
      },
    }),
  };
}

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: (ms: number) => { t += ms; } };
}

test("#2581 switchToWal switches a fresh file database to WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "wal-2581-"));
  try {
    const db = new DatabaseSync(join(dir, "b.sqlite"));
    assert.equal(switchToWal(db), "wal");
    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2581 switchToWal leaves an in-memory database in memory mode", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(switchToWal(db), "memory");
  db.close();
});

test("#2581 switchToWal does not issue the switch when the database is already WAL", () => {
  const db = fakeDb([() => ({ journal_mode: "wal" })]);
  assert.equal(switchToWal(db), "wal");
  assert.deepEqual(db.calls, ["PRAGMA journal_mode"]);
});

test("#2581 switchToWal retries SQLITE_BUSY from a concurrent opener and then sees WAL", () => {
  const clock = fakeClock();
  const db = fakeDb([
    () => ({ journal_mode: "delete" }),
    () => { throw busyError(); }, // the other connection holds the lock while converting
    () => { throw busyError(); },
    () => ({ journal_mode: "wal" }), // it finished: the file is WAL now
  ]);
  assert.equal(switchToWal(db, clock), "wal");
  assert.deepEqual(db.calls, ["PRAGMA journal_mode", "PRAGMA journal_mode = WAL", "PRAGMA journal_mode", "PRAGMA journal_mode"]);
});

test("#2581 switchToWal rethrows SQLITE_BUSY once the budget is spent", () => {
  const clock = fakeClock();
  const script = Array.from({ length: 1000 }, () => () => { throw busyError(); });
  assert.throws(() => switchToWal(fakeDb(script), { ...clock, budgetMs: 200 }), /database is locked/);
  assert.ok(clock.now() >= 200 && clock.now() < 400, `waited ${clock.now()}ms`);
});

test("#2581 switchToWal rethrows a non-busy error at once", () => {
  const clock = fakeClock();
  const db = fakeDb([() => { throw new Error("file is not a database"); }]);
  assert.throws(() => switchToWal(db, clock), /file is not a database/);
  assert.equal(clock.now(), 0);
});

test("#2581 isSqliteBusyError recognises primary and extended busy codes and the message", () => {
  assert.equal(isSqliteBusyError(busyError()), true);
  assert.equal(isSqliteBusyError(Object.assign(new Error("x"), { errcode: 261 })), true); // SQLITE_BUSY_RECOVERY
  assert.equal(isSqliteBusyError(new Error("database is locked")), true);
  assert.equal(isSqliteBusyError(Object.assign(new Error("readonly"), { errcode: 8 })), false);
  assert.equal(isSqliteBusyError("database is locked"), false);
});
