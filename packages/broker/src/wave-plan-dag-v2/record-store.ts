/**
 * Append-only rehearsal-evidence store for WavePlanDagV2 (#1800 slice 4 —
 * item 7 remainder: restart/replay/idempotency and partial-failure atomicity
 * contracts, pure subset).
 *
 * This is the first persistable V2 surface, so its guarantees are the point:
 *
 * - **Evidence preservation.** Admissions and rehearsal outcomes are the
 *   signed-boundary documents of this contract (§5: "a rejection grants no
 *   authority and emits no success-like receipt"). The store keeps ALL
 *   distinct rehearsal outcomes for a manifest — replaying vectors 0 and 1 of
 *   the same manifest yields two preserved receipts, never a silent
 *   overwrite.
 * - **Idempotent redelivery (at-least-once safe).** Re-appending an entry
 *   identical to an existing one is a counted no-op. The identity key is
 *   semantic — admission: `manifestDigest`; receipt:
 *   `(manifestDigest, receiptDigest)`; rejection:
 *   `(manifestDigest, rejectionReason)` — so duplicates are detected by
 *   meaning, not array position. Same key with DIFFERENT content is a
 *   `duplicate_conflict` and rejects the whole batch.
 * - **All-or-nothing batches.** A batch is validated in full against a
 *   staged copy; any failure leaves the committed state byte-untouched. A
 *   half-built receipt cannot be represented (closed unions) nor smuggled in
 *   (structural validation + helper constructors derived from slice-1 typed
 *   results).
 * - **Flow ordering enforced.** A rehearsal entry must reference an already-
 *   known admission — from earlier commits or earlier in the same batch.
 *   An interrupted integration therefore only ever leaves "admitted,
 *   unrehearsed" or "admitted + rehearsed" states behind, both reproducible
 *   by re-running the pure functions.
 * - **Timestamp-free by design** (mirrors `core/wave-plan.ts`): identical op
 *   sequences produce deep-equal stores across processes, so restart/resume
 *   determinism is testable without clocks.
 * - **Fail-closed restore.** `restore()` validates every record structurally
 *   AND referentially before returning a store; one corrupted row rejects
 *   the whole snapshot with a structured reason. This is deliberately the
 *   opposite of slice-2's fail-open views: views are read projections where
 *   a bad row is survivable noise, while this store holds preservation-of-
 *   evidence records where silently dropping a row would be the actual harm.
 *   Honest boundary: structural corruption is caught; deletion of a complete,
 *   self-consistent entry cannot be detected locally — completeness pinning
 *   belongs to the operator's snapshot policy, not this module.
 *
 * No clock, no I/O, no broker wiring (`registerSnapshotExtension`
 * compatibility via plain value arrays comes with the future integration
 * slice). Entry unions carry no action fields — storage is not authority
 * (spec §1).
 */

import {
  WAVE_PLAN_DAG_V2_REJECTION_REASONS,
  type WavePlanDagV2RejectionReason,
} from "./errors.js";
import { compareAscii } from "./digest.js";
import type { WavePlanDagManifestAdmissionOkV2, WavePlanDagProposalSourceV2 } from "./manifest.js";
import type { WavePlanDagDryRunResultV2 } from "./dry-run.js";

export const WAVE_PLAN_DAG_V2_STORE_ENTRY_KIND = "WavePlanDagV2StoreEntryV1" as const;

/** Store-local closed vocabulary — separate from the §5 spec-reason enum. */
export const WAVE_PLAN_DAG_V2_STORE_REJECTION_REASONS = [
  "entry_malformed",
  "duplicate_conflict",
  "manifest_not_known",
  "batch_limit_exceeded",
  "snapshot_corrupt",
] as const;

export type WavePlanDagV2StoreRejectionReason = (typeof WAVE_PLAN_DAG_V2_STORE_REJECTION_REASONS)[number];

const MANIFEST_ALIAS_PATTERN = /^wpm_[0-9a-f]{16}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** Spec §3 cap mirrored for structural validation. */
const MAX_STAGES = 32;

class StoreRejectionError extends Error {
  constructor(readonly reason: WavePlanDagV2StoreRejectionReason, message: string) {
    super(message);
    this.name = "StoreRejectionError";
  }
}

function storeReject(reason: WavePlanDagV2StoreRejectionReason, message: string): never {
  throw new StoreRejectionError(reason, message);
}

/** Per-call batch bound keeping rejection surfaces bounded like §5 reasons. */
export const WAVE_PLAN_DAG_V2_STORE_MAX_BATCH_ENTRIES = 64;

interface ManifestAdmissionFields {
  entryType: "manifest_admitted";
  manifestDigest: string;
  manifestAlias: string;
  stageCount: number;
  proposalSource: WavePlanDagProposalSourceV2;
}

interface ReceiptFields {
  entryType: "rehearsal_receipt_recorded";
  manifestDigest: string;
  receiptDigest: string;
  topologyLength: number;
}

interface RejectionFields {
  entryType: "rehearsal_rejected";
  manifestDigest: string;
  rejectionReason: WavePlanDagV2RejectionReason;
}

/** Closed stored-entry union. Any extra field makes the entry malformed. */
export type WavePlanDagV2StoredEntry =
  | ({ kind: typeof WAVE_PLAN_DAG_V2_STORE_ENTRY_KIND; version: 1 } & ManifestAdmissionFields)
  | ({ kind: typeof WAVE_PLAN_DAG_V2_STORE_ENTRY_KIND; version: 1 } & ReceiptFields)
  | ({ kind: typeof WAVE_PLAN_DAG_V2_STORE_ENTRY_KIND; version: 1 } & RejectionFields);

function assertClosedEntryShape(entry: unknown): asserts entry is WavePlanDagV2StoredEntry {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    storeReject("entry_malformed", "store entry must be an object");
  }
  const candidate = entry as Record<string, unknown>;
  if (candidate.kind !== WAVE_PLAN_DAG_V2_STORE_ENTRY_KIND || candidate.version !== 1) {
    storeReject("entry_malformed", "store entry kind/version mismatch");
  }
  const expected =
    candidate.entryType === "manifest_admitted"
      ? ["entryType", "kind", "manifestAlias", "manifestDigest", "proposalSource", "stageCount", "version"]
      : candidate.entryType === "rehearsal_receipt_recorded"
        ? ["entryType", "kind", "manifestDigest", "receiptDigest", "topologyLength", "version"]
        : candidate.entryType === "rehearsal_rejected"
          ? ["entryType", "kind", "manifestDigest", "rejectionReason", "version"]
          : null;
  if (expected === null) {
    storeReject("entry_malformed", `unknown entryType ${String(candidate.entryType)}`);
  }
  const actual = Object.keys(candidate).sort(compareAscii);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    storeReject("entry_malformed", `store entry fields differ: ${JSON.stringify(actual)}`);
  }
}

function validateEntrySemantics(entry: WavePlanDagV2StoredEntry): void {
  if (!DIGEST_PATTERN.test(entry.manifestDigest)) {
    storeReject("entry_malformed", "manifestDigest has invalid form");
  }
  if (entry.entryType === "manifest_admitted") {
    if (!MANIFEST_ALIAS_PATTERN.test(entry.manifestAlias)) {
      storeReject("entry_malformed", "manifestAlias has invalid form");
    }
    if (!Number.isSafeInteger(entry.stageCount) || entry.stageCount < 1 || entry.stageCount > MAX_STAGES) {
      storeReject("entry_malformed", "stageCount outside 1..32");
    }
    if (entry.proposalSource !== "model" && entry.proposalSource !== "operator") {
      storeReject("entry_malformed", "proposalSource is not closed");
    }
  } else if (entry.entryType === "rehearsal_receipt_recorded") {
    if (!DIGEST_PATTERN.test(entry.receiptDigest)) {
      storeReject("entry_malformed", "receiptDigest has invalid form");
    }
    if (!Number.isSafeInteger(entry.topologyLength) || entry.topologyLength < 1 || entry.topologyLength > MAX_STAGES) {
      storeReject("entry_malformed", "topologyLength outside 1..32");
    }
  } else if (!WAVE_PLAN_DAG_V2_REJECTION_REASONS.includes(entry.rejectionReason)) {
    storeReject("entry_malformed", "rejectionReason is not a closed §5 reason");
  }
}

/**
 * Semantic identity key. Duplicates are detected by meaning, so an at-least-
 * once redelivery arriving in different array positions still collapses.
 */
function identityKey(entry: WavePlanDagV2StoredEntry): string {
  if (entry.entryType === "manifest_admitted") return `A\0${entry.manifestDigest}`;
  if (entry.entryType === "rehearsal_receipt_recorded") {
    return `R\0${entry.manifestDigest}\0${entry.receiptDigest}`;
  }
  return `J\0${entry.manifestDigest}\0${entry.rejectionReason}`;
}

/** Canonical content string used to tell conflicting writes apart from dupes. */
function contentKey(entry: WavePlanDagV2StoredEntry): string {
  const pairs = Object.keys(entry)
    .sort(compareAscii)
    .map((key) => `${key}:${String(((entry as unknown as Record<string, unknown>)[key]))}`);
  return `${identityKey(entry)}|${pairs.join("|")}`;
}

export interface WavePlanDagV2StoreAppendOk {
  ok: true;
  /** New entries committed by this call. */
  committed: number;
  /** Exact duplicates that collapsed onto existing knowledge. */
  skippedDuplicates: number;
}
export interface WavePlanDagV2StoreAppendRejected {
  ok: false;
  reason: WavePlanDagV2StoreRejectionReason;
  message: string;
}
export type WavePlanDagV2StoreAppendResult = WavePlanDagV2StoreAppendOk | WavePlanDagV2StoreAppendRejected;

export class WavePlanDagV2RecordStore {
  private readonly entries: WavePlanDagV2StoredEntry[] = [];
  private readonly indexByKey = new Map<string, string>();

  /**
   * Validates the whole batch against a staged copy and commits atomically.
   * On any failure nothing changes; on success exact duplicates collapse into
   * skipped counts and new entries append in arrival order.
   */
  append(batch: readonly unknown[]): WavePlanDagV2StoreAppendResult {
    try {
      if (!Array.isArray(batch)) {
        storeReject("entry_malformed", "append batch must be an array");
      }
      if (batch.length > WAVE_PLAN_DAG_V2_STORE_MAX_BATCH_ENTRIES) {
        storeReject(
          "batch_limit_exceeded",
          `batch exceeds ${WAVE_PLAN_DAG_V2_STORE_MAX_BATCH_ENTRIES} entries`,
        );
      }

      const stagedEntries = [...this.entries];
      const stagedKeys = new Map(this.indexByKey);
      let committed = 0;
      let skippedDuplicates = 0;

      for (const raw of batch) {
        assertClosedEntryShape(raw);
        validateEntrySemantics(raw);
        const entry = raw;

        const key = identityKey(entry);
        const content = contentKey(entry);
        const existingContent = stagedKeys.get(key);
        if (existingContent !== undefined) {
          if (existingContent !== content) {
            storeReject(
              "duplicate_conflict",
              `conflicting rewrite of ${key.split("\0")[0]} record`,
            );
          }
          skippedDuplicates += 1;
          continue;
        }

        // Flow ordering: rehearsals must reference a known admission.
        if (entry.entryType !== "manifest_admitted" && !stagedKeys.has(`A\0${entry.manifestDigest}`)) {
          storeReject("manifest_not_known", `no admitted manifest ${entry.manifestDigest} precedes this rehearsal`);
        }

        stagedKeys.set(key, content);
        stagedEntries.push(entry);
        committed += 1;
      }

      // Commit point — everything above passed; swap atomically.
      this.entries.length = 0;
      this.entries.push(...stagedEntries);
      this.indexByKey.clear();
      for (const [key, content] of stagedKeys) this.indexByKey.set(key, content);
      return { ok: true, committed, skippedDuplicates };
    } catch (error) {
      if (error instanceof StoreRejectionError) {
        return { ok: false, reason: error.reason, message: error.message };
      }
      throw error;
    }
  }

  /** All admissions in first-admission order. Fresh copies, frozen shape. */
  admissions(): Extract<WavePlanDagV2StoredEntry, { entryType: "manifest_admitted" }>[] {
    return this.entries
      .filter((entry): entry is Extract<WavePlanDagV2StoredEntry, { entryType: "manifest_admitted" }> => entry.entryType === "manifest_admitted")
      .map((entry) => ({ ...entry }));
  }

  /** Every preserved rehearsal outcome for one manifest, in commit order. */
  rehearsalsOf(manifestDigest: string): Extract<WavePlanDagV2StoredEntry, { entryType: "rehearsal_receipt_recorded" | "rehearsal_rejected" }>[] {
    return this.entries
      .filter((entry): entry is Extract<WavePlanDagV2StoredEntry, { entryType: "rehearsal_receipt_recorded" | "rehearsal_rejected" }> => entry.entryType !== "manifest_admitted" && entry.manifestDigest === manifestDigest)
      .map((entry) => ({ ...entry }));
  }

  /** Plain value-array persistence form (timestamp-free; order is the sort key). */
  snapshot(): WavePlanDagV2StoredEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /**
   * Fail-closed load path. Returns a new store only when EVERY record is
   * structurally valid and referentially consistent; otherwise a structured
   * rejection names the corruption class and nothing is loaded.
   */
  static restore(records: unknown):
    | { ok: true; store: WavePlanDagV2RecordStore }
    | { ok: false; reason: WavePlanDagV2StoreRejectionReason; message: string } {
    try {
      if (!Array.isArray(records)) {
        storeReject("snapshot_corrupt", "snapshot must be an array");
      }
      // Each record must be closed-shaped here even though append() would
      // also check it: restore reports `snapshot_corrupt`, not entry vocab.
      for (const record of records) {
        try {
          assertClosedEntryShape(record);
          validateEntrySemantics(record);
        } catch (error) {
          if (error instanceof StoreRejectionError || (error instanceof Error && "reason" in error)) {
            storeReject("snapshot_corrupt", `structurally invalid record: ${error instanceof Error ? error.message : String(error)}`);
          }
          throw error;
        }
      }
      const store = new WavePlanDagV2RecordStore();
      const result = store.append(records);
      if (!result.ok) {
        storeReject("snapshot_corrupt", `referentially inconsistent snapshot: ${result.message}`);
      }
      if (result.committed !== records.length) {
        storeReject(
          "snapshot_corrupt",
          "snapshot contains exact-duplicate entries; canonical snapshots never do",
        );
      }
      return { ok: true, store };
    } catch (error) {
      if (error instanceof StoreRejectionError) {
        return { ok: false, reason: error.reason, message: error.message };
      }
      throw error;
    }
  }
}

export function createWavePlanDagV2RecordStore(): WavePlanDagV2RecordStore {
  return new WavePlanDagV2RecordStore();
}

// ---------------------------------------------------------------------------
// Helper constructors — entries derive from slice-1 typed results only, so
// fabricated digests have no path into the store through these doors.
// ---------------------------------------------------------------------------

export function wavePlanDagV2ManifestAdmissionEntry(
  admission: WavePlanDagManifestAdmissionOkV2,
): WavePlanDagV2StoredEntry {
  return {
    kind: WAVE_PLAN_DAG_V2_STORE_ENTRY_KIND,
    version: 1,
    entryType: "manifest_admitted",
    manifestDigest: admission.manifest.manifestDigest,
    manifestAlias: admission.manifest.manifestAlias,
    stageCount: admission.manifest.stages.length,
    proposalSource: admission.manifest.proposalSource,
  };
}

export function wavePlanDagV2RehearsalOutcomeEntry(
  run: Extract<WavePlanDagDryRunResultV2, { ok: true }> | Extract<WavePlanDagDryRunResultV2, { ok: false }>,
  manifestDigest: string,
): WavePlanDagV2StoredEntry {
  if (run.ok) {
    return {
      kind: WAVE_PLAN_DAG_V2_STORE_ENTRY_KIND,
      version: 1,
      entryType: "rehearsal_receipt_recorded",
      manifestDigest,
      receiptDigest: run.receipt.receiptDigest,
      topologyLength: run.receipt.topologicalOrder.length,
    };
  }
  return {
    kind: WAVE_PLAN_DAG_V2_STORE_ENTRY_KIND,
    version: 1,
    entryType: "rehearsal_rejected",
    manifestDigest,
    rejectionReason: run.reason,
  };
}
