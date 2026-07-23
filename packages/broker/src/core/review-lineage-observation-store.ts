/**
 * Atomic observation store for bounded PR review lineages (#1518 Phase 9).
 *
 * This is a source-only reference adapter. It proves that one normalized
 * Phase 8 observation can update a lineage and its durable idempotency ledger
 * in the same SQLite transaction. It is intentionally not connected to the
 * broker snapshot, HTTP routes, task completion, retries, or finalizer output.
 */

import { DatabaseSync } from "node:sqlite";

import {
  canonicalize,
  sha256Hex,
} from "../review-lifecycle/canonical-json.js";
import {
  applyEvent,
  createLineage,
} from "../review-lifecycle/lifecycle.js";
import type {
  ProjectedReviewLineageObservation,
  ReviewLineageSubjectBindingV1,
} from "../review-lifecycle/observation.js";
import type {
  ReviewLineageRecord,
  ReviewLineageState,
} from "../review-lifecycle/types.js";
import { reviewLineageRecordSchema } from "./store-schemas.js";

export const REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE =
  "broker_review_lineage_observation_lineages_v1";
export const REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE =
  "broker_review_lineage_observation_ledger_v1";

export type StableObservationOutcome =
  | "applied"
  | "missing_lineage"
  | "subject_conflict"
  | "transition_rejected";

export type ReviewLineageObservationApplicationResult =
  | {
      status: "applied";
      lineageId: string;
      outcome: "applied";
      state: ReviewLineageState;
      recordVersion: number;
      effects: string[];
    }
  | {
      status: "missing_lineage";
      lineageId: string;
      outcome: "missing_lineage";
    }
  | {
      status: "subject_conflict";
      lineageId: string;
      outcome: "subject_conflict";
    }
  | {
      status: "transition_rejected";
      lineageId: string;
      outcome: "transition_rejected";
    }
  | {
      status: "replayed";
      lineageId: string;
      originalOutcome: StableObservationOutcome;
      state?: ReviewLineageState;
      recordVersion?: number;
      effects?: string[];
    }
  | {
      status: "idempotency_conflict";
      lineageId: string;
    };

export interface DurableReviewLineageObservationStore {
  apply(
    command: ProjectedReviewLineageObservation,
  ): ReviewLineageObservationApplicationResult;
  getLineage(lineageId: string): ReviewLineageRecord | undefined;
  countLedgerEntries(): number;
}

export class ReviewLineageObservationStoreError extends Error {
  constructor(
    readonly code: "stored_record_invalid" | "stored_ledger_invalid",
  ) {
    super(code);
    this.name = "ReviewLineageObservationStoreError";
  }
}

interface LineageRow {
  lineage_id: string;
  record_json: string;
  record_version: number;
  intent_hash: string;
  head_sha: string;
  diff_hash: string;
}

interface LedgerRow {
  idempotency_key: string;
  payload_fingerprint: string;
  lineage_id: string;
  outcome_code: StableObservationOutcome;
  state: ReviewLineageState | null;
  record_version: number | null;
  effects_json: string;
}

function subjectFingerprint(subject: ReviewLineageSubjectBindingV1): string {
  return `sha256:${sha256Hex(canonicalize(subject))}`;
}

function subjectFromRecord(
  record: ReviewLineageRecord,
): ReviewLineageSubjectBindingV1 | undefined {
  if (record.currentDiffHash === null) return undefined;
  return {
    intentHash: record.contract.intentHash,
    headSha: record.currentHeadSha,
    diffHash: record.currentDiffHash,
  };
}

function sameSubject(
  left: ReviewLineageSubjectBindingV1 | undefined,
  right: ReviewLineageSubjectBindingV1,
): boolean {
  return left !== undefined
    && left.intentHash === right.intentHash
    && left.headSha === right.headSha
    && left.diffHash === right.diffHash;
}

/**
 * Engine effects are useful outcome metadata, but some carry reviewer ids,
 * finding ids, changed paths, or an unknown event value after a colon. The
 * durable ledger keeps only a closed redacted code projection.
 */
function redactEngineEffects(effects: string[]): string[] {
  return effects.map((effect) => {
    if (effect.startsWith("receipt_rejected:")) {
      return effect.split(":").slice(0, 2).join(":");
    }
    if (effect.startsWith("new_blocker_admitted:")) {
      const via = effect.split(":")[2];
      return via ? `new_blocker_admitted:${via}` : "new_blocker_admitted";
    }
    const code = effect.split(":")[0];
    if (
      code === "nonblocking_category_normalized"
      || code === "goalpost_rejected"
      || code === "duplicate_finding_id_ignored"
      || code === "repeated_signature_stop"
      || code === "forbidden_path_rejected"
      || code === "scope_drift_rejected"
      || code === "unknown_event"
    ) {
      return code;
    }
    return effect;
  });
}

function stableResult(
  lineageId: string,
  outcome: StableObservationOutcome,
  record?: ReviewLineageRecord,
  recordVersion?: number,
  effects: string[] = [],
): ReviewLineageObservationApplicationResult {
  if (
    outcome === "applied"
    && record !== undefined
    && recordVersion !== undefined
  ) {
    return {
      status: "applied",
      lineageId,
      outcome,
      state: record.state,
      recordVersion,
      effects: [...effects],
    };
  }
  if (outcome === "missing_lineage") {
    return { status: outcome, lineageId, outcome };
  }
  if (outcome === "subject_conflict") {
    return { status: outcome, lineageId, outcome };
  }
  return {
    status: "transition_rejected",
    lineageId,
    outcome: "transition_rejected",
  };
}

function replayResult(
  row: LedgerRow,
): ReviewLineageObservationApplicationResult {
  const result: Extract<
    ReviewLineageObservationApplicationResult,
    { status: "replayed" }
  > = {
    status: "replayed",
    lineageId: row.lineage_id,
    originalOutcome: row.outcome_code,
  };
  if (row.state !== null) result.state = row.state;
  if (row.record_version !== null) result.recordVersion = row.record_version;
  if (row.record_version !== null) {
    try {
      const parsed = JSON.parse(row.effects_json);
      if (
        !Array.isArray(parsed)
        || parsed.some((value) => typeof value !== "string")
      ) {
        throw new Error("invalid effects");
      }
      result.effects = parsed;
    } catch {
      throw new ReviewLineageObservationStoreError("stored_ledger_invalid");
    }
  }
  return result;
}

export class SqliteReviewLineageObservationStore
implements DurableReviewLineageObservationStore {
  private readonly db: DatabaseSync;

  constructor(dbFile: string) {
    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (dbFile !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.initialize();
  }

  apply(
    command: ProjectedReviewLineageObservation,
  ): ReviewLineageObservationApplicationResult {
    return this.immediateTransaction(() => {
      const prior = this.readLedger(command.idempotencyKey);
      if (prior) {
        if (prior.payload_fingerprint !== command.payloadFingerprint) {
          return {
            status: "idempotency_conflict",
            lineageId: command.lineageId,
          };
        }
        return replayResult(prior);
      }

      if (command.command.kind === "create_lineage") {
        return this.applyCreate(command);
      }
      return this.applyEvent(command);
    });
  }

  getLineage(lineageId: string): ReviewLineageRecord | undefined {
    const row = this.readLineageRow(lineageId);
    return row ? this.parseRecord(row.record_json) : undefined;
  }

  countLedgerEntries(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM ${REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE}`,
      )
      .get() as { count?: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE} (
        lineage_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        record_version INTEGER NOT NULL CHECK (record_version > 0),
        intent_hash TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS ${REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE} (
        idempotency_key TEXT PRIMARY KEY,
        payload_fingerprint TEXT NOT NULL,
        lineage_id TEXT NOT NULL,
        outcome_code TEXT NOT NULL CHECK (
          outcome_code IN (
            'applied',
            'missing_lineage',
            'subject_conflict',
            'transition_rejected'
          )
        ),
        expected_subject_fingerprint TEXT NOT NULL,
        state TEXT,
        record_version INTEGER,
        effects_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS
        broker_review_lineage_observation_ledger_lineage_v1
      ON ${REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE} (lineage_id);
    `);
  }

  private applyCreate(
    command: ProjectedReviewLineageObservation,
  ): ReviewLineageObservationApplicationResult {
    if (command.command.kind !== "create_lineage") {
      return this.recordStableOutcome(command, "transition_rejected");
    }
    const existing = this.readLineageRow(command.lineageId);
    if (existing) {
      return this.recordStableOutcome(command, "subject_conflict");
    }

    let record: ReviewLineageRecord;
    try {
      record = createLineage({
        ...command.command.input,
        mode: "record",
      });
    } catch {
      return this.recordStableOutcome(command, "transition_rejected");
    }
    const subject = subjectFromRecord(record);
    if (!sameSubject(subject, command.expectedSubject)) {
      return this.recordStableOutcome(command, "subject_conflict");
    }

    this.db.prepare(
      `INSERT INTO ${REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE} (
        lineage_id,
        record_json,
        record_version,
        intent_hash,
        head_sha,
        diff_hash,
        updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      record.lineageId,
      JSON.stringify(record),
      record.contract.intentHash,
      record.currentHeadSha,
      record.currentDiffHash,
      record.updatedAt,
    );
    return this.recordStableOutcome(command, "applied", record, 1, []);
  }

  private applyEvent(
    command: ProjectedReviewLineageObservation,
  ): ReviewLineageObservationApplicationResult {
    if (command.command.kind !== "record_event") {
      return this.recordStableOutcome(command, "transition_rejected");
    }
    const currentRow = this.readLineageRow(command.lineageId);
    if (!currentRow) {
      return this.recordStableOutcome(command, "missing_lineage");
    }
    const current = this.parseRecord(currentRow.record_json);
    if (!sameSubject(subjectFromRecord(current), command.expectedSubject)) {
      return this.recordStableOutcome(command, "subject_conflict");
    }

    let next: ReviewLineageRecord;
    let effects: string[];
    try {
      const applied = applyEvent(
        structuredClone(current),
        structuredClone(command.command.event),
      );
      next = applied.record;
      effects = redactEngineEffects(applied.effects);
    } catch {
      return this.recordStableOutcome(command, "transition_rejected");
    }
    const nextSubject = subjectFromRecord(next);
    if (!nextSubject) {
      return this.recordStableOutcome(command, "transition_rejected");
    }
    const nextVersion = currentRow.record_version + 1;
    const update = this.db.prepare(
      `UPDATE ${REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE}
       SET record_json = ?,
           record_version = ?,
           intent_hash = ?,
           head_sha = ?,
           diff_hash = ?,
           updated_at = ?
       WHERE lineage_id = ?
         AND record_version = ?
         AND intent_hash = ?
         AND head_sha = ?
         AND diff_hash = ?`,
    ).run(
      JSON.stringify(next),
      nextVersion,
      nextSubject.intentHash,
      nextSubject.headSha,
      nextSubject.diffHash,
      next.updatedAt,
      command.lineageId,
      currentRow.record_version,
      command.expectedSubject.intentHash,
      command.expectedSubject.headSha,
      command.expectedSubject.diffHash,
    );
    if (Number(update.changes) !== 1) {
      const raced = this.readLineageRow(command.lineageId);
      return this.recordStableOutcome(
        command,
        raced ? "subject_conflict" : "missing_lineage",
      );
    }
    return this.recordStableOutcome(
      command,
      "applied",
      next,
      nextVersion,
      effects,
    );
  }

  private recordStableOutcome(
    command: ProjectedReviewLineageObservation,
    outcome: StableObservationOutcome,
    record?: ReviewLineageRecord,
    recordVersion?: number,
    effects: string[] = [],
  ): ReviewLineageObservationApplicationResult {
    this.db.prepare(
      `INSERT INTO ${REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE} (
        idempotency_key,
        payload_fingerprint,
        lineage_id,
        outcome_code,
        expected_subject_fingerprint,
        state,
        record_version,
        effects_json,
        observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      command.idempotencyKey,
      command.payloadFingerprint,
      command.lineageId,
      outcome,
      subjectFingerprint(command.expectedSubject),
      record?.state ?? null,
      recordVersion ?? null,
      JSON.stringify(effects),
      command.observedAt,
    );
    return stableResult(
      command.lineageId,
      outcome,
      record,
      recordVersion,
      effects,
    );
  }

  private readLineageRow(lineageId: string): LineageRow | undefined {
    return this.db.prepare(
      `SELECT
         lineage_id,
         record_json,
         record_version,
         intent_hash,
         head_sha,
         diff_hash
       FROM ${REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE}
       WHERE lineage_id = ?`,
    ).get(lineageId) as LineageRow | undefined;
  }

  private readLedger(idempotencyKey: string): LedgerRow | undefined {
    return this.db.prepare(
      `SELECT
         idempotency_key,
         payload_fingerprint,
         lineage_id,
         outcome_code,
         state,
         record_version,
         effects_json
       FROM ${REVIEW_LINEAGE_OBSERVATION_LEDGER_TABLE}
       WHERE idempotency_key = ?`,
    ).get(idempotencyKey) as LedgerRow | undefined;
  }

  private parseRecord(payload: string): ReviewLineageRecord {
    try {
      return reviewLineageRecordSchema.parse(JSON.parse(payload));
    } catch {
      throw new ReviewLineageObservationStoreError("stored_record_invalid");
    }
  }

  private immediateTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the first failure; partial success is never reported.
      }
      throw error;
    }
  }
}
