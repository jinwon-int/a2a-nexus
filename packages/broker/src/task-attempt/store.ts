/**
 * Durable TaskAttemptRecordV1 store (#1799 slice 1).
 *
 * SQLite-backed (node:sqlite, same engine as the review-lineage observation
 * store) with the exact spec §6 boundary semantics:
 *
 *   contract_rejected        — validation failed; nothing stored
 *   accepted                 — first appearance of this recordKey
 *   idempotent_replay        — same key, byte-equivalent canonical payload,
 *                              same fingerprint; no additional effect
 *   same_key_payload_conflict — same key, different validated payload or
 *                              fingerprint; fails closed, original untouched
 *
 * Every result is a boundary result only: it never carries task-execution
 * authority (no claim denial, no retry, no finalization — spec §6, §9).
 *
 * The store also owns the private public-safe alias ledger: broker-local task
 * ids never appear in a record, so the producer asks the store for a stable
 * random `tsk_`/`brk_` alias per local id. The alias table is private local
 * state — it is not part of any record, projection, or export.
 */

import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalTaskAttemptJson,
  validateTaskAttemptRecord,
  type TaskAttemptRecordV1,
} from "./record.js";

export const TASK_ATTEMPT_RECORD_TABLE = "broker_task_attempt_records_v1";
export const TASK_ATTEMPT_ALIAS_TABLE = "broker_task_attempt_alias_v1";

export type TaskAttemptSubmitResult =
  | { status: "accepted"; recordKey: string }
  | { status: "idempotent_replay"; recordKey: string }
  | { status: "same_key_payload_conflict"; recordKey: string }
  | { status: "contract_rejected"; reason: string };

export class TaskAttemptRecordStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${TASK_ATTEMPT_RECORD_TABLE} (
        record_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        canonical_payload TEXT NOT NULL,
        producer_kind TEXT NOT NULL,
        broker_of_record TEXT NOT NULL,
        retry_root_task_id TEXT NOT NULL,
        attempt_ordinal INTEGER NOT NULL
      ) STRICT;`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${TASK_ATTEMPT_ALIAS_TABLE} (
        scope TEXT NOT NULL,
        local_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        PRIMARY KEY (scope, local_id)
      ) STRICT;`,
    );
  }

  /**
   * Validate then apply spec §6 replay/conflict semantics in one transaction.
   */
  submit(input: unknown): TaskAttemptSubmitResult {
    const validation = validateTaskAttemptRecord(input);
    if (!validation.ok) {
      return { status: "contract_rejected", reason: validation.reason };
    }
    const record = validation.record;
    const canonical = canonicalTaskAttemptJson(record as unknown as Record<string, unknown>);
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.db
        .prepare(`SELECT fingerprint, canonical_payload FROM ${TASK_ATTEMPT_RECORD_TABLE} WHERE record_key = ?`)
        .get(record.recordKey) as { fingerprint: string; canonical_payload: string } | undefined;
      if (existing !== undefined) {
        this.db.exec("ROLLBACK;");
        // Byte-equivalent canonical payload AND same fingerprint ⇒ replay.
        // Anything else — including an equal fingerprint over a different
        // payload — is a conflict (spec §6).
        if (existing.canonical_payload === canonical && existing.fingerprint === record.fingerprint) {
          return { status: "idempotent_replay", recordKey: record.recordKey };
        }
        return { status: "same_key_payload_conflict", recordKey: record.recordKey };
      }
      this.db
        .prepare(
          `INSERT INTO ${TASK_ATTEMPT_RECORD_TABLE}
             (record_key, fingerprint, canonical_payload, producer_kind, broker_of_record, retry_root_task_id, attempt_ordinal)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.recordKey,
          record.fingerprint,
          canonical,
          record.producerKind,
          record.brokerOfRecord,
          record.retryRootTaskId,
          record.attemptOrdinal,
        );
      this.db.exec("COMMIT;");
      return { status: "accepted", recordKey: record.recordKey };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // already rolled back
      }
      throw error;
    }
  }

  /** Re-validated read; a corrupted row fails closed to undefined (spec §9). */
  getByRecordKey(recordKey: string): TaskAttemptRecordV1 | undefined {
    const row = this.db
      .prepare(`SELECT canonical_payload FROM ${TASK_ATTEMPT_RECORD_TABLE} WHERE record_key = ?`)
      .get(recordKey) as { canonical_payload: string } | undefined;
    if (row === undefined) return undefined;
    return this.revalidate(row.canonical_payload);
  }

  /**
   * All records in one explicit retry lineage, ordinal-ascending. Advisory
   * read only — the slice-2 dispatcher preflight builds on this.
   */
  listByRetryRoot(brokerOfRecord: string, retryRootTaskId: string): TaskAttemptRecordV1[] {
    const rows = this.db
      .prepare(
        `SELECT canonical_payload FROM ${TASK_ATTEMPT_RECORD_TABLE}
         WHERE broker_of_record = ? AND retry_root_task_id = ?
         ORDER BY attempt_ordinal ASC, record_key ASC`,
      )
      .all(brokerOfRecord, retryRootTaskId) as { canonical_payload: string }[];
    const records: TaskAttemptRecordV1[] = [];
    for (const row of rows) {
      const record = this.revalidate(row.canonical_payload);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  recordCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${TASK_ATTEMPT_RECORD_TABLE}`).get() as { n: number };
    return row.n;
  }

  /**
   * Stable random public-safe alias for a broker-local identifier. Random
   * assignment (spec §2: never derived from private data), idempotent per
   * (scope, localId) so one local task keeps one alias across emissions and
   * restarts. The ledger is private local state only.
   */
  aliasFor(scope: "task" | "broker", localId: string): string {
    const row = this.db
      .prepare(`SELECT alias FROM ${TASK_ATTEMPT_ALIAS_TABLE} WHERE scope = ? AND local_id = ?`)
      .get(scope, localId) as { alias: string } | undefined;
    if (row !== undefined) return row.alias;
    const alias = scope === "task" ? "tsk_" + randomBytes(16).toString("hex") : "brk_" + randomBytes(8).toString("hex");
    this.db
      .prepare(`INSERT INTO ${TASK_ATTEMPT_ALIAS_TABLE} (scope, local_id, alias) VALUES (?, ?, ?)`)
      .run(scope, localId, alias);
    return alias;
  }

  close(): void {
    this.db.close();
  }

  private revalidate(canonicalPayload: string): TaskAttemptRecordV1 | undefined {
    try {
      const validation = validateTaskAttemptRecord(JSON.parse(canonicalPayload));
      return validation.ok ? validation.record : undefined;
    } catch {
      return undefined;
    }
  }
}
