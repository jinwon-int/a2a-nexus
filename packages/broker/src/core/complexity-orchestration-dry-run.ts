// ── Complexity orchestration recommendation dry-run (source-only, no-live) ──
//
// Builds the #971 recommendation packet from a fixture or raw
// TaskComplexityInput. This module is deliberately pure: no broker reads, no
// worker dispatch, no DB mutation, and no provider sends.
// ─────────────────────────────────────────────────────────────────────────────

import {
  classifyTaskComplexity,
  COMPLEXITY_LEVELS,
  type ComplexityBounds,
  type ComplexityLevel,
  type TaskComplexityInput,
} from "./task-complexity-classifier.js";
import {
  buildComplexityOrchestrationRecommendation,
  renderComplexityOrchestrationRecommendationMarkdown,
  type ComplexityOrchestrationRecommendationPacket,
} from "./complexity-orchestration-recommendation.js";

export type ComplexityOrchestrationDryRunFormat = "markdown" | "json";

export interface ComplexityOrchestrationDryRunFixture {
  kind?: string;
  version?: number;
  description?: string;
  now?: string;
  format?: ComplexityOrchestrationDryRunFormat;
  input?: TaskComplexityInput;
  taskComplexityInput?: TaskComplexityInput;
  bounds?: ComplexityBounds;
}

export interface NormalizedComplexityOrchestrationDryRunInput {
  input: TaskComplexityInput;
  bounds?: ComplexityBounds;
  now?: string;
  format: ComplexityOrchestrationDryRunFormat;
}

export interface ComplexityOrchestrationDryRunResult {
  kind: "a2a-broker.complexity-orchestration-recommendation-dry-run";
  version: 1;
  generatedAt: string;
  format: ComplexityOrchestrationDryRunFormat;
  packet: ComplexityOrchestrationRecommendationPacket;
  boundaries: {
    brokerStateRead: false;
    workerDispatch: false;
    subagentSpawn: false;
    taskFlowMutation: false;
    dbMutation: false;
    deployOrRestart: false;
    providerSend: false;
    terminalAckOrReplay: false;
    secretMovement: false;
  };
}

const DEFAULT_FORMAT: ComplexityOrchestrationDryRunFormat = "markdown";

const LEVELS = new Set<ComplexityLevel>(COMPLEXITY_LEVELS);

export function normalizeComplexityOrchestrationDryRunInput(
  value: unknown,
): NormalizedComplexityOrchestrationDryRunInput {
  if (!isRecord(value)) {
    throw new Error("Dry-run input must be a JSON object.");
  }

  const fixture = value as ComplexityOrchestrationDryRunFixture;
  const candidate = fixture.input ?? fixture.taskComplexityInput ?? value;

  if (!isTaskComplexityInput(candidate)) {
    throw new Error("Dry-run input must include task complexity input with an intent.");
  }

  return {
    input: candidate,
    bounds: normalizeBounds(fixture.bounds),
    now: typeof fixture.now === "string" && fixture.now.trim() !== ""
      ? fixture.now
      : undefined,
    format: normalizeFormat(fixture.format),
  };
}

export function buildComplexityOrchestrationDryRun(
  value: unknown,
  options: {
    now?: string;
    format?: ComplexityOrchestrationDryRunFormat;
  } = {},
): ComplexityOrchestrationDryRunResult {
  const normalized = normalizeComplexityOrchestrationDryRunInput(value);
  const classification = classifyTaskComplexity(
    normalized.input,
    normalized.bounds,
  );
  const packet = buildComplexityOrchestrationRecommendation(classification, {
    now: options.now ?? normalized.now,
  });

  return {
    kind: "a2a-broker.complexity-orchestration-recommendation-dry-run",
    version: 1,
    generatedAt: packet.generatedAt,
    format: options.format ?? normalized.format,
    packet,
    boundaries: {
      brokerStateRead: false,
      workerDispatch: false,
      subagentSpawn: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      providerSend: false,
      terminalAckOrReplay: false,
      secretMovement: false,
    },
  };
}

export function renderComplexityOrchestrationDryRunMarkdown(
  result: ComplexityOrchestrationDryRunResult,
): string {
  return [
    "# Complexity orchestration recommendation dry-run",
    "",
    `- **dryRunKind**: ${result.kind}`,
    `- **packetKind**: ${result.packet.kind}`,
    `- **generatedAt**: ${result.generatedAt}`,
    "",
    renderComplexityOrchestrationRecommendationMarkdown(result.packet),
  ].join("\n");
}

function normalizeFormat(
  format: unknown,
): ComplexityOrchestrationDryRunFormat {
  if (format === "json" || format === "markdown") return format;
  return DEFAULT_FORMAT;
}

function normalizeBounds(bounds: unknown): ComplexityBounds | undefined {
  if (bounds === undefined) return undefined;
  if (!isRecord(bounds)) {
    throw new Error("bounds must be an object with min and max complexity levels.");
  }
  const { min, max } = bounds;
  if (!isComplexityLevel(min) || !isComplexityLevel(max)) {
    throw new Error("bounds.min and bounds.max must be valid complexity levels.");
  }
  return { min, max };
}

function isTaskComplexityInput(value: unknown): value is TaskComplexityInput {
  return isRecord(value) && typeof value.intent === "string";
}

function isComplexityLevel(value: unknown): value is ComplexityLevel {
  return typeof value === "string" && LEVELS.has(value as ComplexityLevel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
