/**
 * Tests for broker tracker close/supersede recommendations (#863–#866).
 *
 * Covers deterministic mapping from OutboxLegacyResidueReport to
 * TrackerCloseoutRecommendation verdicts under healthy, edge, and
 * degraded classifier-report conditions.
 *
 * Reference: #896 Team1/Bangtong Terminal Brief completion lane 1/7.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTrackerCloseoutRecommendations,
  KNOWN_TRACKERS,
  type OutboxTrackerCloseoutMap,
} from "./terminal-outbox-tracker-recommendations.js";
import type {
  OutboxLegacyResidueReport,
  OutboxRowClassification,
} from "./terminal-outbox-legacy-classifier.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const CUTOFF_MS = Date.parse("2026-05-04T07:10:00.000Z");
const AFTER_CUTOFF = "2026-05-06T00:00:00.000Z";
const BEFORE_CUTOFF = "2026-05-02T00:00:00.000Z";

function healthyCurrentWindowClassification(
  id: string,
  overrides: Partial<OutboxRowClassification["signals"]> = {},
): OutboxRowClassification {
  return {
    id,
    origin: "current-window",
    signals: {
      preCutoff: false,
      hasTaskBrief: true,
      missingEvidence: false,
      legacyReceiptStatus: false,
      legacyAckEvidence: false,
      receiptConfirmed: false,
      ...overrides,
    },
    reason: "current window: post-cutoff, has taskBrief, has evidence",
  };
}

function legacyPreCutoffClassification(id: string): OutboxRowClassification {
  return {
    id,
    origin: "legacy-residue",
    signals: {
      preCutoff: true,
      hasTaskBrief: false,
      missingEvidence: true,
      legacyReceiptStatus: false,
      legacyAckEvidence: false,
      receiptConfirmed: false,
    },
    reason: "legacy residue: pre-cutoff, missing taskBrief, missing evidence",
  };
}

function legacyVocabClassification(id: string): OutboxRowClassification {
  return {
    id,
    origin: "current-window",
    signals: {
      preCutoff: false,
      hasTaskBrief: true,
      missingEvidence: false,
      legacyReceiptStatus: true,
      legacyAckEvidence: false,
      receiptConfirmed: false,
    },
    reason: "current window: post-cutoff, has taskBrief, has evidence, legacy receipt status",
  };
}

/**
 * Build a healthy report resembling a broker that has processed live all-hands
 * canary rounds and has a few legacy rows from prior protocol versions.
 */
function healthyReport(): OutboxLegacyResidueReport {
  return {
    total: 5,
    currentWindow: 3,
    legacyResidue: 2,
    unclassifiable: 0,
    classifications: [
      healthyCurrentWindowClassification("task-001"),
      healthyCurrentWindowClassification("task-002"),
      healthyCurrentWindowClassification("task-003"),
      legacyPreCutoffClassification("legacy-001"),
      legacyPreCutoffClassification("legacy-002"),
    ],
    currentWindowBlockers: {
      missingEvidenceIds: [],
      missingWorkerIds: [],
      missingTaskBriefIds: [],
      unsafeEvidenceIds: [],
    },
    legacyResidueSummary: [
      { id: "legacy-001", reason: "legacy residue: pre-cutoff, missing taskBrief, missing evidence" },
      { id: "legacy-002", reason: "legacy residue: pre-cutoff, missing taskBrief, missing evidence" },
    ],
  };
}

/**
 * Build a degraded report with current-window rows that have legacy vocabulary
 * and missing evidence.
 */
function degradedReport(): OutboxLegacyResidueReport {
  return {
    total: 4,
    currentWindow: 3,
    legacyResidue: 0,
    unclassifiable: 1,
    classifications: [
      healthyCurrentWindowClassification("task-001", { legacyReceiptStatus: true, legacyAckEvidence: false }),
      healthyCurrentWindowClassification("task-002", { missingEvidence: true }),
      legacyVocabClassification("task-003"),
      { id: "unclass-001", origin: "unclassifiable", signals: { preCutoff: null, hasTaskBrief: false, missingEvidence: true, legacyReceiptStatus: false, legacyAckEvidence: false, receiptConfirmed: false }, reason: "insufficient data" },
    ],
    currentWindowBlockers: {
      missingEvidenceIds: ["task-002"],
      missingWorkerIds: [],
      missingTaskBriefIds: [],
      unsafeEvidenceIds: [],
    },
    legacyResidueSummary: [],
  };
}

/**
 * Build a report with unsafe evidence URLs.
 */
function unsafeEvidenceReport(): OutboxLegacyResidueReport {
  return {
    total: 2,
    currentWindow: 2,
    legacyResidue: 0,
    unclassifiable: 0,
    classifications: [
      healthyCurrentWindowClassification("task-001", { missingEvidence: true }),
      healthyCurrentWindowClassification("task-002"),
    ],
    currentWindowBlockers: {
      missingEvidenceIds: ["task-001"],
      missingWorkerIds: [],
      missingTaskBriefIds: [],
      unsafeEvidenceIds: ["task-001"],
    },
    legacyResidueSummary: [],
  };
}

/**
 * Build an empty report.
 */
function emptyReport(): OutboxLegacyResidueReport {
  return {
    total: 0,
    currentWindow: 0,
    legacyResidue: 0,
    unclassifiable: 0,
    classifications: [],
    currentWindowBlockers: {
      missingEvidenceIds: [],
      missingWorkerIds: [],
      missingTaskBriefIds: [],
      unsafeEvidenceIds: [],
    },
    legacyResidueSummary: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("evaluateTrackerCloseoutRecommendations", () => {
  it("recommends close for all four trackers on a healthy report", () => {
    const map = evaluateTrackerCloseoutRecommendations(healthyReport());
    assert.equal(map.kind, "a2a-broker.outbox-tracker-closeout-map");
    assert.equal(map.version, 1);
    assert.equal(map.recommendations.length, 4);
    assert.equal(map.summary.totalTrackers, 4);
    assert.equal(map.summary.recommendClose, 4);
    assert.equal(map.summary.recommendSupersede, 0);
    assert.equal(map.summary.recommendReview, 0);
  });

  it("links each recommendation to the correct tracker ID and URL", () => {
    const map = evaluateTrackerCloseoutRecommendations(healthyReport());
    for (let i = 0; i < KNOWN_TRACKERS.length; i++) {
      const rec = map.recommendations[i]!;
      const known = KNOWN_TRACKERS[i]!;
      assert.equal(rec.trackerId, known.id, `trackerId mismatch for ${known.id}`);
      assert.equal(rec.trackerUrl, known.url, `trackerUrl mismatch for ${known.id}`);
    }
  });

  it("recommends close for #863 when current-window rows have no legacy vocab", () => {
    const map = evaluateTrackerCloseoutRecommendations(healthyReport());
    const r863 = map.recommendations.find((r) => r.trackerId === "#863")!;
    assert.equal(r863.recommendation, "close");
    assert.equal(r863.confidence, "high");
    assert.match(r863.rationale, /legacy/i);
  });

  it("recommends supersede for #863 when current-window rows use legacy vocab", () => {
    const map = evaluateTrackerCloseoutRecommendations(degradedReport());
    const r863 = map.recommendations.find((r) => r.trackerId === "#863")!;
    assert.equal(r863.recommendation, "supersede");
    assert.equal(r863.confidence, "medium");
    assert.ok(r863.supersedeAction);
    assert.match(r863.supersedeAction!, /re-drive|re-drive/i);
  });

  it("recommends close for #864 (bangtong harness) unconditionally when classifier exists", () => {
    const map = evaluateTrackerCloseoutRecommendations(healthyReport());
    const r864 = map.recommendations.find((r) => r.trackerId === "#864")!;
    assert.equal(r864.recommendation, "close");
    assert.equal(r864.confidence, "high");
    assert.match(r864.rationale, /classifier/);
  });

  it("recommends close for #864 even on degraded or empty report", () => {
    const degraded = evaluateTrackerCloseoutRecommendations(degradedReport());
    const empty = evaluateTrackerCloseoutRecommendations(emptyReport());
    assert.equal(degraded.recommendations.find((r) => r.trackerId === "#864")!.recommendation, "close");
    assert.equal(empty.recommendations.find((r) => r.trackerId === "#864")!.recommendation, "close");
  });

  it("recommends close for #865 (libero) when no unsafe evidence URLs", () => {
    const map = evaluateTrackerCloseoutRecommendations(healthyReport());
    const r865 = map.recommendations.find((r) => r.trackerId === "#865")!;
    assert.equal(r865.recommendation, "close");
    assert.equal(r865.confidence, "high");
    assert.match(r865.rationale, /safe/);
  });

  it("recommends supersede for #865 when unsafe evidence URLs exist", () => {
    const map = evaluateTrackerCloseoutRecommendations(unsafeEvidenceReport());
    const r865 = map.recommendations.find((r) => r.trackerId === "#865")!;
    assert.equal(r865.recommendation, "supersede");
    assert.equal(r865.confidence, "high");
    assert.ok(r865.supersedeAction);
    assert.match(r865.supersedeAction!, /unsafe/);
  });

  it("recommends close for #866 (cross-broker dedupe) unconditionally when ingest idempotency is verified", () => {
    const map = evaluateTrackerCloseoutRecommendations(healthyReport());
    const r866 = map.recommendations.find((r) => r.trackerId === "#866")!;
    assert.equal(r866.recommendation, "close");
    assert.equal(r866.confidence, "high");
    assert.match(r866.rationale, /idempotent/);
  });

  it("recommends close for #866 even on degraded or empty report", () => {
    const degraded = evaluateTrackerCloseoutRecommendations(degradedReport());
    const empty = evaluateTrackerCloseoutRecommendations(emptyReport());
    assert.equal(degraded.recommendations.find((r) => r.trackerId === "#866")!.recommendation, "close");
    assert.equal(empty.recommendations.find((r) => r.trackerId === "#866")!.recommendation, "close");
  });

  it("handles empty report without crashing", () => {
    const map = evaluateTrackerCloseoutRecommendations(emptyReport());
    assert.equal(map.kind, "a2a-broker.outbox-tracker-closeout-map");
    assert.equal(map.reportRef, "empty-report");
    assert.equal(map.recommendations.length, 4);
    assert.equal(map.summary.recommendClose, 4);
  });

  it("generates ISO-8601 timestamp in generatedAt", () => {
    const map = evaluateTrackerCloseoutRecommendations(healthyReport(), {
      now: "2026-05-23T02:10:00.000Z",
    });
    assert.equal(map.generatedAt, "2026-05-23T02:10:00.000Z");
  });

  it("recommendations have non-empty rationale and conditionSummary", () => {
    const map = evaluateTrackerCloseoutRecommendations(healthyReport());
    for (const rec of map.recommendations) {
      assert.ok(rec.rationale.length > 0, `${rec.trackerId} rationale is empty`);
      assert.ok(rec.conditionSummary.length > 0, `${rec.trackerId} conditionSummary is empty`);
    }
  });

  it("supersede recommendations have a supersedeAction", () => {
    const map = evaluateTrackerCloseoutRecommendations(degradedReport());
    const superseded = map.recommendations.filter((r) => r.recommendation === "supersede");
    for (const rec of superseded) {
      assert.ok(rec.supersedeAction, `${rec.trackerId} missing supersedeAction`);
    }
  });

  it("KNOWN_TRACKERS has exactly 4 entries", () => {
    assert.equal(KNOWN_TRACKERS.length, 4);
    assert.equal(KNOWN_TRACKERS[0]!.id, "#863");
    assert.equal(KNOWN_TRACKERS[1]!.id, "#864");
    assert.equal(KNOWN_TRACKERS[2]!.id, "#865");
    assert.equal(KNOWN_TRACKERS[3]!.id, "#866");
  });

  it("tracker URLs point to jinwon-int/a2a-broker", () => {
    for (const t of KNOWN_TRACKERS) {
      assert.ok(t.url.startsWith("https://github.com/jinwon-int/a2a-broker/issues/"),
        `${t.id} URL unexpected: ${t.url}`);
    }
  });
});
