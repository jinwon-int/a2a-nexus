// export-sqlite-state load-source tests (#1301 M3 dogfood defect).
// A live hot-tables broker keeps its canonical snapshot blob stale, so the
// exporter's implicit loadSource="snapshot" silently exports old state. The
// CLI must expose the same --load-source / BROKER_SQLITE_LOAD_SOURCE choice
// as the server runtime, with snapshot staying the back-compat default.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { SqliteBrokerStateStore, emptySnapshot } from "../dist/core/store.js";
import { makeTask } from "../dist/core/store-test-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "export-sqlite-state.mjs");

/**
 * Build a DB reproducing the live defect: hot tables carry a task while the
 * canonical snapshot blob is stale (here: emptied after the fact).
 */
function buildDivergentDb() {
  const dir = mkdtempSync(join(tmpdir(), "export-sqlite-state-"));
  const dbFile = join(dir, "state.sqlite");
  const store = new SqliteBrokerStateStore(dbFile);
  store.save({ ...emptySnapshot(), tasks: [makeTask("hot-only-task", "queued", "worker-a")] });
  store.close();

  const emptyDbFile = join(dir, "empty.sqlite");
  const emptyStore = new SqliteBrokerStateStore(emptyDbFile);
  emptyStore.save(emptySnapshot());
  emptyStore.close();

  const source = new DatabaseSync(emptyDbFile, { readOnly: true });
  const stalePayload = source.prepare("SELECT payload FROM broker_snapshots WHERE id = 1").get().payload;
  source.close();
  const target = new DatabaseSync(dbFile);
  target.prepare("UPDATE broker_snapshots SET payload = ? WHERE id = 1").run(stalePayload);
  target.close();
  return dbFile;
}

function runExport(dbFile, extraArgs = [], envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  delete env.BROKER_SQLITE_FILE;
  delete env.SQLITE_STATE_FILE;
  if (!("BROKER_SQLITE_LOAD_SOURCE" in envOverrides)) delete env.BROKER_SQLITE_LOAD_SOURCE;
  const res = spawnSync(process.execPath, [CLI, "--db", dbFile, ...extraArgs], { encoding: "utf8", env });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test("default stays snapshot (back-compat): the stale blob is what exports", () => {
  const snapshot = runExport(buildDivergentDb());
  assert.deepEqual(snapshot.tasks ?? [], [], "no flag => canonical snapshot blob, even when stale");
});

test("--load-source hot-tables exports the live hot tables", () => {
  const snapshot = runExport(buildDivergentDb(), ["--load-source", "hot-tables"]);
  assert.equal(snapshot.tasks?.length, 1);
  assert.equal(snapshot.tasks[0].id, "hot-only-task");
});

test("BROKER_SQLITE_LOAD_SOURCE env is honored like the server runtime; flag wins over env", () => {
  const viaEnv = runExport(buildDivergentDb(), [], { BROKER_SQLITE_LOAD_SOURCE: "hot-tables" });
  assert.equal(viaEnv.tasks?.length, 1);

  const flagWins = runExport(buildDivergentDb(), ["--load-source", "snapshot"], { BROKER_SQLITE_LOAD_SOURCE: "hot-tables" });
  assert.deepEqual(flagWins.tasks ?? [], []);
});

test("unrecognized load source falls back to snapshot (same normalizer as the server)", () => {
  const snapshot = runExport(buildDivergentDb(), ["--load-source", "warm-cache"]);
  assert.deepEqual(snapshot.tasks ?? [], []);
});
