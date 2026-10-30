// Durable wave plan persistence + resume (#1357 G3-c).
//
// The pure state machine in wave-plan.ts is timestamp-free so that a saved plan
// reloads to a byte-identical state (resume determinism). This store is the
// broker-side holder that (a) drives the pure transitions, (b) stamps a
// broker-clock `updatedAt` on every transition for the stale-wave reaper, and
// (c) snapshots/restores through the existing BrokerSnapshot path — no hot
// table, canonical-blob persistence like crossBrokerTerminalBriefs.
//
// Reaper is DETECTION only here (findStalled): it flags running/stage_ready
// plans idle past a threshold so the broker/hub can emit a `wave.stalled`
// warning. It never auto-aborts — advancing/aborting a wave stays a privileged
// operator action, consistent with wave-plan.ts's "stage_ready is a signal".

import {
  validateWavePlanSpec,
  startWavePlan,
  reportStageEvidence,
  advanceWavePlan,
  abortWavePlan,
  WavePlanError,
  type WavePlan,
  type WavePlanState,
  type WaveStageEvidence,
} from "./wave-plan.js";

/** A wave plan plus the broker-clock bookkeeping that must survive a restart. */
export interface PersistedWavePlan {
  plan: WavePlan;
  /** ISO timestamp of the last transition (broker clock). Drives staleness. */
  updatedAt: string;
  /**
   * ISO timestamp of the last `wave.stalled` warning, if any. Set by
   * markStalledNotified and cleared on the next real transition so a stalled
   * plan warns once per stall, not once per sweep.
   */
  stalledNotifiedAt?: string;
}

export interface WavePlanStoreOptions {
  /** Injectable clock (tests). Defaults to the wall clock. */
  now?: () => Date;
}

/** A live (running|stage_ready) plan that has gone idle past the threshold. */
export interface StalledWavePlan {
  wavePlanId: string;
  state: WavePlanState;
  currentStage: number;
  stageId: string;
  updatedAt: string;
  idleMs: number;
}

const LIVE_STATES = new Set<WavePlanState>(["running", "stage_ready"]);

function clonePersisted(record: PersistedWavePlan): PersistedWavePlan {
  return {
    plan: structuredClone(record.plan),
    updatedAt: record.updatedAt,
    ...(record.stalledNotifiedAt ? { stalledNotifiedAt: record.stalledNotifiedAt } : {}),
  };
}

export class WavePlanStore {
  private readonly records = new Map<string, PersistedWavePlan>();

  constructor(records: PersistedWavePlan[] = [], private readonly options: WavePlanStoreOptions = {}) {
    for (const record of records) {
      this.records.set(record.plan.wavePlanId, clonePersisted(record));
    }
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /** Validate a spec and register a fresh draft. Duplicate ids fail closed. */
  create(spec: unknown): WavePlan {
    const plan = validateWavePlanSpec(spec);
    if (this.records.has(plan.wavePlanId)) {
      throw new WavePlanError("wave_spec_invalid", `duplicate wavePlanId '${plan.wavePlanId}'`);
    }
    this.records.set(plan.wavePlanId, { plan, updatedAt: this.nowIso() });
    return structuredClone(plan);
  }

  private requireRecord(wavePlanId: string): PersistedWavePlan {
    const record = this.records.get(wavePlanId);
    if (!record) {
      throw new WavePlanError("wave_illegal_transition", `unknown wavePlanId '${wavePlanId}'`);
    }
    return record;
  }

  /** Apply a pure transition and re-stamp updatedAt (clearing any stall flag). */
  private transition(wavePlanId: string, fn: (plan: WavePlan) => WavePlan): WavePlan {
    const record = this.requireRecord(wavePlanId);
    const next = fn(record.plan);
    this.records.set(wavePlanId, { plan: next, updatedAt: this.nowIso() });
    return structuredClone(next);
  }

  start(wavePlanId: string): WavePlan {
    return this.transition(wavePlanId, startWavePlan);
  }

  reportEvidence(wavePlanId: string, evidence: WaveStageEvidence): WavePlan {
    return this.transition(wavePlanId, (plan) => reportStageEvidence(plan, evidence));
  }

  advance(wavePlanId: string): WavePlan {
    return this.transition(wavePlanId, advanceWavePlan);
  }

  abort(wavePlanId: string): WavePlan {
    return this.transition(wavePlanId, abortWavePlan);
  }

  get(wavePlanId: string): WavePlan | undefined {
    const record = this.records.get(wavePlanId);
    return record ? structuredClone(record.plan) : undefined;
  }

  list(): WavePlan[] {
    return [...this.records.values()].map((record) => structuredClone(record.plan));
  }

  /**
   * Detection-only reaper: live plans whose last transition is older than
   * staleAfterMs and that have not already been warned about since. Non-mutating
   * — the caller decides whether to emit `wave.stalled` and then calls
   * markStalledNotified. Never auto-aborts.
   */
  findStalled(staleAfterMs: number, nowMs = Date.now()): StalledWavePlan[] {
    const stalled: StalledWavePlan[] = [];
    for (const record of this.records.values()) {
      if (!LIVE_STATES.has(record.plan.state)) continue;
      if (record.stalledNotifiedAt) continue;
      const updatedAtMs = Date.parse(record.updatedAt);
      if (!Number.isFinite(updatedAtMs)) continue;
      const idleMs = nowMs - updatedAtMs;
      if (idleMs < staleAfterMs) continue;
      stalled.push({
        wavePlanId: record.plan.wavePlanId,
        state: record.plan.state,
        currentStage: record.plan.currentStage,
        stageId: record.plan.stages[record.plan.currentStage]?.id ?? "",
        updatedAt: record.updatedAt,
        idleMs,
      });
    }
    return stalled;
  }

  /** Record that a `wave.stalled` warning was emitted (dedupes repeat sweeps). */
  markStalledNotified(wavePlanId: string): void {
    const record = this.requireRecord(wavePlanId);
    this.records.set(wavePlanId, { ...record, stalledNotifiedAt: this.nowIso() });
  }

  snapshot(): PersistedWavePlan[] {
    return [...this.records.values()].map(clonePersisted);
  }

  restore(records: PersistedWavePlan[]): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(record.plan.wavePlanId, clonePersisted(record));
    }
  }
}
