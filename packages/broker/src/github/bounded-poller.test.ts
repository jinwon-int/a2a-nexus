/**
 * Tests for the BoundedPoller module.
 * Uses long poll intervals so timers never fire — we inspect the stat machinery
 * directly without waiting on real-time delays.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoundedPoller, type PollerFetchResult } from "./bounded-poller.js";

/** Placeholder ingestion service that just counts (never used when fetchEvents returns []). */
const NULL_SERVICE = null as never;

/** Helper: synchronous empty fetch result. */
function emptyResult(label = "poll-0"): PollerFetchResult {
  return {
    events: [],
    context: { deliveryId: label, receivedAt: new Date().toISOString() },
  };
}

// ---------------------------------------------------------------------------
// Bounded poller tests (synchronous — no real timer waits)
// ---------------------------------------------------------------------------

test("BoundedPoller initial stats reflect not started", () => {
  const poller = new BoundedPoller({
    ingestionService: NULL_SERVICE,
    fetchEvents: () => emptyResult(),
    pollIntervalMs: 100_000, // long — never fires
    label: "test-initial",
  });

  const stats = poller.getStats();
  assert.equal(stats.label, "test-initial");
  assert.equal(stats.running, false);
  assert.equal(stats.busy, false);
  assert.equal(stats.totalPolls, 0);
  assert.equal(stats.totalEventsFetched, 0);
  assert.equal(stats.totalEventsIngested, 0);
  assert.equal(stats.idleCycles, 0);
  assert.equal(stats.errorCycles, 0);
  assert.equal(stats.lastPollAt, null);
  assert.equal(stats.lastErrorAt, null);
  assert.equal(stats.lastErrorMessage, null);
  assert.ok(stats.currentBackoffMs >= 100_000);
});

test("BoundedPoller start/stop lifecycle", () => {
  const poller = new BoundedPoller({
    ingestionService: NULL_SERVICE,
    fetchEvents: () => emptyResult(),
    pollIntervalMs: 100_000,
    label: "test-lifecycle",
  });

  assert.equal(poller.running, false);
  assert.equal(poller.busy, false);

  poller.start();
  assert.equal(poller.running, true);
  assert.equal(poller.busy, false);

  poller.stop();
  assert.equal(poller.running, false);
  assert.equal(poller.busy, false);

  // Double stop is safe
  poller.stop();
  assert.equal(poller.running, false);
});

test("BoundedPoller double start is safe", () => {
  const poller = new BoundedPoller({
    ingestionService: NULL_SERVICE,
    fetchEvents: () => emptyResult(),
    pollIntervalMs: 100_000,
    label: "test-double-start",
  });

  poller.start();
  poller.start(); // no-op
  assert.equal(poller.running, true);
  poller.stop();
});

test("BoundedPoller defaults to sensible values", () => {
  const poller = new BoundedPoller({
    ingestionService: NULL_SERVICE,
    fetchEvents: () => emptyResult(),
  });

  // Defaults: 30s interval, 50 max events, 5s base backoff, 300s max backoff
  const stats = poller.getStats();
  assert.equal(stats.label, "github-bounded-poller");
});

test("BoundedPoller custom label appears in stats", () => {
  const poller = new BoundedPoller({
    ingestionService: NULL_SERVICE,
    fetchEvents: () => emptyResult(),
    pollIntervalMs: 100_000,
    label: "my-custom-poller",
  });

  assert.equal(poller.getStats().label, "my-custom-poller");
  poller.start();
  assert.equal(poller.getStats().label, "my-custom-poller");
  poller.stop();
});

test("BoundedPoller getStats returns running false after stop", () => {
  const poller = new BoundedPoller({
    ingestionService: NULL_SERVICE,
    fetchEvents: () => emptyResult(),
    pollIntervalMs: 100_000,
  });

  poller.start();
  assert.equal(poller.getStats().running, true);
  poller.stop();
  assert.equal(poller.getStats().running, false);
});

// ---------------------------------------------------------------------------
// Backoff floor / restart scheduling (a2a-nexus#573 item 19)
// ---------------------------------------------------------------------------

test("BoundedPoller backoff honors the baseBackoffMs floor and maxBackoffMs ceiling", async () => {
  const poller = new BoundedPoller({
    ingestionService: NULL_SERVICE,
    fetchEvents: () => {
      throw new Error("boom");
    },
    pollIntervalMs: 1_000,
    baseBackoffMs: 50_000,
    maxBackoffMs: 60_000,
    label: "test-backoff-floor",
  });
  const internals = poller as unknown as { _running: boolean; poll(): Promise<void> };

  // Drive cycles directly (no timers fire; interval far below the base floor).
  internals._running = true;
  await internals.poll();
  assert.equal(
    poller.getStats().currentBackoffMs,
    50_000,
    "first failed cycle must back off to at least baseBackoffMs",
  );

  await internals.poll();
  assert.equal(
    poller.getStats().currentBackoffMs,
    60_000,
    "doubling must stay capped at maxBackoffMs",
  );

  poller.stop();
});

test("BoundedPoller scheduleNext replaces a pending timer instead of stacking chains", async () => {
  const cleared: unknown[] = [];
  const origClear = globalThis.clearTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    cleared.push(handle);
    return origClear(handle);
  }) as typeof clearTimeout;

  try {
    const poller = new BoundedPoller({
      ingestionService: NULL_SERVICE,
      fetchEvents: () => emptyResult(),
      pollIntervalMs: 100_000, // long — timers never fire during the test
      label: "test-single-chain",
    });
    const internals = poller as unknown as { _timer: unknown; poll(): Promise<void> };

    poller.start();
    const firstTimer = internals._timer;
    assert.ok(firstTimer, "start() must schedule a timer");

    // Simulates the in-flight cycle finishing after a stop()+start(): its
    // finally-scheduleNext must replace the pending timer, not add a second
    // live chain.
    await internals.poll();
    const secondTimer = internals._timer;
    assert.notEqual(secondTimer, firstTimer, "poll completion reschedules");
    assert.ok(
      cleared.includes(firstTimer),
      "the previously pending timer must be cleared, not left running",
    );

    poller.stop();
  } finally {
    globalThis.clearTimeout = origClear;
  }
});
