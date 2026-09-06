import { createHash } from "node:crypto";
import { stableStringify } from "./value-guards.js";

import {
  buildOIValidationFrameworkPacket,
  type OIValidationFrameworkPacket,
  type OIValidationMetric,
  type OIValidationScenarioId,
} from "./orchestration-intelligence-validation-framework.js";

export type OIValidationMetricValue = number | boolean;

export interface OIValidationScenarioEvidenceInput {
  id: OIValidationScenarioId;
  baselineMetrics?: Record<string, OIValidationMetricValue>;
  candidateMetrics?: Record<string, OIValidationMetricValue>;
  evidenceUrls?: string[];
  notes?: string[];
}

export interface OIValidationScorerInput {
  generatedAt?: string;
  runId?: string;
  framework?: OIValidationFrameworkPacket;
  evidence?: OIValidationScenarioEvidenceInput[];
}

export interface OIValidationMetricScore {
  name: string;
  baseline?: OIValidationMetricValue;
  candidate?: OIValidationMetricValue;
  status: "improved" | "preserved" | "degraded" | "passed" | "blocked" | "missing";
  delta?: number;
  message: string;
}

export interface OIValidationScenarioScore {
  id: OIValidationScenarioId;
  title: string;
  repository: string;
  evidenceUrls: string[];
  notes: string[];
  metricScores: OIValidationMetricScore[];
  missingMetrics: string[];
  blockers: string[];
  decision: "candidate_ready_for_review" | "candidate_needs_review" | "waiting_for_paired_evidence" | "blocked";
}

export interface OIValidationScorePacket {
  kind: "a2a-broker.orchestration-intelligence.validation-score.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  sourceOnly: true;
  idempotencyKey: string;
  frameworkIdempotencyKey: string;
  roadmap: OIValidationFrameworkPacket["roadmap"];
  state: "score_ready" | "waiting_for_paired_evidence" | "approval_boundary_blocked";
  scenarioScores: OIValidationScenarioScore[];
  aggregate: {
    scenariosReady: number;
    scenariosWaiting: number;
    scenariosBlocked: number;
    improvedMetrics: number;
    degradedMetrics: number;
    preservedOrPassedMetrics: number;
    missingMetrics: number;
    approvalBoundaryViolations: number;
  };
  nextAction: string;
  safety: {
    runtimeExecutorCreated: false;
    brokerDispatchCreated: false;
    workerSpawned: false;
    providerSend: false;
    terminalAckReplay: false;
    dbMutation: false;
    deployOrRestart: false;
    credentialMovement: false;
    releasePublished: false;
  };
}

export function buildOIValidationScorePacket(input: OIValidationScorerInput = {}): OIValidationScorePacket {
  const framework = input.framework ?? buildOIValidationFrameworkPacket();
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const runId = input.runId ?? `${framework.runId}-score`;
  const evidenceByScenario = new Map((input.evidence ?? []).map((entry) => [entry.id, entry]));
  const scenarioScores = framework.scenarios.map((scenario) => {
    const evidence = evidenceByScenario.get(scenario.id);
    const metricScores = framework.metrics.map((metric) =>
      scoreMetric(metric, evidence?.baselineMetrics?.[metric.name], evidence?.candidateMetrics?.[metric.name]),
    );
    const missingMetrics = metricScores.filter((score) => score.status === "missing").map((score) => score.name);
    const blockers = metricScores.filter((score) => score.status === "blocked").map((score) => score.message);
    return {
      id: scenario.id,
      title: scenario.title,
      repository: scenario.repository,
      evidenceUrls: evidence?.evidenceUrls ?? [],
      notes: evidence?.notes ?? [],
      metricScores,
      missingMetrics,
      blockers,
      decision: scenarioDecision(metricScores),
    };
  });

  const aggregate = {
    scenariosReady: scenarioScores.filter((score) => score.decision === "candidate_ready_for_review").length,
    scenariosWaiting: scenarioScores.filter((score) => score.decision === "waiting_for_paired_evidence").length,
    scenariosBlocked: scenarioScores.filter((score) => score.decision === "blocked").length,
    improvedMetrics: countMetricStatus(scenarioScores, "improved"),
    degradedMetrics: countMetricStatus(scenarioScores, "degraded"),
    preservedOrPassedMetrics: countMetricStatus(scenarioScores, "preserved") + countMetricStatus(scenarioScores, "passed"),
    missingMetrics: countMetricStatus(scenarioScores, "missing"),
    approvalBoundaryViolations: scenarioScores.reduce(
      (count, score) => count + score.metricScores.filter((metric) => metric.name === "approval_boundary_violated" && metric.status === "blocked").length,
      0,
    ),
  };
  const state =
    aggregate.approvalBoundaryViolations > 0
      ? "approval_boundary_blocked"
      : aggregate.missingMetrics > 0
        ? "waiting_for_paired_evidence"
        : "score_ready";

  return {
    kind: "a2a-broker.orchestration-intelligence.validation-score.packet",
    version: 1,
    generatedAt,
    runId,
    sourceOnly: true,
    idempotencyKey: stableId("oi-validation-score", { runId, framework: framework.idempotencyKey, scenarioScores }),
    frameworkIdempotencyKey: framework.idempotencyKey,
    roadmap: framework.roadmap,
    state,
    scenarioScores,
    aggregate,
    nextAction: nextActionForState(state),
    safety: {
      runtimeExecutorCreated: false,
      brokerDispatchCreated: false,
      workerSpawned: false,
      providerSend: false,
      terminalAckReplay: false,
      dbMutation: false,
      deployOrRestart: false,
      credentialMovement: false,
      releasePublished: false,
    },
  };
}

export function renderOIValidationScoreMarkdown(packet: OIValidationScorePacket): string {
  const scenarioLines = packet.scenarioScores.map(
    (scenario) =>
      `- ${scenario.id}: ${scenario.decision}; improved=${scenario.metricScores.filter((metric) => metric.status === "improved").length}, degraded=${scenario.metricScores.filter((metric) => metric.status === "degraded").length}, missing=${scenario.missingMetrics.length}, blocked=${scenario.blockers.length}`,
  );
  return [
    "A2A Orchestration Intelligence v2 validation score",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `State: ${packet.state}`,
    `Scenarios ready: ${packet.aggregate.scenariosReady}`,
    `Scenarios waiting: ${packet.aggregate.scenariosWaiting}`,
    `Scenarios blocked: ${packet.aggregate.scenariosBlocked}`,
    "Scenario scores:",
    ...scenarioLines,
    `Next action: ${packet.nextAction}`,
    "Safety: source-only score packet; no runtime executor, broker dispatch, worker spawn, provider send, Terminal ACK/replay, DB mutation, deploy/restart, release, or credential movement.",
  ].join("\n");
}

function scoreMetric(
  metric: OIValidationMetric,
  baseline: OIValidationMetricValue | undefined,
  candidate: OIValidationMetricValue | undefined,
): OIValidationMetricScore {
  if (baseline === undefined || candidate === undefined) {
    return { name: metric.name, baseline, candidate, status: "missing", message: "paired baseline/candidate metric is required" };
  }
  if (metric.direction === "must_be_false") {
    if (candidate === true) {
      return { name: metric.name, baseline, candidate, status: "blocked", message: `${metric.name} must remain false before scoring can proceed` };
    }
    return { name: metric.name, baseline, candidate, status: "passed", message: `${metric.name} stayed false` };
  }
  if (typeof baseline !== "number" || typeof candidate !== "number") {
    return { name: metric.name, baseline, candidate, status: "blocked", message: `${metric.name} requires numeric paired values` };
  }
  const delta = metric.direction === "lower_is_better" ? baseline - candidate : candidate - baseline;
  if (delta > 0) return { name: metric.name, baseline, candidate, status: "improved", delta, message: `${metric.name} improved by ${delta}` };
  if (delta < 0) return { name: metric.name, baseline, candidate, status: "degraded", delta, message: `${metric.name} degraded by ${Math.abs(delta)}` };
  return { name: metric.name, baseline, candidate, status: "preserved", delta, message: `${metric.name} preserved` };
}

function scenarioDecision(metricScores: OIValidationMetricScore[]): OIValidationScenarioScore["decision"] {
  if (metricScores.some((score) => score.status === "blocked")) return "blocked";
  if (metricScores.some((score) => score.status === "missing")) return "waiting_for_paired_evidence";
  if (metricScores.some((score) => score.status === "degraded")) return "candidate_needs_review";
  return "candidate_ready_for_review";
}

function countMetricStatus(scenarios: OIValidationScenarioScore[], status: OIValidationMetricScore["status"]): number {
  return scenarios.reduce((count, scenario) => count + scenario.metricScores.filter((metric) => metric.status === status).length, 0);
}

function nextActionForState(state: OIValidationScorePacket["state"]): string {
  if (state === "approval_boundary_blocked") return "stop scoring and route to broker finalizer review because an approval boundary was violated";
  if (state === "waiting_for_paired_evidence") return "collect missing paired baseline/candidate metrics before finalizer scoring";
  return "prepare a broker finalizer review packet from the score results";
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}
