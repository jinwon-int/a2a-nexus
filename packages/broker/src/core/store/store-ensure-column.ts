// #2573: idempotent ADD COLUMN that tolerates a concurrent writer.
//
// Opening a store runs `initializeDatabase`, which checks `PRAGMA table_info`
// and then issues `ALTER TABLE … ADD COLUMN` for columns added by later schema
// versions. The check and the ALTER are not atomic, so when two connections
// open the same fresh database at once (the main store plus its
// worker-thread persistence writer) both can see the column missing and the
// slower ALTER fails with `duplicate column name`. That failure is only a lost
// race: re-read the table and accept it when the column is now present. Any
// other error — or a duplicate-column error while the column is still absent —
// is rethrown unchanged.

export interface EnsureColumnOps {
  /** Current column names of the table (a fresh `PRAGMA table_info` read). */
  listColumns(): readonly string[];
  /** Runs the ALTER TABLE statement. */
  exec(sql: string): void;
}

const DUPLICATE_COLUMN_RE = /duplicate column name/i;

export function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return DUPLICATE_COLUMN_RE.test(message);
}

/**
 * Adds `columnName` to `tableName` unless it already exists.
 * Returns `"present"` (no ALTER needed), `"added"`, or `"added-concurrently"`
 * (another connection won the race).
 */
export function ensureColumnWith(
  ops: EnsureColumnOps,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): "present" | "added" | "added-concurrently" {
  if (ops.listColumns().includes(columnName)) {
    return "present";
  }
  try {
    ops.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
    return "added";
  } catch (error) {
    if (isDuplicateColumnError(error) && ops.listColumns().includes(columnName)) {
      return "added-concurrently";
    }
    throw error;
  }
}
