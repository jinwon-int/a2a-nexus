import { createHash } from "node:crypto";

export type OIValidationScenarioId =
  | "wiki-large-refactor"
  | "skill-update-sweep"
  | "complex-architecture-design"
  | "a2a-worker-deployment";

export type OIValidationEvidenceState = "missing" | "planned" | "collected";

export interface OIValidationMetric {
  name: string;
  unit: "minutes" | "count" | "usd" | "score_1_5" | "boolean";
  direction: "lower_is_better" | "higher_is_better" | "must_be_true" | "must_be_false";
  required: boolean;
}

export interface OIValidationScenarioInput {
  id: OIValidationScenarioId;
  title?: string;
  repository?: string;
  owner?: string;
  baselineEvidence?: OIValidationEvidenceState;
  candidateEvidence?: OIValidationEvidenceState;
  notes?: string[];
}

export interface OIValidationFrameworkInput {
  generatedAt?: string;
  runId?: string;
  roadmapIssueUrl?: string;
  parentIssueNumber?: number;
  scenarios?: OIValidationScenarioInput[];
}

export interface OIValidationScenario {
  id: OIValidationScenarioId;
  title: string;
  owner: string;
  repository: string;
  goal: string;
  baselineEvidence: OIValidationEvidenceState;
  candidateEvidence: OIValidationEvidenceState;
  requiredEvidence: string[];
  notes: string[];
}

export interface OIValidationFrameworkPacket {
  kind: "a2a-broker.orchestration-intelligence.validation-framework.packet";
  version: 1;
  generatedAt: string;
  runId: string;
  roadmap: {
    issueNumber: number;
    issueUrl: string;
    phase: "2.4-validation-framework";
  };
  sourceOnly: true;
  idempotencyKey: string;
  scenarios: OIValidationScenario[];
  metrics: OIValidationMetric[];
  readiness: {
    state: "framework_ready" | "waiting_for_evidence";
    missingEvidence: Array<{ scenarioId: OIValidationScenarioId; slot: "baseline" | "candidate" }>;
    nextAction: string;
  };
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

const DEFAULT_ROADMAP_ISSUE = 968;
const DEFAULT_ROADMAP_URL = "https://github.com/jinwon-int/a2a-broker/issues/968";
const DEFAULT_RUN_ID = "oi-v2-validation-framework";

const DEFAULT_SCENARIOS: Omit<OIValidationScenario, "baselineEvidence" | "candidateEvidence" | "notes">[] = [
  {
    id: "wiki-large-refactor",
    title: "Wiki large refactor",
    owner: "broker-finalizer",
    repository: "jinwon-int/seoyoon-family-wiki",
    goal: "Compare OI v2 orchestration against a large Wiki restructure with reviewable PR output.",
    requiredEvidence: ["before task transcript", "after task transcript", "PR diff summary", "wiki gate result"],
  },
  {
    id: "skill-update-sweep",
    title: "Skill update sweep",
    owner: "broker-finalizer",
    repository: "jinwon-int/seoyoon-family-wiki",
    goal: "Compare repeated skill maintenance across independent files and verify owner-safe boundaries.",
    requiredEvidence: ["before task transcript", "after task transcript", "changed skill list", "diff check result"],
  },
  {
    id: "complex-architecture-design",
    title: "Complex architecture design",
    owner: "broker-finalizer",
    repository: "jinwon-int/a2a-broker",
    goal: "Compare source-only architecture design quality for multi-step A2A planning without runtime execution.",
    requiredEvidence: ["before design packet", "after design packet", "review findings", "operator decision"],
  },
  {
    id: "a2a-worker-deployment",
    title: "A2A worker deployment",
    owner: "broker-finalizer",
    repository: "jinwon-int/a2a-broker",
    goal: "Compare supervised worker deployment planning while keeping deploy/restart behind explicit approval.",
    requiredEvidence: ["before runbook", "after runbook", "preflight output", "approval boundary review"],
  },
];

const DEFAULT_METRICS: OIValidationMetric[] = [
  { name: "elapsed_time_minutes", unit: "minutes", direction: "lower_is_better", required: true },
  { name: "human_intervention_count", unit: "count", direction: "lower_is_better", required: true },
  { name: "estimated_cost_usd", unit: "usd", direction: "lower_is_better", required: true },
  { name: "output_quality_score", unit: "score_1_5", direction: "higher_is_better", required: true },
  { name: "system_stability_score", unit: "score_1_5", direction: "higher_is_better", required: true },
  { name: "approval_boundary_violated", unit: "boolean", direction: "must_be_false", required: true },
];

export function buildOIValidationFrameworkPacket(
  input: OIValidationFrameworkInput = {},
): OIValidationFrameworkPacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const issueNumber = input.parentIssueNumber ?? DEFAULT_ROADMAP_ISSUE;
  const issueUrl = input.roadmapIssueUrl ?? DEFAULT_ROADMAP_URL;
  const runId = input.runId ?? DEFAULT_RUN_ID;
  const scenarioOverrides = new Map((input.scenarios ?? []).map((scenario) => [scenario.id, scenario]));
  const scenarios = DEFAULT_SCENARIOS.map((scenario) => {
    const override = scenarioOverrides.get(scenario.id);
    return {
      ...scenario,
      title: override?.title ?? scenario.title,
      owner: override?.owner ?? scenario.owner,
      repository: override?.repository ?? scenario.repository,
      baselineEvidence: override?.baselineEvidence ?? "missing",
      candidateEvidence: override?.candidateEvidence ?? "missing",
      notes: override?.notes ?? [],
    };
  });
  const missingEvidence = scenarios.flatMap((scenario) => [
    ...(scenario.baselineEvidence === "collected" ? [] : [{ scenarioId: scenario.id, slot: "baseline" as const }]),
    ...(scenario.candidateEvidence === "collected" ? [] : [{ scenarioId: scenario.id, slot: "candidate" as const }]),
  ]);

  return {
    kind: "a2a-broker.orchestration-intelligence.validation-framework.packet",
    version: 1,
    generatedAt,
    runId,
    roadmap: {
      issueNumber,
      issueUrl,
      phase: "2.4-validation-framework",
    },
    sourceOnly: true,
    idempotencyKey: stableId("oi-validation-framework", { runId, issueNumber, scenarios }),
    scenarios,
    metrics: DEFAULT_METRICS,
    readiness: {
      state: missingEvidence.length ? "waiting_for_evidence" : "framework_ready",
      missingEvidence,
      nextAction: missingEvidence.length
        ? "collect paired before/after evidence for every validation scenario before scoring OI v2"
        : "score paired scenario evidence and prepare a separate finalizer review packet",
    },
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

export function renderOIValidationFrameworkMarkdown(packet: OIValidationFrameworkPacket): string {
  const scenarioLines = packet.scenarios.map(
    (scenario) =>
      `- ${scenario.id}: baseline=${scenario.baselineEvidence}, candidate=${scenario.candidateEvidence}, repo=${scenario.repository}`,
  );
  const metricLines = packet.metrics.map((metric) => `- ${metric.name}: ${metric.unit}, ${metric.direction}`);
  return [
    "A2A Orchestration Intelligence v2 validation framework",
    `Roadmap: #${packet.roadmap.issueNumber}`,
    `Readiness: ${packet.readiness.state}`,
    "Scenarios:",
    ...scenarioLines,
    "Metrics:",
    ...metricLines,
    `Next action: ${packet.readiness.nextAction}`,
    "Safety: source-only framework; no runtime executor, broker dispatch, worker spawn, provider send, Terminal ACK/replay, DB mutation, deploy/restart, release, or credential movement.",
  ].join("\n");
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
