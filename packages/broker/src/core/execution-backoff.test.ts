import { describe, it } from "node:test";

import { expect } from "../test-helpers/expect.js";

import {
  computeBaseDelay,
  computeDeterministicJitter,
  computeBackoffDelay,
  buildBackoffSchedule,
  normalizeBackoffConfig,
  getBackoffEntry,
  serializeBackoffSchedule,
  DEFAULT_BACKOFF_CONFIG,
  PHASE_BACKOFF_CONFIGS,
  type BackoffConfig,
  type BackoffSchedule,
} from "./execution-backoff.js";

// ---------------------------------------------------------------------------
// normalizeBackoffConfig
// ---------------------------------------------------------------------------

describe("normalizeBackoffConfig", () => {
  it("fills defaults when given empty config", () => {
    const c = normalizeBackoffConfig({});
    expect(c.strategy).toBe("exponential");
    expect(c.baseMs).toBe(1_000);
    expect(c.maxMs).toBe(300_000);
    expect(c.jitterMs).toBe(0);
    expect(c.multiplier).toBe(2);
  });

  it("fills defaults when given undefined", () => {
    const c = normalizeBackoffConfig();
    expect(c.baseMs).toBe(1_000);
    expect(c.strategy).toBe("exponential");
  });

  it("preserves explicit values", () => {
    const c = normalizeBackoffConfig({ baseMs: 500, strategy: "linear", jitterMs: 100 });
    expect(c.baseMs).toBe(500);
    expect(c.strategy).toBe("linear");
    expect(c.jitterMs).toBe(100);
    expect(c.maxMs).toBe(300_000); // default
  });

  it("clamps baseMs to minimum 1", () => {
    const c = normalizeBackoffConfig({ baseMs: 0 });
    expect(c.baseMs).toBe(1);
  });

  it("clamps jitterMs to minimum 0", () => {
    const c = normalizeBackoffConfig({ jitterMs: -5 });
    expect(c.jitterMs).toBe(0);
  });

  it("clamps multiplier to minimum 1", () => {
    const c = normalizeBackoffConfig({ multiplier: 0 });
    expect(c.multiplier).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeBaseDelay
// ---------------------------------------------------------------------------

describe("computeBaseDelay", () => {
  it("returns baseMs for attempt 1 (exponential)", () => {
    expect(computeBaseDelay(1)).toBe(1_000);
  });

  it("doubles each attempt (exponential, multiplier=2)", () => {
    expect(computeBaseDelay(1, { baseMs: 100 })).toBe(100);
    expect(computeBaseDelay(2, { baseMs: 100 })).toBe(200);
    expect(computeBaseDelay(3, { baseMs: 100 })).toBe(400);
    expect(computeBaseDelay(4, { baseMs: 100 })).toBe(800);
  });

  it("caps at maxMs", () => {
    const delay = computeBaseDelay(10, { baseMs: 100, maxMs: 500 });
    expect(delay).toBe(500); // 100*2^9 = 51200, capped at 500
  });

  it("linear strategy: baseMs + (n-1)*multiplier*baseMs", () => {
    const delay1 = computeBaseDelay(1, { strategy: "linear", baseMs: 100, multiplier: 2 });
    expect(delay1).toBe(100); // 100 + 0
    const delay2 = computeBaseDelay(2, { strategy: "linear", baseMs: 100, multiplier: 2 });
    expect(delay2).toBe(300); // 100 + 1*2*100
    const delay3 = computeBaseDelay(3, { strategy: "linear", baseMs: 100, multiplier: 3 });
    expect(delay3).toBe(700); // 100 + 2*3*100
  });

  it("fixed strategy returns baseMs", () => {
    expect(computeBaseDelay(1, { strategy: "fixed", baseMs: 5000 })).toBe(5000);
    expect(computeBaseDelay(5, { strategy: "fixed", baseMs: 5000 })).toBe(5000);
  });

  it("caps linear delay at maxMs", () => {
    const delay = computeBaseDelay(100, {
      strategy: "linear",
      baseMs: 1000,
      maxMs: 5000,
    });
    expect(delay).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// computeDeterministicJitter
// ---------------------------------------------------------------------------

describe("computeDeterministicJitter", () => {
  it("returns 0 when maxJitterMs is 0", () => {
    expect(computeDeterministicJitter(1, "seed", 0)).toBe(0);
  });

  it("returns a value in [0, maxJitterMs]", () => {
    const max = 1000;
    const jitter = computeDeterministicJitter(1, "test-seed", max);
    expect(jitter >= 0).toBe(true);
    expect(jitter <= max).toBe(true);
  });

  it("is deterministic: same inputs → same output", () => {
    const a = computeDeterministicJitter(3, "stable", 500);
    const b = computeDeterministicJitter(3, "stable", 500);
    expect(a).toBe(b);
  });

  it("produces different values for different seeds", () => {
    const a = computeDeterministicJitter(1, "seed-a", 1000);
    const b = computeDeterministicJitter(1, "seed-b", 1000);
    // Extremely unlikely to collide
    expect(a === b).toBe(false);
  });

  it("is insensitive to attempt numbers below 1", () => {
    const zeroJitter = computeDeterministicJitter(0, "test", 500);
    const oneJitter = computeDeterministicJitter(1, "test", 500);
    expect(zeroJitter).toBe(oneJitter);
  });
});

// ---------------------------------------------------------------------------
// computeBackoffDelay
// ---------------------------------------------------------------------------

describe("computeBackoffDelay", () => {
  it("returns base, jitter, and total", () => {
    const result = computeBackoffDelay(1, { baseMs: 100, jitterMs: 0 });
    expect(result.baseDelayMs).toBe(100);
    expect(result.jitterMs).toBe(0);
    expect(result.totalDelayMs).toBe(100);
  });

  it("includes jitter when configured", () => {
    const result = computeBackoffDelay(2, { baseMs: 100, jitterMs: 100, seed: "test" });
    expect(result.baseDelayMs).toBe(200);
    expect(result.jitterMs).toBeGreaterThan(0);
    expect(result.totalDelayMs).toBe(result.baseDelayMs + result.jitterMs);
  });
});

// ---------------------------------------------------------------------------
// buildBackoffSchedule
// ---------------------------------------------------------------------------

describe("buildBackoffSchedule", () => {
  it("produces entries for each attempt", () => {
    const schedule = buildBackoffSchedule(3, { baseMs: 100 });
    expect(schedule.entries).toHaveLength(3);
    expect(schedule.entries[0].attempt).toBe(1);
    expect(schedule.entries[1].attempt).toBe(2);
    expect(schedule.entries[2].attempt).toBe(3);
  });

  it("computes cumulative delay", () => {
    const schedule = buildBackoffSchedule(2, { baseMs: 1000, jitterMs: 0 });
    expect(schedule.entries[0].cumulativeDelayMs).toBe(1000);
    expect(schedule.entries[1].cumulativeDelayMs).toBe(1000 + 2000);
    expect(schedule.totalCumulativeMs).toBe(3000);
  });

  it("handles maxAttempts of 1", () => {
    const schedule = buildBackoffSchedule(1);
    expect(schedule.entries).toHaveLength(1);
    expect(schedule.totalCumulativeMs).toBe(schedule.entries[0].totalDelayMs);
  });

  it("creates entries with monotonically increasing delays (exponential)", () => {
    const schedule = buildBackoffSchedule(5, { baseMs: 100, maxMs: 10_000 });
    for (let i = 1; i < schedule.entries.length; i++) {
      expect(schedule.entries[i].baseDelayMs >= schedule.entries[i - 1].baseDelayMs).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// getBackoffEntry
// ---------------------------------------------------------------------------

describe("getBackoffEntry", () => {
  it("returns entry for retryCount within schedule", () => {
    const schedule = buildBackoffSchedule(5);
    const entry = getBackoffEntry(0, schedule);
    expect(entry?.attempt).toBe(1);
    expect(getBackoffEntry(4, schedule)?.attempt).toBe(5);
  });

  it("clamps retryCount beyond schedule length", () => {
    const schedule = buildBackoffSchedule(3);
    const entry = getBackoffEntry(10, schedule);
    expect(entry?.attempt).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// serializeBackoffSchedule
// ---------------------------------------------------------------------------

describe("serializeBackoffSchedule", () => {
  it("produces serializable summary", () => {
    const schedule = buildBackoffSchedule(2, { baseMs: 100, jitterMs: 50, seed: "x" });
    const s = serializeBackoffSchedule(schedule);
    expect(s.strategy).toBe("exponential");
    expect(s.baseMs).toBe(100);
    expect(s.jitterMs).toBe(50);
    expect(s.entries).toBe(2);
    expect((s.entryDelays as Array<{ attempt: number; delayMs: number }>)).toHaveLength(2);
    expect(s.totalCumulativeMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PHASE_BACKOFF_CONFIGS
// ---------------------------------------------------------------------------

describe("PHASE_BACKOFF_CONFIGS", () => {
  it("queued uses shortest base and max", () => {
    expect(PHASE_BACKOFF_CONFIGS.queued.baseMs).toBe(2_000);
    expect(PHASE_BACKOFF_CONFIGS.queued.maxMs).toBe(60_000);
  });

  it("running uses the longest max", () => {
    expect(PHASE_BACKOFF_CONFIGS.running.maxMs).toBe(300_000);
    expect(PHASE_BACKOFF_CONFIGS.running.baseMs).toBe(10_000);
  });

  it("each phase has a distinct seed", () => {
    const seeds = new Set([
      PHASE_BACKOFF_CONFIGS.queued.seed,
      PHASE_BACKOFF_CONFIGS.claimed.seed,
      PHASE_BACKOFF_CONFIGS.running.seed,
    ]);
    expect(seeds.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Integration: deterministic across runs
// ---------------------------------------------------------------------------

describe("deterministic across calls", () => {
  it("computeBaseDelay produces same value given same inputs", () => {
    const a = computeBaseDelay(5, { baseMs: 200, multiplier: 3 });
    const b = computeBaseDelay(5, { baseMs: 200, multiplier: 3 });
    expect(a).toBe(b);
  });

  it("buildBackoffSchedule is consistent", () => {
    const a = buildBackoffSchedule(4, { baseMs: 500, jitterMs: 100, seed: "abc" });
    const b = buildBackoffSchedule(4, { baseMs: 500, jitterMs: 100, seed: "abc" });
    expect(a.entries.map((e) => e.totalDelayMs)).toEqual(
      b.entries.map((e) => e.totalDelayMs),
    );
  });
});
