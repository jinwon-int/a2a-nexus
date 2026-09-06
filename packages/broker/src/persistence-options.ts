import type { SqliteBrokerLoadSource } from "./core/store.js";

export type BrokerPersistenceBackend = "json-file" | "sqlite";

/**
 * Default persistence backend.
 *
 * Was `json-file` until the broker-perf pass. The JSON-file store has no
 * incremental write path: every persisted mutation re-serializes the whole
 * broker snapshot and pays a tmp-write + fsync, a `.bak` copy + fsync, a
 * rename, and a directory fsync (`store-snapshot-io.ts` writeBrokerSnapshotFile).
 * Measured on a 400-task snapshot that is ~23 ms per mutation versus ~6 ms for
 * the SQLite backend, and the gap widens linearly with snapshot size, so the
 * default was the single largest persistence cost a new deployment inherited.
 *
 * Backward compatibility: `createDefaultStateStore` constructs the SQLite store
 * with `importJsonFile: stateFile`, and both SQLite load paths
 * (`loadCanonicalSnapshot` and `loadHotRuntimeSnapshot`) import that JSON file
 * when the SQLite database has no snapshot yet. An existing `state.json`
 * therefore migrates into `state.json.sqlite` on the first start after upgrade,
 * and the original JSON file is left untouched. Rollback is
 * `BROKER_PERSISTENCE_BACKEND=json-file`, which resumes from the JSON file that
 * was never deleted (any state written after the cutover stays in SQLite).
 */
export const DEFAULT_BROKER_PERSISTENCE_BACKEND: BrokerPersistenceBackend = "sqlite";

const JSON_FILE_BACKEND_ALIASES = new Set(["json-file", "json", "file"]);

export function normalizePersistenceBackend(value: string | undefined): BrokerPersistenceBackend {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === undefined || normalized === "") {
    return DEFAULT_BROKER_PERSISTENCE_BACKEND;
  }
  if (JSON_FILE_BACKEND_ALIASES.has(normalized)) {
    return "json-file";
  }
  return "sqlite";
}

export function normalizeSqliteLoadSource(value: string | undefined): SqliteBrokerLoadSource {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "hot-tables" || normalized === "hot-table" || normalized === "hot-runtime") {
    return "hot-tables";
  }
  return "snapshot";
}
