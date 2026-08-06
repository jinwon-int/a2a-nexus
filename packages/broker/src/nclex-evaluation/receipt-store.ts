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

export class NclexEvaluationReceiptStore {
  private readonly records = new Map<string, NclexReceiptRecord>();

  constructor(rows: NclexReceiptRecord[] = []) {
    this.restore(rows);
  }

  /** Idempotent: same receiptId returns the existing record. */
  add(receipt: NclexSignedReceipt, recordedAt: string = new Date().toISOString()): NclexReceiptRecord {
    const existing = this.records.get(receipt.receiptId);
    if (existing) return existing;
    const record: NclexReceiptRecord = { receipt: structuredClone(receipt), recordedAt };
    this.records.set(receipt.receiptId, record);
    return record;
  }

  listByPr(repo: string, prNumber: number): NclexReceiptRecord[] {
    return [...this.records.values()]
      .filter((record) => record.receipt.repo === repo && record.receipt.prNumber === prNumber)
      .sort((a, b) => a.receipt.producedAt.localeCompare(b.receipt.producedAt));
  }

  listAll(): NclexReceiptRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
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
  }
}
