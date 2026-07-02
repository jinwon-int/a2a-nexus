/**
 * Tests for the terminal outbox legacy residue classifier.
 *
 * Covers deterministic classification of current-window vs legacy-residue
 * vs unclassifiable terminal_outbox rows using cutoff age, payload
 * completeness, receipt vocabulary, and ACK evidence vocabulary signals.
 *
 * Reference: #886 Team1/workergamma Terminal Brief hardening lane 1/4.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOutboxRow,
  classifyOutboxRows,
  hasUnsafeEvidenceUrl,
  DEFAULT_LEGACY_RESIDUE_CUTOFF,
  type OutboxRowCandidate,
  type OutboxRowClassification,
  type OutboxLegacyResidueReport,
} from "./terminal-outbox-legacy-classifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CUTOFF_MS = Date.parse(DEFAULT_LEGACY_RESIDUE_CUTOFF);
const BEFORE_CUTOFF = "2026-05-02T00:00:00.000Z";
const AFTER_CUTOFF = "2026-05-06T00:00:00.000Z";

function makeRow(overrides: Partial<OutboxRowCandidate> & { id: string }): OutboxRowCandidate {
  const { id, createdAt, receipt, payload, ack, ...rest } = overrides;
  const hasCreatedAt = Object.prototype.hasOwnProperty.call(overrides, "createdAt");
  const hasReceipt = Object.prototype.hasOwnProperty.call(overrides, "receipt");
  const hasPayload = Object.prototype.hasOwnProperty.call(overrides, "payload");
  return {
    ...rest,
    id,
    createdAt: hasCreatedAt ? createdAt : AFTER_CUTOFF,
    receipt: hasReceipt ? receipt : { status: "accepted", updatedAt: AFTER_CUTOFF },
    payload: hasPayload ? payload : {
      taskBrief: "test task",
      prUrl: "https://github.com/test/repo/pull/1",
      worker: "test-worker",
    },
    // Ensure nested objects merge correctly
    ack: ack ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Single row classification
// ---------------------------------------------------------------------------

describe("classifyOutboxRow", () => {
  it("classifies a complete healthy post-cutoff row as current-window", () => {
    const row = makeRow({ id: "healthy-1" });
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "current-window");
    assert.equal(result.id, "healthy-1");
    assert.equal(result.signals.hasTaskBrief, true);
    assert.equal(result.signals.missingEvidence, false);
    assert.equal(result.signals.preCutoff, false);
    assert.equal(result.signals.legacyReceiptStatus, false);
    assert.equal(result.signals.legacyAckEvidence, false);
  });

  it("classifies a pre-cutoff row with complete data as legacy-residue", () => {
    const row = makeRow({ id: "pre-cutoff-1", createdAt: BEFORE_CUTOFF });
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "legacy-residue");
    assert.equal(result.signals.preCutoff, true);
    assert.match(result.reason, /pre-cutoff/);
  });

  it("classifies a post-cutoff row missing taskBrief as current-window", () => {
    const row = makeRow({
      id: "no-brief-1",
      payload: {
        prUrl: "https://github.com/test/repo/pull/2",
        worker: "test-worker",
      },
    });
    // Remove taskBrief that makeRow adds by default
    delete (row as any).payload.taskBrief;
    const result = classifyOutboxRow(row, CUTOFF_MS);
    // Post-cutoff with evidence but no taskBrief → still current-window (has evidence and no strong legacy signals)
    assert.equal(result.origin, "current-window");
    assert.equal(result.signals.hasTaskBrief, false);
    assert.equal(result.signals.preCutoff, false);
  });

  it("classifies a pre-cutoff row missing taskBrief as legacy-residue", () => {
    const row = makeRow({
      id: "legacy-no-brief-1",
      createdAt: BEFORE_CUTOFF,
      payload: {
        prUrl: "https://github.com/test/repo/pull/3",
      },
    });
    delete (row as any).payload.taskBrief;
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "legacy-residue");
    assert.ok(result.signals.preCutoff);
  });

  it("classifies a pre-cutoff row missing both taskBrief and evidence as legacy-residue", () => {
    const row = makeRow({
      id: "legacy-bare-1",
      createdAt: BEFORE_CUTOFF,
      payload: {},
    });
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "legacy-residue");
    assert.equal(result.signals.preCutoff, true);
    assert.equal(result.signals.hasTaskBrief, false);
    assert.equal(result.signals.missingEvidence, true);
  });

  it("classifies a row with legacy receipt status as legacy-residue", () => {
    const row = makeRow({
      id: "legacy-receipt-1",
      createdAt: AFTER_CUTOFF,
      receipt: { status: "sent", updatedAt: AFTER_CUTOFF },
      payload: {
        taskBrief: "legacy receipt",
        prUrl: "https://github.com/test/repo/pull/4",
        worker: "test-worker",
      },
    });
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "legacy-residue");
    assert.equal(result.signals.legacyReceiptStatus, true);
    assert.match(result.reason, /legacy receipt status/);
  });

  it("classifies a row with legacy ACK evidence as legacy-residue", () => {
    const row = makeRow({
      id: "legacy-ack-1",
      createdAt: AFTER_CUTOFF,
      ack: {
        status: "receipt_confirmed",
        evidence: "provider_delivery_receipt",
        acknowledgedAt: AFTER_CUTOFF,
      },
      payload: {
        taskBrief: "legacy ACK",
        prUrl: "https://github.com/test/repo/pull/5",
        worker: "test-worker",
      },
    });
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "legacy-residue");
    assert.equal(result.signals.legacyAckEvidence, true);
    assert.match(result.reason, /legacy ACK evidence/);
  });

  it("classifies a row with provider_delivered_if_known receipt as legacy-residue", () => {
    const row = makeRow({
      id: "legacy-receipt-2",
      receipt: { status: "provider_delivered_if_known", updatedAt: BEFORE_CUTOFF },
    });
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "legacy-residue");
    assert.equal(result.signals.legacyReceiptStatus, true);
  });

  it("classifies a receipt-confirmed post-cutoff row as current-window", () => {
    const row = makeRow({
      id: "ack-current-1",
      ack: {
        status: "receipt_confirmed",
        evidence: "operator_visible",
        acknowledgedAt: AFTER_CUTOFF,
      },
      receipt: {
        status: "operator_visible",
        updatedAt: AFTER_CUTOFF,
      },
    });
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "current-window");
    assert.equal(result.signals.receiptConfirmed, true);
    assert.equal(result.signals.legacyAckEvidence, false);
  });

  it("classifies row with minimal data as unclassifiable", () => {
    const result = classifyOutboxRow({ id: "empty-1" }, CUTOFF_MS);
    assert.equal(result.origin, "unclassifiable");
    assert.match(result.reason, /insufficient data/);
  });

  it("returns null id when id is missing or not a string", () => {
    const result = classifyOutboxRow({ id: 42 } as any, CUTOFF_MS);
    assert.equal(result.id, null);
  });

  it("handles null cutoffMs gracefully", () => {
    const row = makeRow({ id: "no-cutoff-1", createdAt: BEFORE_CUTOFF });
    const result = classifyOutboxRow(row, null);
    assert.equal(result.origin, "legacy-residue");
    assert.equal(result.signals.preCutoff, true);
  });

  it("handles undefined cutoffMs gracefully", () => {
    const row = makeRow({ id: "no-cutoff-2", createdAt: BEFORE_CUTOFF });
    const result = classifyOutboxRow(row, undefined);
    assert.equal(result.origin, "legacy-residue");
    assert.equal(result.signals.preCutoff, true);
  });

  it("handles missing createdAt with pre-cutoff unknown", () => {
    const row = makeRow({ id: "no-created-1", createdAt: undefined as any });
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.signals.preCutoff, null);
  });

  it("classifies post-cutoff receipt-confirmed row missing taskBrief but having evidence as current-window", () => {
    const row = makeRow({
      id: "no-brief-acked-1",
      ack: { status: "receipt_confirmed", evidence: "operator_visible", acknowledgedAt: AFTER_CUTOFF },
      receipt: { status: "operator_visible", updatedAt: AFTER_CUTOFF },
      payload: {
        prUrl: "https://github.com/test/repo/pull/6",
        worker: "test-worker",
      },
    });
    delete (row as any).payload.taskBrief;
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "current-window");
    assert.ok(result.signals.receiptConfirmed);
  });

  it("classifies pre-cutoff receipt-confirmed row with legacy evidence as legacy-residue", () => {
    const row = makeRow({
      id: "pre-cutoff-acked-legacy-1",
      createdAt: BEFORE_CUTOFF,
      ack: { status: "receipt_confirmed", evidence: "provider_delivery_receipt", acknowledgedAt: BEFORE_CUTOFF },
      receipt: { status: "sent", updatedAt: BEFORE_CUTOFF },
    });
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "legacy-residue");
    assert.equal(result.signals.preCutoff, true);
    assert.equal(result.signals.legacyReceiptStatus, true);
    assert.equal(result.signals.legacyAckEvidence, true);
  });
});

// ---------------------------------------------------------------------------
// Aggregate report
// ---------------------------------------------------------------------------

describe("classifyOutboxRows", () => {
  it("returns empty report for empty array", () => {
    const report = classifyOutboxRows([]);
    assert.equal(report.total, 0);
    assert.equal(report.currentWindow, 0);
    assert.equal(report.legacyResidue, 0);
    assert.equal(report.unclassifiable, 0);
    assert.equal(report.classifications.length, 0);
  });

  it("categorizes mixed rows correctly", () => {
    const rows: OutboxRowCandidate[] = [
      makeRow({ id: "current-1" }),
      makeRow({ id: "legacy-1", createdAt: BEFORE_CUTOFF }),
      makeRow({ id: "unclass-1", createdAt: undefined as any }),
    ];
    // Remove all payload from the unclassifiable row
    (rows[2] as any).payload = undefined;

    const report = classifyOutboxRows(rows, { cutoffMs: CUTOFF_MS });
    assert.equal(report.total, 3);
    assert.equal(report.currentWindow, 1);
    assert.equal(report.legacyResidue, 1);
    assert.equal(report.unclassifiable, 1);
    assert.equal(report.classifications.length, 3);

    // Check IDs match
    const currentIds = report.classifications.filter((c) => c.origin === "current-window").map((c) => c.id);
    const legacyIds = report.classifications.filter((c) => c.origin === "legacy-residue").map((c) => c.id);
    assert.deepEqual(currentIds, ["current-1"]);
    assert.deepEqual(legacyIds, ["legacy-1"]);
  });

  it("populates legacyResidueSummary correctly", () => {
    const rows: OutboxRowCandidate[] = [
      makeRow({ id: "current-1" }),
      makeRow({ id: "legacy-1", createdAt: BEFORE_CUTOFF }),
    ];
    const report = classifyOutboxRows(rows, { cutoffMs: CUTOFF_MS });
    assert.equal(report.legacyResidueSummary.length, 1);
    assert.equal(report.legacyResidueSummary[0]!.id, "legacy-1");
    assert.match(report.legacyResidueSummary[0]!.reason, /legacy residue/);
  });

  it("reports current-window missingTaskBriefIds", () => {
    const rows: OutboxRowCandidate[] = [
      {
        id: "current-no-brief",
        createdAt: AFTER_CUTOFF,
        receipt: { status: "accepted", updatedAt: AFTER_CUTOFF },
        payload: {
          prUrl: "https://github.com/test/repo/pull/10",
          worker: "test-worker",
        },
      },
    ];
    // Can't use makeRow since it adds taskBrief; build manually
    const report = classifyOutboxRows(rows, { cutoffMs: CUTOFF_MS });
    assert.equal(report.currentWindowBlockers.missingTaskBriefIds.length, 1);
    assert.equal(report.currentWindowBlockers.missingTaskBriefIds[0], "current-no-brief");
  });
});

// ---------------------------------------------------------------------------
// Unsafe evidence URL detection
// ---------------------------------------------------------------------------

describe("hasUnsafeEvidenceUrl", () => {
  it("returns false for null/undefined payload", () => {
    assert.equal(hasUnsafeEvidenceUrl(null), false);
    assert.equal(hasUnsafeEvidenceUrl(undefined), false);
  });

  it("returns false for HTTP and HTTPS URLs", () => {
    assert.equal(hasUnsafeEvidenceUrl({ prUrl: "https://github.com/a/b/pull/1" }), false);
    assert.equal(hasUnsafeEvidenceUrl({ doneUrl: "http://example.com/result" }), false);
    assert.equal(hasUnsafeEvidenceUrl({ blockUrl: "https://issues.example.com/42" }), false);
  });

  it("returns true for file:// URLs", () => {
    assert.equal(hasUnsafeEvidenceUrl({ prUrl: "file:///tmp/secret" }), true);
    assert.equal(hasUnsafeEvidenceUrl({ doneUrl: "file:///var/log/output" }), true);
  });

  it("returns true for relative paths", () => {
    assert.equal(hasUnsafeEvidenceUrl({ blockUrl: "../relative/path" }), true);
  });

  it("returns true for data: URIs", () => {
    assert.equal(hasUnsafeEvidenceUrl({ prUrl: "data:text/plain;base64,SGVsbG8=" }), true);
  });

  it("checks all three evidence URL keys", () => {
    assert.equal(hasUnsafeEvidenceUrl({ prUrl: "https://safe.url", doneUrl: "file:///unsafe" }), true);
    assert.equal(hasUnsafeEvidenceUrl({ prUrl: "https://safe.url", doneUrl: "https://safe.url", blockUrl: "file:///unsafe" }), true);
  });

  it("ignores non-string values", () => {
    assert.equal(hasUnsafeEvidenceUrl({ prUrl: 42 } as any), false);
    assert.equal(hasUnsafeEvidenceUrl({ prUrl: "" }), false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("classifyOutboxRow — edge cases", () => {
  it("handles null payload gracefully", () => {
    const row: OutboxRowCandidate = { id: "null-payload-1", payload: null };
    const result = classifyOutboxRow(row, CUTOFF_MS);
    // Should be unclassifiable
    assert.equal(result.origin, "unclassifiable");
  });

  it("handles null receipt gracefully", () => {
    const row: OutboxRowCandidate = {
      id: "null-receipt-1",
      createdAt: AFTER_CUTOFF,
      receipt: null,
      payload: {
        taskBrief: "null receipt",
        prUrl: "https://example.com/pr/1",
        worker: "w",
      },
    };
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "current-window");
    assert.equal(result.signals.legacyReceiptStatus, false);
  });

  it("handles null ack gracefully", () => {
    const row: OutboxRowCandidate = {
      id: "null-ack-1",
      createdAt: AFTER_CUTOFF,
      receipt: { status: "accepted", updatedAt: AFTER_CUTOFF },
      ack: null,
      payload: {
        taskBrief: "null ack",
        prUrl: "https://example.com/pr/2",
        worker: "w",
      },
    };
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "current-window");
    assert.equal(result.signals.legacyAckEvidence, false);
    assert.equal(result.signals.receiptConfirmed, false);
  });

  it("handles invalid createdAt string gracefully", () => {
    const row = makeRow({ id: "bad-date-1", createdAt: "not-a-date" });
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.signals.preCutoff, null);
  });

  it("classifies row missing evidence and taskBrief but pre-cutoff as legacy-residue", () => {
    const row: OutboxRowCandidate = {
      id: "bare-pre-cutoff-1",
      createdAt: BEFORE_CUTOFF,
      receipt: { status: "accepted", updatedAt: BEFORE_CUTOFF },
      payload: { worker: "w" },
    };
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "legacy-residue");
    assert.equal(result.signals.preCutoff, true);
    assert.equal(result.signals.hasTaskBrief, false);
    assert.equal(result.signals.missingEvidence, true);
  });

  it("classifies post-cutoff row with evidence but no taskBrief as current-window", () => {
    const row: OutboxRowCandidate = {
      id: "current-no-brief-has-evidence",
      createdAt: AFTER_CUTOFF,
      receipt: { status: "accepted", updatedAt: AFTER_CUTOFF },
      payload: {
        prUrl: "https://github.com/test/repo/pull/10",
        worker: "w",
      },
    };
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "current-window");
    assert.equal(result.signals.missingEvidence, false);
    assert.equal(result.signals.hasTaskBrief, false);
  });

  it("classifies receipt-confirmed row with operator_visible evidence as current-window even without taskBrief", () => {
    const row: OutboxRowCandidate = {
      id: "ack-no-brief-1",
      createdAt: AFTER_CUTOFF,
      ack: { status: "receipt_confirmed", evidence: "operator_visible", acknowledgedAt: AFTER_CUTOFF },
      receipt: { status: "operator_visible", updatedAt: AFTER_CUTOFF },
      payload: { prUrl: "https://github.com/test/repo/pull/11", worker: "w" },
    };
    const result = classifyOutboxRow(row, CUTOFF_MS);
    assert.equal(result.origin, "current-window");
    assert.equal(result.signals.receiptConfirmed, true);
    assert.equal(result.signals.hasTaskBrief, false);
  });
});
