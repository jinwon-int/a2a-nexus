/**
 * In-memory NCLEX evaluation receipt store with snapshot persistence (#1724).
 *
 * Deduped by receiptId (idempotent submission). Persistence rides the broker's
 * snapshot extension mechanism: the store contributes its rows into the
 * broker snapshot (passthrough schema) and restores on boot. Records are
 * operator-safe projections only — they never carry prompt text or restricted
 * reference bodies, by construction of the receipt contract.
 */
import type { NclexSignedReceipt } from "./receipt-contract.js";

export interface NclexReceiptRecord {
  receipt: NclexSignedReceipt;
  recordedAt: string;
}

function prKeyOf(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

export class NclexEvaluationReceiptStore {
  private readonly records = new Map<string, NclexReceiptRecord>();
  /** Secondary index `${repo}#${prNumber}` → records in insertion order, so listByPr skips the full scan. */
  private readonly recordsByPr = new Map<string, NclexReceiptRecord[]>();

  constructor(rows: NclexReceiptRecord[] = []) {
    this.restore(rows);
  }

  /** Idempotent: same receiptId returns the existing record. */
  add(receipt: NclexSignedReceipt, recordedAt: string = new Date().toISOString()): NclexReceiptRecord {
    const existing = this.records.get(receipt.receiptId);
    if (existing) return existing;
    const record: NclexReceiptRecord = { receipt: structuredClone(receipt), recordedAt };
    this.records.set(receipt.receiptId, record);
    this.indexByPr(record);
    return record;
  }

  listByPr(repo: string, prNumber: number): NclexReceiptRecord[] {
    return (this.recordsByPr.get(prKeyOf(repo, prNumber)) ?? [])
      .filter((record) => record.receipt.repo === repo && record.receipt.prNumber === prNumber)
      .sort((a, b) => a.receipt.producedAt.localeCompare(b.receipt.producedAt));
  }

  listAll(): NclexReceiptRecord[] {
    // Shared records, not clones: every caller only reads/serializes them (the
    // snapshot writer stringifies immediately) — callers must not mutate.
    return [...this.records.values()];
  }

  count(): number {
    return this.records.size;
  }

  restore(rows: NclexReceiptRecord[]): void {
    this.records.clear();
    for (const row of rows) {
      if (row?.receipt?.receiptId) {
        this.records.set(row.receipt.receiptId, structuredClone(row));
      }
    }
    // Rebuild after the loop so duplicate receiptIds index the surviving row.
    this.recordsByPr.clear();
    for (const record of this.records.values()) {
      this.indexByPr(record);
    }
  }

  private indexByPr(record: NclexReceiptRecord): void {
    const key = prKeyOf(record.receipt.repo, record.receipt.prNumber);
    const bucket = this.recordsByPr.get(key);
    if (bucket) {
      bucket.push(record);
    } else {
      this.recordsByPr.set(key, [record]);
    }
  }
}
