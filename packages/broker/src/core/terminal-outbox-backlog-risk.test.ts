/**
 * Tests for terminal-outbox backlog risk analyzer (issues #540, #824).
 *
 * Reference: #540 Team1/workergamma stability gates for #497/#294;
 * #824 cleanup candidate actionability for cursor-derived outbox states.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  analyzeTerminalOutboxBacklogRisk,
  DEFAULT_TERMINAL_OUTBOX_BACKLOG_THRESHOLDS,
  type TerminalOutboxBacklogSnapshot,
} from "./terminal-outbox-backlog-risk.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySnapshot(): TerminalOutboxBacklogSnapshot {
  return { total: 0, acked: 0, unacked: 0, unackedRatio: 0, oldestUnackedAgeMs: null, oldestUnackedCreatedAt: null, warnings: [] };
}

function snapshot(overrides: Partial<TerminalOutboxBacklogSnapshot>): TerminalOutboxBacklogSnapshot {
  return { ...emptySnapshot(), ...overrides };
}

// ---------------------------------------------------------------------------
// Empty outbox
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — empty outbox", () => {
  it("returns none risk for an empty outbox", () => {
    const result = analyzeTerminalOutboxBacklogRisk(emptySnapshot());
    assert.strictEqual(result.risk, "none");
    assert.strictEqual(result.stabilityGatePass, true);
    assert.strictEqual(result.signals.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Healthy outbox
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — healthy outbox", () => {
  it("returns none risk when everything is acked", () => {
    const s = snapshot({ total: 50, acked: 50, unacked: 0, unackedRatio: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "none");
    assert.strictEqual(result.stabilityGatePass, true);
    assert.strictEqual(result.signals.length, 0);
  });

  it("returns none risk for low unacked count below thresholds", () => {
    const s = snapshot({ total: 200, acked: 190, unacked: 10, unackedRatio: 0.05 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "none");
    assert.strictEqual(result.stabilityGatePass, true);
  });
});

// ---------------------------------------------------------------------------
// High unacked ratio
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — high unacked ratio", () => {
  it("flags high_unacked_ratio when unackedRatio > 0.5", () => {
    const s = snapshot({ total: 100, acked: 20, unacked: 80, unackedRatio: 0.8 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "high_unacked_ratio");
    assert.ok(signal, "should have high_unacked_ratio signal");
    assert.strictEqual(signal.severity, "warning");
    assert.strictEqual(result.risk, "low");
  });

  it("flags high_unacked_ratio as critical at >= 90%", () => {
    const s = snapshot({ total: 100, acked: 5, unacked: 95, unackedRatio: 0.95 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "high_unacked_ratio");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "critical");
    assert.strictEqual(result.risk, "high");
  });

  it("respects custom unacked ratio threshold", () => {
    const s = snapshot({ total: 100, acked: 70, unacked: 30, unackedRatio: 0.3 });
    const result = analyzeTerminalOutboxBacklogRisk(s, { maxUnackedRatioWarning: 0.25 });
    const signal = result.signals.find((sig) => sig.kind === "high_unacked_ratio");
    assert.ok(signal, "should flag with custom lower threshold");
  });
});

// ---------------------------------------------------------------------------
// Unacked accumulation
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — unacked accumulation", () => {
  it("flags unacked_accumulation at warning level", () => {
    const s = snapshot({ total: 300, acked: 100, unacked: 200, unackedRatio: 0.67 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "unacked_accumulation");
    assert.ok(signal, "should have unacked_accumulation signal");
    assert.strictEqual(signal.severity, "warning");
  });

  it("flags unacked_accumulation at critical level above 500", () => {
    const s = snapshot({ total: 600, acked: 50, unacked: 550, unackedRatio: 0.92 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "unacked_accumulation");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "critical");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("uses custom unacked count thresholds", () => {
    const s = snapshot({ total: 50, acked: 0, unacked: 50, unackedRatio: 1.0 });
    const result = analyzeTerminalOutboxBacklogRisk(s, { maxUnackedCountWarning: 40, maxUnackedCountCritical: 200 });
    const signal = result.signals.find((sig) => sig.kind === "unacked_accumulation");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "warning");
  });

  it("does not flag when below both ratio and count thresholds", () => {
    const s = snapshot({ total: 10, acked: 9, unacked: 1, unackedRatio: 0.1 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Stale unacked entries
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — stale unacked entries", () => {
  it("flags stale_unacked_entry at warning level (>7 days)", () => {
    const s = snapshot({
      total: 100, acked: 90, unacked: 10, unackedRatio: 0.1,
      oldestUnackedAgeMs: 8 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-05-01T00:00:00.000Z",
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "stale_unacked_entry");
    assert.ok(signal, "should have stale_unacked_entry signal");
    assert.strictEqual(signal.severity, "warning");
  });

  it("flags stale_unacked_entry at critical level (>30 days)", () => {
    const s = snapshot({
      total: 100, acked: 80, unacked: 20, unackedRatio: 0.2,
      oldestUnackedAgeMs: 31 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-04-01T00:00:00.000Z",
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "stale_unacked_entry");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "critical");
  });

  it("skips stale check when oldestUnackedAgeMs is null", () => {
    const s = snapshot({ total: 10, acked: 5, unacked: 5, unackedRatio: 0.5 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "stale_unacked_entry");
    assert.strictEqual(signal, undefined);
  });

  it("respects custom age thresholds", () => {
    const s = snapshot({
      total: 50, acked: 49, unacked: 1, unackedRatio: 0.02,
      oldestUnackedAgeMs: 3 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-05-08T00:00:00.000Z",
    });
    const result = analyzeTerminalOutboxBacklogRisk(s, { maxUnackedAgeMsWarning: 2 * 24 * 60 * 60 * 1000 });
    assert.ok(result.signals.find((sig) => sig.kind === "stale_unacked_entry"));
  });
});

// ---------------------------------------------------------------------------
// Provider send-only stall
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — provider send-only stall", () => {
  it("flags provider_send_only_stall when provider-sent entries are unacked", () => {
    const s = snapshot({ total: 100, acked: 80, unacked: 20, unackedRatio: 0.2, providerSendOnlyUnacked: 5 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "provider_send_only_stall");
    assert.ok(signal, "should flag provider-sent/accepted entries without operator visibility");
    assert.strictEqual(signal.severity, "warning");
  });

  it("does not flag when providerSendOnlyUnacked is zero", () => {
    const s = snapshot({ total: 100, acked: 80, unacked: 20, unackedRatio: 0.2, providerSendOnlyUnacked: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "provider_send_only_stall"), undefined);
  });

  it("does not flag when providerSendOnlyUnacked is undefined", () => {
    const s = snapshot({ total: 100, acked: 80, unacked: 20, unackedRatio: 0.2 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "provider_send_only_stall"), undefined);
  });
});

// ---------------------------------------------------------------------------
// ACK-eligible stall
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — ACK-eligible stall", () => {
  it("flags ack_eligible_stall as info when eligible events are unconfirmed", () => {
    const s = snapshot({ total: 50, acked: 30, unacked: 20, unackedRatio: 0.4, ackEligibleUnacked: 5 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "ack_eligible_stall");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "info");
  });

  it("does not flag ack_eligible_stall at zero", () => {
    const s = snapshot({ total: 50, acked: 30, unacked: 20, unackedRatio: 0.4, ackEligibleUnacked: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "ack_eligible_stall"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Replay-eligible pending stall
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — replay-eligible pending stall", () => {
  it("flags replay_eligible_pending_stall as info when small count exists", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5, replayEligiblePending: 15 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "replay_eligible_pending_stall");
    assert.ok(signal, "should flag replay-eligible pending rows");
    assert.strictEqual(signal.severity, "info");
  });

  it("flags replay_eligible_pending_stall as warning above 100", () => {
    const s = snapshot({ total: 500, acked: 200, unacked: 300, unackedRatio: 0.6, replayEligiblePending: 150 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "replay_eligible_pending_stall");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "warning");
  });

  it("does not flag when replayEligiblePending is undefined", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "replay_eligible_pending_stall"), undefined);
  });

  it("does not flag when replayEligiblePending is zero", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5, replayEligiblePending: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "replay_eligible_pending_stall"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Cursor-skipped unacked blindspot
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — cursor-skipped unacked blindspot", () => {
  it("flags cursor_skipped_unacked_blindspot when cursor-skipped rows are unacked", () => {
    const s = snapshot({ total: 100, acked: 60, unacked: 40, unackedRatio: 0.4, cursorSkippedUnacked: 8 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "cursor_skipped_unacked_blindspot");
    assert.ok(signal, "should flag cursor-skipped unacked blindspot");
    assert.strictEqual(signal.severity, "warning");
  });

  it("flags cursor_skipped_unacked_blindspot as critical at >= 50 skipped rows", () => {
    const s = snapshot({ total: 200, acked: 100, unacked: 100, unackedRatio: 0.5, cursorSkippedUnacked: 50 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "cursor_skipped_unacked_blindspot");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "critical");
  });

  it("does not flag when cursorSkippedUnacked is zero", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5, cursorSkippedUnacked: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "cursor_skipped_unacked_blindspot"), undefined);
  });

  it("does not flag when cursorSkippedUnacked is undefined", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "cursor_skipped_unacked_blindspot"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Cursor-unknown unacked blindspot
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — cursor-unknown unacked blindspot", () => {
  it("flags cursor_unknown_unacked_blindspot as info for small unknown count", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5, cursorUnknownUnacked: 10 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "cursor_unknown_unacked_blindspot");
    assert.ok(signal, "should flag cursor-unknown unacked blindspot");
    assert.strictEqual(signal.severity, "info");
  });

  it("flags cursor_unknown_unacked_blindspot as warning at >= 100 unknown rows", () => {
    const s = snapshot({ total: 300, acked: 100, unacked: 200, unackedRatio: 0.67, cursorUnknownUnacked: 100 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "cursor_unknown_unacked_blindspot");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "warning");
  });

  it("does not flag when cursorUnknownUnacked is zero", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5, cursorUnknownUnacked: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "cursor_unknown_unacked_blindspot"), undefined);
  });

  it("does not flag when cursorUnknownUnacked is undefined", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "cursor_unknown_unacked_blindspot"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Stale receipt blindspot
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — stale receipt blindspot", () => {
  it("flags stale_receipt_blindspot for unacked stale-receipt entries", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5, staleReceiptUnacked: 12 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "stale_receipt_blindspot");
    assert.ok(signal, "should flag stale-receipt unacked blindspot");
    assert.strictEqual(signal.severity, "warning");
  });

  it("does not flag when staleReceiptUnacked is zero", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5, staleReceiptUnacked: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "stale_receipt_blindspot"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Risk level and stability gate
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — risk levels", () => {
  it("returns critical when two critical signals are present", () => {
    const s = snapshot({
      total: 600, acked: 50, unacked: 550, unackedRatio: 0.92,
      oldestUnackedAgeMs: 31 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-04-01T00:00:00.000Z",
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "critical");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("returns high with one critical signal", () => {
    const s = snapshot({
      total: 100, acked: 5, unacked: 95, unackedRatio: 0.95,
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "high");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("returns medium with two warning signals", () => {
    const s = snapshot({
      total: 150, acked: 50, unacked: 100, unackedRatio: 0.67,
      oldestUnackedAgeMs: 8 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-05-01T00:00:00.000Z",
      providerSendOnlyUnacked: 20,
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "medium");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("returns low with one warning signal", () => {
    const s = snapshot({ total: 100, acked: 20, unacked: 80, unackedRatio: 0.8 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "low");
    assert.strictEqual(result.stabilityGatePass, true);
  });

  it("returns none with no signals", () => {
    const s = snapshot({ total: 50, acked: 50, unacked: 0, unackedRatio: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "none");
    assert.strictEqual(result.stabilityGatePass, true);
  });
});

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — recommendations", () => {
  it("provides operator recommendation on critical stale entry", () => {
    const s = snapshot({
      total: 600, acked: 50, unacked: 550, unackedRatio: 0.92,
      oldestUnackedAgeMs: 31 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-04-01T00:00:00.000Z",
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.ok(result.recommendation, "should provide recommendation");
  });

  it("provides recommendation for provider send-only stall", () => {
    const s = snapshot({ total: 50, acked: 20, unacked: 30, unackedRatio: 0.6, providerSendOnlyUnacked: 20 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.ok(result.recommendation);
  });

  it("provides cursor-skipped critical recommendation when >= 50 cursor-skipped unacked", () => {
    const s = snapshot({ total: 200, acked: 50, unacked: 150, unackedRatio: 0.75, cursorSkippedUnacked: 75 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.ok(result.recommendation, "should provide cursor-skipped recommendation");
    assert.ok(result.recommendation.includes("cursor-skipped/suppressed"), "recommendation should mention cursor-skipped");
  });

  it("provides cursor-unknown recommendation when cursor state unknown", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5, cursorUnknownUnacked: 25 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.ok(result.recommendation, "should provide cursor-unknown recommendation");
    assert.ok(result.recommendation.includes("cursor-unknown") || result.recommendation.includes("cursor evidence"), "recommendation should mention cursor ambiguity");
  });

  it("returns undefined recommendation for healthy outbox", () => {
    const s = snapshot({ total: 50, acked: 50, unacked: 0, unackedRatio: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.recommendation, undefined);
  });
});

// ---------------------------------------------------------------------------
// Cursor classification regression — combined scenarios
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — cursor classification regression", () => {
  it("distinguishes replay-eligible pending from cursor-skipped unacked in same snapshot", () => {
    // Snapshot has rows in all three cursor buckets
    const s = snapshot({
      total: 200, acked: 50, unacked: 150, unackedRatio: 0.75,
      replayEligiblePending: 80,
      cursorSkippedUnacked: 40,
      cursorUnknownUnacked: 30,
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const replaySig = result.signals.find((sig) => sig.kind === "replay_eligible_pending_stall");
    const skipSig = result.signals.find((sig) => sig.kind === "cursor_skipped_unacked_blindspot");
    const unknownSig = result.signals.find((sig) => sig.kind === "cursor_unknown_unacked_blindspot");
    assert.ok(replaySig, "should distinguish replay-eligible pending rows");
    assert.ok(skipSig, "should distinguish cursor-skipped rows");
    assert.ok(unknownSig, "should distinguish cursor-unknown rows");
    assert.strictEqual(replaySig.severity, "info", "80 replay-eligible pending is info-level");
    assert.strictEqual(skipSig.severity, "warning", "40 cursor-skipped is warning-level");
    assert.strictEqual(unknownSig.severity, "info", "30 cursor-unknown is info-level");
  });

  it("does not flag cursor-skipped/cursor-unknown when caller has no cursor evidence", () => {
    // Caller does not supply any cursor-derived fields — broker cannot assume
    const s = snapshot({ total: 100, acked: 10, unacked: 90, unackedRatio: 0.9 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "replay_eligible_pending_stall"), undefined);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "cursor_skipped_unacked_blindspot"), undefined);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "cursor_unknown_unacked_blindspot"), undefined);
    // But existing signals like high_unacked_ratio should still fire
    const ratioSig = result.signals.find((sig) => sig.kind === "high_unacked_ratio");
    assert.ok(ratioSig, "existing unacked ratio signal should still fire without cursor evidence");
  });

  it("flags cursor-skipped critical + other signals for combined high risk", () => {
    const s = snapshot({
      total: 500, acked: 50, unacked: 450, unackedRatio: 0.9,
      cursorSkippedUnacked: 120,
      oldestUnackedAgeMs: 7 * 24 * 60 * 60 * 1000 + 1, // just over warning threshold
      oldestUnackedCreatedAt: "2026-05-01T00:00:00.000Z",
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const skipSig = result.signals.find((sig) => sig.kind === "cursor_skipped_unacked_blindspot");
    assert.ok(skipSig);
    assert.strictEqual(skipSig.severity, "critical");
    // Multiple critical signals should drive risk level up
    assert.strictEqual(result.risk, "critical", "combined critical signals should be critical risk");
    assert.strictEqual(result.stabilityGatePass, false);
    assert.ok(result.recommendation, "should provide recommendation for combined critical signals");
  });

  it("does not double-count cursor classification fields against unacked total", () => {
    // replayEligiblePending + cursorSkippedUnacked + cursorUnknownUnacked
    // may equal unacked or be a subset — analyzer should not assume.
    // Test: all three add to unacked exactly, and existing signals are orthogonal.
    const s = snapshot({
      total: 100, acked: 0, unacked: 100, unackedRatio: 1.0,
      replayEligiblePending: 40,
      cursorSkippedUnacked: 35,
      cursorUnknownUnacked: 25,
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const replaySig = result.signals.find((sig) => sig.kind === "replay_eligible_pending_stall");
    const skipSig = result.signals.find((sig) => sig.kind === "cursor_skipped_unacked_blindspot");
    const unknownSig = result.signals.find((sig) => sig.kind === "cursor_unknown_unacked_blindspot");
    assert.ok(replaySig, "should flag replay-eligible pending");
    assert.ok(skipSig, "should flag cursor-skipped");
    assert.ok(unknownSig, "should flag cursor-unknown");
    // All classifications fire orthogonally, not double-counting unacked
    const distinctKinds = new Set(result.signals.map((sig) => sig.kind));
    assert.ok(distinctKinds.has("replay_eligible_pending_stall"));
    assert.ok(distinctKinds.has("cursor_skipped_unacked_blindspot"));
    assert.ok(distinctKinds.has("cursor_unknown_unacked_blindspot"));
  });
});

// ---------------------------------------------------------------------------
// Threshold defaults
// ---------------------------------------------------------------------------

describe("DEFAULT_TERMINAL_OUTBOX_BACKLOG_THRESHOLDS", () => {
  it("has consistent defaults", () => {
    const t = DEFAULT_TERMINAL_OUTBOX_BACKLOG_THRESHOLDS;
    assert.ok(t.maxUnackedRatioWarning > 0 && t.maxUnackedRatioWarning < 1, "ratio in (0,1)");
    assert.ok(t.maxUnackedCountWarning > 0);
    assert.ok(t.maxUnackedCountCritical > t.maxUnackedCountWarning);
    assert.ok(t.maxUnackedAgeMsCritical > t.maxUnackedAgeMsWarning);
  });
});
