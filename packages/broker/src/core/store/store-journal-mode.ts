// #2581: switch a database to WAL without failing on a concurrent opener.
//
// `PRAGMA journal_mode = WAL` needs an exclusive lock on the file. When two
// connections open the same fresh database at the same moment, the one that
// loses gets SQLITE_BUSY ("database is locked") straight away — the
// connection's busy_timeout does not cover this path. The winner is about to
// leave the file in WAL mode, so the loser only has to wait and look again.
//
// Read the current mode first (an existing WAL database needs no exclusive
// lock at all), and retry SQLITE_BUSY within a bounded budget. Any other error
// — or a busy error that outlasts the budget — is rethrown unchanged.

export interface JournalModeDb {
  prepare(sql: string): { get(): unknown };
}

export interface SwitchToWalOptions {
  /** Total time to keep retrying SQLITE_BUSY, in ms (default 5000, matching busy_timeout). */
  budgetMs?: number;
  /** Synchronous sleep, injectable for tests. */
  sleep?: (ms: number) => void;
  /** Monotonic clock, injectable for tests. */
  now?: () => number;
}

const SQLITE_BUSY = 5;

export function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  // Extended codes keep the primary code in the low byte (SQLITE_BUSY_RECOVERY = 261, …).
  if (typeof errcode === "number" && (errcode & 0xff) === SQLITE_BUSY) return true;
  const message = error instanceof Error ? error.message : "";
  return /database is locked|SQLITE_BUSY/i.test(message);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function modeOf(row: unknown): string | undefined {
  const mode = (row as { journal_mode?: unknown } | undefined)?.journal_mode;
  return typeof mode === "string" ? mode : undefined;
}

/** Returns the resulting journal mode (`"wal"`, or e.g. `"memory"` for `:memory:`). */
export function switchToWal(db: JournalModeDb, options: SwitchToWalOptions = {}): string {
  const budgetMs = options.budgetMs ?? 5000;
  const sleep = options.sleep ?? sleepSync;
  const now = options.now ?? (() => performance.now());
  const started = now();
  let delayMs = 5;
  for (;;) {
    try {
      const current = modeOf(db.prepare("PRAGMA journal_mode").get());
      if (current?.toLowerCase() === "wal") return current;
      return modeOf(db.prepare("PRAGMA journal_mode = WAL").get()) ?? "unknown";
    } catch (error) {
      const elapsed = now() - started;
      if (!isSqliteBusyError(error) || elapsed >= budgetMs) throw error;
      sleep(Math.min(delayMs, Math.max(1, budgetMs - elapsed)));
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
}
