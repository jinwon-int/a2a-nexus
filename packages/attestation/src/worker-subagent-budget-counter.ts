import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import { numberValue, optionalString } from "./value-text.js";

// Source-only sub-agent token/cost COUNTER source.
//
// contracts/a2a/broker-policy.md defers `maxSubagentBudget` "until a counter
// source exists". This packet IS that source: given supplied, normalized token
// usage (per-task + broker aggregate) and the configured ceilings, it derives a
// SHRINK-ONLY spawn ceiling (0 when a ceiling is reached, otherwise no extra
// constraint). It never probes usage, never enforces at runtime, and never
// forces a spawn — a future runtime spawn gate consumes it. Units are
// normalized ("token-units"); no real currency is recorded (anonymity discipline).

export interface A2AWorkerSubagentBudgetCounterUsage {
  taskId?: string;
  taskTokensSpent?: number;
  taskTokenCeiling?: number;
  brokerTokensSpent?: number;
  brokerTokenCeiling?: number;
}

export interface A2AWorkerSubagentBudgetCounterInput {
  now?: string;
  workerId: string;
  usage: A2AWorkerSubagentBudgetCounterUsage;
  source?: {
    collector?: string;
    observedAt?: string;
    note?: string;
  };
}

export interface A2AWorkerSubagentBudgetCounterPacket {
  kind: "a2a-broker.worker-subagent-budget-counter.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  idempotencyKey: string;
  workerId: string;
  taskId?: string;
  usage: {
    taskTokensSpent?: number;
    taskTokenCeiling?: number;
    brokerTokensSpent?: number;
    brokerTokenCeiling?: number;
    normalizedUnits: "token-units";
    currencyRecorded: false;
  };
  source: {
    collector?: string;
    observedAt?: string;
    note?: string;
    suppliedCounterOnly: true;
    probesUsage: false;
    enforcesBudget: false;
  };
  counter: {
    taskRemaining?: number;
    brokerRemaining?: number;
    taskCeilingReached: boolean;
    brokerCeilingReached: boolean;
    budgetExhausted: boolean;
    // Shrink-only: 0 caps further spawns when a ceiling is reached; null adds no
    // constraint (the count budget stays governed by the orchestration policy).
    spawnBudgetCeiling: number | null;
    reducedReasons: string[];
  };
  readiness: {
    counterReady: boolean;
    missing: string[];
    nextAction: string;
  };
  state: "insufficient-input" | "within-budget" | "budget-exhausted";
  boundaries: {
    sourceOnly: true;
    liveHostProbe: false;
    plannerRouteCall: false;
    runtimeBehaviorChanged: false;
    mandatoryProductionSpawn: false;
    actualSubagentSpawn: false;
    brokerDispatch: false;
    workerClaim: false;
    executorInvocation: false;
    processSpawn: false;
    taskFlowMutation: false;
    dbMutation: false;
    deployOrRestart: false;
    providerSend: false;
    terminalAckOrReplay: false;
    releaseOrPublish: false;
    secretMovement: false;
  };
}

function remaining(spent: number | undefined, ceiling: number | undefined): number | undefined {
  if (spent === undefined || ceiling === undefined) return undefined;
  return Math.max(0, ceiling - spent);
}

function ceilingReached(spent: number | undefined, ceiling: number | undefined): boolean {
  return spent !== undefined && ceiling !== undefined && spent >= ceiling;
}

export function buildA2AWorkerSubagentBudgetCounter(
  input: A2AWorkerSubagentBudgetCounterInput,
): A2AWorkerSubagentBudgetCounterPacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const usage = input.usage ?? {};

  const taskRemaining = remaining(usage.taskTokensSpent, usage.taskTokenCeiling);
  const brokerRemaining = remaining(usage.brokerTokensSpent, usage.brokerTokenCeiling);
  const taskCeilingReached = ceilingReached(usage.taskTokensSpent, usage.taskTokenCeiling);
  const brokerCeilingReached = ceilingReached(usage.brokerTokensSpent, usage.brokerTokenCeiling);
  const budgetExhausted = taskCeilingReached || brokerCeilingReached;

  const reducedReasons: string[] = [];
  if (taskCeilingReached) reducedReasons.push("task_token_ceiling_reached");
  if (brokerCeilingReached) reducedReasons.push("broker_token_ceiling_reached");

  const missing = missingFields(usage);
  const counterReady = missing.length === 0;
  const state: A2AWorkerSubagentBudgetCounterPacket["state"] = !counterReady
    ? "insufficient-input"
    : budgetExhausted
      ? "budget-exhausted"
      : "within-budget";

  return {
    kind: "a2a-broker.worker-subagent-budget-counter.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    idempotencyKey: buildBudgetCounterId(input, generatedAt),
    workerId: input.workerId,
    taskId: usage.taskId,
    usage: {
      taskTokensSpent: usage.taskTokensSpent,
      taskTokenCeiling: usage.taskTokenCeiling,
      brokerTokensSpent: usage.brokerTokensSpent,
      brokerTokenCeiling: usage.brokerTokenCeiling,
      normalizedUnits: "token-units",
      currencyRecorded: false,
    },
    source: {
      collector: input.source?.collector,
      observedAt: input.source?.observedAt,
      note: input.source?.note,
      suppliedCounterOnly: true,
      probesUsage: false,
      enforcesBudget: false,
    },
    counter: {
      taskRemaining,
      brokerRemaining,
      taskCeilingReached,
      brokerCeilingReached,
      budgetExhausted,
      spawnBudgetCeiling: budgetExhausted ? 0 : null,
      reducedReasons,
    },
    readiness: {
      counterReady,
      missing,
      nextAction: counterReady
        ? (budgetExhausted
            ? "budget exhausted: a runtime spawn gate should cap further sub-agent spawns to spawnBudgetCeiling (0)"
            : "within budget: the counter adds no constraint; the orchestration policy governs the count budget")
        : "supply at least one complete spent+ceiling pair (task or broker) before the counter can derive a ceiling",
    },
    state,
    boundaries: {
      sourceOnly: true,
      liveHostProbe: false,
      plannerRouteCall: false,
      runtimeBehaviorChanged: false,
      mandatoryProductionSpawn: false,
      actualSubagentSpawn: false,
      brokerDispatch: false,
      workerClaim: false,
      executorInvocation: false,
      processSpawn: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      providerSend: false,
      terminalAckOrReplay: false,
      releaseOrPublish: false,
      secretMovement: false,
    },
  };
}

export function extractA2AWorkerSubagentBudgetCounterInput(input: unknown): A2AWorkerSubagentBudgetCounterInput {
  const envelope = isRecord(input) ? input : {};
  const candidate = isRecord(envelope.workerSubagentBudgetCounter)
    ? envelope.workerSubagentBudgetCounter
    : isRecord(envelope.budgetCounter)
      ? envelope.budgetCounter
      : envelope;
  if (!isRecord(candidate)) {
    throw new Error("worker subagent budget counter input must be an object");
  }
  const workerId = optionalString(candidate.workerId ?? candidate.worker_id);
  if (!workerId) throw new Error("worker subagent budget counter requires workerId");
  const usageInput = isRecord(candidate.usage) ? candidate.usage : candidate;
  return {
    now: optionalString(candidate.now),
    workerId,
    usage: {
      taskId: optionalString(usageInput.taskId ?? usageInput.task_id),
      taskTokensSpent: numberValue(usageInput.taskTokensSpent ?? usageInput.task_tokens_spent),
      taskTokenCeiling: numberValue(usageInput.taskTokenCeiling ?? usageInput.task_token_ceiling),
      brokerTokensSpent: numberValue(usageInput.brokerTokensSpent ?? usageInput.broker_tokens_spent),
      brokerTokenCeiling: numberValue(usageInput.brokerTokenCeiling ?? usageInput.broker_token_ceiling),
    },
    source: isRecord(candidate.source)
      ? {
          collector: optionalString(candidate.source.collector),
          observedAt: optionalString(candidate.source.observedAt ?? candidate.source.observed_at),
          note: optionalString(candidate.source.note),
        }
      : undefined,
  };
}

export function renderA2AWorkerSubagentBudgetCounterMarkdown(packet: A2AWorkerSubagentBudgetCounterPacket): string {
  return [
    "A2A worker sub-agent budget counter packet",
    "Worker: " + packet.workerId,
    "Generated: " + packet.generatedAt,
    "State: " + packet.state,
    "Counter ready: " + packet.readiness.counterReady,
    "Missing: " + (packet.readiness.missing.join(", ") || "none"),
    "Task budget: spent=" + valueOrUnknown(packet.usage.taskTokensSpent)
      + " ceiling=" + valueOrUnknown(packet.usage.taskTokenCeiling)
      + " remaining=" + valueOrUnknown(packet.counter.taskRemaining),
    "Broker budget: spent=" + valueOrUnknown(packet.usage.brokerTokensSpent)
      + " ceiling=" + valueOrUnknown(packet.usage.brokerTokenCeiling)
      + " remaining=" + valueOrUnknown(packet.counter.brokerRemaining),
    "Spawn budget ceiling (shrink-only): " + (packet.counter.spawnBudgetCeiling === null ? "none" : String(packet.counter.spawnBudgetCeiling)),
    "Reasons: " + (packet.counter.reducedReasons.join(", ") || "none"),
    "Units: normalized token-units; no currency recorded.",
    "Safety: source-only supplied counter; no usage probe, no runtime enforcement, no subagent spawn, dispatch, DB/TaskFlow mutation, deploy/restart, provider send, terminal ACK/replay, release/publish, or secret movement.",
  ].join("\n");
}

function missingFields(usage: A2AWorkerSubagentBudgetCounterUsage): string[] {
  const taskPair = usage.taskTokensSpent !== undefined && usage.taskTokenCeiling !== undefined;
  const brokerPair = usage.brokerTokensSpent !== undefined && usage.brokerTokenCeiling !== undefined;
  if (taskPair || brokerPair) return [];
  return ["usage.taskTokensSpent+usage.taskTokenCeiling or usage.brokerTokensSpent+usage.brokerTokenCeiling"];
}

function buildBudgetCounterId(input: A2AWorkerSubagentBudgetCounterInput, generatedAt: string): string {
  const base = JSON.stringify({ input, generatedAt });
  return "a2a-worker-subagent-budget-counter:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function valueOrUnknown(value: unknown): string {
  return value === undefined ? "unknown" : String(value);
}
