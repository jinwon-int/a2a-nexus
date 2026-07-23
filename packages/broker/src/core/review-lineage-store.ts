/**
 * Durable adapter for the bounded PR review lifecycle (#1518 Phase 3b).
 *
 * The lifecycle engine remains pure. This store only owns cloned records and
 * applies explicit events; it does not subscribe to task completion, retry, or
 * finalizer paths. Broker rollout mode decides whether mutations are recorded.
 */

import {
  applyEvent,
  createLineage,
  type AppliedEvent,
  type CreateLineageInput,
} from "../review-lifecycle/lifecycle.js";
import type {
  ReviewLineageEvent,
  ReviewLineageRecord,
} from "../review-lifecycle/types.js";

export type CreateRecordedReviewLineageInput = Omit<CreateLineageInput, "mode">;
export type ReviewLineageRolloutMode = "off" | "record";

export function resolveReviewLineageRolloutMode(
  raw: string | undefined,
): ReviewLineageRolloutMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "record") return "record";
  throw new Error(
    `invalid A2A_REVIEW_LINEAGE_MODE='${raw}' (expected off | record)`,
  );
}

export class ReviewLineageStoreError extends Error {
  constructor(
    readonly code: "duplicate_lineage" | "lineage_not_found",
    message: string,
  ) {
    super(message);
    this.name = "ReviewLineageStoreError";
  }
}

function cloneRecord(record: ReviewLineageRecord): ReviewLineageRecord {
  return structuredClone(record);
}

export class ReviewLineageStore {
  private readonly records = new Map<string, ReviewLineageRecord>();

  constructor(records: ReviewLineageRecord[] = []) {
    this.restore(records);
  }

  create(input: CreateRecordedReviewLineageInput): ReviewLineageRecord {
    if (this.records.has(input.contract.lineageId)) {
      throw new ReviewLineageStoreError(
        "duplicate_lineage",
        `review lineage '${input.contract.lineageId}' already exists`,
      );
    }
    const record = createLineage({ ...input, mode: "record" });
    this.records.set(record.lineageId, cloneRecord(record));
    return cloneRecord(record);
  }

  apply(lineageId: string, event: ReviewLineageEvent): AppliedEvent {
    const current = this.records.get(lineageId);
    if (!current) {
      throw new ReviewLineageStoreError(
        "lineage_not_found",
        `review lineage '${lineageId}' not found`,
      );
    }
    const applied = applyEvent(cloneRecord(current), structuredClone(event));
    this.records.set(lineageId, cloneRecord(applied.record));
    return {
      record: cloneRecord(applied.record),
      effects: [...applied.effects],
    };
  }

  get(lineageId: string): ReviewLineageRecord | undefined {
    const record = this.records.get(lineageId);
    return record ? cloneRecord(record) : undefined;
  }

  list(): ReviewLineageRecord[] {
    return [...this.records.values()]
      .sort((a, b) => a.lineageId.localeCompare(b.lineageId))
      .map(cloneRecord);
  }

  snapshot(): ReviewLineageRecord[] {
    return this.list();
  }

  restore(records: ReviewLineageRecord[]): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(record.lineageId, cloneRecord(record));
    }
  }
}
