// Stale-reaper status tracker, extracted from createBrokerServer in server.ts.
// Owns the running tally the periodic stale-task reaper exposes via /healthz and
// the operator dashboard: last run timestamp, last requeued / dead-lettered
// counts, cumulative dead-lettered total, last error, and run count. The sweep
// orchestration (broker call, operator-broadcast suppression) stays in the
// server; it just records outcomes here and reads back a status object.
//
// BrokerStaleReaperStatus is defined and exported by server.ts; it is imported
// here type-only, so there is no runtime import cycle.
import type { BrokerStaleReaperStatus } from "./server.js";

/** The static (config-derived) fields a status report is stamped with. */
export interface StaleReaperStatusBase {
  enabled: boolean;
  intervalSec: number;
  olderThanSec: number;
  waveStaleAfterSec: number;
  maxRequeueAttempts: number;
}

export class StaleReaperStatusTracker {
  private lastRunAt: string | undefined;
  private lastRequeued: number | undefined;
  private lastDeadLettered: number | undefined;
  private totalDeadLettered = 0;
  private lastError: string | undefined;
  private runCount = 0;

  /** Record a successful sweep that requeued / dead-lettered the given counts. */
  recordSweep(requeuedCount: number, deadLetteredCount: number): void {
    this.lastRunAt = new Date().toISOString();
    this.lastRequeued = requeuedCount;
    this.lastDeadLettered = deadLetteredCount;
    this.totalDeadLettered += deadLetteredCount;
    this.lastError = undefined;
    this.runCount += 1;
  }

  /** Record a sweep that threw; preserves the cumulative dead-lettered total. */
  recordError(message: string): void {
    this.lastRunAt = new Date().toISOString();
    this.lastRequeued = 0;
    this.lastDeadLettered = 0;
    this.lastError = message;
    this.runCount += 1;
  }

  /** Build a full status report by stamping the tracked tally onto the config base. */
  status(base: StaleReaperStatusBase): BrokerStaleReaperStatus {
    return {
      enabled: base.enabled,
      intervalSec: base.intervalSec,
      olderThanSec: base.olderThanSec,
      waveStaleAfterSec: base.waveStaleAfterSec,
      maxRequeueAttempts: base.maxRequeueAttempts,
      lastRunAt: this.lastRunAt,
      lastRequeued: this.lastRequeued,
      lastDeadLettered: this.lastDeadLettered,
      totalDeadLettered: this.totalDeadLettered,
      lastError: this.lastError,
      runCount: this.runCount,
    };
  }
}
