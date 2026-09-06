import { isRecord } from "./value-guards.js";

// Durable wave plan (#1357 G3) — pure state machine + gate evaluation.
//
// The manual wave rhythm (dispatch -> readback -> quorum/gate -> implement ->
// review -> merge -> next stage) has been operator-driven for every 2026-07
// wave. This module is the broker-objectified core of that rhythm: a linear
// stage machine with an explicit transition table (illegal transitions fail
// closed) and per-stage gate evaluation over an evidence summary.
//
// Load-bearing contract: `stage_ready` is a SIGNAL, not an action. When a
// stage's gate is met the broker records readiness and emits an event/audit;
// the next-stage dispatch (a privileged action) is the operator/hub's explicit
// advance call — never auto-taken here. Persistence, HTTP routes, resume, and
// the classifier single-source wiring are separate slices (G3-c).
//
// v1 scope: linear stages only (no DAG/branching/cron). Anonymous by
// construction — a plan holds stage ids + dispatch manifest refs + gate specs,
// never worker names or prompt text.

export const WAVE_PLAN_STATES = ["draft", "running", "stage_ready", "halted", "completed", "aborted"] as const;
export type WavePlanState = (typeof WAVE_PLAN_STATES)[number];

export type WaveStageGate =
  | { type: "quorum"; minSubstantive: number }
  | { type: "approval" }
  | { type: "manual" };

export type WaveOnGateFail = "halt" | "retry-once";

export interface WaveStage {
  id: string;
  dispatch?: { manifestRef: string };
  gate: WaveStageGate;
  onGateFail?: WaveOnGateFail;
}

export interface WavePlan {
  wavePlanId: string;
  stages: WaveStage[];
  state: WavePlanState;
  currentStage: number;
  /** Stage indices that have already consumed their retry-once budget. */
  retriedStages: number[];
}

/**
 * Evidence summary for the current stage's gate. Counts/flags only — the
 * broker computes `substantiveCount` from the finalizer-gate evidence classes
 * (single-source wiring is the G3-c slice); this pure evaluator only compares.
 */
export interface WaveStageEvidence {
  substantiveCount?: number;
  approvalGranted?: boolean;
  manualPass?: boolean;
}

export type WavePlanErrorCode = "wave_spec_invalid" | "wave_illegal_transition" | "wave_gate_not_met";

export class WavePlanError extends Error {
  code: WavePlanErrorCode;
  constructor(code: WavePlanErrorCode, message: string) {
    super(message);
    this.name = "WavePlanError";
    this.code = code;
  }
}

const TERMINAL_STATES = new Set<WavePlanState>(["completed", "aborted"]);

function validateGate(raw: unknown, where: string): WaveStageGate {
  if (!isRecord(raw)) throw new WavePlanError("wave_spec_invalid", `${where}: gate must be an object`);
  if (raw.type === "quorum") {
    if (!Number.isInteger(raw.minSubstantive) || (raw.minSubstantive as number) < 0) {
      throw new WavePlanError("wave_spec_invalid", `${where}: quorum gate requires an integer minSubstantive >= 0`);
    }
    return { type: "quorum", minSubstantive: raw.minSubstantive as number };
  }
  if (raw.type === "approval") return { type: "approval" };
  if (raw.type === "manual") return { type: "manual" };
  throw new WavePlanError("wave_spec_invalid", `${where}: unknown gate type '${String(raw.type)}' (quorum|approval|manual)`);
}

/** Validate a wave plan spec and return a fresh draft plan. Fail-closed. */
export function validateWavePlanSpec(spec: unknown): WavePlan {
  if (!isRecord(spec)) throw new WavePlanError("wave_spec_invalid", "wave plan spec must be an object");
  if (typeof spec.wavePlanId !== "string" || !spec.wavePlanId.trim()) {
    throw new WavePlanError("wave_spec_invalid", "wavePlanId is required");
  }
  if (!Array.isArray(spec.stages) || spec.stages.length === 0) {
    throw new WavePlanError("wave_spec_invalid", "a wave plan requires at least one stage");
  }
  const seen = new Set<string>();
  const stages: WaveStage[] = spec.stages.map((raw, index) => {
    const where = `stages[${index}]`;
    if (!isRecord(raw)) throw new WavePlanError("wave_spec_invalid", `${where} must be an object`);
    if (typeof raw.id !== "string" || !raw.id.trim()) throw new WavePlanError("wave_spec_invalid", `${where}: stage id is required`);
    if (seen.has(raw.id)) throw new WavePlanError("wave_spec_invalid", `${where}: duplicate stage id '${raw.id}'`);
    seen.add(raw.id);
    if (raw.onGateFail !== undefined && raw.onGateFail !== "halt" && raw.onGateFail !== "retry-once") {
      throw new WavePlanError("wave_spec_invalid", `${where}: onGateFail must be 'halt' or 'retry-once'`);
    }
    let dispatch: { manifestRef: string } | undefined;
    if (raw.dispatch !== undefined) {
      if (!isRecord(raw.dispatch) || typeof raw.dispatch.manifestRef !== "string" || !raw.dispatch.manifestRef.trim()) {
        throw new WavePlanError("wave_spec_invalid", `${where}: dispatch must carry a non-empty manifestRef`);
      }
      dispatch = { manifestRef: raw.dispatch.manifestRef };
    }
    return {
      id: raw.id,
      gate: validateGate(raw.gate, where),
      ...(dispatch ? { dispatch } : {}),
      ...(raw.onGateFail ? { onGateFail: raw.onGateFail as WaveOnGateFail } : {}),
    };
  });
  return { wavePlanId: spec.wavePlanId, stages, state: "draft", currentStage: 0, retriedStages: [] };
}

/** Pure gate evaluation. Returns { met, reason }. */
export function evaluateWaveGate(gate: WaveStageGate, evidence: WaveStageEvidence): { met: boolean; reason: string } {
  if (gate.type === "quorum") {
    const count = Number.isInteger(evidence.substantiveCount) ? (evidence.substantiveCount as number) : 0;
    return count >= gate.minSubstantive
      ? { met: true, reason: `quorum met: substantive ${count}/${gate.minSubstantive}` }
      : { met: false, reason: `quorum not met: substantive ${count}/${gate.minSubstantive}` };
  }
  if (gate.type === "approval") {
    return evidence.approvalGranted === true
      ? { met: true, reason: "approval granted" }
      : { met: false, reason: "approval not granted" };
  }
  return evidence.manualPass === true
    ? { met: true, reason: "manual pass" }
    : { met: false, reason: "manual pass not recorded" };
}

function clone(plan: WavePlan): WavePlan {
  return { ...plan, stages: plan.stages, retriedStages: [...plan.retriedStages] };
}

/** draft -> running. */
export function startWavePlan(plan: WavePlan): WavePlan {
  if (plan.state !== "draft") {
    throw new WavePlanError("wave_illegal_transition", `cannot start a wave plan in state '${plan.state}'`);
  }
  return { ...clone(plan), state: "running", currentStage: 0 };
}

/**
 * Report the current stage's evidence and apply its gate (running only):
 * met -> stage_ready; not met with onGateFail=halt (default) -> halted; not met
 * with onGateFail=retry-once and retry budget left -> stays running (budget
 * consumed); retry budget spent -> halted. `stage_ready` is a signal only.
 */
export function reportStageEvidence(plan: WavePlan, evidence: WaveStageEvidence): WavePlan {
  if (plan.state !== "running") {
    throw new WavePlanError("wave_illegal_transition", `cannot report stage evidence in state '${plan.state}'`);
  }
  const stage = plan.stages[plan.currentStage];
  const decision = evaluateWaveGate(stage.gate, evidence);
  if (decision.met) {
    return { ...clone(plan), state: "stage_ready" };
  }
  const onFail: WaveOnGateFail = stage.onGateFail ?? "halt";
  if (onFail === "retry-once" && !plan.retriedStages.includes(plan.currentStage)) {
    return { ...clone(plan), state: "running", retriedStages: [...plan.retriedStages, plan.currentStage] };
  }
  return { ...clone(plan), state: "halted" };
}

/**
 * stage_ready -> running(next stage), or completed when the last stage is
 * cleared. Advancing before the gate is met is rejected fail-closed. This is
 * the operator/hub's explicit privileged step.
 */
export function advanceWavePlan(plan: WavePlan): WavePlan {
  if (plan.state === "running") {
    throw new WavePlanError("wave_gate_not_met", "cannot advance: the current stage gate is not met (report stage evidence first)");
  }
  if (plan.state !== "stage_ready") {
    throw new WavePlanError("wave_illegal_transition", `cannot advance a wave plan in state '${plan.state}'`);
  }
  const nextStage = plan.currentStage + 1;
  if (nextStage >= plan.stages.length) {
    return { ...clone(plan), state: "completed" };
  }
  return { ...clone(plan), state: "running", currentStage: nextStage };
}

/** Abort from any non-terminal state. Terminal. */
export function abortWavePlan(plan: WavePlan): WavePlan {
  if (TERMINAL_STATES.has(plan.state)) {
    throw new WavePlanError("wave_illegal_transition", `cannot abort a wave plan in terminal state '${plan.state}'`);
  }
  return { ...clone(plan), state: "aborted" };
}
